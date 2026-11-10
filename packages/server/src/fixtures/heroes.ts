import sharp, { type Sharp } from 'sharp';
import type { NormalizedBox } from '@holiday/core';
import type { HeroPhoto } from './photos.js';
import { transformBox, type CropRect } from './photos.js';

/** Bumped whenever hero rendering changes, so seeded renditions are re-encoded. */
export const HERO_ART_VERSION = '2.0.0';

/** Hero orientations: landscape 3:2 and the art-directed portrait 2:3. */
export type HeroOrientation = 'landscape' | 'portrait';

/** Width / height of each hero orientation. */
export const HERO_ASPECT: Readonly<Record<HeroOrientation, number>> = {
  landscape: 3 / 2,
  portrait: 2 / 3,
};

/**
 * The largest crop of the master at the orientation's aspect ratio, centered on the photo's
 * focal point for that orientation (the portrait crop is art-directed, not a center crop) and
 * slid back inside the master when the focal point is near an edge.
 */
export function heroCropRect(photo: HeroPhoto, orientation: HeroOrientation): CropRect {
  const aspect = HERO_ASPECT[orientation];
  const [fx, fy] = orientation === 'portrait' ? photo.portraitFocal : photo.landscapeFocal;
  const height = Math.min(photo.height, Math.floor(photo.width / aspect));
  const width = Math.min(photo.width, Math.round(height * aspect));
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(0, value)));
  return {
    left: clamp(fx * photo.width - width / 2, photo.width - width),
    top: clamp(fy * photo.height - height / 2, photo.height - height),
    width,
    height,
  };
}

/** A point of the master (normalized) in a crop's normalized coordinates, clamped to it. */
export function pointInCrop(
  point: readonly [number, number],
  crop: CropRect,
  photo: { width: number; height: number },
): [number, number] {
  const r3 = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return [
    r3((point[0] * photo.width - crop.left) / crop.width),
    r3((point[1] * photo.height - crop.top) / crop.height),
  ];
}

/** The master's safe area in a crop's coordinates, or null when it falls mostly outside. */
export function safeAreaInCrop(
  photo: HeroPhoto,
  crop: CropRect,
  minVisible = 0.6,
): NormalizedBox | null {
  return transformBox(photo.safeArea, crop, photo, minVisible);
}

export type HeroFormat = 'avif' | 'webp' | 'jpeg';

const QUALITY: Readonly<Record<HeroFormat, { start: number; floor: number }>> = {
  avif: { start: 56, floor: 30 },
  webp: { start: 80, floor: 45 },
  jpeg: { start: 84, floor: 50 },
};

function encoder(image: Sharp, format: HeroFormat, quality: number): Sharp {
  if (format === 'avif') return image.avif({ quality, effort: 4, chromaSubsampling: '4:2:0' });
  if (format === 'webp') return image.webp({ quality, effort: 5, smartSubsample: true });
  return image.jpeg({ quality, progressive: true, mozjpeg: true });
}

/**
 * Encodes one rendition of a cropped master: Lanczos downscale to the exact size, sRGB, no
 * metadata. With `maxBytes`, quality steps down until the file fits the byte budget (or reaches
 * the format's quality floor).
 */
export async function encodeHeroRendition(
  crop: { data: Buffer; width: number; height: number },
  size: { width: number; height: number },
  format: HeroFormat,
  options: { maxBytes?: number } = {},
): Promise<{ body: Buffer; quality: number }> {
  const resized = await sharp(crop.data, {
    raw: { width: crop.width, height: crop.height, channels: 3 },
  })
    .resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const source = () =>
    sharp(resized, { raw: { width: size.width, height: size.height, channels: 3 } });
  const { start, floor } = QUALITY[format];
  let quality = start;
  let body = await encoder(source(), format, quality).toBuffer();
  while (options.maxBytes !== undefined && body.length > options.maxBytes && quality > floor) {
    quality = Math.max(floor, quality - 6);
    body = await encoder(source(), format, quality).toBuffer();
  }
  return { body, quality };
}

/** Decodes the hero master and extracts one orientation's crop as raw sRGB pixels. */
export async function extractHeroCrop(
  file: string,
  crop: CropRect,
): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(file)
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .extract(crop)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
