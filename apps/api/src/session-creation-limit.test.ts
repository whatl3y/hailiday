import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, json, type Harness } from './test/harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

/** Creates sessions through `GET /v1/experience` until one is refused; returns how many passed. */
async function sessionsUntilRefused(target: Harness, max: number): Promise<number> {
  for (let i = 0; i < max; i += 1) {
    const response = await target
      .client()
      .get('/v1/experience', { 'x-turnstile-token': 'fixture-pass' });
    if (response.statusCode === 429) return i;
    expect(response.statusCode).toBe(200);
  }
  return max;
}

describe('implicit session creation', () => {
  it('counts against the per-IP session creation limit', async () => {
    const limit = await harness.context.settings.get('rate.sessions_per_ip_10m');
    expect(limit).toBe(20);
    for (let i = 0; i < limit; i += 1) {
      const response = await harness
        .client()
        .get('/v1/experience', { 'x-turnstile-token': 'fixture-pass' });
      expect(response.statusCode).toBe(200);
      expect(response.cookies.some((cookie) => cookie.name === 'holiday_session')).toBe(true);
    }
    const refused = await harness
      .client()
      .get('/v1/experience', { 'x-turnstile-token': 'fixture-pass' });
    expect(refused.statusCode).toBe(429);
    expect(json(refused).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'sessions' },
    });
    expect(refused.cookies.some((cookie) => cookie.name === 'holiday_session')).toBe(false);
    const explicit = await harness
      .client()
      .post('/v1/sessions', { turnstileToken: 'fixture-pass' });
    expect(explicit.statusCode).toBe(429);
  });

  it('takes the limit from the rate.sessions_per_ip_10m runtime setting', async () => {
    const other = await createHarness({ overrides: { RATE_SESSIONS_PER_IP_10M: '3' } });
    try {
      expect(await other.context.settings.get('rate.sessions_per_ip_10m')).toBe(3);
      expect(await sessionsUntilRefused(other, 10)).toBe(3);
    } finally {
      await other.close();
    }
  });
});
