import type { NormalizedBox } from '@hailiday/core';
import { TO_LINEAR, smoothstep, toSrgb } from '../../fixtures/canvas.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { copyRect, toRect, type PxRect, type Raster } from './raster.js';

type AttributionSettings = (typeof PIPELINE_DEFAULTS)['attributionRelight'];

/** One accepted stroke component of an attribution rectangle (in-frame pixels only). */
export interface AttributionStrokeComponent {
  /** Bounding box of its pixels in the frame (`x1` and `y1` exclusive). */
  box: PxRect;
  /** Its pixel count. */
  area: number;
  /** 90th percentile of the unblurred luma (0 to 1) over its pixels. */
  fill: number;
  /** `fill` minus the median unblurred luma of its surround. */
  contrast: number;
}

/** The attribution strokes of one rectangle of a base image. */
export interface AttributionStrokes {
  /** The rectangle in pixels (`toRect` of the box). */
  rect: PxRect;
  /** Per pixel of the rectangle, row by row: 0 (ground) to 1 (stroke kept from the base). */
  keep: Float32Array;
  /** Pixels of the rectangle whose `keep` is above 0.5, as a share of its area. */
  share: number;
  /** The accepted stroke components, left to right; empty when no stroke was found. */
  components: AttributionStrokeComponent[];
}

/** A stroke component's in-frame pixels (window indices) and measures. */
interface StrokeComponent extends AttributionStrokeComponent {
  pixels: number[];
  /** Side of the largest square of its pixels near its fill (see `thicknessLevel`). */
  thickness: number;
}

/** The measures of a set of pixels (see `attributionStrokes`). */
interface Measures {
  fill: number;
  contrast: number;
  need: number;
  thickness: number;
}

/** One line of strokes: its anchor, rows, and the run of candidates from the anchor. */
interface Line {
  anchor: StrokeComponent;
  top: number;
  bottom: number;
  height: number;
  members: StrokeComponent[];
  left: number;
  right: number;
  area: number;
}

/** How one attribution rectangle was restored into a relit image. */
export type AttributionRestoreMode = 'adapted' | 'verbatim';

export interface AttributionRestore {
  raster: Raster;
  mode: AttributionRestoreMode;
  share: number;
  /** The relight's per-channel gain in linear light, measured on the ring; null when verbatim. */
  gain: [number, number, number] | null;
}

const settingsOf = (overrides?: Partial<AttributionSettings>): AttributionSettings => ({
  ...PIPELINE_DEFAULTS.attributionRelight,
  ...(overrides ?? {}),
});

/** Running min or max of a plane along rows, then along columns (square window, clamped edges). */
function squareFilter(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
  pick: (a: number, b: number) => number,
): Float32Array {
  const rows = new Float32Array(src.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let v = src[row + x] as number;
      const from = Math.max(0, x - radius);
      const to = Math.min(width - 1, x + radius);
      for (let xx = from; xx <= to; xx += 1) v = pick(v, src[row + xx] as number);
      rows[row + x] = v;
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y += 1) {
    const from = Math.max(0, y - radius);
    const to = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      let v = rows[y * width + x] as number;
      for (let yy = from; yy <= to; yy += 1) v = pick(v, rows[yy * width + x] as number);
      out[y * width + x] = v;
    }
  }
  return out;
}

/** The value at quantile `q` of `values` (sorted copy, nearest rank below). */
function quantile(values: readonly number[], q: number): number {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
}

/** Whether `inner` lies inside `outer` (both with `x1` and `y1` exclusive). */
const containsRect = (outer: PxRect, inner: PxRect) =>
  inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;

/**
 * The inside of the copyright label's dark box in a rectangle that reaches the frame's right and
 * bottom edges (`width` and `height`), or null when the box is not seen. `luma(x, y)` is the
 * unblurred luma of frame pixel `(x, y)`. The box passes about 0.30 of the ground behind it, and
 * its glyphs keep a few pixels from its edges.
 *
 * A step of an edge is seen at a pixel when the mean luma of the `band` rows (or columns) inside
 * the edge is at most `stepRatio` of the ground outside it: the brightest of the `outside` rows
 * (or columns) beyond a `gap` (a soft edge), which must reach `minGround`, or the step cannot be
 * seen. The top edge is the topmost row whose step is seen on `edgeShare` of the `probe` columns
 * at the frame's right edge (the glyphs' lower edges step down too, lower in the box); the left
 * edge below it is found as `leftFrom` says; the top edge is then found again over the box's
 * width, and the left edge below it; and the top edge must show its step on `edgeShare` of the
 * columns from the left edge to the frame's right edge. The inside starts `inset` pixels within
 * the left edge and the top edge's first row.
 */
function labelBoxOf(
  luma: (x: number, y: number) => number,
  rect: PxRect,
  width: number,
  height: number,
  p: {
    band: number;
    outside: number;
    gap: number;
    corner: number;
    cornerRows: number;
    probe: number;
    cornerShare: number;
    insideShare: number;
    stepRatio: number;
    minGround: number;
    edgeShare: number;
    inset: number;
    /** The first row and column the window can read. */
    firstRow: number;
    firstColumn: number;
  },
): PxRect | null {
  const { band, outside, gap } = p;
  const stepAt = (out: number, inside: number) => out >= p.minGround && inside <= p.stepRatio * out;
  /**
   * The step of a top edge at row `y`, seen at column `x`: the ground above is the brightest of
   * the `outside` rows (dark gaps in gravel beside the box do not hide its edge), or their mean
   * when `strict` (texture alone does not make a step).
   */
  const topStep = (x: number, y: number, strict = false) => {
    let above = 0;
    let below = 0;
    for (let k = 1; k <= outside; k += 1) {
      const v = luma(x, y - gap - k);
      above = strict ? above + v / outside : Math.max(above, v);
    }
    for (let k = 0; k < band; k += 1) below += luma(x, y + k);
    return stepAt(above, below / band);
  };
  /** The step of a left edge at column `x`, seen at row `y`. */
  const leftStep = (x: number, y: number) => {
    let before = 0;
    let after = 0;
    for (let k = 1; k <= outside; k += 1) before = Math.max(before, luma(x - gap - k, y));
    for (let k = 0; k < band; k += 1) after += luma(x + k, y);
    return stepAt(before, after / band);
  };
  const topShare = (y: number, from: number, to = width, strict = false) => {
    let seen = 0;
    for (let x = from; x < to; x += 1) if (topStep(x, y, strict)) seen += 1;
    return seen / (to - from);
  };
  const leftShare = (x: number, from: number, to = height) => {
    let seen = 0;
    for (let y = from; y < to; y += 1) if (leftStep(x, y)) seen += 1;
    return seen / (to - from);
  };
  const firstRow = Math.max(rect.y0 + 1, p.firstRow + gap + outside);
  const lastRow = height - band;
  const firstColumn = Math.max(rect.x0 + 1, p.firstColumn + gap + outside);
  const probeFrom = Math.max(firstColumn, width - p.probe);
  /**
   * The top edge over the columns from `from`: the topmost row whose step is seen on `edgeShare`
   * of those columns (on a soft edge, the row before the box's first dark row), and the row
   * after it, where the box's dark rows begin; null when there is none.
   */
  const topFrom = (from: number) => {
    for (let y = firstRow; y < lastRow; y += 1) {
      if (topShare(y, from) >= p.edgeShare) return { first: y, top: Math.min(lastRow - 1, y + 1) };
    }
    return null;
  };
  /**
   * The left edge below the top edge, whose box's dark rows begin at `top`. A column is the
   * box's left edge when the edges meet there: its step is seen on `edgeShare` of the rows from
   * `top` and on `cornerShare` of the `cornerRows` rows from `top`, which the glyphs leave free
   * under the top edge (a glyph's right side steps down too, but only over the glyph's rows), and
   * the top edge's step at `top` is seen on `cornerShare` of the `corner` columns right of it and
   * on less than `insideShare` of those left of it, the ground above taken as the mean of its
   * rows (left of an edge inside the box, the top edge goes on; beside a step of the ground left
   * of the box, it is not there). Such columns must form one run (columns within
   * `gap + outside` of the edge still see the ground beyond it), whose first column is the edge
   * (a second run is a corner of the ground, and the box cannot be told from it); -1 otherwise.
   */
  const leftFrom = (top: number) => {
    let left = -1;
    let last = -2;
    for (let x = firstColumn; x < probeFrom; x += 1) {
      if (leftShare(x, top) < p.edgeShare) continue;
      if (leftShare(x, top, Math.min(height, top + p.cornerRows)) < p.cornerShare) continue;
      if (topShare(top, x, Math.min(width, x + p.corner)) < p.cornerShare) continue;
      if (topShare(top, Math.max(firstColumn, x - p.corner), x - gap, true) >= p.insideShare) {
        continue;
      }
      if (left >= 0 && x > last + gap + outside) return -1;
      if (left < 0) left = x;
      last = x;
    }
    return left;
  };
  // The probe columns at the frame's right edge give a first top edge (the glyphs' lower edges
  // step down too, lower in the box); the left edge found from it gives the box's width, over
  // which the top edge is found again.
  let edge = topFrom(probeFrom);
  if (edge === null) return null;
  let left = leftFrom(edge.top);
  if (left < 0) return null;
  edge = topFrom(left);
  if (edge === null) return null;
  left = leftFrom(edge.top);
  if (left < 0 || topShare(edge.top, left) < p.edgeShare) return null;
  return { x0: left + p.inset, y0: edge.first + p.inset, x1: width, y1: height };
}

/**
 * The logo and copyright strokes inside an attribution rectangle of `base`.
 *
 * Detection: on a window around the rectangle (beyond a frame edge, the edge pixels repeated),
 * the top-hat (3x3 mean luma minus its morphological opening) marks pixels much brighter than
 * their surroundings, and a pixel with a chroma above `maxStrokeChroma` is never a stroke (the
 * strokes are white or light grey). Every measure below counts only pixels inside the frame.
 *
 * The mark's place: each mark has a known place, and only strong response inside it can be a
 * stroke or join a stroke's component. The logo's place is `logoPlace` (fractions of the frame;
 * the letters' extent on Street View frames); a rectangle that holds it is the logo's. A
 * rectangle that reaches the frame's right and bottom edges is the copyright label's, whose place
 * is the inside of its dark box, found from the picture (`labelBoxOf`); when the box is not seen
 * there are no strokes. Any other rectangle (drawn around its credit, as fixture frames do) is its
 * own place.
 *
 * Measures of a set of pixels: its fill (90th percentile of the unblurred luma), its contrast
 * (the fill minus the median unblurred luma of its surround, the pixels within `surroundPx` that
 * are not excluded), the contrast it needs, `max(minContrast, contrastOfFill * fill)`, and its
 * thickness (the side of the largest square of its pixels at least `thicknessLevel` of the way
 * from the surround to the fill).
 *
 * Candidates: a component of `minStrokeArea` to `maxStrokeArea` (scaled with the image area)
 * wholly inside the region looked at is a candidate when it has the contrast it needs and is at
 * most `maxStrokeThickness` thick. A larger component, one crossing the region's edge, or one of
 * enough contrast that is too thick (a stroke touching a blob) is split into its bright parts
 * (pixels at least its fill minus `fillLow`, 8-connected); the parts of the right size inside
 * the region are tested the same way, and those that pass, grouped by fill, are candidates.
 *
 * One mark, one line: the run of a candidate is the candidates within the fill tolerance of it,
 * in its line (its rows grown by `lineSlack` of its height above and `lineSlackBelow` below), at
 * least `minHeightShare` of its height tall, reached through each other without a horizontal
 * gap wider than `runGap` heights. The run of the largest area is the mark; its largest member
 * is the anchor, whose own run is the accepted components.
 *
 * Bright parts: the accepted components' pixels at least as bright as the anchor's fill minus
 * `fillLow`, 8-connected, are strokes when each part on its own has the contrast it needs (its
 * surround: the pixels that are not in a bright part), is no thicker than the anchor plus
 * `thicknessAllowance`, has the anchor's fill when the mark is opaque (anchor fill at least
 * `opaqueFill`), and is at least `minStrokeArea` large or lies within the rows of the parts that
 * are. Bright ground joined to a stroke only through the stroke's dark outline is a part of its
 * own and is not kept; of two parts one above the other, the one farther from the middle of the
 * line is not kept. In the label, a stroke pixel lies next to one at least `labelGlyphShare` of
 * the anchor's fill (bright ground under the translucent box stays dimmer).
 *
 * Whole or not at all: no stroke is found (the rectangle is then restored verbatim; a mark
 * restored without one of its strokes, or with daylight ground beside it, would be damaged)
 * - when something rejected may be one of the mark's strokes (about the mark's fill, in its line
 *   and run, sharing rows with a kept stroke and not above or below one, and rejected only
 *   narrowly by contrast or thickness, or by height or fill, or left out of the anchor's run);
 * - when a candidate of the whole rectangle with pixels outside the place lies in the mark's run
 *   beside its strokes (a look-alike beside the mark, or a stroke the place left out);
 * - when a kept stroke reaches out of the place with pixels of about the mark's fill;
 * - when the strokes stop short of a side of the place by more than `markLeadPx` (the logo's
 *   letters span their place; the label's glyphs start a few pixels inside the box and end a
 *   few pixels short of the frame's edge);
 * - logo: when loose parts of the place (letter-bright pixels in no accepted component, beside
 *   the letters and sharing their rows, of about their fill and contrast) add up to
 *   `minStrokeArea`: a letter lost with ground joined to it;
 * - label: when more than `boxStrayPx` pixels inside the box as bright as a glyph are not a kept
 *   stroke or next to one (the box passes about 0.30 of the ground, so nothing else there is
 *   that bright), or when something in the box is brighter than the anchor's fill by more than
 *   `boxPeakMargin`.
 *
 * The keep matte, on the strokes grown by one pixel, is a smoothstep of the unblurred
 * top-hat (stroke edges stay soft) times a smoothstep of the unblurred luma below the anchor's
 * fill (ground merged into a stroke's component is darker than the stroke and is not kept).
 * Deterministic.
 */
export function attributionStrokes(
  base: Raster,
  box: NormalizedBox,
  overrides?: Partial<AttributionSettings>,
): AttributionStrokes {
  const s = settingsOf(overrides);
  const { width, height, data } = base;
  const long = Math.max(width, height);
  const rect = toRect(box, width, height);
  const rw = rect.x1 - rect.x0;
  const rh = rect.y1 - rect.y0;
  const keep = new Float32Array(rw * rh);
  if (rw <= 0 || rh <= 0) return { rect, keep, share: 0, components: [] };
  const scale = long / 1024;
  const radius = Math.max(s.minRadiusPx, Math.round(s.radiusFraction * long));
  const minArea = Math.max(s.minStrokeAreaFloor, Math.round(s.minStrokeArea * scale ** 2));
  const maxArea = Math.max(minArea, Math.round(s.maxStrokeArea * scale ** 2));
  const surroundPx = Math.max(1, Math.round(s.surroundPx * scale));
  // The window is not clamped to the frame: beyond a frame edge it reads the edge pixels again, so
  // ground trapped between a stroke and the frame edge is as wide as the structuring element.
  const wx0 = rect.x0 - radius - 1;
  const wy0 = rect.y0 - radius - 1;
  const wx1 = rect.x1 + radius + 1;
  const wy1 = rect.y1 + radius + 1;
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  const n = ww * wh;

  const raw = new Float32Array(n);
  const chroma = new Float32Array(n);
  const inFrame = new Uint8Array(n);
  for (let y = 0; y < wh; y += 1) {
    const fy = y + wy0;
    const sy = Math.min(height - 1, Math.max(0, fy));
    for (let x = 0; x < ww; x += 1) {
      const fx = x + wx0;
      const sx = Math.min(width - 1, Math.max(0, fx));
      const p = (sy * width + sx) * 3;
      const r = data[p] as number;
      const g = data[p + 1] as number;
      const b = data[p + 2] as number;
      raw[y * ww + x] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      chroma[y * ww + x] = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      if (fx >= 0 && fx < width && fy >= 0 && fy < height) inFrame[y * ww + x] = 1;
    }
  }
  const mean = new Float32Array(n);
  for (let y = 0; y < wh; y += 1) {
    for (let x = 0; x < ww; x += 1) {
      let sum = 0;
      let count = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(wh - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(ww - 1, x + 1); xx += 1) {
          sum += raw[yy * ww + xx] as number;
          count += 1;
        }
      }
      mean[y * ww + x] = sum / count;
    }
  }
  const opened = squareFilter(
    squareFilter(mean, ww, wh, radius, Math.min),
    ww,
    wh,
    radius,
    Math.max,
  );

  const strong = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (
      (mean[i] as number) - (opened[i] as number) > s.strokeThreshold &&
      (chroma[i] as number) <= s.maxStrokeChroma
    ) {
      strong[i] = 1;
    }
  }
  const none = (): AttributionStrokes => ({ rect, keep, share: 0, components: [] });

  // The mark's place: the logo's fixed place when the rectangle holds it; the inside of the
  // label's dark box when the rectangle reaches the frame's right and bottom edges (the box
  // reaches them too); otherwise the rectangle itself (a rectangle drawn around its credit, as
  // fixture frames do). Nothing outside the place is a stroke or joins a stroke's component.
  const [px0, py0, px1, py1] = s.logoPlace;
  const logoPlace = toRect([px0, py0, px1, py1], width, height);
  const isLogo = containsRect(rect, logoPlace);
  let place: PxRect | null = isLogo ? logoPlace : rect;
  const boxed = !isLogo && rect.x1 === width && rect.y1 === height;
  if (boxed) {
    place = labelBoxOf((x, y) => raw[(y - wy0) * ww + x - wx0] as number, rect, width, height, {
      band: Math.max(2, Math.round(s.boxBandPx * scale)),
      outside: Math.max(2, Math.round(s.boxOutsidePx * scale)),
      gap: Math.max(1, Math.round(s.boxGapPx * scale)),
      corner: Math.max(4, Math.round(s.boxCornerPx * scale)),
      cornerRows: Math.max(2, Math.round(s.boxCornerRows * scale)),
      probe: Math.round(s.boxProbePx * scale),
      cornerShare: s.boxCornerShare,
      insideShare: s.boxInsideShare,
      stepRatio: s.boxStepRatio,
      minGround: s.boxMinGround,
      edgeShare: s.boxEdgeShare,
      inset: Math.max(1, Math.round(s.boxInsetPx * scale)),
      firstRow: wy0,
      firstColumn: wx0,
    });
  }
  if (place === null) return none();
  const inPlace = new Uint8Array(n);
  for (let fy = place.y0; fy < place.y1; fy += 1) {
    for (let fx = place.x0; fx < place.x1; fx += 1) inPlace[(fy - wy0) * ww + fx - wx0] = 1;
  }
  const placed = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) if (strong[i] && inPlace[i]) placed[i] = 1;
  /** 8-connected components of `mask`, each as its pixels inside the frame (window indices). */
  const connected = (mask: Uint8Array): number[][] => {
    const groups: number[][] = [];
    const seen = new Uint8Array(n);
    const stack: number[] = [];
    for (let start = 0; start < n; start += 1) {
      if (!mask[start] || seen[start]) continue;
      seen[start] = 1;
      stack.push(start);
      const pixels: number[] = [];
      while (stack.length > 0) {
        const p = stack.pop() as number;
        if (inFrame[p]) pixels.push(p);
        const px = p % ww;
        const py = (p - px) / ww;
        for (let yy = Math.max(0, py - 1); yy <= Math.min(wh - 1, py + 1); yy += 1) {
          for (let xx = Math.max(0, px - 1); xx <= Math.min(ww - 1, px + 1); xx += 1) {
            const q = yy * ww + xx;
            if (mask[q] && !seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
          }
        }
      }
      groups.push(pixels);
    }
    return groups;
  };
  /** The pixels of `pixels` at least `level` bright, 8-connected. */
  const partsOf = (pixels: readonly number[], level: number): number[][] => {
    const mask = new Uint8Array(n);
    for (const p of pixels) if ((raw[p] as number) >= level) mask[p] = 1;
    return connected(mask);
  };
  const surroundMark = new Int32Array(n).fill(-1);
  let surroundStamp = 0;
  const boundsOf = (pixels: readonly number[]): PxRect => {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of pixels) {
      const fx = (p % ww) + wx0;
      const fy = Math.floor(p / ww) + wy0;
      b.x0 = Math.min(b.x0, fx);
      b.y0 = Math.min(b.y0, fy);
      b.x1 = Math.max(b.x1, fx + 1);
      b.y1 = Math.max(b.y1, fy + 1);
    }
    return b;
  };
  const touchesRect = (b: PxRect) =>
    b.x1 > rect.x0 && b.x0 < rect.x1 && b.y1 > rect.y0 && b.y0 < rect.y1;
  /** Whether `b` lies above or below `k`: columns shared over half the narrower, no row shared. */
  const overUnder = (b: PxRect, k: PxRect) =>
    Math.min(b.x1, k.x1) - Math.max(b.x0, k.x0) >= Math.min(b.x1 - b.x0, k.x1 - k.x0) / 2 &&
    (b.y1 <= k.y0 || b.y0 >= k.y1);
  /** Side of the largest square of `pixels` (window indices) that pass `inside`. */
  const squareSide = (pixels: readonly number[], inside: (p: number) => boolean): number => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pixels) {
      const px = p % ww;
      const py = (p - px) / ww;
      x0 = Math.min(x0, px);
      y0 = Math.min(y0, py);
      x1 = Math.max(x1, px + 1);
      y1 = Math.max(y1, py + 1);
    }
    if (pixels.length === 0) return 0;
    const gw = x1 - x0;
    const grid = new Int32Array(gw * (y1 - y0));
    for (const p of pixels) {
      if (!inside(p)) continue;
      const px = p % ww;
      grid[((p - px) / ww - y0) * gw + (px - x0)] = 1;
    }
    let side = 0;
    for (let y = 0; y < y1 - y0; y += 1) {
      for (let x = 0; x < gw; x += 1) {
        const i = y * gw + x;
        if (!grid[i]) continue;
        const v =
          x > 0 && y > 0
            ? 1 +
              Math.min(grid[i - 1] as number, grid[i - gw] as number, grid[i - gw - 1] as number)
            : 1;
        grid[i] = v;
        side = Math.max(side, v);
      }
    }
    return side;
  };
  /**
   * The measures of a set of in-frame pixels: its fill, the median of its surround (the in-frame
   * pixels within `surroundPx` not in `exclude`), the contrast between them, the contrast the
   * rule needs, and its thickness (the side of the largest square of its pixels at least
   * `thicknessLevel` of the way from the surround to the fill). Null without a surround.
   */
  const measure = (pixels: readonly number[], exclude: Uint8Array): Measures | null => {
    surroundStamp += 1;
    const fill = quantile(
      pixels.map((p) => raw[p] as number),
      0.9,
    );
    const ring: number[] = [];
    for (const p of pixels) {
      const px = p % ww;
      const py = (p - px) / ww;
      for (
        let yy = Math.max(0, py - surroundPx);
        yy <= Math.min(wh - 1, py + surroundPx);
        yy += 1
      ) {
        for (
          let xx = Math.max(0, px - surroundPx);
          xx <= Math.min(ww - 1, px + surroundPx);
          xx += 1
        ) {
          const q = yy * ww + xx;
          if (exclude[q] || !inFrame[q] || surroundMark[q] === surroundStamp) continue;
          surroundMark[q] = surroundStamp;
          ring.push(raw[q] as number);
        }
      }
    }
    if (ring.length === 0) return null;
    const surround = quantile(ring, 0.5);
    const level = surround + s.thicknessLevel * (fill - surround);
    return {
      fill,
      contrast: fill - surround,
      need: Math.max(s.minContrast, s.contrastOfFill * fill),
      thickness: squareSide(pixels, (p) => (raw[p] as number) >= level),
    };
  };
  const maxThickness = s.maxStrokeThickness * scale;
  /** How far a stroke's fill may be from the mark's: a translucent stroke varies with its ground. */
  const toleranceOf = (fill: number) => Math.max(s.fillTolerance, s.fillSpread * (1 - fill));
  /** Something rejected that may still be a stroke of the mark (its box). */
  const doubtful: PxRect[] = [];

  // Candidates: components of strong response inside a region (the mark's place, or the whole
  // rectangle when looking for look-alikes), sized, contrasted and thin. A component larger than
  // `maxStrokeArea`, crossing the region's edge, or of enough contrast but too thick may be
  // strokes joined to ground (through the 3x3 mean, or touching a blob): its bright parts are
  // tested on their own, and those that pass are candidates, grouped by brightness.
  const candidatesOf = (mask: Uint8Array, region: PxRect) => {
    const inside = (b: PxRect) => containsRect(region, b);
    const found: StrokeComponent[] = [];
    const missed: (Measures & { box: PxRect })[] = [];
    const consider = (pixels: number[]): StrokeComponent | null => {
      const box = boundsOf(pixels);
      const m = measure(pixels, strong);
      if (m === null) return null;
      if (m.contrast < m.need || m.thickness > maxThickness) {
        missed.push({ ...m, box });
        return null;
      }
      return {
        box,
        area: pixels.length,
        fill: m.fill,
        contrast: m.contrast,
        thickness: m.thickness,
        pixels,
      };
    };
    for (const pixels of connected(mask)) {
      if (pixels.length < minArea) continue;
      const box = boundsOf(pixels);
      if (!touchesRect(box)) continue;
      if (pixels.length <= maxArea && inside(box)) {
        // A component too thick but of enough contrast may be a stroke joined to a blob.
        const m = measure(pixels, strong);
        if (m === null) continue;
        if (m.contrast < m.need || m.thickness <= maxThickness) {
          const candidate = consider(pixels);
          if (candidate) found.push(candidate);
          continue;
        }
      }
      const level =
        quantile(
          pixels.map((p) => raw[p] as number),
          0.9,
        ) - s.fillLow;
      const passed = partsOf(pixels, level)
        .filter((piece) => piece.length >= minArea && piece.length <= maxArea)
        .filter((piece) => inside(boundsOf(piece)))
        .map(consider)
        .filter((piece): piece is StrokeComponent => piece !== null)
        .sort((a, b) => b.fill - a.fill);
      let group: StrokeComponent[] = [];
      const flush = () => {
        const union = group.flatMap((piece) => piece.pixels);
        const m = union.length > 0 ? measure(union, strong) : null;
        if (m !== null) {
          found.push({
            box: boundsOf(union),
            area: union.length,
            fill: m.fill,
            contrast: m.contrast,
            thickness: m.thickness,
            pixels: union,
          });
        }
        group = [];
      };
      for (const piece of passed) {
        if (group.length > 0 && (group[0] as StrokeComponent).fill - piece.fill > s.fillTolerance) {
          flush();
        }
        group.push(piece);
      }
      flush();
    }
    return { found, missed };
  };
  const { found: candidates, missed: rejected } = candidatesOf(placed, place);

  // One mark: one line of strokes of one brightness. The line of a candidate is its rows grown
  // by `lineSlack` of its height above and `lineSlackBelow` below (descenders); its run is the
  // candidates within the fill tolerance, in the line, at least `minHeightShare` of its height
  // tall, reached through each other with no horizontal gap wider than `runGap` heights. The
  // run with the largest area is the mark, and its largest member the anchor.
  const lineOf = (a: StrokeComponent): Line => {
    const height = a.box.y1 - a.box.y0;
    const line: Line = {
      anchor: a,
      top: a.box.y0 - Math.max(2, Math.round(s.lineSlack * height)),
      bottom: a.box.y1 + Math.max(2, Math.round(s.lineSlackBelow * height)),
      height,
      members: [a],
      left: a.box.x0,
      right: a.box.x1,
      area: a.area,
    };
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of candidates) {
        if (line.members.includes(c) || !inRun(line, c.box, c.fill, 0)) continue;
        if (c.box.y1 - c.box.y0 < s.minHeightShare * height) continue;
        line.members.push(c);
        line.left = Math.min(line.left, c.box.x0);
        line.right = Math.max(line.right, c.box.x1);
        line.area += c.area;
        grew = true;
      }
    }
    return line;
  };
  /** Whether a box of a fill is in a line's rows and run, with `margin` added to the tolerance. */
  const inRun = (line: Line, b: PxRect, fill: number, margin: number) => {
    if (Math.abs(fill - line.anchor.fill) > toleranceOf(line.anchor.fill) + margin) return false;
    if (b.y0 < line.top || b.y1 > line.bottom) return false;
    const gap = b.x0 >= line.right ? b.x0 - line.right : line.left >= b.x1 ? line.left - b.x1 : 0;
    return gap <= s.runGap * line.height;
  };
  let best: Line | null = null;
  for (const candidate of candidates) {
    const run = lineOf(candidate);
    if (best === null || run.area > best.area) best = run;
  }
  let line: Line | null = null;
  if (best !== null) {
    let anchor = best.anchor;
    for (const member of best.members) if (member.area > anchor.area) anchor = member;
    line = lineOf(anchor);
    // Something of about the mark's brightness in its line and run that the contrast rule
    // missed by a little, or the thickness rule rejected by a little (a blob is much thicker
    // than a stroke), or the height rule rejected, or that the anchor's line leaves out of the
    // run it was chosen by, may be one of its strokes.
    for (const member of best.members)
      if (!line.members.includes(member)) doubtful.push(member.box);
    for (const r of rejected) {
      if (r.contrast < r.need && r.contrast < s.doubtfulContrastShare * r.need) continue;
      if (r.contrast >= r.need && r.thickness > s.doubtfulThicknessFactor * maxThickness) continue;
      if (inRun(line, r.box, r.fill, s.doubtfulFillMargin)) doubtful.push(r.box);
    }
    for (const c of candidates) {
      if (line.members.includes(c)) continue;
      if (inRun(line, c.box, c.fill, s.doubtfulFillMargin)) doubtful.push(c.box);
    }
  }
  const components = line ? [...line.members] : [];
  components.sort((a, b) => a.box.x0 - b.box.x0 || a.box.y0 - b.box.y0);

  // Bright parts: the accepted components' pixels at least as bright as the anchor's fill minus
  // `fillLow`, 8-connected. A part is a stroke when it passes the contrast rule (its surround:
  // the pixels that are not in a bright part), is no thicker than the anchor plus
  // `thicknessAllowance` and, in an opaque mark, has the anchor's fill: bright ground joined to a
  // stroke only through its dark outline is a part of its own. Of two parts one above the other,
  // the one farther from the middle of the line is not a stroke.
  const markFill = line?.anchor.fill ?? 1;
  /** As bright as a letter or glyph of the mark. */
  const glyphLevel = markFill - s.fillHigh;
  const bright = new Uint8Array(n);
  for (const c of components) {
    for (const p of c.pixels) if ((raw[p] as number) >= markFill - s.fillLow) bright[p] = 1;
  }
  const partLimit = Math.min(
    maxThickness,
    (line?.anchor.thickness ?? 0) + s.thicknessAllowance * scale,
  );
  const parts = connected(bright).map((pixels) => ({ pixels, box: boundsOf(pixels) }));
  const large = parts.filter((part) => part.pixels.length >= minArea);
  const rowsTop = Math.min(...large.map((part) => part.box.y0));
  const rowsBottom = Math.max(...large.map((part) => part.box.y1));
  const keptParts: { pixels: number[]; box: PxRect; large: boolean }[] = [];
  for (const { pixels, box } of parts) {
    const isLarge = pixels.length >= minArea;
    // A part smaller than `minStrokeArea` (a thin glyph cut from its neighbours) is a stroke
    // only within the rows of the larger parts.
    if (pixels.length === 0 || (!isLarge && (box.y0 < rowsTop || box.y1 > rowsBottom))) continue;
    const m = measure(pixels, bright);
    if (m === null) continue;
    // An opaque mark's strokes all reach its fill; a dimmer part is ground.
    const fillOk = markFill < s.opaqueFill || Math.abs(m.fill - markFill) <= toleranceOf(markFill);
    if (m.contrast >= m.need && fillOk && m.thickness <= partLimit) {
      keptParts.push({ pixels, box, large: isLarge });
      continue;
    }
    if (isLarge && Math.abs(m.fill - markFill) <= toleranceOf(markFill) + s.doubtfulFillMargin) {
      doubtful.push(box);
    }
  }
  const keptLarge = keptParts.filter((k) => k.large);
  const centres = keptLarge.map((k) => (k.box.y0 + k.box.y1) / 2).sort((a, b) => a - b);
  const middle = centres.length > 0 ? (centres[centres.length >> 1] as number) : 0;
  const offMiddle = (b: PxRect) => Math.abs((b.y0 + b.y1) / 2 - middle);
  const strokes = new Uint8Array(n);
  for (const { pixels, box } of keptParts) {
    const under = keptLarge.some(
      (k) => k.box !== box && overUnder(box, k.box) && offMiddle(box) > offMiddle(k.box),
    );
    if (under) continue;
    for (const p of pixels) strokes[p] = 1;
  }
  if (!isLogo) {
    // Inside the label's box the ground passes about 0.30 of what is behind it, so a bright
    // ground under the box can reach the low end of the bright parts: a stroke pixel of the
    // label lies next to a pixel at least `labelGlyphShare` of the anchor's fill (the glyphs
    // are about 0.58 of white over the box, so one over dark ground is dimmer than one over
    // bright ground, while the box stays below about half of the glyphs' brightness).
    const level = s.labelGlyphShare * markFill;
    const core = Uint8Array.from(strokes);
    for (let i = 0; i < n; i += 1) {
      if (!core[i] || (raw[i] as number) >= level) continue;
      const px = i % ww;
      const py = (i - px) / ww;
      let near = false;
      for (let yy = Math.max(0, py - 1); yy <= Math.min(wh - 1, py + 1) && !near; yy += 1) {
        for (let xx = Math.max(0, px - 1); xx <= Math.min(ww - 1, px + 1); xx += 1) {
          const q = yy * ww + xx;
          if (core[q] && (raw[q] as number) >= level) {
            near = true;
            break;
          }
        }
      }
      if (!near) strokes[i] = 0;
    }
  }
  // All or nothing: a doubtful thing beside the kept strokes (sharing rows with one, and not
  // above or below one) may be a stroke the rules rejected, and a mark restored without one of
  // its strokes is damaged.
  const besideStrokes = (b: PxRect) =>
    !keptLarge.some((k) => overUnder(b, k.box)) &&
    keptLarge.some((k) => b.y1 > k.box.y0 && b.y0 < k.box.y1);
  if (line === null || doubtful.some(besideStrokes)) return none();
  const mark = line;

  // The strokes of a line stand side by side: something whose columns are mostly columns of
  // kept strokes lies above or below them.
  const keptColumn = new Uint8Array(ww);
  for (let i = 0; i < n; i += 1) if (strokes[i]) keptColumn[i % ww] = 1;
  const stacked = (b: PxRect) => {
    let covered = 0;
    for (let x = b.x0; x < b.x1; x += 1) covered += keptColumn[x - wx0] as number;
    return covered * 2 > b.x1 - b.x0;
  };
  // Look-alikes: a candidate of the whole rectangle with pixels outside the place is a look-alike
  // beside the mark, or a stroke the place left out, when it is in the mark's run (its fill within
  // the doubt margin; the rows and gap of its pixels outside the place of a glyph's brightness,
  // since ground joined to it is dimmer or brighter and strokes inside the place are the mark's)
  // and those pixels are beside the kept strokes.
  const brightest = markFill + toleranceOf(markFill) + s.doubtfulFillMargin;
  const lookAlike = candidatesOf(strong, rect).found.some((c) => {
    const core = c.pixels.filter(
      (p) => !inPlace[p] && (raw[p] as number) >= glyphLevel && (raw[p] as number) <= brightest,
    );
    if (core.length === 0) return false;
    const box = boundsOf(core);
    return inRun(mark, box, c.fill, s.doubtfulFillMargin) && !stacked(box);
  });
  if (lookAlike) return none();

  // A stroke cut by the place's edge: a component holding a kept stroke reaches out of the place
  // with pixels of about the mark's fill. For the logo the component is of those pixels alone
  // (ground joined to a letter only through its dimmer outline is not part of it); for the label
  // it is of strong response (inside the box, ground passes too little light to be that bright,
  // so ground under the box joined to a glyph and reaching out of it is such a component).
  const cutPx = Math.max(1, Math.round(s.placeCutPx * scale ** 2));
  const strokeLevel = markFill - toleranceOf(markFill) - s.doubtfulFillMargin;
  let linked = strong;
  if (isLogo) {
    linked = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) if ((raw[i] as number) >= strokeLevel) linked[i] = 1;
  }
  for (const pixels of connected(linked)) {
    if (!pixels.some((p) => strokes[p])) continue;
    let outside = 0;
    for (const p of pixels) if (!inPlace[p] && (raw[p] as number) >= strokeLevel) outside += 1;
    if (outside >= cutPx) return none();
  }

  // The marks fill their places from side to side: the logo's letters span its place (and reach
  // its top), and the label's glyphs start a few pixels inside its box and end a few pixels short
  // of the frame's edge. Strokes that stop short of a side have lost a letter or glyph there (or
  // the place is not the mark's).
  if (isLogo || boxed) {
    const lead = Math.round(s.markLeadPx * scale);
    let first = Infinity;
    let end = -Infinity;
    let topmost = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (!strokes[i]) continue;
      const fx = (i % ww) + wx0;
      first = Math.min(first, fx);
      end = Math.max(end, fx + 1);
      topmost = Math.min(topmost, Math.floor(i / ww) + wy0);
    }
    const edge = boxed ? place.x0 - Math.max(1, Math.round(s.boxInsetPx * scale)) : place.x0;
    if (first - edge > lead || place.x1 - end > lead) return none();
    if (isLogo && topmost - place.y0 > lead) return none();
  }

  if (isLogo) {
    // Completeness: pixels of strong response in the place, at least the mark's fill minus
    // `fillHigh` and in no accepted component, form loose parts. A loose part in the line's rows
    // and run, sharing at least half its rows with the kept letters, of about the mark's fill,
    // with most of the contrast a stroke needs, and not stacked on a kept letter (the letters
    // stand side by side: a lost letter's columns hold no kept stroke) may be a letter the rules
    // lost with ground joined to it, however thick that ground; when such parts add up to
    // `minStrokeArea`, the strokes are not found.
    const keptTop = Math.min(...keptLarge.map((k) => k.box.y0));
    const keptBottom = Math.max(...keptLarge.map((k) => k.box.y1));
    const accepted = new Uint8Array(n);
    for (const c of components) for (const p of c.pixels) accepted[p] = 1;
    const loose = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      if (placed[i] && !accepted[i] && (raw[i] as number) >= glyphLevel) loose[i] = 1;
    }
    const looseMin = Math.max(1, Math.round(s.looseMinPx * scale ** 2));
    let looseArea = 0;
    for (const pixels of connected(loose)) {
      if (pixels.length < looseMin) continue;
      const box = boundsOf(pixels);
      if (box.y0 < mark.top || box.y1 > mark.bottom) continue;
      const gap =
        box.x0 >= mark.right ? box.x0 - mark.right : mark.left >= box.x1 ? mark.left - box.x1 : 0;
      if (gap > s.runGap * mark.height) continue;
      const shared = Math.min(box.y1, keptBottom) - Math.max(box.y0, keptTop);
      if (shared * 2 < box.y1 - box.y0 || stacked(box)) continue;
      const m = measure(pixels, loose);
      if (m === null) continue;
      if (Math.abs(m.fill - markFill) > toleranceOf(markFill) + s.doubtfulFillMargin) continue;
      if (m.contrast < s.doubtfulContrastShare * m.need) continue;
      looseArea += pixels.length;
    }
    if (looseArea >= minArea) return none();
  } else {
    // Completeness: inside the label's box the ground passes at most about 0.30 of what is
    // behind it, so a pixel there as bright as a glyph (the mark's fill minus `fillHigh`) that is
    // not a kept stroke or next to one is a glyph the rules did not find.
    let stray = 0;
    for (let i = 0; i < n; i += 1) {
      if (!inPlace[i] || (raw[i] as number) < glyphLevel) continue;
      const px = i % ww;
      const py = (i - px) / ww;
      let near = false;
      for (let yy = Math.max(0, py - 1); yy <= Math.min(wh - 1, py + 1) && !near; yy += 1) {
        for (let xx = Math.max(0, px - 1); xx <= Math.min(ww - 1, px + 1); xx += 1) {
          if (strokes[yy * ww + xx]) {
            near = true;
            break;
          }
        }
      }
      if (!near) stray += 1;
    }
    if (stray > Math.round(s.boxStrayPx * scale ** 2)) return none();
    // The glyphs are a translucent white over the box: nothing in it is brighter than their fill
    // by more than their edges' and the compression's overshoot (bright ground beside a box found
    // too wide is).
    let peak = 0;
    for (let i = 0; i < n; i += 1) if (inPlace[i]) peak = Math.max(peak, raw[i] as number);
    if (peak > markFill + s.boxPeakMargin) return none();
  }

  let kept = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    const wy = y - wy0;
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const wx = x - wx0;
      let grown = false;
      for (let yy = Math.max(0, wy - 1); yy <= Math.min(wh - 1, wy + 1) && !grown; yy += 1) {
        for (let xx = Math.max(0, wx - 1); xx <= Math.min(ww - 1, wx + 1); xx += 1) {
          if (strokes[yy * ww + xx]) {
            grown = true;
            break;
          }
        }
      }
      if (!grown) continue;
      const i = wy * ww + wx;
      const value =
        smoothstep(s.keepLow, s.keepHigh, (raw[i] as number) - (opened[i] as number)) *
        smoothstep(markFill - s.fillLow, markFill - s.fillHigh, raw[i] as number);
      keep[(y - rect.y0) * rw + (x - rect.x0)] = value;
      if (value > 0.5) kept += 1;
    }
  }
  return {
    rect,
    keep,
    share: kept / (rw * rh),
    components: components.map(({ box: b, area, fill, contrast }) => ({
      box: b,
      area,
      fill,
      contrast,
    })),
  };
}

/** Whether a stroke share is inside the bounds where the strokes are found reliably. */
export function attributionStrokesReliable(
  share: number,
  overrides?: Partial<AttributionSettings>,
): boolean {
  const s = settingsOf(overrides);
  return share >= s.minShare && share <= s.maxShare;
}

function median(values: Float64Array): number {
  if (values.length === 0) return 1;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * Restores one attribution rectangle of `base` into a relit `candidate` (same size): the strokes
 * found by `attributionStrokes` keep the base's own pixels (byte for byte where the keep matte is
 * at least `solidKeep`; blended by the matte below it), and the ground behind them is the base's
 * ground times the relight's per-channel gain in linear light (the median ratio of candidate to
 * base over a ring around the rectangle, `ringExclude` boxes left out), blended into the candidate
 * over a feather at the rectangle's inner edges (sides on a frame edge have none). When the
 * strokes are not found reliably (share outside the bounds) or the ring has too few pixels, the
 * rectangle is copied verbatim from the base. Deterministic.
 */
export function restoreAttributionRelit(
  candidate: Raster,
  base: Raster,
  box: NormalizedBox,
  options: { ringExclude?: readonly NormalizedBox[]; settings?: Partial<AttributionSettings> } = {},
): AttributionRestore {
  if (candidate.width !== base.width || candidate.height !== base.height) {
    throw new RangeError('attribution restore needs equal sizes');
  }
  const s = settingsOf(options.settings);
  const { width, height } = base;
  const long = Math.max(width, height);
  const strokes = attributionStrokes(base, box, options.settings);
  const { rect, keep, share } = strokes;
  const out: Raster = { ...candidate, data: Buffer.from(candidate.data) };
  const verbatim = (): AttributionRestore => {
    copyRect(out, base, rect);
    return { raster: out, mode: 'verbatim', share, gain: null };
  };
  if (!attributionStrokesReliable(share, options.settings)) return verbatim();

  const ringPx = Math.round(s.ringFraction * long);
  const gx0 = Math.max(0, rect.x0 - ringPx);
  const gy0 = Math.max(0, rect.y0 - ringPx);
  const gx1 = Math.min(width, rect.x1 + ringPx);
  const gy1 = Math.min(height, rect.y1 + ringPx);
  const excluded = (options.ringExclude ?? []).map((other) => toRect(other, width, height));
  const ratios: number[][] = [[], [], []];
  for (let y = gy0; y < gy1; y += 1) {
    for (let x = gx0; x < gx1; x += 1) {
      if (x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) continue;
      if (excluded.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) continue;
      const p = (y * width + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        (ratios[c] as number[]).push(
          (TO_LINEAR[candidate.data[p + c] as number] as number) /
            Math.max(0.001, TO_LINEAR[base.data[p + c] as number] as number),
        );
      }
    }
  }
  if ((ratios[0] as number[]).length < 16) return verbatim();
  const gain = ratios.map((list) =>
    Math.min(s.maxGain, Math.max(s.minGain, median(Float64Array.from(list)))),
  ) as [number, number, number];

  const feather = Math.max(s.minFeatherPx, Math.round(s.featherFraction * long));
  const rw = rect.x1 - rect.x0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const k = keep[(y - rect.y0) * rw + (x - rect.x0)] as number;
      const p = (y * width + x) * 3;
      if (k >= s.solidKeep) {
        out.data[p] = base.data[p] as number;
        out.data[p + 1] = base.data[p + 1] as number;
        out.data[p + 2] = base.data[p + 2] as number;
        continue;
      }
      let d = Number.POSITIVE_INFINITY;
      if (rect.x0 > 0) d = Math.min(d, x - rect.x0);
      if (rect.x1 < width) d = Math.min(d, rect.x1 - 1 - x);
      if (rect.y0 > 0) d = Math.min(d, y - rect.y0);
      if (rect.y1 < height) d = Math.min(d, rect.y1 - 1 - y);
      const edge = Math.min(1, (d + 1) / (feather + 1));
      for (let c = 0; c < 3; c += 1) {
        const b = TO_LINEAR[base.data[p + c] as number] as number;
        const current = TO_LINEAR[candidate.data[p + c] as number] as number;
        const ground = edge * b * (gain[c] as number) + (1 - edge) * current;
        out.data[p + c] = Math.round(toSrgb(k * b + (1 - k) * ground));
      }
    }
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { raster: out, mode: 'adapted', share, gain: gain.map(r3) as [number, number, number] };
}

/** What the deterministic check measured on one attribution rectangle of a relight. */
export interface AttributionStrokeCheck {
  mode: AttributionRestoreMode;
  share: number;
  /**
   * Adapted: over the pixels where the reference's keep matte is at least `solidKeep`, the mean
   * absolute difference (sRGB levels, all channels) and the share within `closeDifference` on
   * every channel.
   */
  strokeDifference: { pixels: number; mean: number; closeShare: number } | null;
  passed: boolean;
}

/**
 * The relight attribution check of one rectangle: when the reference's strokes are found
 * reliably, the candidate's stroke pixels must equal the reference's; otherwise the result is
 * `verbatim` with `passed` true and the caller applies its verbatim rule.
 */
export function checkAttributionStrokes(
  reference: Raster,
  candidate: Raster,
  box: NormalizedBox,
  overrides?: Partial<AttributionSettings>,
): AttributionStrokeCheck {
  const s = settingsOf(overrides);
  const { rect, keep, share } = attributionStrokes(reference, box, overrides);
  const rounded = Math.round(share * 10_000) / 10_000;
  if (!attributionStrokesReliable(share, overrides)) {
    return { mode: 'verbatim', share: rounded, strokeDifference: null, passed: true };
  }
  const rw = rect.x1 - rect.x0;
  let pixels = 0;
  let close = 0;
  let total = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      if ((keep[(y - rect.y0) * rw + (x - rect.x0)] as number) < s.solidKeep) continue;
      const p = (y * reference.width + x) * 3;
      let worst = 0;
      for (let c = 0; c < 3; c += 1) {
        const diff = Math.abs(
          (candidate.data[p + c] as number) - (reference.data[p + c] as number),
        );
        total += diff;
        if (diff > worst) worst = diff;
      }
      pixels += 1;
      if (worst <= s.closeDifference) close += 1;
    }
  }
  const mean = pixels > 0 ? total / (pixels * 3) : 0;
  const closeShare = pixels > 0 ? close / pixels : 1;
  return {
    mode: 'adapted',
    share: rounded,
    strokeDifference: {
      pixels,
      mean: Math.round(mean * 1000) / 1000,
      closeShare: Math.round(closeShare * 10_000) / 10_000,
    },
    passed: mean <= s.maxMeanDifference && closeShare >= s.minCloseShare,
  };
}
