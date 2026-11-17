import type { CapabilityKey, SourceKind } from '@hailiday/core';
import { useAppStore } from '../state/appStore';

export type ImageOrigin = 'street_view' | 'generated' | 'example_after' | 'photo';

/** The path under which the API serves the fixture stand-ins of Street View frames. */
const FIXTURE_STREET_VIEW_PATH = '/fixture/';

function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url, window.location.href).pathname;
  } catch {
    return null;
  }
}

/**
 * Whether an image comes from an integration in fixture mode, so it carries the development
 * "Fixture" badge and is never mistaken for real imagery. Signals: the experience's fixture
 * capability list; a `fixture` source kind; and, for Street View, a display URL of the API's own
 * fixture stand-ins. A frame served by the provider or from the app's storage (the stored frame
 * a look was made from) is real imagery.
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
      return pathOf(options.url)?.startsWith(FIXTURE_STREET_VIEW_PATH) ?? false;
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
