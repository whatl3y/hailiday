import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { adoptStreetViewProject } from './test/projects.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      // A distinct secret gives this file its own device and IP hashes. The device and IP
      // dimensions get different limits.
      SESSION_SECRET: 'backstop-limits-test-session-secret-0123456789',
      QUOTA_RENDER_REQUESTS_PER_DEVICE_24H: '2',
      QUOTA_RENDER_REQUESTS_PER_IP_24H: '5',
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

async function render(client: TestClient) {
  const project = await adoptStreetViewProject(harness, client);
  return client.post(
    '/v1/renders',
    {
      projectId: project.projectId,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
    },
    { 'idempotency-key': randomUUID() },
  );
}

/** One admitted render, canceled at once (the backstop counts every job created). */
async function renderOnce(client: TestClient): Promise<void> {
  const response = await render(client);
  expect(response.statusCode).toBe(202);
  const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
  expect((await client.post(`/v1/renders/${renderJobId}/cancel`, {})).statusCode).toBe(200);
}

describe('the device and IP dimensions of the backstop have their own limits', () => {
  it('admits renders behind one address up to the IP limit, past the device limit', async () => {
    // Two browsers behind one address: the address holds as many jobs as the device limit.
    for (let i = 0; i < 2; i += 1) await renderOnce(await owner('10.75.0.1'));
    // Fresh browsers on that address are admitted by the pre-check and the locked re-check alike
    // until the address reaches its own limit.
    for (let i = 0; i < 3; i += 1) await renderOnce(await owner('10.75.0.1'));

    const sixth = await owner('10.75.0.1');
    const refused = await render(sixth);
    expect(refused.statusCode).toBe(429);
    expect(json(refused).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'device' },
    });
  });

  it('challenges a browser at the device limit while its addresses are under the IP limit', async () => {
    const first = await owner('10.76.0.1');
    const device = first.deviceCookie;
    await renderOnce(first);
    await renderOnce(await owner('10.76.0.2', device));

    const third = await owner('10.76.0.3', device);
    const challenged = await render(third);
    expect(challenged.statusCode).toBe(403);
    expect(json(challenged).error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { scope: 'device' },
    });
  });
});
