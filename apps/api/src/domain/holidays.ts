import {
  EDITORIAL_TIMEZONE,
  isDateInRange,
  localDateIn,
  pickerOrder,
  windowContaining,
  type HolidayId,
  type PromotionWindow,
} from '@holiday/core';
import type { HolidayOccurrenceRow } from '@holiday/server/db';
import type { ApiDeps } from '../deps.js';

const CACHE_MS = 30_000;

interface OccurrenceCache {
  loadedAt: number;
  rows: HolidayOccurrenceRow[];
  packVersions: Map<string, { id: string; holidayId: HolidayId; version: string }>;
  published: Map<HolidayId, string>;
}

let cache: OccurrenceCache | null = null;
let cacheOwner: unknown = null;

/** Enabled holiday occurrences and pack versions, cached briefly in process. */
export async function holidayCalendar(deps: Pick<ApiDeps, 'db' | 'clock'>) {
  const now = deps.clock.now().getTime();
  if (cache && cacheOwner === deps.db && now - cache.loadedAt < CACHE_MS) return cache;
  const rows = await deps.db
    .selectFrom('holidayOccurrences')
    .selectAll()
    .where('enabled', '=', true)
    .where('region', '=', 'US')
    .orderBy('promotionStart')
    .execute();
  const versions = await deps.db
    .selectFrom('holidayPackVersions')
    .select(['id', 'holidayId', 'version', 'status'])
    .where('region', '=', 'US')
    .execute();
  const packVersions = new Map(versions.map((row) => [row.id, row]));
  const published = new Map<HolidayId, string>();
  for (const row of versions)
    if (row.status === 'published') published.set(row.holidayId, row.version);
  cache = { loadedAt: now, rows, packVersions, published };
  cacheOwner = deps.db;
  return cache;
}

/** Drops the cached calendar (after operator changes and in tests). */
export function invalidateHolidayCalendar(): void {
  cache = null;
}

export function toWindow(row: HolidayOccurrenceRow): PromotionWindow & { occurrenceKey: string } {
  return {
    holidayId: row.holidayId,
    promotionStart: row.promotionStart,
    promotionEnd: row.promotionEnd,
    editorialPriority: row.editorialPriority,
    celebrationStart: row.celebrationStart,
    occurrenceKey: row.occurrenceKey,
  };
}

/** The local date in the editorial timezone. */
export function editorialDate(now: Date): string {
  return localDateIn(now, EDITORIAL_TIMEZONE);
}

/** The enabled occurrence whose promotion window contains today, or null off-season. */
export function currentOccurrence(
  rows: readonly HolidayOccurrenceRow[],
  now: Date,
): HolidayOccurrenceRow | null {
  const today = editorialDate(now);
  const window = windowContaining(today, rows.map(toWindow));
  return window ? (rows.find((row) => row.occurrenceKey === window.occurrenceKey) ?? null) : null;
}

/** Holidays with at least one enabled occurrence, in catalog order. */
export function enabledHolidayIds(rows: readonly HolidayOccurrenceRow[]): HolidayId[] {
  const order: HolidayId[] = ['halloween', 'thanksgiving_us', 'christmas', 'new_years_eve'];
  const present = new Set(rows.map((row) => row.holidayId));
  return order.filter((id) => present.has(id));
}

/** The occurrence of a holiday that is current, else the next one to start, else the latest. */
export function occurrenceOf(
  rows: readonly HolidayOccurrenceRow[],
  holidayId: HolidayId,
  now: Date,
): HolidayOccurrenceRow | null {
  const today = editorialDate(now);
  const mine = rows.filter((row) => row.holidayId === holidayId);
  return (
    mine.find((row) => isDateInRange(today, row.promotionStart, row.promotionEnd)) ??
    mine.find((row) => row.promotionStart > today) ??
    mine[mine.length - 1] ??
    null
  );
}

/** The occurrence of a holiday whose commerce window contains today, or null. */
export function commerceOccurrenceOf(
  rows: readonly HolidayOccurrenceRow[],
  holidayId: HolidayId,
  now: Date,
): HolidayOccurrenceRow | null {
  const today = editorialDate(now);
  return (
    rows.find(
      (row) =>
        row.holidayId === holidayId &&
        row.commerceStart !== null &&
        row.commerceEnd !== null &&
        isDateInRange(today, row.commerceStart, row.commerceEnd) &&
        (row.catalogRetireAt === null || today < row.catalogRetireAt),
    ) ?? null
  );
}

/**
 * The full pack version stamped on a new render job: the version pinned by the enabled occurrence
 * that contains today, otherwise the published version for the holiday.
 */
export async function packVersionFor(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
  holidayId: HolidayId,
): Promise<string | null> {
  const calendar = await holidayCalendar(deps);
  const now = deps.clock.now();
  const today = editorialDate(now);
  const pinned = calendar.rows.find(
    (row) =>
      row.holidayId === holidayId &&
      row.packVersionId !== null &&
      isDateInRange(today, row.promotionStart, row.promotionEnd),
  );
  const pinnedVersion = pinned?.packVersionId
    ? calendar.packVersions.get(pinned.packVersionId)?.version
    : undefined;
  return pinnedVersion ?? calendar.published.get(holidayId) ?? null;
}

/** The default holiday now (editorial timezone), or null off-season. */
export async function defaultHoliday(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
): Promise<HolidayId | null> {
  const calendar = await holidayCalendar(deps);
  return currentOccurrence(calendar.rows, deps.clock.now())?.holidayId ?? null;
}

/**
 * The holiday a new project starts with: the requested one when enabled, else the default, else
 * (off-season) the first holiday in picker order.
 */
export async function holidayForNewProject(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
  requested: HolidayId | null | undefined,
): Promise<HolidayId> {
  const calendar = await holidayCalendar(deps);
  const enabled = enabledHolidayIds(calendar.rows);
  if (requested && (enabled.includes(requested) || enabled.length === 0)) return requested;
  const current = currentOccurrence(calendar.rows, deps.clock.now())?.holidayId ?? null;
  if (current) return current;
  const ordered = pickerOrder(enabled, null, editorialDate(deps.clock.now()));
  return ordered[0] ?? requested ?? 'christmas';
}
