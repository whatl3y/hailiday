import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@holiday/server/config';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { adoptUploadProject } from './test/projects.js';

let harness: Harness;
/** Capability states this file's API reads; other capabilities keep their stored rows. */
const states: Record<string, string> = {};

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      SESSION_SECRET: 'render-legs-test-session-secret-0123456789abc',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
    // The API prices legs by the configured provider names; the adapters stay fixtures and the
    // test never runs the worker, so nothing is dispatched.
    mapConfig: (config): AppConfig => ({
      ...config,
      providers: { ...config.providers, imageEditor: 'openai', vision: 'anthropic' },
    }),
  });
  // Capability states for this server only, so files running alongside never see them.
  const capabilities = harness.context.capabilities;
  const stored = capabilities.state.bind(capabilities);
  vi.spyOn(capabilities, 'state').mockImplementation(async (country, capability) =>
    capability in states
      ? ((states[capability] ?? null) as Awaited<ReturnType<typeof stored>>)
      : stored(country, capability),
  );
  // No provider is paused for this server: files running alongside pause and resume providers
  // (Anthropic among them) in the shared database while these renders are admitted.
  vi.spyOn(harness.context.settings, 'isProviderPaused').mockResolvedValue(false);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

async function newClient(index: number): Promise<TestClient> {
  const client = harness.client({ remoteAddress: `10.61.0.${index}` });
  await client.createSession();
  return client;
}

async function render(
  client: TestClient,
  project: { projectId: string; projectVersion: number },
  lightingMode: 'source' | 'evening' = 'source',
) {
  return client.post(
    '/v1/renders',
    {
      projectId: project.projectId,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode,
    },
    { 'idempotency-key': randomUUID() },
  );
}

async function reservationsOf(projectId: string) {
  return harness.context.db
    .selectFrom('usageLedger')
    .select(['sku', 'provider', 'isFixture', 'stage'])
    .where('projectId', '=', projectId)
    .where('kind', '=', 'reservation')
    .execute();
}

describe('render reservations price each leg for the adapter the worker uses', () => {
  it('marks fixture vision lines of a live-edit job as fixture work', async () => {
    Object.assign(states, {
      image_editing: 'live_public',
      vision_analysis: 'fixture',
    });
    const client = await newClient(1);
    const project = await adoptUploadProject(harness, client);
    const response = await render(client, project);
    expect(response.statusCode).toBe(202);
    const lines = await reservationsOf(project.projectId);
    const vision = lines.filter((line) => line.sku === 'vision_call');
    const edits = lines.filter((line) => line.sku === 'image_edit_attempt');
    expect(vision.length).toBeGreaterThan(0);
    for (const line of vision) expect(line).toMatchObject({ provider: 'fixture', isFixture: true });
    expect(edits).toHaveLength(2);
    for (const line of edits) expect(line).toMatchObject({ provider: 'openai', isFixture: false });
    const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
    await client.post(`/v1/renders/${renderJobId}/cancel`, {});
  });

  it('prices live vision when vision_analysis is live for the caller', async () => {
    Object.assign(states, {
      image_editing: 'live_public',
      vision_analysis: 'live_public',
    });
    const client = await newClient(2);
    const project = await adoptUploadProject(harness, client);
    const response = await render(client, project);
    expect(response.statusCode).toBe(202);
    const vision = (await reservationsOf(project.projectId)).filter(
      (line) => line.sku === 'vision_call',
    );
    expect(vision.length).toBeGreaterThan(0);
    for (const line of vision) {
      expect(line).toMatchObject({ provider: 'anthropic', isFixture: false });
    }
    const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
    await client.post(`/v1/renders/${renderJobId}/cancel`, {});
  });

  it('reserves one localization per decorating attempt: two by daylight, one for evening', async () => {
    Object.assign(states, {
      image_editing: 'live_public',
      vision_analysis: 'live_public',
    });
    const counts: Record<string, number> = {};
    for (const [index, lightingMode] of [
      [4, 'source'],
      [5, 'evening'],
    ] as const) {
      const client = await newClient(index);
      const project = await adoptUploadProject(harness, client);
      const response = await render(client, project, lightingMode);
      expect(response.statusCode).toBe(202);
      const lines = await reservationsOf(project.projectId);
      expect(lines.filter((line) => line.sku === 'image_edit_attempt')).toHaveLength(2);
      counts[lightingMode] = lines.filter(
        (line) => line.sku === 'vision_call' && line.stage === 'localizing',
      ).length;
      const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
      await client.post(`/v1/renders/${renderJobId}/cancel`, {});
    }
    expect(counts).toEqual({ source: 2, evening: 1 });
  });

  it('refuses before any reservation when vision is private and the caller is not an operator', async () => {
    Object.assign(states, {
      image_editing: 'live_public',
      vision_analysis: 'live_private',
    });
    const client = await newClient(3);
    const project = await adoptUploadProject(harness, client);
    const response = await render(client, project);
    expect(response.statusCode).toBe(503);
    expect(json(response).error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { provider: 'anthropic' },
    });
    expect(await reservationsOf(project.projectId)).toEqual([]);
    const jobs = await harness.context.db
      .selectFrom('renderJobs')
      .select('id')
      .where('projectId', '=', project.projectId)
      .execute();
    expect(jobs).toEqual([]);
  });
});
