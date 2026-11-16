import type { CapabilityKey, SourceKind } from '@hailiday/core';
import { useAppStore } from '../state/appStore';

export type ImageOrigin = 'street_view' | 'generated' | 'example_after' | 'photo';

const GOOGLE_STREET_VIEW_HOST = 'maps.googleapis.com';

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, window.location.href).host;
  } catch {
    return null;
  }
}

/**
 * Whether an image comes from an integration in fixture mode, so it carries the development
 * "Fixture" badge and is never mistaken for real imagery. Signals: the experience's fixture
 * capability list; a `fixture` source kind; and, for Street View, a display URL that is not
 * served by Google.
 */
export function isFixtureImage(
  origin: ImageOrigin,
  fixtureCapabilities: readonly CapabilityKey[],
  options: { url?: string | null; sourceKind?: SourceKind | null } = {},
): boolean {
  if (options.sourceKind === 'fixture') return true;
  switch (origin) {
    case 'street_view': {
      if (fixtureCapabilities.includes('street_view_display')) return true;
      const host = hostOf(options.url);
      return host !== null && host !== GOOGLE_STREET_VIEW_HOST;
    }
    case 'generated':
    case 'example_after':
      return fixtureCapabilities.includes('image_editing');
    case 'photo':
      return false;
  }
}

export function useIsFixtureImage(
  origin: ImageOrigin,
  options: { url?: string | null; sourceKind?: SourceKind | null } = {},
): boolean {
  const fixtureCapabilities = useAppStore((state) => state.fixtureCapabilities);
  return isFixtureImage(origin, fixtureCapabilities, options);
}

/**
 * Whether Street View-origin imagery is fixture imagery for attribution purposes: the display
 * capability runs in fixture mode or the source is a fixture source. Unlike the badge, this
 * never guesses from the image host, so live imagery always keeps its Google attribution.
 */
export function isFixtureStreetView(
  fixtureCapabilities: readonly CapabilityKey[],
  sourceKind: SourceKind | null | undefined,
): boolean {
  return sourceKind === 'fixture' || fixtureCapabilities.includes('street_view_display');
}

/**
 * Whether address suggestions come from the fixture provider (no Google keys), so the address
 * field offers the sample places and never credits Google for them.
 */
export function useIsFixtureAddressLookup(): boolean {
  return useAppStore((state) => state.fixtureCapabilities.includes('address_lookup'));
}

export function useIsFixtureStreetView(sourceKind?: SourceKind | null): boolean {
  const fixtureCapabilities = useAppStore((state) => state.fixtureCapabilities);
  return isFixtureStreetView(fixtureCapabilities, sourceKind);
}
