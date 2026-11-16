import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeSchema } from '@hailiday/core';
import { sha256Hex } from '@hailiday/server/ids';
import { DEVICE_COOKIE, deviceHashOf } from './auth/session.js';
import { createHarness, json, type Harness } from './test/harness.js';
import { signInSameSession } from './test/operator.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) Safari/605.1.15';

/** A raw request with explicit cookies and headers (the harness client keeps only the session). */
function inject(input: {
  method?: 'GET' | 'POST';
  url: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  payload?: object;
}) {
  const cookie = Object.entries(input.cookies ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  return harness.server.app.inject({
    method: input.method ?? 'GET',
    url: input.url,
    headers: {
      origin: harness.config.publicBaseUrl,
      'user-agent': SAFARI,
      'accept-language': 'en-US',
      ...(cookie ? { cookie } : {}),
      ...(input.headers ?? {}),
    },
    ...(input.payload ? { payload: input.payload } : {}),
  });
}

function cookieValue(response: Awaited<ReturnType<typeof inject>>, name: string) {
  return response.cookies.find((cookie) => cookie.name === name);
}

async function sessionByCookie(token: string) {
  return harness.context.db
    .selectFrom('anonymousSessions')
    .selectAll()
    .where('tokenHash', '=', sha256Hex(token))
    .executeTakeFirstOrThrow();
}

function fakeRequest(input: {
  device?: string;
  ua?: string;
  language?: string;
  ip?: string;
}): FastifyRequest {
  return {
    cookies: input.device ? { [DEVICE_COOKIE]: input.device } : {},
    headers: { 'user-agent': input.ua ?? SAFARI, 'accept-language': input.language ?? 'en-US' },
    ip: input.ip ?? '203.0.113.7',
  } as unknown as FastifyRequest;
}

describe('the device key of the render backstop', () => {
  it('gives each browser its own random device cookie, even with identical headers', async () => {
    const first = await inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { turnstileToken: 'fixture-pass' },
    });
    const second = await inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { turnstileToken: 'fixture-pass' },
    });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    const devices = [cookieValue(first, DEVICE_COOKIE), cookieValue(second, DEVICE_COOKIE)];
    for (const device of devices) {
      expect(device?.value).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(device?.httpOnly).toBe(true);
      expect(String(device?.sameSite).toLowerCase()).toBe('lax');
      expect(device?.maxAge).toBeGreaterThan(365 * 24 * 3600);
    }
    expect(devices[0]?.value).not.toBe(devices[1]?.value);

    const rows = await Promise.all(
      [first, second].map((response) =>
        sessionByCookie(cookieValue(response, 'hailiday_session')?.value ?? ''),
      ),
    );
    expect(rows[0]?.deviceHash).not.toBe(rows[1]?.deviceHash);
    // The session records the same key later requests from that browser are counted under.
    expect(rows[0]?.deviceHash).toBe(
      deviceHashOf(harness, fakeRequest({ device: devices[0]?.value ?? '' })),
    );

    // A browser that already has a device cookie keeps it.
    const again = await inject({
      method: 'POST',
      url: '/v1/sessions',
      cookies: { [DEVICE_COOKIE]: devices[0]?.value ?? '' },
      payload: { turnstileToken: 'fixture-pass' },
    });
    expect(cookieValue(again, DEVICE_COOKIE)).toBeUndefined();
    const againRow = await sessionByCookie(cookieValue(again, 'hailiday_session')?.value ?? '');
    expect(againRow.deviceHash).toBe(rows[0]?.deviceHash);
  });

  it('keys on the device cookie, not on the user agent', () => {
    const one = 'AAAAAAAAAAAAAAAAAAAAAA';
    const two = 'BBBBBBBBBBBBBBBBBBBBBB';
    // Two browsers with identical headers behind one address are separate devices.
    expect(deviceHashOf(harness, fakeRequest({ device: one }))).not.toBe(
      deviceHashOf(harness, fakeRequest({ device: two })),
    );
    // Rotating the user agent while keeping the cookie stays in one bucket.
    expect(deviceHashOf(harness, fakeRequest({ device: one, ua: 'curl/8.0' }))).toBe(
      deviceHashOf(harness, fakeRequest({ device: one, ua: 'Firefox/140.0', ip: '198.51.100.1' })),
    );
  });

  it('falls back to user agent, language and address only when the cookie is missing', () => {
    const base = deviceHashOf(harness, fakeRequest({}));
    // Same headers behind another address: not the same device.
    expect(deviceHashOf(harness, fakeRequest({ ip: '198.51.100.9' }))).not.toBe(base);
    expect(deviceHashOf(harness, fakeRequest({}))).toBe(base);
    expect(deviceHashOf(harness, fakeRequest({ language: 'de-DE' }))).not.toBe(base);
    // A malformed cookie is ignored rather than trusted as a key.
    expect(deviceHashOf(harness, fakeRequest({ device: 'short' }))).toBe(base);
    expect(deviceHashOf(harness, fakeRequest({ device: 'AAAAAAAAAAAAAAAAAAAAAA' }))).not.toBe(base);
  });
});

describe('Global Privacy Control', () => {
  it('records the signal on the session at creation and on a later request', async () => {
    const signaled = await inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { 'sec-gpc': '1' },
      payload: { turnstileToken: 'fixture-pass' },
    });
    const signaledToken = cookieValue(signaled, 'hailiday_session')?.value ?? '';
    expect((await sessionByCookie(signaledToken)).gpcSignaledAt).toBeInstanceOf(Date);

    const plain = harness.client();
    await plain.createSession();
    const token = plain.cookie ?? '';
    expect((await sessionByCookie(token)).gpcSignaledAt).toBeNull();
    expect((await plain.get('/v1/me')).statusCode).toBe(200);
    expect((await sessionByCookie(token)).gpcSignaledAt).toBeNull();

    // Within the touch interval, the signal still forces the write.
    expect((await plain.get('/v1/me', { 'sec-gpc': '1' })).statusCode).toBe(200);
    const recorded = (await sessionByCookie(token)).gpcSignaledAt;
    expect(recorded).toBeInstanceOf(Date);
    // The first time is kept.
    await plain.get('/v1/me', { 'sec-gpc': '1' });
    expect((await sessionByCookie(token)).gpcSignaledAt).toEqual(recorded);
  });
});

describe('logout', () => {
  it('leaves a session whose first paid action runs the bot check again', async () => {
    const client = harness.client();
    await client.createSession();
    await signInSameSession(harness, client, 'logout-check@example.com');
    expect((await client.post('/v1/auth/logout', {})).statusCode).toBe(204);
    const replacement = await sessionByCookie(client.cookie ?? '');
    expect(replacement.turnstileVerifiedAt).toBeNull();

    const refused = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });

    // The client's ordinary session call with a bot-check token verifies that session in place.
    const failed = await client.post('/v1/sessions', { turnstileToken: 'fixture-fail' });
    expect(failed.statusCode).toBe(403);
    const verified = await client.post('/v1/sessions', { turnstileToken: 'fixture-pass' });
    expect(verified.statusCode).toBe(201);
    const after = await sessionByCookie(client.cookie ?? '');
    expect(after.id).toBe(replacement.id);
    expect(after.turnstileVerifiedAt).toBeInstanceOf(Date);
    const created = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
    expect(created.statusCode).toBe(201);
  });
});

describe('the operator role', () => {
  it('takes effect only while the email is allowlisted and is removed at the next sign-in', async () => {
    const email = 'former-operator@example.com';
    const client = harness.client();
    await client.createSession();
    await signInSameSession(harness, client, email);
    // An account that held the role before its email left the allowlist.
    await harness.context.db
      .updateTable('users')
      .set({ roles: ['user', 'operator'] })
      .where('emailNormalized', '=', email)
      .execute();

    const me = MeSchema.parse((await client.get('/v1/me')).json());
    expect(me.user?.roles).toEqual(['user']);
    const internal = await client.get('/internal/v1/session');
    expect(internal.statusCode).toBe(403);
    expect(json(internal).error).toMatchObject({ details: { reason: 'operator_required' } });

    const again = harness.client();
    await again.createSession();
    await signInSameSession(harness, again, email);
    const stored = await harness.context.db
      .selectFrom('users')
      .select('roles')
      .where('emailNormalized', '=', email)
      .executeTakeFirstOrThrow();
    expect(stored.roles).toEqual(['user']);
  });
});
