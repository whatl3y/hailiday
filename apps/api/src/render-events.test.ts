import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { adoptStreetViewProject, ownerIdOf } from './test/projects.js';

let harness: Harness;
let client: TestClient;
let renderJobId: string;

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      SESSION_SECRET: 'render-events-test-session-secret-0123456789ab',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
  });
  client = harness.client();
  await client.createSession();
  const project = await adoptStreetViewProject(harness, client);
  const queued = await client.post(
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
  expect(queued.statusCode).toBe(202);
  renderJobId = json<{ renderJobId: string }>(queued).renderJobId;
});

afterAll(async () => {
  await harness?.context.db
    .updateTable('renderJobs')
    .set({ state: 'canceled', terminalAt: new Date() })
    .where('id', '=', renderJobId)
    .execute();
  await harness?.server.close().catch(() => undefined);
  await harness?.context.close();
});

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('render event stream bounds', () => {
  it('replaces the oldest stream of an owner on one job instead of piling streams up', async () => {
    const ownerId = await ownerIdOf(harness, client);
    const events = harness.server.deps.events;
    let firstEnded = false;
    const first = client.get(`/v1/renders/${renderJobId}/events`).then((response) => {
      firstEnded = true;
      return response;
    });
    await until(() => events.streamCount(ownerId) === 1);
    void client.get(`/v1/renders/${renderJobId}/events`);
    await until(() => events.streamCount(ownerId) === 2);
    void client.get(`/v1/renders/${renderJobId}/events`);
    await until(() => firstEnded);
    expect(events.streamCount(ownerId)).toBe(2);
    expect(events.subscriberCount(renderJobId)).toBe(2);
    const response = await first;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: render');
  });
});

describe('shutdown with open streams', () => {
  it('ends every open stream so the server closes promptly', async () => {
    await harness.server.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = harness.server.app.server.address() as AddressInfo;
    let ended = false;
    const opened = new Promise<void>((resolve, reject) => {
      const request = http.get(
        {
          host: '127.0.0.1',
          port,
          path: `/v1/renders/${renderJobId}/events`,
          headers: { cookie: `hailiday_session=${client.cookie}`, 'last-event-id': '0' },
        },
        (response) => {
          expect(response.statusCode).toBe(200);
          response.on('data', () => resolve());
          response.on('end', () => {
            ended = true;
          });
          response.resume();
        },
      );
      request.on('error', reject);
    });
    await opened;
    const started = Date.now();
    await Promise.race([
      harness.server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('close hung')), 5000)),
    ]);
    expect(Date.now() - started).toBeLessThan(2000);
    await until(() => ended, 2000);
    expect(harness.server.deps.events.streamCount()).toBe(0);
  });
});
