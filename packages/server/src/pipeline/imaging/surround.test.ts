import { describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { PIPELINE_DEFAULTS } from '../versions.js';
import type { Raster } from './raster.js';
import { identityToneCurves, ringBlurPx, ringChange, toneCurves } from './surround.js';

const W = 512;
const H = 256;
const { cleanShare, minRingPixels, minToneSamples } = PIPELINE_DEFAULTS.protectedSurround;

/** A wide-range wall: a 0 to 255 gradient from left to right, each channel its own ramp. */
function gradient(width = W, height = H): Raster {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 3;
      const g = Math.round((x * 255) / (width - 1));
      data[p] = g;
      data[p + 1] = Math.round(g * 0.85 + 10);
      data[p + 2] = Math.round(g * 0.7 + 20);
    }
  }
  return { data, width, height };
}

/** A deterministic hash of a pixel's position, channel and a seed, in [0, 1). */
function hash(x: number, y: number, c: number, seed: number): number {
  let h = (x * 374_761_393 + y * 668_265_263 + c * 2_147_483_647 + seed * 1_274_126_177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

/**
 * A fine texture (a plaster or foliage stand-in): a mid-level base with a small pattern, each
 * pixel and channel shifted by independent noise of up to `amplitude` levels drawn with `seed`.
 */
function texture(seed: number, amplitude = 40): Raster {
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const p = (y * W + x) * 3;
      const base = 110 + ((x * 7 + y * 13) % 30);
      for (let c = 0; c < 3; c += 1) {
        const noise = Math.round((hash(x, y, c, seed) * 2 - 1) * amplitude);
        data[p + c] = Math.max(0, Math.min(255, base - c * 15 + noise));
      }
    }
  }
  return { data, width: W, height: H };
}

function copy(raster: Raster): Raster {
  return { data: Buffer.from(raster.data), width: raster.width, height: raster.height };
}

function rectOf(raster: Raster, box: NormalizedBox) {
  return {
    x0: Math.round(box[0] * raster.width),
    y0: Math.round(box[1] * raster.height),
    x1: Math.round(box[2] * raster.width),
    y1: Math.round(box[3] * raster.height),
  };
}

function paint(raster: Raster, box: NormalizedBox, rgb: [number, number, number]): Raster {
  const out = copy(raster);
  const r = rectOf(raster, box);
  for (let y = r.y0; y < r.y1; y += 1) {
    for (let x = r.x0; x < r.x1; x += 1) {
      const p = (y * raster.width + x) * 3;
      out.data[p] = rgb[0];
      out.data[p + 1] = rgb[1];
      out.data[p + 2] = rgb[2];
    }
  }
  return out;
}

function mapPixels(raster: Raster, f: (value: number) => number): Raster {
  const out = copy(raster);
  for (let i = 0; i < out.data.length; i += 1) {
    out.data[i] = Math.max(0, Math.min(255, Math.round(f(out.data[i] as number))));
  }
  return out;
}

/** A per-pixel area (1 inside `box`), as the edited area the curves skip. */
function areaOf(box: NormalizedBox, width = W, height = H): Uint8Array {
  const area = new Uint8Array(width * height);
  const r = rectOf({ data: Buffer.alloc(0), width, height }, box);
  for (let y = r.y0; y < r.y1; y += 1) area.fill(1, y * width + r.x0, y * width + r.x1);
  return area;
}

/** The mark sits on the bright end of the gradient (levels about 204 to 230 in its ring). */
const INNER: NormalizedBox = [0.84, 0.4, 0.86, 0.55];
const OUTER: NormalizedBox = [0.8, 0.3, 0.9, 0.65];

const measure = (reference: Raster, candidate: Raster, skip: Uint8Array | null = null) =>
  ringChange(reference, candidate, INNER, OUTER, {
    curves: toneCurves(reference, candidate, { skip }).curves,
  });

describe('surroundings of a protected box', () => {
  it('measures nothing when the output equals the reference', () => {
    const reference = gradient();
    const tone = toneCurves(reference, copy(reference));
    expect(tone.curves).toEqual(identityToneCurves());
    expect(tone.sampled).toBe('all');
    expect(tone.samples).toBe((W / 4) * (H / 4));
    const ring = measure(reference, copy(reference));
    expect(ring.share).toBe(0);
    expect(ring.pixels).toBeGreaterThan(minRingPixels);
  });

  it('reads a re-toned output as unchanged across the whole tone range once mapped through the curves', () => {
    const reference = gradient();
    const cases: [string, (v: number) => number][] = [
      ['+30 levels', (v) => v + 30],
      ['-30 levels', (v) => v - 30],
      ['+60 levels', (v) => v + 60],
      ['-60 levels', (v) => v - 60],
      ['x1.3 with clipping', (v) => v * 1.3],
      ['gamma 0.7', (v) => 255 * (v / 255) ** 0.7],
      ['contrast x1.3', (v) => 128 + (v - 128) * 1.3],
    ];
    for (const [name, f] of cases) {
      const candidate = mapPixels(reference, f);
      expect({ name, share: measure(reference, candidate).share }).toEqual({ name, share: 0 });
    }
    // Without the curves a shift of 60 levels reads as a change of the whole ring.
    for (const shift of [60, -60]) {
      const candidate = mapPixels(reference, (v) => v + shift);
      expect(ringChange(reference, candidate, INNER, OUTER).share).toBeGreaterThan(0.9);
    }
  });

  it('reads re-rendered fine texture as unchanged once blurred, and as changed pixel by pixel', () => {
    const reference = texture(1);
    const candidate = texture(2);
    expect(ringBlurPx(W, H)).toBe(1);
    const curves = toneCurves(reference, candidate).curves;
    const blurred = ringChange(reference, candidate, INNER, OUTER, { curves });
    const sharp = ringChange(reference, candidate, INNER, OUTER, { curves, blurPx: 0 });
    expect(blurred.share).toBeLessThan(cleanShare);
    expect(sharp.share).toBeGreaterThan(cleanShare);
  });

  it('measures about all of a ring that a decoration covers', () => {
    const reference = gradient();
    const candidate = paint(reference, OUTER, [20, 70, 30]);
    expect(measure(reference, candidate, areaOf(OUTER)).share).toBeGreaterThan(0.9);
    // Sampled over the decoration too, the curves map its flat colour onto the wall behind it:
    // this is why they skip the edited area.
    expect(measure(reference, candidate).share).toBeLessThan(0.9);
  });

  it('keeps the box itself out of its ring, blur included', () => {
    const reference = gradient();
    const candidate = paint(reference, INNER, [255, 0, 255]);
    for (const blurPx of [0, 1, 3, 6]) {
      const ring = ringChange(reference, candidate, INNER, OUTER, { blurPx });
      expect(ring.share).toBe(0);
    }
  });

  it('samples the curves outside the edited area, so a repaint elsewhere does not move them', () => {
    const reference = gradient();
    // The bottom 30% of the frame repainted with a ramp over the ring's own levels.
    const repaint: NormalizedBox = [0, 0.7, 1, 1];
    const candidate = copy(reference);
    const r = rectOf(reference, repaint);
    for (let y = r.y0; y < r.y1; y += 1) {
      for (let x = r.x0; x < r.x1; x += 1) {
        const p = (y * W + x) * 3;
        const v = 195 + Math.round((x / W) * 40);
        candidate.data[p] = v;
        candidate.data[p + 1] = Math.round(v * 0.85 + 10);
        candidate.data[p + 2] = Math.round(v * 0.7 + 20);
      }
    }
    const skip = areaOf(repaint);
    const tone = toneCurves(reference, candidate, { skip });
    expect(tone.sampled).toBe('outside_edits');
    expect(tone.samples).toBeGreaterThanOrEqual(minToneSamples);
    expect(measure(reference, candidate, skip).share).toBe(0);
    // Sampled over the repaint too, the curves read the untouched ring as changed.
    expect(measure(reference, candidate).share).toBeGreaterThan(cleanShare);
  });

  it('samples every pixel when too few lie outside the edited area', () => {
    const reference = gradient();
    const candidate = mapPixels(reference, (v) => v + 20);
    const tone = toneCurves(reference, candidate, { skip: areaOf([0, 0, 1, 0.99]) });
    expect(tone.sampled).toBe('all');
    expect(tone.samples).toBe((W / 4) * (H / 4));
    expect(() => toneCurves(reference, candidate, { skip: new Uint8Array(10) })).toThrow(
      /edited area/,
    );
  });

  it('fills a level with too few samples from the nearest level that has enough', () => {
    // Levels 100 (offset +10) and 104 (offset -10), each sampled widely; nothing else.
    const width = 64;
    const height = 64;
    const reference: Raster = { data: Buffer.alloc(width * height * 3), width, height };
    const candidate: Raster = { data: Buffer.alloc(width * height * 3), width, height };
    for (let i = 0; i < width * height; i += 1) {
      const left = i % width < width / 2;
      reference.data.fill(left ? 110 : 94, i * 3, i * 3 + 3);
      candidate.data.fill(left ? 100 : 104, i * 3, i * 3 + 3);
    }
    const [curve] = toneCurves(reference, candidate).curves;
    expect(curve?.[100]).toBe(110);
    expect(curve?.[104]).toBe(94);
    // Level 102 is as near to both: the lower level's offset.
    expect(curve?.[102]).toBe(112);
    expect(curve?.[103]).toBe(93);
    expect(curve?.[0]).toBe(10);
    expect(curve?.[255]).toBe(245);
    // With nothing sampled the curves are the identity.
    const all: NormalizedBox[] = [[0, 0, 1, 1]];
    expect(toneCurves(reference, candidate, { ignore: all }).curves).toEqual(identityToneCurves());
  });

  it('leaves the ignored rectangles out of the ring and of the curves', () => {
    const reference = gradient();
    // The left half of the ring is painted, as are padding bands top and bottom.
    const left: NormalizedBox = [OUTER[0], OUTER[1], INNER[0], OUTER[3]];
    const candidate = paint(reference, left, [10, 10, 10]);
    const all = ringChange(reference, candidate, INNER, OUTER);
    const ignored = ringChange(reference, candidate, INNER, OUTER, { ignore: [left] });
    expect(all.share).toBeGreaterThan(0.2);
    expect(ignored.share).toBe(0);
    expect(ignored.pixels).toBeLessThan(all.pixels);
    const pad: NormalizedBox[] = [
      [0, 0, 1, 0.2],
      [0, 0.8, 1, 1],
    ];
    let padded = copy(reference);
    for (const box of pad) padded = paint(padded, box, [0, 0, 0]);
    expect(toneCurves(reference, padded, { ignore: pad }).curves).toEqual(identityToneCurves());
    expect(toneCurves(reference, padded).curves).not.toEqual(identityToneCurves());
  });

  it('measures 0 on a ring of fewer than the minimum pixels', () => {
    const reference = gradient();
    const candidate = paint(reference, OUTER, [0, 0, 0]);
    // A 1-pixel ring around a 1 x 1 pixel box: 8 pixels.
    const inner: NormalizedBox = [430 / W, 128 / H, 431 / W, 129 / H];
    const outer: NormalizedBox = [429 / W, 127 / H, 432 / W, 130 / H];
    const ring = ringChange(reference, candidate, inner, outer, { blurPx: 0 });
    expect(ring.pixels).toBe(8);
    expect(ring.share).toBe(0);
    // Three pixels wide: 48 pixels, all changed.
    const wide = ringChange(reference, candidate, inner, [427 / W, 125 / H, 434 / W, 132 / H], {
      blurPx: 0,
    });
    expect(wide.pixels).toBe(48);
    expect(wide.share).toBe(1);
  });

  it('is deterministic', () => {
    const reference = gradient();
    const candidate = paint(
      mapPixels(reference, (v) => v * 1.1),
      [0.82, 0.2, 0.845, 0.9],
      [30, 80, 40],
    );
    const skip = areaOf([0.82, 0.2, 0.845, 0.9]);
    const first = toneCurves(reference, candidate, { skip });
    const second = toneCurves(reference, copy(candidate), { skip: Uint8Array.from(skip) });
    expect(second).toEqual(first);
    const ringA = ringChange(reference, candidate, INNER, OUTER, { curves: first.curves });
    const ringB = ringChange(reference, copy(candidate), INNER, OUTER, { curves: second.curves });
    expect(ringB).toEqual(ringA);
    expect(ringA.share).toBeGreaterThan(0);
    expect(ringA.share).toBeLessThan(1);
  });

  it('refuses rasters of different sizes', () => {
    expect(() => toneCurves(gradient(), gradient(100, 100))).toThrow(/differ in size/);
    expect(() => ringChange(gradient(), gradient(100, 100), INNER, OUTER)).toThrow(
      /differ in size/,
    );
  });
});
