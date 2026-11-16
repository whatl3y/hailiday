import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProjectSchema,
  RenderStatusSchema,
  SourceDiscoveryResponseSchema,
  type Project,
} from '@hailiday/core';
import type { AppConfig } from '@hailiday/server/config';
import { toJson } from '@hailiday/server/db';
import { newId, randomToken, sha256Hex } from '@hailiday/server/ids';
import { runStreetViewRevalidation } from '@hailiday/server/pipeline';
import { defaultPolicyTemplate, streetViewSourceMode } from '@hailiday/server/policy';
import { keys } from '@hailiday/server/storage';
import { evaluateFor } from './domain/sources.js';
import { createHarness, json, TestClient, type Harness } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';
import { adoptStreetViewProject } from './test/projects.js';

const PLACES = {
  autoStart: 'ChIJfxLanternHillColonial01',
  confirm: 'ChIJfxDriftwoodCoveCapeXX15',
} as const;
const LIVE_COPYRIGHT = '© 2025 Google';
const DAY_MS = 86_400_000;

let clientIndex = 0;

async function newClient(harness: Harness): Promise<TestClient> {
  clientIndex += 1;
  const client = harness.client({
    remoteAddress: `10.73.${Math.floor(clientIndex / 200)}.${clientIndex % 200}`,
  });
  await client.createSession();
  return client;
}

/** The same browser (session and device cookies) against another API process on the same data. */
function sameBrowser(harness: Harness, client: TestClient): TestClient {
  const other = new TestClient(harness, {
    remoteAddress: client.remoteAddress,
    deviceCookie: client.deviceCookie,
  });
  other.cookie = client.cookie;
  return other;
}

const BASE_OVERRIDES = { RENDER_QUEUE_DEPTH_MAX: '100000', RENDER_MAX_WAIT_S: '1000000' };

/**
 * A harness whose API sees the given capability states (this server only) and live Street View
 * imagery in its configuration; every adapter stays a fixture.
 */
async function stubbedHarness(
  states: Record<string, string>,
  overrides: Record<string, string> = {},
): Promise<Harness> {
  const harness = await createHarness({
    overrides: { ...BASE_OVERRIDES, ...overrides },
    mapConfig: (config): AppConfig => ({
      ...config,
      providers: { ...config.providers, streetView: 'google', imageEditor: 'openai' },
    }),
  });
  const capabilities = harness.context.capabilities;
  const stored = capabilities.state.bind(capabilities);
  vi.spyOn(capabilities, 'state').mockImplementation(async (country, capability) =>
    capability in states
      ? ((states[capability] ?? null) as Awaited<ReturnType<typeof stored>>)
      : stored(country, capability),
  );
  vi.spyOn(harness.context.settings, 'isProviderPaused').mockResolvedValue(false);
  return harness;
}

async function currentProject(client: TestClient, projectId: string): Promise<Project> {
  return ProjectSchema.parse(
    json<{ project: unknown }>(await client.get(`/v1/projects/${projectId}`)).project,
  );
}

async function render(client: TestClient, projectId: string, styleIndex = 0) {
  const current = await currentProject(client, projectId);
  const styles = current.offered?.styles ?? [];
  expect(styles.length).toBeGreaterThan(styleIndex);
  return client.post(
    '/v1/renders',
    {
      projectId,
      projectVersion: current.projectVersion,
      holidayId: 'christmas',
      style: styles[styleIndex],
      lightingMode: 'source',
    },
    { 'idempotency-key': randomUUID() },
  );
}

async function resolve(harness: Harness, client: TestClient, placeId: string): Promise<Project> {
  const response = await client.post('/v1/addresses/resolve', {
    placeId,
    sessionToken: await placesTokenForClient(harness, client),
    holidayId: 'christmas',
  });
  expect(response.statusCode).toBe(201);
  return ProjectSchema.parse((response.json() as { project: unknown }).project);
}

async function discover(client: TestClient, project: Pick<Project, 'id' | 'projectVersion'>) {
  const response = await client.post(`/v1/projects/${project.id}/source-discovery`, {
    projectVersion: project.projectVersion,
  });
  expect(response.statusCode).toBe(200);
  return SourceDiscoveryResponseSchema.parse(response.json());
}

function sourceRow(harness: Harness, id: string) {
  return harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** Gives a project's property a place ID of its own and puts that place on the opt-out list. */
async function blockPlaceOf(harness: Harness, projectId: string) {
  const db = harness.context.db;
  const project = await db
    .selectFrom('projects')
    .select('propertyId')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  const placeId = `ChIJsvApiSafety${newId().replace(/-/g, '')}`;
  await db
    .updateTable('properties')
    .set({ placeId })
    .where('id', '=', project.propertyId!)
    .execute();
  await db
    .insertInto('blockedAddresses')
    .values({ id: newId(), placeId, source: 'homeowner_request', evidenceRef: 'test:opt-out' })
    .execute();
}

/** A Street View project with one delivered look and a stored frame. */
async function renderedLook(harness: Harness, client: TestClient) {
  const project = await adoptStreetViewProject(harness, client);
  await harness.context.db
    .updateTable('sourceAssets')
    .set({ streetViewMode: 'persist' })
    .where('id', '=', project.sourceAssetId)
    .execute();
  const response = await render(client, project.projectId);
  expect(response.statusCode).toBe(202);
  const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
  expect(await harness.completeRender(renderJobId)).toBe('succeeded');
  const asset = await harness.context.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('jobId', '=', renderJobId)
    .executeTakeFirstOrThrow();
  const source = await sourceRow(harness, project.sourceAssetId);
  expect(source.objectKey).not.toBeNull();
  return { project, renderJobId, asset, source };
}

async function variantsOf(client: TestClient, projectId: string) {
  const response = await client.get(`/v1/projects/${projectId}/variants`);
  expect(response.statusCode).toBe(200);
  return json<{
    items: {
      renderAssetId: string;
      downloadUrl: string | null;
      distributable: boolean;
      expiresAt: string | null;
    }[];
  }>(response).items;
}

function staticFetchLines(harness: Harness, jobId: string) {
  return harness.context.db
    .selectFrom('usageLedger')
    .select(['kind', 'sku'])
    .where('jobId', '=', jobId)
    .where('sku', '=', 'street_view_static_fetch')
    .execute();
}

/** The analysis lines of a render job's ledger, oldest first. */
async function analysisLines(harness: Harness, jobId: string) {
  const rows = await harness.context.db
    .selectFrom('usageLedger')
    .select('kind')
    .where('jobId', '=', jobId)
    .where('sku', '=', 'vision_call')
    .where('stage', '=', 'analyzing')
    .orderBy('createdAt')
    .execute();
  return rows.map((row) => row.kind);
}

/**
 * Makes a source's stored frame one fetched 45 days ago with other bytes than the provider serves
 * now (recorded with their own checksum, so the stored copy itself is intact).
 */
async function storeEarlierAgedFrame(harness: Harness, sourceId: string) {
  const stored = await sourceRow(harness, sourceId);
  const earlier = Buffer.from(`earlier frame ${randomToken(8)}`);
  await harness.context.storage.put({
    bucket: 'private',
    key: stored.objectKey!,
    body: earlier,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'upload' },
  });
  await harness.context.db
    .updateTable('sourceAssets')
    .set({
      checksumSha256: sha256Hex(earlier),
      viewpoint: toJson({
        ...stored.viewpoint!,
        fetchedAt: new Date(Date.now() - 45 * DAY_MS).toISOString(),
      }),
    })
    .where('id', '=', sourceId)
    .execute();
}

/** Puts a share link's public copies (the shared after image and the card) on the public bucket. */
async function publishShareCopies(harness: Harness, token: string) {
  for (const key of [keys.shared(token, 'after'), keys.card(token)]) {
    await harness.context.storage.put({
      bucket: 'public',
      key,
      body: Buffer.from('public copy'),
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
  }
}

async function publicCopies(harness: Harness, token: string) {
  const heads = await Promise.all(
    [keys.shared(token, 'after'), keys.card(token)].map((key) =>
      harness.context.storage.head('public', key),
    ),
  );
  return heads.filter((head) => head !== null).length;
}

async function shareOf(client: TestClient, renderAssetId: string) {
  const share = await client.post(
    '/v1/shares',
    { renderAssetId },
    { 'idempotency-key': randomUUID() },
  );
  expect(share.statusCode).toBe(201);
  return json<{ token: string }>(share).token;
}

describe('Street View safety under the default use policy', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ overrides: BASE_OVERRIDES });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('refuses a render of a blocked place, also of a cached look, and creates no job', async () => {
    const client = await newClient(harness);
    const { project } = await renderedLook(harness, client);
    await blockPlaceOf(harness, project.projectId);
    const jobsBefore = await harness.context.db
      .selectFrom('renderJobs')
      .select('id')
      .where('projectId', '=', project.projectId)
      .execute();
    for (const styleIndex of [0, 1]) {
      const response = await render(client, project.projectId, styleIndex);
      expect(response.statusCode).toBe(409);
      expect(json(response).error).toMatchObject({
        code: 'NEEDS_PHOTO',
        details: { sourceMode: 'unavailable' },
      });
    }
    const jobsAfter = await harness.context.db
      .selectFrom('renderJobs')
      .select('id')
      .where('projectId', '=', project.projectId)
      .execute();
    expect(jobsAfter).toHaveLength(jobsBefore.length);
  });

  it('refuses to bind a candidate of a place blocked after its discovery and never replays it', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const first = await discover(client, project);
    expect(first.discovery.matchClass).toBe('confirm');
    const primary = first.discovery.candidates.find((candidate) => candidate.isPrimary);
    await blockPlaceOf(harness, project.id);

    const bound = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: first.project.projectVersion,
      candidateId: primary?.candidateId,
    });
    expect(bound.statusCode).toBe(404);
    expect(json(bound).error).toMatchObject({ code: 'NO_STREET_VIEW' });

    const again = await discover(client, first.project);
    expect(again.discovery.discoveryId).not.toBe(first.discovery.discoveryId);
    expect(again.discovery).toMatchObject({ matchClass: 'skip_to_upload', candidates: [] });
    expect(again.project.activeSource).toBeNull();
  });

  it('turns a source recorded as transient into persist under the unchanged full template', async () => {
    const client = await newClient(harness);
    const project = await adoptStreetViewProject(harness, client);
    expect((await sourceRow(harness, project.sourceAssetId)).streetViewMode).toBe('transient');
    const response = await render(client, project.projectId);
    expect(response.statusCode).toBe(202);
    expect((await sourceRow(harness, project.sourceAssetId)).streetViewMode).toBe('persist');
    await client.post(`/v1/renders/${json<{ renderJobId: string }>(response).renderJobId}/cancel`);
  });

  it('keeps a transient source transient when its policy was recorded deliberately', async () => {
    const client = await newClient(harness);
    const project = await adoptStreetViewProject(harness, client);
    const source = await sourceRow(harness, project.sourceAssetId);
    await harness.context.db
      .updateTable('assetPolicies')
      .set({ createdBy: 'operator:policy-review' })
      .where('id', '=', source.assetPolicyId as string)
      .execute();
    const response = await render(client, project.projectId);
    expect(response.statusCode).toBe(202);
    expect((await sourceRow(harness, project.sourceAssetId)).streetViewMode).toBe('transient');
    await client.post(`/v1/renders/${json<{ renderJobId: string }>(response).renderJobId}/cancel`);
  });

  it('keeps an operator-denied source display-only when its view is confirmed again', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const first = await discover(client, project);
    const primary = first.discovery.candidates.find((candidate) => candidate.isPrimary);
    const bind = (projectVersion: number) =>
      client.put(`/v1/projects/${project.id}/source`, {
        projectVersion,
        candidateId: primary?.candidateId,
      });
    const bound = ProjectSchema.parse(
      json<{ project: unknown }>(await bind(first.project.projectVersion)).project,
    );
    expect(bound.activeSource?.sourceMode).toBe('persist');
    const source = await sourceRow(harness, bound.activeSource?.sourceAssetId as string);
    await harness.context.db
      .updateTable('assetPolicies')
      .set({ aiProcess: 'denied', edit: 'denied', createdBy: 'operator:policy-review' })
      .where('id', '=', source.assetPolicyId as string)
      .execute();

    const again = await bind(bound.projectVersion);
    expect(again.statusCode).toBe(200);
    expect(
      ProjectSchema.parse(json<{ project: unknown }>(again).project).activeSource,
    ).toMatchObject({ sourceAssetId: source.id, sourceMode: 'display_only' });
    expect((await sourceRow(harness, source.id)).streetViewMode).toBe('display_only');
  });

  it('reserves a Static fetch for a stored frame past its maximum age, and none before', async () => {
    const client = await newClient(harness);
    const { project, source } = await renderedLook(harness, client);
    const age = async (days: number) =>
      harness.context.db
        .updateTable('sourceAssets')
        .set({
          viewpoint: toJson({
            ...source.viewpoint!,
            fetchedAt: new Date(Date.now() - days * DAY_MS).toISOString(),
          }),
        })
        .where('id', '=', source.id)
        .execute();
    await age(29);
    const fresh = await render(client, project.projectId, 1);
    expect(fresh.statusCode).toBe(202);
    const freshJob = json<{ renderJobId: string }>(fresh).renderJobId;
    expect(await staticFetchLines(harness, freshJob)).toEqual([]);
    // The stored frame's analysis is reused, so none is reserved.
    expect(await analysisLines(harness, freshJob)).toEqual([]);
    await client.post(`/v1/renders/${freshJob}/cancel`);

    await age(31);
    const aged = await render(client, project.projectId, 2);
    expect(aged.statusCode).toBe(202);
    const agedJob = json<{ renderJobId: string }>(aged).renderJobId;
    expect(await staticFetchLines(harness, agedJob)).toEqual([
      { kind: 'reservation', sku: 'street_view_static_fetch' },
    ]);
    // The fetched frame may carry other bytes, so its analysis is reserved too.
    expect(await analysisLines(harness, agedJob)).toEqual(['reservation']);
    await client.post(`/v1/renders/${agedJob}/cancel`);
  });

  it('renders an auto-started place on a refetched frame with other bytes and discovers it again', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.autoStart);
    const first = await discover(client, project);
    expect(first.discovery.matchClass).toBe('auto_start');
    const sourceId = first.project.activeSource?.sourceAssetId as string;
    const r1 = await render(client, project.id, 0);
    expect(await harness.completeRender(json<{ renderJobId: string }>(r1).renderJobId)).toBe(
      'succeeded',
    );
    await storeEarlierAgedFrame(harness, sourceId);

    const r2 = await render(client, project.id, 1);
    expect(r2.statusCode).toBe(202);
    const job2 = json<{ renderJobId: string }>(r2).renderJobId;
    expect(await harness.completeRender(job2)).toBe('succeeded');
    const after = await sourceRow(harness, sourceId);
    expect(after).toMatchObject({ state: 'ready', staleAt: null });
    const frame = await harness.context.storage.get('private', after.objectKey!);
    expect(after.checksumSha256).toBe(sha256Hex(frame!.body));
    expect(Date.now() - Date.parse(after.viewpoint!.fetchedAt!)).toBeLessThan(DAY_MS);
    expect(await staticFetchLines(harness, job2)).toEqual([
      { kind: 'reservation', sku: 'street_view_static_fetch' },
      { kind: 'settlement', sku: 'street_view_static_fetch' },
    ]);
    // The fetched frame is the one the first look was analyzed on: the reserved analysis is
    // released, not settled.
    expect(await analysisLines(harness, job2)).toEqual(['reservation', 'release']);

    const again = await discover(client, await currentProject(client, project.id));
    expect(again.project.activeSource).toMatchObject({ sourceAssetId: sourceId, state: 'ready' });
    const items = await variantsOf(client, project.id);
    expect(items).toHaveLength(2);
  });

  it('reserves the analysis of a frame replaced by a job that failed before analyzing it', async () => {
    const client = await newClient(harness);
    const { project, source } = await renderedLook(harness, client);
    await storeEarlierAgedFrame(harness, source.id);
    // The refetch serves another decodable frame (a view turned a little), whose analysis fails.
    const streetView = harness.pipeline.providers.fixtures.streetView;
    const fetchTransient = streetView.fetchTransient.bind(streetView);
    const spies = [
      vi
        .spyOn(streetView, 'fetchTransient')
        .mockImplementation(async (view, options) =>
          fetchTransient({ ...view, heading: view.heading + 10 }, options),
        ),
      ...[
        ...new Set([harness.pipeline.providers.vision, harness.pipeline.providers.fixtures.vision]),
      ].map((vision) =>
        vi.spyOn(vision, 'analyzeScene').mockRejectedValue(new Error('unavailable')),
      ),
    ];
    let replacing: string;
    try {
      const response = await render(client, project.projectId, 1);
      expect(response.statusCode).toBe(202);
      replacing = json<{ renderJobId: string }>(response).renderJobId;
      expect(await harness.completeRender(replacing)).toBe('failed');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // The job replaced the stored frame (other bytes, a fresh fetch time) and stored no analysis.
    const replaced = await sourceRow(harness, source.id);
    expect(replaced.state).toBe('ready');
    expect(replaced.checksumSha256).not.toBe(source.checksumSha256);
    const frame = await harness.context.storage.get('private', replaced.objectKey!);
    expect(replaced.checksumSha256).toBe(sha256Hex(frame!.body));
    expect(Date.now() - Date.parse(replaced.viewpoint!.fetchedAt!)).toBeLessThan(DAY_MS);
    expect(await analysisLines(harness, replacing)).toEqual(['reservation', 'release']);

    // The next render reads the fresh frame from storage: no fetch, and its analysis is reserved.
    const next = await render(client, project.projectId, 2);
    expect(next.statusCode).toBe(202);
    const nextJob = json<{ renderJobId: string }>(next).renderJobId;
    expect(await staticFetchLines(harness, nextJob)).toEqual([]);
    expect(await analysisLines(harness, nextJob)).toEqual(['reservation']);
    expect(await harness.completeRender(nextJob)).toBe('succeeded');
    expect(await analysisLines(harness, nextJob)).toEqual(['reservation', 'settlement']);
  });

  it('admits a render again once the revalidation finds a stale source panorama still served', async () => {
    const client = await newClient(harness);
    const { project, source } = await renderedLook(harness, client);
    await harness.context.db
      .updateTable('sourceAssets')
      .set({ state: 'stale', staleAt: new Date(), revalidatedAt: null })
      .where('id', '=', source.id)
      .execute();
    const refused = await render(client, project.projectId, 1);
    expect(refused.statusCode).toBe(409);
    expect(json(refused).error).toMatchObject({ details: { reason: 'stale' } });

    const result = await runStreetViewRevalidation(harness.pipeline, {
      sourceAssetIds: [source.id],
    });
    expect(result.restored).toBe(1);
    expect(await sourceRow(harness, source.id)).toMatchObject({
      state: 'ready',
      staleAt: null,
      objectKey: source.objectKey,
    });
    const admitted = await render(client, project.projectId, 1);
    expect(admitted.statusCode).toBe(202);
    await client.post(`/v1/renders/${json<{ renderJobId: string }>(admitted).renderJobId}/cancel`);
  });

  it('keeps a confirmed view usable after a refetched frame with other bytes', async () => {
    const client = await newClient(harness);
    const { project, source } = await renderedLook(harness, client);
    await storeEarlierAgedFrame(harness, source.id);
    const second = await render(client, project.projectId, 1);
    expect(second.statusCode).toBe(202);
    const secondJob = json<{ renderJobId: string }>(second).renderJobId;
    expect(await harness.completeRender(secondJob)).toBe('succeeded');
    expect((await sourceRow(harness, source.id)).state).toBe('ready');

    const third = await render(client, project.projectId, 2);
    expect(third.statusCode).toBe(202);
    await client.post(`/v1/renders/${json<{ renderJobId: string }>(third).renderJobId}/cancel`);
    expect(await variantsOf(client, project.projectId)).toHaveLength(2);
  });

  it('reports the third attempt in the render status', async () => {
    const client = await newClient(harness);
    const project = await adoptStreetViewProject(harness, client);
    const response = await render(client, project.projectId);
    const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
    await harness.context.db
      .updateTable('renderJobs')
      .set({ attemptCount: 3 })
      .where('id', '=', renderJobId)
      .execute();
    const status = RenderStatusSchema.parse(json(await client.get(`/v1/renders/${renderJobId}`)));
    expect(status.attempt).toBe(3);
    await client.post(`/v1/renders/${renderJobId}/cancel`);
  });

  it('reports no expiry for a look while time-based deletion is off', async () => {
    const client = await newClient(harness);
    const { project, asset } = await renderedLook(harness, client);
    await harness.context.db
      .updateTable('renderAssets')
      .set({ expiresAt: new Date(Date.now() - DAY_MS) })
      .where('id', '=', asset.id)
      .execute();
    expect(await harness.context.settings.get('retention.time_based_deletion')).toBe(false);
    const items = await variantsOf(client, project.projectId);
    expect(items.find((item) => item.renderAssetId === asset.id)?.expiresAt).toBeNull();
  });
});

/**
 * Makes a harness's fixture Street View provider answer as if every panorama had been replaced by
 * newer imagery: the old pano IDs no longer resolve, and the same spots answer with new pano IDs
 * whose frames are the old ones. Undone by `vi.restoreAllMocks()`.
 */
function replacePanoramas(harness: Harness) {
  const provider = harness.server.deps.providers.fixtures.streetView;
  expect(harness.pipeline.providers.fixtures.streetView).toBe(provider);
  const suffix = '_NEW';
  const isNew = (panoId: string) => panoId.endsWith(suffix);
  const toOld = (panoId: string) => (isNew(panoId) ? panoId.slice(0, -suffix.length) : panoId);
  const metadataByPano = provider.metadataByPano.bind(provider);
  const discoverCandidates = provider.discoverCandidates.bind(provider);
  const fetchTransient = provider.fetchTransient.bind(provider);
  vi.spyOn(provider, 'metadataByPano').mockImplementation(async (panoId, options) => {
    if (!isNew(panoId)) {
      return { status: 'ZERO_RESULTS', panoId: null, location: null, date: null, copyright: null };
    }
    const found = await metadataByPano(toOld(panoId), options);
    return found.status === 'OK' ? { ...found, panoId } : found;
  });
  vi.spyOn(provider, 'discoverCandidates').mockImplementation(async (input, options) => {
    const result = await discoverCandidates(input, options);
    return {
      ...result,
      candidates: result.candidates.map((candidate) => ({
        ...candidate,
        panoId: `${candidate.panoId}${suffix}`,
      })),
    };
  });
  vi.spyOn(provider, 'fetchTransient').mockImplementation(async (view, options) =>
    fetchTransient({ ...view, panoId: toOld(view.panoId) }, options),
  );
  vi.spyOn(provider, 'refreshPanorama').mockImplementation(async (panoId) => {
    const found = await metadataByPano(toOld(panoId));
    return isNew(panoId)
      ? { status: 'unchanged', metadata: { ...found, panoId } }
      : { status: 'replaced', metadata: { ...found, panoId: `${panoId}${suffix}` } };
  });
}

describe('an address whose panorama is replaced after a discovery of the bound version', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      overrides: { ...BASE_OVERRIDES, RATE_STATIC_DISPLAY_LOADS_PER_ADDRESS: '50' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await harness?.close();
  });

  /** Binds the place's view and renders a look. */
  async function boundAndRendered(placeId: string) {
    const client = await newClient(harness);
    const project = await resolve(harness, client, placeId);
    const found = await discover(client, project);
    let sourceId = found.project.activeSource?.sourceAssetId ?? null;
    if (!sourceId) {
      const primary = found.discovery.candidates.find((candidate) => candidate.isPrimary);
      const bound = await client.put(`/v1/projects/${project.id}/source`, {
        projectVersion: found.project.projectVersion,
        candidateId: primary?.candidateId,
      });
      expect(bound.statusCode).toBe(200);
      sourceId = ProjectSchema.parse(json<{ project: unknown }>(bound).project).activeSource
        ?.sourceAssetId as string;
    }
    const first = await render(client, project.id, 0);
    expect(first.statusCode).toBe(202);
    expect(await harness.completeRender(json<{ renderJobId: string }>(first).renderJobId)).toBe(
      'succeeded',
    );
    return { client, projectId: project.id, sourceId };
  }

  /** Runs the daily revalidation on the source and checks that it is stale and refuses renders. */
  async function revalidateToStale(client: TestClient, projectId: string, sourceId: string) {
    await harness.context.db
      .updateTable('sourceAssets')
      .set({ revalidatedAt: null })
      .where('id', '=', sourceId)
      .execute();
    await runStreetViewRevalidation(harness.pipeline, { sourceAssetIds: [sourceId] });
    expect((await sourceRow(harness, sourceId)).state).toBe('stale');
    const refused = await render(client, projectId, 1);
    expect(refused.statusCode).toBe(409);
    expect(json(refused).error).toMatchObject({
      code: 'SOURCE_NOT_EDITABLE',
      details: { reason: 'stale' },
    });
  }

  /**
   * Binds the place's view, renders a look, discovers again at the bound version, then replaces
   * the panorama and lets the daily revalidation mark the source stale.
   */
  async function staleAfterRediscovery(placeId: string) {
    const { client, projectId, sourceId } = await boundAndRendered(placeId);
    const reopened = await discover(client, await currentProject(client, projectId));
    expect(reopened.project.activeSource?.sourceAssetId).toBe(sourceId);

    replacePanoramas(harness);
    await revalidateToStale(client, projectId, sourceId);
    return { client, projectId, sourceId, reopened };
  }

  /**
   * Binds the place's view and renders a look; the daily revalidation then marks the source stale
   * after a discovery of the bound version was stored during its run, before the source's own
   * metadata call answered that the panorama was replaced. With `stampBeforeDiscovery`, the stale
   * stamp is then moved before that discovery, as when the database clock runs ahead of the API's.
   */
  async function staleDuringRediscovery(
    placeId: string,
    options: { stampBeforeDiscovery?: boolean } = {},
  ) {
    const { client, projectId, sourceId } = await boundAndRendered(placeId);
    const provider = harness.server.deps.providers.fixtures.streetView;
    const during: { reopened?: Awaited<ReturnType<typeof discover>> } = {};
    vi.spyOn(provider, 'refreshPanorama').mockImplementationOnce(async (panoId, refresh) => {
      // The owner reopens the place while the run is in progress.
      during.reopened = await discover(client, await currentProject(client, projectId));
      replacePanoramas(harness);
      return provider.refreshPanorama(panoId, refresh);
    });
    await revalidateToStale(client, projectId, sourceId);
    const reopened = during.reopened;
    if (!reopened) throw new Error('no discovery during the revalidation run');
    expect(reopened.project.activeSource?.sourceAssetId).toBe(sourceId);
    if (options.stampBeforeDiscovery) {
      const row = await harness.context.db
        .selectFrom('sourceDiscoveries')
        .select('createdAt')
        .where('id', '=', reopened.discovery.discoveryId)
        .executeTakeFirstOrThrow();
      await harness.context.db
        .updateTable('sourceAssets')
        .set({ staleAt: new Date(row.createdAt.getTime() - 1000) })
        .where('id', '=', sourceId)
        .execute();
    }
    return { client, projectId, sourceId, reopened };
  }

  async function admitsRender(client: TestClient, projectId: string) {
    const admitted = await render(client, projectId, 1);
    expect(admitted.statusCode).toBe(202);
    await client.post(`/v1/renders/${json<{ renderJobId: string }>(admitted).renderJobId}/cancel`);
  }

  type Stale = Awaited<ReturnType<typeof staleAfterRediscovery>>;

  /** A confirm place discovered again binds a new ready source from the new imagery. */
  async function rebindsConfirmPlace({ client, projectId, sourceId, reopened }: Stale) {
    expect(reopened.discovery.matchClass).toBe('confirm');

    const again = await discover(client, await currentProject(client, projectId));
    expect(again.discovery.discoveryId).not.toBe(reopened.discovery.discoveryId);
    const primary = again.discovery.candidates.find((candidate) => candidate.isPrimary);
    expect(primary).toBeDefined();
    // A discovery made after the source went stale is replayed as usual.
    const replayed = await discover(client, again.project);
    expect(replayed.discovery.discoveryId).toBe(again.discovery.discoveryId);

    const bound = await client.put(`/v1/projects/${projectId}/source`, {
      projectVersion: again.project.projectVersion,
      candidateId: primary?.candidateId,
    });
    expect(bound.statusCode).toBe(200);
    const active = ProjectSchema.parse(json<{ project: unknown }>(bound).project).activeSource;
    expect(active?.sourceAssetId).not.toBe(sourceId);
    expect((await sourceRow(harness, active?.sourceAssetId as string)).state).toBe('ready');
    await admitsRender(client, projectId);
  }

  /** An auto-start place discovered again starts on a new ready source from the new imagery. */
  async function restartsAutoStartPlace({ client, projectId, sourceId, reopened }: Stale) {
    expect(reopened.discovery.matchClass).toBe('auto_start');

    const again = await discover(client, await currentProject(client, projectId));
    expect(again.discovery.discoveryId).not.toBe(reopened.discovery.discoveryId);
    expect(again.discovery.nextAction).toBe('render');
    const active = again.project.activeSource;
    expect(active?.sourceAssetId).not.toBe(sourceId);
    expect((await sourceRow(harness, active?.sourceAssetId as string)).state).toBe('ready');
    await admitsRender(client, projectId);
  }

  it('discovers a confirm place again and binds a new ready source from the new imagery', async () => {
    await rebindsConfirmPlace(await staleAfterRediscovery(PLACES.confirm));
  });

  it('auto-starts a place again on a new ready source from the new imagery', async () => {
    await restartsAutoStartPlace(await staleAfterRediscovery(PLACES.autoStart));
  });

  it('discovers a confirm place again when its last discovery was stored during the run that marked the source stale', async () => {
    await rebindsConfirmPlace(await staleDuringRediscovery(PLACES.confirm));
  });

  it('auto-starts a place again when its last discovery was stored during the run that marked the source stale', async () => {
    await restartsAutoStartPlace(await staleDuringRediscovery(PLACES.autoStart));
  });

  it('discovers a confirm place again when a discovery holding the retired panorama looks newer than the staling', async () => {
    await rebindsConfirmPlace(
      await staleDuringRediscovery(PLACES.confirm, { stampBeforeDiscovery: true }),
    );
  });

  it('auto-starts a place again when a discovery holding the retired panorama looks newer than the staling', async () => {
    await restartsAutoStartPlace(
      await staleDuringRediscovery(PLACES.autoStart, { stampBeforeDiscovery: true }),
    );
  });
});

describe('a tightened Street View use policy reaches existing looks', () => {
  let full: Harness;
  let decorate: Harness;
  let displayOnly: Harness;

  beforeAll(async () => {
    full = await createHarness({ overrides: BASE_OVERRIDES });
    decorate = await createHarness({
      overrides: { ...BASE_OVERRIDES, STREET_VIEW_USE_POLICY: 'decorate' },
    });
    displayOnly = await stubbedHarness(
      { street_view_ai: 'live_public', street_view_display: 'live_public' },
      { STREET_VIEW_USE_POLICY: 'display_only' },
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all([full?.close(), decorate?.close(), displayOnly?.close()]);
  });

  const cases = [
    { name: 'decorate', next: () => decorate, renderStatus: 202 },
    { name: 'display_only', next: () => displayOnly, renderStatus: 409 },
  ] as const;

  for (const { name, next, renderStatus } of cases) {
    it(`full then ${name}: no download or new share, the old link is gone, the frame is deleted, the look stays`, async () => {
      const client = await newClient(full);
      const { project, asset, source } = await renderedLook(full, client);
      const share = await client.post(
        '/v1/shares',
        { renderAssetId: asset.id },
        { 'idempotency-key': randomUUID() },
      );
      expect(share.statusCode).toBe(201);
      const token = json<{ token: string }>(share).token;
      expect((await variantsOf(client, project.projectId))[0]?.downloadUrl).not.toBeNull();
      await full.context.storage.put({
        bucket: 'public',
        key: keys.shared(token, 'after'),
        body: Buffer.from('public copy'),
        contentType: 'image/jpeg',
        provenance: { sourceKind: 'upload' },
      });

      const tightened = next();
      const later = sameBrowser(tightened, client);
      const items = await variantsOf(later, project.projectId);
      expect(items.map((item) => item.renderAssetId)).toContain(asset.id);
      expect(items.find((item) => item.renderAssetId === asset.id)).toMatchObject({
        downloadUrl: null,
        distributable: false,
      });

      const refused = await later.post(
        '/v1/shares',
        { renderAssetId: asset.id },
        { 'idempotency-key': randomUUID() },
      );
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error).toMatchObject({
        details: { reason: 'distribution_not_permitted' },
      });

      const viewed = await later.get(`/v1/shares/${token}`);
      expect(viewed.statusCode).toBe(410);
      expect(json(viewed).error).toMatchObject({
        code: 'SHARE_REVOKED',
        details: { reason: 'revoked' },
      });
      expect(
        await tightened.context.storage.head('public', keys.shared(token, 'after')),
      ).toBeNull();

      const response = await render(later, project.projectId, 1);
      expect(response.statusCode).toBe(renderStatus);
      const after = await sourceRow(tightened, source.id);
      expect(after.objectKey).toBeNull();
      expect(await tightened.context.storage.head('private', source.objectKey!)).toBeNull();
      if (response.statusCode === 202) {
        await later.post(
          `/v1/renders/${json<{ renderJobId: string }>(response).renderJobId}/cancel`,
        );
      } else {
        expect(json(response).error).toMatchObject({ code: 'SOURCE_NOT_EDITABLE' });
      }
      expect(
        (await variantsOf(later, project.projectId)).map((item) => item.renderAssetId),
      ).toContain(asset.id);
    });
  }
});

describe('the daily revalidation applies a tightened use policy to share links', () => {
  let full: Harness;
  let decorate: Harness;

  beforeAll(async () => {
    full = await createHarness({ overrides: BASE_OVERRIDES });
    decorate = await createHarness({
      overrides: { ...BASE_OVERRIDES, STREET_VIEW_USE_POLICY: 'decorate' },
    });
  });

  afterAll(async () => {
    await Promise.all([full?.close(), decorate?.close()]);
  });

  it('revokes a link nobody opened and deletes its public copies; widening does not bring it back', async () => {
    const client = await newClient(full);
    const { asset, source } = await renderedLook(full, client);
    const token = await shareOf(client, asset.id);
    await publishShareCopies(full, token);
    expect(await publicCopies(full, token)).toBe(2);
    await full.context.db
      .updateTable('sourceAssets')
      .set({ revalidatedAt: null })
      .where('id', '=', source.id)
      .execute();

    const result = await runStreetViewRevalidation(decorate.pipeline, {
      sourceAssetIds: [source.id],
    });
    expect(result.sharesRevoked).toBe(1);
    expect(await publicCopies(full, token)).toBe(0);
    const grant = await full.context.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('tokenHash', '=', sha256Hex(token))
      .executeTakeFirstOrThrow();
    expect(grant.revokedAt).not.toBeNull();

    // Widened again: the revoked link stays gone, and the owner can share again.
    const viewed = await sameBrowser(full, client).get(`/v1/shares/${token}`);
    expect(viewed.statusCode).toBe(410);
    expect(json(viewed).error).toMatchObject({ details: { reason: 'revoked' } });
    const renewed = await shareOf(sameBrowser(full, client), asset.id);
    expect((await full.client().get(`/v1/shares/${renewed}`)).statusCode).toBe(200);
  });
});

describe('a share link while the Street View AI capability has no row', () => {
  let harness: Harness;
  let missing = false;

  beforeAll(async () => {
    // A configuration object of its own, so the test can take it out of the local environments.
    harness = await createHarness({
      overrides: BASE_OVERRIDES,
      mapConfig: (config): AppConfig => ({ ...config }),
    });
    const capabilities = harness.context.capabilities;
    const stored = capabilities.state.bind(capabilities);
    vi.spyOn(capabilities, 'state').mockImplementation(async (country, capability) =>
      missing && capability === 'street_view_ai' ? null : stored(country, capability),
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await harness?.close();
  });

  it('answers gone without revoking, and works again once the capability is back', async () => {
    const client = await newClient(harness);
    const { asset } = await renderedLook(harness, client);
    const token = await shareOf(client, asset.id);
    await publishShareCopies(harness, token);
    const viewer = harness.client();
    expect((await viewer.get(`/v1/shares/${token}`)).statusCode).toBe(200);

    const config = harness.server.deps.config as { isLocal: boolean };
    const wasLocal = config.isLocal;
    missing = true;
    config.isLocal = false;
    try {
      const during = await viewer.get(`/v1/shares/${token}`);
      expect(during.statusCode).toBe(410);
      expect(json(during).error).toMatchObject({
        code: 'SHARE_REVOKED',
        details: { reason: 'revoked' },
      });
    } finally {
      missing = false;
      config.isLocal = wasLocal;
    }
    const grant = await harness.context.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('tokenHash', '=', sha256Hex(token))
      .executeTakeFirstOrThrow();
    expect(grant.revokedAt).toBeNull();
    expect(await publicCopies(harness, token)).toBe(2);
    expect((await viewer.get(`/v1/shares/${token}`)).statusCode).toBe(200);
  });
});

describe('a fixture Street View AI capability beside live Street View display', () => {
  const harnesses: Harness[] = [];

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all(harnesses.map((harness) => harness.close()));
  });

  for (const usePolicy of ['full', 'decorate'] as const) {
    it(`under ${usePolicy}, keeps real Google imagery display-only and fixture stand-ins decoratable`, async () => {
      const harness = await stubbedHarness(
        { street_view_ai: 'fixture', street_view_display: 'live_public' },
        { STREET_VIEW_USE_POLICY: usePolicy },
      );
      harnesses.push(harness);
      const streetView = harness.server.deps.providers.fixtures.streetView;
      const discoverCandidates = streetView.discoverCandidates.bind(streetView);
      const spy = vi.spyOn(streetView, 'discoverCandidates').mockImplementation(async (...args) => {
        const result = await discoverCandidates(...args);
        return {
          ...result,
          candidates: result.candidates.map((candidate) => ({
            ...candidate,
            copyright: LIVE_COPYRIGHT,
          })),
        };
      });
      const client = await newClient(harness);
      try {
        const project = await resolve(harness, client, PLACES.autoStart);
        const result = await discover(client, project);
        expect(result.discovery).toMatchObject({
          matchClass: 'confirm',
          sourceMode: 'display_only',
        });
        expect(result.project.activeSource).toBeNull();
      } finally {
        spy.mockRestore();
      }

      // A bound real frame is never admitted for decoration on fixture legs.
      const live = await adoptStreetViewProject(harness, client);
      await harness.context.db
        .updateTable('sourceAssets')
        .set({ copyright: LIVE_COPYRIGHT, isGoogleImagery: true })
        .where('id', '=', live.sourceAssetId)
        .execute();
      const refused = await render(client, live.projectId);
      expect(refused.statusCode).toBe(409);
      expect(json(refused).error).toMatchObject({
        code: 'SOURCE_NOT_EDITABLE',
        details: { reason: 'display_only' },
      });
      expect((await sourceRow(harness, live.sourceAssetId)).state).toBe('ready');

      // A fixture stand-in on the same legs stays decoratable.
      const standIn = await adoptStreetViewProject(harness, client);
      const admitted = await render(client, standIn.projectId);
      expect(admitted.statusCode).toBe(202);
      await client.post(
        `/v1/renders/${json<{ renderJobId: string }>(admitted).renderJobId}/cancel`,
      );
    });
  }
});

describe('a Street View AI capability with no row outside local environments', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ overrides: BASE_OVERRIDES });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('permits no storage, decoration, distribution or commerce adjacency', async () => {
    const policyRow = await harness.context.db
      .insertInto('assetPolicies')
      .values({
        id: newId(),
        subjectKind: 'source_asset',
        subjectId: newId(),
        ...defaultPolicyTemplate('street_view', { attributionText: 'Google Maps' }),
        territory: 'US',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const unseeded = {
      config: { ...harness.config, isLocal: false },
      db: harness.context.db,
      clock: harness.context.clock,
      capabilities: {
        ...harness.context.capabilities,
        state: async (_country: string, capability: string) =>
          capability === 'street_view_display' ? ('live_public' as const) : null,
      },
    };
    const { permission } = await evaluateFor(unseeded, {
      policyId: policyRow.id,
      kind: 'street_view',
      isGoogleImagery: true,
      copyright: 'Fixture photo: stand-in',
      audience: { roles: [] },
    });
    expect(permission).toMatchObject({
      display: true,
      store: false,
      aiProcess: false,
      edit: false,
      distributeDerivative: false,
      commerceAdjacent: false,
    });
    expect(streetViewSourceMode(permission)).toBe('display_only');
  });
});
