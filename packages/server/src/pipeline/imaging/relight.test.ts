import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@holiday/core';
import { gradientMagnitude } from './checks.js';
import { toGray, toRect, type Raster } from './raster.js';
import { relightSourceToEvening } from './relight.js';
import { prepareWorkingImage } from './working.js';

const PHOTO = new URL('../../../content/photos/samples/sample-front-porch.jpg', import.meta.url);
/** The band the string lights run along, and a window and the attribution corner. */
const BAND: NormalizedBox = [0.2, 0.3, 0.8, 0.34];
const WINDOW: NormalizedBox = [0.62, 0.45, 0.72, 0.62];
const CREDIT: NormalizedBox = [0.82, 0.95, 1, 1];

let working: Raster;
let composite: Raster;
let band: Uint8Array;
const bulbs: [number, number][] = [];

const luma = (r: Raster, x: number, y: number) => {
  const p = (y * r.width + x) * 3;
  return 0.299 * r.data[p]! + 0.587 * r.data[p + 1]! + 0.114 * r.data[p + 2]!;
};

/** Mean luma over a rectangle. */
function meanLuma(r: Raster, box: NormalizedBox): number {
  const rect = toRect(box, r.width, r.height);
  let sum = 0;
  let n = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      sum += luma(r, x, y);
      n += 1;
    }
  }
  return sum / n;
}

beforeAll(async () => {
  working = (await prepareWorkingImage(readFileSync(PHOTO), 'upload')).raster;
  // The accepted source composite: warm bulbs (3 × 3 px) every 24 px along the band.
  composite = { ...working, data: Buffer.from(working.data) };
  const rect = toRect(BAND, working.width, working.height);
  const y = (rect.y0 + rect.y1) >> 1;
  for (let x = rect.x0 + 6; x < rect.x1 - 6; x += 24) {
    bulbs.push([x, y]);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const p = ((y + dy) * working.width + x + dx) * 3;
        composite.data[p] = 255;
        composite.data[p + 1] = 236;
        composite.data[p + 2] = 190;
      }
    }
  }
  band = new Uint8Array(working.width * working.height);
  for (let yy = rect.y0; yy < rect.y1; yy += 1) {
    band.fill(255, yy * working.width + rect.x0, yy * working.width + rect.x1);
  }
});

const relight = (decorationMask: Uint8Array | null) =>
  relightSourceToEvening({
    composite,
    working,
    interior: false,
    targetFacade: [0.05, 0.25, 0.95, 0.95],
    windows: [WINDOW],
    decorationMask,
    seed: 'variant-1',
    restore: [CREDIT],
  });

describe('deterministic evening relight of a source composite', () => {
  it('darkens the scene, keeps the decoration lights lit and blooms them', () => {
    const evening = relight(band);
    const raster = evening.raster;
    expect(evening.emitterPixels).toBeGreaterThanOrEqual(bulbs.length * 9 * 0.8);
    // The scene drops well below its daylight exposure.
    expect(meanLuma(raster, [0, 0.4, 1, 0.9])).toBeLessThan(
      meanLuma(working, [0, 0.4, 1, 0.9]) * 0.5,
    );
    // Every bulb stays bright.
    // Every bulb that adds light to its background stays bright (a bulb on an already white
    // wall is indistinguishable from it and dims with the wall).
    const visible = bulbs.filter(([x, y]) => luma(working, x, y) < 200);
    expect(visible.length).toBeGreaterThan(bulbs.length * 0.9);
    for (const [x, y] of visible) expect(luma(raster, x, y)).toBeGreaterThan(200);
    // Bloom: just beside the bulbs the relit scene is brighter than without decoration light.
    const plain = relight(null).raster;
    let brighter = 0;
    for (const [x, y] of bulbs)
      if (luma(raster, x + 5, y) > luma(plain, x + 5, y) + 6) brighter += 1;
    expect(brighter).toBeGreaterThan(bulbs.length * 0.8);
    // Unlit decorations are not light sources: nothing outside the mask was detected.
    expect(relight(null).emitterPixels).toBe(0);
  });

  it('keeps every structure: edges of the relit image follow the original', () => {
    const raster = relight(band).raster;
    const gw = gradientMagnitude(toGray(working), working.width, working.height);
    const ge = gradientMagnitude(toGray(raster), working.width, working.height);
    // Correlation of gradient magnitudes over the lower frame (the house, below the sky).
    const rect = toRect([0.05, 0.4, 0.95, 0.9], working.width, working.height);
    let n = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let y = rect.y0; y < rect.y1; y += 2) {
      for (let x = rect.x0; x < rect.x1; x += 2) {
        const a = gw[y * working.width + x]!;
        const b = ge[y * working.width + x]!;
        n += 1;
        sa += a;
        sb += b;
        saa += a * a;
        sbb += b * b;
        sab += a * b;
      }
    }
    const cov = sab - (sa * sb) / n;
    const correlation = cov / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
    expect(correlation).toBeGreaterThan(0.8);
  });

  it('gives existing windows a warm glow, restores the credit verbatim and is deterministic', () => {
    const first = relight(band);
    const second = relight(band);
    expect(first.raster.data.equals(second.raster.data)).toBe(true);
    expect(first.litWindows).toBe(1);
    // Warm interior light: red above blue inside the window.
    const rect = toRect(WINDOW, working.width, working.height);
    const p = ((((rect.y0 + rect.y1) >> 1) * working.width + ((rect.x0 + rect.x1) >> 1)) * 3) | 0;
    expect(first.raster.data[p]!).toBeGreaterThan(first.raster.data[p + 2]! + 20);
    const credit = toRect(CREDIT, working.width, working.height);
    for (let y = credit.y0; y < credit.y1; y += 2) {
      for (let x = credit.x0; x < credit.x1; x += 2) {
        const q = (y * working.width + x) * 3;
        expect(first.raster.data[q]).toBe(composite.data[q]);
      }
    }
  });
});
