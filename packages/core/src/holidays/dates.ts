/**
 * Calendar-date utilities. A civil date is a `YYYY-MM-DD` string with no timezone; such
 * strings compare correctly with `<`, `>` and `===`.
 */

export type CivilDate = string;

/** Editorial timezone in which the server resolves the hero and the commerce windows. */
export const EDITORIAL_TIMEZONE = 'America/New_York';

const CIVIL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isCivilDate(value: string): boolean {
  const match = CIVIL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Builds a civil date from year, month (1–12) and day; out-of-range values roll over. */
export function civilDate(year: number, month: number, day: number): CivilDate {
  const date = new Date(Date.UTC(year, month - 1, day));
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function parseCivilDate(value: CivilDate): { year: number; month: number; day: number } {
  const match = CIVIL_DATE_PATTERN.exec(value);
  if (!match || !isCivilDate(value)) throw new RangeError(`Invalid civil date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addDays(value: CivilDate, days: number): CivilDate {
  const { year, month, day } = parseCivilDate(value);
  return civilDate(year, month, day + days);
}

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: CivilDate, b: CivilDate): number {
  const pa = parseCivilDate(a);
  const pb = parseCivilDate(b);
  return Math.round(
    (Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) /
      86_400_000,
  );
}

/** Day of week, 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(value: CivilDate): number {
  const { year, month, day } = parseCivilDate(value);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Inclusive range check on civil dates. */
export function isDateInRange(value: CivilDate, start: CivilDate, end: CivilDate): boolean {
  return value >= start && value <= end;
}

/** Whether a string names a timezone this runtime knows. */
export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export type InstantInput = Date | number | string;

function toEpochMs(instant: InstantInput): number {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid instant: ${String(instant)}`);
  return ms;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** The local calendar date of an instant in a timezone. Never evaluated on UTC. */
export function localDateIn(instant: InstantInput, timeZone: string): CivilDate {
  const p = zonedParts(toEpochMs(instant), timeZone);
  return civilDate(p.year, p.month, p.day);
}

/** Offset of a timezone from UTC at an instant, in milliseconds. */
export function timeZoneOffsetMs(instant: InstantInput, timeZone: string): number {
  const epochMs = toEpochMs(instant);
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant at which a local wall-clock time (`YYYY-MM-DDTHH:mm[:ss]`) occurs in a timezone.
 * Nonexistent local times (spring-forward gaps) resolve forward by the gap.
 */
export function zonedTimeToInstant(localDateTime: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    localDateTime,
  );
  if (!match) throw new RangeError(`Invalid local date-time: ${localDateTime}`);
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match;
  const wallAsUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  let guess = wallAsUtc - timeZoneOffsetMs(wallAsUtc, timeZone);
  const corrected = wallAsUtc - timeZoneOffsetMs(guess, timeZone);
  if (corrected !== guess) guess = corrected;
  return new Date(guess);
}

/** The instant a local calendar date starts in a timezone. */
export function startOfLocalDate(date: CivilDate, timeZone: string): Date {
  return zonedTimeToInstant(`${date}T00:00:00`, timeZone);
}
