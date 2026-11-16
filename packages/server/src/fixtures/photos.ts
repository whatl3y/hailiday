import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { z } from 'zod';
import type {
  Anchor,
  AnchorCategory,
  BuildingForm,
  NormalizedBox,
  PreserveRegion,
} from '@hailiday/core';
import { DEFAULT_CONTENT_DIR } from '../content/load.js';
import { CONTRIBUTOR_STAND_IN_SUFFIX, FIXTURE_PHOTO_COPYRIGHT_PREFIX } from './copyright.js';
import { signedAngleDelta } from '../providers/geo.js';
import type { FixtureSceneGeometry } from './scene.js';
import { NO_QUALITY_FLAGS } from './scene.js';
import { escapeXml } from './svg.js';

/** The licensed real-photograph library (`content/photos`). */
export const PHOTO_LIBRARY_DIR = path.join(DEFAULT_CONTENT_DIR, 'photos');

const Box = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const Point = z.tuple([z.number(), z.number()]);
/** A polyline in normalized photo coordinates (at least two points). */
const Line = z.array(Point).min(2);
/** The surface a standing spot lies on: its ends (normalized x) and whether it is open ground. */
const StandSurfaceSchema = z.object({
  from: z.number(),
  to: z.number(),
  open: z.boolean().default(false),
});
export type StandSurface = z.infer<typeof StandSurfaceSchema>;

const HouseAnchorsSchema = z.object({
  houseFacade: Box,
  roofline: Box.nullable(),
  eaves: Box.nullable(),
  frontDoor: Box.nullable(),
  doorFrame: Box.nullable(),
  windows: z.array(Box).default([]),
  porchRail: Box.nullable(),
  porchSteps: Box.nullable(),
  columns: z.array(Box).default([]),
  walkwayEdge: Box.nullable(),
  planters: z.array(Box).default([]),
  garageDoor: Box.nullable(),
  existingDecor: z.array(Box).default([]),
  parkedCar: Box.nullable(),
  neighborFacades: z.array(Box).default([]),
  /** Further horizontal light lines (porch fascia, lower roof edges), reported as eaves. */
  fascia: z.array(Box).default([]),
  /**
   * Measured light lines: the lower edges of eaves, gutters, rooflines and porch fascia that a
   * string of lights can be clipped to (polylines, sloped where the photo shows them sloped).
   * When present they replace `roofline`, `eaves` and `fascia` for placement.
   */
  lightLines: z.array(Line).default([]),
  /**
   * The top rails of porch railings, one polyline per run between posts, stairs and the door.
   * When present they replace `porchRail` for placement.
   */
  railLines: z.array(Line).default([]),
  /**
   * Points on hard, unobstructed ground or porch floor near the entrance where standing
   * decorations rest (step ends, porch floor beside the door). When present they are the only
   * places standing items go.
   */
  standSpots: z.array(Point).default([]),
  /**
   * For each standing spot (same order), the surface it lies on (a step tread, a wall cap, the
   * porch floor beside the door, the lawn beside the walk): its left and right ends as
   * normalized x, between which standing objects stay, and `open` when nothing stands between
   * it and the camera (leaves behind an object on a lawn never hide it). A spot without one may
   * use about 1.4 m around it.
   */
  standSurfaces: z.array(StandSurfaceSchema).default([]),
});
export type HouseAnchors = z.infer<typeof HouseAnchorsSchema>;

/**
 * Placement geometry of a library photo for the fixture compositor: lines that decorations
 * follow and points where they rest or hang, all measured on the photo. Lights only ever run
 * along `eaves` and `rails`; nothing is drawn over `windows`, `doorGlass` or `keepClear`.
 */
const LibraryAnchorsSchema = z.object({
  /** A feature of known real size that sets the scene scale (pixels per meter). */
  scale: z.object({ box: Box, meters: z.number().positive(), axis: z.enum(['height', 'width']) }),
  /** Camera height above the floor or ground the scale feature stands on, in meters. */
  eyeHeight: z.number().positive().default(1.4),
  doors: z.array(Box).default([]),
  doorFrames: z.array(Box).default([]),
  doorGlass: z.array(Box).default([]),
  windows: z.array(Box).default([]),
  /** Top casings or curtain rods of windows, for a draped garland. */
  windowTops: z.array(Line).default([]),
  /** The front top edge of a mantel shelf. */
  mantel: Line.nullable().default(null),
  /** Top rails of porch, stair and balcony railings (ends are real posts). */
  rails: z.array(Line).default([]),
  /** Eave, roofline and porch fascia lines for string lights. */
  eaves: z.array(Line).default([]),
  /** Porch posts and columns a garland can be wound around (their visible shafts). */
  posts: z.array(Box).default([]),
  /** Where a centerpiece rests on a table (base point). */
  tableSpots: z.array(Point).default([]),
  /** Counter, shelf and hearth spots for small items (base points). */
  surfaceSpots: z.array(Point).default([]),
  /** Floor, step and ground spots for standing items (base points). */
  standSpots: z.array(Point).default([]),
  /** The surface under each standing spot (same order as `standSpots`). */
  standSurfaces: z.array(StandSurfaceSchema).default([]),
  /** Existing objects and areas no decoration may cover. */
  keepClear: z.array(Box).default([]),
});
export type LibraryAnchors = z.infer<typeof LibraryAnchorsSchema>;

const PhotoBaseSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  width: z.int().positive(),
  height: z.int().positive(),
  title: z.string().default(''),
  description: z.string().default(''),
  photographer: z.string().min(1),
  sourceUrl: z.url(),
  license: z.string().min(1),
  licenseUrl: z.url(),
  tags: z.array(z.string()).default([]),
});

const HeroPhotoSchema = PhotoBaseSchema.extend({
  kind: z.literal('hero'),
  slot: z.string().min(1),
  focalPoint: Point,
  safeArea: Box,
  landscapeFocal: Point,
  portraitFocal: Point,
});
export type HeroPhoto = z.infer<typeof HeroPhotoSchema>;

const HousePhotoSchema = PhotoBaseSchema.extend({
  kind: z.literal('house'),
  style: z.string(),
  buildingForm: z.enum(['detached', 'attached', 'multi_unit']),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']),
  unobstructed: z.boolean(),
  existingDecor: z.enum(['none', 'halloween', 'christmas']),
  anchors: HouseAnchorsSchema,
});
export type HousePhoto = z.infer<typeof HousePhotoSchema>;

const SamplePhotoSchema = PhotoBaseSchema.extend({
  kind: z.literal('sample'),
  scene: z.string(),
  anchors: LibraryAnchorsSchema.optional(),
});
export type SamplePhoto = z.infer<typeof SamplePhotoSchema>;

/** A photographed decoration cut out of its background (RGBA, straight alpha). */
const DecorPhotoSchema = PhotoBaseSchema.extend({
  kind: z.literal('decor'),
  decor: z.object({
    /** Real-world size of the object along `sizeAxis`, in meters. */
    sizeMeters: z.number().positive(),
    sizeAxis: z.enum(['height', 'width']),
    /** `base`: rests on a surface at `attachPoint`; `hang`: hangs from `attachPoint`. */
    attach: z.enum(['base', 'hang']),
    /** The resting base or hanging point, normalized within the cutout. */
    attachPoint: Point,
    /** True when the object is a light source (flame, lit carving). */
    emitsLight: z.boolean(),
    /** Center of the emitted light, normalized within the cutout. */
    lightPoint: Point.optional(),
  }),
});
export type DecorPhoto = z.infer<typeof DecorPhotoSchema>;

const PhotoSchema = z.discriminatedUnion('kind', [
  HeroPhotoSchema,
  HousePhotoSchema,
  SamplePhotoSchema,
  DecorPhotoSchema,
]);
export type LibraryPhoto = z.infer<typeof PhotoSchema>;

const ManifestSchema = z.object({ retrievedAt: z.string(), photos: z.array(PhotoSchema) });

export interface PhotoLibrary {
  dir: string;
  photos: LibraryPhoto[];
  photo(id: string): LibraryPhoto | undefined;
  house(id: string): HousePhoto | undefined;
  hero(slot: string): HeroPhoto | undefined;
  /** A decoration cutout by ID (`decor-<name>`). */
  decor(id: string): DecorPhoto | undefined;
  /** Absolute path of a photo's master file. */
  pathOf(photo: Pick<LibraryPhoto, 'file'>): string;
}

let cachedLibrary: PhotoLibrary | null = null;

/** Loads and validates `content/photos/manifest.json` (cached for the default directory). */
export function loadPhotoLibrary(dir: string = PHOTO_LIBRARY_DIR): PhotoLibrary {
  if (cachedLibrary && dir === PHOTO_LIBRARY_DIR) return cachedLibrary;
  const manifest = ManifestSchema.parse(
    JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
  );
  const byId = new Map(manifest.photos.map((photo) => [photo.id, photo]));
  const library: PhotoLibrary = {
    dir,
    photos: manifest.photos,
    photo: (id) => byId.get(id),
    house: (id) => {
      const photo = byId.get(id);
      return photo?.kind === 'house' ? photo : undefined;
    },
    decor: (id) => {
      const photo = byId.get(id);
      return photo?.kind === 'decor' ? photo : undefined;
    },
    hero: (slot) =>
      manifest.photos.find(
        (photo): photo is HeroPhoto => photo.kind === 'hero' && photo.slot === slot,
      ),
    pathOf: (photo) => path.join(dir, photo.file),
  };
  if (dir === PHOTO_LIBRARY_DIR) cachedLibrary = library;
  return library;
}

/** Credit line of a library photo: photographer and license. */
export function photoCredit(photo: Pick<LibraryPhoto, 'photographer' | 'license'>): string {
  return `${photo.photographer} / ${photo.license}`;
}

/** The metadata copyright of a fixture panorama photographed by `photo`. */
export function fixturePhotoCopyright(
  photo: Pick<LibraryPhoto, 'photographer' | 'license'>,
  options: { contributor?: boolean } = {},
): string {
  const base = `${FIXTURE_PHOTO_COPYRIGHT_PREFIX} ${photoCredit(photo)}`;
  return options.contributor ? `${base} ${CONTRIBUTOR_STAND_IN_SUFFIX}` : base;
}

// ---- view → crop ---------------------------------------------------------------------------------

/** A crop rectangle in photo pixels (integers). */
export interface CropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewAngles {
  heading: number;
  fov: number;
  pitch: number;
}

export interface PanoramaCropInput {
  photo: { width: number; height: number };
  /** The target facade in photo coordinates (normalized). */
  facade: NormalizedBox;
  /** The view that frames the facade: the panorama's discovered heading, fov and pitch. */
  reference: ViewAngles;
  /** The requested view. */
  view: ViewAngles;
  /** Output aspect ratio (width / height). */
  aspect?: number;
  /** Scales the reference framing (greater than 1 shows more around the house). */
  framing?: number;
  /** Horizontal and vertical offset of the reference framing, as fractions of its size. */
  shiftX?: number;
  shiftY?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Pans and zooms within a photograph as if it were a panorama: the reference view frames the
 * facade; a heading offset shifts the crop horizontally, a pitch offset vertically (looking up
 * moves it up), and the field of view sets its size at a fixed number of photo pixels per degree.
 * The crop never leaves the photo (it slides back inside, and shrinks to fit). Deterministic.
 */
export function panoramaCrop(input: PanoramaCropInput): CropRect {
  const { width: W, height: H } = input.photo;
  const aspect = input.aspect ?? 1;
  const [fx0, fy0, fx1, fy1] = input.facade;
  const facadeW = (fx1 - fx0) * W;
  const facadeH = (fy1 - fy0) * H;
  // Largest crop height that fits the photo at this aspect ratio.
  const maxHeight = Math.min(H, W / aspect);
  const referenceHeight = clamp(
    Math.max(facadeW * 1.18, facadeH * 1.3 * aspect) * (input.framing ?? 1),
    maxHeight * 0.25,
    maxHeight,
  );
  const pxPerDegree = referenceHeight / Math.max(1, input.reference.fov);
  const height = clamp(pxPerDegree * input.view.fov, maxHeight * 0.1, maxHeight);
  const width = height * aspect;
  const cx =
    ((fx0 + fx1) / 2) * W +
    (input.shiftX ?? 0) * referenceHeight +
    signedAngleDelta(input.reference.heading, input.view.heading) * pxPerDegree;
  const cy =
    ((fy0 + fy1) / 2) * H +
    (input.shiftY ?? 0) * referenceHeight -
    (input.view.pitch - input.reference.pitch) * pxPerDegree;
  const w = Math.max(1, Math.min(W, Math.round(width)));
  const h = Math.max(1, Math.min(H, Math.round(height)));
  return {
    left: Math.round(clamp(cx - w / 2, 0, W - w)),
    top: Math.round(clamp(cy - h / 2, 0, H - h)),
    width: w,
    height: h,
  };
}

const r4 = (value: number) => Math.round(value * 10000) / 10000;

/**
 * Transforms a box from photo coordinates (normalized) into the crop's normalized coordinates,
 * clipped to the crop. Returns null when less than `minVisible` of the box lies inside the crop.
 */
export function transformBox(
  box: NormalizedBox,
  crop: CropRect,
  photo: { width: number; height: number },
  minVisible = 0.5,
): NormalizedBox | null {
  const x0 = box[0] * photo.width;
  const y0 = box[1] * photo.height;
  const x1 = box[2] * photo.width;
  const y1 = box[3] * photo.height;
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (area <= 0) return null;
  const cx0 = Math.max(x0, crop.left);
  const cy0 = Math.max(y0, crop.top);
  const cx1 = Math.min(x1, crop.left + crop.width);
  const cy1 = Math.min(y1, crop.top + crop.height);
  const visible = (Math.max(0, cx1 - cx0) * Math.max(0, cy1 - cy0)) / area;
  if (visible < minVisible) return null;
  const nx0 = r4((cx0 - crop.left) / crop.width);
  const ny0 = r4((cy0 - crop.top) / crop.height);
  const nx1 = r4((cx1 - crop.left) / crop.width);
  const ny1 = r4((cy1 - crop.top) / crop.height);
  if (!(nx0 < nx1 && ny0 < ny1)) return null;
  return [nx0, ny0, nx1, ny1];
}

/** Share of `box` (normalized photo coordinates) inside the crop. */
function visibleShare(
  box: NormalizedBox,
  crop: CropRect,
  photo: { width: number; height: number },
): number {
  const x0 = box[0] * photo.width;
  const y0 = box[1] * photo.height;
  const x1 = box[2] * photo.width;
  const y1 = box[3] * photo.height;
  const area = Math.max(1e-9, (x1 - x0) * (y1 - y0));
  const w = Math.max(0, Math.min(x1, crop.left + crop.width) - Math.max(x0, crop.left));
  const h = Math.max(0, Math.min(y1, crop.top + crop.height) - Math.max(y0, crop.top));
  return (w * h) / area;
}

function overlapShare(box: NormalizedBox, other: NormalizedBox): number {
  const area = Math.max(1e-9, (box[2] - box[0]) * (box[3] - box[1]));
  const w = Math.max(0, Math.min(box[2], other[2]) - Math.max(box[0], other[0]));
  const h = Math.max(0, Math.min(box[3], other[3]) - Math.max(box[1], other[1]));
  return (w * h) / area;
}

// ---- geometry ------------------------------------------------------------------------------------

/** The burned-in credit of a fixture frame: text and its box in output pixels. */
export interface CreditStrip {
  text: string;
  fontSize: number;
  x: number;
  y: number;
  box: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Where the photographer credit is burned into a frame: a small opaque label in the bottom right
 * (Street View style). The label is opaque so it reads the same in every lighting mode when the
 * pipeline restores it verbatim.
 */
export function creditStrip(text: string, width: number, height: number): CreditStrip {
  const fontSize = Math.max(8, Math.round(Math.min(width, height) * 0.018));
  const textWidth = text.length * fontSize * 0.55;
  const pad = fontSize * 0.45;
  const x = Math.max(pad * 2, width - textWidth - pad * 2);
  const y = height - pad * 1.6;
  return {
    text,
    fontSize,
    x,
    y,
    box: {
      x0: Math.max(0, Math.floor(x - pad)),
      y0: Math.max(0, Math.floor(y - fontSize - pad * 0.4)),
      x1: Math.min(width, Math.ceil(x + textWidth + pad)),
      y1: Math.min(height, Math.ceil(y + pad * 0.9)),
    },
  };
}

export interface PhotoFrameInput {
  photo: HousePhoto;
  crop: CropRect;
  width: number;
  height: number;
  /** Burned-in credit line (null for none). */
  credit: string | null;
  /** The owner asked for the house to be blurred: the facade is blurred in the frame. */
  blurredHouse?: boolean;
}

/**
 * True when the roofline box's lower edge runs along the eaves box (the same edge measured
 * twice), so only one string of lights belongs there.
 */
function rooflineIsEave(a: HouseAnchors): boolean {
  if (!a.roofline || !a.eaves) return false;
  const roofEdge = a.roofline[3];
  const eaveLine = a.eaves[1] + (a.eaves[3] - a.eaves[1]) * 0.6;
  const overlap = Math.min(a.roofline[2], a.eaves[2]) - Math.max(a.roofline[0], a.eaves[0]);
  const width = Math.min(a.roofline[2] - a.roofline[0], a.eaves[2] - a.eaves[0]);
  return Math.abs(roofEdge - eaveLine) < 0.035 && overlap > width * 0.6;
}

/** The box around a polyline, padded (more below than above when `below` is given). */
function lineBox(
  line: readonly (readonly [number, number])[],
  padX: number,
  padY: number,
  below = padY,
): NormalizedBox {
  const xs = line.map((p) => p[0]);
  const ys = line.map((p) => p[1]);
  return [
    r4(Math.max(0, Math.min(...xs) - padX)),
    r4(Math.max(0, Math.min(...ys) - padY)),
    r4(Math.min(1, Math.max(...xs) + padX)),
    r4(Math.min(1, Math.max(...ys) + below)),
  ];
}

/**
 * The area standing decorations may occupy at a measured spot: about 1.4 m wide (room for a
 * cluster of pumpkins and pots, or a planter with a pumpkin at its foot) and 1.3 m tall above
 * it (from the door height), its bottom edge on the spot. The planner trims the side that runs
 * into steps, walkways or the door.
 */
export function standSpotBox(
  spot: readonly [number, number],
  a: HouseAnchors,
  photo: { width: number; height: number },
  surface?: StandSurface,
): NormalizedBox {
  const door = a.frontDoor ?? a.doorFrame;
  const meter = door ? (door[3] - door[1]) / 2.05 : 0.08;
  const halfW = (meter * 0.7 * photo.height) / photo.width;
  // The planner insets an area anchor by 15% on each side; the box is widened by that much so
  // the planned region spans the surface.
  const pad = surface ? (surface.to - surface.from) * 0.22 : 0;
  const x0 = surface ? Math.max(spot[0] - halfW, surface.from - pad) : spot[0] - halfW;
  const x1 = surface ? Math.min(spot[0] + halfW, surface.to + pad) : spot[0] + halfW;
  return [r4(x0), r4(Math.max(0, spot[1] - meter * 1.3)), r4(x1), r4(spot[1])];
}

const ANCHOR_CONFIDENCE: Readonly<Partial<Record<AnchorCategory, number>>> = {
  front_door: 0.96,
  door_frame: 0.94,
  roofline: 0.93,
  eaves: 0.94,
  window_frame: 0.92,
  porch_rail: 0.92,
  porch_steps: 0.94,
  column: 0.91,
  walkway_edge: 0.9,
  planter: 0.9,
};

/**
 * Scene geometry of a photo frame: the manifest's anchor boxes transformed into the crop
 * (clipped; anchors mostly outside the frame are dropped), with preserve and access regions,
 * existing decorations, season cues and the burned-in credit region.
 */
export function photoFrameGeometry(input: PhotoFrameInput): FixtureSceneGeometry {
  const { photo, crop, width, height } = input;
  const size = { width: photo.width, height: photo.height };
  const a = photo.anchors;
  const t = (box: NormalizedBox | null, minVisible = 0.5) =>
    box ? transformBox(box, crop, size, minVisible) : null;
  const occluders = [a.parkedCar].filter((box): box is NormalizedBox => box !== null);

  const anchors: Anchor[] = [];
  const add = (category: AnchorCategory, box: NormalizedBox | null) => {
    if (!box) return;
    const transformed = t(box);
    if (!transformed) return;
    const visible = visibleShare(box, crop, size);
    const occlusion = Math.min(
      1,
      occluders.reduce((sum, occluder) => sum + overlapShare(box, occluder), 0),
    );
    const occlusionFraction = Math.round(occlusion * 100) / 100;
    const base = ANCHOR_CONFIDENCE[category] ?? 0.9;
    anchors.push({
      id: `a${anchors.length + 1}`,
      category,
      box: transformed,
      confidence: Math.round((visible < 0.95 ? base - 0.12 : base) * 100) / 100,
      occluded: occlusionFraction > 0.05,
      ...(occlusionFraction > 0 ? { occlusionFraction } : {}),
    });
  };
  if (a.lightLines.length > 0) {
    for (const line of a.lightLines) add('eaves', lineBox(line, 0.006, 0.004));
  } else {
    if (!rooflineIsEave(a)) add('roofline', a.roofline);
    add('eaves', a.eaves);
  }
  add('front_door', a.frontDoor);
  add('door_frame', a.doorFrame);
  for (const box of a.windows) add('window_frame', box);
  if (a.railLines.length > 0) {
    for (const line of a.railLines) add('porch_rail', lineBox(line, 0, 0.004, 0.03));
  } else {
    add('porch_rail', a.porchRail);
  }
  for (const box of a.columns) add('column', box);
  add('walkway_edge', a.walkwayEdge);
  if (a.standSpots.length > 0) {
    // Measured spots replace the steps and planters as places to stand things.
    for (const [i, spot] of a.standSpots.entries())
      add('planter', standSpotBox(spot, a, size, a.standSurfaces[i]));
  } else {
    add('porch_steps', a.porchSteps);
    // Only planters standing near ground level take standing items; window boxes and hanging
    // baskets higher on the facade would leave pumpkins and lanterns floating.
    const groundLine = a.houseFacade[1] + (a.houseFacade[3] - a.houseFacade[1]) * 0.75;
    for (const box of a.planters) if (box[3] >= groundLine) add('planter', box);
  }
  if (a.lightLines.length === 0) for (const box of a.fascia) add('eaves', box);

  const targetFacade = t(a.houseFacade, 0.2) ?? undefined;
  const credit = input.credit ? creditStrip(input.credit, width, height) : null;
  const attributionRegion: NormalizedBox | undefined = credit
    ? [
        r4(credit.box.x0 / width),
        r4(credit.box.y0 / height),
        r4(credit.box.x1 / width),
        r4(credit.box.y1 / height),
      ]
    : undefined;

  const preserveRegions: PreserveRegion[] = [];
  const existing = a.existingDecor
    .map((box) => t(box, 0.3))
    .filter((box): box is NormalizedBox => box !== null);
  for (const box of existing) preserveRegions.push({ kind: 'existing_decor', box });
  const car = t(a.parkedCar, 0.3);
  if (car) preserveRegions.push({ kind: 'vehicle', box: car });
  if (attributionRegion) preserveRegions.push({ kind: 'logo', box: attributionRegion });

  const accessRegions: FixtureSceneGeometry['accessRegions'] = [];
  const door = t(a.frontDoor);
  if (door) accessRegions.push({ kind: 'door', box: door });
  const steps = t(a.porchSteps);
  if (steps) accessRegions.push({ kind: 'steps', box: steps });
  const walkway = t(a.walkwayEdge);
  if (walkway) accessRegions.push({ kind: 'walkway', box: walkway });
  const garage = t(a.garageDoor);
  if (garage) accessRegions.push({ kind: 'driveway', box: garage });

  const neighborFacades = a.neighborFacades
    .map((box) => t(box, 0.25))
    .filter((box): box is NormalizedBox => box !== null);
  const windows = a.windows
    .map((box) => t(box))
    .filter((box): box is NormalizedBox => box !== null);
  const dusk = /\b(dusk|blue hour|night)\b/i.test(`${photo.title} ${photo.description}`);
  const winter = photo.season === 'winter';
  const buildingForm: BuildingForm =
    photo.buildingForm === 'multi_unit' ? 'other' : photo.buildingForm;
  return {
    width,
    height,
    sceneType: 'house_exterior',
    buildingForm,
    ...(targetFacade ? { targetFacade } : {}),
    targetFacadeAmbiguous: !targetFacade,
    anchors,
    preserveRegions,
    accessRegions,
    hazards: [],
    existingDecorations:
      photo.existingDecor !== 'none' && existing.length > 0
        ? {
            present: true,
            holidayGuess: photo.existingDecor,
            density: existing.length >= 4 ? 'high' : 'medium',
            boxes: existing,
          }
        : { present: false, density: 'none', boxes: [] },
    peopleBoxes: [],
    protectedBlurRegions:
      input.blurredHouse && targetFacade ? [{ kind: 'house', box: targetFacade }] : [],
    lighting: dusk
      ? { timeOfDay: 'dusk', isDaylight: false, exposure: 'under' }
      : { timeOfDay: 'day', isDaylight: true, exposure: 'normal' },
    seasonCues: {
      snowVisible: winter,
      foliage: winter ? 'bare' : photo.season === 'autumn' ? 'mixed' : 'leafy',
    },
    qualityFlags: {
      ...NO_QUALITY_FLAGS,
      multipleBuildings: neighborFacades.length > 0,
      blur: input.blurredHouse ?? false,
    },
    windows,
    ...(attributionRegion ? { attributionRegion } : {}),
    neighborFacades,
    lightSources: [],
  };
}

// ---- rendering -----------------------------------------------------------------------------------

/** Decoded photo masters, kept per process (a fixture photo is about 8 MB raw). */
const decoded = new Map<string, Promise<{ data: Buffer; width: number; height: number }>>();
const MAX_DECODED = 8;

function decodePhoto(file: string) {
  let entry = decoded.get(file);
  if (!entry) {
    entry = sharp(file)
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => ({ data, width: info.width, height: info.height }));
    entry.catch(() => decoded.delete(file));
    decoded.set(file, entry);
    if (decoded.size > MAX_DECODED) {
      const oldest = decoded.keys().next().value;
      if (oldest !== undefined) decoded.delete(oldest);
    }
  }
  return entry;
}

/**
 * Renders a photo frame: the crop resampled to the output size, the facade blurred when the owner
 * asked for it, and the credit line burned into the bottom right. Returns PNG or JPEG bytes.
 */
export async function renderPhotoFrame(
  input: PhotoFrameInput & { file: string; format?: 'jpeg' | 'png'; quality?: number },
): Promise<Buffer> {
  const master = await decodePhoto(input.file);
  let frame = await sharp(master.data, {
    raw: { width: master.width, height: master.height, channels: 3 },
  })
    .extract(input.crop)
    .resize(input.width, input.height, { fit: 'fill', kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const overlays: OverlayOptions[] = [];
  if (input.blurredHouse) {
    const facade = transformBox(
      input.photo.anchors.houseFacade,
      input.crop,
      { width: input.photo.width, height: input.photo.height },
      0.2,
    );
    if (facade) {
      const left = Math.max(0, Math.floor(facade[0] * input.width));
      const top = Math.max(0, Math.floor(facade[1] * input.height));
      const w = Math.min(input.width - left, Math.ceil((facade[2] - facade[0]) * input.width));
      const h = Math.min(input.height - top, Math.ceil((facade[3] - facade[1]) * input.height));
      if (w > 2 && h > 2) {
        const sigma = Math.max(6, Math.min(input.width, input.height) * 0.03);
        const blurred = await sharp(frame)
          .blur(sigma)
          .extract({ left, top, width: w, height: h })
          .png()
          .toBuffer();
        overlays.push({ input: blurred, left, top });
      }
    }
  }
  if (input.credit) {
    const strip = creditStrip(input.credit, input.width, input.height);
    const text = escapeXml(strip.text);
    const font = `font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${strip.fontSize}"`;
    overlays.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}"><rect x="${strip.box.x0}" y="${strip.box.y0}" width="${strip.box.x1 - strip.box.x0}" height="${strip.box.y1 - strip.box.y0}" fill="#202224"/><text x="${strip.x.toFixed(1)}" y="${strip.y.toFixed(1)}" ${font} fill="#E8E8E8">${text}</text></svg>`,
      ),
      left: 0,
      top: 0,
    });
  }
  if (overlays.length > 0) {
    frame = await sharp(frame).composite(overlays).removeAlpha().png().toBuffer();
  }
  if (input.format === 'png') return frame;
  return sharp(frame)
    .jpeg({ quality: input.quality ?? 88, chromaSubsampling: '4:4:4', mozjpeg: false })
    .toBuffer();
}

// ---- placement geometry ---------------------------------------------------------------------------

const boxLine = (box: NormalizedBox, y: number): [number, number][] => [
  [box[0], y],
  [box[2], y],
];

/**
 * Placement geometry of a library photo: the sample's measured anchors, or, for a house photo,
 * its measured light lines, rail lines and standing spots, falling back to lines derived from its
 * anchor boxes (the eave and fascia edges, the rail's top edge). Null for other photos.
 */
export function libraryAnchorsOf(photo: LibraryPhoto): LibraryAnchors | null {
  if (photo.kind === 'sample') return photo.anchors ?? null;
  if (photo.kind !== 'house') return null;
  const a = photo.anchors;
  const door = a.frontDoor ?? a.doorFrame;
  if (!door) return null;
  const eaves: [number, number][][] = a.lightLines.map((line) => line.map(([x, y]) => [x, y]));
  if (eaves.length === 0 && a.eaves)
    eaves.push(boxLine(a.eaves, a.eaves[1] + (a.eaves[3] - a.eaves[1]) * 0.6));
  if (a.lightLines.length === 0) {
    // The roofline's lower edge often is the eave itself; one string per edge.
    if (a.roofline && !rooflineIsEave(a)) eaves.push(boxLine(a.roofline, a.roofline[3] - 0.004));
    for (const box of a.fascia) eaves.push(boxLine(box, box[1] + (box[3] - box[1]) * 0.6));
  }
  // Only measured spots: a guess beside the steps can land in a shrub, and an existing
  // planter's base is taken by the planter.
  const standSpots: [number, number][] = a.standSpots.map(([x, y]) => [x, y]);
  return {
    scale: { box: door, meters: a.frontDoor ? 2.05 : 2.25, axis: 'height' },
    eyeHeight: 1.6,
    doors: a.frontDoor ? [a.frontDoor] : [],
    doorFrames: a.doorFrame ? [a.doorFrame] : [],
    doorGlass: [],
    windows: a.windows,
    windowTops: [],
    mantel: null,
    rails:
      a.railLines.length > 0
        ? a.railLines.map((line) => line.map(([x, y]) => [x, y] as [number, number]))
        : a.porchRail
          ? [boxLine(a.porchRail, a.porchRail[1] + 0.004)]
          : [],
    eaves,
    posts: a.columns,
    tableSpots: [],
    surfaceSpots: [],
    standSpots,
    standSurfaces: a.standSurfaces.map((surface) => ({ ...surface })),
    keepClear: [...a.existingDecor, ...(a.parkedCar ? [a.parkedCar] : []), ...a.neighborFacades],
  };
}
