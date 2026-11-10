import type { NormalizedBox, Placement } from '@holiday/core';
import { gradientMagnitude } from './checks.js';
import { buildCompositeMask, placementMaskShapes, type CompositeMask } from './mask.js';
import { resizeRaster, toGray, toRect, type Raster } from './raster.js';

/**
 * A similarity transform from working-image pixel coordinates to candidate pixel coordinates:
 * `q = R(rotation) · diag(scale · √aspect, scale / √aspect) · (p − c) + c + (dx, dy)`, where `c`
 * is the image center and pixel centers sit at `i + 0.5`. A candidate that zoomed in has
 * `scale < 1`; one shifted right has `dx > 0`. `aspect` (1 for a pure similarity) absorbs the
 * small stretch left when an output of a slightly different aspect is resampled to the grid.
 */
export interface SimilarityTransform {
  dx: number;
  dy: number;
  scale: number;
  rotationDeg: number;
  aspect: number;
}

/** The 2×2 linear part of a transform, row-major `[a, b, c, d]` (`qx = a·px + b·py`). */
function linearPart(t: SimilarityTransform): [number, number, number, number] {
  const theta = (t.rotationDeg * Math.PI) / 180;
  const root = Math.sqrt(t.aspect);
  const sx = t.scale * root;
  const sy = t.scale / root;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [cos * sx, -sin * sy, sin * sx, cos * sy];
}

/** A transform with its fit: gradient correlation over the reference pixels and their count. */
export interface SimilarityEstimate extends SimilarityTransform {
  score: number;
  inliers: number;
}

/** Registration limits and fit floors (render spec, compositing and registration). */
export const REGISTRATION_LIMITS = {
  /** Largest accepted scale change (±). */
  maxScaleDelta: 0.08,
  /** Largest accepted translation, as a fraction of the long edge. */
  maxTranslationFraction: 0.06,
  /** Largest accepted rotation in degrees (±). */
  maxRotationDeg: 2,
  /** Smallest gradient correlation that counts as a good fit for a warp. */
  minScore: 0.5,
  /** A transform moving no pixel further than this many pixels is applied as identity. */
  identityPx: 0.5,
  /** Largest relative aspect difference of a differently sized output that is resampled. */
  maxAspectDelta: 0.02,
} as const;

export type RegistrationLimits = typeof REGISTRATION_LIMITS;

const IDENTITY: SimilarityTransform = { dx: 0, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 };

interface Plane {
  data: Float32Array;
  width: number;
  height: number;
  /** Full-resolution pixels per plane pixel. */
  factor: number;
}

function downscalePlane(plane: Float32Array, width: number, height: number, factor: number): Plane {
  if (factor === 1) return { data: plane, width, height, factor };
  const w = Math.max(1, Math.floor(width / factor));
  const h = Math.max(1, Math.floor(height / factor));
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
  return { data: out, width: w, height: h, factor };
}

/** Plane pixels that are fully reference pixels (not excluded) at a pyramid level. */
function downscaleWeight(
  include: Uint8Array,
  width: number,
  height: number,
  factor: number,
): Uint8Array {
  if (factor === 1) return include;
  const plane = downscalePlane(Float32Array.from(include), width, height, factor);
  return Uint8Array.from(plane.data, (value) => (value > 0.99 ? 1 : 0));
}

/** Largest displacement the transform applies to any image corner, in pixels. */
export function maxDisplacement(t: SimilarityTransform, width: number, height: number): number {
  const cx = width / 2;
  const cy = height / 2;
  const [a, b, c, d] = linearPart(t);
  let worst = 0;
  for (const [x, y] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ] as const) {
    const px = x - cx;
    const py = y - cy;
    const qx = a * px + b * py + cx + t.dx;
    const qy = c * px + d * py + cy + t.dy;
    worst = Math.max(worst, Math.hypot(qx - x, qy - y));
  }
  return worst;
}

/**
 * Normalized cross-correlation between reference plane `a` and plane `b` sampled through the
 * transform (bilinear), over included pixels on a stride. Samples falling outside `b` are
 * skipped; when fewer than half of the included samples land inside, the fit is rejected.
 */
function transformedNcc(
  a: Plane,
  b: Plane,
  weight: Uint8Array,
  t: SimilarityTransform,
  full: { width: number; height: number },
  stride: number,
): number {
  const cx = full.width / 2;
  const cy = full.height / 2;
  const [m00, m01, m10, m11] = linearPart(t);
  const f = a.factor;
  const bw = b.width;
  const bh = b.height;
  let total = 0;
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let y = 0; y < a.height; y += stride) {
    const py = (y + 0.5) * f - cy;
    for (let x = 0; x < a.width; x += stride) {
      const i = y * a.width + x;
      if (!weight[i]) continue;
      total += 1;
      const px = (x + 0.5) * f - cx;
      const u = (m00 * px + m01 * py + cx + t.dx) / f - 0.5;
      const v = (m10 * px + m11 * py + cy + t.dy) / f - 0.5;
      if (u < 0 || v < 0 || u > bw - 1 || v > bh - 1) continue;
      const x0 = Math.min(bw - 2, Math.floor(u));
      const y0 = Math.min(bh - 2, Math.floor(v));
      const fx = u - x0;
      const fy = v - y0;
      const j = y0 * bw + x0;
      const top = (b.data[j] as number) * (1 - fx) + (b.data[j + 1] as number) * fx;
      const bottom = (b.data[j + bw] as number) * (1 - fx) + (b.data[j + bw + 1] as number) * fx;
      const vb = top * (1 - fy) + bottom * fy;
      const va = a.data[i] as number;
      n += 1;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  if (n < 32 || n < total * 0.5) return -1;
  const cov = sab - (sa * sb) / n;
  const varA = saa - (sa * sa) / n;
  const varB = sbb - (sb * sb) / n;
  return varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : -1;
}

/**
 * Estimates the similarity transform that maps the working image onto a candidate of the same
 * size, from gradient-magnitude maps over the reference pixels (`exclude` marks pixels to
 * ignore: the placement shapes and their dilation). A coarse exhaustive search over scale and
 * translation on a low-resolution pyramid level is refined level by level with a pattern search
 * over translation, scale and rotation (and the aspect term when `stretch` is set, for resampled
 * outputs). Ties resolve toward the identity, so an unchanged
 * candidate registers exactly.
 */
export function estimateSimilarity(
  working: Float32Array,
  candidate: Float32Array,
  width: number,
  height: number,
  exclude: Uint8Array | null,
  limits: RegistrationLimits = REGISTRATION_LIMITS,
  stretch = false,
): SimilarityEstimate {
  const maxAspect = limits.maxAspectDelta;
  const gw = gradientMagnitude(working, width, height);
  const gc = gradientMagnitude(candidate, width, height);
  const include = exclude
    ? Uint8Array.from(exclude, (value) => (value ? 0 : 1))
    : new Uint8Array(width * height).fill(1);
  const long = Math.max(width, height);
  const full = { width, height };
  let top = 1;
  while (long / (top * 2) >= 64) top *= 2;
  const levels: { a: Plane; b: Plane; weight: Uint8Array }[] = [];
  for (let factor = top; factor >= 1; factor /= 2) {
    levels.push({
      a: downscalePlane(gw, width, height, factor),
      b: downscalePlane(gc, width, height, factor),
      weight: downscaleWeight(include, width, height, factor),
    });
  }
  const coarse = levels[0] as (typeof levels)[number];
  const score = (level: (typeof levels)[number], t: SimilarityTransform, stride = 1) =>
    transformedNcc(level.a, level.b, level.weight, t, full, stride);

  // Coarse exhaustive search: scale in 1% steps, translation in coarse pixels.
  const range = Math.ceil((limits.maxTranslationFraction * long) / coarse.a.factor);
  const scaleSteps = Math.round(limits.maxScaleDelta / 0.01);
  let best: SimilarityEstimate = { ...IDENTITY, score: score(coarse, IDENTITY), inliers: 0 };
  const cost = (t: SimilarityTransform) =>
    Math.abs(t.dx) + Math.abs(t.dy) + Math.abs(t.scale - 1) * long;
  for (let k = -scaleSteps; k <= scaleSteps; k += 1) {
    const scale = 1 + k * 0.01;
    for (let gy = -range; gy <= range; gy += 1) {
      for (let gx = -range; gx <= range; gx += 1) {
        const t = { ...IDENTITY, dx: gx * coarse.a.factor, dy: gy * coarse.a.factor, scale };
        const s = score(coarse, t);
        if (s > best.score + 1e-6 || (s >= best.score - 1e-6 && cost(t) < cost(best))) {
          best = { ...t, score: s, inliers: 0 };
        }
      }
    }
  }

  // Pattern search per level, finest last. Steps are expressed as corner displacement.
  const radius = Math.hypot(width, height) / 2;
  let current: SimilarityTransform = {
    dx: best.dx,
    dy: best.dy,
    scale: best.scale,
    rotationDeg: best.rotationDeg,
    aspect: best.aspect,
  };
  for (const level of levels) {
    const stride = level.a.factor === 1 ? 2 : 1;
    let currentScore = score(level, current, stride);
    let step = level.a.factor;
    const minStep = level.a.factor === 1 ? 0.125 : level.a.factor / 2;
    let guard = 0;
    while (step >= minStep && guard < 400) {
      guard += 1;
      const ds = step / radius;
      const dr = (step / radius) * (180 / Math.PI);
      const moves: SimilarityTransform[] = [
        { ...current, dx: current.dx + step },
        { ...current, dx: current.dx - step },
        { ...current, dy: current.dy + step },
        { ...current, dy: current.dy - step },
        { ...current, scale: current.scale + ds },
        { ...current, scale: current.scale - ds },
        { ...current, rotationDeg: current.rotationDeg + dr },
        { ...current, rotationDeg: current.rotationDeg - dr },
        ...(stretch
          ? [
              { ...current, aspect: Math.min(1 + maxAspect, current.aspect + 2 * ds) },
              { ...current, aspect: Math.max(1 - maxAspect, current.aspect - 2 * ds) },
            ]
          : []),
      ];
      let improved = false;
      for (const move of moves) {
        const s = score(level, move, stride);
        if (s > currentScore + 1e-7) {
          current = move;
          currentScore = s;
          improved = true;
        }
      }
      if (!improved) step /= 2;
    }
  }
  const finest = levels[levels.length - 1] as (typeof levels)[number];
  let inliers = 0;
  for (const value of finest.weight) inliers += value;
  const finalScore = score(finest, current, 2);
  // An estimate no better than the identity is the identity.
  const identityScore = score(finest, IDENTITY, 2);
  if (identityScore >= finalScore - 1e-6) return { ...IDENTITY, score: identityScore, inliers };
  return { ...current, score: finalScore, inliers };
}

/** Reflects a sample coordinate into `[0, size − 1]` about the outermost pixel centers. */
function reflect(value: number, size: number): number {
  const last = size - 1;
  let u = value < 0 ? -value : value > last ? 2 * last - value : value;
  // A strip deeper than the image itself (never accepted) falls back to the edge.
  u = Math.min(last, Math.max(0, u));
  return u;
}

/**
 * Bilinear warp of a candidate onto the working grid through the transform. Working pixels the
 * candidate does not cover sample the candidate mirrored at its border (so a thin strip continues
 * the texture instead of smearing the outermost row into streaks); their share is reported as
 * `uncoveredFraction` and the deepest such strip, in working pixels, as `uncoveredInsetPx`.
 */
export function warpRaster(
  candidate: Raster,
  t: SimilarityTransform,
  width: number,
  height: number,
): { raster: Raster; uncoveredFraction: number; uncoveredInsetPx: number } {
  const out = Buffer.alloc(width * height * 3);
  const cx = width / 2;
  const cy = height / 2;
  const [m00, m01, m10, m11] = linearPart(t);
  const sw = candidate.width;
  const sh = candidate.height;
  const src = candidate.data;
  let uncovered = 0;
  let inset = 0;
  for (let y = 0; y < height; y += 1) {
    const py = y + 0.5 - cy;
    for (let x = 0; x < width; x += 1) {
      const px = x + 0.5 - cx;
      let u = m00 * px + m01 * py + cx + t.dx - 0.5;
      let v = m10 * px + m11 * py + cy + t.dy - 0.5;
      if (u < -0.5 || v < -0.5 || u > sw - 0.5 || v > sh - 0.5) {
        uncovered += 1;
        inset = Math.max(inset, -0.5 - u, u - (sw - 0.5), -0.5 - v, v - (sh - 0.5));
        u = reflect(u, sw);
        v = reflect(v, sh);
      }
      u = Math.min(sw - 1, Math.max(0, u));
      v = Math.min(sh - 1, Math.max(0, v));
      const x0 = Math.min(sw - 2, Math.floor(u));
      const y0 = Math.min(sh - 2, Math.floor(v));
      const fx = u - x0;
      const fy = v - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const j = (y0 * sw + x0) * 3;
      const k = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const value =
          (src[j + c] as number) * w00 +
          (src[j + 3 + c] as number) * w10 +
          (src[j + sw * 3 + c] as number) * w01 +
          (src[j + sw * 3 + 3 + c] as number) * w11;
        out[k + c] = Math.min(255, Math.max(0, Math.round(value)));
      }
    }
  }
  // The deepest uncovered pixel lies `inset` beyond the candidate's edge (in candidate pixels,
  // pixel centers); the strip it belongs to is half a pixel deeper. The transform's scale maps
  // it to working pixels.
  const insetPx =
    inset > 0 ? (inset + 0.5) / Math.max(1e-6, Math.min(Math.abs(m00), Math.abs(m11))) : 0;
  return {
    raster: { data: out, width, height },
    uncoveredFraction: uncovered / (width * height),
    uncoveredInsetPx: insetPx,
  };
}

/** The registration recorded on an attempt (`render_attempts.registration_transform`). */
export interface AlignmentRecord extends SimilarityEstimate {
  /** Whether the candidate is usable on the working grid (otherwise `camera_changed`). */
  accepted: boolean;
  /** Whether the candidate was warped into alignment before compositing. */
  applied: boolean;
  /** The delivered size when it differed from the working grid and was resampled. */
  resampledFrom?: { width: number; height: number };
  /** Share of working pixels the warped candidate does not cover (filled by reflection). */
  uncoveredFraction: number;
  /** Depth in working pixels of the deepest uncovered strip (0 when everything is covered). */
  uncoveredInsetPx?: number;
  /**
   * Why the candidate was not accepted. `uncovered`: in `evening`, where nothing is pasted back,
   * the warp left a strip deeper than the configured inset (see `alignAndComposite`).
   */
  reason?: 'aspect' | 'out_of_range' | 'poor_fit' | 'uncovered';
}

/** The registration as stored on the attempt, rounded for a stable record. */
export function registrationRecord(record: AlignmentRecord): Record<string, unknown> {
  const r = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
  return {
    dx: r(record.dx, 3),
    dy: r(record.dy, 3),
    scale: r(record.scale, 5),
    rotationDeg: r(record.rotationDeg, 4),
    aspect: r(record.aspect, 5),
    score: r(record.score, 4),
    inliers: record.inliers,
    accepted: record.accepted,
    applied: record.applied,
    uncoveredFraction: record.uncoveredFraction,
    ...(record.uncoveredInsetPx ? { uncoveredInsetPx: r(record.uncoveredInsetPx, 2) } : {}),
    ...(record.resampledFrom ? { resampledFrom: record.resampledFrom } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

export interface AlignmentResult {
  /** The candidate on the working grid, aligned when a warp was applied; null when rejected. */
  aligned: Raster | null;
  record: AlignmentRecord;
}

/**
 * Registration before compositing (render spec, compositing and registration): a candidate of
 * another size but the same aspect is resampled to the working grid; then the similarity
 * transform is estimated over pixels outside the placement shapes. Within the limits and with a
 * good fit, the candidate is warped into alignment (a transform under `identityPx` is applied as
 * identity, leaving the candidate byte for byte). A small transform with a poor fit is accepted
 * unwarped when it stays within `fallbackPx` (the legacy residual tolerance); anything else is
 * rejected, which the checks report as `camera_changed`.
 */
export async function alignCandidate(
  working: Raster,
  delivered: Raster,
  exclude: Uint8Array | null,
  options: { fallbackPx?: number; limits?: RegistrationLimits } = {},
): Promise<AlignmentResult> {
  const limits = options.limits ?? REGISTRATION_LIMITS;
  const { width, height } = working;
  const rejected = (reason: AlignmentRecord['reason'], estimate?: SimilarityEstimate) => ({
    aligned: null,
    record: {
      ...(estimate ?? { ...IDENTITY, score: 0, inliers: 0 }),
      accepted: false,
      applied: false,
      uncoveredFraction: 0,
      ...(delivered.width !== width || delivered.height !== height
        ? { resampledFrom: { width: delivered.width, height: delivered.height } }
        : {}),
      reason,
    },
  });
  let candidate = delivered;
  if (delivered.width !== width || delivered.height !== height) {
    const target = width / height;
    const actual = delivered.width / delivered.height;
    if (Math.abs(actual - target) / target > limits.maxAspectDelta) return rejected('aspect');
    candidate = await resizeRaster(delivered, width, height);
  }
  const resampled =
    candidate !== delivered
      ? { resampledFrom: { width: delivered.width, height: delivered.height } }
      : {};
  const estimate = estimateSimilarity(
    toGray(working),
    toGray(candidate),
    width,
    height,
    exclude,
    limits,
    candidate !== delivered,
  );
  const displacement = maxDisplacement(estimate, width, height);
  if (displacement <= limits.identityPx) {
    return {
      aligned: candidate,
      record: { ...estimate, accepted: true, applied: false, uncoveredFraction: 0, ...resampled },
    };
  }
  const long = Math.max(width, height);
  const inRange =
    Math.abs(estimate.scale - 1) <= limits.maxScaleDelta &&
    Math.hypot(estimate.dx, estimate.dy) <= limits.maxTranslationFraction * long &&
    Math.abs(estimate.rotationDeg) <= limits.maxRotationDeg;
  if (inRange && estimate.score >= limits.minScore) {
    const warped = warpRaster(candidate, estimate, width, height);
    return {
      aligned: warped.raster,
      record: {
        ...estimate,
        accepted: true,
        applied: true,
        uncoveredFraction: Math.round(warped.uncoveredFraction * 10_000) / 10_000,
        ...(warped.uncoveredInsetPx > 0 ? { uncoveredInsetPx: warped.uncoveredInsetPx } : {}),
        ...resampled,
      },
    };
  }
  if (displacement < (options.fallbackPx ?? 0)) {
    return {
      aligned: candidate,
      record: { ...estimate, accepted: true, applied: false, uncoveredFraction: 0, ...resampled },
    };
  }
  const result = rejected(inRange ? 'poor_fit' : 'out_of_range', estimate);
  return { aligned: null, record: { ...result.record, ...resampled } };
}

/**
 * Pixels registration ignores: the composite mask (source mode) or, without one, the placement
 * shapes dilated by `dilationFraction`, plus any extra boxes (windows that may glow in evening).
 */
export function registrationExclusion(input: {
  width: number;
  height: number;
  mask: CompositeMask | null;
  placements: readonly Pick<Placement, 'region' | 'maskShapes'>[];
  dilationFraction: number;
  extra?: readonly NormalizedBox[];
}): Uint8Array {
  const { width, height } = input;
  const base = input.mask
    ? input.mask.hard
    : buildCompositeMask({
        width,
        height,
        shapes: placementMaskShapes(input.placements),
        dilationFraction: input.dilationFraction,
        featherFraction: 0,
      }).hard;
  const exclude = Uint8Array.from(base, (value) => (value ? 1 : 0));
  for (const box of input.extra ?? []) {
    const rect = toRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1)
      exclude.fill(1, y * width + rect.x0, y * width + rect.x1);
  }
  return exclude;
}
