import { describe, expect, it } from 'vitest';
import { AppError } from '@hailiday/server/errors';
import { decodeCursor, decodePreciseCursor, encodeCursor, encodePreciseCursor } from './cursor.js';
import { isApiPath, normalizedPath } from './types.js';

describe('isApiPath', () => {
  it('decides on the decoded path the router matches', () => {
    expect(isApiPath('/v1/me')).toBe(true);
    expect(isApiPath('/%76%31/me')).toBe(true);
    expect(isApiPath('/%69nternal/v1/pause?x=1')).toBe(true);
    expect(isApiPath('//v1//projects')).toBe(true);
    expect(isApiPath('/v1')).toBe(true);
    expect(isApiPath('/places')).toBe(false);
    expect(isApiPath('/s/abc')).toBe(false);
    expect(isApiPath('/v1x/me')).toBe(false);
  });

  it('treats a path that is not valid percent-encoding as an API path', () => {
    expect(normalizedPath('/%E0%A4%A')).toBeNull();
    expect(isApiPath('/%E0%A4%A')).toBe(true);
  });
});

describe('pagination cursors', () => {
  const id = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e';

  it('round-trips a timestamp and id', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    expect(decodeCursor(encodeCursor(at, id))).toEqual([at, id]);
    expect(decodeCursor(undefined)).toBeNull();
  });

  const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const refused = (decode: (cursor: string) => unknown, cursor: string) => {
    let error: unknown;
    try {
      decode(cursor);
    } catch (caught) {
      error = caught;
    }
    expect(error, cursor).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
  };

  it('refuses crafted cursors with VALIDATION_FAILED instead of reaching the database', () => {
    const crafted = [
      raw(['2026-01-01T00:00:00.000Z', 'x']),
      raw(['not a date', id]),
      raw(['2026-01-01T00:00:00.000Z', id, 'extra']),
      raw({ at: '2026-01-01T00:00:00.000Z', id }),
      'not-base64-json',
      // Timestamps JavaScript parses but encodeCursor never writes, or PostgreSQL cannot store.
      raw(['2026-01-01T00:00:00Z', id]),
      raw(['2026-01-01', id]),
      raw(['-000001-01-01T00:00:00.000Z', id]),
      raw(['+275760-09-13T00:00:00.000Z', id]),
      raw(['0000-01-01T00:00:00.000Z', id]),
      raw(['2026-02-30T00:00:00.000Z', id]),
      raw(['2026-01-01T00:00:00.000+00:00', id]),
      raw(['2026-01-01T00:00:00.000000Z', id]),
    ];
    for (const cursor of crafted) refused(decodeCursor, cursor);
    const earliest = new Date('0001-01-01T00:00:00.000Z');
    expect(decodeCursor(encodeCursor(earliest, id))).toEqual([earliest, id]);
  });

  it('carries microseconds in a precise cursor and refuses anything else', () => {
    const at = '2026-11-10T12:00:00.123456Z';
    expect(decodePreciseCursor(encodePreciseCursor(at, id))).toEqual([at, id]);
    expect(decodePreciseCursor(raw([at, id.toUpperCase()]))).toEqual([at, id]);
    expect(decodePreciseCursor(undefined)).toBeNull();
    expect(() => encodePreciseCursor('2026-11-10T12:00:00.123Z', id)).toThrow(RangeError);
    for (const cursor of [
      encodeCursor(new Date('2026-11-10T12:00:00.123Z'), id),
      raw(['-000001-01-01T00:00:00.000000Z', id]),
      raw(['0000-01-01T00:00:00.000000Z', id]),
      raw(['2026-02-30T00:00:00.000000Z', id]),
      raw(['2026-11-10T12:00:00.1234567Z', id]),
      raw([at, 'x']),
      'not-base64-json',
    ]) {
      refused(decodePreciseCursor, cursor);
    }
  });
});
