import { describe, expect, it } from 'vitest';
import type { HolidayId } from '../types/content.js';
import {
  DEFAULT_ENABLED_HOLIDAY_IDS,
  EDITORIAL_TIMEZONE,
  US_HOLIDAY_CATALOG,
  addDays,
  dayOfWeek,
  defaultCatalogAround,
  isCatalogRetired,
  isInCommerceWindow,
  isOffSeason,
  isValidTimeZone,
  localDateIn,
  nextCelebrationStart,
  occurrenceFor,
  occurrencesFor,
  occurrencesForYears,
  offSeasonAfter,
  parseHolidayDeepLink,
  parseOccurrenceKey,
  pickerOrder,
  recomputeClientDefault,
  resolveClientTimeZone,
  resolveDefaultHoliday,
  selectHoliday,
  thanksgivingDate,
  zonedTimeToInstant,
} from './index.js';

const WITH_NYE: readonly HolidayId[] = [...DEFAULT_ENABLED_HOLIDAY_IDS, 'new_years_eve'];

/** The enabled catalog around a year, as the server or a served calendar would provide it. */
function catalog(year: number, holidayIds: readonly HolidayId[] = DEFAULT_ENABLED_HOLIDAY_IDS) {
  return occurrencesForYears([year - 1, year, year + 1], holidayIds);
}

function at(local: string, timeZone: string): Date {
  return zonedTimeToInstant(local, timeZone);
}

describe('thanksgivingDate', () => {
  it('computes the fourth Thursday of November for the worked years', () => {
    expect(thanksgivingDate(2026)).toBe('2026-11-26');
    expect(thanksgivingDate(2027)).toBe('2027-11-25');
    expect(thanksgivingDate(2028)).toBe('2028-11-23');
  });

  it('is always a Thursday between November 22 and 28', () => {
    for (let year = 2000; year <= 2100; year += 1) {
      const date = thanksgivingDate(year);
      expect(dayOfWeek(date)).toBe(4);
      const day = Number(date.slice(8));
      expect(day).toBeGreaterThanOrEqual(22);
      expect(day).toBeLessThanOrEqual(28);
      expect(date.slice(5, 7)).toBe('11');
    }
  });

  it('handles years where November 1 is a Thursday', () => {
    // 2029-11-01 is a Thursday, so the fourth Thursday is the 22nd.
    expect(dayOfWeek('2029-11-01')).toBe(4);
    expect(thanksgivingDate(2029)).toBe('2029-11-22');
  });

  it('rejects invalid years', () => {
    expect(() => thanksgivingDate(2026.5)).toThrow(RangeError);
  });
});

describe('worked calendar: window boundaries by year', () => {
  const rows = [
    {
      year: 2026,
      halloween: ['2026-09-15', '2026-10-31'],
      thanksgiving: ['2026-11-01', '2026-11-26'],
      christmas: ['2026-11-27', '2026-12-25'],
      nye: ['2026-12-26', '2027-01-01'],
      offSeason: ['2027-01-02', '2027-09-14'],
    },
    {
      year: 2027,
      halloween: ['2027-09-15', '2027-10-31'],
      thanksgiving: ['2027-11-01', '2027-11-25'],
      christmas: ['2027-11-26', '2027-12-25'],
      nye: ['2027-12-26', '2028-01-01'],
      offSeason: ['2028-01-02', '2028-09-14'],
    },
    {
      year: 2028,
      halloween: ['2028-09-15', '2028-10-31'],
      thanksgiving: ['2028-11-01', '2028-11-23'],
      christmas: ['2028-11-24', '2028-12-25'],
      nye: ['2028-12-26', '2029-01-01'],
      offSeason: ['2029-01-02', '2029-09-14'],
    },
  ];

  for (const row of rows) {
    it(`generates the ${row.year} promotion windows`, () => {
      const windows = (id: HolidayId) => {
        const o = occurrenceFor(id, row.year);
        return [o.promotionStart, o.promotionEnd];
      };
      expect(windows('halloween')).toEqual(row.halloween);
      expect(windows('thanksgiving_us')).toEqual(row.thanksgiving);
      expect(windows('christmas')).toEqual(row.christmas);
      expect(windows('new_years_eve')).toEqual(row.nye);
      const off = offSeasonAfter(row.year, { includeNewYearsEve: true });
      expect([off.start, off.end]).toEqual(row.offSeason);
    });

    it(`places December 26 to January 1 in the off-season without New Year's Eve (${row.year})`, () => {
      const off = offSeasonAfter(row.year, { includeNewYearsEve: false });
      expect(off.start).toBe(`${row.year}-12-26`);
      expect(off.end).toBe(row.offSeason[1]);
    });

    it(`keeps the ${row.year} windows adjacent and non-overlapping`, () => {
      const os = occurrencesFor(row.year);
      const sorted = [...os].sort((a, b) => (a.promotionStart < b.promotionStart ? -1 : 1));
      for (let i = 1; i < sorted.length; i += 1) {
        expect(addDays(sorted[i - 1]!.promotionEnd, 1)).toBe(sorted[i]!.promotionStart);
      }
    });
  }

  it('reports the weekday of each window end', () => {
    expect(dayOfWeek('2026-10-31')).toBe(6); // Sat
    expect(dayOfWeek('2026-11-26')).toBe(4); // Thu
    expect(dayOfWeek('2026-12-25')).toBe(5); // Fri
    expect(dayOfWeek('2027-10-31')).toBe(0); // Sun
    expect(dayOfWeek('2027-12-25')).toBe(6); // Sat
    expect(dayOfWeek('2028-10-31')).toBe(2); // Tue
    expect(dayOfWeek('2028-12-25')).toBe(1); // Mon
  });
});

describe('worked calendar: test vectors', () => {
  const vectors: {
    local: string;
    timeZone: string;
    expected: HolidayId | null;
    holidays?: readonly HolidayId[];
  }[] = [
    { local: '2026-11-15T12:00', timeZone: 'America/Chicago', expected: 'thanksgiving_us' },
    { local: '2026-12-15T12:00', timeZone: 'America/Los_Angeles', expected: 'christmas' },
    { local: '2027-11-15T12:00', timeZone: 'America/New_York', expected: 'thanksgiving_us' },
    { local: '2028-11-15T12:00', timeZone: 'America/New_York', expected: 'thanksgiving_us' },
    { local: '2026-09-14T23:59', timeZone: 'America/New_York', expected: null },
    { local: '2026-09-15T00:00', timeZone: 'America/New_York', expected: 'halloween' },
    { local: '2026-10-31T21:00', timeZone: 'America/Los_Angeles', expected: 'halloween' },
    { local: '2026-11-01T00:30', timeZone: 'America/New_York', expected: 'thanksgiving_us' },
    { local: '2026-11-26T19:30', timeZone: 'Pacific/Honolulu', expected: 'thanksgiving_us' },
    { local: '2026-11-27T00:00', timeZone: 'America/New_York', expected: 'christmas' },
    { local: '2026-12-25T23:59', timeZone: 'America/New_York', expected: 'christmas' },
    {
      local: '2026-12-26T00:00',
      timeZone: 'America/New_York',
      expected: 'new_years_eve',
      holidays: WITH_NYE,
    },
    { local: '2026-12-26T00:00', timeZone: 'America/New_York', expected: null },
    { local: '2026-12-25T20:00', timeZone: 'Pacific/Honolulu', expected: 'christmas' },
    { local: '2027-01-02T12:00', timeZone: 'America/New_York', expected: null },
    { local: '2027-03-28T12:00', timeZone: 'America/New_York', expected: null },
    { local: '2028-11-24T12:00', timeZone: 'America/New_York', expected: 'christmas' },
  ];

  for (const v of vectors) {
    const label = `${v.local} ${v.timeZone}${v.holidays ? ' (New Year’s Eve enabled)' : ''}`;
    it(`${label} → ${v.expected ?? 'off-season'}`, () => {
      const instant = at(v.local, v.timeZone);
      const year = Number(v.local.slice(0, 4));
      expect(localDateIn(instant, v.timeZone)).toBe(v.local.slice(0, 10));
      expect(resolveDefaultHoliday(instant, v.timeZone, catalog(year, v.holidays))).toBe(
        v.expected,
      );
      if (!v.holidays) expect(resolveDefaultHoliday(instant, v.timeZone)).toBe(v.expected);
    });
  }

  it('evaluates windows on the local date, never UTC (Halloween night in Los Angeles)', () => {
    const instant = at('2026-10-31T21:00', 'America/Los_Angeles');
    expect(instant.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(resolveDefaultHoliday(instant, 'UTC')).toBe('thanksgiving_us');
    expect(resolveDefaultHoliday(instant, 'America/Los_Angeles')).toBe('halloween');
  });

  it('server shell shows Thanksgiving at 00:30 New York while a Los Angeles client swaps to Halloween', () => {
    const instant = at('2026-11-01T00:30', 'America/New_York');
    expect(localDateIn(instant, 'America/Los_Angeles')).toBe('2026-10-31');
    const server = resolveDefaultHoliday(instant, EDITORIAL_TIMEZONE);
    expect(server).toBe('thanksgiving_us');
    expect(
      recomputeClientDefault({
        serverDefaultHolidayId: server,
        calendar: catalog(2026),
        instant,
        timeZone: 'America/Los_Angeles',
      }),
    ).toEqual({ holidayId: 'halloween', swap: true });
  });

  it('server shell already shows Christmas on Thanksgiving evening in Honolulu; the client swaps back', () => {
    const instant = at('2026-11-26T19:30', 'Pacific/Honolulu');
    expect(localDateIn(instant, EDITORIAL_TIMEZONE)).toBe('2026-11-27');
    const server = resolveDefaultHoliday(instant, EDITORIAL_TIMEZONE);
    expect(server).toBe('christmas');
    expect(
      recomputeClientDefault({
        serverDefaultHolidayId: server,
        calendar: catalog(2026),
        instant,
        timeZone: 'Pacific/Honolulu',
      }),
    ).toEqual({ holidayId: 'thanksgiving_us', swap: true });
  });

  it('server shell shows New Year’s Eve or the neutral hero on Christmas night in Honolulu; the client swaps back', () => {
    const instant = at('2026-12-25T20:00', 'Pacific/Honolulu');
    expect(localDateIn(instant, EDITORIAL_TIMEZONE)).toBe('2026-12-26');
    expect(resolveDefaultHoliday(instant, EDITORIAL_TIMEZONE, catalog(2026, WITH_NYE))).toBe(
      'new_years_eve',
    );
    expect(resolveDefaultHoliday(instant, EDITORIAL_TIMEZONE, catalog(2026))).toBeNull();
    expect(
      recomputeClientDefault({
        serverDefaultHolidayId: null,
        calendar: catalog(2026),
        instant,
        timeZone: 'Pacific/Honolulu',
      }),
    ).toEqual({ holidayId: 'christmas', swap: true });
  });

  it('does not swap when the client resolves the same default', () => {
    const instant = at('2026-11-15T12:00', 'America/Chicago');
    expect(
      recomputeClientDefault({
        serverDefaultHolidayId: 'thanksgiving_us',
        calendar: catalog(2026),
        instant,
        timeZone: 'America/Chicago',
      }),
    ).toEqual({ holidayId: 'thanksgiving_us', swap: false });
  });

  it('explicit deep-link choice wins in any season (2027-07-04, ?holiday=christmas)', () => {
    for (const timeZone of ['America/New_York', 'Pacific/Honolulu', 'Europe/London']) {
      const selection = selectHoliday({
        deepLinkHolidayId: 'christmas',
        instant: at('2027-07-04T12:00', timeZone),
        timeZone,
      });
      expect(selection).toEqual({ holidayId: 'christmas', source: 'deep_link', offSeason: false });
    }
  });

  it('a saved project’s choice wins over the in-window default (2026-12-15, halloween)', () => {
    for (const timeZone of ['America/New_York', 'America/Los_Angeles']) {
      const selection = selectHoliday({
        savedProjectHolidayId: 'halloween',
        instant: at('2026-12-15T12:00', timeZone),
        timeZone,
      });
      expect(selection).toEqual({
        holidayId: 'halloween',
        source: 'saved_project',
        offSeason: false,
      });
    }
  });

  it('holds the mid-November example every year from 2026 to 2040', () => {
    for (let year = 2026; year <= 2040; year += 1) {
      expect(resolveDefaultHoliday(at(`${year}-11-15T12:00`, EDITORIAL_TIMEZONE))).toBe(
        'thanksgiving_us',
      );
      expect(resolveDefaultHoliday(at(`${year}-12-15T12:00`, EDITORIAL_TIMEZONE))).toBe(
        'christmas',
      );
    }
  });
});

describe('selectHoliday precedence', () => {
  const instant = at('2026-11-15T12:00', 'America/Chicago');

  it('prefers the picker choice over a saved project and a deep link', () => {
    expect(
      selectHoliday({
        explicitHolidayId: 'christmas',
        savedProjectHolidayId: 'halloween',
        deepLinkHolidayId: 'halloween',
        instant,
        timeZone: 'America/Chicago',
      }).holidayId,
    ).toBe('christmas');
  });

  it('falls back to the in-window default', () => {
    expect(selectHoliday({ instant, timeZone: 'America/Chicago' })).toEqual({
      holidayId: 'thanksgiving_us',
      source: 'in_window',
      offSeason: false,
    });
  });

  it('ignores unknown and disabled holidays', () => {
    expect(
      selectHoliday({ deepLinkHolidayId: 'easter', instant, timeZone: 'America/Chicago' }).source,
    ).toBe('in_window');
    expect(
      selectHoliday({ deepLinkHolidayId: 'new_years_eve', instant, timeZone: 'America/Chicago' })
        .source,
    ).toBe('in_window');
    expect(
      selectHoliday({
        deepLinkHolidayId: 'new_years_eve',
        enabledHolidayIds: WITH_NYE,
        instant,
        timeZone: 'America/Chicago',
      }).holidayId,
    ).toBe('new_years_eve');
  });

  it('reports off-season with no holiday and no auto-start', () => {
    expect(selectHoliday({ instant: at('2027-03-28T12:00', EDITORIAL_TIMEZONE) })).toEqual({
      holidayId: null,
      source: 'off_season',
      offSeason: true,
    });
    expect(isOffSeason(at('2027-03-28T12:00', EDITORIAL_TIMEZONE))).toBe(true);
  });

  it('parses deep links against the enabled holidays', () => {
    expect(parseHolidayDeepLink('christmas')).toBe('christmas');
    expect(parseHolidayDeepLink('new_years_eve')).toBeNull();
    expect(parseHolidayDeepLink('new_years_eve', WITH_NYE)).toBe('new_years_eve');
    expect(parseHolidayDeepLink(undefined)).toBeNull();
    expect(parseHolidayDeepLink('us-thanksgiving')).toBeNull();
  });
});

describe('timezones', () => {
  it('falls back to the editorial timezone for missing or invalid client zones', () => {
    expect(resolveClientTimeZone(undefined)).toBe('America/New_York');
    expect(resolveClientTimeZone('Not/AZone')).toBe('America/New_York');
    expect(resolveClientTimeZone('America/Denver')).toBe('America/Denver');
    expect(isValidTimeZone('Pacific/Honolulu')).toBe(true);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('converts local wall-clock times across daylight saving changes', () => {
    expect(zonedTimeToInstant('2026-11-01T00:30', 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:30:00.000Z',
    );
    expect(zonedTimeToInstant('2026-11-02T00:30', 'America/New_York').toISOString()).toBe(
      '2026-11-02T05:30:00.000Z',
    );
    expect(zonedTimeToInstant('2026-07-04T12:00', 'Pacific/Honolulu').toISOString()).toBe(
      '2026-07-04T22:00:00.000Z',
    );
  });
});

describe('occurrences', () => {
  it('builds occurrence keys and parses them back', () => {
    const o = occurrenceFor('thanksgiving_us', 2026);
    expect(o.occurrenceKey).toBe('thanksgiving_us.US.2026');
    expect(o.celebrationStart).toBe('2026-11-26');
    expect(o.editorialTimezone).toBe('America/New_York');
    expect(parseOccurrenceKey('thanksgiving_us.US.2026')).toEqual({
      holidayId: 'thanksgiving_us',
      region: 'US',
      year: 2026,
    });
    expect(parseOccurrenceKey('easter.US.2026')).toBeNull();
  });

  it('generates one occurrence per catalog holiday by default', () => {
    expect(occurrencesFor(2026).map((o) => o.holidayId)).toEqual(
      US_HOLIDAY_CATALOG.map((e) => e.holidayId),
    );
    expect(() => occurrencesFor(2026, 'CA')).toThrow(RangeError);
  });

  it('matches the commerce calendar worked rows', () => {
    const rows = [
      [2026, '2026-10-15', '2026-11-23', '2026-11-27'],
      [2027, '2027-10-15', '2027-11-22', '2027-11-26'],
      [2028, '2028-10-15', '2028-11-20', '2028-11-24'],
    ] as const;
    for (const [year, start, end, retire] of rows) {
      const o = occurrenceFor('thanksgiving_us', year);
      expect([o.commerceStart, o.commerceEnd, o.catalogRetireAt]).toEqual([start, end, retire]);
    }
    const halloween = occurrenceFor('halloween', 2026);
    expect([halloween.commerceStart, halloween.commerceEnd, halloween.catalogRetireAt]).toEqual([
      '2026-09-01',
      '2026-10-24',
      '2026-11-01',
    ]);
    const christmas = occurrenceFor('christmas', 2026);
    expect([christmas.commerceStart, christmas.commerceEnd, christmas.catalogRetireAt]).toEqual([
      '2026-10-15',
      '2026-12-18',
      '2026-12-26',
    ]);
    const nye = occurrenceFor('new_years_eve', 2026);
    expect([nye.commerceStart, nye.commerceEnd, nye.catalogRetireAt]).toEqual([
      '2026-12-01',
      '2026-12-29',
      '2027-01-02',
    ]);
  });

  it('evaluates commerce windows and retirement in the editorial timezone', () => {
    const christmas = occurrenceFor('christmas', 2026);
    expect(isInCommerceWindow(christmas, at('2026-11-15T12:00', EDITORIAL_TIMEZONE))).toBe(true);
    expect(isInCommerceWindow(christmas, at('2026-12-19T00:00', EDITORIAL_TIMEZONE))).toBe(false);
    // 2026-12-18 23:30 in Los Angeles is already 2026-12-19 in New York.
    expect(isInCommerceWindow(christmas, at('2026-12-18T23:30', 'America/Los_Angeles'))).toBe(
      false,
    );
    expect(isCatalogRetired(christmas, at('2026-12-25T23:59', EDITORIAL_TIMEZONE))).toBe(false);
    expect(isCatalogRetired(christmas, at('2026-12-26T00:00', EDITORIAL_TIMEZONE))).toBe(true);
  });

  it('lists the picker by current default, then next celebration date', () => {
    expect(
      pickerOrder(['halloween', 'thanksgiving_us', 'christmas'], 'thanksgiving_us', '2026-11-15'),
    ).toEqual(['thanksgiving_us', 'christmas', 'halloween']);
    expect(pickerOrder(['halloween', 'thanksgiving_us', 'christmas'], null, '2027-03-28')).toEqual([
      'halloween',
      'thanksgiving_us',
      'christmas',
    ]);
    expect(pickerOrder(WITH_NYE, 'christmas', '2026-12-15')).toEqual([
      'christmas',
      'new_years_eve',
      'halloween',
      'thanksgiving_us',
    ]);
    expect(nextCelebrationStart('new_years_eve', '2027-01-01')).toBe('2026-12-31');
    expect(nextCelebrationStart('halloween', '2026-11-01')).toBe('2027-10-31');
  });

  it('builds a default catalog around a date that covers New Year’s Eve of the prior year', () => {
    const windows = defaultCatalogAround('2027-01-01', WITH_NYE);
    expect(
      windows.some((w) => w.holidayId === 'new_years_eve' && w.promotionEnd === '2027-01-01'),
    ).toBe(true);
  });
});
