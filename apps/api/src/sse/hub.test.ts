import { describe, expect, it } from 'vitest';
import { testConfig } from '@holiday/server/config';
import { createSilentLogger } from '@holiday/server/logger';
import { RenderEventHub } from './hub.js';

function hub(limits: { perOwnerJob?: number; perOwner?: number; total?: number } = {}) {
  return new RenderEventHub({
    config: testConfig(),
    logger: createSilentLogger(),
    enabled: false,
    limits,
  });
}

function stream(events: RenderEventHub, ownerId: string, jobId: string) {
  const handle = { closed: false, release: () => {} };
  handle.release = events.openStream({
    ownerId,
    jobId,
    close: () => {
      handle.closed = true;
      handle.release();
    },
  });
  return handle;
}

describe('RenderEventHub stream bounds', () => {
  it('replaces the oldest stream of an owner and job beyond the per-job bound', () => {
    const events = hub({ perOwnerJob: 2 });
    const first = stream(events, 'owner-a', 'job-1');
    const second = stream(events, 'owner-a', 'job-1');
    const third = stream(events, 'owner-a', 'job-1');
    expect([first.closed, second.closed, third.closed]).toEqual([true, false, false]);
    expect(events.streamCount('owner-a')).toBe(2);
    const other = stream(events, 'owner-b', 'job-1');
    expect(other.closed).toBe(false);
    expect(events.streamCount()).toBe(3);
  });

  it("replaces an owner's oldest stream beyond the per-owner bound", () => {
    const events = hub({ perOwnerJob: 2, perOwner: 3 });
    const streams = ['job-1', 'job-2', 'job-3', 'job-4'].map((jobId) =>
      stream(events, 'owner-a', jobId),
    );
    expect(streams.map((handle) => handle.closed)).toEqual([true, false, false, false]);
    expect(events.streamCount('owner-a')).toBe(3);
  });

  it('refuses a stream with AT_CAPACITY when the process is full, and after closeAll', () => {
    const events = hub({ total: 2 });
    const a = stream(events, 'owner-a', 'job-1');
    stream(events, 'owner-b', 'job-1');
    expect(() => stream(events, 'owner-c', 'job-1')).toThrow(
      expect.objectContaining({ code: 'AT_CAPACITY' }),
    );
    a.release();
    expect(() => stream(events, 'owner-c', 'job-1')).not.toThrow();

    events.closeAll();
    expect(events.streamCount()).toBe(0);
    expect(() => stream(events, 'owner-d', 'job-1')).toThrow(
      expect.objectContaining({ code: 'AT_CAPACITY' }),
    );
  });
});
