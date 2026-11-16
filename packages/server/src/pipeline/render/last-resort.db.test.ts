import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CompiledRequest,
  FailureCode,
  JudgeResult,
  LightingMode,
  NormalizedBox,
} from '@hailiday/core';
import type { Clock } from '../../clock/index.js';
import { ProviderError } from '../../providers/errors.js';
import type {
  CallOptions,
  ImageEditor,
  JudgeInput,
  Providers,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import type * as Plan from '../plan/index.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { runRenderJob } from './job.js';
import { heldKeys } from './publish.js';
import type * as Quality from './quality.js';
import type * as Transitions from './transitions.js';
import { LostRaceError, readJob } from './transitions.js';

/**
 * Test hooks: `extraCodes` adds deterministic codes to the composites of one checked output (`n`
 * counts the composites of that output: 0 as checked, 1 with spots put back); `unplannable` makes
 * the plan of an attempt find no usable anchors; `onRejected` runs right after a transition to
 * `rejected` commits, before the job's run goes on.
 */
const hook = vi.hoisted(() => ({
  extraCodes: null as null | ((n: number) => FailureCode[]),
  unplannable: null as null | ((planVersion: number) => boolean),
  onRejected: null as null | ((jobId: string) => Promise<void>),
}));

vi.mock('../plan/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Plan>();
  const wrapped: typeof Plan.planAndCompile = (input, options) => {
    const result = actual.planAndCompile(input, options);
    if (!hook.unplannable?.(input.planVersion)) return result;
    return {
      built: {
        ...result.built,
        validator: { ...result.built.validator, passed: false, failure: 'non_empty' },
      },
      compile: null,
    };
  };
  return { ...actual, planAndCompile: wrapped };
});

vi.mock('./transitions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Transitions>();
  const wrapped: typeof Transitions.transitionJob = async (db, input) => {
    const job = await actual.transitionJob(db, input);
    if (input.to === 'rejected' && hook.onRejected) await hook.onRejected(job.id);
    return job;
  };
  return { ...actual, transitionJob: wrapped };
});

vi.mock('./quality.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Quality>();
  const composites = new WeakMap<object, number>();
  const wrapped: typeof Quality.compositeAndCheck = async (input) => {
    const result = await actual.compositeAndCheck(input);
    const registration = input.registration;
    if (!registration || !hook.extraCodes) return result;
    const n = composites.get(registration) ?? 0;
    composites.set(registration, n + 1);
    const extra = hook.extraCodes(n);
    if (extra.length === 0) return result;
    return {
      ...result,
      deterministic: {
        ...result.deterministic,
        codes: [...new Set([...result.deterministic.codes, ...extra])],
      },
    };
  };
  return { ...actual, compositeAndCheck: wrapped };
});

const SHOWCASE = 'ChIJfxLanternHillColonial01';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

afterEach(() => {
  hook.extraCodes = null;
  hook.unplannable = null;
  hook.onRejected = null;
});

/** A clock that runs with the system clock plus an offset the test can move forward. */
function steppingClock(): Clock & { advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance(ms: number) {
      offset += ms;
    },
  };
}

function depsWith(o: {
  imageEditor?: ImageEditor;
  vision?: VisionModel;
  clock?: Clock;
  options?: PipelineDeps['options'];
  settings?: PipelineDeps['settings'];
  storage?: PipelineDeps['storage'];
}) {
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
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.options ? { options: { ...base.options, ...o.options } } : {}),
    ...(o.settings ? { settings: o.settings } : {}),
    ...(o.storage ? { storage: o.storage } : {}),
  } as PipelineDeps;
}

/** A look of the showcase place whose frame, masks and working image are stored. */
async function lookOf(
  deps: PipelineDeps,
  lightingMode: LightingMode = 'source',
  reviewMode?: 'pre_delivery',
) {
  const { ownerId, projectId, source } = await createStreetViewSource(deps, {
    placeId: SHOWCASE,
    streetViewMode: 'persist',
  });
  const job = await createRenderJobRecord(deps, {
    ownerId,
    projectId,
    source,
    lightingMode,
    ...(reviewMode ? { reviewMode } : {}),
  });
  return { job, projectId };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const HALLWAY = path.join(here, '../../../content/photos/samples/sample-apartment-hallway.jpg');

/** A bright look of an uploaded hallway photo (dark enough to be relit). */
async function brightLookOf(deps: PipelineDeps) {
  const { ownerId, projectId, source } = await createUploadSource(deps, {
    image: await readFile(HALLWAY),
    fileName: 'hallway.jpg',
    sceneType: 'apartment_entry',
    roomType: null,
  });
  const job = await createRenderJobRecord(deps, {
    ownerId,
    projectId,
    source,
    style: 'abundant',
    lightingMode: 'bright',
  });
  return { job, projectId };
}

/** The companion job that holds or published an evening job's daylight base. */
const companionOf = (jobId: string) =>
  base.db
    .selectFrom('renderJobs')
    .selectAll()
    .where('idempotencyKey', '=', `relight-base:${jobId}`)
    .executeTakeFirst();

/** The attempt number of an edit request's attempt. */
async function attemptNoOf(attemptId: string): Promise<number> {
  const row = await base.db
    .selectFrom('renderAttempts')
    .select('attemptNo')
    .where('id', '=', attemptId)
    .executeTakeFirstOrThrow();
  return row.attemptNo;
}

async function attemptsOf(jobId: string) {
  return base.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
}

const summary = (rows: Awaited<ReturnType<typeof attemptsOf>>) =>
  rows.map((a) => [a.attemptNo, a.isRepair, a.outcome]);

async function assetsOf(projectId: string) {
  return base.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('projectId', '=', projectId)
    .where('deletedAt', 'is', null)
    .orderBy('createdAt')
    .execute();
}

/** Settled ledger lines of the job per SKU and stage, and its reservations still open. */
async function ledgerOf(jobId: string) {
  const rows = await base.db
    .selectFrom('usageLedger')
    .selectAll()
    .where('jobId', '=', jobId)
    .execute();
  const settled = (sku: string, stage?: string) =>
    rows.filter(
      (row) =>
        row.kind === 'settlement' &&
        row.sku === sku &&
        (stage === undefined || row.stage === stage),
    ).length;
  const open = rows
    .filter((row) => row.kind === 'reservation')
    .filter((row) => !rows.some((other) => other.reservationId === row.id));
  return { settled, open };
}

const restoredOf = (attempt: { compositeMask: unknown } | undefined) =>
  (attempt?.compositeMask as { restored?: unknown } | null)?.restored;

type Raw = { data: Buffer; width: number; height: number; channels: number };

async function decode(bytes: Uint8Array): Promise<Raw> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function stored(key: string, channels: 1 | 3): Promise<Raw> {
  const object = await base.storage.get('private', key);
  if (!object) throw new Error(`missing ${key}`);
  if (channels === 3) return decode(object.body);
  const { data, info } = await sharp(object.body)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Mean absolute channel difference of two images of one grid inside a box. */
function meanDiff(a: Raw, b: Raw, box: NormalizedBox): number {
  let total = 0;
  let count = 0;
  for (let y = Math.round(box[1] * a.height); y < Math.round(box[3] * a.height); y += 1) {
    for (let x = Math.round(box[0] * a.width); x < Math.round(box[2] * a.width); x += 1) {
      const i = y * a.width + x;
      for (let c = 0; c < 3; c += 1) {
        total += Math.abs(
          (a.data[i * a.channels + c] as number) - (b.data[i * b.channels + c] as number),
        );
        count += 1;
      }
    }
  }
  return total / count;
}

/** The working image of a job (stored for a persisted frame). */
const workingOf = (jobId: string) => stored(keys.working(jobId, 'working.png'), 3);

/**
 * The job's delivered image on the working grid: the delivered JPEG with the padding the working
 * image added put back from the working image.
 */
async function deliveredOf(jobId: string, objectKey: string): Promise<Raw> {
  const working = await workingOf(jobId);
  const delivered = await stored(objectKey, 3);
  const job = await readJob(base.db, jobId);
  const pad = job?.workingPadBox as NormalizedBox | null;
  if (!pad) return delivered;
  const out = { ...working, data: Buffer.from(working.data) };
  const x0 = Math.round(pad[0] * working.width);
  const y0 = Math.round(pad[1] * working.height);
  for (let y = 0; y < delivered.height; y += 1) {
    for (let x = 0; x < delivered.width; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        out.data[((y0 + y) * working.width + x0 + x) * 3 + c] = delivered.data[
          (y * delivered.width + x) * delivered.channels + c
        ] as number;
      }
    }
  }
  return out;
}

/**
 * A 16 px box well inside the hard composite mask an attempt stored (the editor was free to draw
 * there).
 */
async function editableBox(jobId: string, attemptNo: number): Promise<NormalizedBox> {
  const { data, width, height } = await stored(keys.working(jobId, `mask-${attemptNo}.png`), 1);
  const set = (x: number, y: number) => (data[y * width + x] as number) > 127;
  for (let y = 24; y < height - 24; y += 4) {
    for (let x = 24; x < width - 24; x += 4) {
      let inside = true;
      for (let dy = -20; dy <= 20 && inside; dy += 2) {
        for (let dx = -20; dx <= 20 && inside; dx += 2) inside = set(x + dx, y + dy);
      }
      if (inside) return [(x - 8) / width, (y - 8) / height, (x + 8) / width, (y + 8) / height];
    }
  }
  throw new Error('no editable area in the mask');
}

/**
 * The fixture editor that paints a solid patch over an editable spot of each decorate attempt's
 * mask (`spots`, by attempt number), records the relight inputs, and answers the decorate
 * attempts `fail` names with `fail(...)`.
 */
function paintingEditor(
  o: { fail?: (attemptNo: number, call: number) => 'provider_error' | 'stop' | null } = {},
  stop?: AbortController,
) {
  const inner = base.providers.fixtures.imageEditor;
  const spots = new Map<number, NormalizedBox>();
  const relightInputs: Buffer[] = [];
  const requests: CompiledRequest[] = [];
  const calls = new Map<number, number>();
  const editor: ImageEditor = {
    ...inner,
    async edit(request, input, options) {
      requests.push(request);
      if ((request.kind ?? 'decorate') !== 'decorate') {
        relightInputs.push(Buffer.from(input.image));
        return inner.edit(request, input, options);
      }
      const attempt = await base.db
        .selectFrom('renderAttempts')
        .select(['jobId', 'attemptNo'])
        .where('id', '=', options.attemptId)
        .executeTakeFirstOrThrow();
      const call = calls.get(attempt.attemptNo) ?? 0;
      calls.set(attempt.attemptNo, call + 1);
      const failure = o.fail?.(attempt.attemptNo, call) ?? null;
      if (failure === 'stop') {
        stop?.abort();
        return { status: 'failed', kind: 'provider_error', retryable: false };
      }
      if (failure === 'provider_error') {
        return { status: 'failed', kind: 'provider_error', retryable: false };
      }
      const outcome = await inner.edit(request, input, options);
      if (outcome.status !== 'completed') return outcome;
      const box = await editableBox(attempt.jobId, attempt.attemptNo);
      spots.set(attempt.attemptNo, box);
      const left = Math.round(box[0] * outcome.width);
      const top = Math.round(box[1] * outcome.height);
      const patch = await sharp({
        create: {
          width: Math.max(1, Math.round(box[2] * outcome.width) - left),
          height: Math.max(1, Math.round(box[3] * outcome.height) - top),
          channels: 3,
          background: { r: 255, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer();
      const image = await sharp(outcome.image)
        .composite([{ input: patch, left, top }])
        .png()
        .toBuffer();
      return { ...outcome, image, format: 'png' };
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
  return {
    editor,
    spots,
    relightInputs,
    kinds: () => requests.map((r) => r.kind ?? 'decorate'),
  };
}

type TestFinding = {
  code: FailureCode;
  confidence: number;
  box?: NormalizedBox | 'spot' | 'placements';
};

/**
 * The fixture vision model with findings added to every decorate judge call (its escalation
 * included) as `findingsOf` gives them for the plan's attempt number: `spot` boxes the painted
 * spot of that attempt, `placements` the box around all of the plan's placements. `throwOn`
 * makes the decorate judge of that attempt unavailable.
 */
function judgingVision(
  spots: Map<number, NormalizedBox>,
  findingsOf: (attemptNo: number) => TestFinding[],
  o: { onJudge?: (input: JudgeInput) => void; throwOn?: number } = {},
) {
  const inner = base.providers.fixtures.vision;
  const judged: JudgeInput[] = [];
  const vision: VisionModel = {
    ...inner,
    async judge(input: JudgeInput, options?: CallOptions): Promise<VisionCallResult<JudgeResult>> {
      judged.push(input);
      o.onJudge?.(input);
      const result = await inner.judge(input, options);
      if (input.mode === 'relight') return result;
      const attemptNo = input.plan.attemptNumber;
      if (o.throwOn === attemptNo) {
        throw new ProviderError('fixture', 'provider_error', 'judge unavailable', {
          retryable: false,
        });
      }
      const regions = input.plan.placements.map((placement) => placement.region);
      const around: NormalizedBox = [
        Math.min(...regions.map((r) => r[0])),
        Math.min(...regions.map((r) => r[1])),
        Math.max(...regions.map((r) => r[2])),
        Math.max(...regions.map((r) => r[3])),
      ];
      const critical = [...result.result.critical];
      const major = [...result.result.major];
      for (const finding of findingsOf(attemptNo)) {
        const box =
          finding.box === 'spot'
            ? spots.get(attemptNo)
            : finding.box === 'placements'
              ? around
              : finding.box;
        const entry = {
          code: finding.code,
          confidence: finding.confidence,
          evidence: 'Test judge finding.',
          ...(box ? { box } : {}),
        };
        if (
          ['unrequested_change', 'plan_not_followed', 'implausible_decor'].includes(finding.code)
        ) {
          major.push(entry as JudgeResult['major'][number]);
        } else {
          critical.push(entry as JudgeResult['critical'][number]);
        }
      }
      return { ...result, result: { ...result.result, critical, major } };
    },
  };
  return { vision, judged };
}

const everyAttempt =
  (...findings: TestFinding[]) =>
  () =>
    findings;

describe('the last resort: a rejected look has the spots the judge objected to put back', () => {
  it('as photographed: both attempts rejected for a boxed confident finding; the look is delivered', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.95, box: 'spot' }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
    ]);
    const spot = painting.spots.get(2) as NormalizedBox;
    const restored = restoredOf(attempts[1]) as { keptShare: number };
    expect(restored).toMatchObject({
      kind: 'objected',
      codes: ['structure_changed'],
      boxes: [spot],
    });
    expect(restored.keptShare).toBeGreaterThanOrEqual(0.4);
    expect(restoredOf(attempts[0])).toBeUndefined();

    // The delivered look is the original inside the spot, although the editor painted it, and
    // decorated elsewhere.
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode])).toEqual([[job.id, 'source']]);
    const working = await workingOf(job.id);
    const delivered = await deliveredOf(job.id, assets[0]?.objectKey as string);
    const judgedCandidate = await decode(
      judging.judged.find((input) => input.plan.attemptNumber === 2)?.candidate.bytes as Buffer,
    );
    expect(meanDiff(judgedCandidate, working, spot)).toBeGreaterThan(10);
    expect(meanDiff(delivered, working, spot)).toBeLessThan(3);
    const plan = judging.judged.find((input) => input.plan.attemptNumber === 2)?.plan;
    const decorated = Math.max(
      ...(plan?.placements ?? []).map((p) => meanDiff(delivered, working, p.region)),
    );
    expect(decorated).toBeGreaterThan(3);

    // No paid call is added: two edits, two judge calls, two localizations.
    expect(judging.judged).toHaveLength(2);
    const ledger = await ledgerOf(job.id);
    expect(ledger.settled('image_edit_attempt')).toBe(2);
    expect(ledger.settled('vision_call', 'checking')).toBe(2);
    expect(ledger.settled('vision_call', 'localizing')).toBe(2);
    expect(ledger.open).toEqual([]);
    expect(await readJob(base.db, job.id)).toMatchObject({ attemptCount: 2, repairUsed: true });
  });

  it('evening: the restored base is relit while time allows', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.95, box: 'spot' }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate', 'relight']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
      [3, false, 'succeeded'],
    ]);
    const spot = painting.spots.get(2) as NormalizedBox;
    expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected', boxes: [spot] });
    expect(attempts[2]?.fallback).toMatchObject({
      kind: 'relight',
      baseAttemptId: attempts[1]?.id,
    });
    // The relight started from the restored base: the original inside the spot.
    const working = await workingOf(job.id);
    const relit = await decode(painting.relightInputs[0] as Buffer);
    expect(meanDiff(relit, working, spot)).toBe(0);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['evening']);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('evening: with no time for the relight, the restored base is the daylight look', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    // The repair is judged when the job is 200 s old: no time is left for the relight.
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.95, box: 'spot' }),
      {
        onJudge: (input) => {
          if (input.plan.attemptNumber === 2 && !input.escalated) clock.advance(200_000);
        },
      },
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision, clock });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(painting.kinds()).toEqual(['decorate', 'decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
    ]);
    expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected' });
    expect(attempts[1]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'evening',
      reason: 'relight_not_attempted',
      deliveredAs: 'daylight_variant',
      relightAttemptId: null,
      codes: ['structure_changed'],
    });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => a.lightingMode)).toEqual(['source']);
    expect(assets[0]?.jobId).not.toBe(job.id);
    const working = await workingOf(job.id);
    const daylight = await deliveredOf(job.id, assets[0]?.objectKey as string);
    expect(meanDiff(daylight, working, painting.spots.get(2) as NormalizedBox)).toBeLessThan(3);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  for (const code of ['people_altered', 'privacy_regression'] as const) {
    it(`as photographed: a boxed ${code} finding is put back and delivered`, async () => {
      const painting = paintingEditor();
      const judging = judgingVision(
        painting.spots,
        everyAttempt({ code, confidence: 0.95, box: 'spot' }),
      );
      const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
      const { job, projectId } = await lookOf(deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected', codes: [code] });
      expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
    });
  }
});

describe('the last resort does not apply: the job ends rejected as before', () => {
  async function expectRejected(
    findings: TestFinding[],
    o: { attempts: number; extraCodes?: (n: number) => FailureCode[] },
  ) {
    hook.extraCodes = o.extraCodes ?? null;
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, everyAttempt(...findings));
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => a.outcome)).toEqual(Array(o.attempts).fill('qa_rejected'));
    expect(attempts.map(restoredOf)).toEqual(Array(o.attempts).fill(undefined));
    expect(await assetsOf(projectId)).toEqual([]);
    expect((await ledgerOf(job.id)).open).toEqual([]);
    return job;
  }

  it('a finding without a box', async () => {
    await expectRejected([{ code: 'structure_changed', confidence: 0.95 }], { attempts: 2 });
  });

  it('a boxed finding beside one without a box', async () => {
    await expectRejected(
      [
        { code: 'structure_changed', confidence: 0.95, box: 'spot' },
        { code: 'access_blocked', confidence: 0.5 },
      ],
      { attempts: 2 },
    );
  });

  for (const code of [
    'wrong_property',
    'camera_changed',
    'unsafe_or_offensive',
    'attribution_altered',
  ] as const) {
    it(`a boxed ${code} finding`, async () => {
      const job = await expectRejected(
        [
          { code: 'structure_changed', confidence: 0.95, box: 'spot' },
          { code, confidence: 0.95, box: 'spot' },
        ],
        { attempts: code === 'camera_changed' ? 2 : 1 },
      );
      expect((await readJob(base.db, job.id))?.failureCodes).toContain(code);
    });
  }

  it('a deterministic code behind the verdict', async () => {
    const job = await expectRejected(
      [{ code: 'structure_changed', confidence: 0.95, box: 'spot' }],
      { attempts: 2, extraCodes: (n) => (n === 0 ? ['implausible_decor'] : []) },
    );
    expect((await readJob(base.db, job.id))?.failureCodes).toEqual([
      'structure_changed',
      'implausible_decor',
    ]);
  });

  it('a restore that leaves too little of the decorations', async () => {
    await expectRejected([{ code: 'structure_changed', confidence: 0.95, box: [0, 0, 1, 1] }], {
      attempts: 2,
    });
  });

  it('a restored picture the deterministic checks reject', async () => {
    await expectRejected([{ code: 'structure_changed', confidence: 0.95, box: 'spot' }], {
      attempts: 2,
      extraCodes: (n) => (n === 1 ? ['structure_changed'] : []),
    });
  });
});

describe('a doubt delivered as it stands has its doubted spot put back when that costs little', () => {
  /** An evening look whose base is doubted when 100 s of the job are left. */
  async function doubtedEvening(finding: TestFinding) {
    const clock = steppingClock();
    const painting = paintingEditor();
    let aged = false;
    const judging = judgingVision(painting.spots, everyAttempt(finding), {
      onJudge: () => {
        if (!aged) clock.advance(140_000);
        aged = true;
      },
    });
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision, clock });
    const { job } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'relight']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, false, 'succeeded'],
    ]);
    const spot = painting.spots.get(1) as NormalizedBox;
    const working = await workingOf(job.id);
    const relit = await decode(painting.relightInputs[0] as Buffer);
    return { attempts, spot, working, relit };
  }

  it('evening: a doubted base accepted for lack of time is relit from the original inside the box', async () => {
    const { attempts, spot, working, relit } = await doubtedEvening({
      code: 'structure_changed',
      confidence: 0.5,
      box: 'spot',
    });
    expect(restoredOf(attempts[0])).toMatchObject({
      kind: 'doubted',
      codes: ['structure_changed'],
      boxes: [spot],
    });
    expect(meanDiff(relit, working, spot)).toBe(0);
  });

  it('a doubt whose box holds most of the decorations goes on unrestored', async () => {
    const { attempts, spot, working, relit } = await doubtedEvening({
      code: 'structure_changed',
      confidence: 0.5,
      box: 'placements',
    });
    expect(restoredOf(attempts[0])).toBeUndefined();
    expect(meanDiff(relit, working, spot)).toBeGreaterThan(10);
  });

  it('a doubt without a box goes on unrestored', async () => {
    const { attempts, spot, working, relit } = await doubtedEvening({
      code: 'structure_changed',
      confidence: 0.5,
    });
    expect(restoredOf(attempts[0])).toBeUndefined();
    expect(meanDiff(relit, working, spot)).toBeGreaterThan(10);
  });
});

describe('a doubted picture is not lost to its repair', () => {
  const doubtThen =
    (...repair: TestFinding[]) =>
    (attemptNo: number): TestFinding[] =>
      attemptNo === 1 ? [{ code: 'structure_changed', confidence: 0.5, box: 'spot' }] : repair;

  it('as photographed: the repair is rejected; the kept attempt is delivered with its doubt put back', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      doubtThen({ code: 'neighbor_decorated', confidence: 0.95 }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    const spot = painting.spots.get(1) as NormalizedBox;
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'doubted', boxes: [spot] });
    expect(restoredOf(attempts[1])).toBeUndefined();
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode])).toEqual([[job.id, 'source']]);
    const working = await workingOf(job.id);
    const delivered = await deliveredOf(job.id, assets[0]?.objectKey as string);
    expect(meanDiff(delivered, working, spot)).toBeLessThan(3);
    expect(await readJob(base.db, job.id)).toMatchObject({ renderAssetId: assets[0]?.id });
  });

  it('evening: the repair is rejected; the kept base is relit', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      doubtThen({ code: 'neighbor_decorated', confidence: 0.95 }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate', 'relight']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
      [3, false, 'succeeded'],
    ]);
    expect(attempts[2]?.fallback).toMatchObject({
      kind: 'relight',
      baseAttemptId: attempts[0]?.id,
    });
    const working = await workingOf(job.id);
    const relit = await decode(painting.relightInputs[0] as Buffer);
    expect(meanDiff(relit, working, painting.spots.get(1) as NormalizedBox)).toBe(0);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['evening']);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it("as photographed: the repair's edit fails; the kept attempt is delivered", async () => {
    const painting = paintingEditor({
      fail: (attemptNo) => (attemptNo === 2 ? 'provider_error' : null),
    });
    const judging = judgingVision(painting.spots, doubtThen());
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'provider_error'],
    ]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'doubted' });
    expect((await assetsOf(projectId)).map((a) => [a.jobId, a.lightingMode])).toEqual([
      [job.id, 'source'],
    ]);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it("evening: the repair's check fails; the kept base is the daylight look without a relight", async () => {
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, doubtThen(), { throwOn: 2 });
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(painting.kinds()).toEqual(['decorate', 'decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'evening',
      reason: 'relight_not_attempted',
      deliveredAs: 'daylight_variant',
      relightAttemptId: null,
      codes: ['structure_changed'],
    });
    expect(await readJob(base.db, job.id)).toMatchObject({
      rejectionReason: 'qa_uncertain',
      failureCodes: ['structure_changed'],
    });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('nothing is kept across a redelivery: the repair that fails there fails the job as before', async () => {
    const stop = new AbortController();
    const painting = paintingEditor(
      {
        fail: (attemptNo, call) =>
          attemptNo !== 2 ? null : call === 0 ? 'stop' : 'provider_error',
      },
      stop,
    );
    const judging = judgingVision(painting.spots, doubtThen());
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    // The worker stops while the repair is sent; another worker takes the job.
    await expect(
      runRenderJob(deps, { renderJobId: job.id, signal: stop.signal }),
    ).rejects.toThrow();
    expect((await readJob(base.db, job.id))?.state).toBe('rendering');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'provider_error' });
    expect(await assetsOf(projectId)).toEqual([]);
  });
});

describe('a rejected first attempt whose objected spots qualify is kept through its repair', () => {
  const boxedOnFirst =
    (...repair: TestFinding[]) =>
    (attemptNo: number): TestFinding[] =>
      attemptNo === 1 ? [{ code: 'structure_changed', confidence: 0.95, box: 'spot' }] : repair;

  it("as photographed: the repair's edit fails; the kept attempt is delivered with its spots put back", async () => {
    const painting = paintingEditor({
      fail: (attemptNo) => (attemptNo === 2 ? 'provider_error' : null),
    });
    const judging = judgingVision(painting.spots, boxedOnFirst());
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'provider_error'],
    ]);
    const spot = painting.spots.get(1) as NormalizedBox;
    expect(restoredOf(attempts[0])).toMatchObject({
      kind: 'objected',
      codes: ['structure_changed'],
      boxes: [spot],
    });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode])).toEqual([[job.id, 'source']]);
    const working = await workingOf(job.id);
    const delivered = await deliveredOf(job.id, assets[0]?.objectKey as string);
    expect(meanDiff(delivered, working, spot)).toBeLessThan(3);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('as photographed: the repair is rejected with nothing to put back; the kept attempt goes on', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      boxedOnFirst({ code: 'neighbor_decorated', confidence: 0.95 }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'objected' });
    expect(restoredOf(attempts[1])).toBeUndefined();
    expect((await assetsOf(projectId)).map((a) => [a.jobId, a.lightingMode])).toEqual([
      [job.id, 'source'],
    ]);
  });

  it("evening: the repair's check fails; the kept base with its spots put back is the daylight look", async () => {
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, boxedOnFirst(), { throwOn: 2 });
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(painting.kinds()).toEqual(['decorate', 'decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'objected' });
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'evening',
      reason: 'relight_not_attempted',
      deliveredAs: 'daylight_variant',
      relightAttemptId: null,
      codes: ['structure_changed'],
    });
    expect(await readJob(base.db, job.id)).toMatchObject({
      rejectionReason: 'qa_critical',
      failureCodes: ['structure_changed'],
    });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => a.lightingMode)).toEqual(['source']);
    const working = await workingOf(job.id);
    const daylight = await deliveredOf(job.id, assets[0]?.objectKey as string);
    expect(meanDiff(daylight, working, painting.spots.get(1) as NormalizedBox)).toBeLessThan(3);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('a kept doubt goes before the last resort on the repair', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, (attemptNo) =>
      attemptNo === 1
        ? [{ code: 'structure_changed', confidence: 0.5, box: 'spot' }]
        : [{ code: 'structure_changed', confidence: 0.95, box: 'spot' }],
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'doubted' });
    expect(restoredOf(attempts[1])).toBeUndefined();
  });

  it('a boxless confident major beside a boxed critical finding is recorded, not a block', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt(
        { code: 'structure_changed', confidence: 0.95, box: 'spot' },
        { code: 'plan_not_followed', confidence: 0.9 },
      ),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
    ]);
    expect(restoredOf(attempts[1])).toEqual({
      kind: 'objected',
      codes: ['structure_changed', 'plan_not_followed'],
      boxes: [painting.spots.get(2)],
      keptShare: expect.any(Number),
      recordedMajors: ['plan_not_followed'],
    });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
  });
});

describe('an attempt that would pass with no repair after it is not lost to its repair', () => {
  const majorOnFirst =
    (first: TestFinding, ...repair: TestFinding[]) =>
    (attemptNo: number): TestFinding[] =>
      attemptNo === 1 ? [first] : repair;

  for (const box of [undefined, 'spot', 'placements'] as const) {
    it(`as photographed: the repair's edit fails; the kept attempt with a ${box ?? 'boxless'} major is delivered as it stands`, async () => {
      const painting = paintingEditor({
        fail: (attemptNo) => (attemptNo === 2 ? 'provider_error' : null),
      });
      const judging = judgingVision(
        painting.spots,
        majorOnFirst({ code: 'plan_not_followed', confidence: 0.9, ...(box ? { box } : {}) }),
      );
      const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
      const { job, projectId } = await lookOf(deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect(painting.kinds()).toEqual(['decorate', 'decorate']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'succeeded'],
        [2, true, 'provider_error'],
      ]);
      expect(restoredOf(attempts[0])).toBeUndefined();
      expect(await readJob(base.db, job.id)).toMatchObject({ repairUsed: true });
      expect((await readJob(base.db, job.id))?.qaPassedAt).not.toBeNull();
      const assets = await assetsOf(projectId);
      expect(assets.map((a) => [a.jobId, a.lightingMode])).toEqual([[job.id, 'source']]);
      // The picture is the attempt as it stands: what the editor drew is kept.
      const working = await workingOf(job.id);
      const delivered = await deliveredOf(job.id, assets[0]?.objectKey as string);
      expect(meanDiff(delivered, working, painting.spots.get(1) as NormalizedBox)).toBeGreaterThan(
        10,
      );
      expect((await ledgerOf(job.id)).open).toEqual([]);
    });
  }

  it('as photographed: the repair is rejected for a finding without a box; the kept attempt is delivered', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      majorOnFirst(
        { code: 'plan_not_followed', confidence: 0.9 },
        { code: 'neighbor_decorated', confidence: 0.95 },
      ),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    expect(attempts.map(restoredOf)).toEqual([undefined, undefined]);
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode])).toEqual([[job.id, 'source']]);
    expect(await readJob(base.db, job.id)).toMatchObject({ renderAssetId: assets[0]?.id });
  });

  it("as photographed: the repair's judge is unavailable; the kept attempt is delivered", async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      majorOnFirst({ code: 'plan_not_followed', confidence: 0.9 }),
      { throwOn: 2 },
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    expect((await assetsOf(projectId)).map((a) => [a.jobId, a.lightingMode])).toEqual([
      [job.id, 'source'],
    ]);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('the kept passing attempt goes before the last resort on the repair', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      majorOnFirst(
        { code: 'plan_not_followed', confidence: 0.9 },
        { code: 'structure_changed', confidence: 0.95, box: 'spot' },
      ),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
    ]);
    expect(attempts.map(restoredOf)).toEqual([undefined, undefined]);
    expect((await assetsOf(projectId)).map((a) => [a.jobId, a.lightingMode])).toEqual([
      [job.id, 'source'],
    ]);
  });

  it("evening: the repair's edit fails; the kept base is the daylight look, published as a pass", async () => {
    const painting = paintingEditor({
      fail: (attemptNo) => (attemptNo === 2 ? 'provider_error' : null),
    });
    const judging = judgingVision(
      painting.spots,
      majorOnFirst({ code: 'plan_not_followed', confidence: 0.9 }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(painting.kinds()).toEqual(['decorate', 'decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'provider_error'],
    ]);
    expect(restoredOf(attempts[0])).toBeUndefined();
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'evening',
      reason: 'relight_not_attempted',
      deliveredAs: 'daylight_variant',
      relightAttemptId: null,
      codes: [],
    });
    expect(await readJob(base.db, job.id)).toMatchObject({
      rejectionReason: 'qa_critical',
      failureCodes: [],
    });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => a.lightingMode)).toEqual(['source']);
    expect(await companionOf(job.id)).toMatchObject({ state: 'succeeded' });
    expect((await companionOf(job.id))?.qaPassedAt).not.toBeNull();
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('evening: the repair is rejected; the kept base is published as the daylight look and relit', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      majorOnFirst(
        { code: 'plan_not_followed', confidence: 0.9 },
        { code: 'neighbor_decorated', confidence: 0.95 },
      ),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate', 'relight']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'qa_rejected'],
      [3, false, 'succeeded'],
    ]);
    expect(attempts[2]?.fallback).toMatchObject({
      kind: 'relight',
      baseAttemptId: attempts[0]?.id,
    });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode).sort()).toEqual([
      'evening',
      'source',
    ]);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it("bright: the repair's edit fails; the kept base is the result", async () => {
    const painting = paintingEditor({
      fail: (attemptNo) => (attemptNo === 2 ? 'provider_error' : null),
    });
    const judging = judgingVision(
      painting.spots,
      majorOnFirst({ code: 'plan_not_followed', confidence: 0.9 }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await brightLookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'provider_error'],
    ]);
    expect(attempts[0]?.fallback).toMatchObject({
      kind: 'relight_fallback',
      target: 'bright',
      deliveredAs: 'result',
      reason: 'relight_not_attempted',
      codes: [],
    });
    expect((await readJob(base.db, job.id))?.qaPassedAt).not.toBeNull();
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['bright']);
  });
});

describe('a boxed confident major never costs the look', () => {
  it('as photographed: putting its box back too would leave too little; the critical spot alone is put back', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt(
        { code: 'structure_changed', confidence: 0.95, box: 'spot' },
        { code: 'plan_not_followed', confidence: 0.9, box: 'placements' },
      ),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
    ]);
    const spot = painting.spots.get(2) as NormalizedBox;
    expect(restoredOf(attempts[1])).toEqual({
      kind: 'objected',
      codes: ['structure_changed', 'plan_not_followed'],
      boxes: [spot],
      keptShare: expect.any(Number),
      recordedMajors: ['plan_not_followed'],
    });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode])).toEqual([[job.id, 'source']]);
    const working = await workingOf(job.id);
    const delivered = await deliveredOf(job.id, assets[0]?.objectKey as string);
    expect(meanDiff(delivered, working, spot)).toBeLessThan(3);
    const plan = judging.judged.find((input) => input.plan.attemptNumber === 2)?.plan;
    const decorated = Math.max(
      ...(plan?.placements ?? []).map((p) => meanDiff(delivered, working, p.region)),
    );
    expect(decorated).toBeGreaterThan(3);
  });

  it('a boxed major beside a critical finding that already takes too much still ends rejected', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt(
        { code: 'structure_changed', confidence: 0.95, box: [0, 0, 1, 1] },
        { code: 'plan_not_followed', confidence: 0.9, box: 'spot' },
      ),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map(restoredOf)).toEqual([undefined, undefined]);
    expect(await assetsOf(projectId)).toEqual([]);
  });
});

describe('a repair while the job keeps an attempt to fall back on', () => {
  const doubtOnFirst = (attemptNo: number): TestFinding[] =>
    attemptNo === 1 ? [{ code: 'structure_changed', confidence: 0.5, box: 'spot' }] : [];

  /** The first attempt is judged when the job is `age` ms old (its escalation too). */
  function agedJudge(
    spots: Map<number, NormalizedBox>,
    clock: { advance(ms: number): void },
    age: number,
  ) {
    let aged = false;
    return judgingVision(spots, doubtOnFirst, {
      onJudge: () => {
        if (!aged) clock.advance(age);
        aged = true;
      },
    });
  }

  it('as photographed: the repair edit is bounded by the time left; its timeout delivers the kept doubt', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    const timeouts: number[] = [];
    // The repair's edit times out (the time it was given is recorded).
    const editor: ImageEditor = {
      ...painting.editor,
      async edit(request, input, options) {
        if ((await attemptNoOf(options.attemptId)) !== 2) {
          return painting.editor.edit(request, input, options);
        }
        timeouts.push(options.timeoutMs ?? 0);
        return { status: 'failed', kind: 'timeout', retryable: false };
      },
    };
    // The first attempt is judged when the job is 180 s old: 60 s are left of the 240 s limit,
    // more than the 48 s repair budget, so the repair starts with 45 s for its edit.
    const judging = agedJudge(painting.spots, clock, 180_000);
    const deps = depsWith({ imageEditor: editor, vision: judging.vision, clock });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(45_000);
    // The clock also runs in real time, so a busy machine eats a few seconds of what is left.
    expect(timeouts[0]).toBeGreaterThan(30_000);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'timeout'],
    ]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'doubted' });
    expect((await assetsOf(projectId)).map((a) => [a.jobId, a.lightingMode])).toEqual([
      [job.id, 'source'],
    ]);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('as photographed: a repair edit that could not finish in the time left is never sent', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    // The first attempt is judged when the job is 210 s old: 30 s are left, more than the 5 s
    // repair budget, so the repair is planned; with the 15 s guard only 15 s remain for its edit,
    // under the 20 s an edit needs, so it is not sent.
    const judging = agedJudge(painting.spots, clock, 210_000);
    const deps = depsWith({
      imageEditor: painting.editor,
      vision: judging.vision,
      clock,
      options: { repairBudgetMs: 5_000 },
    });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'canceled'],
    ]);
    expect(attempts[1]?.requestSentAt).toBeNull();
    expect(attempts[1]?.errorDetail).toMatchObject({ notDispatched: 'deadline' });
    expect((await assetsOf(projectId)).map((a) => [a.jobId, a.lightingMode])).toEqual([
      [job.id, 'source'],
    ]);
    const ledger = await ledgerOf(job.id);
    expect(ledger.settled('image_edit_attempt')).toBe(1);
    expect(ledger.open).toEqual([]);
  });

  /**
   * An editor whose repair edits answer a retryable timeout, each after using up `usesMs(call,
   * timeoutMs)` of the job's clock; the timeouts the repair's edits were given are recorded.
   */
  function slowRepairEditor(
    painting: ReturnType<typeof paintingEditor>,
    clock: { advance(ms: number): void },
    usesMs: (call: number, timeoutMs: number) => number,
  ) {
    const timeouts: number[] = [];
    const editor: ImageEditor = {
      ...painting.editor,
      async edit(request, input, options) {
        if ((await attemptNoOf(options.attemptId)) !== 2) {
          return painting.editor.edit(request, input, options);
        }
        const timeoutMs = options.timeoutMs ?? 0;
        clock.advance(usesMs(timeouts.length, timeoutMs));
        timeouts.push(timeoutMs);
        return { status: 'failed', kind: 'timeout', retryable: true };
      },
    };
    return { editor, timeouts };
  }

  async function expectKeptDoubtDelivered(jobId: string, projectId: string, retries: number) {
    const attempts = await attemptsOf(jobId);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded'],
      [2, true, 'timeout'],
    ]);
    expect(attempts[1]?.transportRetries).toBe(retries);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'doubted' });
    expect((await assetsOf(projectId)).map((a) => [a.jobId, a.lightingMode])).toEqual([
      [jobId, 'source'],
    ]);
    expect((await ledgerOf(jobId)).open).toEqual([]);
  }

  it('as photographed: a repair edit that timed out is not sent again once too little time is left', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    // The first call gives up after 5 s and is sent again with about 40 s; that one uses all of
    // its time, which leaves no time for another edit whatever the retry limit.
    const slow = slowRepairEditor(painting, clock, (call, timeoutMs) =>
      call === 0 ? 5_000 : timeoutMs,
    );
    const judging = agedJudge(painting.spots, clock, 180_000);
    const deps = depsWith({
      imageEditor: slow.editor,
      vision: judging.vision,
      clock,
      options: { transportRetryLimit: 4, retryDelayMs: () => 20 },
    });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(slow.timeouts).toHaveLength(2);
    expect(slow.timeouts[1]).toBeGreaterThan(PIPELINE_DEFAULTS.relightMinDispatchMs);
    await expectKeptDoubtDelivered(job.id, projectId, 1);
  });

  it('as photographed: a repair edit is not sent again when the retry delay would leave too little time', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    // The first call gives up after 20 s, leaving about 25 s for an edit; a 10 s retry delay
    // would leave under the 20 s an edit needs.
    const slow = slowRepairEditor(painting, clock, () => 20_000);
    const judging = agedJudge(painting.spots, clock, 180_000);
    const deps = depsWith({
      imageEditor: slow.editor,
      vision: judging.vision,
      clock,
      options: { transportRetryLimit: 2, retryDelayMs: () => 10_000 },
    });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(slow.timeouts).toHaveLength(1);
    await expectKeptDoubtDelivered(job.id, projectId, 0);
  });
});

describe("a kept attempt is the job's picture when its repair fails at planning", () => {
  const doubtOnFirst = (attemptNo: number): TestFinding[] =>
    attemptNo === 1 ? [{ code: 'structure_changed', confidence: 0.5, box: 'spot' }] : [];
  const boxedOnFirst = (attemptNo: number): TestFinding[] =>
    attemptNo === 1 ? [{ code: 'structure_changed', confidence: 0.95, box: 'spot' }] : [];

  /** Whether the job is planning its repair (one attempt written). */
  async function planningRepair(jobId: string): Promise<boolean> {
    const row = await readJob(base.db, jobId);
    return row?.state === 'planning' && (await attemptsOf(jobId)).length === 1;
  }

  it('as photographed: paid work is paused before the repair; the kept attempt is delivered', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, boxedOnFirst);
    const job = { id: '' };
    const settings: PipelineDeps['settings'] = {
      ...base.settings,
      isProviderPaused: async (provider: string) =>
        (job.id !== '' && (await planningRepair(job.id))) ||
        base.settings.isProviderPaused(provider),
    };
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision, settings });
    const look = await lookOf(deps);
    job.id = look.job.id;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([[1, false, 'succeeded']]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'objected' });
    expect((await assetsOf(look.projectId)).map((a) => a.lightingMode)).toEqual(['source']);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('evening: the paid-attempt cap refuses the repair; the kept doubt is the daylight look', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, doubtOnFirst);
    const job = { id: '' };
    const settings: PipelineDeps['settings'] = {
      ...base.settings,
      get: (async (key: string) => {
        // Another job of the owner took the last attempt after this one decided to repair.
        if (key === 'quota.attempts_per_owner_24h' && job.id && (await planningRepair(job.id))) {
          return 0;
        }
        return base.settings.get(key as never);
      }) as PipelineDeps['settings']['get'],
    };
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision, settings });
    const look = await lookOf(deps, 'evening');
    job.id = look.job.id;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(painting.kinds()).toEqual(['decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([[1, false, 'succeeded']]);
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'evening',
      reason: 'relight_not_attempted',
      deliveredAs: 'daylight_variant',
      relightAttemptId: null,
      codes: ['structure_changed'],
    });
    expect(await readJob(base.db, job.id)).toMatchObject({ rejectionReason: 'qa_uncertain' });
    expect((await assetsOf(look.projectId)).map((a) => a.lightingMode)).toEqual(['source']);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it("as photographed: the job's time is up when the repair is planned; the kept doubt is delivered", async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, doubtOnFirst);
    // The repair's mask is stored just before the time guard: the clock passes the limit there.
    const storage: PipelineDeps['storage'] = {
      ...base.storage,
      put: async (input) => {
        if (input.key.endsWith('mask-2.png')) clock.advance(600_000);
        return base.storage.put(input);
      },
    };
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision, clock, storage });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([[1, false, 'succeeded']]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'doubted' });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
  });

  it("as photographed: the job's deadline passes while the repair is planned; the kept doubt is delivered", async () => {
    const maxJobDurationMs = 25_000;
    const job = { id: '' };
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, doubtOnFirst);
    // The repair's mask is stored after the job's own deadline has fired.
    const storage: PipelineDeps['storage'] = {
      ...base.storage,
      put: async (input) => {
        if (input.key === keys.working(job.id, 'mask-2.png')) {
          const startedAt = (await readJob(base.db, job.id))?.startedAt?.getTime() ?? Date.now();
          const wait = startedAt + maxJobDurationMs + 500 - Date.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        }
        return base.storage.put(input);
      },
    };
    const deps = depsWith({
      imageEditor: painting.editor,
      vision: judging.vision,
      storage,
      options: { maxJobDurationMs, repairBudgetMs: 1_000 },
    });
    const look = await lookOf(deps);
    job.id = look.job.id;
    const projectId = look.projectId;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([[1, false, 'succeeded']]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'doubted' });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  }, 90_000);

  it('evening: the repair finds no usable anchors; the kept base with its spots put back is the daylight look', async () => {
    hook.unplannable = (planVersion) => planVersion === 2;
    const painting = paintingEditor();
    const judging = judgingVision(painting.spots, boxedOnFirst);
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(painting.kinds()).toEqual(['decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([[1, false, 'succeeded']]);
    expect(restoredOf(attempts[0])).toMatchObject({ kind: 'objected' });
    expect(attempts[0]?.fallback).toMatchObject({
      kind: 'relight_fallback',
      deliveredAs: 'daylight_variant',
      codes: ['structure_changed'],
    });
    expect(await readJob(base.db, job.id)).toMatchObject({ rejectionReason: 'qa_critical' });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
  });
});

describe('a redelivery after the fallback to a kept attempt moved the job to checking', () => {
  it('ends the job with the failure the repair recorded', async () => {
    const painting = paintingEditor({
      fail: (attemptNo) => (attemptNo === 2 ? 'provider_error' : null),
    });
    const judging = judgingVision(painting.spots, (attemptNo) =>
      attemptNo === 1 ? [{ code: 'structure_changed', confidence: 0.5, box: 'spot' }] : [],
    );
    const plain = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    let stopped = false;
    // The worker stops while the kept attempt is published, after the job moved to `checking`.
    const storage: PipelineDeps['storage'] = {
      ...plain.storage,
      put: async (input) => {
        if (!stopped && input.key.endsWith('full.jpg')) {
          stopped = true;
          throw new LostRaceError('stopped', 'checking');
        }
        return plain.storage.put(input);
      },
    };
    const deps = { ...plain, storage } as PipelineDeps;
    const { job, projectId } = await lookOf(deps);
    expect(await runRenderJob(deps, { renderJobId: job.id })).toMatchObject({ stopped: true });
    expect((await readJob(base.db, job.id))?.state).toBe('checking');
    expect((await runRenderJob(plain, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'provider_error' });
    expect(await assetsOf(projectId)).toEqual([]);
  });
});

describe('the record of an evening job that ends with its daylight look', () => {
  it('is written with the rejection', async () => {
    const painting = paintingEditor();
    const inner = base.providers.fixtures.vision;
    // Every relight is rejected for good: the job ends rejected with its daylight look.
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        const result = await inner.judge(input, options);
        if (input.mode !== 'relight') return result;
        const entry = {
          code: 'structure_changed' as const,
          confidence: 0.95,
          evidence: 'Test judge finding.',
        };
        return {
          ...result,
          result: { ...result.result, critical: [...result.result.critical, entry] },
        };
      },
    };
    const deps = depsWith({ imageEditor: painting.editor, vision });
    const { job } = await lookOf(deps, 'evening');
    const atRejection: unknown[] = [];
    hook.onRejected = async (jobId) => {
      if (jobId !== job.id) return;
      const rows = await base.db
        .selectFrom('renderAttempts')
        .select('fallback')
        .where('jobId', '=', jobId)
        .where('fallback', 'is not', null)
        .execute();
      atRejection.push(...rows.map((row) => row.fallback));
    };
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(atRejection).toContainEqual(
      expect.objectContaining({ kind: 'relight_fallback', deliveredAs: 'daylight_variant' }),
    );
  });
});

describe('the product links of a picture with spots put back', () => {
  /**
   * The fixture vision model that rejects every decorate attempt for a boxed finding over the
   * region of the smallest placement whose kit item is placed once (`chosen`, by attempt number).
   */
  function removingVision(o: { onJudge?: (input: JudgeInput) => void } = {}) {
    const inner = base.providers.fixtures.vision;
    const chosen = new Map<number, { id: string; region: NormalizedBox }>();
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        o.onJudge?.(input);
        const result = await inner.judge(input, options);
        if (input.mode === 'relight') return result;
        const placements = input.plan.placements;
        const counts = new Map<string, number>();
        for (const p of placements) counts.set(p.kitItemId, (counts.get(p.kitItemId) ?? 0) + 1);
        const area = (r: NormalizedBox) => (r[2] - r[0]) * (r[3] - r[1]);
        const target = placements
          .filter((p) => counts.get(p.kitItemId) === 1)
          .sort((a, b) => area(a.region) - area(b.region))[0];
        if (!target) throw new Error('no placement of a kit item placed once');
        chosen.set(input.plan.attemptNumber, { id: target.id, region: target.region });
        const entry = {
          code: 'structure_changed' as const,
          confidence: 0.95,
          evidence: 'Test judge finding.',
          box: target.region,
        };
        return {
          ...result,
          result: { ...result.result, critical: [...result.result.critical, entry] },
        };
      },
    };
    return { vision, chosen };
  }

  /** The removed placement's link of an asset is hidden; the other decorations keep theirs. */
  async function expectRemovedLinkHidden(assetId: string, removedId: string | undefined) {
    const links = await base.db
      .selectFrom('renderProductLinks')
      .select(['placementRef', 'hiddenAt', 'hiddenReason'])
      .where('renderAssetId', '=', assetId)
      .execute();
    expect(removedId).toBeDefined();
    const link = links.find((l) => l.placementRef === removedId);
    expect(link).toMatchObject({ hiddenReason: 'not_present' });
    expect(link?.hiddenAt).not.toBeNull();
    expect(links.filter((l) => l.placementRef !== removedId && l.hiddenAt !== null)).toEqual([]);
    expect(links.length).toBeGreaterThan(1);
  }

  it('hide a decoration the restore took out of the picture', async () => {
    const painting = paintingEditor();
    const { vision, chosen } = removingVision();
    const deps = depsWith({ imageEditor: painting.editor, vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected' });
    const [asset] = await assetsOf(projectId);
    await expectRemovedLinkHidden(asset?.id as string, chosen.get(2)?.id);
  });

  it('evening: hide it on the relit look of the restored base', async () => {
    const painting = paintingEditor();
    const { vision, chosen } = removingVision();
    const deps = depsWith({ imageEditor: painting.editor, vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate', 'relight']);
    const attempts = await attemptsOf(job.id);
    expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected' });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode])).toEqual([[job.id, 'evening']]);
    await expectRemovedLinkHidden(assets[0]?.id as string, chosen.get(2)?.id);
  });

  it('evening: hide it on the daylight look when no time is left for the relight', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    // The repair is judged when the job is 200 s old: no time is left for the relight.
    const { vision, chosen } = removingVision({
      onJudge: (input) => {
        if (input.mode !== 'relight' && input.plan.attemptNumber === 2 && !input.escalated) {
          clock.advance(200_000);
        }
      },
    });
    const deps = depsWith({ imageEditor: painting.editor, vision, clock });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const attempts = await attemptsOf(job.id);
    expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected' });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => a.lightingMode)).toEqual(['source']);
    expect(assets[0]?.jobId).not.toBe(job.id);
    await expectRemovedLinkHidden(assets[0]?.id as string, chosen.get(2)?.id);
  });
});

describe('pre-delivery review', () => {
  it('holds a picture with spots put back, unpassed and unpublished', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.95, box: 'spot' }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps, 'source', 'pre_delivery');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    const attempts = await attemptsOf(job.id);
    expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected' });
    expect(await readJob(base.db, job.id)).toMatchObject({ qaPassedAt: null });
    expect(await assetsOf(projectId)).toEqual([]);
    const held = heldKeys(job.id, attempts[1]?.id as string);
    expect(await base.storage.get('private', held.delivered)).not.toBeNull();
  });

  it('evening with no time for the relight: the restored base is held under a companion', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.95, box: 'spot' }),
      {
        onJudge: (input) => {
          if (input.plan.attemptNumber === 2 && !input.escalated) clock.advance(200_000);
        },
      },
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision, clock });
    const { job, projectId } = await lookOf(deps, 'evening', 'pre_delivery');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(restoredOf((await attemptsOf(job.id))[1])).toMatchObject({ kind: 'objected' });
    expect(await companionOf(job.id)).toMatchObject({ state: 'needs_review', qaPassedAt: null });
    expect(await assetsOf(projectId)).toEqual([]);
  });

  it('does not put back the spots of a doubt it holds for the reviewer', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.5, box: 'spot' }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job } = await lookOf(deps, 'source', 'pre_delivery');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([[1, false, 'succeeded']]);
    expect(restoredOf(attempts[0])).toBeUndefined();
    // The held picture keeps what the editor drew inside the doubted spot.
    const working = await workingOf(job.id);
    const heldPicture = await deliveredOf(
      job.id,
      heldKeys(job.id, attempts[0]?.id as string).delivered,
    );
    expect(meanDiff(heldPicture, working, painting.spots.get(1) as NormalizedBox)).toBeGreaterThan(
      10,
    );
  });
});

describe('the last resort for a bright look', () => {
  it('relights the attempt with its objected spots put back', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.95, box: 'spot' }),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await brightLookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'decorate', 'relight']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
      [3, false, 'succeeded'],
    ]);
    const spot = painting.spots.get(2) as NormalizedBox;
    expect(restoredOf(attempts[1])).toMatchObject({ kind: 'objected', boxes: [spot] });
    const working = await workingOf(job.id);
    const relit = await decode(painting.relightInputs[0] as Buffer);
    expect(meanDiff(relit, working, spot)).toBe(0);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['bright']);
  });
});

describe('a relight the judge only doubts', () => {
  it('evening: delivered when no repair can follow', async () => {
    const painting = paintingEditor();
    const inner = base.providers.fixtures.vision;
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        const result = await inner.judge(input, options);
        if (input.mode !== 'relight') return result;
        const doubt = {
          code: 'structure_changed' as const,
          confidence: 0.5,
          evidence: 'Test judge doubt.',
        };
        return {
          ...result,
          result: { ...result.result, critical: [...result.result.critical, doubt] },
        };
      },
    };
    const deps = depsWith({ imageEditor: painting.editor, vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    // The first relight's doubt is repaired while the job has its repair; the repair, doubted
    // again with no repair after it, is delivered.
    expect(painting.kinds()).toEqual(['decorate', 'relight', 'relight']);
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded'],
      [2, false, 'qa_rejected'],
      [3, true, 'succeeded'],
    ]);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toContain('evening');
  });

  it('evening: a relight whose registration finds the camera moved is never delivered', async () => {
    const painting = paintingEditor();
    // Every relight comes back reframed to a narrow picture: registration rejects it
    // (`camera_changed`) before the judge, which doubts the camera on every relight.
    const editor: ImageEditor = {
      ...painting.editor,
      async edit(request, input, options) {
        const outcome = await painting.editor.edit(request, input, options);
        if ((request.kind ?? 'decorate') === 'decorate' || outcome.status !== 'completed') {
          return outcome;
        }
        const meta = await sharp(outcome.image).metadata();
        const side = Math.min(meta.width ?? 0, meta.height ?? 0);
        const image = await sharp(outcome.image)
          .resize(Math.round(side * 0.6), side, { fit: 'fill' })
          .png()
          .toBuffer();
        return { ...outcome, image, format: 'png', width: Math.round(side * 0.6), height: side };
      },
    };
    const inner = base.providers.fixtures.vision;
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        const result = await inner.judge(input, options);
        if (input.mode !== 'relight') return result;
        const doubt = {
          code: 'camera_changed' as const,
          confidence: 0.5,
          evidence: 'Test judge doubt.',
        };
        return {
          ...result,
          result: { ...result.result, critical: [...result.result.critical, doubt] },
        };
      },
    };
    const deps = depsWith({ imageEditor: editor, vision });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(painting.kinds()).toEqual(['decorate', 'relight', 'relight']);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureCodes: ['camera_changed'] });
    const judged = await base.db
      .selectFrom('judgeResults as r')
      .innerJoin('renderAttempts as a', 'a.id', 'r.attemptId')
      .select(['a.attemptNo', 'r.modelId', 'r.criticalCodes'])
      .where('a.jobId', '=', job.id)
      .where('a.attemptNo', '>', 1)
      .execute();
    expect(judged.map((row) => row.modelId)).toEqual([
      'deterministic-checks',
      'deterministic-checks',
    ]);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
  });
});

describe('a base doubted with too little time for a repair and the relight', () => {
  it('evening: with 130 s left the doubted base is relit at once', async () => {
    const clock = steppingClock();
    const painting = paintingEditor();
    let aged = false;
    // The first base is judged when the job is 110 s old: 130 s are left of the 240 s limit,
    // under `uncertainRepairWithRelightMs` (150 s), so the doubt is not repaired.
    const judging = judgingVision(
      painting.spots,
      everyAttempt({ code: 'structure_changed', confidence: 0.5 }),
      {
        onJudge: () => {
          if (!aged) clock.advance(110_000);
          aged = true;
        },
      },
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision, clock });
    const { job, projectId } = await lookOf(deps, 'evening');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(painting.kinds()).toEqual(['decorate', 'relight']);
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded'],
      [2, false, 'succeeded'],
    ]);
    expect(await readJob(base.db, job.id)).toMatchObject({ repairUsed: false });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toContain('evening');
  });
});

describe('a doubted global code beside a confident boxed finding', () => {
  it('blocks the last resort', async () => {
    const painting = paintingEditor();
    const judging = judgingVision(
      painting.spots,
      everyAttempt(
        { code: 'structure_changed', confidence: 0.95, box: 'spot' },
        { code: 'wrong_property', confidence: 0.5, box: 'spot' },
      ),
    );
    const deps = depsWith({ imageEditor: painting.editor, vision: judging.vision });
    const { job, projectId } = await lookOf(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => a.outcome)).toEqual(['qa_rejected', 'qa_rejected']);
    expect(attempts.map(restoredOf)).toEqual([undefined, undefined]);
    expect(await assetsOf(projectId)).toEqual([]);
  });
});
