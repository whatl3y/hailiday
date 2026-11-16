import {
  boxArea,
  clampBox,
  intersectBoxes,
  regionOverlapFraction,
  type Anchor,
  type AnchorCategory,
  type AttachmentIntent,
  type MaskShape,
  type NormalizedBox,
  type PlacementRule,
} from '@hailiday/core';
import { AREA_ANCHORS } from './phrases.js';
import { boxShape, clipShapes, shapesBounds } from './shapes.js';

/** Image size the analysis boxes refer to (regions are normalized; squares need the aspect). */
export interface Grid {
  width: number;
  height: number;
}

/**
 * Placement geometry constants (render spec, placement geometry). Band thicknesses and caps are
 * fractions of the image height; the wrap widening is a fraction of the anchor width.
 */
export const PLACEMENT_GEOMETRY = {
  /** Lights sit within this distance above and below the edge they follow. */
  lightsHalfBand: 0.015,
  /** Garland, cobwebs and other draped items hang this far below the edge. */
  garlandDrape: 0.06,
  /**
   * A garland across a window top hangs up to this share of the window's height when that is
   * deeper than `garlandDrape`: a close interior window shows the garland's real thickness and
   * swag, which a fixed share of the image height does not hold.
   */
  windowDrapeShare: 0.25,
  /** An `eaves` box at most this tall hugs the eave line: its band spans the whole box. */
  eaveLineMaxHeight: 0.08,
  /** A roofline box at least this tall relative to its width is a gable. */
  gableRatio: 0.35,
  /** Tall anchors (columns, posts) widen by this share of their width on each side. */
  tallWrap: 0.15,
  /** Deepest `hang_from` region. */
  hangFromMaxDepth: 0.12,
  /** Tallest `on_surface` region. */
  onSurfaceMaxHeight: 0.15,
  /** Largest share of the image the source-mode mask shapes may cover before dilation. */
  sourceMaskCap: 0.25,
} as const;

const DOOR_CATEGORIES = new Set<AnchorCategory>(['front_door', 'unit_door']);

/** Anchors whose decoration follows their bottom edge (the eave or gutter line). */
export const EAVE_ANCHORS: readonly AnchorCategory[] = ['roofline', 'eaves'];

/** Frames: decoration follows the top edge whatever the frame's aspect. */
export const FRAME_ANCHORS: readonly AnchorCategory[] = [
  'window_frame',
  'interior_window',
  'door_frame',
];

/** Window anchors whose interior stays protected below the top band. */
export const WINDOW_ANCHORS: readonly AnchorCategory[] = ['window_frame', 'interior_window'];

/** Anchors whose decoration wraps the anchor itself. */
export const WRAP_ANCHORS: readonly AnchorCategory[] = ['column'];

export interface GeometryOptions {
  /** `strung` items (lights) use the thin band; anything else drapes below the edge. */
  attachment?: AttachmentIntent;
  /** Multiplier on the garland drape (1 = full drape); the source-mode mask cap lowers it. */
  drapeScale?: number;
}

/** A placement's bounding region and the tight shapes its composite mask is built from. */
export interface PlacementGeometry {
  region: NormalizedBox;
  shapes: MaskShape[];
}

/**
 * The garland drape below an anchor's decorated edge before any budget scaling: `garlandDrape`,
 * or for a window a share of its height when that is deeper.
 */
export function garlandDrapeFor(anchor: Pick<Anchor, 'category' | 'box'>): number {
  const g = PLACEMENT_GEOMETRY;
  if (!WINDOW_ANCHORS.includes(anchor.category)) return g.garlandDrape;
  return Math.max(g.garlandDrape, g.windowDrapeShare * (anchor.box[3] - anchor.box[1]));
}

/** Depth below an edge for an item: the thin lights band or the (scaled) garland drape. */
function depthBelow(
  options: GeometryOptions,
  drape: number = PLACEMENT_GEOMETRY.garlandDrape,
): number {
  const g = PLACEMENT_GEOMETRY;
  if (options.attachment === 'strung') return g.lightsHalfBand;
  return Math.max(g.lightsHalfBand, drape * (options.drapeScale ?? 1));
}

/** A horizontal band from `top` (less the lights margin) down to `edge` plus the item's depth. */
function band(
  x0: number,
  x1: number,
  edge: number,
  options: GeometryOptions,
  top = edge,
  drape: number = PLACEMENT_GEOMETRY.garlandDrape,
): MaskShape | null {
  const box = clampBox([
    x0,
    top - PLACEMENT_GEOMETRY.lightsHalfBand,
    x1,
    edge + depthBelow(options, drape),
  ]);
  return box ? boxShape(box) : null;
}

/** Two sloped bands from the bottom corners to the apex at the top center, plus the bottom band. */
function gableShapes(anchor: Anchor, options: GeometryOptions): MaskShape[] {
  const [x0, y0, x1, y1] = anchor.box;
  const cx = (x0 + x1) / 2;
  const t = PLACEMENT_GEOMETRY.lightsHalfBand;
  const shapes: MaskShape[] = [
    {
      kind: 'polygon',
      points: [
        [x0, y1 - t],
        [cx, y0 - t],
        [cx, y0 + t],
        [x0, y1 + t],
      ],
    },
    {
      kind: 'polygon',
      points: [
        [cx, y0 - t],
        [x1, y1 - t],
        [x1, y1 + t],
        [cx, y0 + t],
      ],
    },
  ];
  const bottom = band(x0, x1, y1, options);
  if (bottom) shapes.push(bottom);
  return shapes;
}

/**
 * The two jambs of a door frame: vertical bands centered on its side edges, as thick (in pixels)
 * as the lights band or half the garland band, so a garland that follows the frame down its sides
 * survives while the opening stays protected.
 */
function jambShapes(anchor: Anchor, grid: Grid, options: GeometryOptions): MaskShape[] {
  const [x0, y0, x1, y1] = anchor.box;
  const g = PLACEMENT_GEOMETRY;
  const half =
    options.attachment === 'strung'
      ? g.lightsHalfBand
      : (g.lightsHalfBand + depthBelow(options)) / 2;
  const t = half * (grid.height / grid.width);
  return [x0, x1]
    .map((x) => clampBox([x - t, y0, x + t, y1]))
    .filter((box): box is NormalizedBox => box !== null)
    .map(boxShape);
}

function alongShapes(anchor: Anchor, grid: Grid, options: GeometryOptions): MaskShape[] {
  const [x0, y0, x1, y1] = anchor.box;
  const w = x1 - x0;
  const h = y1 - y0;
  if (EAVE_ANCHORS.includes(anchor.category)) {
    if (anchor.category === 'roofline' && h >= PLACEMENT_GEOMETRY.gableRatio * w) {
      return gableShapes(anchor, options);
    }
    // A thin eaves box is the eave line itself; anything taller decorates its bottom edge.
    const top = anchor.category === 'eaves' && h <= PLACEMENT_GEOMETRY.eaveLineMaxHeight ? y0 : y1;
    const bottom = band(x0, x1, y1, options, top);
    return bottom ? [bottom] : [];
  }
  if (
    FRAME_ANCHORS.includes(anchor.category) ||
    (w >= h && !WRAP_ANCHORS.includes(anchor.category))
  ) {
    const top = band(x0, x1, y0, options, y0, garlandDrapeFor(anchor));
    const shapes = top ? [top] : [];
    if (anchor.category === 'door_frame') shapes.push(...jambShapes(anchor, grid, options));
    return shapes;
  }
  // Tall anchors (columns, posts, upright rails): the garland wraps the anchor itself.
  const wrap = clampBox([
    x0 - w * PLACEMENT_GEOMETRY.tallWrap,
    y0,
    x1 + w * PLACEMENT_GEOMETRY.tallWrap,
    y1,
  ]);
  return wrap ? [boxShape(wrap)] : [];
}

/** The box a box-shaped rule derives from an anchor (every rule except `along`). */
function ruleBox(
  rule: Exclude<PlacementRule, 'along'>,
  anchor: Anchor,
  grid: Grid,
): NormalizedBox | null {
  const [x0, y0, x1, y1] = anchor.box;
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  const aspect = grid.width / grid.height;
  const isArea = AREA_ANCHORS.includes(anchor.category);
  switch (rule) {
    case 'centered_on': {
      // A roughly square item centered on the anchor (a wreath on a door sits in its upper part).
      const sizeX = Math.min(w * 0.6, (h * 0.6) / aspect);
      const sizeY = sizeX * aspect;
      const cy = DOOR_CATEGORIES.has(anchor.category) ? y0 + h * 0.32 : (y0 + y1) / 2;
      return clampBox([cx - sizeX / 2, cy - sizeY / 2, cx + sizeX / 2, cy + sizeY / 2]);
    }
    case 'beside': {
      if (isArea) return clampBox([x0 + w * 0.15, y0 + h * 0.25, x1 - w * 0.15, y1]);
      // On the ground next to the anchor: the left flank, or the right one at the image edge.
      const flank = Math.max(w * 0.5, 0.04);
      const top = y0 - Math.max(h * 0.4, 0.02);
      return x0 - flank >= 0
        ? clampBox([x0 - flank, top, x0, y1])
        : clampBox([x1, top, x1 + flank, y1]);
    }
    case 'on_surface': {
      // The surface band, at most the cap tall, kept centered on the band it would otherwise be.
      let top = y0 - h * 0.15;
      let bottom = y0 + h * 0.6;
      const excess = bottom - top - PLACEMENT_GEOMETRY.onSurfaceMaxHeight;
      if (excess > 0) {
        top += excess / 2;
        bottom -= excess / 2;
      }
      return clampBox([x0 + w * 0.1, top, x1 - w * 0.1, bottom]);
    }
    case 'cluster_at':
      return isArea
        ? clampBox([cx - w * 0.3, y0 + h * 0.2, cx + w * 0.3, y1])
        : clampBox([x0, y0, x1, y1]);
    case 'hang_from': {
      const top = y1 - h * 0.05;
      const bottom = Math.min(
        y1 + Math.max(h * 1.2, 0.1),
        top + PLACEMENT_GEOMETRY.hangFromMaxDepth,
      );
      return clampBox([x0 + w * 0.08, top, x1 - w * 0.08, bottom]);
    }
  }
}

/**
 * Derives a placement's geometry from an anchor box by placement rule (render spec, placement
 * geometry): the tight mask shapes and the region that bounds them (for `along`, the anchor's
 * long edge with room for a drape, as compiled text and the overlap checks have always used).
 * `along` follows the edge the decoration attaches to: the bottom edge of eaves and roof planes
 * (sloped bands on a gable), the top edge of rails, frames, mantels and shelves (plus the jambs
 * of a door frame), or the widened anchor for columns and posts. Every other rule is one box.
 * Regions describe the image, never real-world sizes; null when nothing remains.
 */
export function placementGeometry(
  rule: PlacementRule,
  anchor: Anchor,
  grid: Grid,
  options: GeometryOptions = {},
): PlacementGeometry | null {
  if (rule === 'along') {
    const shapes = clipShapes(alongShapes(anchor, grid, options), [0, 0, 1, 1]);
    const bounds = shapesBounds(shapes);
    if (!bounds) return null;
    // The region keeps the anchor's long edge with room for a drape, grown to bound the shapes.
    const [x0, y0, x1, y1] = anchor.box;
    const w = x1 - x0;
    const h = y1 - y0;
    const edge: NormalizedBox =
      w >= h ? [x0, y0 - h * 0.25, x1, y1 + h * 0.25] : [x0 - w * 0.25, y0, x1 + w * 0.25, y1];
    const region = clampBox([
      Math.min(edge[0], bounds[0]),
      Math.min(edge[1], bounds[1]),
      Math.max(edge[2], bounds[2]),
      Math.max(edge[3], bounds[3]),
    ]);
    return region ? { region, shapes } : null;
  }
  const region = ruleBox(rule, anchor, grid);
  return region ? { region, shapes: [boxShape(region)] } : null;
}

/** The bounding placement region of a rule on an anchor; null when nothing remains. */
export function regionFor(
  rule: PlacementRule,
  anchor: Anchor,
  grid: Grid,
  options: GeometryOptions = {},
): NormalizedBox | null {
  return placementGeometry(rule, anchor, grid, options)?.region ?? null;
}

/** The four boxes left of `region` when the side of it that overlaps `blocker` is cut away. */
function cutsAround(region: NormalizedBox, blocker: NormalizedBox): NormalizedBox[] {
  const [rx0, ry0, rx1, ry1] = region;
  const [bx0, by0, bx1, by1] = blocker;
  const options: (NormalizedBox | null)[] = [
    clampBox([rx0, ry0, Math.min(rx1, bx0), ry1]),
    clampBox([Math.max(rx0, bx1), ry0, rx1, ry1]),
    clampBox([rx0, ry0, rx1, Math.min(ry1, by0)]),
    clampBox([rx0, Math.max(ry0, by1), rx1, ry1]),
  ];
  return options.filter((option): option is NormalizedBox => option !== null);
}

/**
 * Shrinks a region so that at most `tolerance` of it overlaps the blockers, by cutting away the
 * side that overlaps each blocker; with `cuts` 2, a candidate that still overlaps another blocker
 * is cut once more (a region with a blocker at each end keeps its free middle). Returns the
 * largest candidate that keeps at least `minKeep` of the original area, or null when none does.
 */
export function shrinkToAllowed(
  region: NormalizedBox,
  blockers: readonly NormalizedBox[],
  tolerance: number,
  minKeep = 0.25,
  cuts: 1 | 2 = 1,
): NormalizedBox | null {
  if (regionOverlapFraction(region, blockers) <= tolerance) return region;
  const originalArea = boxArea(region);
  const cutOnce = (box: NormalizedBox) =>
    blockers.flatMap((blocker) => (intersectBoxes(box, blocker) ? cutsAround(box, blocker) : []));
  const candidates = cutOnce(region);
  if (cuts === 2) {
    for (const candidate of [...candidates]) {
      if (regionOverlapFraction(candidate, blockers) > tolerance) {
        candidates.push(...cutOnce(candidate));
      }
    }
  }
  let best: NormalizedBox | null = null;
  for (const candidate of candidates) {
    if (boxArea(candidate) < originalArea * minKeep) continue;
    if (regionOverlapFraction(candidate, blockers) > tolerance) continue;
    if (!best || boxArea(candidate) > boxArea(best)) best = candidate;
  }
  return best;
}

/** Rounds box coordinates to four decimals so plans and compiled text are stable. */
export function roundBox(box: NormalizedBox): NormalizedBox {
  const r = (value: number) => Math.round(value * 10_000) / 10_000;
  return [r(box[0]), r(box[1]), r(box[2]), r(box[3])];
}
