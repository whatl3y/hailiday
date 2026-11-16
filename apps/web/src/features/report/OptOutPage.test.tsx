import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import * as turnstile from '../../api/turnstile';
import { useAppStore } from '../../state/appStore';
import { OptOutPage } from './OptOutPage';

vi.mock('../../api/endpoints', () => ({ getAddressSuggestions: vi.fn(), createReport: vi.fn() }));
vi.mock('../../api/turnstile', () => ({
  getTurnstileToken: vi.fn(),
  registerChallengeSlot: vi.fn(() => () => undefined),
}));

const api = vi.mocked(endpoints);
const bot = vi.mocked(turnstile);

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setup() {
  render(
    <MemoryRouter>
      <OptOutPage />
    </MemoryRouter>,
  );
  const input = screen.getByRole('combobox');
  fireEvent.change(screen.getByLabelText('Your email, so we can confirm'), {
    target: { value: 'owner@example.com' },
  });
  return input;
}

async function chooseFirst(input: HTMLElement) {
  fireEvent.change(input, { target: { value: '12 Lantern' } });
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  await flush();
  fireEvent.click(screen.getByRole('option', { name: /12 Lantern Hill Rd/ }));
}

beforeEach(() => {
  vi.useFakeTimers();
  api.getAddressSuggestions.mockResolvedValue({
    sessionToken: '6f1c1c1e-5b0a-4c47-9f4c-1f6f6f2b8a11',
    suggestions: [
      {
        placeId: 'place-1',
        primaryText: '12 Lantern Hill Rd',
        secondaryText: 'Maplewood, VT, USA',
      },
    ],
  });
  api.createReport.mockResolvedValue({ reportId: 'r' } as never);
  bot.getTurnstileToken.mockResolvedValue('fixture-pass');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  useAppStore.setState({ fixtureCapabilities: [] });
});

describe('OptOutPage', () => {
  it('does not file the request for an address the field no longer shows', async () => {
    const input = setup();
    await chooseFirst(input);
    fireEvent.change(input, { target: { value: '14 Lantern Hill Rd, Maplewood, VT, USA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await flush();
    expect(api.createReport).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Choose the address from the list.');
  });

  it('files the request for the chosen address', async () => {
    const input = setup();
    await chooseFirst(input);
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await flush();
    await flush();
    expect(api.createReport.mock.calls[0]![0]).toMatchObject({
      target: { kind: 'address', placeId: 'place-1' },
      reason: 'this_is_my_home',
    });
  });

  it('says so when the bot check cannot run, instead of failing silently', async () => {
    bot.getTurnstileToken.mockRejectedValue(new Error('blocked'));
    const input = setup();
    await chooseFirst(input);
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await flush();
    await flush();
    expect(api.createReport).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('confirm you');
  });

  it('with live lookup, the empty state names no manual entry or photo upload', async () => {
    api.getAddressSuggestions.mockResolvedValue({
      sessionToken: '6f1c1c1e-5b0a-4c47-9f4c-1f6f6f2b8a11',
      suggestions: [],
    });
    const input = setup();
    fireEvent.change(input, { target: { value: '1600 Pennsylvania Ave' } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    const notice = screen.getByText(/^No matches\./);
    expect(notice.textContent).toBe(
      'No matches. Check the street number and ZIP. Address lookup covers US addresses for now.',
    );
    expect(notice.textContent).not.toMatch(/manual|upload/i);
    expect(screen.queryByRole('group', { name: 'Sample places' })).toBeNull();
    expect(document.querySelector('.sr-only[aria-live="polite"]')!.textContent).toBe('No matches');
  });

  describe('without Google keys (sample mode)', () => {
    beforeEach(() => {
      useAppStore.setState({ fixtureCapabilities: ['address_lookup'] });
      api.getAddressSuggestions.mockResolvedValue({
        sessionToken: '6f1c1c1e-5b0a-4c47-9f4c-1f6f6f2b8a11',
        suggestions: [],
      });
    });

    it('offers the sample places without mentioning a photo upload the page does not have', async () => {
      const input = setup();
      fireEvent.change(input, { target: { value: '1600 Pennsylvania Ave' } });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      await flush();
      const notice = screen.getByText(/no Google Maps keys/);
      expect(notice.textContent).toBe(
        'No matches. This setup has no Google Maps keys, so address search only knows the ' +
          'sample places. Try one below.',
      );
      expect(notice.textContent).not.toMatch(/upload/i);
      expect(screen.getByRole('group', { name: 'Sample places' })).toBeTruthy();
      expect(document.querySelector('.sr-only[aria-live="polite"]')!.textContent).toBe(
        'No matches. Sample places are available.',
      );
    });
  });
});
