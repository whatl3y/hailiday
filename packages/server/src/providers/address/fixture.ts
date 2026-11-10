import { randomUUID } from 'node:crypto';
import type { AddressSuggestion, GeocodeRequest } from '@holiday/core';
import { loadFixtureData, type FixtureData, type FixturePlace } from '../../fixtures/data.js';
import type {
  AddressProvider,
  DestinationGeometry,
  GeocodeSignal,
  ResolvedPlace,
  SignedGeocodeCandidate,
} from '../types.js';
import {
  MAX_GEOCODE_CANDIDATES,
  MIN_SUGGEST_QUERY_LENGTH,
  candidatePayload,
  normalizeAddressText,
  signGeocodeCandidate,
  verifyGeocodeCandidate,
} from './signals.js';

function resolvedOf(place: FixturePlace): ResolvedPlace {
  return {
    placeId: place.placeId,
    formattedAddress: place.formattedAddress,
    addressComponents: place.addressComponents.map(({ longText, shortText, types }) => ({
      longText,
      shortText,
      types,
    })),
    countryCode: place.countryCode,
    location: place.location,
    viewport: place.viewport ?? null,
    types: place.types,
  };
}

function geocodeOf(place: FixturePlace, partialMatch: boolean): GeocodeSignal {
  return {
    placeId: place.placeId,
    formattedAddress: place.formattedAddress,
    addressComponents: place.addressComponents.map(({ longText, shortText, types }) => ({
      longText,
      shortText,
      types,
    })),
    countryCode: place.countryCode,
    location: place.location,
    locationType: place.geocode.locationType,
    partialMatch: partialMatch || place.geocode.partialMatch,
    types: place.types,
  };
}

/**
 * Fixture address provider over `fixtures/places.json`: suggestions by text match (the non-US
 * entry is included so the out-of-scope path is reachable), Essentials-shaped details,
 * Geocoding signals, manual-entry aliases and SearchDestinations-shaped geometry.
 */
export function createFixtureAddressProvider(options: {
  sessionSecret: string;
  data?: FixtureData;
}): AddressProvider {
  const data = () => options.data ?? loadFixtureData();
  return {
    providerId: 'fixture-address',
    mode: 'fixture',

    async suggest(input) {
      const sessionToken = input.sessionToken ?? randomUUID();
      const query = normalizeAddressText(input.query);
      if (input.query.trim().length < MIN_SUGGEST_QUERY_LENGTH) {
        return { sessionToken, suggestions: [], called: false };
      }
      const tokens = query.split(' ').filter(Boolean);
      const suggestions: AddressSuggestion[] = [];
      for (const place of data().places) {
        const haystack = normalizeAddressText(
          `${place.formattedAddress} ${place.geocodeAliases.join(' ')}`,
        );
        const words = haystack.split(' ');
        const matches = tokens.every((token) => words.some((word) => word.startsWith(token)));
        if (matches || haystack.includes(query)) {
          suggestions.push({
            placeId: place.placeId,
            primaryText: place.primaryText,
            secondaryText: place.secondaryText,
          });
        }
        if (suggestions.length >= 5) break;
      }
      return { sessionToken, suggestions, called: true };
    },

    async resolve(input) {
      const place = data().placeById(input.placeId);
      return place ? resolvedOf(place) : null;
    },

    async geocodeByPlaceId(placeId) {
      const place = data().placeById(placeId);
      return place ? geocodeOf(place, false) : null;
    },

    async geocode(request: GeocodeRequest, context) {
      const line1 = normalizeAddressText(request.line1);
      const line2 = request.line2 ? normalizeAddressText(request.line2) : '';
      const typed = new Set([line1, line2 ? `${line1} ${line2}` : line1]);
      const results: SignedGeocodeCandidate[] = [];
      for (const place of data().places) {
        if (!place.geocodeAliases.some((alias) => typed.has(normalizeAddressText(alias)))) continue;
        const entry = place.manualEntry;
        const partial =
          normalizeAddressText(entry.city) !== normalizeAddressText(request.city) ||
          normalizeAddressText(entry.state) !== normalizeAddressText(request.state) ||
          entry.postalCode.slice(0, 5) !== request.postalCode.slice(0, 5);
        const payload = candidatePayload(geocodeOf(place, partial), line2 || null);
        const { token, expiresAt } = signGeocodeCandidate(options.sessionSecret, payload, context);
        results.push({
          payload,
          candidate: {
            candidateId: token,
            formattedAddress: payload.formattedAddress,
            precision: payload.precision,
            partialMatch: payload.partialMatch,
            multiUnit: payload.multiUnit,
            expiresAt: expiresAt.toISOString(),
          },
        });
        if (results.length >= MAX_GEOCODE_CANDIDATES) break;
      }
      return results;
    },

    verifyCandidate(token, context) {
      return verifyGeocodeCandidate(options.sessionSecret, token, context);
    },

    async searchDestinations(placeId): Promise<DestinationGeometry | null> {
      const place = data().placeById(placeId);
      if (!place) return null;
      return { ...place.destinations };
    },
  };
}
