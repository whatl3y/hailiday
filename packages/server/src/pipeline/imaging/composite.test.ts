import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { TO_LINEAR, toSrgb } from '../../fixtures/canvas.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import {
  SYNTHETIC_ATTRIBUTION,
  attributionScene,
  burnAttribution,
  relitBy,
} from './attribution.testing.js';
import {
  laplacianVariance,
  medianDeltaE,
  protectedRestoreLevel,
  runDeterministicChecks,
  type RestoredProtectedBox,
} from './checks.js';
import {
  alignAndComposite,
  edgeSeamDeltaE,
  pasteBack,
  photometricAlign,
  restoreProtectedRectangles,
} from './composite.js';
import { buildCompositeMask, featherBand, type CompositeMask } from './mask.js';
import { toGray, toRect, type Raster } from './raster.js';
import type { AlignmentRecord } from './registration.js';
import { prepareWorkingImage } from './working.js';

const PHOTO = new URL('../../../content/photos/samples/sample-front-porch.jpg', import.meta.url);
const REGION: NormalizedBox = [0.4, 0.3, 0.6, 0.5];

let working: Raster;
let mask: CompositeMask;

beforeAll(async () => {
  working = (await prepareWorkingImage(readFileSync(PHOTO), 'upload')).raster;
  mask = buildCompositeMask({
    width: working.width,
    height: working.height,
    regions: [REGION],
    dilationFraction: 0.04,
    featherFraction: 0.02,
  });
});

/** Applies `value × gain + offset` per channel, optionally only where `where(x, y)` holds. */
function toneShift(
  raster: Raster,
  gain: [number, number, number],
  offset: [number, number, number],
  where: (x: number, y: number) => boolean = () => true,
): Raster {
  const data = Buffer.from(raster.data);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (!where(x, y)) continue;
      const p = (y * raster.width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const v = (raster.data[p + c] as number) * gain[c]! + offset[c]!;
        data[p + c] = Math.min(255, Math.max(0, Math.round(v)));
      }
    }
  }
  return { ...raster, data };
}

/** A saturated red decoration inside the placement region. */
function decorate(raster: Raster): Raster {
  const data = Buffer.from(raster.data);
  const rect = toRect(REGION, raster.width, raster.height);
  for (let y = rect.y0 + 20; y < rect.y1 - 20; y += 1) {
    for (let x = rect.x0 + 20; x < rect.x1 - 20; x += 1) {
      const p = (y * raster.width + x) * 3;
      data[p] = 200;
      data[p + 1] = 30;
      data[p + 2] = 40;
    }
  }
  return { ...raster, data };
}

const compose = (delivered: Raster, extra: Partial<Parameters<typeof alignAndComposite>[0]> = {}) =>
  alignAndComposite({
    working,
    delivered,
    lightingMode: 'source',
    mask,
    exclude: mask.hard,
    seamDeltaE: 6,
    fallbackPx: 3,
    ...extra,
  });

describe('photometric alignment before paste-back', () => {
  it('matches an exposure-shifted output so no pasted rectangle shows across the mask edge', async () => {
    // A whole-frame exposure and white-balance shift, the way editors return a brighter frame.
    const delivered = decorate(toneShift(working, [1.16, 1.1, 1.02], [8, 4, -6]));
    const plain = pasteBack(working, delivered, mask);
    expect(edgeSeamDeltaE(working, plain, mask)).toBeGreaterThan(6);
    expect(
      runDeterministicChecks({
        working,
        raw: delivered,
        candidate: plain,
        requested: { width: working.width, height: working.height },
        lightingMode: 'source',
        placementRegions: [REGION],
        peopleBoxes: [],
        blurRegions: [],
        houseNumberRegions: [],
        glowRegions: [],
        mask,
      }).codes,
    ).toContain('implausible_decor');

    const composite = await compose(delivered);
    expect(composite.exposureMatched).toBe(true);
    expect(composite.photometric).toMatchObject({ applied: true });
    expect(composite.photometric?.ringDeltaE).toBeGreaterThan(5);
    expect(composite.photometric?.ringDeltaEAfter).toBeLessThan(1);
    expect(edgeSeamDeltaE(working, composite.candidate, mask)).toBeLessThan(1.5);
    expect(medianDeltaE(working, composite.candidate, featherBand(mask))).toBeLessThan(1.5);
    // The decoration survives (only its tone follows the correction).
    const center = toRect(REGION, working.width, working.height);
    const p = (((center.y0 + center.y1) >> 1) * working.width + ((center.x0 + center.x1) >> 1)) * 3;
    expect(composite.candidate.data[p]).toBeGreaterThan(150);
    expect(composite.candidate.data[p + 1]).toBeLessThan(60);
    // Outside the mask the original stays byte for byte.
    for (let i = 0; i < mask.alpha.length; i += 97) {
      if (mask.alpha[i]) continue;
      expect(composite.candidate.data[i * 3]).toBe(working.data[i * 3]);
    }
  });

  it('follows a local tone shift (one side of the edit brighter than the other)', async () => {
    const split = Math.round(0.44 * working.width);
    const delivered = decorate(toneShift(working, [1, 1, 1], [26, 22, 18], (x) => x >= split));
    expect(edgeSeamDeltaE(working, pasteBack(working, delivered, mask), mask)).toBeGreaterThan(5);
    const composite = await compose(delivered);
    expect(composite.photometric?.applied).toBe(true);
    expect(edgeSeamDeltaE(working, composite.candidate, mask)).toBeLessThan(2);
  });

  it('leaves an output that kept the original tones as it is', async () => {
    const delivered = decorate(working);
    const composite = await compose(delivered);
    expect(composite.photometric).toMatchObject({ applied: false, skipped: 'within_tolerance' });
    expect(composite.candidate.data.equals(pasteBack(working, delivered, mask).data)).toBe(true);
  });

  it('ignores a hole the mask encloses that the editor repainted (structure, not tone)', () => {
    // Two jamb bands with the door between them, which the editor turned dark.
    const jambs = buildCompositeMask({
      width: working.width,
      height: working.height,
      regions: [
        [0.3, 0.2, 0.33, 0.8],
        [0.37, 0.2, 0.4, 0.8],
      ],
      dilationFraction: 0.004,
      featherFraction: 0.004,
    });
    const door = toRect([0.335, 0.22, 0.365, 0.78], working.width, working.height);
    const delivered = toneShift(
      working,
      [0.25, 0.25, 0.25],
      [0, 0, 0],
      (x, y) => x >= door.x0 && x < door.x1 && y >= door.y0 && y < door.y1,
    );
    const aligned = photometricAlign(working, delivered, jambs, {
      ringPx: 46,
      toleranceDeltaE: 1,
    });
    expect(aligned.record).toMatchObject({ applied: false, skipped: 'within_tolerance' });
    expect(edgeSeamDeltaE(working, pasteBack(working, aligned.raster, jambs), jambs)).toBeLessThan(
      1,
    );
  });
});

describe('attribution rectangles', () => {
  it('restores every listed rectangle verbatim in source mode and checks each', async () => {
    const regions: NormalizedBox[] = [
      [0, 0.94, 0.12, 1],
      [0.8, 0.95, 1, 1],
    ];
    // The editor rewrote both corners.
    const delivered = toneShift(working, [0.4, 0.4, 0.4], [90, 90, 90], (x, y) => {
      const fx = x / working.width;
      const fy = y / working.height;
      return fy >= 0.93 && (fx <= 0.13 || fx >= 0.79);
    });
    const composite = await compose(delivered, { attributionRegion: regions });
    expect(composite.attributionRestored).toBe(true);
    expect(composite.attribution).toEqual([
      { mode: 'verbatim', share: null, gain: null },
      { mode: 'verbatim', share: null, gain: null },
    ]);
    for (const box of regions) {
      const rect = toRect(box, working.width, working.height);
      for (let y = rect.y0; y < rect.y1; y += 3) {
        for (let x = rect.x0; x < rect.x1; x += 3) {
          const p = (y * working.width + x) * 3;
          expect(composite.candidate.data[p]).toBe(working.data[p]);
        }
      }
    }
    const base = {
      working,
      raw: delivered,
      requested: { width: working.width, height: working.height },
      lightingMode: 'source' as const,
      placementRegions: [REGION],
      peopleBoxes: [],
      blurRegions: [],
      houseNumberRegions: [],
      glowRegions: [],
      mask,
      attributionRegion: regions,
    };
    const restored = runDeterministicChecks({ ...base, candidate: composite.candidate });
    expect(restored.checks.attribution).toMatchObject({ passed: true });
    expect(restored.codes).not.toContain('attribution_altered');
    // Without restoration the second rectangle alone fails the check.
    const altered = runDeterministicChecks({ ...base, candidate: delivered });
    expect(altered.codes).toContain('attribution_altered');
    expect((altered.checks.attribution as { regions: number[] }).regions).toHaveLength(2);
  });
});

describe('attribution rectangles of a relight', () => {
  it('keeps the strokes over the relit ground and records each rectangle', async () => {
    const scene = attributionScene(1024);
    const delivered = relitBy(scene.ground, [0.08, 0.09, 0.19]);
    const record: AlignmentRecord = {
      dx: 0,
      dy: 0,
      scale: 1,
      rotationDeg: 0,
      score: 1,
      inliers: 500,
      aspect: 1,
      accepted: true,
      applied: false,
      uncoveredFraction: 0,
    };
    const composite = await alignAndComposite({
      working: scene.base,
      delivered,
      lightingMode: 'evening',
      mask: null,
      exclude: null,
      attributionRegion: SYNTHETIC_ATTRIBUTION,
      seamDeltaE: 6,
      fallbackPx: 3,
      registered: { aligned: delivered, record },
    });
    expect(composite.attribution.map((entry) => entry.mode)).toEqual(['adapted', 'adapted']);
    for (const entry of composite.attribution) {
      expect(entry.share).toBeGreaterThan(0.04);
      expect(entry.gain?.[2]).toBeCloseTo(0.19, 2);
    }
    let core = 0;
    for (let i = 0; i < scene.strokeCore.length; i += 1) {
      if (!scene.strokeCore[i]) continue;
      core += 1;
      expect(composite.candidate.data[i * 3]).toBe(scene.base.data[i * 3]);
    }
    expect(core).toBeGreaterThan(500);
    // The ground behind the logo is relit, not the daylight base.
    const logo = scene.rects[0]!;
    const p = ((logo.y0 + 2) * 1024 + logo.x1 - 3) * 3;
    expect(composite.candidate.data[p]).toBeLessThan((scene.base.data[p] as number) / 2);
  });
});

describe('attribution rectangles of a lavish decorate attempt', () => {
  it("are restored the relight's way: strokes kept over the picture's own ground", () => {
    const scene = attributionScene(1024);
    const candidate = relitBy(scene.ground, [1.25, 1.2, 1.1]);
    const relit = restoreProtectedRectangles({
      candidate,
      working: scene.base,
      lightingMode: 'source',
      attribution: SYNTHETIC_ATTRIBUTION,
      relitAttribution: true,
      protectedBoxes: [[0.4, 0.4, 0.5, 0.5]],
    });
    expect(relit.attribution.map((entry) => entry.mode)).toEqual(['adapted', 'adapted']);
    // A decorate attempt never runs the protected restore of a relight.
    expect(relit.protectedRestore).toBeNull();
    const verbatim = restoreProtectedRectangles({
      candidate,
      working: scene.base,
      lightingMode: 'source',
      attribution: SYNTHETIC_ATTRIBUTION,
    });
    expect(verbatim.attribution.map((entry) => entry.mode)).toEqual(['verbatim', 'verbatim']);
  });
});

describe('the protected restore of a relight', () => {
  const W = () => working.width;
  const H = () => working.height;
  const BLURRED: NormalizedBox = [0.06, 0.55, 0.2, 0.8];
  const TEXTURED: NormalizedBox = [0.55, 0.55, 0.65, 0.7];
  const SMOOTH: NormalizedBox = [0.75, 0.1, 0.8, 0.16];

  /** A box blur of a rectangle (radius `r`, two passes), the way a privacy blur softens a face. */
  function blurRect(raster: Raster, box: NormalizedBox, r: number): Raster {
    const rect = toRect(box, raster.width, raster.height);
    let data = Buffer.from(raster.data);
    for (let pass = 0; pass < 2; pass += 1) {
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

  /** A nearly flat patch: one level above the ground on about a quarter of its pixels. */
  function smoothPatch(raster: Raster, box: NormalizedBox): Raster {
    const out = { ...raster, data: Buffer.from(raster.data) };
    const rect = toRect(box, raster.width, raster.height);
    let seed = 7;
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
        const bump = seed / 0x7fffffff < 0.22 ? 1 : 0;
        const p = (y * raster.width + x) * 3;
        out.data[p] = 120 + bump;
        out.data[p + 1] = 118 + bump;
        out.data[p + 2] = 110 + bump;
      }
    }
    return out;
  }

  /** The editor's reconstruction inside a box: a sharp checkerboard. */
  function sharpen(raster: Raster, box: NormalizedBox): Raster {
    const out = { ...raster, data: Buffer.from(raster.data) };
    const rect = toRect(box, raster.width, raster.height);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        const v = ((x >> 1) + (y >> 1)) % 2 === 0 ? 30 : 220;
        out.data.fill(v, (y * raster.width + x) * 3, (y * raster.width + x) * 3 + 3);
      }
    }
    return out;
  }

  let base: Raster;
  beforeAll(() => {
    base = smoothPatch(blurRect(working, BLURRED, 4), SMOOTH);
  });

  const check = (
    candidate: Raster,
    lightingMode: 'evening' | 'bright',
    regions: { people?: NormalizedBox[]; blur?: NormalizedBox[] },
    restored?: readonly RestoredProtectedBox[],
  ) =>
    runDeterministicChecks({
      working: base,
      raw: candidate,
      candidate,
      requested: { width: W(), height: H() },
      lightingMode,
      placementRegions: [],
      peopleBoxes: regions.people ?? [],
      blurRegions: regions.blur ?? [],
      houseNumberRegions: [],
      glowRegions: [],
      mask: null,
      alignment: {
        dx: 0,
        dy: 0,
        scale: 1,
        rotationDeg: 0,
        score: 1,
        inliers: 500,
        accepted: true,
        applied: false,
      },
      lavish: true,
      ...(restored ? { restoredProtected: restored } : {}),
    });
  const regionsOf = (result: ReturnType<typeof check>) =>
    (result.checks.protectedRegions as { regions: Record<string, unknown>[] }).regions;

  it('passes smooth, blurred and textured boxes restored under gains across the clamp range', () => {
    const smooth = toRect(SMOOTH, W(), H());
    const detail = laplacianVariance(toGray(base), W(), H(), smooth);
    // The smooth box sits just under the noise floor of the sharpness measure.
    expect(detail).toBeGreaterThan(3);
    expect(detail).toBeLessThan(4);
    const boxes = [BLURRED, TEXTURED, SMOOTH];
    let failedWithoutRecords = 0;
    for (const gain of [
      [0.03, 0.04, 0.08],
      [0.3, 0.32, 0.4],
      [1, 1, 1],
      [1.8, 1.7, 1.5],
      [3.6, 3.7, 3.9],
    ] as [number, number, number][]) {
      const mode = gain[0] > 1 ? 'bright' : 'evening';
      let candidate = relitBy(base, gain);
      for (const box of boxes) candidate = sharpen(candidate, box);
      // Before the restore the editor's boxes fail.
      expect(check(candidate, mode, { blur: boxes }).codes).toContain('privacy_regression');
      const restored = restoreProtectedRectangles({
        candidate,
        working: base,
        lightingMode: mode,
        attribution: [],
        protectedBoxes: boxes,
      });
      const record = restored.protectedRestore;
      expect(record?.record).toMatchObject({ groups: 3, boxes: 3 });
      expect(record?.record.modes).toEqual(['adapted', 'adapted', 'adapted']);
      for (const [index, applied] of (record?.record.gains ?? []).entries()) {
        for (let c = 0; c < 3; c += 1) {
          // Measured on the relit ring (white clips the brightest gains a little).
          const expected = gain[c] as number;
          expect(
            Math.abs((applied[c] as number) - expected),
            `${gain.join(',')} group ${index}`,
          ).toBeLessThanOrEqual(0.05 * expected + 0.005);
        }
      }
      // Every pixel of a box is the base's under the applied gain.
      const [first] = record?.restored ?? [];
      const rect = toRect(BLURRED, W(), H());
      const p = ((rect.y0 + 3) * W() + rect.x0 + 3) * 3;
      expect(restored.candidate.data[p]).toBe(
        protectedRestoreLevel(base.data[p] as number, first?.gain[0] as number),
      );
      const result = check(restored.candidate, mode, { blur: boxes }, record?.restored);
      expect(result.codes, gain.join(',')).not.toContain('privacy_regression');
      for (const region of regionsOf(result)) {
        expect(region, gain.join(',')).toMatchObject({ restored: true, passed: true });
        expect(region.ratio).toEqual(expect.any(Number));
        if (mode === 'evening') expect(region.newEdgeShare).toEqual(expect.any(Number));
      }
      // Without the records the ratio and edge tests decide, and some restored box fails them.
      const unrecorded = check(restored.candidate, mode, { blur: boxes });
      if (unrecorded.codes.includes('privacy_regression')) failedWithoutRecords += 1;
    }
    expect(failedWithoutRecords).toBeGreaterThan(0);
  });

  it('does not excuse a box sharpened after the restore (a stale record)', () => {
    const gain: [number, number, number] = [0.3, 0.32, 0.4];
    const restored = restoreProtectedRectangles({
      candidate: sharpen(relitBy(base, gain), BLURRED),
      working: base,
      lightingMode: 'evening',
      attribution: [],
      protectedBoxes: [BLURRED],
    });
    const records = restored.protectedRestore?.restored ?? [];
    expect(records).toHaveLength(1);
    const tampered = sharpen(restored.candidate, BLURRED);
    const result = check(tampered, 'evening', { blur: [BLURRED] }, records);
    expect(result.codes).toContain('privacy_regression');
    expect(regionsOf(result)[0]).not.toHaveProperty('restored');
  });

  it('restores a person over a blur region as one group; boxes closer than the feather keep exact interiors', () => {
    const gain: [number, number, number] = [0.25, 0.27, 0.35];
    const person: NormalizedBox = [0.3, 0.3, 0.4, 0.6];
    const face: NormalizedBox = [0.33, 0.28, 0.37, 0.36];
    const left: NormalizedBox = [0.5, 0.1, 0.55, 0.2];
    // Five pixels to the right of the left box: closer than the feather (6 px at 1536).
    const gap = 5 / W();
    const right: NormalizedBox = [left[2] + gap, 0.1, left[2] + gap + 0.05, 0.2];
    let candidate = relitBy(base, gain);
    for (const box of [person, face, left, right]) candidate = sharpen(candidate, box);
    const restored = restoreProtectedRectangles({
      candidate,
      working: base,
      lightingMode: 'evening',
      attribution: [],
      protectedBoxes: [person, face, left, right],
    });
    const record = restored.protectedRestore;
    expect(record?.record).toMatchObject({ groups: 3, boxes: 4 });
    const gains = (record?.restored ?? []).map((entry) => entry.gain);
    expect(gains[0]).toEqual(gains[1]);
    const result = check(
      restored.candidate,
      'evening',
      { people: [person], blur: [face, left, right] },
      record?.restored,
    );
    expect(result.codes).toEqual([]);
    expect(regionsOf(result).map((region) => region.restored)).toEqual([true, true, true, true]);
  });

  it('restores a group whose ring is too small verbatim', () => {
    const whole: NormalizedBox = [0, 0, 1, 1];
    const restored = restoreProtectedRectangles({
      candidate: relitBy(base, [0.3, 0.3, 0.3]),
      working: base,
      lightingMode: 'evening',
      attribution: [],
      protectedBoxes: [whole],
    });
    expect(restored.protectedRestore?.record).toEqual({
      groups: 1,
      boxes: 1,
      gains: [[1, 1, 1]],
      modes: ['verbatim'],
    });
    expect(restored.candidate.data.equals(base.data)).toBe(true);
  });

  it('changes nothing in a relight without people and blur regions', () => {
    const candidate = relitBy(base, [0.3, 0.3, 0.3]);
    const pad: NormalizedBox = [0, 0, 0.05, 1];
    const plain = restoreProtectedRectangles({
      candidate,
      working: base,
      lightingMode: 'evening',
      attribution: [],
      padRegions: [pad],
    });
    for (const protectedBoxes of [[], [pad]]) {
      const restored = restoreProtectedRectangles({
        candidate,
        working: base,
        lightingMode: 'evening',
        attribution: [],
        padRegions: [pad],
        protectedBoxes,
      });
      expect(restored.protectedRestore).toBeNull();
      expect(restored.candidate.data.equals(plain.candidate.data)).toBe(true);
    }
  });

  /** The deterministic checks of a relight of `reference` (identity registration). */
  const checkOn = (
    reference: Raster,
    candidate: Raster,
    blur: NormalizedBox[],
    restored: readonly RestoredProtectedBox[] | undefined,
    attributionRegion: readonly NormalizedBox[] = [],
  ) =>
    runDeterministicChecks({
      working: reference,
      raw: candidate,
      candidate,
      requested: { width: reference.width, height: reference.height },
      lightingMode: 'evening',
      placementRegions: [],
      peopleBoxes: [],
      blurRegions: blur,
      houseNumberRegions: [],
      glowRegions: [],
      mask: null,
      alignment: {
        dx: 0,
        dy: 0,
        scale: 1,
        rotationDeg: 0,
        score: 1,
        inliers: 500,
        accepted: true,
        applied: false,
      },
      attributionRegion,
      ...(restored ? { restoredProtected: restored } : {}),
    });
  const EVENING_GAINS: [number, number, number][] = [
    [0.2, 0.22, 0.3],
    [0.35, 0.36, 0.45],
    [0.5, 0.5, 0.6],
  ];
  /** A synthetic frame whose `plate` is blurred and over which the attribution is burned in. */
  const plateFrame = (plate: NormalizedBox) =>
    burnAttribution(blurRect(attributionScene(1024).ground, plate, 4)).base;

  it('verifies a restored box on its own pixels where an attribution rectangle overlaps it', () => {
    // Half of the plate lies in the copyright label's rectangle.
    const plate: NormalizedBox = [0.86, 0.94, 0.93, 0.985];
    const frame = plateFrame(plate);
    for (const gain of EVENING_GAINS) {
      // The editor only relit the frame.
      const strip = restoreProtectedRectangles({
        candidate: relitBy(frame, gain),
        working: frame,
        lightingMode: 'evening',
        attribution: SYNTHETIC_ATTRIBUTION,
        protectedBoxes: [plate],
      });
      expect(strip.attribution.map((entry) => entry.mode)).toEqual(['adapted', 'adapted']);
      const onStrip = checkOn(
        frame,
        strip.candidate,
        [plate],
        strip.protectedRestore?.restored,
        SYNTHETIC_ATTRIBUTION,
      );
      expect(onStrip.codes, gain.join(',')).toEqual([]);
      expect(regionsOf(onStrip)[0], gain.join(',')).toMatchObject({
        restored: true,
        passed: true,
      });
    }
  });

  it('verifies a restored box on its own pixels where the padding overlaps it', () => {
    // A blurred region reaching 6 px into the padding.
    const pad: NormalizedBox = [0, 0, 0.1, 1];
    const intoPad: NormalizedBox = [0.094, 0.4, 0.2, 0.5];
    const padded = blurRect(attributionScene(1024).ground, intoPad, 4);
    const padRect = toRect(pad, 1024, 1024);
    for (let y = padRect.y0; y < padRect.y1; y += 1)
      padded.data.fill(128, (y * 1024 + padRect.x0) * 3, (y * 1024 + padRect.x1) * 3);
    for (const gain of EVENING_GAINS) {
      const padding = restoreProtectedRectangles({
        candidate: relitBy(padded, gain),
        working: padded,
        lightingMode: 'evening',
        attribution: [],
        padRegions: [pad],
        // The render job lists the padding as a blurred region too.
        protectedBoxes: [intoPad, pad],
      });
      const onPad = checkOn(
        padded,
        padding.candidate,
        [intoPad, pad],
        padding.protectedRestore?.restored,
      );
      expect(onPad.codes, gain.join(',')).toEqual([]);
      expect(regionsOf(onPad)[0], gain.join(',')).toMatchObject({ restored: true, passed: true });
      // The padding itself has no record and passes the ratio test, as before.
      expect(regionsOf(onPad)[1]).not.toHaveProperty('restored');
    }
  });

  it('decides by the ratio a box sharpened outside the strip after the restore, and a box wholly inside an attribution rectangle', () => {
    const gain: [number, number, number] = [0.35, 0.36, 0.45];
    const plate: NormalizedBox = [0.86, 0.94, 0.93, 0.985];
    const frame = plateFrame(plate);
    const restored = restoreProtectedRectangles({
      candidate: relitBy(frame, gain),
      working: frame,
      lightingMode: 'evening',
      attribution: SYNTHETIC_ATTRIBUTION,
      protectedBoxes: [plate],
    });
    const records = restored.protectedRestore?.restored;
    expect(records?.[0]?.restoredAfter).toEqual(SYNTHETIC_ATTRIBUTION);
    // Its pixels above the label's rectangle sharpened after the restore: a stale record.
    const tampered = sharpen(restored.candidate, [0.86, 0.94, 0.93, 0.965]);
    const stale = checkOn(frame, tampered, [plate], records, SYNTHETIC_ATTRIBUTION);
    expect(stale.codes).toContain('privacy_regression');
    expect(regionsOf(stale)[0]).not.toHaveProperty('restored');

    // A box wholly inside the label's rectangle has no pixel of its own restore left.
    const inside: NormalizedBox = [0.86, 0.972, 0.93, 0.995];
    const insideFrame = plateFrame(inside);
    const insideRestored = restoreProtectedRectangles({
      candidate: relitBy(insideFrame, gain),
      working: insideFrame,
      lightingMode: 'evening',
      attribution: SYNTHETIC_ATTRIBUTION,
      protectedBoxes: [inside],
    });
    expect(insideRestored.protectedRestore?.restored).toHaveLength(1);
    const insideResult = checkOn(
      insideFrame,
      insideRestored.candidate,
      [inside],
      insideRestored.protectedRestore?.restored,
      SYNTHETIC_ATTRIBUTION,
    );
    const region = regionsOf(insideResult)[0] as { ratio: number; newEdgeShare: number };
    expect(region).not.toHaveProperty('restored');
    expect(region).toMatchObject({
      passed:
        region.ratio <= PIPELINE_DEFAULTS.checks.protectedSharpnessRatio &&
        region.newEdgeShare <= PIPELINE_DEFAULTS.checks.protectedNewEdgeShare,
    });
  });

  it('runs before the attribution and padding restoration: their strokes and bytes win over a box', () => {
    const scene = attributionScene(1024);
    const pad: NormalizedBox = [0, 0, 1, 0.04];
    const frame: Raster = { ...scene.base, data: Buffer.from(scene.base.data) };
    const padRect = toRect(pad, 1024, 1024);
    for (let y = padRect.y0; y < padRect.y1; y += 1)
      frame.data.fill(128, (y * 1024 + padRect.x0) * 3, (y * 1024 + padRect.x1) * 3);
    const acrossLabel: NormalizedBox = [0.86, 0.94, 0.93, 0.99];
    const acrossPad: NormalizedBox = [0.4, 0.02, 0.5, 0.1];
    let candidate = relitBy(frame, [0.3, 0.32, 0.4]);
    for (const box of [acrossLabel, acrossPad]) candidate = sharpen(candidate, box);
    const restored = restoreProtectedRectangles({
      candidate,
      working: frame,
      lightingMode: 'evening',
      attribution: SYNTHETIC_ATTRIBUTION,
      padRegions: [pad],
      protectedBoxes: [acrossLabel, acrossPad, pad],
    });
    expect(restored.protectedRestore?.record).toMatchObject({ groups: 2, boxes: 2 });
    expect(restored.attribution.map((entry) => entry.mode)).toEqual(['adapted', 'adapted']);
    const same = (x: number, y: number) => {
      const p = (y * 1024 + x) * 3;
      return restored.candidate.data.subarray(p, p + 3).equals(frame.data.subarray(p, p + 3));
    };
    // The label's strokes inside the box are the working image's, byte for byte.
    const label = toRect(acrossLabel, 1024, 1024);
    let strokes = 0;
    for (let y = label.y0; y < label.y1; y += 1) {
      for (let x = label.x0; x < label.x1; x += 1) {
        if (!scene.strokeCore[y * 1024 + x]) continue;
        strokes += 1;
        expect(same(x, y), `stroke ${x},${y}`).toBe(true);
      }
    }
    expect(strokes).toBeGreaterThan(50);
    // The padding inside the other box is the working image's padding.
    const inPad = toRect([acrossPad[0], acrossPad[1], acrossPad[2], pad[3]], 1024, 1024);
    for (let y = inPad.y0; y < inPad.y1; y += 1) {
      for (let x = inPad.x0; x < inPad.x1; x += 1) expect(same(x, y), `pad ${x},${y}`).toBe(true);
    }
  });

  // Each case leaves out of a group's ring more than half of what it would hold.
  describe('the ring the gain is measured on', () => {
    const size = 512;
    const gain: [number, number, number] = [0.3, 0.32, 0.4];
    const px = (x0: number, y0: number, x1: number, y1: number): NormalizedBox => [
      x0 / size,
      y0 / size,
      x1 / size,
      y1 / size,
    ];
    const white = (raster: Raster, box: NormalizedBox) => {
      const out = { ...raster, data: Buffer.from(raster.data) };
      const rect = toRect(box, size, size);
      for (let y = rect.y0; y < rect.y1; y += 1)
        out.data.fill(255, (y * size + rect.x0) * 3, (y * size + rect.x1) * 3);
      return out;
    };
    const expectGain = (applied: [number, number, number] | undefined) => {
      for (let c = 0; c < 3; c += 1) {
        expect(
          Math.abs((applied?.[c] as number) - (gain[c] as number)),
          `channel ${c}`,
        ).toBeLessThanOrEqual(0.05 * (gain[c] as number) + 0.005);
      }
    };

    it('leaves out a white neighbouring protected box of another group', () => {
      const ground = attributionScene(size).ground;
      const box = px(0, 0, 200, 16);
      // Five pixels below the box: its own group once both are grown by 2 px.
      const neighbour = px(0, 21, 300, 80);
      const restored = restoreProtectedRectangles({
        candidate: white(relitBy(ground, gain), neighbour),
        working: ground,
        lightingMode: 'evening',
        attribution: [],
        protectedBoxes: [box, neighbour],
      });
      expect(restored.protectedRestore?.record).toMatchObject({ groups: 2, boxes: 2 });
      expect(restored.protectedRestore?.record.modes[0]).toBe('adapted');
      expectGain(restored.protectedRestore?.record.gains[0]);
    });

    it('leaves out a white attribution rectangle', () => {
      const ground = attributionScene(size).ground;
      const plate = px(200, 466, 216, 490);
      const strip = px(0, 470, 512, 512);
      const restored = restoreProtectedRectangles({
        candidate: white(relitBy(ground, gain), strip),
        working: ground,
        lightingMode: 'evening',
        attribution: [strip],
        protectedBoxes: [plate],
      });
      expect(restored.protectedRestore?.record.modes).toEqual(['adapted']);
      expectGain(restored.protectedRestore?.record.gains[0]);
    });

    it('leaves out white padding', () => {
      const pad = px(0, 0, 110, 512);
      const intoPad = px(100, 200, 112, 216);
      const padded = attributionScene(size).ground;
      const padRect = toRect(pad, size, size);
      for (let y = padRect.y0; y < padRect.y1; y += 1)
        padded.data.fill(128, (y * size + padRect.x0) * 3, (y * size + padRect.x1) * 3);
      const restored = restoreProtectedRectangles({
        candidate: white(relitBy(padded, gain), pad),
        working: padded,
        lightingMode: 'evening',
        attribution: [],
        padRegions: [pad],
        protectedBoxes: [intoPad, pad],
      });
      expect(restored.protectedRestore?.record.modes).toEqual(['adapted']);
      expectGain(restored.protectedRestore?.record.gains[0]);
    });
  });

  it('clamps the gain to [0.02, 4]', () => {
    const dark = attributionScene(512, { groundLuma: 0.25 }).ground;
    const box: NormalizedBox = [0.4, 0.4, 0.5, 0.5];
    for (const [relight, recorded] of [
      [6, 4],
      [0.005, 0.02],
    ] as const) {
      const restored = restoreProtectedRectangles({
        candidate: relitBy(dark, [relight, relight, relight]),
        working: dark,
        lightingMode: relight > 1 ? 'bright' : 'evening',
        attribution: [],
        protectedBoxes: [box],
      });
      expect(restored.protectedRestore?.record).toMatchObject({
        gains: [[recorded, recorded, recorded]],
        modes: ['adapted'],
      });
    }
  });

  describe('around a restored box', () => {
    const size = 512;
    const box: NormalizedBox = [200 / size, 200 / size, 240 / size, 240 / size];
    // The documented feather: max(3 px, 0.4% of the long edge); boxes grow by 2 px.
    const featherPx = Math.max(3, Math.round(0.004 * size));
    const run = () => {
      const ground = attributionScene(size).ground;
      // The editor redrew the box and 6 px around it.
      const around: NormalizedBox = [194 / size, 194 / size, 246 / size, 246 / size];
      const candidate = sharpen(relitBy(ground, [0.3, 0.32, 0.4]), around);
      const restored = restoreProtectedRectangles({
        candidate,
        working: ground,
        lightingMode: 'evening',
        attribution: [],
        protectedBoxes: [box],
      });
      const gain = restored.protectedRestore?.record.gains[0] as [number, number, number];
      const at = (raster: Raster, x: number, y: number) => {
        const p = (y * size + x) * 3;
        return [...raster.data.subarray(p, p + 3)];
      };
      const blend = (x: number, y: number, w: number) => {
        const p = (y * size + x) * 3;
        return [0, 1, 2].map((c) => {
          const scaled = Math.min(
            1,
            (TO_LINEAR[ground.data[p + c] as number] as number) * (gain[c] as number),
          );
          const current = TO_LINEAR[candidate.data[p + c] as number] as number;
          return Math.round(toSrgb(w * scaled + (1 - w) * current));
        });
      };
      const level = (x: number, y: number) => {
        const p = (y * size + x) * 3;
        return [0, 1, 2].map((c) =>
          protectedRestoreLevel(ground.data[p + c] as number, gain[c] as number),
        );
      };
      return { ground, candidate, restored: restored.candidate, at, blend, level };
    };

    it('feathers linearly in linear light from the grown box out to the band width', () => {
      const { candidate, restored, at, blend } = run();
      const rect = toRect(box, size, size);
      const row = (rect.y0 + rect.y1) >> 1;
      const column = (rect.x0 + rect.x1) >> 1;
      for (let d = 1; d <= featherPx; d += 1) {
        const w = (featherPx + 1 - d) / (featherPx + 1);
        // Right of the box, and below it.
        const x = rect.x1 + 2 + d - 1;
        const y = rect.y1 + 2 + d - 1;
        expect(at(restored, x, row), `right d=${d}`).toEqual(blend(x, row, w));
        expect(at(restored, column, y), `below d=${d}`).toEqual(blend(column, y, w));
        expect(at(restored, x, row), `right d=${d}`).not.toEqual(at(candidate, x, row));
      }
      const beyond = rect.x1 + 2 + featherPx;
      expect(at(restored, beyond, row)).toEqual(at(candidate, beyond, row));
      expect(at(restored, column, rect.y1 + 2 + featherPx)).toEqual(
        at(candidate, column, rect.y1 + 2 + featherPx),
      );
    });

    it('restores the box grown by 2 px exactly and blends from the third pixel out', () => {
      const { restored, at, blend, level } = run();
      const rect = toRect(box, size, size);
      const row = (rect.y0 + rect.y1) >> 1;
      for (const x of [rect.x1, rect.x1 + 1, rect.x0 - 1, rect.x0 - 2]) {
        expect(at(restored, x, row), `x=${x}`).toEqual(level(x, row));
      }
      const w = featherPx / (featherPx + 1);
      for (const x of [rect.x1 + 2, rect.x0 - 3]) {
        expect(at(restored, x, row), `x=${x}`).toEqual(blend(x, row, w));
        expect(at(restored, x, row), `x=${x}`).not.toEqual(level(x, row));
      }
    });
  });
});
