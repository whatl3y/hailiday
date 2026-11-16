import type {
  Anchor,
  AnchorCategory,
  BuildingForm,
  NormalizedBox,
  RoomType,
  SceneType,
} from '@hailiday/core';
import type { LibraryAnchors } from './photos.js';
import { anchorsInCrop, recognizeLibraryPhoto } from './recognize.js';
import {
  DAYLIGHT,
  NO_EXISTING_DECOR,
  NO_QUALITY_FLAGS,
  type FixtureSceneGeometry,
} from './scene.js';

type Layout = readonly (readonly [AnchorCategory, NormalizedBox])[];

/** Generic anchor layouts for uploaded photos, by scene type (fixture vision model). */
const EXTERIOR: Layout = [
  ['roofline', [0.14, 0.13, 0.86, 0.19]],
  ['eaves', [0.1, 0.3, 0.9, 0.35]],
  ['window_frame', [0.2, 0.38, 0.32, 0.52]],
  ['window_frame', [0.68, 0.38, 0.8, 0.52]],
  ['front_door', [0.45, 0.5, 0.55, 0.74]],
  ['door_frame', [0.43, 0.47, 0.57, 0.75]],
  ['porch_rail', [0.2, 0.66, 0.42, 0.75]],
  ['porch_rail', [0.58, 0.66, 0.8, 0.75]],
  ['column', [0.4, 0.53, 0.42, 0.75]],
  ['column', [0.58, 0.53, 0.6, 0.75]],
  ['porch_steps', [0.43, 0.75, 0.57, 0.84]],
  ['planter', [0.34, 0.76, 0.41, 0.86]],
  ['planter', [0.59, 0.76, 0.66, 0.86]],
  ['walkway_edge', [0.44, 0.84, 0.56, 1.0]],
  ['lawn', [0.05, 0.86, 0.38, 0.98]],
];

const APARTMENT_ENTRY: Layout = [
  ['unit_door', [0.42, 0.25, 0.58, 0.78]],
  ['door_frame', [0.39, 0.21, 0.61, 0.79]],
  ['floor_area', [0.62, 0.68, 0.8, 0.86]],
  ['wall', [0.66, 0.24, 0.9, 0.48]],
  ['planter', [0.16, 0.6, 0.28, 0.82]],
];

const BALCONY: Layout = [
  ['balcony_railing', [0.08, 0.5, 0.96, 0.78]],
  ['balcony_floor', [0.5, 0.74, 0.95, 0.95]],
  ['door_frame', [0.02, 0.18, 0.2, 0.82]],
  ['planter', [0.24, 0.66, 0.38, 0.88]],
  ['wall', [0.02, 0.05, 0.2, 0.18]],
];

const INTERIOR: Record<RoomType, Layout> = {
  dining_room: [
    ['dining_table', [0.24, 0.55, 0.76, 0.75]],
    ['interior_window', [0.36, 0.2, 0.5, 0.48]],
    ['interior_window', [0.52, 0.2, 0.66, 0.48]],
    ['sideboard', [0.8, 0.5, 0.98, 0.56]],
    ['wall', [0.04, 0.22, 0.2, 0.45]],
  ],
  living_room: [
    ['mantel', [0.28, 0.42, 0.54, 0.45]],
    ['interior_window', [0.6, 0.2, 0.74, 0.48]],
    ['floor_area', [0.72, 0.3, 0.9, 0.66]],
    ['shelf', [0.06, 0.3, 0.18, 0.38]],
    ['wall', [0.04, 0.12, 0.24, 0.28]],
  ],
  entryway: [
    ['banister', [0.62, 0.3, 0.95, 0.85]],
    ['floor_area', [0.3, 0.62, 0.55, 0.9]],
    ['shelf', [0.05, 0.5, 0.28, 0.56]],
    ['wall', [0.08, 0.15, 0.4, 0.42]],
  ],
  kitchen: [
    ['dining_table', [0.3, 0.6, 0.72, 0.78]],
    ['interior_window', [0.4, 0.18, 0.6, 0.42]],
    ['shelf', [0.68, 0.28, 0.9, 0.34]],
  ],
  bedroom: [
    ['interior_window', [0.66, 0.18, 0.84, 0.48]],
    ['wall', [0.3, 0.14, 0.62, 0.36]],
    ['shelf', [0.06, 0.34, 0.24, 0.4]],
  ],
  other: [
    ['interior_window', [0.56, 0.18, 0.74, 0.48]],
    ['wall', [0.12, 0.16, 0.42, 0.4]],
    ['shelf', [0.16, 0.46, 0.4, 0.52]],
  ],
};

function anchorsOf(layout: Layout, confidence: number): Anchor[] {
  return layout.map(([category, box], index) => ({
    id: `a${index + 1}`,
    category,
    box: [...box] as NormalizedBox,
    confidence,
    occluded: false,
  }));
}

/**
 * A generic, approximate layout for an uploaded photo of a scene type. Confidence is high
 * enough for planning; the fixture never inspects the user's pixels.
 */
export function genericUploadGeometry(input: {
  sceneType: SceneType;
  buildingForm?: BuildingForm | null;
  roomType?: RoomType | null;
  width?: number;
  height?: number;
}): FixtureSceneGeometry {
  const sceneType = input.sceneType;
  const roomType = input.roomType ?? 'living_room';
  const layout =
    sceneType === 'house_exterior'
      ? EXTERIOR
      : sceneType === 'apartment_entry'
        ? APARTMENT_ENTRY
        : sceneType === 'balcony'
          ? BALCONY
          : INTERIOR[roomType];
  const anchors = anchorsOf(layout, 0.86);
  const windows = anchors
    .filter((anchor) => anchor.category === 'window_frame' || anchor.category === 'interior_window')
    .map((anchor) => anchor.box);
  const door = anchors.find(
    (anchor) => anchor.category === 'front_door' || anchor.category === 'unit_door',
  );
  const steps = anchors.find((anchor) => anchor.category === 'porch_steps');
  return {
    width: input.width ?? 1024,
    height: input.height ?? 1024,
    sceneType,
    ...(sceneType === 'house_exterior' ? { buildingForm: input.buildingForm ?? 'detached' } : {}),
    ...(sceneType === 'interior' ? { roomType } : {}),
    ...(sceneType === 'house_exterior'
      ? { targetFacade: [0.06, 0.08, 0.94, 0.9] as NormalizedBox }
      : {}),
    targetFacadeAmbiguous: false,
    anchors,
    preserveRegions: [],
    accessRegions: [
      ...(door ? [{ kind: 'door' as const, box: door.box }] : []),
      ...(steps ? [{ kind: 'steps' as const, box: steps.box }] : []),
    ],
    hazards: [],
    existingDecorations: NO_EXISTING_DECOR,
    peopleBoxes: [],
    protectedBlurRegions: [],
    lighting: DAYLIGHT,
    seasonCues: { snowVisible: false, foliage: 'unknown' },
    qualityFlags: NO_QUALITY_FLAGS,
    windows,
    neighborFacades: [],
    lightSources: [],
  };
}

const r4 = (value: number) => Math.round(value * 10000) / 10000;

function clampBox([x0, y0, x1, y1]: NormalizedBox): NormalizedBox {
  const c = (v: number) => r4(Math.min(1, Math.max(0, v)));
  return [c(x0), c(y0), c(x1), c(y1)];
}

function lineBox(
  line: readonly (readonly [number, number])[],
  padX: number,
  padY: number,
): NormalizedBox {
  const xs = line.map((p) => p[0]);
  const ys = line.map((p) => p[1]);
  return clampBox([
    Math.min(...xs) - padX,
    Math.min(...ys) - padY,
    Math.max(...xs) + padX,
    Math.max(...ys) + padY,
  ]);
}

/**
 * Scene geometry of a recognized library photo (normalized to the image): its measured anchors
 * in the scene-analysis vocabulary, sized so that the planner's regions cover where the fixture
 * compositor will place each decoration.
 */
export function libraryUploadGeometry(input: {
  anchors: LibraryAnchors;
  sceneType: SceneType;
  buildingForm?: BuildingForm | null;
  roomType?: RoomType | null;
  width?: number;
  height?: number;
}): FixtureSceneGeometry {
  const a = input.anchors;
  const sceneType = input.sceneType;
  const exterior = sceneType === 'house_exterior';
  const layout: [AnchorCategory, NormalizedBox][] = [];
  const doorCategory: AnchorCategory = sceneType === 'apartment_entry' ? 'unit_door' : 'front_door';
  for (const box of a.doors) layout.push([doorCategory, clampBox(box)]);
  for (const box of a.doorFrames) layout.push(['door_frame', clampBox(box)]);
  for (const [i, box] of a.windows.entries()) {
    // A window's anchor reaches up to its top casing or curtain rod, where a garland hangs.
    const top = a.windowTops[i];
    const reach: NormalizedBox = top
      ? [
          Math.min(box[0], ...top.map((p) => p[0])),
          Math.min(box[1], ...top.map((p) => p[1] - 0.04)),
          Math.max(box[2], ...top.map((p) => p[0])),
          box[3],
        ]
      : box;
    layout.push([exterior ? 'window_frame' : 'interior_window', clampBox(reach)]);
  }
  for (const line of a.eaves) layout.push(['eaves', lineBox(line, 0, 0.02)]);
  const railCategory: AnchorCategory =
    sceneType === 'balcony'
      ? 'balcony_railing'
      : sceneType === 'interior'
        ? 'banister'
        : 'porch_rail';
  for (const line of a.rails) layout.push([railCategory, lineBox(line, 0.01, 0.02)]);
  if (a.mantel) layout.push(['mantel', lineBox(a.mantel, 0, 0.03)]);
  for (const [x, y] of a.tableSpots)
    layout.push(['dining_table', clampBox([x - 0.07, y - 0.05, x + 0.07, y + 0.04])]);
  for (const [x, y] of a.surfaceSpots)
    layout.push(['shelf', clampBox([x - 0.08, y - 0.04, x + 0.08, y + 0.03])]);
  const standCategory: AnchorCategory =
    sceneType === 'balcony' ? 'balcony_floor' : exterior ? 'planter' : 'floor_area';
  for (const [x, y] of a.standSpots)
    layout.push([standCategory, clampBox([x - 0.09, y - 0.2, x + 0.09, y + 0.01])]);
  const anchors = anchorsOf(layout, 0.9);
  const door = anchors.find((anchor) => anchor.category === doorCategory);
  return {
    width: input.width ?? 1024,
    height: input.height ?? 1024,
    sceneType,
    ...(exterior ? { buildingForm: input.buildingForm ?? 'detached' } : {}),
    ...(sceneType === 'interior' ? { roomType: input.roomType ?? 'living_room' } : {}),
    ...(exterior ? { targetFacade: [0.02, 0.02, 0.98, 0.98] as NormalizedBox } : {}),
    targetFacadeAmbiguous: false,
    anchors,
    preserveRegions: a.keepClear.map((box) => ({ kind: 'other' as const, box: clampBox(box) })),
    accessRegions: door ? [{ kind: 'door' as const, box: door.box }] : [],
    hazards: [],
    existingDecorations: NO_EXISTING_DECOR,
    peopleBoxes: [],
    protectedBlurRegions: [],
    lighting: DAYLIGHT,
    seasonCues: { snowVisible: false, foliage: 'unknown' },
    qualityFlags: NO_QUALITY_FLAGS,
    windows: a.windows.map(clampBox),
    neighborFacades: [],
    lightSources: [],
  };
}

/**
 * Fixture scene analysis of an uploaded image: the measured anchors when the image is one of the
 * library photos (the shipped samples and house photos), otherwise the generic layout.
 */
export async function fixtureUploadGeometry(input: {
  image: Uint8Array;
  sceneType: SceneType;
  buildingForm?: BuildingForm | null;
  roomType?: RoomType | null;
  width?: number;
  height?: number;
}): Promise<FixtureSceneGeometry> {
  const recognized = await recognizeLibraryPhoto(input.image);
  if (!recognized) return genericUploadGeometry(input);
  return libraryUploadGeometry({
    ...input,
    anchors: anchorsInCrop(recognized.anchors, recognized.crop),
  });
}
