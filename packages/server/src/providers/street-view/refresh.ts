import type { LatLng } from '../geo.js';
import type { RefreshPanoramaResult, StreetViewMetadata } from '../types.js';
import { METADATA_ERROR_STATUSES } from './discover.js';

/**
 * Radius of the location probe that looks for newer imagery when a pinned pano is gone, when the
 * probed location is where the panorama was taken.
 */
export const REFRESH_LOCATION_RADIUS_M = 15;

/**
 * Radius of that probe when the probed location is the property's target point: above the first
 * step of the discovery radius ladder (50 m), so a panorama at the distance discovery finds one
 * from the target answers the probe.
 */
export const REFRESH_TARGET_POINT_RADIUS_M = 60;

export interface RefreshProbes {
  byPano(panoId: string): Promise<StreetViewMetadata>;
  byLocation(location: LatLng, radiusM: number): Promise<StreetViewMetadata>;
}

/**
 * Revalidates a pinned panorama from free metadata calls. The pano ID is queried first: OK with
 * the same ID is `unchanged`; an error status (quota, denied, invalid request, unknown error,
 * network failure or a non-200 answer, which the adapters report as UNKNOWN_ERROR) is `error`.
 * Only ZERO_RESULTS or NOT_FOUND mean the pano is gone; then, when the viewpoint's location is
 * known, an outdoor probe at that spot tells newer imagery under another pano ID (`replaced`,
 * with that metadata) from a removal (`missing`). A failed location probe, or one that still
 * answers with the pinned pano, is `error`: neither proves a removal.
 */
export async function refreshPinnedPanorama(
  panoId: string,
  location: LatLng | null | undefined,
  probes: RefreshProbes,
  radiusM: number = REFRESH_LOCATION_RADIUS_M,
): Promise<RefreshPanoramaResult> {
  const current = await probes.byPano(panoId);
  if (current.status === 'OK') {
    if (current.panoId === panoId) return { status: 'unchanged', metadata: current };
    if (current.panoId) return { status: 'replaced', metadata: current };
    return { status: 'error', metadata: current };
  }
  if (current.status !== 'ZERO_RESULTS' && current.status !== 'NOT_FOUND') {
    return { status: 'error', metadata: current };
  }
  if (!location) return { status: 'missing', metadata: current };
  const nearby = await probes.byLocation(location, radiusM);
  if (nearby.status === 'OK') {
    if (nearby.panoId && nearby.panoId !== panoId) return { status: 'replaced', metadata: nearby };
    return { status: 'error', metadata: nearby };
  }
  if (METADATA_ERROR_STATUSES.includes(nearby.status)) return { status: 'error', metadata: nearby };
  return { status: 'missing', metadata: current };
}
