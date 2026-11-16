import { STRAIGHTEN_MAX_DEGREES, straightenScale, type NormalizedBox } from '@hailiday/core';
import { t } from '../../copy';

export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const CORNERS: readonly Corner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The minimum normalized width and height that keep the crop's short edge at `minPx`. */
export function minimumCropSpan(widthPx: number | null, heightPx: number | null, minPx: number) {
  if (!widthPx || !heightPx) return { x: 0.2, y: 0.2 };
  return { x: clamp(minPx / widthPx, 0.05, 1), y: clamp(minPx / heightPx, 0.05, 1) };
}

/**
 * Moves one corner of a normalized `[x0, y0, x1, y1]` box to a point, keeping the box inside
 * the image and no smaller than the minimum span.
 */
export function moveCorner(
  box: NormalizedBox,
  corner: Corner,
  x: number,
  y: number,
  minSpan: { x: number; y: number },
): NormalizedBox {
  let [x0, y0, x1, y1] = box;
  if (corner === 'topLeft' || corner === 'bottomLeft') x0 = clamp(x, 0, x1 - minSpan.x);
  else x1 = clamp(x, x0 + minSpan.x, 1);
  if (corner === 'topLeft' || corner === 'topRight') y0 = clamp(y, 0, y1 - minSpan.y);
  else y1 = clamp(y, y0 + minSpan.y, 1);
  return [x0, y0, x1, y1];
}

/** The corner's current point. */
export function cornerPoint(box: NormalizedBox, corner: Corner): { x: number; y: number } {
  const [x0, y0, x1, y1] = box;
  return {
    x: corner === 'topLeft' || corner === 'bottomLeft' ? x0 : x1,
    y: corner === 'topLeft' || corner === 'topRight' ? y0 : y1,
  };
}

/** Whether a crop still keeps the short edge at or above the minimum in pixels. */
export function cropMeetsMinimum(
  box: NormalizedBox,
  widthPx: number | null,
  heightPx: number | null,
  minPx: number,
): boolean {
  if (!widthPx || !heightPx) return true;
  const width = (box[2] - box[0]) * widthPx;
  const height = (box[3] - box[1]) * heightPx;
  return Math.min(width, height) >= minPx - 0.5;
}

/** Straighten keyboard steps, in degrees. */
export const STRAIGHTEN_STEP = 0.5;
export const STRAIGHTEN_PAGE_STEP = 5;

/** Clamps a straighten angle to the allowed range, on the half-degree grid. */
export function clampStraighten(degrees: number): number {
  const stepped = Math.round(degrees / STRAIGHTEN_STEP) * STRAIGHTEN_STEP;
  const clamped = clamp(stepped, -STRAIGHTEN_MAX_DEGREES, STRAIGHTEN_MAX_DEGREES);
  return Object.is(clamped, -0) ? 0 : clamped;
}

/**
 * The straighten slider's keyboard model: arrows move half a degree, Page Up and Page Down five
 * degrees, Home and End jump to the limits. Returns null for keys the slider does not handle.
 */
export function nextStraighten(degrees: number, key: string): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clampStraighten(degrees + STRAIGHTEN_STEP);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampStraighten(degrees - STRAIGHTEN_STEP);
    case 'PageUp':
      return clampStraighten(degrees + STRAIGHTEN_PAGE_STEP);
    case 'PageDown':
      return clampStraighten(degrees - STRAIGHTEN_PAGE_STEP);
    case 'Home':
      return -STRAIGHTEN_MAX_DEGREES;
    case 'End':
      return STRAIGHTEN_MAX_DEGREES;
    default:
      return null;
  }
}

/**
 * The photo's size as seen in the straightened view: the server zooms a turned photo to fill its
 * frame, so each normalized unit of a crop box holds fewer source pixels.
 */
export function straightenedSize(
  widthPx: number | null,
  heightPx: number | null,
  degrees: number,
): { width: number | null; height: number | null } {
  if (!widthPx || !heightPx) return { width: widthPx, height: heightPx };
  const scale = straightenScale(degrees, widthPx, heightPx);
  return { width: widthPx / scale, height: heightPx / scale };
}

/** Grows a box about its center (inside the image) until it spans at least the minimum. */
export function fitMinimumSpan(
  box: NormalizedBox,
  minSpan: { x: number; y: number },
): NormalizedBox {
  const grow = (lo: number, hi: number, span: number): [number, number] => {
    if (hi - lo >= span) return [lo, hi];
    const center = clamp((lo + hi) / 2, span / 2, 1 - span / 2);
    return [Math.max(0, center - span / 2), Math.min(1, center + span / 2)];
  };
  const [x0, x1] = grow(box[0], box[2], Math.min(1, minSpan.x));
  const [y0, y1] = grow(box[1], box[3], Math.min(1, minSpan.y));
  return [x0, y0, x1, y1];
}

/** "Level", "2.5° clockwise" or "4° counterclockwise". */
export function straightenText(degrees: number): string {
  if (degrees === 0) return t('upload.straightenLevel');
  const n = Math.abs(degrees).toLocaleString('en-US', { maximumFractionDigits: 1 });
  return degrees > 0
    ? t('upload.straightenClockwise', { n })
    : t('upload.straightenCounterclockwise', { n });
}
