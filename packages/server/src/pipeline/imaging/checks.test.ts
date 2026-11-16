import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { attributionStrokes } from './attribution.js';
import { SYNTHETIC_ATTRIBUTION, attributionScene, relitBy } from './attribution.testing.js';
import { laplacianVariance, runDeterministicChecks } from './checks.js';
import { restoreProtectedRectangles } from './composite.js';
import { buildCompositeMask } from './mask.js';
import { shiftRaster, toGray, toRect, type Raster } from './raster.js';
import { relightToBright } from './relight.js';
import { prepareWorkingImage } from './working.js';

const PHOTO = new URL('../../../content/photos/samples/sample-front-porch.jpg', import.meta.url);
/** A protected blur box (a passer-by's face blurred by the uploader). */
const BLUR: NormalizedBox = [0.06, 0.55, 0.2, 0.8];

let sharp: Raster;
let working: Raster;

/** Box blur of a rectangle (radius `r`, three passes), the way a privacy blur softens a face. */
function blurRect(raster: Raster, box: NormalizedBox, r: number): Raster {
  const rect = toRect(box, raster.width, raster.height);
  let data = Buffer.from(raster.data);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = Buffer.from(data);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          let sum = 0;
          let n = 0;
          for (let dy = -r; dy <= r; dy += 1) {
            for (let dx = -r; dx <= r; dx += 1) {
              const yy = Math.min(rect.y1 - 1, Math.max(rect.y0, y + dy));
              const xx = Math.min(rect.x1 - 1, Math.max(rect.x0, x + dx));
              sum += data[(yy * raster.width + xx) * 3 + c] as number;
              n += 1;
            }
          }
          next[(y * raster.width + x) * 3 + c] = Math.round(sum / n);
        }
      }
    }
    data = next;
  }
  return { ...raster, data };
}

/** The evening exposure drop on every pixel (sRGB values scaled). */
function darken(raster: Raster, factor: number): Raster {
  return { ...raster, data: Buffer.from(raster.data.map((v) => Math.round(v * factor))) };
}

beforeAll(async () => {
  sharp = (await prepareWorkingImage(readFileSync(PHOTO), 'upload')).raster;
  working = blurRect(sharp, BLUR, 4);
});

const check = (candidate: Raster) =>
  runDeterministicChecks({
    working,
    raw: candidate,
    candidate,
    requested: { width: working.width, height: working.height },
    lightingMode: 'evening',
    placementRegions: [[0.4, 0.2, 0.6, 0.3]],
    peopleBoxes: [],
    blurRegions: [BLUR],
    houseNumberRegions: [],
    glowRegions: [],
    mask: null,
  });

describe('protected regions under an evening relight', () => {
  it('flags a blurred area reconstructed sharper but darker by the relight', () => {
    // The editor re-synthesized the blurred box with most of its detail and relit the frame.
    const reconstructed = darken(blurRect(sharp, BLUR, 1), 0.35);
    const rect = toRect(BLUR, working.width, working.height);
    // The darker exposure hides much of the new detail from a raw Laplacian variance.
    const lit = laplacianVariance(
      toGray(blurRect(sharp, BLUR, 1)),
      working.width,
      working.height,
      rect,
    );
    const after = laplacianVariance(toGray(reconstructed), working.width, working.height, rect);
    expect(after).toBeLessThan(0.25 * lit);

    const result = check(reconstructed);
    expect(result.codes).toContain('privacy_regression');
    const region = (result.checks.protectedRegions as { regions: Record<string, number>[] })
      .regions[0];
    expect(region?.newEdgeShare).toBeGreaterThan(0.02);
  });

  it('flags a fully sharp reconstruction on the exposure-invariant ratio too', () => {
    const result = check(darken(sharp, 0.35));
    const region = (result.checks.protectedRegions as { regions: Record<string, number>[] })
      .regions[0];
    expect(result.codes).toContain('privacy_regression');
    expect(region?.ratio).toBeGreaterThan(1.2);
  });

  it('passes the same blurred area merely relit', () => {
    for (const factor of [0.35, 0.6]) {
      const result = check(darken(working, factor));
      expect(result.codes, String(factor)).not.toContain('privacy_regression');
      expect(result.checks.protectedRegions, String(factor)).toMatchObject({ passed: true });
    }
  });

  it('passes a box restored verbatim while everything around it is relit (padding)', () => {
    // A flat padding band, copied back byte for byte; the photo next to it turned dark.
    const pad: NormalizedBox = [0, 0, 0.06, 1];
    const rect = toRect(pad, working.width, working.height);
    const flat = (raster: Raster): Raster => {
      const data = Buffer.from(raster.data);
      for (let y = rect.y0; y < rect.y1; y += 1) {
        data.fill(128, (y * raster.width + rect.x0) * 3, (y * raster.width + rect.x1) * 3);
      }
      return { ...raster, data };
    };
    const reference = flat(working);
    const relit = flat(darken(working, 0.35));
    const result = runDeterministicChecks({
      working: reference,
      raw: relit,
      candidate: relit,
      requested: { width: working.width, height: working.height },
      lightingMode: 'evening',
      placementRegions: [[0.4, 0.2, 0.6, 0.3]],
      peopleBoxes: [],
      blurRegions: [pad],
      houseNumberRegions: [],
      glowRegions: [],
      mask: null,
    });
    expect(result.codes).not.toContain('privacy_regression');
    expect(result.checks.protectedRegions).toMatchObject({ passed: true });
  });

  it('applies to people boxes with `people_altered`', () => {
    const result = runDeterministicChecks({
      working,
      raw: darken(sharp, 0.35),
      candidate: darken(sharp, 0.35),
      requested: { width: working.width, height: working.height },
      lightingMode: 'evening',
      placementRegions: [[0.4, 0.2, 0.6, 0.3]],
      peopleBoxes: [BLUR],
      blurRegions: [],
      houseNumberRegions: [],
      glowRegions: [],
      mask: null,
    });
    expect(result.codes).toContain('people_altered');
  });
});

describe('a bright relight against its base', () => {
  const brightCheck = (candidate: Raster, lightingMode: 'bright' | 'evening' = 'bright') =>
    runDeterministicChecks({
      working,
      raw: candidate,
      candidate,
      requested: { width: working.width, height: working.height },
      lightingMode,
      placementRegions: [[0.4, 0.2, 0.6, 0.3]],
      peopleBoxes: [],
      blurRegions: [BLUR],
      houseNumberRegions: [],
      glowRegions: [],
      contentBox: [0, 0.05, 1, 0.95],
      mask: null,
    });

  it('passes the brightened photo: structure kept, blurred area still blurred, brighter', () => {
    const result = brightCheck(relightToBright({ image: working }));
    expect(result.codes).toEqual([]);
    expect(result.decisive).toBeUndefined();
    expect(result.checks.brightness).toMatchObject({ measure: 'median_luma', passed: true });
    const { base, candidate } = result.checks.brightness as { base: number; candidate: number };
    expect(candidate).toBeGreaterThan(base);
  });

  it('refuses a result darker than its base as lighting_implausible, decisively', () => {
    const result = brightCheck(darken(working, 0.8));
    expect(result.codes).toContain('lighting_implausible');
    expect(result.decisive).toEqual(['lighting_implausible']);
    expect(result.checks.brightness).toMatchObject({ passed: false });
  });

  it('runs the brightness check only for the bright look', () => {
    const result = brightCheck(darken(working, 0.8), 'evening');
    expect(result.checks.brightness).toBeUndefined();
    expect(result.codes).not.toContain('lighting_implausible');
  });
});

describe('the attribution rectangles of a relight', () => {
  const scene = attributionScene(1024);
  /** Registration before compositing, as the pipeline records it: the identity, accepted. */
  const identity = {
    dx: 0,
    dy: 0,
    scale: 1,
    rotationDeg: 0,
    score: 1,
    inliers: 500,
    accepted: true,
    applied: false,
  };
  const relit = (gain: readonly [number, number, number] = [0.08, 0.09, 0.19]) =>
    restoreProtectedRectangles({
      candidate: relitBy(scene.ground, gain),
      working: scene.base,
      lightingMode: 'evening',
      attribution: SYNTHETIC_ATTRIBUTION,
    }).candidate;
  const attributionCheck = (
    candidate: Raster,
    lightingMode: 'evening' | 'bright' | 'source' = 'evening',
    working: Raster = scene.base,
  ) =>
    runDeterministicChecks({
      working,
      raw: candidate,
      candidate,
      requested: { width: working.width, height: working.height },
      lightingMode,
      placementRegions: [],
      peopleBoxes: [],
      blurRegions: [],
      houseNumberRegions: [],
      glowRegions: [],
      attributionRegion: SYNTHETIC_ATTRIBUTION,
      mask: null,
      alignment: identity,
    });

  /** The candidate with every pixel of the rectangles changed by `edit` (x, y, rgb). */
  const tamper = (
    candidate: Raster,
    edit: (x: number, y: number, rgb: [number, number, number]) => [number, number, number],
  ): Raster => {
    const data = Buffer.from(candidate.data);
    for (const rect of scene.rects) {
      for (let y = rect.y0; y < rect.y1; y += 1) {
        for (let x = rect.x0; x < rect.x1; x += 1) {
          const p = (y * candidate.width + x) * 3;
          const next = edit(x, y, [data[p]!, data[p + 1]!, data[p + 2]!]);
          data[p] = next[0];
          data[p + 1] = next[1];
          data[p + 2] = next[2];
        }
      }
    }
    return { ...candidate, data };
  };

  it('passes strokes kept over a relit ground (evening and bright) and records each rectangle', () => {
    for (const [mode, gain] of [
      ['evening', [0.08, 0.09, 0.19]],
      ['bright', [1.8, 1.7, 1.5]],
    ] as const) {
      const result = attributionCheck(relit(gain), mode);
      expect(result.codes).not.toContain('attribution_altered');
      const record = result.checks.attribution as {
        passed: boolean;
        regions: { mode: string; share: number; strokeDifference: { mean: number } }[];
      };
      expect(record.passed).toBe(true);
      expect(record.regions.map((region) => region.mode)).toEqual(['adapted', 'adapted']);
      for (const region of record.regions) {
        expect(region.share).toBeGreaterThan(0.04);
        expect(region.strokeDifference.mean).toBe(0);
      }
    }
  });

  it('fails strokes dimmed by 30%, blurred or shifted by 3 px as attribution_altered', () => {
    const good = relit();
    const keeps = SYNTHETIC_ATTRIBUTION.map((box) => attributionStrokes(scene.base, box));
    const strokeAt = (x: number, y: number) =>
      keeps.some(({ rect, keep }) => {
        if (x < rect.x0 || x >= rect.x1 || y < rect.y0 || y >= rect.y1) return false;
        return (keep[(y - rect.y0) * (rect.x1 - rect.x0) + (x - rect.x0)] as number) > 0;
      });
    const dimmed = tamper(good, (x, y, rgb) =>
      strokeAt(x, y) ? (rgb.map((v) => Math.round(v * 0.7)) as [number, number, number]) : rgb,
    );
    const blurredWhole = blurRect(good, [0, 0.9, 1, 1], 1);
    const shifted = shiftRaster(good, 3, 0);
    for (const candidate of [dimmed, blurredWhole, shifted]) {
      const result = attributionCheck(candidate);
      expect(result.codes).toContain('attribution_altered');
      expect(result.checks.attribution).toMatchObject({ passed: false });
    }
    expect(attributionCheck(good).codes).not.toContain('attribution_altered');
  });

  it('applies the SSIM rule where the strokes are not found, and in source mode', () => {
    const white = attributionScene(1024, { ground: 'white' });
    const verbatim = restoreProtectedRectangles({
      candidate: relitBy(white.ground, [0.08, 0.09, 0.19]),
      working: white.base,
      lightingMode: 'evening',
      attribution: [SYNTHETIC_ATTRIBUTION[0]!],
    }).candidate;
    const check = runDeterministicChecks({
      working: white.base,
      raw: verbatim,
      candidate: verbatim,
      requested: { width: 1024, height: 1024 },
      lightingMode: 'evening',
      placementRegions: [],
      peopleBoxes: [],
      blurRegions: [],
      houseNumberRegions: [],
      glowRegions: [],
      attributionRegion: [SYNTHETIC_ATTRIBUTION[0]!],
      mask: null,
      alignment: identity,
    });
    expect(check.checks.attribution).toMatchObject({
      passed: true,
      regions: [{ mode: 'verbatim', strokeDifference: null, ssim: 1, passed: true }],
    });

    // Source mode: the whole rectangle must match (SSIM), so a relit ground fails there.
    const source = attributionCheck(relit(), 'source');
    expect(source.checks.attribution).toHaveProperty('ssim');
    expect(source.checks.attribution).not.toHaveProperty('regions.0.mode');
    expect(source.codes).toContain('attribution_altered');
    expect(attributionCheck(scene.base, 'source').codes).not.toContain('attribution_altered');
  });
});

describe('house numbers a decoration covers (source mode)', () => {
  const left: NormalizedBox = [0.3, 0.4, 0.33, 0.46];
  const right: NormalizedBox = [0.7, 0.4, 0.73, 0.46];
  /** The working image with a dark garland band painted over `box` and its surroundings. */
  const garlandOver = (box: NormalizedBox): Raster => {
    const out = { ...working, data: Buffer.from(working.data) };
    const rect = toRect([box[0] - 0.03, 0.2, box[2] + 0.03, 0.8], out.width, out.height);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        const p = (y * out.width + x) * 3;
        out.data[p] = 25 + ((x * 7 + y * 3) % 40);
        out.data[p + 1] = 70 + ((x * 3 + y * 5) % 50);
        out.data[p + 2] = 30;
      }
    }
    return out;
  };
  const sourceCheck = (
    candidate: Raster,
    houseNumberRegions: NormalizedBox[],
    coveredHouseNumberRegions?: NormalizedBox[],
  ) =>
    runDeterministicChecks({
      working,
      raw: candidate,
      candidate,
      requested: { width: working.width, height: working.height },
      lightingMode: 'source',
      placementRegions: [[0.25, 0.2, 0.38, 0.8]],
      peopleBoxes: [],
      blurRegions: [],
      houseNumberRegions,
      ...(coveredHouseNumberRegions ? { coveredHouseNumberRegions } : {}),
      glowRegions: [],
      mask: buildCompositeMask({
        width: working.width,
        height: working.height,
        regions: [[0.25, 0.2, 0.38, 0.8]],
        dilationFraction: 0.01,
        featherFraction: 0.01,
      }),
    });

  it('does not compare a covered house number and counts it; the others are still compared', () => {
    const candidate = garlandOver(left);
    // Compared, the covered number fails the pixel rule.
    const compared = sourceCheck(candidate, [left, right]);
    expect(compared.codes).toContain('text_added');
    // Covered: not compared, counted; the untouched one is compared and passes.
    const covered = sourceCheck(candidate, [right], [left]);
    expect(covered.codes).not.toContain('text_added');
    expect(covered.checks.textDetection).toMatchObject({
      covered: 1,
      houseNumbers: [{ passed: true }],
    });
    // A changed house number that is not covered still fails.
    const both = garlandOver(right);
    expect(sourceCheck(both, [right], [left]).codes).toContain('text_added');
    expect(sourceCheck(working, [left, right]).checks.textDetection).toMatchObject({
      covered: 0,
    });
  });
});
