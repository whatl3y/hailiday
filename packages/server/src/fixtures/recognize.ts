import sharp from 'sharp';
import type { NormalizedBox } from '@holiday/core';
import {
  libraryAnchorsOf,
  loadPhotoLibrary,
  type LibraryAnchors,
  type LibraryPhoto,
  type PhotoLibrary,
} from './photos.js';

/** Thumbnail grid used to recognize a library photo in an image. */
const THUMB_W = 24;
const THUMB_H = 16;
/** Mean absolute difference (0–255) under which a thumbnail counts as the same photograph. */
const MATCH_THRESHOLD = 9;

export interface RecognizedPhoto {
  photo: LibraryPhoto;
  anchors: LibraryAnchors;
  /** The part of the photo the image shows (normalized photo coordinates). */
  crop: NormalizedBox;
  /** Mean absolute thumbnail difference (lower is closer). */
  distance: number;
}

const thumbCache = new Map<string, Promise<Uint8Array>>();

/** Center crop of a photo at an aspect ratio (at most a symmetric trim of one dimension). */
export function centerCropFor(
  photo: { width: number; height: number },
  aspect: number,
): NormalizedBox {
  const ratio = photo.width / photo.height;
  if (Math.abs(ratio - aspect) < 1e-3) return [0, 0, 1, 1];
  if (ratio > aspect) {
    const keep = aspect / ratio;
    return [(1 - keep) / 2, 0, (1 + keep) / 2, 1];
  }
  const keep = ratio / aspect;
  return [0, (1 - keep) / 2, 1, (1 + keep) / 2];
}

async function thumbOf(bytes: Uint8Array | string, crop?: NormalizedBox): Promise<Uint8Array> {
  let pipeline = sharp(bytes).rotate().removeAlpha().toColourspace('srgb');
  if (crop) {
    const meta = await sharp(bytes).rotate().metadata();
    const w = meta.autoOrient?.width ?? meta.width ?? 1;
    const h = meta.autoOrient?.height ?? meta.height ?? 1;
    const left = Math.round(crop[0] * w);
    const top = Math.round(crop[1] * h);
    pipeline = pipeline.extract({
      left,
      top,
      width: Math.max(1, Math.min(w - left, Math.round((crop[2] - crop[0]) * w))),
      height: Math.max(1, Math.min(h - top, Math.round((crop[3] - crop[1]) * h))),
    });
  }
  const data = await pipeline
    .resize(THUMB_W, THUMB_H, { fit: 'fill', kernel: 'cubic' })
    .raw()
    .toBuffer();
  return new Uint8Array(data);
}

function difference(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs((a[i] as number) - (b[i] as number));
  return sum / a.length;
}

/**
 * Recognizes a library photo (a shipped sample or a house master) in an image, allowing for the
 * center crop the working grid applies, so the fixture compositor can place decorations on the
 * photo's measured anchors. Returns null for any other image.
 */
export async function recognizeLibraryPhoto(
  image: Uint8Array,
  library: PhotoLibrary = loadPhotoLibrary(),
): Promise<RecognizedPhoto | null> {
  const meta = await sharp(image).rotate().metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (width < 8 || height < 8) return null;
  const aspect = width / height;
  const thumb = await thumbOf(image);
  let best: RecognizedPhoto | null = null;
  for (const photo of library.photos) {
    if (photo.kind !== 'sample' && photo.kind !== 'house') continue;
    const anchors = libraryAnchorsOf(photo);
    if (!anchors) continue;
    // Only crops of at most 10% of either side, the working grid's limit.
    const crop = centerCropFor(photo, aspect);
    if (crop[2] - crop[0] < 0.88 || crop[3] - crop[1] < 0.88) continue;
    const key = `${library.dir}:${photo.id}:${crop.map((v) => v.toFixed(4)).join(',')}`;
    let pending = thumbCache.get(key);
    if (!pending) {
      pending = thumbOf(library.pathOf(photo), crop);
      pending.catch(() => thumbCache.delete(key));
      thumbCache.set(key, pending);
    }
    const distance = difference(thumb, await pending);
    if (distance < MATCH_THRESHOLD && (!best || distance < best.distance)) {
      best = { photo, anchors, crop, distance };
    }
  }
  return best;
}

/**
 * Recognizes a fixture Street View frame: a crop of a library house photo, panned and zoomed.
 * The front door seen in the frame and the door measured on each photo fix the crop; the frame
 * is accepted when its thumbnail matches that crop of the photo. Returns null otherwise (the door
 * is cut off by the frame edge, or the image is not a library photo).
 */
export async function recognizeFrameByDoor(
  image: Uint8Array,
  door: NormalizedBox,
  library: PhotoLibrary = loadPhotoLibrary(),
): Promise<RecognizedPhoto | null> {
  const meta = await sharp(image).rotate().metadata();
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  const dw = door[2] - door[0];
  const dh = door[3] - door[1];
  if (width < 8 || height < 8 || dw <= 0.005 || dh <= 0.005) return null;
  if (door[0] <= 0.002 || door[1] <= 0.002 || door[2] >= 0.998 || door[3] >= 0.998) return null;
  let thumb: Uint8Array | null = null;
  let best: RecognizedPhoto | null = null;
  for (const photo of library.photos) {
    if (photo.kind !== 'house') continue;
    const measured = photo.anchors.frontDoor;
    const anchors = libraryAnchorsOf(photo);
    if (!measured || !anchors) continue;
    const cw = (measured[2] - measured[0]) / dw;
    const ch = (measured[3] - measured[1]) / dh;
    const crop: NormalizedBox = [
      measured[0] - door[0] * cw,
      measured[1] - door[1] * ch,
      measured[0] - door[0] * cw + cw,
      measured[1] - door[1] * ch + ch,
    ];
    // The crop has the frame's aspect ratio and lies inside the photo.
    const aspect = (cw * photo.width) / (ch * photo.height);
    if (Math.abs(aspect / (width / height) - 1) > 0.06) continue;
    if (crop[0] < -0.01 || crop[1] < -0.01 || crop[2] > 1.01 || crop[3] > 1.01) continue;
    const inside: NormalizedBox = [
      Math.max(0, crop[0]),
      Math.max(0, crop[1]),
      Math.min(1, crop[2]),
      Math.min(1, crop[3]),
    ];
    thumb ??= await thumbOf(image);
    const distance = difference(thumb, await thumbOf(library.pathOf(photo), inside));
    if (distance < MATCH_THRESHOLD && (!best || distance < best.distance)) {
      best = { photo, anchors, crop, distance };
    }
  }
  return best;
}

/** Maps a normalized point from photo coordinates into the crop. */
export function pointInCrop(
  point: readonly [number, number],
  crop: NormalizedBox,
): [number, number] {
  return [(point[0] - crop[0]) / (crop[2] - crop[0]), (point[1] - crop[1]) / (crop[3] - crop[1])];
}

/** Maps a normalized box from photo coordinates into the crop. */
export function boxInCrop(box: NormalizedBox, crop: NormalizedBox): NormalizedBox {
  const [x0, y0] = pointInCrop([box[0], box[1]], crop);
  const [x1, y1] = pointInCrop([box[2], box[3]], crop);
  return [x0, y0, x1, y1];
}

/** The library anchors expressed in the crop's normalized coordinates. */
export function anchorsInCrop(anchors: LibraryAnchors, crop: NormalizedBox): LibraryAnchors {
  const p = (point: readonly [number, number]) => pointInCrop(point, crop);
  const b = (box: NormalizedBox) => boxInCrop(box, crop);
  const line = (points: readonly (readonly [number, number])[]) => points.map(p);
  return {
    scale: { ...anchors.scale, box: b(anchors.scale.box) },
    eyeHeight: anchors.eyeHeight,
    doors: anchors.doors.map(b),
    doorFrames: anchors.doorFrames.map(b),
    doorGlass: anchors.doorGlass.map(b),
    windows: anchors.windows.map(b),
    windowTops: anchors.windowTops.map(line),
    mantel: anchors.mantel ? line(anchors.mantel) : null,
    rails: anchors.rails.map(line),
    eaves: anchors.eaves.map(line),
    posts: anchors.posts.map(b),
    tableSpots: anchors.tableSpots.map(p),
    surfaceSpots: anchors.surfaceSpots.map(p),
    standSpots: anchors.standSpots.map(p),
    standSurfaces: anchors.standSurfaces.map((surface) => ({
      ...surface,
      from: (surface.from - crop[0]) / (crop[2] - crop[0]),
      to: (surface.to - crop[0]) / (crop[2] - crop[0]),
    })),
    keepClear: anchors.keepClear.map(b),
  };
}
