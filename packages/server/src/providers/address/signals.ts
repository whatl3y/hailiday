import type { EntryMethod, HeadingMode, Precision, PrecisionSource } from '@holiday/core';
import {
  fromLocalMeters,
  initialBearingDeg,
  normalizeDegrees,
  polygonCentroid,
  toLocalMeters,
  type LatLng,
} from '../geo.js';
import { signToken, verifyToken } from '../signing.js';
import type {
  AddressComponent,
  DestinationGeometry,
  GeocodeCandidatePayload,
  GeocodeLocationType,
  GeocodeSignal,
  ResolvedPlace,
} from '../types.js';

/** Place types that pass the place-type gate. */
export const ADDRESS_PLACE_TYPES = ['street_address', 'premise', 'subpremise'] as const;
/** Place types that mark a multi-unit property. */
export const MULTI_UNIT_PLACE_TYPES = [
  'subpremise',
  'apartment_complex',
  'condominium_complex',
  'apartment_building',
];
/** Minimum autocomplete query length after trim. */
export const MIN_SUGGEST_QUERY_LENGTH = 3;
/** Maximum manual-entry candidates returned. */
export const MAX_GEOCODE_CANDIDATES = 5;
/** Lifetime of a signed manual-entry candidate. */
export const GEOCODE_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const CANDIDATE_PURPOSE = 'geocode-candidate';

/** Geocoding `location_type` → precision class. */
export function precisionFromLocationType(locationType: GeocodeLocationType): Precision {
  if (locationType === 'ROOFTOP') return 'rooftop_equivalent';
  if (locationType === 'RANGE_INTERPOLATED') return 'interpolated';
  return 'low';
}

export function countryCodeOf(components: readonly AddressComponent[]): string | null {
  return components.find((component) => component.types.includes('country'))?.shortText ?? null;
}

/** Normalization for manual-entry matching: NFD, no diacritics, lower case, `[a-z0-9# ]`. */
export function normalizeAddressText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9# ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everything resolve derives about a property from Places, Geocoding and SearchDestinations. */
export interface PropertySignals {
  countryCode: string | null;
  inScope: boolean;
  precision: Precision;
  precisionSource: PrecisionSource;
  partialMatch: boolean;
  multiUnit: boolean;
  placeTypes: string[];
  structureType: 'BUILDING' | 'GROUNDS' | null;
  geometryAvailable: boolean;
  headingMode: HeadingMode;
  /** Target point T (entrance on the facade, outline centroid, else the resolved location). */
  targetPoint: LatLng;
  facadeWidthM: number | null;
  roadBearingDeg: number | null;
  facadeNormalDeg: number | null;
  entranceOffsetM: number | null;
  attachedFacade: boolean;
  entryMethod: EntryMethod;
}

/**
 * Derives the property record's signals. Precision prefers Geocoding by place ID, then
 * SearchDestinations, then the Places types proxy; the place-type gate forces `low` for
 * non-address types.
 */
export function derivePropertySignals(input: {
  resolved?: ResolvedPlace | null;
  geocode?: GeocodeSignal | null;
  destinations?: DestinationGeometry | null;
  entryMethod: EntryMethod;
  unit?: string | null;
}): PropertySignals {
  const types = input.resolved?.types ?? input.geocode?.types ?? [];
  const components = input.resolved?.addressComponents ?? input.geocode?.addressComponents ?? [];
  const countryCode =
    input.resolved?.countryCode ?? input.geocode?.countryCode ?? countryCodeOf(components);
  const structureType = input.destinations?.structureType ?? null;
  let precision: Precision;
  let precisionSource: PrecisionSource;
  if (input.geocode) {
    precision = precisionFromLocationType(input.geocode.locationType);
    precisionSource = 'geocoding';
  } else if (structureType === 'BUILDING' && input.destinations?.hasOutline) {
    precision = 'rooftop_equivalent';
    precisionSource = 'search_destinations';
  } else {
    precision = types.some((type) => type === 'street_address' || type === 'premise')
      ? 'interpolated'
      : 'low';
    precisionSource = 'places_types';
  }
  if (!types.some((type) => (ADDRESS_PLACE_TYPES as readonly string[]).includes(type))) {
    precision = 'low';
  }
  const hasSubpremise = components.some((component) => component.types.includes('subpremise'));
  const unitEntered = Boolean(input.unit && input.unit.trim());
  const complexType = types.some((type) => MULTI_UNIT_PLACE_TYPES.includes(type));
  const multiUnit = hasSubpremise || unitEntered || complexType;
  const geometryAvailable = Boolean(
    input.destinations?.hasOutline && input.destinations.targetPoint,
  );
  const location = input.resolved?.location ??
    input.geocode?.location ?? { latitude: 0, longitude: 0 };
  return {
    countryCode,
    inScope: countryCode === 'US',
    precision,
    precisionSource,
    partialMatch: input.geocode?.partialMatch ?? false,
    multiUnit,
    placeTypes: types,
    structureType,
    geometryAvailable,
    headingMode: geometryAvailable ? 'geometry' : 'point',
    targetPoint: (geometryAvailable ? input.destinations?.targetPoint : null) ?? location,
    facadeWidthM: geometryAvailable ? (input.destinations?.facadeWidthM ?? null) : null,
    roadBearingDeg: geometryAvailable ? (input.destinations?.roadBearingDeg ?? null) : null,
    facadeNormalDeg: geometryAvailable ? (input.destinations?.facadeNormalDeg ?? null) : null,
    entranceOffsetM: geometryAvailable ? (input.destinations?.entranceOffsetM ?? null) : null,
    attachedFacade: input.destinations?.attachedFacade ?? false,
    entryMethod: input.entryMethod,
  };
}

/** Signs a manual-entry candidate for one session; it expires after ten minutes. */
export function signGeocodeCandidate(
  secret: string,
  payload: GeocodeCandidatePayload,
  context: { sessionId: string; now: Date; ttlMs?: number },
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(context.now.getTime() + (context.ttlMs ?? GEOCODE_CANDIDATE_TTL_MS));
  return {
    token: signToken(secret, CANDIDATE_PURPOSE, payload, {
      sessionId: context.sessionId,
      expiresAt,
    }),
    expiresAt,
  };
}

/** Verifies a manual-entry candidate token; null when forged, expired or from another session. */
export function verifyGeocodeCandidate(
  secret: string,
  token: string,
  context: { sessionId: string; now: Date },
): GeocodeCandidatePayload | null {
  return verifyToken<GeocodeCandidatePayload>(secret, CANDIDATE_PURPOSE, token, context);
}

/** Builds the payload of a manual-entry candidate from a geocode result. */
export function candidatePayload(
  signal: GeocodeSignal,
  unit: string | null,
): GeocodeCandidatePayload {
  const derived = derivePropertySignals({ geocode: signal, entryMethod: 'manual', unit });
  return {
    placeId: signal.placeId,
    formattedAddress: signal.formattedAddress,
    precision: derived.precision,
    partialMatch: signal.partialMatch,
    multiUnit: derived.multiUnit,
    locationType: signal.locationType,
    location: signal.location,
    types: signal.types,
    countryCode: signal.countryCode,
    unit,
  };
}

/**
 * Derives facade numbers from a building outline: the front edge is the edge nearest the
 * preferred entrance (else the longest edge); its length is the facade width, its bearing the
 * road bearing, and the outward direction from the centroid the facade normal. The target point
 * is the entrance moved onto the front edge, else the centroid. A neighboring outline with a
 * vertex within 0.6 m of an edge marks an attached facade. Only these numbers are kept.
 */
export function geometryFromOutline(input: {
  polygon: readonly LatLng[];
  entrance?: LatLng | null;
  neighbors?: readonly (readonly LatLng[])[];
  structureType: 'BUILDING' | 'GROUNDS' | null;
}): DestinationGeometry {
  const ring = input.polygon;
  if (ring.length < 3) {
    return {
      structureType: input.structureType,
      hasOutline: false,
      targetPoint: null,
      facadeWidthM: null,
      roadBearingDeg: null,
      facadeNormalDeg: null,
      entranceOffsetM: null,
      attachedFacade: false,
    };
  }
  const origin = ring[0] as LatLng;
  const pts = ring.map((point) => toLocalMeters(origin, point));
  const centroid = polygonCentroid(pts);
  const edges = pts
    .map((a, i) => {
      const b = pts[(i + 1) % pts.length] as { x: number; y: number };
      return { a, b, length: Math.hypot(b.x - a.x, b.y - a.y) };
    })
    .filter((edge) => edge.length > 0.3);
  const projectOn = (p: { x: number; y: number }, edge: (typeof edges)[number]) => {
    const dx = edge.b.x - edge.a.x;
    const dy = edge.b.y - edge.a.y;
    const t = Math.max(
      0,
      Math.min(1, ((p.x - edge.a.x) * dx + (p.y - edge.a.y) * dy) / (dx * dx + dy * dy)),
    );
    const q = { x: edge.a.x + dx * t, y: edge.a.y + dy * t };
    return { q, distance: Math.hypot(p.x - q.x, p.y - q.y) };
  };
  const entrance = input.entrance ? toLocalMeters(origin, input.entrance) : null;
  const front = entrance
    ? edges.reduce((best, edge) =>
        projectOn(entrance, edge).distance < projectOn(entrance, best).distance ? edge : best,
      )
    : edges.reduce((best, edge) => (edge.length > best.length ? edge : best));
  const mid = { x: (front.a.x + front.b.x) / 2, y: (front.a.y + front.b.y) / 2 };
  const toLatLng = (p: { x: number; y: number }) => fromLocalMeters(origin, p);
  const edgeBearing = initialBearingDeg(toLatLng(front.a), toLatLng(front.b));
  const normal = initialBearingDeg(toLatLng(centroid), toLatLng(mid));
  const projected = entrance ? projectOn(entrance, front) : null;
  let attached = false;
  for (const neighbor of input.neighbors ?? []) {
    for (const vertex of neighbor) {
      const local = toLocalMeters(origin, vertex);
      if (edges.some((edge) => projectOn(local, edge).distance < 0.6)) attached = true;
    }
  }
  return {
    structureType: input.structureType,
    hasOutline: true,
    targetPoint: projected ? toLatLng(projected.q) : toLatLng(centroid),
    facadeWidthM: Math.round(front.length * 10) / 10,
    roadBearingDeg: Math.round(normalizeDegrees(edgeBearing) * 10) / 10,
    facadeNormalDeg: Math.round(normalizeDegrees(normal) * 10) / 10,
    entranceOffsetM: projected ? Math.round(projected.distance * 10) / 10 : null,
    attachedFacade: attached,
  };
}
