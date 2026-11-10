import sharp from 'sharp';
import type { HolidayId, LightingMode, NormalizedBox, SceneType, Style } from '@holiday/core';
import { eveningGradeLinear, eveningWindowLights } from '../pipeline/imaging/relight.js';
import { archetypeFor, type DecorArchetype } from './archetypes.js';
import {
  TO_LINEAR,
  blurFloat,
  clipRect,
  lum,
  luminancePlane,
  meanRgb,
  smoothstep,
  toSrgb,
  type Canvas,
  type Rect,
} from './canvas.js';
import type { FixturePlacement } from './decor.js';
import type { LibraryAnchors } from './photos.js';
import { anchorsInCrop, recognizeFrameByDoor, recognizeLibraryPhoto } from './recognize.js';
import {
  compositeOver,
  gradeRendered,
  loadSprite,
  multiplyShadow,
  renderSprite,
  type Grade,
  type Rendered,
  type Sprite,
} from './sprites.js';
import { Rng, hashSeed } from './svg.js';

/** Version of the fixture compositor; recorded as the fixture editor's model snapshot. */
export const FIXTURE_COMPOSITOR_VERSION = 'fixture-compositor-3.2';

export interface DecorateInput {
  image: Uint8Array;
  holidayId: HolidayId;
  style: Style;
  lightingMode: LightingMode;
  sceneType: SceneType;
  placements: readonly FixturePlacement[];
  /** Existing window glass (warm interior glow in evening exteriors; lights never cross it). */
  windows?: readonly NormalizedBox[];
  /** Existing light sources (sconces, chandeliers) that glow in evening mode. */
  lightSources?: readonly NormalizedBox[];
  /** Regions decorations must never cover (vehicles, existing decor, signs, credits). */
  preserveRegions?: readonly NormalizedBox[];
  /** Walkways and steps that runs along rails must leave open. */
  accessRegions?: readonly NormalizedBox[];
  /** The front door, which sets the scene scale (a door is about 2.05 m tall). */
  referenceDoor?: NormalizedBox | null;
  /** The target facade; its top edge bounds the sky in the evening relight. */
  targetFacade?: NormalizedBox | null;
  /** Burned-in attribution restored verbatim from the source after compositing. */
  attributionRegion?: NormalizedBox | null;
  /**
   * True when the placement regions come from exact frame geometry (fixture Street View frames
   * and drawn scenes) rather than a generic layout; defaults to true when an attribution region
   * is given, since only fixture frames carry one.
   */
  anchoredGeometry?: boolean;
  seed: string;
  /** Output size; defaults to the input size. */
  width?: number;
  height?: number;
  format?: 'jpeg' | 'png' | 'webp';
  quality?: number;
}

/** How the compositor knows where things are. */
export type DecorationGeometry = 'anchored' | 'library' | 'unplaced';

export interface DecorateResult {
  image: Buffer;
  width: number;
  height: number;
  format: 'jpeg' | 'png' | 'webp';
  /** Archetypes actually drawn, by placement ID (null when nothing could be placed). */
  drawn: Record<string, string | null>;
  /**
   * `anchored`: placements follow exact frame geometry (fixture Street View frames);
   * `library`: the image is a library photo and decorations use its measured anchors;
   * `unplaced`: an unknown upload, which gets only a photographic light treatment.
   */
  geometry: DecorationGeometry;
}

/** Real-world height of a front door, used to derive the scene scale. */
const DOOR_HEIGHT_M = 2.05;

type Pt = [number, number];

function toLinearPixels(rgb: Buffer): Float32Array {
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 1) out[i] = TO_LINEAR[rgb[i] as number] as number;
  return out;
}

// ---- scene measurements --------------------------------------------------------------------------

/**
 * Foliage in front of the house (shrubs, branches) from the source pixels: green or yellow-green,
 * saturated and not too dark. Rails and eaves behind it are hidden there.
 */
function foliageMatte(rgb: Buffer, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const r = rgb[p * 3] as number;
    const g = rgb[p * 3 + 1] as number;
    const b = rgb[p * 3 + 2] as number;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max > 0 ? (max - min) / max : 0;
    // Hue in degrees for the green-to-yellow range of leaves.
    let hue = 0;
    if (max !== min) {
      if (max === r) hue = (60 * (g - b)) / (max - min);
      else if (max === g) hue = 60 * (2 + (b - r) / (max - min));
      else hue = 60 * (4 + (r - g) / (max - min));
    }
    if (hue < 0) hue += 360;
    // Green leaves only: cream and yellow paint in warm light must not count as foliage.
    const leafy = smoothstep(62, 82, hue) * (1 - smoothstep(165, 190, hue));
    out[p] = leafy * smoothstep(0.2, 0.35, sat) * smoothstep(18, 40, max);
  }
  return blurFloat(out, width, height, 1, 1);
}

/** Scene light color: the mean of bright, nearly neutral pixels (white paint, sky, stone). */
function illuminant(canvas: Canvas): [number, number, number] {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  const lumPlane = luminancePlane(canvas);
  const sorted = Float32Array.from(lumPlane).sort();
  const bright = sorted[Math.floor(sorted.length * 0.8)] as number;
  for (let p = 0; p < lumPlane.length; p += 7) {
    if ((lumPlane[p] as number) < bright) continue;
    const r = canvas.rgb[p * 3] as number;
    const g = canvas.rgb[p * 3 + 1] as number;
    const b = canvas.rgb[p * 3 + 2] as number;
    const max = Math.max(r, g, b);
    if (max <= 0 || (max - Math.min(r, g, b)) / max > 0.35) continue;
    sr += r;
    sg += g;
    sb += b;
    n += 1;
  }
  if (n < 20) return [1, 1, 1];
  const l = lum(sr / n, sg / n, sb / n);
  return [sr / n / l, sg / n / l, sb / n / l];
}

/** Grain and sharpness of the photograph, measured on luminance. */
function photoTexture(canvas: Canvas): { grain: number; sharpness: number } {
  const { width, height } = canvas;
  const l = luminancePlane(canvas);
  const b1 = blurFloat(l, width, height, 1, 1);
  const b3 = blurFloat(l, width, height, 1, 3);
  const residuals: number[] = [];
  let fine = 0;
  let coarse = 0;
  for (let p = 0; p < l.length; p += 5) {
    const v = l[p] as number;
    const d1 = Math.abs(v - (b1[p] as number));
    const d3 = Math.abs(v - (b3[p] as number));
    fine += d1;
    coarse += d3;
    // Flat areas show the grain: little coarse structure around the pixel.
    if (d3 < 0.01 + v * 0.05) residuals.push(d1 / Math.max(0.03, v));
  }
  residuals.sort((a, b) => a - b);
  const grain = residuals.length > 50 ? (residuals[residuals.length >> 1] as number) * 1.4 : 0.01;
  return { grain: Math.min(0.06, grain), sharpness: coarse > 0 ? fine / coarse : 0.4 };
}

/** Sharpness of a rendered sprite on the same measure, inside its opaque core. */
function spriteSharpness(r: Rendered): number {
  const l = new Float32Array(r.width * r.height);
  for (let p = 0; p < l.length; p += 1) {
    const a = r.data[p * 4 + 3] as number;
    l[p] =
      a > 0.01
        ? lum(r.data[p * 4] as number, r.data[p * 4 + 1] as number, r.data[p * 4 + 2] as number) / a
        : 0;
  }
  const b1 = blurFloat(l, r.width, r.height, 1, 1);
  const b3 = blurFloat(l, r.width, r.height, 1, 3);
  let fine = 0;
  let coarse = 0;
  for (let p = 0; p < l.length; p += 1) {
    if ((r.data[p * 4 + 3] as number) < 0.98) continue;
    fine += Math.abs((l[p] as number) - (b1[p] as number));
    coarse += Math.abs((l[p] as number) - (b3[p] as number));
  }
  return coarse > 0 ? fine / coarse : 0.4;
}

// ---- geometry -----------------------------------------------------------------------------------

/** Pixels per meter as a function of where an object rests (a ground-plane perspective model). */
interface ScaleModel {
  /** At the reference plane (door, mantel, table). */
  ref: number;
  at(y: number): number;
}

function scaleModel(ref: number, baseY: number, eyeMeters: number): ScaleModel {
  const horizon = baseY - eyeMeters * ref;
  return {
    ref,
    at: (y: number) => {
      const k = (y - horizon) / Math.max(1, baseY - horizon);
      // Raised floors (porches, hearths) also sit higher in the frame without being farther
      // away, so the ground-plane estimate is kept to a modest range.
      return ref * Math.min(1.15, Math.max(0.8, k));
    },
  };
}

interface PxBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const px = (box: NormalizedBox, w: number, h: number): PxBox => ({
  x0: box[0] * w,
  y0: box[1] * h,
  x1: box[2] * w,
  y1: box[3] * h,
});

const inset = (b: PxBox, k: number): PxBox => {
  const dx = (b.x1 - b.x0) * k;
  const dy = (b.y1 - b.y0) * k;
  return { x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 - dx, y1: b.y1 - dy };
};

const inside = (b: PxBox, [x, y]: Pt) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1;

function overlapFraction(a: Rect, b: PxBox): number {
  const w = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const h = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0));
  return (w * h) / area;
}

/** Resamples a polyline at a fixed spacing; each sample carries the local direction. */
function sampleAlong(path: readonly Pt[], spacing: number): { p: Pt; angle: number }[] {
  const out: { p: Pt; angle: number }[] = [];
  if (spacing <= 0 || path.length < 2) return out;
  let carry = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const [ax, ay] = path[i] as Pt;
    const [bx, by] = path[i + 1] as Pt;
    const len = Math.hypot(bx - ax, by - ay);
    const angle = Math.atan2(by - ay, bx - ax);
    let t = carry;
    while (t <= len) {
      const k = len === 0 ? 0 : t / len;
      out.push({ p: [ax + (bx - ax) * k, ay + (by - ay) * k], angle });
      t += spacing;
    }
    carry = t - len;
  }
  return out;
}

function pathLength(path: readonly Pt[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i] as Pt;
    const b = path[i + 1] as Pt;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/**
 * Hangs a flexible run (garland, light string) from a support line: it is fixed at points spaced
 * about `span` apart (the line's ends included, which sit on real posts or corners) and sags
 * `sag` pixels at mid-span under its own weight.
 */
function drape(support: readonly Pt[], span: number, sag: number): Pt[] {
  const out: Pt[] = [];
  for (let s = 0; s < support.length - 1; s += 1) {
    const a = support[s] as Pt;
    const b = support[s + 1] as Pt;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const spans = Math.max(1, Math.round(len / Math.max(4, span)));
    const steps = 10;
    for (let k = 0; k < spans; k += 1) {
      for (let j = 0; j <= steps; j += 1) {
        if ((k > 0 || s > 0) && j === 0) continue;
        const t = (k + j / steps) / spans;
        const local = j / steps;
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t + sag * 4 * local * (1 - local);
        out.push([x, y]);
      }
    }
  }
  return out;
}

/**
 * Splits a polyline wherever a point falls inside one of the blocked boxes or fails `allowed`
 * (outside the frame or the editable area).
 */
export function splitPath(
  path: readonly Pt[],
  blocked: readonly PxBox[],
  allowed: (point: Pt) => boolean = () => true,
): Pt[][] {
  const runs: Pt[][] = [];
  let current: Pt[] = [];
  for (const point of path) {
    if (!allowed(point) || blocked.some((box) => inside(box, point))) {
      if (current.length > 1) runs.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length > 1) runs.push(current);
  return runs;
}

/** Densifies a polyline so splitting at boxes is accurate. */
function densify(path: readonly Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i] as Pt;
    const b = path[i + 1] as Pt;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k += 1)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  const last = path[path.length - 1];
  if (last) out.push(last);
  return out;
}

// ---- items --------------------------------------------------------------------------------------

type Item =
  | { kind: 'lights'; support: Pt[]; layer: number }
  | {
      kind: 'garland';
      path: Pt[];
      harvest: boolean;
      lit: boolean;
      onRail: boolean;
      layer: number;
      /** Hung across the top of a window: it may cover the upper part of the glass. */
      overGlass?: boolean;
      /** Hung on a door (a wreath): it may cover the door. */
      onDoor?: boolean;
      /** A closed ring (a wreath) rather than a run between supports. */
      ring?: boolean;
      /** Thickness relative to a standard garland (1). */
      fullness?: number;
    }
  | {
      kind: 'sprite';
      asset: string;
      x: number;
      y: number;
      /** Size along the asset's size axis, in pixels. */
      size: number;
      shadow: 'contact' | 'drop';
      layer: number;
      flip: boolean;
      /** The point of the cutout placed at (x, y); defaults to its manifest attach point. */
      pivot?: [number, number];
      /** Lowest exposure (linear gain) the scene grade may give it. */
      minExposure?: number;
      /** Hidden by foliage in front of it (a bow on a rail behind a shrub). */
      occludable?: boolean;
      /** Left out when its group had to be thinned to fit the surface it stands on. */
      dropped?: boolean;
      /** Stands on open ground (a lawn): nothing in front of it, whatever grows behind it. */
      inOpen?: boolean;
    };

interface Scene {
  width: number;
  height: number;
  holiday: HolidayId;
  evening: boolean;
  density: number;
  scale: ScaleModel;
  rng: Rng;
  /** Glass and door areas no light string or garland may cross. */
  glass: PxBox[];
  /** Areas nothing may cover (preserved regions, existing objects). */
  keepOut: PxBox[];
  /** Openings rail runs must leave open (steps, walkways). */
  gaps: PxBox[];
  /** The groups already standing on each measured spot (rearranged as groups arrive). */
  spotGroups: Map<string, { items: Extract<Item, { kind: 'sprite' }>[]; width: number }[]>;
  /** Pixels decorations may change (null: anywhere). */
  editable: Uint8Array | null;
}

const STANDING: Partial<Record<DecorArchetype, true>> = {
  pumpkins: true,
  carved_pumpkins: true,
  potted_plant: true,
  potted_plant_and_stalks: true,
  potted_tree: true,
  lantern: true,
};

/**
 * The photographed objects standing together for one placement of a standing archetype, largest
 * first. The style sets how full each group is: subtle one object, classic a pair, abundant a
 * cluster of several sizes (pumpkins with gourds, a jack-o'-lantern with pumpkins, mums with a
 * pumpkin at their foot).
 */
function standingGroup(archetype: DecorArchetype, scene: Scene, lit: boolean): string[] {
  const tier = scene.density > 1.1 ? 2 : scene.density < 0.9 ? 0 : 1;
  const pick = (options: readonly string[][]): string[] => options[tier] ?? [];
  const halloween = scene.holiday === 'halloween';
  switch (archetype) {
    case 'pumpkins':
      return scene.holiday === 'thanksgiving_us'
        ? pick([
            ['decor-pumpkin-orange'],
            ['decor-pumpkin-orange', 'decor-gourds-group'],
            ['decor-pumpkins-harvest', 'decor-pumpkins-white', 'decor-gourds-group'],
          ])
        : pick([
            ['decor-pumpkin-orange'],
            ['decor-pumpkin-orange', 'decor-pumpkins-white'],
            ['decor-pumpkins-harvest', 'decor-pumpkins-white', 'decor-pumpkin-small'],
          ]);
    case 'carved_pumpkins':
      return pick([
        ['decor-jack-o-lantern'],
        ['decor-jack-o-lantern', 'decor-pumpkin-small'],
        ['decor-jack-o-lantern', 'decor-pumpkin-orange', 'decor-gourds-group'],
      ]);
    case 'potted_plant':
    case 'potted_plant_and_stalks':
      return pick([
        ['decor-mums-yellow'],
        ['decor-mums-yellow', halloween ? 'decor-pumpkin-small' : 'decor-gourds-group'],
        ['decor-mums-yellow', 'decor-pumpkin-orange', 'decor-pumpkin-small'],
      ]);
    case 'potted_tree':
      return ['decor-spruce-potted'];
    case 'lantern':
      return [lit || scene.evening ? 'decor-lantern-white' : 'decor-lantern-white-unlit'];
    default:
      return [];
  }
}

/**
 * Lays a group out side by side on one resting line, the largest object in the middle and the
 * smaller ones either side of it, a little in front (drawn after it).
 */
function arrangeGroup(items: Extract<Item, { kind: 'sprite' }>[], scale: ScaleModel): void {
  if (items.length < 2) return;
  const [main, ...rest] = items as [
    Extract<Item, { kind: 'sprite' }>,
    ...Extract<Item, { kind: 'sprite' }>[],
  ];
  const cx = main.x;
  let right = cx + spriteWidthPx(main) * 0.4;
  let left = cx - spriteWidthPx(main) * 0.4;
  for (const [i, it] of rest.entries()) {
    const w = spriteWidthPx(it) * 0.8;
    if (i % 2 === 0) {
      it.x = right + w / 2;
      right += w;
    } else {
      it.x = left - w / 2;
      left -= w;
    }
    it.y = main.y + scale.ref * 0.012 * (i + 1);
  }
  const shift = (left + right) / 2 - cx;
  for (const it of items) it.x -= shift;
}

/** Photographed assets for a tabletop or shelf archetype. */
function surfaceAsset(
  archetype: DecorArchetype,
  holiday: HolidayId,
): { asset: string; meters?: number } | null {
  const festive = holiday === 'christmas' || holiday === 'new_years_eve';
  switch (archetype) {
    case 'centerpiece':
      return festive
        ? { asset: 'decor-candle-centerpiece' }
        : holiday === 'thanksgiving_us'
          ? { asset: 'decor-gourds-group' }
          : { asset: 'decor-pumpkins-white', meters: 0.34 };
    case 'arrangement':
      // A smaller arrangement for a sideboard, shelf or hearth.
      return festive
        ? { asset: 'decor-candle-centerpiece', meters: 0.32 }
        : { asset: 'decor-gourds-group', meters: 0.28 };
    case 'candles':
      return { asset: 'decor-lantern-white', meters: 0.3 };
    case 'pumpkins':
      return {
        asset: holiday === 'halloween' ? 'decor-pumpkins-white' : 'decor-gourds-group',
        meters: 0.32,
      };
    case 'carved_pumpkins':
      return { asset: 'decor-jack-o-lantern', meters: 0.26 };
    default:
      return null;
  }
}

/** Area anchors (measured spots on the ground or floor) whose bottom edge is the resting line. */
const AREA_CATEGORIES = new Set(['planter', 'floor_area', 'balcony_floor', 'lawn']);

/** Where light strings may run: eaves, rooflines, porch fascia and rails only. */
const LIGHT_LINES = new Set(['eaves', 'roofline', 'porch_rail', 'balcony_railing']);

/** The anchor box an `along` region was derived from (the planner pads the long edge's sides). */
function alongAnchor(region: PxBox): PxBox {
  const w = region.x1 - region.x0;
  const h = region.y1 - region.y0;
  if (w >= h) {
    const ah = h / 1.5;
    return { x0: region.x0, x1: region.x1, y0: region.y0 + ah * 0.25, y1: region.y1 - ah * 0.25 };
  }
  const aw = w / 1.5;
  return { x0: region.x0 + aw * 0.25, x1: region.x1 - aw * 0.25, y0: region.y0, y1: region.y1 };
}

/** The support line of a run on an anchor (from exact frame geometry). */
function supportLine(category: string, a: PxBox, scale: ScaleModel): Pt[] {
  switch (category) {
    case 'roofline':
      return [
        [a.x0, a.y1 - Math.min((a.y1 - a.y0) * 0.06, scale.ref * 0.1)],
        [a.x1, a.y1 - Math.min((a.y1 - a.y0) * 0.06, scale.ref * 0.1)],
      ];
    case 'eaves':
      return [
        [a.x0, a.y0 + (a.y1 - a.y0) * 0.6],
        [a.x1, a.y0 + (a.y1 - a.y0) * 0.6],
      ];
    case 'mantel':
      return [
        [a.x0, a.y0 + (a.y1 - a.y0) * 0.2],
        [a.x1, a.y0 + (a.y1 - a.y0) * 0.2],
      ];
    case 'interior_window':
    case 'window_frame':
      return [
        [a.x0, a.y0 + (a.y1 - a.y0) * 0.03],
        [a.x1, a.y0 + (a.y1 - a.y0) * 0.03],
      ];
    case 'banister':
      return [
        [a.x0, a.y1],
        [a.x1, a.y0],
      ];
    default:
      return [
        [a.x0, a.y0 + Math.min((a.y1 - a.y0) * 0.1, scale.ref * 0.04)],
        [a.x1, a.y0 + Math.min((a.y1 - a.y0) * 0.1, scale.ref * 0.04)],
      ];
  }
}

/** Distance between the points a rail garland is tied up at, in meters. */
const RAIL_SWAG_SPAN = 1.3;

/** The points a run hung with `drape` is fixed at (both ends included). */
function swagPoints(support: readonly Pt[], span: number): Pt[] {
  const out: Pt[] = [];
  for (let s = 0; s < support.length - 1; s += 1) {
    const a = support[s] as Pt;
    const b = support[s + 1] as Pt;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const spans = Math.max(1, Math.round(len / Math.max(4, span)));
    for (let k = s === 0 ? 0 : 1; k <= spans; k += 1) {
      out.push([a[0] + ((b[0] - a[0]) * k) / spans, a[1] + ((b[1] - a[1]) * k) / spans]);
    }
  }
  return out;
}

/**
 * Red velvet bows tied where a Christmas garland is fixed: at each swag point of a rail garland,
 * at the top of a garland wound round a post, or at the top corners of a door casing. Classic and
 * abundant styles only.
 */
function garlandBows(scene: Scene, kind: GarlandKind, support: readonly Pt[]): Item[] {
  if (scene.holiday !== 'christmas' || scene.density < 1) return [];
  const m = scene.scale.ref;
  const points =
    kind === 'rail'
      ? swagPoints(support, RAIL_SWAG_SPAN * m)
      : kind === 'post'
        ? [support[0] as Pt]
        : kind === 'frame' && support.length === 4
          ? [support[1] as Pt, support[2] as Pt]
          : [];
  return points.map(([x, y]): Item => ({
    kind: 'sprite',
    asset: 'decor-bow-red',
    x,
    y: y - m * 0.03,
    size: m * (kind === 'post' ? 0.26 : 0.24) * (scene.density > 1.1 ? 1.1 : 1),
    shadow: 'drop',
    layer: 2.5,
    flip: false,
    occludable: true,
  }));
}

/** How full a garland of a given kind is drawn (rope and boughs). */
function garlandFullness(scene: Scene, kind: GarlandKind): number {
  const base = kind === 'rail' ? 1.3 : kind === 'post' ? 1.2 : 1;
  return base * (scene.density > 1.1 ? 1.1 : scene.density < 0.9 ? 0.9 : 1);
}

/** A garland path for a run of the given kind on its support line. */
type GarlandKind = 'rail' | 'mantel' | 'window' | 'frame' | 'post';

function garlandPath(kind: GarlandKind, support: Pt[], s: ScaleModel): Pt[][] {
  const m = s.ref;
  switch (kind) {
    case 'rail':
      return [drape(support, RAIL_SWAG_SPAN * m, m * 0.2)];
    case 'window': {
      // Hung just below the top casing, swagged in two or three spans.
      const lowered = support.map(([x, y]): Pt => [x, y + m * 0.07]);
      return [drape(lowered, Math.max(m * 0.6, pathLength(support) / 3), m * 0.12)];
    }
    case 'mantel': {
      // Draped across the shelf's front face, below the things standing on it.
      support = support.map(([x, y]): Pt => [x, y + m * 0.05]);
      const swags = drape(support, Math.max(m * 0.45, pathLength(support) / 3), m * 0.1);
      const [first, last] = [support[0] as Pt, support[support.length - 1] as Pt];
      // The ends drop over the shelf's corners.
      const tail = (p: Pt, dir: number): Pt[] => [
        [p[0] + dir * m * 0.02, p[1] + m * 0.02],
        [p[0] + dir * m * 0.035, p[1] + m * 0.18],
        [p[0] + dir * m * 0.03, p[1] + m * 0.34],
      ];
      return [swags, [first, ...tail(first, -1)], [last, ...tail(last, 1)]];
    }
    case 'frame': {
      if (support.length !== 4) return [support];
      // Up one side of the casing, over the top with a slight sag and back down, its corners
      // rounded the way a garland bends over a nail rather than a square frame.
      const [bl, tl, tr, br] = support as [Pt, Pt, Pt, Pt];
      const r = Math.min(m * 0.14, (tr[0] - tl[0]) * 0.25, (bl[1] - tl[1]) * 0.2);
      const out: Pt[] = [bl, [tl[0], tl[1] + r]];
      const corner = (cx: number, cy: number, from: number) => {
        for (let k = 1; k < 6; k += 1) {
          const t = from + (k / 6) * (Math.PI / 2);
          out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
        }
      };
      corner(tl[0] + r, tl[1] + r, Math.PI);
      const sag = m * 0.07;
      for (let k = 0; k <= 10; k += 1) {
        const t = k / 10;
        out.push([tl[0] + r + (tr[0] - tl[0] - 2 * r) * t, tl[1] + sag * 4 * t * (1 - t)]);
      }
      corner(tr[0] - r, tr[1] + r, -Math.PI / 2);
      out.push([tr[0], tr[1] + r], br);
      return [out];
    }
    case 'post': {
      // Wound around a porch post: only the turns crossing the front face show, each a short
      // diagonal from one side to the other; the back of each turn is hidden by the post.
      const [top, bottom] = [support[0] as Pt, support[1] as Pt];
      const half = Math.max(1, (support[2]?.[0] ?? top[0] + m * 0.08) - top[0]);
      const turns = Math.max(2, Math.round((bottom[1] - top[1]) / (m * 0.5)));
      const pitch = (bottom[1] - top[1]) / turns;
      const out: Pt[][] = [];
      for (let k = 0; k < turns; k += 1) {
        const y = top[1] + pitch * k;
        const segment: Pt[] = [];
        for (let j = 0; j <= 6; j += 1) {
          const t = j / 6;
          // Seen on a cylinder: the crossing is steepest at the edges.
          segment.push([top[0] - Math.cos(t * Math.PI) * half * 0.95, y + pitch * 0.55 * t]);
        }
        out.push(segment);
      }
      return out;
    }
  }
}

/** Lowest exposure of a wreath hung on a door or window in shade (linear gain). */
const HUNG_MIN_EXPOSURE = 0.5;

/**
 * A wreath sized to fill its planned region (the planner sizes that region from the door or
 * window it hangs on), centered on it. A Christmas wreath is a full fir and holly ring with a red
 * velvet bow tied at its top; other holidays hang their own photographed wreath.
 */
function wreathItems(scene: Scene, region: PxBox, onDoor: boolean): Item[] {
  const s = scene.scale;
  const cx = (region.x0 + region.x1) / 2;
  const cy = (region.y0 + region.y1) / 2;
  const side = Math.min(region.x1 - region.x0, region.y1 - region.y0);
  const minExposure = onDoor ? HUNG_MIN_EXPOSURE : HUNG_MIN_EXPOSURE * 0.8;
  if (scene.holiday === 'christmas') {
    // Sprite width (sprig tips included) about the region's size; a 20 to 30 inch wreath.
    const diameter = Math.min(s.ref * 0.78, Math.max(s.ref * 0.3, side * 1.02));
    const bow = diameter * (onDoor ? 0.46 : 0.4);
    return [
      {
        kind: 'sprite',
        asset: 'decor-wreath-fir-holly',
        x: cx,
        y: cy,
        size: diameter,
        shadow: 'drop',
        layer: 1,
        flip: false,
        pivot: [0.52, 0.5],
        minExposure,
      },
      {
        kind: 'sprite',
        asset: 'decor-bow-red',
        x: cx,
        y: cy - diameter * 0.33,
        size: bow,
        shadow: 'drop',
        layer: 1.1,
        flip: false,
        minExposure,
      },
    ];
  }
  if (scene.holiday === 'new_years_eve') {
    const diameter = Math.min(s.ref * 0.66, Math.max(s.ref * 0.3, side * 1.02));
    return [
      {
        kind: 'sprite',
        asset: 'decor-wreath-evergreen',
        x: cx,
        y: cy,
        size: diameter,
        shadow: 'drop',
        layer: 1,
        flip: false,
        pivot: [0.5, 0.5],
        minExposure,
      },
    ];
  }
  // An autumn leaf wreath: photographed maple and oak leaves bound densely on a ring.
  const outer = Math.min(s.ref * 0.3, Math.max(s.ref * 0.12, side * 0.46));
  // Leaves and the bound core scale with the ring, so a small wreath keeps its open center.
  const fullness = Math.min(1.2, Math.max(0.45, outer / (s.ref * 0.25)));
  const radius = outer * 0.66;
  const path: Pt[] = [];
  for (let k = 0; k <= 48; k += 1) {
    const t = (k / 48) * Math.PI * 2 - Math.PI / 2;
    path.push([cx + Math.cos(t) * radius, cy + Math.sin(t) * radius]);
  }
  return [
    {
      kind: 'garland',
      path,
      harvest: true,
      lit: false,
      onRail: false,
      layer: 1,
      onDoor,
      ring: true,
      fullness,
    },
  ];
}

/** Builds placement items from exact frame geometry (placement regions). */
function itemsFromRegions(
  scene: Scene,
  placement: FixturePlacement,
  archetype: DecorArchetype,
): Item[] {
  const { width: W, height: H } = scene;
  const region = px(placement.region, W, H);
  const items: Item[] = [];
  const s = scene.scale;
  const category = placement.anchorCategory;
  if (archetype === 'string_lights') {
    if (!LIGHT_LINES.has(category)) return [];
    items.push({
      kind: 'lights',
      support: supportLine(category, alongAnchor(region), s),
      layer: 0,
    });
    return items;
  }
  if (archetype === 'garland') {
    const anchor = alongAnchor(region);
    const harvest = scene.holiday === 'thanksgiving_us' || scene.holiday === 'halloween';
    if (category === 'door_frame' || category === 'front_door' || category === 'unit_door') {
      const off = s.ref * 0.03;
      const support: Pt[] = [
        [anchor.x0 - off, anchor.y1 - (anchor.y1 - anchor.y0) * 0.02],
        [anchor.x0 - off, anchor.y0 - off],
        [anchor.x1 + off, anchor.y0 - off],
        [anchor.x1 + off, anchor.y1 - (anchor.y1 - anchor.y0) * 0.02],
      ];
      for (const path of garlandPath('frame', support, s)) {
        items.push({ kind: 'garland', path, harvest, lit: placement.lit, onRail: false, layer: 1 });
      }
      items.push(...garlandBows(scene, 'frame', support));
      return items;
    }
    if (category === 'column') {
      const cx = (anchor.x0 + anchor.x1) / 2;
      const half = (anchor.x1 - anchor.x0) / 2;
      const support: Pt[] = [
        [cx, anchor.y0 + (anchor.y1 - anchor.y0) * 0.03],
        [cx, anchor.y1],
        [cx + half, anchor.y0],
      ];
      for (const path of garlandPath('post', support, s)) {
        items.push({
          kind: 'garland',
          path,
          harvest,
          lit: placement.lit,
          onRail: false,
          layer: 1,
          fullness: garlandFullness(scene, 'post'),
        });
      }
      items.push(...garlandBows(scene, 'post', support));
      return items;
    }
    const kind =
      category === 'mantel'
        ? 'mantel'
        : category === 'interior_window' || category === 'window_frame'
          ? 'window'
          : 'rail';
    const support = supportLine(category, anchor, s);
    for (const path of garlandPath(kind, support, s)) {
      items.push({
        kind: 'garland',
        path,
        harvest,
        lit: placement.lit,
        onRail: kind === 'rail',
        layer: kind === 'rail' ? 2 : 1,
        overGlass: kind === 'window',
        fullness: garlandFullness(scene, kind),
      });
    }
    items.push(...garlandBows(scene, kind, support));
    return items;
  }
  if (archetype === 'wreath') {
    const door = category === 'front_door' || category === 'unit_door' || category === 'door_frame';
    return wreathItems(scene, region, door);
  }
  if (archetype === 'stocking') {
    const n = Math.max(1, Math.min(3, Math.round((region.x1 - region.x0) / s.ref / 0.45)));
    for (let i = 0; i < n; i += 1) {
      const x = region.x0 + ((i + 0.5) / n) * (region.x1 - region.x0);
      items.push({
        kind: 'sprite',
        asset: 'decor-stocking',
        x,
        y: region.y0 + s.ref * 0.03,
        size: s.ref * 0.5,
        shadow: 'drop',
        layer: 1,
        flip: i % 2 === 1,
      });
    }
    return items;
  }
  if (placement.placementRule === 'on_surface') {
    const choice = surfaceAsset(archetype, scene.holiday);
    if (!choice) return [];
    const anchorH = (region.y1 - region.y0) / 0.75;
    const top = region.y0 + anchorH * 0.15;
    const y = top + anchorH * 0.3;
    const x = (region.x0 + region.x1) / 2;
    items.push(spriteOnBase(scene, choice.asset, x, y, choice.meters, false));
    return items;
  }
  if (STANDING[archetype]) {
    const assets = standingGroup(archetype, scene, placement.lit);
    if (assets.length === 0) return [];
    const count = Math.max(1, Math.min(3, Math.max(placement.count, assets.length)));
    if (AREA_CATEGORIES.has(category)) {
      // A measured standing spot: the items stand side by side, centered on it.
      const items = Array.from({ length: count }, (_, i) =>
        spriteOnBase(
          scene,
          assets[i % assets.length] as string,
          0,
          region.y1,
          undefined,
          i % 2 === 1,
        ),
      );
      const widths = items.map((it) => (it.kind === 'sprite' ? spriteWidthPx(it) * 0.85 : 0));
      let x = (region.x0 + region.x1) / 2 - widths.reduce((a, b) => a + b, 0) / 2;
      for (const [i, it] of items.entries()) {
        if (it.kind === 'sprite') it.x = x + (widths[i] as number) / 2;
        x += widths[i] as number;
      }
      return items;
    }
    const baseY =
      placement.placementRule === 'cluster_at'
        ? region.y0 + (region.y1 - region.y0) * 0.75
        : region.y1 - (region.y1 - region.y0) * 0.02;
    // The anchor is on the side the planner flanked; items line up away from it.
    const gap = scene.gaps.find(
      (g) => Math.abs(g.x0 - region.x1) < W * 0.012 || Math.abs(g.x1 - region.x0) < W * 0.012,
    );
    const anchorOnRight = gap ? Math.abs(gap.x0 - region.x1) < W * 0.012 : true;
    let offset = 0;
    for (let i = 0; i < count; i += 1) {
      const asset = assets[i % assets.length] as string;
      const item = spriteOnBase(scene, asset, 0, baseY, undefined, i % 2 === 1);
      const w = item.kind === 'sprite' ? spriteWidthPx(item) : 0;
      let x: number;
      if (placement.placementRule === 'cluster_at') {
        x = (region.x0 + region.x1) / 2 + (i - (count - 1) / 2) * w * 0.9;
      } else if (gap && i % 2 === 1) {
        // A pair flanks the steps: the second item stands on the other side.
        x = anchorOnRight ? gap.x1 + w * 0.6 + offset * 0 : gap.x0 - w * 0.6;
      } else {
        x = anchorOnRight ? region.x1 - w * 0.6 - offset : region.x0 + w * 0.6 + offset;
        offset += w * 0.95;
      }
      if (item.kind === 'sprite') item.x = x;
      items.push(item);
    }
    return items;
  }
  return [];
}

/** Where the stocking cutout's hanging loop is, as a share of its height from the top. */
const STOCKING_HOOK = 0.33;

/** Intrinsic sizes of the cutouts (filled in once sprites load). */
const ASPECTS = new Map<string, { aspect: number; axis: 'width' | 'height'; meters: number }>();

function spriteWidthPx(item: Extract<Item, { kind: 'sprite' }>): number {
  const info = ASPECTS.get(item.asset);
  if (!info) return item.size;
  return info.axis === 'width' ? item.size : item.size * info.aspect;
}

function spriteOnBase(
  scene: Scene,
  asset: string,
  x: number,
  y: number,
  meters: number | undefined,
  flip: boolean,
): Item {
  const info = ASPECTS.get(asset);
  const size = (meters ?? info?.meters ?? 0.4) * scene.scale.at(y) * scene.rng.range(0.93, 1.05);
  return { kind: 'sprite', asset, x, y, size, shadow: 'contact', layer: 3, flip };
}

/** Overlap of two normalized boxes as a share of the smaller one (0 when apart). */
function boxOverlap(a: NormalizedBox, b: NormalizedBox): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h < 0) return 0;
  const area = (box: NormalizedBox) =>
    Math.max(1e-6, (box[2] - box[0]) * Math.max(box[3] - box[1], 0.004));
  return (w * Math.max(h, 0.004)) / Math.min(area(a), area(b));
}

function boundsOf(points: readonly (readonly [number, number])[]): NormalizedBox {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The unused candidates that lie in a placement's region, best overlap first: the planner's
 * regions were derived from the same measured anchors, so each placement finds its own.
 */
function inRegion<T extends { key: string; box: NormalizedBox }>(
  candidates: readonly T[],
  region: NormalizedBox,
  used: Set<string>,
): T[] {
  return candidates
    .filter((c) => !used.has(c.key) && boxOverlap(c.box, region) > 0.3)
    .sort((a, b) => boxOverlap(b.box, region) - boxOverlap(a.box, region));
}

type SpriteItem = Extract<Item, { kind: 'sprite' }>;

/** True when the pipeline lets the image change at a point (or anywhere, without a mask). */
function spotEditable(scene: Scene, [x, y]: Pt): boolean {
  if (!scene.editable) return true;
  const xi = Math.round(x);
  const yi = Math.round(y) - 2;
  if (xi < 0 || yi < 0 || xi >= scene.width || yi >= scene.height) return false;
  return scene.editable[yi * scene.width + xi] === 1;
}

/** The editable width either side of a point on a row (to the first pixel that may not change). */
function editableReach(scene: Scene, x: number, y: number): [number, number] {
  const { width: W, height: H } = scene;
  const editable = scene.editable;
  if (!editable) return [W, W];
  const row = Math.max(0, Math.min(H - 1, Math.round(y)));
  const start = Math.max(0, Math.min(W - 1, Math.round(x)));
  let left = 0;
  while (start - left - 1 >= 0 && editable[row * W + start - left - 1]) left += 1;
  let right = 0;
  while (start + right + 1 < W && editable[row * W + start + right + 1]) right += 1;
  return [left, right];
}

/**
 * Lays out the groups standing on one measured spot side by side, centered on it, and thins
 * them until they fit the surface the pipeline lets the image change there: the smallest object
 * of the fullest group goes first, so every group keeps its main object as long as possible.
 */
function layoutSpot(
  scene: Scene,
  x: number,
  y: number,
  groups: { items: SpriteItem[]; width: number }[],
  surface?: readonly [number, number],
): void {
  const m = scene.scale.at(y);
  // The narrowest editable width over the height the objects stand.
  let reachL = Infinity;
  let reachR = Infinity;
  for (const k of [0.05, 0.3, 0.6]) {
    const [l, r] = editableReach(scene, x, y - k * m);
    reachL = Math.min(reachL, l);
    reachR = Math.min(reachR, r);
  }
  if (surface) {
    // Bases stay on the surface; a rounded object may overhang its edge a little.
    reachL = Math.min(reachL, x - surface[0] + m * 0.06);
    reachR = Math.min(reachR, surface[1] - x + m * 0.06);
  }
  const room = reachL + reachR;
  const liveOf = (g: { items: SpriteItem[] }) => g.items.filter((it) => !it.dropped);
  const extent = (live: SpriteItem[]): [number, number] => [
    Math.min(...live.map((it) => it.x - spriteWidthPx(it) * 0.5)),
    Math.max(...live.map((it) => it.x + spriteWidthPx(it) * 0.5)),
  ];
  for (;;) {
    for (const g of groups) {
      const live = liveOf(g);
      if (live[0]) live[0].y = y;
      arrangeGroup(live, scene.scale);
      const [l, r] = live.length > 0 ? extent(live) : [0, 0];
      g.width = r - l;
    }
    const standing = groups.filter((g) => liveOf(g).length > 0);
    const total = standing.reduce((sum, g) => sum + g.width, 0);
    // Groups may overlap, the later one standing in front, down to 60% of their combined width.
    const widest = Math.max(0, ...standing.map((g) => g.width));
    const packed = Math.max(widest, total * 0.6);
    const singles = standing.every((g) => liveOf(g).length <= 1);
    if (packed <= room || (singles && standing.length <= 1)) {
      const k =
        total > room && total > widest ? Math.max(0, (room - widest) / (total - widest)) : 1;
      const step = (g: { width: number }, i: number) => (i === 0 ? g.width : g.width * k);
      const used = standing.reduce((sum, g, i) => sum + step(g, i), 0);
      // Centered on the spot, shifted only as far as the surface requires.
      const center = Math.min(x + reachR - used / 2, Math.max(x - reachL + used / 2, x));
      let left = center - used / 2;
      for (const [i, g] of standing.entries()) {
        const live = liveOf(g);
        const [l, r] = extent(live);
        const shift = (i === 0 ? left : left - g.width * (1 - k)) + g.width / 2 - (l + r) / 2;
        for (const it of g.items) {
          it.x += shift;
          if (k < 1 && i > 0) it.y += scene.scale.ref * 0.03 * i;
        }
        left += step(g, i);
      }
      return;
    }
    if (singles) {
      // Even single objects do not fit together: the last group to arrive stays out.
      for (const it of (standing[standing.length - 1] as (typeof groups)[number]).items)
        it.dropped = true;
      continue;
    }
    const fullest = standing.reduce((best, g) =>
      liveOf(g).length > liveOf(best).length ? g : best,
    );
    const live = liveOf(fullest);
    const smallest = live.slice(1).reduce((a, b) => (spriteWidthPx(b) < spriteWidthPx(a) ? b : a));
    smallest.dropped = true;
  }
}

/** Builds placement items from a recognized library photo's measured anchors. */
function itemsFromLibrary(
  scene: Scene,
  placement: FixturePlacement,
  archetype: DecorArchetype,
  anchors: LibraryAnchors,
  used: Set<string>,
): Item[] {
  const { width: W, height: H } = scene;
  const P = (p: readonly [number, number]): Pt => [p[0] * W, p[1] * H];
  const s = scene.scale;
  const harvest = scene.holiday === 'thanksgiving_us' || scene.holiday === 'halloween';
  const region = placement.region;
  const category = placement.anchorCategory;
  const lines = (list: readonly (readonly (readonly [number, number])[])[], prefix: string) =>
    list.map((line, i) => ({ key: `${prefix}${i}`, box: boundsOf(line), line }));
  const out: Item[] = [];
  if (archetype === 'string_lights') {
    const onRail = ['porch_rail', 'balcony_railing', 'banister'].includes(category);
    const candidates = onRail
      ? lines(anchors.rails, 'lights-rail')
      : lines(anchors.eaves, 'lights-eave');
    for (const c of inRegion(candidates, region, used).slice(0, Math.max(1, placement.count))) {
      used.add(c.key);
      out.push({ kind: 'lights', support: c.line.map(P), layer: 0 });
    }
    return out;
  }
  if (archetype === 'garland') {
    type Candidate = {
      key: string;
      box: NormalizedBox;
      kind: GarlandKind;
      support: Pt[];
    };
    const candidates: Candidate[] = [];
    if (category === 'mantel' && anchors.mantel) {
      candidates.push({
        key: 'mantel',
        box: boundsOf(anchors.mantel),
        kind: 'mantel',
        support: anchors.mantel.map(P),
      });
    }
    if (category === 'interior_window' || category === 'window_frame' || category === 'mantel') {
      for (const c of lines(anchors.windowTops, 'window')) {
        candidates.push({ key: c.key, box: c.box, kind: 'window', support: c.line.map(P) });
      }
    }
    if (['porch_rail', 'balcony_railing', 'banister'].includes(category)) {
      for (const c of lines(anchors.rails, 'garland-rail')) {
        candidates.push({ key: c.key, box: c.box, kind: 'rail', support: c.line.map(P) });
      }
    }
    if (category === 'column') {
      for (const [i, box] of anchors.posts.entries()) {
        const b = px(box, W, H);
        const cx = (b.x0 + b.x1) / 2;
        candidates.push({
          key: `garland-post${i}`,
          box,
          kind: 'post',
          support: [
            [cx, b.y0 + (b.y1 - b.y0) * 0.03],
            [cx, b.y1],
            [b.x1, b.y0],
          ],
        });
      }
    }
    if (category === 'door_frame') {
      for (const [i, box] of anchors.doorFrames.entries()) {
        const b = px(box, W, H);
        if (b.y0 < H * 0.02) continue;
        const off = s.ref * 0.03;
        candidates.push({
          key: `frame${i}`,
          box,
          kind: 'frame',
          support: [
            [b.x0 - off, b.y1],
            [b.x0 - off, b.y0 - off],
            [b.x1 + off, b.y0 - off],
            [b.x1 + off, b.y1],
          ],
        });
      }
    }
    const [chosen] = inRegion(candidates, region, used);
    if (!chosen) return out;
    used.add(chosen.key);
    for (const path of garlandPath(chosen.kind, chosen.support, s)) {
      out.push({
        kind: 'garland',
        path,
        harvest,
        lit: placement.lit,
        onRail: chosen.kind === 'rail',
        layer: chosen.kind === 'rail' ? 2 : 1,
        overGlass: chosen.kind === 'window',
        fullness: garlandFullness(scene, chosen.kind),
      });
    }
    out.push(...garlandBows(scene, chosen.kind, chosen.support));
    return out;
  }
  if (archetype === 'wreath') {
    const onWindow = category === 'window_frame' || category === 'interior_window';
    const targets = (onWindow ? anchors.windows : anchors.doors).map((box, i) => ({
      key: `wreath:${onWindow ? 'w' : 'd'}${i}`,
      box,
    }));
    for (const target of inRegion(targets, region, used).slice(0, 1)) {
      used.add(target.key);
      // The planned region is centered on the measured door or window and sized from it.
      out.push(...wreathItems(scene, px(region, W, H), !onWindow));
    }
    return out;
  }
  if (archetype === 'stocking') {
    if (!anchors.mantel || used.has('stockings')) return [];
    used.add('stockings');
    const line = anchors.mantel.map(P);
    const a = line[0] as Pt;
    const b = line[line.length - 1] as Pt;
    const n = Math.max(2, Math.min(3, Math.round(placement.count + 1)));
    // Hung from hooks on the shelf's front face; as long as the planned region allows (the
    // stocking's greenery rises a third of its length above the hook).
    const spec = ASPECTS.get('decor-stocking');
    const shelf = Math.max(a[1], b[1]);
    const bottom = region[3] * H + Math.max(W, H) * 0.012;
    // Hung in front of the garland from hooks on the shelf's face; the whole stocking,
    // greenery included, stays below the shelf's top edge.
    const hookY = shelf + s.ref * 0.14;
    const size = Math.min(
      s.ref * 0.5,
      (bottom - hookY) / (1 - STOCKING_HOOK),
      (hookY - shelf) / STOCKING_HOOK,
    );
    if (!spec || size < s.ref * 0.3) return [];
    for (let i = 0; i < n; i += 1) {
      const t = 0.22 + (0.56 * i) / Math.max(1, n - 1);
      out.push({
        kind: 'sprite',
        asset: 'decor-stocking',
        x: a[0] + (b[0] - a[0]) * t,
        y: hookY,
        size,
        shadow: 'drop',
        layer: 2,
        flip: i % 2 === 1,
      });
    }
    return out;
  }
  const spot = (p: readonly [number, number], key: string) => ({
    key,
    box: [p[0] - 0.002, p[1] - 0.002, p[0] + 0.002, p[1] + 0.002] as NormalizedBox,
    p,
  });
  if (
    placement.placementRule === 'on_surface' ||
    archetype === 'centerpiece' ||
    archetype === 'arrangement' ||
    archetype === 'candles'
  ) {
    const choice = surfaceAsset(archetype, scene.holiday);
    if (!choice) return [];
    const spots = [
      ...anchors.tableSpots.map((p, i) => spot(p, `table${i}`)),
      ...(category === 'dining_table'
        ? []
        : anchors.surfaceSpots.map((p, i) => spot(p, `surface${i}`))),
    ];
    for (const c of inRegion(spots, region, used).slice(0, 1)) {
      used.add(c.key);
      const [x, y] = P(c.p);
      const item = spriteOnBase(scene, choice.asset, x, y, choice.meters, false);
      if (item.kind === 'sprite')
        item.size = (choice.meters ?? ASPECTS.get(choice.asset)?.meters ?? 0.4) * s.ref;
      out.push(item);
    }
    return out;
  }
  if (STANDING[archetype]) {
    const assets = standingGroup(archetype, scene, placement.lit);
    if (assets.length === 0) return [];
    const spots = anchors.standSpots.map((p, i) => spot(p, `stand${i}`));
    // The planned region's own spot (its bottom center), then other measured spots the plan lets
    // the image change, nearest first: a group that finds its spot full stands on the next one.
    const home: Pt = [((region[0] + region[2]) / 2) * W, region[3] * H];
    const within = inRegion(spots, region, new Set()).map((c) => c.key);
    const near = (c: (typeof spots)[number]) =>
      Math.hypot(P(c.p)[0] - home[0], P(c.p)[1] - home[1]);
    const order = [
      ...spots.filter((c) => within.includes(c.key)).sort((a, b) => near(a) - near(b)),
      ...spots
        .filter((c) => !within.includes(c.key) && spotEditable(scene, P(c.p)))
        .filter((c) => near(c) < s.ref * 2.5)
        .sort((a, b) => near(a) - near(b)),
    ].filter((c) => (scene.spotGroups.get(c.key)?.length ?? 0) < 3);
    for (const [attempt, c] of order.entries()) {
      const [x, y] = P(c.p);
      const groups = scene.spotGroups.get(c.key) ?? [];
      const offset = anchors.standSpots.indexOf(c.p as [number, number]) + groups.length;
      const items = assets
        .map((asset, i) => spriteOnBase(scene, asset, x, y, undefined, (i + offset) % 2 === 1))
        .filter((it): it is SpriteItem => it.kind === 'sprite');
      arrangeGroup(items, s);
      const group = { items, width: 0 };
      const before = groups.flatMap((g) =>
        g.items.map((it) => ({ it, x: it.x, dropped: it.dropped })),
      );
      // The second group goes to the right of the first, the third to the left.
      const next = groups.length === 2 ? [group, ...groups] : [...groups, group];
      const index = anchors.standSpots.indexOf(c.p as [number, number]);
      const surface = anchors.standSurfaces[index];
      layoutSpot(scene, x, y, next, surface ? [surface.from * W, surface.to * W] : undefined);
      if (surface?.open) for (const it of items) it.inOpen = true;
      const last = attempt === order.length - 1;
      if ((items[0] as SpriteItem).dropped && !last) {
        // No room here: put the spot back as it was and try the next one.
        for (const saved of before) {
          saved.it.x = saved.x;
          saved.it.dropped = saved.dropped;
        }
        continue;
      }
      groups.splice(0, groups.length, ...next);
      scene.spotGroups.set(c.key, groups);
      out.push(...items);
      break;
    }
    return out;
  }
  return [];
}

// ---- drawing ------------------------------------------------------------------------------------

interface Studio {
  canvas: Canvas;
  glow: Float32Array;
  /** Light falling on nearby surfaces (multiplied by their daylight color). */
  spill: Float32Array;
  /** The scene's surface colors: the source photo in linear light. */
  albedo: Float32Array;
  scene: Scene;
  illum: [number, number, number];
  texture: { grain: number; sharpness: number };
  foliage: Float32Array;
  keepOutPlane: Float32Array;
  /** Pixels decorations may change (null: anywhere). */
  editable: Uint8Array | null;
  /** 1 where nothing may be drawn, softened at the edge of the editable area (null: none). */
  outside: Float32Array | null;
  sprites: Map<string, Sprite>;
  rng: Rng;
}

/** Combined hide plane: preserved regions always, foliage in front for occludable items. */
function hidePlane(studio: Studio, occludable: boolean): Float32Array {
  if (!occludable) return studio.keepOutPlane;
  const out = new Float32Array(studio.keepOutPlane.length);
  for (let p = 0; p < out.length; p += 1) {
    out[p] = Math.max(studio.keepOutPlane[p] as number, studio.foliage[p] as number);
  }
  return out;
}

function gradeFor(
  studio: Studio,
  rect: Rect,
  rendered: Rendered,
  emits: boolean,
  maxBlur = 1.4,
): Grade {
  const pad = Math.max(rect.x1 - rect.x0, rect.y1 - rect.y0) * 0.6;
  const around = meanRgb(studio.canvas, {
    x0: rect.x0 - pad,
    y0: rect.y0 - pad * 0.5,
    x1: rect.x1 + pad,
    y1: rect.y1 + pad * 0.5,
  });
  const key = lum(...around);
  // Exposure follows the light around the object; the cutouts were shot brightly lit in a
  // studio, so they sit a little below the scene's own key.
  const exposure = Math.min(0.95, Math.max(0.08, (key / 0.24) ** 0.7));
  // Studio color is cleaner than color in a real scene: saturation follows the scene's.
  const sceneChroma = meanChroma(studio.canvas, {
    x0: rect.x0 - pad,
    y0: rect.y0 - pad * 0.5,
    x1: rect.x1 + pad,
    y1: rect.y1 + pad * 0.5,
  });
  const ownChroma = renderedChroma(rendered);
  const saturation = Math.min(
    1,
    Math.max(0.62, 0.55 + (0.6 * sceneChroma) / Math.max(0.05, ownChroma)),
  );
  const tint = studio.illum.map((v) => v ** 0.75) as [number, number, number];
  const target = studio.texture.sharpness;
  const own = spriteSharpness(rendered);
  // Soften until the cutout is no crisper than the photograph around it.
  const blur = own > target ? Math.min(maxBlur, (own - target) * 6) : 0;
  return {
    gain: [exposure * tint[0], exposure * tint[1], exposure * tint[2]],
    saturation: saturation * (studio.scene.evening ? 0.82 : 1),
    blur,
    grain: studio.texture.grain * Math.max(0.02, key),
    emissionGain: emits ? (studio.scene.evening ? 1.6 : 1) : 0,
  };
}

/** Mean chroma ((max − min) / max) of a canvas area, from a sparse sample. */
function meanChroma(canvas: Canvas, rect: Rect): number {
  const r = clipRect(rect, canvas.width, canvas.height);
  const step = Math.max(1, Math.floor(Math.sqrt(((r.x1 - r.x0) * (r.y1 - r.y0)) / 3000)));
  let sum = 0;
  let n = 0;
  for (let y = r.y0; y < r.y1; y += step) {
    for (let x = r.x0; x < r.x1; x += step) {
      const i = (y * canvas.width + x) * 3;
      const red = canvas.rgb[i] as number;
      const green = canvas.rgb[i + 1] as number;
      const blue = canvas.rgb[i + 2] as number;
      const max = Math.max(red, green, blue);
      if (max <= 0.01) continue;
      sum += (max - Math.min(red, green, blue)) / max;
      n += 1;
    }
  }
  return n === 0 ? 0.2 : sum / n;
}

/** Alpha-weighted mean chroma of a rendered sprite. */
function renderedChroma(r: Rendered): number {
  let sum = 0;
  let total = 0;
  for (let p = 0; p < r.width * r.height; p += 1) {
    const a = r.data[p * 4 + 3] as number;
    if (a <= 0.3) continue;
    const red = r.data[p * 4] as number;
    const green = r.data[p * 4 + 1] as number;
    const blue = r.data[p * 4 + 2] as number;
    const max = Math.max(red, green, blue);
    if (max <= 0.01 * a) continue;
    sum += ((max - Math.min(red, green, blue)) / max) * a;
    total += a;
  }
  return total > 0 ? sum / total : 0.2;
}

/** True when a point lies in the frame and in the area decorations may change. */
function placeable(studio: Studio, [x, y]: Pt): boolean {
  const { width, height } = studio.canvas;
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= width || yi >= height) return false;
  return !studio.editable || studio.editable[yi * width + xi] === 1;
}

/** Share of a rendered object's coverage (alpha) that lies in the editable area. */
function editableAlphaShare(studio: Studio, r: Rendered): number {
  if (!studio.editable) return 1;
  const { width, height } = studio.canvas;
  let inside = 0;
  let total = 0;
  for (let y = 0; y < r.height; y += 1) {
    const cy = r.rect.y0 + y;
    for (let x = 0; x < r.width; x += 1) {
      const a = r.data[(y * r.width + x) * 4 + 3] as number;
      if (a <= 0.02) continue;
      total += a;
      const cx = r.rect.x0 + x;
      if (cx >= 0 && cy >= 0 && cx < width && cy < height && studio.editable[cy * width + cx])
        inside += a;
    }
  }
  return total === 0 ? 0 : inside / total;
}

/** A hide plane extended by the soft complement of the editable area. */
function withOutside(studio: Studio, hide: Float32Array): Float32Array {
  const outside = studio.outside;
  if (!outside) return hide;
  return hide.map((v, i) => Math.max(v, outside[i] as number));
}

/**
 * The hide plane for an object standing at `baseY`: preserved regions, plus foliage that is in
 * front of it. Leaves count as in front in the columns where the foliage reaches below the
 * object's base (a shrub between the camera and the object), and not where they only rise
 * behind it.
 */
function foliageInFront(studio: Studio, rect: Rect, baseY: number): Float32Array {
  const { width, height } = studio.canvas;
  const r = clipRect(rect, width, height);
  const probe = Math.min(
    height - 1,
    Math.round(baseY + Math.max(2, studio.scene.scale.ref * 0.04)),
  );
  let any = false;
  const front = new Uint8Array(width);
  for (let x = r.x0; x < r.x1; x += 1) {
    if ((studio.foliage[probe * width + x] as number) > 0.5) {
      front[x] = 1;
      any = true;
    }
  }
  if (!any) return studio.keepOutPlane;
  const plane = Float32Array.from(studio.keepOutPlane);
  for (let y = r.y0; y < r.y1; y += 1) {
    for (let x = r.x0; x < r.x1; x += 1) {
      if (!front[x]) continue;
      const p = y * width + x;
      plane[p] = Math.max(plane[p] as number, studio.foliage[p] as number);
    }
  }
  return plane;
}

/** Adds a soft radial light to the glow buffer (bloomed later). */
function addLight(
  studio: Studio,
  x: number,
  y: number,
  radius: number,
  color: Pt | [number, number, number],
  strength: number,
) {
  const { width, height } = studio.canvas;
  const r = clipRect(
    { x0: x - radius, y0: y - radius, x1: x + radius, y1: y + radius },
    width,
    height,
  );
  for (let yy = r.y0; yy < r.y1; yy += 1) {
    for (let xx = r.x0; xx < r.x1; xx += 1) {
      const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y) / radius;
      if (d >= 1) continue;
      const k = strength * (1 - d) ** 2.2;
      const p = (yy * width + xx) * 3;
      studio.glow[p] = (studio.glow[p] as number) + (color[0] as number) * k;
      studio.glow[p + 1] = (studio.glow[p + 1] as number) + (color[1] as number) * k;
      studio.glow[p + 2] = (studio.glow[p + 2] as number) + ((color as number[])[2] ?? 0) * k;
    }
  }
}

/**
 * Adds light that falls on the surfaces around a source (fascia, wall, porch floor): it lights
 * them in their own color, mostly below the source.
 */
function addSpill(
  studio: Studio,
  x: number,
  y: number,
  radius: number,
  color: readonly number[],
  strength: number,
) {
  const { width, height } = studio.canvas;
  const cy = y + radius * 0.3;
  const r = clipRect(
    { x0: x - radius, y0: cy - radius, x1: x + radius, y1: cy + radius },
    width,
    height,
  );
  for (let yy = r.y0; yy < r.y1; yy += 1) {
    for (let xx = r.x0; xx < r.x1; xx += 1) {
      const d = Math.hypot(xx + 0.5 - x, (yy + 0.5 - cy) * 1.15) / radius;
      if (d >= 1) continue;
      const k = strength * (1 - d) ** 2;
      const p = (yy * width + xx) * 3;
      for (let c = 0; c < 3; c += 1)
        studio.spill[p + c] = (studio.spill[p + c] as number) + (color[c] as number) * k;
    }
  }
}

/** Draws one cutout: shadow on the surface, the graded object, and its light if it gives any. */
function drawSprite(studio: Studio, item: Extract<Item, { kind: 'sprite' }>): boolean {
  const sprite = studio.sprites.get(item.asset);
  if (!sprite || item.dropped) return false;
  const spec = sprite.photo.decor;
  const axisPx = spec.sizeAxis === 'width' ? sprite.width : sprite.height;
  const scale = item.size / axisPx;
  const rendered = renderSprite(sprite, {
    x: item.x,
    y: item.y,
    scale,
    flip: item.flip,
    ...(item.pivot ? { pivot: item.pivot } : {}),
  });
  if (!rendered) return false;
  const { canvas, scene } = studio;
  // Never cover a preserved area or an existing object; never leave the editable area.
  if (scene.keepOut.some((box) => overlapFraction(rendered.rect, box) > 0.04)) return false;
  if (editableAlphaShare(studio, rendered) < 0.96) return false;
  const W = canvas.width;
  const H = canvas.height;
  if (rendered.rect.x0 < -2 || rendered.rect.x1 > W + 2 || rendered.rect.y1 > H + 2) return false;
  const emits = spec.emitsLight && (scene.evening || item.asset !== 'decor-lantern-white');
  const grade = gradeFor(studio, rendered.rect, rendered, emits);
  if (item.minExposure && !scene.evening) {
    // In daylight a hung decoration sits in front of a recessed door or wall and catches more of
    // the open light than the shade behind it; keep it at least at that level.
    const floor = item.minExposure;
    const level = Math.max(...grade.gain);
    if (level < floor) grade.gain = grade.gain.map((g) => (g * floor) / level) as typeof grade.gain;
  }
  const graded = gradeRendered(rendered, grade, studio.rng);
  const objW = rendered.rect.x1 - rendered.rect.x0;
  const hide = withOutside(
    studio,
    item.shadow === 'contact'
      ? item.inOpen
        ? studio.keepOutPlane
        : foliageInFront(studio, rendered.rect, item.y)
      : item.occludable
        ? foliageInFront(studio, rendered.rect, item.y + scene.scale.ref * 0.25)
        : studio.keepOutPlane,
  );
  if (item.shadow === 'contact') {
    // Ambient occlusion where the object meets the surface: a soft, flattened ellipse.
    const rx = objW * 0.5;
    const ry = Math.max(1.5, objW * 0.09);
    const rect: Rect = {
      x0: Math.floor(item.x - rx * 1.6),
      y0: Math.floor(item.y - ry * 3),
      x1: Math.ceil(item.x + rx * 1.6),
      y1: Math.ceil(item.y + ry * 2.5),
    };
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    const mask = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const dx = (rect.x0 + x + 0.5 - item.x) / rx;
        const dy = (rect.y0 + y + 0.5 - (item.y - ry * 0.3)) / ry;
        const d = Math.sqrt(dx * dx + dy * dy);
        mask[y * w + x] =
          (1 - smoothstep(0.35, 1.25, d)) * 0.8 + (1 - smoothstep(0, 0.55, d)) * 0.35;
      }
    }
    multiplyShadow(canvas, rect, w, mask, scene.evening ? 0.45 : 0.62, hide);
    // Ambient occlusion on whatever stands behind it (a riser, a wall, a rail): a very soft,
    // faint copy of its silhouette, slightly offset.
    const a = new Float32Array(graded.width * graded.height);
    for (let p = 0; p < a.length; p += 1) a[p] = graded.data[p * 4 + 3] as number;
    const soft = blurFloat(a, graded.width, graded.height, 1, Math.max(1.5, objW * 0.12));
    const dx = Math.round(objW * 0.06);
    const dy = -Math.round(objW * 0.03);
    multiplyShadow(
      canvas,
      {
        x0: graded.rect.x0 + dx,
        y0: graded.rect.y0 + dy,
        x1: graded.rect.x1 + dx,
        y1: graded.rect.y1 + dy,
      },
      graded.width,
      soft,
      scene.evening ? 0.15 : 0.22,
      hide,
    );
  } else {
    // A hung object casts a soft shadow just below it on the surface behind.
    const off = scene.scale.ref * 0.022;
    const blur = Math.max(1, scene.scale.ref * 0.018);
    const a = new Float32Array(graded.width * graded.height);
    for (let p = 0; p < a.length; p += 1) a[p] = graded.data[p * 4 + 3] as number;
    const soft = blurFloat(a, graded.width, graded.height, 1, blur);
    multiplyShadow(
      canvas,
      {
        x0: graded.rect.x0 + Math.round(off * 0.4),
        y0: graded.rect.y0 + Math.round(off),
        x1: graded.rect.x1 + Math.round(off * 0.4),
        y1: graded.rect.y1 + Math.round(off),
      },
      graded.width,
      soft,
      scene.evening ? 0.3 : 0.42,
      hide,
    );
  }
  compositeOver(canvas, graded, hide);
  if (emits && spec.lightPoint) {
    // The light point in output pixels, measured from the attach point in the sprite's frame.
    const dir = item.flip ? -1 : 1;
    const x = item.x + (spec.lightPoint[0] - spec.attachPoint[0]) * sprite.width * scale * dir;
    const y = item.y + (spec.lightPoint[1] - spec.attachPoint[1]) * sprite.height * scale;
    const radius = Math.max(objW * (scene.evening ? 1.6 : 0.6), 4);
    addLight(studio, x, y, radius, [1, 0.62, 0.26], scene.evening ? 0.5 : 0.05);
    if (scene.evening)
      addSpill(studio, x, y, Math.max(objW * 3, scene.scale.ref * 0.8), [1, 0.62, 0.3], 0.35);
  }
  return true;
}

/** Bulb colors for a holiday (warm white unless the pack wants color). */
function bulbColors(holiday: HolidayId): [number, number, number][] {
  if (holiday === 'halloween')
    return [
      [1, 0.42, 0.08],
      [0.55, 0.25, 1],
    ];
  return [
    [1, 0.78, 0.45],
    [1, 0.82, 0.52],
    [1, 0.75, 0.4],
  ];
}

/** Real size of a C9 bulb: glass width and length, and the socket's length, in meters. */
const C9 = { width: 0.03, length: 0.058, socket: 0.022 } as const;

/**
 * Draws one C9 bulb on its socket, hanging from the wire at (x, y) and pointing away from the
 * line it is clipped to (down for a level eave): a dark socket, then a tapered glass bulb lit from
 * inside, hottest along its axis and more saturated at its edge, with a soft halo. A bulb is never
 * drawn smaller than three pixels across, so it still reads as a bulb at
 * street distance.
 */
function drawBulb(
  studio: Studio,
  hide: Float32Array,
  x: number,
  y: number,
  lineAngle: number,
  color: [number, number, number],
): boolean {
  const { canvas, scene } = studio;
  const W = canvas.width;
  const H = canvas.height;
  const m = scene.scale.at(y) * studio.rng.range(0.95, 1.05);
  const width = Math.max(3, C9.width * m);
  const length = Math.max(5, C9.length * m);
  const socket = Math.max(1.2, C9.socket * m);
  // The bulb's axis: perpendicular to the line, on its lower side.
  let ax = -Math.sin(lineAngle);
  let ay = Math.cos(lineAngle);
  if (ay < 0) {
    ax = -ax;
    ay = -ay;
  }
  // Clipped bulbs tilt a little, each its own way.
  const tilt = studio.rng.jitter(0.25);
  const cx = ax * Math.cos(tilt) - ay * Math.sin(tilt);
  const cy = ax * Math.sin(tilt) + ay * Math.cos(tilt);
  const tipX = x + cx * (socket + length);
  const tipY = y + cy * (socket + length);
  if (
    (hide[Math.round(tipY - cy * length * 0.5) * W + Math.round(tipX - cx * length * 0.5)] ?? 1) >
    0.5
  )
    return false;
  const reach = socket + length + 2;
  const rect = clipRect({ x0: x - reach, y0: y - reach, x1: x + reach, y1: y + reach }, W, H);
  const evening = scene.evening;
  const brightness = studio.rng.range(0.85, 1.1) * (evening ? 2.8 : 1);
  const sub = 3;
  let any = false;
  for (let yy = rect.y0; yy < rect.y1; yy += 1) {
    for (let xx = rect.x0; xx < rect.x1; xx += 1) {
      let glassA = 0;
      let socketA = 0;
      let axial = 0;
      for (let sy = 0; sy < sub; sy += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const dx = xx + (sx + 0.5) / sub - x;
          const dy = yy + (sy + 0.5) / sub - y;
          const along = dx * cx + dy * cy;
          const across = Math.abs(-dx * cy + dy * cx);
          if (along >= 0 && along < socket) {
            if (across < width * 0.32) socketA += 1;
            continue;
          }
          const t = (along - socket) / length;
          if (t < 0 || t > 1) continue;
          // A C9's profile: full just below the socket, tapering to a rounded point.
          const radius = (width / 2) * Math.sin(Math.PI * Math.min(1, 0.45 + t * 0.55)) ** 0.7;
          if (across < Math.max(0.35, radius)) {
            glassA += 1;
            axial += 1 - across / Math.max(0.35, radius);
          }
        }
      }
      const n = sub * sub;
      const q = yy * W + xx;
      const keep = 1 - (hide[q] as number);
      if (keep <= 0) continue;
      const o = q * 3;
      if (socketA > 0) {
        const a = (socketA / n) * keep * 0.85;
        for (let c = 0; c < 3; c += 1)
          canvas.rgb[o + c] = (canvas.rgb[o + c] as number) * (1 - a) + 0.012 * a;
      }
      if (glassA > 0) {
        const a = (glassA / n) * keep;
        const hot = axial / glassA;
        for (let c = 0; c < 3; c += 1) {
          // Lit glass: saturated at its edge, near white along the filament's axis.
          const tint = color[c] as number;
          const glass = (tint * (0.62 + 0.25 * hot) + 0.3 * hot * hot) * brightness;
          canvas.rgb[o + c] = (canvas.rgb[o + c] as number) * (1 - a) + glass * a;
        }
        any = true;
      }
    }
  }
  if (!any) return false;
  const mx = x + cx * (socket + length * 0.45);
  const my = y + cy * (socket + length * 0.45);
  addLight(studio, mx, my, width * (evening ? 5 : 3.2), color, evening ? 0.42 : 0.22);
  if (evening) addSpill(studio, mx, my, scene.scale.ref * 0.75, color, 0.07);
  return true;
}

/** A string of lights hung from clips along a support line: a fine wire and glowing bulbs. */
function drawLights(studio: Studio, support: Pt[]): boolean {
  const { canvas, scene } = studio;
  const s = scene.scale;
  const W = canvas.width;
  const path = densify(drape(densify(support, 4), s.ref * 0.4, s.ref * 0.025), 2);
  const blocked = [...scene.glass.map((b) => inset(b, 0.04)), ...scene.keepOut, ...scene.gaps];
  const runs = splitPath(path, blocked, (p) => placeable(studio, p)).filter(
    (run) => pathLength(run) > s.ref * 0.5,
  );
  if (runs.length === 0) return false;
  const hide = hidePlane(studio, true);
  const colors = bulbColors(scene.holiday);
  const spacing = (s.ref * 0.3) / Math.min(1.3, Math.max(0.8, scene.density));
  let drew = false;
  let index = 0;
  for (const run of runs) {
    // The wire: a thin dark line, softly antialiased.
    const wireW = Math.max(0.55, s.ref * 0.006);
    for (const { p } of sampleAlong(run, 0.5)) {
      const [x, y] = p;
      const r = clipRect(
        { x0: x - wireW - 1, y0: y - wireW - 1, x1: x + wireW + 1, y1: y + wireW + 1 },
        W,
        canvas.height,
      );
      for (let yy = r.y0; yy < r.y1; yy += 1) {
        for (let xx = r.x0; xx < r.x1; xx += 1) {
          const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y);
          const a = (1 - smoothstep(wireW * 0.5, wireW + 0.6, d)) * 0.16;
          if (a <= 0) continue;
          const q = yy * W + xx;
          const k = 1 - a * (1 - (hide[q] as number));
          canvas.rgb[q * 3] = (canvas.rgb[q * 3] as number) * k;
          canvas.rgb[q * 3 + 1] = (canvas.rgb[q * 3 + 1] as number) * k;
          canvas.rgb[q * 3 + 2] = (canvas.rgb[q * 3 + 2] as number) * k;
        }
      }
    }
    for (const { p, angle } of sampleAlong(run, spacing)) {
      const [x, y] = p;
      const color = colors[index % colors.length] as [number, number, number];
      index += 1;
      if (drawBulb(studio, hide, x, y, angle, color)) drew = true;
    }
  }
  return drew;
}

/** Deterministic per-pixel noise in [0, 1). */
function hash2(x: number, y: number, seed: number): number {
  let h =
    (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) |
    0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The shaded core of a garland rope: the needles' own mean color, lighter on top and darker
 * underneath, with needle-scale texture and an irregular edge.
 */
function garlandCore(
  run: readonly Pt[],
  radius: number,
  mean: readonly [number, number, number],
  rng: Rng,
): Rendered | null {
  if (run.length < 2 || radius < 0.8) return null;
  const xs = run.map((p) => p[0]);
  const ys = run.map((p) => p[1]);
  const pad = radius * 1.4 + 2;
  const rect: Rect = {
    x0: Math.floor(Math.min(...xs) - pad),
    y0: Math.floor(Math.min(...ys) - pad),
    x1: Math.ceil(Math.max(...xs) + pad),
    y1: Math.ceil(Math.max(...ys) + pad),
  };
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  if (width * height > 4_000_000) return null;
  const seed = Math.floor(rng.next() * 1e6);
  // The radius wanders along the rope like real bunched greenery.
  const wobble = run.map((_, i) => {
    const end = Math.min(i, run.length - 1 - i) / Math.max(1, Math.min(12, run.length / 4));
    const taper = 0.35 + 0.65 * Math.min(1, end);
    return taper * (0.8 + 0.4 * Math.sin(i * 0.37 + seed) * Math.sin(i * 0.11 + seed * 0.5));
  });
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const px0 = rect.x0 + x + 0.5;
      const py0 = rect.y0 + y + 0.5;
      let best = Infinity;
      let bestDy = 0;
      let bestR = radius;
      for (let i = 0; i < run.length; i += 1) {
        const p = run[i] as Pt;
        const dx = px0 - p[0];
        const dy = py0 - p[1];
        if (Math.abs(dx) > pad || Math.abs(dy) > pad) continue;
        const r = radius * (wobble[i] as number);
        const d = Math.hypot(dx, dy) / r;
        if (d < best) {
          best = d;
          bestDy = dy / r;
          bestR = r;
        }
      }
      if (best >= 1.1) continue;
      const grain = hash2(rect.x0 + x, rect.y0 + y, seed);
      const edge = 1 - smoothstep(0.7 + 0.25 * grain, 1.05, best);
      if (edge <= 0) continue;
      // Top-lit and self-shadowed underneath; dark gaps between needles.
      const shade = (0.5 - 0.3 * Math.max(-1, Math.min(1, bestDy))) * (0.35 + 0.8 * grain ** 2);
      const a = edge * (bestR > 0 ? 1 : 0);
      const o = (y * width + x) * 4;
      data[o] = mean[0] * shade * a;
      data[o + 1] = mean[1] * shade * a;
      data[o + 2] = mean[2] * shade * a;
      data[o + 3] = a;
    }
  }
  return { rect, width, height, data, emission: new Float32Array(width * height) };
}

/** A garland built from photographed boughs (or leaves) laid along a drape, with its shadow. */
function drawGarland(studio: Studio, item: Extract<Item, { kind: 'garland' }>): boolean {
  const { canvas, scene } = studio;
  const s = scene.scale;
  // A window swag may hang over the top of the glass; nothing else crosses glass.
  const glass = item.onDoor
    ? []
    : scene.glass.map((b) =>
        item.overGlass ? { ...inset(b, 0.06), y0: b.y0 + (b.y1 - b.y0) * 0.3 } : inset(b, 0.06),
      );
  const blocked = [...glass, ...scene.keepOut, ...(item.onDoor ? [] : scene.gaps)];
  const fullness = item.fullness ?? 1;
  // The rope stops short of the editable edge so its tips can fade out there.
  const margin = s.ref * (item.ring ? 0.04 : 0.2);
  const roomy = (p: Pt) =>
    placeable(studio, p) &&
    placeable(studio, [p[0] - margin, p[1]]) &&
    placeable(studio, [p[0] + margin, p[1]]) &&
    placeable(studio, [p[0], p[1] - margin * 0.6]);
  const runs = splitPath(densify(item.path, 3), blocked, roomy).filter(
    (run) => pathLength(run) > s.ref * 0.35,
  );
  // A wreath is drawn whole or not at all.
  if (item.ring && (runs.length !== 1 || pathLength(runs[0] as Pt[]) < pathLength(item.path) * 0.9))
    return false;
  if (runs.length === 0) return false;
  const pieces: Rendered[] = [];
  const rng = studio.rng;
  const make = (
    p: Pt,
    asset: string,
    meters: number,
    rot: number,
    pivot: [number, number],
    flip: boolean,
    gain: number,
  ) => {
    const sprite = studio.sprites.get(asset);
    if (!sprite) return;
    const axis = sprite.photo.decor.sizeAxis === 'width' ? sprite.width : sprite.height;
    const local = Math.min(1.3, s.at(p[1]) / s.ref);
    const r = renderSprite(sprite, {
      x: p[0] + rng.jitter(s.ref * 0.012),
      y: p[1] + rng.jitter(s.ref * 0.012),
      scale: (meters * s.ref * local) / axis,
      angle: rot,
      flip,
      pivot,
    });
    if (!r) return;
    for (let i = 0; i < r.data.length; i += 4) {
      // Many fine needles at a small scale average to a thin haze; a garland is dense, so the
      // coverage of each piece is filled in (premultiplied color follows the new alpha).
      const a = Math.min(1, r.data[i + 3] as number);
      if (a <= 0.001) continue;
      const dense = 1 - (1 - a) ** 3;
      // Thin needles keep some of the studio backdrop in their color; darken that fringe.
      const k = (dense / a) * gain * (0.55 + 0.45 * smoothstep(0.3, 0.9, a));
      r.data[i] = (r.data[i] as number) * k;
      r.data[i + 1] = (r.data[i + 1] as number) * k;
      r.data[i + 2] = (r.data[i + 2] as number) * k;
      r.data[i + 3] = dense;
    }
    pieces.push(r);
  };
  // A dense core along the rope, so the boughs read as one full garland rather than a haze.
  const coreSprite = studio.sprites.get(item.harvest ? 'decor-bough-yew' : 'decor-bough-pine');
  if (coreSprite) {
    for (const run of runs) {
      const core = garlandCore(
        run,
        s.ref * (item.harvest ? 0.05 : 0.065) * fullness,
        coreSprite.mean,
        rng,
      );
      if (core) pieces.push(core);
    }
  }
  const density = Math.min(1.3, Math.max(0.8, scene.density));
  const leaves = [
    'decor-leaf-maple-orange',
    'decor-leaf-oak-gold',
    'decor-leaf-japanese-maple-red',
    'decor-leaf-japanese-maple-orange',
  ];
  // Two passes: the back of the rope (in its own shade), then the front boughs or leaves.
  for (const pass of [0, 1]) {
    for (const run of runs) {
      const spacing = (s.ref * (pass === 0 ? 0.06 : 0.04)) / density / (item.ring ? 1.4 : 1);
      for (const { p, angle } of sampleAlong(run, spacing)) {
        if (item.harvest) {
          if (pass === 0) {
            make(
              p,
              'decor-bough-yew',
              rng.range(0.24, 0.32) * fullness,
              angle + rng.jitter(0.5) + (rng.next() < 0.5 ? 0 : Math.PI) - Math.PI / 2,
              [0.5, 0.5],
              rng.next() < 0.5,
              0.5,
            );
          } else {
            make(
              p,
              rng.pick(leaves),
              rng.range(0.09, 0.13) * fullness,
              rng.range(0, Math.PI * 2),
              [0.5, 0.5],
              rng.next() < 0.5,
              rng.range(0.7, 0.95),
            );
          }
          continue;
        }
        // Short tufts bound along the rope, tips angled forward and out to both sides like a
        // real tied garland; the back pass sits in the rope's own shade.
        const side = rng.next() < 0.5 ? -1 : 1;
        const tilt = side * rng.range(0.25, 1.05);
        // The yew sprig grows upward from its base at the bottom.
        make(
          p,
          'decor-bough-yew',
          rng.range(0.18, 0.3) * fullness,
          angle + tilt + Math.PI / 2,
          [0.45, 0.97],
          rng.next() < 0.5,
          pass === 0 ? rng.range(0.4, 0.55) : rng.range(0.7, 1),
        );
      }
    }
  }
  if (pieces.length === 0) return false;
  // Merge the pieces into one layer.
  const rect: Rect = {
    x0: Math.min(...pieces.map((p) => p.rect.x0)),
    y0: Math.min(...pieces.map((p) => p.rect.y0)),
    x1: Math.max(...pieces.map((p) => p.rect.x1)),
    y1: Math.max(...pieces.map((p) => p.rect.y1)),
  };
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  if (width * height > 12_000_000) return false;
  // Needle tips may reach past the editable area (they fade out there); the rope may not.
  const data = new Float32Array(width * height * 4);
  for (const piece of pieces) {
    for (let y = 0; y < piece.height; y += 1) {
      for (let x = 0; x < piece.width; x += 1) {
        const l = (y * piece.width + x) * 4;
        const a = piece.data[l + 3] as number;
        if (a <= 0.001) continue;
        const o = ((piece.rect.y0 - rect.y0 + y) * width + (piece.rect.x0 - rect.x0 + x)) * 4;
        for (let c = 0; c < 4; c += 1)
          data[o + c] = (piece.data[l + c] as number) + (data[o + c] as number) * (1 - a);
      }
    }
  }
  const layer: Rendered = { rect, width, height, data, emission: new Float32Array(width * height) };
  if (editableAlphaShare(studio, layer) < (item.ring ? 0.9 : 0.6)) return false;
  const grade = gradeFor(studio, rect, layer, false, 0.6);
  // Seen from the street, a garland's needles merge into a deep green mass; studio-lit sprigs at
  // that scale would average out to a pale haze, so the far garland is graded deeper.
  const distance = item.harvest ? 1 : 0.8 + 0.2 * smoothstep(90, 220, s.ref);
  const level = Math.max(...grade.gain);
  if (item.onDoor && !scene.evening && level < HUNG_MIN_EXPOSURE) {
    grade.gain = grade.gain.map((g) => (g * HUNG_MIN_EXPOSURE) / level) as typeof grade.gain;
  }
  // Fresh greenery is darker and more saturated than its studio cutouts suggest.
  const graded = gradeRendered(
    layer,
    {
      ...grade,
      gain: grade.gain.map((g) => g * 0.85 * distance) as [number, number, number],
      saturation: grade.saturation * (1.15 + 0.25 * (1 - distance)),
    },
    studio.rng,
  );
  // On a rail, leaves count as in front only where a shrub rises from below the rail (its
  // foliage continues under the garland); trees seen through the balusters stay behind it.
  let hide = item.onRail
    ? foliageInFront(studio, rect, Math.max(...runs.flat().map((p) => p[1])) + s.ref * 0.12)
    : studio.keepOutPlane;
  if (studio.outside) {
    const outside = studio.outside;
    hide = hide.map((v, i) => Math.max(v, outside[i] as number));
  }
  // Shadow on the wall or rail just below.
  const a = new Float32Array(width * height);
  for (let p = 0; p < a.length; p += 1) a[p] = graded.data[p * 4 + 3] as number;
  const soft = blurFloat(a, width, height, 1, Math.max(1, s.ref * 0.025));
  const off = Math.round(s.ref * 0.03);
  multiplyShadow(
    canvas,
    { x0: rect.x0, y0: rect.y0 + off, x1: rect.x1, y1: rect.y1 + off },
    width,
    soft,
    scene.evening ? 0.25 : 0.38,
    hide,
  );
  compositeOver(canvas, graded, hide);
  if (item.lit) {
    // Fine warm lights tucked into the greenery.
    for (const run of runs) {
      for (const { p } of sampleAlong(run, s.ref * 0.11)) {
        const x = p[0] + rng.jitter(s.ref * 0.05);
        const y = p[1] + rng.range(-0.02, 0.08) * s.ref;
        const q = Math.round(y) * canvas.width + Math.round(x);
        if ((hide[q] ?? 1) > 0.5) continue;
        const r = Math.max(0.7, s.ref * 0.006);
        const o = q * 3;
        if (o < 0 || o >= canvas.rgb.length) continue;
        const k = scene.evening ? 2.2 : 0.9;
        canvas.rgb[o] = Math.max(canvas.rgb[o] as number, 1 * k);
        canvas.rgb[o + 1] = Math.max(canvas.rgb[o + 1] as number, 0.8 * k);
        canvas.rgb[o + 2] = Math.max(canvas.rgb[o + 2] as number, 0.5 * k);
        addLight(
          studio,
          x,
          y,
          r * (scene.evening ? 8 : 3.5),
          [1, 0.75, 0.42],
          scene.evening ? 0.45 : 0.1,
        );
      }
    }
  }
  return true;
}

/**
 * The treatment for an image whose geometry is unknown: no objects (nothing may float), only a
 * string of warm fairy lights close to the lens and far out of focus, as if the photo were
 * taken through it: overlapping discs of light along a gentle arc in an upper corner of the
 * frame, kept inside the area the plan lets the image change.
 */
function drawBokeh(studio: Studio, regions: PxBox[]): boolean {
  const { canvas, scene } = studio;
  const W = canvas.width;
  const H = canvas.height;
  const unit = Math.max(W, H);
  const rng = studio.rng;
  // The largest planned area in the upper half of the frame holds the string.
  const upper = regions
    .map((r) => ({ ...r, y1: Math.min(r.y1, H * 0.6) }))
    .filter((r) => r.y0 < H * 0.45 && r.x1 - r.x0 > W * 0.08 && r.y1 - r.y0 > H * 0.06)
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  const region = upper[0];
  if (!region) return false;
  const colors: [number, number, number][] = [
    [1, 0.7, 0.36],
    [1, 0.78, 0.5],
    [1, 0.62, 0.28],
  ];
  const strength = scene.evening ? 0.3 : 0.16;
  // The string sags across the region from one top corner toward the other.
  const fromLeft = (region.x0 + region.x1) / 2 < W / 2;
  const count = Math.round(10 + 6 * Math.min(1.3, scene.density));
  let drew = false;
  for (let i = 0; i < count; i += 1) {
    const t = (i + rng.range(-0.3, 0.3)) / Math.max(1, count - 1);
    const radius = unit * rng.range(0.01, 0.024) * (rng.next() < 0.15 ? 1.5 : 1);
    const margin = radius * 1.05;
    const spanX = region.x1 - region.x0 - margin * 2;
    const spanY = region.y1 - region.y0 - margin * 2;
    if (spanX <= 0 || spanY <= 0) continue;
    const u = fromLeft ? t : 1 - t;
    const x = region.x0 + margin + spanX * u;
    const y =
      region.y0 +
      margin +
      spanY * (0.2 + 0.55 * Math.sin(t * Math.PI) * 0.7 + rng.range(-0.08, 0.08));
    if (scene.keepOut.some((b) => inside(b, [x, y]))) continue;
    const color = rng.pick(colors);
    const level = strength * rng.range(0.55, 1.1) * (radius > unit * 0.026 ? 0.6 : 1);
    const r = clipRect(
      { x0: x - radius - 2, y0: y - radius - 2, x1: x + radius + 2, y1: y + radius + 2 },
      W,
      H,
    );
    for (let yy = r.y0; yy < r.y1; yy += 1) {
      for (let xx = r.x0; xx < r.x1; xx += 1) {
        const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y) / radius;
        // A defocused point light: a flat disc, a slightly brighter rim and a soft edge.
        const disc = (1 - smoothstep(0.9, 1.02, d)) * (0.82 + 0.3 * smoothstep(0.6, 0.95, d));
        if (disc <= 0) continue;
        const q = yy * W + xx;
        const keep = studio.outside ? 1 - (studio.outside[q] as number) : 1;
        const k = disc * level * keep * (1 - (studio.keepOutPlane[q] as number));
        if (k <= 0) continue;
        for (let c = 0; c < 3; c += 1) {
          canvas.rgb[q * 3 + c] = (canvas.rgb[q * 3 + c] as number) + (color[c] as number) * k;
        }
      }
    }
    // The light also blooms a little into the image around it.
    addLight(studio, x, y, radius * 1.6, color, level * 0.15);
    drew = true;
  }
  return drew;
}

// ---- main ---------------------------------------------------------------------------------------

function keepOutPlaneOf(boxes: readonly PxBox[], width: number, height: number): Float32Array {
  const plane = new Float32Array(width * height);
  for (const b of boxes) {
    const r = clipRect(b, width, height);
    for (let y = r.y0; y < r.y1; y += 1) plane.fill(1, y * width + r.x0, y * width + r.x1);
  }
  if (boxes.length === 0) return plane;
  // A slightly soft edge, so needles meeting a protected object fade rather than stop dead;
  // the box itself stays fully protected.
  const soft = blurFloat(plane, width, height, 1, 1.2);
  for (let p = 0; p < plane.length; p += 1)
    plane[p] = Math.max(plane[p] as number, soft[p] as number);
  return plane;
}

/**
 * Pixels the render pipeline keeps from the decorated image in `source` lighting: the placement
 * regions plus the part of its dilation band where its feathered mask still keeps every pixel.
 * The pipeline leaves steps, walkways and doors out of that band (only a placement region itself
 * may cover them), so the band stops at them here too.
 */
export function editableMask(
  placements: readonly FixturePlacement[],
  width: number,
  height: number,
  openings: readonly NormalizedBox[] = [],
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const dilation = Math.max(width, height) * 0.018;
  for (const p of placements) {
    const r = clipRect(
      {
        x0: p.region[0] * width - dilation,
        y0: p.region[1] * height - dilation,
        x1: p.region[2] * width + dilation,
        y1: p.region[3] * height + dilation,
      },
      width,
      height,
    );
    for (let y = r.y0; y < r.y1; y += 1) mask.fill(1, y * width + r.x0, y * width + r.x1);
  }
  if (openings.length === 0) return mask;
  const inRegion = new Uint8Array(width * height);
  for (const p of placements) {
    const r = clipRect(px(p.region, width, height), width, height);
    for (let y = r.y0; y < r.y1; y += 1) inRegion.fill(1, y * width + r.x0, y * width + r.x1);
  }
  for (const box of openings) {
    const r = clipRect(px(box, width, height), width, height);
    for (let y = r.y0; y < r.y1; y += 1) {
      for (let x = r.x0; x < r.x1; x += 1) {
        const i = y * width + x;
        if (!inRegion[i]) mask[i] = 0;
      }
    }
  }
  return mask;
}

/** The complement of the editable area, feathered over a few pixels inside its edge. */
function softOutside(editable: Uint8Array, width: number, height: number): Float32Array {
  const plane = new Float32Array(width * height);
  for (let p = 0; p < plane.length; p += 1) plane[p] = editable[p] ? 0 : 1;
  const soft = blurFloat(plane, width, height, 1, Math.max(2, Math.max(width, height) * 0.006));
  for (let p = 0; p < soft.length; p += 1) {
    soft[p] = editable[p] ? Math.min(1, (soft[p] as number) * 2) : 1;
  }
  return soft;
}

const ALL_ASSETS = [
  'decor-wreath-evergreen',
  'decor-wreath-fir-holly',
  'decor-bow-red',
  'decor-spruce-potted',
  'decor-wreath-autumn',
  'decor-bough-pine',
  'decor-bough-yew',
  'decor-leaf-maple-orange',
  'decor-leaf-oak-gold',
  'decor-leaf-japanese-maple-red',
  'decor-leaf-japanese-maple-orange',
  'decor-pumpkin-orange',
  'decor-pumpkin-small',
  'decor-pumpkins-white',
  'decor-pumpkins-harvest',
  'decor-gourds-group',
  'decor-jack-o-lantern',
  'decor-lantern-white',
  'decor-lantern-white-unlit',
  'decor-mums-yellow',
  'decor-candle-centerpiece',
  'decor-stocking',
];

async function loadSprites(): Promise<Map<string, Sprite>> {
  const sprites = new Map<string, Sprite>();
  for (const id of ALL_ASSETS) {
    const sprite = await loadSprite(id);
    sprites.set(id, sprite);
    const spec = sprite.photo.decor;
    ASPECTS.set(id, {
      aspect: sprite.width / sprite.height,
      axis: spec.sizeAxis,
      meters: spec.sizeMeters,
    });
  }
  return sprites;
}

/** Pixels per meter at the decorated surface, from the door when one is known. */
function referenceScale(
  input: DecorateInput,
  width: number,
  height: number,
): { ref: number; baseY: number } {
  const doorBox =
    input.referenceDoor ??
    input.placements.find(
      (p) => p.anchorCategory === 'front_door' || p.anchorCategory === 'unit_door',
    )?.region ??
    null;
  if (doorBox && (doorBox[3] - doorBox[1]) * height > 4) {
    return {
      ref: ((doorBox[3] - doorBox[1]) * height) / DOOR_HEIGHT_M,
      baseY: doorBox[3] * height,
    };
  }
  const fallback = input.sceneType === 'house_exterior' ? width / 16 : width / 5;
  return { ref: fallback, baseY: height * 0.85 };
}

/**
 * Deterministic fixture image editor. Decorations are real photographs cut out of their
 * backgrounds, placed at real-world scale on known geometry (exact frame anchors, or the measured
 * anchors of a recognized library photo), graded to the scene's light, white balance, sharpness
 * and grain, with contact or drop shadows and foliage in front kept in front. Light strings are
 * drawn as light sources along eaves, rooflines, fascia and rails, never across glass. Images
 * without known geometry get no objects, only an out-of-focus fairy-light foreground. `evening`
 * relights the photo for dusk. Preserved regions and the attribution strip are never changed.
 * Same input, same bytes.
 */
export async function decorateImage(input: DecorateInput): Promise<DecorateResult> {
  const meta = await sharp(input.image).metadata();
  const width = input.width ?? meta.width ?? 1024;
  const height = input.height ?? meta.height ?? 1024;
  const source = await sharp(input.image)
    .rotate()
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer();
  const evening = input.lightingMode === 'evening';
  const sprites = await loadSprites();
  const rng = new Rng(`${input.seed}:${input.holidayId}:${input.style}:${input.lightingMode}`);

  // Geometry: the measured anchors of a recognized library photo (a fixture Street View frame
  // cropped from it, or the photo uploaded), else exact frame anchors, else nothing known.
  const anchored = input.anchoredGeometry ?? Boolean(input.attributionRegion);
  const recognized =
    anchored && input.referenceDoor
      ? await recognizeFrameByDoor(input.image, input.referenceDoor)
      : anchored
        ? null
        : await recognizeLibraryPhoto(input.image);
  const library: LibraryAnchors | null = recognized
    ? anchorsInCrop(recognized.anchors, recognized.crop)
    : null;
  const geometry: DecorationGeometry = library ? 'library' : anchored ? 'anchored' : 'unplaced';
  // Windows and fixtures glow in the evening only where they are known to be: a generic layout
  // guessed for an unknown photo would light up rectangles of plain wall.
  const known: DecorateInput = {
    ...input,
    windows: library ? library.windows : anchored ? (input.windows ?? []) : [],
    lightSources: geometry === 'unplaced' ? [] : (input.lightSources ?? []),
  };
  const canvas: Canvas = {
    width,
    height,
    rgb: evening
      ? eveningGradeLinear(source, width, height, {
          interior: known.sceneType === 'interior',
          targetFacade: known.targetFacade ?? null,
          windows: known.windows ?? [],
          seed: known.seed,
          unknownScene: geometry === 'unplaced',
        })
      : toLinearPixels(source),
  };
  let scale: ScaleModel;
  if (library) {
    const b = px(library.scale.box, width, height);
    const extent = library.scale.axis === 'height' ? b.y1 - b.y0 : b.x1 - b.x0;
    scale = scaleModel(extent / library.scale.meters, b.y1, library.eyeHeight);
  } else {
    const { ref, baseY } = referenceScale(input, width, height);
    scale = scaleModel(Math.min(width / 1.5, Math.max(width / 70, ref)), baseY, 1.6);
  }
  const preserve = (input.preserveRegions ?? []).map((b) => px(b, width, height));
  const door = input.referenceDoor ? [px(input.referenceDoor, width, height)] : [];
  const scene: Scene = {
    width,
    height,
    holiday: input.holidayId,
    evening,
    density: input.style === 'abundant' ? 1.25 : input.style === 'subtle' ? 0.8 : 1,
    scale,
    rng,
    glass: [
      ...(input.windows ?? []).map((b) => px(b, width, height)),
      ...door,
      ...(library
        ? [...library.windows, ...library.doorGlass].map((b) => px(b, width, height))
        : []),
    ],
    keepOut: [...preserve, ...(library ? library.keepClear.map((b) => px(b, width, height)) : [])],
    gaps: (input.accessRegions ?? []).map((b) => px(b, width, height)),
    spotGroups: new Map(),
    editable: null,
  };
  const editable = evening
    ? null
    : editableMask(input.placements, width, height, [
        ...(input.accessRegions ?? []),
        ...(input.referenceDoor ? [input.referenceDoor] : []),
      ]);
  scene.editable = editable;
  const studio: Studio = {
    canvas,
    glow: new Float32Array(width * height * 3),
    spill: new Float32Array(width * height * 3),
    albedo: evening ? toLinearPixels(source) : canvas.rgb,
    scene,
    illum: illuminant(canvas),
    texture: photoTexture(canvas),
    foliage: foliageMatte(source, width, height),
    keepOutPlane: keepOutPlaneOf(preserve, width, height),
    editable,
    outside: editable ? softOutside(editable, width, height) : null,
    sprites,
    rng: new Rng(hashSeed(`${input.seed}:grain`)),
  };

  const drawn: Record<string, string | null> = {};
  if (geometry === 'unplaced') {
    const regions = input.placements.map((p) => px(p.region, width, height));
    drawBokeh(studio, regions);
    for (const placement of input.placements) drawn[placement.id] = null;
  } else {
    const planned: { id: string; archetype: DecorArchetype; item: Item }[] = [];
    const used = new Set<string>();
    for (const placement of input.placements) {
      const archetype = archetypeFor(
        placement.kitItemId,
        placement.specText ?? '',
        placement.archetype,
      );
      drawn[placement.id] = null;
      if (!archetype) continue;
      const items = library
        ? itemsFromLibrary(scene, placement, archetype, library, used)
        : itemsFromRegions(scene, placement, archetype);
      for (const item of items) planned.push({ id: placement.id, archetype, item });
    }
    // Back to front: lights on the facade, hung items, rail garlands, then standing items from
    // the farthest (highest in the frame) to the nearest.
    const depth = (item: Item) =>
      item.kind === 'sprite' && item.layer === 3 ? 3 + item.y / height : item.layer;
    planned.sort((a, b) => depth(a.item) - depth(b.item));
    for (const { id, archetype, item } of planned) {
      const ok =
        item.kind === 'lights'
          ? drawLights(studio, item.support)
          : item.kind === 'garland'
            ? drawGarland(studio, item)
            : drawSprite(studio, item);
      if (ok) drawn[id] = archetype;
    }
    // Known geometry with nothing that could be placed convincingly still gets the light
    // treatment rather than coming back unchanged.
    if (Object.values(drawn).every((archetype) => archetype === null)) {
      drawBokeh(
        studio,
        input.placements.map((p) => px(p.region, width, height)),
      );
    }
  }

  // Light spill from existing windows and fixtures in the evening.
  if (evening) {
    const lights = eveningWindowLights(input.seed, known.windows?.length ?? 0);
    if (input.sceneType !== 'interior') {
      for (const [index, [x0, y0, x1, y1]] of (known.windows ?? []).entries()) {
        if (!lights[index]?.lit) continue;
        addLight(
          studio,
          ((x0 + x1) / 2) * width,
          ((y0 + y1) / 2) * height,
          Math.max(x1 - x0, y1 - y0) * width * 0.8,
          [1, 0.6, 0.3],
          0.035,
        );
      }
    }
    for (const [x0, y0, x1, y1] of known.lightSources ?? []) {
      const r = Math.max((x1 - x0) * width, (y1 - y0) * height);
      addLight(
        studio,
        ((x0 + x1) / 2) * width,
        ((y0 + y1) / 2) * height,
        r * 2.4,
        [1, 0.72, 0.4],
        0.6,
      );
    }
  }

  const count = width * height;
  for (let i = 0; i < count * 3; i += 1) {
    const k = studio.spill[i] as number;
    if (k > 0) canvas.rgb[i] = (canvas.rgb[i] as number) + (studio.albedo[i] as number) * k;
  }
  // Light adds in linear space: the glow itself plus a wide bloom.
  const glowSum = studio.glow.reduce((s, v) => s + v, 0);
  if (glowSum > 0) {
    const bloom = blurFloat(
      studio.glow,
      width,
      height,
      3,
      Math.max(2, width * (evening ? 0.01 : 0.005)),
    );
    const tight = evening ? 0.9 : 0.5;
    const wide = evening ? 1.1 : 0.3;
    for (let i = 0; i < count * 3; i += 1) {
      canvas.rgb[i] =
        (canvas.rgb[i] as number) +
        (studio.glow[i] as number) * tight +
        (bloom[i] as number) * wide;
    }
  }

  // Back to sRGB. Untouched pixels keep their exact values (the pipeline pastes the decorated
  // regions back into the original, so any global tone change would show as a seam); light
  // brighter than white clips, as it does in a photograph.
  const outRgb = Buffer.alloc(count * 3);
  for (let i = 0; i < count * 3; i += 1) outRgb[i] = Math.round(toSrgb(canvas.rgb[i] as number));
  if (input.attributionRegion) {
    const [x0, y0, x1, y1] = input.attributionRegion;
    const left = Math.max(0, Math.round(x0 * width));
    const top = Math.max(0, Math.round(y0 * height));
    const right = Math.min(width, left + Math.round((x1 - x0) * width));
    const bottom = Math.min(height, top + Math.round((y1 - y0) * height));
    for (let y = top; y < bottom; y += 1) {
      source.copy(outRgb, (y * width + left) * 3, (y * width + left) * 3, (y * width + right) * 3);
    }
  }
  const format = input.format ?? 'jpeg';
  const output = sharp(outRgb, { raw: { width, height, channels: 3 } });
  const image =
    format === 'png'
      ? await output.png().toBuffer()
      : format === 'webp'
        ? await output.webp({ quality: input.quality ?? 90 }).toBuffer()
        : await output
            .jpeg({ quality: input.quality ?? 90, chromaSubsampling: '4:4:4' })
            .toBuffer();
  return { image, width, height, format, drawn, geometry };
}
