import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { ApiError } from '../../api/errors';
import { VerifyPage } from './VerifyPage';

vi.mock('../../api/endpoints', () => ({
  verifyMagicLink: vi.fn(),
  requestMagicLink: vi.fn(),
}));

const api = vi.mocked(endpoints);

const SIGNED_IN = {
  user: { id: '018f0000-0000-7000-8000-000000000001', email: 'tess@example.com', roles: [] },
  claimedProjects: 1,
  returnTo: '/p/018f0000-0000-7000-8000-aaaaaaaaaaaa',
};

async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function open(token: string) {
  render(
    <MemoryRouter initialEntries={[`/auth/verify?token=${token}`]}>
      <Routes>
        <Route path="/auth/verify" element={<VerifyPage />} />
        <Route path="/" element={<p>landing page</p>} />
        <Route path="/p/:id" element={<p>project page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VerifyPage', () => {
  it('signs in at once when the link is opened in the browser that asked for it', async () => {
    api.verifyMagicLink.mockResolvedValue(SIGNED_IN);
    open('same-browser');
    await flush();
    expect(api.verifyMagicLink).toHaveBeenCalledTimes(1);
    expect(api.verifyMagicLink).toHaveBeenCalledWith('same-browser', false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('project page')).toBeTruthy();
  });

  it('asks before signing in from another browser, then confirms', async () => {
    api.verifyMagicLink
      .mockResolvedValueOnce({ confirmationRequired: true, emailHint: 't•••@example.com' })
      .mockResolvedValueOnce(SIGNED_IN);
    open('other-browser');
    await flush();
    const sheet = screen.getByRole('dialog', { name: 'Sign in as t•••@example.com?' });
    expect(sheet.textContent).toContain("We'll save your places to this account.");
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    expect(api.verifyMagicLink).toHaveBeenLastCalledWith('other-browser', true);
    expect(screen.getByText('project page')).toBeTruthy();
  });

  it('"Not me" leaves without using the link', async () => {
    api.verifyMagicLink.mockResolvedValueOnce({
      confirmationRequired: true,
      emailHint: 't•••@example.com',
    });
    open('not-mine');
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Not me' }));
    await flush();
    expect(api.verifyMagicLink).toHaveBeenCalledTimes(1);
    expect(screen.getByText('landing page')).toBeTruthy();
  });

  it('asks the API again when a failed verification is retried without a reload', async () => {
    api.verifyMagicLink
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(SIGNED_IN);
    open('flaky-network');
    await flush();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(api.verifyMagicLink).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toBeTruthy();

    // A remount (leaving and coming back) does not replay the failure either.
    cleanup();
    open('flaky-network');
    await flush();
    expect(api.verifyMagicLink).toHaveBeenCalledTimes(3);
    expect(api.verifyMagicLink).toHaveBeenLastCalledWith('flaky-network', false);
    expect(screen.getByText('project page')).toBeTruthy();
  });

  it('retries a failed confirmation by sending the confirmation again', async () => {
    api.verifyMagicLink
      .mockResolvedValueOnce({ confirmationRequired: true, emailHint: 't•••@example.com' })
      .mockRejectedValueOnce(
        new ApiError({
          kind: 'http',
          status: 503,
          code: 'PROVIDER_UNAVAILABLE',
          details: {},
          requestId: 'r1',
          retryAfterSeconds: null,
        }),
      )
      .mockResolvedValueOnce(SIGNED_IN);
    open('confirm-retry');
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    // The unconsumed first step is reused; the failed confirmation is sent again.
    expect(api.verifyMagicLink).toHaveBeenCalledTimes(3);
    expect(api.verifyMagicLink).toHaveBeenLastCalledWith('confirm-retry', true);
    expect(screen.getByText('project page')).toBeTruthy();
  });
});
