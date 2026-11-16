import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StreetViewAttribution } from './Attribution';
import { attributionParts } from './attributionText';

afterEach(cleanup);

describe('Street View attribution', () => {
  it('shows the Google Maps logo and the credit for live imagery', () => {
    const { container } = render(
      <StreetViewAttribution text="© 2025 Google" logo="google_maps" captureDate="2025-06" />,
    );
    expect(container.textContent).toContain('Google Maps');
    expect(container.textContent).toContain('© 2025 Google');
  });

  it('prints Google Maps once when the credit starts with it and the logo is shown', () => {
    const { container } = render(
      <StreetViewAttribution
        text="Google Maps · © 2026 Google"
        logo="google_maps"
        captureDate="2026-08"
      />,
    );
    const text = container.textContent ?? '';
    expect(text.match(/Google Maps/g)).toHaveLength(1);
    expect(text).toContain('© 2026 Google');
    expect(
      attributionParts({
        text: 'Google Maps · © 2026 Google',
        logo: 'google_maps',
        fixture: false,
      }),
    ).toEqual({ showLogo: true, credit: '© 2026 Google' });
    expect(
      attributionParts({ text: 'Google Maps · © 2026 Google', logo: null, fixture: false }),
    ).toEqual({ showLogo: false, credit: 'Google Maps · © 2026 Google' });
    expect(
      attributionParts({ text: 'Google Maps Imagery', logo: 'google_maps', fixture: false }).credit,
    ).toBe('Google Maps Imagery');
  });

  it("names a contributor's frame after its own copyright holder, never Google", () => {
    for (const text of ['Google Maps · © GIS1 Street Imagery', '© GIS1 Street Imagery']) {
      expect(attributionParts({ text, logo: 'google_maps', fixture: false })).toEqual({
        showLogo: true,
        credit: '© GIS1 Street Imagery',
      });
      const { container, unmount } = render(
        <StreetViewAttribution text={text} logo="google_maps" captureDate="2024-05" />,
      );
      const shown = container.textContent ?? '';
      expect(shown).toContain('© GIS1 Street Imagery');
      expect(shown.match(/Google/g)).toHaveLength(1);
      expect(shown).not.toMatch(/©[^·]*Google/);
      unmount();
    }
  });

  it('prints the fixture photo credit and never names Google next to a fixture photo', () => {
    const { container } = render(
      <StreetViewAttribution
        text="Fixture photo: Ian MacDonald / Unsplash License"
        logo="google_maps"
        captureDate="2025-06"
      />,
    );
    expect(container.textContent).toContain('Fixture photo: Ian MacDonald / Unsplash License');
    expect(container.textContent).not.toMatch(/google/i);
  });

  it('drops Google branding when the source is known to be fixture imagery', () => {
    expect(attributionParts({ text: 'Google Maps', logo: 'google_maps', fixture: true })).toEqual({
      showLogo: false,
      credit: null,
    });
    expect(attributionParts({ text: 'Google Maps', logo: 'google_maps', fixture: false })).toEqual({
      showLogo: true,
      credit: null,
    });
    expect(attributionParts({ text: '© Google', logo: null, fixture: false }).showLogo).toBe(false);
  });
});
