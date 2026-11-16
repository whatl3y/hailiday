import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderStatus } from '@hailiday/core';
import { apiError } from '../test/fixtures';
import { subscribeToRender } from './sse';

const JOB = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e';
const PROJECT = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5f';
const NOW = '2026-11-09T14:03:00.000Z';

function status(seq: number, state: RenderStatus['state']): RenderStatus {
  return {
    renderJobId: JOB,
    projectId: PROJECT,
    projectVersion: 1,
    state,
    stageLabelKey: state === 'rendering' ? 'stage.rendering' : null,
    seq,
    attempt: 1,
    repairUsed: false,
    queuePosition: null,
    holidayId: 'christmas',
    style: 'classic',
    lightingMode: 'source',
    failureKind: null,
    failureDetail: null,
    rejectionReason: null,
    failureCodes: [],
    errorCode: null,
    permittedActions: [],
    variant: null,
    supersededByRenderJobId: null,
    timestamps: {
      requestedAt: NOW,
      sourceReadyAt: null,
      startedAt: null,
      renderStartedAt: null,
      renderCompletedAt: null,
      qaPassedAt: null,
      reviewCompletedAt: null,
      succeededAt: null,
      terminalAt: null,
    },
    allowance: {
      variants: { limit: 3, remaining: 2, resetsAt: null },
      addresses: { limit: 3, remaining: 3, resetsAt: null },
      gate: 'none',
    },
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    const event =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

describe('subscribeToRender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it('delivers stream events in order without duplicates and stops at a terminal state', () => {
    const onStatus = vi.fn();
    const subscription = subscribeToRender(
      JOB,
      { onStatus },
      {
        eventSource: FakeEventSource as unknown as typeof EventSource,
        fetchStatus: vi.fn(),
      },
    );
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe(`/v1/renders/${JOB}/events`);
    source.emit('render', status(3, 'rendering'));
    source.emit('render', status(3, 'rendering'));
    source.emit('render', status(2, 'planning'));
    source.emit('render', status(5, 'succeeded'));
    expect(onStatus.mock.calls.map(([value]) => (value as RenderStatus).seq)).toEqual([3, 5]);
    expect(source.closed).toBe(true);
    expect(subscription.mode).toBe('closed');
  });

  it('delivers an event with a stage key this build does not know, with that key cleared', () => {
    const onStatus = vi.fn();
    subscribeToRender(
      JOB,
      { onStatus },
      {
        eventSource: FakeEventSource as unknown as typeof EventSource,
        fetchStatus: vi.fn(),
      },
    );
    const source = FakeEventSource.instances[0]!;
    source.emit('render', { ...status(2, 'preparing'), stageLabelKey: 'stage.somethingNew' });
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls[0]![0]).toMatchObject({ seq: 2, stageLabelKey: null });
  });

  it('delivers the framing stage with its key, which this page shows', () => {
    const onStatus = vi.fn();
    subscribeToRender(
      JOB,
      { onStatus },
      {
        eventSource: FakeEventSource as unknown as typeof EventSource,
        fetchStatus: vi.fn(),
      },
    );
    const source = FakeEventSource.instances[0]!;
    source.emit('render', { ...status(2, 'preparing'), stageLabelKey: 'stage.framing' });
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls[0]![0]).toMatchObject({ seq: 2, stageLabelKey: 'stage.framing' });
  });

  it('falls back to polling after two failed reconnects and backs off after a minute', async () => {
    let clock = 0;
    const fetchStatus = vi.fn(async () => status(4, 'rendering'));
    const onStatus = vi.fn();
    const subscription = subscribeToRender(
      JOB,
      { onStatus },
      {
        eventSource: FakeEventSource as unknown as typeof EventSource,
        fetchStatus,
        pollMs: 3000,
        backoffMs: 5000,
        backoffAfterMs: 60_000,
        now: () => clock,
      },
    );
    const source = FakeEventSource.instances[0]!;
    source.emit('error');
    source.emit('error');
    expect(subscription.mode).toBe('stream');
    source.emit('error');
    expect(subscription.mode).toBe('poll');
    expect(source.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    clock = 61_000;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchStatus).toHaveBeenCalledTimes(4);
    subscription.close();
  });

  it('polls when EventSource is unavailable and stops at a terminal state', async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(status(2, 'planning'))
      .mockResolvedValueOnce(status(6, 'failed'));
    const onStatus = vi.fn();
    const subscription = subscribeToRender(
      JOB,
      { onStatus },
      { eventSource: null, fetchStatus, pollMs: 3000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onStatus).toHaveBeenCalledTimes(2);
    expect(subscription.mode).toBe('closed');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('stops polling and reports once when the job is gone', async () => {
    const gone = apiError('NOT_FOUND');
    const fetchStatus = vi.fn().mockRejectedValue(gone);
    const onError = vi.fn();
    const subscription = subscribeToRender(
      JOB,
      { onStatus: vi.fn(), onError },
      { eventSource: null, fetchStatus, pollMs: 3000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(gone);
    expect(subscription.mode).toBe('closed');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps polling when the bot check is due, which is a 403 but not a lost job', async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(apiError('VERIFICATION_REQUIRED'))
      .mockResolvedValueOnce(status(4, 'succeeded'));
    const onStatus = vi.fn();
    const subscription = subscribeToRender(
      JOB,
      { onStatus, onError: vi.fn() },
      { eventSource: null, fetchStatus, pollMs: 3000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(subscription.mode).toBe('poll');
    await vi.advanceTimersByTimeAsync(3000);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(subscription.mode).toBe('closed');
  });

  it('keeps polling through a transient failure', async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(status(4, 'succeeded'));
    const onError = vi.fn();
    const subscription = subscribeToRender(
      JOB,
      { onStatus: vi.fn(), onError },
      { eventSource: null, fetchStatus, pollMs: 3000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(subscription.mode).toBe('poll');
    await vi.advanceTimersByTimeAsync(3000);
    expect(subscription.mode).toBe('closed');
  });
});
