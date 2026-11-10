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
