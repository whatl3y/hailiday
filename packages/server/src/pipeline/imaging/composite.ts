import type { LightingMode, NormalizedBox } from '@hailiday/core';
import { TO_LINEAR, toSrgb } from '../../fixtures/canvas.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { restoreAttributionRelit, type AttributionRestoreMode } from './attribution.js';
import {
  attributionRegionsOf,
  medianDeltaE,
  protectedRestoreLevel,
  type RestoredProtectedBox,
} from './checks.js';
import { featherBand, neighbourhood, type CompositeMask } from './mask.js';
import { copyRect, toRect, type PxRect, type Raster } from './raster.js';
import { alignCandidate, type AlignmentRecord, type AlignmentResult } from './registration.js';

/**
 * Paste-back: `candidate = working × (1 − α) + raw × α` per channel in integer arithmetic, so a
 * pixel with α = 0 is byte-identical to the working image.
 */
export function pasteBack(working: Raster, raw: Raster, mask: CompositeMask): Raster {
  if (working.width !== raw.width || working.height !== raw.height) {
    throw new RangeError('paste-back needs equal sizes');
  }
  const out = Buffer.allocUnsafe(working.data.length);
  const alpha = mask.alpha;
  for (let i = 0, p = 0; i < alpha.length; i += 1, p += 3) {
    const a = alpha[i] as number;
    if (a === 0) {
      out[p] = working.data[p] as number;
      out[p + 1] = working.data[p + 1] as number;
      out[p + 2] = working.data[p + 2] as number;
    } else if (a === 255) {
      out[p] = raw.data[p] as number;
      out[p + 1] = raw.data[p + 1] as number;
      out[p + 2] = raw.data[p + 2] as number;
    } else {
      const b = 255 - a;
      for (let c = 0; c < 3; c += 1) {
        out[p + c] = Math.floor(
          ((working.data[p + c] as number) * b + (raw.data[p + c] as number) * a + 127) / 255,
        );
      }
    }
  }
  return { data: out, width: working.width, height: working.height };
}

/** Restores a rectangle verbatim from the working image (attribution, padding). */
export function restoreRegion(candidate: Raster, working: Raster, box: NormalizedBox): Raster {
  const out: Raster = { ...candidate, data: Buffer.from(candidate.data) };
  copyRect(out, working, toRect(box, working.width, working.height));
  return out;
}

/** What photometric alignment did (stored with the compositing checks on the attempt). */
export interface PhotometricRecord {
  applied: boolean;
  /** Unedited ring pixels sampled (outside the mask, padding and attribution). */
  ringPixels: number;
  /** Median ΔE76 between the working image and the output over the ring, before and after. */
  ringDeltaE: number;
  ringDeltaEAfter?: number;
  /** The per-channel affine part (`working ≈ gain × output + offset`, sRGB 0–255). */
  gain?: [number, number, number];
  offset?: [number, number, number];
  /** Why nothing was changed. */
  skipped?: 'too_few_samples' | 'within_tolerance' | 'no_improvement';
  /** Median ΔE76 across the feather band after paste-back, without and with the alignment. */
  seamDeltaE?: { plain: number; matched: number };
}

interface ChannelFit {
  gain: number;
  offset: number;
}

/** Smallest interquartile range (sRGB levels) of the ring for which a gain is fitted. */
const MIN_FIT_SPREAD = 20;
/** Largest residual a single ring sample contributes to the local field (sRGB levels). */
const MAX_FIELD_RESIDUAL = 48;

function quantile(sorted: Float32Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
}

/**
 * `y ≈ gain × x + offset` matched on robust distribution statistics: the gain is the ratio of
 * the interquartile ranges (a least-squares slope is biased toward zero by the misregistration
 * noise in `x`) when both span enough levels to say anything about contrast, within 0.67–1.5;
 * otherwise 1. The offset matches the medians.
 */
function fitAffine(xs: Float32Array, ys: Float32Array): ChannelFit {
  if (xs.length < 16) return { gain: 1, offset: 0 };
  const sx = Float32Array.from(xs).sort();
  const sy = Float32Array.from(ys).sort();
  const spreadX = quantile(sx, 0.75) - quantile(sx, 0.25);
  const spreadY = quantile(sy, 0.75) - quantile(sy, 0.25);
  const gain =
    spreadX >= MIN_FIT_SPREAD && spreadY >= MIN_FIT_SPREAD
      ? Math.min(1.5, Math.max(0.67, spreadY / spreadX))
      : 1;
  const offset = Math.min(128, Math.max(-128, quantile(sy, 0.5) - gain * quantile(sx, 0.5)));
  return { gain, offset };
}

function medianOf(values: Float32Array): number {
  if (values.length === 0) return 0;
  return quantile(Float32Array.from(values).sort(), 0.5);
}

/**
 * A smooth per-channel field over a block grid from scattered block averages (pull-push
 * interpolation: empty blocks take the value of the coarser level), then a 3×3 block smoothing.
 */
function fillBlockField(
  sums: Float32Array,
  counts: Float32Array,
  gw: number,
  gh: number,
  minCount: number,
): Float32Array {
  type Level = { w: number; h: number; sums: Float32Array; counts: Float32Array };
  const levels: Level[] = [{ w: gw, h: gh, sums, counts }];
  while ((levels[levels.length - 1] as Level).w > 1 || (levels[levels.length - 1] as Level).h > 1) {
    const fine = levels[levels.length - 1] as Level;
    const w = Math.max(1, Math.ceil(fine.w / 2));
    const h = Math.max(1, Math.ceil(fine.h / 2));
    const coarseSums = new Float32Array(w * h * 3);
    const coarseCounts = new Float32Array(w * h);
    for (let y = 0; y < fine.h; y += 1) {
      for (let x = 0; x < fine.w; x += 1) {
        const f = y * fine.w + x;
        const c = (y >> 1) * w + (x >> 1);
        coarseCounts[c] = (coarseCounts[c] as number) + (fine.counts[f] as number);
        for (let ch = 0; ch < 3; ch += 1) {
          coarseSums[c * 3 + ch] =
            (coarseSums[c * 3 + ch] as number) + (fine.sums[f * 3 + ch] as number);
        }
      }
    }
    levels.push({ w, h, sums: coarseSums, counts: coarseCounts });
  }
  let values = new Float32Array(3);
  const top = levels[levels.length - 1] as Level;
  for (let ch = 0; ch < 3; ch += 1) {
    values[ch] =
      (top.counts[0] as number) > 0 ? (top.sums[ch] as number) / (top.counts[0] as number) : 0;
  }
  for (let l = levels.length - 2; l >= 0; l -= 1) {
    const level = levels[l] as Level;
    const parent = levels[l + 1] as Level;
    const next = new Float32Array(level.w * level.h * 3);
    for (let y = 0; y < level.h; y += 1) {
      for (let x = 0; x < level.w; x += 1) {
        const i = y * level.w + x;
        const p = (y >> 1) * parent.w + (x >> 1);
        const count = level.counts[i] as number;
        const weight = Math.min(1, count / minCount);
        for (let ch = 0; ch < 3; ch += 1) {
          const own = count > 0 ? (level.sums[i * 3 + ch] as number) / count : 0;
          next[i * 3 + ch] = weight * own + (1 - weight) * (values[p * 3 + ch] as number);
        }
      }
    }
    values = next;
  }
  const smoothed = new Float32Array(values.length);
  for (let y = 0; y < gh; y += 1) {
    for (let x = 0; x < gw; x += 1) {
      let n = 0;
      const acc = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
          n += 1;
          for (let ch = 0; ch < 3; ch += 1)
            acc[ch] = (acc[ch] as number) + (values[(yy * gw + xx) * 3 + ch] as number);
        }
      }
      for (let ch = 0; ch < 3; ch += 1) smoothed[(y * gw + x) * 3 + ch] = (acc[ch] as number) / n;
    }
  }
  return smoothed;
}

/**
 * Photometric alignment before paste-back (render spec, compositing algorithm): image editors
 * often return the whole frame slightly brighter, darker or tinted, which shows as a pasted
 * rectangle once original pixels surround the edit. The output's color and brightness are
 * matched to the working image over the unedited ring outside the composite mask (`ringPx` wide;
 * padding and `ignore` boxes left out): a robust per-channel affine fit, then a smooth residual
 * field interpolated from the ring into the mask, so a local tone shift (one wall brighter than
 * another) is matched too. Ring samples that differ by structure rather than tone are outliers
 * and do not steer the fit. Nothing changes when the ring already agrees within
 * `toleranceDeltaE` unless `force` is set. Returns the corrected output (every pixel; paste-back
 * keeps only the masked part) and the record.
 */
export function photometricAlign(
  working: Raster,
  raw: Raster,
  mask: CompositeMask,
  options: {
    ringPx: number;
    toleranceDeltaE: number;
    ignore?: readonly NormalizedBox[];
    force?: boolean;
  },
): { raster: Raster; record: PhotometricRecord } {
  const { width, height } = working;
  const edited = Uint8Array.from(mask.hard, (value) => (value ? 1 : 0));
  const radius = Math.max(1, options.ringPx);
  const near = neighbourhood(edited, width, height, radius);
  // Holes and gaps the mask encloses (a door between two jamb bands, a protected box) are left
  // out: the editor saw them as part of the edit and may have repainted them, which is structure,
  // not tone. They are what a closing of the mask by the ring width fills.
  const closed = Uint8Array.from(
    neighbourhood(
      Uint8Array.from(near, (value) => (value ? 0 : 1)),
      width,
      height,
      radius,
    ),
    (value) => (value ? 0 : 1),
  );
  const ring = Uint8Array.from(near, (value, i) => (value && !closed[i] ? 1 : 0));
  for (const box of options.ignore ?? []) {
    const rect = toRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1)
      ring.fill(0, y * width + rect.x0, y * width + rect.x1);
  }
  // Every other pixel on every other row keeps the statistics cheap and representative.
  const samples: number[] = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = y * width + x;
      if (ring[i]) samples.push(i);
    }
  }
  const select = new Uint8Array(width * height);
  for (const i of samples) select[i] = 1;
  const ringDeltaE = samples.length > 0 ? medianDeltaE(working, raw, select) : 0;
  const record: PhotometricRecord = {
    applied: false,
    ringPixels: samples.length,
    ringDeltaE: Math.round(ringDeltaE * 100) / 100,
  };
  if (samples.length < 64)
    return { raster: raw, record: { ...record, skipped: 'too_few_samples' } };
  if (!options.force && ringDeltaE <= options.toleranceDeltaE) {
    return { raster: raw, record: { ...record, skipped: 'within_tolerance' } };
  }

  // Ring samples whose difference is far from the typical difference show structure the editor
  // changed or drew beyond the mask (a garland wider than its band), not tone; they are left out.
  const diffs = Float32Array.from(samples, (i) => {
    let sum = 0;
    for (let c = 0; c < 3; c += 1) {
      sum += (working.data[i * 3 + c] as number) - (raw.data[i * 3 + c] as number);
    }
    return sum / 3;
  });
  const typical = medianOf(diffs);
  const spread = medianOf(diffs.map((d) => Math.abs(d - typical)));
  const limit = Math.max(12, 2.5 * 1.4826 * spread);
  const tone = samples.filter((_, k) => Math.abs((diffs[k] as number) - typical) <= limit);
  const fitSamples = tone.length >= 64 ? tone : samples;

  // Global per-channel affine from the distributions of the tone samples.
  const fits: ChannelFit[] = [];
  for (let c = 0; c < 3; c += 1) {
    fits.push(
      fitAffine(
        Float32Array.from(fitSamples, (i) => raw.data[i * 3 + c] as number),
        Float32Array.from(fitSamples, (i) => working.data[i * 3 + c] as number),
      ),
    );
  }

  // Local residual field on a block grid: the median residual of the ring samples in each block
  // (robust to the odd structural difference), interpolated into the blocks the ring misses.
  const block = Math.max(4, Math.round(options.ringPx / 2));
  const gw = Math.ceil(width / block);
  const gh = Math.ceil(height / block);
  const byBlock = new Map<number, number[]>();
  for (const i of fitSamples) {
    const b = Math.floor(Math.floor(i / width) / block) * gw + Math.floor((i % width) / block);
    let list = byBlock.get(b);
    if (!list) {
      list = [];
      byBlock.set(b, list);
    }
    list.push(i);
  }
  const sums = new Float32Array(gw * gh * 3);
  const counts = new Float32Array(gw * gh);
  for (const [b, members] of byBlock) {
    counts[b] = members.length;
    for (let c = 0; c < 3; c += 1) {
      const fit = fits[c] as ChannelFit;
      const residuals = Float32Array.from(members, (i) =>
        Math.min(
          MAX_FIELD_RESIDUAL,
          Math.max(
            -MAX_FIELD_RESIDUAL,
            (working.data[i * 3 + c] as number) -
              (fit.gain * (raw.data[i * 3 + c] as number) + fit.offset),
          ),
        ),
      );
      sums[b * 3 + c] = medianOf(residuals) * members.length;
    }
  }
  const field = fillBlockField(sums, counts, gw, gh, Math.max(4, (block * block) / 16));

  const out = Buffer.allocUnsafe(raw.data.length);
  for (let y = 0; y < height; y += 1) {
    // Bilinear interpolation between block centers.
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x += 1) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const p = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const f00 = field[(y0 * gw + x0) * 3 + c] as number;
        const f10 = field[(y0 * gw + x1) * 3 + c] as number;
        const f01 = field[(y1 * gw + x0) * 3 + c] as number;
        const f11 = field[(y1 * gw + x1) * 3 + c] as number;
        const residual = (f00 * (1 - tx) + f10 * tx) * (1 - ty) + (f01 * (1 - tx) + f11 * tx) * ty;
        const fit = fits[c] as ChannelFit;
        const value = fit.gain * (raw.data[p + c] as number) + fit.offset + residual;
        out[p + c] = Math.min(255, Math.max(0, Math.round(value)));
      }
    }
  }
  const raster: Raster = { data: out, width, height };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    raster,
    record: {
      ...record,
      applied: true,
      ringDeltaEAfter: Math.round(medianDeltaE(working, raster, select) * 100) / 100,
      gain: fits.map((fit) => r3(fit.gain)) as [number, number, number],
      offset: fits.map((fit) => r3(fit.offset)) as [number, number, number],
    },
  };
}

/**
 * Seam metric across a mask edge: the median ΔE76 between the candidate and the working image
 * over the mask's feather band (`featherBand`), where the pasted output meets the original.
 * Decorations reaching into the band are a minority and do not move the median.
 */
export function edgeSeamDeltaE(working: Raster, candidate: Raster, mask: CompositeMask): number {
  return medianDeltaE(working, candidate, featherBand(mask));
}

export interface AlignedComposite {
  /** The provider output on the working grid (resampled and warped when registration applied). */
  raw: Raster;
  /** The candidate: pasted back in `source` mode, the aligned output in a relight. */
  candidate: Raster;
  alignment: AlignmentRecord;
  /** Whether photometric alignment changed the output before paste-back. */
  exposureMatched: boolean;
  /** Photometric alignment record (`source` mode with a mask). */
  photometric: PhotometricRecord | null;
  attributionRestored: boolean;
  /** How each attribution rectangle was restored, in order (empty when there are none). */
  attribution: AttributionRestoreRecord[];
  /** The people boxes and blur regions a relight put back from the reference; null otherwise. */
  protectedRestore: ProtectedRestore | null;
}

/** One attribution rectangle's restoration (stored with the compositing checks on the attempt). */
export interface AttributionRestoreRecord {
  mode: AttributionRestoreMode;
  /** The stroke share found in the rectangle (a relight); null in `source` mode. */
  share: number | null;
  /** The relight's per-channel gain in linear light (adapted only). */
  gain: [number, number, number] | null;
}

/** What the protected restore of a relight did (stored with the compositing checks). */
export interface ProtectedRestoreRecord {
  /** Groups of touching or overlapping boxes, each restored with one gain. */
  groups: number;
  /** People boxes and blur regions restored. */
  boxes: number;
  /** The applied per-channel gain of each group, in linear light. */
  gains: [number, number, number][];
  /** `adapted` when the gain was measured around the group, `verbatim` when it was 1. */
  modes: AttributionRestoreMode[];
}

/** The protected restore's result: the candidate, the record and each box with its gain. */
export interface ProtectedRestore {
  candidate: Raster;
  record: ProtectedRestoreRecord;
  restored: RestoredProtectedBox[];
}

/** Settings of the protected restore of a relight (render spec, lighting modes). */
const PROTECTED_RESTORE = {
  /** Growth of each box on every side, in pixels. */
  growPx: 2,
  /** Width of the ring the gain is measured on: this share of the long edge, at least `minRingPx`. */
  ringFraction: 0.02,
  minRingPx: 8,
  /** Fewest ring pixels for a measured gain; fewer restores the group verbatim. */
  minRingPixels: 64,
  minGain: 0.02,
  maxGain: 4,
  /** Width of the feather around each group: this share of the long edge, at least `minFeatherPx`. */
  featherFraction: 0.004,
  minFeatherPx: 3,
} as const;

const inRect = (rect: PxRect, x: number, y: number) =>
  x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;

const touches = (a: PxRect, b: PxRect) =>
  a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

function medianOfList(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * Puts people boxes and blur regions back from the base of a relight (render spec, lighting
 * modes), so their pixels are the base's, never the editor's. Each box is grown by 2 px and
 * clipped to the frame; boxes that overlap or touch form one group, whose region is the union of
 * its grown rectangles. Each group gets one gain per channel in linear light: the median ratio of
 * candidate to base (base floored at 0.001) over a ring around the group's bounding rectangle,
 * every protected rectangle and the `ignore` boxes (attribution, padding) left out, clamped to
 * [0.02, 4] and rounded to 3 decimals before it is applied; with fewer than 64 ring pixels the
 * gain is 1 (`verbatim`). A feather band around each region blends the gain-scaled base into the
 * candidate in linear light (weight 1 at the region falling linearly to 0 at the band's outer
 * edge), then every region is written as exactly `protectedRestoreLevel(base, gain)`.
 * Deterministic; null when there is no box.
 */
export function restoreProtectedBoxes(input: {
  candidate: Raster;
  base: Raster;
  boxes: readonly NormalizedBox[];
  ignore?: readonly NormalizedBox[];
}): ProtectedRestore | null {
  const { candidate, base } = input;
  if (input.boxes.length === 0) return null;
  if (candidate.width !== base.width || candidate.height !== base.height) {
    throw new RangeError('protected restore needs equal sizes');
  }
  const { width, height } = base;
  const s = PROTECTED_RESTORE;
  const long = Math.max(width, height);
  const rects = input.boxes.map((box): PxRect => {
    const rect = toRect(box, width, height);
    return {
      x0: Math.max(0, rect.x0 - s.growPx),
      y0: Math.max(0, rect.y0 - s.growPx),
      x1: Math.min(width, rect.x1 + s.growPx),
      y1: Math.min(height, rect.y1 + s.growPx),
    };
  });
  // Groups of boxes that overlap or touch, transitively, in the order of their first box.
  const parent = rects.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] as number;
    return i;
  };
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (!touches(rects[i] as PxRect, rects[j] as PxRect)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const members = new Map<number, number[]>();
  for (let i = 0; i < rects.length; i += 1) {
    const root = find(i);
    const list = members.get(root) ?? [];
    list.push(i);
    members.set(root, list);
  }
  const groups = [...members.values()].map((indices) => {
    const own = indices.map((i) => rects[i] as PxRect);
    return {
      indices,
      rects: own,
      bounds: {
        x0: Math.min(...own.map((r) => r.x0)),
        y0: Math.min(...own.map((r) => r.y0)),
        x1: Math.max(...own.map((r) => r.x1)),
        y1: Math.max(...own.map((r) => r.y1)),
      },
    };
  });

  // One gain per group and channel, measured on the candidate as delivered.
  const ignored = (input.ignore ?? []).map((box) => toRect(box, width, height));
  const ringPx = Math.max(s.minRingPx, Math.round(s.ringFraction * long));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const gains = groups.map(({ bounds }) => {
    const ratios: number[][] = [[], [], []];
    const x0 = Math.max(0, bounds.x0 - ringPx);
    const y0 = Math.max(0, bounds.y0 - ringPx);
    const x1 = Math.min(width, bounds.x1 + ringPx);
    const y1 = Math.min(height, bounds.y1 + ringPx);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (inRect(bounds, x, y)) continue;
        if (rects.some((rect) => inRect(rect, x, y))) continue;
        if (ignored.some((rect) => inRect(rect, x, y))) continue;
        const p = (y * width + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          (ratios[c] as number[]).push(
            (TO_LINEAR[candidate.data[p + c] as number] as number) /
              Math.max(0.001, TO_LINEAR[base.data[p + c] as number] as number),
          );
        }
      }
    }
    if ((ratios[0] as number[]).length < s.minRingPixels) {
      return { gain: [1, 1, 1] as [number, number, number], mode: 'verbatim' as const };
    }
    const gain = ratios.map((list) =>
      r3(Math.min(s.maxGain, Math.max(s.minGain, medianOfList(list)))),
    ) as [number, number, number];
    return { gain, mode: 'adapted' as const };
  });

  // The regions, then the feather bands outside every region (the nearest group's weight).
  const region = new Int32Array(width * height).fill(-1);
  for (const [g, group] of groups.entries()) {
    for (const rect of group.rects) {
      for (let y = rect.y0; y < rect.y1; y += 1)
        region.fill(g, y * width + rect.x0, y * width + rect.x1);
    }
  }
  const featherPx = Math.max(s.minFeatherPx, Math.round(s.featherFraction * long));
  const weight = new Float32Array(width * height);
  const owner = new Int32Array(width * height).fill(-1);
  for (const [g, group] of groups.entries()) {
    const x0 = Math.max(0, group.bounds.x0 - featherPx);
    const y0 = Math.max(0, group.bounds.y0 - featherPx);
    const x1 = Math.min(width, group.bounds.x1 + featherPx);
    const y1 = Math.min(height, group.bounds.y1 + featherPx);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = y * width + x;
        if ((region[i] as number) >= 0) continue;
        let d = Number.POSITIVE_INFINITY;
        for (const rect of group.rects) {
          const dx = Math.max(rect.x0 - x, 0, x - (rect.x1 - 1));
          const dy = Math.max(rect.y0 - y, 0, y - (rect.y1 - 1));
          d = Math.min(d, Math.max(dx, dy));
        }
        if (d > featherPx) continue;
        const w = (featherPx + 1 - d) / (featherPx + 1);
        if (w > (weight[i] as number)) {
          weight[i] = w;
          owner[i] = g;
        }
      }
    }
  }
  const out: Raster = { ...candidate, data: Buffer.from(candidate.data) };
  for (let i = 0; i < owner.length; i += 1) {
    const g = owner[i] as number;
    if (g < 0) continue;
    const w = weight[i] as number;
    const gain = (gains[g] as { gain: [number, number, number] }).gain;
    for (let c = 0; c < 3; c += 1) {
      const p = i * 3 + c;
      const restored = Math.min(1, (TO_LINEAR[base.data[p] as number] as number) * gain[c]);
      const current = TO_LINEAR[candidate.data[p] as number] as number;
      out.data[p] = Math.round(toSrgb(w * restored + (1 - w) * current));
    }
  }
  for (let i = 0; i < region.length; i += 1) {
    const g = region[i] as number;
    if (g < 0) continue;
    const gain = (gains[g] as { gain: [number, number, number] }).gain;
    for (let c = 0; c < 3; c += 1) {
      const p = i * 3 + c;
      out.data[p] = protectedRestoreLevel(base.data[p] as number, gain[c]);
    }
  }
  const groupOf = new Map<number, number>();
  for (const [g, group] of groups.entries()) for (const i of group.indices) groupOf.set(i, g);
  return {
    candidate: out,
    record: {
      groups: groups.length,
      boxes: input.boxes.length,
      gains: gains.map((entry) => [...entry.gain] as [number, number, number]),
      modes: gains.map((entry) => entry.mode),
    },
    restored: input.boxes.map((box, i) => ({
      box,
      gain: [...(gains[groupOf.get(i) as number] as { gain: [number, number, number] }).gain] as [
        number,
        number,
        number,
      ],
    })),
  };
}

/**
 * Restores the attribution rectangles and the padding into a candidate. In `source` mode both are
 * copied verbatim from the working image. In a relight each attribution rectangle keeps the
 * working image's logo and copyright strokes while the ground behind them follows the new light
 * (`restoreAttributionRelit`, verbatim when the strokes are not found reliably); padding stays
 * verbatim. `relitAttribution` restores the attribution rectangles of a `source` candidate the
 * relight's way (a lavish attempt, whose whole frame is the editor's); every people box and blur
 * region in `protectedBoxes` is then copied back verbatim from the working image, so those boxes
 * hold the original's pixels also where they overlap an attribution rectangle. In a relight the
 * people boxes and blur regions in `protectedBoxes` (padding left out) are put back from the
 * working image first (`restoreProtectedBoxes`), so the attribution rectangles and padding win
 * where they overlap; each restored box records those rectangles (`restoredAfter`).
 */
export function restoreProtectedRectangles(input: {
  candidate: Raster;
  working: Raster;
  lightingMode: LightingMode;
  attribution: readonly NormalizedBox[];
  padRegions?: readonly NormalizedBox[];
  relitAttribution?: boolean;
  protectedBoxes?: readonly NormalizedBox[];
}): {
  candidate: Raster;
  attribution: AttributionRestoreRecord[];
  protectedRestore: ProtectedRestore | null;
} {
  const { working, attribution } = input;
  const pads = input.padRegions ?? [];
  let candidate = input.candidate;
  const records: AttributionRestoreRecord[] = [];
  const sameBox = (a: NormalizedBox, b: NormalizedBox) => a.every((value, i) => value === b[i]);
  // The attribution rectangles and the padding are restored after the protected boxes, from the
  // same working image, and win where they overlap a box.
  const restoredAfter = [...attribution, ...pads];
  const restoredBoxes =
    input.lightingMode === 'source'
      ? null
      : restoreProtectedBoxes({
          candidate,
          base: working,
          boxes: (input.protectedBoxes ?? []).filter(
            (box) => !pads.some((pad) => sameBox(pad, box)),
          ),
          ignore: restoredAfter,
        });
  const protectedRestore =
    restoredBoxes && restoredAfter.length > 0
      ? {
          ...restoredBoxes,
          restored: restoredBoxes.restored.map((entry) => ({ ...entry, restoredAfter })),
        }
      : restoredBoxes;
  if (protectedRestore) candidate = protectedRestore.candidate;
  for (const [index, box] of attribution.entries()) {
    if (input.lightingMode === 'source' && !input.relitAttribution) {
      candidate = restoreRegion(candidate, working, box);
      records.push({ mode: 'verbatim', share: null, gain: null });
      continue;
    }
    const restored = restoreAttributionRelit(candidate, working, box, {
      ringExclude: [...attribution.filter((_, other) => other !== index), ...pads],
    });
    candidate = restored.raster;
    records.push({
      mode: restored.mode,
      share: Math.round(restored.share * 10_000) / 10_000,
      gain: restored.gain,
    });
  }
  if (input.lightingMode === 'source' && input.relitAttribution) {
    // The people boxes and blur regions of a lavish attempt are the original's, never a relit
    // ground's.
    const boxes = input.protectedBoxes ?? [];
    if (boxes.length > 0) {
      const out: Raster = { ...candidate, data: Buffer.from(candidate.data) };
      for (const box of boxes) copyRect(out, working, toRect(box, working.width, working.height));
      candidate = out;
    }
  }
  for (const pad of pads) candidate = restoreRegion(candidate, working, pad);
  return { candidate, attribution: records, protectedRestore };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Registration of a delivered output to a reference image (render spec, registration): the
 * similarity transform estimated over pixels outside `exclude`, applied when within the limits.
 * In a relight (`evening` or `bright`), where nothing is pasted back, a warp that leaves an
 * uncovered strip deeper than `maxUncoveredInsetFraction` of the long edge is rejected
 * (`reason: 'uncovered'`, which the checks report as `camera_changed`). A rejected registration
 * has no aligned raster. With `acceptPoorFit` (`source` mode only), a transform within the limits
 * whose fit is poor is taken unwarped instead of rejected (`reason: 'poor_fit_ignored'`).
 */
export async function registerDelivered(input: {
  working: Raster;
  delivered: Raster;
  lightingMode: LightingMode;
  exclude: Uint8Array | null;
  fallbackPx: number;
  maxUncoveredInsetFraction?: number;
  acceptPoorFit?: boolean;
}): Promise<AlignmentResult> {
  const { working } = input;
  const long = Math.max(working.width, working.height);
  const registered = await alignCandidate(working, input.delivered, input.exclude, {
    fallbackPx: input.fallbackPx,
    ...(input.acceptPoorFit && input.lightingMode === 'source' ? { acceptPoorFit: true } : {}),
  });
  if (!registered.aligned) return registered;
  const maxInset =
    (input.maxUncoveredInsetFraction ?? PIPELINE_DEFAULTS.checks.maxUncoveredInsetFraction) * long;
  if (
    input.lightingMode !== 'source' &&
    registered.record.applied &&
    (registered.record.uncoveredInsetPx ?? 0) > maxInset
  ) {
    return {
      aligned: null,
      record: { ...registered.record, accepted: false, reason: 'uncovered' },
    };
  }
  return registered;
}

/**
 * Registration, then compositing (render spec, compositing and registration), shared by the
 * render job and the example renderer: the delivered output is registered to the working image
 * over pixels outside the placement shapes (`exclude`) and warped into alignment when the
 * transform is within the limits (`registerDelivered`, or a registration passed in). In `source`
 * mode the output's color and brightness are matched to the working image over the unedited ring
 * around the mask (`photometricAlign`; also forced when the seam would otherwise exceed
 * `seamDeltaE`), then the original pixels are pasted back outside the feathered mask. In a
 * relight nothing is pasted back, so a warp that leaves an uncovered strip deeper than
 * `maxUncoveredInsetFraction` of the long edge is rejected (`reason: 'uncovered'`, which the
 * checks report as `camera_changed`); a thinner strip is kept, filled by reflection. Padding is
 * restored verbatim in both modes, and so are the attribution rectangles in `source` mode; in a
 * relight each attribution rectangle keeps the working image's logo and copyright strokes over a
 * relit ground (`restoreProtectedRectangles`), after the people boxes and blur regions
 * (`protectedBoxes`) are put back from the reference with the exposure adapted. A lavish attempt
 * (`relitAttribution`) has its attribution rectangles restored the relight's way in `source` mode
 * too, and its people boxes and blur regions (`protectedBoxes`) copied back verbatim after them. A
 * rejected registration returns the delivered output unchanged with `alignment.accepted` false.
 */
export async function alignAndComposite(input: {
  working: Raster;
  delivered: Raster;
  lightingMode: LightingMode;
  mask: CompositeMask | null;
  exclude: Uint8Array | null;
  /**
   * The embedded attribution rectangle(s): verbatim in `source` mode, strokes kept over the
   * picture's own ground in a relight and with `relitAttribution`.
   */
  attributionRegion?: NormalizedBox | readonly NormalizedBox[] | null;
  padRegions?: readonly NormalizedBox[];
  seamDeltaE: number;
  /** A poor-fit transform smaller than this many pixels is accepted without a warp. */
  fallbackPx: number;
  /** Photometric alignment settings (defaults: `PIPELINE_DEFAULTS.photometric`); false disables. */
  photometric?: false | Partial<(typeof PIPELINE_DEFAULTS)['photometric']>;
  /** Deepest accepted uncovered strip in a relight (default from `PIPELINE_DEFAULTS.checks`). */
  maxUncoveredInsetFraction?: number;
  /**
   * A registration already done on `delivered` (`registerDelivered`), for callers that look at the
   * aligned output before compositing; `exclude` and `fallbackPx` are then not used.
   */
  registered?: AlignmentResult;
  /** Restore the attribution rectangles with their strokes in `source` mode too. */
  relitAttribution?: boolean;
  /**
   * People boxes and blur regions a relight puts back from the reference; with `relitAttribution`
   * in `source` mode, copied back verbatim after the attribution rectangles.
   */
  protectedBoxes?: readonly NormalizedBox[];
}): Promise<AlignedComposite> {
  const { working } = input;
  const long = Math.max(working.width, working.height);
  const attribution = attributionRegionsOf(input.attributionRegion);
  const registered =
    input.registered ??
    (await registerDelivered({
      working,
      delivered: input.delivered,
      lightingMode: input.lightingMode,
      exclude: input.exclude,
      fallbackPx: input.fallbackPx,
      ...(input.maxUncoveredInsetFraction !== undefined
        ? { maxUncoveredInsetFraction: input.maxUncoveredInsetFraction }
        : {}),
    }));
  if (!registered.aligned) {
    return {
      raw: input.delivered,
      candidate: input.delivered,
      alignment: registered.record,
      exposureMatched: false,
      photometric: null,
      attributionRestored: false,
      attribution: [],
      protectedRestore: null,
    };
  }
  const raw = registered.aligned;
  let candidate = raw;
  let photometric: PhotometricRecord | null = null;
  if (input.lightingMode === 'source' && input.mask) {
    const mask = input.mask;
    if (input.photometric === false) {
      candidate = pasteBack(working, raw, mask);
    } else {
      const settings = { ...PIPELINE_DEFAULTS.photometric, ...(input.photometric ?? {}) };
      const align = (force: boolean) =>
        photometricAlign(working, raw, mask, {
          ringPx: Math.max(2, Math.round(settings.ringFraction * long)),
          toleranceDeltaE: settings.toleranceDeltaE,
          ignore: [...(input.padRegions ?? []), ...attribution],
          force,
        });
      const band = featherBand(mask);
      const plain = pasteBack(working, raw, mask);
      const plainSeam = medianDeltaE(working, plain, band);
      let matched = align(false);
      if (!matched.record.applied && plainSeam > input.seamDeltaE) matched = align(true);
      candidate = plain;
      photometric = matched.record;
      if (matched.record.applied) {
        // Kept only when it brings the pasted output closer to the original across the seam.
        const corrected = pasteBack(working, matched.raster, mask);
        const seam = {
          plain: round2(plainSeam),
          matched: round2(medianDeltaE(working, corrected, band)),
        };
        if (seam.matched < seam.plain) {
          candidate = corrected;
          photometric = { ...matched.record, seamDeltaE: seam };
        } else {
          photometric = {
            ...matched.record,
            applied: false,
            skipped: 'no_improvement',
            seamDeltaE: seam,
          };
        }
      }
    }
  }
  const restored = restoreProtectedRectangles({
    candidate,
    working,
    lightingMode: input.lightingMode,
    attribution,
    ...(input.padRegions ? { padRegions: input.padRegions } : {}),
    ...(input.relitAttribution ? { relitAttribution: true } : {}),
    ...(input.protectedBoxes ? { protectedBoxes: input.protectedBoxes } : {}),
  });
  return {
    raw,
    candidate: restored.candidate,
    alignment: registered.record,
    exposureMatched: photometric?.applied ?? false,
    photometric,
    attributionRestored: attribution.length > 0,
    attribution: restored.attribution,
    protectedRestore: restored.protectedRestore,
  };
}
