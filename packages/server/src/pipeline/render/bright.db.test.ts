import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompiledRequest, JudgeResult, RoomType, SceneType } from '@hailiday/core';
import type {
  CallOptions,
  EditOutcome,
  ImageEditor,
  JudgeInput,
  Providers,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import type { PipelineDeps } from '../context.js';
import { newId } from '../../ids/index.js';
import { decodeRaster } from '../imaging/raster.js';
import { medianLuma } from '../imaging/relight.js';
import { prepareWorkingImage } from '../imaging/working.js';
import { createPipelineTestDeps, createRenderJobRecord, createUploadSource } from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { runRenderJob } from './job.js';
import { approveReview } from './review.js';
import { readJob } from './transitions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(here, '../../../content/photos/samples');

/** The sample photos and the scene each is uploaded as. */
const PHOTOS = {
  hallway: { file: 'sample-apartment-hallway.jpg', sceneType: 'apartment_entry', roomType: null },
  living: { file: 'sample-living-room-mantel.jpg', sceneType: 'interior', roomType: 'living_room' },
  dining: { file: 'sample-dining-room.jpg', sceneType: 'interior', roomType: 'dining_room' },
} as const satisfies Record<
  string,
  { file: string; sceneType: SceneType; roomType: RoomType | null }
>;

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

/** The shared dependencies with the fixture editor or vision model replaced. */
function depsWith(o: { imageEditor?: ImageEditor; vision?: VisionModel }): PipelineDeps {
  const providers: Providers = {
    ...base.providers,
    fixtures: {
      ...base.providers.fixtures,
      ...(o.imageEditor ? { imageEditor: o.imageEditor } : {}),
      ...(o.vision ? { vision: o.vision } : {}),
    },
  };
  return { ...base, providers };
}

/** Wraps the fixture editor, recording every request; relight answers can be replaced. */
function recordingEditor(
  relight?: (
    request: CompiledRequest,
    input: Parameters<ImageEditor['edit']>[1],
    options: Parameters<ImageEditor['edit']>[2],
  ) => Promise<EditOutcome>,
) {
  const inner = base.providers.fixtures.imageEditor;
  const requests: CompiledRequest[] = [];
  const editor: ImageEditor = {
    ...inner,
    async edit(request, input, options) {
      requests.push(request);
      if (relight && request.kind === 'relight') return relight(request, input, options);
      return inner.edit(request, input, options);
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
  return { editor, requests };
}

/** Wraps the fixture vision model; the judge can be replaced. */
function judgingVision(
  judge: (
    input: JudgeInput,
    inner: VisionModel,
    options?: CallOptions,
  ) => Promise<VisionCallResult<JudgeResult>>,
) {
  const inner = base.providers.fixtures.vision;
  const judged: JudgeInput[] = [];
  const vision: VisionModel = {
    ...inner,
    async judge(input, options) {
      judged.push(input);
      return judge(input, inner, options);
    },
  };
  return { vision, judged };
}

/** A judge result with one confident finding added. */
async function rejecting(
  input: JudgeInput,
  inner: VisionModel,
  finding: { code: 'structure_changed' } | { code: 'implausible_decor' },
  options?: CallOptions,
): Promise<VisionCallResult<JudgeResult>> {
  const result = await inner.judge(input, options);
  const entry = { ...finding, confidence: 0.95, evidence: 'Test judge finding.' };
  return {
    ...result,
    result: {
      ...result.result,
      ...(finding.code === 'structure_changed'
        ? { critical: [...result.result.critical, entry as JudgeResult['critical'][number]] }
        : { major: [...result.result.major, entry as JudgeResult['major'][number]] }),
    },
  };
}

async function sample(name: keyof typeof PHOTOS): Promise<Buffer> {
  return readFile(path.join(SAMPLES, PHOTOS[name].file));
}

/** An upload project of a sample photo and a queued render job for it. */
async function brightJob(
  deps: PipelineDeps,
  name: keyof typeof PHOTOS,
  extra: Partial<Parameters<typeof createRenderJobRecord>[1]> = {},
) {
  const photo = PHOTOS[name];
  const { ownerId, projectId, source } = await createUploadSource(deps, {
    image: await sample(name),
    fileName: `${name}.jpg`,
    sceneType: photo.sceneType,
    roomType: photo.roomType,
  });
  const job = await createRenderJobRecord(deps, {
    ownerId,
    projectId,
    source,
    style: 'abundant',
    lightingMode: 'bright',
    ...extra,
  });
  return { job, ownerId, projectId, source };
}

async function attemptsOf(jobId: string) {
  return base.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
}

async function assetsOf(projectId: string) {
  return base.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('projectId', '=', projectId)
    .where('deletedAt', 'is', null)
    .orderBy('createdAt')
    .execute();
}

async function openReservationIds(jobId: string): Promise<string[]> {
  const rows = await base.db
    .selectFrom('usageLedger')
    .selectAll()
    .where('jobId', '=', jobId)
    .execute();
  return rows
    .filter((row) => row.kind === 'reservation')
    .filter((row) => !rows.some((other) => other.reservationId === row.id))
    .map((row) => row.id);
}

/** Median luma of a stored delivered image (it carries no padding). */
async function deliveredLuma(objectKey: string): Promise<number> {
  const object = await base.storage.get('private', objectKey);
  return medianLuma(await decodeRaster(object?.body as Buffer));
}

describe('the bright look: which photos are relit', () => {
  it('measures the sample photos on their content area: the rooms are bright, the hallway is dim', async () => {
    const measures: Record<string, number> = {};
    for (const name of Object.keys(PHOTOS) as (keyof typeof PHOTOS)[]) {
      const working = await prepareWorkingImage(await sample(name), 'upload');
      measures[name] = medianLuma(working.raster, working.contentBox);
    }
    expect(PIPELINE_DEFAULTS.brightMedianLuma).toBe(0.6);
    // Recorded measures (Rec. 709 luma of the encoded values, padding excluded).
    expect(measures.living).toBeCloseTo(0.742, 2);
    expect(measures.dining).toBeCloseTo(0.627, 2);
    expect(measures.hallway).toBeCloseTo(0.474, 2);
    // The hallway is letterboxed on the working grid; its padding is not measured.
    const hallway = await prepareWorkingImage(await sample('hallway'), 'upload');
    expect(hallway.contentBox).not.toBeNull();
    expect(medianLuma(hallway.raster)).not.toBe(measures.hallway);
  });

  it('relights a dim photo: decorated as photographed, then brightened, one bright result', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor });
    const { job, projectId } = await brightJob(deps, 'hallway');
    expect(await runRenderJob(deps, { renderJobId: job.id })).toEqual({
      state: 'succeeded',
      stopped: false,
    });
    expect(await readJob(base.db, job.id)).toMatchObject({ attemptCount: 2, repairUsed: false });
    expect(editor.requests.map((request) => request.kind ?? 'decorate')).toEqual([
      'decorate',
      'relight',
    ]);
    expect(editor.requests[1]?.parameters.relight_target).toBe('bright');
    expect(editor.requests[1]?.mask).toBeUndefined();
    expect(editor.requests[1]?.instructionText).toContain(
      'Relight this exact photograph so the space is bright, airy and cheerful',
    );
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome, a.fidelityMode])).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'succeeded', 'global_relight'],
    ]);
    expect(attempts[0]?.fallback).toBeNull();
    expect(attempts[1]?.fallback).toMatchObject({
      kind: 'relight',
      base: 'attempt',
      baseAttemptId: attempts[0]?.id,
      baseRenderAssetId: null,
    });
    // The decorated base stays unpublished (stored for the relight): one bright result only.
    const base1 = await base.storage.get(
      'private',
      `attempts/${job.id}/${attempts[0]?.id}/relight-base.png`,
    );
    expect(base1).not.toBeNull();
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode, a.fidelityMode])).toEqual([
      [job.id, 'bright', 'global_relight'],
    ]);
    const baseRaster = await decodeRaster(base1?.body as Buffer);
    const working = await prepareWorkingImage(await sample('hallway'), 'upload');
    const relit = await deliveredLuma(assets[0]?.objectKey as string);
    expect(relit).toBeGreaterThan(medianLuma(baseRaster, working.contentBox) + 0.05);
    // The relight's judge ran in relight mode for the bright look.
    const judge = await base.db
      .selectFrom('judgeResults')
      .select(['deterministicChecks', 'decision'])
      .where('attemptId', '=', attempts[1]?.id as string)
      .executeTakeFirstOrThrow();
    expect(judge.decision).toBe('pass');
    expect((judge.deterministicChecks as { brightness?: unknown }).brightness).toMatchObject({
      measure: 'median_luma',
      passed: true,
    });
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  for (const name of ['living', 'dining'] as const) {
    it(`does not relight a photo that is already bright (${name}): one edit, the skip recorded`, async () => {
      const editor = recordingEditor();
      const deps = depsWith({ imageEditor: editor.editor });
      const { job, projectId } = await brightJob(deps, name);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect(editor.requests.map((request) => request.kind ?? 'decorate')).toEqual(['decorate']);
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
        [1, 'succeeded', 'composite_additive'],
      ]);
      expect(attempts[0]?.fallback).toEqual({
        kind: 'relight_skipped',
        reason: 'already_bright',
        medianLuma: expect.any(Number),
        threshold: 0.6,
      });
      expect((attempts[0]?.fallback as { medianLuma: number }).medianLuma).toBeGreaterThanOrEqual(
        0.6,
      );
      const assets = await assetsOf(projectId);
      expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
        ['bright', 'composite_additive'],
      ]);
      const edits = (
        await base.db.selectFrom('usageLedger').selectAll().where('jobId', '=', job.id).execute()
      ).filter((row) => row.sku === 'image_edit_attempt');
      expect(edits.filter((row) => row.kind === 'settlement')).toHaveLength(1);
      expect(await openReservationIds(job.id)).toEqual([]);
    });
  }
});

describe('the bright look never fails because brightening failed', () => {
  it('delivers the decorated base when the relight and its repair are rejected, and records it', async () => {
    const editor = recordingEditor();
    const vision = judgingVision((input, inner, options) =>
      input.mode === 'relight'
        ? rejecting(input, inner, { code: 'structure_changed' }, options)
        : inner.judge(input, options),
    );
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const { job, projectId } = await brightJob(deps, 'hallway');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
      [1, false, 'succeeded'],
      [2, false, 'qa_rejected'],
      [3, true, 'qa_rejected'],
    ]);
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'bright',
      reason: 'relight_rejected',
      deliveredAs: 'result',
      relightAttemptId: attempts[2]?.id,
      codes: ['structure_changed'],
    });
    const assets = await assetsOf(projectId);
    expect(assets.map((a) => [a.jobId, a.lightingMode, a.fidelityMode])).toEqual([
      [job.id, 'bright', 'composite_additive'],
    ]);
    // The delivered pixels are the decorated base, not the relit output.
    const stored = await base.storage.get(
      'private',
      `attempts/${job.id}/${attempts[0]?.id}/relight-base.png`,
    );
    const working = await prepareWorkingImage(await sample('hallway'), 'upload');
    expect(await deliveredLuma(assets[0]?.objectKey as string)).toBeCloseTo(
      medianLuma(await decodeRaster(stored?.body as Buffer), working.contentBox),
      1,
    );
    expect(await readJob(base.db, job.id)).toMatchObject({
      state: 'succeeded',
      failureCodes: null,
    });
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('refuses a relight darker than its base without asking the judge, and delivers the base', async () => {
    const editor = recordingEditor(async (request, input, options) => {
      const outcome = await base.providers.fixtures.imageEditor.edit(request, input, options);
      if (outcome.status !== 'completed') return outcome;
      const darker = await sharp(outcome.image).modulate({ brightness: 0.6 }).jpeg().toBuffer();
      return { ...outcome, image: darker };
    });
    const vision = judgingVision((input, inner, options) => inner.judge(input, options));
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const { job, projectId } = await brightJob(deps, 'hallway');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts[1]?.outcome).toBe('qa_rejected');
    // The base's judge ran; the darker relight was rejected by the deterministic check alone.
    expect(vision.judged.map((input) => input.mode ?? 'decorate')).toEqual(['decorate']);
    const relightJudge = await base.db
      .selectFrom('judgeResults')
      .selectAll()
      .where('attemptId', '=', attempts[1]?.id as string)
      .executeTakeFirstOrThrow();
    expect(relightJudge).toMatchObject({
      modelId: 'deterministic-checks',
      decision: 'reject',
      majorCodes: ['lighting_implausible'],
    });
    expect(
      (relightJudge.deterministicChecks as { brightness: { passed: boolean } }).brightness.passed,
    ).toBe(false);
    expect(attempts[0]?.fallback).toMatchObject({
      kind: 'relight_fallback',
      reason: 'relight_rejected',
      codes: ['lighting_implausible'],
    });
    expect((await assetsOf(projectId)).map((a) => a.fidelityMode)).toEqual(['composite_additive']);
  });

  it('delivers the decorated base when the relight edit fails', async () => {
    const editor = recordingEditor(async (_request, _input, options) => {
      const operationId = `stub:${options.attemptId}`;
      await options.onOperation?.(operationId);
      return {
        status: 'failed',
        operationId,
        kind: 'provider_error',
        providerCode: 'server_error',
        httpStatus: 500,
        retryable: false,
      };
    });
    const deps = depsWith({ imageEditor: editor.editor });
    const { job, projectId } = await brightJob(deps, 'hallway');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([
      [1, 'succeeded'],
      [2, 'provider_error'],
    ]);
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'bright',
      reason: 'relight_failed',
      deliveredAs: 'result',
      relightAttemptId: attempts[1]?.id,
      codes: [],
      failureKind: 'provider_error',
    });
    expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
      ['bright', 'composite_additive'],
    ]);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('holds the decorated base for pre-delivery review and publishes it on approval', async () => {
    const vision = judgingVision((input, inner, options) =>
      input.mode === 'relight'
        ? rejecting(input, inner, { code: 'structure_changed' }, options)
        : inner.judge(input, options),
    );
    const deps = depsWith({ vision: vision.vision });
    const { job, projectId } = await brightJob(deps, 'hallway', { reviewMode: 'pre_delivery' });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    expect(await assetsOf(projectId)).toEqual([]);
    const attempts = await attemptsOf(job.id);
    expect(attempts[0]?.candidateObjectKey).toBe(
      `attempts/${job.id}/${attempts[0]?.id}/held-delivered.jpg`,
    );
    const ownerId = (
      await base.db
        .insertInto('owners')
        .values({ id: newId(), kind: 'user' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const reviewer = await base.db
      .insertInto('users')
      .values({
        id: newId(),
        ownerId,
        emailNormalized: `reviewer-${ownerId}@example.com`,
        roles: ['reviewer'],
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const asset = await approveReview(deps, { jobId: job.id, reviewerUserId: reviewer.id });
    expect(asset).toMatchObject({
      jobId: job.id,
      lightingMode: 'bright',
      fidelityMode: 'composite_additive',
    });
    expect(await readJob(base.db, job.id)).toMatchObject({ state: 'succeeded' });
  });
});

describe('a rejected base is repaired once', () => {
  it('bright: a repaired base that fails too rejects the job', async () => {
    const vision = judgingVision((input, inner, options) =>
      rejecting(input, inner, { code: 'structure_changed' }, options),
    );
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const { job, projectId } = await brightJob(deps, 'hallway');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(await readJob(base.db, job.id)).toMatchObject({
      rejectionReason: 'qa_critical',
      failureCodes: ['structure_changed'],
      attemptCount: 2,
    });
    expect(editor.requests.every((request) => (request.kind ?? 'decorate') === 'decorate')).toBe(
      true,
    );
    expect(await assetsOf(projectId)).toEqual([]);
    expect(await openReservationIds(job.id)).toEqual([]);
  });
});
