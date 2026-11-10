import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { useAppStore } from '../../state/appStore';
import { useShareStore } from '../../state/shares';
import { allowance } from '../../test/fixtures';
import { AccountPage } from './AccountPage';

vi.mock('../../api/endpoints', () => ({
  getMe: vi.fn(),
  logout: vi.fn(),
  deleteMe: vi.fn(),
  resetSession: vi.fn(),
}));

const api = vi.mocked(endpoints);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AccountPage', () => {
  it('signing out forgets the share links and the last project kept on this device', async () => {
    api.getMe.mockResolvedValue({
      user: { id: '018f0000-0000-7000-8000-000000000001', email: 'a@example.com', roles: ['user'] },
      allowance: allowance(),
      savedProjects: 1,
    });
    api.logout.mockResolvedValue(undefined);
    useShareStore.getState().remember({
      token: 't',
      url: 'http://localhost:8080/s/t',
      expiresAt: '2099-01-01T00:00:00.000Z',
      cardUrl: null,
      renderAssetId: 'r',
      projectId: 'p',
      includeBefore: false,
    } as never);
    useAppStore.getState().rememberProject('018f0000-0000-7000-8000-aaaaaaaaaaaa');
    render(
      <MemoryRouter>
        <AccountPage />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.logout).toHaveBeenCalled();
    expect(useShareStore.getState().byVariant).toEqual({});
    expect(useAppStore.getState().lastProject).toBeNull();
    expect(window.localStorage.getItem('holiday.shares')).toBeNull();
    expect(api.resetSession).toHaveBeenCalled();
  });
});
