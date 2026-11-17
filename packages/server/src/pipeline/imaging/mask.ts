import type { MaskShape, NormalizedBox, Placement, SceneAnalysis } from '@hailiday/core';
import { WINDOW_ANCHORS, garlandDrapeFor } from '../plan/geometry.js';
import { fillShape } from '../plan/shapes.js';
import { checksumOf, toRect, type PxRect } from './raster.js';

export interface CompositeMask {
  width: number;
  height: number;
  /** Hard mask: 255 inside the dilated placement regions (after exclusions), else 0. */
  hard: Uint8Array;
  /**
   * Feathered alpha 0–255 used for paste-back: 255 on the shapes, falling to 0 by the outer edge
   * of each shape's dilation band; 0 outside the hard mask.
   */
  alpha: Uint8Array;
  /** SHA-256 of the hard mask bytes (the edit mask sent to providers). */
  checksum: string;
  /** Dilation of box shapes (and plain regions). */
  dilationPx: number;
  /** Dilation of band shapes (at most `dilationPx`). */
  bandDilationPx: number;
  featherPx: number;
}

function fillRect(mask: Uint8Array, width: number, rect: PxRect, value: number): void {
  for (let y = rect.y0; y < rect.y1; y += 1) {
    mask.fill(value, y * width + rect.x0, y * width + rect.x1);
  }
}

/** Separable box blur on an 8-bit plane (one pass). */
function boxBlur(src: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return src.slice();
  const tmp = new Float32Array(width * height);
  const out = new Uint8Array(width * height);
  const size = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const row = y * width;
    for (let x = -radius; x <= radius; x += 1)
      sum += src[row + Math.min(width - 1, Math.max(0, x))] as number;
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / size;
      const add = src[row + Math.min(width - 1, x + radius + 1)] as number;
      const remove = src[row + Math.max(0, x - radius)] as number;
      sum += add - remove;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1)
      sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x] as number;
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = Math.round(sum / size);
      const add = tmp[Math.min(height - 1, y + radius + 1) * width + x] as number;
      const remove = tmp[Math.max(0, y - radius) * width + x] as number;
      sum += add - remove;
    }
  }
  return out;
}

/**
 * Square dilation of a binary plane by `radius` pixels (separable, running sums), so a filled
 * rectangle grows to exactly the rectangle expanded by `radius` on every side, clamped.
 */
function dilate(src: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return src.slice();
  const horizontal = new Uint8Array(width * height);
  const prefix = new Int32Array(Math.max(width, height) + 1);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1)
      prefix[x + 1] = (prefix[x] as number) + (src[row + x] ? 1 : 0);
    for (let x = 0; x < width; x += 1) {
      const from = Math.max(0, x - radius);
      const to = Math.min(width, x + radius + 1);
      if ((prefix[to] as number) - (prefix[from] as number) > 0) horizontal[row + x] = 1;
    }
  }
  const out = new Uint8Array(width * height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1)
      prefix[y + 1] = (prefix[y] as number) + (horizontal[y * width + x] as number);
    for (let y = 0; y < height; y += 1) {
      const from = Math.max(0, y - radius);
      const to = Math.min(height, y + radius + 1);
      if ((prefix[to] as number) - (prefix[from] as number) > 0) out[y * width + x] = 1;
    }
  }
  return out;
}

/** The mask shapes of placements: their tight shapes, or the whole region when they have none. */
export function placementMaskShapes(
  placements: readonly Pick<Placement, 'region' | 'maskShapes'>[],
): MaskShape[] {
  return placements.flatMap((placement) =>
    placement.maskShapes && placement.maskShapes.length > 0
      ? placement.maskShapes
      : [{ kind: 'box' as const, box: placement.region }],
  );
}

/**
 * The mask shapes of placements split by dilation class: `bands` are the tight shapes of `along`
 * placements (eave, rail and frame bands, sloped gable bands, jambs, column wraps), which follow
 * an edge and already carry their drape and lights margins; `shapes` are everything else (boxes
 * of the other rules, and whole regions of placements without shapes).
 */
export function placementMaskParts(
  placements: readonly Pick<Placement, 'region' | 'maskShapes' | 'placementRule'>[],
): { shapes: MaskShape[]; bands: MaskShape[] } {
  const shapes: MaskShape[] = [];
  const bands: MaskShape[] = [];
  for (const placement of placements) {
    const own = placementMaskShapes([placement]);
    if (placement.placementRule === 'along' && placement.maskShapes?.length) bands.push(...own);
    else shapes.push(...own);
  }
  return { shapes, bands };
}

/**
 * What the composite mask protects beyond the protected regions (render spec, compositing
 * algorithm). Window interiors below their top band (`garlandDrapeFor`) are never editable. A
 * window carrying its own garland keeps a deeper top band, by `hang` (the dilation, as a fraction
 * of the image height), so the garland may hang into it; a window carrying anything else (a
 * wreath on the glass) is not protected. Access regions and existing decorations are kept out
 * of the dilation band; placement shapes themselves stay editable there.
 */
export function compositeProtection(
  analysis: Pick<
    SceneAnalysis,
    'anchors' | 'accessRegions' | 'preserveRegions' | 'existingDecorations'
  >,
  placements: readonly Pick<Placement, 'anchorId' | 'placementRule'>[],
  hang = 0,
): { exclusions: NormalizedBox[]; keepOuts: NormalizedBox[] } {
  const exclusions: NormalizedBox[] = [];
  for (const anchor of analysis.anchors) {
    if (!WINDOW_ANCHORS.includes(anchor.category)) continue;
    const own = placements.filter((placement) => placement.anchorId === anchor.id);
    if (own.some((placement) => placement.placementRule !== 'along')) continue;
    const [x0, y0, x1, y1] = anchor.box;
    const top = y0 + garlandDrapeFor(anchor) + (own.length > 0 ? hang : 0);
    if (top < y1) exclusions.push([x0, top, x1, y1]);
  }
  return {
    exclusions,
    keepOuts: [
      ...analysis.accessRegions.map((region) => region.box),
      ...analysis.preserveRegions
        .filter((region) => region.kind === 'existing_decor')
        .map((region) => region.box),
      ...analysis.existingDecorations.boxes,
    ],
  };
}

/** The dilation of a mask as a fraction of the image height (for `compositeProtection`). */
export function dilationHang(dilationFraction: number, width: number, height: number): number {
  return (dilationFraction * Math.max(width, height)) / height;
}

/**
 * The feathered alpha of shapes inside their own dilation band: full on the shapes, falling to 0
 * by the band's outer edge. The shapes are grown by the band less the blur's reach and blurred by
 * two box passes (radius `featherPx / 2`, never more than a quarter of the band), so
 * the ramp ends at the band's outer edge and never reaches into the shapes. A zero `featherPx`
 * gives the dilated shapes without a ramp.
 */
function bandFeather(
  shapes: Uint8Array,
  width: number,
  height: number,
  dilationPx: number,
  featherPx: number,
): Uint8Array {
  const band = Math.max(0, dilationPx);
  const radius = Math.max(
    0,
    Math.min(Math.round(featherPx / 2), Math.floor((band - Math.ceil(band / 2)) / 2)),
  );
  const grown = dilate(shapes, width, height, band - 2 * radius).map((value) => (value ? 255 : 0));
  return boxBlur(boxBlur(grown, width, height, radius), width, height, radius);
}

/**
 * Builds the composite mask (render spec, compositing algorithm): the union of the placements'
 * mask shapes (boxes and plain `regions` dilated by `dilationFraction` of the long edge; band
 * shapes from `placementMaskParts` by `bandDilationFraction`, never more than the box
 * dilation), minus the exclusions (protected regions, the attribution rectangle and window
 * interiors, always; keep-outs such as access regions and existing decorations outside the
 * shapes themselves). The alpha keeps each shape class at full strength on its shapes and fades
 * it to 0 by the outer edge of its own dilation band (`bandFeather`, two box passes of radius
 * `featherFraction / 2` of the long edge, capped by the band), so there is no alpha step where
 * the hard mask ends. Excluded and kept-out pixels are zero in the alpha too, so they are
 * restored from the working image byte for byte.
 */
export function buildCompositeMask(input: {
  width: number;
  height: number;
  regions?: readonly NormalizedBox[];
  shapes?: readonly MaskShape[];
  /** Band shapes (`placementMaskParts`), dilated by `bandDilationFraction`. */
  bands?: readonly MaskShape[];
  dilationFraction: number;
  /** Defaults to `dilationFraction` (bands then dilate like boxes). */
  bandDilationFraction?: number;
  featherFraction: number;
  /** Never editable (protected regions, attribution). */
  exclusions?: readonly NormalizedBox[];
  /** Keep-outs (`compositeProtection`): removed from the dilation band, not from the shapes. */
  access?: readonly NormalizedBox[];
}): CompositeMask {
  const { width, height } = input;
  const long = Math.max(width, height);
  const dilationPx = Math.max(0, Math.round(input.dilationFraction * long));
  const bandDilationPx = Math.min(
    dilationPx,
    Math.max(0, Math.round((input.bandDilationFraction ?? input.dilationFraction) * long)),
  );
  const featherPx = Math.max(0, Math.round(input.featherFraction * long));
  const shapes: MaskShape[] = [
    ...(input.regions ?? []).map((box) => ({ kind: 'box' as const, box })),
    ...(input.shapes ?? []),
  ];
  const regionMask = new Uint8Array(width * height);
  for (const shape of shapes) fillShape(regionMask, width, height, shape, 1);
  const dilated = dilate(regionMask, width, height, dilationPx);
  const ramp = bandFeather(regionMask, width, height, dilationPx, featherPx);
  if (input.bands && input.bands.length > 0) {
    const bandMask = new Uint8Array(width * height);
    for (const shape of input.bands) fillShape(bandMask, width, height, shape, 1);
    const grown = dilate(bandMask, width, height, bandDilationPx);
    const bandRamp = bandFeather(bandMask, width, height, bandDilationPx, featherPx);
    for (let i = 0; i < grown.length; i += 1) {
      if (grown[i]) dilated[i] = 1;
      if (bandMask[i]) regionMask[i] = 1;
      if ((bandRamp[i] as number) > (ramp[i] as number)) ramp[i] = bandRamp[i] as number;
    }
  }
  const hard = dilated.map((value) => (value ? 255 : 0));
  for (const box of input.access ?? []) {
    const rect = toRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      for (let x = rect.x0; x < rect.x1; x += 1) {
        const i = y * width + x;
        if (!regionMask[i]) hard[i] = 0;
      }
    }
  }
  const exclusionRects = (input.exclusions ?? []).map((box) => toRect(box, width, height));
  for (const rect of exclusionRects) fillRect(hard, width, rect, 0);

  // Nothing outside the hard mask may change.
  const alpha = ramp.map((value, i) => (hard[i] ? value : 0));
  for (const rect of exclusionRects) fillRect(alpha, width, rect, 0);
  return {
    width,
    height,
    hard,
    alpha,
    checksum: checksumOf(hard),
    dilationPx,
    bandDilationPx,
    featherPx,
  };
}

/** Share of an image a hard mask covers (pixels set before feathering). */
export function maskCoverage(hard: Uint8Array): number {
  if (hard.length === 0) return 0;
  let set = 0;
  for (const value of hard) if (value) set += 1;
  return set / hard.length;
}

/** The hard pixels of `boxes`, each grown by `dilationPx` on every side (clamped), as 0/255. */
export function boxesHardMask(
  width: number,
  height: number,
  boxes: readonly NormalizedBox[],
  dilationPx: number,
): Uint8Array {
  const hard = new Uint8Array(width * height);
  for (const box of boxes) {
    const rect = toRect(box, width, height);
    fillRect(
      hard,
      width,
      {
        x0: Math.max(0, rect.x0 - dilationPx),
        y0: Math.max(0, rect.y0 - dilationPx),
        x1: Math.min(width, rect.x1 + dilationPx),
        y1: Math.min(height, rect.y1 + dilationPx),
      },
      255,
    );
  }
  return hard;
}

/**
 * The feathered alpha of localized boxes: full on each box and over the inner part of its
 * `dilationPx` band, falling to 0 by the band's outer edge. The boxes are grown by half the band
 * and blurred by two box passes whose combined reach is at most the other half, so the ramp is
 * centred in the band, never reaches into the box and never extends past the band.
 */
export function localizedFeather(
  width: number,
  height: number,
  boxes: readonly NormalizedBox[],
  dilationPx: number,
): Uint8Array {
  const half = Math.ceil(Math.max(0, dilationPx) / 2);
  const radius = Math.max(0, Math.floor((Math.max(0, dilationPx) - half) / 2));
  const grown = boxesHardMask(width, height, boxes, half);
  return boxBlur(boxBlur(grown, width, height, radius), width, height, radius);
}

/**
 * The keep-mask of localized compositing (render spec, compositing algorithm): the plan's
 * composite mask (its tight shapes with their protections) united with each localized box grown
 * by `dilationPx`, minus `exclusions` only (people, blurred regions, text marks, attribution and
 * padding: window and door protections never cut a localized item). The plan's part keeps the
 * plan mask's own feathered alpha; each localized item keeps full alpha on itself and fades to 0
 * within its dilation band (`localizedFeather`), so there is no alpha step at the band's outer
 * edge. Excluded pixels are zero in both the hard mask and the alpha.
 */
export function unionLocalizedMask(
  base: CompositeMask,
  input: {
    boxes: readonly NormalizedBox[];
    dilationPx: number;
    exclusions: readonly NormalizedBox[];
  },
): CompositeMask {
  const { width, height } = base;
  const added = boxesHardMask(width, height, input.boxes, input.dilationPx);
  const hard = Uint8Array.from(base.hard, (value, i) => (value || added[i] ? 255 : 0));
  const exclusionRects = input.exclusions.map((box) => toRect(box, width, height));
  for (const rect of exclusionRects) fillRect(hard, width, rect, 0);
  const localized = localizedFeather(width, height, input.boxes, input.dilationPx);
  const alpha = Uint8Array.from(hard, (value, i) =>
    value ? Math.max(base.alpha[i] as number, localized[i] as number) : 0,
  );
  for (const rect of exclusionRects) fillRect(alpha, width, rect, 0);
  return {
    width,
    height,
    hard,
    alpha,
    checksum: checksumOf(hard),
    dilationPx: base.dilationPx,
    bandDilationPx: base.bandDilationPx,
    featherPx: base.featherPx,
  };
}

/**
 * The keep-mask of an attempt whose whole frame is kept: every pixel outside `exclusions` is kept
 * (hard 255) and every pixel inside one shows the original (0 in the hard mask and the alpha).
 * Around each `soft` box the alpha falls from 255 to 0 toward the box across `featherPx`
 * (`localizedFeather`, inverted), so the original fades into the kept picture; every other
 * exclusion has a hard edge. A `soft` box must also be listed in `exclusions`.
 */
export function wholeFrameMask(input: {
  width: number;
  height: number;
  exclusions: readonly NormalizedBox[];
  soft?: readonly NormalizedBox[];
  featherPx?: number;
}): CompositeMask {
  const { width, height } = input;
  const featherPx = Math.max(0, Math.round(input.featherPx ?? 0));
  const soft = input.soft ?? [];
  const hard = new Uint8Array(width * height).fill(255);
  const alpha = new Uint8Array(width * height).fill(255);
  if (featherPx > 0 && soft.length > 0) {
    const fade = localizedFeather(width, height, soft, featherPx);
    for (let i = 0; i < alpha.length; i += 1) alpha[i] = 255 - (fade[i] as number);
  }
  for (const box of input.exclusions) {
    const rect = toRect(box, width, height);
    fillRect(hard, width, rect, 0);
    fillRect(alpha, width, rect, 0);
  }
  return {
    width,
    height,
    hard,
    alpha,
    checksum: checksumOf(hard),
    dilationPx: 0,
    bandDilationPx: 0,
    featherPx,
  };
}

/**
 * Pixels within `radius` of a set pixel of `plane` (square neighbourhood), as 0/1. Used for the
 * unedited ring around a mask and the inner edge band of a mask.
 */
export function neighbourhood(
  plane: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return dilate(plane, width, height, radius);
}

/** Run-length encoding of a hard mask (`transient` sources store this instead of an object). */
export function runLengthEncode(mask: Uint8Array): number[] {
  const runs: number[] = [];
  let current = 0;
  let length = 0;
  for (const value of mask) {
    const bit = value > 0 ? 1 : 0;
    if (bit === current) {
      length += 1;
    } else {
      runs.push(length);
      current = bit;
      length = 1;
    }
  }
  runs.push(length);
  return runs;
}

/**
 * Pixels of the feather band: the part of the feathered edge where the blend is mostly the
 * output (128 ≤ α < 255). A tone mismatch between the pasted output and the original shows there
 * at half or more of its size, and the original's edges must survive the blend there; beyond it
 * the original dominates.
 */
export function featherBand(mask: CompositeMask): Uint8Array {
  return mask.alpha.map((value) => (value >= 128 && value < 255 ? 1 : 0));
}
