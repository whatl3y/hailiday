import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BUILDING_FORMS,
  NormalizedBoxSchema,
  ROOM_TYPES,
  SCENE_TYPES,
  SKIP_REASONS,
} from '@hailiday/core';
import type { BuildingForm, NormalizedBox, RoomType, SceneType } from '@hailiday/core';
import { DEFAULT_FIXTURES_DIR } from '../content/load.js';

/** Render scenarios a fixture place or upload file name can trigger. */
export const RENDER_SCENARIOS = [
  'pass',
  'repair_then_pass',
  'reject',
  'relight_reject',
  'provider_error',
  'slow',
  'no_anchors',
  'moderation',
] as const;
export type RenderScenario = (typeof RENDER_SCENARIOS)[number];

const LatLngSchema = z.object({ latitude: z.number(), longitude: z.number() });

/** Procedural house parameters (places.json `house`, heroes.json `procedural.house`). */
export const HouseParamsSchema = z.object({
  style: z.enum([
    'colonial',
    'bungalow',
    'cape_cod',
    'farmhouse',
    'ranch',
    'townhouse_row',
    'apartment_block',
  ]),
  stories: z.int().min(1).max(4),
  roofShape: z.enum(['gable', 'hip', 'flat']),
  bodyColor: z.string(),
  trimColor: z.string(),
  roofColor: z.string(),
  doorColor: z.string(),
  porch: z.enum(['full', 'stoop', 'none']),
  windowsPerFloor: z.int().min(1).max(8),
  garage: z.boolean(),
  shutters: z.boolean(),
  trees: z.enum(['both', 'left', 'right', 'none']),
  fence: z.boolean(),
  season: z.enum(['summer', 'autumn', 'winter']),
  existingDecor: z.enum(['none', 'halloween']),
  parkedCar: z.boolean(),
  neighborLeft: z.boolean(),
  neighborRight: z.boolean(),
  setbackMeters: z.number().positive(),
  blurredHouse: z.boolean(),
});
export type HouseParams = z.infer<typeof HouseParamsSchema>;

/**
 * A licensed real photograph standing in for a fixture panorama: the photo's ID in
 * `content/photos/manifest.json`, an optional framing scale and offset of the reference view, and
 * whether the owner asked Google to blur the house (the facade is blurred in every frame).
 */
export const PanoramaPhotoSchema = z.object({
  photoId: z.string().min(1),
  framing: z.number().positive().default(1),
  shiftX: z.number().min(-1).max(1).default(0),
  shiftY: z.number().min(-1).max(1).default(0),
  blurredHouse: z.boolean().default(false),
});
export type PanoramaPhoto = z.infer<typeof PanoramaPhotoSchema>;

const PanoramaSchema = z
  .object({
    panoId: z.string().min(1),
    probe: z.string(),
    probeRadiusM: z.number(),
    location: LatLngSchema,
    captureDate: z.string().nullable(),
    captureGranularity: z.enum(['month', 'year', 'none']),
    copyright: z.string(),
    isGoogleImagery: z.boolean(),
    distanceM: z.number(),
    headingDeg: z.number(),
    /**
     * Where the home stands as seen from this panorama, for a place whose target point lies on
     * the road: its compass bearing and distance. Its frames show the photograph at the home's
     * bearing and angular size, so a view turned away shows the home at the side, cut by the
     * frame's edge or not at all.
     */
    home: z
      .object({
        bearingDeg: z.number().min(0).lt(360),
        distanceM: z.number().positive(),
      })
      .optional(),
    /** A real photograph shown for this panorama (owner-facing places). */
    photo: PanoramaPhotoSchema.optional(),
    /** Procedural house parameters (the SVG renderer, kept for tests that need exact drawings). */
    house: HouseParamsSchema.optional(),
  })
  .refine((panorama) => Boolean(panorama.photo) !== Boolean(panorama.house), {
    message: 'A panorama has exactly one of photo or house',
  });
export type FixturePanorama = z.infer<typeof PanoramaSchema>;

const AddressComponentSchema = z.object({
  longText: z.string(),
  shortText: z.string(),
  types: z.array(z.string()),
  languageCode: z.string().optional(),
});

const PlaceSchema = z.object({
  placeId: z.string().min(1),
  label: z.string().optional(),
  scenario: z.object({
    match: z.enum(['auto_start', 'confirm', 'skip_to_upload']),
    reason: z.enum(SKIP_REASONS).nullable(),
    render: z.enum(RENDER_SCENARIOS),
    tags: z.array(z.string()).default([]),
  }),
  formattedAddress: z.string(),
  primaryText: z.string(),
  secondaryText: z.string(),
  addressComponents: z.array(AddressComponentSchema),
  countryCode: z.string(),
  location: LatLngSchema,
  viewport: z.object({ low: LatLngSchema, high: LatLngSchema }).optional(),
  types: z.array(z.string()),
  geocode: z.object({
    locationType: z.enum(['ROOFTOP', 'RANGE_INTERPOLATED', 'GEOMETRIC_CENTER', 'APPROXIMATE']),
    partialMatch: z.boolean(),
  }),
  destinations: z.object({
    structureType: z.enum(['BUILDING', 'GROUNDS']).nullable(),
    hasOutline: z.boolean(),
    targetPoint: LatLngSchema.nullable(),
    facadeWidthM: z.number().nullable(),
    roadBearingDeg: z.number().nullable(),
    facadeNormalDeg: z.number().nullable(),
    entranceOffsetM: z.number().nullable(),
    attachedFacade: z.boolean(),
  }),
  multiUnit: z.boolean(),
  blocked: z.boolean(),
  metadataStatus: z.enum(['OK', 'ZERO_RESULTS', 'UNKNOWN_ERROR']),
  manualEntry: z.object({
    line1: z.string(),
    line2: z.string().default(''),
    city: z.string(),
    state: z.string(),
    postalCode: z.string(),
  }),
  geocodeAliases: z.array(z.string()),
  /**
   * How a metadata probe near the place finds a panorama. `probe`: by the panorama's probe label
   * (the target point, or an offset along the road) within its probe radius. `nearest`: the
   * panorama nearest the probed point, within the probe's radius.
   */
  panoramaLookup: z.enum(['probe', 'nearest']).default('probe'),
  panoramas: z.array(PanoramaSchema).default([]),
});
export type FixturePlace = z.infer<typeof PlaceSchema>;

const PlacesFileSchema = z.object({ places: z.array(PlaceSchema) });

const SceneHintSchema = z.object({
  token: z.string(),
  sceneType: z.enum(SCENE_TYPES),
  roomType: z.enum(ROOM_TYPES).optional(),
  buildingForm: z.enum(BUILDING_FORMS).optional(),
  confidence: z.number(),
});

const TriggersFileSchema = z.object({
  screening: z.array(
    z.object({
      token: z.string(),
      outcome: z.enum(['admitted', 'declined', 'held']),
      reasonClass: z.enum(['guidance', 'safety']).optional(),
      reason: z.string().optional(),
      peopleDetected: z.boolean().optional(),
      peopleBoxes: z.array(NormalizedBoxSchema).optional(),
      suggestedCropBox: NormalizedBoxSchema.optional(),
    }),
  ),
  screeningDefault: z.object({ outcome: z.literal('admitted'), peopleDetected: z.boolean() }),
  render: z.array(z.object({ token: z.string(), scenario: z.enum(RENDER_SCENARIOS) })),
  renderDefault: z.enum(RENDER_SCENARIOS),
  sceneHints: z.array(SceneHintSchema),
});
export type UploadTriggers = z.infer<typeof TriggersFileSchema>;

export interface FixtureData {
  places: FixturePlace[];
  triggers: UploadTriggers;
  placeById(placeId: string): FixturePlace | undefined;
  panorama(panoId: string): { place: FixturePlace; panorama: FixturePanorama } | undefined;
}

let cached: FixtureData | null = null;

/** Loads and validates `packages/server/fixtures` (places and upload triggers), cached. */
export function loadFixtureData(dir: string = DEFAULT_FIXTURES_DIR): FixtureData {
  if (cached && dir === DEFAULT_FIXTURES_DIR) return cached;
  const places = PlacesFileSchema.parse(
    JSON.parse(readFileSync(path.join(dir, 'places.json'), 'utf8')),
  ).places;
  const triggers = TriggersFileSchema.parse(
    JSON.parse(readFileSync(path.join(dir, 'upload-triggers.json'), 'utf8')),
  );
  const byId = new Map(places.map((place) => [place.placeId, place]));
  const byPano = new Map(
    places.flatMap((place) =>
      place.panoramas.map((panorama) => [panorama.panoId, { place, panorama }] as const),
    ),
  );
  const data: FixtureData = {
    places,
    triggers,
    placeById: (placeId) => byId.get(placeId),
    panorama: (panoId) => byPano.get(panoId),
  };
  if (dir === DEFAULT_FIXTURES_DIR) cached = data;
  return data;
}

/** Normalizes a file name for trigger matching: lower case, separators as single spaces. */
export function normalizeFileName(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/[-_.\s]+/g, ' ')
    .trim();
}

function tokenMatches(normalizedName: string, token: string): boolean {
  const normalizedToken = normalizeFileName(token);
  return ` ${normalizedName} `.includes(normalizedToken) && normalizedToken.length > 0;
}

export type ScreeningTrigger = UploadTriggers['screening'][number];

/** The screening trigger for an upload file name (first match wins), or null for the default. */
export function screeningTriggerFor(
  fileName: string | null | undefined,
  data: FixtureData = loadFixtureData(),
): ScreeningTrigger | null {
  if (!fileName) return null;
  const name = normalizeFileName(fileName);
  return data.triggers.screening.find((trigger) => tokenMatches(name, trigger.token)) ?? null;
}

/** The render scenario for an upload file name (first match wins). */
export function renderScenarioForFileName(
  fileName: string | null | undefined,
  data: FixtureData = loadFixtureData(),
): RenderScenario {
  if (!fileName) return data.triggers.renderDefault;
  const name = normalizeFileName(fileName);
  return (
    data.triggers.render.find((trigger) => tokenMatches(name, trigger.token))?.scenario ??
    data.triggers.renderDefault
  );
}

/** The render scenario of a fixture place, found by place ID or panorama ID. */
export function renderScenarioForPlace(
  ref: { placeId?: string | null; panoId?: string | null },
  data: FixtureData = loadFixtureData(),
): RenderScenario {
  const place =
    (ref.placeId ? data.placeById(ref.placeId) : undefined) ??
    (ref.panoId ? data.panorama(ref.panoId)?.place : undefined);
  return place?.scenario.render ?? 'pass';
}

export interface SceneHint {
  sceneType: SceneType;
  roomType?: RoomType;
  buildingForm?: BuildingForm;
  confidence: number;
}

/**
 * Scene type hint for an upload file name (first matching token), or null when the name carries
 * none: the fixture triage then reports no confident scene and the user picks the scene type.
 */
export function sceneHintForFileName(
  fileName: string | null | undefined,
  data: FixtureData = loadFixtureData(),
): SceneHint | null {
  const name = fileName ? normalizeFileName(fileName) : '';
  const hint = name
    ? data.triggers.sceneHints.find((candidate) => tokenMatches(name, candidate.token))
    : undefined;
  if (!hint) return null;
  const { token: _token, ...rest } = hint;
  return rest;
}

/** People boxes for a `people` screening trigger. */
export function triggerPeopleBoxes(trigger: ScreeningTrigger | null): NormalizedBox[] {
  return (trigger?.peopleBoxes ?? []) as NormalizedBox[];
}
