import { describe, expect, it } from 'vitest';
import {
  effectiveStreetViewMode,
  streetViewFetchExpected,
  streetViewFrameRefetchDue,
  streetViewProviderJudges,
} from './source.js';

const persist = { display: true, aiProcess: true, edit: true, store: true };
const transient = { display: true, aiProcess: true, edit: true, store: false };
const displayOnly = { display: true, aiProcess: false, edit: false, store: false };

describe('effectiveStreetViewMode', () => {
  it('follows the permission when it allows decoration, never storing a transient source', () => {
    expect(effectiveStreetViewMode('persist', persist)).toBe('persist');
    expect(effectiveStreetViewMode('transient', persist)).toBe('transient');
    expect(effectiveStreetViewMode('persist', transient)).toBe('transient');
    expect(effectiveStreetViewMode('display_only', persist)).toBe('persist');
    expect(effectiveStreetViewMode('display_only', transient)).toBe('transient');
    expect(effectiveStreetViewMode(null, persist)).toBe('persist');
  });

  it('refuses decoration the permission does not allow, whatever was stored', () => {
    expect(effectiveStreetViewMode('persist', displayOnly)).toBe('display_only');
    expect(effectiveStreetViewMode('transient', { ...persist, display: false })).toBe(
      'unavailable',
    );
  });
});

describe('streetViewFetchExpected', () => {
  const streetView = { kind: 'street_view' as const, objectKey: null };

  it('fetches for every transient render and for a persist render until a frame is stored', () => {
    expect(streetViewFetchExpected(streetView, 'transient')).toBe(true);
    expect(
      streetViewFetchExpected({ ...streetView, objectKey: 'originals/a/b' }, 'transient'),
    ).toBe(true);
    expect(streetViewFetchExpected(streetView, 'persist')).toBe(true);
    expect(streetViewFetchExpected({ ...streetView, objectKey: 'originals/a/b' }, 'persist')).toBe(
      false,
    );
  });

  it('never fetches for other modes or kinds', () => {
    expect(streetViewFetchExpected(streetView, 'display_only')).toBe(false);
    expect(streetViewFetchExpected(streetView, null)).toBe(false);
    expect(streetViewFetchExpected({ kind: 'upload', objectKey: null }, 'transient')).toBe(false);
  });
});

describe('stored frame age', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const maxAgeMs = 30 * 86_400_000;
  const viewpointFetched = (daysAgo: number | null) =>
    ({
      fetchedAt:
        daysAgo === null ? null : new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    }) as never;
  const stored = (daysAgo: number | null) => ({
    kind: 'street_view' as const,
    objectKey: 'originals/a/b',
    viewpoint: viewpointFetched(daysAgo),
  });

  it('is due past the maximum age or at an unrecorded fetch time, never without a stored copy', () => {
    expect(streetViewFrameRefetchDue(stored(29), now, maxAgeMs)).toBe(false);
    expect(streetViewFrameRefetchDue(stored(31), now, maxAgeMs)).toBe(true);
    expect(streetViewFrameRefetchDue(stored(null), now, maxAgeMs)).toBe(true);
    expect(streetViewFrameRefetchDue({ ...stored(31), objectKey: null }, now, maxAgeMs)).toBe(
      false,
    );
    expect(streetViewFrameRefetchDue({ ...stored(31), kind: 'upload' }, now, maxAgeMs)).toBe(false);
  });

  it('reserves a fetch for a persist source whose stored frame is due', () => {
    expect(streetViewFetchExpected(stored(31), 'persist', { now, maxAgeMs })).toBe(true);
    expect(streetViewFetchExpected(stored(29), 'persist', { now, maxAgeMs })).toBe(false);
    expect(streetViewFetchExpected(stored(31), 'persist')).toBe(false);
    expect(streetViewFetchExpected(stored(31), 'display_only', { now, maxAgeMs })).toBe(false);
  });
});

describe('streetViewProviderJudges', () => {
  it('lets the fixture adapter judge only stand-ins and the live provider only real imagery', () => {
    const standIn = { copyright: 'Fixture photo: Someone / Unsplash License' };
    const real = { copyright: '© 2025 Google' };
    expect(streetViewProviderJudges({ mode: 'fixture' }, standIn)).toBe(true);
    expect(streetViewProviderJudges({ mode: 'fixture' }, real)).toBe(false);
    expect(streetViewProviderJudges({ mode: 'fixture' }, { copyright: null })).toBe(false);
    expect(streetViewProviderJudges({ mode: 'live' }, real)).toBe(true);
    expect(streetViewProviderJudges({ mode: 'live' }, standIn)).toBe(false);
  });
});
