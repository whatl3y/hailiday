import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProjectSchema,
  SourceDiscoveryResponseSchema,
  VariantListResponseSchema,
  ViewpointResponseSchema,
  type Candidate,
  type Project,
} from '@hailiday/core';
import { factories, sql, toJson } from '@hailiday/server/db';
import { fixturePlace } from '@hailiday/server/pipeline';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';

/** The fixture place whose address resolves to a point on the road. */
const ROAD_PLACE = 'ChIJfxMillpondRoadCapeXXX26';
/** A place with a building outline (its views are aimed at the building). */
const OUTLINED_PLACE = 'ChIJfxDriftwoodCoveCapeXX15';
const BASE_OVERRIDES = { RENDER_QUEUE_DEPTH_MAX: '100000', RENDER_MAX_WAIT_S: '1000000' };

let clientIndex = 0;

async function newClient(harness: Harness): Promise<TestClient> {
  clientIndex += 1;
  const client = harness.client({
    remoteAddress: `10.97.${Math.floor(clientIndex / 200)}.${clientIndex % 200}`,
  });
  await client.createSession();
  return client;
}

async function resolve(harness: Harness, client: TestClient, placeId = ROAD_PLACE) {
  const response = await client.post('/v1/addresses/resolve', {
    placeId,
    sessionToken: await placesTokenForClient(harness, client),
    holidayId: 'christmas',
  });
  expect(response.statusCode).toBe(201);
  return ProjectSchema.parse(json<{ project: unknown }>(response).project);
}

async function discover(client: TestClient, project: Pick<Project, 'id' | 'projectVersion'>) {
  const response = await client.post(`/v1/projects/${project.id}/source-discovery`, {
    projectVersion: project.projectVersion,
  });
  expect(response.statusCode).toBe(200);
  return SourceDiscoveryResponseSchema.parse(response.json());
}

async function bind(client: TestClient, project: Project, candidate: Candidate | undefined) {
  const response = await client.put(`/v1/projects/${project.id}/source`, {
    projectVersion: project.projectVersion,
    candidateId: candidate?.candidateId,
  });
  expect(response.statusCode).toBe(200);
  return ProjectSchema.parse(json<{ project: unknown }>(response).project);
}

function render(client: TestClient, project: Pick<Project, 'id' | 'projectVersion'>) {
  return client.post(
    '/v1/renders',
    {
      projectId: project.id,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
    },
    { 'idempotency-key': randomUUID() },
  );
}

/** The candidate of a discovery by rank. */
const ranked = (candidates: readonly Candidate[], rank: number) =>
  candidates.find((candidate) => candidate.rank === rank && !candidate.derivedFromCandidateId);

describe('an address on the road', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ overrides: BASE_OVERRIDES });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await harness?.close();
  });

  const db = () => harness.context.db;

  async function displayLedgerRows(projectId: string) {
    return db()
      .selectFrom('usageLedger')
      .select('id')
      .where('projectId', '=', projectId)
      .where('sku', '=', 'street_view_static_display')
      .execute();
  }

  async function discoveryRows(projectId: string) {
    return db()
      .selectFrom('sourceDiscoveries')
      .selectAll()
      .where('projectId', '=', projectId)
      .orderBy('projectVersion', 'desc')
      .execute();
  }

  async function loadsIssued(project: Project) {
    const row = await db()
      .selectFrom('properties')
      .innerJoin('projects', 'projects.propertyId', 'properties.id')
      .select(['properties.id', 'properties.displayLoadsIssued'])
      .where('projects.id', '=', project.id)
      .executeTakeFirstOrThrow();
    return row;
  }

  /** Rewrites the project's latest discovery as one made before the on-road test. */
  async function predateRoadViews(projectId: string) {
    const [row] = await discoveryRows(projectId);
    if (!row) throw new Error('no discovery');
    const candidates = row.candidates.map((candidate) => ({
      ...candidate,
      headingMode: 'point',
    }));
    const { road: _road, ...signals } = row.signals as Record<string, unknown>;
    await db()
      .updateTable('sourceDiscoveries')
      .set({
        algorithmVersion: '2',
        candidates: toJson(candidates),
        signals: toJson({ ...signals, headingMode: 'point' }),
      })
      .where('id', '=', row.id)
      .execute();
  }

  async function activeSourceOf(projectId: string) {
    const project = await db()
      .selectFrom('projects')
      .select('activeSourceAssetId')
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    return db()
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', project.activeSourceAssetId as string)
      .executeTakeFirstOrThrow();
  }

  it('is confirmed with both sides of the road shown', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    expect(discovery).toMatchObject({ matchClass: 'confirm', nextAction: 'confirm_place' });
    expect(discovery.candidates).toHaveLength(3);
    expect(discovery.candidates.map(({ headingMode }) => headingMode)).toEqual([
      'road',
      'road',
      'road',
    ]);
    expect(discovery.candidates.map(({ rank, heading }) => [rank, heading])).toEqual([
      [1, 171.3],
      [2, 27.6],
      [3, 109.9],
    ]);
    expect(ranked(discovery.candidates, 1)?.displayUrl).toContain('sig=');
    expect(ranked(discovery.candidates, 2)?.displayUrl).toContain('sig=');
    expect(ranked(discovery.candidates, 3)?.displayUrl).toBeNull();
    expect(discovery.remainingDisplayLoads).toBe(4);
    expect(await displayLedgerRows(project.id)).toHaveLength(2);
    const [row] = await discoveryRows(project.id);
    expect(row?.algorithmVersion).toBe('3');
    expect(row?.signals).toMatchObject({
      headingMode: 'road',
      road: { onRoad: true, trackSource: 'alternates', crossProbes: 4 },
    });
    for (const rank of [1, 2]) {
      const url = ranked(discovery.candidates, rank)?.displayUrl ?? '';
      const frame = await client.get(url.slice(harness.config.publicBaseUrl.length));
      expect(frame.statusCode).toBe(200);
      expect(frame.headers['content-type']).toBe('image/jpeg');
    }
  });

  it('issues the third view and a turned view on request, and binds the turned view as a road view', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    const along = await client.put(`/v1/projects/${project.id}/viewpoint`, {
      projectVersion: 0,
      candidateId: ranked(discovery.candidates, 3)?.candidateId,
    });
    expect(along.statusCode).toBe(200);
    const alongBody = ViewpointResponseSchema.parse(along.json());
    expect(alongBody.candidate.displayUrl).toContain('sig=');
    expect(alongBody.remainingDisplayLoads).toBe(3);

    const turned = await client.put(`/v1/projects/${project.id}/viewpoint`, {
      projectVersion: 0,
      candidateId: ranked(discovery.candidates, 1)?.candidateId,
      nudge: { headingDelta: -15, fov: 90 },
    });
    expect(turned.statusCode).toBe(200);
    const turnedBody = ViewpointResponseSchema.parse(turned.json());
    expect(turnedBody.remainingDisplayLoads).toBe(2);
    expect(turnedBody.candidate).toMatchObject({ headingMode: 'road', heading: 156.3, fov: 90 });

    const bound = await bind(client, project, turnedBody.candidate);
    expect(bound.projectVersion).toBe(1);
    const source = await activeSourceOf(project.id);
    expect(source.viewpoint).toMatchObject({ headingMode: 'road', fov: 90 });
    expect(source.viewpoint?.heading).toBeCloseTo(156.3, 6);
  });

  it('gives the second side view no picture when one load is left', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const property = await loadsIssued(project);
    await db()
      .updateTable('properties')
      .set({ displayLoadsIssued: 5, displayLoadsWindowStartedAt: new Date() })
      .where('id', '=', property.id)
      .execute();
    const { discovery } = await discover(client, project);
    expect(ranked(discovery.candidates, 1)?.displayUrl).toContain('sig=');
    expect(ranked(discovery.candidates, 2)?.displayUrl).toBeNull();
    expect(discovery.remainingDisplayLoads).toBe(0);
    expect(await displayLedgerRows(project.id)).toHaveLength(1);
  });

  it('runs a discovery made before the road test again while the place has no look', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const first = await discover(client, project);
    await predateRoadViews(project.id);
    const again = await discover(client, project);
    expect(again.discovery.discoveryId).not.toBe(first.discovery.discoveryId);
    const rows = await discoveryRows(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.algorithmVersion).toBe('3');
    expect(again.discovery.candidates.map(({ headingMode }) => headingMode)).toEqual([
      'road',
      'road',
      'road',
    ]);
    // The loads of the dropped discovery stay counted.
    expect((await loadsIssued(project)).displayLoadsIssued).toBe(4);
    expect(again.discovery.remainingDisplayLoads).toBe(2);
  });

  it('replays a discovery made before the road test whose primary was aimed at the building', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, OUTLINED_PLACE);
    const first = await discover(client, project);
    expect(first.discovery.candidates[0]?.headingMode).toBe('geometry');
    await db()
      .updateTable('sourceDiscoveries')
      .set({ algorithmVersion: '2' })
      .where('projectId', '=', project.id)
      .execute();
    const ledger = await displayLedgerRows(project.id);
    const again = await discover(client, project);
    expect(again.discovery.discoveryId).toBe(first.discovery.discoveryId);
    expect(await displayLedgerRows(project.id)).toHaveLength(ledger.length);
  });

  it('replays a discovery made before the road test when the place has a look', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    const bound = await bind(client, project, ranked(discovery.candidates, 1));
    const queued = await render(client, bound);
    expect(queued.statusCode).toBe(202);
    expect(await harness.completeRender(json<{ renderJobId: string }>(queued).renderJobId)).toBe(
      'succeeded',
    );
    const current = await discover(client, bound);
    await predateRoadViews(project.id);
    const ledger = await displayLedgerRows(project.id);
    const again = await discover(client, bound);
    expect(again.discovery.discoveryId).toBe(current.discovery.discoveryId);
    expect(await displayLedgerRows(project.id)).toHaveLength(ledger.length);
  });

  it('confirms a view confirmed before the road test again instead of decorating it', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    const bound = await bind(client, project, ranked(discovery.candidates, 1));
    const source = await activeSourceOf(project.id);
    await db()
      .updateTable('sourceAssets')
      .set({
        viewpoint: sql<string>`viewpoint || ${JSON.stringify({ heading: 109.9, pitch: 10, headingMode: 'point' })}::jsonb`,
      })
      .where('id', '=', source.id)
      .execute();
    await predateRoadViews(project.id);

    const refused = await render(client, bound);
    expect(refused.statusCode).toBe(409);
    expect(json(refused).error).toMatchObject({
      code: 'NEEDS_CONFIRMATION',
      details: { candidateCount: 3 },
    });
    const jobs = () =>
      db().selectFrom('renderJobs').select('id').where('projectId', '=', project.id).execute();
    expect(await jobs()).toHaveLength(0);

    // The place is now known to be on the road: the old view is still not decorated.
    const fresh = await discover(client, bound);
    expect(fresh.discovery.candidates.map(({ headingMode }) => headingMode)).toEqual([
      'road',
      'road',
      'road',
    ]);
    const stillRefused = await render(client, bound);
    expect(stillRefused.statusCode).toBe(409);
    expect(json(stillRefused).error).toMatchObject({ code: 'NEEDS_CONFIRMATION' });
    expect(await jobs()).toHaveLength(0);

    const rebound = await bind(client, bound, ranked(fresh.discovery.candidates, 1));
    const newSource = await activeSourceOf(project.id);
    expect(newSource.id).not.toBe(source.id);
    expect(newSource.viewpoint?.headingMode).toBe('road');
    expect((await render(client, rebound)).statusCode).toBe(202);
  });

  it('leaves a view confirmed before the road test alone while a look is made or once one exists', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    const bound = await bind(client, project, ranked(discovery.candidates, 1));
    const source = await activeSourceOf(project.id);
    await db()
      .updateTable('sourceAssets')
      .set({
        viewpoint: sql<string>`jsonb_set(viewpoint, '{headingMode}', to_jsonb('point'::text))`,
      })
      .where('id', '=', source.id)
      .execute();
    await predateRoadViews(project.id);
    expect((await render(client, bound)).statusCode).toBe(409);

    // Another look of the project is being made: the request joins the ordinary path.
    await factories.renderJob(db(), {
      ownerId: source.ownerId,
      projectId: project.id,
      sourceAssetId: source.id,
      state: 'rendering',
    });
    const queued = await render(client, bound);
    expect(queued.statusCode).toBe(202);
    expect(await harness.completeRender(json<{ renderJobId: string }>(queued).renderJobId)).toBe(
      'succeeded',
    );

    // The project has a look made from that view: another look is made from it as well.
    const another = await client.post(
      '/v1/renders',
      {
        projectId: project.id,
        projectVersion: bound.projectVersion,
        holidayId: 'halloween',
        style: 'classic',
        lightingMode: 'source',
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(another.statusCode).toBe(202);
  });

  it('decorates a turned road view', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    const turned = await client.put(`/v1/projects/${project.id}/viewpoint`, {
      projectVersion: 0,
      candidateId: ranked(discovery.candidates, 1)?.candidateId,
      nudge: { headingDelta: -15, fov: 90 },
    });
    expect(turned.statusCode).toBe(200);
    const candidate = ViewpointResponseSchema.parse(turned.json()).candidate;
    expect(candidate).toMatchObject({ headingMode: 'road', heading: 156.3 });
    const bound = await bind(client, project, candidate);
    const queued = await render(client, bound);
    expect(queued.statusCode).toBe(202);
    expect(await harness.completeRender(json<{ renderJobId: string }>(queued).renderJobId)).toBe(
      'succeeded',
    );
    const variants = VariantListResponseSchema.parse(
      (await client.get(`/v1/projects/${project.id}/variants`)).json(),
    );
    expect(variants.items).toHaveLength(1);
  });

  it('sets the mode of a source bound again to the candidate’s', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    const bound = await bind(client, project, ranked(discovery.candidates, 1));
    const source = await activeSourceOf(project.id);
    // The same view, recorded as aimed at the point.
    await db()
      .updateTable('sourceAssets')
      .set({
        viewpoint: sql<string>`jsonb_set(viewpoint, '{headingMode}', to_jsonb('point'::text))`,
      })
      .where('id', '=', source.id)
      .execute();
    const again = await discover(client, bound);
    expect(ranked(again.discovery.candidates, 1)?.heading).toBe(171.3);
    const rebound = await bind(client, bound, ranked(again.discovery.candidates, 1));
    const reused = await activeSourceOf(project.id);
    expect(reused.id).toBe(source.id);
    expect(reused.viewpoint?.headingMode).toBe('road');
    expect((await render(client, rebound)).statusCode).toBe(202);
  });

  it('decorates a view aimed at the point when the current discovery offers it', async () => {
    const provider = harness.server.deps.providers.fixtures.streetView;
    const discoverCandidates = provider.discoverCandidates.bind(provider);
    vi.spyOn(provider, 'discoverCandidates').mockImplementation(async (input, options) => {
      const result = await discoverCandidates(input, options);
      return {
        ...result,
        candidates: result.candidates.map((candidate) => ({
          ...candidate,
          headingMode: 'point' as const,
        })),
        road: result.road ? { ...result.road, onRoad: false } : null,
      };
    });
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    expect(discovery.candidates[0]?.headingMode).toBe('point');
    // A current discovery aimed at the point is replayed as any other.
    expect((await discover(client, project)).discovery.discoveryId).toBe(discovery.discoveryId);
    const bound = await bind(client, project, ranked(discovery.candidates, 1));
    expect((await activeSourceOf(project.id)).viewpoint?.headingMode).toBe('point');
    const queued = await render(client, bound);
    expect(queued.statusCode).toBe(202);
  });
});

describe('an address on the road whose imagery may only be shown', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      overrides: { ...BASE_OVERRIDES, STREET_VIEW_CONTRIBUTOR_IMAGERY: 'display_only' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('issues one view at discovery', async () => {
    const contributor = fixturePlace('ChIJfxPinonMesaAdobeXXXXX17').panoramas[0];
    const provider = harness.server.deps.providers.fixtures.streetView;
    const discoverCandidates = provider.discoverCandidates.bind(provider);
    vi.spyOn(provider, 'discoverCandidates').mockImplementation(async (input, options) => {
      const result = await discoverCandidates(input, options);
      return {
        ...result,
        candidates: result.candidates.map((candidate) => ({
          ...candidate,
          copyright: contributor?.copyright ?? null,
          isGoogleImagery: false,
        })),
      };
    });
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const { discovery } = await discover(client, project);
    expect(discovery.sourceMode).toBe('display_only');
    expect(discovery.candidates.map(({ headingMode }) => headingMode)).toEqual([
      'road',
      'road',
      'road',
    ]);
    expect(ranked(discovery.candidates, 1)?.displayUrl).toContain('sig=');
    expect(ranked(discovery.candidates, 2)?.displayUrl).toBeNull();
    expect(discovery.remainingDisplayLoads).toBe(5);
    const ledger = await harness.context.db
      .selectFrom('usageLedger')
      .select('id')
      .where('projectId', '=', project.id)
      .where('sku', '=', 'street_view_static_display')
      .execute();
    expect(ledger).toHaveLength(1);
  });
});
