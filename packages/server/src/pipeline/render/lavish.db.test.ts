import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isCriticalFailureCode,
  isLavishPlan,
  type DecorationPlan,
  type JudgeResult,
  type NormalizedBox,
  type RoomType,
  type SceneAnalysis,
  type SceneType,
} from '@hailiday/core';
import type { AppConfig } from '../../config/index.js';
import { loadContent } from '../../content/load.js';
import { toJson } from '../../db/client.js';
import { ProviderError } from '../../providers/errors.js';
import type {
  CallOptions,
  ImageEditor,
  JudgeInput,
  Providers,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import { sha256Hex } from '../../ids/index.js';
import type { PipelineDeps } from '../context.js';
import { LAVISH_ADDED, LAVISH_RELIGHT_DECORATIONS, stableJson } from '../compile/compiler.js';
import { protectedRestoreLevel } from '../imaging/checks.js';
import { toRect } from '../imaging/raster.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { JobAborted } from './errors.js';
import { runRenderJob } from './job.js';
import { decorationsLeft, enoughDecorationsLeft, restoredAreas } from './last-resort.js';
import { readJob } from './transitions.js';

const SHOWCASE = 'ChIJfxLanternHillColonial01';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

interface Overrides {
  fixtureImageEditor?: ImageEditor;
  fixtureVision?: VisionModel;
  imageEdit?: Partial<AppConfig['imageEdit']>;
}

/** The shared test dependencies with per-test providers layered on top. */
function depsWith(o: Overrides): PipelineDeps {
  const providers: Providers = {
    ...base.providers,
    fixtures: {
      ...base.providers.fixtures,
      ...(o.fixtureImageEditor ? { imageEditor: o.fixtureImageEditor } : {}),
      ...(o.fixtureVision ? { vision: o.fixtureVision } : {}),
    },
  };
  const config: AppConfig = {
    ...base.config,
    ...(o.imageEdit ? { imageEdit: { ...base.config.imageEdit, ...o.imageEdit } } : {}),
  };
  return { ...base, providers, config };
}

interface EditCall {
  kind: string;
  /** The input image bytes the provider was given. */
  image: Uint8Array;
  mask: boolean;
  instructionText: string;
  hasRequestMask: boolean;
}

/**
 * Wraps the fixture editor, recording every call; `after` may change a completed output
 * (`kind` is `decorate` or `relight`, `call` counts the calls of that kind from 0).
 */
function recordingEditor(
  after?: (
    image: Uint8Array,
    context: { kind: string; call: number; fixture: Parameters<ImageEditor['edit']>[1]['fixture'] },
  ) => Promise<Uint8Array>,
) {
  const inner = base.providers.fixtures.imageEditor;
  const calls: EditCall[] = [];
  const editor: ImageEditor = {
    providerId: inner.providerId,
    mode: inner.mode,
    capabilities: inner.capabilities,
    async edit(request, input, options) {
      const kind = request.kind ?? 'decorate';
      const call = calls.filter((entry) => entry.kind === kind).length;
      calls.push({
        kind,
        image: input.image,
        mask: input.mask !== undefined,
        instructionText: request.instructionText,
        hasRequestMask: request.mask !== undefined,
      });
      const outcome = await inner.edit(request, input, options);
      if (outcome.status !== 'completed' || !after) return outcome;
      return {
        ...outcome,
        image: await after(outcome.image, { kind, call, fixture: input.fixture }),
      };
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
  return { editor, calls };
}

/** Wraps the fixture vision model, counting calls; any call can be replaced. */
function countingVision(
  patch: {
    analyze?: (analysis: SceneAnalysis) => SceneAnalysis;
    judge?: (input: JudgeInput, options?: CallOptions) => Promise<VisionCallResult<JudgeResult>>;
    localize?: VisionModel['localizeAdditions'];
  } = {},
) {
  const inner = base.providers.fixtures.vision;
  const calls = { analyze: 0, judge: 0, localize: 0 };
  const judgeInputs: JudgeInput[] = [];
  const vision: VisionModel = {
    providerId: inner.providerId,
    mode: inner.mode,
    classifyUpload: (input, options) => inner.classifyUpload(input, options),
    async analyzeScene(input, options) {
      calls.analyze += 1;
      const result = await inner.analyzeScene(input, options);
      return patch.analyze ? { ...result, result: patch.analyze(result.result) } : result;
    },
    async judge(input, options) {
      calls.judge += 1;
      judgeInputs.push(input);
      return patch.judge ? patch.judge(input, options) : inner.judge(input, options);
    },
    async localizeAdditions(input, options) {
      calls.localize += 1;
      return patch.localize
        ? patch.localize(input, options)
        : inner.localizeAdditions(input, options);
    },
    judgeEnhancement: (input, options) => inner.judgeEnhancement(input, options),
    locateHome: (input, options) => inner.locateHome(input, options),
  };
  return { vision, calls, judgeInputs };
}

async function attemptsOf(jobId: string) {
  return base.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
}

async function plansOf(jobId: string): Promise<DecorationPlan[]> {
  const rows = await base.db
    .selectFrom('decorationPlans')
    .select('document')
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
  return rows.map((row) => row.document as unknown as DecorationPlan);
}

async function judgeRowsOf(attemptId: string) {
  return base.db
    .selectFrom('judgeResults')
    .selectAll()
    .where('attemptId', '=', attemptId)
    .orderBy('escalated')
    .execute();
}

/** The job's ledger lines. */
async function ledgerOf(jobId: string) {
  return base.db.selectFrom('usageLedger').selectAll().where('jobId', '=', jobId).execute();
}

/** The job's reservations that no settlement, charge or release followed, as `sku/stage`. */
async function openReservationsOf(jobId: string) {
  const rows = await ledgerOf(jobId);
  return rows
    .filter((row) => row.kind === 'reservation')
    .filter((row) => !rows.some((other) => other.reservationId === row.id))
    .map((row) => `${row.sku}/${row.stage}`);
}

/**
 * A job that made no localization call: no settlement or charge of stage `localizing`, each of its
 * reserved localizations closed by one release and nothing else, and no reservation left open.
 */
async function expectNoLocalizationPaid(jobId: string) {
  const rows = await ledgerOf(jobId);
  expect(
    rows.filter(
      (row) => row.stage === 'localizing' && (row.kind === 'settlement' || row.kind === 'charge'),
    ),
  ).toEqual([]);
  const reserved = rows.filter((row) => row.kind === 'reservation' && row.stage === 'localizing');
  expect(reserved).toHaveLength(2);
  for (const reservation of reserved) {
    expect(
      rows.filter((row) => row.reservationId === reservation.id).map((row) => row.kind),
    ).toEqual(['release']);
  }
  const open = rows
    .filter((row) => row.kind === 'reservation')
    .filter((row) => !rows.some((other) => other.reservationId === row.id));
  expect(open).toEqual([]);
}

/** Every stored plan of the job is lavish (the pack carries the section's lavish description). */
async function expectLavish(jobId: string, lavish = true) {
  const plans = await plansOf(jobId);
  expect(plans.length, 'stored plans').toBeGreaterThan(0);
  for (const plan of plans) {
    expect(
      isLavishPlan(plan),
      lavish
        ? 'the plan of an abundant Christmas house exterior is lavish (pack lavish block)'
        : 'the plan is not lavish',
    ).toBe(lavish);
  }
}

async function streetViewJob(
  deps: PipelineDeps,
  extra: Partial<Parameters<typeof createRenderJobRecord>[1]> = {},
  mode: 'transient' | 'persist' = 'transient',
) {
  const { ownerId, projectId, source } = await createStreetViewSource(deps, {
    placeId: SHOWCASE,
    streetViewMode: mode,
  });
  const job = await createRenderJobRecord(deps, {
    ownerId,
    projectId,
    source,
    style: 'abundant',
    ...extra,
  });
  return { job, ownerId, projectId, source };
}

/** The delivered image of a job (its render asset). */
async function deliveredOf(jobId: string): Promise<Buffer> {
  const asset = await base.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('jobId', '=', jobId)
    .where('deletedAt', 'is', null)
    .executeTakeFirstOrThrow();
  return (await base.storage.get('private', asset.objectKey))?.body as Buffer;
}

/** Raw RGB pixels of an encoded image with its size. */
async function rgb(bytes: Uint8Array) {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** A box of `size` (normalized) clear of every placement region and `avoid` box by `margin`. */
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

/** Paints solid squares onto an encoded image (normalized boxes). */
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
            width: Math.max(1, Math.round((box[2] - box[0]) * w)),
            height: Math.max(1, Math.round((box[3] - box[1]) * h)),
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

/** Mean color of the middle half of a normalized box in an encoded image. */
async function meanColor(bytes: Uint8Array, box: NormalizedBox): Promise<[number, number, number]> {
  const { data, width, height } = await rgb(bytes);
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  const x0 = Math.round((box[0] + bw * 0.25) * width);
  const x1 = Math.round((box[2] - bw * 0.25) * width);
  const y0 = Math.round((box[1] + bh * 0.25) * height);
  const y1 = Math.round((box[3] - bh * 0.25) * height);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      for (let c = 0; c < 3; c += 1)
        sum[c] = (sum[c] as number) + (data[(y * width + x) * 3 + c] as number);
      n += 1;
    }
  }
  return sum.map((value) => value / Math.max(1, n)) as [number, number, number];
}

const BLUE: [number, number, number] = [20, 40, 220];
const isBlue = (color: [number, number, number]) => color[2] - color[0] > 120;

/**
 * An editor that turns a spot outside every placement region blue (a change nobody reports);
 * `spot.box` is chosen on the first output, clear of the preserve regions too unless
 * `overPreserved` is set.
 */
function blueSpotEditor(
  spot: { box?: NormalizedBox },
  more?: Parameters<typeof recordingEditor>[0],
  overPreserved = false,
) {
  return recordingEditor(async (image, context) => {
    let out = image;
    if (context.kind === 'decorate') {
      const placements = context.fixture?.placements ?? [];
      const avoid = [
        ...(context.fixture?.attributionRegion ? [context.fixture.attributionRegion] : []),
        ...(overPreserved ? [] : (context.fixture?.preserveRegions ?? [])),
      ];
      spot.box ??= clearBox(placements, avoid, 0.08, 0.07);
      out = await paint(out, [{ box: spot.box, color: BLUE }]);
    }
    return more ? more(out, context) : out;
  });
}

describe('the kept area of a lavish decorate attempt', () => {
  it("keeps the editor's whole picture without asking the localizer: a change nobody reported stays", async () => {
    const run = async (style: 'abundant' | 'classic') => {
      const spot: { box?: NormalizedBox } = {};
      const editor = blueSpotEditor(spot);
      const vision = countingVision();
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { style });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      const [attempt] = await attemptsOf(job.id);
      const blue = isBlue(await meanColor(await deliveredOf(job.id), spot.box as NormalizedBox));
      return { job, vision, attempt, blue };
    };
    const lavish = await run('abundant');
    await expectLavish(lavish.job.id);
    expect(lavish.vision.calls.localize).toBe(0);
    expect(lavish.blue).toBe(true);
    const record = lavish.attempt?.compositeMask as {
      keep?: { area: string; coverage: number; featherPx: number };
      protectedBoxes?: unknown;
    };
    expect(record.keep).toMatchObject({ area: 'whole_frame', featherPx: expect.any(Number) });
    expect(record.keep).not.toHaveProperty('vehicles');
    expect(record).not.toHaveProperty('localization');
    expect(record.protectedBoxes).toBeDefined();
    expect(record.keep?.coverage).toBeGreaterThan(0.5);
    expect(lavish.attempt?.fidelityMode).toBe('composite_additive');
    // The two reserved localizations are released with the job's other unused reservations.
    await expectNoLocalizationPaid(lavish.job.id);

    // A plan without the mark still localizes, pays the call, and keeps only what was found.
    const classic = await run('classic');
    await expectLavish(classic.job.id, false);
    expect(classic.vision.calls.localize).toBe(1);
    expect(classic.blue).toBe(false);
    expect(classic.attempt?.compositeMask).toMatchObject({ localization: { status: 'localized' } });
    expect(classic.attempt?.compositeMask).not.toHaveProperty('keep');
    const settled = (await ledgerOf(classic.job.id)).filter(
      (row) => row.kind === 'settlement' && row.stage === 'localizing',
    );
    expect(settled).toHaveLength(1);
  });

  it('puts a person and a blurred area back from the original', async () => {
    const person: NormalizedBox = [0.04, 0.08, 0.14, 0.3];
    const plate: NormalizedBox = [0.84, 0.08, 0.94, 0.16];
    const MAGENTA: [number, number, number] = [250, 0, 250];
    const editor = recordingEditor(async (image, context) =>
      context.kind === 'decorate'
        ? paint(image, [
            { box: person, color: MAGENTA },
            { box: plate, color: MAGENTA },
          ])
        : image,
    );
    const vision = countingVision({
      analyze: (analysis) => ({
        ...analysis,
        peopleBoxes: [...analysis.peopleBoxes, person],
        protectedBlurRegions: [...analysis.protectedBlurRegions, { kind: 'plate', box: plate }],
      }),
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(vision.calls.analyze).toBe(1);
    await expectLavish(job.id);
    const [plan] = await plansOf(job.id);
    const touches = (a: NormalizedBox, b: NormalizedBox) =>
      a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    for (const placement of plan?.placements ?? []) {
      expect(touches(placement.region, person)).toBe(false);
      expect(touches(placement.region, plate)).toBe(false);
    }
    const delivered = await deliveredOf(job.id);
    const working = editor.calls[0]?.image as Uint8Array;
    for (const box of [person, plate]) {
      const got = await meanColor(delivered, box);
      const original = await meanColor(working, box);
      for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c] - original[c])).toBeLessThan(3);
    }
  });

  it('does not depend on the localizer: one that is down or would report 48 items is never asked', async () => {
    const failing = { box: undefined as NormalizedBox | undefined };
    const editor1 = blueSpotEditor(failing);
    const down = countingVision({
      localize: async () => {
        throw new ProviderError('fixture', 'provider_error', 'localizer down', {
          retryable: false,
        });
      },
    });
    const deps1 = depsWith({ fixtureImageEditor: editor1.editor, fixtureVision: down.vision });
    const { job: first } = await streetViewJob(deps1);
    expect((await runRenderJob(deps1, { renderJobId: first.id })).state).toBe('succeeded');
    await expectLavish(first.id);
    expect(down.calls.localize).toBe(0);
    const [failed] = await attemptsOf(first.id);
    const failedRecord = failed?.compositeMask as {
      keep?: { area: string; coverage: number };
    };
    expect(failedRecord).not.toHaveProperty('localization');
    expect(failedRecord.keep).toMatchObject({ area: 'whole_frame' });
    expect(isBlue(await meanColor(await deliveredOf(first.id), failing.box as NormalizedBox))).toBe(
      true,
    );

    // 48 unplanned items over the whole frame.
    const many = { box: undefined as NormalizedBox | undefined };
    const editor2 = blueSpotEditor(many);
    const items = Array.from({ length: 48 }, (_, i) => {
      const col = i % 8;
      const row = Math.floor(i / 8);
      return {
        label: `light ${i}`,
        box: [col / 8, row / 6, (col + 1) / 8, (row + 1) / 6] as NormalizedBox,
        placementId: null,
      };
    });
    const crowded = countingVision({
      localize: async (input, options) => {
        const planned = await base.providers.fixtures.vision.localizeAdditions(input, options);
        return { ...planned, result: { added: items, otherChanges: [] } };
      },
    });
    const deps2 = depsWith({ fixtureImageEditor: editor2.editor, fixtureVision: crowded.vision });
    const { job: second } = await streetViewJob(deps2);
    expect((await runRenderJob(deps2, { renderJobId: second.id })).state).toBe('succeeded');
    expect(crowded.calls.localize).toBe(0);
    const [attempt] = await attemptsOf(second.id);
    const record = attempt?.compositeMask as { keep?: { coverage: number } };
    expect(record).not.toHaveProperty('localization');
    expect(record.keep?.coverage).toBe(failedRecord.keep?.coverage);
    expect(isBlue(await meanColor(await deliveredOf(second.id), many.box as NormalizedBox))).toBe(
      true,
    );
    // The same whole frame was kept: the two pictures agree.
    const a = await rgb(await deliveredOf(first.id));
    const b = await rgb(await deliveredOf(second.id));
    expect(a.data.equals(b.data)).toBe(true);
  });

  it('records the edge, seam and drift checks as skipped and asks the judge', async () => {
    const editor = blueSpotEditor({});
    const deps = depsWith({ fixtureImageEditor: editor.editor });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    await expectLavish(job.id);
    const [attempt] = await attemptsOf(job.id);
    const [row] = await judgeRowsOf(attempt?.id as string);
    expect(row?.modelId).not.toBe('deterministic-checks');
    const checks = row?.deterministicChecks as Record<string, Record<string, unknown>>;
    expect(checks.drift).toEqual({ skipped: 'lavish', hint: false });
    expect(checks.edgeAgreement).toEqual({ passed: true, skipped: 'lavish' });
    expect(checks.seam).toEqual({ passed: true, skipped: 'lavish' });
    expect(checks.compositing?.photometric).toBeNull();
    // The attribution rectangles are restored and compared as a relight's.
    const restored = checks.compositing?.attribution as { mode: string }[];
    const compared = (checks.attribution as { passed: boolean; regions: { mode: string }[] })
      .regions;
    expect(restored.length).toBeGreaterThan(0);
    // The fixture frame's logo and copyright strokes are found: they keep the original's pixels
    // over the editor's ground.
    expect(restored.map((entry) => entry.mode)).toContain('adapted');
    expect(compared.map((region) => region.mode)).toEqual(restored.map((entry) => entry.mode));
    expect(checks.attribution).toMatchObject({ passed: true });
    expect(checks.protectedRegions).toMatchObject({ passed: true });
  });

  it('a moved camera still rejects a lavish attempt', async () => {
    // A square output for a wide working image: registration rejects it (`camera_changed`).
    const editor = recordingEditor(async (image, context) => {
      if (context.kind !== 'decorate') return image;
      const meta = await sharp(image).metadata();
      const side = Math.min(meta.width ?? 0, meta.height ?? 0);
      return sharp(image)
        .resize(Math.round(side * 0.6), side, { fit: 'fill' })
        .jpeg()
        .toBuffer();
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    // The lavish attempt is rejected; its repair, after a critical code, is the ordinary look,
    // which the moved camera rejects too.
    expect((await plansOf(job.id)).map((plan) => isLavishPlan(plan))).toEqual([true, false]);
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'qa_rejected'],
    ]);
    for (const attempt of attempts) {
      const [row] = await judgeRowsOf(attempt.id);
      expect(row).toMatchObject({
        modelId: 'deterministic-checks',
        criticalCodes: ['camera_changed'],
      });
    }
  });

  it('takes a lavish output with a poor registration fit unwarped and tells the judge; any other attempt fails camera_changed', async () => {
    /** The output shifted by 12 px under strong noise: a transform in range with a poor fit. */
    const noisyShift = async (image: Uint8Array) => {
      const { data, width, height } = await rgb(image);
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
    };
    const run = async (style: 'abundant' | 'classic') => {
      const editor = recordingEditor(async (image, context) =>
        context.kind === 'decorate' ? noisyShift(image) : image,
      );
      const vision = countingVision();
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { style });
      const result = await runRenderJob(deps, { renderJobId: job.id });
      const [attempt] = await attemptsOf(job.id);
      const [row] = await judgeRowsOf(attempt?.id as string);
      return { job, result, attempt, row, vision };
    };
    const lavish = await run('abundant');
    await expectLavish(lavish.job.id);
    expect(lavish.attempt?.registrationTransform).toMatchObject({
      accepted: true,
      applied: false,
      reason: 'poor_fit_ignored',
    });
    expect((lavish.attempt?.registrationTransform as { score: number }).score).toBeLessThan(0.5);
    expect(lavish.row?.modelId).not.toBe('deterministic-checks');
    expect(lavish.row?.criticalCodes ?? []).not.toContain('camera_changed');
    expect(lavish.vision.judgeInputs[0]?.hints).toContain('camera_changed');

    const plain = await run('classic');
    await expectLavish(plain.job.id, false);
    expect(plain.attempt?.registrationTransform).toMatchObject({
      accepted: false,
      reason: 'poor_fit',
    });
    expect(plain.row).toMatchObject({
      modelId: 'deterministic-checks',
      criticalCodes: ['camera_changed'],
    });
  });

  it('a lavish repair keeps the whole picture and puts the judge box back', async () => {
    // A home whose only anchor is its front door: the plan's decorations lie inside one small
    // judge box, so putting it back at once would leave too little of them, and the attempt
    // rejected for that boxed major alone is repaired with the mark instead.
    const spot: { box?: NormalizedBox } = {};
    const editor = blueSpotEditor(spot);
    const judged: { box?: NormalizedBox } = {};
    const inner = base.providers.fixtures.vision;
    let decorateJudged = 0;
    const vision = countingVision({
      analyze: (analysis) => ({
        ...analysis,
        anchors: analysis.anchors.filter((anchor) => anchor.category === 'front_door'),
      }),
      judge: async (input, options) => {
        const result = await inner.judge(input, options);
        if (input.mode === 'relight') return result;
        decorateJudged += 1;
        if (decorateJudged > 1) return result;
        const regions = input.plan.placements.map((placement) => placement.region);
        judged.box ??= [
          Math.max(0, Math.min(...regions.map((r) => r[0])) - 0.005),
          Math.max(0, Math.min(...regions.map((r) => r[1])) - 0.005),
          Math.min(1, Math.max(...regions.map((r) => r[2])) + 0.005),
          Math.min(1, Math.max(...regions.map((r) => r[3])) + 0.005),
        ];
        return {
          ...result,
          result: {
            ...result.result,
            major: [
              {
                code: 'unrequested_change',
                confidence: 0.8,
                evidence: 'The front door was repainted.',
                box: judged.box,
              },
            ],
          },
        };
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    await expectLavish(job.id);
    const box = judged.box as NormalizedBox;
    expect((box[2] - box[0]) * (box[3] - box[1])).toBeLessThanOrEqual(0.03);
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
    ]);
    expect(attempts[0]?.compositeMask).not.toHaveProperty('restored');
    expect(editor.calls[1]?.instructionText).toContain(
      'Change nothing except adding decorations: no repainting, no landscaping changes, no added snow, no removed objects.',
    );
    const repaired = attempts[1]?.compositeMask as {
      protectedBoxes?: { restoreBoxes: { box: NormalizedBox; applied: boolean }[] };
      keep?: { area: string };
    };
    expect(repaired.keep?.area).toBe('whole_frame');
    expect(repaired.protectedBoxes?.restoreBoxes).toEqual([
      expect.objectContaining({ box, applied: true }),
    ]);
    const delivered = await deliveredOf(job.id);
    expect(isBlue(await meanColor(delivered, spot.box as NormalizedBox))).toBe(true);
    const got = await meanColor(delivered, box);
    const original = await meanColor(editor.calls[1]?.image as Uint8Array, box);
    for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c] - original[c])).toBeLessThan(3);
  });

  it('a redelivered check composites the same lavish picture, with no localization on either run', async () => {
    const controller = new AbortController();
    const spot: { box?: NormalizedBox } = {};
    const editor = blueSpotEditor(spot);
    const first = countingVision({
      judge: async () => {
        // The worker stops while the judge is asked about the composite.
        controller.abort();
        throw new ProviderError('fixture', 'timeout', 'stopped', { retryable: false });
      },
    });
    const deps1 = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: first.vision });
    // A stored source keeps the raw output, which the redelivery composites again.
    const { job } = await streetViewJob(deps1, {}, 'persist');
    await expect(
      runRenderJob(deps1, { renderJobId: job.id, signal: controller.signal }),
    ).rejects.toBeInstanceOf(JobAborted);
    expect(first.calls.localize).toBe(0);
    expect(first.calls.judge).toBe(1);
    expect((await readJob(base.db, job.id))?.state).toBe('checking');
    const [stopped] = await attemptsOf(job.id);
    const written = stopped?.compositeMask as { keep?: unknown; protectedBoxes?: unknown };
    expect(written.keep).toMatchObject({ area: 'whole_frame' });
    expect(written.protectedBoxes).toBeDefined();

    const second = countingVision();
    const deps2 = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: second.vision });
    expect((await runRenderJob(deps2, { renderJobId: job.id })).state).toBe('succeeded');
    expect(second.calls.localize).toBe(0);
    await expectLavish(job.id);
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.compositeMask).toEqual(stopped?.compositeMask);
    expect(attempt?.compositeMask).not.toHaveProperty('localization');
    // The judge saw the same picture on both runs.
    const judged = (input: JudgeInput | undefined) => Buffer.from(input?.candidate.bytes ?? []);
    expect(judged(second.judgeInputs[0]).length).toBeGreaterThan(0);
    expect(judged(second.judgeInputs[0]).equals(judged(first.judgeInputs[0]))).toBe(true);
    expect(isBlue(await meanColor(await deliveredOf(job.id), spot.box as NormalizedBox))).toBe(
      true,
    );
    await expectNoLocalizationPaid(job.id);
  });

  it('a home with many decorations of its own steps down to the ordinary path', async () => {
    const spot: { box?: NormalizedBox } = {};
    const editor = blueSpotEditor(spot);
    const vision = countingVision({
      analyze: (analysis) => ({
        ...analysis,
        existingDecorations: { present: true, density: 'high', boxes: [] },
      }),
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    await expectLavish(job.id, false);
    expect(isBlue(await meanColor(await deliveredOf(job.id), spot.box as NormalizedBox))).toBe(
      false,
    );
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.compositeMask).not.toHaveProperty('keep');
    const [row] = await judgeRowsOf(attempt?.id as string);
    expect((row?.deterministicChecks as { seam: Record<string, unknown> }).seam).toHaveProperty(
      'deltaE',
    );
  });

  it('a transient Street View source is delivered with nothing stored', async () => {
    const deps = depsWith({});
    const { job } = await streetViewJob(deps, {}, 'transient');
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    await expectLavish(job.id);
    const [attempt] = await attemptsOf(job.id);
    const record = attempt?.compositeMask as Record<string, unknown>;
    expect(record).toHaveProperty('rle');
    expect(record).toHaveProperty('keep');
    expect(record).not.toHaveProperty('objectKey');
    expect(await base.storage.list('private', `working/${job.id}/`)).toEqual([]);
  });
});

describe('the relight of a lavish base', () => {
  /** Thin bright lines across the target facade, the way a dense display of lights reads. */
  const gridOver = async (
    image: Uint8Array,
    facade: NormalizedBox,
    avoid: readonly NormalizedBox[],
  ) => {
    const { data, width, height } = await rgb(image);
    const out = Buffer.from(data);
    const x0 = Math.round(facade[0] * width);
    const x1 = Math.round(facade[2] * width);
    const y0 = Math.round(facade[1] * height);
    const y1 = Math.round(facade[3] * height);
    const skip = (x: number, y: number) =>
      avoid.some(
        (box) =>
          x >= box[0] * width - 4 &&
          x < box[2] * width + 4 &&
          y >= box[1] * height - 4 &&
          y < box[3] * height + 4,
      );
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if ((x - x0) % 10 !== 0 && (y - y0) % 10 !== 0) continue;
        if (skip(x, y)) continue;
        out.fill(250, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    }
    return sharp(out, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
  };

  it('is not rejected for its edges', async () => {
    const run = async (style: 'abundant' | 'classic') => {
      const editor = recordingEditor(async (image, context) => {
        if (context.kind !== 'relight') return image;
        const facade = context.fixture?.targetFacade ?? [0.1, 0.1, 0.9, 0.9];
        return gridOver(image, facade, [
          ...(context.fixture?.attributionRegion ? [context.fixture.attributionRegion] : []),
        ]);
      });
      const deps = depsWith({ fixtureImageEditor: editor.editor });
      const { job } = await streetViewJob(deps, { style, lightingMode: 'evening' });
      const result = await runRenderJob(deps, { renderJobId: job.id });
      const attempts = await attemptsOf(job.id);
      const relight = attempts[1];
      const [row] = await judgeRowsOf(relight?.id as string);
      return { job, result, attempts, row };
    };
    const control = await run('classic');
    await expectLavish(control.job.id, false);
    expect(control.attempts[1]?.outcome).toBe('qa_rejected');
    expect(control.row).toMatchObject({ modelId: 'deterministic-checks' });
    expect(control.row?.criticalCodes).toContain('structure_changed');

    const lavish = await run('abundant');
    await expectLavish(lavish.job.id);
    expect(lavish.result.state).toBe('succeeded');
    expect(lavish.attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'composite_additive'],
      [2, 'succeeded', 'global_relight'],
    ]);
    expect(lavish.row?.modelId).not.toBe('deterministic-checks');
    expect((lavish.row?.deterministicChecks as { edgeAgreement: unknown }).edgeAgreement).toEqual({
      passed: true,
      skipped: 'lavish',
    });
  });

  it('registers a lavish relight on the frame itself: a moved camera is caught whatever the base localized', async () => {
    const editor = recordingEditor(async (image, context) => {
      if (context.kind !== 'relight') return image;
      const { data, width, height } = await rgb(image);
      const out = Buffer.alloc(data.length);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const sx = Math.max(0, x - 31);
          data.copy(out, (y * width + x) * 3, (y * width + sx) * 3, (y * width + sx) * 3 + 3);
        }
      }
      return sharp(out, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer();
    });
    const inner = base.providers.fixtures.vision;
    const everywhere = { label: 'lights everywhere', box: [0, 0, 1, 1], placementId: null };
    // A lavish base is not localized; one localized by an earlier build carries a record like
    // this, which is written onto the base while its judge runs.
    const vision = countingVision({
      judge: async (input, options) => {
        if (input.mode !== 'relight') {
          const row = await base.db
            .selectFrom('renderAttempts')
            .select('compositeMask')
            .where('id', '=', input.renderAttemptId)
            .executeTakeFirstOrThrow();
          await base.db
            .updateTable('renderAttempts')
            .set({
              compositeMask: toJson({
                ...(row.compositeMask as Record<string, unknown>),
                localization: {
                  status: 'localized',
                  model: 'earlier',
                  promptVersion: 'earlier',
                  items: [everywhere],
                  otherChanges: [],
                  dropped: [],
                  dilationPx: 0,
                  coverageBeforeCap: 1,
                  coverage: 1,
                  usage: null,
                  ledgerEntryId: null,
                  elapsedMs: 0,
                },
              }),
            })
            .where('id', '=', input.renderAttemptId)
            .execute();
        }
        return inner.judge(input, options);
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job } = await streetViewJob(deps, { lightingMode: 'evening' });
    await runRenderJob(deps, { renderJobId: job.id });
    await expectLavish(job.id);
    expect(vision.calls.localize).toBe(0);
    const attempts = await attemptsOf(job.id);
    expect(
      (attempts[0]?.compositeMask as { localization?: { items: unknown[] } }).localization?.items,
    ).toEqual([everywhere]);
    const relight = attempts[1];
    expect(relight?.outcome).toBe('qa_rejected');
    expect(relight?.registrationTransform).toMatchObject({ accepted: false, reason: 'uncovered' });
    const [row] = await judgeRowsOf(relight?.id as string);
    expect(row).toMatchObject({
      modelId: 'deterministic-checks',
      criticalCodes: ['camera_changed'],
    });
  });

  it('an evening look whose relight is rejected for good ends with the lavish daylight look', async () => {
    const spot: { box?: NormalizedBox } = {};
    const editor = blueSpotEditor(spot);
    const inner = base.providers.fixtures.vision;
    const vision = countingVision({
      judge: async (input, options) => {
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
      },
    });
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job, projectId } = await streetViewJob(deps, { lightingMode: 'evening' });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    await expectLavish(job.id);
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
      [1, false, 'succeeded'],
      [2, false, 'qa_rejected'],
      [3, true, 'qa_rejected'],
    ]);
    expect(attempts[0]?.fallback).toMatchObject({
      kind: 'relight_fallback',
      deliveredAs: 'daylight_variant',
    });
    const assets = await base.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('deletedAt', 'is', null)
      .execute();
    expect(assets.map((asset) => asset.lightingMode)).toEqual(['source']);
    const daylight = (await base.storage.get('private', assets[0]?.objectKey as string))
      ?.body as Buffer;
    expect(isBlue(await meanColor(daylight, spot.box as NormalizedBox))).toBe(true);
  });
});

describe('every relight puts people and blurred areas back from its base', () => {
  for (const style of ['classic', 'abundant'] as const) {
    it(`delivers the base's pixels where the editor sharpened a plate and redrew a person (${style})`, async () => {
      const person: NormalizedBox = [0.04, 0.08, 0.12, 0.28];
      const plate: NormalizedBox = [0.84, 0.08, 0.94, 0.15];
      /** A sharp checkerboard over a box: the editor's reconstruction. */
      const reconstruct = async (image: Uint8Array) => {
        const { data, width, height } = await rgb(image);
        const out = Buffer.from(data);
        for (const box of [person, plate]) {
          for (let y = Math.round(box[1] * height); y < Math.round(box[3] * height); y += 1) {
            for (let x = Math.round(box[0] * width); x < Math.round(box[2] * width); x += 1) {
              out.fill(
                ((x >> 1) + (y >> 1)) % 2 ? 15 : 200,
                (y * width + x) * 3,
                (y * width + x) * 3 + 3,
              );
            }
          }
        }
        return sharp(out, { raw: { width, height, channels: 3 } })
          .png()
          .toBuffer();
      };
      const editor = recordingEditor(async (image, context) =>
        context.kind === 'relight' ? reconstruct(image) : image,
      );
      const vision = countingVision({
        analyze: (analysis) => ({
          ...analysis,
          peopleBoxes: [...analysis.peopleBoxes, person],
          protectedBlurRegions: [...analysis.protectedBlurRegions, { kind: 'plate', box: plate }],
        }),
      });
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { style, lightingMode: 'evening' });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      await expectLavish(job.id, style === 'abundant');
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([
        [1, 'succeeded'],
        [2, 'succeeded'],
      ]);
      const [row] = await judgeRowsOf(attempts[1]?.id as string);
      expect(row?.modelId).not.toBe('deterministic-checks');
      const checks = row?.deterministicChecks as Record<string, Record<string, unknown>>;
      const regions = (checks.protectedRegions as { regions: Record<string, unknown>[] }).regions;
      expect(regions.filter((region) => region.restored === true).length).toBeGreaterThanOrEqual(2);
      expect(checks.protectedRegions).toMatchObject({ passed: true });
      const record = checks.compositing?.protectedRestore as {
        groups: number;
        boxes: number;
        gains: [number, number, number][];
        modes: string[];
      };
      expect(record).toMatchObject({ groups: 2, boxes: 2, modes: ['adapted', 'adapted'] });
      // The relit plate shows the daylight base's pixels under the recorded gain.
      const relightInput = editor.calls.find((call) => call.kind === 'relight')
        ?.image as Uint8Array;
      const delivered = await deliveredOf(job.id);
      const baseColor = await meanColor(relightInput, plate);
      const got = await meanColor(delivered, plate);
      const gain = record.gains[1] as [number, number, number];
      for (let c = 0; c < 3; c += 1) {
        const expected = protectedRestoreLevel(Math.round(baseColor[c]), gain[c] as number);
        expect(Math.abs(got[c] - expected)).toBeLessThan(6);
      }
    });
  }
});

describe('putting spots back from the original in a lavish look', () => {
  type Finding = JudgeResult['critical'][number] | JudgeResult['major'][number];

  /** A normalized box grown by `by` on every side, clamped to the frame. */
  const grow = (box: NormalizedBox, by: number): NormalizedBox => [
    Math.max(0, box[0] - by),
    Math.max(0, box[1] - by),
    Math.min(1, box[2] + by),
    Math.min(1, box[3] + by),
  ];

  /**
   * An editor that paints a solid `color` square around a judge box `spot.box` chosen clear of the
   * placements on the first output (the square reaches `margin` beyond the box), the same on every
   * decorate attempt.
   */
  function squareEditor(
    spot: { box?: NormalizedBox; square?: NormalizedBox },
    color: [number, number, number],
    margin: number,
  ) {
    return recordingEditor(async (image, context) => {
      if (context.kind !== 'decorate') return image;
      const placements = context.fixture?.placements ?? [];
      const avoid = [
        ...(context.fixture?.attributionRegion ? [context.fixture.attributionRegion] : []),
        ...(context.fixture?.preserveRegions ?? []),
      ];
      spot.box ??= clearBox(placements, avoid, 0.04, 0.1);
      spot.square ??= grow(spot.box, margin);
      return paint(image, [{ box: spot.square, color }]);
    });
  }

  /**
   * The fixture vision model with `findings` (by the plan's attempt number) added to every
   * decorate judge call, critical codes as critical findings and the others as major ones; with
   * `localized`, the localizer reports that box as a decoration the editor added.
   */
  function findingsVision(
    findingsOf: (
      attemptNo: number,
    ) => (JudgeResult['critical'][number] | JudgeResult['major'][number])[],
    localized?: () => NormalizedBox | undefined,
  ) {
    const inner = base.providers.fixtures.vision;
    return countingVision({
      judge: async (input, options) => {
        const result = await inner.judge(input, options);
        if (input.mode === 'relight') return result;
        const added = findingsOf(input.plan.attemptNumber);
        const critical = added.filter((finding): finding is JudgeResult['critical'][number] =>
          isCriticalFailureCode(finding.code),
        );
        const major = added.filter(
          (finding): finding is JudgeResult['major'][number] =>
            !isCriticalFailureCode(finding.code),
        );
        return {
          ...result,
          result: {
            ...result.result,
            critical: [...result.result.critical, ...critical],
            major: [...result.result.major, ...major],
          },
        };
      },
      ...(localized
        ? {
            localize: async (input: Parameters<VisionModel['localizeAdditions']>[0], options) => {
              const planned = await inner.localizeAdditions(input, options);
              const box = localized();
              if (!box) return planned;
              return {
                ...planned,
                result: {
                  ...planned.result,
                  added: [
                    ...planned.result.added,
                    { label: 'painted square', box, placementId: null },
                  ],
                },
              };
            },
          }
        : {}),
    });
  }

  describe('a rejected first attempt with a repair open', () => {
    const MAGENTA: [number, number, number] = [250, 0, 250];
    /**
     * A job whose first attempt the judge rejects for `finding` (one finding or several) about the
     * painted square `box`.
     */
    const run = async (
      style: 'abundant' | 'classic',
      finding: (box: NormalizedBox) => Finding | Finding[],
      extra: { reviewMode?: 'pre_delivery' } = {},
    ) => {
      const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
      const editor = squareEditor(spot, MAGENTA, 0);
      const vision = findingsVision((attemptNo) =>
        attemptNo === 1 ? [finding(spot.box as NormalizedBox)].flat() : [],
      );
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { style, ...extra });
      const result = await runRenderJob(deps, { renderJobId: job.id });
      const attempts = await attemptsOf(job.id);
      const plans = await plansOf(job.id);
      const decorateCalls = editor.calls.filter((call) => call.kind === 'decorate').length;
      const box = spot.box as NormalizedBox;
      const delivered =
        result.state === 'succeeded' ? await meanColor(await deliveredOf(job.id), box) : null;
      const original = await meanColor(editor.calls[0]?.image as Uint8Array, box);
      return { job, result, attempts, plans, decorateCalls, box, delivered, original };
    };
    const accessBlocked = (box: NormalizedBox) => ({
      code: 'access_blocked' as const,
      confidence: 0.9,
      evidence: 'A decoration stands in the doorway.',
      box,
    });
    const expectOriginal = (got: Awaited<ReturnType<typeof run>>) => {
      expect(got.delivered).not.toBeNull();
      for (let c = 0; c < 3; c += 1) {
        expect(Math.abs((got.delivered?.[c] as number) - (got.original[c] as number))).toBeLessThan(
          3,
        );
      }
    };

    it('a lavish attempt has its objected spot put back and goes on at once', async () => {
      const lavish = await run('abundant', accessBlocked);
      expect(lavish.result.state).toBe('succeeded');
      expect(lavish.plans.map((plan) => isLavishPlan(plan))).toEqual([true]);
      expect(lavish.decorateCalls).toBe(1);
      expect(lavish.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'succeeded'],
      ]);
      expect((await readJob(base.db, lavish.job.id))?.repairUsed).toBe(false);
      expect(lavish.attempts[0]?.compositeMask).toMatchObject({
        keep: { area: 'whole_frame' },
        restored: { kind: 'objected', codes: ['access_blocked'], boxes: [lavish.box] },
      });
      expectOriginal(lavish);
    });

    it('a lavish attempt rejected for a boxed major alone has that box put back and goes on at once', async () => {
      const lavish = await run('abundant', (box) => ({
        code: 'unrequested_change',
        confidence: 0.8,
        evidence: 'A wall was repainted.',
        box,
      }));
      expect(lavish.result.state).toBe('succeeded');
      expect(lavish.plans.map((plan) => isLavishPlan(plan))).toEqual([true]);
      expect(lavish.decorateCalls).toBe(1);
      expect(lavish.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'succeeded'],
      ]);
      expect((await readJob(base.db, lavish.job.id))?.repairUsed).toBe(false);
      expect(lavish.attempts[0]?.compositeMask).toMatchObject({
        restored: { kind: 'objected', codes: ['unrequested_change'], boxes: [lavish.box] },
      });
      expectOriginal(lavish);
    });

    /**
     * A lavish job whose first attempt the judge rejects for `finding` (no box), with the job's
     * stored repair record as the repair's edit is sent.
     */
    const repaired = async (
      lightingMode: 'source' | 'evening',
      finding: JudgeResult['critical'][number] | JudgeResult['major'][number],
    ) => {
      const jobRef: { id?: string } = {};
      const stored: unknown[] = [];
      const editor = recordingEditor(async (image, context) => {
        if (context.kind === 'decorate' && context.call === 1) {
          stored.push((await readJob(base.db, jobRef.id as string))?.repairConstraints);
        }
        return image;
      });
      const vision = findingsVision((attemptNo) => (attemptNo === 1 ? [finding] : []));
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { lightingMode });
      jobRef.id = job.id;
      const result = await runRenderJob(deps, { renderJobId: job.id });
      const attempts = await attemptsOf(job.id);
      const plans = await plansOf(job.id);
      const decorate = editor.calls.filter((call) => call.kind === 'decorate');
      const relight = editor.calls.filter((call) => call.kind === 'relight');
      const [repairRow] = await judgeRowsOf(attempts[1]?.id as string);
      return { job, result, attempts, plans, decorate, relight, vision, stored, repairRow };
    };

    it('a lavish attempt rejected for a critical finding without a box is repaired the ordinary way', async () => {
      for (const lightingMode of ['source', 'evening'] as const) {
        const got = await repaired(lightingMode, {
          code: 'access_blocked',
          confidence: 0.9,
          evidence: 'A decoration stands in the doorway.',
        });
        expect(got.result.state, lightingMode).toBe('succeeded');
        expect(
          got.plans.map((plan) => [plan.attemptNumber, isLavishPlan(plan)]),
          lightingMode,
        ).toEqual(
          lightingMode === 'source'
            ? [
                [1, true],
                [2, false],
              ]
            : [
                [1, true],
                [2, false],
                [3, false],
              ],
        );
        expect(got.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
          [1, false, 'qa_rejected'],
          [2, true, 'succeeded'],
          ...(lightingMode === 'evening' ? [[3, false, 'succeeded']] : []),
        ]);
        // The stored repair record asks for the ordinary look.
        expect(got.stored).toEqual([
          expect.objectContaining({
            codes: ['access_blocked'],
            adjustments: expect.objectContaining({ ordinary: true, accessTolerance: 0 }),
          }),
        ]);
        // Compiled with placement sentences, localized and pasted back.
        expect(got.decorate[0]?.instructionText).toContain(LAVISH_ADDED);
        expect(got.decorate[1]?.instructionText).not.toContain(LAVISH_ADDED);
        expect(got.decorate[1]?.instructionText).toContain(', at the ');
        expect(got.vision.calls.localize).toBe(1);
        expect(got.attempts[0]?.compositeMask).toHaveProperty('keep');
        expect(got.attempts[1]?.compositeMask).toMatchObject({
          localization: { status: 'localized' },
        });
        expect(got.attempts[1]?.compositeMask).not.toHaveProperty('keep');
        const checks = got.repairRow?.deterministicChecks as Record<
          string,
          Record<string, unknown>
        >;
        expect(checks.seam).not.toHaveProperty('skipped');
        expect(checks.edgeAgreement).not.toHaveProperty('skipped');
        if (lightingMode === 'evening') {
          // The ordinary relight names the lit decorations again.
          expect(got.relight).toHaveLength(1);
          expect(got.relight[0]?.instructionText).toContain(
            'The lights already on the decorations glow warmly and cast soft light on nearby surfaces: ',
          );
          expect(got.relight[0]?.instructionText).not.toContain(LAVISH_RELIGHT_DECORATIONS);
        }
      }
    });

    it('a lavish attempt rejected for a major finding alone is repaired with the mark', async () => {
      const got = await repaired('source', {
        code: 'unrequested_change',
        confidence: 0.8,
        evidence: 'A wall was repainted.',
      });
      expect(got.result.state).toBe('succeeded');
      expect(got.plans.map((plan) => isLavishPlan(plan))).toEqual([true, true]);
      expect(got.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect(got.stored).toHaveLength(1);
      expect((got.stored[0] as { adjustments: object }).adjustments).not.toHaveProperty('ordinary');
      expect(got.decorate[1]?.instructionText).toContain(LAVISH_ADDED);
      expect(got.decorate[1]?.instructionText).toContain(
        'Change nothing except adding decorations: no repainting, no landscaping changes, no added snow, no removed objects.',
      );
      expect(got.vision.calls.localize).toBe(0);
      expect(got.attempts[1]?.compositeMask).toMatchObject({ keep: { area: 'whole_frame' } });
    });

    it('a classic attempt with the same boxed finding is repaired first', async () => {
      const classic = await run('classic', accessBlocked);
      expect(classic.result.state).toBe('succeeded');
      expect(classic.plans.map((plan) => isLavishPlan(plan))).toEqual([false, false]);
      expect(classic.decorateCalls).toBe(2);
      expect(classic.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect((await readJob(base.db, classic.job.id))?.repairUsed).toBe(true);
      expect(classic.attempts[0]?.compositeMask).not.toHaveProperty('restored');
      expect(classic.attempts[1]?.compositeMask).not.toHaveProperty('restored');
    });

    const notFollowed: Finding = {
      code: 'plan_not_followed',
      confidence: 0.9,
      evidence: 'Hardly anything was added.',
    };
    /** The job was repaired once, the ordinary way, and attempt 1 has nothing put back. */
    const expectOrdinaryRepair = async (got: Awaited<ReturnType<typeof run>>) => {
      expect(got.result.state).toBe('succeeded');
      expect(got.plans.map((plan) => isLavishPlan(plan))).toEqual([true, false]);
      expect(got.decorateCalls).toBe(2);
      expect(got.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect((await readJob(base.db, got.job.id))?.repairUsed).toBe(true);
      expect(got.attempts[0]?.compositeMask).not.toHaveProperty('restored');
    };

    it('a lavish attempt with a deliverable doubt and a confident major without a box is repaired, not delivered at once', async () => {
      const got = await run('abundant', (box) => [
        {
          code: 'structure_changed',
          confidence: 0.55,
          evidence: 'Something may have changed.',
          box,
        },
        notFollowed,
      ]);
      await expectOrdinaryRepair(got);
      // A critical code is among the findings: the repair is the ordinary look and answers both.
      expect((got.plans[1]?.repairConstraints ?? []).map((c) => c.code)).toEqual([
        'structure_changed',
        'plan_not_followed',
      ]);
    });

    it('a lavish attempt rejected for a boxed critical finding and a confident major without a box is repaired, not put back at once', async () => {
      const got = await run('abundant', (box) => [accessBlocked(box), notFollowed]);
      await expectOrdinaryRepair(got);
      expect((got.plans[1]?.repairConstraints ?? []).map((c) => c.code)).toEqual([
        'access_blocked',
        'plan_not_followed',
      ]);
    });

    it('a lavish attempt rejected for a critical and a major finding, each with a box, has both put back and goes on at once', async () => {
      const spots: { access?: NormalizedBox; change?: NormalizedBox } = {};
      const editor = recordingEditor(async (image, context) => {
        if (context.kind !== 'decorate') return image;
        const placements = context.fixture?.placements ?? [];
        const avoid = [
          ...(context.fixture?.attributionRegion ? [context.fixture.attributionRegion] : []),
          ...(context.fixture?.preserveRegions ?? []),
        ];
        spots.access ??= clearBox(placements, avoid, 0.04, 0.1);
        spots.change ??= clearBox(placements, [...avoid, spots.access], 0.04, 0.1);
        return paint(image, [
          { box: spots.access, color: MAGENTA },
          { box: spots.change, color: MAGENTA },
        ]);
      });
      const vision = findingsVision((attemptNo) =>
        attemptNo === 1
          ? [
              accessBlocked(spots.access as NormalizedBox),
              {
                code: 'unrequested_change',
                confidence: 0.8,
                evidence: 'A wall was repainted.',
                box: spots.change as NormalizedBox,
              },
            ]
          : [],
      );
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect((await plansOf(job.id)).map((plan) => isLavishPlan(plan))).toEqual([true]);
      expect(editor.calls.filter((call) => call.kind === 'decorate')).toHaveLength(1);
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'succeeded'],
      ]);
      expect((await readJob(base.db, job.id))?.repairUsed).toBe(false);
      const restored = (attempts[0]?.compositeMask as { restored?: Record<string, unknown> })
        .restored;
      expect(restored).toMatchObject({
        kind: 'objected',
        codes: ['access_blocked', 'unrequested_change'],
        boxes: [spots.access, spots.change],
      });
      expect(restored).not.toHaveProperty('recordedMajors');
      const delivered = await deliveredOf(job.id);
      for (const box of [spots.access, spots.change] as NormalizedBox[]) {
        const got = await meanColor(delivered, box);
        const original = await meanColor(editor.calls[0]?.image as Uint8Array, box);
        for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c] - original[c])).toBeLessThan(3);
      }
    });

    it('a lavish attempt whose boxes leave enough of the decorations only without the major one is repaired, not delivered at once', async () => {
      const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
      const editor = squareEditor(spot, MAGENTA, 0);
      const inner = base.providers.fixtures.vision;
      // The major finding's box covers every planned decoration; the critical one is clear of
      // them.
      const covering: { box?: NormalizedBox } = {};
      const vision = countingVision({
        judge: async (input, options) => {
          const result = await inner.judge(input, options);
          if (input.mode === 'relight' || input.plan.attemptNumber !== 1) return result;
          const regions = input.plan.placements.map((placement) => placement.region);
          covering.box ??= [
            Math.max(0, Math.min(...regions.map((r) => r[0])) - 0.005),
            Math.max(0, Math.min(...regions.map((r) => r[1])) - 0.005),
            Math.min(1, Math.max(...regions.map((r) => r[2])) + 0.005),
            Math.min(1, Math.max(...regions.map((r) => r[3])) + 0.005),
          ];
          return {
            ...result,
            result: {
              ...result.result,
              critical: [...result.result.critical, accessBlocked(spot.box as NormalizedBox)],
              major: [
                ...result.result.major,
                {
                  code: 'unrequested_change',
                  confidence: 0.8,
                  evidence: 'The facade was repainted.',
                  box: covering.box,
                },
              ],
            },
          };
        },
      });
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      const plans = await plansOf(job.id);
      expect(plans.map((plan) => isLavishPlan(plan))).toEqual([true, false]);
      // Putting every box back would leave too little; the critical box alone would not.
      const { width, height } = await rgb(editor.calls[0]?.image as Uint8Array);
      const regions = (plans[0]?.placements ?? []).map((placement) => placement.region);
      const enough = (boxes: NormalizedBox[]) =>
        enoughDecorationsLeft(
          decorationsLeft({ width, height, decorations: regions, placements: regions, boxes }),
          'objected',
        );
      expect(enough([spot.box as NormalizedBox, covering.box as NormalizedBox])).toBe(false);
      expect(enough([spot.box as NormalizedBox])).toBe(true);
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect((await readJob(base.db, job.id))?.repairUsed).toBe(true);
      expect(attempts[0]?.compositeMask).not.toHaveProperty('restored');
    });

    const neighborDoubt = (box: NormalizedBox, confidence: number): Finding => ({
      code: 'neighbor_decorated',
      confidence,
      evidence: 'Lights may reach the neighbouring porch.',
      box,
    });

    it('a lavish attempt rejected for a boxed finding about the home is repaired, not put back at once, when the judge also doubts a neighbouring home', async () => {
      // The verdict's codes hold the confident finding alone; the doubt beside it still counts.
      const got = await run('abundant', (box) => [accessBlocked(box), neighborDoubt(box, 0.45)]);
      await expectOrdinaryRepair(got);
    });

    it('a finding under the uncertainty floor does not keep the objected spot of a lavish attempt from being put back at once', async () => {
      const got = await run('abundant', (box) => [accessBlocked(box), neighborDoubt(box, 0.3)]);
      expect(got.result.state).toBe('succeeded');
      expect(got.plans.map((plan) => isLavishPlan(plan))).toEqual([true]);
      expect(got.decorateCalls).toBe(1);
      expect(got.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'succeeded'],
      ]);
      expect((await readJob(base.db, got.job.id))?.repairUsed).toBe(false);
      expect(got.attempts[0]?.compositeMask).toMatchObject({
        restored: { kind: 'objected', codes: ['access_blocked'], boxes: [got.box] },
      });
      expectOriginal(got);
    });

    it('in pre-delivery review a lavish attempt is repaired first and then held for review, as a classic one is', async () => {
      for (const style of ['abundant', 'classic'] as const) {
        const got = await run(style, accessBlocked, { reviewMode: 'pre_delivery' });
        expect(got.result.state, style).toBe('needs_review');
        expect(
          got.plans.map((plan) => isLavishPlan(plan)),
          style,
        ).toEqual([style === 'abundant', false]);
        expect(got.decorateCalls, style).toBe(2);
        expect(
          got.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome]),
          style,
        ).toEqual([
          [1, false, 'qa_rejected'],
          [2, true, 'succeeded'],
        ]);
        expect((await readJob(base.db, got.job.id))?.repairUsed, style).toBe(true);
        expect(got.attempts[0]?.compositeMask, style).not.toHaveProperty('restored');
      }
    });
  });

  describe('a doubted first attempt with a repair open', () => {
    /** A job whose first attempt the judge doubts for `code`, with a box when `boxed` is set. */
    const run = async (
      style: 'abundant' | 'classic',
      code: 'structure_changed' | 'neighbor_decorated',
      boxed = code === 'structure_changed',
    ) => {
      const spot: { box?: NormalizedBox } = {};
      const editor = blueSpotEditor(spot);
      const vision = findingsVision((attemptNo) =>
        attemptNo === 1
          ? [
              {
                code,
                confidence: 0.55,
                evidence: 'Something may have changed.',
                ...(boxed ? { box: spot.box as NormalizedBox } : {}),
              },
            ]
          : [],
      );
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { style });
      const result = await runRenderJob(deps, { renderJobId: job.id });
      const attempts = await attemptsOf(job.id);
      const plans = await plansOf(job.id);
      const decorateCalls = editor.calls.filter((call) => call.kind === 'decorate').length;
      return { job, result, attempts, plans, decorateCalls, spot: spot.box as NormalizedBox };
    };

    it('is delivered at once as the editor drew it when the doubt is deliverable and the look lavish', async () => {
      const lavish = await run('abundant', 'structure_changed');
      expect(lavish.result.state).toBe('succeeded');
      expect(lavish.plans.map((plan) => isLavishPlan(plan))).toEqual([true]);
      expect(lavish.decorateCalls).toBe(1);
      expect(lavish.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'succeeded'],
      ]);
      expect((await readJob(base.db, lavish.job.id))?.repairUsed).toBe(false);
      const rows = await judgeRowsOf(lavish.attempts[0]?.id as string);
      expect(rows.map((row) => row.decision)).toContain('uncertain');
      expect(rows.every((row) => row.decision !== 'reject')).toBe(true);
      expect(lavish.attempts[0]?.compositeMask).not.toHaveProperty('restored');
      expect(isBlue(await meanColor(await deliveredOf(lavish.job.id), lavish.spot))).toBe(true);
    });

    it('is repaired as before on a classic attempt', async () => {
      const classic = await run('classic', 'structure_changed');
      expect(classic.result.state).toBe('succeeded');
      expect(classic.plans.map((plan) => isLavishPlan(plan))).toEqual([false, false]);
      expect(classic.decorateCalls).toBe(2);
      expect(classic.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect((await readJob(base.db, classic.job.id))?.repairUsed).toBe(true);
    });

    it('is repaired on a lavish attempt when the doubt is not deliverable', async () => {
      const neighbor = await run('abundant', 'neighbor_decorated');
      expect(neighbor.result.state).toBe('succeeded');
      // The doubted critical code makes the repair the ordinary look.
      expect(neighbor.plans.map((plan) => isLavishPlan(plan))).toEqual([true, false]);
      expect(neighbor.decorateCalls).toBe(2);
      expect(neighbor.attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect((await readJob(base.db, neighbor.job.id))?.repairUsed).toBe(true);
      expect(neighbor.attempts[0]?.compositeMask).not.toHaveProperty('restored');
    });

    const ORANGE: [number, number, number] = [250, 140, 0];
    const aboutOthers = [
      ['neighbor_decorated', 0.55],
      ['neighbor_decorated', 0.9],
      ['privacy_regression', 0.9],
      ['people_altered', 0.9],
    ] as const;
    for (const [code, confidence] of aboutOthers) {
      it(`repairs ${code} at ${confidence} the ordinary way on a lavish attempt, also when it has a box`, async () => {
        const label = `${code} ${confidence}`;
        // The editor's square reaches beyond the judge's box and the area a restore puts back.
        const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
        const editor = squareEditor(spot, ORANGE, 0.06);
        const vision = findingsVision((attemptNo) =>
          attemptNo === 1
            ? [
                {
                  code,
                  confidence,
                  evidence: 'Something was changed there.',
                  box: spot.box as NormalizedBox,
                },
              ]
            : [],
        );
        const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
        const { job } = await streetViewJob(deps);
        expect((await runRenderJob(deps, { renderJobId: job.id })).state, label).toBe('succeeded');
        expect(
          (await plansOf(job.id)).map((plan) => isLavishPlan(plan)),
          label,
        ).toEqual([true, false]);
        const attempts = await attemptsOf(job.id);
        expect(
          attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome]),
          label,
        ).toEqual([
          [1, false, 'qa_rejected'],
          [2, true, 'succeeded'],
        ]);
        expect((await readJob(base.db, job.id))?.repairUsed, label).toBe(true);
        expect(attempts[0]?.compositeMask, label).not.toHaveProperty('restored');
        // The editor's change between the square's edge and the grown judge box, which an
        // early restore would have kept, is not in the delivered picture.
        const original = editor.calls[0]?.image as Uint8Array;
        const { width, height } = await rgb(original);
        const [area] = restoredAreas([spot.box as NormalizedBox], width, height);
        const square = spot.square as NormalizedBox;
        const strip: NormalizedBox = [square[0], square[1], (area as NormalizedBox)[0], square[3]];
        expect(strip[2] - strip[0], label).toBeGreaterThan(0.01);
        const judged = vision.judgeInputs[0]?.candidate.bytes as Uint8Array;
        const drawn = await meanColor(judged, strip);
        expect(drawn[0] - drawn[2], label).toBeGreaterThan(150);
        const got = await meanColor(await deliveredOf(job.id), strip);
        const before = await meanColor(original, strip);
        for (let c = 0; c < 3; c += 1) {
          expect(Math.abs(got[c] - before[c]), label).toBeLessThan(3);
        }
      });
    }
  });

  it('a doubted lavish look is delivered as the editor drew it; a classic one has its doubt put back', async () => {
    const run = async (style: 'abundant' | 'classic') => {
      const spot: { box?: NormalizedBox } = {};
      const editor = blueSpotEditor(spot);
      // Attempt 1 is rejected for a major finding without a box, so a lavish look is repaired
      // with the mark; the repair, with no repair after it, is doubted for a boxed finding.
      const vision = findingsVision(
        (attemptNo) =>
          attemptNo === 1
            ? [{ code: 'unrequested_change', confidence: 0.8, evidence: 'A wall was repainted.' }]
            : [
                {
                  code: 'access_blocked',
                  confidence: 0.5,
                  evidence: 'Something may stand in the way.',
                  box: spot.box as NormalizedBox,
                },
              ],
        // Without the mark the composite keeps the spot only where the localizer found it.
        () => spot.box,
      );
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { style });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      await expectLavish(job.id, style === 'abundant');
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      const delivered = await meanColor(await deliveredOf(job.id), spot.box as NormalizedBox);
      const original = await meanColor(
        editor.calls[1]?.image as Uint8Array,
        spot.box as NormalizedBox,
      );
      return { attempts, delivered, original, spot: spot.box as NormalizedBox };
    };
    const lavish = await run('abundant');
    expect(isBlue(lavish.delivered)).toBe(true);
    expect(lavish.attempts[1]?.compositeMask).not.toHaveProperty('restored');

    const classic = await run('classic');
    expect(classic.attempts[1]?.compositeMask).toMatchObject({
      restored: { kind: 'doubted', codes: ['access_blocked'], boxes: [classic.spot] },
    });
    expect(isBlue(classic.delivered)).toBe(false);
    for (let c = 0; c < 3; c += 1) {
      expect(Math.abs(classic.delivered[c] - classic.original[c])).toBeLessThan(3);
    }
  });

  it("a lavish look's objected spot, put back at once, fades in; a classic one's, put back by the last resort, keeps a hard edge", async () => {
    const MAGENTA: [number, number, number] = [250, 0, 250];
    const run = async (style: 'abundant' | 'classic') => {
      // A lavish attempt has its objected spot put back on the first attempt; a classic one is
      // repaired first and the last resort puts the spot back on the rejected repair.
      const at = style === 'abundant' ? 0 : 1;
      const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
      const editor = squareEditor(spot, MAGENTA, 0.12);
      const vision = findingsVision(
        () => [
          {
            code: 'structure_changed',
            confidence: 0.97,
            evidence: 'A patch appeared.',
            box: spot.box as NormalizedBox,
          },
        ],
        // Without the mark the composite keeps the square only where the localizer found it.
        () => spot.square,
      );
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps, { style });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      await expectLavish(job.id, style === 'abundant');
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual(
        style === 'abundant'
          ? [[1, false, 'succeeded']]
          : [
              [1, false, 'qa_rejected'],
              [2, true, 'succeeded'],
            ],
      );
      expect(attempts[at]?.compositeMask).toMatchObject({
        restored: { kind: 'objected', boxes: [spot.box] },
      });
      expect(vision.judgeInputs).toHaveLength(at + 1);
      const original = await rgb(vision.judgeInputs[at]?.original.bytes as Uint8Array);
      const judged = await rgb(vision.judgeInputs[at]?.candidate.bytes as Uint8Array);
      const delivered = await rgb(await deliveredOf(job.id));
      expect([delivered.width, delivered.height]).toEqual([original.width, original.height]);
      const { width, height } = original;
      const [area] = restoredAreas([spot.box as NormalizedBox], width, height);
      const rect = toRect(area as NormalizedBox, width, height);
      const y = Math.round((rect.y0 + rect.y1) / 2);
      /**
       * How far the delivered pixel `d` px right of the restored area has moved from the
       * original toward the editor's picture (0: the original, 1: the editor's).
       */
      const share = (d: number) => {
        const i = (y * width + rect.x1 - 1 + d) * 3;
        let num = 0;
        let den = 0;
        for (let c = 0; c < 3; c += 1) {
          const o = original.data[i + c] as number;
          const p = judged.data[i + c] as number;
          num += ((delivered.data[i + c] as number) - o) * (p - o);
          den += (p - o) * (p - o);
        }
        return num / Math.max(1, den);
      };
      const keep = (attempts[at]?.compositeMask as { keep?: { featherPx: number } }).keep;
      return { share, keep };
    };

    const lavish = await run('abundant');
    const softPx = lavish.keep?.featherPx as number;
    expect(softPx).toBeGreaterThan(4);
    const shares = Array.from({ length: softPx + 4 }, (_, d) => lavish.share(d));
    // Inside the area the original; just outside it still nearly the original, then a smooth
    // rise to the editor's picture by the feather width.
    expect(shares[0]).toBeLessThan(0.1);
    expect(shares[1]).toBeLessThan(0.15);
    expect(shares[softPx + 2]).toBeGreaterThan(0.85);
    for (let d = 1; d < shares.length; d += 1) {
      expect(Math.abs((shares[d] as number) - (shares[d - 1] as number))).toBeLessThan(0.3);
    }

    const classic = await run('classic');
    expect(classic.keep).toBeUndefined();
    expect(classic.share(0)).toBeLessThan(0.1);
    expect(classic.share(1)).toBeGreaterThan(0.85);
  });

  describe('around a lavish attempt that goes on at once', () => {
    const MAGENTA: [number, number, number] = [250, 0, 250];
    const doubt = (box: NormalizedBox): Finding => ({
      code: 'structure_changed',
      confidence: 0.55,
      evidence: 'Something may have changed.',
      box,
    });
    const access = (box?: NormalizedBox): Finding => ({
      code: 'access_blocked',
      confidence: 0.9,
      evidence: 'A decoration stands in the doorway.',
      ...(box ? { box } : {}),
    });
    /** The lighting of every look the project has published. */
    const looksOf = async (projectId: string) =>
      (
        await base.db
          .selectFrom('renderAssets')
          .select('lightingMode')
          .where('projectId', '=', projectId)
          .where('deletedAt', 'is', null)
          .execute()
      ).map((asset) => asset.lightingMode);
    /** An evening job whose base the judge objects to with `finding`; the relight passes. */
    const evening = async (
      editorFor: (spot: { box?: NormalizedBox; square?: NormalizedBox }) => {
        editor: ImageEditor;
        calls: EditCall[];
      },
      finding: (box: NormalizedBox) => Finding,
    ) => {
      const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
      const editor = editorFor(spot);
      const vision = findingsVision((attemptNo) =>
        attemptNo === 1 ? [finding(spot.box as NormalizedBox)] : [],
      );
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job, projectId } = await streetViewJob(deps, { lightingMode: 'evening' });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect(
        (await plansOf(job.id)).map((plan) => [
          plan.attemptNumber,
          plan.lightingMode,
          isLavishPlan(plan),
        ]),
      ).toEqual([
        [1, 'source', true],
        [2, 'evening', true],
      ]);
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'succeeded'],
        [2, false, 'succeeded'],
      ]);
      const stored = await readJob(base.db, job.id);
      expect(stored?.repairUsed).toBe(false);
      // The base did not pass: it is not published as the daylight look.
      expect(stored?.repairConstraints).toMatchObject({
        baseVerdict: 'uncertain',
        relightBase: { baseRenderAssetId: null },
      });
      expect(await looksOf(projectId)).toEqual(['evening']);
      await expectNoLocalizationPaid(job.id);
      const box = spot.box as NormalizedBox;
      const relightInput = editor.calls.find((call) => call.kind === 'relight')
        ?.image as Uint8Array;
      return {
        job,
        attempts,
        box,
        relit: await meanColor(relightInput, box),
        original: await meanColor(editor.calls[0]?.image as Uint8Array, box),
      };
    };

    it('an evening look whose lavish base is a deliverable doubt relights the base as drawn and publishes the evening look alone', async () => {
      const got = await evening((spot) => blueSpotEditor(spot), doubt);
      for (const row of await judgeRowsOf(got.attempts[0]?.id as string)) {
        expect(row.decision).toBe('uncertain');
      }
      expect(got.attempts[0]?.compositeMask).not.toHaveProperty('restored');
      expect(isBlue(got.relit)).toBe(true);
    });

    it('an evening look whose lavish base has its objected spot put back at once relights the restored base', async () => {
      const got = await evening((spot) => squareEditor(spot, MAGENTA, 0), access);
      expect(got.attempts[0]?.compositeMask).toMatchObject({
        restored: { kind: 'objected', codes: ['access_blocked'], boxes: [got.box] },
      });
      for (let c = 0; c < 3; c += 1) {
        expect(Math.abs(got.relit[c] - got.original[c])).toBeLessThan(3);
      }
    });

    it('a lavish look delivered at once, as drawn or with its objected spot put back, leaves nothing open and pays no localization', async () => {
      for (const rule of ['as drawn', 'put back'] as const) {
        const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
        const editor = rule === 'as drawn' ? blueSpotEditor(spot) : squareEditor(spot, MAGENTA, 0);
        const vision = findingsVision((attemptNo) =>
          attemptNo === 1
            ? [rule === 'as drawn' ? doubt(spot.box as NormalizedBox) : access(spot.box)]
            : [],
        );
        const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
        const { job } = await streetViewJob(deps);
        expect((await runRenderJob(deps, { renderJobId: job.id })).state, rule).toBe('succeeded');
        expect(
          (await attemptsOf(job.id)).map((a) => [a.attemptNo, a.isRepair, a.outcome]),
          rule,
        ).toEqual([[1, false, 'succeeded']]);
        await expectNoLocalizationPaid(job.id);
        // One image edit paid; the edit reserved for a repair released.
        const edits = (await ledgerOf(job.id)).filter((row) => row.sku === 'image_edit_attempt');
        expect(
          edits.filter((row) => row.kind === 'settlement'),
          rule,
        ).toHaveLength(1);
        expect(
          edits.filter((row) => row.kind === 'release'),
          rule,
        ).toHaveLength(1);
      }
    });

    it('a rejected ordinary repair of a lavish attempt has its boxed spot put back by the last resort', async () => {
      const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
      const editor = squareEditor(spot, MAGENTA, 0);
      // The repair keeps the square as a decoration the localizer found, and the judge objects.
      const vision = findingsVision(
        (attemptNo) =>
          attemptNo === 1
            ? [access()]
            : [
                {
                  code: 'structure_changed',
                  confidence: 0.97,
                  evidence: 'A patch appeared.',
                  box: spot.box as NormalizedBox,
                },
              ],
        () => spot.box,
      );
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job } = await streetViewJob(deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect((await plansOf(job.id)).map((plan) => isLavishPlan(plan))).toEqual([true, false]);
      const attempts = await attemptsOf(job.id);
      expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect(attempts[0]?.compositeMask).not.toHaveProperty('restored');
      expect(attempts[1]?.compositeMask).toMatchObject({
        restored: { kind: 'objected', codes: ['structure_changed'], boxes: [spot.box] },
      });
      const got = await meanColor(await deliveredOf(job.id), spot.box as NormalizedBox);
      const original = await meanColor(
        editor.calls[0]?.image as Uint8Array,
        spot.box as NormalizedBox,
      );
      for (let c = 0; c < 3; c += 1) expect(Math.abs(got[c] - original[c])).toBeLessThan(3);
      expect(await openReservationsOf(job.id)).toEqual([]);
    });

    it('a rejected ordinary repair of a lavish attempt with a finding without a box ends the job rejected with nothing open', async () => {
      const spot: { box?: NormalizedBox; square?: NormalizedBox } = {};
      const editor = squareEditor(spot, MAGENTA, 0);
      const vision = findingsVision(() => [access()]);
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { job, projectId } = await streetViewJob(deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
      expect((await plansOf(job.id)).map((plan) => isLavishPlan(plan))).toEqual([true, false]);
      expect((await attemptsOf(job.id)).map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'qa_rejected'],
      ]);
      expect(await readJob(base.db, job.id)).toMatchObject({
        state: 'rejected',
        rejectionReason: 'qa_critical',
        failureCodes: ['access_blocked'],
        repairUsed: true,
      });
      expect(await looksOf(projectId)).toEqual([]);
      expect(await openReservationsOf(job.id)).toEqual([]);
    });

    it('a job stopped after the ordinary repair was recorded plans that repair without the mark when it is delivered again', async () => {
      const controller = new AbortController();
      const editor = recordingEditor();
      const vision = findingsVision((attemptNo) => (attemptNo === 1 ? [access()] : []));
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      // The worker stops while the repair's mask is stored, after the repair record was written
      // and before the repair's plan.
      const storage = new Proxy(deps.storage, {
        get(target, prop, receiver) {
          if (prop === 'put') {
            return async (input: Parameters<typeof target.put>[0]) => {
              if (input.key.endsWith('mask-2.png')) {
                controller.abort();
                throw new Error('stopped');
              }
              return target.put(input);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      });
      const { job } = await streetViewJob(deps, {}, 'persist');
      await expect(
        runRenderJob({ ...deps, storage }, { renderJobId: job.id, signal: controller.signal }),
      ).rejects.toThrow();
      const stopped = await readJob(base.db, job.id);
      expect(stopped?.state).toBe('planning');
      expect(stopped?.repairConstraints).toMatchObject({
        codes: ['access_blocked'],
        adjustments: { ordinary: true },
      });
      expect((await plansOf(job.id)).map((plan) => isLavishPlan(plan))).toEqual([true]);

      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect((await plansOf(job.id)).map((plan) => isLavishPlan(plan))).toEqual([true, false]);
      expect((await attemptsOf(job.id)).map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
        [1, false, 'qa_rejected'],
        [2, true, 'succeeded'],
      ]);
      expect((await readJob(base.db, job.id))?.repairUsed).toBe(true);
      expect(vision.calls.localize).toBe(1);
      expect(await openReservationsOf(job.id)).toEqual([]);
    });
  });
});

describe('the scene types of the lavish look', () => {
  const SAMPLES = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../content/photos/samples',
  );
  const uploads = [
    { file: 'sample-living-room-mantel.jpg', sceneType: 'interior', roomType: 'living_room' },
    { file: 'sample-apartment-hallway.jpg', sceneType: 'apartment_entry', roomType: null },
    { file: 'sample-balcony.jpg', sceneType: 'balcony', roomType: null },
  ] as const satisfies readonly { file: string; sceneType: SceneType; roomType: RoomType | null }[];

  it('decorates only a house exterior from the lavish description', () => {
    expect(PIPELINE_DEFAULTS.lavishSceneTypes).toEqual(['house_exterior']);
  });

  for (const upload of uploads) {
    it(`plans an abundant ${upload.sceneType} without the mark, localizes it and pastes it back`, async () => {
      const spot: { box?: NormalizedBox } = {};
      const editor = blueSpotEditor(spot, undefined, true);
      const vision = countingVision();
      const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
      const { ownerId, projectId, source } = await createUploadSource(deps, {
        image: await readFile(path.join(SAMPLES, upload.file)),
        fileName: upload.file,
        sceneType: upload.sceneType,
        roomType: upload.roomType,
      });
      const job = await createRenderJobRecord(deps, {
        ownerId,
        projectId,
        source,
        style: 'abundant',
      });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      const plans = await plansOf(job.id);
      expect(plans.map((plan) => [plan.sceneType, plan.style])).toEqual([
        [upload.sceneType, 'abundant'],
      ]);
      // The pack's section has a description; the scene type does not use it.
      const content = await loadContent();
      expect(
        content.packFor('christmas')?.pack.sceneSections[upload.sceneType]?.promptFragments.lavish,
      ).toBeDefined();
      await expectLavish(job.id, false);
      expect(editor.calls[0]?.instructionText).not.toContain(LAVISH_ADDED);
      expect(editor.calls[0]?.instructionText).toContain(', at the ');
      // Localized and pasted back as an ordinary look: the change nobody reported is not kept.
      expect(vision.calls.localize).toBe(1);
      const [attempt] = await attemptsOf(job.id);
      expect(attempt?.compositeMask).toMatchObject({ localization: { status: 'localized' } });
      expect(attempt?.compositeMask).not.toHaveProperty('keep');
      expect(attempt?.fidelityMode).toBe('composite_additive');
      expect(isBlue(await meanColor(await deliveredOf(job.id), spot.box as NormalizedBox))).toBe(
        false,
      );
      const [row] = await judgeRowsOf(attempt?.id as string);
      expect(
        (row?.deterministicChecks as { seam: Record<string, unknown> }).seam,
      ).not.toHaveProperty('skipped');
    });
  }

  it('plans an abundant house exterior with the mark and keeps its whole frame', async () => {
    const spot: { box?: NormalizedBox } = {};
    const editor = blueSpotEditor(spot);
    const vision = countingVision();
    const deps = depsWith({ fixtureImageEditor: editor.editor, fixtureVision: vision.vision });
    const { job } = await streetViewJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [plan] = await plansOf(job.id);
    expect(plan?.sceneType).toBe('house_exterior');
    await expectLavish(job.id);
    expect(editor.calls[0]?.instructionText).toContain(LAVISH_ADDED);
    expect(vision.calls.localize).toBe(0);
    const [attempt] = await attemptsOf(job.id);
    expect(attempt?.compositeMask).toMatchObject({ keep: { area: 'whole_frame' } });
    expect(isBlue(await meanColor(await deliveredOf(job.id), spot.box as NormalizedBox))).toBe(
      true,
    );
  });
});

describe('the provider mask of a lavish request', () => {
  it('is not sent under the tight mask policy, and the attempt says so; a classic request still carries one', async () => {
    const run = async (style: 'abundant' | 'classic') => {
      const editor = recordingEditor();
      const deps = depsWith({
        fixtureImageEditor: editor.editor,
        imageEdit: { providerMask: 'tight' },
      });
      const { job } = await streetViewJob(deps, { style });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      await expectLavish(job.id, style === 'abundant');
      const [attempt] = await attemptsOf(job.id);
      const [plan] = await plansOf(job.id);
      /** The settings hash the compiler records for this attempt's request with or without a mask. */
      const hashWith = (mask: boolean) =>
        `sha256:${sha256Hex(
          stableJson({
            provider: 'fixture',
            modelSnapshot: attempt?.modelSnapshot,
            compilerVersion: plan?.compilerVersion,
            parameters: plan?.compiled.parameters,
            mask,
            referenceOrder: [],
          }),
        )}`;
      return { call: editor.calls[0], attempt, hashWith };
    };
    const lavish = await run('abundant');
    expect(lavish.call).toMatchObject({ kind: 'decorate', mask: false, hasRequestMask: false });
    expect(lavish.attempt?.settingsHash).toBe(lavish.hashWith(false));
    expect(lavish.attempt?.settingsHash).not.toBe(lavish.hashWith(true));

    const classic = await run('classic');
    expect(classic.call).toMatchObject({ kind: 'decorate', mask: true, hasRequestMask: true });
    expect(classic.attempt?.settingsHash).toBe(classic.hashWith(true));
  });
});
