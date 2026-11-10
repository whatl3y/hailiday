import type { Clock } from '../clock/index.js';
import { DAY_MS, systemClock } from '../clock/index.js';

/** Length of the rolling allowance and quota window. */
export const ROLLING_WINDOW_MS = DAY_MS;

/** Exclusive start of the rolling window `(now − 24 h, now]`. */
export function rollingWindowStart(now: Date, windowMs = ROLLING_WINDOW_MS): Date {
  return new Date(now.getTime() - windowMs);
}

/** Whether `instant` falls in `(now − window, now]`. */
export function inRollingWindow(instant: Date, now: Date, windowMs = ROLLING_WINDOW_MS): boolean {
  const t = instant.getTime();
  return t > now.getTime() - windowMs && t <= now.getTime();
}

/** `resetsAt`: the oldest counted timestamp plus the window, or null when nothing is counted. */
export function resetsAtFrom(oldest: Date | null, windowMs = ROLLING_WINDOW_MS): Date | null {
  return oldest ? new Date(oldest.getTime() + windowMs) : null;
}

/** A counted allowance or quota. */
export interface CounterState {
  limit: number;
  /** Units counted in the window (and held, for the variants allowance). */
  used: number;
  remaining: number;
  /** When the oldest counted unit leaves the window; null when nothing is counted. */
  resetsAt: Date | null;
  exhausted: boolean;
}

/** Combines a limit with counted timestamps (and held units that never expire on their own). */
export function counterState(input: {
  limit: number;
  counted: readonly Date[];
  held?: number;
  now: Date;
  windowMs?: number;
}): CounterState {
  const inWindow = input.counted.filter((instant) =>
    inRollingWindow(instant, input.now, input.windowMs),
  );
  const oldest = inWindow.reduce<Date | null>(
    (min, instant) => (min === null || instant < min ? instant : min),
    null,
  );
  const used = inWindow.length + (input.held ?? 0);
  const remaining = Math.max(0, input.limit - used);
  return {
    limit: input.limit,
    used,
    remaining,
    resetsAt: resetsAtFrom(oldest, input.windowMs),
    exhausted: remaining === 0,
  };
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the next unit frees up; 0 when allowed. */
  retryAfterSeconds: number;
  /** When the window fully resets. */
  resetAt: Date;
}

export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

/**
 * In-memory sliding-window counter for abuse quotas and request rate limits, where a miss costs
 * little. Keys are opaque hashes (session, IP hash, token hash), never raw identifiers.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly clock: Clock;
  private readonly maxKeys: number;

  constructor(options: { clock?: Clock; maxKeys?: number } = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxKeys = options.maxKeys ?? 100_000;
  }

  private prune(key: string, now: number, windowMs: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (list.length === 0) this.hits.delete(key);
    else this.hits.set(key, list);
    return list;
  }

  /** Reads the state without counting a hit. */
  peek(key: string, rule: RateLimitRule): RateLimitResult {
    const now = this.clock.now().getTime();
    const list = this.prune(key, now, rule.windowMs);
    return this.result(list, rule, now, list.length < rule.limit);
  }

  /** Counts a hit when allowed; a refused hit is not counted. */
  hit(key: string, rule: RateLimitRule, cost = 1): RateLimitResult {
    const now = this.clock.now().getTime();
    const list = this.prune(key, now, rule.windowMs);
    const allowed = list.length + cost <= rule.limit;
    if (allowed) {
      if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
        const oldestKey = this.hits.keys().next().value;
        if (oldestKey !== undefined) this.hits.delete(oldestKey);
      }
      for (let i = 0; i < cost; i += 1) list.push(now);
      this.hits.set(key, list);
    }
    return this.result(list, rule, now, allowed);
  }

  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }

  private result(list: number[], rule: RateLimitRule, now: number, allowed: boolean) {
    const oldest = list[0];
    const resetAt = new Date((list[list.length - 1] ?? now) + rule.windowMs);
    const retryAfterMs = allowed || oldest === undefined ? 0 : oldest + rule.windowMs - now;
    return {
      allowed,
      limit: rule.limit,
      remaining: Math.max(0, rule.limit - list.length),
      retryAfterSeconds: Math.max(0, Math.ceil(retryAfterMs / 1000)),
      resetAt,
    };
  }
}

/** IETF `RateLimit-Policy` and `RateLimit` structured fields (draft 11) for a response. */
export function rateLimitHeaders(policyName: string, result: RateLimitResult, rule: RateLimitRule) {
  const windowSeconds = Math.ceil(rule.windowMs / 1000);
  const resetSeconds = Math.max(0, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000));
  return {
    'RateLimit-Policy': `"${policyName}";q=${rule.limit};w=${windowSeconds}`,
    RateLimit: `"${policyName}";r=${result.remaining};t=${resetSeconds}`,
  };
}
