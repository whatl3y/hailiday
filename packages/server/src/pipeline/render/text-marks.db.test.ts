import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JudgeResult, NormalizedBox } from '@hailiday/core';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { framedViewOf } from '../../providers/street-view/framing.js';
import type { ImageEditor, Providers, VisionModel } from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { runRenderJob } from './job.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HALLWAY = path.join(here, '../../../content/photos/samples/sample-apartment-hallway.jpg');

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

/** Boxes on the hallway's pale left wall (1536 x 1024 working grid). */
// A door-number plaque 15 x 51 px; its grown box adds 15 px on every side.
const PLAQUE: NormalizedBox = [0.1, 0.5, 0.11, 0.55];
// A garland strand hung straight down the wall, across the plaque and its surroundings.
const STRAND: NormalizedBox = [0.06, 0.25, 0.15, 0.8];
const STRAND_RGB = [40, 96, 52] as const;
const OPEN_HINT =
  'a house number (middle left of the image) keeps the edited pixels: compare its text with image 1';
const PATCH_RGB = [255, 0, 255] as const;

interface Paint {
  box: NormalizedBox;
  rgb: readonly [number, number, number];
}

/** The fixture editor with solid rectangles painted over every decorate output. */
function paintingEditor(paints: readonly Paint[]) {
  const inner = base.providers.fixtures.imageEditor;
  const editor: ImageEditor = {
    ...inner,
    async edit(request, input, options) {
      const outcome = await inner.edit(request, input, options);
      if (outcome.status !== 'completed' || (request.kind ?? 'decorate') !== 'decorate') {
        return outcome;
      }
      const image = await sharp(outcome.image)
        .composite(
          paints.map(({ box, rgb }) => {
            const left = Math.round(box[0] * outcome.width);
            const top = Math.round(box[1] * outcome.height);
            return {
              input: {
                create: {
                  width: Math.round(box[2] * outcome.width) - left,
                  height: Math.round(box[3] * outcome.height) - top,
                  channels: 3 as const,
                  background: { r: rgb[0], g: rgb[1], b: rgb[2] },
                },
              },
              left,
              top,
            };
          }),
        )
        .png()
        .toBuffer();
      return { ...outcome, image, format: 'png' };
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
  return editor;
}

/**
 * The fixture vision model with a house number added to the analysis, decorations added to what
 * the localizer reports, and `text_added` findings on attempt 1 (confident, boxed). It records the
 * judged candidate of every decorate attempt.
 */
function markingVision(o: {
  houseNumber?: NormalizedBox;
  added?: readonly NormalizedBox[];
  textAdded?: readonly NormalizedBox[];
}) {
  const inner = base.providers.fixtures.vision;
  const candidates = new Map<number, Buffer>();
  const hints = new Map<number, string[]>();
  const vision: VisionModel = {
    ...inner,
    async analyzeScene(input, options) {
      const call = await inner.analyzeScene(input, options);
      if (!o.houseNumber) return call;
      return {
        ...call,
        result: {
          ...call.result,
          preserveRegions: [
            ...call.result.preserveRegions,
            { kind: 'house_number', box: o.houseNumber },
          ],
        },
      };
    },
    async localizeAdditions(input, options) {
      const call = await inner.localizeAdditions(input, options);
      return {
        ...call,
        result: {
          ...call.result,
          added: [
            ...call.result.added,
            ...(o.added ?? []).map((box) => ({ label: 'garland', box, placementId: null })),
          ],
        },
      };
    },
    async judge(input, options) {
      const call = await inner.judge(input, options);
      if (input.mode === 'relight') return call;
      const attemptNo = input.plan.attemptNumber;
      if (!input.escalated) {
        candidates.set(attemptNo, Buffer.from(input.candidate.bytes));
        hints.set(attemptNo, [...(input.hints ?? [])]);
      }
      if (attemptNo !== 1 || !o.textAdded?.length) return call;
      const findings: JudgeResult['critical'] = o.textAdded.map((box) => ({
        code: 'text_added',
        confidence: 0.95,
        evidence: 'A number plaque looks altered.',
        box,
      }));
      return {
        ...call,
        result: { ...call.result, critical: [...call.result.critical, ...findings] },
      };
    },
  };
  return { vision, candidates, hints };
}

function depsWith(o: { imageEditor: ImageEditor; vision: VisionModel }): PipelineDeps {
  const providers: Providers = {
    ...base.providers,
    fixtures: { ...base.providers.fixtures, imageEditor: o.imageEditor, vision: o.vision },
  };
  return { ...base, providers } as PipelineDeps;
}

async function hallwayJob(deps: PipelineDeps) {
  const { ownerId, projectId, source } = await createUploadSource(deps, {
    image: await readFile(HALLWAY),
    fileName: 'hallway.jpg',
    sceneType: 'apartment_entry',
    roomType: null,
  });
  return createRenderJobRecord(deps, { ownerId, projectId, source, lightingMode: 'source' });
}

async function attemptsOf(jobId: string) {
  return base.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
}

async function checksOf(attemptId: string) {
  const row = await base.db
    .selectFrom('judgeResults')
    .select(['deterministicChecks', 'criticalCodes'])
    .where('attemptId', '=', attemptId)
    .orderBy('createdAt')
    .executeTakeFirstOrThrow();
  return row;
}

interface Raw {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function decode(bytes: Uint8Array): Promise<Raw> {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function workingOf(jobId: string): Promise<Raw> {
  const object = await base.storage.get('private', keys.working(jobId, 'working.png'));
  if (!object) throw new Error('missing working image');
  return decode(object.body);
}

function pixelsOf(box: NormalizedBox, width: number, height: number): number[] {
  const out: number[] = [];
  for (let y = Math.round(box[1] * height); y < Math.round(box[3] * height); y += 1) {
    for (let x = Math.round(box[0] * width); x < Math.round(box[2] * width); x += 1) {
      out.push(y * width + x);
    }
  }
  return out;
}

/** Mean absolute channel difference of two images inside a box. */
function meanDiff(a: Raw, b: Raw, box: NormalizedBox): number {
  const pixels = pixelsOf(box, a.width, a.height);
  let total = 0;
  for (const i of pixels) {
    for (let c = 0; c < 3; c += 1) {
      total += Math.abs(
        (a.data[i * a.channels + c] as number) - (b.data[i * b.channels + c] as number),
      );
    }
  }
  return total / (pixels.length * 3);
}

/** Mean absolute channel difference of an image from one color inside a box. */
function diffFrom(a: Raw, rgb: readonly number[], box: NormalizedBox): number {
  const pixels = pixelsOf(box, a.width, a.height);
  let total = 0;
  for (const i of pixels) {
    for (let c = 0; c < 3; c += 1) {
      total += Math.abs((a.data[i * a.channels + c] as number) - (rgb[c] as number));
    }
  }
  return total / (pixels.length * 3);
}

/** A box grown by `px` working pixels on every side (1536 x 1024). */
const grownBy = (box: NormalizedBox, px: number): NormalizedBox => [
  box[0] - px / 1536,
  box[1] - px / 1024,
  box[2] + px / 1536,
  box[3] + px / 1024,
];

describe('a text mark that a decoration covers keeps the editor’s pixels', () => {
  it('a garland strand across the plaque: open, not compared, delivered with the strand', async () => {
    const { vision, candidates, hints } = markingVision({ houseNumber: PLAQUE, added: [STRAND] });
    const deps = depsWith({
      imageEditor: paintingEditor([{ box: STRAND, rgb: STRAND_RGB }]),
      vision,
    });
    const job = await hallwayJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([[1, 'succeeded']]);
    const record = attempts[0]?.compositeMask as {
      protectedBoxes: {
        textMarks: { kind: string; box: NormalizedBox; mode: string; changedShare: number }[];
      };
    };
    expect(record.protectedBoxes.textMarks).toHaveLength(1);
    expect(record.protectedBoxes.textMarks[0]).toMatchObject({
      kind: 'house_number',
      box: PLAQUE,
      mode: 'open',
      decorated: true,
    });
    expect(attempts[0]?.compositeMask).toMatchObject({
      protectedBoxes: { tone: { sampled: 'outside_edits' } },
    });
    // The judge is told the plaque keeps the edited pixels.
    expect(hints.get(1)).toContain(OPEN_HINT);
    expect(record.protectedBoxes.textMarks[0]?.changedShare).toBeGreaterThanOrEqual(
      PIPELINE_DEFAULTS.protectedSurround.coveredShare,
    );
    // The deterministic check counts the plaque as covered and finds no added text.
    const checks = await checksOf(attempts[0]?.id as string);
    expect(checks.criticalCodes).not.toContain('text_added');
    expect(checks.deterministicChecks).toMatchObject({
      textDetection: { houseNumbers: [], covered: 1 },
    });
    // The delivered candidate holds the strand across the plaque, not a pasted window of wall.
    const candidate = await decode(candidates.get(1) as Buffer);
    const working = await workingOf(job.id);
    expect(diffFrom(candidate, STRAND_RGB, grownBy(PLAQUE, 15))).toBeLessThan(4);
    expect(meanDiff(candidate, working, PLAQUE)).toBeGreaterThan(30);
  });

  it('a number redrawn inside its own box, surroundings untouched: grown, the original is kept', async () => {
    // The localizer reports a decoration around the plaque, so only the exclusion keeps it.
    const around: NormalizedBox = [0.07, 0.42, 0.14, 0.63];
    const { vision, candidates, hints } = markingVision({ houseNumber: PLAQUE, added: [around] });
    const deps = depsWith({
      imageEditor: paintingEditor([{ box: PLAQUE, rgb: PATCH_RGB }]),
      vision,
    });
    const job = await hallwayJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([[1, 'succeeded']]);
    expect(attempts[0]?.compositeMask).toMatchObject({
      protectedBoxes: {
        textMarks: [{ kind: 'house_number', box: PLAQUE, mode: 'grown', decorated: true }],
      },
    });
    // No mark is open, so the judge gets no such hint.
    expect(hints.get(1)?.some((hint) => hint.includes('keeps the edited pixels'))).toBe(false);
    const record = attempts[0]?.compositeMask as {
      protectedBoxes: { textMarks: { changedShare: number }[] };
    };
    expect(record.protectedBoxes.textMarks[0]?.changedShare).toBeLessThan(
      PIPELINE_DEFAULTS.protectedSurround.cleanShare,
    );
    const checks = await checksOf(attempts[0]?.id as string);
    expect(checks.deterministicChecks).toMatchObject({
      textDetection: { houseNumbers: [{ passed: true }], covered: 0 },
    });
    // The candidate (JPEG) equals the original across the grown box.
    const candidate = await decode(candidates.get(1) as Buffer);
    const working = await workingOf(job.id);
    expect(meanDiff(candidate, working, grownBy(PLAQUE, 15))).toBeLessThan(2);
  });

  it('a repair whose judge box lies in a painted strand skips that restore box and applies one on a plain wall', async () => {
    // The judge's box on the strand, and a second one on the plain wall left of it where the
    // editor painted a patch inside a decoration the localizer reported.
    const onStrand: NormalizedBox = [0.095, 0.45, 0.115, 0.5];
    const onWall: NormalizedBox = [0.02, 0.4, 0.035, 0.45];
    const lantern: NormalizedBox = [0.005, 0.37, 0.05, 0.48];
    const { vision, candidates } = markingVision({
      added: [STRAND, lantern],
      textAdded: [onStrand, onWall],
    });
    const deps = depsWith({
      imageEditor: paintingEditor([
        { box: STRAND, rgb: STRAND_RGB },
        { box: onWall, rgb: PATCH_RGB },
      ]),
      vision,
    });
    const job = await hallwayJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
    ]);
    // The repair planned both boxes, and the mask sent to the editor excludes both.
    expect(attempts[1]?.compositeMask).toMatchObject({ restoreBoxes: [onStrand, onWall] });
    const record = attempts[1]?.compositeMask as {
      protectedBoxes: {
        restoreBoxes: { box: NormalizedBox; applied: boolean; changedShare: number }[];
      };
    };
    expect(record.protectedBoxes.restoreBoxes.map((b) => [b.box, b.applied])).toEqual([
      [onStrand, false],
      [onWall, true],
    ]);
    expect(record.protectedBoxes.restoreBoxes[0]?.changedShare).toBeGreaterThanOrEqual(
      PIPELINE_DEFAULTS.protectedSurround.coveredShare,
    );
    expect(record.protectedBoxes.restoreBoxes[1]?.changedShare).toBeLessThan(
      PIPELINE_DEFAULTS.protectedSurround.coveredShare,
    );
    const object = await base.storage.get('private', keys.working(job.id, 'mask-2.png'));
    const mask2 = await sharp(object?.body).greyscale().raw().toBuffer({ resolveWithObject: true });
    for (const box of [onStrand, onWall]) {
      expect(
        pixelsOf(box, mask2.info.width, mask2.info.height).every((i) => mask2.data[i] === 0),
      ).toBe(true);
    }
    // The repaired candidate keeps the strand in the skipped box (no window of wall cut into
    // it) and the original in the applied one; attempt 1 kept the patch there.
    const working = await workingOf(job.id);
    const first = await decode(candidates.get(1) as Buffer);
    const second = await decode(candidates.get(2) as Buffer);
    expect(diffFrom(second, STRAND_RGB, onStrand)).toBeLessThan(4);
    expect(meanDiff(first, working, onWall)).toBeGreaterThan(60);
    expect(meanDiff(second, working, onWall)).toBeLessThan(2);
  });

  it('a plate the editor redrew beyond its box with no decoration on it keeps the original digits', async () => {
    // A plaque inside the plan mask's dilation, right of the planned lanterns and potted tree
    // (localized up to x 0.764), with no decoration on its grown box; the editor redraws the
    // plate 8 px wider on every side (into its ring).
    const plaque: NormalizedBox = [0.775, 0.75, 0.785, 0.8];
    const plate = grownBy(plaque, 8);
    const { vision, candidates, hints } = markingVision({ houseNumber: plaque });
    const deps = depsWith({
      imageEditor: paintingEditor([{ box: plate, rgb: PATCH_RGB }]),
      vision,
    });
    const job = await hallwayJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([[1, 'succeeded']]);
    const record = attempts[0]?.compositeMask as {
      protectedBoxes: {
        textMarks: { mode: string; changedShare: number; decorated: boolean }[];
      };
    };
    expect(record.protectedBoxes.textMarks).toEqual([
      expect.objectContaining({
        kind: 'house_number',
        box: plaque,
        mode: 'exact',
        decorated: false,
      }),
    ]);
    expect(record.protectedBoxes.textMarks[0]?.changedShare).toBeGreaterThanOrEqual(
      PIPELINE_DEFAULTS.protectedSurround.coveredShare,
    );
    // The number is compared and passes; nothing is open, so the judge gets no open-mark hint.
    const checks = await checksOf(attempts[0]?.id as string);
    expect(checks.deterministicChecks).toMatchObject({
      textDetection: { houseNumbers: [{ passed: true }], covered: 0 },
    });
    expect(hints.get(1)?.some((hint) => hint.includes('keeps the edited pixels'))).toBe(false);
    // The candidate keeps the original digits in the analysis box, while the plan mask keeps
    // (part of) the editor's redrawn plate in the ring around it.
    const candidate = await decode(candidates.get(1) as Buffer);
    const working = await workingOf(job.id);
    expect(meanDiff(candidate, working, plaque)).toBeLessThan(2);
    const left: NormalizedBox = [plate[0], plaque[1], plaque[0] - 2 / 1536, plaque[3]];
    expect(meanDiff(candidate, working, left)).toBeGreaterThan(60);
  });
});

describe('a house number on a street photo is never left to the editor', () => {
  // A street photo whose home fills the frame (1024 x 1024 working grid, no padding). The
  // number sits on the shingled wall right of the porch; a garland strand is painted across it
  // and its surroundings, and the localizer reports the strand over the whole number.
  const PLACE = 'ChIJfxLanternHillColonial01';
  const NUMBER: NormalizedBox = [0.85, 0.44, 0.865, 0.49];
  const GARLAND: NormalizedBox = [0.81, 0.4, 0.91, 0.54];
  const GARLAND_RGB = [200, 30, 160] as const;

  async function decorated(kind: 'street_view' | 'upload') {
    const { vision, candidates } = markingVision({ houseNumber: NUMBER, added: [GARLAND] });
    const deps = depsWith({
      imageEditor: paintingEditor([{ box: GARLAND, rgb: GARLAND_RGB }]),
      vision,
    });
    const street = await createStreetViewSource(deps, {
      placeId: PLACE,
      streetViewMode: 'persist',
    });
    let job;
    if (kind === 'street_view') {
      job = await createRenderJobRecord(deps, { ...street, lightingMode: 'source' });
    } else {
      // The same frame, uploaded.
      const frame = await renderFixturePanorama(framedViewOf(street.source.viewpoint!));
      const upload = await createUploadSource(deps, {
        image: frame!.image,
        sceneType: 'house_exterior',
      });
      job = await createRenderJobRecord(deps, { ...upload, lightingMode: 'source' });
    }
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.outcome])).toEqual([[1, 'succeeded']]);
    const record = attempts[0]?.compositeMask as {
      protectedBoxes: {
        textMarks: { kind: string; box: NormalizedBox; mode: string; changedShare: number }[];
      };
    };
    const candidate = await decode(candidates.get(1) as Buffer);
    const working = await workingOf(job.id);
    expect(working.width).toBe(1024);
    expect(working.height).toBe(1024);
    const mark = record.protectedBoxes.textMarks.find((m) => m.kind === 'house_number');
    return { mark, candidate, working, attempt: attempts[0] };
  }

  it('a decoration laid over the number on a street photo: exact, the original digits delivered', async () => {
    const { mark, candidate, working, attempt } = await decorated('street_view');
    expect(mark).toMatchObject({
      kind: 'house_number',
      box: NUMBER,
      mode: 'exact',
      decorated: true,
    });
    expect(mark?.changedShare).toBeGreaterThanOrEqual(
      PIPELINE_DEFAULTS.protectedSurround.coveredShare,
    );
    // The delivered pixels in the number's box are the working image's; the garland stays around.
    const at = (box: NormalizedBox) => meanDiff(candidate, working, box);
    expect(at(NUMBER)).toBeLessThan(2);
    expect(diffFrom(candidate, GARLAND_RGB, [0.815, 0.405, 0.835, 0.43])).toBeLessThan(4);
    const checks = await checksOf(attempt?.id as string);
    expect(checks.deterministicChecks).toMatchObject({
      textDetection: { houseNumbers: [{ passed: true }], covered: 0 },
    });
  });

  it('the same scene uploaded: open, the editor’s pixels delivered', async () => {
    const { mark, candidate, working } = await decorated('upload');
    expect(mark).toMatchObject({
      kind: 'house_number',
      box: NUMBER,
      mode: 'open',
      decorated: true,
    });
    expect(diffFrom(candidate, GARLAND_RGB, NUMBER)).toBeLessThan(4);
    expect(meanDiff(candidate, working, NUMBER)).toBeGreaterThan(30);
  });
});
