import { validationFailed } from '@hailiday/server/errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A UTC timestamp exactly as `Date#toISOString` writes it for the years PostgreSQL stores (0001 to
 * 9999; year 0000 does not exist there).
 */
const MILLISECOND_TIMESTAMP = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The same with microseconds, as PostgreSQL stores `timestamptz`. */
const MICROSECOND_TIMESTAMP = /^((?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

/**
 * The PostgreSQL `to_char` pattern that writes a UTC timestamp in the form `encodePreciseCursor`
 * carries (`YYYY-MM-DDTHH:MM:SS.ffffffZ`): `to_char(column at time zone 'utc', <this>)`.
 */
export const MICROSECOND_TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

function invalidCursor() {
  return validationFailed({ fields: [{ path: 'querystring.cursor', reason: 'invalid' }] });
}

/** True for a millisecond ISO timestamp that names a real instant (no rolled-over dates). */
function isMillisecondTimestamp(value: string): boolean {
  if (!MILLISECOND_TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

/** The `[timestamp, id]` pair of a cursor, or null when it is not one. */
function cursorPair(cursor: string): [string, string] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [at, id] = parsed as unknown[];
  if (typeof at !== 'string' || typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
  return [at, id.toLowerCase()];
}

/** An opaque keyset cursor: base64url of `[timestamp ISO string, row id]`. */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

/**
 * Decodes a cursor made by `encodeCursor`. Absent means the first page (null); anything else that
 * is not a pair of a millisecond timestamp as `encodeCursor` writes it and a UUID answers
 * `VALIDATION_FAILED` on `querystring.cursor`, so a crafted cursor never reaches the database.
 */
export function decodeCursor(cursor: string | undefined): [Date, string] | null {
  if (!cursor) return null;
  const pair = cursorPair(cursor);
  if (!pair || !isMillisecondTimestamp(pair[0])) throw invalidCursor();
  return [new Date(pair[0]), pair[1]];
}

/**
 * A keyset cursor at the database's own precision: base64url of `[microsecond timestamp, row id]`,
 * the timestamp as `MICROSECOND_TIMESTAMP_FORMAT` writes it. A keyset over a `timestamptz` column
 * compares the stored value itself, so the cursor must not lose its microseconds.
 */
export function encodePreciseCursor(at: string, id: string): string {
  if (!MICROSECOND_TIMESTAMP.test(at)) throw new RangeError(`Not a microsecond timestamp: ${at}`);
  return Buffer.from(JSON.stringify([at, id])).toString('base64url');
}

/**
 * Decodes a cursor made by `encodePreciseCursor` into the timestamp text (to compare as
 * `timestamptz`) and the row id. Absent means the first page (null); anything else answers
 * `VALIDATION_FAILED` on `querystring.cursor`.
 */
export function decodePreciseCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  const pair = cursorPair(cursor);
  const match = pair ? MICROSECOND_TIMESTAMP.exec(pair[0]) : null;
  if (!pair || !match?.[1] || !isMillisecondTimestamp(`${match[1]}Z`)) throw invalidCursor();
  return pair;
}
