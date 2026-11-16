import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { project, variant } from '../../test/fixtures';
import { useAppStore } from '../../state/appStore';
import { PlaceRow, PlacesPage } from './PlacesPage';

vi.mock('../../api/endpoints', () => ({
  deleteProject: vi.fn(),
  listProjects: vi.fn(),
  listVariants: vi.fn(),
  sendAnalytics: vi.fn(async () => undefined),
  hasSession: vi.fn(() => false),
  onSessionReady: vi.fn(() => () => undefined),
}));

const api = vi.mocked(endpoints);

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderRow(
  latest: ReturnType<typeof variant>,
  overrides: Parameters<typeof project>[0] = {},
): Promise<HTMLElement> {
  api.listVariants.mockResolvedValue({ items: [latest] } as never);
  const { container } = render(
    <MemoryRouter>
      <ul>
        <PlaceRow
          project={project({ saved: true, ...overrides })}
          now={Date.now()}
          onDelete={() => undefined}
        />
      </ul>
    </MemoryRouter>,
  );
  await flush();
  return container;
}

const streetViewLatest = () =>
  variant({
    attribution: { required: true, text: 'Google Maps · © 2026 Google', logo: 'google_maps' },
  });

describe('Your places thumbnail badge', () => {
  async function badgeFor(latest: ReturnType<typeof variant>): Promise<HTMLElement> {
    const container = await renderRow(latest);
    const badge = container.querySelector<HTMLElement>('.place__badge');
    if (!badge) throw new Error('badge missing');
    expect(badge.textContent).toBe('AI preview');
    return badge;
  }

  it('sits in the lower-right corner of an upload-origin preview', async () => {
    const badge = await badgeFor(variant());
    expect(badge.classList.contains('place__badge--lower-right')).toBe(true);
    expect(badge.classList.contains('place__badge--upper-left')).toBe(false);
  });

  it('sits in the upper-left corner of a Street View preview', async () => {
    const badge = await badgeFor(
      variant({ attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' } }),
    );
    expect(badge.classList.contains('place__badge--upper-left')).toBe(true);
    expect(badge.classList.contains('place__badge--lower-right')).toBe(false);
  });
});

describe('Your places Street View credit', () => {
  it('crops a Street View preview from the top and credits Google Maps under the row', async () => {
    const container = await renderRow(streetViewLatest());
    const thumb = container.querySelector('.place__thumb');
    expect(thumb?.classList.contains('place__thumb--street-view')).toBe(true);
    const credit = container.querySelector('.place__text .place__credit');
    expect(credit?.textContent).toContain('Google Maps');
    expect(credit?.textContent).toContain('© 2026 Google');
    expect(credit?.textContent?.match(/Google Maps/g)).toHaveLength(1);
  });

  it('keeps the plain crop and shows no credit for an uploaded photo', async () => {
    const container = await renderRow(variant());
    const thumb = container.querySelector('.place__thumb');
    expect(thumb?.classList.contains('place__thumb--street-view')).toBe(false);
    expect(container.querySelector('.place__credit')).toBeNull();
  });
});

describe('Your places card', () => {
  it.each([
    [3, '3 looks'],
    [1, '1 look'],
  ])('says how many looks a place with %i has', async (count, text) => {
    const container = await renderRow(variant(), { variantCount: count });
    expect(container.querySelector('.place__meta')?.textContent).toContain(text);
  });

  it('says nothing about looks before the first', async () => {
    const container = await renderRow(variant(), { variantCount: 0 });
    expect(container.querySelector('.place__meta')?.textContent).not.toMatch(/look/);
  });

  it('reserves the picture box from the look size and opens the place from the card', async () => {
    const container = await renderRow(variant({ width: 1536, height: 1024 }));
    const image = container.querySelector('.place__thumb img');
    expect(image?.getAttribute('width')).toBe('1536');
    expect(image?.getAttribute('height')).toBe('1024');
    expect(image?.getAttribute('loading')).toBe('lazy');
    const link = container.querySelector<HTMLAnchorElement>('a.place__link');
    expect(link?.getAttribute('href')).toMatch(/^\/p\//);
    // The credit sits under the picture, before the title.
    const credit = await renderRow(streetViewLatest());
    const text = credit.querySelector('.place__text');
    expect(text?.firstElementChild?.classList.contains('place__credit')).toBe(true);
  });
});

describe('Your places card link', () => {
  it('is the whole card above the actions, named by the title and described by the meta line', async () => {
    const container = await renderRow(streetViewLatest(), {
      property: {
        id: '00000000-0000-4000-8000-0000000000aa',
        formattedAddress: '14 Lantern Hill Rd',
        precision: 'rooftop',
        multiUnit: false,
        countryCode: 'US',
      },
    } as never);
    const link = container.querySelector<HTMLAnchorElement>('a.place__link');
    if (!link) throw new Error('link missing');
    expect(link.querySelector('.place__thumb img')).not.toBeNull();
    expect(link.querySelector('.place__credit')).not.toBeNull();
    expect(link.querySelector('.place__meta')).not.toBeNull();
    const title = document.getElementById(link.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('14 Lantern Hill Rd');
    const meta = document.getElementById(link.getAttribute('aria-describedby') ?? '');
    expect(meta?.classList.contains('place__meta')).toBe(true);
    // The actions are outside the link, never nested in it.
    expect(link.querySelector('button, a')).toBeNull();
    expect(container.querySelector('.place__actions button')?.textContent).toBe('Delete');
  });
});

describe('Your places card without a look', () => {
  it('shows an uploaded source photo filling the box, with no badge and no credit', async () => {
    const container = await renderRow(variant(), { variantCount: 0 });
    const thumb = container.querySelector('.place__thumb');
    expect(thumb?.classList.contains('place__thumb--source')).toBe(true);
    const image = thumb?.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://cdn.test/source.jpg');
    expect(image?.getAttribute('alt')).toBe('Your photo');
    expect(image?.getAttribute('width')).toBe('1600');
    expect(image?.getAttribute('loading')).toBe('lazy');
    expect(container.querySelector('.place__badge')).toBeNull();
    expect(container.querySelector('.place__swatch')).toBeNull();
    expect(container.querySelector('.place__credit')).toBeNull();
    expect(api.listVariants).not.toHaveBeenCalled();
  });

  it('shows a Street View frame whole on the stage ground with its Google Maps credit', async () => {
    const container = await renderRow(variant(), {
      variantCount: 0,
      activeSource: {
        sourceAssetId: '00000000-0000-4000-8000-0000000000bb',
        kind: 'street_view',
        state: 'ready',
        sourceMode: 'persist',
        displayUrl: 'https://maps.googleapis.com/maps/api/streetview?size=640x640',
        captureDate: '2024-06',
        copyright: '© 2026 Google',
        isGoogleImagery: true,
        width: 640,
        height: 640,
        peopleDetected: false,
        privateOnly: false,
      },
    } as never);
    const thumb = container.querySelector('.place__thumb');
    expect(thumb?.classList.contains('place__thumb--source-frame')).toBe(true);
    expect(thumb?.classList.contains('place__thumb--street-view')).toBe(false);
    expect(thumb?.querySelector('img')?.getAttribute('alt')).toBe(
      'Street View image of the selected place',
    );
    expect(container.querySelector('.place__badge')).toBeNull();
    const credit = container.querySelector('.place__text .place__credit');
    expect(credit?.textContent).toContain('Google Maps');
    expect(credit?.textContent).toContain('© 2026 Google');
  });

  it('keeps the holiday dot when there is no source photo either', async () => {
    const container = await renderRow(variant(), { variantCount: 0, activeSource: null });
    expect(container.querySelector('.place__thumb img')).toBeNull();
    expect(container.querySelector('.place__swatch')).not.toBeNull();
  });

  it('never shows the source while a place with looks waits for its newest look', async () => {
    api.listVariants.mockReturnValue(new Promise(() => undefined) as never);
    const { container } = render(
      <MemoryRouter>
        <ul>
          <PlaceRow
            project={project({ saved: true, variantCount: 2 })}
            now={Date.now()}
            onDelete={() => undefined}
          />
        </ul>
      </MemoryRouter>,
    );
    await flush();
    expect(container.querySelector('.place__thumb img')).toBeNull();
    expect(container.querySelector('.place__swatch')).not.toBeNull();
  });
});

describe('Your places header', () => {
  it('shows no holiday picker', async () => {
    useAppStore.setState({ pickerHolidayIds: ['christmas', 'thanksgiving_us'] });
    api.listProjects.mockResolvedValue({ items: [], nextCursor: null } as never);
    const { container } = render(
      <MemoryRouter>
        <PlacesPage />
      </MemoryRouter>,
    );
    await flush();
    expect(container.querySelector('.site-header')).not.toBeNull();
    expect(container.querySelector('.holiday-chip')).toBeNull();
    useAppStore.setState({ pickerHolidayIds: [] });
  });
});
