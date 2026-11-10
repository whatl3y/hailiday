import { describe, expect, it } from 'vitest';
import { createManualClock, HOUR_MS } from '../clock/index.js';
import {
  SlidingWindowLimiter,
  counterState,
  inRollingWindow,
  resetsAtFrom,
  rollingWindowStart,
} from './windows.js';

const now = new Date('2026-11-09T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('rolling 24-hour windows', () => {
  it('excludes the start instant and includes now', () => {
    expect(rollingWindowStart(now).toISOString()).toBe('2026-11-08T12:00:00.000Z');
    expect(inRollingWindow(ago(24 * HOUR_MS), now)).toBe(false);
    expect(inRollingWindow(ago(24 * HOUR_MS - 1), now)).toBe(true);
    expect(inRollingWindow(now, now)).toBe(true);
    expect(inRollingWindow(new Date(now.getTime() + 1), now)).toBe(false);
  });

  it('reports remaining units and resetsAt from the oldest counted unit', () => {
    const state = counterState({
      limit: 3,
      counted: [ago(2 * HOUR_MS), ago(23 * HOUR_MS), ago(25 * HOUR_MS)],
      now,
    });
    expect(state.used).toBe(2);
    expect(state.remaining).toBe(1);
    expect(state.exhausted).toBe(false);
    expect(state.resetsAt?.toISOString()).toBe('2026-11-09T13:00:00.000Z');
  });

  it('holds non-terminal units against the allowance without a reset time', () => {
    const state = counterState({ limit: 3, counted: [ago(HOUR_MS)], held: 2, now });
    expect(state.remaining).toBe(0);
    expect(state.exhausted).toBe(true);
    expect(state.resetsAt?.toISOString()).toBe('2026-11-10T11:00:00.000Z');
    expect(counterState({ limit: 3, counted: [], held: 3, now }).resetsAt).toBeNull();
    expect(resetsAtFrom(null)).toBeNull();
  });
});

describe('SlidingWindowLimiter', () => {
  it('refuses the hit past the limit and frees units as the window slides', () => {
    const clock = createManualClock(now);
    const limiter = new SlidingWindowLimiter({ clock });
    const rule = { limit: 2, windowMs: 10 * 60_000 };
    expect(limiter.hit('session-a', rule).allowed).toBe(true);
    clock.advanceSeconds(60);
    expect(limiter.hit('session-a', rule).allowed).toBe(true);
    const refused = limiter.hit('session-a', rule);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBe(540);
    expect(limiter.hit('session-b', rule).allowed).toBe(true);
    clock.advanceSeconds(540);
    expect(limiter.hit('session-a', rule).allowed).toBe(true);
    expect(limiter.peek('session-a', rule).remaining).toBe(0);
  });
});
