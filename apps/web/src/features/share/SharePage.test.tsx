import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ShareView } from '@hailiday/core';
import { getShare } from '../../api/endpoints';
import shareCss from './share.css?raw';
import { SharePage } from './SharePage';

vi.mock('../../api/endpoints', () => ({
  getShare: vi.fn(),
  createReport: vi.fn(),
  sendAnalytics: vi.fn(async () => undefined),
  hasSession: vi.fn(() => false),
  onSessionReady: vi.fn(() => () => undefined),
}));

const TOKEN = 'share-token';

function view(overrides: Partial<ShareView> = {}): ShareView {
  return {
    holidayId: 'christmas',
    style: 'classic',
    imageUrl: 'https://cdn.test/after.jpg',
    beforeImageUrl: null,
    width: 1600,
    height: 1200,
    labelKey: 'result.aiPreview',
    attribution: null,
    createdAt: '2026-11-09T12:00:00.000Z',
    expiresAt: '2026-12-09T12:00:00.000Z',
    report: { targetKind: 'share' },
    ...overrides,
  };
}

/** Renders the share page from the inline share data the server shell carries. */
function renderShare(shared: ShareView) {
  const script = document.createElement('script');
  script.type = 'application/json';
  script.id = 'share';
  script.textContent = JSON.stringify({ status: 'active', token: TOKEN, view: shared });
  document.body.appendChild(script);
  return render(
    <MemoryRouter initialEntries={[`/s/${TOKEN}`]}>
      <Routes>
        <Route path="/s/:token" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  document.getElementById('share')?.remove();
});

describe('SharePage AI preview badge', () => {
  function corner(container: HTMLElement): HTMLElement {
    const element = container.querySelector<HTMLElement>('.image-card__corner');
    if (!element) throw new Error('badge corner missing');
    return element;
  }

  it('sits in the lower-right corner of an upload-origin share', () => {
    const { container } = renderShare(view());
    expect(corner(container).classList.contains('image-card__corner--lower-right')).toBe(true);
    expect(corner(container).classList.contains('image-card__corner--upper-left')).toBe(false);
  });

  it('sits in the upper-left corner of a Street View share, off its logo and copyright', () => {
    const { container } = renderShare(
      view({ attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' } }),
    );
    const element = corner(container);
    expect(element.classList.contains('image-card__corner--upper-left')).toBe(true);
    expect(element.classList.contains('image-card__corner--lower-right')).toBe(false);
  });
});

describe('SharePage taking over the server-painted page', () => {
  it('continues the picture the server painted instead of playing its entrance again', () => {
    const { container } = renderShare(view());
    const shared = container.querySelector<HTMLElement>('.shared');
    expect(shared?.classList.contains('shared--continues')).toBe(true);
    // It carries how long the painted page has been on screen, so the arrival continues there.
    expect(shared?.style.getPropertyValue('--share-elapsed')).toMatch(/^\d+ms$/);
    const plain = shareCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.shared--continues \.shared__stage \.stage__picture\s*\{([^}]*)\}/.exec(plain);
    expect(rule?.[1]).toMatch(/animation-delay: calc\(-1 \* var\(--share-elapsed, 1200ms\)\);/);
  });

  it('plays the entrance when the app loads the share itself', async () => {
    vi.mocked(getShare).mockResolvedValue(view());
    const { container } = render(
      <MemoryRouter initialEntries={[`/s/${TOKEN}`]}>
        <Routes>
          <Route path="/s/:token" element={<SharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.shared')).not.toBeNull());
    expect(container.querySelector('.shared')?.classList.contains('shared--continues')).toBe(false);
    expect(
      container.querySelector<HTMLElement>('.shared')?.style.getPropertyValue('--share-elapsed'),
    ).toBe('');
  });
});

describe('SharePage picture on a stage', () => {
  it('shows the picture on a viewport stage at its natural size, the rendering as its ambient', () => {
    const { container } = renderShare(view());
    const shared = container.querySelector<HTMLElement>('.shared.stage-scope')!;
    expect(shared.style.getPropertyValue('--stage-w')).toBe('1600');
    expect(shared.style.getPropertyValue('--stage-h')).toBe('1200');
    const stage = shared.querySelector<HTMLElement>('.stage.stage--viewport.shared__stage')!;
    expect(stage.style.getPropertyValue('--stage-w')).toBe('1600');
    const ambient = stage.querySelector('.stage__ambient');
    expect(ambient?.getAttribute('aria-hidden')).toBe('true');
    expect(ambient?.querySelector('img')?.getAttribute('src')).toBe('https://cdn.test/after.jpg');
    expect(ambient?.querySelector('img')?.getAttribute('alt')).toBe('');
    const after = stage.querySelector<HTMLImageElement>('.stage__picture > img.shared__after')!;
    expect(after.getAttribute('width')).toBe('1600');
    expect(after.getAttribute('height')).toBe('1200');
    expect(container.querySelector('.image-card, .image-card__frame, figure')).toBeNull();
  });

  it('puts the credit, the headline and the one call to action under the stage, the report link after', () => {
    const { container } = renderShare(
      view({ attribution: { required: true, text: '© 2026 Google', logo: 'google_maps' } }),
    );
    const below = container.querySelector('.shared > .share-page-app__below')!;
    expect(below.previousElementSibling?.classList.contains('stage')).toBe(true);
    expect(below.querySelector('.share-page-app__credit')?.textContent).toBe(
      'Christmas · ClassicGoogle Maps·© 2026 Google',
    );
    const heading = below.querySelector('h1.share-page-app__caption');
    expect(heading?.textContent).toBe('A holiday preview made with Hailiday');
    const cta = below.querySelector<HTMLAnchorElement>('a.button--primary.share-page-app__cta');
    expect(cta?.getAttribute('href')).toBe('/?holiday=christmas');
    expect(container.querySelectorAll('.button--primary')).toHaveLength(1);
    const more = container.querySelector('.shared + .share-page-app__more');
    expect(more?.querySelector('button.link-button')?.textContent).toBe('Report this image');
  });

  it('switches before and after from the stage corner only when the share includes the before photo', () => {
    const { container, unmount } = renderShare(view());
    expect(container.querySelector('.stage__overlay')).toBeNull();
    unmount();
    document.getElementById('share')?.remove();
    const shown = renderShare(view({ beforeImageUrl: 'https://cdn.test/before.jpg' }));
    const toggle = shown.container.querySelector(
      '.stage__overlay > .segmented.segmented--on-stage',
    );
    expect(toggle?.getAttribute('role')).toBe('group');
    expect(toggle?.querySelectorAll('button')).toHaveLength(2);
  });

  it('repeats the switch on the paper under the picture for phones, both copies in step', () => {
    const { container, unmount } = renderShare(view());
    expect(container.querySelector('.shared__controls')).toBeNull();
    unmount();
    document.getElementById('share')?.remove();
    const shown = renderShare(view({ beforeImageUrl: 'https://cdn.test/before.jpg' }));
    const below = shown.container.querySelector('.share-page-app__below')!;
    const controls = below.querySelector(':scope > .stage-controls.shared__controls')!;
    // First under the picture, alone in its row; the look's line follows it.
    expect(controls.previousElementSibling).toBeNull();
    expect(controls.children).toHaveLength(1);
    expect(controls.nextElementSibling?.classList.contains('share-page-app__credit')).toBe(true);
    const paperBefore = controls.querySelector<HTMLButtonElement>('button[aria-pressed="false"]')!;
    expect(paperBefore.textContent).toBe('Before');
    act(() => paperBefore.click());
    const stageBefore = shown.container.querySelector('.stage__overlay button')!;
    expect(stageBefore.getAttribute('aria-pressed')).toBe('true');
    expect(shown.container.querySelector('.shared__after')?.getAttribute('data-hidden')).toBe(
      'true',
    );
    const plain = shareCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(plain).toMatch(/\n\.shared__controls \{\s*display: none;/);
    expect(plain).toMatch(
      /@media \(max-width: 599px\) \{\s*\.shared:has\(\.shared__controls\) \{\s*--stage-peek: 248px;\s*\}\s*\.shared \.stage__overlay \{\s*display: none;/,
    );
    // No grid sets the look's label beside the switch.
    expect(plain).not.toMatch(/grid-template-columns: minmax\(0, 1fr\) auto/);
  });
});

describe('SharePage header tone', () => {
  afterEach(() => {
    document.head.querySelector('meta[name="theme-color"]')?.remove();
  });

  it('wears the ink header band and an ink theme-color above the shared picture', () => {
    const { container } = renderShare(view());
    const page = container.querySelector('.share-page-app')!;
    expect(page.classList.contains('page--stage')).toBe(true);
    const header = container.querySelector('header.share-page-app__header')!;
    expect(header.classList.contains('site-header')).toBe(true);
    expect(header.classList.contains('site-header--stage')).toBe(true);
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(
      '#0d0d0f',
    );
  });

  it('is a paper page with a white theme-color for a link that no longer works', async () => {
    vi.mocked(getShare).mockRejectedValue(new Error('gone'));
    const { container } = render(
      <MemoryRouter initialEntries={[`/s/${TOKEN}`]}>
        <Routes>
          <Route path="/s/:token" element={<SharePage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(container.querySelector('.share-page-app__gone')).not.toBeNull());
    expect(container.querySelector('.share-page-app')?.classList.contains('page--stage')).toBe(
      false,
    );
    expect(container.querySelector('header')?.classList.contains('site-header--stage')).toBe(false);
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(
      '#ffffff',
    );
  });
});
