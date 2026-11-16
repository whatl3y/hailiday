import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressSuggestionsResponse } from '@hailiday/core';
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

function setup(fetchSuggestions: FetchSuggestions, options: { sampleMode?: boolean } = {}) {
  const onSelect = vi.fn();
  render(
    <AddressCombobox
      label="Enter a US address"
      onSelect={onSelect}
      fetchSuggestions={fetchSuggestions}
      minChars={3}
      debounceMs={250}
      sampleMode={options.sampleMode}
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
      "We couldn't get Hailiday ready for you. Check your connection and try again.",
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

  it('keeps the no-matches notice mounted while the next request runs and after it', async () => {
    let answerSecond: (value: AddressSuggestionsResponse) => void = () => undefined;
    const fetchSuggestions = vi
      .fn<FetchSuggestions>()
      .mockImplementationOnce(async () => response())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerSecond = resolve;
          }),
      );
    const { input } = setup(fetchSuggestions);
    const live = document.querySelector('.combo .sr-only[aria-live="polite"]')!;
    await typeAndSettle(input, '1600 Pennsylvania');
    const notice = screen.getByText(/Address lookup covers US addresses for now/);
    expect(live.textContent).toBe('No matches');

    // The next query is in flight: the loading indicator shows, the notice stays where it is.
    await typeAndSettle(input, '1600 Pennsylvania Ave');
    expect(fetchSuggestions).toHaveBeenCalledTimes(2);
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('.combo__loading')).not.toBeNull();
    expect(notice.isConnected).toBe(true);
    expect(screen.getByText(/Address lookup covers US addresses for now/)).toBe(notice);
    expect(input.getAttribute('aria-describedby')).toContain(notice.id);
    expect(live.textContent).toBe('');

    // A second empty answer keeps the same node and announces the empty state again.
    answerSecond(response());
    await flush();
    expect(input.getAttribute('aria-busy')).toBeNull();
    expect(notice.isConnected).toBe(true);
    expect(screen.getByText(/Address lookup covers US addresses for now/)).toBe(notice);
    expect(live.textContent).toBe('No matches');
    expect(document.activeElement === input || document.activeElement === document.body).toBe(true);
  });

  it('keeps the suggestions open while the next request runs', async () => {
    let answerSecond: (value: AddressSuggestionsResponse) => void = () => undefined;
    const fetchSuggestions = vi
      .fn<FetchSuggestions>()
      .mockImplementationOnce(async () => THREE)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerSecond = resolve;
          }),
      );
    const { input } = setup(fetchSuggestions);
    await typeAndSettle(input, '12 Lan');
    await typeAndSettle(input, '12 Lant');
    expect(input.getAttribute('aria-busy')).toBe('true');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(3);

    answerSecond(response());
    await flush();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(/Address lookup covers US addresses for now/)).toBeTruthy();
  });

  describe('text edited back to the last search', () => {
    const LANT = response(['12 Lantern Terrace', 'Bristol, RI, USA']);
    const byQuery = () => vi.fn<FetchSuggestions>(async (q) => (q === '12 Lant' ? LANT : THREE));

    it('drops the search queued for the text typed in between', async () => {
      const fetchSuggestions = byQuery();
      const { input } = setup(fetchSuggestions);
      await typeAndSettle(input, '12 Lan');
      expect(screen.getAllByRole('option')).toHaveLength(3);

      fireEvent.change(input, { target: { value: '12 Lant' } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.change(input, { target: { value: '12 Lan' } });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      await flush();

      expect(fetchSuggestions).toHaveBeenCalledTimes(1);
      expect((input as HTMLInputElement).value).toBe('12 Lan');
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(3);
      expect(options.some((option) => option.textContent?.includes('12 Lantern Terrace'))).toBe(
        false,
      );
    });

    it('keeps the answer of the request in flight for that text', async () => {
      let answerFirst: (value: AddressSuggestionsResponse) => void = () => undefined;
      const fetchSuggestions = vi
        .fn<FetchSuggestions>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answerFirst = resolve;
            }),
        )
        .mockImplementation(async () => LANT);
      const { input } = setup(fetchSuggestions);
      await typeAndSettle(input, '12 Lan');
      expect(input.getAttribute('aria-busy')).toBe('true');

      fireEvent.change(input, { target: { value: '12 Lant' } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.change(input, { target: { value: '12 Lan' } });
      answerFirst(THREE);
      await flush();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      await flush();

      expect(fetchSuggestions).toHaveBeenCalledTimes(1);
      expect(input.getAttribute('aria-busy')).toBeNull();
      expect(screen.getAllByRole('option')).toHaveLength(3);
      expect(screen.getByText('3 suggestions')).toBeTruthy();
    });

    it('searches the text again when the silent retry for it was replaced', async () => {
      let limited = true;
      const fetchSuggestions = vi.fn<FetchSuggestions>(async (q) => {
        if (limited) {
          limited = false;
          throw apiError('RATE_LIMITED', { retryAfter: '2' });
        }
        return q === '12 Lant' ? LANT : THREE;
      });
      const { input } = setup(fetchSuggestions);
      await typeAndSettle(input, '12 Lan');
      expect(fetchSuggestions).toHaveBeenCalledTimes(1);

      // Waiting to retry: an edit replaces the retry, and the edit back to the text searches again.
      fireEvent.change(input, { target: { value: '12 Lant' } });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      await typeAndSettle(input, '12 Lan');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      await flush();

      expect(fetchSuggestions.mock.calls.map((call) => call[0])).toEqual(['12 Lan', '12 Lan']);
      expect(input.getAttribute('aria-busy')).toBeNull();
      expect(screen.getAllByRole('option')).toHaveLength(3);
    });

    it('keeps the silent retry when the edit leaves the searched text unchanged', async () => {
      let limited = true;
      const fetchSuggestions = vi.fn<FetchSuggestions>(async () => {
        if (limited) {
          limited = false;
          throw apiError('RATE_LIMITED', { retryAfter: '2' });
        }
        return THREE;
      });
      const { input } = setup(fetchSuggestions);
      await typeAndSettle(input, '12 Lan');
      fireEvent.change(input, { target: { value: '12 Lan ' } });
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      await flush();

      expect(fetchSuggestions.mock.calls.map((call) => call[0])).toEqual(['12 Lan', '12 Lan']);
      expect(screen.getAllByRole('option')).toHaveLength(3);
    });
  });

  describe('sample mode', () => {
    const LANTERN = response(['14 Lantern Hill Rd', 'Maplebrook, VT, USA']);
    const lookup = () =>
      vi.fn<FetchSuggestions>(async (q) => (q.startsWith('14 Lantern') ? LANTERN : response()));

    it('says the setup has no Google keys and offers the sample places', async () => {
      const { input } = setup(lookup(), { sampleMode: true });
      await typeAndSettle(input, '1600 Pennsylvania Ave');
      const notice = screen.getByText(/no Google Maps keys/);
      expect(notice.textContent).toBe(
        'No matches. This setup has no Google Maps keys, so address search only knows the ' +
          'sample places. Try one below, or upload a photo to decorate your own place.',
      );
      expect(screen.queryByText(/Check the street number and ZIP/)).toBeNull();
      const group = screen.getByRole('group', { name: 'Sample places' });
      expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
        '14 Lantern Hill',
        '418 Larkspur',
      ]);
      // The live region says that sample places are offered, not only that nothing matched.
      expect(document.querySelector('.combo .sr-only[aria-live="polite"]')!.textContent).toBe(
        'No matches. Sample places are available.',
      );
    });

    it('announces the plain empty state when no sample places are offered', async () => {
      const onSelect = vi.fn();
      render(
        <AddressCombobox
          label="Enter a US address"
          onSelect={onSelect}
          fetchSuggestions={lookup()}
          minChars={3}
          debounceMs={250}
          sampleMode
          samplePlaces={[]}
        />,
      );
      await typeAndSettle(screen.getByRole('combobox'), '1600 Pennsylvania Ave');
      expect(screen.queryByRole('group', { name: 'Sample places' })).toBeNull();
      expect(document.querySelector('.combo .sr-only[aria-live="polite"]')!.textContent).toBe(
        'No matches',
      );
    });

    it("uses the caller's sample-mode empty line when one is given", async () => {
      render(
        <AddressCombobox
          label="Enter a US address"
          onSelect={vi.fn()}
          fetchSuggestions={lookup()}
          minChars={3}
          debounceMs={250}
          sampleMode
          sampleNoResultsKey="optout.noResultsSample"
        />,
      );
      await typeAndSettle(screen.getByRole('combobox'), '1600 Pennsylvania Ave');
      expect(screen.getByText(/no Google Maps keys/).textContent).toBe(
        'No matches. This setup has no Google Maps keys, so address search only knows the ' +
          'sample places. Try one below.',
      );
      expect(screen.getByRole('group', { name: 'Sample places' })).toBeTruthy();
    });

    it('a sample place fills the field, searches at once and opens the list', async () => {
      const fetchSuggestions = lookup();
      const { input, onSelect } = setup(fetchSuggestions, { sampleMode: true });
      input.focus();
      await typeAndSettle(input, '1600 Pennsylvania Ave');
      expect(fetchSuggestions).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: '14 Lantern Hill' }));
      expect((input as HTMLInputElement).value).toBe('14 Lantern Hill');
      expect(fetchSuggestions).toHaveBeenCalledTimes(2);
      expect(fetchSuggestions.mock.calls[1]![0]).toBe('14 Lantern Hill');
      expect(fetchSuggestions.mock.calls[1]![1]).toBe(TOKEN);
      await flush();

      expect(input.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(input);
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(1);
      expect(options[0]!.textContent).toContain('14 Lantern Hill Rd');
      expect(screen.queryByRole('group', { name: 'Sample places' })).toBeNull();
      expect(screen.queryByText(/no Google Maps keys/)).toBeNull();

      fireEvent.click(options[0]!);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls[0]![0]).toMatchObject({
        sessionToken: TOKEN,
        rank: 1,
        suggestion: { primaryText: '14 Lantern Hill Rd' },
      });
    });

    it('does not credit Google for the suggestions', async () => {
      const { input } = setup(lookup(), { sampleMode: true });
      await typeAndSettle(input, '14 Lantern');
      expect(screen.getAllByRole('option')).toHaveLength(1);
      expect(screen.queryByText('Powered by Google')).toBeNull();
    });

    it('live mode keeps the live empty state and the Google attribution', async () => {
      const { input } = setup(lookup());
      await typeAndSettle(input, '1600 Pennsylvania Ave');
      expect(screen.getByText(/Check the street number and ZIP/)).toBeTruthy();
      expect(document.querySelector('.combo .sr-only[aria-live="polite"]')!.textContent).toBe(
        'No matches',
      );
      expect(screen.queryByText(/no Google Maps keys/)).toBeNull();
      expect(screen.queryByRole('group', { name: 'Sample places' })).toBeNull();
      await typeAndSettle(input, '14 Lantern');
      expect(screen.getAllByRole('option')).toHaveLength(1);
      expect(screen.getByText('Powered by Google')).toBeTruthy();
    });

    it("live mode uses the caller's empty line when one is given", async () => {
      render(
        <AddressCombobox
          label="Enter a US address"
          onSelect={vi.fn()}
          fetchSuggestions={lookup()}
          minChars={3}
          debounceMs={250}
          noResultsKey="optout.noResults"
          sampleNoResultsKey="optout.noResultsSample"
        />,
      );
      await typeAndSettle(screen.getByRole('combobox'), '1600 Pennsylvania Ave');
      expect(screen.getByText(/^No matches\./).textContent).toBe(
        'No matches. Check the street number and ZIP. Address lookup covers US addresses for now.',
      );
      expect(screen.queryByText(/enter the address manually/)).toBeNull();
      expect(screen.queryByRole('group', { name: 'Sample places' })).toBeNull();
    });
  });
});
