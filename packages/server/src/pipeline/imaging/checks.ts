import { expandBox, type FailureCode, type LightingMode, type NormalizedBox } from '@hailiday/core';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { checkAttributionStrokes } from './attribution.js';
import { featherBand, type CompositeMask } from './mask.js';
import { toGray, toRect, type PxRect, type Raster } from './raster.js';
import { medianLuma } from './relight.js';

/** Gradient magnitude (central differences) of a gray plane. */
export function gradientMagnitude(gray: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = (gray[i + 1] as number) - (gray[i - 1] as number);
      const gy = (gray[i + width] as number) - (gray[i - width] as number);
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

function downscale(plane: Float32Array, width: number, height: number, factor: number) {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * width + x * factor;
        for (let dx = 0; dx < factor; dx += 1) sum += plane[row + dx] as number;
      }
      out[y * w + x] = sum / (factor * factor);
    }
  }
  return { plane: out, width: w, height: h };
}

/** Normalized cross-correlation of `a` and `b` shifted by (dx, dy) over weighted pixels. */
function ncc(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
  weight: Uint8Array | null,
  stride: number,
): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  const margin = Math.max(Math.abs(dx), Math.abs(dy)) + 1;
  for (let y = margin; y < height - margin; y += stride) {
    for (let x = margin; x < width - margin; x += stride) {
      const i = y * width + x;
      if (weight && !weight[i]) continue;
      const va = a[i] as number;
      const vb = b[(y + dy) * width + (x + dx)] as number;
      n += 1;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  if (n < 16) return -1;
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : -1;
}

export interface Registration {
  dx: number;
  dy: number;
  scale: number;
  rotationDeg: number;
  score: number;
  inliers: number;
  /** Set when registration ran before compositing (see `alignCandidate`). */
  aspect?: number;
  accepted?: boolean;
  applied?: boolean;
  resampledFrom?: { width: number; height: number };
  uncoveredFraction?: number;
  uncoveredInsetPx?: number;
  reason?: 'aspect' | 'out_of_range' | 'poor_fit' | 'uncovered';
}

/**
 * Estimates the translation between the working image and a provider output by maximizing the
 * normalized cross-correlation of gradient maps (coarse search at a quarter resolution, refined
 * at full resolution), ignoring pixels under `exclude` (placement regions). Scale and rotation are
 * assumed nominal; a scaled or rotated output lowers the correlation instead.
 */
export function estimateTranslation(
  working: Float32Array,
  raw: Float32Array,
  width: number,
  height: number,
  exclude: Uint8Array | null,
  searchPx = 32,
): Registration {
  const gw = gradientMagnitude(working, width, height);
  const gr = gradientMagnitude(raw, width, height);
  const weight = exclude ? exclude.map((value) => (value ? 0 : 1)) : null;
  const factor = 4;
  const cw = downscale(gw, width, height, factor);
  const cr = downscale(gr, width, height, factor);
  const cweight = weight
    ? downscale(Float32Array.from(weight), width, height, factor).plane.map((v) =>
        v > 0.99 ? 1 : 0,
      )
    : null;
  const coarseRange = Math.ceil(searchPx / factor);
  // Ties (a textureless or shift-invariant frame) resolve to the smallest shift.
  const pick = (scores: { dx: number; dy: number; score: number }[]) => {
    const max = Math.max(...scores.map((entry) => entry.score));
    return scores
      .filter((entry) => entry.score >= max - 1e-4)
      .sort(
        (a, b) =>
          Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)) || b.score - a.score,
      )[0] as { dx: number; dy: number; score: number };
  };
  const coarseWeight = cweight ? Uint8Array.from(cweight) : null;
  const coarse: { dx: number; dy: number; score: number }[] = [];
  for (let dy = -coarseRange; dy <= coarseRange; dy += 1) {
    for (let dx = -coarseRange; dx <= coarseRange; dx += 1) {
      coarse.push({
        dx,
        dy,
        score: ncc(cw.plane, cr.plane, cw.width, cw.height, dx, dy, coarseWeight, 1),
      });
    }
  }
  const best = pick(coarse);
  const finePoints: { dx: number; dy: number; score: number }[] = [];
  for (let dy = best.dy * factor - factor; dy <= best.dy * factor + factor; dy += 1) {
    for (let dx = best.dx * factor - factor; dx <= best.dx * factor + factor; dx += 1) {
      finePoints.push({ dx, dy, score: ncc(gw, gr, width, height, dx, dy, weight, 2) });
    }
  }
  const fine = pick(finePoints);
  const inliers = weight ? weight.reduce((sum, v) => sum + v, 0) : width * height;
  return { dx: fine.dx, dy: fine.dy, scale: 1, rotationDeg: 0, score: fine.score, inliers };
}

/** Single-window SSIM of two gray planes over a rectangle. */
export function rectSsim(a: Float32Array, b: Float32Array, width: number, rect: PxRect): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const i = y * width + x;
      const va = a[i] as number;
      const vb = b[i] as number;
      n += 1;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  if (n === 0) return 1;
  const ma = sa / n;
  const mb = sb / n;
  const vara = saa / n - ma * ma;
  const varb = sbb / n - mb * mb;
  const cov = sab / n - ma * mb;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (vara + varb + c2));
}

/** Mean SSIM over 8×8 windows inside a rectangle (more sensitive than one window). */
export function meanSsim(a: Float32Array, b: Float32Array, width: number, rect: PxRect): number {
  const step = 8;
  let total = 0;
  let count = 0;
  for (let y = rect.y0; y < rect.y1; y += step) {
    for (let x = rect.x0; x < rect.x1; x += step) {
      total += rectSsim(a, b, width, {
        x0: x,
        y0: y,
        x1: Math.min(rect.x1, x + step),
        y1: Math.min(rect.y1, y + step),
      });
      count += 1;
    }
  }
  return count === 0 ? 1 : total / count;
}

/** Variance of gray values over a rectangle. */
export function grayVariance(gray: Float32Array, width: number, rect: PxRect): number {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const v = gray[y * width + x] as number;
      n += 1;
      sum += v;
      sumSq += v * v;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Exposure-invariant sharpness of a rectangle: Laplacian variance above a noise floor, over gray
 * variance (plus a small constant so a flat box does not divide by zero). Scaling the box's
 * exposure scales both terms alike, so a darker relight of a blurred area keeps its value (or
 * drops into the noise floor) while a sharper reconstruction raises it.
 */
export function relativeSharpness(
  gray: Float32Array,
  width: number,
  height: number,
  rect: PxRect,
  noiseFloor = 0,
) {
  const detail = Math.max(0, laplacianVariance(gray, width, height, rect) - noiseFloor);
  return detail / (grayVariance(gray, width, rect) + 25);
}

/**
 * Share of a rectangle's pixels where the candidate shows an edge the working image does not
 * have: candidate gradient (scaled by the box's exposure ratio, so a darker relight is
 * compensated) at or above `threshold`, with no working gradient of half that within
 * `tolerancePx`.
 */
export function newEdgeShare(
  working: Float32Array,
  candidate: Float32Array,
  width: number,
  height: number,
  rect: PxRect,
  threshold: number,
  tolerancePx: number,
): number {
  const x0 = Math.max(1, rect.x0);
  const y0 = Math.max(1, rect.y0);
  const x1 = Math.min(width - 1, rect.x1);
  const y1 = Math.min(height - 1, rect.y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  let meanW = 0;
  let meanC = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      meanW += working[y * width + x] as number;
      meanC += candidate[y * width + x] as number;
    }
  }
  const gain = Math.min(4, Math.max(1, (meanW + 1) / (meanC + 1)));
  const w = x1 - x0;
  const h = y1 - y0;
  const grad = (plane: Float32Array, x: number, y: number) => {
    const i = y * width + x;
    const gx = (plane[i + 1] as number) - (plane[i - 1] as number);
    const gy = (plane[i + width] as number) - (plane[i - width] as number);
    return Math.sqrt(gx * gx + gy * gy);
  };
  const edgeW = new Uint8Array(w * h);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (grad(working, x, y) >= threshold / 2) edgeW[(y - y0) * w + (x - x0)] = 1;
    }
  }
  const nearW = dilateBinary(edgeW, w, h, tolerancePx);
  let added = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (nearW[(y - y0) * w + (x - x0)]) continue;
      if (grad(candidate, x, y) * gain >= threshold) added += 1;
    }
  }
  return added / (w * h);
}

/**
 * Variance of the 4-neighbour Laplacian over a rectangle (a sharpness measure). Only pixels whose
 * neighbours lie inside the rectangle count, so the pixels around the box (a relit or decorated
 * surrounding next to a restored box) never add an edge along its border.
 */
export function laplacianVariance(gray: Float32Array, width: number, height: number, rect: PxRect) {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = Math.max(1, rect.y0 + 1); y < Math.min(height - 1, rect.y1 - 1); y += 1) {
    for (let x = Math.max(1, rect.x0 + 1); x < Math.min(width - 1, rect.x1 - 1); x += 1) {
      const i = y * width + x;
      const value =
        4 * (gray[i] as number) -
        (gray[i - 1] as number) -
        (gray[i + 1] as number) -
        (gray[i - width] as number) -
        (gray[i + width] as number);
      n += 1;
      sum += value;
      sumSq += value * value;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** CIE L*a*b* (D65) of one sRGB pixel. */
export function toLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Median ΔE76 between two rasters over the pixels selected by `select`. The median measures an
 * exposure or color mismatch across the whole band without counting decorations that reach into
 * it.
 */
export function medianDeltaE(a: Raster, b: Raster, select: Uint8Array): number {
  const values: number[] = [];
  for (let i = 0, p = 0; i < select.length; i += 1, p += 3) {
    if (!select[i]) continue;
    const la = toLab(a.data[p] as number, a.data[p + 1] as number, a.data[p + 2] as number);
    const lb = toLab(b.data[p] as number, b.data[p + 1] as number, b.data[p + 2] as number);
    values.push(Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]));
  }
  return percentile(values, 0.5);
}

/** Correlation of two gray planes over a rectangle (structure without exposure). */
export function rectCorrelation(
  a: Float32Array,
  b: Float32Array,
  width: number,
  rect: PxRect,
): number {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const i = y * width + x;
      const va = a[i] as number;
      const vb = b[i] as number;
      n += 1;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  if (n === 0) return 1;
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  const c3 = (0.03 * 255) ** 2 / 2;
  return (cov + c3) / (Math.sqrt(Math.max(0, va) * Math.max(0, vb)) + c3);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] as number;
}

function dilateBinary(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const horizontal = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = 0;
      for (let d = -radius; d <= radius && !on; d += 1) {
        const xx = x + d;
        if (xx >= 0 && xx < width && mask[y * width + xx]) on = 1;
      }
      horizontal[y * width + x] = on;
    }
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let on = 0;
      for (let d = -radius; d <= radius && !on; d += 1) {
        const yy = y + d;
        if (yy >= 0 && yy < height && horizontal[yy * width + x]) on = 1;
      }
      out[y * width + x] = on;
    }
  }
  return out;
}

/**
 * Edge agreement: F1 of edge pixels (each image thresholded at its own 85th gradient percentile
 * inside the area, so a global exposure change does not count as an edge change) within a
 * pixel tolerance. Returns null when the area holds too few edges to judge.
 */
export function edgeAgreement(
  working: Float32Array,
  candidate: Float32Array,
  width: number,
  height: number,
  area: Uint8Array,
  tolerancePx: number,
): { f1: number; precision: number; recall: number; edges: number } | null {
  const gw = gradientMagnitude(working, width, height);
  const gc = gradientMagnitude(candidate, width, height);
  const sw: number[] = [];
  const sc: number[] = [];
  for (let i = 0; i < area.length; i += 7) {
    if (!area[i]) continue;
    sw.push(gw[i] as number);
    sc.push(gc[i] as number);
  }
  if (sw.length < 300) return null;
  const tw = Math.max(6, percentile(sw, 0.85));
  const tc = Math.max(3, percentile(sc, 0.85));
  const ew = new Uint8Array(width * height);
  const ec = new Uint8Array(width * height);
  let countW = 0;
  let countC = 0;
  for (let i = 0; i < area.length; i += 1) {
    if (!area[i]) continue;
    if ((gw[i] as number) >= tw) {
      ew[i] = 1;
      countW += 1;
    }
    if ((gc[i] as number) >= tc) {
      ec[i] = 1;
      countC += 1;
    }
  }
  if (countW < 200 || countC === 0) return null;
  const dw = dilateBinary(ew, width, height, tolerancePx);
  const dc = dilateBinary(ec, width, height, tolerancePx);
  let tpC = 0;
  let tpW = 0;
  for (let i = 0; i < area.length; i += 1) {
    if (ec[i] && dw[i]) tpC += 1;
    if (ew[i] && dc[i]) tpW += 1;
  }
  const precision = tpC / countC;
  const recall = tpW / countW;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { f1, precision, recall, edges: countW };
}

export interface DeterministicCheckInput {
  working: Raster;
  raw: Raster;
  /** Composited candidate (source mode) or the raw output with restorations (a relight). */
  candidate: Raster;
  requested: { width: number; height: number };
  /** `source` checks a decorate composite; `evening` and `bright` check a relight. */
  lightingMode: LightingMode;
  placementRegions: readonly NormalizedBox[];
  targetFacade?: NormalizedBox | null;
  peopleBoxes: readonly NormalizedBox[];
  blurRegions: readonly NormalizedBox[];
  houseNumberRegions: readonly NormalizedBox[];
  /**
   * House numbers a decoration covers (`source` mode): the composite keeps the editor's pixels
   * there, so they are counted, not compared; the judge guards their text.
   */
  coveredHouseNumberRegions?: readonly NormalizedBox[];
  /** Existing windows and light sources, which may glow in a relight. */
  glowRegions: readonly NormalizedBox[];
  /**
   * The photo's content area on the grid (padding excluded), where the `bright` brightness check
   * measures; the whole image when absent.
   */
  contentBox?: NormalizedBox | null;
  /** The embedded attribution rectangle(s), compared after restoration. */
  attributionRegion?: NormalizedBox | readonly NormalizedBox[] | null;
  mask: CompositeMask | null;
  /**
   * Registration done before compositing: `raw` is then the delivered output resampled and
   * aligned onto the working grid, and the alignment check reports this record instead of
   * estimating a residual translation.
   */
  alignment?: Registration & { accepted: boolean };
  thresholds?: Partial<(typeof PIPELINE_DEFAULTS)['checks']> & { edgeExclusionFraction?: number };
}

export interface DeterministicCheckResult {
  /**
   * Deterministic failure codes (critical, plus `implausible_decor` from the seam check and
   * `lighting_implausible` from the bright brightness check).
   */
  codes: FailureCode[];
  /**
   * Codes that fail the attempt whatever the judge says and on any attempt (a bright relight
   * darker than its base). Absent when there are none.
   */
  decisive?: FailureCode[];
  /** Hints passed to the judge. */
  hints: string[];
  registration: Registration | null;
  /** Metrics and outcomes per check, stored on the judge result. */
  checks: Record<string, Record<string, unknown>>;
}

/** The embedded attribution rectangles as a list (one rectangle, several, or none). */
export function attributionRegionsOf(
  value: NormalizedBox | readonly NormalizedBox[] | null | undefined,
): NormalizedBox[] {
  if (!value || value.length === 0) return [];
  return typeof value[0] === 'number'
    ? [value as NormalizedBox]
    : [...(value as readonly NormalizedBox[])];
}

function areaMask(
  width: number,
  height: number,
  include: NormalizedBox | null,
  exclude: readonly NormalizedBox[],
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const rect = include ? toRect(include, width, height) : { x0: 0, y0: 0, x1: width, y1: height };
  for (let y = rect.y0; y < rect.y1; y += 1) mask.fill(1, y * width + rect.x0, y * width + rect.x1);
  for (const box of exclude) {
    const r = toRect(box, width, height);
    for (let y = r.y0; y < r.y1; y += 1) mask.fill(0, y * width + r.x0, y * width + r.x1);
  }
  return mask;
}

/**
 * Runs the deterministic checks of the render spec on one attempt: output dimensions,
 * alignment, out-of-mask drift (hint), edge agreement, protected-region preservation, house
 * number preservation, the seam check (source mode), the attribution region and, for a bright
 * relight, that the result is not darker than its base (median luma over the content area).
 * Text detection on the rest of the frame needs a detector and is reported as not available.
 */
export function runDeterministicChecks(input: DeterministicCheckInput): DeterministicCheckResult {
  const t: (typeof PIPELINE_DEFAULTS)['checks'] & { edgeExclusionFraction?: number } = {
    ...PIPELINE_DEFAULTS.checks,
    ...(input.thresholds ?? {}),
  };
  const codes = new Set<FailureCode>();
  const hints: string[] = [];
  const checks: DeterministicCheckResult['checks'] = {};
  const { working, raw, candidate } = input;
  const width = working.width;
  const height = working.height;

  const alignment = input.alignment ?? null;
  if (alignment) {
    // Registered before compositing: a same-aspect output was resampled to the working grid.
    const delivered = alignment.resampledFrom ?? { width: raw.width, height: raw.height };
    checks.dimensions = {
      passed: alignment.reason !== 'aspect',
      requested: input.requested,
      delivered,
      ...(alignment.resampledFrom ? { resampled: true } : {}),
    };
    checks.alignment = { passed: alignment.accepted, ...alignment };
    if (!alignment.accepted || raw.width !== width || raw.height !== height) {
      codes.add('camera_changed');
      return { codes: [...codes], hints, registration: alignment, checks };
    }
  } else {
    const dimensionsOk =
      raw.width === input.requested.width && raw.height === input.requested.height;
    checks.dimensions = {
      passed: dimensionsOk,
      requested: input.requested,
      delivered: { width: raw.width, height: raw.height },
    };
    if (!dimensionsOk || raw.width !== width || raw.height !== height) {
      codes.add('camera_changed');
      return { codes: [...codes], hints, registration: null, checks };
    }
  }

  const grayW = toGray(working);
  const grayR = toGray(raw);
  const grayC = toGray(candidate);
  const long = Math.max(width, height);

  // Alignment on pixels outside the placement regions (dilated in source mode).
  const placementMask = areaMask(width, height, null, []).map(() => 0);
  for (const region of input.placementRegions) {
    const r = toRect(region, width, height);
    for (let y = r.y0; y < r.y1; y += 1) placementMask.fill(1, y * width + r.x0, y * width + r.x1);
  }
  let registration: Registration;
  if (alignment) {
    registration = alignment;
  } else {
    const alignExclude = input.mask
      ? input.mask.hard.map((v, i) => (v || placementMask[i] ? 1 : 0))
      : placementMask;
    registration = estimateTranslation(grayW, grayR, width, height, alignExclude);
    const translation = Math.hypot(registration.dx, registration.dy);
    const maxTranslation = Math.max(1, Math.round(t.maxTranslationFraction * long));
    const aligned = translation < maxTranslation;
    checks.alignment = {
      passed: aligned,
      ...registration,
      translationPx: translation,
      maxTranslationPx: maxTranslation,
    };
    if (!aligned) {
      codes.add('camera_changed');
      return { codes: [...codes], hints, registration, checks };
    }
  }

  // Out-of-mask drift (source mode): per-tile SSIM before paste-back; a hint only.
  if (input.lightingMode === 'source' && input.mask) {
    const tile = 32;
    let tiles = 0;
    let low = 0;
    for (let y = 0; y + tile <= height; y += tile) {
      for (let x = 0; x + tile <= width; x += tile) {
        let inside = false;
        for (let yy = y; yy < y + tile && !inside; yy += 4) {
          for (let xx = x; xx < x + tile; xx += 4) {
            if (input.mask.hard[yy * width + xx]) {
              inside = true;
              break;
            }
          }
        }
        if (inside) continue;
        tiles += 1;
        if (
          rectSsim(grayW, grayR, width, { x0: x, y0: y, x1: x + tile, y1: y + tile }) <
          t.driftTileSsim
        ) {
          low += 1;
        }
      }
    }
    const share = tiles === 0 ? 0 : low / tiles;
    checks.drift = { tiles, lowTiles: low, share, hint: share > t.driftTileShare };
    if (share > t.driftTileShare) hints.push('structure_changed');
  }

  // Edge agreement. A relight: F1 inside the target facade, excluding the placements (with their
  // dilation, where decorations and their glow land) and existing windows and light sources,
  // which may legitimately glow. Source: the mask's feather band, where the original edges must
  // survive the blend; decorations reaching into the band add edges, so recall is the measure.
  let area: Uint8Array;
  const evening = input.lightingMode !== 'source' || !input.mask;
  if (evening) {
    const pad = t.edgeExclusionFraction ?? 0.04;
    const excluded = [
      ...input.placementRegions.map((box) => expandBox(box, pad) ?? box),
      ...input.glowRegions,
    ];
    area = areaMask(width, height, input.targetFacade ?? null, excluded);
  } else {
    const band = featherBand(input.mask as CompositeMask);
    area = band.map((v, i) => (v && !placementMask[i] ? 1 : 0));
  }
  const edges = edgeAgreement(grayW, grayC, width, height, area, t.edgeTolerancePx);
  const edgeScore = edges ? (evening ? edges.f1 : edges.recall) : null;
  checks.edgeAgreement = edges
    ? {
        ...edges,
        measure: evening ? 'f1' : 'recall',
        passed: (edgeScore as number) >= t.edgeF1,
        threshold: t.edgeF1,
      }
    : { passed: true, skipped: 'insufficient_edges' };
  if (edgeScore !== null && edgeScore < t.edgeF1) codes.add('structure_changed');

  // Protected regions: never sharper than the working image, whatever the exposure. In a relight,
  // which passes through every protected box, a reconstruction also shows as edges the working
  // box does not have.
  const protectedResults: Record<string, unknown>[] = [];
  const protect = (box: NormalizedBox, code: FailureCode, kind: string) => {
    const rect = toRect(box, width, height);
    const before = relativeSharpness(grayW, width, height, rect, t.protectedNoiseFloor);
    const after = relativeSharpness(grayC, width, height, rect, t.protectedNoiseFloor);
    const ratio = (after + 1e-3) / (before + 1e-3);
    let passed = ratio <= t.protectedSharpnessRatio;
    const result: Record<string, unknown> = { kind, ratio: Math.round(ratio * 1000) / 1000 };
    if (evening) {
      const share = newEdgeShare(
        grayW,
        grayC,
        width,
        height,
        rect,
        t.protectedEdgeGradient,
        t.edgeTolerancePx,
      );
      result.newEdgeShare = Math.round(share * 10_000) / 10_000;
      if (share > t.protectedNewEdgeShare) passed = false;
    }
    protectedResults.push({ ...result, passed });
    if (!passed) codes.add(code);
  };
  for (const box of input.peopleBoxes) protect(box, 'people_altered', 'person');
  for (const box of input.blurRegions) protect(box, 'privacy_regression', 'blur');
  checks.protectedRegions = {
    passed: protectedResults.every((r) => r.passed),
    regions: protectedResults,
  };

  // House numbers must stay unchanged (the feasible part of text detection). In source mode they
  // are excluded from the composite mask, so this passes by construction unless restoration
  // failed; a house number a decoration covers keeps the editor's pixels, so it is only counted
  // (`covered`) and the judge's `text_added` code covers it. In a relight the new light and the
  // legitimate window glow change these pixels, so a pixel comparison is no evidence; the judge
  // covers them all.
  if (evening) {
    checks.textDetection = { detector: 'not_available', houseNumbers: 'delegated_to_judge' };
  } else {
    const houseNumbers = input.houseNumberRegions.map((box) => {
      const score = meanSsim(grayW, grayC, width, toRect(box, width, height));
      if (score < t.houseNumberSsim) codes.add('text_added');
      return { ssim: score, passed: score >= t.houseNumberSsim };
    });
    checks.textDetection = {
      detector: 'not_available',
      houseNumbers,
      covered: input.coveredHouseNumberRegions?.length ?? 0,
    };
  }

  // Seam check across the feather band (source mode).
  if (input.lightingMode === 'source' && input.mask) {
    const deltaE = medianDeltaE(working, candidate, featherBand(input.mask));
    checks.seam = { deltaE, passed: deltaE <= t.seamDeltaE, threshold: t.seamDeltaE };
    if (deltaE > t.seamDeltaE) codes.add('implausible_decor');
  }

  // Attribution rectangles, compared after restoration. In a relight the ground behind the logo and
  // copyright follows the new light, so where the reference's strokes are found reliably only the
  // solid stroke pixels are compared, and must equal the reference's; elsewhere the rectangle was
  // restored verbatim and its SSIM against the reference is the measure, as in `source` mode.
  const attribution = attributionRegionsOf(input.attributionRegion);
  if (attribution.length > 0 && input.lightingMode !== 'source') {
    const regions = attribution.map((box) => {
      const strokes = checkAttributionStrokes(working, candidate, box);
      if (strokes.mode === 'adapted') return strokes;
      const ssim = meanSsim(grayW, grayC, width, toRect(box, width, height));
      return { ...strokes, ssim, passed: ssim >= t.attributionSsim };
    });
    const passed = regions.every((region) => region.passed);
    checks.attribution = { passed, regions };
    if (!passed) codes.add('attribution_altered');
  } else if (attribution.length > 0) {
    const scores = attribution.map((box) =>
      meanSsim(grayW, grayC, width, toRect(box, width, height)),
    );
    const score = Math.min(...scores);
    checks.attribution = {
      ssim: score,
      ...(scores.length > 1 ? { regions: scores } : {}),
      passed: score >= t.attributionSsim,
    };
    if (score < t.attributionSsim) codes.add('attribution_altered');
  }

  // A bright relight must not be darker than its base over the photo's content area.
  const decisive: FailureCode[] = [];
  if (input.lightingMode === 'bright') {
    const base = medianLuma(working, input.contentBox ?? null);
    const result = medianLuma(candidate, input.contentBox ?? null);
    const passed = result >= base;
    checks.brightness = { measure: 'median_luma', base, candidate: result, passed };
    if (!passed) {
      codes.add('lighting_implausible');
      decisive.push('lighting_implausible');
    }
  }

  return {
    codes: [...codes],
    hints,
    registration,
    checks,
    ...(decisive.length > 0 ? { decisive } : {}),
  };
}
