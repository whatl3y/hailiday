import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JobEnhancementRecordSchema,
  type CompiledRequest,
  type JudgeResult,
  type RenderSubStage,
  type SceneAnalysis,
} from '@hailiday/core';
import type { Clock } from '../../clock/index.js';
import { testConfig } from '../../config/index.js';
import type { RenderJob, SourceAsset } from '../../db/schema.js';
import { newId, sha256Hex } from '../../ids/index.js';
import { ENHANCE_LEDGER_STAGE } from '../../ledger/index.js';
import { ProviderError } from '../../providers/errors.js';
import type {
  EditOutcome,
  EnhanceJudgeInput,
  ImageEditor,
  Providers,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { decodeRaster, encodeJpeg } from '../imaging/raster.js';
import { deleteProject } from '../jobs/deletion.js';
import { placePreservationHold } from '../jobs/holds.js';
import { runReconciliation } from '../jobs/reconciliation.js';
import { runRenderJob } from '../render/job.js';
import { dropStoredStreetViewFrame } from '../render/source.js';
import { terminateRenderJob } from '../render/terminate.js';
import { readJob } from '../render/transitions.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { JUDGE_MIN_TIME_LEFT_MS } from './run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HALLWAY = path.join(here, '../../../content/photos/samples/sample-apartment-hallway.jpg');
const SHOWCASE = 'ChIJfxLanternHillColonial01';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps({ config: testConfig({ STREET_VIEW_ENHANCE: 'on' }) });
});

afterAll(async () => {
  await base.close();
});

const isEnhance = (request: CompiledRequest) => request.kind === 'enhance';

/**
 * The fixture editor with the enhance answer replaced where `enhance` says so, recording every
 * request and the job's sub-stage while each enhance edit runs.
 */
function recordingEditor(
  o: {
    enhance?: (
      request: CompiledRequest,
      input: Parameters<ImageEditor['edit']>[1],
      options: Parameters<ImageEditor['edit']>[2],
      inner: ImageEditor,
    ) => Promise<EditOutcome>;
    jobId?: () => string | null;
  } = {},
) {
  const inner = base.providers.fixtures.imageEditor;
  const requests: CompiledRequest[] = [];
  const subStages: (RenderSubStage | null)[] = [];
  const editor: ImageEditor = {
    ...inner,
    async edit(request, input, options) {
      requests.push(request);
      if (isEnhance(request)) {
        const jobId = o.jobId?.();
        if (jobId) subStages.push((await readJob(base.db, jobId))?.subStage ?? null);
        if (o.enhance) return o.enhance(request, input, options, inner);
      }
      return inner.edit(request, input, options);
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
  return {
    editor,
    requests,
    subStages,
    kinds: () => requests.map((r) => r.kind ?? 'decorate'),
    enhanceCount: () => requests.filter(isEnhance).length,
  };
}

/** The fixture vision model with the enhance judge replaced where `judge` says so. */
function enhanceVision(
  judge?: (input: EnhanceJudgeInput, inner: VisionModel) => Promise<VisionCallResult<JudgeResult>>,
  analysis?: (analysis: SceneAnalysis) => SceneAnalysis,
) {
  const inner = base.providers.fixtures.vision;
  const calls: EnhanceJudgeInput[] = [];
  const vision: VisionModel = {
    ...inner,
    async analyzeScene(input, options) {
      const result = await inner.analyzeScene(input, options);
      return analysis ? { ...result, result: analysis(result.result) } : result;
    },
    async judgeEnhancement(input, options) {
      calls.push(input);
      return judge ? judge(input, inner) : inner.judgeEnhancement(input, options);
    },
  };
  return { vision, calls };
}

/** A judge answer with one finding. */
function judgeWith(code: 'structure_changed' | 'unrequested_change', confidence: number) {
  return async (input: EnhanceJudgeInput, inner: VisionModel) => {
    const result = await inner.judgeEnhancement(input);
    const entry = { code, confidence, evidence: 'Test judge finding.' };
    return {
      ...result,
      result: {
        ...result.result,
        ...(code === 'structure_changed'
          ? { critical: [entry as JudgeResult['critical'][number]] }
          : { major: [entry as JudgeResult['major'][number]] }),
      },
    };
  };
}

function depsWith(
  o: {
    imageEditor?: ImageEditor;
    vision?: VisionModel;
    clock?: Clock;
    options?: PipelineDeps['options'];
    settings?: PipelineDeps['settings'];
    enhance?: boolean;
  } = {},
): PipelineDeps {
  const providers: Providers = {
    ...base.providers,
    fixtures: {
      ...base.providers.fixtures,
      ...(o.imageEditor ? { imageEditor: o.imageEditor } : {}),
      ...(o.vision ? { vision: o.vision } : {}),
    },
  };
  return {
    ...base,
    providers,
    ...(o.enhance === false
      ? { config: { ...base.config, streetView: { ...base.config.streetView, enhance: false } } }
      : {}),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.options ? { options: { ...base.options, ...o.options } } : {}),
    ...(o.settings ? { settings: o.settings } : {}),
  } as PipelineDeps;
}

/** A persist Street View source of the showcase place. */
async function persistSource(deps: PipelineDeps, mode: 'persist' | 'transient' = 'persist') {
  return createStreetViewSource(deps, { placeId: SHOWCASE, streetViewMode: mode });
}

async function jobOf(
  deps: PipelineDeps,
  created: { ownerId: string; projectId: string; source: SourceAsset },
  o: { lightingMode?: 'source' | 'evening'; enhance?: boolean } = {},
): Promise<RenderJob> {
  const source = await base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', created.source.id)
    .executeTakeFirstOrThrow();
  return createRenderJobRecord(deps, {
    ownerId: created.ownerId,
    projectId: created.projectId,
    source,
    lightingMode: o.lightingMode ?? 'source',
    enhance: o.enhance ?? true,
  });
}

async function rowsOf(sourceId: string) {
  return base.db
    .selectFrom('sourceEnhancements')
    .selectAll()
    .where('sourceAssetId', '=', sourceId)
    .orderBy('createdAt')
    .execute();
}

async function enhancementOf(jobId: string) {
  const job = await readJob(base.db, jobId);
  return job?.enhancement ? JobEnhancementRecordSchema.parse(job.enhancement) : null;
}

/** The job's ledger rows of the enhancement (stage `enhancing`). */
async function enhancingLedger(jobId: string) {
  const rows = await base.db
    .selectFrom('usageLedger')
    .selectAll()
    .where('jobId', '=', jobId)
    .execute();
  const reservations = rows.filter(
    (row) => row.kind === 'reservation' && row.stage === ENHANCE_LEDGER_STAGE,
  );
  const closing = (kind: string, sku: string) =>
    rows.filter(
      (row) =>
        row.kind === kind &&
        row.sku === sku &&
        (row.stage === ENHANCE_LEDGER_STAGE ||
          reservations.some((reservation) => reservation.id === row.reservationId)),
    );
  const open = reservations.filter(
    (reservation) => !rows.some((row) => row.reservationId === reservation.id),
  );
  return {
    settled: (sku: string) => closing('settlement', sku),
    charged: (sku: string) => closing('charge', sku),
    released: (sku: string) => closing('release', sku),
    open,
  };
}

/** An editor answer shifted far beyond the registration limits (a moved camera). */
async function shiftedAnswer(
  request: CompiledRequest,
  input: Parameters<ImageEditor['edit']>[1],
  options: Parameters<ImageEditor['edit']>[2],
  inner: ImageEditor,
): Promise<EditOutcome> {
  const outcome = await inner.edit(request, input, options);
  if (outcome.status !== 'completed') return outcome;
  const raster = await decodeRaster(outcome.image);
  const shift = Math.round(raster.width * 0.2);
  const data = Buffer.alloc(raster.data.length);
  for (let y = 0; y < raster.height; y += 1) {
    const row = y * raster.width * 3;
    raster.data.copy(data, row, row + shift * 3, row + raster.width * 3);
  }
  return { ...outcome, image: await encodeJpeg({ ...raster, data }, { quality: 92 }) };
}

describe('the first job of a stored frame enhances it and every later job reuses it', () => {
  it('accepts, stores, records and charges the enhancement, and the attempts use it', async () => {
    let jobId: string | null = null;
    const editor = recordingEditor({ jobId: () => jobId });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    jobId = job.id;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['enhance', 'decorate']);
    // The sub-stage is `enhancing` while the edit runs, and cleared afterwards.
    expect(editor.subStages).toEqual(['enhancing']);
    const done = await readJob(base.db, job.id);
    expect(done?.subStage).toBeNull();

    const [row, ...others] = await rowsOf(created.source.id);
    expect(others).toHaveLength(0);
    expect(row).toMatchObject({
      status: 'accepted',
      jobId: job.id,
      editCount: 1,
      providerMode: 'fixture',
      compilerVersion: job.compilerVersion,
    });
    const object = await base.storage.get('private', row?.objectKey as string);
    expect(row?.objectKey).toBe(
      keys.enhanced(created.ownerId, created.source.id, row?.id as string),
    );
    expect(sha256Hex(object?.body as Buffer)).toBe(row?.enhancedChecksumSha256);
    expect(row?.rawObjectKey).toBe(keys.attempt(job.id, row?.id as string, 'raw.jpg'));
    expect(row?.judge).toMatchObject({ renderAttemptId: row?.id });

    expect(await enhancementOf(job.id)).toEqual({
      outcome: 'made',
      enhancementId: row?.id,
      reason: null,
    });
    expect(done?.workingChecksumSha256).toBe(row?.enhancedChecksumSha256);
    const source = await base.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    const attempts = await base.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .execute();
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) {
      expect(attempt.workingChecksumSha256).toBe(row?.enhancedChecksumSha256);
      expect(attempt.sourceChecksumSha256).toBe(source.checksumSha256);
    }
    // The decorate edit received the enhanced picture.
    expect(editor.requests[1]?.images[0]?.checksum).toBe(row?.enhancedChecksumSha256);

    const ledger = await enhancingLedger(job.id);
    expect(ledger.settled('image_edit_attempt')).toHaveLength(1);
    expect(ledger.settled('vision_call')).toHaveLength(1);
    expect(ledger.open).toHaveLength(0);
    expect(row?.editLedgerEntryId).toBe(ledger.settled('image_edit_attempt')[0]?.id);
    expect(row?.judgeLedgerEntryId).toBe(ledger.settled('vision_call')[0]?.id);

    // A later job of the source reuses it: no enhance request, no enhancing charge.
    const second = await jobOf(deps, created);
    const before = editor.requests.length;
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    expect(editor.kinds().slice(before)).toEqual(['decorate']);
    expect(await enhancementOf(second.id)).toEqual({
      outcome: 'reused',
      enhancementId: row?.id,
      reason: null,
    });
    expect((await readJob(base.db, second.id))?.workingChecksumSha256).toBe(
      row?.enhancedChecksumSha256,
    );
    const reused = await enhancingLedger(second.id);
    expect(reused.settled('image_edit_attempt')).toHaveLength(0);
    expect(reused.charged('image_edit_attempt')).toHaveLength(0);
    expect(reused.released('image_edit_attempt')).toHaveLength(1);
    expect(reused.released('vision_call')).toHaveLength(1);

    // An evening job relights the `source` look made on the same enhanced picture.
    const evening = await jobOf(deps, created, { lightingMode: 'evening' });
    const beforeEvening = editor.requests.length;
    expect((await runRenderJob(deps, { renderJobId: evening.id })).state).toBe('succeeded');
    expect(editor.kinds().slice(beforeEvening)).toEqual(['relight']);
  });
});

describe('a rejection is final and the job goes on with the frame', () => {
  it('a critical judge finding at 0.5 rejects; the look succeeds on the frame; no later edit', async () => {
    const editor = recordingEditor();
    const vision = enhanceVision(judgeWith('structure_changed', 0.5));
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'rejected',
      reason: 'qa',
      failureCodes: ['structure_changed'],
    });
    expect(row?.objectKey).toBeNull();
    expect(await enhancementOf(job.id)).toEqual({
      outcome: 'rejected',
      enhancementId: row?.id,
      reason: 'qa',
    });
    const source = await base.db
      .selectFrom('sourceAssets')
      .select('checksumSha256')
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    const working = (await readJob(base.db, job.id))?.workingChecksumSha256;
    expect(working).not.toBe(row?.enhancedChecksumSha256);
    expect(editor.requests[1]?.images[0]?.checksum).toBe(working);
    expect(source.checksumSha256).not.toBeNull();

    const later = await jobOf(deps, created);
    const before = editor.requests.length;
    expect((await runRenderJob(deps, { renderJobId: later.id })).state).toBe('succeeded');
    expect(editor.kinds().slice(before)).toEqual(['decorate']);
    expect(await enhancementOf(later.id)).toMatchObject({ outcome: 'rejected', reason: 'qa' });
    expect(vision.calls).toHaveLength(1);
  });

  it('a major judge finding under 0.7 is accepted', async () => {
    const vision = enhanceVision(judgeWith('unrequested_change', 0.6));
    const deps = depsWith({ vision: vision.vision });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect((await rowsOf(created.source.id))[0]?.status).toBe('accepted');
  });

  it('a shifted picture is camera_changed without a judge call; the judge line is released', async () => {
    const editor = recordingEditor({ enhance: shiftedAnswer });
    const vision = enhanceVision();
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'rejected',
      reason: 'qa',
      failureCodes: ['camera_changed'],
    });
    expect(vision.calls).toHaveLength(0);
    const ledger = await enhancingLedger(job.id);
    expect(ledger.settled('image_edit_attempt')).toHaveLength(1);
    expect(ledger.released('vision_call')).toHaveLength(1);
    expect(ledger.open).toHaveLength(0);
  });

  it('a dusk photo and protected boxes over the limit are rejected before any edit', async () => {
    const cases: [string, (analysis: SceneAnalysis) => SceneAnalysis][] = [
      [
        'not_daylight',
        (analysis) => ({
          ...analysis,
          lighting: { ...analysis.lighting, isDaylight: false, timeOfDay: 'dusk' },
        }),
      ],
      [
        'protected_coverage',
        (analysis) => ({
          ...analysis,
          protectedBlurRegions: [
            ...analysis.protectedBlurRegions,
            { kind: 'other', box: [0, 0.5, 1, 1] },
          ],
        }),
      ],
    ];
    for (const [reason, change] of cases) {
      const editor = recordingEditor();
      const deps = depsWith({
        imageEditor: editor.editor,
        vision: enhanceVision(undefined, change).vision,
      });
      const created = await persistSource(deps);
      const job = await jobOf(deps, created);
      await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.enhanceCount()).toBe(0);
      const [row] = await rowsOf(created.source.id);
      expect(row).toMatchObject({ status: 'rejected', reason, editCount: 0 });
      expect(await enhancementOf(job.id)).toMatchObject({ outcome: 'rejected', reason });
      expect((await enhancingLedger(job.id)).released('image_edit_attempt')).toHaveLength(1);
    }
  });
});

/** An enhance answer that reports the operation (the edit is sent) and then fails. */
const failingAfterSend =
  (failure: Extract<EditOutcome, { status: 'failed' }>) =>
  async (
    _request: CompiledRequest,
    _input: Parameters<ImageEditor['edit']>[1],
    options: Parameters<ImageEditor['edit']>[2],
  ): Promise<EditOutcome> => {
    await options.onOperation?.(`op-${options.attemptId}-${Math.random()}`);
    return failure;
  };

describe('provider failures leave the job on the frame', () => {
  it('a provider error is settled at 0 and tried once more; the second makes it final', async () => {
    const editor = recordingEditor({
      enhance: failingAfterSend({
        status: 'failed',
        kind: 'provider_error',
        httpStatus: 500,
        retryable: true,
      }),
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const first = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    let [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'provider_error',
      retryable: true,
      editCount: 1,
    });
    expect(await enhancementOf(first.id)).toMatchObject({
      outcome: 'failed',
      reason: 'provider_error',
    });
    const settled = (await enhancingLedger(first.id)).settled('image_edit_attempt');
    expect(settled.map((entry) => Number(entry.amountMicros))).toEqual([0]);

    const second = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      retryable: false,
      editCount: 2,
      jobId: second.id,
    });
    expect(row?.checks).toMatchObject({
      previous: [{ reason: 'provider_error', jobId: first.id }],
    });
    expect(editor.enhanceCount()).toBe(2);

    const third = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: third.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(2);
    expect(await enhancementOf(third.id)).toMatchObject({
      outcome: 'failed',
      reason: 'provider_error',
    });
  });

  it('a timeout is charged once at the list price and stays retryable', async () => {
    const editor = recordingEditor({
      enhance: failingAfterSend({ status: 'failed', kind: 'timeout', retryable: true }),
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'timeout', retryable: true });
    const settled = (await enhancingLedger(job.id)).settled('image_edit_attempt');
    expect(settled.map((entry) => Number(entry.amountMicros))).toEqual([130_000]);
    expect(row?.editLedgerEntryId).toBe(settled[0]?.id);
  });

  it('a refusal is final and the job goes on to its decorate attempt', async () => {
    const editor = recordingEditor({
      enhance: failingAfterSend({
        status: 'failed',
        kind: 'moderation_blocked',
        httpStatus: 400,
        retryable: false,
      }),
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['enhance', 'decorate']);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'moderation_blocked', retryable: false });
    const source = await base.db
      .selectFrom('sourceAssets')
      .select('state')
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    expect(source.state).toBe('ready');
  });

  it('a judge that stays unavailable keeps the output; the next job resumes without an edit', async () => {
    let fail = true;
    const editor = recordingEditor();
    const vision = enhanceVision(async (input, inner) => {
      if (fail)
        throw new ProviderError('fixture', 'provider_error', 'judge down', { retryable: false });
      return inner.judgeEnhancement(input);
    });
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const first = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    let [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'judge_unavailable', retryable: true });
    expect(row?.rawObjectKey).not.toBeNull();
    fail = false;
    const second = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(1);
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', editCount: 1, jobId: second.id });
    expect(await enhancementOf(second.id)).toMatchObject({ outcome: 'made' });
    expect((await enhancingLedger(second.id)).settled('image_edit_attempt')).toHaveLength(0);
    expect((await enhancingLedger(second.id)).settled('vision_call')).toHaveLength(1);
  });
});

describe('a cancel, a stop or the deadline during the enhancement', () => {
  it('a cancel while the edit is in flight charges the edit and ends the row aborted', async () => {
    const controller = new AbortController();
    let jobId = '';
    const editor = recordingEditor({
      enhance: async (_request, _input, options) => {
        await options.onOperation?.(`op-${options.attemptId}`);
        await terminateRenderJob(base, { jobId, to: 'canceled' });
        controller.abort();
        return { status: 'failed', kind: 'provider_error', retryable: true };
      },
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    jobId = job.id;
    const result = await runRenderJob(deps, { renderJobId: job.id, signal: controller.signal });
    expect(result).toMatchObject({ state: 'canceled', stopped: true });
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'aborted',
      retryable: true,
      editCount: 1,
    });
    const ledger = await enhancingLedger(job.id);
    expect(ledger.charged('image_edit_attempt').map((e) => Number(e.amountMicros))).toEqual([
      130_000,
    ]);
    expect(row?.editLedgerEntryId).toBe(ledger.charged('image_edit_attempt')[0]?.id);
    const assets = await base.db
      .selectFrom('renderAssets')
      .select('id')
      .where('projectId', '=', created.projectId)
      .execute();
    expect(assets).toHaveLength(0);
  });

  it('a cancel during the judge keeps the output; the next job pays only the judge', async () => {
    const controller = new AbortController();
    let jobId = '';
    let cancel = true;
    const editor = recordingEditor();
    const vision = enhanceVision(async (input, inner) => {
      if (cancel) {
        cancel = false;
        await terminateRenderJob(base, { jobId, to: 'canceled' });
        controller.abort();
        throw new Error('aborted');
      }
      return inner.judgeEnhancement(input);
    });
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    jobId = job.id;
    expect(
      await runRenderJob(deps, { renderJobId: job.id, signal: controller.signal }),
    ).toMatchObject({ state: 'canceled', stopped: true });
    let [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'aborted', retryable: true });
    const next = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: next.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(1);
    expect(vision.calls).toHaveLength(2);
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', jobId: next.id });
  });

  it('a run stopped after the output was stored resumes on redelivery without a second edit', async () => {
    const controller = new AbortController();
    let stop = true;
    const editor = recordingEditor();
    const vision = enhanceVision(async (input, inner) => {
      if (stop) {
        stop = false;
        controller.abort();
        throw new Error('aborted');
      }
      return inner.judgeEnhancement(input);
    });
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    await expect(
      runRenderJob(deps, { renderJobId: job.id, signal: controller.signal }),
    ).rejects.toThrow();
    expect((await readJob(base.db, job.id))?.state).toBe('analyzing');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(1);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', editCount: 1, jobId: job.id });
    expect(await enhancementOf(job.id)).toMatchObject({ outcome: 'made' });
  });

  it('with too little time left nothing is sent', async () => {
    const editor = recordingEditor();
    const deps = depsWith({
      imageEditor: editor.editor,
      options: { maxJobDurationMs: PIPELINE_DEFAULTS.enhance.minJobTimeLeftMs - 1_000 },
    });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(0);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'no_time',
      retryable: true,
      editCount: 0,
    });
    expect(await enhancementOf(job.id)).toMatchObject({ outcome: 'failed', reason: 'no_time' });
  });

  it('a paused editor sends nothing', async () => {
    let paused = false;
    const settings = {
      ...base.settings,
      isProviderPaused: async (provider: string) =>
        (paused && provider === 'fixture') || base.settings.isProviderPaused(provider),
    } as PipelineDeps['settings'];
    const editor = recordingEditor();
    const vision = enhanceVision(undefined, (analysis) => {
      paused = true;
      return analysis;
    });
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision, settings });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    await runRenderJob(deps, { renderJobId: job.id });
    expect(editor.enhanceCount()).toBe(0);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'paused', editCount: 0 });
    expect(await enhancementOf(job.id)).toMatchObject({ outcome: 'failed', reason: 'paused' });
  });
});

describe('sources that are not enhanced', () => {
  it('a transient source: no row, the job records skipped not_stored', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps, 'transient');
    const job = await jobOf(deps, created, { enhance: false });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(await rowsOf(created.source.id)).toHaveLength(0);
    expect(editor.enhanceCount()).toBe(0);
    expect(await enhancementOf(job.id)).toEqual({
      outcome: 'skipped',
      enhancementId: null,
      reason: 'not_stored',
    });
  });

  it('the switch off: no row, no request, skipped disabled', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, enhance: false });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created, { enhance: false });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['decorate']);
    expect(await rowsOf(created.source.id)).toHaveLength(0);
    expect(await enhancementOf(job.id)).toMatchObject({ outcome: 'skipped', reason: 'disabled' });
  });

  it('an upload: no row and no record', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await createUploadSource(deps, {
      image: await readFile(HALLWAY),
      fileName: 'hallway.jpg',
      sceneType: 'apartment_entry',
      roomType: null,
    });
    const job = await createRenderJobRecord(deps, { ...created });
    await runRenderJob(deps, { renderJobId: job.id });
    expect(editor.enhanceCount()).toBe(0);
    expect(await rowsOf(created.source.id)).toHaveLength(0);
    expect((await readJob(base.db, job.id))?.enhancement).toBeNull();
  });
});

describe('the stored frame and its enhancement', () => {
  it('a refetch with other bytes drops the old enhancement and makes a new one', async () => {
    const deps = depsWith();
    const created = await persistSource(deps);
    const first = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    const [old] = await rowsOf(created.source.id);
    expect(old?.status).toBe('accepted');
    const source = await base.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    // The stored copy is other bytes than the panorama now serves, and due to be fetched again.
    const stored = await base.storage.get('private', source.objectKey as string);
    const other = await encodeJpeg(await decodeRaster(stored?.body as Buffer), { quality: 70 });
    await base.storage.put({
      bucket: 'private',
      key: source.objectKey as string,
      body: other,
      contentType: 'image/jpeg',
      provenance: {
        sourceKind: 'street_view',
        permission: { store: true, evidenceId: 'test' } as never,
      },
    });
    await base.db
      .updateTable('sourceAssets')
      .set({
        checksumSha256: sha256Hex(other),
        viewpoint: JSON.stringify({
          ...source.viewpoint,
          fetchedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
        }) as never,
      })
      .where('id', '=', source.id)
      .execute();
    const second = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    const rows = await rowsOf(created.source.id);
    expect(rows.map((row) => row.id)).not.toContain(old?.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'accepted', jobId: second.id });
    expect(await base.storage.get('private', old?.objectKey as string)).toBeNull();
  });

  it('a frame changed between the put and the accept: the picture is deleted, frame_changed', async () => {
    const storage: PipelineDeps['storage'] = {
      ...base.storage,
      async put(input) {
        const done = await base.storage.put(input);
        if (input.key.startsWith('enhanced/')) {
          await base.db
            .updateTable('sourceAssets')
            .set({ checksumSha256: 'changed' })
            .where('objectKey', 'is not', null)
            .where('id', '=', input.key.split('/')[2] as string)
            .execute();
        }
        return done;
      },
    };
    const deps = { ...depsWith(), storage } as PipelineDeps;
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'frame_changed', retryable: false });
    expect(
      await base.storage.list('private', keys.enhancedPrefix(created.ownerId, created.source.id)),
    ).toEqual([]);
    expect(await enhancementOf(job.id)).toMatchObject({
      outcome: 'failed',
      reason: 'frame_changed',
    });
  });

  it('a pending row of a terminal job is closed with a charge; the new job tries again', async () => {
    const stored = await persistSource(depsWith({ enhance: false }));
    const warmup = await jobOf(depsWith({ enhance: false }), stored, { enhance: false });
    expect(
      (await runRenderJob(depsWith({ enhance: false }), { renderJobId: warmup.id })).state,
    ).toBe('succeeded');
    const source = await base.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', stored.source.id)
      .executeTakeFirstOrThrow();
    const orphanId = crypto.randomUUID();
    await base.db
      .insertInto('sourceEnhancements')
      .values({
        id: orphanId,
        sourceAssetId: source.id,
        frameChecksumSha256: source.checksumSha256 as string,
        compilerVersion: warmup.compilerVersion,
        workingWidth: 1024,
        workingHeight: 1024,
        status: 'pending',
        jobId: warmup.id,
        editCount: 1,
        provider: 'fixture-editor',
        providerMode: 'fixture',
        providerOperationId: 'op-orphan',
      })
      .execute();
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor });
    const job = await jobOf(deps, stored);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(source.id);
    expect(row).toMatchObject({ id: orphanId, status: 'accepted', editCount: 2, jobId: job.id });
    expect(row?.checks).toMatchObject({ previous: [{ reason: 'abandoned', jobId: warmup.id }] });
    const charged = (await enhancingLedger(warmup.id)).charged('image_edit_attempt');
    expect(charged.map((entry) => Number(entry.amountMicros))).toEqual([130_000]);
    expect(editor.enhanceCount()).toBe(1);
  });

  it('without a reservation the edit and the judge are direct charges', async () => {
    const deps = depsWith();
    const created = await persistSource(deps);
    const job = await jobOf(deps, created, { enhance: false });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const ledger = await enhancingLedger(job.id);
    expect(ledger.charged('image_edit_attempt')).toHaveLength(1);
    expect(ledger.charged('vision_call')).toHaveLength(1);
    expect(ledger.settled('image_edit_attempt')).toHaveLength(0);
  });

  it('an exception inside the step never fails the look', async () => {
    const storage: PipelineDeps['storage'] = {
      ...base.storage,
      async put(input) {
        if (input.key.startsWith('enhanced/')) throw new Error('storage down');
        return base.storage.put(input);
      },
    };
    const deps = { ...depsWith(), storage } as PipelineDeps;
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'internal_error', retryable: false });
    expect(await enhancementOf(job.id)).toMatchObject({
      outcome: 'failed',
      reason: 'internal_error',
    });
  });

  it('a redelivery past analyzing uses the enhanced picture, or fails when it is gone', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const first = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    const pastAnalyzing = async () => {
      const job = await jobOf(deps, created);
      await base.db
        .updateTable('renderJobs')
        .set({
          state: 'planning',
          startedAt: new Date(),
          workingChecksumSha256: row?.enhancedChecksumSha256 as string,
          enhancement: JSON.stringify({
            outcome: 'reused',
            enhancementId: row?.id,
            reason: null,
          }) as never,
        })
        .where('id', '=', job.id)
        .execute();
      return job;
    };
    const redelivered = await pastAnalyzing();
    const before = editor.requests.length;
    expect((await runRenderJob(deps, { renderJobId: redelivered.id })).state).toBe('succeeded');
    expect(editor.requests.slice(before).map((r) => r.images[0]?.checksum)).toEqual([
      row?.enhancedChecksumSha256,
    ]);

    const orphaned = await pastAnalyzing();
    await base.db
      .deleteFrom('sourceEnhancements')
      .where('id', '=', row?.id as string)
      .execute();
    expect((await runRenderJob(deps, { renderJobId: orphaned.id })).state).toBe('failed');
    expect(await readJob(base.db, orphaned.id)).toMatchObject({
      failureKind: 'source_unavailable',
    });
  });
});

describe('reconciliation', () => {
  it('closes a pending row whose job is gone', async () => {
    const created = await persistSource(depsWith({ enhance: false }));
    const id = crypto.randomUUID();
    await base.db
      .insertInto('sourceEnhancements')
      .values({
        id,
        sourceAssetId: created.source.id,
        frameChecksumSha256: 'f'.repeat(64),
        compilerVersion: 'test',
        workingWidth: 1024,
        workingHeight: 1024,
        status: 'pending',
        jobId: crypto.randomUUID(),
        editCount: 0,
      })
      .execute();
    const result = await runReconciliation(base, { scanObjects: false });
    expect(result.enhancementsAbandoned).toBeGreaterThanOrEqual(1);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ id, status: 'failed', reason: 'abandoned', retryable: true });
  });

  it('deletes an orphaned enhanced picture after the grace and keeps a live one', async () => {
    const deps = depsWith();
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    const orphan = keys.enhanced(created.ownerId, created.source.id, crypto.randomUUID());
    await base.storage.put({
      bucket: 'private',
      key: orphan,
      body: Buffer.from('orphan'),
      contentType: 'image/png',
      provenance: {
        sourceKind: 'street_view',
        permission: { store: true, evidenceId: 'test' } as never,
      },
    });
    await runReconciliation(base, { objectGraceMs: 0 });
    expect(await base.storage.head('private', orphan)).toBeNull();
    expect(await base.storage.head('private', row?.objectKey as string)).not.toBeNull();
    await dropStoredStreetViewFrame(
      base,
      await base.db
        .selectFrom('sourceAssets')
        .selectAll()
        .where('id', '=', created.source.id)
        .executeTakeFirstOrThrow(),
    );
    expect(await rowsOf(created.source.id)).toHaveLength(0);
    expect(await base.storage.head('private', row?.objectKey as string)).toBeNull();
    // Reconciliation walks the whole test database and its buckets, which other files fill.
  }, 180_000);
});

/** A gate a fake editor waits at until the test opens it. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Paid enhance edits of an owner (charges and settlements), wherever their job went. */
async function paidEditsOf(ownerId: string) {
  return base.db
    .selectFrom('usageLedger')
    .selectAll()
    .where('ownerId', '=', ownerId)
    .where('sku', '=', 'image_edit_attempt')
    .where('stage', '=', ENHANCE_LEDGER_STAGE)
    .where('kind', 'in', ['charge', 'settlement'])
    .execute();
}

/** A clock that runs with real time, shifted by `offset.ms`. */
function shiftedClock() {
  const offset = { ms: 0 };
  const clock: Clock = { now: () => new Date(Date.now() + offset.ms) };
  return { clock, offset };
}

async function projectRow(projectId: string) {
  return base.db
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
}

/** A persist source whose frame is stored (by a job with the enhancement off). */
async function storedSource() {
  const off = depsWith({ enhance: false });
  const created = await persistSource(off);
  const warmup = await jobOf(off, created, { enhance: false });
  expect((await runRenderJob(off, { renderJobId: warmup.id })).state).toBe('succeeded');
  const source = await base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', created.source.id)
    .executeTakeFirstOrThrow();
  return { ...created, source, compilerVersion: warmup.compilerVersion };
}

describe('the cost of a sent edit is recorded when its row is gone', () => {
  it('the project is deleted while the edit is in flight: one charge at the list price', async () => {
    const controller = new AbortController();
    let projectId = '';
    const editor = recordingEditor({
      enhance: async (_request, _input, options) => {
        await options.onOperation?.(`op-${options.attemptId}-deleted`);
        await deleteProject(base, {
          project: await projectRow(projectId),
          scope: 'project',
          requestedBy: 'user',
        });
        controller.abort();
        return { status: 'failed', kind: 'provider_error', retryable: true };
      },
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    projectId = created.projectId;
    const job = await jobOf(deps, created);
    await runRenderJob(deps, { renderJobId: job.id, signal: controller.signal }).catch(() => null);
    expect(editor.enhanceCount()).toBe(1);
    expect(await readJob(base.db, job.id)).toBeNull();
    expect(await rowsOf(created.source.id)).toHaveLength(0);
    const paid = await paidEditsOf(created.ownerId);
    expect(
      paid.map((entry) => [entry.kind, Number(entry.amountMicros), entry.jobId, entry.projectId]),
    ).toEqual([['charge', 130_000, null, null]]);
  });

  it('the project is deleted before the answer is handled: the answered edit is charged once', async () => {
    let projectId = '';
    const editor = recordingEditor({
      enhance: async (request, input, options, inner) => {
        const outcome = await inner.edit(request, input, options);
        await deleteProject(base, {
          project: await projectRow(projectId),
          scope: 'project',
          requestedBy: 'user',
        });
        return outcome;
      },
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    projectId = created.projectId;
    const job = await jobOf(deps, created);
    await runRenderJob(deps, { renderJobId: job.id }).catch(() => null);
    expect(editor.enhanceCount()).toBe(1);
    const paid = await paidEditsOf(created.ownerId);
    expect(paid.map((entry) => [entry.kind, entry.jobId, entry.projectId])).toEqual([
      ['charge', null, null],
    ]);
    // The output that nothing will resume from is not kept.
    expect(await base.storage.list('private', `attempts/${job.id}/`)).toEqual([]);
  });

  it('the frame is dropped while the edit is in flight: the edit is settled against the job', async () => {
    let sourceId = '';
    const editor = recordingEditor({
      enhance: async (request, input, options, inner) => {
        const outcome = await inner.edit(request, input, options);
        await dropStoredStreetViewFrame(
          base,
          await base.db
            .selectFrom('sourceAssets')
            .selectAll()
            .where('id', '=', sourceId)
            .executeTakeFirstOrThrow(),
        );
        return outcome;
      },
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    sourceId = created.source.id;
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(1);
    expect(await rowsOf(created.source.id)).toHaveLength(0);
    const record = await enhancementOf(job.id);
    expect(record).toMatchObject({ outcome: 'failed', reason: 'frame_changed' });
    const ledger = await enhancingLedger(job.id);
    expect(ledger.settled('image_edit_attempt')).toHaveLength(1);
    expect(ledger.charged('image_edit_attempt')).toHaveLength(0);
    expect(ledger.open).toHaveLength(0);
    expect(await paidEditsOf(created.ownerId)).toHaveLength(1);
    expect(
      await base.storage.head(
        'private',
        keys.attempt(job.id, record?.enhancementId as string, 'raw.jpg'),
      ),
    ).toBeNull();
  });

  it('a frame dropped just before the send: nothing is sent and the job goes on with the frame', async () => {
    let armed = false;
    let sourceId = '';
    const settings = {
      ...base.settings,
      isProviderPaused: async (provider: string) => {
        if (armed && provider === 'fixture') {
          armed = false;
          await dropStoredStreetViewFrame(
            base,
            await base.db
              .selectFrom('sourceAssets')
              .selectAll()
              .where('id', '=', sourceId)
              .executeTakeFirstOrThrow(),
          );
        }
        return base.settings.isProviderPaused(provider);
      },
    } as PipelineDeps['settings'];
    const vision = enhanceVision(undefined, (analysis) => {
      armed = true;
      return analysis;
    });
    const deps = depsWith({ vision: vision.vision, settings });
    const created = await persistSource(deps);
    sourceId = created.source.id;
    const job = await jobOf(deps, created);
    const result = await runRenderJob(deps, { renderJobId: job.id });
    expect(result).toMatchObject({ state: 'succeeded', stopped: false });
    expect(await enhancementOf(job.id)).toMatchObject({
      outcome: 'failed',
      reason: 'frame_changed',
    });
    expect(await paidEditsOf(created.ownerId)).toHaveLength(0);
  });
});

describe('a canceled run whose answer arrives after the next job claimed the row', () => {
  it('the late answer after the next job accepted changes nothing; each edit is paid once', async () => {
    const hold = gate();
    const entered = gate();
    let first = true;
    const editor = recordingEditor({
      enhance: async (request, input, options, inner) => {
        if (first) {
          first = false;
          await options.onOperation?.(`op-late-${options.attemptId}`);
          entered.open();
          await hold.wait;
          return inner.edit(request, input, { ...options, onOperation: undefined });
        }
        return inner.edit(request, input, options);
      },
    });
    const vision = enhanceVision();
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const a = await jobOf(deps, created);
    // The canceled run hears of the cancel only at its next heartbeat: no abort reaches it here.
    const runA = runRenderJob(deps, { renderJobId: a.id });
    await entered.wait;
    await terminateRenderJob(base, { jobId: a.id, to: 'canceled' });
    const b = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: b.id })).state).toBe('succeeded');
    const [made] = await rowsOf(created.source.id);
    expect(made).toMatchObject({ status: 'accepted', jobId: b.id, editCount: 2 });

    hold.open();
    expect(await runA).toMatchObject({ state: 'canceled', stopped: true });
    const [after, ...others] = await rowsOf(created.source.id);
    expect(others).toHaveLength(0);
    expect(after).toEqual(made);
    const picture = await base.storage.get('private', made?.objectKey as string);
    expect(sha256Hex(picture?.body as Buffer)).toBe(made?.enhancedChecksumSha256);
    expect(vision.calls).toHaveLength(1);
    expect(
      await base.storage.head('private', keys.attempt(a.id, made?.id as string, 'raw.jpg')),
    ).toBeNull();

    const c = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: c.id })).state).toBe('succeeded');
    expect(await enhancementOf(c.id)).toMatchObject({ outcome: 'reused', enhancementId: made?.id });

    const ledgerA = await enhancingLedger(a.id);
    expect([
      ...ledgerA.settled('image_edit_attempt'),
      ...ledgerA.charged('image_edit_attempt'),
    ]).toHaveLength(1);
    expect(ledgerA.settled('vision_call')).toHaveLength(0);
    expect(ledgerA.charged('vision_call')).toHaveLength(0);
    expect((await enhancingLedger(b.id)).settled('image_edit_attempt')).toHaveLength(1);
    expect(await paidEditsOf(created.ownerId)).toHaveLength(2);
  });

  it('the late answer while the next job edits never touches that job’s row', async () => {
    const holdA = gate();
    const enteredA = gate();
    const holdB = gate();
    const enteredB = gate();
    let edits = 0;
    const editor = recordingEditor({
      enhance: async (request, input, options, inner) => {
        edits += 1;
        const mine = edits;
        await options.onOperation?.(`op-${mine}-${options.attemptId}`);
        if (mine === 1) {
          enteredA.open();
          await holdA.wait;
        } else {
          enteredB.open();
          await holdB.wait;
        }
        return inner.edit(request, input, { ...options, onOperation: undefined });
      },
    });
    const vision = enhanceVision();
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const a = await jobOf(deps, created);
    const runA = runRenderJob(deps, { renderJobId: a.id });
    await enteredA.wait;
    await terminateRenderJob(base, { jobId: a.id, to: 'canceled' });
    const b = await jobOf(deps, created);
    const runB = runRenderJob(deps, { renderJobId: b.id });
    await enteredB.wait;
    const [claimed] = await rowsOf(created.source.id);
    expect(claimed).toMatchObject({ status: 'pending', jobId: b.id, editCount: 2 });

    holdA.open();
    expect(await runA).toMatchObject({ state: 'canceled', stopped: true });
    const [untouched] = await rowsOf(created.source.id);
    expect(untouched).toEqual(claimed);

    holdB.open();
    expect((await runB).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', jobId: b.id, editCount: 2 });
    expect(await enhancementOf(b.id)).toMatchObject({ outcome: 'made', enhancementId: row?.id });
    expect((await readJob(base.db, b.id))?.workingChecksumSha256).toBe(row?.enhancedChecksumSha256);
    expect(vision.calls).toHaveLength(1);
    const ledgerA = await enhancingLedger(a.id);
    expect([
      ...ledgerA.settled('image_edit_attempt'),
      ...ledgerA.charged('image_edit_attempt'),
    ]).toHaveLength(1);
    const ledgerB = await enhancingLedger(b.id);
    expect(ledgerB.settled('image_edit_attempt')).toHaveLength(1);
    expect(row?.editLedgerEntryId).toBe(ledgerB.settled('image_edit_attempt')[0]?.id);
  });
});

describe('an output that does not decode', () => {
  it('is dropped with its row’s judge, so the next job sends the remaining edit', async () => {
    let broken = true;
    const editor = recordingEditor({
      enhance: async (request, input, options, inner) => {
        const outcome = await inner.edit(request, input, options);
        return broken && outcome.status === 'completed'
          ? { ...outcome, image: Buffer.from('these bytes are not an image') }
          : outcome;
      },
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const first = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    let [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'undecodable',
      retryable: true,
      editCount: 1,
      rawObjectKey: null,
      judge: null,
    });
    expect(await enhancementOf(first.id)).toMatchObject({
      outcome: 'failed',
      reason: 'undecodable',
    });
    expect(
      await base.storage.head('private', keys.attempt(first.id, row?.id as string, 'raw.jpg')),
    ).toBeNull();
    expect((await enhancingLedger(first.id)).settled('image_edit_attempt')).toHaveLength(1);

    broken = false;
    const second = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(2);
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', jobId: second.id, editCount: 2 });
    expect(await enhancementOf(second.id)).toMatchObject({ outcome: 'made' });
  });
});

describe('older releases’ enhancements after an accept', () => {
  /** An accepted row of another compiler version last written two days ago, with its picture. */
  async function olderRelease(created: { ownerId: string; source: SourceAsset }) {
    const id = newId();
    const key = keys.enhanced(created.ownerId, created.source.id, id);
    const picture = Buffer.from(`older-${id}`);
    await base.storage.put({
      bucket: 'private',
      key,
      body: picture,
      contentType: 'image/png',
      provenance: {
        sourceKind: 'street_view',
        permission: { store: true, evidenceId: 'test' } as never,
        derivative: false,
      },
    });
    await base.db
      .insertInto('sourceEnhancements')
      .values({
        id,
        sourceAssetId: created.source.id,
        frameChecksumSha256: 'e'.repeat(64),
        compilerVersion: 'older-release',
        workingWidth: 1024,
        workingHeight: 1024,
        status: 'accepted',
        objectKey: key,
        enhancedChecksumSha256: sha256Hex(picture),
        decidedAt: new Date(Date.now() - 2 * 86_400_000),
        updatedAt: new Date(Date.now() - 2 * 86_400_000),
      })
      .execute();
    return { id, key };
  }

  it('are removed with their pictures, unless a hold on the project covers the source', async () => {
    const deps = depsWith();
    const free = await persistSource(deps);
    const freeOld = await olderRelease(free);
    expect((await runRenderJob(deps, { renderJobId: (await jobOf(deps, free)).id })).state).toBe(
      'succeeded',
    );
    expect((await rowsOf(free.source.id)).map((row) => row.id)).not.toContain(freeOld.id);
    expect(await base.storage.head('private', freeOld.key)).toBeNull();

    const held = await persistSource(deps);
    const heldOld = await olderRelease(held);
    await base.db.transaction().execute((trx) =>
      placePreservationHold(trx, {
        targetKind: 'project',
        targetId: held.projectId,
        reason: 'complaint_investigation',
        authorityRef: `test:${held.projectId}`,
        releaseCondition: 'test',
        placedBy: null,
      }),
    );
    // A source added to the project after the hold was placed carries no hold of its own.
    await base.db
      .updateTable('sourceAssets')
      .set({ preservationHoldId: null })
      .where('id', '=', held.source.id)
      .execute();
    expect((await runRenderJob(deps, { renderJobId: (await jobOf(deps, held)).id })).state).toBe(
      'succeeded',
    );
    const rows = await rowsOf(held.source.id);
    expect(rows.map((row) => row.status).sort()).toEqual(['accepted', 'accepted']);
    expect(rows.map((row) => row.id)).toContain(heldOld.id);
    expect(await base.storage.head('private', heldOld.key)).not.toBeNull();
  });
});

describe('the time the judge needs', () => {
  it('with too little time left for the judge the output waits for the next job', async () => {
    const { clock, offset } = shiftedClock();
    const maxJobDurationMs = PIPELINE_DEFAULTS.enhance.minJobTimeLeftMs + 10_000;
    const editor = recordingEditor({
      enhance: async (request, input, options, inner) => {
        const outcome = await inner.edit(request, input, options);
        // A slow edit: the judge would start with less than it and the look need.
        offset.ms += maxJobDurationMs - JUDGE_MIN_TIME_LEFT_MS + 5_000;
        return outcome;
      },
    });
    const vision = enhanceVision();
    const slow = depsWith({
      imageEditor: editor.editor,
      vision: vision.vision,
      clock,
      options: { ...base.options, maxJobDurationMs },
    });
    const created = await persistSource(slow);
    const first = await jobOf(slow, created);
    await runRenderJob(slow, { renderJobId: first.id });
    expect(vision.calls).toHaveLength(0);
    let [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'no_time',
      retryable: true,
      editCount: 1,
      rawObjectKey: keys.attempt(first.id, row?.id as string, 'raw.jpg'),
    });
    expect(await enhancementOf(first.id)).toMatchObject({ outcome: 'failed', reason: 'no_time' });
    const ledger = await enhancingLedger(first.id);
    expect(ledger.released('vision_call')).toHaveLength(1);

    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const second = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(1);
    expect(vision.calls).toHaveLength(1);
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', jobId: second.id, editCount: 1 });
  });

  it('an output of the last edit that the judge never saw is judged by the next job', async () => {
    const { clock, offset } = shiftedClock();
    const maxJobDurationMs = PIPELINE_DEFAULTS.enhance.minJobTimeLeftMs + 10_000;
    let edits = 0;
    const editor = recordingEditor({
      enhance: async (request, input, options, inner) => {
        edits += 1;
        // The first edit fails; the second answers so slowly that the judge has no time left.
        if (edits === 1) {
          return failingAfterSend({
            status: 'failed',
            kind: 'provider_error',
            httpStatus: 500,
            retryable: true,
          })(request, input, options);
        }
        const outcome = await inner.edit(request, input, options);
        offset.ms += maxJobDurationMs - JUDGE_MIN_TIME_LEFT_MS + 5_000;
        return outcome;
      },
    });
    const vision = enhanceVision();
    const slow = depsWith({
      imageEditor: editor.editor,
      vision: vision.vision,
      clock,
      options: { ...base.options, maxJobDurationMs },
    });
    const created = await persistSource(slow);
    const first = await jobOf(slow, created);
    await runRenderJob(slow, { renderJobId: first.id });
    let [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'provider_error', editCount: 1 });

    const second = await jobOf(slow, created);
    await runRenderJob(slow, { renderJobId: second.id });
    expect(vision.calls).toHaveLength(0);
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'no_time',
      retryable: true,
      editCount: PIPELINE_DEFAULTS.enhance.maxEdits,
      judge: null,
    });
    expect(row?.rawObjectKey).not.toBeNull();

    // The next job judges the stored output and sends no edit.
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const third = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: third.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(2);
    expect(vision.calls).toHaveLength(1);
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', jobId: third.id, editCount: 2 });
    expect(await enhancementOf(third.id)).toMatchObject({ outcome: 'made' });
    expect((await enhancingLedger(third.id)).settled('image_edit_attempt')).toHaveLength(0);
  });

  it('the job deadline during the edit charges the edit, ends the row deadline and fails the job timeout', async () => {
    const { clock, offset } = shiftedClock();
    const editor = recordingEditor({
      enhance: async (_request, _input, options) => {
        await options.onOperation?.(`op-${options.attemptId}-deadline`);
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          options.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 'failed', kind: 'timeout', retryable: true };
      },
    });
    // The clock goes back during the analysis, so the enhancement starts with time to spare while
    // the deadline timer, set when the run began, fires a few seconds later.
    const vision = enhanceVision(undefined, (analysis) => {
      offset.ms = -PIPELINE_DEFAULTS.enhance.minJobTimeLeftMs;
      return analysis;
    });
    const deps = depsWith({
      imageEditor: editor.editor,
      vision: vision.vision,
      clock,
      options: { ...base.options, maxJobDurationMs: 8_000 },
    });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'timeout' });
    expect(editor.enhanceCount()).toBe(1);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'deadline',
      retryable: true,
      editCount: 1,
    });
    const ledger = await enhancingLedger(job.id);
    expect(
      [...ledger.settled('image_edit_attempt'), ...ledger.charged('image_edit_attempt')].map(
        (entry) => Number(entry.amountMicros),
      ),
    ).toEqual([130_000]);
  });
});

describe('outcomes of the edit that cannot be known', () => {
  for (const [name, answer] of [
    [
      'an unreadable 200',
      failingAfterSend({
        status: 'failed',
        kind: 'provider_error',
        httpStatus: 200,
        providerCode: 'invalid_json',
        retryable: false,
      }),
    ],
    [
      'a pending answer',
      async (
        _request: CompiledRequest,
        _input: Parameters<ImageEditor['edit']>[1],
        options: Parameters<ImageEditor['edit']>[2],
      ): Promise<EditOutcome> => {
        await options.onOperation?.(`op-${options.attemptId}-pending`);
        return { status: 'pending', operationId: `op-${options.attemptId}-pending` };
      },
    ],
  ] as const) {
    it(`${name} is unknown_outcome, charged at the list price and tried once more`, async () => {
      const editor = recordingEditor({ enhance: answer });
      const deps = depsWith({ imageEditor: editor.editor });
      const created = await persistSource(deps);
      const job = await jobOf(deps, created);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      const [row] = await rowsOf(created.source.id);
      expect(row).toMatchObject({
        status: 'failed',
        reason: 'unknown_outcome',
        retryable: true,
        editCount: 1,
      });
      const settled = (await enhancingLedger(job.id)).settled('image_edit_attempt');
      expect(settled.map((entry) => Number(entry.amountMicros))).toEqual([130_000]);
      expect(await enhancementOf(job.id)).toMatchObject({
        outcome: 'failed',
        reason: 'unknown_outcome',
      });
    });
  }

  it('a redelivered job asks getOperation: a completed answer is used, anything else is unknown_outcome', async () => {
    const deps = depsWith();
    const created = await persistSource(deps);
    const first = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    const [made] = await rowsOf(created.source.id);
    const raw = (await base.storage.get('private', made?.rawObjectKey as string))?.body as Buffer;
    const size = await decodeRaster(raw);
    const answers = new Map<string, EditOutcome>([
      [
        'op-recovered',
        {
          status: 'completed',
          operationId: 'op-recovered',
          image: raw,
          width: size.width,
          height: size.height,
          format: 'jpeg',
          usage: { images: 1, raw: { fixture: true } },
          modelSnapshot: 'fixture-enhance',
          provenance: { watermark: 'unknown' },
          providerMode: 'fixture',
        },
      ],
    ]);
    const asked: string[] = [];
    const recording = recordingEditor();
    const imageEditor: ImageEditor = {
      ...recording.editor,
      async getOperation(operationId) {
        asked.push(operationId);
        return (
          answers.get(operationId) ?? {
            status: 'failed',
            operationId,
            kind: 'provider_error',
            providerCode: 'unknown_operation',
            retryable: false,
          }
        );
      },
    };
    const redelivering = depsWith({ imageEditor });
    /** The row as a job left it that sent its edit and died before the answer was recorded. */
    const sentBy = async (jobId: string, operationId: string) => {
      if (made?.objectKey) await base.storage.delete('private', made.objectKey);
      await base.db
        .updateTable('sourceEnhancements')
        .set({
          status: 'pending',
          reason: null,
          jobId,
          editCount: 1,
          providerOperationId: operationId,
          editLedgerEntryId: null,
          rawObjectKey: null,
          objectKey: null,
          enhancedChecksumSha256: null,
          byteLength: null,
          decidedAt: null,
          judge: null,
          judgeUsage: null,
          judgeLedgerEntryId: null,
        })
        .where('id', '=', made?.id as string)
        .execute();
    };

    const recovered = await jobOf(redelivering, created);
    await sentBy(recovered.id, 'op-recovered');
    expect((await runRenderJob(redelivering, { renderJobId: recovered.id })).state).toBe(
      'succeeded',
    );
    expect(asked).toEqual(['op-recovered']);
    expect(recording.enhanceCount()).toBe(0);
    let [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'accepted', jobId: recovered.id, editCount: 1 });
    expect(await enhancementOf(recovered.id)).toMatchObject({ outcome: 'made' });
    expect((await enhancingLedger(recovered.id)).settled('image_edit_attempt')).toHaveLength(1);

    const lost = await jobOf(redelivering, created);
    await sentBy(lost.id, 'op-lost');
    expect((await runRenderJob(redelivering, { renderJobId: lost.id })).state).toBe('succeeded');
    expect(asked).toEqual(['op-recovered', 'op-lost']);
    expect(recording.enhanceCount()).toBe(0);
    [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'unknown_outcome', retryable: true });
    const settled = (await enhancingLedger(lost.id)).settled('image_edit_attempt');
    expect(settled.map((entry) => Number(entry.amountMicros))).toEqual([130_000]);
  });
});

describe('more ends of the enhancement', () => {
  it('an accepted row whose picture is gone is made again from the stored output at no cost', async () => {
    const editor = recordingEditor();
    const vision = enhanceVision();
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const created = await persistSource(deps);
    const first = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    const [made] = await rowsOf(created.source.id);
    await base.storage.delete('private', made?.objectKey as string);
    const second = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    // Neither the edit nor the judge is paid again: the stored output and its judge are reused.
    expect(editor.enhanceCount()).toBe(1);
    expect(vision.calls).toHaveLength(1);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ id: made?.id, status: 'accepted', jobId: second.id, editCount: 1 });
    expect(row?.checks).toMatchObject({ previous: [{ reason: 'object_missing' }] });
    expect(await base.storage.head('private', row?.objectKey as string)).not.toBeNull();
    expect(await enhancementOf(second.id)).toMatchObject({ outcome: 'made' });
    const ledger = await enhancingLedger(second.id);
    expect(ledger.settled('image_edit_attempt')).toHaveLength(0);
    expect(ledger.charged('image_edit_attempt')).toHaveLength(0);
    expect(ledger.settled('vision_call')).toHaveLength(0);
    expect(ledger.charged('vision_call')).toHaveLength(0);
  });

  it('a judge refusal rejects the candidate as unsafe_or_offensive without a judge charge', async () => {
    const vision = enhanceVision(async () => {
      throw new ProviderError('fixture', 'moderation_blocked', 'refused', { retryable: false });
    });
    const deps = depsWith({ vision: vision.vision });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'rejected',
      reason: 'qa',
      failureCodes: ['unsafe_or_offensive'],
      judgeLedgerEntryId: null,
    });
    expect(row?.judge).toMatchObject({ judgeModel: 'refusal' });
    const ledger = await enhancingLedger(job.id);
    expect(ledger.settled('vision_call')).toHaveLength(0);
    expect(ledger.charged('vision_call')).toHaveLength(0);
    expect(ledger.released('vision_call')).toHaveLength(1);
  });

  it('a permission that no longer allows the edit: nothing is sent, failed policy', async () => {
    let policyId = '';
    const editor = recordingEditor();
    const inner = base.providers.fixtures.vision;
    // The policy stops allowing storage while the scene is analyzed.
    const vision: VisionModel = {
      ...inner,
      async analyzeScene(input, options) {
        const result = await inner.analyzeScene(input, options);
        await base.db
          .updateTable('assetPolicies')
          .set({ store: 'denied' })
          .where('id', '=', policyId)
          .execute();
        return result;
      },
    };
    const deps = depsWith({ imageEditor: editor.editor, vision });
    const created = await persistSource(deps);
    policyId = created.source.assetPolicyId as string;
    const job = await jobOf(deps, created);
    await runRenderJob(deps, { renderJobId: job.id });
    expect(editor.enhanceCount()).toBe(0);
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({
      status: 'failed',
      reason: 'policy',
      retryable: true,
      editCount: 0,
    });
    expect(await enhancementOf(job.id)).toMatchObject({ outcome: 'failed', reason: 'policy' });
    expect(await paidEditsOf(created.ownerId)).toHaveLength(0);
  });

  it('a request the provider rejects is final and settled at 0', async () => {
    const editor = recordingEditor({
      enhance: failingAfterSend({
        status: 'failed',
        kind: 'invalid_request',
        httpStatus: 400,
        providerCode: 'invalid_value',
        retryable: false,
      }),
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const created = await persistSource(deps);
    const job = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [row] = await rowsOf(created.source.id);
    expect(row).toMatchObject({ status: 'failed', reason: 'invalid_request', retryable: false });
    const settled = (await enhancingLedger(job.id)).settled('image_edit_attempt');
    expect(settled.map((entry) => Number(entry.amountMicros))).toEqual([0]);

    const later = await jobOf(deps, created);
    expect((await runRenderJob(deps, { renderJobId: later.id })).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(1);
  });
});

describe('a pending row of another active job', () => {
  /** A queued job of another project, standing for an active job that holds the row. */
  async function otherActiveJob(deps: PipelineDeps) {
    const other = await persistSource(deps);
    return jobOf(deps, other, { enhance: false });
  }

  async function pendingOf(
    stored: Awaited<ReturnType<typeof storedSource>>,
    jobId: string,
  ): Promise<string> {
    const id = newId();
    await base.db
      .insertInto('sourceEnhancements')
      .values({
        id,
        sourceAssetId: stored.source.id,
        frameChecksumSha256: stored.source.checksumSha256 as string,
        compilerVersion: stored.compilerVersion,
        workingWidth: 1024,
        workingHeight: 1024,
        status: 'pending',
        jobId,
        editCount: 0,
      })
      .execute();
    return id;
  }

  it('is waited for; when it stays pending the job goes on with the frame (busy)', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor });
    const stored = await storedSource();
    const other = await otherActiveJob(deps);
    const id = await pendingOf(stored, other.id);
    const job = await jobOf(deps, stored);
    const started = Date.now();
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(Date.now() - started).toBeGreaterThanOrEqual(PIPELINE_DEFAULTS.enhance.pendingWaitMs);
    expect(editor.enhanceCount()).toBe(0);
    expect(await enhancementOf(job.id)).toEqual({
      outcome: 'skipped',
      enhancementId: null,
      reason: 'busy',
    });
    const [row] = await rowsOf(stored.source.id);
    expect(row).toMatchObject({ id, status: 'pending', jobId: other.id });
    await terminateRenderJob(base, { jobId: other.id, to: 'canceled' });
  }, 60_000);

  it('is waited for; when it ends without a decision the job claims it and enhances', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor });
    const stored = await storedSource();
    const other = await otherActiveJob(deps);
    const id = await pendingOf(stored, other.id);
    const job = await jobOf(deps, stored);
    const running = runRenderJob(deps, { renderJobId: job.id });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await base.db
      .updateTable('sourceEnhancements')
      .set({ status: 'failed', reason: 'aborted', retryable: true })
      .where('id', '=', id)
      .execute();
    expect((await running).state).toBe('succeeded');
    expect(editor.enhanceCount()).toBe(1);
    const [row] = await rowsOf(stored.source.id);
    expect(row).toMatchObject({ id, status: 'accepted', jobId: job.id, editCount: 1 });
    await terminateRenderJob(base, { jobId: other.id, to: 'canceled' });
  }, 60_000);
});
