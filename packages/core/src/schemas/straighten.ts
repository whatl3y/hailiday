import { z } from 'zod';
import type { NormalizedBox } from './box.js';

/**
 * Straightening for the people crop. The photo turns about its center by `rotation` degrees
 * (positive is clockwise on screen) and zooms just enough to fill its own frame again, so the
 * straightened view has the original width and height and no empty corners. A crop box is
 * normalized on that straightened view.
 */
export const STRAIGHTEN_MAX_DEGREES = 15;

export const StraightenDegreesSchema = z
  .number()
  .min(-STRAIGHTEN_MAX_DEGREES)
  .max(STRAIGHTEN_MAX_DEGREES);

const radians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * The zoom that makes a `width` × `height` photo turned by `degrees` cover its own frame:
 * `cos θ + max(w/h, h/w) · sin θ`. 1 when the photo is not turned.
 */
export function straightenScale(degrees: number, width: number, height: number): number {
  const angle = Math.abs(radians(degrees));
  if (angle === 0 || !(width > 0) || !(height > 0)) return 1;
  const aspect = width / height;
  return Math.cos(angle) + Math.max(aspect, 1 / aspect) * Math.sin(angle);
}

/**
 * Maps a point of the photo (pixels, origin top-left) into the straightened view (pixels of the
 * same frame).
 */
export function straightenPoint(
  point: readonly [number, number],
  degrees: number,
  width: number,
  height: number,
): [number, number] {
  const scale = straightenScale(degrees, width, height);
  const angle = radians(degrees);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = point[0] - width / 2;
  const dy = point[1] - height / 2;
  return [width / 2 + scale * (cos * dx - sin * dy), height / 2 + scale * (sin * dx + cos * dy)];
}

/**
 * The axis-aligned bounds, normalized on the straightened view, of a box normalized on the
 * photo. Not clamped: parts of the box the zoom pushes out of the frame lie outside 0–1.
 */
export function straightenBoxBounds(
  box: NormalizedBox,
  degrees: number,
  width: number,
  height: number,
): [number, number, number, number] {
  const corners = [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[0], box[3]],
    [box[2], box[3]],
  ].map(([x, y]) =>
    straightenPoint([(x as number) * width, (y as number) * height], degrees, width, height),
  );
  const xs = corners.map(([x]) => x / width);
  const ys = corners.map(([, y]) => y / height);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
