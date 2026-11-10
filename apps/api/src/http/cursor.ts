import { validationFailed } from '@holiday/server/errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An opaque keyset cursor: base64url of `[timestamp ISO string, row id]`. */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

/**
 * Decodes a cursor made by `encodeCursor`. Absent means the first page (null); anything that is
 * not a pair of a valid timestamp and a UUID answers `VALIDATION_FAILED` on `querystring.cursor`,
 * so a crafted cursor never reaches the database.
 */
export function decodeCursor(cursor: string | undefined): [Date, string] | null {
  if (!cursor) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    parsed = null;
  }
  if (Array.isArray(parsed) && parsed.length === 2) {
    const [at, id] = parsed as unknown[];
    if (typeof at === 'string' && typeof id === 'string' && UUID_PATTERN.test(id)) {
      const date = new Date(at);
      if (!Number.isNaN(date.getTime())) return [date, id.toLowerCase()];
    }
  }
  throw validationFailed({ fields: [{ path: 'querystring.cursor', reason: 'invalid' }] });
}
