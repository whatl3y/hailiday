import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLavishPlan, type DecorationPlan, type JudgeResult } from '@hailiday/core';
import type {
  CallOptions,
  ImageEditor,
  JudgeInput,
  Providers,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { runRenderJob } from './job.js';
import { readJob } from './transitions.js';

const SHOWCASE = 'ChIJfxLanternHillColonial01';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

/** The shared test dependencies with the fixture editor and vision model replaced. */
function depsWith(editor: ImageEditor, vision: VisionModel): PipelineDeps {
  const providers: Providers = {
    ...base.providers,
    fixtures: { ...base.providers.fixtures, imageEditor: editor, vision },
  };
  return { ...base, providers };
}

/** The output shifted by 12 px under strong noise: a transform in range with a poor fit. */
async function noisyShift(image: Uint8Array): Promise<Buffer> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const out = Buffer.alloc(data.length);
  let seed = 5;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      const noise = (seed / 0x7fffffff - 0.5) * 160;
      const sx = Math.max(0, x - 12);
      for (let c = 0; c < 3; c += 1) {
        const v = (data[(y * width + sx) * 3 + c] as number) + noise;
        out[(y * width + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** The fixture editor with every decorate output shifted under noise (`noisyShift`). */
function shiftingEditor(): ImageEditor {
  const inner = base.providers.fixtures.imageEditor;
  return {
    providerId: inner.providerId,
    mode: inner.mode,
    capabilities: inner.capabilities,
    async edit(request, input, options) {
      const outcome = await inner.edit(request, input, options);
      if (outcome.status !== 'completed' || (request.kind ?? 'decorate') !== 'decorate') {
        return outcome;
      }
      return { ...outcome, image: await noisyShift(outcome.image) };
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
}

/** The findings the judge reports on a decorate attempt, by the attempt number of its plan. */
type Findings = (attemptNumber: number) => Partial<Pick<JudgeResult, 'critical' | 'major'>>;

/** The judge doubts the camera (`camera_changed` at 0.55, between the uncertainty floor and the critical threshold). */
const cameraDoubted: Findings = () => ({
  critical: [{ code: 'camera_changed', confidence: 0.55, evidence: 'The framing looks shifted.' }],
});

/**
 * The fixture vision model; with `doubtCamera`, the judge of a decorate attempt doubts the camera
 * (`cameraDoubted`), or reports the findings it gives.
 */
function visionWith(doubtCamera: boolean | Findings) {
  const inner = base.providers.fixtures.vision;
  const judgeInputs: JudgeInput[] = [];
  const findings = doubtCamera === true ? cameraDoubted : doubtCamera;
  const judge = async (
    input: JudgeInput,
    options?: CallOptions,
  ): Promise<VisionCallResult<JudgeResult>> => {
    judgeInputs.push(input);
    const result = await inner.judge(input, options);
    if (!findings || input.mode === 'relight') return result;
    return {
      ...result,
      result: { ...result.result, ...findings(input.plan.attemptNumber) },
    };
  };
  const vision: VisionModel = {
    providerId: inner.providerId,
    mode: inner.mode,
    classifyUpload: (input, options) => inner.classifyUpload(input, options),
    analyzeScene: (input, options) => inner.analyzeScene(input, options),
    judge,
    localizeAdditions: (input, options) => inner.localizeAdditions(input, options),
    judgeEnhancement: (input, options) => inner.judgeEnhancement(input, options),
    locateHome: (input, options) => inner.locateHome(input, options),
  };
  return { vision, judgeInputs };
}

/** Runs a Street View job of `style` whose editor shifts every decorate output. */
async function runShifted(style: 'abundant' | 'classic', doubtCamera: boolean | Findings) {
  const { vision, judgeInputs } = visionWith(doubtCamera);
  const deps = depsWith(shiftingEditor(), vision);
  const { ownerId, projectId, source } = await createStreetViewSource(deps, {
    placeId: SHOWCASE,
    streetViewMode: 'transient',
  });
  const job = await createRenderJobRecord(deps, { ownerId, projectId, source, style });
  const result = await runRenderJob(deps, { renderJobId: job.id });
  const attempts = await base.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', job.id)
    .orderBy('attemptNo')
    .execute();
  const plans = await base.db
    .selectFrom('decorationPlans')
    .select('document')
    .where('jobId', '=', job.id)
    .orderBy('attemptNo')
    .execute();
  const judgeRows = await base.db
    .selectFrom('judgeResults')
    .selectAll()
    .where(
      'attemptId',
      'in',
      attempts.map((attempt) => attempt.id),
    )
    .execute();
  const assets = await base.db
    .selectFrom('renderAssets')
    .select(['id', 'lightingMode'])
    .where('jobId', '=', job.id)
    .where('deletedAt', 'is', null)
    .execute();
  return {
    result,
    stored: await readJob(base.db, job.id),
    attempts,
    lavish: plans.map((row) => isLavishPlan(row.document as unknown as DecorationPlan)),
    judgeRows,
    assets,
    judgeInputs,
  };
}

describe('a lavish attempt whose registration ignored a poor fit', () => {
  it('is not delivered with a doubted camera; its repair is the ordinary look, which the poor fit rejects', async () => {
    const run = await runShifted('abundant', true);
    // The doubted camera is a critical finding: the repair is planned without the mark.
    expect(run.lavish).toEqual([true, false]);
    expect(run.attempts.map((attempt) => attempt.registrationTransform)).toEqual([
      expect.objectContaining({ accepted: true, applied: false, reason: 'poor_fit_ignored' }),
      expect.objectContaining({ accepted: false, reason: 'poor_fit' }),
    ]);
    // The judge doubted the camera of the lavish attempt, which was not delivered but repaired;
    // the ordinary repair failed the registration and never reached the judge.
    const rowsOf = (index: number) =>
      run.judgeRows.filter((row) => row.attemptId === run.attempts[index]?.id);
    expect(rowsOf(0).length).toBeGreaterThan(0);
    for (const row of rowsOf(0)) {
      expect(row).toMatchObject({ decision: 'uncertain', criticalCodes: ['camera_changed'] });
    }
    expect(rowsOf(1)).toEqual([
      expect.objectContaining({
        modelId: 'deterministic-checks',
        criticalCodes: ['camera_changed'],
      }),
    ]);
    expect(run.judgeInputs.length).toBeGreaterThan(0);
    for (const input of run.judgeInputs) {
      expect(input.plan.attemptNumber).toBe(1);
      expect(input.hints).toContain('camera_changed');
    }
    expect(run.attempts.map((attempt) => [attempt.isRepair, attempt.outcome])).toEqual([
      [false, 'qa_rejected'],
      [true, 'qa_rejected'],
    ]);
    expect(run.result.state).toBe('rejected');
    expect(run.stored).toMatchObject({
      state: 'rejected',
      rejectionReason: 'qa_critical',
      failureCodes: ['camera_changed'],
      repairUsed: true,
    });
    expect(run.assets).toEqual([]);
  });

  it('is delivered unwarped when the judge does not doubt the camera', async () => {
    const run = await runShifted('abundant', false);
    expect(run.lavish[0]).toBe(true);
    expect(run.attempts[0]?.registrationTransform).toMatchObject({
      accepted: true,
      applied: false,
      reason: 'poor_fit_ignored',
    });
    expect(run.result.state).toBe('succeeded');
    expect(run.attempts.map((attempt) => attempt.outcome)).toContain('succeeded');
    expect(run.assets).toHaveLength(1);
  });

  it('is not delivered with a doubted camera after a lavish repair: the attempt kept through the repair is', async () => {
    // The first attempt is rejected for a major finding without a box, so its repair is lavish
    // too; the repair, taken unwarped as well, is doubted for its camera with no repair after it.
    const run = await runShifted('abundant', (attemptNumber) =>
      attemptNumber === 1
        ? {
            major: [
              { code: 'unrequested_change', confidence: 0.8, evidence: 'A wall was repainted.' },
            ],
          }
        : cameraDoubted(attemptNumber),
    );
    expect(run.lavish).toEqual([true, true]);
    expect(run.attempts.map((attempt) => attempt.registrationTransform)).toEqual([
      expect.objectContaining({ accepted: true, applied: false, reason: 'poor_fit_ignored' }),
      expect.objectContaining({ accepted: true, applied: false, reason: 'poor_fit_ignored' }),
    ]);
    const rowsOf = (index: number) =>
      run.judgeRows.filter((row) => row.attemptId === run.attempts[index]?.id);
    expect(rowsOf(1).length).toBeGreaterThan(0);
    for (const row of rowsOf(1)) {
      expect(row).toMatchObject({ decision: 'uncertain', criticalCodes: ['camera_changed'] });
    }
    expect(run.attempts.map((attempt) => [attempt.isRepair, attempt.outcome])).toEqual([
      [false, 'succeeded'],
      [true, 'qa_rejected'],
    ]);
    expect(run.result.state).toBe('succeeded');
    expect(run.stored).toMatchObject({ state: 'succeeded', repairUsed: true });
    expect(run.assets).toHaveLength(1);
  });

  it('leaves any other attempt as it was: a poor fit fails camera_changed', async () => {
    const run = await runShifted('classic', true);
    expect(run.lavish).toEqual([false, false]);
    expect(run.attempts.map((attempt) => attempt.registrationTransform)).toEqual([
      expect.objectContaining({ accepted: false, reason: 'poor_fit' }),
      expect.objectContaining({ accepted: false, reason: 'poor_fit' }),
    ]);
    for (const row of run.judgeRows) {
      expect(row).toMatchObject({
        modelId: 'deterministic-checks',
        criticalCodes: ['camera_changed'],
      });
    }
    expect(run.judgeInputs).toEqual([]);
    expect(run.stored).toMatchObject({
      state: 'rejected',
      rejectionReason: 'qa_critical',
      failureCodes: ['camera_changed'],
    });
    expect(run.assets).toEqual([]);
  });
});
