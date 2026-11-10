import { clampBox, type MaskShape, type NormalizedBox, type NormalizedPoint } from '@holiday/core';

/** Integer pixel rectangle `[x0, x1)` × `[y0, y1)`. */
interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A box as a pixel rectangle (`px = round(x × width)`, clamped), the mask builder's rounding. */
export function boxToPixels(box: NormalizedBox, width: number, height: number): PixelRect {
  const x0 = Math.max(0, Math.min(width, Math.round(box[0] * width)));
  const y0 = Math.max(0, Math.min(height, Math.round(box[1] * height)));
  const x1 = Math.max(x0, Math.min(width, Math.round(box[2] * width)));
  const y1 = Math.max(y0, Math.min(height, Math.round(box[3] * height)));
  return { x0, y0, x1, y1 };
}

/** A box mask shape. */
export function boxShape(box: NormalizedBox): MaskShape {
  return { kind: 'box', box };
}

/** The bounding box of a shape, or null when it has no area. */
export function shapeBounds(shape: MaskShape): NormalizedBox | null {
  if (shape.kind === 'box') return shape.box;
  const xs = shape.points.map((point) => point[0]);
  const ys = shape.points.map((point) => point[1]);
  return clampBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
}

/** The bounding box of several shapes, or null when none has area. */
export function shapesBounds(shapes: readonly MaskShape[]): NormalizedBox | null {
  const boxes = shapes.map(shapeBounds).filter((box): box is NormalizedBox => box !== null);
  if (boxes.length === 0) return null;
  return clampBox([
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ]);
}

/** Keeps the part of a polygon on one side of an axis-aligned line (one Sutherland–Hodgman pass). */
function clipAgainst(
  input: readonly NormalizedPoint[],
  axis: 0 | 1,
  value: number,
  keepAbove: boolean,
): NormalizedPoint[] {
  const inside = (p: NormalizedPoint) => (keepAbove ? p[axis] >= value : p[axis] <= value);
  const cut = (a: NormalizedPoint, b: NormalizedPoint): NormalizedPoint => {
    const t = (value - a[axis]) / (b[axis] - a[axis]);
    return axis === 0 ? [value, a[1] + (b[1] - a[1]) * t] : [a[0] + (b[0] - a[0]) * t, value];
  };
  const output: NormalizedPoint[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const current = input[i] as NormalizedPoint;
    const previous = input[(i + input.length - 1) % input.length] as NormalizedPoint;
    if (inside(current)) {
      if (!inside(previous)) output.push(cut(previous, current));
      output.push(current);
    } else if (inside(previous)) {
      output.push(cut(previous, current));
    }
  }
  return output;
}

/** Clips a convex polygon to a box. */
function clipPolygon(points: readonly NormalizedPoint[], box: NormalizedBox): NormalizedPoint[] {
  let output = clipAgainst(points, 0, box[0], true);
  output = clipAgainst(output, 0, box[2], false);
  output = clipAgainst(output, 1, box[1], true);
  return clipAgainst(output, 1, box[3], false);
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Twice the signed area of a polygon (shoelace). */
function doubledArea(points: readonly NormalizedPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as NormalizedPoint;
    const b = points[(i + 1) % points.length] as NormalizedPoint;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/**
 * Clips a shape to a box (and to the image); coordinates are rounded to four decimals so plans
 * stay stable. Returns null when nothing with area remains.
 */
export function clipShape(shape: MaskShape, box: NormalizedBox): MaskShape | null {
  const bounds = clampBox(box);
  if (!bounds) return null;
  if (shape.kind === 'box') {
    const clipped = clampBox([
      Math.max(shape.box[0], bounds[0]),
      Math.max(shape.box[1], bounds[1]),
      Math.min(shape.box[2], bounds[2]),
      Math.min(shape.box[3], bounds[3]),
    ]);
    if (!clipped) return null;
    const rounded = clampBox(clipped.map(round4));
    return rounded ? { kind: 'box', box: rounded } : null;
  }
  const points = clipPolygon(shape.points, bounds).map(
    (point) => [round4(point[0]), round4(point[1])] as NormalizedPoint,
  );
  const distinct = points.filter((point, i) => {
    const next = points[(i + 1) % points.length] as NormalizedPoint;
    return point[0] !== next[0] || point[1] !== next[1];
  });
  if (distinct.length < 3 || Math.abs(doubledArea(distinct)) < 1e-8) return null;
  return { kind: 'polygon', points: distinct };
}

/** Clips every shape to a box, dropping shapes with nothing left. */
export function clipShapes(shapes: readonly MaskShape[], box: NormalizedBox): MaskShape[] {
  return shapes
    .map((shape) => clipShape(shape, box))
    .filter((shape): shape is MaskShape => shape !== null);
}

/**
 * Sets `value` on every pixel of `target` (row-major, `width` × `height`) whose center lies in
 * the shape. Boxes use the mask builder's rounding, so a box shape fills exactly the pixels a box
 * region always filled.
 */
export function fillShape(
  target: Uint8Array,
  width: number,
  height: number,
  shape: MaskShape,
  value = 1,
): void {
  if (shape.kind === 'box') {
    const rect = boxToPixels(shape.box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      target.fill(value, y * width + rect.x0, y * width + rect.x1);
    }
    return;
  }
  const points = shape.points.map(([x, y]) => [x * width, y * height] as const);
  const ys = points.map((point) => point[1]);
  const top = Math.max(0, Math.floor(Math.min(...ys) - 0.5));
  const bottom = Math.min(height - 1, Math.ceil(Math.max(...ys)));
  for (let y = top; y <= bottom; y += 1) {
    const v = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i] as readonly [number, number];
      const b = points[(i + 1) % points.length] as readonly [number, number];
      if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) {
        crossings.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil((crossings[i] as number) - 0.5));
      const to = Math.min(width, Math.ceil((crossings[i + 1] as number) - 0.5));
      if (to > from) target.fill(value, y * width + from, y * width + to);
    }
  }
}

/** Rasterizes the union of shapes on a pixel grid (1 inside, 0 outside). */
export function rasterizeShapes(
  shapes: readonly MaskShape[],
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (const shape of shapes) fillShape(out, width, height, shape, 1);
  return out;
}

/**
 * Share of the image the union of shapes covers, measured on a grid whose long edge is
 * `resolution` pixels with the image's aspect.
 */
export function shapesCoverage(
  shapes: readonly MaskShape[],
  aspect: { width: number; height: number },
  resolution = 512,
): number {
  const scale = resolution / Math.max(aspect.width, aspect.height);
  const width = Math.max(1, Math.round(aspect.width * scale));
  const height = Math.max(1, Math.round(aspect.height * scale));
  const raster = rasterizeShapes(shapes, width, height);
  let covered = 0;
  for (const value of raster) covered += value;
  return covered / raster.length;
}
