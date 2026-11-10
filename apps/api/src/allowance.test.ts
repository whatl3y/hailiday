import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NON_TERMINAL_RENDER_JOB_STATES } from '@holiday/core';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';
import { adoptStreetViewProject, ownerIdOf } from './test/projects.js';

let harness: Harness;

/** Jobs this file queued; canceled at the end so other files' admission control never sees them. */
const queuedJobs: { client: TestClient; renderJobId: string }[] = [];

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      // A distinct secret gives this file its own device and IP hashes, so the backstop counts
      // only its own jobs; admission control is opened up for the parallel requests.
      SESSION_SECRET: 'allowance-test-session-secret-0123456789abcdef',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
  });
});

afterAll(async () => {
  for (const { client, renderJobId } of queuedJobs) {
    await client.post(`/v1/renders/${renderJobId}/cancel`, {});
  }
  await harness?.close();
});

let clients = 0;

/**
 * A new browser (its own `holiday_device` cookie) behind its own address, so each client is its
 * own device and IP bucket of the render backstop, as separate visitors are.
 */
async function newClient(): Promise<TestClient> {
  clients += 1;
  const client = harness.client({ remoteAddress: `10.50.${clients >> 8}.${clients & 255}` });
  await client.createSession();
  return client;
}

function render(
  client: TestClient,
  project: { projectId: string; projectVersion: number },
  overrides: Record<string, unknown> = {},
  key: string = randomUUID(),
) {
  return client.post(
    '/v1/renders',
    {
      projectId: project.projectId,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
      ...overrides,
    },
    { 'idempotency-key': key },
  );
}

function remember(client: TestClient, response: { statusCode: number; json(): unknown }) {
  if (response.statusCode === 202) {
    queuedJobs.push({
      client,
      renderJobId: (response.json() as { renderJobId: string }).renderJobId,
    });
  }
}

async function nonTerminalJobs(ownerId: string) {
  return harness.context.db
    .selectFrom('renderJobs')
    .select(['id', 'projectId', 'state'])
    .where('ownerId', '=', ownerId)
    .where('state', 'in', [...NON_TERMINAL_RENDER_JOB_STATES])
    .execute();
}

async function remainingAllowance(client: TestClient) {
  const me = json<{
    allowance: { variants: { remaining: number }; addresses: { remaining: number } };
  }>(await client.get('/v1/me'));
  return { variants: me.allowance.variants.remaining, addresses: me.allowance.addresses.remaining };
}

describe('allowance under parallel requests', () => {
  it('admits exactly the variants allowance from ten parallel renders on ten projects', async () => {
    const client = await newClient();
    const ownerId = await ownerIdOf(harness, client);
    const projects = [];
    for (let i = 0; i < 10; i += 1) projects.push(await adoptStreetViewProject(harness, client));

    const responses = await Promise.all(projects.map((project) => render(client, project)));
    for (const response of responses) remember(client, response);
    const accepted = responses.filter((response) => response.statusCode === 202);
    const refused = responses.filter((response) => response.statusCode === 429);
    expect(accepted).toHaveLength(3);
    expect(refused).toHaveLength(7);
    for (const response of refused) {
      expect(json(response).error).toMatchObject({
        code: 'ALLOWANCE_EXHAUSTED',
        details: { scope: 'variants' },
      });
    }
    expect(await nonTerminalJobs(ownerId)).toHaveLength(3);
  });

  it('creates exactly the addresses allowance from ten parallel resolves', async () => {
    const client = await newClient();
    const ownerId = await ownerIdOf(harness, client);
    const tokens = [];
    for (let i = 0; i < 10; i += 1) tokens.push(await placesTokenForClient(harness, client));

    const responses = await Promise.all(
      tokens.map((sessionToken) =>
        client.post('/v1/addresses/resolve', {
          placeId: 'ChIJfxLanternHillColonial01',
          sessionToken,
          holidayId: 'christmas',
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(3);
    const refused = responses.filter((response) => response.statusCode === 429);
    expect(refused).toHaveLength(7);
    for (const response of refused) {
      expect(json(response).error).toMatchObject({
        code: 'ALLOWANCE_EXHAUSTED',
        details: { scope: 'addresses' },
      });
    }
    const projects = await harness.context.db
      .selectFrom('projects')
      .select('id')
      .where('ownerId', '=', ownerId)
      .where('kind', '=', 'address')
      .execute();
    expect(projects).toHaveLength(3);
  });
});

describe('deletion keeps allowance units counted', () => {
  it('counts a deleted address project until it leaves the window', async () => {
    const client = await newClient();
    const resolve = async () =>
      client.post('/v1/addresses/resolve', {
        placeId: 'ChIJfxLanternHillColonial01',
        sessionToken: await placesTokenForClient(harness, client),
        holidayId: 'christmas',
      });
    const first = await resolve();
    expect(first.statusCode).toBe(201);
    expect((await remainingAllowance(client)).addresses).toBe(2);
    const projectId = json<{ project: { id: string } }>(first).project.id;
    expect((await client.delete(`/v1/projects/${projectId}`)).statusCode).toBe(202);
    expect((await remainingAllowance(client)).addresses).toBe(2);
    expect((await resolve()).statusCode).toBe(201);
    expect((await remainingAllowance(client)).addresses).toBe(1);
  });

  it('keeps a succeeded variant counted after its project is deleted', async () => {
    const client = await newClient();
    const project = await adoptStreetViewProject(harness, client);
    const queued = await render(client, project);
    expect(queued.statusCode).toBe(202);
    const renderJobId = json<{ renderJobId: string }>(queued).renderJobId;
    expect(await harness.completeRender(renderJobId)).toBe('succeeded');
    expect((await remainingAllowance(client)).variants).toBe(2);
    expect((await client.delete(`/v1/projects/${project.projectId}`)).statusCode).toBe(202);
    expect((await remainingAllowance(client)).variants).toBe(2);
  });
});

describe('sign-in carries deleted-unit residue', () => {
  function linkToken(email: string): string {
    const message = harness.email.lastTo(email);
    const match = /token=([A-Za-z0-9_%-]+)/.exec(message?.text ?? '');
    if (!match?.[1]) throw new Error(`no link sent to ${email}`);
    return decodeURIComponent(match[1]);
  }

  async function signIn(client: TestClient, email: string) {
    expect(
      (await client.post('/v1/auth/magic-link', { email, returnTo: '/places' })).statusCode,
    ).toBe(202);
    expect((await client.post('/v1/auth/verify', { token: linkToken(email) })).statusCode).toBe(
      200,
    );
  }

  async function resolve(client: TestClient) {
    const response = await client.post('/v1/addresses/resolve', {
      placeId: 'ChIJfxLanternHillColonial01',
      sessionToken: await placesTokenForClient(harness, client),
      holidayId: 'christmas',
    });
    expect(response.statusCode).toBe(201);
    return json<{ project: { id: string } }>(response).project.id;
  }

  it('keeps a deleted address counted for the account (union of both windows)', async () => {
    const email = `residue-${randomUUID()}@example.com`;
    // The account already used one address in another browser.
    const elsewhere = await newClient();
    await signIn(elsewhere, email);
    await resolve(elsewhere);
    expect((await remainingAllowance(elsewhere)).addresses).toBe(2);

    // Anonymously, this browser used one address and deleted it.
    const client = await newClient();
    const anonymousOwner = await ownerIdOf(harness, client);
    const projectId = await resolve(client);
    expect((await client.delete(`/v1/projects/${projectId}`)).statusCode).toBe(202);
    expect((await remainingAllowance(client)).addresses).toBe(2);

    await signIn(client, email);
    const accountOwner = await ownerIdOf(harness, client);
    expect(accountOwner).not.toBe(anonymousOwner);
    const residue = await harness.context.db
      .selectFrom('allowanceResidue')
      .select(['ownerId', 'kind'])
      .where('ownerId', 'in', [anonymousOwner, accountOwner])
      .execute();
    expect(residue).toEqual([{ ownerId: accountOwner, kind: 'address' }]);
    expect((await remainingAllowance(client)).addresses).toBe(1);
    expect((await remainingAllowance(elsewhere)).addresses).toBe(1);
  });
});

describe('one non-terminal job per project', () => {
  it('supersedes instead of failing when two looks race on one project', async () => {
    const client = await newClient();
    const ownerId = await ownerIdOf(harness, client);
    const project = await adoptStreetViewProject(harness, client);
    const [a, b] = await Promise.all([
      render(client, project, { style: 'subtle' }),
      render(client, project, { style: 'abundant' }),
    ]);
    remember(client, a);
    remember(client, b);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    const active = await nonTerminalJobs(ownerId);
    expect(active).toHaveLength(1);
    const ids = [
      json<{ renderJobId: string }>(a).renderJobId,
      json<{ renderJobId: string }>(b).renderJobId,
    ];
    const loser = ids.find((id) => id !== active[0]?.id) as string;
    const superseded = await harness.context.db
      .selectFrom('renderJobs')
      .select(['state', 'supersededByJobId'])
      .where('id', '=', loser)
      .executeTakeFirstOrThrow();
    expect(superseded).toEqual({ state: 'superseded', supersededByJobId: active[0]?.id });
  });

  it('returns the in-flight job for a repeat of its look instead of restarting it', async () => {
    const client = await newClient();
    const project = await adoptStreetViewProject(harness, client);
    const first = await render(client, project, { style: 'subtle' });
    remember(client, first);
    expect(first.statusCode).toBe(202);
    const renderJobId = json<{ renderJobId: string }>(first).renderJobId;
    const repeat = await render(client, project, { style: 'subtle' });
    expect(repeat.statusCode).toBe(202);
    expect(json(repeat)).toMatchObject({ renderJobId, supersededRenderJobId: null });

    const jobs = await harness.context.db
      .selectFrom('renderJobs')
      .select(['id', 'state'])
      .where('projectId', '=', project.projectId)
      .execute();
    expect(jobs).toEqual([{ id: renderJobId, state: 'queued' }]);
    const reservations = await harness.context.db
      .selectFrom('usageLedger')
      .select('jobId')
      .where('projectId', '=', project.projectId)
      .where('kind', '=', 'reservation')
      .execute();
    expect(new Set(reservations.map((row) => row.jobId))).toEqual(new Set([renderJobId]));
    const entries = await harness.context.queue.boss.findJobs('render', { key: project.projectId });
    expect(entries.map((entry) => entry.id)).toEqual([renderJobId]);
  });
});

describe('variant-key cache', () => {
  it('serves a cached look only while the asset is unexpired, the source ready and display allowed', async () => {
    const client = await newClient();
    const project = await adoptStreetViewProject(harness, client);
    const queued = await render(client, project);
    const renderJobId = json<{ renderJobId: string }>(queued).renderJobId;
    expect(await harness.completeRender(renderJobId)).toBe('succeeded');
    expect((await render(client, project)).statusCode).toBe(200);
    const db = harness.context.db;
    const asset = await db
      .selectFrom('renderAssets')
      .select('id')
      .where('jobId', '=', renderJobId)
      .executeTakeFirstOrThrow();
    const source = await db
      .selectFrom('sourceAssets')
      .select(['id', 'assetPolicyId'])
      .where('id', '=', project.sourceAssetId)
      .executeTakeFirstOrThrow();
    const cancelNew = async (response: { statusCode: number; json(): unknown }) => {
      if (response.statusCode !== 202) return;
      const id = (response.json() as { renderJobId: string }).renderJobId;
      await client.post(`/v1/renders/${id}/cancel`, {});
    };

    await db
      .updateTable('renderAssets')
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where('id', '=', asset.id)
      .execute();
    const expired = await render(client, project);
    expect(expired.statusCode).toBe(202);
    await cancelNew(expired);
    await db
      .updateTable('renderAssets')
      .set({ expiresAt: null })
      .where('id', '=', asset.id)
      .execute();
    expect((await render(client, project)).statusCode).toBe(200);

    await db
      .updateTable('sourceAssets')
      .set({ state: 'stale' })
      .where('id', '=', source.id)
      .execute();
    const stale = await render(client, project);
    expect(stale.statusCode).toBe(409);
    expect(json(stale).error).toMatchObject({
      code: 'SOURCE_NOT_EDITABLE',
      details: { reason: 'stale' },
    });
    await db
      .updateTable('sourceAssets')
      .set({ state: 'ready' })
      .where('id', '=', source.id)
      .execute();
    expect((await render(client, project)).statusCode).toBe(200);

    await db
      .updateTable('assetPolicies')
      .set({ display: 'denied' })
      .where('id', '=', source.assetPolicyId as string)
      .execute();
    const hidden = await render(client, project);
    expect(hidden.statusCode).not.toBe(200);
    await cancelNew(hidden);
  });
});
