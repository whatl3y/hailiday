import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@hailiday/server/config';
import { recordAllowanceResidue } from '@hailiday/server/limits';
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

  it('reserves two localizations for evening too, and a third edit, judge and escalation', async () => {
    Object.assign(states, {
      image_editing: 'live_public',
      vision_analysis: 'live_public',
    });
    const counts: Record<string, Record<string, number>> = {};
    for (const [index, lightingMode] of [
      [4, 'source'],
      [5, 'evening'],
    ] as const) {
      const client = await newClient(index);
      const project = await adoptUploadProject(harness, client);
      const response = await render(client, project, lightingMode);
      expect(response.statusCode).toBe(202);
      const lines = await reservationsOf(project.projectId);
      counts[lightingMode] = {
        edits: lines.filter((line) => line.sku === 'image_edit_attempt').length,
        checks: lines.filter((line) => line.sku === 'vision_call' && line.stage === 'checking')
          .length,
        localizations: lines.filter(
          (line) => line.sku === 'vision_call' && line.stage === 'localizing',
        ).length,
      };
      const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
      await client.post(`/v1/renders/${renderJobId}/cancel`, {});
    }
    // Checks: one judge and one escalation per attempt.
    expect(counts).toEqual({
      source: { edits: 2, checks: 4, localizations: 2 },
      evening: { edits: 3, checks: 6, localizations: 2 },
    });
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

/**
 * Requests a look for a new owner who has used `used` paid attempts in the window and returns the
 * status and, when admitted, how many edits the job reserved.
 */
async function renderWithAttemptsUsed(
  index: number,
  lightingMode: 'source' | 'evening',
  used: number,
): Promise<{ status: number; edits: number | null }> {
  const client = await newClient(index);
  const project = await adoptUploadProject(harness, client);
  const { ownerId } = await harness.context.db
    .selectFrom('projects')
    .select('ownerId')
    .where('id', '=', project.projectId)
    .executeTakeFirstOrThrow();
  const now = harness.context.clock.now();
  await recordAllowanceResidue(harness.context.db, {
    ownerId,
    now,
    units: Array.from({ length: used }, () => ({
      kind: 'attempt' as const,
      countedAt: new Date(now.getTime() - 60_000),
    })),
  });
  const response = await render(client, project, lightingMode);
  if (response.statusCode !== 202) {
    expect(json(response).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'attempts' },
    });
    expect(await reservationsOf(project.projectId)).toEqual([]);
    return { status: response.statusCode, edits: null };
  }
  const edits = (await reservationsOf(project.projectId)).filter(
    (line) => line.sku === 'image_edit_attempt',
  ).length;
  const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
  await client.post(`/v1/renders/${renderJobId}/cancel`, {});
  return { status: response.statusCode, edits };
}

describe('the paid-attempt cap projects two attempts for every look', () => {
  it('admits a relit look with two attempts left and still reserves its three edits', async () => {
    Object.assign(states, { image_editing: 'live_public', vision_analysis: 'live_public' });
    const limit = await harness.context.settings.get('quota.attempts_per_owner_24h');
    expect({
      source: await renderWithAttemptsUsed(6, 'source', limit - 2),
      evening: await renderWithAttemptsUsed(7, 'evening', limit - 2),
    }).toEqual({ source: { status: 202, edits: 2 }, evening: { status: 202, edits: 3 } });
  });

  it('refuses any look with one attempt left', async () => {
    Object.assign(states, { image_editing: 'live_public', vision_analysis: 'live_public' });
    const limit = await harness.context.settings.get('quota.attempts_per_owner_24h');
    expect({
      source: (await renderWithAttemptsUsed(8, 'source', limit - 1)).status,
      evening: (await renderWithAttemptsUsed(9, 'evening', limit - 1)).status,
    }).toEqual({ source: 429, evening: 429 });
  });

  it('admits the third look under the production cap after two relit looks used three each', async () => {
    Object.assign(states, { image_editing: 'live_public', vision_analysis: 'live_public' });
    const settings = harness.context.settings;
    const stored = settings.get.bind(settings);
    // The specified production cap: 8 paid attempts per owner in 24 hours.
    const cap = vi
      .spyOn(settings, 'get')
      .mockImplementation(((key: Parameters<typeof stored>[0]) =>
        key === 'quota.attempts_per_owner_24h'
          ? Promise.resolve(8)
          : stored(key)) as typeof stored);
    try {
      expect(await renderWithAttemptsUsed(10, 'evening', 6)).toEqual({ status: 202, edits: 3 });
    } finally {
      cap.mockRestore();
    }
  });
});
