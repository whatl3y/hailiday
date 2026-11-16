import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Endpoints from '../api/endpoints';
import { projectPageTitle } from '../features/project/pageTitle';
import { routes } from './routes';

vi.mock('../analytics', () => ({ analytics: { track: vi.fn(() => true), flush: vi.fn() } }));

vi.mock('../api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof Endpoints>()),
  getMe: vi.fn(() => new Promise(() => undefined)),
  getProject: vi.fn(() => new Promise(() => undefined)),
  listGallery: vi.fn(() => new Promise(() => undefined)),
  listProjects: vi.fn(() => new Promise(() => undefined)),
  verifyMagicLink: vi.fn(() => new Promise(() => undefined)),
}));

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

function announcer(): HTMLElement {
  return document.querySelector<HTMLElement>('.route-announcer')!;
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  document.title = 'Hailiday';
});

afterEach(() => {
  cleanup();
});

describe('route titles, announcements and focus', () => {
  it('titles the first page without announcing it or moving focus', () => {
    renderAt('/terms');
    expect(document.title).toBe('Terms of use · Hailiday');
    expect(announcer().getAttribute('aria-live')).toBe('polite');
    expect(announcer().textContent).toBe('');
    expect(document.activeElement).toBe(document.body);
  });

  it('retitles, announces and focuses the heading after a client-side navigation', () => {
    renderAt('/terms');
    fireEvent.click(screen.getByRole('link', { name: 'Privacy' }));
    expect(document.title).toBe('Privacy notice · Hailiday');
    expect(announcer().textContent).toBe('Privacy notice · Hailiday');
    const heading = screen.getByRole('heading', { level: 1, name: 'Privacy notice' });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('announces again when the next page has the same title', async () => {
    const router = renderAt('/terms');
    await act(() => router.navigate('/does-not-exist'));
    const first = announcer().textContent;
    await act(() => router.navigate('/still-not-here'));
    const second = announcer().textContent;
    expect(first?.trim()).toBe("We couldn't find that · Hailiday");
    expect(second?.trim()).toBe("We couldn't find that · Hailiday");
    expect(second).not.toBe(first);
  });

  it('titles the account pages from the copy deck', async () => {
    const router = renderAt('/terms');
    await act(() => router.navigate('/account'));
    expect(document.title).toBe('Your account · Hailiday');
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 1, name: 'Your account' }),
    );
    await act(() => router.navigate('/places'));
    expect(document.title).toBe('Your places · Hailiday');
    expect(screen.getAllByRole('link', { name: 'Gallery' }).length).toBeGreaterThan(0);
    await act(() => router.navigate('/gallery'));
    expect(document.title).toBe('Gallery · Hailiday');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Gallery' }));
    await act(() => router.navigate('/auth/verify'));
    expect(document.title).toBe('Sign in · Hailiday');
    await act(() => router.navigate('/dont-decorate-my-home'));
    expect(document.title).toBe("Don't decorate my home · Hailiday");
  });

  it('links the gallery from the header navigation on every page', () => {
    renderAt('/terms');
    const nav = screen.getByRole('navigation', { name: 'Site' });
    expect(nav.querySelector('a')?.getAttribute('href')).toBe('/gallery');
    expect(nav.textContent).toBe('Gallery');
  });

  it('keeps focus that the new page placed inside its main region', async () => {
    const router = renderAt('/terms');
    await act(() => router.navigate('/missing'));
    const heading = screen.getByRole('heading', { level: 1, name: "We couldn't find that" });
    expect(document.activeElement).toBe(heading);
  });

  it('falls back to the main region when the page has no heading yet', async () => {
    const router = renderAt('/terms');
    await act(() => router.navigate('/p/018f0000-0000-7000-8000-aaaaaaaaaaaa'));
    expect(document.title).toBe('Your place · Hailiday');
    expect(document.activeElement).toBe(document.getElementById('main'));
  });

  it('names each project screen by its heading and never by an address', () => {
    expect(projectPageTitle('confirm', null)).toBe('Is this the right place?');
    expect(projectPageTitle('waiting', null)).toBe('Decorating your place');
    expect(projectPageTitle('result', 'christmas')).toBe('Your place, ready for Christmas');
    expect(projectPageTitle('render_error', null)).toBe('Your place');
    expect(projectPageTitle('render_error', 'christmas')).toBe('Your place, ready for Christmas');
    expect(projectPageTitle('loading', null)).toBe('Your place');
  });
});
