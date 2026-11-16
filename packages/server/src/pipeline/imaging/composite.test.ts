import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { SYNTHETIC_ATTRIBUTION, attributionScene, relitBy } from './attribution.testing.js';
import { medianDeltaE, runDeterministicChecks } from './checks.js';
import { alignAndComposite, edgeSeamDeltaE, pasteBack, photometricAlign } from './composite.js';
import { buildCompositeMask, featherBand, type CompositeMask } from './mask.js';
import { toRect, type Raster } from './raster.js';
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
