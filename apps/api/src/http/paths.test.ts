import { describe, expect, it } from 'vitest';
import { AppError } from '@holiday/server/errors';
import { decodeCursor, encodeCursor } from './cursor.js';
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

  it('refuses crafted cursors with VALIDATION_FAILED instead of reaching the database', () => {
    const crafted = [
      Buffer.from(JSON.stringify(['2026-01-01T00:00:00Z', 'x'])).toString('base64url'),
      Buffer.from(JSON.stringify(['not a date', id])).toString('base64url'),
      Buffer.from(JSON.stringify(['2026-01-01T00:00:00Z', id, 'extra'])).toString('base64url'),
      Buffer.from(JSON.stringify({ at: '2026-01-01T00:00:00Z', id })).toString('base64url'),
      'not-base64-json',
    ];
    for (const cursor of crafted) {
      let error: unknown;
      try {
        decodeCursor(cursor);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});
