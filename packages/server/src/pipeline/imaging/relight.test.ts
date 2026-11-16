import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { attributionStrokes } from './attribution.js';
import { SYNTHETIC_ATTRIBUTION, attributionScene, lumaAt } from './attribution.testing.js';
import { gradientMagnitude } from './checks.js';
import { toGray, toRect, type Raster } from './raster.js';
import { BRIGHT_GRADE, medianLuma, relightSourceToEvening, relightToBright } from './relight.js';
import { prepareWorkingImage } from './working.js';
import { PIPELINE_DEFAULTS } from '../versions.js';

const SOLID = PIPELINE_DEFAULTS.attributionRelight.solidKeep;

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

describe('bright relight and the median luma measure', () => {
  it('measures the median luma inside a box from the encoded values', () => {
    const raster: Raster = {
      width: 4,
      height: 1,
      data: Buffer.from([0, 0, 0, 51, 51, 51, 204, 204, 204, 255, 255, 255]),
    };
    expect(medianLuma(raster)).toBe(0.2);
    expect(medianLuma(raster, [0.5, 0, 1, 1])).toBe(0.8);
    expect(medianLuma({ width: 1, height: 1, data: Buffer.from([255, 0, 0]) })).toBeCloseTo(
      0.2118,
      3,
    );
  });

  it('lifts shadows and midtones with a slight warm balance, keeps structure and restores rectangles', () => {
    const bright = relightToBright({ image: composite, restore: [CREDIT] });
    expect(bright.width).toBe(composite.width);
    expect(medianLuma(bright)).toBeGreaterThan(medianLuma(composite) + 0.05);
    // Shadows lift most: a dark gray rises more than a light one.
    const dark = relightToBright({
      image: { width: 1, height: 1, data: Buffer.from([40, 40, 40]) },
    });
    const light = relightToBright({
      image: { width: 1, height: 1, data: Buffer.from([200, 200, 200]) },
    });
    expect(dark.data[1]! - 40).toBeGreaterThan(light.data[1]! - 200);
    // Warm: red above green above blue on a neutral input; nothing clips at mid gray.
    expect(dark.data[0]!).toBeGreaterThan(dark.data[1]!);
    expect(dark.data[1]!).toBeGreaterThan(dark.data[2]!);
    expect(BRIGHT_GRADE.gamma).toBeLessThan(1);
    // Edges stay where they are: the gradient field keeps its peaks.
    const before = gradientMagnitude(toGray(composite), composite.width, composite.height);
    const after = gradientMagnitude(toGray(bright), bright.width, bright.height);
    let moved = 0;
    let edges = 0;
    for (let i = 0; i < before.length; i += 1) {
      if (before[i]! < 40) continue;
      edges += 1;
      if (after[i]! < 10) moved += 1;
    }
    expect(edges).toBeGreaterThan(1000);
    expect(moved / edges).toBeLessThan(0.01);
    // The credit corner is copied verbatim.
    const rect = toRect(CREDIT, composite.width, composite.height);
    const p = (rect.y0 * composite.width + rect.x0) * 3;
    expect(bright.data.subarray(p, p + 3).equals(composite.data.subarray(p, p + 3))).toBe(true);
    // Same input, same bytes.
    expect(
      relightToBright({ image: composite }).data.equals(relightToBright({ image: composite }).data),
    ).toBe(true);
  });
});

describe('attribution rectangles in the deterministic relights', () => {
  const scene = attributionScene(1024);
  const solid = (box: NormalizedBox) => {
    const { rect, keep } = attributionStrokes(scene.base, box);
    const pixels: number[] = [];
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        if ((keep[(y - rect.y0) * (rect.x1 - rect.x0) + (x - rect.x0)] as number) >= SOLID) {
          pixels.push(y * 1024 + x);
        }
      }
    }
    return pixels;
  };
  const expectStrokesKept = (raster: Raster) => {
    for (const box of SYNTHETIC_ATTRIBUTION) {
      const pixels = solid(box);
      expect(pixels.length).toBeGreaterThan(200);
      for (const i of pixels) {
        expect(
          raster.data.subarray(i * 3, i * 3 + 3).equals(scene.base.data.subarray(i * 3, i * 3 + 3)),
        ).toBe(true);
      }
    }
  };
  /** A ground pixel of the logo rectangle, clear of the strokes. */
  const ground = (() => {
    const rect = scene.rects[0]!;
    return { x: rect.x1 - 3, y: rect.y0 + 2 };
  })();

  it('keeps the strokes and relights their ground in the evening relight; padding stays verbatim', () => {
    const pad: NormalizedBox = [0.4, 0, 0.6, 0.04];
    const evening = relightSourceToEvening({
      composite: scene.base,
      working: scene.base,
      interior: false,
      decorationMask: null,
      seed: 'variant-1',
      attribution: SYNTHETIC_ATTRIBUTION,
      restore: [pad],
    }).raster;
    expectStrokesKept(evening);
    expect(lumaAt(evening, ground.x, ground.y)).toBeLessThan(
      lumaAt(scene.base, ground.x, ground.y) * 0.6,
    );
    const rect = toRect(pad, 1024, 1024);
    const p = (rect.y0 * 1024 + rect.x0) * 3;
    expect(evening.data.subarray(p, p + 3).equals(scene.base.data.subarray(p, p + 3))).toBe(true);
  });

  it('keeps the strokes and brightens their ground in the bright relight', () => {
    const bright = relightToBright({ image: scene.base, attribution: SYNTHETIC_ATTRIBUTION });
    expectStrokesKept(bright);
    expect(lumaAt(bright, ground.x, ground.y)).toBeGreaterThan(
      lumaAt(scene.base, ground.x, ground.y),
    );
  });
});
