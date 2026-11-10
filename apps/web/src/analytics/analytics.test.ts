import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsBatch } from '@holiday/core';
import { ensureSession, resetSession } from '../api/endpoints';
import { CLIENT_DEFAULTS } from '../config/values';
import { useAppStore } from '../state/appStore';
import { chooseHolidayExplicitly } from '../ui/holidaySelection';
import { createAnalyticsQueue } from './analytics';
import { analytics } from './index';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('the analytics queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('holds events while the page has no session, then sends them once it has one', () => {
    let session = false;
    let ready: (() => void) | null = null;
    const send = vi.fn<(batch: AnalyticsBatch, keepalive: boolean) => Promise<void>>(
      async () => undefined,
    );
    const queue = createAnalyticsQueue({
      send,
      hasSession: () => session,
      onSessionReady: (listener) => {
        ready = listener;
      },
      flushMs: 100,
      maxBatch: 2,
    });

    queue.track('compare_used', { mode: 'slider' });
    queue.track('compare_used', { mode: 'toggle' });
    queue.track('compare_used', { mode: 'slider' });
    vi.advanceTimersByTime(1_000);
    queue.flush(true);
    expect(send).not.toHaveBeenCalled();
    expect(queue.size()).toBe(3);

    session = true;
    ready!();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(([batch]) => batch.events.length)).toEqual([2, 1]);
    expect(queue.size()).toBe(0);
  });

  it('keeps only the newest events while it waits', () => {
    const send = vi.fn(async () => undefined);
    const queue = createAnalyticsQueue({ send, hasSession: () => false, maxBatch: 2, maxHeld: 3 });
    for (let index = 0; index < 5; index += 1) queue.track('compare_used', { mode: 'slider' });
    expect(queue.size()).toBe(3);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the app analytics queue', () => {
  let paths: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetSession();
    useAppStore.setState({ experience: null, allowance: null });
    paths = [];
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const path = String(input).split('?')[0]!;
      paths.push(path);
      if (path === '/v1/sessions') return json(201, { expiresAt: '2026-11-10T12:00:00.000Z' });
      return json(202, {});
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSession();
  });

  it('never starts a session: a holiday choice and an idle page send nothing', async () => {
    chooseHolidayExplicitly('halloween', 'landing');
    expect(analytics.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(CLIENT_DEFAULTS.analyticsFlushMs * 3);
    analytics.flush(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(paths).toEqual([]);

    // Something else starts the session (here the person starts typing an address).
    await ensureSession();
    await vi.advanceTimersByTimeAsync(0);
    expect(paths).toEqual(['/v1/sessions', '/v1/analytics']);
    expect(analytics.size()).toBe(0);
  });
});
