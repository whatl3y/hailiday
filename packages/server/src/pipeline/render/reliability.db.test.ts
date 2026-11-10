import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ActivationState,
  CompiledRequest,
  DecorationPlan,
  JudgeResult,
  NormalizedBox,
} from '@holiday/core';
import type { Capabilities } from '../../capabilities/index.js';
import type { AppConfig } from '../../config/index.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import type {
  EditOutcome,
  ImageEditor,
  ImageEditorCapabilities,
  JudgeInput,
  CallOptions,
  LocalizedChange,
  Providers,
  StreetViewProvider,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import { ProviderError } from '../../providers/errors.js';
import { dailySaltedHash } from '../../ids/index.js';
import type { RuntimeSettings } from '../../settings/index.js';
import type { PipelineDeps } from '../context.js';
import { RELIGHT_REPAIR_KEEP } from '../compile/compiler.js';
import { nativeBoxesOnWorkingGrid } from '../imaging/working.js';
import { runReconciliation } from '../jobs/reconciliation.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { settleDeadRender } from './dead-letter.js';
import { JobAborted } from './errors.js';
import { runRenderJob } from './job.js';
import { terminateRenderJob } from './terminate.js';
import { readJob } from './transitions.js';

const PLACES = {
  showcase: 'ChIJfxLanternHillColonial01',
  slow: 'ChIJfxMagnoliaTerraceColo06',
};

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps({ fixtureSlowDelayMs: 4000 });
});

afterAll(async () => {
  await base.close();
});

interface Overrides {
  /** Runtime settings read by the worker (kill switches), without touching the shared rows. */
  settings?: Record<string, unknown>;
  /** Capability states, without touching the shared rows. */
  capabilities?: Record<string, ActivationState | null>;
  imageEditor?: ImageEditor;
  vision?: VisionModel;
  fixtureImageEditor?: ImageEditor;
  fixtureVision?: VisionModel;
  fixtureStreetView?: StreetViewProvider;
  imageEdit?: Partial<AppConfig['imageEdit']>;
  /** `STREET_VIEW_ATTRIBUTION_REGIONS`, as parsed. */
  attributionRegions?: Record<string, NormalizedBox[]>;
}

/** The shared test dependencies with per-test overrides layered on top. */
function depsWith(o: Overrides): PipelineDeps {
  const values = o.settings ?? {};
  const settings: RuntimeSettings = {
    ...base.settings,
    get: ((key: string) =>
      key in values
        ? Promise.resolve(values[key])
        : base.settings.get(
            key as Parameters<RuntimeSettings['get']>[0],
          )) as RuntimeSettings['get'],
    isProviderPaused: async (provider) =>
      values[`pause.provider.${provider}`] === true || base.settings.isProviderPaused(provider),
  };
  const states = o.capabilities ?? {};
  const capabilities: Capabilities = {
    ...base.capabilities,
    state: async (country, capability) =>
      capability in states
        ? (states[capability] ?? null)
        : base.capabilities.state(country, capability),
  };
  const providers: Providers = {
    ...base.providers,
    ...(o.imageEditor ? { imageEditor: o.imageEditor } : {}),
    ...(o.vision ? { vision: o.vision } : {}),
    fixtures: {
      ...base.providers.fixtures,
      ...(o.fixtureImageEditor ? { imageEditor: o.fixtureImageEditor } : {}),
      ...(o.fixtureVision ? { vision: o.fixtureVision } : {}),
      ...(o.fixtureStreetView ? { streetView: o.fixtureStreetView } : {}),
    },
  };
  const config: AppConfig = {
    ...base.config,
    ...(o.imageEdit ? { imageEdit: { ...base.config.imageEdit, ...o.imageEdit } } : {}),
    ...(o.attributionRegions ? { streetView: { attributionRegions: o.attributionRegions } } : {}),
  };
  return { ...base, settings, capabilities, providers, config };
}

interface EditCall {
  attemptId: string;
  request: CompiledRequest;
  mask: boolean;
  /** The input image bytes the provider was given. */
  image: Uint8Array;
}

/** Wraps an editor, recording every `edit` call; any part can be replaced. */
function recordingEditor(
  inner: ImageEditor,
  patch: {
    providerId?: string;
    mode?: ImageEditor['mode'];
    capabilities?: Partial<ImageEditorCapabilities>;
    edit?: ImageEditor['edit'];
    getOperation?: ImageEditor['getOperation'];
  } = {},
) {
  const calls: EditCall[] = [];
  const editor: ImageEditor = {
    providerId: patch.providerId ?? inner.providerId,
    mode: patch.mode ?? inner.mode,
    capabilities: { ...inner.capabilities, ...(patch.capabilities ?? {}) },
    async edit(request, input, options) {
      calls.push({
        attemptId: options.attemptId,
        request,
        mask: input.mask !== undefined,
        image: input.image,
      });
      return (patch.edit ?? ((r, i, o) => inner.edit(r, i, o)))(request, input, options);
    },
    getOperation: patch.getOperation ?? ((operationId) => inner.getOperation(operationId)),
  };
  return { editor, calls };
}

/** A provider with no status API (as the live OpenAI and Gemini adapters answer). */
const NO_STATUS_API = async (operationId: string): Promise<EditOutcome> => ({
  status: 'failed',
  operationId,
  kind: 'provider_error',
  providerCode: 'no_status_api',
  retryable: false,
});

/** Synchronous, no status API, no idempotency key: the live editors' capabilities. */
const SYNCHRONOUS = { asyncOperations: false, supportsIdempotencyKey: false } as const;

/** Wraps a vision model, counting calls; the judge and the localizer can be replaced. */
function countingVision(
  inner: VisionModel,
  judge?: (input: JudgeInput, options?: CallOptions) => Promise<VisionCallResult<JudgeResult>>,
  localize?: VisionModel['localizeAdditions'],
) {
  const calls = { analyze: 0, judge: 0, localize: 0 };
  const judgeInputs: JudgeInput[] = [];
  const vision: VisionModel = {
    providerId: inner.providerId,
    mode: inner.mode,
    classifyUpload: (input, options) => inner.classifyUpload(input, options),
    async analyzeScene(input, options) {
      calls.analyze += 1;
      return inner.analyzeScene(input, options);
    },
    async judge(input, options) {
      calls.judge += 1;
      judgeInputs.push(input);
      return judge ? judge(input, options) : inner.judge(input, options);
    },
    async localizeAdditions(input, options) {
      calls.localize += 1;
      return localize ? localize(input, options) : inner.localizeAdditions(input, options);
    },
  };
  return { vision, calls, judgeInputs };
}

async function ledgerFor(jobId: string) {
  return base.db.selectFrom('usageLedger').selectAll().where('jobId', '=', jobId).execute();
}

async function openReservationIds(jobId: string): Promise<string[]> {
  const rows = await ledgerFor(jobId);
  return rows
    .filter((row) => row.kind === 'reservation')
    .filter((row) => !rows.some((other) => other.reservationId === row.id))
    .map((row) => row.id);
}

async function attemptsOf(jobId: string) {
  return base.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function streetViewJob(
  deps: PipelineDeps,
  placeId = PLACES.showcase,
  extra: Partial<Parameters<typeof createRenderJobRecord>[1]> = {},
) {
  const { ownerId, projectId, source } = await createStreetViewSource(deps, { placeId });
  const job = await createRenderJobRecord(deps, { ownerId, projectId, source, ...extra });
  return { job, ownerId, projectId, source };
}

let uploadImage: Buffer | null = null;
async function uploadJob(deps: PipelineDeps) {
  uploadImage ??= await sharp(
    (
      await renderFixturePanorama({
        panoId: 'fxSvLanternHillC01p1Sv',
        heading: 0,
        fov: 80,
        pitch: 2,
      })
    )?.image ?? Buffer.alloc(0),
  )
    .resize(1200, 900, { fit: 'fill' })
    .jpeg()
    .toBuffer();
  const { ownerId, projectId, source } = await createUploadSource(deps, {
    image: uploadImage,
    fileName: 'front-porch.jpg',
  });
  const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
  return { job, ownerId, projectId, source };
}

/** Starts a job, waits until its request was sent, then aborts the run as a worker stop does. */
async function abortAfterSend(deps: PipelineDeps, jobId: string) {
  const controller = new AbortController();
  const running = runRenderJob(deps, { renderJobId: jobId, signal: controller.signal });
  await waitFor(async () => {
    const attempt = await base.db
      .selectFrom('renderAttempts')
      .select('providerOperationId')
      .where('jobId', '=', jobId)
      .executeTakeFirst();
    return attempt?.providerOperationId ?? null;
  });
  controller.abort();
  await expect(running).rejects.toBeInstanceOf(JobAborted);
}

/** Hangs after the request is sent until the run aborts (a call the worker never sees end). */
const hangAfterSend: ImageEditor['edit'] = async (_request, _input, options) => {
  const operationId = `stub:${options.attemptId}`;
  await options.onOperation?.(operationId);
  await new Promise<void>((resolve) => {
    if (options.signal.aborted) return resolve();
    options.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  return { status: 'failed', operationId, kind: 'timeout', retryable: true };
};

describe('redelivery never buys a second call for a recorded attempt', () => {
  it('records a worker stop mid-call as unknown and resolves it without a second dispatch', async () => {
    const { editor, calls } = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
    });
    const deps = depsWith({ fixtureImageEditor: editor });
    const { job } = await streetViewJob(deps, PLACES.slow);
    await abortAfterSend(deps, job.id);
    let [attempt] = await attemptsOf(job.id);
    expect(attempt?.outcome).toBe('unknown');
    expect((await readJob(base.db, job.id))?.state).toBe('rendering');
    expect(calls).toHaveLength(1);

    // The queue's transport retry: recovery only, no second paid call.
    const result = await runRenderJob(deps, { renderJobId: job.id });
    expect(result.state).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'unknown_outcome' });
    [attempt] = await attemptsOf(job.id);
    expect(attempt?.outcome).toBe('unknown');
    expect(await openReservationIds(job.id)).toEqual([attempt?.reservationEntryId]);

    const reconciled = await runReconciliation(deps, { jobIds: [job.id], scanObjects: false });
    expect(reconciled.attemptsAssumedCharged).toBe(1);
    const settlement = (await ledgerFor(job.id)).find(
      (row) => row.kind === 'settlement' && row.attemptId === attempt?.id,
    );
    expect(Number(settlement?.units)).toBe(1);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('continues a succeeded attempt to checking without calling the provider again', async () => {
    const controller = new AbortController();
    const first = recordingEditor(base.providers.fixtures.imageEditor, {
      edit: async (request, input, options) => {
        const outcome = await base.providers.fixtures.imageEditor.edit(request, input, options);
        // The worker stops right after the provider answered.
        controller.abort();
        return outcome;
      },
    });
    const { job } = await uploadJob(depsWith({ fixtureImageEditor: first.editor }));
    await expect(
      runRenderJob(depsWith({ fixtureImageEditor: first.editor }), {
        renderJobId: job.id,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(JobAborted);
    const [attempt] = await attemptsOf(job.id);
    expect(attempt).toMatchObject({ outcome: 'succeeded' });
    expect(attempt?.candidateObjectKey).not.toBeNull();
    // A crash between recording the outcome and the state change leaves the job in `rendering`.
    await base.db
      .updateTable('renderJobs')
      .set({ state: 'rendering' })
      .where('id', '=', job.id)
      .execute();

    const second = recordingEditor(base.providers.fixtures.imageEditor);
    const result = await runRenderJob(depsWith({ fixtureImageEditor: second.editor }), {
      renderJobId: job.id,
    });
    expect(result.state).toBe('succeeded');
    expect(second.calls).toHaveLength(0);
    expect(await attemptsOf(job.id)).toHaveLength(1);
    const settlements = (await ledgerFor(job.id)).filter(
      (row) => row.kind === 'settlement' && row.sku === 'image_edit_attempt',
    );
    expect(settlements).toHaveLength(1);
  });

  it('ends a recorded provider failure without dispatching again', async () => {
    const { editor, calls } = recordingEditor(base.providers.fixtures.imageEditor);
    const deps = depsWith({ fixtureImageEditor: editor });
    const { job } = await streetViewJob(deps);
    const hanging = recordingEditor(base.providers.fixtures.imageEditor, { edit: hangAfterSend });
    await abortAfterSend(depsWith({ fixtureImageEditor: hanging.editor }), job.id);
    // The outcome was recorded and settled, then the worker died before failing the job.
    await base.db
      .updateTable('renderAttempts')
      .set({ outcome: 'provider_error' })
      .where('jobId', '=', job.id)
      .execute();
    const result = await runRenderJob(deps, { renderJobId: job.id });
    expect(result.state).toBe('failed');
    expect(calls).toHaveLength(0);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'provider_error' });
  });
});

describe('synchronous editors without a status API', () => {
  it('never re-sends a request that got no answer; the outcome is unknown', async () => {
    const { editor, calls } = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: async (_request, _input, options) => {
        const operationId = `stub:${options.attemptId}`;
        await options.onOperation?.(operationId);
        // The connection dropped while the response was read.
        return { status: 'failed', operationId, kind: 'provider_error', retryable: true };
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'unknown_outcome' });
    const [attempt] = await attemptsOf(job.id);
    expect(attempt).toMatchObject({ outcome: 'unknown', transportRetries: 0 });
    expect(await openReservationIds(job.id)).toEqual([attempt?.reservationEntryId]);
    const reconciled = await runReconciliation(deps, { jobIds: [job.id], scanObjects: false });
    expect(reconciled.attemptsAssumedCharged).toBe(1);
    const after = await attemptsOf(job.id);
    expect(after[0]?.reconciled).toBe('assumed_charged');
  });

  it('re-sends a request the vendor answered with a retryable status (nothing billed)', async () => {
    const { editor, calls } = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: async (_request, _input, options) => {
        const operationId = `stub:${options.attemptId}`;
        await options.onOperation?.(operationId);
        return {
          status: 'failed',
          operationId,
          kind: 'provider_error',
          httpStatus: 503,
          retryable: true,
        };
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(calls).toHaveLength(1 + deps.config.queue.renderTransportRetryLimit);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'provider_error' });
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.outcome).toBe('provider_error');
    const settlement = (await ledgerFor(job.id)).find(
      (row) => row.kind === 'settlement' && row.attemptId === attempt?.id,
    );
    expect(settlement?.amountMicros).toBe(0);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('recovers a pending sent attempt as unknown, never as a $0 provider error', async () => {
    const stub = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: hangAfterSend,
    });
    const deps = depsWith({ fixtureImageEditor: stub.editor });
    const { job } = await streetViewJob(deps);
    await abortAfterSend(deps, job.id);
    // A hard worker death leaves the sent attempt `pending`.
    await base.db
      .updateTable('renderAttempts')
      .set({ outcome: 'pending', completedAt: null })
      .where('jobId', '=', job.id)
      .execute();
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(stub.calls).toHaveLength(1);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'unknown_outcome' });
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.outcome).toBe('unknown');
    const ledger = await ledgerFor(job.id);
    expect(ledger.some((row) => row.kind === 'settlement' && row.attemptId === attempt?.id)).toBe(
      false,
    );
    const reconciled = await runReconciliation(deps, { jobIds: [job.id], scanObjects: false });
    expect(reconciled.attemptsAssumedCharged).toBe(1);
    const settlement = (await ledgerFor(job.id)).find(
      (row) => row.kind === 'settlement' && row.attemptId === attempt?.id,
    );
    expect(Number(settlement?.units)).toBe(1);
  });

  it('dead-letters an attempt left unknown by a worker stop as unknown_outcome', async () => {
    const stub = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: hangAfterSend,
    });
    const deps = depsWith({ fixtureImageEditor: stub.editor });
    const { job } = await streetViewJob(deps);
    await abortAfterSend(deps, job.id);
    expect(await settleDeadRender(deps, { renderJobId: job.id })).toEqual({
      failureKind: 'unknown_outcome',
    });
    const [attempt] = await attemptsOf(job.id);
    expect(await openReservationIds(job.id)).toEqual([attempt?.reservationEntryId]);
  });
});

describe('a reply without an image', () => {
  const noImage = (operationId: string): EditOutcome => ({
    status: 'failed',
    operationId,
    kind: 'provider_error',
    providerCode: 'no_image',
    providerMessage: 'finishReason STOP',
    retryable: false,
  });

  it('is re-dispatched once, and the second answer is used', async () => {
    let call = 0;
    const { editor, calls } = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: async (request, input, options) => {
        call += 1;
        if (call === 1) {
          await options.onOperation?.(`fixture:${options.attemptId}`);
          return noImage(`fixture:${options.attemptId}`);
        }
        return base.providers.fixtures.imageEditor.edit(request, input, options);
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(calls).toHaveLength(2);
    const [attempt] = await attemptsOf(job.id);
    expect(attempt).toMatchObject({ outcome: 'succeeded', transportRetries: 1 });
  });

  it('is re-dispatched at most once', async () => {
    const { editor, calls } = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: async (_request, _input, options) => {
        await options.onOperation?.(`stub:${options.attemptId}`);
        return noImage(`stub:${options.attemptId}`);
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(calls).toHaveLength(2);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'provider_error' });
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.outcome).toBe('provider_error');
    expect(await openReservationIds(job.id)).toEqual([]);
  });
});

describe('kill switches in the worker', () => {
  function counted() {
    const editor = recordingEditor(base.providers.fixtures.imageEditor);
    const vision = countingVision(base.providers.fixtures.vision);
    return { editor, vision };
  }

  it('the global pause stops a queued job before any provider call', async () => {
    const { editor, vision } = counted();
    const deps = depsWith({
      settings: { 'pause.global': true },
      fixtureImageEditor: editor.editor,
      fixtureVision: vision.vision,
    });
    for (const make of [() => streetViewJob(deps), () => uploadJob(deps)]) {
      const { job } = await make();
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
      expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'provider_error' });
      expect(await openReservationIds(job.id)).toEqual([]);
      expect(await attemptsOf(job.id)).toEqual([]);
    }
    expect(editor.calls).toHaveLength(0);
    expect(vision.calls).toEqual({ analyze: 0, judge: 0, localize: 0 });
  });

  it("a provider's pause stops the job before that provider is called", async () => {
    const { editor, vision } = counted();
    const deps = depsWith({
      settings: { 'pause.global': false, 'pause.provider.fixture': true },
      fixtureImageEditor: editor.editor,
      fixtureVision: vision.vision,
    });
    const { job } = await uploadJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(editor.calls).toHaveLength(0);
    expect(vision.calls.analyze).toBe(0);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('a pause stops a job with a reusable analysis before its attempt row', async () => {
    const { editor, vision } = counted();
    const free = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job, ownerId, projectId, source } = await uploadJob(free);
    expect((await runRenderJob(free, { renderJobId: job.id })).state).toBe('succeeded');
    const before = { edits: editor.calls.length, ...vision.calls };

    // The second job reuses the analysis (no vision call), so the planning check stops it.
    const paused = depsWith({
      settings: { 'pause.global': true },
      fixtureImageEditor: editor.editor,
      fixtureVision: vision.vision,
    });
    const next = await createRenderJobRecord(paused, {
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(paused, { renderJobId: next.id })).state).toBe('failed');
    expect(await readJob(base.db, next.id)).toMatchObject({ state: 'failed', attemptCount: 0 });
    expect(editor.calls.length).toBe(before.edits);
    expect(vision.calls).toEqual({
      analyze: before.analyze,
      judge: before.judge,
      localize: before.localize,
    });
    expect(await attemptsOf(next.id)).toEqual([]);
    expect(await openReservationIds(next.id)).toEqual([]);
  });
});

describe('provider legs from their own capabilities', () => {
  function live(providerId: 'gemini' | 'openai', edit?: ImageEditor['edit']) {
    return recordingEditor(base.providers.fixtures.imageEditor, {
      providerId,
      mode: 'live',
      ...(edit ? { edit } : {}),
    });
  }

  it('uses the fixture vision model when vision_analysis is fixture, even with a live editor', async () => {
    const editor = live('gemini');
    const liveVision = countingVision(base.providers.fixtures.vision);
    const fixtureVision = countingVision(base.providers.fixtures.vision);
    const deps = depsWith({
      capabilities: { image_editing: 'live_public', vision_analysis: 'fixture' },
      imageEditor: editor.editor,
      vision: liveVision.vision,
      fixtureVision: fixtureVision.vision,
    });
    const { job } = await uploadJob(deps);
    await runRenderJob(deps, { renderJobId: job.id });
    expect(editor.calls.length).toBeGreaterThan(0);
    expect(liveVision.calls).toEqual({ analyze: 0, judge: 0, localize: 0 });
    expect(fixtureVision.calls.analyze).toBe(1);
  });

  it('uses the live vision model when vision_analysis is live', async () => {
    const editor = live('gemini');
    const liveVision = countingVision(base.providers.fixtures.vision);
    const fixtureVision = countingVision(base.providers.fixtures.vision);
    const deps = depsWith({
      capabilities: { image_editing: 'live_public', vision_analysis: 'live_public' },
      imageEditor: editor.editor,
      vision: liveVision.vision,
      fixtureVision: fixtureVision.vision,
    });
    const { job } = await uploadJob(deps);
    await runRenderJob(deps, { renderJobId: job.id });
    expect(liveVision.calls.analyze).toBe(1);
    expect(fixtureVision.calls).toEqual({ analyze: 0, judge: 0, localize: 0 });
  });

  it('fails policy_denied before any call when vision_analysis is unavailable', async () => {
    const editor = live('gemini');
    const liveVision = countingVision(base.providers.fixtures.vision);
    const deps = depsWith({
      capabilities: { image_editing: 'live_public', vision_analysis: 'live_private' },
      imageEditor: editor.editor,
      vision: liveVision.vision,
    });
    const { job } = await uploadJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'policy_denied' });
    expect(editor.calls).toHaveLength(0);
    expect(liveVision.calls).toEqual({ analyze: 0, judge: 0, localize: 0 });
  });

  it('compiles the configured request settings (Gemini size and thinking level)', async () => {
    const editor = live('gemini');
    const deps = depsWith({
      capabilities: { image_editing: 'live_public' },
      imageEditor: editor.editor,
      imageEdit: { geminiImageSize: '2K', geminiThinkingLevel: 'high' },
    });
    const { job } = await uploadJob(deps);
    await runRenderJob(deps, { renderJobId: job.id });
    expect(editor.calls[0]?.request.parameters).toMatchObject({
      image_size: '2K',
      thinking_level: 'high',
    });
  });

  it('compiles the configured OpenAI quality and mask policy, and settles from token usage', async () => {
    const editor = live('openai', async (request, input, options) => {
      const outcome = await base.providers.fixtures.imageEditor.edit(request, input, options);
      if (outcome.status !== 'completed') return outcome;
      return {
        ...outcome,
        modelSnapshot: 'gpt-image-2.5-flare',
        usage: { inputTokens: 1_964, outputTokens: 1_372, images: 1, raw: { requestId: 'req_1' } },
        providerMode: 'live',
      };
    });
    const deps = depsWith({
      capabilities: { image_editing: 'live_public' },
      imageEditor: editor.editor,
      imageEdit: { openaiQuality: 'high', providerMask: 'tight' },
    });
    const { job } = await uploadJob(deps);
    await runRenderJob(deps, { renderJobId: job.id });
    expect(editor.calls[0]?.request.parameters).toMatchObject({ quality: 'high' });
    expect(editor.calls[0]?.request.mask).toBeDefined();
    expect(editor.calls[0]?.mask).toBe(true);
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.providerUsage).toMatchObject({
      inputTokens: 1_964,
      outputTokens: 1_372,
      raw: { requestId: 'req_1' },
    });
    const settlement = (await ledgerFor(job.id)).find(
      (row) =>
        row.kind === 'settlement' &&
        row.attemptId === attempt?.id &&
        row.sku === 'image_edit_attempt',
    );
    // $8 and $30 per million input and output tokens (economics cost worksheet).
    expect(settlement?.amountMicros).toBe(1_964 * 8 + 1_372 * 30);
  });
});

describe('usage and compositing records', () => {
  it('stores provider usage, vision usage and the photometric alignment record', async () => {
    const { job, source } = await streetViewJob(base);
    expect((await runRenderJob(base, { renderJobId: job.id })).state).toBe('succeeded');
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.providerUsage).toMatchObject({ images: 1 });
    const analysis = await base.db
      .selectFrom('sceneAnalyses')
      .selectAll()
      .where('sourceAssetId', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(analysis.usage).toHaveProperty('inputTokens');
    const judge = await base.db
      .selectFrom('judgeResults')
      .selectAll()
      .where('attemptId', '=', attempt?.id as string)
      .executeTakeFirstOrThrow();
    expect(judge.usage).toHaveProperty('outputTokens');
    const compositing = (judge.deterministicChecks as { compositing?: Record<string, unknown> })
      .compositing;
    expect(compositing?.photometric).toMatchObject({ applied: expect.any(Boolean) });
  });
});

describe('evening: the editor relights the accepted daylight variant', () => {
  /** Raw RGB pixels of an encoded image. */
  async function pixels(bytes: Uint8Array): Promise<Buffer> {
    return sharp(bytes).removeAlpha().raw().toBuffer();
  }

  async function meanLuma(bytes: Uint8Array): Promise<number> {
    const stats = await sharp(bytes).greyscale().stats();
    return stats.channels[0]?.mean ?? 0;
  }

  async function assetOf(jobId: string) {
    return base.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', jobId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
  }

  it('relights an existing daylight variant: the provider gets its image and no mask', async () => {
    const editor = recordingEditor(base.providers.fixtures.imageEditor);
    const vision = countingVision(base.providers.fixtures.vision);
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job: dayJob, ownerId, projectId, source } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: dayJob.id })).state).toBe('succeeded');
    const day = await assetOf(dayJob.id);
    const dayBytes = (await base.storage.get('private', day?.objectKey as string))?.body;

    const evening = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    const before = editor.calls.length;
    expect((await runRenderJob(deps, { renderJobId: evening.id })).state).toBe('succeeded');
    const calls = editor.calls.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.request.kind).toBe('relight');
    expect(calls[0]?.request.parameters.relight).toBe(true);
    expect(calls[0]?.request.mask).toBeUndefined();
    expect(calls[0]?.mask).toBe(false);
    // The provider input is the delivered daylight image on the working grid.
    expect(
      (await pixels(calls[0]?.image as Uint8Array)).equals(await pixels(dayBytes as Buffer)),
    ).toBe(true);
    const attempts = await attemptsOf(evening.id);
    expect(attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'global_relight'],
    ]);
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight',
      base: 'variant',
      baseJobId: dayJob.id,
      baseAttemptId: (await attemptsOf(dayJob.id))[0]?.id,
      basePlanId: (await attemptsOf(dayJob.id))[0]?.decorationPlanId,
      baseRenderAssetId: day?.id,
    });
    // The judge compared the relit image with the daylight variant.
    const relightJudge = vision.judgeInputs[vision.judgeInputs.length - 1];
    expect(relightJudge?.mode).toBe('relight');
    expect(relightJudge?.base).toBeDefined();
    const asset = await assetOf(evening.id);
    expect(asset).toMatchObject({ lightingMode: 'evening', fidelityMode: 'global_relight' });
    const relit = await base.storage.get('private', asset?.objectKey as string);
    expect(await meanLuma(relit?.body as Buffer)).toBeLessThan(
      0.8 * (await meanLuma(dayBytes as Buffer)),
    );
    expect(await openReservationIds(evening.id)).toEqual([]);
  });

  it('without a daylight variant, publishes it first and relights it: two variants, one job', async () => {
    const editor = recordingEditor(base.providers.fixtures.imageEditor);
    const deps = depsWith({ fixtureImageEditor: editor.editor });
    const { job, projectId } = await streetViewJob(deps, PLACES.showcase, {
      lightingMode: 'evening',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome, a.fidelityMode])).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'succeeded', 'global_relight'],
    ]);
    expect(editor.calls.map((call) => call.request.kind ?? 'decorate')).toEqual([
      'decorate',
      'relight',
    ]);
    expect(editor.calls[1]?.mask).toBe(false);
    // Relighting the job's own daylight base is its second attempt, not a repair.
    expect(await readJob(base.db, job.id)).toMatchObject({ attemptCount: 2, repairUsed: false });
    const succeededEvents = await base.db
      .selectFrom('analyticsEvents')
      .select('properties')
      .where('eventName', '=', 'render_succeeded')
      .where(
        'sessionHash',
        '=',
        dailySaltedHash(base.config.sessionSecret, `owner:${job.ownerId}`, base.clock.now()),
      )
      .execute();
    expect(succeededEvents.map((event) => event.properties)).toEqual([
      expect.objectContaining({ attempts: 2, repaired: false, lightingMode: 'evening' }),
    ]);
    const assets = await base.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt')
      .execute();
    expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
      ['source', 'composite_additive'],
      ['evening', 'global_relight'],
    ]);
    const [day, evening] = assets;
    expect(evening?.jobId).toBe(job.id);
    // The daylight variant has its own key, labels and download, under a companion job.
    const companion = await readJob(base.db, day?.jobId as string);
    expect(companion).toMatchObject({
      state: 'succeeded',
      lightingMode: 'source',
      idempotencyKey: `relight-base:${job.id}`,
      renderAssetId: day?.id,
    });
    expect(day?.variantKey).toBe(companion?.variantKey);
    expect(day?.downloadable).toBe(evening?.downloadable);
    // The relight's input is the published daylight image.
    const dayBytes = (await base.storage.get('private', day?.objectKey as string))?.body;
    expect(
      (await pixels(editor.calls[1]?.image as Uint8Array)).equals(await pixels(dayBytes as Buffer)),
    ).toBe(true);
    expect(attempts[1]?.fallback).toMatchObject({
      kind: 'relight',
      base: 'attempt',
      baseAttemptId: attempts[0]?.id,
      baseRenderAssetId: day?.id,
    });
    // Fixture mode delivers an evening variant: darker than the daylight one.
    const relit = await base.storage.get('private', evening?.objectKey as string);
    expect(await meanLuma(relit?.body as Buffer)).toBeLessThan(
      0.8 * (await meanLuma(dayBytes as Buffer)),
    );
    expect(await openReservationIds(job.id)).toEqual([]);

    // A later evening request finds the published daylight variant and relights it directly.
    const again = await createRenderJobRecord(deps, {
      ownerId: job.ownerId,
      projectId,
      source: await base.db
        .selectFrom('sourceAssets')
        .selectAll()
        .where('id', '=', job.sourceAssetId)
        .executeTakeFirstOrThrow(),
      lightingMode: 'evening',
    });
    expect((await runRenderJob(deps, { renderJobId: again.id })).state).toBe('succeeded');
    expect((await attemptsOf(again.id))[0]?.fallback).toMatchObject({
      base: 'variant',
      baseAttemptId: attempts[0]?.id,
      baseRenderAssetId: day?.id,
    });
  });

  it('a relight rejected after its repair rejects the job; nothing deterministic is delivered', async () => {
    const editor = recordingEditor(base.providers.fixtures.imageEditor, {
      providerId: 'openai',
      mode: 'live',
      edit: async (request, input, options) => {
        const outcome = await base.providers.fixtures.imageEditor.edit(request, input, options);
        return outcome.status === 'completed' ? { ...outcome, providerMode: 'live' } : outcome;
      },
    });
    const inner = base.providers.fixtures.vision;
    const vision = countingVision(inner, async (input, options) => {
      const result = await inner.judge(input, options);
      if (input.mode !== 'relight') return result;
      return {
        ...result,
        result: {
          ...result.result,
          critical: [
            { code: 'structure_changed', confidence: 0.97, evidence: 'The front door changed.' },
          ],
        },
      };
    });
    const deps = depsWith({
      capabilities: { image_editing: 'live_public' },
      imageEditor: editor.editor,
      fixtureVision: vision.vision,
    });
    const { job: dayJob, ownerId, projectId, source } = await uploadJob(deps);
    expect((await runRenderJob(deps, { renderJobId: dayJob.id })).state).toBe('succeeded');
    const evening = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    const before = editor.calls.length;
    expect((await runRenderJob(deps, { renderJobId: evening.id })).state).toBe('rejected');
    expect(await readJob(base.db, evening.id)).toMatchObject({
      rejectionReason: 'qa_critical',
      failureCodes: ['structure_changed'],
      attemptCount: 2,
    });
    const calls = editor.calls.slice(before);
    expect(calls.map((call) => call.request.kind)).toEqual(['relight', 'relight']);
    expect(calls.every((call) => !call.mask)).toBe(true);
    expect(calls[1]?.request.instructionText).toContain(RELIGHT_REPAIR_KEEP);
    expect(calls[0]?.request.instructionText).not.toContain(RELIGHT_REPAIR_KEEP);
    const attempts = await attemptsOf(evening.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'qa_rejected'],
    ]);
    // The second relight carries the rejecting codes as repair constraints: it is a repair.
    expect(await readJob(base.db, evening.id)).toMatchObject({ repairUsed: true });
    expect(await assetOf(evening.id)).toBeUndefined();
    expect(await openReservationIds(evening.id)).toEqual([]);
  });

  it('never relights a daylight base that failed: a rejected base rejects the job', async () => {
    const inner = base.providers.fixtures.vision;
    const vision = countingVision(inner, async (input, options) => {
      const result = await inner.judge(input, options);
      return {
        ...result,
        result: {
          ...result.result,
          critical: [
            { code: 'structure_changed', confidence: 0.97, evidence: 'The front door changed.' },
          ],
        },
      };
    });
    const editor = recordingEditor(base.providers.fixtures.imageEditor);
    const deps = depsWith({ fixtureVision: vision.vision, fixtureImageEditor: editor.editor });
    const { job, projectId } = await streetViewJob(deps, PLACES.showcase, {
      lightingMode: 'evening',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(await readJob(base.db, job.id)).toMatchObject({
      rejectionReason: 'qa_critical',
      failureCodes: ['structure_changed'],
      attemptCount: 1,
    });
    expect(editor.calls).toHaveLength(1);
    expect(
      await base.db
        .selectFrom('renderAssets')
        .select('id')
        .where('projectId', '=', projectId)
        .execute(),
    ).toEqual([]);
    expect(await openReservationIds(job.id)).toEqual([]);
  });
});

describe('localized compositing', () => {
  /** A box of `size` (normalized) clear of every placement region by `margin`, scanning a grid. */
  function clearBox(
    placements: readonly { region: NormalizedBox }[],
    avoid: readonly NormalizedBox[],
    size: number,
    margin: number,
  ): NormalizedBox {
    const overlaps = (a: NormalizedBox, b: NormalizedBox, pad: number) =>
      a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad;
    for (let y = 0.05; y + size <= 0.95; y += 0.02) {
      for (let x = 0.05; x + size <= 0.95; x += 0.02) {
        const box: NormalizedBox = [x, y, x + size, y + size];
        if (placements.some((p) => overlaps(box, p.region, margin))) continue;
        if (avoid.some((other) => overlaps(box, other, margin))) continue;
        return box;
      }
    }
    throw new Error('no clear box');
  }

  /** Paints solid squares onto an editor's output (normalized boxes on the output grid). */
  async function paint(
    image: Uint8Array,
    squares: readonly { box: NormalizedBox; color: [number, number, number] }[],
  ): Promise<Buffer> {
    const meta = await sharp(image).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    return sharp(image)
      .composite(
        squares.map(({ box, color }) => ({
          input: {
            create: {
              width: Math.round((box[2] - box[0]) * w),
              height: Math.round((box[3] - box[1]) * h),
              channels: 3 as const,
              background: { r: color[0], g: color[1], b: color[2] },
            },
          },
          left: Math.round(box[0] * w),
          top: Math.round(box[1] * h),
        })),
      )
      .jpeg({ quality: 95 })
      .toBuffer();
  }

  /** Mean color of the middle of a normalized box in an encoded image. */
  async function meanColor(
    bytes: Uint8Array,
    box: NormalizedBox,
  ): Promise<[number, number, number]> {
    const { data, info } = await sharp(bytes)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bw = box[2] - box[0];
    const bh = box[3] - box[1];
    const x0 = Math.round((box[0] + bw * 0.25) * info.width);
    const x1 = Math.round((box[2] - bw * 0.25) * info.width);
    const y0 = Math.round((box[1] + bh * 0.25) * info.height);
    const y1 = Math.round((box[3] - bh * 0.25) * info.height);
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        for (let c = 0; c < 3; c += 1)
          sum[c] = (sum[c] as number) + (data[(y * info.width + x) * 3 + c] as number);
        n += 1;
      }
    }
    return sum.map((value) => value / Math.max(1, n)) as [number, number, number];
  }

  /**
   * An editor that adds a red item outside every planned region (which the localizer reports)
   * and turns another spot blue (an unrequested change nobody reports).
   */
  function strayEditor(boxes: { red?: NormalizedBox; blue?: NormalizedBox }) {
    return recordingEditor(base.providers.fixtures.imageEditor, {
      edit: async (request, input, options) => {
        const outcome = await base.providers.fixtures.imageEditor.edit(request, input, options);
        if (outcome.status !== 'completed') return outcome;
        const placements = input.fixture?.placements ?? [];
        const avoid = [
          ...(input.fixture?.attributionRegion ? [input.fixture.attributionRegion] : []),
          ...(input.fixture?.preserveRegions ?? []),
        ];
        boxes.red ??= clearBox(placements, avoid, 0.08, 0.07);
        boxes.blue ??= clearBox(placements, [...avoid, boxes.red], 0.08, 0.07);
        const image = await paint(outcome.image, [
          { box: boxes.red, color: [220, 20, 20] },
          { box: boxes.blue, color: [20, 40, 220] },
        ]);
        return { ...outcome, image };
      },
    });
  }

  function reportingLocalizer(
    boxes: { red?: NormalizedBox },
    otherChanges: LocalizedChange[] | (() => LocalizedChange[]) = [],
  ) {
    const inner = base.providers.fixtures.vision;
    return countingVision(inner, undefined, async (input, options) => {
      const planned = await inner.localizeAdditions(input, options);
      return {
        ...planned,
        result: {
          added: [
            ...planned.result.added,
            { label: 'red lantern', box: boxes.red as NormalizedBox, placementId: null },
          ],
          otherChanges: typeof otherChanges === 'function' ? otherChanges() : otherChanges,
        },
      };
    });
  }

  it('keeps a reported decoration outside the plan and restores an unreported change', async () => {
    const boxes: { red?: NormalizedBox; blue?: NormalizedBox } = {};
    const editor = strayEditor(boxes);
    // Two other changes: one where the editor turned a spot blue (outside the keep-mask, so the
    // paste-back restores it) and one inside the kept red item's box.
    const vision = reportingLocalizer(boxes, () => [
      { description: 'rocking chair moved to the left', box: boxes.blue as NormalizedBox },
      { description: 'porch light replaced', box: boxes.red as NormalizedBox },
    ]);
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job, source } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(vision.calls.localize).toBe(1);
    const asset = await base.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const delivered = (await base.storage.get('private', asset.objectKey))?.body as Buffer;
    const red = await meanColor(delivered, boxes.red as NormalizedBox);
    expect(red[0]).toBeGreaterThan(180);
    expect(red[1]).toBeLessThan(80);
    const blue = await meanColor(delivered, boxes.blue as NormalizedBox);
    expect(blue[2] - blue[0]).toBeLessThan(60);
    expect(source.kind).toBe('street_view');

    const [attempt] = await attemptsOf(job.id);
    const localization = (attempt?.compositeMask as { localization?: Record<string, unknown> })
      .localization;
    expect(localization).toMatchObject({
      status: 'localized',
      model: expect.any(String),
      promptVersion: expect.any(String),
      dropped: [],
      otherChanges: [
        { description: 'rocking chair moved to the left', box: boxes.blue },
        { description: 'porch light replaced', box: boxes.red },
      ],
    });
    expect(localization?.items).toContainEqual({
      label: 'red lantern',
      box: boxes.red,
      placementId: null,
    });
    expect(localization?.coverage).toBeGreaterThan(0);
    // Settled from usage as a vision call of the localizing stage against its own reservation,
    // recorded on the attempt; the judge settles against a judge reservation.
    const ledger = await ledgerFor(job.id);
    const settlements = ledger.filter(
      (row) => row.kind === 'settlement' && row.sku === 'vision_call',
    );
    const localizing = settlements.filter((row) => row.stage === 'localizing');
    expect(localizing).toHaveLength(1);
    expect(localizing[0]?.attemptId).toBe(attempt?.id);
    expect(localization?.ledgerEntryId).toBe(localizing[0]?.id);
    expect(settlements.filter((row) => row.stage === 'checking')).toHaveLength(1);
    // The change outside the keep-mask reaches the judge as restored from the original; the one
    // inside the kept decorations as an unrequested change to inspect.
    expect(vision.judgeInputs[0]?.hints).toContainEqual(
      expect.stringContaining('restored from the original: rocking chair moved to the left'),
    );
    expect(vision.judgeInputs[0]?.hints).toContainEqual(
      expect.stringContaining(
        'unrequested change inside the kept decorations: porch light replaced',
      ),
    );
    expect(vision.judgeInputs[0]?.hints).not.toContainEqual(
      expect.stringContaining('restored from the original: porch light replaced'),
    );
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('reuses a recorded localization on redelivery (no second paid call)', async () => {
    const controller = new AbortController();
    const boxes: { red?: NormalizedBox } = {};
    const editor = strayEditor(boxes);
    const inner = base.providers.fixtures.vision;
    const first = countingVision(inner, undefined, async (input, options) => {
      const planned = await inner.localizeAdditions(input, options);
      // The worker stops right after the localizer answered.
      controller.abort();
      return {
        ...planned,
        result: {
          ...planned.result,
          added: [
            ...planned.result.added,
            { label: 'red lantern', box: boxes.red as NormalizedBox, placementId: null },
          ],
        },
      };
    });
    const deps1 = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: first.vision });
    // A stored source keeps the raw output, which the redelivery composites again.
    const stored = await createStreetViewSource(deps1, {
      placeId: PLACES.showcase,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(deps1, stored);
    await expect(
      runRenderJob(deps1, { renderJobId: job.id, signal: controller.signal }),
    ).rejects.toBeInstanceOf(JobAborted);
    expect(first.calls.localize).toBe(1);
    expect((await readJob(base.db, job.id))?.state).toBe('checking');

    const second = countingVision(inner);
    const deps2 = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: second.vision });
    expect((await runRenderJob(deps2, { renderJobId: job.id })).state).toBe('succeeded');
    expect(second.calls.localize).toBe(0);
    const localizing = (await ledgerFor(job.id)).filter(
      (row) =>
        row.kind !== 'reservation' && row.sku === 'vision_call' && row.stage === 'localizing',
    );
    expect(localizing.filter((row) => row.kind !== 'release')).toHaveLength(1);
    const asset = await base.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const delivered = (await base.storage.get('private', asset.objectKey))?.body as Buffer;
    expect((await meanColor(delivered, boxes.red as NormalizedBox))[0]).toBeGreaterThan(180);
  });

  it('falls back to the plan mask when the localizer fails, and records it', async () => {
    const boxes: { red?: NormalizedBox } = {};
    const editor = strayEditor(boxes);
    const vision = countingVision(base.providers.fixtures.vision, undefined, async () => {
      throw new ProviderError('fixture', 'provider_error', 'localizer down', { retryable: false });
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [attempt] = await attemptsOf(job.id);
    expect((attempt?.compositeMask as { localization?: unknown }).localization).toMatchObject({
      status: 'fallback',
      fallbackReason: 'provider_error',
      items: [],
    });
    expect(
      (await ledgerFor(job.id)).some(
        (row) => row.kind !== 'reservation' && row.stage === 'localizing' && row.kind !== 'release',
      ),
    ).toBe(false);
    // With the plan mask only, the stray item is restored from the original.
    const asset = await base.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const delivered = (await base.storage.get('private', asset.objectKey))?.body as Buffer;
    expect((await meanColor(delivered, boxes.red as NormalizedBox))[0]).toBeLessThan(180);
  });
});

describe('judge records', () => {
  it('records a deterministic rejection as decision reject with its codes', async () => {
    // A square output for a wide working image: registration rejects it (`camera_changed`).
    const editor = recordingEditor(base.providers.fixtures.imageEditor, {
      edit: async (request, input, options) => {
        const outcome = await base.providers.fixtures.imageEditor.edit(request, input, options);
        if (outcome.status !== 'completed') return outcome;
        const meta = await sharp(outcome.image).metadata();
        const side = Math.min(meta.width ?? 0, meta.height ?? 0);
        const image = await sharp(outcome.image)
          .resize(Math.round(side * 0.6), side, { fit: 'fill' })
          .jpeg()
          .toBuffer();
        return { ...outcome, image, width: Math.round(side * 0.6), height: side };
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor });
    const { job } = await uploadJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const rows = await base.db
      .selectFrom('judgeResults as r')
      .innerJoin('renderAttempts as a', 'a.id', 'r.attemptId')
      .select(['r.decision', 'r.criticalCodes', 'r.majorCodes', 'r.modelId'])
      .where('a.jobId', '=', job.id)
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({
        modelId: 'deterministic-checks',
        decision: 'reject',
        criticalCodes: ['camera_changed'],
      });
    }
  });

  it('writes the judge row and its settlement together: a crash between them pays once', async () => {
    // A failure while the judge row is written (a worker death at that point) after the call.
    await sql`
      create or replace function holiday_test_judge_crash() returns trigger as $$
      begin raise exception 'worker died while recording the judge'; end;
      $$ language plpgsql`.execute(base.db);
    await sql`drop trigger if exists holiday_test_judge_crash on judge_results`.execute(base.db);
    await sql`
      create trigger holiday_test_judge_crash before insert on judge_results
      for each row when (new.model_id = 'crash-test')
      execute function holiday_test_judge_crash()`.execute(base.db);
    try {
      const controller = new AbortController();
      const inner = base.providers.fixtures.vision;
      const first = countingVision(inner, async (input, options) => {
        const result = await inner.judge(input, options);
        controller.abort();
        return { ...result, result: { ...result.result, judgeModel: 'crash-test' } };
      });
      const deps1 = depsWith({ fixtureVision: first.vision });
      const { job } = await uploadJob(deps1);
      await expect(
        runRenderJob(deps1, { renderJobId: job.id, signal: controller.signal }),
      ).rejects.toThrow();
      expect(first.calls.judge).toBe(1);
      const judgeSettlements = async () =>
        (await ledgerFor(job.id)).filter(
          (row) =>
            row.kind !== 'reservation' &&
            row.kind !== 'release' &&
            row.sku === 'vision_call' &&
            row.stage === 'checking',
        );
      // Nothing of the unrecorded call was settled.
      expect(await judgeSettlements()).toHaveLength(0);

      const second = countingVision(inner);
      const deps2 = depsWith({ fixtureVision: second.vision });
      expect((await runRenderJob(deps2, { renderJobId: job.id })).state).toBe('succeeded');
      expect(second.calls.judge).toBe(1);
      const settled = await judgeSettlements();
      expect(settled).toHaveLength(1);
      const row = await base.db
        .selectFrom('judgeResults as r')
        .innerJoin('renderAttempts as a', 'a.id', 'r.attemptId')
        .select(['r.ledgerEntryId'])
        .where('a.jobId', '=', job.id)
        .executeTakeFirstOrThrow();
      expect(row.ledgerEntryId).toBe(settled[0]?.id);
      expect(await openReservationIds(job.id)).toEqual([]);
    } finally {
      await sql`drop trigger if exists holiday_test_judge_crash on judge_results`.execute(base.db);
      await sql`drop function if exists holiday_test_judge_crash()`.execute(base.db);
    }
  });
});

describe('a 200 response whose body cannot be read', () => {
  it('is an unknown outcome settled as charged, never a $0 provider error', async () => {
    const { editor, calls } = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: async (_request, _input, options) => {
        const operationId = `stub:${options.attemptId}`;
        await options.onOperation?.(operationId);
        return {
          status: 'failed',
          operationId,
          kind: 'provider_error',
          providerCode: 'invalid_json',
          httpStatus: 200,
          retryable: false,
        };
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(calls).toHaveLength(1);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'unknown_outcome' });
    const [attempt] = await attemptsOf(job.id);
    expect(attempt).toMatchObject({ outcome: 'unknown' });
    expect(attempt?.errorDetail).toMatchObject({ unresolved: 'unreadable_response' });
    const ledger = await ledgerFor(job.id);
    expect(ledger.some((row) => row.kind === 'settlement' && row.attemptId === attempt?.id)).toBe(
      false,
    );
    expect(await openReservationIds(job.id)).toEqual([attempt?.reservationEntryId]);
    const reconciled = await runReconciliation(deps, { jobIds: [job.id], scanObjects: false });
    expect(reconciled.attemptsAssumedCharged).toBe(1);
    const settlement = (await ledgerFor(job.id)).find(
      (row) => row.kind === 'settlement' && row.attemptId === attempt?.id,
    );
    expect(Number(settlement?.units)).toBe(1);
    expect(settlement?.amountMicros).toBeGreaterThan(0);
  });
});

describe('judge reuse on redelivery', () => {
  it('reuses the recorded judge result after a crash between the judge call and publishing', async () => {
    const controller = new AbortController();
    const first = countingVision(base.providers.fixtures.vision, async (input, options) => {
      const result = await base.providers.fixtures.vision.judge(input, options);
      // The worker stops right after the judge answered.
      controller.abort();
      return result;
    });
    const deps1 = depsWith({ fixtureVision: first.vision });
    const { job } = await uploadJob(deps1);
    await expect(
      runRenderJob(deps1, { renderJobId: job.id, signal: controller.signal }),
    ).rejects.toBeInstanceOf(JobAborted);
    expect(first.calls.judge).toBe(1);
    expect((await readJob(base.db, job.id))?.state).toBe('checking');
    const [attempt] = await attemptsOf(job.id);
    const judged = await base.db
      .selectFrom('judgeResults')
      .select(['id', 'decision'])
      .where('attemptId', '=', attempt?.id as string)
      .execute();
    expect(judged).toHaveLength(1);

    // The queue's transport retry: the recorded judge result decides; no second paid call.
    const second = countingVision(base.providers.fixtures.vision);
    const deps2 = depsWith({ fixtureVision: second.vision });
    expect((await runRenderJob(deps2, { renderJobId: job.id })).state).toBe('succeeded');
    expect(second.calls.judge).toBe(0);
    const judgeSettlements = (await ledgerFor(job.id)).filter(
      (row) => row.kind === 'settlement' && row.sku === 'vision_call' && row.stage === 'checking',
    );
    expect(judgeSettlements).toHaveLength(1);
    const asset = await base.db
      .selectFrom('renderAssets')
      .select('id')
      .where('jobId', '=', job.id)
      .executeTakeFirst();
    expect(asset).toBeDefined();
    expect(await openReservationIds(job.id)).toEqual([]);
  });
});

describe('terminating a job with a sent attempt', () => {
  it('marks a sent attempt still pending as unknown, keeping its reservation', async () => {
    const stub = recordingEditor(base.providers.fixtures.imageEditor, {
      capabilities: SYNCHRONOUS,
      getOperation: NO_STATUS_API,
      edit: hangAfterSend,
    });
    const deps = depsWith({ fixtureImageEditor: stub.editor });
    const { job } = await streetViewJob(deps);
    await abortAfterSend(deps, job.id);
    // A hard worker death leaves the sent attempt `pending`.
    await base.db
      .updateTable('renderAttempts')
      .set({ outcome: 'pending', completedAt: null })
      .where('jobId', '=', job.id)
      .execute();
    const ended = await terminateRenderJob(deps, { jobId: job.id, to: 'canceled' });
    expect(ended?.state).toBe('canceled');
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.outcome).toBe('unknown');
    expect(await openReservationIds(job.id)).toEqual([attempt?.reservationEntryId]);
    const reconciled = await runReconciliation(deps, { jobIds: [job.id], scanObjects: false });
    expect(reconciled.attemptsAssumedCharged).toBe(1);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('never sends an attempt that a termination canceled before the send', async () => {
    let jobId = '';
    let sends = 0;
    const stub = recordingEditor(base.providers.fixtures.imageEditor, {
      edit: async (_request, _input, options) => {
        // The job is canceled between the attempt row and the send.
        await terminateRenderJob(deps, { jobId, to: 'canceled' });
        const operationId = `stub:${options.attemptId}`;
        await options.onOperation?.(operationId);
        sends += 1;
        return { status: 'failed', operationId, kind: 'provider_error', retryable: false };
      },
    });
    const deps = depsWith({ fixtureImageEditor: stub.editor });
    const { job } = await streetViewJob(deps);
    jobId = job.id;
    expect(await runRenderJob(deps, { renderJobId: job.id })).toMatchObject({
      state: 'canceled',
      stopped: true,
    });
    expect(stub.calls).toHaveLength(1);
    expect(sends).toBe(0);
    const [attempt] = await attemptsOf(job.id);
    expect(attempt).toMatchObject({
      outcome: 'canceled',
      providerOperationId: null,
      requestSentAt: null,
    });
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('never re-sends on a transport retry once a termination marked the sent attempt unknown', async () => {
    let jobId = '';
    let sends = 0;
    const stub = recordingEditor(base.providers.fixtures.imageEditor, {
      edit: async (_request, _input, options) => {
        const operationId = `stub:${options.attemptId}`;
        await options.onOperation?.(operationId);
        sends += 1;
        // The job is canceled while the request is out; the vendor then answers retryable.
        await terminateRenderJob(deps, { jobId, to: 'canceled' });
        return {
          status: 'failed',
          operationId,
          kind: 'provider_error',
          httpStatus: 503,
          retryable: true,
        };
      },
    });
    const deps = depsWith({ fixtureImageEditor: stub.editor });
    const { job } = await streetViewJob(deps);
    jobId = job.id;
    expect(await runRenderJob(deps, { renderJobId: job.id })).toMatchObject({
      state: 'canceled',
      stopped: true,
    });
    // The retry reached the editor, which reports the operation before sending: refused there.
    expect(stub.calls).toHaveLength(2);
    expect(sends).toBe(1);
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.outcome).toBe('unknown');
    expect(await openReservationIds(job.id)).toEqual([attempt?.reservationEntryId]);
  });

  it('re-dispatches an operation the provider never saw, and guards its retries the same way', async () => {
    const hanging = recordingEditor(base.providers.fixtures.imageEditor, { edit: hangAfterSend });
    const stopped = await streetViewJob(depsWith({ fixtureImageEditor: hanging.editor }));
    const retried = await streetViewJob(depsWith({ fixtureImageEditor: hanging.editor }));
    for (const { job } of [stopped, retried]) {
      await abortAfterSend(depsWith({ fixtureImageEditor: hanging.editor }), job.id);
      expect((await attemptsOf(job.id))[0]?.outcome).toBe('unknown');
    }
    // The redelivery finds the recorded operation unknown to the provider and sends again; the
    // vendor answers retryable once.
    const redelivery = (terminate: string | null) => {
      const seen: (string | undefined)[] = [];
      const stub = recordingEditor(base.providers.fixtures.imageEditor, {
        edit: async (request, input, options) => {
          if (seen.length > 0)
            return base.providers.fixtures.imageEditor.edit(request, input, options);
          const operationId = `stub:${options.attemptId}`;
          await options.onOperation?.(operationId);
          const [row] = await base.db
            .selectFrom('renderAttempts')
            .select('outcome')
            .where('id', '=', options.attemptId)
            .execute();
          seen.push(row?.outcome);
          if (terminate) await terminateRenderJob(deps, { jobId: terminate, to: 'canceled' });
          return {
            status: 'failed',
            operationId,
            kind: 'provider_error',
            httpStatus: 503,
            retryable: true,
          };
        },
      });
      const deps = depsWith({ fixtureImageEditor: stub.editor });
      return { deps, stub, seen };
    };

    // Without a termination the re-dispatch reopens the attempt and its retry is sent.
    const plain = redelivery(null);
    expect((await runRenderJob(plain.deps, { renderJobId: retried.job.id })).state).toBe(
      'succeeded',
    );
    expect(plain.seen).toEqual(['pending']);
    expect(plain.stub.calls).toHaveLength(2);
    expect((await attemptsOf(retried.job.id))[0]?.outcome).toBe('succeeded');

    // A termination while the re-dispatched request is out stops the retry before it is sent.
    const ended = redelivery(stopped.job.id);
    expect(await runRenderJob(ended.deps, { renderJobId: stopped.job.id })).toMatchObject({
      state: 'canceled',
      stopped: true,
    });
    expect(ended.seen).toEqual(['pending']);
    expect(ended.stub.calls).toHaveLength(2);
    const [attempt] = await attemptsOf(stopped.job.id);
    expect(attempt?.outcome).toBe('unknown');
    expect(attempt?.providerOperationId).toBe(`stub:${attempt?.id}`);
    expect(await openReservationIds(stopped.job.id)).toEqual([attempt?.reservationEntryId]);
  });

  it('never re-dispatches for a job a termination ended while the operation was looked up', async () => {
    const hanging = recordingEditor(base.providers.fixtures.imageEditor, { edit: hangAfterSend });
    const { job } = await streetViewJob(depsWith({ fixtureImageEditor: hanging.editor }));
    await abortAfterSend(depsWith({ fixtureImageEditor: hanging.editor }), job.id);
    let sends = 0;
    const stub = recordingEditor(base.providers.fixtures.imageEditor, {
      edit: async (_request, _input, options) => {
        await options.onOperation?.(`stub:${options.attemptId}`);
        sends += 1;
        return { status: 'failed', operationId: 'x', kind: 'provider_error', retryable: false };
      },
      getOperation: async (operationId) => {
        await terminateRenderJob(deps, { jobId: job.id, to: 'canceled' });
        return base.providers.fixtures.imageEditor.getOperation(operationId);
      },
    });
    const deps = depsWith({ fixtureImageEditor: stub.editor });
    expect(await runRenderJob(deps, { renderJobId: job.id })).toMatchObject({
      state: 'canceled',
      stopped: true,
    });
    expect(stub.calls).toHaveLength(1);
    expect(sends).toBe(0);
    expect((await attemptsOf(job.id))[0]?.outcome).toBe('unknown');
  });

  it('leaves an attempt that was never sent as it is', async () => {
    const deps = depsWith({});
    const { job } = await streetViewJob(deps);
    const ended = await terminateRenderJob(deps, { jobId: job.id, to: 'superseded' });
    expect(ended?.state).toBe('superseded');
    expect(await attemptsOf(job.id)).toEqual([]);
    expect(await openReservationIds(job.id)).toEqual([]);
  });
});

describe('a panorama found removed at render time', () => {
  function streetViewAnswering(answer: 'removed' | 'replaced' | 'error'): StreetViewProvider {
    const inner = base.providers.fixtures.streetView;
    return {
      ...inner,
      async refreshPanorama(panoId) {
        if (answer === 'error') throw new Error('metadata unavailable');
        return {
          status: 'missing',
          metadata: {
            status: answer === 'removed' ? 'ZERO_RESULTS' : 'OK',
            panoId: answer === 'removed' ? null : `${panoId}-newer`,
            location: null,
            date: null,
            copyright: null,
          },
        };
      },
    } as StreetViewProvider;
  }

  async function renderedSource(streetViewMode: 'transient' | 'persist') {
    const { ownerId, projectId, source } = await createStreetViewSource(base, {
      placeId: PLACES.showcase,
      streetViewMode,
    });
    const first = await createRenderJobRecord(base, { ownerId, projectId, source });
    expect((await runRenderJob(base, { renderJobId: first.id })).state).toBe('succeeded');
    const stored = await base.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    return { ownerId, projectId, source: stored };
  }

  async function liveVariants(sourceId: string) {
    return base.db
      .selectFrom('renderAssets')
      .select(['id', 'objectKey'])
      .where('sourceAssetId', '=', sourceId)
      .where('deletedAt', 'is', null)
      .execute();
  }

  for (const mode of ['transient', 'persist'] as const) {
    it(`purges the variants made from it (${mode})`, async () => {
      const { ownerId, projectId, source } = await renderedSource(mode);
      const variants = await liveVariants(source.id);
      expect(variants).toHaveLength(1);
      if (mode === 'persist') {
        expect(source.objectKey).not.toBeNull();
        expect(await base.storage.head('private', source.objectKey as string)).not.toBeNull();
      }
      const deps = depsWith({ fixtureStreetView: streetViewAnswering('removed') });
      const next = await createRenderJobRecord(deps, {
        ownerId,
        projectId,
        source,
        holidayId: 'halloween',
      });
      expect((await runRenderJob(deps, { renderJobId: next.id })).state).toBe('failed');
      expect(await readJob(base.db, next.id)).toMatchObject({ failureKind: 'source_unavailable' });
      const after = await base.db
        .selectFrom('sourceAssets')
        .selectAll()
        .where('id', '=', source.id)
        .executeTakeFirstOrThrow();
      expect(after.state).toBe('stale');
      expect(await liveVariants(source.id)).toEqual([]);
      expect(await base.storage.head('private', variants[0]?.objectKey as string)).toBeNull();
      if (mode === 'persist') {
        expect(after.objectKey).toBeNull();
        expect(await base.storage.head('private', source.objectKey as string)).toBeNull();
      }
    });
  }

  it('only labels the source stale when newer imagery replaced the panorama', async () => {
    const { ownerId, projectId, source } = await renderedSource('persist');
    const deps = depsWith({ fixtureStreetView: streetViewAnswering('replaced') });
    const next = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(deps, { renderJobId: next.id })).state).toBe('failed');
    const after = await base.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(after.state).toBe('stale');
    expect(await liveVariants(source.id)).toHaveLength(1);
    expect(after.objectKey).toBe(source.objectKey);
  });

  it('only labels the source stale when the metadata call fails', async () => {
    const { ownerId, projectId, source } = await renderedSource('transient');
    const deps = depsWith({ fixtureStreetView: streetViewAnswering('error') });
    const next = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(deps, { renderJobId: next.id })).state).toBe('failed');
    expect(await liveVariants(source.id)).toHaveLength(1);
  });
});

describe('configured Street View attribution rectangles', () => {
  /** A live editing leg on a Street View source whose licensing grant is recorded. */
  async function liveStreetViewJob(deps: PipelineDeps) {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
    });
    await base.db
      .updateTable('assetPolicies')
      .set({
        display: 'allowed',
        store: 'allowed',
        aiProcess: 'allowed',
        edit: 'allowed',
        distributeDerivative: 'allowed',
      })
      .where('id', '=', source.assetPolicyId as string)
      .execute();
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    return { job, source };
  }

  function liveDeps(attributionRegions?: Record<string, NormalizedBox[]>) {
    const editor = recordingEditor(base.providers.fixtures.imageEditor, {
      providerId: 'openai',
      mode: 'live',
    });
    return depsWith({
      capabilities: { street_view_ai: 'live_public', vision_analysis: 'fixture' },
      imageEditor: editor.editor,
      ...(attributionRegions ? { attributionRegions } : {}),
    });
  }

  function decodeRle(record: unknown): { hard: Uint8Array; width: number; height: number } {
    const { rle, width, height } = record as { rle: number[]; width: number; height: number };
    const hard = new Uint8Array(width * height);
    let at = 0;
    rle.forEach((run, index) => {
      if (index % 2 === 1) hard.fill(255, at, at + run);
      at += run;
    });
    return { hard, width, height };
  }

  const pixelsIn = (
    mask: { hard: Uint8Array; width: number; height: number },
    box: NormalizedBox,
  ) => {
    let set = 0;
    const [x0, y0, x1, y1] = box;
    for (let y = Math.round(y0 * mask.height); y < Math.round(y1 * mask.height); y += 1) {
      for (let x = Math.round(x0 * mask.width); x < Math.round(x1 * mask.width); x += 1) {
        if (mask.hard[y * mask.width + x]) set += 1;
      }
    }
    return set;
  };

  async function outcome(jobId: string) {
    const [attempt] = await attemptsOf(jobId);
    const plan = await base.db
      .selectFrom('decorationPlans')
      .select('document')
      .where('jobId', '=', jobId)
      .executeTakeFirstOrThrow();
    const judge = await base.db
      .selectFrom('judgeResults')
      .select('deterministicChecks')
      .where('attemptId', '=', attempt?.id as string)
      .executeTakeFirstOrThrow();
    return {
      mask: decodeRle(attempt?.compositeMask),
      plan: plan.document as DecorationPlan,
      checks: judge.deterministicChecks as Record<string, Record<string, unknown> | undefined>,
    };
  }

  it('excludes, restores and checks the configured rectangles; the default changes nothing', async () => {
    // Default configuration: a live frame has no attribution rectangle.
    const plain = liveDeps();
    const a = await liveStreetViewJob(plain);
    expect((await runRenderJob(plain, { renderJobId: a.job.id })).state).toBe('succeeded');
    const before = await outcome(a.job.id);
    expect(before.plan.preserve.attributionRegion).toBeUndefined();
    expect(before.plan.preserve.attributionRegions).toBeUndefined();
    expect(before.checks.compositing?.attributionRestored).toBe(false);
    expect(before.checks.attribution).toBeUndefined();

    // A rectangle over a decorated area of that frame, configured for its requested size.
    const target = before.plan.placements
      .map((placement) => placement.region)
      .find((box) => pixelsIn(before.mask, box) > 0) as NormalizedBox;
    expect(target).toBeDefined();
    const viewpoint = a.source.viewpoint as { width: number; height: number };
    const key = `${viewpoint.width}x${viewpoint.height}`;
    const configured = liveDeps({ [key]: [target] });
    const b = await liveStreetViewJob(configured);
    expect((await runRenderJob(configured, { renderJobId: b.job.id })).state).toBe('succeeded');
    const done = await readJob(base.db, b.job.id);
    const mapped = nativeBoxesOnWorkingGrid([target], {
      cropBox: (done?.workingCropBox as NormalizedBox | null) ?? null,
      contentBox: (done?.workingPadBox as NormalizedBox | null) ?? null,
    });
    expect(mapped).toHaveLength(1);
    const after = await outcome(b.job.id);
    expect(after.plan.preserve.attributionRegions).toEqual(mapped);
    expect(after.plan.preserve.attributionRegion).toEqual(mapped[0]);
    expect(pixelsIn(after.mask, mapped[0] as NormalizedBox)).toBe(0);
    expect(after.checks.compositing?.attributionRestored).toBe(true);
    expect(after.checks.attribution).toMatchObject({ passed: true });
  });
});
