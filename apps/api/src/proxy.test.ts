import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dailySaltedHash } from '@hailiday/server/ids';
import { trustProxyHops } from './server.js';
import { createHarness, type Harness } from './test/harness.js';

let behindRouter: Harness;
let direct: Harness;

beforeAll(async () => {
  behindRouter = await createHarness({ overrides: { TRUST_PROXY_HOPS: '1' } });
  direct = await createHarness();
});

afterAll(async () => {
  await behindRouter?.close();
  await direct?.close();
});

async function sessionsWithIp(harness: Harness, ip: string): Promise<number> {
  const ipHash = dailySaltedHash(
    harness.config.sessionSecret,
    `ip:${ip}`,
    harness.context.clock.now(),
  );
  const rows = await harness.context.db
    .selectFrom('anonymousSessions')
    .select('id')
    .where('ipHash', '=', ipHash)
    .execute();
  return rows.length;
}

describe('trustProxyHops', () => {
  it('trusts the immediate peer and the next hops minus one forwarded entries', () => {
    expect(trustProxyHops(0)).toBe(false);
    const two = trustProxyHops(2);
    expect(two && [0, 1, 2, 3].map((hop) => two('10.0.0.1', hop))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});

describe('client address behind the platform router', () => {
  it('takes the address the trusted hop appended, never a client-supplied one', async () => {
    expect(behindRouter.config.trustProxyHops).toBe(1);
    const created = await behindRouter
      .client()
      .post(
        '/v1/sessions',
        { turnstileToken: 'fixture-pass' },
        { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
      );
    expect(created.statusCode).toBe(201);
    expect(await sessionsWithIp(behindRouter, '198.51.100.7')).toBe(1);
    expect(await sessionsWithIp(behindRouter, '203.0.113.9')).toBe(0);
  });

  it('ignores X-Forwarded-For when no proxy hop is trusted', async () => {
    expect(direct.config.trustProxyHops).toBe(0);
    const created = await direct
      .client()
      .post(
        '/v1/sessions',
        { turnstileToken: 'fixture-pass' },
        { 'x-forwarded-for': '192.0.2.44, 198.51.100.8' },
      );
    expect(created.statusCode).toBe(201);
    expect(await sessionsWithIp(direct, '192.0.2.44')).toBe(0);
    expect(await sessionsWithIp(direct, '198.51.100.8')).toBe(0);
  });
});
