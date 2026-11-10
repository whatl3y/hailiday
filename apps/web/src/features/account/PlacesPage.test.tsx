import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { project, variant } from '../../test/fixtures';
import { PlaceThumb } from './PlacesPage';

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

describe('Your places thumbnail badge', () => {
  async function badgeFor(latest: ReturnType<typeof variant>): Promise<HTMLElement> {
    api.listVariants.mockResolvedValue({ items: [latest] } as never);
    const { container } = render(<PlaceThumb project={project()} />);
    await flush();
    const badge = container.querySelector<HTMLElement>('.place__badge');
    if (!badge) throw new Error('badge missing');
    expect(badge.textContent).toBe('AI preview');
    return badge;
  }

  it('sits in the lower-right corner of an upload-origin preview', async () => {
    const badge = await badgeFor(variant());
    expect(badge.classList.contains('place__badge--lower-right')).toBe(true);
  });

  it('sits in the lower-left corner of a Street View preview', async () => {
    const badge = await badgeFor(
      variant({ attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' } }),
    );
    expect(badge.classList.contains('place__badge--lower-left')).toBe(true);
    expect(badge.classList.contains('place__badge--lower-right')).toBe(false);
  });
});
