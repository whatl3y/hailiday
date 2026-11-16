import type { NormalizedBox } from '@hailiday/core';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { toRect, type PxRect, type Raster } from './raster.js';

/** Per-channel (R, G, B) lookup tables that map an output's levels onto a reference's. */
export type ToneCurveSet = [Uint8Array, Uint8Array, Uint8Array];

/** The tone curves of an output against a reference, and where they were sampled. */
export interface ToneCurves {
  curves: ToneCurveSet;
  /** Pixels sampled. */
  samples: number;
  /**
   * `outside_edits`: only pixels outside the edited area were sampled; `all`: no edited area was
   * given, or too few pixels lay outside it and every pixel was sampled.
   */
  sampled: 'outside_edits' | 'all';
}

/** How much of the ring around a protected box an output changed. */
export interface RingChange {
  /** Share of the ring's pixels whose largest channel difference exceeds the change level. */
  share: number;
  /** Pixels in the ring (inside `outer`, outside `inner` and every ignored rectangle). */
  pixels: number;
}

function sameSize(reference: Raster, candidate: Raster): void {
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `Rasters differ in size: ${reference.width}x${reference.height} and ${candidate.width}x${candidate.height}`,
    );
  }
}

const inside = (rect: PxRect, x: number, y: number) =>
  x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;

/** Identity curves (every level maps to itself). */
export function identityToneCurves(): ToneCurveSet {
  const identity = () => Uint8Array.from({ length: 256 }, (_, level) => level);
  return [identity(), identity(), identity()];
}

/**
 * One channel's curve from its pair table (`table[v * 256 + r]` counts the samples whose output
 * level is `v` and reference level `r`): for each output level with at least `minLevelSamples`
 * samples, the offset is the median reference level (the value at index `floor(n / 2)` of the
 * sorted samples) minus the level; a level with fewer takes the offset of the nearest level that
 * has one (the lower level on a tie), or 0 when none has.
 */
function channelCurve(table: Uint32Array, minLevelSamples: number): Uint8Array {
  const offsets: (number | null)[] = new Array<number | null>(256).fill(null);
  for (let v = 0; v < 256; v += 1) {
    let count = 0;
    for (let r = 0; r < 256; r += 1) count += table[v * 256 + r] as number;
    if (count < minLevelSamples) continue;
    const target = Math.floor(count / 2);
    let seen = 0;
    for (let r = 0; r < 256; r += 1) {
      seen += table[v * 256 + r] as number;
      if (seen > target) {
        offsets[v] = r - v;
        break;
      }
    }
  }
  const curve = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) {
    let offset = offsets[v] ?? null;
    for (let d = 1; offset === null && d < 256; d += 1) {
      if (v - d >= 0 && offsets[v - d] !== null) offset = offsets[v - d] as number;
      else if (v + d < 256 && offsets[v + d] !== null) offset = offsets[v + d] as number;
    }
    curve[v] = Math.max(0, Math.min(255, v + (offset ?? 0)));
  }
  return curve;
}

/**
 * The per-channel tone curves of `candidate` against `reference` (render spec, compositing
 * algorithm): over every `stride`-th pixel in x and y outside the `ignore` rectangles (padding,
 * attribution) and where `skip` (one byte per pixel, non-zero inside the edited area) is zero,
 * each output level is mapped to the median reference level of the samples that have it. They
 * take out an output's exposure, white-balance, gamma and contrast changes, so a re-toned output
 * is not read as a change everywhere. When fewer than `minToneSamples` pixels lie outside `skip`,
 * every pixel outside `ignore` is sampled instead (`sampled: 'all'`).
 */
export function toneCurves(
  reference: Raster,
  candidate: Raster,
  options: {
    ignore?: readonly NormalizedBox[];
    skip?: Uint8Array | null;
    stride?: number;
  } = {},
): ToneCurves {
  sameSize(reference, candidate);
  const { width, height } = reference;
  const settings = PIPELINE_DEFAULTS.protectedSurround;
  const skip = options.skip ?? null;
  if (skip && skip.length !== width * height) {
    throw new Error(
      `The edited area has ${skip.length} pixels; the rasters have ${width * height}`,
    );
  }
  const rects = (options.ignore ?? []).map((box) => toRect(box, width, height));
  const step = Math.max(1, Math.round(options.stride ?? settings.toneStride));
  const collect = (useSkip: boolean) => {
    const tables = [new Uint32Array(65_536), new Uint32Array(65_536), new Uint32Array(65_536)];
    let samples = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        if (useSkip && skip && skip[y * width + x]) continue;
        if (rects.some((rect) => inside(rect, x, y))) continue;
        const p = (y * width + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          const v = candidate.data[p + c] as number;
          const r = reference.data[p + c] as number;
          (tables[c] as Uint32Array)[v * 256 + r] += 1;
        }
        samples += 1;
      }
    }
    return { tables, samples };
  };
  let sampled: ToneCurves['sampled'] = skip ? 'outside_edits' : 'all';
  let { tables, samples } = collect(skip !== null);
  if (skip && samples < settings.minToneSamples) {
    ({ tables, samples } = collect(false));
    sampled = 'all';
  }
  const curves = tables.map((table) =>
    channelCurve(table, settings.minLevelSamples),
  ) as ToneCurveSet;
  return { curves, samples, sampled };
}

/** The blur radius the ring measure uses on a `width` x `height` grid. */
export function ringBlurPx(width: number, height: number): number {
  const { blurFraction, minBlurPx } = PIPELINE_DEFAULTS.protectedSurround;
  return Math.max(minBlurPx, Math.round(blurFraction * Math.max(width, height)));
}

/**
 * How much `candidate` changed the ring around a protected box: over the pixels inside `outer`,
 * outside `inner` and outside every `ignore` rectangle (all rounded to pixels like the masks,
 * `toRect`), the share whose largest channel difference exceeds `changeLevel`, after the candidate
 * is mapped through the tone `curves` and both images are box-blurred with a square window of
 * `2 * blurPx + 1` pixels. The window keeps only pixels inside the frame, outside `inner` and
 * outside the ignored rectangles, so the box's own pixels (what is being judged) never bleed into
 * its ring. The blur takes out re-rendered fine texture (foliage, grass, asphalt, plaster) that
 * keeps its look but not its exact pixels; `blurPx: 0` compares single pixels. A ring of fewer
 * than `minRingPixels` pixels measures 0, so a box with no measurable surroundings keeps its
 * protection.
 */
export function ringChange(
  reference: Raster,
  candidate: Raster,
  inner: NormalizedBox,
  outer: NormalizedBox,
  options: {
    curves?: ToneCurveSet;
    ignore?: readonly NormalizedBox[];
    changeLevel?: number;
    minRingPixels?: number;
    blurPx?: number;
  } = {},
): RingChange {
  sameSize(reference, candidate);
  const { width, height } = reference;
  const curves = options.curves ?? identityToneCurves();
  const level = options.changeLevel ?? PIPELINE_DEFAULTS.protectedSurround.changeLevel;
  const minPixels = options.minRingPixels ?? PIPELINE_DEFAULTS.protectedSurround.minRingPixels;
  const radius = Math.max(0, Math.round(options.blurPx ?? ringBlurPx(width, height)));
  const innerRect = toRect(inner, width, height);
  const outerRect = toRect(outer, width, height);
  const ignored = (options.ignore ?? []).map((box) => toRect(box, width, height));
  const excluded = (x: number, y: number) =>
    inside(innerRect, x, y) || ignored.some((rect) => inside(rect, x, y));

  // Summed-area tables over the ring's own window (the outer box grown by the radius, clamped to
  // the frame): the count of usable pixels and, per channel, the sums of the reference and of the
  // mapped candidate.
  const x0 = Math.max(0, outerRect.x0 - radius);
  const y0 = Math.max(0, outerRect.y0 - radius);
  const x1 = Math.min(width, outerRect.x1 + radius);
  const y1 = Math.min(height, outerRect.y1 + radius);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const stride = w + 1;
  const count = new Float64Array(stride * (h + 1));
  const sums = Array.from({ length: 6 }, () => new Float64Array(stride * (h + 1)));
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const x = x0 + i;
      const y = y0 + j;
      const at = (j + 1) * stride + (i + 1);
      const up = j * stride + (i + 1);
      const left = (j + 1) * stride + i;
      const diagonal = j * stride + i;
      const usable = excluded(x, y) ? 0 : 1;
      count[at] =
        usable + (count[up] as number) + (count[left] as number) - (count[diagonal] as number);
      const p = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const ref = usable ? (reference.data[p + c] as number) : 0;
        const cand = usable
          ? ((curves[c] as Uint8Array)[candidate.data[p + c] as number] as number)
          : 0;
        for (const [k, value] of [
          [c, ref],
          [c + 3, cand],
        ] as const) {
          const table = sums[k] as Float64Array;
          table[at] =
            value + (table[up] as number) + (table[left] as number) - (table[diagonal] as number);
        }
      }
    }
  }
  const boxSum = (table: Float64Array, ax: number, ay: number, bx: number, by: number) =>
    (table[by * stride + bx] as number) -
    (table[ay * stride + bx] as number) -
    (table[by * stride + ax] as number) +
    (table[ay * stride + ax] as number);

  let pixels = 0;
  let changed = 0;
  for (let y = outerRect.y0; y < outerRect.y1; y += 1) {
    for (let x = outerRect.x0; x < outerRect.x1; x += 1) {
      if (excluded(x, y)) continue;
      pixels += 1;
      const ax = Math.max(x0, x - radius) - x0;
      const ay = Math.max(y0, y - radius) - y0;
      const bx = Math.min(x1, x + radius + 1) - x0;
      const by = Math.min(y1, y + radius + 1) - y0;
      const n = boxSum(count, ax, ay, bx, by);
      let difference = 0;
      for (let c = 0; c < 3; c += 1) {
        const ref = boxSum(sums[c] as Float64Array, ax, ay, bx, by) / n;
        const cand = boxSum(sums[c + 3] as Float64Array, ax, ay, bx, by) / n;
        difference = Math.max(difference, Math.abs(ref - cand));
      }
      if (difference > level) changed += 1;
    }
  }
  return { share: pixels < minPixels ? 0 : changed / pixels, pixels };
}
