import type { NormalizedBox } from '@hailiday/core';
import { TO_LINEAR, toSrgb } from '../../fixtures/canvas.js';
import { toRect, type PxRect, type Raster } from './raster.js';

/** The attribution rectangles of a Street View Static frame (logo lower left, label lower right). */
export const SYNTHETIC_ATTRIBUTION: readonly NormalizedBox[] = [
  [0, 0.955, 0.11, 1],
  [0.8, 0.965, 1, 1],
];

/** A synthetic square frame with a burned-in logo and copyright label (no map imagery). */
export interface AttributionScene {
  /** The frame with its attribution. */
  base: Raster;
  /** The same frame without the logo, the label and its dark box. */
  ground: Raster;
  /** Pixels painted as the core of a logo or label stroke (1 inside). */
  strokeCore: Uint8Array;
  /** Pixels painted as a logo or label stroke, edges included (1 inside). */
  strokePaint: Uint8Array;
  /** Bounding boxes of the logo's glyphs, left to right (`x1`, `y1` exclusive). */
  logoGlyphs: PxRect[];
  /** Bounding boxes of the label's glyphs, left to right. */
  labelGlyphs: PxRect[];
  /** The label's dark box (reaching the frame's right and bottom edges). */
  labelBox: PxRect;
  /** Centers `[x, y]` of 2x2 bright speckles (gravel glints) inside the rectangles. */
  speckles: [number, number][];
  rects: PxRect[];
}

function hash(x: number, y: number): number {
  let h = (Math.imul(x, 73_856_093) ^ Math.imul(y, 19_349_663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177) >>> 0;
  return (h >>> 8) / 16_777_216;
}

/** Paints `[x0, x1) x [y0, y1)` of `raster` in one color, clipped to the frame. */
export function paintRect(
  raster: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: readonly number[],
): void {
  for (let y = Math.max(0, y0); y < Math.min(raster.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(raster.width, x1); x += 1) {
      const p = (y * raster.width + x) * 3;
      raster.data[p] = rgb[0] as number;
      raster.data[p + 1] = rgb[1] as number;
      raster.data[p + 2] = rgb[2] as number;
    }
  }
}

type StrokeRect = [number, number, number, number];

/** Multiplies the pixels of `raster` marked in `mask` by `transmission`. */
function darken(raster: Raster, mask: Uint8Array, transmission: number): void {
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    for (let c = 0; c < 3; c += 1) {
      raster.data[i * 3 + c] = Math.round((raster.data[i * 3 + c] as number) * transmission);
    }
  }
}

/**
 * Hollow-rectangle and bar glyphs of a line, as stroke rectangles `[x0, y0, x1, y1]` and glyph
 * boxes; after every `wordEvery` glyphs (0: never) the gap is `wordGap` instead of `gap`.
 */
function glyphStrokes(
  left: number,
  top: number,
  height: number,
  glyphWidth: number,
  gap: number,
  stroke: number,
  count: number,
  wordEvery = 0,
  wordGap = gap,
): { strokes: StrokeRect[]; glyphs: PxRect[] } {
  const strokes: StrokeRect[] = [];
  const glyphs: PxRect[] = [];
  let x = left;
  for (let g = 0; g < count; g += 1) {
    const width = g % 3 === 2 ? stroke : glyphWidth;
    if (g % 3 === 2) {
      strokes.push([x, top, x + stroke, top + height]);
    } else {
      strokes.push([x, top, x + glyphWidth, top + stroke]);
      strokes.push([x, top + height - stroke, x + glyphWidth, top + height]);
      strokes.push([x, top, x + stroke, top + height]);
      strokes.push([x + glyphWidth - stroke, top, x + glyphWidth, top + height]);
      if (g % 3 === 1)
        strokes.push([x, top + (height >> 1), x + glyphWidth, top + (height >> 1) + stroke]);
    }
    glyphs.push({ x0: x, y0: top, x1: x + width, y1: top + height });
    x += width + (wordEvery > 0 && (g + 1) % wordEvery === 0 ? wordGap : gap);
  }
  return { strokes, glyphs };
}

/**
 * Paints an irregular, roughly elliptical blob (a sunlit leaf or pebble) with radii `rx` and
 * `ry` around `(cx, cy)`, clipped to the frame, and returns its pixel indices (`y * width + x`).
 */
export function paintBlob(
  raster: Raster,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rgb: readonly number[],
): number[] {
  const pixels: number[] = [];
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y += 1) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x += 1) {
      if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d > 1 + 0.35 * (hash(x + 7, y + 3) - 0.5)) continue;
      paintRect(raster, x, y, x + 1, y + 1, rgb);
      pixels.push(y * raster.width + x);
    }
  }
  return pixels;
}

/**
 * The logo's outline and the label's box are translucent: they pass these shares of the ground
 * behind them (measured on recorded Street View frames).
 */
export const LOGO_OUTLINE_TRANSMISSION = 0.4;
export const LABEL_BOX_TRANSMISSION = 0.3;
/** The label's strokes are white at this opacity over the box (measured). */
export const LABEL_TEXT_OPACITY = 0.58;

/** The label's stroke color over a ground color (through the translucent box). */
export function labelStrokeOver(ground: readonly number[]): number[] {
  return ground.map((v) =>
    Math.round(255 * LABEL_TEXT_OPACITY + (1 - LABEL_TEXT_OPACITY) * LABEL_BOX_TRANSMISSION * v),
  );
}

/**
 * A deterministic `size` x `size` frame: a textured grey ground (a flat neutral one of
 * `groundLuma`, or a washed-out white one where the logo's outline is faint), 2x2 bright speckles
 * on textured ground, a "logo" of white strokes with a translucent dark outline (2 px at 1024, as
 * on Street View frames) across the logo's place (`logoPlace`) in the left rectangle, and a
 * translucent dark box reaching the frame's right and bottom edges with light grey text-like
 * strokes in the right rectangle. Stroke widths scale with the size (about 3.5 px for the logo
 * and 2 px for the label at 1024).
 */
export function attributionScene(
  size: number,
  options: {
    ground?: 'textured' | 'white';
    /** A flat neutral ground of this luma (0 to 1) instead of the textured one. */
    groundLuma?: number;
    /** Label glyphs (default 10). */
    labelGlyphs?: number;
    /** A word gap (`labelWordGap` px at 1024, default 8) after every `labelWordEvery` glyphs. */
    labelWordEvery?: number;
    labelWordGap?: number;
  } = {},
): AttributionScene {
  const white = options.ground === 'white';
  const flatLuma = options.groundLuma;
  const ground: Raster = { data: Buffer.alloc(size * size * 3), width: size, height: size };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const p = (y * size + x) * 3;
      if (flatLuma !== undefined) {
        const v = Math.max(0, Math.min(255, Math.round(255 * flatLuma + (hash(x, y) - 0.5) * 3)));
        ground.data[p] = v;
        ground.data[p + 1] = v;
        ground.data[p + 2] = v;
        continue;
      }
      if (white) {
        const v = 246 + Math.round(hash(x, y) * 6);
        ground.data[p] = v;
        ground.data[p + 1] = v;
        ground.data[p + 2] = v;
        continue;
      }
      const v = 112 + 10 * Math.sin(x * 0.05) + 6 * Math.cos(y * 0.07) + (hash(x, y) - 0.5) * 28;
      ground.data[p] = Math.round(v + 4);
      ground.data[p + 1] = Math.round(v);
      ground.data[p + 2] = Math.round(v - 6);
    }
  }
  const rects = SYNTHETIC_ATTRIBUTION.map((box) => toRect(box, size, size));
  const speckles: [number, number][] = [];
  if (!white && flatLuma === undefined) {
    // On open ground: above the logo's strokes, and left of the label's dark box.
    const spots: [number, number][] = [
      [rects[0]!.x0 + 0.01 * size, rects[0]!.y0 + 0.004 * size],
      [rects[0]!.x0 + 0.05 * size, rects[0]!.y0 + 0.003 * size],
      [rects[0]!.x0 + 0.1 * size, rects[0]!.y0 + 0.02 * size],
      [rects[1]!.x0 + 0.005 * size, rects[1]!.y0 + 0.01 * size],
      [rects[1]!.x0 + 0.015 * size, rects[1]!.y0 + 0.02 * size],
      [rects[1]!.x0 + 0.022 * size, rects[1]!.y0 + 0.03 * size],
    ];
    for (const [fx, fy] of spots) {
      const x = Math.round(fx);
      const y = Math.round(fy);
      speckles.push([x, y]);
      paintRect(ground, x, y, x + 2, y + 2, [236, 234, 228]);
    }
  }
  return {
    ...burnAttribution(ground, {
      faintOutline: white,
      ...(options.labelGlyphs !== undefined ? { labelGlyphs: options.labelGlyphs } : {}),
      ...(options.labelWordEvery !== undefined ? { labelWordEvery: options.labelWordEvery } : {}),
      ...(options.labelWordGap !== undefined ? { labelWordGap: options.labelWordGap } : {}),
    }),
    ground,
    speckles,
  };
}

/** A square frame with the synthetic attribution burned in (see `burnAttribution`). */
export type BurnedAttribution = Omit<AttributionScene, 'ground' | 'speckles'>;

/**
 * Burns the synthetic logo (lower left) and copyright label (lower right) of `attributionScene`
 * into a copy of a square `ground` frame: the logo's white strokes with their translucent dark
 * outline (faint when `faintOutline`, as on a washed-out frame) and the label's translucent dark
 * box with its light grey strokes. `marks` limits it to one of the two. Stroke widths scale with
 * the size (about 3.5 px for the logo and 2 px for the label at 1024).
 */
export function burnAttribution(
  ground: Raster,
  options: {
    marks?: 'both' | 'logo' | 'label';
    faintOutline?: boolean;
    /** Label glyphs (default 10). */
    labelGlyphs?: number;
    /** A word gap (`labelWordGap` px at 1024, default 8) after every `labelWordEvery` glyphs. */
    labelWordEvery?: number;
    labelWordGap?: number;
  } = {},
): BurnedAttribution {
  if (ground.width !== ground.height) throw new RangeError('the synthetic frame is square');
  const size = ground.width;
  const marks = options.marks ?? 'both';
  const white = options.faintOutline === true;
  const rects = SYNTHETIC_ATTRIBUTION.map((box) => toRect(box, size, size));
  const logo = rects[0] as PxRect;
  const base: Raster = { ...ground, data: Buffer.from(ground.data) };
  const strokeCore = new Uint8Array(size * size);
  const scale = size / 1024;

  const logoStroke = Math.max(2, Math.round(3.5 * scale));
  const logoHeight = Math.round(0.022 * size);
  // The letters' top row is the place's (`logoPlace`) plus one: the outline above them is not
  // part of the place.
  const logoLine = glyphStrokes(
    logo.x0 + Math.round(0.012 * size),
    logo.y1 - Math.round(0.0303 * size),
    logoHeight,
    Math.round(0.013 * size),
    Math.max(2, Math.round(4.5 * scale)),
    logoStroke,
    6,
  );
  const logoStrokes = marks === 'label' ? [] : logoLine.strokes;
  // The outline passes LOGO_OUTLINE_TRANSMISSION of the ground; a washed-out frame shows it
  // only faintly.
  const halo = Math.ceil(2 * scale);
  const outlined = new Uint8Array(size * size);
  for (const [x0, y0, x1, y1] of logoStrokes) {
    for (let y = Math.max(0, y0 - halo); y < Math.min(size, y1 + halo); y += 1) {
      for (let x = Math.max(0, x0 - halo); x < Math.min(size, x1 + halo); x += 1) {
        outlined[y * size + x] = 1;
      }
    }
  }
  darken(base, outlined, white ? 0.92 : LOGO_OUTLINE_TRANSMISSION);
  for (const [x0, y0, x1, y1] of logoStrokes) paintRect(base, x0, y0, x1, y1, [246, 246, 244]);

  // The label is right-aligned as on Street View frames: its glyphs end `labelMargin` short of
  // the frame's right edge, and its box starts `labelMargin` left of the first glyph.
  const boxTop = Math.round(0.968 * size);
  const labelStroke = Math.max(1, Math.round(2 * scale));
  const labelHeight = Math.round(0.018 * size);
  const labelMargin = Math.max(3, Math.round(2.5 * scale));
  const lineOf = (left: number) =>
    glyphStrokes(
      left,
      boxTop + Math.round((size - boxTop - labelHeight) / 2),
      labelHeight,
      Math.round(0.011 * size),
      Math.max(3, Math.round(4 * scale)),
      labelStroke,
      options.labelGlyphs ?? 10,
      options.labelWordEvery ?? 0,
      Math.round((options.labelWordGap ?? 8) * scale),
    );
  const lineEnd = (lineOf(0).glyphs.at(-1) as PxRect).x1;
  const labelLine = lineOf(size - labelMargin - lineEnd);
  const boxLeft = (labelLine.glyphs[0] as PxRect).x0 - labelMargin;
  const labelStrokes = marks === 'logo' ? [] : labelLine.strokes;
  if (marks !== 'logo') {
    const boxed = new Uint8Array(size * size);
    for (let y = boxTop; y < size; y += 1)
      for (let x = boxLeft; x < size; x += 1) boxed[y * size + x] = 1;
    darken(base, boxed, LABEL_BOX_TRANSMISSION);
  }
  for (const [x0, y0, x1, y1] of labelStrokes) {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x += 1) {
        const p = (y * size + x) * 3;
        const rgb = labelStrokeOver([
          ground.data[p] as number,
          ground.data[p + 1] as number,
          ground.data[p + 2] as number,
        ]);
        base.data[p] = rgb[0] as number;
        base.data[p + 1] = rgb[1] as number;
        base.data[p + 2] = rgb[2] as number;
      }
    }
  }

  // The core of a stroke: its rectangle less one pixel on each side of a dimension wider than 2.
  const strokePaint = new Uint8Array(size * size);
  for (const [x0, y0, x1, y1] of [...logoStrokes, ...labelStrokes]) {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x += 1) strokePaint[y * size + x] = 1;
    }
    const ix = x1 - x0 > 2 ? 1 : 0;
    const iy = y1 - y0 > 2 ? 1 : 0;
    for (let y = y0 + iy; y < y1 - iy; y += 1) {
      for (let x = x0 + ix; x < x1 - ix; x += 1) strokeCore[y * size + x] = 1;
    }
  }
  return {
    base,
    strokeCore,
    strokePaint,
    logoGlyphs: marks === 'label' ? [] : logoLine.glyphs,
    labelGlyphs: marks === 'logo' ? [] : labelLine.glyphs,
    labelBox: { x0: boxLeft, y0: boxTop, x1: size, y1: size },
    rects,
  };
}

/** `raster` times a per-channel gain in linear light, re-encoded (a uniform relight). */
export function relitBy(raster: Raster, gain: readonly [number, number, number]): Raster {
  const data = Buffer.alloc(raster.data.length);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.round(
      toSrgb((TO_LINEAR[raster.data[i] as number] as number) * (gain[i % 3] as number)),
    );
  }
  return { ...raster, data };
}

/** Rec. 709 luma (0 to 1) of one pixel. */
export function lumaAt(raster: Raster, x: number, y: number): number {
  const p = (y * raster.width + x) * 3;
  return (
    (0.2126 * (raster.data[p] as number) +
      0.7152 * (raster.data[p + 1] as number) +
      0.0722 * (raster.data[p + 2] as number)) /
    255
  );
}
