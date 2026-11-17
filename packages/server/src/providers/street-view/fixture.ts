import { loadFixtureData, type FixtureData } from '../../fixtures/data.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { ProviderError } from '../errors.js';
import { haversineDistanceM, toLocalMeters, type LatLng } from '../geo.js';
import { signFixtureStreetView, verifyFixtureStreetView } from '../signing.js';
import type { StreetViewMetadata, StreetViewProvider, StreetViewView } from '../types.js';
import { discoverCandidates } from './discover.js';
import { refreshPinnedPanorama } from './refresh.js';

const NONE: Omit<StreetViewMetadata, 'status'> = {
  panoId: null,
  location: null,
  date: null,
  copyright: null,
};

/**
 * Pano IDs with this prefix answer metadata with UNKNOWN_ERROR (a failed revalidation). Unknown
 * pano IDs answer ZERO_RESULTS: a revalidation reports them `replaced` when the viewpoint's
 * location is near a fixture place with imagery, and `missing` otherwise.
 */
export const FIXTURE_METADATA_ERROR_PANO_PREFIX = 'fxSvMetadataError';

/** The path the API serves fixture Street View frames from. */
export const FIXTURE_STREET_VIEW_PATH = '/fixture/streetview';

function format(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

/** Canonical query parameters of a fixture display URL (without the signature). */
export function fixtureStreetViewParams(view: StreetViewView) {
  return {
    pano: view.panoId,
    heading: format(view.heading),
    fov: format(view.fov),
    pitch: format(view.pitch),
    size: `${view.width}x${view.height}`,
  };
}

/** Builds the signed app URL that serves a fixture frame (signed with `SESSION_SECRET`). */
export function buildFixtureDisplayUrl(
  publicBaseUrl: string,
  secret: string,
  view: StreetViewView,
): string {
  const params = fixtureStreetViewParams(view);
  const query = new URLSearchParams({ ...params, sig: signFixtureStreetView(secret, params) });
  return `${publicBaseUrl.replace(/\/+$/, '')}${FIXTURE_STREET_VIEW_PATH}?${query.toString()}`;
}

/**
 * Parses and verifies the query of a fixture display URL. Returns the view, or null when a
 * parameter is missing, out of range or the signature does not match.
 */
export function verifyFixtureDisplayQuery(
  secret: string,
  query: Record<string, string | undefined>,
): StreetViewView | null {
  const { pano, heading, fov, pitch, size, sig } = query;
  if (!pano || !heading || !fov || !pitch || !size || !sig) return null;
  if (!verifyFixtureStreetView(secret, { pano, heading, fov, pitch, size, sig })) return null;
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  const view = {
    panoId: pano,
    heading: Number(heading),
    fov: Number(fov),
    pitch: Number(pitch),
    width: Number(match?.[1]),
    height: Number(match?.[2]),
  };
  if (!match || view.width > 640 || view.height > 640) return null;
  if (![view.heading, view.fov, view.pitch].every(Number.isFinite)) return null;
  return view;
}

/**
 * Fixture Street View: contract-shaped metadata from `fixtures/places.json` (every status,
 * Google and contributor copyright, year-only and absent dates), signed app URLs for display,
 * and procedurally rendered frames for transient fetches. Nothing is written to storage.
 */
export function createFixtureStreetViewProvider(options: {
  publicBaseUrl: string;
  sessionSecret: string;
  data?: FixtureData;
  retryDelayMs?: number;
}): StreetViewProvider {
  const data = () => options.data ?? loadFixtureData();

  const metadataByLocation = async (input: {
    location: LatLng;
    radiusM: number;
  }): Promise<StreetViewMetadata> => {
    let nearest: { place: ReturnType<FixtureData['placeById']>; distance: number } | null = null;
    for (const place of data().places) {
      const target = place.destinations.targetPoint ?? place.location;
      const distance = haversineDistanceM(target, input.location);
      if (distance <= 80 && (!nearest || distance < nearest.distance))
        nearest = { place, distance };
    }
    const place = nearest?.place;
    if (!place) return { status: 'ZERO_RESULTS', ...NONE };
    if (place.metadataStatus === 'UNKNOWN_ERROR') return { status: 'UNKNOWN_ERROR', ...NONE };
    if (place.metadataStatus === 'ZERO_RESULTS' || place.panoramas.length === 0) {
      return { status: 'ZERO_RESULTS', ...NONE };
    }
    if (place.panoramaLookup === 'nearest') {
      // The panorama nearest the probed point within the radius (the first in file order on a
      // tie); probe labels and probe radii play no part.
      let closest: { panorama: (typeof place.panoramas)[number]; distance: number } | null = null;
      for (const candidate of place.panoramas) {
        const distance = haversineDistanceM(candidate.location, input.location);
        if (distance <= input.radiusM && (!closest || distance < closest.distance))
          closest = { panorama: candidate, distance };
      }
      if (!closest) return { status: 'ZERO_RESULTS', ...NONE };
      return {
        status: 'OK',
        panoId: closest.panorama.panoId,
        location: closest.panorama.location,
        date: closest.panorama.captureDate,
        copyright: closest.panorama.copyright,
      };
    }
    const target = place.destinations.targetPoint ?? place.location;
    let panorama = place.panoramas.find((candidate) => candidate.probe === 'target');
    if ((nearest?.distance ?? 0) > 1) {
      const bearing = ((place.destinations.roadBearingDeg ?? 90) * Math.PI) / 180;
      const local = toLocalMeters(target, input.location);
      const along = local.x * Math.sin(bearing) + local.y * Math.cos(bearing);
      const label = `offset_${along >= 0 ? '+' : '-'}${Math.round(Math.abs(along))}m`;
      panorama = place.panoramas.find((candidate) => candidate.probe === label) ?? panorama;
    }
    if (!panorama || panorama.probeRadiusM > input.radiusM)
      return { status: 'ZERO_RESULTS', ...NONE };
    return {
      status: 'OK',
      panoId: panorama.panoId,
      location: panorama.location,
      date: panorama.captureDate,
      copyright: panorama.copyright,
    };
  };

  const metadataByPano = async (panoId: string): Promise<StreetViewMetadata> => {
    if (panoId.startsWith(FIXTURE_METADATA_ERROR_PANO_PREFIX)) {
      return { status: 'UNKNOWN_ERROR', ...NONE };
    }
    const found = data().panorama(panoId);
    if (!found) return { status: 'ZERO_RESULTS', ...NONE };
    return {
      status: 'OK',
      panoId,
      location: found.panorama.location,
      date: found.panorama.captureDate,
      copyright: found.panorama.copyright,
    };
  };

  return {
    providerId: 'fixture-street-view',
    mode: 'fixture',
    metadataByLocation,
    metadataByPano,
    discoverCandidates(input, callOptions) {
      return discoverCandidates(
        (location, radiusM) => metadataByLocation({ location, radiusM }),
        input,
        {
          budgetMs: callOptions?.budgetMs ?? 6000,
          retryDelayMs: options.retryDelayMs ?? 50,
        },
      );
    },
    buildDisplayUrl(view) {
      return buildFixtureDisplayUrl(options.publicBaseUrl, options.sessionSecret, view);
    },
    async fetchTransient(view) {
      const rendered = await renderFixturePanorama(view);
      if (!rendered) {
        throw new ProviderError('fixture-street-view', 'not_found', 'Unknown fixture panorama', {
          retryable: false,
        });
      }
      return {
        bytes: rendered.image,
        checksum: rendered.checksum,
        width: view.width,
        height: view.height,
        contentType: 'image/jpeg',
        providerMode: 'fixture',
        fetchedAt: new Date(),
      };
    },
    refreshPanorama(panoId, callOptions) {
      return refreshPinnedPanorama(
        panoId,
        callOptions?.location,
        {
          byPano: metadataByPano,
          byLocation: (location, radiusM) => metadataByLocation({ location, radiusM }),
        },
        callOptions?.locationRadiusM,
      );
    },
  };
}
