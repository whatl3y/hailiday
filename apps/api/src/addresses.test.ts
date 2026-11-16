import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AddressSuggestionsResponseSchema,
  GeocodeResponseSchema,
  ProjectSchema,
  SourceDiscoveryResponseSchema,
  ViewpointResponseSchema,
  type Project,
  type SourceDiscoveryResponse,
} from '@hailiday/core';
import { newId } from '@hailiday/server/ids';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';

const PLACES = {
  autoStart: 'ChIJfxLanternHillColonial01',
  confirm: 'ChIJfxDriftwoodCoveCapeXX15',
  multiUnit: 'ChIJfxWickerLaneApartment21',
  blocked: 'ChIJfxWrenSongRoadColonia23',
  noImagery: 'ChIJfxBitterrootBenchRanc20',
  lowPrecision: 'ChIJfxSourwoodRidgeRoadXX22',
  error: 'ChIJfxAspenHollowErrorXXX24',
  outOfScope: 'ChIJfxThornburyCrescentCA25',
} as const;

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
  await harness.context.db
    .insertInto('blockedAddresses')
    .values({
      id: newId(),
      placeId: PLACES.blocked,
      source: 'homeowner_request',
      evidenceRef: 'test:opt-out',
    })
    .onConflict((oc) => oc.column('placeId').doNothing())
    .execute();
});

afterAll(async () => {
  await harness?.close();
});

async function sessionClient(): Promise<TestClient> {
  const client = harness.client();
  await client.createSession();
  return client;
}

async function resolve(client: TestClient, placeId: string, holidayId = 'christmas') {
  const response = await client.post('/v1/addresses/resolve', {
    placeId,
    sessionToken: await placesTokenForClient(harness, client),
    holidayId,
  });
  return response;
}

async function discover(client: TestClient, project: Project) {
  const response = await client.post(`/v1/projects/${project.id}/source-discovery`, {
    projectVersion: project.projectVersion,
  });
  expect(response.statusCode).toBe(200);
  return SourceDiscoveryResponseSchema.parse(response.json());
}

describe('address entry', () => {
  it('suggests US places with a server-minted session token and enforces the minimum length', async () => {
    const client = await sessionClient();
    const short = await client.get('/v1/addresses/suggestions?q=14');
    expect(short.statusCode).toBe(400);
    const first = await client.get('/v1/addresses/suggestions?q=14%20Lantern');
    expect(first.statusCode).toBe(200);
    const body = AddressSuggestionsResponseSchema.parse(first.json());
    expect(body.suggestions[0]).toMatchObject({ placeId: PLACES.autoStart });
    expect(first.headers['ratelimit']).toBeTruthy();
    const next = await client.get(
      `/v1/addresses/suggestions?q=14%20Lantern%20Hill&sessionToken=${body.sessionToken}`,
    );
    expect(AddressSuggestionsResponseSchema.parse(next.json()).sessionToken).toBe(
      body.sessionToken,
    );

    const resolved = await client.post('/v1/addresses/resolve', {
      placeId: PLACES.autoStart,
      sessionToken: body.sessionToken,
    });
    expect(resolved.statusCode).toBe(201);
    const second = await client.post('/v1/addresses/resolve', {
      placeId: PLACES.autoStart,
      sessionToken: body.sessionToken,
    });
    expect(second.statusCode).toBe(429);
    expect(json(second).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'resolve' },
    });
  });

  it('resolves a place into a project and keeps its Geocoding address for later reads', async () => {
    const client = await sessionClient();
    const response = await resolve(client, PLACES.autoStart);
    expect(response.statusCode).toBe(201);
    const { project } = response.json() as { project: Project };
    ProjectSchema.parse(project);
    expect(project).toMatchObject({ kind: 'address', projectVersion: 0, activeSource: null });
    expect(project.property?.formattedAddress).toContain('Lantern Hill');
    expect(project.property?.precision).toBe('rooftop_equivalent');

    // Time-based deletion is off by default, so the Geocoding address is stored for the gallery.
    const reread = await client.get(`/v1/projects/${project.id}`);
    expect((reread.json() as { project: Project }).project.property?.formattedAddress).toBe(
      '14 Lantern Hill Rd, Maplebrook, VT 05341, USA',
    );
    const ledger = await harness.context.db
      .selectFrom('usageLedger')
      .select(['sku', 'isFixture'])
      .where('projectId', '=', project.id)
      .execute();
    expect(ledger.map((row) => row.sku).sort()).toEqual([
      'geocoding',
      'geocoding_search_destinations',
      'places_details_essentials',
    ]);
    expect(ledger.every((row) => row.isFixture)).toBe(true);
  });

  it('refuses a non-US place without creating a project and counts the address allowance', async () => {
    const client = await sessionClient();
    const outside = await resolve(client, PLACES.outOfScope);
    expect(outside.statusCode).toBe(422);
    expect(json(outside).error).toMatchObject({ code: 'ADDRESS_OUT_OF_SCOPE' });
    for (const placeId of [PLACES.autoStart, PLACES.confirm, PLACES.noImagery]) {
      expect((await resolve(client, placeId)).statusCode).toBe(201);
    }
    const exhausted = await resolve(client, PLACES.multiUnit);
    expect(exhausted.statusCode).toBe(429);
    expect(json(exhausted).error).toMatchObject({
      code: 'ALLOWANCE_EXHAUSTED',
      details: { scope: 'addresses' },
    });
  });

  it('geocodes a manual entry into signed candidates that resolve without a second geocode', async () => {
    const client = await sessionClient();
    const response = await client.post('/v1/addresses/geocode', {
      line1: '4 Driftwood Cove Road',
      city: 'Port Kestrel',
      state: 'ME',
      postalCode: '04462',
    });
    expect(response.statusCode).toBe(200);
    const { candidates } = GeocodeResponseSchema.parse(response.json());
    expect(candidates).toHaveLength(1);
    const resolved = await client.post('/v1/addresses/resolve', {
      candidateId: candidates[0]?.candidateId,
      holidayId: 'christmas',
    });
    expect(resolved.statusCode).toBe(201);
    const { project } = resolved.json() as { project: Project };
    const discovery = await discover(client, project);
    expect(discovery.discovery.entryMethod).toBe('manual');
    expect(discovery.discovery.matchClass).not.toBe('auto_start');

    const other = await sessionClient();
    const stolen = await other.post('/v1/addresses/resolve', {
      candidateId: candidates[0]?.candidateId,
    });
    expect(stolen.statusCode).toBe(400);
  });
});

describe('source discovery', () => {
  it('auto_start binds the primary candidate and returns its source asset', async () => {
    const client = await sessionClient();
    const { project } = (await resolve(client, PLACES.autoStart)).json() as { project: Project };
    const result: SourceDiscoveryResponse = await discover(client, project);
    expect(result.discovery).toMatchObject({
      matchClass: 'auto_start',
      reason: null,
      nextAction: 'render',
      attribution: { logo: 'google_maps', required: true },
    });
    expect(['persist', 'transient']).toContain(result.discovery.sourceMode);
    expect(result.discovery.sourceAssetId).toBe(result.project.activeSource?.sourceAssetId);
    expect(result.project.projectVersion).toBe(1);
    expect(result.project.activeSource).toMatchObject({ kind: 'street_view', state: 'ready' });
    expect(result.project.activeSource?.displayUrl).toContain('/fixture/streetview?');
    const primary = result.discovery.candidates.find((candidate) => candidate.isPrimary);
    expect(primary?.displayUrl).toContain('sig=');
    expect(result.discovery.remainingDisplayLoads).toBe(5);

    const replay = await discover(client, project);
    expect(replay.discovery.discoveryId).toBe(result.discovery.discoveryId);
    const runs = await harness.context.db
      .selectFrom('sourceDiscoveries')
      .select('id')
      .where('projectId', '=', project.id)
      .execute();
    expect(runs).toHaveLength(1);

    const stale = await client.post(`/v1/projects/${project.id}/source-discovery`, {
      projectVersion: 7,
    });
    expect(stale.statusCode).toBe(409);
    expect(json(stale).error).toMatchObject({
      code: 'STALE_PROJECT_VERSION',
      details: { currentProjectVersion: 1 },
    });
    const events = await harness.context.db
      .selectFrom('analyticsEvents')
      .select('eventName')
      .where('eventName', 'in', ['source_discovery_completed', 'source_confirmed'])
      .execute();
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('confirm lists candidates, issues alternate and nudged display URLs, and binds on confirm', async () => {
    const client = await sessionClient();
    const { project } = (await resolve(client, PLACES.confirm)).json() as { project: Project };
    const result = await discover(client, project);
    expect(result.discovery).toMatchObject({ matchClass: 'confirm', nextAction: 'confirm_place' });
    expect(result.discovery.candidates.length).toBeGreaterThan(1);
    expect(result.discovery.sourceAssetId).toBeNull();
    const primary = result.discovery.candidates.find((candidate) => candidate.isPrimary);
    const alternate = result.discovery.candidates.find((candidate) => !candidate.isPrimary);
    expect(primary?.displayUrl).toBeTruthy();
    expect(alternate?.displayUrl).toBeNull();
    expect(result.discovery.remainingDisplayLoads).toBe(5);

    const premature = await client.post(
      '/v1/renders',
      {
        projectId: project.id,
        projectVersion: 0,
        holidayId: 'christmas',
        style: 'classic',
        lightingMode: 'source',
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(premature.statusCode).toBe(409);
    expect(json(premature).error).toMatchObject({ code: 'NEEDS_CONFIRMATION' });

    const alt = await client.put(`/v1/projects/${project.id}/viewpoint`, {
      projectVersion: 0,
      candidateId: alternate?.candidateId,
    });
    expect(alt.statusCode).toBe(200);
    const altBody = ViewpointResponseSchema.parse(alt.json());
    expect(altBody.candidate.displayUrl).toContain('sig=');
    expect(altBody.remainingDisplayLoads).toBe(4);

    const nudged = await client.put(`/v1/projects/${project.id}/viewpoint`, {
      projectVersion: 0,
      candidateId: primary?.candidateId,
      nudge: { headingDelta: -15, fov: 60 },
    });
    expect(nudged.statusCode).toBe(200);
    const nudgedBody = ViewpointResponseSchema.parse(nudged.json());
    expect(nudgedBody.candidate.derivedFromCandidateId).toBe(primary?.candidateId);
    expect(nudgedBody.remainingDisplayLoads).toBe(3);

    const outOfBounds = await client.put(`/v1/projects/${project.id}/viewpoint`, {
      projectVersion: 0,
      candidateId: primary?.candidateId,
      nudge: { headingDelta: 45, fov: 75 },
    });
    expect(outOfBounds.statusCode).toBe(400);

    const bound = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: 0,
      candidateId: nudgedBody.candidate.candidateId,
    });
    expect(bound.statusCode).toBe(200);
    const boundProject = (bound.json() as { project: Project }).project;
    expect(boundProject.projectVersion).toBe(1);
    expect(boundProject.activeSource?.kind).toBe('street_view');
    expect(boundProject.activeSource?.displayUrl).toBe(nudgedBody.candidate.displayUrl);

    const staleBind = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: 0,
      candidateId: primary?.candidateId,
    });
    expect(staleBind.statusCode).toBe(409);
  });

  it('skip_to_upload reports multi-unit, no imagery, low precision and errors, and projects blocked addresses', async () => {
    const expectations: [string, string, boolean][] = [
      [PLACES.multiUnit, 'multi_unit', false],
      [PLACES.noImagery, 'no_imagery', false],
      [PLACES.lowPrecision, 'low_precision', false],
      [PLACES.blocked, 'unavailable', false],
      [PLACES.error, 'error', true],
    ];
    for (const [placeId, reason, retryable] of expectations) {
      const client = await sessionClient();
      const resolved = await resolve(client, placeId);
      expect(resolved.statusCode).toBe(201);
      const { project } = resolved.json() as { project: Project };
      const result = await discover(client, project);
      expect(result.discovery).toMatchObject({
        matchClass: 'skip_to_upload',
        reason,
        retryable,
        nextAction: 'upload_photo',
        candidates: [],
      });
      expect(result.project.discovery?.reason).toBe(reason);
      if (placeId === PLACES.blocked) {
        const stored = await harness.context.db
          .selectFrom('sourceDiscoveries')
          .select('reason')
          .where('projectId', '=', project.id)
          .executeTakeFirstOrThrow();
        expect(stored.reason).toBe('blocked_address');
      }
      const render = await client.post(
        '/v1/renders',
        {
          projectId: project.id,
          projectVersion: 0,
          holidayId: 'christmas',
          style: 'classic',
          lightingMode: 'source',
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(render.statusCode).toBe(409);
      expect(json(render).error).toMatchObject({ code: 'NEEDS_PHOTO' });
    }
  });
});

describe('resolving a place the owner already has', () => {
  /** An existing project at the place with no stored address (made before addresses were kept). */
  async function unlabeledProject(client: TestClient, placeId: string): Promise<Project> {
    const first = await resolve(client, placeId);
    expect(first.statusCode).toBe(201);
    const project = ProjectSchema.parse(json<{ project: unknown }>(first).project);
    await harness.context.db
      .updateTable('properties')
      .set({
        displayAddress: null,
        displayAddressBasis: 'autocomplete_transient',
        displayAddressStoredAt: null,
      })
      .where('id', '=', project.property?.id as string)
      .execute();
    return project;
  }

  it('opens the known project without a label when the label lookup fails', async () => {
    const client = await sessionClient();
    const project = await unlabeledProject(client, PLACES.autoStart);
    const providers = [
      harness.server.deps.providers.address,
      harness.server.deps.providers.fixtures.address,
    ];
    const originals = providers.map((provider) => provider.geocodeByPlaceId);
    let calls = 0;
    for (const provider of providers) {
      provider.geocodeByPlaceId = () => {
        calls += 1;
        return Promise.reject(new Error('geocoding is down'));
      };
    }
    try {
      const again = await resolve(client, PLACES.autoStart);
      expect(again.statusCode).toBe(200);
      const reused = ProjectSchema.parse(json<{ project: unknown }>(again).project);
      expect(reused.id).toBe(project.id);
      expect(reused.property?.formattedAddress).toBeNull();
      expect(calls).toBe(1);
    } finally {
      providers.forEach((provider, index) => {
        provider.geocodeByPlaceId = originals[index] as typeof provider.geocodeByPlaceId;
      });
    }
    // Nothing was charged for the failed lookup.
    const charged = await harness.context.db
      .selectFrom('usageLedger')
      .select('id')
      .where('projectId', '=', project.id)
      .where('sku', '=', 'geocoding')
      .execute();
    expect(charged).toHaveLength(1);
    // With the lookup working again, the label is found and stored.
    const labeled = await resolve(client, PLACES.autoStart);
    expect(
      ProjectSchema.parse(json<{ project: unknown }>(labeled).project).property?.formattedAddress,
    ).toContain('Lantern Hill');
  });

  it("starts a returning visit with the place's display budget as of now", async () => {
    const client = await sessionClient();
    const first = await resolve(client, PLACES.confirm);
    const project = ProjectSchema.parse(json<{ project: unknown }>(first).project);
    const propertyId = project.property?.id as string;
    const spent = (startedAt: Date) =>
      harness.context.db
        .updateTable('properties')
        .set({ displayLoadsIssued: 6, displayLoadsWindowStartedAt: startedAt })
        .where('id', '=', propertyId)
        .execute();
    const stored = () =>
      harness.context.db
        .selectFrom('properties')
        .select('displayLoadsIssued')
        .where('id', '=', propertyId)
        .executeTakeFirstOrThrow();

    await spent(new Date(Date.now() - 60 * 60_000));
    expect((await resolve(client, PLACES.confirm)).statusCode).toBe(200);
    expect(await stored()).toEqual({ displayLoadsIssued: 6 });

    await spent(new Date(Date.now() - 25 * 60 * 60_000));
    expect((await resolve(client, PLACES.confirm)).statusCode).toBe(200);
    expect(await stored()).toEqual({ displayLoadsIssued: 0 });
  });

  it('issues a seventh view at an address a day after the sixth', async () => {
    const client = await sessionClient();
    const { project } = (await resolve(client, PLACES.confirm)).json() as { project: Project };
    const result = await discover(client, project);
    const alternate = result.discovery.candidates.find((candidate) => !candidate.isPrimary);
    expect(alternate).toBeDefined();
    const propertyId = project.property?.id as string;
    const spent = (startedAt: Date) =>
      harness.context.db
        .updateTable('properties')
        .set({ displayLoadsIssued: 6, displayLoadsWindowStartedAt: startedAt })
        .where('id', '=', propertyId)
        .execute();
    const view = () =>
      client.put(`/v1/projects/${project.id}/viewpoint`, {
        projectVersion: 0,
        candidateId: alternate?.candidateId,
      });

    // Six views issued within the last day: the seventh is refused.
    await spent(new Date(Date.now() - 60 * 60_000));
    const refused = await view();
    expect(refused.statusCode).toBe(429);
    expect(json(refused).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'viewpoints' },
    });

    // A day after the window opened, the seventh view is issued and opens a new window.
    await spent(new Date(Date.now() - 24 * 60 * 60_000 - 60_000));
    const issued = await view();
    expect(issued.statusCode).toBe(200);
    expect(ViewpointResponseSchema.parse(issued.json()).remainingDisplayLoads).toBe(5);
    const property = await harness.context.db
      .selectFrom('properties')
      .select(['displayLoadsIssued', 'displayLoadsWindowStartedAt'])
      .where('id', '=', propertyId)
      .executeTakeFirstOrThrow();
    expect(property.displayLoadsIssued).toBe(1);
    expect(Date.now() - (property.displayLoadsWindowStartedAt?.getTime() ?? 0)).toBeLessThan(
      60_000,
    );
  });

  it("reports the place's remaining views as of now wherever a project is read", async () => {
    const client = await sessionClient();
    const { project } = (await resolve(client, PLACES.confirm)).json() as { project: Project };
    const result = await discover(client, project);
    const primary = result.discovery.candidates.find((candidate) => candidate.isPrimary);
    expect(primary).toBeDefined();
    const propertyId = project.property?.id as string;
    const spent = (startedAt: Date) =>
      harness.context.db
        .updateTable('properties')
        .set({ displayLoadsIssued: 6, displayLoadsWindowStartedAt: startedAt })
        .where('id', '=', propertyId)
        .execute();
    // The project read by id, a replay of its discovery and a view already issued: none of them
    // issues a view or opens a window.
    const remaining = async () => {
      const opened = await client.get(`/v1/projects/${project.id}`);
      expect(opened.statusCode).toBe(200);
      const replayed = await discover(client, project);
      const reused = await client.put(`/v1/projects/${project.id}/viewpoint`, {
        projectVersion: 0,
        candidateId: primary?.candidateId,
      });
      expect(reused.statusCode).toBe(200);
      return [
        ProjectSchema.parse(json<{ project: unknown }>(opened).project).discovery
          ?.remainingDisplayLoads,
        replayed.discovery.remainingDisplayLoads,
        ViewpointResponseSchema.parse(reused.json()).remainingDisplayLoads,
      ];
    };

    await spent(new Date(Date.now() - 60 * 60_000));
    expect(await remaining()).toEqual([0, 0, 0]);

    // A day after the window opened, the whole budget is available again.
    await spent(new Date(Date.now() - 24 * 60 * 60_000 - 60_000));
    expect(await remaining()).toEqual([6, 6, 6]);
  });
});
