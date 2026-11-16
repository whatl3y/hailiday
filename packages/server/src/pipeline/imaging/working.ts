import sharp, { type Sharp } from 'sharp';
import type { NormalizedBox, SourceKind } from '@hailiday/core';
import { checksumOf, encodePng, type Raster } from './raster.js';

/** Supported working aspects and their 1K provider dimensions. */
export const WORKING_GRIDS = [
  { aspect: 1, width: 1024, height: 1024 },
  { aspect: 3 / 2, width: 1536, height: 1024 },
  { aspect: 2 / 3, width: 1024, height: 1536 },
] as const;

/** Street View frames are resampled from 640×640 to this grid. */
export const STREET_VIEW_WORKING_SIZE = 1024;

/** Largest center crop allowed before padding is used instead. */
export const MAX_ASPECT_CROP = 0.1;

/** Neutral pad color; padded areas are protected and cropped out before delivery. */
export const PAD_COLOR = { r: 128, g: 128, b: 128 };

export const RESAMPLER = 'lanczos3';

export interface WorkingImage {
  raster: Raster;
  /** PNG bytes of the working image (what the provider receives). */
  png: Buffer;
  /** SHA-256 of the PNG bytes. */
  checksum: string;
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  resampler: string;
  /** Working size ÷ native size (long edge). */
  scaleFactor: number;
  /** Aspect crop applied to the native image (normalized on the native image), if any. */
  cropBox: NormalizedBox | null;
  /** Content area inside the working grid when padding was added (normalized), if any. */
  contentBox: NormalizedBox | null;
  /** Padded strips on the working grid (protected, never decorated). */
  padRegions: NormalizedBox[];
}

/** Picks the supported aspect closest to the native aspect (in log space). */
export function nearestGrid(width: number, height: number) {
  const ratio = width / height;
  return [...WORKING_GRIDS].sort(
    (a, b) => Math.abs(Math.log(ratio / a.aspect)) - Math.abs(Math.log(ratio / b.aspect)),
  )[0] as (typeof WORKING_GRIDS)[number];
}

/**
 * Normalizes a source image to the working grid (render spec, compositing and resolution):
 * orientation applied, sRGB, no alpha; Street View frames resampled to 1024×1024; uploads and
 * fixtures center-cropped by at most 10% to the nearest supported aspect, otherwise padded with a
 * neutral color, then resampled to the provider's 1K dimensions for that aspect.
 */
export async function prepareWorkingImage(
  bytes: Uint8Array,
  kind: SourceKind,
): Promise<WorkingImage> {
  const base = sharp(bytes).rotate().flatten({ background: '#ffffff' }).toColourspace('srgb');
  const decoded = await base.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const nativeWidth = decoded.info.width;
  const nativeHeight = decoded.info.height;
  const native = sharp(decoded.data, {
    raw: { width: nativeWidth, height: nativeHeight, channels: 3 },
  });

  let targetWidth: number;
  let targetHeight: number;
  let cropBox: NormalizedBox | null = null;
  let contentBox: NormalizedBox | null = null;
  const padRegions: NormalizedBox[] = [];
  let pipeline: Sharp;

  if (kind === 'street_view') {
    targetWidth = STREET_VIEW_WORKING_SIZE;
    targetHeight = STREET_VIEW_WORKING_SIZE;
    pipeline = native.resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' });
  } else {
    const grid = nearestGrid(nativeWidth, nativeHeight);
    targetWidth = grid.width;
    targetHeight = grid.height;
    const ratio = nativeWidth / nativeHeight;
    if (Math.abs(ratio - grid.aspect) < 1e-6) {
      pipeline = native.resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' });
    } else if (ratio > grid.aspect) {
      const keepWidth = Math.round(nativeHeight * grid.aspect);
      const cropFraction = 1 - keepWidth / nativeWidth;
      if (cropFraction <= MAX_ASPECT_CROP) {
        const left = Math.floor((nativeWidth - keepWidth) / 2);
        cropBox = [left / nativeWidth, 0, (left + keepWidth) / nativeWidth, 1];
        pipeline = sharp(
          await native
            .extract({ left, top: 0, width: keepWidth, height: nativeHeight })
            .raw()
            .toBuffer(),
          { raw: { width: keepWidth, height: nativeHeight, channels: 3 } },
        ).resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' });
      } else {
        // Too wide: pad top and bottom.
        const contentHeight = Math.round(targetWidth / ratio);
        const top = Math.floor((targetHeight - contentHeight) / 2);
        contentBox = [0, top / targetHeight, 1, (top + contentHeight) / targetHeight];
        if (top > 0) padRegions.push([0, 0, 1, top / targetHeight]);
        if (top + contentHeight < targetHeight) {
          padRegions.push([0, (top + contentHeight) / targetHeight, 1, 1]);
        }
        pipeline = native
          .resize(targetWidth, contentHeight, { fit: 'fill', kernel: 'lanczos3' })
          .extend({
            top,
            bottom: targetHeight - contentHeight - top,
            left: 0,
            right: 0,
            background: PAD_COLOR,
          });
      }
    } else {
      const keepHeight = Math.round(nativeWidth / grid.aspect);
      const cropFraction = 1 - keepHeight / nativeHeight;
      if (cropFraction <= MAX_ASPECT_CROP) {
        const top = Math.floor((nativeHeight - keepHeight) / 2);
        cropBox = [0, top / nativeHeight, 1, (top + keepHeight) / nativeHeight];
        pipeline = sharp(
          await native
            .extract({ left: 0, top, width: nativeWidth, height: keepHeight })
            .raw()
            .toBuffer(),
          { raw: { width: nativeWidth, height: keepHeight, channels: 3 } },
        ).resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' });
      } else {
        // Too tall: pad left and right.
        const contentWidth = Math.round(targetHeight * ratio);
        const left = Math.floor((targetWidth - contentWidth) / 2);
        contentBox = [left / targetWidth, 0, (left + contentWidth) / targetWidth, 1];
        if (left > 0) padRegions.push([0, 0, left / targetWidth, 1]);
        if (left + contentWidth < targetWidth) {
          padRegions.push([(left + contentWidth) / targetWidth, 0, 1, 1]);
        }
        pipeline = native
          .resize(contentWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' })
          .extend({
            top: 0,
            bottom: 0,
            left,
            right: targetWidth - contentWidth - left,
            background: PAD_COLOR,
          });
      }
    }
  }

  const data = await pipeline.removeAlpha().raw().toBuffer();
  const raster: Raster = { data, width: targetWidth, height: targetHeight };
  const png = await encodePng(raster);
  return {
    raster,
    png,
    checksum: checksumOf(png),
    width: targetWidth,
    height: targetHeight,
    nativeWidth,
    nativeHeight,
    resampler: RESAMPLER,
    scaleFactor:
      Math.round(
        (Math.max(targetWidth, targetHeight) / Math.max(nativeWidth, nativeHeight)) * 1000,
      ) / 1000,
    cropBox,
    contentBox,
    padRegions,
  };
}

/**
 * Maps boxes normalized on the native image (for example the embedded attribution rectangles of
 * a Street View Static frame, configured per requested size) onto the working grid: through the
 * aspect crop, then into the content area when the working image is padded. Parts cut away by
 * the crop are dropped; a box left with no area is omitted.
 */
export function nativeBoxesOnWorkingGrid(
  boxes: readonly NormalizedBox[],
  working: Pick<WorkingImage, 'cropBox' | 'contentBox'>,
): NormalizedBox[] {
  const [cx0, cy0, cx1, cy1] = working.cropBox ?? [0, 0, 1, 1];
  const [tx0, ty0, tx1, ty1] = working.contentBox ?? [0, 0, 1, 1];
  const r4 = (value: number) => Math.round(value * 10_000) / 10_000;
  const out: NormalizedBox[] = [];
  for (const [x0, y0, x1, y1] of boxes) {
    const along = (v: number, a0: number, a1: number, b0: number, b1: number) =>
      b0 + Math.min(1, Math.max(0, (v - a0) / (a1 - a0))) * (b1 - b0);
    const box: NormalizedBox = [
      r4(along(x0, cx0, cx1, tx0, tx1)),
      r4(along(y0, cy0, cy1, ty0, ty1)),
      r4(along(x1, cx0, cx1, tx0, tx1)),
      r4(along(y1, cy0, cy1, ty0, ty1)),
    ];
    if (box[2] > box[0] && box[3] > box[1]) out.push(box);
  }
  return out;
}
