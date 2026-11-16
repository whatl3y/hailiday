import type { LightingMode, NormalizedBox } from '@hailiday/core';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { restoreAttributionRelit, type AttributionRestoreMode } from './attribution.js';
import { attributionRegionsOf, medianDeltaE } from './checks.js';
import { featherBand, neighbourhood, type CompositeMask } from './mask.js';
import { copyRect, toRect, type Raster } from './raster.js';
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
}

/** One attribution rectangle's restoration (stored with the compositing checks on the attempt). */
export interface AttributionRestoreRecord {
  mode: AttributionRestoreMode;
  /** The stroke share found in the rectangle (a relight); null in `source` mode. */
  share: number | null;
  /** The relight's per-channel gain in linear light (adapted only). */
  gain: [number, number, number] | null;
}

/**
 * Restores the attribution rectangles and the padding into a candidate. In `source` mode both are
 * copied verbatim from the working image. In a relight each attribution rectangle keeps the
 * working image's logo and copyright strokes while the ground behind them follows the new light
 * (`restoreAttributionRelit`, verbatim when the strokes are not found reliably); padding stays
 * verbatim.
 */
export function restoreProtectedRectangles(input: {
  candidate: Raster;
  working: Raster;
  lightingMode: LightingMode;
  attribution: readonly NormalizedBox[];
  padRegions?: readonly NormalizedBox[];
}): { candidate: Raster; attribution: AttributionRestoreRecord[] } {
  const { working, attribution } = input;
  const pads = input.padRegions ?? [];
  let candidate = input.candidate;
  const records: AttributionRestoreRecord[] = [];
  for (const [index, box] of attribution.entries()) {
    if (input.lightingMode === 'source') {
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
  for (const pad of pads) candidate = restoreRegion(candidate, working, pad);
  return { candidate, attribution: records };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Registration of a delivered output to a reference image (render spec, registration): the
 * similarity transform estimated over pixels outside `exclude`, applied when within the limits.
 * In a relight (`evening` or `bright`), where nothing is pasted back, a warp that leaves an
 * uncovered strip deeper than `maxUncoveredInsetFraction` of the long edge is rejected
 * (`reason: 'uncovered'`, which the checks report as `camera_changed`). A rejected registration
 * has no aligned raster.
 */
export async function registerDelivered(input: {
  working: Raster;
  delivered: Raster;
  lightingMode: LightingMode;
  exclude: Uint8Array | null;
  fallbackPx: number;
  maxUncoveredInsetFraction?: number;
}): Promise<AlignmentResult> {
  const { working } = input;
  const long = Math.max(working.width, working.height);
  const registered = await alignCandidate(working, input.delivered, input.exclude, {
    fallbackPx: input.fallbackPx,
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
 * relit ground (`restoreProtectedRectangles`). A rejected registration returns the delivered
 * output unchanged with `alignment.accepted` false.
 */
export async function alignAndComposite(input: {
  working: Raster;
  delivered: Raster;
  lightingMode: LightingMode;
  mask: CompositeMask | null;
  exclude: Uint8Array | null;
  /** The embedded attribution rectangle(s): verbatim in `source` mode, strokes kept in a relight. */
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
  });
  return {
    raw,
    candidate: restored.candidate,
    alignment: registered.record,
    exposureMatched: photometric?.applied ?? false,
    photometric,
    attributionRestored: attribution.length > 0,
    attribution: restored.attribution,
  };
}
