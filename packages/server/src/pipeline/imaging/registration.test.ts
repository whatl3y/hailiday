import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@holiday/core';
import { medianDeltaE } from './checks.js';
import { alignAndComposite, pasteBack } from './composite.js';
import { buildCompositeMask, featherBand, type CompositeMask } from './mask.js';
import { decodeRaster, resizeRaster, toRect, type Raster } from './raster.js';
import {
  alignCandidate,
  maxDisplacement,
  registrationRecord,
  warpRaster,
  type SimilarityTransform,
} from './registration.js';
import { prepareWorkingImage } from './working.js';

const PHOTO = new URL('../../../content/photos/samples/sample-front-porch.jpg', import.meta.url);
const REGION: NormalizedBox = [0.4, 0.3, 0.6, 0.5];

let working: Raster;
let decorated: Raster;
let mask: CompositeMask;

/** The transform that undoes `t` (pure similarity: aspect 1). */
function inverse(t: SimilarityTransform): SimilarityTransform {
  const theta = (-t.rotationDeg * Math.PI) / 180;
  const k = 1 / t.scale;
  // t' = −(1/s) · R(−θ) · t
  const dx = -k * (Math.cos(theta) * t.dx - Math.sin(theta) * t.dy);
  const dy = -k * (Math.sin(theta) * t.dx + Math.cos(theta) * t.dy);
  return { dx, dy, scale: k, rotationDeg: -t.rotationDeg, aspect: 1 };
}

/** What a provider returning a reframed image would deliver: the decorated scene seen through `t`. */
function reframed(t: SimilarityTransform): Raster {
  return warpRaster(decorated, inverse(t), working.width, working.height).raster;
}

/** Mean absolute difference over pixels outside the mask and away from the frame border. */
function outsideDifference(a: Raster, b: Raster, border: number): number {
  let sum = 0;
  let n = 0;
  for (let y = border; y < a.height - border; y += 1) {
    for (let x = border; x < a.width - border; x += 1) {
      const i = y * a.width + x;
      if (mask.hard[i]) continue;
      for (let c = 0; c < 3; c += 1)
        sum += Math.abs((a.data[i * 3 + c] as number) - (b.data[i * 3 + c] as number));
      n += 3;
    }
  }
  return sum / n;
}

beforeAll(async () => {
  const prepared = await prepareWorkingImage(readFileSync(PHOTO), 'upload');
  working = prepared.raster;
  // A bright decoration inside the placement region.
  decorated = { ...working, data: Buffer.from(working.data) };
  const rect = toRect(REGION, working.width, working.height);
  for (let y = rect.y0 + 20; y < rect.y1 - 20; y += 1) {
    for (let x = rect.x0 + 20; x < rect.x1 - 20; x += 1) {
      const p = (y * working.width + x) * 3;
      decorated.data[p] = 200;
      decorated.data[p + 1] = 30;
      decorated.data[p + 2] = 40;
    }
  }
  mask = buildCompositeMask({
    width: working.width,
    height: working.height,
    regions: [REGION],
    dilationFraction: 0.04,
    featherFraction: 0.02,
  });
});

describe('registration before paste-back', () => {
  it('leaves an unchanged candidate untouched (identity, no warp)', async () => {
    const result = await alignCandidate(working, decorated, mask.hard);
    expect(result.record).toMatchObject({ accepted: true, applied: false, dx: 0, dy: 0, scale: 1 });
    expect(result.aligned?.data.equals(decorated.data)).toBe(true);
  });

  const cases: [string, SimilarityTransform][] = [
    ['a shifted candidate', { dx: 14, dy: -9, scale: 1, rotationDeg: 0, aspect: 1 }],
    ['a zoomed candidate', { dx: 0, dy: 0, scale: 0.95, rotationDeg: 0, aspect: 1 }],
    [
      'a zoomed, shifted and slightly rotated candidate',
      { dx: -20, dy: 11, scale: 1.04, rotationDeg: 0.6, aspect: 1 },
    ],
  ];
  for (const [name, truth] of cases) {
    it(`aligns ${name} so no seam remains`, async () => {
      const candidate = reframed(truth);
      const border = Math.ceil(maxDisplacement(truth, working.width, working.height)) + 2;
      const result = await alignCandidate(working, candidate, mask.hard);
      expect(result.record.accepted).toBe(true);
      expect(result.record.applied).toBe(true);
      expect(result.record.dx).toBeCloseTo(truth.dx, 0);
      expect(result.record.dy).toBeCloseTo(truth.dy, 0);
      expect(Math.abs(result.record.scale - truth.scale)).toBeLessThan(0.002);
      expect(Math.abs(result.record.rotationDeg - truth.rotationDeg)).toBeLessThan(0.1);
      const aligned = result.aligned as Raster;
      // Out-of-mask difference: large before alignment; after it, no more than resampling the
      // candidate through the true transform leaves (two bilinear resamplings soften edges).
      const oracle = warpRaster(candidate, truth, working.width, working.height).raster;
      expect(outsideDifference(candidate, working, border)).toBeGreaterThan(8);
      expect(outsideDifference(aligned, working, border)).toBeLessThan(
        outsideDifference(oracle, working, border) + 0.2,
      );
      expect(outsideDifference(aligned, working, border)).toBeLessThan(3);

      // Paste-back: the unaligned candidate leaves a seam; the aligned one does not.
      const band = featherBand(mask);
      const seamBefore = medianDeltaE(working, pasteBack(working, candidate, mask), band);
      const composite = await alignAndComposite({
        working,
        delivered: candidate,
        lightingMode: 'source',
        mask,
        exclude: mask.hard,
        seamDeltaE: 6,
        fallbackPx: 3,
      });
      const seamAfter = medianDeltaE(working, composite.candidate, band);
      expect(seamBefore).toBeGreaterThan(4);
      expect(seamAfter).toBeLessThan(1.5);
      expect(registrationRecord(composite.alignment)).toMatchObject({
        accepted: true,
        applied: true,
      });
    });
  }

  it('resamples a same-aspect output of another size and aligns it', async () => {
    const png = await sharp(decorated.data, {
      raw: { width: working.width, height: working.height, channels: 3 },
    })
      .resize(1264, 848, { fit: 'fill' })
      .png()
      .toBuffer();
    const delivered = await decodeRaster(png);
    const result = await alignCandidate(working, delivered, mask.hard);
    expect(result.record).toMatchObject({
      accepted: true,
      resampledFrom: { width: 1264, height: 848 },
    });
    const aligned = result.aligned as Raster;
    expect([aligned.width, aligned.height]).toEqual([working.width, working.height]);
    // Better than resampling alone, which leaves the resampler's sub-pixel offset in place.
    const resampledOnly = await resizeRaster(delivered, working.width, working.height);
    expect(outsideDifference(aligned, working, 4)).toBeLessThan(
      outsideDifference(resampledOnly, working, 4),
    );
    expect(outsideDifference(aligned, working, 4)).toBeLessThan(3.5);
  });

  it('keeps camera_changed beyond the limits or for another aspect', async () => {
    const zoomed = await alignCandidate(
      working,
      reframed({ dx: 0, dy: 0, scale: 0.86, rotationDeg: 0, aspect: 1 }),
      mask.hard,
    );
    expect(zoomed.aligned).toBeNull();
    expect(zoomed.record).toMatchObject({ accepted: false, reason: 'out_of_range' });

    const far = await alignCandidate(
      working,
      reframed({ dx: 0.09 * working.width, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 }),
      mask.hard,
    );
    expect(far.record.accepted).toBe(false);

    const square = await decodeRaster(
      await sharp(decorated.data, {
        raw: { width: working.width, height: working.height, channels: 3 },
      })
        .resize(1024, 1024, { fit: 'fill' })
        .png()
        .toBuffer(),
    );
    const other = await alignCandidate(working, square, mask.hard);
    expect(other.record).toMatchObject({ accepted: false, reason: 'aspect' });

    const composite = await alignAndComposite({
      working,
      delivered: square,
      lightingMode: 'source',
      mask,
      exclude: mask.hard,
      seamDeltaE: 6,
      fallbackPx: 3,
    });
    expect(composite.alignment.accepted).toBe(false);
    expect(composite.candidate).toBe(square);
  });

  it('rejects an evening output whose warp would leave a deep uncovered strip, keeps a thin one', async () => {
    const evening = (delivered: Raster) =>
      alignAndComposite({
        working,
        delivered,
        lightingMode: 'evening',
        mask: null,
        exclude: mask.hard,
        seamDeltaE: 6,
        fallbackPx: 3,
      });
    // A 31 px shift (seen on a live output): nothing is pasted back in evening, so the warp's
    // 31 px uncovered strip would reach the delivered image.
    const shifted = await evening(reframed({ dx: 31, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 }));
    expect(shifted.alignment).toMatchObject({ accepted: false, reason: 'uncovered' });
    expect(shifted.alignment.uncoveredInsetPx).toBeGreaterThan(30);
    expect(registrationRecord(shifted.alignment)).toMatchObject({ reason: 'uncovered' });
    // The same output in source mode is aligned and pasted back (the strip lies outside the mask).
    const source = await alignAndComposite({
      working,
      delivered: reframed({ dx: 31, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 }),
      lightingMode: 'source',
      mask,
      exclude: mask.hard,
      seamDeltaE: 6,
      fallbackPx: 3,
    });
    expect(source.alignment.accepted).toBe(true);

    // A 2 px shift is warped and kept.
    const thin = await evening(reframed({ dx: 2, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 }));
    expect(thin.alignment).toMatchObject({ accepted: true, applied: true });
    expect(thin.alignment.uncoveredInsetPx).toBeLessThan(3);
  });

  it('fills an uncovered strip by reflection, not by replicating the outermost column', () => {
    const t: SimilarityTransform = { dx: -8, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 };
    const warped = warpRaster(working, t, working.width, working.height);
    expect(warped.uncoveredInsetPx).toBeCloseTo(8, 0);
    expect(warped.uncoveredFraction).toBeCloseTo(8 / working.width, 3);
    // Working column x samples candidate column x − 8; columns 0–7 mirror columns 1–8.
    let replicatedRows = 0;
    for (let y = 0; y < working.height; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const out = (y * working.width + x) * 3;
        const mirrored = (y * working.width + (8 - x)) * 3;
        for (let c = 0; c < 3; c += 1) {
          expect(warped.raster.data[out + c]).toBe(working.data[mirrored + c]);
        }
      }
      const a = y * working.width * 3;
      const b = (y * working.width + 7) * 3;
      if (warped.raster.data[a] === warped.raster.data[b]) replicatedRows += 1;
    }
    // Replication would make the whole strip one value per row.
    expect(replicatedRows).toBeLessThan(working.height * 0.9);
  });
});
