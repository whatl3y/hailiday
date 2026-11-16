import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { useShareStore } from '../../state/shares';
import { project, variant } from '../../test/fixtures';
import { ShareSheet } from './ShareSheet';

vi.mock('../../api/endpoints', () => ({ createShare: vi.fn(), deleteShare: vi.fn() }));

const api = vi.mocked(endpoints);

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  useShareStore.getState().clear();
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
  let n = 0;
  api.createShare.mockImplementation(async () => {
    n += 1;
    return {
      token: `token-${n}`,
      url: `http://localhost:8080/s/token-${n}`,
      expiresAt: '2026-12-09T12:00:00.000Z',
      cardUrl: null,
    } as never;
  });
  api.deleteShare.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ShareSheet card preview badge', () => {
  function badge(): HTMLElement {
    const element = document.querySelector<HTMLElement>('.share-card__badge');
    if (!element) throw new Error('badge missing');
    return element;
  }

  it('sits in the lower-right corner of an upload-origin preview', () => {
    render(<ShareSheet project={project()} variant={variant()} onClose={() => undefined} />);
    expect(badge().classList.contains('share-card__badge--lower-right')).toBe(true);
    expect(badge().classList.contains('share-card__badge--upper-left')).toBe(false);
  });

  it('sits in the upper-left corner of a Street View preview', () => {
    render(
      <ShareSheet
        project={project()}
        variant={variant({
          attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
        })}
        onClose={() => undefined}
      />,
    );
    expect(badge().classList.contains('share-card__badge--upper-left')).toBe(true);
    expect(badge().classList.contains('share-card__badge--lower-right')).toBe(false);
  });
});

describe('ShareSheet', () => {
  it('uses a fresh idempotency key for a new link after Stop sharing', async () => {
    const shown = variant();
    render(<ShareSheet project={project()} variant={shown} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));
    await flush();
    expect(api.deleteShare).toHaveBeenCalledWith('token-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await flush();
    expect(api.createShare).toHaveBeenCalledTimes(2);
    const [first, second] = api.createShare.mock.calls.map((call) => call[1]);
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
    expect(useShareStore.getState().byVariant[shown.renderAssetId]?.token).toBe('token-2');
  });
});
