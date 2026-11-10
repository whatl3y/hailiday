/** A WGS84 coordinate in degrees, in the Places API (New) shape. */
export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Mean Earth radius used by the viewpoint formulas. */
export const EARTH_RADIUS_M = 6_371_000;

const toRad = (degrees: number) => (degrees * Math.PI) / 180;
const toDeg = (radians: number) => (radians * 180) / Math.PI;

/** Normalizes an angle to [0, 360). */
export function normalizeDegrees(degrees: number): number {
  const value = degrees % 360;
  return value < 0 ? value + 360 : value === 360 ? 0 : value;
}

/** Signed smallest difference `to − from` in degrees, in (−180, 180]. */
export function signedAngleDelta(from: number, to: number): number {
  const delta = normalizeDegrees(to - from);
  return delta > 180 ? delta - 360 : delta;
}

/** Absolute smallest difference between two bearings, in [0, 180]. */
export function angleDifference(a: number, b: number): number {
  return Math.abs(signedAngleDelta(a, b));
}

/** Haversine distance in meters. */
export function haversineDistanceM(from: LatLng, to: LatLng): number {
  const phi1 = toRad(from.latitude);
  const phi2 = toRad(to.latitude);
  const dPhi = phi2 - phi1;
  const dLambda = toRad(to.longitude - from.longitude);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial great-circle bearing from `from` to `to`, in degrees normalized to [0, 360):
 * θ = atan2(sin Δλ · cos φ_T, cos φ_P · sin φ_T − sin φ_P · cos φ_T · cos Δλ).
 */
export function initialBearingDeg(from: LatLng, to: LatLng): number {
  const phi1 = toRad(from.latitude);
  const phi2 = toRad(to.latitude);
  const dLambda = toRad(to.longitude - from.longitude);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return normalizeDegrees(toDeg(Math.atan2(y, x)));
}

/** The point reached by travelling `distanceM` from `origin` on the initial bearing. */
export function destinationPoint(origin: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const phi1 = toRad(origin.latitude);
  const lambda1 = toRad(origin.longitude);
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return { latitude: toDeg(phi2), longitude: ((toDeg(lambda2) + 540) % 360) - 180 };
}

/** Local east/north offset in meters of `point` relative to `origin` (equirectangular). */
export function toLocalMeters(origin: LatLng, point: LatLng): { x: number; y: number } {
  const x =
    toRad(point.longitude - origin.longitude) *
    Math.cos(toRad((origin.latitude + point.latitude) / 2)) *
    EARTH_RADIUS_M;
  const y = toRad(point.latitude - origin.latitude) * EARTH_RADIUS_M;
  return { x, y };
}

/** Inverse of `toLocalMeters`. */
export function fromLocalMeters(origin: LatLng, offset: { x: number; y: number }): LatLng {
  const latitude = origin.latitude + toDeg(offset.y / EARTH_RADIUS_M);
  const longitude =
    origin.longitude +
    toDeg(offset.x / (EARTH_RADIUS_M * Math.cos(toRad((origin.latitude + latitude) / 2))));
  return { latitude, longitude };
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Viewpoint parameters (configuration defaults from the address spec). */
export interface ViewpointParameters {
  radiusLadderM: readonly number[];
  alternateOffsetsM: readonly number[];
  maxCandidates: number;
  maxAlternateDistanceM: number;
  fovMin: number;
  fovMax: number;
  facadeMarginM: number;
  pitchMin: number;
  pitchMax: number;
  facadeMidHeightM: number;
  cameraHeightM: number;
  size: number;
  preferredDistanceM: number;
  farFromTargetM: number;
  primaryReplacementMaxDistanceM: number;
}

export const DEFAULT_VIEWPOINT_PARAMETERS: ViewpointParameters = Object.freeze({
  radiusLadderM: [50, 100, 200],
  alternateOffsetsM: [15, -15, 30, -30],
  maxCandidates: 3,
  maxAlternateDistanceM: 60,
  fovMin: 60,
  fovMax: 90,
  facadeMarginM: 2,
  pitchMin: 0,
  pitchMax: 10,
  facadeMidHeightM: 3.5,
  cameraHeightM: 2.5,
  size: 640,
  preferredDistanceM: 20,
  farFromTargetM: 40,
  primaryReplacementMaxDistanceM: 40,
});

/** `fov = clamp(2 · atan((W/2 + m) / d), 60, 90)` when W is known, else 90. */
export function viewFovDeg(
  facadeWidthM: number | null | undefined,
  distanceM: number,
  params: ViewpointParameters = DEFAULT_VIEWPOINT_PARAMETERS,
): number {
  if (!facadeWidthM || facadeWidthM <= 0 || distanceM <= 0) return params.fovMax;
  const raw = 2 * toDeg(Math.atan((facadeWidthM / 2 + params.facadeMarginM) / distanceM));
  return clamp(raw, params.fovMin, params.fovMax);
}

/** `pitch = clamp(atan((h_mid − h_cam) / d), 0, 10)`. */
export function viewPitchDeg(
  distanceM: number,
  params: ViewpointParameters = DEFAULT_VIEWPOINT_PARAMETERS,
): number {
  if (distanceM <= 0) return params.pitchMax;
  const raw = toDeg(Math.atan((params.facadeMidHeightM - params.cameraHeightM) / distanceM));
  return clamp(raw, params.pitchMin, params.pitchMax);
}

/** `estimatedFacadePx = 640 · (2 · atan((W/2)/d)) / fov`, null when W is unknown. */
export function estimatedFacadePx(
  facadeWidthM: number | null | undefined,
  distanceM: number,
  fovDeg: number,
  size = DEFAULT_VIEWPOINT_PARAMETERS.size,
): number | null {
  if (!facadeWidthM || facadeWidthM <= 0 || distanceM <= 0 || fovDeg <= 0) return null;
  return Math.round((size * 2 * toDeg(Math.atan(facadeWidthM / 2 / distanceM))) / fovDeg);
}

/** Rounds to a fixed number of decimals (stable output for URLs and records). */
export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Polygon centroid (area-weighted) of a simple polygon in local meters. */
export function polygonCentroid(points: readonly { x: number; y: number }[]): {
  x: number;
  y: number;
} {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as { x: number; y: number };
    const b = points[(i + 1) % points.length] as { x: number; y: number };
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area) < 1e-9) {
    const n = Math.max(1, points.length);
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / n,
      y: points.reduce((sum, p) => sum + p.y, 0) / n,
    };
  }
  return { x: cx / (3 * area), y: cy / (3 * area) };
}
