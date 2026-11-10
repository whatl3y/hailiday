import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@holiday/core';
import { laplacianVariance, runDeterministicChecks } from './checks.js';
import { toGray, toRect, type Raster } from './raster.js';
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
