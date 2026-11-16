import type { NormalizedBox } from '@hailiday/core';
import type { PIPELINE_DEFAULTS } from '../versions.js';
import { attributionStrokes, attributionStrokesReliable } from './attribution.js';
import { nativeBoxesOnWorkingGrid, type WorkingImage } from './working.js';

type AttributionSettings = (typeof PIPELINE_DEFAULTS)['attributionRelight'];

/** Whether `box` lies wholly inside `crop` (both normalized on the native image). */
function insideCrop(box: NormalizedBox, crop: NormalizedBox | null): boolean {
  if (crop === null) return true;
  return box[0] >= crop[0] && box[1] >= crop[1] && box[2] <= crop[2] && box[3] <= crop[3];
}

/**
 * The embedded attribution rectangles of a picture that is a whole Street View Static frame, on
 * the working grid; empty for any other picture.
 *
 * A picture is such a frame when its native size has rectangles configured (`configured`, keyed
 * `"<width>x<height>"` as `STREET_VIEW_ATTRIBUTION_REGIONS`), the working image holds every one
 * of them whole (no padding, and no aspect crop that cuts into one), and every rectangle carries
 * its mark in the picture itself: `attributionStrokes` on the working image finds strokes there
 * and `attributionStrokesReliable` accepts their share. The rectangles are then those of a Street
 * View source of that size (`nativeBoxesOnWorkingGrid`). Deterministic: the same pixels give the
 * same answer.
 */
export function embeddedAttributionRegions(
  working: Pick<WorkingImage, 'raster' | 'nativeWidth' | 'nativeHeight' | 'cropBox' | 'contentBox'>,
  configured: Readonly<Record<string, readonly NormalizedBox[]>>,
  settings?: Partial<AttributionSettings>,
): NormalizedBox[] {
  const boxes = configured[`${working.nativeWidth}x${working.nativeHeight}`];
  if (!boxes || boxes.length === 0) return [];
  if (working.contentBox !== null) return [];
  if (!boxes.every((box) => insideCrop(box, working.cropBox))) return [];
  const mapped = nativeBoxesOnWorkingGrid(boxes, working);
  if (mapped.length !== boxes.length) return [];
  for (const box of mapped) {
    const { share } = attributionStrokes(working.raster, box, settings);
    if (!attributionStrokesReliable(share, settings)) return [];
  }
  return mapped;
}

/**
 * Width allowed per character of a frame's copyright line, in pixels of the Static frame. The
 * label's box measured 77 px for "© 2026 Google" (13 characters) on live 640x640 frames, about
 * 5.9 px a character with the box's margins; 9 px is half as much again, for wider glyphs and a
 * year or prefix the stored line may lack.
 */
export const COPYRIGHT_LABEL_CHAR_PX = 9;
/** Pixels added to that width: the box's margins and ground left of it to see its edge on. */
export const COPYRIGHT_LABEL_PAD_PX = 16;
/**
 * The leftmost start of a copyright label rectangle, as a fraction of the frame's width: half
 * the frame, which still holds a line of 50 characters at the measured density and stays clear
 * of the logo's rectangle at the lower left.
 */
export const COPYRIGHT_LABEL_MIN_X0 = 0.5;

/**
 * The attribution rectangles of a live Street View Static frame (`configured`, normalized to the
 * frame) with the copyright label's rectangle made wide enough for the frame's own copyright line.
 * The label is drawn right-aligned at the lower right, so its rectangle is the configured one that
 * reaches the frame's right and bottom edges. For imagery attributed to Google the configured
 * rectangles are returned as they are (they were measured on Google's label). For any other
 * imagery with a copyright line, that rectangle starts `COPYRIGHT_LABEL_CHAR_PX` per character
 * (counting a leading "© " the line may lack) plus `COPYRIGHT_LABEL_PAD_PX` left of the frame's
 * right edge, at `frameWidth` pixels, when that is left of where it starts, and never left of
 * `COPYRIGHT_LABEL_MIN_X0`.
 */
export function copyrightLabelRegions(
  configured: readonly NormalizedBox[],
  frame: { frameWidth: number; copyright: string | null; isGoogleImagery: boolean | null },
): NormalizedBox[] {
  const boxes = configured.map((box) => [...box] as NormalizedBox);
  const line = frame.copyright?.trim() ?? '';
  if (frame.isGoogleImagery === true || line === '' || frame.frameWidth <= 0) return boxes;
  const characters = [...line].length + (line.startsWith('©') ? 0 : 2);
  const widthPx = characters * COPYRIGHT_LABEL_CHAR_PX + COPYRIGHT_LABEL_PAD_PX;
  const start = Math.max(COPYRIGHT_LABEL_MIN_X0, 1 - widthPx / frame.frameWidth);
  return boxes.map((box) =>
    box[2] >= 1 && box[3] >= 1 && box[0] > 0 && start < box[0]
      ? ([start, box[1], box[2], box[3]] as NormalizedBox)
      : box,
  );
}
