/** Source of "now" for domain logic; injected so tests control time. All values are UTC. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that only moves when told to. */
export interface ManualClock extends Clock {
  set(instant: Date | string | number): void;
  advance(milliseconds: number): void;
  advanceSeconds(seconds: number): void;
}

export function createManualClock(start: Date | string | number = Date.now()): ManualClock {
  let current = new Date(start).getTime();
  if (Number.isNaN(current)) throw new RangeError(`Invalid clock start: ${String(start)}`);
  return {
    now: () => new Date(current),
    set(instant) {
      const next = new Date(instant).getTime();
      if (Number.isNaN(next)) throw new RangeError(`Invalid instant: ${String(instant)}`);
      current = next;
    },
    advance(milliseconds) {
      current += milliseconds;
    },
    advanceSeconds(seconds) {
      current += seconds * 1000;
    },
  };
}

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** `instant` shifted by a number of milliseconds. */
export function addMs(instant: Date, milliseconds: number): Date {
  return new Date(instant.getTime() + milliseconds);
}

/** Start of the UTC calendar day containing `instant`. */
export function startOfUtcDay(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

/** Start of the UTC calendar month containing `instant`. */
export function startOfUtcMonth(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1));
}

/** Start of the next UTC calendar day. */
export function startOfNextUtcDay(instant: Date): Date {
  return addMs(startOfUtcDay(instant), DAY_MS);
}

/** Start of the next UTC calendar month. */
export function startOfNextUtcMonth(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1));
}

/** ISO 8601 with a `Z` suffix, the only timestamp format the API emits. */
export function toIso(instant: Date): string {
  return instant.toISOString();
}

/** Like `toIso`, passing null through. */
export function toIsoOrNull(instant: Date | null | undefined): string | null {
  return instant ? instant.toISOString() : null;
}
