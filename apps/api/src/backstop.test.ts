import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, MINUTE_MS, createManualClock } from '@hailiday/server/clock';
import * as limits from '@hailiday/server/limits';
import * as turnstile from '@hailiday/server/turnstile';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { adoptStreetViewProject } from './test/projects.js';

vi.mock('@hailiday/server/turnstile', async (importOriginal) => {
  const original = await importOriginal<typeof turnstile>();
  return { ...original, verifyTurnstile: vi.fn(original.verifyTurnstile) };
});

vi.mock('@hailiday/server/limits', async (importOriginal) => {
  const original = await importOriginal<typeof limits>();
  return {
    ...original,
    deviceBackstop: vi.fn(original.deviceBackstop),
    lockOwnerAllowance: vi.fn(original.lockOwnerAllowance),
  };
});

let harness: Harness;
const clock = createManualClock('2026-11-09T20:00:00.000Z');

beforeAll(async () => {
  harness = await createHarness({
    clock,
    overrides: {
      // A distinct secret gives this file its own device and IP hashes; admission control is
      // opened up so jobs of files running alongside never refuse these requests.
      SESSION_SECRET: 'backstop-test-session-secret-0123456789abcdefgh',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
  });
});

afterAll(async () => {
  await harness?.close();
});

/** A new owner (session) in a browser behind `remoteAddress`, optionally an existing browser. */
async function owner(remoteAddress: string, deviceCookie?: string | null): Promise<TestClient> {
  const client = harness.client({ remoteAddress, deviceCookie: deviceCookie ?? null });
  await client.createSession();
  return client;
}

function render(
  client: TestClient,
  project: { projectId: string; projectVersion: number },
  key: string = randomUUID(),
  headers: Record<string, string> = {},
) {
  return client.post(
    '/v1/renders',
    {
      projectId: project.projectId,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
    },
    { 'idempotency-key': key, ...headers },
  );
}

/**
 * One render job for a fresh project of `client`, canceled at once: the backstop counts every
 * job created, whatever its state, and canceled jobs never hold queue capacity.
 */
async function renderOnce(client: TestClient): Promise<void> {
  const project = await adoptStreetViewProject(harness, client);
  const response = await render(client, project);
  expect(response.statusCode).toBe(202);
  const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
  expect((await client.post(`/v1/renders/${renderJobId}/cancel`, {})).statusCode).toBe(200);
}

async function jobsWithKey(key: string) {
  return harness.context.db
    .selectFrom('renderJobs')
    .select('id')
    .where('idempotencyKey', '=', key)
    .execute();
}

describe('the device dimension of the backstop is a challenge', () => {
  it('asks the 7th render from one browser to verify, then admits the same request with a token', async () => {
    // One browser, a new owner on each of six networks: the device fills, no address does.
    const first = await owner('10.70.0.1');
    const device = first.deviceCookie;
    expect(device).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await renderOnce(first);
    for (let i = 2; i <= 6; i += 1) await renderOnce(await owner(`10.70.0.${i}`, device));

    const seventh = await owner('10.70.0.7', device);
    const project = await adoptStreetViewProject(harness, seventh);
    const key = randomUUID();
    const challenged = await render(seventh, project, key);
    expect(challenged.statusCode).toBe(403);
    expect(json(challenged).error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { scope: 'device' },
    });
    // Refused before any job row exists: the retry is neither a replay nor a conflict.
    expect(await jobsWithKey(key)).toEqual([]);

    const failed = await render(seventh, project, key, { 'x-turnstile-token': 'fixture-fail' });
    expect(failed.statusCode).toBe(403);
    expect(json(failed).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });
    expect(await jobsWithKey(key)).toEqual([]);

    vi.mocked(turnstile.verifyTurnstile).mockClear();
    const solved = await render(seventh, project, key, { 'x-turnstile-token': 'fixture-pass' });
    expect(solved.statusCode).toBe(202);
    // Single-use tokens: the backstop and its locked re-check share one verification.
    expect(turnstile.verifyTurnstile).toHaveBeenCalledTimes(1);
    expect(solved.headers['idempotent-replayed']).toBeUndefined();
    expect(await jobsWithKey(key)).toHaveLength(1);
    const renderJobId = json<{ renderJobId: string }>(solved).renderJobId;
    await seventh.post(`/v1/renders/${renderJobId}/cancel`, {});

    // The solve admitted one render; the next one from the browser is challenged again.
    const eighth = await owner('10.70.0.8', device);
    const next = await render(eighth, await adoptStreetViewProject(harness, eighth));
    expect(next.statusCode).toBe(403);
    expect(json(next).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  });
});

describe('the IP dimension of the backstop refuses', () => {
  it('answers RATE_LIMITED for the 7th render behind one address, with or without a token', async () => {
    // Six browsers behind one address.
    for (let i = 0; i < 6; i += 1) await renderOnce(await owner('10.71.0.1'));

    const seventh = await owner('10.71.0.1');
    const project = await adoptStreetViewProject(harness, seventh);
    const attempts: Record<string, string>[] = [{}, { 'x-turnstile-token': 'fixture-pass' }];
    for (const headers of attempts) {
      const key = randomUUID();
      const refused = await render(seventh, project, key, headers);
      expect(refused.statusCode).toBe(429);
      expect(json(refused).error).toMatchObject({
        code: 'RATE_LIMITED',
        details: { scope: 'device' },
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(await jobsWithKey(key)).toEqual([]);
    }
  });

  it('keeps counting an address across the daily salt rotation at 00:00 UTC', async () => {
    clock.set('2026-11-09T23:30:00.000Z');
    for (let i = 0; i < 6; i += 1) await renderOnce(await owner('10.72.0.1'));

    // An hour later the salt has rotated, but the window still holds the six jobs.
    clock.set('2026-11-10T00:30:00.000Z');
    const afterMidnight = await owner('10.72.0.1');
    const refused = await render(
      afterMidnight,
      await adoptStreetViewProject(harness, afterMidnight),
    );
    expect(refused.statusCode).toBe(429);
    expect(json(refused).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'device' },
    });
    // The oldest job leaves the window 24 hours after it was requested.
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual((23 * HOUR_MS) / 1000);

    clock.set(new Date(Date.parse('2026-11-10T23:30:00.000Z') + MINUTE_MS));
    const nextDay = await owner('10.72.0.1');
    await renderOnce(nextDay);
  });
});

describe('the bot-check token of a render request', () => {
  it('is verified before the render transaction when the device fills between the checks', async () => {
    // One browser with five renders: the pre-check admits the sixth request's device.
    const first = await owner('10.73.0.1');
    const device = first.deviceCookie;
    await renderOnce(first);
    for (let i = 2; i <= 5; i += 1) await renderOnce(await owner(`10.73.0.${i}`, device));

    const racing = await owner('10.73.0.6', device);
    const racingProject = await adoptStreetViewProject(harness, racing);
    const requester = await owner('10.73.0.7', device);
    const project = await adoptStreetViewProject(harness, requester);

    // Another request from the browser lands between the pre-check and the locked re-check,
    // filling the device dimension.
    vi.mocked(turnstile.verifyTurnstile).mockClear();
    vi.mocked(limits.lockOwnerAllowance).mockClear();
    vi.mocked(limits.deviceBackstop).mockClear();
    const original = vi.mocked(limits.deviceBackstop).getMockImplementation();
    if (!original) throw new Error('deviceBackstop is not wrapped');
    vi.mocked(limits.deviceBackstop).mockImplementationOnce(async (...args) => {
      const state = await original(...args);
      expect(state.device?.exhausted).toBe(false);
      const raced = await render(racing, racingProject);
      expect(raced.statusCode).toBe(202);
      const racedId = json<{ renderJobId: string }>(raced).renderJobId;
      await racing.post(`/v1/renders/${racedId}/cancel`, {});
      return state;
    });

    const key = randomUUID();
    const admitted = await render(requester, project, key, { 'x-turnstile-token': 'fixture-pass' });
    expect(admitted.statusCode).toBe(202);
    expect(await jobsWithKey(key)).toHaveLength(1);

    // The locked re-check saw the device exhausted and admitted on the token, which was sent to
    // the verifier once, before the requester's transaction took the owner lock.
    const lockedCheck = vi.mocked(limits.deviceBackstop).mock.results.at(-1);
    expect(await lockedCheck?.value).toMatchObject({ device: { exhausted: true } });
    expect(turnstile.verifyTurnstile).toHaveBeenCalledTimes(1);
    const verifiedAt = vi.mocked(turnstile.verifyTurnstile).mock.invocationCallOrder[0] ?? 0;
    const lockedAt = vi.mocked(limits.lockOwnerAllowance).mock.invocationCallOrder.at(-1) ?? 0;
    expect(verifiedAt).toBeGreaterThan(0);
    expect(verifiedAt).toBeLessThan(lockedAt);
    await requester.post(
      `/v1/renders/${json<{ renderJobId: string }>(admitted).renderJobId}/cancel`,
      {},
    );
  });
});
