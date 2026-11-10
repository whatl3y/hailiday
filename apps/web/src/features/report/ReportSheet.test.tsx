import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import * as turnstile from '../../api/turnstile';
import { apiError } from '../../test/fixtures';
import { ReportSheet } from './ReportSheet';

vi.mock('../../api/endpoints', () => ({ createReport: vi.fn() }));
vi.mock('../../api/turnstile', () => ({
  getTurnstileToken: vi.fn(),
  registerChallengeSlot: vi.fn(() => () => undefined),
}));

const api = vi.mocked(endpoints);
const bot = vi.mocked(turnstile);
const TARGET = { kind: 'render', id: '018f0000-0000-7000-8000-aaaaaaaaaaaa' } as const;

async function submit() {
  render(
    <MemoryRouter>
      <ReportSheet target={TARGET} onClose={() => undefined} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByLabelText('A child is pictured'));
  fireEvent.click(screen.getByRole('button', { name: 'Send report' }));
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

describe('ReportSheet', () => {
  it('shows an error when the bot-check token cannot be obtained', async () => {
    bot.getTurnstileToken.mockRejectedValue(new Error('blocked'));
    await submit();
    expect(api.createReport).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('confirm you');
    expect(screen.getByRole('button', { name: 'Send report' }).getAttribute('aria-disabled')).toBe(
      null,
    );
  });

  it('offers Try again after the wait when reporting is rate limited', async () => {
    bot.getTurnstileToken.mockResolvedValue('fixture-pass');
    api.createReport.mockRejectedValue(apiError('RATE_LIMITED', { retryAfter: '5' }));
    await submit();
    expect(screen.getByRole('alert').textContent).toContain('moving fast');
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });
});
