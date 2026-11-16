import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductsPanel } from '@hailiday/core';
import * as endpoints from '../../api/endpoints';
import { project, variant } from '../../test/fixtures';
import { ShopTheLook } from './ShopTheLook';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  createClick: vi.fn(async () => undefined),
  getProducts: vi.fn(),
}));

const api = vi.mocked(endpoints);

const hidden: ProductsPanel = {
  panelState: 'hidden',
  linkMode: null,
  disclosure: { copyKeys: [], programs: [] },
  items: [],
};

const noOffers: ProductsPanel = { ...hidden, panelState: 'no_offers' };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function view(shown: ReturnType<typeof variant>) {
  return (
    <MemoryRouter>
      <ShopTheLook variant={shown} project={project()} />
    </MemoryRouter>
  );
}

describe('Shop the look while its products load', () => {
  it('marks the panel busy and says it is loading until the answer comes', async () => {
    let answer: (value: ProductsPanel) => void = () => undefined;
    api.getProducts.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(view(variant()));
    fireEvent.click(screen.getByRole('button', { name: /^Shop the look/ }));
    const region = screen.getByRole('region', { name: 'Shop the look' });
    expect(region.getAttribute('aria-busy')).toBe('true');
    expect(region.textContent).toContain('Loading…');
    await act(async () => {
      answer(noOffers);
    });
    expect(region.hasAttribute('aria-busy')).toBe(false);
    expect(region.textContent).not.toContain('Loading…');
  });
});

describe('Shop the look where the server hides the panel', () => {
  it('stays, with one line, when the hidden answer comes while the row is open', async () => {
    api.getProducts.mockResolvedValue(hidden);
    render(view(variant()));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Shop the look/ }));
    });
    expect(screen.getByRole('region', { name: 'Shop the look' }).textContent).toBe(
      "Matching decorations aren't available for this look yet.",
    );
  });

  it('stays while it holds focus after the person closed it', async () => {
    let answer: (value: ProductsPanel) => void = () => undefined;
    api.getProducts.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(view(variant()));
    const toggle = screen.getByRole('button', { name: /^Shop the look/ });
    toggle.focus();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await act(async () => {
      answer(hidden);
    });
    expect(screen.getByRole('button', { name: /^Shop the look/ })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
  });

  it('is left out for a later preview whose panel is hidden while the row is closed', async () => {
    api.getProducts.mockResolvedValue(noOffers);
    const first = variant();
    const { rerender } = render(view(first));
    const toggle = screen.getByRole('button', { name: /^Shop the look/ });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    toggle.blur();
    api.getProducts.mockResolvedValue(hidden);
    await act(async () => {
      rerender(view(variant()));
    });
    expect(screen.queryByRole('button', { name: /^Shop the look/ })).toBeNull();
  });
});
