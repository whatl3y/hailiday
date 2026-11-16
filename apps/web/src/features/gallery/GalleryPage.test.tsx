import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { useAppStore } from '../../state/appStore';
import { apiError, galleryItem } from '../../test/fixtures';
import { assignLocation } from '../project/navigate';
import {
  GALLERY_REFRESH_AFTER_MS,
  GALLERY_RETRY_FIRST_MS,
  GALLERY_RETRY_MAX_MS,
  nextRetryDelay,
} from './gallery';
import { GalleryPage } from './GalleryPage';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  listGallery: vi.fn(),
  hasSession: vi.fn(() => false),
  onSessionReady: vi.fn(() => () => undefined),
  sendAnalytics: vi.fn(async () => undefined),
}));
vi.mock('../project/navigate', () => ({ assignLocation: vi.fn() }));

const api = vi.mocked(endpoints);

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderGallery() {
  render(
    <MemoryRouter>
      <GalleryPage />
    </MemoryRouter>,
  );
  await flush();
}

const lantern = galleryItem({ createdAt: '2026-11-09T12:00:00.000Z' });
const lanternEarlier = galleryItem({
  style: 'classic',
  createdAt: '2026-11-09T11:00:00.000Z',
  beforeImageUrl: 'https://cdn.test/before.jpg',
  downloadUrl: 'https://cdn.test/download.jpg',
});
const upload = galleryItem({
  projectId: '018f0000-0000-7000-8000-cccccccccccc',
  group: { key: 'upload-1', kind: 'upload', label: null },
  sceneType: 'interior',
  sourceKind: 'upload',
  lightingMode: 'source',
  createdAt: '2026-11-08T12:00:00.000Z',
});

beforeEach(() => {
  api.listGallery.mockResolvedValue({ items: [lantern, lanternEarlier, upload], nextCursor: null });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  setVisibility('visible');
});

/** Sets what `document.visibilityState` reports. */
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

/** A presigned URL that expired a minute ago, or that is valid for 15 minutes from now. */
function signedUrl(path: string, expired: boolean): string {
  const signedAt = new Date(Date.now() - (expired ? 16 : 0) * 60 * 1000);
  const stamp = signedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `https://cdn.test/${path}?X-Amz-Date=${stamp}&X-Amz-Expires=900`;
}

describe('the gallery', () => {
  it('lists every rendering grouped by place, with the look and date under each', async () => {
    await renderGallery();
    expect(api.listGallery).toHaveBeenCalledWith(null, 60);
    const place = screen.getByRole('heading', {
      level: 2,
      name: '14 Lantern Hill Rd, Maplebrook, VT 05341, USA',
    });
    const placeGroup = place.closest('section')!;
    expect(within(placeGroup).getAllByRole('button')).toHaveLength(2);
    expect(within(placeGroup).getByText('Christmas · Abundant · Evening')).toBeTruthy();
    expect(within(placeGroup).getAllByText('November 9, 2026')).toHaveLength(2);
    const photo = screen.getByRole('heading', { level: 2, name: 'Your photo' }).closest('section')!;
    expect(within(photo).getAllByRole('button')).toHaveLength(1);
    for (const image of document.querySelectorAll('.gallery__thumb img')) {
      expect(image.getAttribute('loading')).toBe('lazy');
    }
    const badges = [...document.querySelectorAll<HTMLElement>('.gallery__badge')];
    expect(badges).toHaveLength(3);
    // Street View tiles carry the badge at the upper left, the uploaded photo at the lower right.
    expect(badges.map((badge) => badge.dataset.corner)).toEqual([
      'upper-left',
      'upper-left',
      'lower-right',
    ]);
    expect(badges[0]!.classList.contains('gallery__badge--upper-left')).toBe(true);
    expect(badges[2]!.classList.contains('gallery__badge--lower-right')).toBe(true);
  });

  it('shows the empty state when there is no session to read', async () => {
    api.listGallery.mockRejectedValue(apiError('VERIFICATION_REQUIRED'));
    await renderGallery();
    expect(
      screen.getByText('No looks yet. Decorate a place and every look you make appears here.'),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('loads more pages on request', async () => {
    const later = galleryItem({ createdAt: '2026-11-01T12:00:00.000Z' });
    api.listGallery
      .mockResolvedValueOnce({ items: [lantern], nextCursor: 'next-1' })
      .mockResolvedValueOnce({ items: [later], nextCursor: null });
    await renderGallery();
    expect(screen.getAllByRole('button', { name: /AI preview of this place/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await flush();
    expect(api.listGallery).toHaveBeenLastCalledWith('next-1', 60);
    expect(screen.getAllByRole('button', { name: /AI preview of this place/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('reads the signed URLs again before they expire', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderGallery();
    expect(api.listGallery).toHaveBeenCalledTimes(1);
    const fresh = { ...lantern, imageUrl: 'https://cdn.test/fresh.jpg' };
    api.listGallery.mockResolvedValue({ items: [fresh], nextCursor: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GALLERY_REFRESH_AFTER_MS);
    });
    await flush();
    expect(api.listGallery).toHaveBeenCalledTimes(2);
    expect(api.listGallery).toHaveBeenLastCalledWith(null, 60);
    expect(document.querySelector('.gallery__thumb img')?.getAttribute('src')).toBe(
      'https://cdn.test/fresh.jpg',
    );
  });

  it('reads the gallery again when the tab comes back into view after the URLs have aged', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderGallery();
    expect(api.listGallery).toHaveBeenCalledTimes(1);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    // Fresh URLs are not read again on every focus.
    expect(api.listGallery).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GALLERY_REFRESH_AFTER_MS + 1000);
    });
    await flush();
    // The timer does not read while the tab is hidden.
    expect(api.listGallery).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(api.listGallery).toHaveBeenCalledTimes(2);
  });

  it('tries a failed refresh again after 30 seconds, then doubles the wait', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await renderGallery();
    api.listGallery.mockRejectedValue(new Error('offline'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GALLERY_REFRESH_AFTER_MS);
    });
    await flush();
    expect(api.listGallery).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GALLERY_RETRY_FIRST_MS - 1000);
    });
    expect(api.listGallery).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await flush();
    expect(api.listGallery).toHaveBeenCalledTimes(3);
    // The second failure waits twice as long before the next try.
    const fresh = { ...lantern, imageUrl: 'https://cdn.test/retried.jpg' };
    api.listGallery.mockResolvedValue({ items: [fresh], nextCursor: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GALLERY_RETRY_FIRST_MS);
    });
    await flush();
    expect(api.listGallery).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GALLERY_RETRY_FIRST_MS);
    });
    await flush();
    expect(api.listGallery).toHaveBeenCalledTimes(4);
    expect(document.querySelector('.gallery__thumb img')?.getAttribute('src')).toBe(
      'https://cdn.test/retried.jpg',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens a rendering in a viewer with Before, Download and "Open this place"', async () => {
    await renderGallery();
    const tiles = screen.getAllByRole('button', { name: /AI preview of this place/ });
    fireEvent.click(tiles[1]!);
    const viewer = screen.getByRole('dialog', { name: /^Christmas\s·\sClassic\s·\sEvening$/ });
    expect(within(viewer).getByText('AI preview', { selector: '.badge' })).toBeTruthy();
    expect(viewer.querySelector<HTMLElement>('.image-card__corner')?.dataset.corner).toBe(
      'upper-left',
    );
    // The viewer shows the picture's position among every rendering on the page.
    expect(within(viewer).getByText('2 of 3')).toBeTruthy();
    fireEvent.click(within(viewer).getByRole('button', { name: 'Before' }));
    expect(viewer.querySelector('.gallery-viewer__image')?.getAttribute('src')).toBe(
      'https://cdn.test/before.jpg',
    );
    expect(within(viewer).queryByText('AI preview', { selector: '.badge' })).toBeNull();
    expect(within(viewer).getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(
      'https://cdn.test/download.jpg',
    );
    expect(within(viewer).getByRole('link', { name: 'Open this place' }).getAttribute('href')).toBe(
      `/p/${lanternEarlier.projectId}`,
    );
  });

  it('has no comparison or download in the viewer when neither exists', async () => {
    await renderGallery();
    fireEvent.click(screen.getAllByRole('button', { name: /AI preview of this place/ })[0]!);
    const viewer = screen.getByRole('dialog');
    expect(within(viewer).queryByRole('button', { name: 'Before' })).toBeNull();
    expect(within(viewer).queryByRole('link', { name: 'Download' })).toBeNull();
  });

  it('keeps the viewer badge of an uploaded photo at the lower right', async () => {
    await renderGallery();
    fireEvent.click(screen.getAllByRole('button', { name: /AI preview of this place/ })[2]!);
    const viewer = screen.getByRole('dialog');
    expect(viewer.querySelector<HTMLElement>('.image-card__corner')?.dataset.corner).toBe(
      'lower-right',
    );
  });

  it('reads a fresh download link first when the signed one has expired', async () => {
    const stale = galleryItem({ downloadUrl: signedUrl('stale.jpg', true) });
    const freshLink = signedUrl('fresh.jpg', false);
    api.listGallery.mockResolvedValue({ items: [stale], nextCursor: null });
    await renderGallery();
    fireEvent.click(screen.getByRole('button', { name: /AI preview of this place/ }));
    const opened = { location: { href: '' }, close: vi.fn() };
    const open = vi.fn(() => opened);
    vi.stubGlobal('open', open);
    api.listGallery.mockResolvedValue({
      items: [{ ...stale, downloadUrl: freshLink }],
      nextCursor: null,
    });
    const link = within(screen.getByRole('dialog')).getByRole('link', { name: 'Download' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(click);
    });
    await flush();
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(api.listGallery).toHaveBeenCalledTimes(2);
    expect(opened.location.href).toBe(freshLink);
  });

  it('opens the fresh download link in this tab when the browser blocks the new window', async () => {
    const stale = galleryItem({ downloadUrl: signedUrl('stale.jpg', true) });
    const freshLink = signedUrl('fresh.jpg', false);
    api.listGallery.mockResolvedValue({ items: [stale], nextCursor: null });
    await renderGallery();
    fireEvent.click(screen.getByRole('button', { name: /AI preview of this place/ }));
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    api.listGallery.mockResolvedValue({
      items: [{ ...stale, downloadUrl: freshLink }],
      nextCursor: null,
    });
    const link = within(screen.getByRole('dialog')).getByRole('link', { name: 'Download' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      link.dispatchEvent(click);
    });
    await flush();
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(vi.mocked(assignLocation)).toHaveBeenCalledExactlyOnceWith(freshLink);
  });

  it('closes the opened window and stays put when no fresh download link comes back', async () => {
    const stale = galleryItem({ downloadUrl: signedUrl('stale.jpg', true) });
    api.listGallery.mockResolvedValue({ items: [stale], nextCursor: null });
    await renderGallery();
    fireEvent.click(screen.getByRole('button', { name: /AI preview of this place/ }));
    const opened = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => opened),
    );
    api.listGallery.mockResolvedValue({
      items: [{ ...stale, downloadUrl: null }],
      nextCursor: null,
    });
    const link = within(screen.getByRole('dialog')).getByRole('link', { name: 'Download' });
    await act(async () => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.location.href).toBe('');
    expect(vi.mocked(assignLocation)).not.toHaveBeenCalled();
  });

  it('follows a download link that is still valid without reading the gallery again', async () => {
    const item = galleryItem({ downloadUrl: signedUrl('valid.jpg', false) });
    api.listGallery.mockResolvedValue({ items: [item], nextCursor: null });
    await renderGallery();
    fireEvent.click(screen.getByRole('button', { name: /AI preview of this place/ }));
    const link = within(screen.getByRole('dialog')).getByRole('link', { name: 'Download' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    await flush();
    expect(click.defaultPrevented).toBe(false);
    expect(api.listGallery).toHaveBeenCalledTimes(1);
  });
});

describe('the gallery viewer on the page', () => {
  it('steps through the renderings in the order the page shows them', async () => {
    // The newest upload is listed first by the API, but its group follows the address's.
    const newestUpload = galleryItem({
      projectId: '018f0000-0000-7000-8000-cccccccccccc',
      group: { key: 'upload-1', kind: 'upload', label: null },
      sourceKind: 'upload',
      createdAt: '2026-11-09T13:00:00.000Z',
    });
    const otherPlace = galleryItem({
      group: { key: 'place-2', kind: 'address', label: '7 Wicker Lane, Bitterroot, MT 59870, USA' },
      createdAt: '2026-11-09T12:30:00.000Z',
    });
    api.listGallery.mockResolvedValue({
      items: [newestUpload, otherPlace, lantern, upload],
      nextCursor: null,
    });
    await renderGallery();
    const order = [...document.querySelectorAll('.gallery__thumb img')].map((image) =>
      image.getAttribute('src'),
    );
    fireEvent.click(screen.getAllByRole('button', { name: /AI preview of this place/ })[0]!);
    const shown = () =>
      screen.getByRole('dialog').querySelector('.gallery-viewer__image')?.getAttribute('src');
    expect(shown()).toBe(order[0]);
    for (let index = 1; index < order.length; index += 1) {
      fireEvent.keyDown(document, { key: 'ArrowRight' });
      expect(shown()).toBe(order[index]);
      expect(within(screen.getByRole('dialog')).getByText(`${index + 1} of 4`)).toBeTruthy();
    }
  });

  it('returns focus to the tile of the picture last on view when it closes', async () => {
    const matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    await renderGallery();
    const tiles = screen.getAllByRole('button', { name: /AI preview of this place/ });
    fireEvent.click(tiles[0]!);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(tiles[1]);
  });
});

describe('gallery Street View attribution', () => {
  it('keeps the bottom of a Street View frame in the crop and credits Google Maps once', async () => {
    await renderGallery();
    const thumbs = [...document.querySelectorAll('.gallery__thumb')];
    expect(thumbs.map((thumb) => thumb.classList.contains('gallery__thumb--street-view'))).toEqual([
      true,
      true,
      false,
    ]);
    const tiles = screen.getAllByRole('button', { name: /AI preview of this place/ });
    const credit = tiles[0]!.querySelector('.gallery__credit');
    expect(credit?.textContent?.match(/Google Maps/g)).toHaveLength(1);
    expect(credit?.textContent).toContain('© 2026 Google');
    expect(tiles[2]!.querySelector('.gallery__credit')).toBeNull();
  });

  it("prints the rendering's own credit in the viewer", async () => {
    await renderGallery();
    fireEvent.click(screen.getAllByRole('button', { name: /AI preview of this place/ })[0]!);
    const strip = screen.getByRole('dialog').querySelector('.lightbox__meta');
    expect(strip?.textContent).toContain('© 2026 Google');
    expect(strip?.textContent?.match(/Google Maps/g)).toHaveLength(1);
  });

  it('says "Your photo" under an uploaded photo in the viewer', async () => {
    await renderGallery();
    fireEvent.click(screen.getAllByRole('button', { name: /AI preview of this place/ })[2]!);
    const strip = screen.getByRole('dialog').querySelector('.lightbox__meta');
    expect(strip?.textContent).toContain('Your photo');
    expect(strip?.textContent).not.toContain('Google');
  });
});

describe('gallery keyboard and screen-reader paths', () => {
  it('moves focus to the first new tile after the last page loads', async () => {
    const later = galleryItem({ createdAt: '2026-11-01T12:00:00.000Z' });
    api.listGallery
      .mockResolvedValueOnce({ items: [lantern], nextCursor: 'next-1' })
      .mockResolvedValueOnce({ items: [later], nextCursor: null });
    await renderGallery();
    const more = screen.getByRole('button', { name: 'Load more' });
    more.focus();
    fireEvent.click(more);
    await flush();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    const tiles = screen.getAllByRole('button', { name: /AI preview of this place/ });
    expect(document.activeElement).toBe(tiles[1]);
    expect(tiles[1]!.querySelector('img')?.getAttribute('src')).toBe(later.imageUrl);
  });

  it('shows a load-more failure beside the button, not at the top of the page', async () => {
    api.listGallery
      .mockResolvedValueOnce({ items: [lantern], nextCursor: 'next-1' })
      .mockRejectedValueOnce(new Error('offline'));
    await renderGallery();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await flush();
    const alert = screen.getByRole('alert');
    const more = screen.getByRole('button', { name: 'Load more' });
    expect(more.nextElementSibling).toBe(alert);
    const heading = screen.getByRole('heading', { level: 1, name: 'Gallery' });
    // The alert follows the tiles in the page.
    const grid = document.querySelector('.gallery__wall')!;
    expect(grid.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('announces the first load and marks the gallery busy until it arrives', async () => {
    let resolve: (value: { items: never[]; nextCursor: null }) => void = () => undefined;
    api.listGallery.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }) as never,
    );
    render(
      <MemoryRouter>
        <GalleryPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(document.querySelector('.gallery')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      resolve({ items: [], nextCursor: null });
    });
    await flush();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(document.querySelector('.gallery')?.hasAttribute('aria-busy')).toBe(false);
  });

  it('shows no holiday picker in the header', async () => {
    useAppStore.setState({ pickerHolidayIds: ['christmas', 'thanksgiving_us'] });
    await renderGallery();
    expect(document.querySelector('.holiday-chip')).toBeNull();
    useAppStore.setState({ pickerHolidayIds: [] });
  });
});

describe('gallery refresh retry wait', () => {
  it('starts at 30 seconds and doubles up to 5 minutes', () => {
    expect(nextRetryDelay(null)).toBe(GALLERY_RETRY_FIRST_MS);
    expect(nextRetryDelay(GALLERY_RETRY_FIRST_MS)).toBe(60 * 1000);
    expect(nextRetryDelay(4 * 60 * 1000)).toBe(GALLERY_RETRY_MAX_MS);
    expect(nextRetryDelay(GALLERY_RETRY_MAX_MS)).toBe(GALLERY_RETRY_MAX_MS);
  });
});
