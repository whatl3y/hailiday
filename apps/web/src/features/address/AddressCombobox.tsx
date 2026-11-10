import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import type { AddressSuggestion, AddressSuggestionsResponse } from '@holiday/core';
import { getAddressSuggestions } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { presentError } from '../../api/present';
import { t, type CopyKey } from '../../copy';
import { CLIENT_DEFAULTS } from '../../config/values';
import { ChallengeSlot } from '../../ui/ChallengeSlot';
import { Icon } from '../../ui/Icon';
import { RetryAfterButton } from '../../ui/RetryAfterButton';

export type FetchSuggestions = (
  q: string,
  sessionToken: string | undefined,
  signal: AbortSignal,
) => Promise<AddressSuggestionsResponse>;

export interface AddressSelection {
  suggestion: AddressSuggestion;
  sessionToken: string;
  /** 1-based position of the chosen row. */
  rank: number;
}

export interface AddressComboboxProps {
  label: string;
  placeholder?: string;
  onSelect: (selection: AddressSelection) => void;
  /** Called when the person edits the text, so a caller can drop a selection it no longer shows. */
  onTextChange?: (text: string) => void;
  fetchSuggestions?: FetchSuggestions;
  minChars?: number;
  debounceMs?: number;
  /** A message about the chosen address (for example out of scope), shown under the field. */
  message?: { key: CopyKey; text: string; tone: 'error' | 'notice' } | null;
  /** Shows the in-field activity indicator while the caller resolves a selection. */
  busy?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  describedBy?: string;
  autoFocus?: boolean;
}

const MAX_ROWS = 5;
const MAX_SILENT_RETRY_SECONDS = 10;

type Status = 'idle' | 'loading' | 'results' | 'empty';

/** A lookup that failed: its message and, when the session could not start, a retry. */
interface LookupFailure {
  key: CopyKey;
  text: string;
  retry: { id: number; query: string; seconds: number } | null;
}

/**
 * The address field: an ARIA combobox with a listbox popup. DOM focus stays in the input and
 * `aria-activedescendant` tracks the highlighted option. Queries need the minimum length,
 * are debounced, cancel stale requests, never repeat identical or just-selected text, and send
 * the typed text only to the suggestions endpoint.
 */
export function AddressCombobox({
  label,
  placeholder,
  onSelect,
  onTextChange,
  fetchSuggestions = getAddressSuggestions,
  minChars = CLIENT_DEFAULTS.autocompleteMinChars,
  debounceMs = CLIENT_DEFAULTS.autocompleteDebounceMs,
  message,
  busy,
  inputRef,
  describedBy,
  autoFocus,
}: AddressComboboxProps) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listboxId = `${baseId}-listbox`;
  const messageId = `${baseId}-message`;

  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState<Status>('idle');
  const [failure, setFailure] = useState<LookupFailure | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const sessionToken = useRef<string | undefined>(undefined);
  const lastQueried = useRef<string | null>(null);
  const selectedText = useRef<string | null>(null);
  const retryId = useRef(0);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      controller.current?.abort();
    },
    [],
  );

  function cancelPending() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    controller.current?.abort();
    controller.current = null;
  }

  function announce(list: AddressSuggestion[]) {
    if (list.length === 0) setAnnouncement(t('address.noMatchesShort'));
    else if (list.length === 1) setAnnouncement(t('address.oneSuggestion'));
    else setAnnouncement(t('address.suggestionsCount', { n: list.length }));
  }

  async function runQuery(query: string, attempt: number) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const requestNumber = ++sequence.current;
    lastQueried.current = query;
    setStatus('loading');
    // Cleared while the request runs, so an unchanged count is announced again.
    setAnnouncement('');
    try {
      const response = await fetchSuggestions(query, sessionToken.current, current.signal);
      if (requestNumber !== sequence.current) return;
      sessionToken.current = response.sessionToken;
      const rows = response.suggestions.slice(0, MAX_ROWS);
      setSuggestions(rows);
      setActiveIndex(-1);
      setOpen(rows.length > 0);
      setStatus(rows.length > 0 ? 'results' : 'empty');
      setFailure(null);
      announce(rows);
    } catch (error) {
      if (requestNumber !== sequence.current || current.signal.aborted) return;
      if (isApiError(error) && error.kind === 'aborted') return;
      // The suggestions limit is retried once silently. A session that cannot start is not:
      // its wait is long and the same for every call, so it is said at once.
      if (isApiError(error) && error.code === 'RATE_LIMITED' && !error.session && attempt === 0) {
        const wait = Math.min(error.retryAfterSeconds ?? 2, MAX_SILENT_RETRY_SECONDS);
        timer.current = setTimeout(() => void runQuery(query, 1), wait * 1000);
        return;
      }
      lastQueried.current = null;
      setStatus('idle');
      setOpen(false);
      setSuggestions([]);
      const inline = presentError(error);
      const retry =
        isApiError(error) && error.session
          ? {
              id: ++retryId.current,
              query,
              seconds: error.code === 'RATE_LIMITED' ? (error.retryAfterSeconds ?? 0) : 0,
            }
          : null;
      setFailure(inline ? { key: inline.key, text: inline.message, retry } : null);
    }
  }

  function onInputChange(value: string) {
    setText(value);
    setFailure(null);
    setAnnouncement('');
    onTextChange?.(value);
    const query = value.trim();
    if (query.length < minChars) {
      cancelPending();
      sequence.current += 1;
      lastQueried.current = null;
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
      setStatus('idle');
      return;
    }
    if (query === lastQueried.current || value === selectedText.current) return;
    selectedText.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void runQuery(query, 0);
    }, debounceMs);
  }

  function select(index: number) {
    const suggestion = suggestions[index];
    const token = sessionToken.current;
    if (!suggestion || !token) return;
    const display = `${suggestion.primaryText}, ${suggestion.secondaryText}`;
    cancelPending();
    selectedText.current = display;
    lastQueried.current = display.trim();
    setText(display);
    setOpen(false);
    setActiveIndex(-1);
    setStatus('idle');
    // The resolve call terminates this autocomplete session; a new search mints a new token.
    sessionToken.current = undefined;
    onSelect({ suggestion, sessionToken: token, rank: index + 1 });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const count = suggestions.length;
    switch (event.key) {
      case 'ArrowDown':
        if (count === 0) return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(0);
        } else {
          setActiveIndex((index) => (index + 1) % count);
        }
        return;
      case 'ArrowUp':
        if (count === 0) return;
        event.preventDefault();
        if (!open) {
          setOpen(true);
          setActiveIndex(count - 1);
        } else {
          setActiveIndex((index) => (index <= 0 ? count - 1 : index - 1));
        }
        return;
      case 'Enter':
        if (open && activeIndex >= 0) {
          event.preventDefault();
          select(activeIndex);
        }
        return;
      case 'Escape':
        if (open) {
          event.preventDefault();
          setOpen(false);
          setActiveIndex(-1);
        }
        return;
      case 'Home':
      case 'End': {
        setActiveIndex(-1);
        const input = event.currentTarget;
        event.preventDefault();
        const position = event.key === 'Home' ? 0 : input.value.length;
        input.setSelectionRange(position, position);
        return;
      }
      default:
        return;
    }
  }

  const expanded = open && suggestions.length > 0;
  const activeId = expanded && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;
  const loading = status === 'loading' || busy;
  const noResults = !failure && status === 'empty';
  const visibleMessage = failure
    ? { text: failure.text, tone: 'error' as const }
    : noResults
      ? { text: t('address.noResults'), tone: 'notice' as const }
      : message
        ? { text: message.text, tone: message.tone }
        : null;
  const describedByIds = [describedBy, visibleMessage ? messageId : null].filter(Boolean).join(' ');
  const invalid = visibleMessage?.tone === 'error';
  // The empty-results notice is already spoken by the live region ("No matches").
  const messageRole = invalid ? 'alert' : noResults ? undefined : 'status';

  return (
    <div className="combo">
      <label className="combo__label" htmlFor={inputId}>
        {label}
      </label>
      <div className="combo__field" data-open={expanded || undefined}>
        <Icon name="search" className="combo__icon" />
        <input
          ref={inputRef}
          id={inputId}
          className="combo__input"
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={describedByIds || undefined}
          aria-invalid={invalid || undefined}
          aria-busy={loading || undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="words"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={placeholder}
          value={text}
          autoFocus={autoFocus}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setOpen(false);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            if (suggestions.length > 0 && status === 'results') setOpen(true);
          }}
        />
        {loading ? (
          <span className="combo__loading" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        ) : null}
      </div>
      <div className="combo__popup" hidden={!expanded}>
        <ul id={listboxId} className="combo__listbox" role="listbox" aria-label={label}>
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.placeId}
              id={`${listboxId}-option-${index}`}
              className="combo__option"
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => select(index)}
            >
              <Icon name="pin" className="combo__option-icon" />
              <span className="combo__option-text">
                <span className="combo__primary">{suggestion.primaryText}</span>
                <span className="combo__secondary">{suggestion.secondaryText}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="combo__attribution">{t('address.poweredByGoogle')}</p>
      </div>
      <ChallengeSlot />
      {visibleMessage ? (
        <p
          key={`${visibleMessage.tone}:${visibleMessage.text}`}
          id={messageId}
          className={`combo__message combo__message--${visibleMessage.tone}`}
          role={messageRole}
        >
          {visibleMessage.text}
        </p>
      ) : null}
      {failure?.retry ? (
        <RetryAfterButton
          key={failure.retry.id}
          className="button button--small combo__retry"
          retryAfterSeconds={failure.retry.seconds}
          onRetry={() => {
            const query = failure.retry?.query;
            if (!query) return;
            setFailure(null);
            void runQuery(query, 0);
          }}
        />
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
