import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressSuggestionsResponse } from '@holiday/core';
import { sessionError } from '../../api/errors';
import { apiError } from '../../test/fixtures';
import { AddressCombobox, type FetchSuggestions } from './AddressCombobox';

const TOKEN = '6f1c1c1e-5b0a-4c47-9f4c-1f6f6f2b8a11';

function response(...rows: Array<[string, string]>): AddressSuggestionsResponse {
  return {
    sessionToken: TOKEN,
    suggestions: rows.map(([primaryText, secondaryText], index) => ({
      placeId: `place-${index}`,
      primaryText,
      secondaryText,
    })),
  };
}

const THREE = response(
  ['12 Lantern Hill Rd', 'Maplewood, VT, USA'],
  ['12 Lantern Ln', 'Cedar Falls, IA, USA'],
  ['12 Lantern Way', 'Ashford, CT, USA'],
);

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setup(fetchSuggestions: FetchSuggestions) {
  const onSelect = vi.fn();
  render(
    <AddressCombobox
      label="Enter a US address"
      onSelect={onSelect}
      fetchSuggestions={fetchSuggestions}
      minChars={3}
      debounceMs={250}
    />,
  );
  const input = screen.getByRole('combobox');
  return { input, onSelect };
}

async function typeAndSettle(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
  act(() => {
    vi.advanceTimersByTime(250);
  });
  await flush();
}

describe('AddressCombobox', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('exposes the ARIA combobox pattern', () => {
    const { input } = setup(vi.fn());
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    const listbox = document.getElementById(input.getAttribute('aria-controls')!);
    expect(listbox?.getAttribute('role')).toBe('listbox');
  });

  it('waits for the minimum length and debounces typing into one request', async () => {
    const fetchSuggestions = vi.fn<FetchSuggestions>(async () => THREE);
    const { input } = setup(fetchSuggestions);
    fireEvent.change(input, { target: { value: '12' } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(fetchSuggestions).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '12 L' } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.change(input, { target: { value: '12 La' } });
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(fetchSuggestions).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(fetchSuggestions).toHaveBeenCalledTimes(1);
    expect(fetchSuggestions.mock.calls[0]![0]).toBe('12 La');
    expect(fetchSuggestions.mock.calls[0]![1]).toBeUndefined();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('3 suggestions')).toBeTruthy();
  });

  it('moves the active option with the arrow keys and accepts with Enter', async () => {
    const { input, onSelect } = setup(vi.fn<FetchSuggestions>(async () => THREE));
    await typeAndSettle(input, '12 Lantern');
    const options = screen.getAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]!.id);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]!.id);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({
      sessionToken: TOKEN,
      rank: 3,
      suggestion: { placeId: 'place-2' },
    });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect((input as HTMLInputElement).value).toBe('12 Lantern Way, Ashford, CT, USA');
    expect(document.activeElement === input || document.activeElement === document.body).toBe(true);
  });

  it('closes with Escape and reopens with ArrowDown', async () => {
    const { input } = setup(vi.fn<FetchSuggestions>(async () => THREE));
    await typeAndSettle(input, '12 Lantern');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id);
  });

  it('Home and End leave the list and move the caret in the text', async () => {
    const { input } = setup(vi.fn<FetchSuggestions>(async () => THREE));
    await typeAndSettle(input, '12 Lantern');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    expect((input as HTMLInputElement).selectionStart).toBe(0);
    fireEvent.keyDown(input, { key: 'End' });
    expect((input as HTMLInputElement).selectionStart).toBe('12 Lantern'.length);
  });

  it('renders only the latest response when an older request resolves late', async () => {
    let resolveFirst: (value: AddressSuggestionsResponse) => void = () => undefined;
    const fetchSuggestions = vi
      .fn<FetchSuggestions>()
      .mockImplementationOnce(
        (_q, _token, signal) =>
          new Promise((resolve, reject) => {
            resolveFirst = resolve;
            signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      )
      .mockImplementationOnce(async () => response(['99 Orchard Bend', 'Hollis, NH, USA']));
    const { input } = setup(fetchSuggestions);
    await typeAndSettle(input, '12 Lan');
    await typeAndSettle(input, '99 Orch');
    expect((fetchSuggestions.mock.calls[0]![2] as AbortSignal).aborted).toBe(true);
    resolveFirst(THREE);
    await flush();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('99 Orchard Bend');
  });

  it('never re-queries the just-selected text and reuses the session token within a search', async () => {
    const fetchSuggestions = vi.fn<FetchSuggestions>(async () => THREE);
    const { input, onSelect } = setup(fetchSuggestions);
    await typeAndSettle(input, '12 Lan');
    await typeAndSettle(input, '12 Lant');
    expect(fetchSuggestions.mock.calls[1]![1]).toBe(TOKEN);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(fetchSuggestions).toHaveBeenCalledTimes(2);
  });

  it('shows the no-results line with US scope messaging and announces it', async () => {
    const { input } = setup(vi.fn<FetchSuggestions>(async () => response()));
    await typeAndSettle(input, 'Rue de Rivoli');
    expect(screen.getByText(/Address lookup covers US addresses for now/)).toBeTruthy();
    expect(screen.getByText('No matches')).toBeTruthy();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('announces an unchanged count again after the next query', async () => {
    const fetchSuggestions = vi.fn<FetchSuggestions>(async () => THREE);
    const { input } = setup(fetchSuggestions);
    const live = document.querySelector('.combo .sr-only[aria-live="polite"]')!;
    await typeAndSettle(input, '12 Lantern');
    expect(live.textContent).toBe('3 suggestions');

    fireEvent.change(input, { target: { value: '12 Lantern H' } });
    expect(live.textContent).toBe('');
    act(() => {
      vi.advanceTimersByTime(250);
    });
    await flush();
    expect(fetchSuggestions).toHaveBeenCalledTimes(2);
    expect(live.textContent).toBe('3 suggestions');
  });

  it('announces a failed lookup and flags the field invalid', async () => {
    const { input } = setup(
      vi.fn<FetchSuggestions>(async () => {
        throw apiError('RATE_LIMITED', { retryAfter: '1' });
      }),
    );
    await typeAndSettle(input, '12 Lantern');
    // The first rate-limited answer is retried silently; the second is shown.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe("You're moving fast. Give it a moment and try again.");
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('says at once when the session cannot start, and retries after Retry-After', async () => {
    let refuse = true;
    const fetchSuggestions = vi.fn<FetchSuggestions>(async () => {
      if (refuse) throw sessionError(apiError('RATE_LIMITED', { retryAfter: '30' }));
      return THREE;
    });
    const { input } = setup(fetchSuggestions);
    await typeAndSettle(input, '12 Lantern');

    // No silent wait: the session line shows as soon as the call fails.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(
      'We need a short breather: lots of visits came from your connection just now. ' +
        'Try again in about 30 seconds.',
    );
    expect(input.getAttribute('aria-busy')).toBeNull();
    expect(fetchSuggestions).toHaveBeenCalledTimes(1);

    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(retry);
    expect(fetchSuggestions).toHaveBeenCalledTimes(1);

    for (let second = 0; second < 30; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    refuse = false;
    expect(retry.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(retry);
    await flush();
    expect(fetchSuggestions).toHaveBeenCalledTimes(2);
    expect(fetchSuggestions.mock.calls[1]![0]).toBe('12 Lantern');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers "Try again" at once when the session failed for another reason', async () => {
    const fetchSuggestions = vi.fn<FetchSuggestions>(async () => {
      throw sessionError(new TypeError('Failed to fetch'));
    });
    const { input } = setup(fetchSuggestions);
    await typeAndSettle(input, '12 Lantern');
    expect(screen.getByRole('alert').textContent).toBe(
      "We couldn't get Holiday ready for you. Check your connection and try again.",
    );
    expect(
      screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('announces an error message from the caller', () => {
    render(
      <AddressCombobox
        label="Enter a US address"
        onSelect={vi.fn()}
        fetchSuggestions={vi.fn()}
        message={{
          key: 'error.ADDRESS_OUT_OF_SCOPE',
          text: 'Address lookup covers US addresses for now. You can still upload a photo of any place.',
          tone: 'error',
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toMatch(/covers US addresses/);
    expect(screen.getByRole('combobox').getAttribute('aria-invalid')).toBe('true');
  });

  it('does not flag the field invalid for the no-results notice', async () => {
    const { input } = setup(vi.fn<FetchSuggestions>(async () => response()));
    await typeAndSettle(input, 'Rue de Rivoli');
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
