import { z } from 'zod';

/**
 * A region `[x0, y0, x1, y1]` normalized to 0–1 on the working image, origin top-left,
 * x to the right, y down, with `x0 < x1` and `y0 < y1`.
 */
export type NormalizedBox = [number, number, number, number];

const unit = z.number().min(0).max(1);

export const NormalizedBoxSchema = z
  .tuple([unit, unit, unit, unit])
  .refine(([x0, y0, x1, y1]) => x0 < x1 && y0 < y1, {
    message: 'Expected x0 < x1 and y0 < y1',
  });

/** A region is an array of boxes; polygons are not used. */
export const NormalizedRegionSchema = z.array(NormalizedBoxSchema);

/** A box in integer pixels on an image of known size. */
export interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function isNormalizedBox(value: unknown): value is NormalizedBox {
  return NormalizedBoxSchema.safeParse(value).success;
}

export function boxWidth(box: NormalizedBox): number {
  return box[2] - box[0];
}

export function boxHeight(box: NormalizedBox): number {
  return box[3] - box[1];
}

export function boxArea(box: NormalizedBox): number {
  return Math.max(0, boxWidth(box)) * Math.max(0, boxHeight(box));
}

export function boxCenter(box: NormalizedBox): [number, number] {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

/** The overlapping box of two boxes, or null when they do not overlap with positive area. */
export function intersectBoxes(a: NormalizedBox, b: NormalizedBox): NormalizedBox | null {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : null;
}

export function intersectionArea(a: NormalizedBox, b: NormalizedBox): number {
  const overlap = intersectBoxes(a, b);
  return overlap ? boxArea(overlap) : 0;
}

/** Share of `box` covered by `other` (0–1). */
export function overlapFraction(box: NormalizedBox, other: NormalizedBox): number {
  const area = boxArea(box);
  return area === 0 ? 0 : intersectionArea(box, other) / area;
}

/** Share of `box` covered by the union of `others`, measured on a fine grid. */
export function regionOverlapFraction(
  box: NormalizedBox,
  others: readonly NormalizedBox[],
  gridSize = 200,
): number {
  const relevant = others.filter((other) => intersectBoxes(box, other) !== null);
  if (relevant.length === 0) return 0;
  if (relevant.length === 1) return overlapFraction(box, relevant[0] as NormalizedBox);
  let covered = 0;
  let total = 0;
  const w = boxWidth(box);
  const h = boxHeight(box);
  for (let i = 0; i < gridSize; i += 1) {
    const x = box[0] + ((i + 0.5) / gridSize) * w;
    for (let j = 0; j < gridSize; j += 1) {
      const y = box[1] + ((j + 0.5) / gridSize) * h;
      total += 1;
      if (relevant.some((o) => x >= o[0] && x <= o[2] && y >= o[1] && y <= o[3])) covered += 1;
    }
  }
  return total === 0 ? 0 : covered / total;
}

/** Intersection over union. */
export function boxIoU(a: NormalizedBox, b: NormalizedBox): number {
  const inter = intersectionArea(a, b);
  const union = boxArea(a) + boxArea(b) - inter;
  return union === 0 ? 0 : inter / union;
}

/** Whether `inner` lies inside `outer`, allowing `tolerance` on each edge. */
export function boxContains(outer: NormalizedBox, inner: NormalizedBox, tolerance = 0): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  );
}

/** Clamps a box to the unit square; returns null when nothing with positive area remains. */
export function clampBox(box: readonly number[]): NormalizedBox | null {
  const [a = 0, b = 0, c = 0, d = 0] = box;
  const x0 = Math.min(1, Math.max(0, Math.min(a, c)));
  const x1 = Math.min(1, Math.max(0, Math.max(a, c)));
  const y0 = Math.min(1, Math.max(0, Math.min(b, d)));
  const y1 = Math.min(1, Math.max(0, Math.max(b, d)));
  return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : null;
}

/** Grows (or shrinks with a negative value) a box on every side, clamped to the image. */
export function expandBox(box: NormalizedBox, dx: number, dy: number = dx): NormalizedBox | null {
  return clampBox([box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy]);
}

/** The smallest box containing all boxes. */
export function boundingBox(boxes: readonly NormalizedBox[]): NormalizedBox | null {
  if (boxes.length === 0) return null;
  return clampBox([
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ]);
}

/** Converts to integer pixels with `px = round(x × width)`, `py = round(y × height)`. */
export function toPixelBox(box: NormalizedBox, width: number, height: number): PixelBox {
  const left = Math.round(box[0] * width);
  const top = Math.round(box[1] * height);
  const right = Math.round(box[2] * width);
  const bottom = Math.round(box[3] * height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Converts a pixel rectangle back to a normalized box. */
export function fromPixelBox(pixel: PixelBox, width: number, height: number): NormalizedBox | null {
  if (width <= 0 || height <= 0) return null;
  return clampBox([
    pixel.left / width,
    pixel.top / height,
    (pixel.left + pixel.width) / width,
    (pixel.top + pixel.height) / height,
  ]);
}

/**
 * Converts a vendor box `[ymin, xmin, ymax, xmax]` on a 0–`scale` grid (Gemini uses 1000)
 * to the canonical normalized box.
 */
export function fromYxBox(box: readonly number[], scale = 1000): NormalizedBox | null {
  const [ymin = 0, xmin = 0, ymax = 0, xmax = 0] = box;
  return clampBox([xmin / scale, ymin / scale, xmax / scale, ymax / scale]);
}

/** Horizontal and vertical third of a box center, used for position words. */
export function boxThirds(box: NormalizedBox): {
  horizontal: 'left' | 'center' | 'right';
  vertical: 'upper' | 'middle' | 'lower';
} {
  const [cx, cy] = boxCenter(box);
  return {
    horizontal: cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center',
    vertical: cy < 1 / 3 ? 'upper' : cy > 2 / 3 ? 'lower' : 'middle',
  };
}
