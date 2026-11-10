import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import * as endpoints from '../../api/endpoints';
import { sessionError } from '../../api/errors';
import { apiError, project } from '../../test/fixtures';
import { UploadEntryPage } from './UploadEntryPage';

vi.mock('../../api/endpoints', () => ({
  createUploadProject: vi.fn(),
  sendAnalytics: vi.fn(async () => undefined),
  hasSession: vi.fn(() => false),
  onSessionReady: vi.fn(() => () => undefined),
}));

const api = vi.mocked(endpoints);

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function start() {
  render(
    <MemoryRouter initialEntries={['/upload']}>
      <Routes>
        <Route path="/upload" element={<UploadEntryPage />} />
        <Route path="/p/:projectId" element={<p>project page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  act(() => {
    vi.advanceTimersByTime(0);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('UploadEntryPage', () => {
  it('says a refused session start in place and retries once its wait has passed', async () => {
    api.createUploadProject
      .mockRejectedValueOnce(sessionError(apiError('RATE_LIMITED', { retryAfter: '5' })))
      .mockResolvedValueOnce(project({ kind: 'upload' }));
    await start();

    expect(screen.getByRole('alert').textContent).toBe(
      'We need a short breather: lots of visits came from your connection just now. ' +
        'Try again in about 5 seconds.',
    );
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(retry);
    expect(api.createUploadProject).toHaveBeenCalledTimes(1);

    for (let second = 0; second < 5; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(api.createUploadProject).toHaveBeenCalledTimes(2);
    expect(screen.getByText('project page')).toBeTruthy();
  });

  it('offers "Try again" at once when the session failed for another reason', async () => {
    api.createUploadProject.mockRejectedValueOnce(sessionError(new TypeError('Failed to fetch')));
    await start();
    expect(screen.getByRole('alert').textContent).toBe(
      "We couldn't get Holiday ready for you. Check your connection and try again.",
    );
    expect(
      screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });
});
