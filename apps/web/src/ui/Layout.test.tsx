import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { PageShell, SiteHeader } from './Layout';

afterEach(cleanup);

function galleryLinkAt(path: string): HTMLElement {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SiteHeader />
    </MemoryRouter>,
  );
  return screen.getByRole('link', { name: 'Gallery' });
}

describe('the header Gallery link', () => {
  it('is the current page on /gallery', () => {
    const link = galleryLinkAt('/gallery');
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(link.className).toBe('site-header__link');
  });

  it('is not current elsewhere', () => {
    expect(galleryLinkAt('/places').hasAttribute('aria-current')).toBe(false);
  });
});

describe('the page surface', () => {
  function themeColor(): string | null {
    return document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;
  }

  function shellAt(tone: 'paper' | 'photo' | 'stage' | undefined) {
    return (
      <MemoryRouter>
        <PageShell tone={tone} footer={false}>
          <p>content</p>
        </PageShell>
      </MemoryRouter>
    );
  }

  it('gives a stage page an ink header band and the page class, and an ink theme color', () => {
    const { container } = render(shellAt('stage'));
    expect(container.querySelector('.page')!.className).toBe('page page--stage');
    expect(container.querySelector('header')!.className).toBe('site-header site-header--stage');
    expect(themeColor()).toBe('#0d0d0f');
  });

  it('keeps the photo tone, which opens on ink too', () => {
    const { container } = render(shellAt('photo'));
    expect(container.querySelector('header')!.className).toBe('site-header site-header--photo');
    expect(themeColor()).toBe('#0d0d0f');
  });

  it('follows the page on screen: back to white on a paper page', () => {
    const { container, rerender } = render(shellAt('stage'));
    expect(themeColor()).toBe('#0d0d0f');
    rerender(shellAt(undefined));
    expect(container.querySelector('.page')!.className).toBe('page');
    expect(container.querySelector('header')!.className).toBe('site-header');
    expect(themeColor()).toBe('#ffffff');
  });

  it('adds the meta tag when the document has none, and keeps one', () => {
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
    render(shellAt('stage'));
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(themeColor()).toBe('#0d0d0f');
  });
});
