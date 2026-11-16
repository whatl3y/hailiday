import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GalleryItem } from '@hailiday/core';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import { galleryItem } from '../../test/fixtures';
import galleryCss from './gallery.css?raw';
import { GalleryViewer, VIEWER_FADE_MS } from './GalleryViewer';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

/*
 * The base and gallery stylesheets in the document, so the computed style follows the real
 * cascade: the image card's own rule covers its frame with the picture, and the viewer must win
 * over it for every picture shape.
 */
const style = document.createElement('style');

beforeAll(() => {
  style.textContent = `${tokensCss}\n${globalCss.replace(/^@import [^;]+;$/gm, '')}\n${galleryCss}`;
  document.head.append(style);
});

afterAll(() => style.remove());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.getElementById('root')?.remove();
});

function renderViewer(
  items: GalleryItem[],
  index = 0,
  handlers: { onNavigate?: (index: number) => void; onClose?: () => void } = {},
) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  return render(
    <MemoryRouter>
      <GalleryViewer
        items={items}
        index={index}
        onNavigate={handlers.onNavigate ?? (() => undefined)}
        onClose={handlers.onClose ?? (() => undefined)}
      />
    </MemoryRouter>,
    { container: root },
  );
}

function picture() {
  const image = document.querySelector<HTMLImageElement>('.gallery-viewer__image');
  const box = document.querySelector<HTMLElement>('.lightbox__picture');
  if (!image || !box) throw new Error('no viewer picture');
  return { image, box };
}

describe('the gallery viewer picture', () => {
  it.each([
    ['a square Street View frame', 640, 640, 'street_view' as const],
    ['a 3:2 uploaded photo', 1536, 1024, 'upload' as const],
    ['a 3:4 uploaded photo', 768, 1024, 'upload' as const],
  ])('shows %s whole, never cropped', (_name, width, height, kind) => {
    renderViewer([galleryItem({ width, height, sourceKind: kind, beforeImageUrl: null })]);
    const { image, box } = picture();
    // The box carries the picture's natural size, which the stylesheet sizes it from ...
    expect(box.style.getPropertyValue('--picture-w')).toBe(String(width));
    expect(box.style.getPropertyValue('--picture-h')).toBe(String(height));
    // ... and the picture is fitted inside it, never covering and cropping it.
    expect(getComputedStyle(image).objectFit).toBe('contain');
    expect(getComputedStyle(image).position).toBe('absolute');
  });

  it('is fitted by a rule of the viewer, not by an inline style', () => {
    renderViewer([galleryItem({ width: 640, height: 640 })]);
    expect(picture().image.getAttribute('style')).toBeNull();
  });

  it('keeps the badge of a Street View frame at the upper left and an upload at the lower right', () => {
    renderViewer([galleryItem(), galleryItem({ sourceKind: 'upload' })]);
    const corner = () =>
      document.querySelector<HTMLElement>('.lightbox__picture .image-card__corner');
    expect(corner()?.dataset.corner).toBe('upper-left');
    cleanup();
    renderViewer([galleryItem(), galleryItem({ sourceKind: 'upload' })], 1);
    expect(corner()?.dataset.corner).toBe('lower-right');
  });

  it('colors the ground from the rendering, never from the before photo', () => {
    const item = galleryItem({ beforeImageUrl: 'https://cdn.test/before.jpg' });
    renderViewer([item]);
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    expect(picture().image.getAttribute('src')).toBe('https://cdn.test/before.jpg');
    const ambient = document.querySelector('.lightbox__ambient img');
    expect(ambient?.getAttribute('src')).toBe(item.imageUrl);
    expect(document.querySelector('.lightbox__ambient')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the gallery viewer as a dialog', () => {
  it('is named by the look, starts on Close and makes the page behind inert', () => {
    renderViewer([galleryItem()]);
    const dialog = screen.getByRole('dialog', { name: /^Christmas\s·\sAbundant\s·\sEvening$/ });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('lets the page go when it closes', () => {
    const { unmount } = renderViewer([galleryItem()]);
    unmount();
    expect(document.getElementById('root')?.hasAttribute('inert')).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('fades out, then closes, on Escape and on Close', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderViewer([galleryItem()], 0, { onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog').classList.contains('lightbox--closing')).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(VIEWER_FADE_MS);
    });
    expect(onClose).toHaveBeenCalledOnce();
    // A second request while it fades does not close it twice.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    act(() => {
      vi.advanceTimersByTime(VIEWER_FADE_MS);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes at once under reduced motion', () => {
    const matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    const onClose = vi.fn();
    renderViewer([galleryItem()], 0, { onClose });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('keeps Tab inside the viewer', () => {
    renderViewer([galleryItem(), galleryItem()], 0);
    const dialog = screen.getByRole('dialog');
    const open = screen.getByRole('link', { name: 'Open this place' });
    open.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Previous look' }));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(open);
  });
});

describe('stepping through the gallery in the viewer', () => {
  const three = () => [galleryItem(), galleryItem(), galleryItem()];

  it('shows the position and steps with the buttons, stopping at either end', () => {
    const onNavigate = vi.fn();
    renderViewer(three(), 0, { onNavigate });
    expect(screen.getByText('1 of 3')).toBeTruthy();
    const previous = screen.getByRole('button', { name: 'Previous look' });
    expect(previous.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(previous);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next look' }));
    expect(onNavigate).toHaveBeenCalledWith(1);
    cleanup();
    renderViewer(three(), 2, { onNavigate });
    expect(screen.getByText('3 of 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next look' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('steps with the arrow keys', () => {
    const onNavigate = vi.fn();
    renderViewer(three(), 1, { onNavigate });
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onNavigate).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onNavigate).toHaveBeenLastCalledWith(2);
  });

  it('steps with a swipe of a finger, not with a mouse drag', () => {
    const onNavigate = vi.fn();
    renderViewer(three(), 1, { onNavigate });
    const stage = document.querySelector('.lightbox__stage')!;
    const swipe = (pointerType: string, fromX: number, toX: number, dy = 0) => {
      fireEvent.pointerDown(stage, { pointerId: 1, pointerType, clientX: fromX, clientY: 300 });
      fireEvent.pointerUp(stage, { pointerId: 1, pointerType, clientX: toX, clientY: 300 + dy });
    };
    swipe('touch', 300, 100);
    expect(onNavigate).toHaveBeenLastCalledWith(2);
    swipe('touch', 100, 300);
    expect(onNavigate).toHaveBeenLastCalledWith(0);
    onNavigate.mockClear();
    swipe('touch', 300, 280);
    swipe('touch', 300, 200, 160);
    swipe('mouse', 300, 100);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('shows no position or step buttons for a single picture', () => {
    renderViewer([galleryItem()]);
    expect(screen.queryByRole('button', { name: 'Next look' })).toBeNull();
    expect(screen.queryByText('1 of 1')).toBeNull();
  });

  it('shows the after picture again when it moves to the next rendering', () => {
    const items = [
      galleryItem({ beforeImageUrl: 'https://cdn.test/before-1.jpg' }),
      galleryItem({ beforeImageUrl: 'https://cdn.test/before-2.jpg' }),
    ];
    const { rerender } = renderViewer(items, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    expect(picture().image.getAttribute('src')).toBe('https://cdn.test/before-1.jpg');
    rerender(
      <MemoryRouter>
        <GalleryViewer
          items={items}
          index={1}
          onNavigate={() => undefined}
          onClose={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(picture().image.getAttribute('src')).toBe(items[1]!.imageUrl);
  });
});
