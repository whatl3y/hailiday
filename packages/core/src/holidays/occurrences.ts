import type { HolidayId } from '../types/content.js';
import { HOLIDAY_IDS } from '../types/content.js';
import { SUPPORTED_REGIONS, catalogEntry } from './catalog.js';
import type { CivilDate, InstantInput } from './dates.js';
import {
  EDITORIAL_TIMEZONE,
  addDays,
  civilDate,
  dayOfWeek,
  isDateInRange,
  localDateIn,
} from './dates.js';

/** Thanksgiving Day: the fourth Thursday of November. */
export function thanksgivingDate(year: number): CivilDate {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    throw new RangeError(`Invalid year: ${year}`);
  }
  const firstOfNovember = civilDate(year, 11, 1);
  const offsetToThursday = (4 - dayOfWeek(firstOfNovember) + 7) % 7;
  return addDays(firstOfNovember, offsetToThursday + 21);
}

/** One holiday in one region and year: celebration, promotion and commerce dates. */
export interface HolidayOccurrence {
  occurrenceKey: string;
  holidayId: HolidayId;
  region: string;
  year: number;
  celebrationStart: CivilDate;
  celebrationEnd: CivilDate;
  promotionStart: CivilDate;
  promotionEnd: CivilDate;
  commerceStart: CivilDate | null;
  commerceEnd: CivilDate | null;
  catalogRetireAt: CivilDate | null;
  editorialPriority: number;
  editorialTimezone: string;
}

/** The minimum an occurrence needs for default-holiday selection. */
export interface PromotionWindow {
  holidayId: HolidayId;
  promotionStart: CivilDate;
  promotionEnd: CivilDate;
  editorialPriority?: number;
  celebrationStart?: CivilDate;
}

export function occurrenceKey(holidayId: HolidayId, region: string, year: number): string {
  return `${holidayId}.${region}.${year}`;
}

export function parseOccurrenceKey(
  key: string,
): { holidayId: HolidayId; region: string; year: number } | null {
  const match = /^([a-z_]+)\.([A-Z]{2}(?:-[A-Z0-9]{1,3})?)\.(\d{4})$/.exec(key);
  if (!match) return null;
  const [, holidayId, region, year] = match;
  if (!(HOLIDAY_IDS as readonly string[]).includes(holidayId as string)) return null;
  return { holidayId: holidayId as HolidayId, region: region as string, year: Number(year) };
}

function assertRegion(region: string): void {
  if (!(SUPPORTED_REGIONS as readonly string[]).includes(region)) {
    throw new RangeError(`No holiday catalog for region ${region}`);
  }
}

/**
 * Generates the default occurrence for a holiday, region and year. The occurrence year is the
 * year its promotion window opens (New Year's Eve 2026 runs 2026-12-26 to 2027-01-01).
 */
export function occurrenceFor(
  holidayId: HolidayId,
  year: number,
  region = 'US',
): HolidayOccurrence {
  assertRegion(region);
  const { editorialPriority } = catalogEntry(holidayId);
  const base = {
    occurrenceKey: occurrenceKey(holidayId, region, year),
    holidayId,
    region,
    year,
    editorialPriority,
    editorialTimezone: EDITORIAL_TIMEZONE,
  };
  switch (holidayId) {
    case 'halloween':
      return {
        ...base,
        celebrationStart: civilDate(year, 10, 31),
        celebrationEnd: civilDate(year, 10, 31),
        promotionStart: civilDate(year, 9, 15),
        promotionEnd: civilDate(year, 10, 31),
        commerceStart: civilDate(year, 9, 1),
        commerceEnd: civilDate(year, 10, 24),
        catalogRetireAt: civilDate(year, 11, 1),
      };
    case 'thanksgiving_us': {
      const day = thanksgivingDate(year);
      return {
        ...base,
        celebrationStart: day,
        celebrationEnd: day,
        promotionStart: civilDate(year, 11, 1),
        promotionEnd: day,
        commerceStart: civilDate(year, 10, 15),
        commerceEnd: addDays(day, -3),
        catalogRetireAt: addDays(day, 1),
      };
    }
    case 'christmas':
      return {
        ...base,
        celebrationStart: civilDate(year, 12, 25),
        celebrationEnd: civilDate(year, 12, 25),
        promotionStart: addDays(thanksgivingDate(year), 1),
        promotionEnd: civilDate(year, 12, 25),
        commerceStart: civilDate(year, 10, 15),
        commerceEnd: civilDate(year, 12, 18),
        catalogRetireAt: civilDate(year, 12, 26),
      };
    case 'new_years_eve':
      return {
        ...base,
        celebrationStart: civilDate(year, 12, 31),
        celebrationEnd: civilDate(year + 1, 1, 1),
        promotionStart: civilDate(year, 12, 26),
        promotionEnd: civilDate(year + 1, 1, 1),
        commerceStart: civilDate(year, 12, 1),
        commerceEnd: civilDate(year, 12, 29),
        catalogRetireAt: civilDate(year + 1, 1, 2),
      };
  }
}

/** Default occurrences for every catalog holiday (or the given ones) in a year. */
export function occurrencesFor(
  year: number,
  region = 'US',
  options: { holidayIds?: readonly HolidayId[] } = {},
): HolidayOccurrence[] {
  const holidayIds = options.holidayIds ?? HOLIDAY_IDS;
  return holidayIds.map((holidayId) => occurrenceFor(holidayId, year, region));
}

/** Occurrences for a span of years, for the given enabled holidays. */
export function occurrencesForYears(
  years: readonly number[],
  holidayIds: readonly HolidayId[],
  region = 'US',
): HolidayOccurrence[] {
  return years.flatMap((year) => occurrencesFor(year, region, { holidayIds }));
}

/**
 * The off-season after a year's last promotion window: from the day after Christmas (or New
 * Year's Day when the New Year's Eve pack is enabled) to the day before the next Halloween window.
 */
export function offSeasonAfter(
  year: number,
  options: { includeNewYearsEve?: boolean; region?: string } = {},
): { start: CivilDate; end: CivilDate } {
  const region = options.region ?? 'US';
  const last = options.includeNewYearsEve
    ? occurrenceFor('new_years_eve', year, region)
    : occurrenceFor('christmas', year, region);
  const next = occurrenceFor('halloween', year + 1, region);
  return { start: addDays(last.promotionEnd, 1), end: addDays(next.promotionStart, -1) };
}

/** Whether an occurrence's commerce window contains the date (editorial timezone by default). */
export function isInCommerceWindow(
  occurrence: Pick<HolidayOccurrence, 'commerceStart' | 'commerceEnd' | 'catalogRetireAt'>,
  instant: InstantInput,
  timeZone: string = EDITORIAL_TIMEZONE,
): boolean {
  if (!occurrence.commerceStart || !occurrence.commerceEnd) return false;
  const today = localDateIn(instant, timeZone);
  if (occurrence.catalogRetireAt && today >= occurrence.catalogRetireAt) return false;
  return isDateInRange(today, occurrence.commerceStart, occurrence.commerceEnd);
}

/** Whether an occurrence's catalog has retired (editorial timezone by default). */
export function isCatalogRetired(
  occurrence: Pick<HolidayOccurrence, 'catalogRetireAt'>,
  instant: InstantInput,
  timeZone: string = EDITORIAL_TIMEZONE,
): boolean {
  return (
    occurrence.catalogRetireAt !== null &&
    localDateIn(instant, timeZone) >= occurrence.catalogRetireAt
  );
}

/** The next celebration start on or after a date (current celebrations count). */
export function nextCelebrationStart(
  holidayId: HolidayId,
  fromDate: CivilDate,
  region = 'US',
): CivilDate {
  const year = Number(fromDate.slice(0, 4));
  const candidates = [year - 1, year, year + 1]
    .map((y) => occurrenceFor(holidayId, y, region))
    .filter((occurrence) => occurrence.celebrationEnd >= fromDate)
    .map((occurrence) => occurrence.celebrationStart)
    .sort();
  const next = candidates[0];
  if (!next) throw new RangeError(`No celebration found for ${holidayId} after ${fromDate}`);
  return next;
}
