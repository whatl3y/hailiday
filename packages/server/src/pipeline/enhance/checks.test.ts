import { describe, expect, it } from 'vitest';
import type { NormalizedBox, SceneAnalysis } from '@hailiday/core';
import {
  SYNTHETIC_ATTRIBUTION,
  attributionScene,
  paintRect,
} from '../imaging/attribution.testing.js';
import { enhanceDeterministic, protectedCoverage } from '../imaging/enhancement.js';
import {
  checksumOf,
  copyRect,
  encodeJpeg,
  encodePng,
  shiftRaster,
  toRect,
  type Raster,
} from '../imaging/raster.js';
import type { WorkingImage } from '../imaging/working.js';
import { textMarkExclusions } from '../render/mask.js';
import {
  enhanceJudgePreserve,
  enhanceProtectedBoxes,
  restoreAndCheckEnhancement,
} from './checks.js';

const SIZE = 1024;
const ATTRIBUTION = [...SYNTHETIC_ATTRIBUTION];
const PLATE: NormalizedBox = [0.62, 0.3, 0.7, 0.35];
const HOUSE_NUMBER: NormalizedBox = [0.3, 0.3, 0.36, 0.34];

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x + seed, 73_856_093) ^ Math.imul(y, 19_349_663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177) >>> 0;
  return (h >>> 8) / 16_777_216;
}

/** Box blur of radius 1 per channel. */
function soften(raster: Raster): Raster {
  return enhanceDeterministic(raster, { unsharpAmount: -1, curve: 0 });
}

/** Low-frequency structure and fine texture, softened once like an upscaled frame. */
function streetTexture(seed: number): Raster {
  const data = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const base =
        120 +
        40 * Math.sin(x / 15 + seed) * Math.cos(y / 21) +
        25 * Math.sin((x + 2 * y) / 31 + seed * 2);
      const noise = (hash(x, y, seed) - 0.5) * 50;
      const p = (y * SIZE + x) * 3;
      data[p] = Math.max(0, Math.min(255, Math.round(base + noise + 4)));
      data[p + 1] = Math.max(0, Math.min(255, Math.round(base + noise)));
      data[p + 2] = Math.max(0, Math.min(255, Math.round(base + noise - 6)));
    }
  }
  return soften({ data, width: SIZE, height: SIZE });
}

/** Dark digit-like bars on a light plate inside `box`; `variant` draws other glyphs. */
function paintHouseNumber(raster: Raster, box: NormalizedBox, variant: number): void {
  const rect = toRect(box, SIZE, SIZE);
  paintRect(raster, rect.x0, rect.y0, rect.x1, rect.y1, [228, 224, 214]);
  const glyphs = 3;
  const width = Math.floor((rect.x1 - rect.x0) / glyphs);
  for (let g = 0; g < glyphs; g += 1) {
    const x0 = rect.x0 + g * width + 4;
    const x1 = x0 + width - 8;
    const top = rect.y0 + 5;
    const bottom = rect.y1 - 5;
    paintRect(raster, x0, top, x0 + 4, bottom, [30, 30, 34]);
    if ((g + variant) % 2 === 0) paintRect(raster, x0, top, x1, top + 4, [30, 30, 34]);
    if ((g + variant) % 3 === 0) paintRect(raster, x1 - 4, top, x1, bottom, [30, 30, 34]);
    paintRect(raster, x0, bottom - 4, x1, bottom, [30, 30, 34]);
  }
}

/** Blurs a box heavily (a blurred plate). */
function blurBox(raster: Raster, box: NormalizedBox): Raster {
  let blurred = raster;
  for (let pass = 0; pass < 8; pass += 1) blurred = soften(blurred);
  const out = { ...raster, data: Buffer.from(raster.data) };
  copyRect(out, blurred, toRect(box, SIZE, SIZE));
  return out;
}

const scene = attributionScene(SIZE);

/**
 * The Street View frame: street texture, a heavily blurred plate, a house number, and the burned-in
 * logo and copyright label in their rectangles.
 */
function makeFrame(): Raster {
  const frame = blurBox(streetTexture(1), PLATE);
  paintHouseNumber(frame, HOUSE_NUMBER, 0);
  for (const rect of scene.rects) copyRect(frame, scene.base, rect);
  return frame;
}

const frameRaster = makeFrame();

async function workingOf(raster: Raster): Promise<WorkingImage> {
  const png = await encodePng(raster);
  return {
    raster,
    png,
    checksum: checksumOf(png),
    width: SIZE,
    height: SIZE,
    nativeWidth: 640,
    nativeHeight: 640,
    resampler: 'lanczos3',
    scaleFactor: 1.6,
    cropBox: null,
    contentBox: null,
    padRegions: [],
  };
}

const frame = await workingOf(frameRaster);

const analysis: Pick<SceneAnalysis, 'peopleBoxes' | 'protectedBlurRegions' | 'preserveRegions'> = {
  peopleBoxes: [],
  protectedBlurRegions: [{ kind: 'plate', box: PLATE }],
  preserveRegions: [
    { kind: 'house_number', box: HOUSE_NUMBER },
    // The burned-in logo recorded as a logo: left to the attribution restore.
    { kind: 'logo', box: [0.01, 0.96, 0.09, 0.995] },
    { kind: 'vehicle', box: [0.7, 0.6, 0.9, 0.75] },
  ],
};

/**
 * What a good enhancement looks like, with the editor's habits: the scene sharpened and re-toned,
 * the blurred plate sharpened, the house number redrawn with other glyphs, and Google's corner
 * marks removed.
 */
function enhancedCandidate(): Raster {
  const candidate = enhanceDeterministic(frameRaster);
  copyRect(candidate, enhanceDeterministic(streetTexture(1)), toRect(PLATE, SIZE, SIZE));
  paintHouseNumber(candidate, HOUSE_NUMBER, 1);
  const ground = enhanceDeterministic(scene.ground);
  for (const rect of scene.rects) copyRect(candidate, ground, rect);
  return candidate;
}

async function jpeg(raster: Raster): Promise<Buffer> {
  return encodeJpeg(raster, { quality: 92 });
}

describe('the protected boxes of an enhancement', () => {
  it('lists people, blur and grown text marks, leaving a logo inside an attribution rectangle out', () => {
    const boxes = enhanceProtectedBoxes({
      analysis: {
        ...analysis,
        peopleBoxes: [[0.1, 0.4, 0.16, 0.7]],
        preserveRegions: [
          ...analysis.preserveRegions,
          { kind: 'sign', box: [0.5, 0.1, 0.6, 0.15] },
          // Less than half of this sign lies inside the label's rectangle.
          { kind: 'sign', box: [0.7, 0.9, 0.85, 0.99] },
        ],
      },
      attributionRegions: ATTRIBUTION,
      width: SIZE,
      height: SIZE,
    });
    expect(boxes.people).toEqual([[0.1, 0.4, 0.16, 0.7]]);
    expect(boxes.blur).toEqual([PLATE]);
    expect(boxes.textMarks).toEqual([HOUSE_NUMBER, [0.5, 0.1, 0.6, 0.15], [0.7, 0.9, 0.85, 0.99]]);
    const grown = textMarkExclusions(
      {
        preserveRegions: [
          { kind: 'house_number', box: HOUSE_NUMBER },
          { kind: 'sign', box: [0.5, 0.1, 0.6, 0.15] },
          { kind: 'sign', box: [0.7, 0.9, 0.85, 0.99] },
        ],
      },
      SIZE,
      SIZE,
    );
    expect(boxes.paste).toEqual([[0.1, 0.4, 0.16, 0.7], PLATE, ...grown]);
    const house = grown[0]!;
    expect(house[0]).toBeLessThan(HOUSE_NUMBER[0]);
    expect(house[2]).toBeGreaterThan(HOUSE_NUMBER[2]);
    expect(boxes.coverage).toBeCloseTo(protectedCoverage(boxes.paste, SIZE, SIZE), 4);
    expect(boxes.coverage).toBeGreaterThan(0.03);
  });

  it('gives the judge every spot with the attribution rectangles', () => {
    const preserve = enhanceJudgePreserve(analysis, ATTRIBUTION);
    expect(preserve).toEqual({
      regions: analysis.preserveRegions,
      protectedBlurRegions: analysis.protectedBlurRegions,
      peopleBoxes: [],
      attributionRegions: ATTRIBUTION,
    });
  });
});

describe('restoring and checking an enhancement', () => {
  it('passes a sharpened copy and gives back the plate, the house number and the marks', async () => {
    const result = await restoreAndCheckEnhancement({
      frame,
      rawBytes: await jpeg(enhancedCandidate()),
      analysis,
      attributionRegions: ATTRIBUTION,
    });
    expect(result.codes).toEqual([]);
    expect(result.alignment.accepted).toBe(true);
    expect(result.candidate).not.toBeNull();
    const checks = result.checks as {
      attribution: { mode: string }[];
      deterministic: {
        attribution: { passed: boolean };
        protectedRegions: { passed: boolean };
        edgeAgreement: { passed: boolean };
      };
      tileCorrelation: { passed: boolean; tiles: number };
      textMarks: { passed: boolean }[];
      protected: { boxes: NormalizedBox[]; coverage: number };
    };
    expect(checks.attribution.map((record) => record.mode)).toEqual(['adapted', 'adapted']);
    expect(checks.deterministic.attribution.passed).toBe(true);
    expect(checks.deterministic.protectedRegions.passed).toBe(true);
    expect(checks.deterministic.edgeAgreement.passed).toBe(true);
    expect(checks.tileCorrelation.passed).toBe(true);
    expect(checks.tileCorrelation.tiles).toBeGreaterThan(20);
    expect(checks.textMarks).toHaveLength(1);
    expect(checks.textMarks[0]?.passed).toBe(true);
    expect(checks.protected.boxes).toHaveLength(2);
    // The attribution strokes are the frame's own, byte for byte.
    const candidate = result.candidate as Raster;
    let strokes = 0;
    let equal = 0;
    for (let i = 0; i < scene.strokeCore.length; i += 1) {
      if (!scene.strokeCore[i]) continue;
      strokes += 1;
      if (
        candidate.data[i * 3] === frameRaster.data[i * 3] &&
        candidate.data[i * 3 + 1] === frameRaster.data[i * 3 + 1] &&
        candidate.data[i * 3 + 2] === frameRaster.data[i * 3 + 2]
      ) {
        equal += 1;
      }
    }
    expect(strokes).toBeGreaterThan(100);
    expect(equal / strokes).toBeGreaterThan(0.95);
  });

  it('rejects an output shifted beyond the registration limits as camera_changed', async () => {
    const result = await restoreAndCheckEnhancement({
      frame,
      rawBytes: await jpeg(shiftRaster(enhancedCandidate(), 90, 0)),
      analysis,
      attributionRegions: ATTRIBUTION,
    });
    expect(result.codes).toEqual(['camera_changed']);
    expect(result.candidate).toBeNull();
    expect(result.alignment.accepted).toBe(false);
  });

  it('rejects an output with a replaced area as structure_changed', async () => {
    const candidate = enhancedCandidate();
    const replaced = { ...candidate, data: Buffer.from(candidate.data) };
    const source = toRect([0.1, 0.55, 0.28, 0.73], SIZE, SIZE);
    const side = source.x1 - source.x0;
    for (let y = 0; y < side; y += 1) {
      const from = ((source.y0 + y) * SIZE + source.x0) * 3;
      candidate.data.copy(replaced.data, ((480 + y) * SIZE + 500) * 3, from, from + side * 3);
    }
    const rawBytes = await jpeg(replaced);
    const result = await restoreAndCheckEnhancement({
      frame,
      rawBytes,
      analysis,
      attributionRegions: ATTRIBUTION,
    });
    expect(result.codes).toEqual(['structure_changed']);
    const tiles = result.checks.tileCorrelation as { passed: boolean; min: number };
    expect(tiles.passed).toBe(false);
    expect(tiles.min).toBeLessThan(0.35);
    // Without the tile check nothing else sees the replaced area.
    const unchecked = await restoreAndCheckEnhancement({
      frame,
      rawBytes,
      analysis,
      attributionRegions: ATTRIBUTION,
      skip: { tiles: true },
    });
    expect(unchecked.codes).toEqual([]);
  });

  it('needs the paste for the plate and the house number, and the restore for the marks', async () => {
    const rawBytes = await jpeg(enhancedCandidate());
    const withoutPaste = await restoreAndCheckEnhancement({
      frame,
      rawBytes,
      analysis,
      attributionRegions: ATTRIBUTION,
      skip: { paste: true },
    });
    expect(withoutPaste.codes).toContain('privacy_regression');
    expect(withoutPaste.codes).toContain('text_added');
    expect(withoutPaste.codes).not.toContain('attribution_altered');
    const withoutRestore = await restoreAndCheckEnhancement({
      frame,
      rawBytes,
      analysis,
      attributionRegions: ATTRIBUTION,
      skip: { attribution: true },
    });
    expect(withoutRestore.codes).toEqual(['attribution_altered']);
  });

  it('throws only when the output does not decode', async () => {
    await expect(
      restoreAndCheckEnhancement({
        frame,
        rawBytes: new Uint8Array([1, 2, 3, 4]),
        analysis,
        attributionRegions: ATTRIBUTION,
      }),
    ).rejects.toThrow();
  });
});
