import { randomUUID } from 'node:crypto';
import type { AddressSuggestion } from '@hailiday/core';
import type { Logger } from '../../logger/index.js';
import {
  diagnosticFields,
  googleErrorDiagnostics,
  logProviderFailure,
  redactProviderText,
} from '../diagnostics.js';
import { ProviderError, kindForHttpStatus } from '../errors.js';
import type { LatLng } from '../geo.js';
import { providerFetch, type FetchLike, type ProviderResponse } from '../http.js';
import type {
  AddressComponent,
  AddressProvider,
  CallOptions,
  DestinationGeometry,
  GeocodeLocationType,
  GeocodeSignal,
  ResolvedPlace,
  SignedGeocodeCandidate,
} from '../types.js';
import {
  MAX_GEOCODE_CANDIDATES,
  MIN_SUGGEST_QUERY_LENGTH,
  SUGGESTION_PRIMARY_TYPES,
  candidatePayload,
  countryCodeOf,
  geometryFromOutline,
  signGeocodeCandidate,
  verifyGeocodeCandidate,
} from './signals.js';

const PROVIDER = 'google-address';
const PLACES_BASE = 'https://places.googleapis.com/v1';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DESTINATIONS_URL = 'https://geocode.googleapis.com/v4/geocode/destinations';
/** Essentials fields only: never an IDs-only mask and never a Pro or Enterprise field. */
export const PLACE_DETAILS_FIELD_MASK =
  'location,formattedAddress,addressComponents,viewport,types';
/** Region restriction for the US Release. */
export const INCLUDED_REGION_CODES = ['us'] as const;

interface PlacesComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

interface GeocodeApiResult {
  place_id: string;
  formatted_address: string;
  address_components: { long_name: string; short_name: string; types: string[] }[];
  geometry: { location: { lat: number; lng: number }; location_type: GeocodeLocationType };
  partial_match?: boolean;
  types: string[];
}

interface FailureContext {
  logger: Logger | undefined;
  secrets: readonly string[];
}

function logged(context: FailureContext, operation: string, error: ProviderError): ProviderError {
  logProviderFailure(
    context.logger,
    { provider: PROVIDER, operation, httpStatus: error.httpStatus, kind: error.kind },
    {
      ...(error.providerCode ? { code: error.providerCode } : {}),
      ...(error.providerMessage ? { message: error.providerMessage } : {}),
      ...(error.providerParam ? { param: error.providerParam } : {}),
    },
  );
  return error;
}

function failIfError(response: ProviderResponse, what: string, context: FailureContext): void {
  if (response.status >= 200 && response.status < 300) return;
  const { kind, retryable } = kindForHttpStatus(response.status);
  throw logged(
    context,
    what,
    new ProviderError(PROVIDER, kind === 'not_found' ? 'provider_error' : kind, `${what} failed`, {
      retryable,
      httpStatus: response.status,
      ...diagnosticFields(googleErrorDiagnostics(response.bytes, context.secrets)),
    }),
  );
}

function geocodeStatusError(
  status: string,
  errorMessage: string | undefined,
  context: FailureContext,
): ProviderError {
  const retryable = status === 'OVER_QUERY_LIMIT' || status === 'UNKNOWN_ERROR';
  return logged(
    context,
    'Geocoding',
    new ProviderError(PROVIDER, 'provider_error', `Geocoding status ${status}`, {
      retryable,
      providerCode: status,
      ...(errorMessage
        ? { providerMessage: redactProviderText(errorMessage, context.secrets) }
        : {}),
    }),
  );
}

function toSignal(result: GeocodeApiResult): GeocodeSignal {
  const addressComponents: AddressComponent[] = result.address_components.map((component) => ({
    longText: component.long_name,
    shortText: component.short_name,
    types: component.types,
  }));
  return {
    placeId: result.place_id,
    formattedAddress: result.formatted_address,
    addressComponents,
    countryCode: countryCodeOf(addressComponents),
    location: { latitude: result.geometry.location.lat, longitude: result.geometry.location.lng },
    locationType: result.geometry.location_type,
    partialMatch: result.partial_match === true,
    types: result.types,
  };
}

/** GeoJSON polygon coordinates (`[lng, lat]`) to points. */
function ringOf(polygon: unknown): LatLng[] {
  const coordinates = (polygon as { coordinates?: unknown } | null)?.coordinates;
  const ring = Array.isArray(coordinates) ? coordinates[0] : null;
  if (!Array.isArray(ring)) return [];
  return ring
    .filter((pair): pair is [number, number] => Array.isArray(pair) && pair.length >= 2)
    .map(([longitude, latitude]) => ({ latitude, longitude }));
}

/**
 * Live address provider: Places Autocomplete (New) restricted to address types (unrestricted
 * when Google rejects the restriction) and Place Details (New) with the server key, the Geocoding
 * API, and Geocoding v4 SearchDestinations.
 */
export function createGoogleAddressProvider(options: {
  serverKey: string;
  sessionSecret: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Receives a warn line with the redacted vendor diagnostics of every failed call. */
  logger?: Logger;
}): AddressProvider {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const timeoutMs = options.timeoutMs ?? 5000;
  const failure: FailureContext = { logger: options.logger, secrets: [options.serverKey] };
  /** Whether Google has rejected the suggestion type restriction (logged once). */
  let typeRestrictionRejected = false;
  const call = (url: string, init: RequestInit, callOptions?: CallOptions) =>
    providerFetch(fetchImpl, url, init, {
      provider: PROVIDER,
      timeoutMs: callOptions?.timeoutMs ?? timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
    });
  const geocodeQuery = async (params: URLSearchParams, callOptions?: CallOptions) => {
    params.set('key', options.serverKey);
    const response = await call(
      `${GEOCODE_URL}?${params.toString()}`,
      { method: 'GET' },
      callOptions,
    );
    failIfError(response, 'Geocoding', failure);
    const body = response.json<{
      status: string;
      error_message?: string;
      results?: GeocodeApiResult[];
    }>();
    if (body.status === 'ZERO_RESULTS') return [];
    if (body.status !== 'OK') throw geocodeStatusError(body.status, body.error_message, failure);
    return body.results ?? [];
  };

  return {
    providerId: PROVIDER,
    mode: 'live',

    async suggest(input, callOptions) {
      const sessionToken = input.sessionToken ?? randomUUID();
      const query = input.query.trim();
      if (query.length < MIN_SUGGEST_QUERY_LENGTH)
        return { sessionToken, suggestions: [], called: false };
      const send = (restricted: boolean) =>
        call(
          `${PLACES_BASE}/places:autocomplete`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': options.serverKey,
              'X-Goog-FieldMask':
                'suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat',
            },
            body: JSON.stringify({
              input: query,
              sessionToken,
              includedRegionCodes: INCLUDED_REGION_CODES,
              ...(restricted ? { includedPrimaryTypes: SUGGESTION_PRIMARY_TYPES } : {}),
            }),
          },
          callOptions,
        );
      let response = await send(true);
      if (response.status === 400) {
        // The type restriction was rejected: ask again without it (the place-type gate still
        // refuses a place that is not an address after selection), and say so once.
        if (!typeRestrictionRejected) {
          typeRestrictionRejected = true;
          logProviderFailure(
            options.logger,
            {
              provider: PROVIDER,
              operation: 'Autocomplete type restriction',
              httpStatus: 400,
              kind: 'invalid_request',
            },
            googleErrorDiagnostics(response.bytes, failure.secrets),
          );
        }
        response = await send(false);
      }
      failIfError(response, 'Autocomplete', failure);
      const body = response.json<{
        suggestions?: {
          placePrediction?: {
            placeId?: string;
            structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
          };
        }[];
      }>();
      const suggestions: AddressSuggestion[] = [];
      for (const item of body.suggestions ?? []) {
        const prediction = item.placePrediction;
        if (!prediction?.placeId) continue;
        suggestions.push({
          placeId: prediction.placeId,
          primaryText: prediction.structuredFormat?.mainText?.text ?? '',
          secondaryText: prediction.structuredFormat?.secondaryText?.text ?? '',
        });
      }
      return { sessionToken, suggestions, called: true };
    },

    async resolve(input, callOptions) {
      const url = `${PLACES_BASE}/places/${encodeURIComponent(input.placeId)}?sessionToken=${encodeURIComponent(input.sessionToken)}`;
      const response = await call(
        url,
        {
          method: 'GET',
          headers: {
            'X-Goog-Api-Key': options.serverKey,
            'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK,
          },
        },
        callOptions,
      );
      if (response.status === 404) return null;
      failIfError(response, 'Place Details', failure);
      const body = response.json<{
        formattedAddress?: string;
        addressComponents?: PlacesComponent[];
        location?: LatLng;
        viewport?: { low: LatLng; high: LatLng };
        types?: string[];
      }>();
      const addressComponents = (body.addressComponents ?? []).map((component) => ({
        longText: component.longText ?? '',
        shortText: component.shortText ?? '',
        types: component.types ?? [],
      }));
      const place: ResolvedPlace = {
        placeId: input.placeId,
        formattedAddress: body.formattedAddress ?? '',
        addressComponents,
        countryCode: countryCodeOf(addressComponents),
        location: body.location ?? { latitude: 0, longitude: 0 },
        viewport: body.viewport ?? null,
        types: body.types ?? [],
      };
      return place;
    },

    async geocodeByPlaceId(placeId, callOptions) {
      const results = await geocodeQuery(new URLSearchParams({ place_id: placeId }), callOptions);
      return results[0] ? toSignal(results[0]) : null;
    },

    async geocode(request, context, callOptions) {
      const address = [
        request.line1,
        request.line2,
        request.city,
        `${request.state} ${request.postalCode}`,
      ]
        .filter((part) => part && part.trim())
        .join(', ');
      const results = await geocodeQuery(
        new URLSearchParams({ address, components: 'country:US' }),
        callOptions,
      );
      const unit = request.line2?.trim() || null;
      return results.slice(0, MAX_GEOCODE_CANDIDATES).map((result): SignedGeocodeCandidate => {
        const payload = candidatePayload(toSignal(result), unit);
        const { token, expiresAt } = signGeocodeCandidate(options.sessionSecret, payload, context);
        return {
          payload,
          candidate: {
            candidateId: token,
            formattedAddress: payload.formattedAddress,
            precision: payload.precision,
            partialMatch: payload.partialMatch,
            multiUnit: payload.multiUnit,
            expiresAt: expiresAt.toISOString(),
          },
        };
      });
    },

    verifyCandidate(token, context) {
      return verifyGeocodeCandidate(options.sessionSecret, token, context);
    },

    async searchDestinations(placeId, callOptions): Promise<DestinationGeometry | null> {
      // Request and response shapes follow the SearchDestinations reference as read; the launch
      // stage and residential outline coverage are unverified, so parsing is defensive and any
      // missing field degrades to "no geometry".
      const response = await call(
        DESTINATIONS_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': options.serverKey,
            'X-Goog-FieldMask':
              'destinations.primary,destinations.entrances,destinations.containingPlaces,destinations.subDestinations',
          },
          body: JSON.stringify({ place: `places/${placeId}` }),
        },
        callOptions,
      );
      if (response.status === 404) return null;
      failIfError(response, 'SearchDestinations', failure);
      const body = response.json<{
        destinations?: {
          primary?: { structureType?: string; displayPolygon?: unknown };
          entrances?: { location?: LatLng; tags?: string[] }[];
          subDestinations?: { structureType?: string; displayPolygon?: unknown }[];
        }[];
      }>();
      const destination = body.destinations?.[0];
      if (!destination?.primary) return null;
      const structureType =
        destination.primary.structureType === 'BUILDING' ||
        destination.primary.structureType === 'GROUNDS'
          ? destination.primary.structureType
          : null;
      const entrance =
        destination.entrances?.find((item) => item.tags?.includes('PREFERRED'))?.location ??
        destination.entrances?.[0]?.location ??
        null;
      const neighbors = (body.destinations ?? [])
        .slice(1)
        .map((item) => ringOf(item.primary?.displayPolygon))
        .filter((ring) => ring.length >= 3);
      return geometryFromOutline({
        polygon: ringOf(destination.primary.displayPolygon),
        entrance,
        neighbors,
        structureType,
      });
    },
  };
}
