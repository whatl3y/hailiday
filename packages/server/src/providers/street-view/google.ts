import { sha256Hex } from '../../ids/index.js';
import type { Logger } from '../../logger/index.js';
import { diagnosticFields, googleErrorDiagnostics, logProviderFailure } from '../diagnostics.js';
import { ProviderError, kindForHttpStatus } from '../errors.js';
import type { LatLng } from '../geo.js';
import { providerFetch, type FetchLike } from '../http.js';
import { signGoogleUrl } from '../signing.js';
import {
  METADATA_STATUSES,
  type CallOptions,
  type MetadataStatus,
  type StreetViewMetadata,
  type StreetViewProvider,
  type StreetViewView,
} from '../types.js';
import { discoverCandidates } from './discover.js';
import { refreshPinnedPanorama } from './refresh.js';

const PROVIDER = 'google-street-view';
export const STREET_VIEW_STATIC_URL = 'https://maps.googleapis.com/maps/api/streetview';
const METADATA_URL = 'https://maps.googleapis.com/maps/api/streetview/metadata';

const fixed = (value: number) => (Math.round(value * 10) / 10).toFixed(1);

/**
 * Builds a signed Street View Static URL by panorama ID with explicit heading, pitch, fov and
 * size and `return_error_code=true`. The URL never contains an address or coordinates.
 */
export function buildStaticUrl(view: StreetViewView, key: string, signingSecret: string): string {
  const params = new URLSearchParams({
    size: `${view.width}x${view.height}`,
    pano: view.panoId,
    heading: fixed(view.heading),
    pitch: fixed(view.pitch),
    fov: fixed(view.fov),
    return_error_code: 'true',
    key,
  });
  return signGoogleUrl(`${STREET_VIEW_STATIC_URL}?${params.toString()}`, signingSecret);
}

/**
 * Live Street View provider: free metadata with the server key, browser display URLs signed
 * with the browser key, and transient pixel fetches with the server key. Pixels are returned
 * in memory only; persisting them is the caller's decision under the asset policy.
 */
export function createGoogleStreetViewProvider(options: {
  serverKey: string;
  browserKey: string;
  signingSecret: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Receives a warn line with the redacted vendor diagnostics of every failed call. */
  logger?: Logger;
}): StreetViewProvider {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 5000;
  const secrets = [options.serverKey, options.browserKey, options.signingSecret];

  const metadata = async (
    params: URLSearchParams,
    callOptions?: CallOptions,
  ): Promise<StreetViewMetadata> => {
    params.set('key', options.serverKey);
    const url = signGoogleUrl(`${METADATA_URL}?${params.toString()}`, options.signingSecret);
    let response;
    try {
      response = await providerFetch(
        fetchImpl,
        url,
        { method: 'GET' },
        {
          provider: PROVIDER,
          timeoutMs: callOptions?.timeoutMs ?? timeoutMs,
          maxBytes: 64 * 1024,
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        },
      );
    } catch {
      return { status: 'UNKNOWN_ERROR', panoId: null, location: null, date: null, copyright: null };
    }
    if (response.status !== 200) {
      logProviderFailure(
        options.logger,
        {
          provider: PROVIDER,
          operation: 'Street View metadata',
          httpStatus: response.status,
          kind: kindForHttpStatus(response.status).kind,
        },
        googleErrorDiagnostics(response.bytes, secrets),
      );
      return { status: 'UNKNOWN_ERROR', panoId: null, location: null, date: null, copyright: null };
    }
    const body = response.json<{
      status?: string;
      pano_id?: string;
      location?: { lat: number; lng: number };
      date?: string;
      copyright?: string;
    }>();
    const status = (METADATA_STATUSES as readonly string[]).includes(body.status ?? '')
      ? (body.status as MetadataStatus)
      : 'UNKNOWN_ERROR';
    return {
      status,
      panoId: body.pano_id ?? null,
      location: body.location
        ? { latitude: body.location.lat, longitude: body.location.lng }
        : null,
      date: body.date ?? null,
      copyright: body.copyright ?? null,
    };
  };

  const metadataByLocation = (
    input: { location: LatLng; radiusM: number },
    callOptions?: CallOptions,
  ) =>
    metadata(
      new URLSearchParams({
        location: `${input.location.latitude.toFixed(7)},${input.location.longitude.toFixed(7)}`,
        radius: String(Math.round(input.radiusM)),
        source: 'outdoor',
      }),
      callOptions,
    );
  const metadataByPano = (panoId: string, callOptions?: CallOptions) =>
    metadata(new URLSearchParams({ pano: panoId }), callOptions);

  return {
    providerId: PROVIDER,
    mode: 'live',
    metadataByLocation,
    metadataByPano,
    discoverCandidates(input, callOptions) {
      return discoverCandidates(
        (location, radiusM) => metadataByLocation({ location, radiusM }, callOptions),
        input,
        {
          budgetMs: callOptions?.budgetMs ?? 6000,
        },
      );
    },
    buildDisplayUrl(view) {
      return buildStaticUrl(view, options.browserKey, options.signingSecret);
    },
    async fetchTransient(view, callOptions) {
      const url = buildStaticUrl(view, options.serverKey, options.signingSecret);
      const response = await providerFetch(
        fetchImpl,
        url,
        { method: 'GET' },
        {
          provider: PROVIDER,
          timeoutMs: callOptions?.timeoutMs ?? 10_000,
          maxBytes: 4 * 1024 * 1024,
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        },
      );
      if (response.status !== 200) {
        const { kind, retryable } = kindForHttpStatus(response.status);
        const diagnostics = googleErrorDiagnostics(response.bytes, secrets);
        logProviderFailure(
          options.logger,
          {
            provider: PROVIDER,
            operation: 'Street View Static',
            httpStatus: response.status,
            kind,
          },
          diagnostics,
        );
        throw new ProviderError(PROVIDER, kind, 'Street View Static fetch failed', {
          retryable,
          httpStatus: response.status,
          ...diagnosticFields(diagnostics),
        });
      }
      return {
        bytes: response.bytes,
        checksum: sha256Hex(response.bytes),
        width: view.width,
        height: view.height,
        contentType: response.headers.get('content-type') ?? 'image/jpeg',
        providerMode: 'live',
        fetchedAt: new Date(),
      };
    },
    refreshPanorama(panoId, callOptions) {
      const { location, locationRadiusM, ...call } = callOptions ?? {};
      return refreshPinnedPanorama(
        panoId,
        location,
        {
          byPano: (id) => metadataByPano(id, call),
          byLocation: (at, radiusM) => metadataByLocation({ location: at, radiusM }, call),
        },
        locationRadiusM,
      );
    },
  };
}
