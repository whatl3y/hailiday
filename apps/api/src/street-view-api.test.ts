import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProductsPanelSchema,
  ProjectSchema,
  SourceDiscoveryResponseSchema,
  type Project,
} from '@hailiday/core';
import type { AppConfig } from '@hailiday/server/config';
import { newId } from '@hailiday/server/ids';
import { isPlaceBlocked } from '@hailiday/server/policy';
import { createHarness, json, OPERATOR_EMAIL, TestClient, type Harness } from './test/harness.js';
import { operatorClient } from './test/operator.js';
import { placesTokenForClient } from './test/places-token.js';
import { adoptStreetViewProject } from './test/projects.js';

const PLACES = { confirm: 'ChIJfxDriftwoodCoveCapeXX15' } as const;
const DAY_MS = 86_400_000;
const BASE_OVERRIDES = { RENDER_QUEUE_DEPTH_MAX: '100000', RENDER_MAX_WAIT_S: '1000000' };

let clientIndex = 0;

/**
 * A harness whose API sees the given capability states (this server only) and, unless
 * `liveImagery` is false, live Street View imagery in its configuration; every adapter stays a
 * fixture.
 */
async function stubbedHarness(
  states: Record<string, string>,
  overrides: Record<string, string> = {},
  liveImagery = true,
): Promise<Harness> {
  const harness = await createHarness({
    overrides: { ...BASE_OVERRIDES, ...overrides },
    ...(liveImagery
      ? {
          mapConfig: (config: AppConfig): AppConfig => ({
            ...config,
            providers: { ...config.providers, streetView: 'google', imageEditor: 'openai' },
          }),
        }
      : {}),
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

async function newClient(harness: Harness): Promise<TestClient> {
  clientIndex += 1;
  const client = harness.client({
    remoteAddress: `10.74.${Math.floor(clientIndex / 200)}.${clientIndex % 200}`,
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

/**
 * Gives a project's property a place ID of its own (so no other test shares it) and returns the
 * property's ID and that place ID.
 */
async function ownPlaceOf(harness: Harness, projectId: string) {
  const db = harness.context.db;
  const project = await db
    .selectFrom('projects')
    .select('propertyId')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  const placeId = uniquePlaceId('Own');
  await db
    .updateTable('properties')
    .set({ placeId })
    .where('id', '=', project.propertyId!)
    .execute();
  return { propertyId: project.propertyId!, placeId };
}

/** A Street View project in `persist` mode with one delivered look and a stored frame. */
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
  const source = await harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', project.sourceAssetId)
    .executeTakeFirstOrThrow();
  expect(source.objectKey).not.toBeNull();
  return { project, renderJobId, asset, source };
}

type BeforeImage = { beforeImageUrl: string | null };

async function galleryItem(client: TestClient, renderAssetId: string) {
  const response = await client.get('/v1/gallery?limit=100');
  expect(response.statusCode).toBe(200);
  const items = json<{ items: (BeforeImage & { id: string })[] }>(response).items;
  return items.find((item) => item.id === renderAssetId);
}

async function variantItem(client: TestClient, projectId: string, renderAssetId: string) {
  const response = await client.get(`/v1/projects/${projectId}/variants`);
  expect(response.statusCode).toBe(200);
  const items = json<{ items: (BeforeImage & { renderAssetId: string })[] }>(response).items;
  return items.find((item) => item.renderAssetId === renderAssetId);
}

function uniquePlaceId(label: string): string {
  return `ChIJsvApi${label}${newId().replace(/-/g, '')}`;
}

/** Lists a place on the opt-out list with a block that expired yesterday. */
async function expiredBlock(harness: Harness, placeId: string): Promise<void> {
  await harness.context.db
    .insertInto('blockedAddresses')
    .values({
      id: newId(),
      placeId,
      source: 'operator',
      evidenceRef: 'test:expired',
      expiresAt: new Date(Date.now() - DAY_MS),
    })
    .execute();
}

describe('blocking a place again after its earlier block expired', () => {
  let harness: Harness;
  let operator: TestClient;
  let csrf: string;

  beforeAll(async () => {
    harness = await createHarness({ overrides: BASE_OVERRIDES });
    ({ client: operator, csrf } = await operatorClient(harness));
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('a homeowner opt-out actioned in triage blocks the place with no expiry', async () => {
    const placeId = uniquePlaceId('Triage');
    await expiredBlock(harness, placeId);
    expect(await isPlaceBlocked(harness.context.db, placeId, new Date())).toBe(false);
    const reportId = newId();
    await harness.context.db
      .insertInto('reports')
      .values({
        id: reportId,
        targetKind: 'address',
        targetPlaceId: placeId,
        reason: 'this_is_my_home',
        reporterContactEmail: 'homeowner@example.com',
        details: 'opt-out',
      })
      .execute();

    const triaged = await operator.post(
      `/internal/v1/reports/${reportId}/triage`,
      { status: 'actioned', resolution: { action: 'block_address' } },
      { 'x-csrf-token': csrf },
    );
    expect(triaged.statusCode).toBe(200);
    expect(await isPlaceBlocked(harness.context.db, placeId, new Date())).toBe(true);
    const row = await harness.context.db
      .selectFrom('blockedAddresses')
      .select(['expiresAt', 'removedAt', 'reportId', 'source', 'evidenceRef', 'createdBy'])
      .where('placeId', '=', placeId)
      .executeTakeFirstOrThrow();
    const operatorUser = await harness.context.db
      .selectFrom('users')
      .select('id')
      .where('emailNormalized', '=', OPERATOR_EMAIL.toLowerCase())
      .executeTakeFirstOrThrow();
    // The earlier operator block's source, evidence and author are replaced by this request's.
    expect(row).toEqual({
      expiresAt: null,
      removedAt: null,
      reportId,
      source: 'homeowner_request',
      evidenceRef: `report:${reportId}`,
      createdBy: operatorUser.id,
    });
  });

  it('an operator block takes the expiry of the new request, or none', async () => {
    const placeId = uniquePlaceId('Operator');
    await expiredBlock(harness, placeId);
    const block = (expiresAt?: string) =>
      operator.post(
        '/internal/v1/blocked-addresses',
        {
          placeId,
          source: 'operator',
          evidenceRef: 'test:again',
          ...(expiresAt ? { expiresAt } : {}),
        },
        { 'x-csrf-token': csrf },
      );

    const withoutExpiry = await block();
    expect(withoutExpiry.statusCode).toBe(201);
    expect(await isPlaceBlocked(harness.context.db, placeId, new Date())).toBe(true);
    const row = await harness.context.db
      .selectFrom('blockedAddresses')
      .select('expiresAt')
      .where('placeId', '=', placeId)
      .executeTakeFirstOrThrow();
    expect(row.expiresAt).toBeNull();

    const until = new Date(Date.now() + 7 * DAY_MS);
    const withExpiry = await block(until.toISOString());
    expect(withExpiry.statusCode).toBe(201);
    expect(json<{ id: string }>(withExpiry).id).toBe(json<{ id: string }>(withoutExpiry).id);
    const updated = await harness.context.db
      .selectFrom('blockedAddresses')
      .select('expiresAt')
      .where('placeId', '=', placeId)
      .executeTakeFirstOrThrow();
    expect(updated.expiresAt?.getTime()).toBe(until.getTime());
    expect(await isPlaceBlocked(harness.context.db, placeId, new Date())).toBe(true);
  });
});

describe('a stored Street View frame after the use policy is tightened', () => {
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

  it('is no longer served as the before image by the gallery or the variants list', async () => {
    const client = await newClient(full);
    const { project, asset, source } = await renderedLook(full, client);
    expect((await galleryItem(client, asset.id))?.beforeImageUrl).toContain('/originals/');
    expect((await variantItem(client, project.projectId, asset.id))?.beforeImageUrl).toContain(
      '/originals/',
    );

    const later = sameBrowser(decorate, client);
    const gallery = await galleryItem(later, asset.id);
    expect(gallery).toBeDefined();
    expect(gallery?.beforeImageUrl).toBeNull();
    const variant = await variantItem(later, project.projectId, asset.id);
    expect(variant).toBeDefined();
    expect(variant?.beforeImageUrl).not.toBeNull();
    expect(variant?.beforeImageUrl).not.toContain('/originals/');
    // Hiding the frame deletes nothing: admission or revalidation removes it.
    expect(await decorate.context.storage.head('private', source.objectKey!)).not.toBeNull();
  });
});

describe('choosing or nudging a view of a place blocked after its discovery', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ overrides: BASE_OVERRIDES });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('answers NO_STREET_VIEW and issues and charges no display load', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const found = await discover(client, project);
    expect(found.discovery.matchClass).toBe('confirm');
    const primary = found.discovery.candidates.find((candidate) => candidate.isPrimary);
    const alternate = found.discovery.candidates.find((candidate) => !candidate.isPrimary);
    expect(alternate).toBeDefined();
    const { propertyId, placeId } = await ownPlaceOf(harness, project.id);
    const issued = async () =>
      (
        await harness.context.db
          .selectFrom('properties')
          .select('displayLoadsIssued')
          .where('id', '=', propertyId)
          .executeTakeFirstOrThrow()
      ).displayLoadsIssued;
    const charged = async () =>
      (
        await harness.context.db
          .selectFrom('usageLedger')
          .select('id')
          .where('projectId', '=', project.id)
          .where('sku', '=', 'street_view_static_display')
          .execute()
      ).length;
    const issuedBefore = await issued();
    const chargedBefore = await charged();
    await harness.context.db
      .insertInto('blockedAddresses')
      .values({ id: newId(), placeId, source: 'homeowner_request', evidenceRef: 'test:opt-out' })
      .execute();

    for (const body of [
      { candidateId: alternate?.candidateId },
      { candidateId: primary?.candidateId, nudge: { headingDelta: -15, fov: 60 } },
    ]) {
      const response = await client.put(`/v1/projects/${project.id}/viewpoint`, {
        projectVersion: found.project.projectVersion,
        ...body,
      });
      expect(response.statusCode).toBe(404);
      expect(json(response).error).toMatchObject({ code: 'NO_STREET_VIEW' });
    }
    expect(await issued()).toBe(issuedBefore);
    expect(await charged()).toBe(chargedBefore);
  });
});

describe('Shop the look of a Street View look', () => {
  let full: Harness;
  let decorate: Harness;
  let fixtureDisplayOnly: Harness;

  beforeAll(async () => {
    full = await createHarness({ overrides: BASE_OVERRIDES });
    decorate = await createHarness({
      overrides: { ...BASE_OVERRIDES, STREET_VIEW_USE_POLICY: 'decorate' },
    });
    fixtureDisplayOnly = await stubbedHarness(
      { street_view_ai: 'fixture' },
      { STREET_VIEW_USE_POLICY: 'display_only' },
      false,
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await Promise.all([full?.close(), decorate?.close(), fixtureDisplayOnly?.close()]);
  });

  const panelOf = async (client: TestClient, renderJobId: string) => {
    const response = await client.get(`/v1/renders/${renderJobId}/products`);
    expect(response.statusCode).toBe(200);
    return ProductsPanelSchema.parse(response.json()).panelState;
  };

  it('is hidden on the first request after the policy is tightened to decorate', async () => {
    const client = await newClient(full);
    const { renderJobId } = await renderedLook(full, client);
    expect(await panelOf(client, renderJobId)).not.toBe('hidden');
    expect(await panelOf(sameBrowser(decorate, client), renderJobId)).toBe('hidden');
  });

  it('treats a fixture stand-in as fixture imagery under a fixture capability and display_only', async () => {
    const client = await newClient(full);
    const { renderJobId } = await renderedLook(full, client);
    expect(await panelOf(sameBrowser(fixtureDisplayOnly, client), renderJobId)).not.toBe('hidden');
  });
});

describe('parallel viewpoint requests', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      overrides: { ...BASE_OVERRIDES, RATE_STATIC_DISPLAY_LOADS_PER_ADDRESS: '20' },
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  /** A discovered place of its own with an empty display budget. */
  async function discovered() {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const found = await discover(client, project);
    const primary = found.discovery.candidates.find((candidate) => candidate.isPrimary);
    expect(primary).toBeDefined();
    const { propertyId } = await ownPlaceOf(harness, project.id);
    await harness.context.db
      .updateTable('properties')
      .set({ displayLoadsIssued: 0, displayLoadsWindowStartedAt: null })
      .where('id', '=', propertyId)
      .execute();
    const stored = async () => {
      const discovery = await harness.context.db
        .selectFrom('sourceDiscoveries')
        .select('candidates')
        .where('id', '=', found.discovery.discoveryId)
        .executeTakeFirstOrThrow();
      const property = await harness.context.db
        .selectFrom('properties')
        .select('displayLoadsIssued')
        .where('id', '=', propertyId)
        .executeTakeFirstOrThrow();
      const charges = await harness.context.db
        .selectFrom('usageLedger')
        .select('id')
        .where('projectId', '=', project.id)
        .where('sku', '=', 'street_view_static_display')
        .where('kind', '=', 'charge')
        .execute();
      return {
        candidates: discovery.candidates as { candidateId: string }[],
        issued: property.displayLoadsIssued,
        charges: charges.length,
      };
    };
    const nudge = (headingDelta: number, fov: number) =>
      client.put(`/v1/projects/${project.id}/viewpoint`, {
        projectVersion: found.project.projectVersion,
        candidateId: primary?.candidateId,
        nudge: { headingDelta, fov },
      });
    return { client, project, found, primary: primary!, stored, nudge };
  }

  it('keeps every candidate issued by six parallel distinct nudges', async () => {
    const { client, project, found, stored, nudge } = await discovered();
    const before = await stored();
    const views = [
      [-30, 60],
      [-15, 60],
      [15, 60],
      [30, 60],
      [-15, 75],
      [15, 75],
    ] as const;
    const responses = await Promise.all(views.map(([delta, fov]) => nudge(delta, fov)));
    for (const response of responses) expect(response.statusCode).toBe(200);
    const issuedIds = responses.map(
      (response) => json<{ candidate: { candidateId: string } }>(response).candidate.candidateId,
    );
    expect(new Set(issuedIds).size).toBe(6);

    const after = await stored();
    expect(after.candidates).toHaveLength(before.candidates.length + 6);
    expect(after.issued).toBe(before.issued + 6);
    expect(after.charges).toBe(before.charges + 6);
    // Every issued candidate can be bound.
    for (const candidateId of issuedIds) {
      expect(after.candidates.map((candidate) => candidate.candidateId)).toContain(candidateId);
    }
    const bound = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: found.project.projectVersion,
      candidateId: issuedIds[0],
    });
    expect(bound.statusCode).toBe(200);
  });

  it('issues and charges one display load for six parallel requests of the same view', async () => {
    const { stored, nudge } = await discovered();
    const before = await stored();
    const responses = await Promise.all(Array.from({ length: 6 }, () => nudge(-15, 90)));
    for (const response of responses) expect(response.statusCode).toBe(200);
    const ids = new Set(
      responses.map(
        (response) => json<{ candidate: { candidateId: string } }>(response).candidate.candidateId,
      ),
    );
    expect(ids.size).toBe(1);
    const after = await stored();
    expect(after.candidates).toHaveLength(before.candidates.length + 1);
    expect(after.issued).toBe(before.issued + 1);
    expect(after.charges).toBe(before.charges + 1);
  });
});

describe('parallel re-confirmations of a bound view on a small connection pool', () => {
  const POOL = 2;
  let harness: Harness;

  beforeAll(async () => {
    // No settings or capability cache (the harness default), so every capability read is a query.
    harness = await createHarness({
      overrides: { ...BASE_OVERRIDES, DATABASE_POOL_MAX: String(POOL) },
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('all complete when more requests than connections bind at once', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const found = await discover(client, project);
    const primary = found.discovery.candidates.find((candidate) => candidate.isPrimary);
    const first = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: found.project.projectVersion,
      candidateId: primary?.candidateId,
    });
    expect(first.statusCode).toBe(200);
    const bound = ProjectSchema.parse(json<{ project: unknown }>(first).project);
    expect(bound.activeSource).not.toBeNull();

    const requests = Array.from({ length: POOL * 4 }, () =>
      client.put(`/v1/projects/${project.id}/source`, {
        projectVersion: bound.projectVersion,
        candidateId: primary?.candidateId,
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      Promise.all(requests).then((responses) => responses.map((r) => r.statusCode)),
      new Promise<'stalled'>((resolve) => {
        timer = setTimeout(() => resolve('stalled'), 20_000);
      }),
    ]);
    clearTimeout(timer);
    expect(outcome).toEqual(Array.from({ length: POOL * 4 }, () => 200));
    const current = await currentProject(client, project.id);
    expect(current.activeSource?.sourceAssetId).toBe(bound.activeSource?.sourceAssetId);
  });
});

describe('parallel first confirmations of the same view', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ overrides: BASE_OVERRIDES });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await harness?.close();
  });

  /**
   * Holds every metadata recheck of the bind until `count` requests have made one, so the
   * requests reach their bind transactions together.
   */
  function barrierOnRecheck(count: number) {
    const streetView = harness.server.deps.providers.fixtures.streetView;
    const metadataByPano = streetView.metadataByPano.bind(streetView);
    let waiting: (() => void)[] = [];
    return vi.spyOn(streetView, 'metadataByPano').mockImplementation(async (panoId, options) => {
      await new Promise<void>((release) => {
        waiting.push(release);
        if (waiting.length >= count) {
          for (const next of waiting) next();
          waiting = [];
        }
      });
      return metadataByPano(panoId, options);
    });
  }

  it('answer 200, and 200 or 409, never 500, and bind one source', async () => {
    const spy = barrierOnRecheck(2);
    try {
      for (let round = 0; round < 6; round += 1) {
        const client = await newClient(harness);
        const project = await resolve(harness, client, PLACES.confirm);
        const found = await discover(client, project);
        const primary = found.discovery.candidates.find((candidate) => candidate.isPrimary);
        const responses = await Promise.all(
          [0, 1].map(() =>
            client.put(`/v1/projects/${project.id}/source`, {
              projectVersion: found.project.projectVersion,
              candidateId: primary?.candidateId,
            }),
          ),
        );
        const statuses = responses.map((response) => response.statusCode);
        expect(statuses).toContain(200);
        for (const response of responses) {
          if (response.statusCode === 200) continue;
          expect(response.statusCode).toBe(409);
          expect(json(response).error).toMatchObject({ code: 'STALE_PROJECT_VERSION' });
        }
        const sources = await harness.context.db
          .selectFrom('sourceAssets')
          .select('id')
          .where('projectId', '=', project.id)
          .where('kind', '=', 'street_view')
          .execute();
        expect(sources).toHaveLength(1);
        const current = await currentProject(client, project.id);
        expect(current.activeSource?.sourceAssetId).toBe(sources[0]?.id);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
