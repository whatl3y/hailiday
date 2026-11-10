import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ShareView } from '@holiday/core';
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
  });

  it('sits in the lower-left corner of a Street View share, off its burned-in credit', () => {
    const { container } = renderShare(
      view({ attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' } }),
    );
    const element = corner(container);
    expect(element.classList.contains('image-card__corner--lower-left')).toBe(true);
    expect(element.classList.contains('image-card__corner--lower-right')).toBe(false);
  });
});

describe('SharePage taking over the server-painted page', () => {
  it('continues the card the server painted instead of playing its entrance again', () => {
    const { container } = renderShare(view());
    const card = container.querySelector<HTMLElement>('.shared__card');
    expect(card?.hasAttribute('data-continues')).toBe(true);
    const plain = shareCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.shared__card\[data-continues\]\s*\{([^}]*)\}/.exec(plain);
    expect(rule?.[1]).toMatch(/animation:\s*none;/);
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
    await waitFor(() => expect(container.querySelector('.shared__card')).not.toBeNull());
    expect(container.querySelector('.shared__card')?.hasAttribute('data-continues')).toBe(false);
  });
});
