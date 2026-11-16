import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionTokenSchema } from '@hailiday/core';
import { mintPlacesSessionToken, verifyPlacesSessionToken } from './places-token.js';

const SECRET = 'test-secret-for-places-tokens';
const SESSION = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e';
const OTHER = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5f';

describe('Places session tokens', () => {
  it('mints UUID v4 strings that verify only for their session and secret', () => {
    const token = mintPlacesSessionToken(SECRET, SESSION);
    expect(SessionTokenSchema.safeParse(token).success).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(verifyPlacesSessionToken(SECRET, SESSION, token)).toBe(true);
    expect(verifyPlacesSessionToken(SECRET, SESSION, token.toUpperCase())).toBe(true);
    expect(verifyPlacesSessionToken(SECRET, OTHER, token)).toBe(false);
    expect(verifyPlacesSessionToken('another-secret', SESSION, token)).toBe(false);
    expect(mintPlacesSessionToken(SECRET, SESSION)).not.toBe(token);
  });

  it('rejects client-chosen tokens', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(verifyPlacesSessionToken(SECRET, SESSION, randomUUID())).toBe(false);
    }
    expect(verifyPlacesSessionToken(SECRET, SESSION, 'not-a-uuid')).toBe(false);
  });
});
