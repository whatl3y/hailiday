import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CachedRenderResponseSchema,
  CreateShareResponseSchema,
  DecorationPlanSchema,
  ProductsPanelSchema,
  QueuedRenderResponseSchema,
  RenderStatusSchema,
  ShareViewSchema,
  VariantListResponseSchema,
  type Project,
} from '@holiday/core';
import { DAY_MS } from '@holiday/server/clock';
import { dailySaltedHash } from '@holiday/server/ids';
import { createRenderJobRecord, generateShareCard } from '@holiday/server/pipeline';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';
import { ownerIdOf } from './test/projects.js';

/**
 * This file's own client address. Every render job counts against the IP dimension of the render
 * backstop, so the file keeps its jobs off the harness default address (127.0.0.1) that other
 * files share under the same session secret.
 */
const FILE_ADDRESS = '10.60.0.1';
const DEFAULT_ADDRESS = '127.0.0.1';

let harness: Harness;
let client: TestClient;
let project: Project;
let firstJobId: string;
let firstKey: string;
let renderAssetId: string;

const body = (overrides: Record<string, unknown> = {}) => ({
  projectId: project.id,
  projectVersion: project.projectVersion,
  holidayId: 'christmas',
  style: 'classic',
  lightingMode: 'source',
  ...overrides,
});

beforeAll(async () => {
  harness = await createHarness();
  client = harness.client({ remoteAddress: FILE_ADDRESS });
  await client.createSession();
  const resolved = await client.post('/v1/addresses/resolve', {
    placeId: 'ChIJfxLanternHillColonial01',
    sessionToken: await placesTokenForClient(harness, client),
    holidayId: 'christmas',
  });
  const created = (resolved.json() as { project: Project }).project;
  const discovery = await client.post(`/v1/projects/${created.id}/source-discovery`, {
    projectVersion: 0,
  });
  project = (discovery.json() as { project: Project }).project;
});

afterAll(async () => {
  await harness?.close();
});

/** Render jobs whose IP hash is one a request from `address` counts in the current window. */
async function jobsBehind(address: string) {
  const now = new Date();
  const hashes = [now, new Date(now.getTime() - DAY_MS)].map((at) =>
    dailySaltedHash(harness.config.sessionSecret, `ip:${address}`, at),
  );
  return harness.context.db
    .selectFrom('renderJobs')
    .select(['id', 'ownerId'])
    .where('ipHash', 'in', hashes)
    .execute();
}

/** Anchor categories of the job's accepted plan, each once in plan order (read from the rows). */
async function acceptedCategories(jobId: string): Promise<string[]> {
  const attempt = await harness.context.db
    .selectFrom('renderAttempts')
    .select('decorationPlanId')
    .where('jobId', '=', jobId)
    .where('outcome', '=', 'succeeded')
    .executeTakeFirstOrThrow();
  const plan = await harness.context.db
    .selectFrom('decorationPlans')
    .select('document')
    .where('id', '=', attempt.decorationPlanId)
    .executeTakeFirstOrThrow();
  const categories: string[] = [];
  for (const placement of DecorationPlanSchema.parse(plan.document).placements) {
    if (!categories.includes(placement.anchorCategory)) categories.push(placement.anchorCategory);
  }
  return categories;
}

describe('POST /v1/renders', () => {
  it('requires an Idempotency-Key and the current project version', async () => {
    const missing = await client.post('/v1/renders', body());
    expect(missing.statusCode).toBe(400);
    const stale = await client.post('/v1/renders', body({ projectVersion: 0 }), {
      'idempotency-key': randomUUID(),
    });
    expect(stale.statusCode).toBe(409);
    expect(json(stale).error).toMatchObject({
      code: 'STALE_PROJECT_VERSION',
      details: { currentProjectVersion: 1 },
    });
    const notOffered = await client.post(
      '/v1/renders',
      body({ lightingMode: 'evening', holidayId: 'thanksgiving_us' }),
      {
        'idempotency-key': randomUUID(),
      },
    );
    expect(notOffered.statusCode).toBe(400);
    expect(json(notOffered).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'content_cell_not_offered' },
    });
  });

  it('queues a job (202) in one transaction with a reservation and the queue entry', async () => {
    firstKey = randomUUID();
    const response = await client.post('/v1/renders', body(), { 'idempotency-key': firstKey });
    expect(response.statusCode).toBe(202);
    const queued = QueuedRenderResponseSchema.parse(response.json());
    expect(queued).toMatchObject({
      cached: false,
      state: 'queued',
      stageLabelKey: 'stage.preparing',
      seq: 0,
      supersededRenderJobId: null,
      permittedActions: ['cancel'],
    });
    firstJobId = queued.renderJobId;
    const reservations = await harness.context.db
      .selectFrom('usageLedger')
      .select(['sku', 'kind'])
      .where('jobId', '=', firstJobId)
      .execute();
    expect(reservations.filter((row) => row.kind === 'reservation').length).toBeGreaterThanOrEqual(
      5,
    );
    const queueJob = await harness.context.queue.getJob('render', firstJobId);
    expect(queueJob?.id).toBe(firstJobId);

    const replay = await client.post('/v1/renders', body(), { 'idempotency-key': firstKey });
    expect(replay.statusCode).toBe(202);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(json(replay).renderJobId).toBe(firstJobId);

    const conflict = await client.post('/v1/renders', body({ style: 'subtle' }), {
      'idempotency-key': firstKey,
    });
    expect(conflict.statusCode).toBe(422);
    expect(json(conflict).error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('streams the current status over SSE and serves polling status', async () => {
    const status = await client.get(`/v1/renders/${firstJobId}`);
    expect(status.statusCode).toBe(200);
    RenderStatusSchema.parse(status.json());

    const state = await harness.completeRender(firstJobId);
    expect(state).toBe('succeeded');

    const stream = await client.get(`/v1/renders/${firstJobId}/events`);
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('retry: 3000');
    const event = /id: (\d+)\nevent: render\ndata: (.*)\n\n/.exec(stream.body);
    expect(event).not.toBeNull();
    const payload = RenderStatusSchema.parse(JSON.parse(event?.[2] ?? '{}'));
    expect(payload.state).toBe('succeeded');
    expect(payload.variant?.imageUrl).toBeTruthy();
    expect(payload.variant?.attribution).toMatchObject({ required: true, logo: 'google_maps' });
    expect(project.activeSource?.sourceAssetId).toBeTruthy();
    expect(payload.variant?.sourceAssetId).toBe(project.activeSource?.sourceAssetId);
    renderAssetId = payload.variant?.renderAssetId ?? '';
    expect(payload.variant?.placements).toEqual(await acceptedCategories(firstJobId));
    expect(payload.variant?.placements.length).toBeGreaterThan(0);

    const done = await client.get(`/v1/renders/${firstJobId}/events`, {
      'last-event-id': String(payload.seq),
    });
    expect(done.statusCode).toBe(204);
  });

  it('answers a repeat of a finished look from the variant cache (200, no allowance)', async () => {
    const response = await client.post('/v1/renders', body(), {
      'idempotency-key': randomUUID(),
    });
    expect(response.statusCode).toBe(200);
    const cached = CachedRenderResponseSchema.parse(response.json());
    expect(cached.variant.renderAssetId).toBe(renderAssetId);
    expect(cached.variant.sourceAssetId).toBe(project.activeSource?.sourceAssetId);
    expect(cached.variant.placements).toEqual(await acceptedCategories(firstJobId));
    expect(cached.allowance.variants.remaining).toBe(2);

    const variants = await client.get(`/v1/projects/${project.id}/variants`);
    const list = VariantListResponseSchema.parse(variants.json());
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.sourceAssetId).toBe(project.activeSource?.sourceAssetId);
    expect(list.items[0]?.placements).toEqual(cached.variant.placements);
    expect(list.activeRender).toBeNull();
    expect(list.offered?.styles).toContain('abundant');
  });

  it('pushes every state transition to an open SSE stream through LISTEN/NOTIFY', async () => {
    const queued = await client.post('/v1/renders', body({ holidayId: 'halloween' }), {
      'idempotency-key': randomUUID(),
    });
    expect(queued.statusCode).toBe(202);
    const jobId = json(queued).renderJobId as string;
    const streaming = client.get(`/v1/renders/${jobId}/events`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.server.deps.events.subscriberCount(jobId)).toBe(1);
    expect(await harness.completeRender(jobId)).toBe('succeeded');
    const stream = await streaming;
    const events = [...stream.body.matchAll(/id: (\d+)\nevent: render\ndata: (.*)\n\n/g)].map(
      (match) => RenderStatusSchema.parse(JSON.parse(match[2] ?? '{}')),
    );
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.state).toBe('queued');
    expect(events[events.length - 1]?.state).toBe('succeeded');
    const seqs = events.map((event) => event.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(harness.server.deps.events.subscriberCount(jobId)).toBe(0);
  });

  it('supersedes an in-flight job and cancels on request', async () => {
    const first = await client.post('/v1/renders', body({ style: 'subtle' }), {
      'idempotency-key': randomUUID(),
    });
    expect(first.statusCode).toBe(202);
    const firstId = json(first).renderJobId as string;
    const second = await client.post('/v1/renders', body({ style: 'abundant' }), {
      'idempotency-key': randomUUID(),
    });
    expect(second.statusCode).toBe(202);
    expect(json(second).supersededRenderJobId).toBe(firstId);
    const old = RenderStatusSchema.parse((await client.get(`/v1/renders/${firstId}`)).json());
    expect(old.state).toBe('superseded');
    const secondId = json(second).renderJobId as string;
    expect(old.supersededByRenderJobId).toBe(secondId);

    const canceled = await client.post(`/v1/renders/${secondId}/cancel`, {});
    expect(canceled.statusCode).toBe(200);
    expect(RenderStatusSchema.parse(canceled.json()).state).toBe('canceled');
    const again = await client.post(`/v1/renders/${secondId}/cancel`, {});
    expect(RenderStatusSchema.parse(again.json()).state).toBe('canceled');
  });

  it('refuses a new look once the variants allowance is spent', async () => {
    const source = await harness.context.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', project.activeSource?.sourceAssetId ?? '')
      .executeTakeFirstOrThrow();
    const ownerId = source.ownerId;
    for (let i = 0; i < 2; i += 1) {
      const job = await createRenderJobRecord(harness.pipeline, {
        ownerId,
        projectId: project.id,
        source,
        style: 'subtle',
      });
      await harness.context.db
        .updateTable('renderJobs')
        .set({ state: 'succeeded', succeededAt: new Date(), terminalAt: new Date() })
        .where('id', '=', job.id)
        .execute();
    }
    const response = await client.post('/v1/renders', body({ lightingMode: 'evening' }), {
      'idempotency-key': randomUUID(),
    });
    expect(response.statusCode).toBe(429);
    expect(json(response).error).toMatchObject({
      code: 'ALLOWANCE_EXHAUSTED',
      details: { scope: 'variants' },
    });
    expect(
      json<{ error: { details: { resetsAt: string } } }>(response).error.details.resetsAt,
    ).toBeTruthy();
    const me = await client.get('/v1/me');
    expect(json(me).allowance).toMatchObject({ gate: 'allowance_variants' });
  });

  it("keeps the file's renders behind its own address, under the IP backstop", async () => {
    const ownerId = await ownerIdOf(harness, client);
    const own = await jobsBehind(FILE_ADDRESS);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((job) => job.ownerId === ownerId)).toBe(true);
    const limit = await harness.context.settings.get('quota.render_requests_per_ip_24h');
    expect(own.length).toBeLessThan(limit);
    const shared = await jobsBehind(DEFAULT_ADDRESS);
    expect(shared.filter((job) => job.ownerId === ownerId)).toEqual([]);
  });
});

describe('Shop the look', () => {
  it('returns a panel state and cards with pre-issued click tokens', async () => {
    const response = await client.get(`/v1/renders/${firstJobId}/products`);
    expect(response.statusCode).toBe(200);
    const panel = ProductsPanelSchema.parse(response.json());
    expect(['active', 'no_offers', 'off_season', 'hidden']).toContain(panel.panelState);
    if (panel.panelState === 'active') {
      const card = panel.items[0];
      expect(card?.clickToken).toBeTruthy();
      const click = await client.post('/v1/clicks', { clickToken: card?.clickToken });
      expect(click.statusCode).toBe(201);
      const repeat = await client.post('/v1/clicks', { clickToken: card?.clickToken });
      expect(json(repeat).clickId).toBe(json(click).clickId);
    }
    const forged = await client.post('/v1/clicks', {
      clickToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(forged.statusCode).toBe(404);
  });
});

describe('shares and feedback', () => {
  it('creates a share, serves the JSON view and share page, and revokes it', async () => {
    const created = await client.post(
      '/v1/shares',
      { renderAssetId },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.statusCode).toBe(201);
    const share = CreateShareResponseSchema.parse(created.json());
    expect(share.url).toBe(`${harness.config.publicBaseUrl}/s/${share.token}`);
    const grant = await harness.context.db
      .selectFrom('shareGrants')
      .select(['id', 'tokenHash'])
      .where('renderAssetId', '=', renderAssetId)
      .executeTakeFirstOrThrow();
    expect(grant.tokenHash).not.toBe(share.token);
    const card = await generateShareCard(harness.pipeline, {
      shareGrantId: grant.id,
      shareToken: share.token,
    });
    expect(card.outcome).toBe('written');

    const anonymous = harness.client();
    const view = await anonymous.get(`/v1/shares/${share.token}`);
    expect(view.statusCode).toBe(200);
    const parsed = ShareViewSchema.parse(view.json());
    expect(parsed.beforeImageUrl).toBeNull();
    expect(parsed.attribution).toMatchObject({ required: true });
    expect(JSON.stringify(parsed)).not.toContain('Lantern');

    const page = await anonymous.get(`/s/${share.token}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('AI preview');
    expect(page.body).toContain('<meta name="robots" content="noindex"');
    expect(page.body).toContain(`/cards/${share.token}.jpg`);
    expect(page.body).toContain('href="/?holiday=christmas"');
    expect(page.body).toContain('Report this image');
    expect(page.body).not.toContain('Lantern');
    expect(page.body).not.toContain('commerce');

    const includeBefore = await client.post('/v1/shares', { renderAssetId, includeBefore: true });
    expect(includeBefore.statusCode).toBe(400);
    expect(json(includeBefore).error).toMatchObject({
      details: { reason: 'source_not_exportable' },
    });

    const revoked = await client.delete(`/v1/shares/${share.token}`);
    expect(revoked.statusCode).toBe(204);
    expect((await client.delete(`/v1/shares/${share.token}`)).statusCode).toBe(204);
    const gone = await anonymous.get(`/s/${share.token}`);
    expect(gone.statusCode).toBe(410);
    expect(gone.body).toContain('no longer shared');
    const goneJson = await anonymous.get(`/v1/shares/${share.token}`);
    expect(goneJson.statusCode).toBe(410);
    expect(json(goneJson).error).toMatchObject({
      code: 'SHARE_REVOKED',
      details: { reason: 'revoked' },
    });
    const unknown = await anonymous.get('/s/AAAAAAAAAAAAAAAAAAAAAA');
    expect(unknown.statusCode).toBe(404);
  });

  it('records feedback idempotently', async () => {
    const key = randomUUID();
    const first = await client.post(
      '/v1/feedback',
      { renderAssetId, verdict: 'down', reasons: ['changed_home'], note: 'The porch moved.' },
      { 'idempotency-key': key },
    );
    expect(first.statusCode).toBe(201);
    const again = await client.post(
      '/v1/feedback',
      { renderAssetId, verdict: 'down', reasons: ['changed_home'], note: 'The porch moved.' },
      { 'idempotency-key': key },
    );
    expect(json(again).feedbackId).toBe(json(first).feedbackId);
  });

  it('deletes the project, revoking access first', async () => {
    const response = await client.delete(`/v1/projects/${project.id}`);
    expect(response.statusCode).toBe(202);
    expect(json(response).deletionRequestId).toBeTruthy();
    expect((await client.get(`/v1/projects/${project.id}`)).statusCode).toBe(404);
    const repeat = await client.delete(`/v1/projects/${project.id}`);
    expect(repeat.statusCode).toBe(202);
    expect(json(repeat).deletionRequestId).toBe(json(response).deletionRequestId);
  });
});
