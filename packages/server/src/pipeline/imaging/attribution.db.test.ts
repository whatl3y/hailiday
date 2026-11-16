import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecorationPlan, NormalizedBox } from '@hailiday/core';
import { DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS } from '../../config/index.js';
import type { JudgeInput, Providers, VisionModel } from '../../providers/types.js';
import {
  judgeSystemPrompt,
  judgeUserPrompt,
  protectedSpotLines,
} from '../../providers/vision/prompts.js';
import type { PipelineDeps } from '../context.js';
import { runRenderJob } from '../render/job.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { attributionStrokes } from './attribution.js';
import { burnAttribution, lumaAt } from './attribution.testing.js';
import { decodeRaster, toRect, type PxRect, type Raster } from './raster.js';
import { prepareWorkingImage } from './working.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

interface AttributionRecord {
  passed: boolean;
  regions: {
    mode: string;
    share: number;
    passed: boolean;
    strokeDifference: { mean: number; closeShare: number; pixels: number } | null;
  }[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** Lumas of a rectangle, or of the ring `width` pixels around it (inside the frame). */
function lumas(raster: Raster, rect: PxRect, ring = 0): number[] {
  const values: number[] = [];
  for (let y = Math.max(0, rect.y0 - ring); y < Math.min(raster.height, rect.y1 + ring); y += 1) {
    for (let x = Math.max(0, rect.x0 - ring); x < Math.min(raster.width, rect.x1 + ring); x += 1) {
      const inside = x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
      if (ring > 0 ? !inside : inside) values.push(lumaAt(raster, x, y));
    }
  }
  return values;
}

describe('the attribution of an evening look of a Street View frame', () => {
  it('is delivered with the strokes of the base kept over a relit ground', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    expect(await runRenderJob(deps, { renderJobId: job.id })).toEqual({
      state: 'succeeded',
      stopped: false,
    });

    // Attempt 1 rendered the daylight base, attempt 2 relit it.
    const attempts = await deps.db
      .selectFrom('renderAttempts')
      .select(['id', 'attemptNo', 'outcome', 'fidelityMode'])
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'composite_additive'],
      [2, 'succeeded', 'global_relight'],
    ]);
    const checksOf = async (attemptId: string) => {
      const row = await deps.db
        .selectFrom('judgeResults')
        .select('deterministicChecks')
        .where('attemptId', '=', attemptId)
        .where('escalated', '=', false)
        .executeTakeFirstOrThrow();
      return row.deterministicChecks as {
        attribution: unknown;
        compositing: { attribution: { mode: string; gain: number[] | null }[] };
      };
    };

    // The daylight base: restored verbatim and compared by SSIM.
    const base = await checksOf(attempts[0]!.id);
    expect(base.attribution).toMatchObject({ passed: true, ssim: 1 });
    expect(base.compositing.attribution.map((entry) => entry.mode)).toEqual(['verbatim']);

    // The relight: strokes kept, ground relit by the measured (darkening) gain.
    const relit = await checksOf(attempts[1]!.id);
    const record = relit.attribution as AttributionRecord;
    expect(record.passed).toBe(true);
    expect(record.regions.length).toBeGreaterThan(0);
    for (const region of record.regions) {
      expect(region).toMatchObject({ mode: 'adapted', passed: true });
      expect(region.strokeDifference).toMatchObject({ mean: 0, closeShare: 1 });
      expect(region.strokeDifference?.pixels).toBeGreaterThan(100);
    }
    for (const entry of relit.compositing.attribution) {
      expect(entry.mode).toBe('adapted');
      for (const gain of entry.gain ?? []) expect(gain).toBeLessThan(0.5);
    }

    // The delivered evening image: no pale patch where the attribution sits, strokes still bright.
    const plan = await deps.db
      .selectFrom('decorationPlans')
      .select('document')
      .where('jobId', '=', job.id)
      .orderBy('attemptNo', 'desc')
      .executeTakeFirstOrThrow();
    const preserve = (plan.document as { preserve: { attributionRegions?: NormalizedBox[] } })
      .preserve;
    const boxes = preserve.attributionRegions ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    const asset = await deps.db
      .selectFrom('renderAssets')
      .select('objectKey')
      .where('jobId', '=', job.id)
      .where('lightingMode', '=', 'evening')
      .executeTakeFirstOrThrow();
    const object = await deps.storage.get('private', asset.objectKey);
    const delivered = await decodeRaster(
      await sharp(object?.body as Buffer)
        .resize(1024, 1024, { fit: 'fill' })
        .png()
        .toBuffer(),
    );
    for (const box of boxes) {
      const rect = toRect(box, delivered.width, delivered.height);
      const inside = lumas(delivered, rect);
      const ring = lumas(delivered, rect, Math.round(0.03 * delivered.width));
      expect(Math.abs(median(inside) - median(ring))).toBeLessThan(0.1);
      const sorted = [...inside].sort((a, b) => a - b);
      expect(sorted[Math.floor(sorted.length * 0.99)]).toBeGreaterThan(median(ring) + 0.3);
    }
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const HOUSE = path.join(here, '../../../content/photos/houses/house-01-colonial-spring.jpg');
const FRAME_BOXES = DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS['640x640'] as readonly NormalizedBox[];

/**
 * A photograph of a house as an uploaded Street View Static frame: drawn at 1024 with the
 * synthetic logo and copyright label (or without them), saved as a 640x640 JPEG.
 */
async function houseFrame(marks: boolean): Promise<Buffer> {
  const { data, info } = await sharp(HOUSE)
    .resize(1024, 1024, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ground: Raster = { data, width: info.width, height: info.height };
  const raster = marks ? burnAttribution(ground).base : ground;
  return sharp(raster.data, { raw: { width: 1024, height: 1024, channels: 3 } })
    .resize(640, 640, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** The shared dependencies with the fixture judge recording its inputs. */
function recordingJudge(): { deps: PipelineDeps; judged: JudgeInput[] } {
  const inner = deps.providers.fixtures.vision;
  const judged: JudgeInput[] = [];
  const vision: VisionModel = {
    ...inner,
    async judge(input, options) {
      judged.push(input);
      return inner.judge(input, options);
    },
  };
  const providers: Providers = {
    ...deps.providers,
    fixtures: { ...deps.providers.fixtures, vision },
  };
  return { deps: { ...deps, providers }, judged };
}

async function eveningUpload(image: Buffer) {
  const recording = recordingJudge();
  const { ownerId, projectId, source } = await createUploadSource(recording.deps, {
    image,
    fileName: 'front-porch.jpg',
  });
  const job = await createRenderJobRecord(recording.deps, {
    ownerId,
    projectId,
    source,
    lightingMode: 'evening',
  });
  expect(await runRenderJob(recording.deps, { renderJobId: job.id })).toEqual({
    state: 'succeeded',
    stopped: false,
  });
  const attempts = await deps.db
    .selectFrom('renderAttempts')
    .select(['id', 'attemptNo', 'outcome', 'fidelityMode'])
    .where('jobId', '=', job.id)
    .orderBy('attemptNo')
    .execute();
  const plans = await deps.db
    .selectFrom('decorationPlans')
    .select(['attemptNo', 'document'])
    .where('jobId', '=', job.id)
    .orderBy('attemptNo')
    .execute();
  const checks = await deps.db
    .selectFrom('judgeResults')
    .select(['attemptId', 'deterministicChecks'])
    .where('escalated', '=', false)
    .where(
      'attemptId',
      'in',
      attempts.map((a) => a.id),
    )
    .execute();
  const asset = await deps.db
    .selectFrom('renderAssets')
    .select(['objectKey', 'lightingMode', 'fidelityMode'])
    .where('jobId', '=', job.id)
    .executeTakeFirstOrThrow();
  return { job, source, attempts, plans, checks, asset, judged: recording.judged };
}

/** Over the solid stroke pixels of a rectangle of `reference`: the mean absolute difference. */
function strokeDifference(reference: Raster, other: Raster, box: NormalizedBox) {
  const { rect, keep } = attributionStrokes(reference, box);
  const rw = rect.x1 - rect.x0;
  let pixels = 0;
  let total = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      if (
        (keep[(y - rect.y0) * rw + (x - rect.x0)] as number) <
        PIPELINE_DEFAULTS.attributionRelight.solidKeep
      ) {
        continue;
      }
      const p = (y * reference.width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        total += Math.abs((reference.data[p + c] as number) - (other.data[p + c] as number));
      }
      pixels += 1;
    }
  }
  return { pixels, mean: pixels > 0 ? total / (pixels * 3) : 0 };
}

/** A stored JPEG decoded on the 1024 working grid. */
async function storedRaster(key: string): Promise<Raster> {
  const object = await deps.storage.get('private', key);
  return decodeRaster(
    await sharp(object?.body as Buffer)
      .resize(1024, 1024, { fit: 'fill' })
      .png()
      .toBuffer(),
  );
}

type RecordedChecks = {
  attribution?: AttributionRecord;
  compositing: { attribution: { mode: string }[] };
};

describe('an uploaded Street View Static frame', () => {
  it('keeps both marks through an evening look, as a Street View source does', async () => {
    const image = await houseFrame(true);
    const run = await eveningUpload(image);
    // The source stays an upload.
    expect(run.source.kind).toBe('upload');
    expect(run.attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'composite_additive'],
      [2, 'succeeded', 'global_relight'],
    ]);
    expect(run.asset).toMatchObject({ lightingMode: 'evening', fidelityMode: 'global_relight' });

    // The rectangles of a 640x640 Street View source, in the plans of both attempts.
    for (const plan of run.plans) {
      expect((plan.document as DecorationPlan).preserve.attributionRegions).toEqual(FRAME_BOXES);
    }
    const checksOf = (attemptId: string) =>
      run.checks.find((row) => row.attemptId === attemptId)?.deterministicChecks as RecordedChecks;
    // The daylight base: restored verbatim and compared by SSIM.
    const daylight = checksOf(run.attempts[0]!.id);
    expect(daylight.attribution).toMatchObject({ passed: true, ssim: 1 });
    expect(daylight.compositing.attribution.map((entry) => entry.mode)).toEqual([
      'verbatim',
      'verbatim',
    ]);
    // The relight: both marks' strokes found and kept over the relit ground.
    const relit = checksOf(run.attempts[1]!.id);
    expect(relit.attribution?.passed).toBe(true);
    expect(relit.attribution?.regions).toHaveLength(2);
    for (const region of relit.attribution?.regions ?? []) {
      expect(region).toMatchObject({ mode: 'adapted', passed: true });
      expect(region.strokeDifference).toMatchObject({ mean: 0, closeShare: 1 });
      expect(region.strokeDifference?.pixels).toBeGreaterThan(100);
    }
    expect(relit.compositing.attribution.map((entry) => entry.mode)).toEqual([
      'adapted',
      'adapted',
    ]);

    // The judge is told what it is told for a Street View source: both rectangles, as the
    // provider's logo and copyright text that must stay.
    const relightJudge = run.judged.find((input) => input.mode === 'relight');
    expect(relightJudge?.plan.preserve.attributionRegions).toEqual(FRAME_BOXES);
    const prompt = judgeUserPrompt(relightJudge!.plan, relightJudge!.hints ?? [], {
      mode: 'relight',
    });
    const attributionLines = protectedSpotLines(
      {
        ...relightJudge!.plan.preserve,
        regions: [],
        protectedBlurRegions: [],
        peopleBoxes: [],
        accessRegions: [],
        attributionRegions: [...FRAME_BOXES],
      },
      'relight',
    );
    expect(attributionLines).toHaveLength(2);
    for (const line of attributionLines) {
      expect(line).toContain("the map provider's logo and copyright text here must stay");
      expect(prompt).toContain(line);
    }
    expect(judgeSystemPrompt('relight')).toContain('attribution_altered');

    // The delivered evening picture: the strokes are the original's pixels (to the JPEG's
    // precision) and still bright over the darker ground; the relit output had lost them.
    const working = (await prepareWorkingImage(image, 'upload')).raster;
    const delivered = await storedRaster(run.asset.objectKey);
    const rawKey = (
      await deps.db
        .selectFrom('renderAttempts')
        .select('candidateObjectKey')
        .where('id', '=', run.attempts[1]!.id)
        .executeTakeFirstOrThrow()
    ).candidateObjectKey;
    const raw = await storedRaster(rawKey as string);
    for (const box of FRAME_BOXES) {
      const kept = strokeDifference(working, delivered, box);
      expect(kept.pixels).toBeGreaterThan(100);
      expect(kept.mean).toBeLessThan(8);
      const rect = toRect(box, delivered.width, delivered.height);
      const inside = lumas(delivered, rect);
      const ring = lumas(delivered, rect, Math.round(0.03 * delivered.width));
      expect(Math.abs(median(inside) - median(ring))).toBeLessThan(0.1);
      const sorted = [...inside].sort((a, b) => a - b);
      expect(sorted[Math.floor(sorted.length * 0.99)]).toBeGreaterThan(median(ring) + 0.3);
    }
    // The fixture editor keeps the first rectangle as it is and relights the label with the rest.
    expect(strokeDifference(working, raw, FRAME_BOXES[1]!).mean).toBeGreaterThan(30);
  });

  it('without the marks stays a plain upload: no rectangles anywhere', async () => {
    const run = await eveningUpload(await houseFrame(false));
    expect(run.attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'composite_additive'],
      [2, 'succeeded', 'global_relight'],
    ]);
    for (const plan of run.plans) {
      const preserve = (plan.document as DecorationPlan).preserve;
      expect(preserve.attributionRegions).toBeUndefined();
      expect(preserve.attributionRegion).toBeUndefined();
    }
    for (const row of run.checks) {
      const checks = row.deterministicChecks as RecordedChecks;
      expect(checks.attribution).toBeUndefined();
      expect(checks.compositing.attribution).toEqual([]);
    }
    for (const input of run.judged) {
      expect(input.plan.preserve.attributionRegions).toBeUndefined();
      expect(
        judgeUserPrompt(input.plan, input.hints ?? [], { mode: input.mode ?? 'decorate' }),
      ).not.toContain('burned-in imagery attribution');
    }
  });
});
