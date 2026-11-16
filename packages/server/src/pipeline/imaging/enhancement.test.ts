import { describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { relativeSharpness } from './checks.js';
import {
  FIXTURE_ENHANCE,
  enhanceDeterministic,
  protectedCoverage,
  restoreProtectedPixels,
  tileStructureAgreement,
} from './enhancement.js';
import { toGray, toRect, type PxRect, type Raster } from './raster.js';
import { alignCandidate } from './registration.js';

const SIZE = 512;

/** A deterministic pseudo-random sequence (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box blur of radius 1 per channel (edge replication). */
function soften(raster: Raster): Raster {
  return enhanceDeterministic(raster, { unsharpAmount: -1, curve: 0 });
}

/**
 * A soft street-like frame: low-frequency structure (sinusoids of 40 to 110 px periods, which a
 * 4x box average keeps) plus fine noise, softened like an upscaled frame.
 */
function frameRaster(seed = 1, size = SIZE): Raster {
  const next = random(seed);
  const data = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const base =
        120 +
        45 * Math.sin(x / 9 + seed) * Math.cos(y / 13) +
        30 * Math.sin((x + 2 * y) / 17 + seed * 2);
      const noise = (next() - 0.5) * 60;
      const p = (y * size + x) * 3;
      data[p] = Math.max(0, Math.min(255, Math.round(base + noise)));
      data[p + 1] = Math.max(0, Math.min(255, Math.round(base * 0.9 + noise + 10)));
      data[p + 2] = Math.max(0, Math.min(255, Math.round(base * 0.8 + noise + 20)));
    }
  }
  return soften({ data, width: size, height: size });
}

/** A sharper, warmer redraw of a frame (what an enhancement does to its pixels). */
function sharpened(frame: Raster): Raster {
  const sharp = enhanceDeterministic(enhanceDeterministic(frame, { unsharpAmount: 2, curve: 0 }), {
    unsharpAmount: 1.5,
    curve: 0.1,
  });
  const data = Buffer.from(sharp.data);
  for (let p = 0; p < data.length; p += 3) data[p] = Math.min(255, (data[p] as number) + 12);
  return { ...sharp, data };
}

function flat(value: number, size = SIZE): Raster {
  return { data: Buffer.alloc(size * size * 3, value), width: size, height: size };
}

/** Copies a square patch from one place of a raster to another. */
function copyPatch(
  raster: Raster,
  from: { x: number; y: number },
  to: { x: number; y: number },
  side: number,
): Raster {
  const out = { ...raster, data: Buffer.from(raster.data) };
  for (let y = 0; y < side; y += 1) {
    const source = ((from.y + y) * raster.width + from.x) * 3;
    raster.data.copy(out.data, ((to.y + y) * raster.width + to.x) * 3, source, source + side * 3);
  }
  return out;
}

function sharpness(raster: Raster, rect: PxRect): number {
  return relativeSharpness(toGray(raster), raster.width, raster.height, rect, 4);
}

/** Pearson correlation of the luma of two rasters over a rectangle. */
function grayCorrelation(a: Raster, b: Raster, rect: PxRect): number {
  const ga = toGray(a);
  const gb = toGray(b);
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const va = ga[y * a.width + x] as number;
      const vb = gb[y * a.width + x] as number;
      n += 1;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  const cov = sab / n - (sa / n) * (sb / n);
  return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
}

function sameBytes(a: Raster, b: Raster, rect: PxRect): boolean {
  for (let y = rect.y0; y < rect.y1; y += 1) {
    const start = (y * a.width + rect.x0) * 3;
    const end = (y * a.width + rect.x1) * 3;
    if (!a.data.subarray(start, end).equals(b.data.subarray(start, end))) return false;
  }
  return true;
}

describe('the fixture enhancement', () => {
  it('is deterministic, registers as the identity and sharpens texture', async () => {
    const frame = frameRaster();
    const first = enhanceDeterministic(frame);
    const second = enhanceDeterministic(frame);
    expect(first.data.equals(second.data)).toBe(true);
    expect(first.data.equals(frame.data)).toBe(false);
    expect(FIXTURE_ENHANCE).toEqual({ unsharpAmount: 0.8, curve: 0.12 });
    const registered = await alignCandidate(frame, first, null, { fallbackPx: 3 });
    expect(registered.record.accepted).toBe(true);
    expect(registered.record.applied).toBe(false);
    const rect = { x0: 100, y0: 100, x1: 300, y1: 300 };
    expect(sharpness(first, rect)).toBeGreaterThan(sharpness(frame, rect) * 1.2);
  });
});

describe('protected coverage', () => {
  it('is the share of the frame the union of the boxes covers', () => {
    expect(protectedCoverage([], 100, 100)).toBe(0);
    expect(protectedCoverage([[0, 0, 0.5, 0.5]], 100, 100)).toBeCloseTo(0.25, 5);
    expect(
      protectedCoverage(
        [
          [0, 0, 0.5, 0.5],
          [0.25, 0.25, 0.75, 0.75],
        ],
        100,
        100,
      ),
    ).toBeCloseTo(0.4375, 5);
  });
});

describe('restoring protected pixels', () => {
  const frame = frameRaster(3);
  const candidate = sharpened(frame);
  const box: NormalizedBox = [0.4, 0.4, 0.55, 0.55];
  const attribution: NormalizedBox[] = [[0, 0.94, 0.15, 1]];

  it('gives a protected box the frame sharpness back, tone-matched, and leaves the rest', () => {
    const rect = toRect(box, SIZE, SIZE);
    const ratioBefore = sharpness(candidate, rect) / sharpness(frame, rect);
    expect(ratioBefore).toBeGreaterThanOrEqual(1.5);
    const restored = restoreProtectedPixels({
      candidate,
      frame,
      boxes: [box],
      attributionRegions: attribution,
    });
    // Under the protected-sharpness limit of the checks (1.2), and the frame's own pixels: the
    // restored box follows the frame pixel for pixel through a tone map, the candidate does not.
    expect(sharpness(restored.raster, rect) / sharpness(frame, rect)).toBeLessThanOrEqual(1.2);
    expect(grayCorrelation(restored.raster, frame, rect)).toBeGreaterThan(0.99);
    expect(grayCorrelation(candidate, frame, rect)).toBeLessThan(0.97);
    expect(restored.photometric?.applied).toBe(true);
    expect(restored.coverage).toBeGreaterThan(0.0225);
    // The tone follows the candidate: the red channel was raised by 12 levels.
    let redFrame = 0;
    let redRestored = 0;
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        redFrame += frame.data[(y * SIZE + x) * 3] as number;
        redRestored += restored.raster.data[(y * SIZE + x) * 3] as number;
      }
    }
    expect((redRestored - redFrame) / ((rect.x1 - rect.x0) * (rect.y1 - rect.y0))).toBeGreaterThan(
      6,
    );
    // Beyond the 6 px dilation and its feather the candidate is untouched, byte for byte.
    const margin = 10;
    expect(
      sameBytes(restored.raster, candidate, { x0: 0, y0: 0, x1: SIZE, y1: rect.y0 - margin }),
    ).toBe(true);
    expect(
      sameBytes(restored.raster, candidate, { x0: 0, y0: rect.y1 + margin, x1: SIZE, y1: SIZE }),
    ).toBe(true);
    expect(
      sameBytes(restored.raster, candidate, { x0: 0, y0: 0, x1: rect.x0 - margin, y1: SIZE }),
    ).toBe(true);
  });

  it('never touches an attribution rectangle, even inside a protected box', () => {
    const restored = restoreProtectedPixels({
      candidate,
      frame,
      boxes: [[0, 0.85, 0.3, 1]],
      attributionRegions: attribution,
    });
    expect(sameBytes(restored.raster, candidate, toRect(attribution[0]!, SIZE, SIZE))).toBe(true);
    expect(sameBytes(restored.raster, candidate, toRect([0.2, 0.9, 0.28, 0.98], SIZE, SIZE))).toBe(
      false,
    );
  });

  it('copies the frame verbatim when the ring has too few samples, and nothing without boxes', () => {
    const whole = restoreProtectedPixels({
      candidate,
      frame,
      boxes: [[0, 0, 1, 1]],
      attributionRegions: [],
    });
    expect(whole.photometric?.skipped).toBe('too_few_samples');
    expect(whole.raster.data.equals(frame.data)).toBe(true);
    const none = restoreProtectedPixels({ candidate, frame, boxes: [], attributionRegions: [] });
    expect(none.raster).toBe(candidate);
    expect(none.photometric).toBeNull();
    expect(none.coverage).toBe(0);
  });
});

describe('the tile structure check', () => {
  const frame = frameRaster(5);

  it('scores identical images 1 and a sharpened, re-toned copy above 0.9', () => {
    const same = tileStructureAgreement(frame, frame, { exclude: [] });
    expect(same.tiles).toBeGreaterThan(20);
    expect(same.min).toBe(1);
    expect(same.passed).toBe(true);
    const enhanced = tileStructureAgreement(frame, sharpened(frame), { exclude: [] });
    expect(enhanced.min).toBeGreaterThan(0.9);
    expect(enhanced.passed).toBe(true);
  });

  it('fails a tile-sized area replaced by other texture and names it among the worst', () => {
    const replaced = copyPatch(sharpened(frame), { x: 40, y: 300 }, { x: 256, y: 128 }, 96);
    const result = tileStructureAgreement(frame, replaced, { exclude: [] });
    expect(result.passed).toBe(false);
    expect(result.min).toBeLessThan(0.35);
    const worst = result.worst[0];
    expect(worst).toBeDefined();
    const [x0, y0, x1, y1] = worst!.box;
    // The worst tile overlaps the replaced square [256, 352) x [128, 224).
    expect(x0 * SIZE).toBeLessThan(352);
    expect(x1 * SIZE).toBeGreaterThan(256);
    expect(y0 * SIZE).toBeLessThan(224);
    expect(y1 * SIZE).toBeGreaterThan(128);
    expect(result.worst.length).toBeLessThanOrEqual(3);
    // The same change inside an excluded box is not counted.
    const excluded = tileStructureAgreement(frame, replaced, {
      exclude: [[208 / SIZE, 80 / SIZE, 400 / SIZE, 272 / SIZE]],
    });
    expect(excluded.passed).toBe(true);
  });

  it('counts no tile where the frame is flat', () => {
    const result = tileStructureAgreement(flat(128), frameRaster(7), { exclude: [] });
    expect(result.tiles).toBe(0);
    expect(result.passed).toBe(true);
    expect(result.min).toBe(1);
  });

  it('scores a flat candidate 0 on every structured tile', () => {
    const result = tileStructureAgreement(frame, flat(128), { exclude: [] });
    expect(result.tiles).toBeGreaterThan(0);
    expect(result.min).toBe(0);
    expect(result.passed).toBe(false);
  });
});
