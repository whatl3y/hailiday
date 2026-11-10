import {
  RENDER_SSE_EVENT,
  RenderEventSchema,
  isTerminalRenderJobState,
  type RenderStatus,
} from '@holiday/core';
import { CLIENT_DEFAULTS } from '../config/values';
import { isApiError } from './errors';

export interface RenderSubscriptionHandlers {
  onStatus(status: RenderStatus): void;
  /**
   * Called when a poll fails. A transient failure keeps the subscription polling; a permanent
   * one (the job is gone or not this session's) closes it first.
   */
  onError?(error: unknown): void;
}

/**
 * Poll failures that will never succeed on retry: the job is not found or not this session's.
 * A coded error decides by its code, so `VERIFICATION_REQUIRED` (also a 403) keeps polling; an
 * uncoded one decides by its status.
 */
export function isPermanentRenderError(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.code !== null) return error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN';
  return error.status === 401 || error.status === 403 || error.status === 404;
}

export interface RenderSubscriptionOptions {
  pollMs?: number;
  backoffMs?: number;
  backoffAfterMs?: number;
  /** Failed reconnects tolerated before falling back to polling. */
  maxReconnectFailures?: number;
  eventSource?: typeof EventSource | null;
  fetchStatus: (renderJobId: string, signal: AbortSignal) => Promise<RenderStatus>;
  /** Decides which poll failures stop the subscription (default: `isPermanentRenderError`). */
  isPermanentError?: (error: unknown) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RenderSubscription {
  close(): void;
  readonly mode: 'stream' | 'poll' | 'closed';
}

/**
 * Follows one render job: Server-Sent Events from `GET /v1/renders/:id/events` (the browser
 * resends `Last-Event-ID` on reconnect), with a polling fallback on `GET /v1/renders/:id`
 * when `EventSource` is unavailable or two reconnects fail. Statuses are delivered in `seq`
 * order without duplicates, and everything stops at a terminal state or a permanent error.
 */
export function subscribeToRender(
  renderJobId: string,
  handlers: RenderSubscriptionHandlers,
  options: RenderSubscriptionOptions,
): RenderSubscription {
  const pollMs = options.pollMs ?? CLIENT_DEFAULTS.pollRenderMs;
  const backoffMs = options.backoffMs ?? CLIENT_DEFAULTS.pollRenderBackoffMs;
  const backoffAfterMs = options.backoffAfterMs ?? CLIENT_DEFAULTS.pollBackoffAfterMs;
  const maxFailures = options.maxReconnectFailures ?? 2;
  const isPermanent = options.isPermanentError ?? isPermanentRenderError;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  const EventSourceCtor =
    options.eventSource === undefined
      ? typeof EventSource === 'undefined'
        ? null
        : EventSource
      : options.eventSource;

  let mode: 'stream' | 'poll' | 'closed' = 'stream';
  let lastSeq = -1;
  let source: EventSource | null = null;
  let failures = 0;
  let pollTimer: unknown = null;
  let pollStartedAt = 0;
  let abort: AbortController | null = null;

  const isClosed = () => mode === 'closed';

  const deliver = (status: RenderStatus) => {
    if (mode === 'closed' || status.renderJobId !== renderJobId) return;
    if (status.seq <= lastSeq) return;
    lastSeq = status.seq;
    handlers.onStatus(status);
    if (isTerminalRenderJobState(status.state)) close();
  };

  const close = () => {
    mode = 'closed';
    source?.close();
    source = null;
    if (pollTimer !== null) clearTimer(pollTimer);
    pollTimer = null;
    abort?.abort();
  };

  const schedulePoll = (delay: number) => {
    if (mode !== 'poll') return;
    pollTimer = setTimer(() => void pollOnce(), delay);
  };

  const pollOnce = async () => {
    if (mode !== 'poll') return;
    abort = new AbortController();
    try {
      deliver(await options.fetchStatus(renderJobId, abort.signal));
    } catch (error) {
      if (isClosed()) return;
      if (isPermanent(error)) {
        close();
        handlers.onError?.(error);
        return;
      }
      handlers.onError?.(error);
    }
    const elapsed = now() - pollStartedAt;
    schedulePoll(elapsed >= backoffAfterMs ? backoffMs : pollMs);
  };

  const startPolling = () => {
    if (mode === 'closed') return;
    source?.close();
    source = null;
    mode = 'poll';
    pollStartedAt = now();
    void pollOnce();
  };

  if (!EventSourceCtor) {
    startPolling();
  } else {
    source = new EventSourceCtor(`/v1/renders/${encodeURIComponent(renderJobId)}/events`, {
      withCredentials: false,
    });
    source.addEventListener(RENDER_SSE_EVENT, (event) => {
      failures = 0;
      try {
        const parsed = RenderEventSchema.safeParse(
          JSON.parse((event as MessageEvent<string>).data),
        );
        if (parsed.success) deliver(parsed.data);
      } catch {
        // A malformed event is ignored; the next one or the poll carries the state.
      }
    });
    source.addEventListener('open', () => {
      failures = 0;
    });
    source.addEventListener('error', () => {
      if (mode !== 'stream' || !source) return;
      // A stream the browser will not reopen (for example after a 204) hands over to polling,
      // which confirms the latest state and stops at a terminal one.
      if (source.readyState === 2) {
        startPolling();
        return;
      }
      failures += 1;
      if (failures > maxFailures) startPolling();
    });
  }

  return {
    close,
    get mode() {
      return mode;
    },
  };
}
