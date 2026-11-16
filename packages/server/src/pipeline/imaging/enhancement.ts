import type { NormalizedBox } from '@hailiday/core';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { pasteBack, photometricAlign, type PhotometricRecord } from './composite.js';
import { boxesHardMask, buildCompositeMask, maskCoverage } from './mask.js';
import { toGray, toRect, type Raster } from './raster.js';

/**
 * The fixture editor's answer to an enhance request: a 3 x 3 unsharp mask of `unsharpAmount`
 * followed by a gentle S-curve of strength `curve`. It is visible, keeps every fixture Street View
 * frame recognisable by the fixture compositor (worst thumbnail distance 5.4 against the limit of
 * 9) and registers as the identity, so fixture decorations stay on their measured anchors.
 */
export const FIXTURE_ENHANCE = { unsharpAmount: 0.8, curve: 0.12 } as const;

/**
 * The deterministic fixture enhancement of a raster: per channel, a 3 x 3 box blur with edge
 * replication, `sharp = clamp(v + unsharpAmount * (v - blur))`, then the S-curve lookup
 * `lut[v] = round(255 * (x - curve * sin(2πx) / (2π)))` with `x = v / 255`. The same input gives
 * the same bytes.
 */
export function enhanceDeterministic(
  raster: Raster,
  settings: { unsharpAmount: number; curve: number } = FIXTURE_ENHANCE,
): Raster {
  const { width, height, data } = raster;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) {
    const x = v / 255;
    lut[v] = Math.min(
      255,
      Math.max(
        0,
        Math.round(255 * (x - (settings.curve * Math.sin(2 * Math.PI * x)) / (2 * Math.PI))),
      ),
    );
  }
  const out = Buffer.allocUnsafe(data.length);
  for (let y = 0; y < height; y += 1) {
    const ys = [Math.max(0, y - 1), y, Math.min(height - 1, y + 1)];
    for (let x = 0; x < width; x += 1) {
      const xs = [Math.max(0, x - 1), x, Math.min(width - 1, x + 1)];
      for (let c = 0; c < 3; c += 1) {
        let sum = 0;
        for (const yy of ys) {
          for (const xx of xs) sum += data[(yy * width + xx) * 3 + c] as number;
        }
        const v = data[(y * width + x) * 3 + c] as number;
        const sharp = Math.min(
          255,
          Math.max(0, Math.round(v + settings.unsharpAmount * (v - sum / 9))),
        );
        out[(y * width + x) * 3 + c] = lut[sharp] as number;
      }
    }
  }
  return { data: out, width, height };
}

/** Share of a `width` x `height` frame the union of `boxes` covers. */
export function protectedCoverage(
  boxes: readonly NormalizedBox[],
  width: number,
  height: number,
): number {
  if (boxes.length === 0) return 0;
  return maskCoverage(boxesHardMask(width, height, boxes, 0));
}

/**
 * Puts the frame's own pixels back into an enhanced picture inside the protected boxes (people,
 * blurred areas, house numbers, signs, logos). The boxes are dilated and feathered by
 * `protectDilationFraction` and `protectFeatherFraction` of the long edge outside the box, never
 * into the attribution rectangles. The frame is first tone-matched to the enhanced picture over a
 * ring `protectRingFraction` of the long edge wide around the boxes (`photometricAlign` with the
 * roles swapped on purpose: the frame is matched to the candidate, so a restored box is not a dull
 * rectangle in a vivid picture); a tone map leaves the sharpness of the box unchanged. With too few
 * ring samples the frame's pixels come back unchanged. Inside a box the result is the frame's
 * pixels through the tone map, in the feather band a blend, elsewhere the candidate byte for byte.
 */
export function restoreProtectedPixels(input: {
  candidate: Raster;
  frame: Raster;
  boxes: readonly NormalizedBox[];
  attributionRegions: readonly NormalizedBox[];
  padRegions?: readonly NormalizedBox[];
}): { raster: Raster; photometric: PhotometricRecord | null; coverage: number } {
  const { candidate, frame } = input;
  if (candidate.width !== frame.width || candidate.height !== frame.height) {
    throw new RangeError('restoring protected pixels needs equal sizes');
  }
  const { width, height } = candidate;
  if (input.boxes.length === 0) return { raster: candidate, photometric: null, coverage: 0 };
  const settings = PIPELINE_DEFAULTS.enhance;
  const long = Math.max(width, height);
  const mask = buildCompositeMask({
    width,
    height,
    regions: input.boxes,
    dilationFraction: settings.protectDilationFraction,
    featherFraction: settings.protectFeatherFraction,
    exclusions: input.attributionRegions,
  });
  const matched = photometricAlign(candidate, frame, mask, {
    ringPx: Math.max(2, Math.round(settings.protectRingFraction * long)),
    toleranceDeltaE: 0,
    ignore: [...input.attributionRegions, ...(input.padRegions ?? [])],
    force: true,
  });
  return {
    raster: pasteBack(candidate, matched.raster, mask),
    photometric: matched.record,
    coverage: Math.round(maskCoverage(mask.hard) * 10_000) / 10_000,
  };
}

/** One tile of the structure check. */
export interface StructureTile {
  box: NormalizedBox;
  correlation: number;
  stdDev: number;
}

/** The result of `tileStructureAgreement`. */
export interface StructureAgreement {
  /** Tiles that carried structure and were compared. */
  tiles: number;
  /** The lowest correlation (1 when no tile was compared). */
  min: number;
  passed: boolean;
  /** The three lowest tiles, lowest first. */
  worst: StructureTile[];
}

/** Box average of a gray plane by an integer factor (the remainder rows and columns dropped). */
function boxDownscale(
  gray: Float32Array,
  width: number,
  height: number,
  factor: number,
): { data: Float32Array; width: number; height: number } {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Float32Array(w * h);
  const area = factor * factor;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * width + x * factor;
        for (let dx = 0; dx < factor; dx += 1) sum += gray[row + dx] as number;
      }
      out[y * w + x] = sum / area;
    }
  }
  return { data: out, width: w, height: h };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Structure check of an enhancement: whether any area of the frame was replaced by something else.
 * The luma of both images is box-averaged by `downscale` (removing the fine texture an
 * enhancement adds), then compared in square tiles of `tileFraction` of the long edge with a stride
 * of half a tile. A tile counts when at least half of its samples lie outside `exclude` and the
 * frame's standard deviation over those samples is at least `minTileStdDev` (sky and plain walls
 * carry no structure to compare); its value is the Pearson correlation of the two tiles over those
 * samples (0 when the candidate is flat). It passes when no counted tile is below
 * `minTileCorrelation`. It catches a replaced area of about a tile and more; small changes (a
 * door, a bin) are left to the judge.
 */
export function tileStructureAgreement(
  frame: Raster,
  candidate: Raster,
  options: {
    exclude: readonly NormalizedBox[];
    settings?: Partial<(typeof PIPELINE_DEFAULTS)['enhance']['structure']>;
  },
): StructureAgreement {
  if (candidate.width !== frame.width || candidate.height !== frame.height) {
    throw new RangeError('the structure check needs equal sizes');
  }
  const settings = { ...PIPELINE_DEFAULTS.enhance.structure, ...(options.settings ?? {}) };
  const { width, height } = frame;
  const factor = Math.max(1, Math.round(settings.downscale));
  const a = boxDownscale(toGray(frame), width, height, factor);
  const b = boxDownscale(toGray(candidate), width, height, factor);
  const skip = new Uint8Array(a.width * a.height);
  for (const box of options.exclude) {
    const rect = toRect(box, a.width, a.height);
    for (let y = rect.y0; y < rect.y1; y += 1)
      skip.fill(1, y * a.width + rect.x0, y * a.width + rect.x1);
  }
  const long = Math.max(width, height);
  const tile = Math.max(2, Math.round((long * settings.tileFraction) / factor));
  const stride = Math.max(1, Math.round(tile / 2));
  const minVariance = settings.minTileStdDev * settings.minTileStdDev;
  const results: StructureTile[] = [];
  for (let ty = 0; ty + tile <= a.height; ty += stride) {
    for (let tx = 0; tx + tile <= a.width; tx += stride) {
      let n = 0;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = ty; y < ty + tile; y += 1) {
        for (let x = tx; x < tx + tile; x += 1) {
          const i = y * a.width + x;
          if (skip[i]) continue;
          const va = a.data[i] as number;
          const vb = b.data[i] as number;
          n += 1;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      if (n < tile * tile * 0.5) continue;
      const ma = sa / n;
      const mb = sb / n;
      const varA = saa / n - ma * ma;
      const varB = sbb / n - mb * mb;
      if (varA < minVariance) continue;
      const cov = sab / n - ma * mb;
      const correlation = varB > 1e-9 ? cov / Math.sqrt(varA * varB) : 0;
      results.push({
        box: [
          (tx * factor) / width,
          (ty * factor) / height,
          Math.min(1, ((tx + tile) * factor) / width),
          Math.min(1, ((ty + tile) * factor) / height),
        ],
        correlation: round3(correlation),
        stdDev: round3(Math.sqrt(varA)),
      });
    }
  }
  results.sort((p, q) => p.correlation - q.correlation);
  const min = results[0]?.correlation ?? 1;
  return {
    tiles: results.length,
    min,
    passed: results.every((result) => result.correlation >= settings.minTileCorrelation),
    worst: results.slice(0, 3),
  };
}
