import type { HolidayId } from '../types/content.js';
import { DEFAULT_ENABLED_HOLIDAY_IDS, isHolidayId } from './catalog.js';
import type { CivilDate, InstantInput } from './dates.js';
import {
  EDITORIAL_TIMEZONE,
  daysBetween,
  isDateInRange,
  isValidTimeZone,
  localDateIn,
} from './dates.js';
import type { PromotionWindow } from './occurrences.js';
import { nextCelebrationStart, occurrencesForYears } from './occurrences.js';

/** Default editorial priority for windows that do not carry one. */
const DEFAULT_PRIORITY = 100;

/** The enabled default catalog around a date: previous, current and next year. */
export function defaultCatalogAround(
  date: CivilDate,
  holidayIds: readonly HolidayId[] = DEFAULT_ENABLED_HOLIDAY_IDS,
  region = 'US',
): PromotionWindow[] {
  const year = Number(date.slice(0, 4));
  return occurrencesForYears([year - 1, year, year + 1], holidayIds, region);
}

/**
 * The promotion window that contains a local date. Overlaps resolve to the lower editorial
 * priority, then to the nearer celebration date, then to catalog order.
 */
export function windowContaining<W extends PromotionWindow>(
  date: CivilDate,
  catalog: readonly W[],
): W | null {
  const containing = catalog.filter((window) =>
    isDateInRange(date, window.promotionStart, window.promotionEnd),
  );
  if (containing.length <= 1) return containing[0] ?? null;
  const distance = (window: W) =>
    window.celebrationStart ? Math.abs(daysBetween(date, window.celebrationStart)) : Infinity;
  return (
    [...containing].sort(
      (a, b) =>
        (a.editorialPriority ?? DEFAULT_PRIORITY) - (b.editorialPriority ?? DEFAULT_PRIORITY) ||
        distance(a) - distance(b),
    )[0] ?? null
  );
}

/**
 * Precedence step 2: the holiday whose promotion window contains the instant's local date in
 * `timeZone`, or null when off-season. When `catalog` is omitted the default enabled
 * occurrences around that date are used.
 */
export function resolveDefaultHoliday(
  instant: InstantInput,
  timeZone: string = EDITORIAL_TIMEZONE,
  catalog?: readonly PromotionWindow[],
): HolidayId | null {
  return resolveDefaultWindow(instant, timeZone, catalog)?.holidayId ?? null;
}

/** Like `resolveDefaultHoliday`, returning the containing window itself. */
export function resolveDefaultWindow<W extends PromotionWindow = PromotionWindow>(
  instant: InstantInput,
  timeZone: string = EDITORIAL_TIMEZONE,
  catalog?: readonly W[],
): W | PromotionWindow | null {
  const date = localDateIn(instant, resolveClientTimeZone(timeZone));
  return windowContaining(date, catalog ?? defaultCatalogAround(date));
}

/** Whether the instant is outside every promotion window. */
export function isOffSeason(
  instant: InstantInput,
  timeZone: string = EDITORIAL_TIMEZONE,
  catalog?: readonly PromotionWindow[],
): boolean {
  return resolveDefaultHoliday(instant, timeZone, catalog) === null;
}

export type HolidaySelectionSource =
  'explicit' | 'saved_project' | 'deep_link' | 'in_window' | 'off_season';

export interface HolidaySelection {
  holidayId: HolidayId | null;
  source: HolidaySelectionSource;
  /** True only when no holiday is selected; no render auto-starts. */
  offSeason: boolean;
}

export interface SelectHolidayInput {
  /** A holiday chosen in this session through the picker. */
  explicitHolidayId?: string | null;
  /** The holiday stored on the saved project being viewed. */
  savedProjectHolidayId?: string | null;
  /** The `?holiday=` deep link value; unknown or disabled values are ignored. */
  deepLinkHolidayId?: string | null;
  /** Holidays with an enabled occurrence; explicit values outside it are ignored. */
  enabledHolidayIds?: readonly HolidayId[];
  instant: InstantInput;
  timeZone?: string;
  catalog?: readonly PromotionWindow[];
}

/**
 * Selection precedence: an explicit choice (picker, saved project, then a valid deep link),
 * then the in-window default, then off-season (no holiday).
 */
export function selectHoliday(input: SelectHolidayInput): HolidaySelection {
  const enabled = input.enabledHolidayIds ?? enabledFromCatalog(input.catalog);
  const valid = (value: string | null | undefined): HolidayId | null =>
    isHolidayId(value) && enabled.includes(value) ? value : null;

  const explicit = valid(input.explicitHolidayId);
  if (explicit) return { holidayId: explicit, source: 'explicit', offSeason: false };
  const saved = valid(input.savedProjectHolidayId);
  if (saved) return { holidayId: saved, source: 'saved_project', offSeason: false };
  const deepLink = valid(input.deepLinkHolidayId);
  if (deepLink) return { holidayId: deepLink, source: 'deep_link', offSeason: false };

  const inWindow = resolveDefaultHoliday(input.instant, input.timeZone, input.catalog);
  if (inWindow) return { holidayId: inWindow, source: 'in_window', offSeason: false };
  return { holidayId: null, source: 'off_season', offSeason: true };
}

function enabledFromCatalog(catalog: readonly PromotionWindow[] | undefined): readonly HolidayId[] {
  if (!catalog) return DEFAULT_ENABLED_HOLIDAY_IDS;
  return [...new Set(catalog.map((window) => window.holidayId))];
}

/** Validates a `?holiday=` deep link against the enabled holidays. */
export function parseHolidayDeepLink(
  value: string | null | undefined,
  enabledHolidayIds: readonly HolidayId[] = DEFAULT_ENABLED_HOLIDAY_IDS,
): HolidayId | null {
  return isHolidayId(value) && enabledHolidayIds.includes(value) ? value : null;
}

/**
 * The timezone the client uses to recompute the default: the reported zone when valid,
 * otherwise the editorial timezone.
 */
export function resolveClientTimeZone(candidate: string | null | undefined): string {
  return isValidTimeZone(candidate) ? candidate : EDITORIAL_TIMEZONE;
}

/** The browser's timezone, falling back to the editorial timezone when unavailable. */
export function detectClientTimeZone(): string {
  try {
    return resolveClientTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return EDITORIAL_TIMEZONE;
  }
}

export interface ClientDefaultRecomputation {
  /** The default in the visitor's timezone. */
  holidayId: HolidayId | null;
  /** Whether the client must swap the hero and default before first interaction. */
  swap: boolean;
}

/**
 * The client's timezone recomputation rule: recompute precedence step 2 in the visitor's
 * timezone from the served calendar and swap when it differs from the server default.
 */
export function recomputeClientDefault(input: {
  serverDefaultHolidayId: HolidayId | null;
  calendar: readonly PromotionWindow[];
  instant: InstantInput;
  timeZone?: string | null;
}): ClientDefaultRecomputation {
  const holidayId = resolveDefaultHoliday(
    input.instant,
    resolveClientTimeZone(input.timeZone),
    input.calendar,
  );
  return { holidayId, swap: holidayId !== input.serverDefaultHolidayId };
}

/**
 * Picker order: the current default first (when in window), then the remaining holidays by
 * next celebration date ascending.
 */
export function pickerOrder(
  holidayIds: readonly HolidayId[],
  defaultHolidayId: HolidayId | null,
  fromDate: CivilDate,
  region = 'US',
): HolidayId[] {
  const rest = holidayIds
    .filter((id) => id !== defaultHolidayId)
    .map((id) => ({ id, next: nextCelebrationStart(id, fromDate, region) }))
    .sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : 0))
    .map(({ id }) => id);
  return defaultHolidayId && holidayIds.includes(defaultHolidayId)
    ? [defaultHolidayId, ...rest]
    : rest;
}
