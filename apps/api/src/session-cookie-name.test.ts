import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '@hailiday/server/config';
import { SECURE_SESSION_COOKIE, SESSION_COOKIE, sessionCookieName } from './auth/session.js';
import { createHarness, json, type Harness } from './test/harness.js';

let secure: Harness;

beforeAll(async () => {
  secure = await createHarness({
    // A deployed configuration as far as cookies go (the fixture email sender is local only; this
    // file sends no email).
    mapConfig: (config): AppConfig => ({
      ...config,
      isLocal: false,
      email: { ...config.email, provider: 'smtp' },
    }),
    overrides: { SESSION_SECRET: 'session-cookie-name-secret-0123456789abcdefgh' },
  });
});

afterAll(async () => {
  await secure?.close();
});

function inject(input: {
  method?: 'GET' | 'POST';
  url: string;
  cookie?: string;
  payload?: object;
}) {
  return secure.server.app.inject({
    method: input.method ?? 'GET',
    url: input.url,
    remoteAddress: '10.73.0.1',
    headers: {
      origin: secure.config.publicBaseUrl,
      ...(input.cookie ? { cookie: input.cookie } : {}),
    },
    ...(input.payload ? { payload: input.payload } : {}),
  });
}

describe('the session cookie name', () => {
  it('uses the __Host- prefix exactly when the cookie is issued with Secure', () => {
    expect(SESSION_COOKIE).toBe('hailiday_session');
    expect(SECURE_SESSION_COOKIE).toBe('__Host-hailiday_session');
    expect(sessionCookieName({ isLocal: true })).toBe(SESSION_COOKIE);
    expect(sessionCookieName({ isLocal: false })).toBe(SECURE_SESSION_COOKIE);
  });

  it('issues and reads __Host-hailiday_session with Secure, Path=/ and no Domain', async () => {
    const created = await inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { turnstileToken: 'fixture-pass' },
    });
    expect(created.statusCode).toBe(201);
    const cookie = created.cookies.find((entry) => entry.name === SECURE_SESSION_COOKIE);
    expect(cookie).toMatchObject({ secure: true, httpOnly: true, path: '/' });
    expect(cookie?.domain).toBeUndefined();
    expect(String(cookie?.sameSite).toLowerCase()).toBe('lax');
    expect(created.cookies.find((entry) => entry.name === SESSION_COOKIE)).toBeUndefined();
    const token = cookie?.value ?? '';
    expect(token.length).toBeGreaterThan(16);

    const me = await inject({ url: '/v1/me', cookie: `${SECURE_SESSION_COOKIE}=${token}` });
    expect(me.statusCode).toBe(200);
    // The unprefixed name is not read where the cookie is issued with Secure.
    const unprefixed = await inject({ url: '/v1/me', cookie: `${SESSION_COOKIE}=${token}` });
    expect(unprefixed.statusCode).toBe(403);
    expect(json(unprefixed).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  });
});
