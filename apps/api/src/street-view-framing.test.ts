import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderStatusSchema, type Project } from '@hailiday/core';
import { ANONYMOUS_AUDIENCE } from '@hailiday/server/capabilities';
import { runRenderJob } from '@hailiday/server/pipeline';
import { framedViewOf } from '@hailiday/server/providers';
import { bindCandidate, type StoredCandidate } from './domain/discovery.js';
import { framedDisplayUrlOf, streetViewCapabilityStates } from './domain/sources.js';
import type { ApiDeps } from './deps.js';
import { createHarness, json, type Harness } from './test/harness.js';
import { adoptStreetViewProject } from './test/projects.js';

/** A fixture place whose wide frame shows its home small enough to zoom in on. */
const FRAMED_PLACE = 'ChIJfxOldQuarryRoadColoni19';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      SESSION_SECRET: 'street-view-framing-test-secret-0123456789abc',
      STREET_VIEW_FRAMING: 'on',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
  });
});

afterAll(async () => {
  await harness?.close();
});

/** The project's display loads ledgered so far (`street_view_static_display` lines). */
async function displayLines(projectId: string): Promise<number> {
  const rows = await harness.context.db
    .selectFrom('usageLedger')
    .select('id')
    .where('projectId', '=', projectId)
    .where('sku', '=', 'street_view_static_display')
    .execute();
  return rows.length;
}

/** Renders a project's first look, streaming its status; returns the stage labels seen. */
async function firstLook(
  client: ReturnType<Harness['client']>,
  project: { projectId: string; projectVersion: number },
): Promise<(string | null)[]> {
  const response = await client.post(
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
  expect(response.statusCode).toBe(202);
  const jobId = json<{ renderJobId: string }>(response).renderJobId;

  // The locate answer is held back briefly so the stream sees the step's own label.
  const inner = harness.pipeline.providers.fixtures.vision;
  const vision = {
    ...inner,
    async locateHome(...args: Parameters<typeof inner.locateHome>) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return inner.locateHome(...args);
    },
  };
  const pipeline = {
    ...harness.pipeline,
    providers: {
      ...harness.pipeline.providers,
      fixtures: { ...harness.pipeline.providers.fixtures, vision },
    },
  };
  const streaming = client.get(`/v1/renders/${jobId}/events`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect((await runRenderJob(pipeline, { renderJobId: jobId })).state).toBe('succeeded');
  const stream = await streaming;
  return [...stream.body.matchAll(/id: (\d+)\nevent: render\ndata: (.*)\n\n/g)]
    .map((match) => RenderStatusSchema.parse(JSON.parse(match[2] ?? '{}')).stageLabelKey)
    .filter((label, i, all) => label !== all[i - 1]);
}

describe('an address render zooms in on the home at its first look', () => {
  it('labels the step, frames the source, shows the stored framed frame and keeps the candidate', async () => {
    const client = harness.client({ remoteAddress: '10.63.0.1' });
    await client.createSession();
    const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'persist');
    const db = harness.context.db;
    const before = await db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', project.sourceAssetId)
      .executeTakeFirstOrThrow();
    const readProject = async () =>
      json<{ project: Project }>(await client.get(`/v1/projects/${project.projectId}`)).project;
    const candidateUrl = (await readProject()).activeSource?.displayUrl;
    expect(candidateUrl).toContain('/fixture/streetview?');
    const linesBefore = await displayLines(project.projectId);

    const labels = await firstLook(client, project);
    expect(labels).toContain('stage.framing');
    // The analysis runs after the framing, under the planning label.
    expect(labels.indexOf('stage.framing')).toBeLessThan(labels.indexOf('stage.planning'));

    const after = await db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', project.sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(after.viewpoint?.framing?.status).toBe('framed');
    expect(after.viewpointKey).toBe(before.viewpointKey);
    expect(after.objectKey).not.toBeNull();

    // The project's picture is the stored framed frame, not a display URL of the provider, so
    // no display load is ledgered for it.
    const shown = (await readProject()).activeSource?.displayUrl;
    expect(shown).toBeTruthy();
    expect(shown).not.toBe(candidateUrl);
    expect(shown).not.toContain('/fixture/streetview?');
    expect(shown).toContain(after.objectKey!);
    expect(await displayLines(project.projectId)).toBe(linesBefore);

    // Confirming the candidate's view again binds the same source.
    const viewpoint = before.viewpoint!;
    const candidate: StoredCandidate = {
      candidateId: randomUUID(),
      derivedFromCandidateId: null,
      isPrimary: true,
      rank: 1,
      panoId: viewpoint.panoId,
      heading: viewpoint.heading,
      headingMode: viewpoint.headingMode,
      pitch: viewpoint.pitch,
      fov: viewpoint.fov,
      width: viewpoint.width,
      height: viewpoint.height,
      distanceMeters: 10,
      captureDate: before.captureDate,
      captureGranularity: viewpoint.captureGranularity,
      copyright: before.copyright,
      isGoogleImagery: before.isGoogleImagery ?? false,
      estimatedFacadePx: null,
      flags: [],
      displayUrlIssuedAt: null,
    };
    const deps = harness.server.deps;
    const capabilities = await streetViewCapabilityStates(deps, ANONYMOUS_AUDIENCE);
    const current = await db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', project.projectId)
      .executeTakeFirstOrThrow();
    const bound = await db.transaction().execute((trx) =>
      bindCandidate(deps, trx, {
        project: current,
        expectedVersion: current.projectVersion,
        candidate,
        streetViewMode: 'persist',
        attachedFacade: false,
        audience: ANONYMOUS_AUDIENCE,
        capabilities,
      }),
    );
    expect(bound.created).toBe(false);
    expect(bound.source.id).toBe(project.sourceAssetId);
    expect(bound.source.viewpoint?.framing?.status).toBe('framed');
  });

  it("shows a transient source's framed view from the display URL, ledgered once", async () => {
    const client = harness.client({ remoteAddress: '10.63.0.2' });
    await client.createSession();
    const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'transient');
    // The policy does not allow storing the frame: the source stays `transient`.
    const { assetPolicyId } = await harness.context.db
      .selectFrom('sourceAssets')
      .select('assetPolicyId')
      .where('id', '=', project.sourceAssetId)
      .executeTakeFirstOrThrow();
    await harness.context.db
      .updateTable('assetPolicies')
      .set({ store: 'denied' })
      .where('id', '=', assetPolicyId!)
      .execute();
    const readProject = async () =>
      json<{ project: Project }>(await client.get(`/v1/projects/${project.projectId}`)).project;
    const candidateUrl = (await readProject()).activeSource?.displayUrl;
    const linesBefore = await displayLines(project.projectId);

    await firstLook(client, project);
    const after = await harness.context.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', project.sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(after.viewpoint?.framing?.status).toBe('framed');
    expect(after.objectKey).toBeNull();

    // No frame is stored: the picture is the framed view's display URL, ledgered once.
    const shown = (await readProject()).activeSource?.displayUrl;
    expect(shown).toContain('/fixture/streetview?');
    expect(shown).not.toBe(candidateUrl);
    expect(shown).toContain(`fov=${framedViewOf(after.viewpoint!).fov.toFixed(1)}`);
    expect(await displayLines(project.projectId)).toBe(linesBefore + 1);
    // Reading the project again issues nothing more.
    await readProject();
    expect(await displayLines(project.projectId)).toBe(linesBefore + 1);
  });
});

/** The display loads counted on a project's property. */
async function displayLoads(projectId: string): Promise<number> {
  const row = await harness.context.db
    .selectFrom('projects')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .select('properties.displayLoadsIssued')
    .where('projects.id', '=', projectId)
    .executeTakeFirstOrThrow();
  return row.displayLoadsIssued;
}

/** Sets the display loads counted in the open window of a project's property. */
async function setDisplayLoads(projectId: string, issued: number): Promise<void> {
  const { propertyId } = await harness.context.db
    .selectFrom('projects')
    .select('propertyId')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  await harness.context.db
    .updateTable('properties')
    .set({ displayLoadsIssued: issued, displayLoadsWindowStartedAt: new Date() })
    .where('id', '=', propertyId!)
    .execute();
}

async function sourceOf(id: string) {
  return harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

/** Requests a look through the API and runs its job. */
async function nextLook(
  client: ReturnType<Harness['client']>,
  projectId: string,
  holidayId: 'christmas' | 'halloween',
) {
  const project = json<{ project: Project }>(await client.get(`/v1/projects/${projectId}`)).project;
  const response = await client.post(
    '/v1/renders',
    {
      projectId,
      projectVersion: project.projectVersion,
      holidayId,
      style: 'classic',
      lightingMode: 'source',
    },
    { 'idempotency-key': randomUUID() },
  );
  expect(response.statusCode).toBe(202);
  const jobId = json<{ renderJobId: string }>(response).renderJobId;
  expect((await runRenderJob(harness.pipeline, { renderJobId: jobId })).state).toBe('succeeded');
  return jobId;
}

describe('the framed view of a source whose stored frame may not be shown', () => {
  it('shows it from the display URL once the policy denies storing, ledgered once', async () => {
    const client = harness.client({ remoteAddress: '10.63.0.3' });
    await client.createSession();
    const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'persist');
    const readProject = async () =>
      json<{ project: Project }>(await client.get(`/v1/projects/${project.projectId}`)).project;
    const readBefores = async () =>
      json<{ items: { beforeImageUrl: string | null }[] }>(
        await client.get(`/v1/projects/${project.projectId}/variants`),
      ).items.map((item) => item.beforeImageUrl);
    await firstLook(client, project);
    const framed = await sourceOf(project.sourceAssetId);
    expect(framed.viewpoint?.framing?.status).toBe('framed');
    expect(framed.objectKey).not.toBeNull();
    expect((await readProject()).activeSource?.displayUrl).toContain(framed.objectKey!);
    const lines = await displayLines(project.projectId);
    const loads = await displayLoads(project.projectId);

    // The use policy stops allowing the stored frame.
    await harness.context.db
      .updateTable('assetPolicies')
      .set({ store: 'denied' })
      .where('id', '=', framed.assetPolicyId!)
      .execute();
    const shown = (await readProject()).activeSource?.displayUrl;
    expect(shown).not.toContain(framed.objectKey!);
    expect(shown).toContain('/fixture/streetview?');
    expect(shown).toContain(`fov=${framedViewOf(framed.viewpoint!).fov.toFixed(1)}`);
    // That load is counted and ledgered once, and marked on the framing.
    expect(await displayLines(project.projectId)).toBe(lines + 1);
    expect(await displayLoads(project.projectId)).toBe(loads + 1);
    const marked = await sourceOf(project.sourceAssetId);
    expect(marked.viewpoint?.framing).toMatchObject({
      status: 'framed',
      displayIssuedAt: expect.any(String),
    });
    // The look's before is the same picture; reading again issues nothing more.
    expect(await readBefores()).toEqual([shown]);
    expect((await readProject()).activeSource?.displayUrl).toBe(shown);
    expect(await displayLines(project.projectId)).toBe(lines + 1);

    // The next look drops the stored frame at admission; the picture stays, with no new line.
    await nextLook(client, project.projectId, 'halloween');
    expect((await sourceOf(project.sourceAssetId)).objectKey).toBeNull();
    expect((await readProject()).activeSource?.displayUrl).toBe(shown);
    expect(await displayLines(project.projectId)).toBe(lines + 1);
    expect(await displayLoads(project.projectId)).toBe(loads + 1);
  });

  it('shows no picture for a deleted stored copy while the display budget has no room', async () => {
    const client = harness.client({ remoteAddress: '10.63.0.4' });
    await client.createSession();
    const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'persist');
    const readProject = async () =>
      json<{ project: Project }>(await client.get(`/v1/projects/${project.projectId}`)).project;
    await firstLook(client, project);
    const framed = await sourceOf(project.sourceAssetId);
    expect(framed.viewpoint?.framing?.status).toBe('framed');
    // The stored copy is deleted (as revalidation or admission deletes it).
    await harness.context.storage.delete('private', framed.objectKey!);
    await harness.context.db
      .updateTable('sourceAssets')
      .set({ objectKey: null })
      .where('id', '=', framed.id)
      .execute();
    const limit = await harness.context.settings.get('rate.static_display_loads_per_address');
    await setDisplayLoads(project.projectId, limit);
    const lines = await displayLines(project.projectId);

    // No room: no picture rather than a display URL that is not counted.
    expect((await readProject()).activeSource?.displayUrl).toBeNull();
    const befores = json<{ items: { beforeImageUrl: string | null }[] }>(
      await client.get(`/v1/projects/${project.projectId}/variants`),
    ).items.map((item) => item.beforeImageUrl);
    expect(befores).toEqual([null]);
    expect(await displayLines(project.projectId)).toBe(lines);
    expect(await displayLoads(project.projectId)).toBe(limit);
    expect((await sourceOf(project.sourceAssetId)).viewpoint?.framing).not.toHaveProperty(
      'displayIssuedAt',
    );

    // Once the budget has room the framed view is shown, counted and ledgered once.
    await setDisplayLoads(project.projectId, 0);
    const shown = (await readProject()).activeSource?.displayUrl;
    expect(shown).toContain(`fov=${framedViewOf(framed.viewpoint!).fov.toFixed(1)}`);
    expect(await displayLines(project.projectId)).toBe(lines + 1);
    expect(await displayLoads(project.projectId)).toBe(1);
    await readProject();
    expect(await displayLines(project.projectId)).toBe(lines + 1);
  });
});

/** A persist project whose first look framed its source, with the stored frame kept. */
async function framedProject(remoteAddress: string) {
  const client = harness.client({ remoteAddress });
  await client.createSession();
  const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'persist');
  await firstLook(client, project);
  const framed = await sourceOf(project.sourceAssetId);
  expect(framed.viewpoint?.framing?.status).toBe('framed');
  expect(framed.viewpoint?.framing).not.toHaveProperty('displayIssuedAt');
  return { client, project, framed };
}

describe('readers at once of a framed source that falls back to the display URL', () => {
  it('count and ledger one display load', async () => {
    const { client, project, framed } = await framedProject('10.63.0.5');
    const jobId = (
      await harness.context.db
        .selectFrom('renderJobs')
        .select('id')
        .where('projectId', '=', project.projectId)
        .executeTakeFirstOrThrow()
    ).id;
    const lines = await displayLines(project.projectId);
    const loads = await displayLoads(project.projectId);
    await harness.context.db
      .updateTable('assetPolicies')
      .set({ store: 'denied' })
      .where('id', '=', framed.assetPolicyId!)
      .execute();

    // Nine reads at once, each of which falls back to the framed display URL.
    const reads = await Promise.all([
      ...[0, 1, 2, 3].map(() => client.get(`/v1/projects/${project.projectId}`)),
      ...[0, 1, 2, 3].map(() => client.get(`/v1/projects/${project.projectId}/variants`)),
      client.get(`/v1/renders/${jobId}`),
    ]);
    expect(reads.map((read) => read.statusCode)).toEqual(Array(9).fill(200));
    const shown = reads
      .slice(0, 4)
      .map((read) => json<{ project: Project }>(read).project.activeSource?.displayUrl);
    const befores = reads
      .slice(4, 8)
      .map(
        (read) =>
          json<{ items: { beforeImageUrl: string | null }[] }>(read).items[0]?.beforeImageUrl,
      );
    expect(new Set([...shown, ...befores]).size).toBe(1);
    expect(shown[0]).toContain(`fov=${framedViewOf(framed.viewpoint!).fov.toFixed(1)}`);
    expect(await displayLines(project.projectId)).toBe(lines + 1);
    expect(await displayLoads(project.projectId)).toBe(loads + 1);
  });
});

describe('the framed display URL while spend is blocked', () => {
  /** The API's deps with `settings` reads replaced. */
  function blocked(
    replace: Partial<
      Pick<ApiDeps['settings'], 'get' | 'isProviderPaused' | 'skuDailyCeilingMicros'>
    >,
    providerMode?: 'live',
  ): ApiDeps {
    const deps = harness.server.deps;
    const fixtures = deps.providers.fixtures;
    return {
      ...deps,
      settings: { ...deps.settings, ...replace },
      ...(providerMode
        ? {
            providers: {
              ...deps.providers,
              fixtures: {
                ...fixtures,
                streetView: { ...fixtures.streetView, mode: providerMode },
              },
            },
          }
        : {}),
    };
  }

  it('issues nothing under the global pause, a provider pause or a spent ceiling', async () => {
    const { client, project, framed } = await framedProject('10.63.0.6');
    const deps = harness.server.deps;
    const session = await harness.context.db
      .selectFrom('anonymousSessions')
      .selectAll()
      .where('ownerId', '=', framed.ownerId)
      .executeTakeFirstOrThrow();
    const auth = { audience: ANONYMOUS_AUDIENCE, ownerId: framed.ownerId, session };
    const lines = await displayLines(project.projectId);
    const loads = await displayLoads(project.projectId);
    const settings = deps.settings;
    const pausedGlobally = blocked({
      get: (async (key: string) =>
        key === 'pause.global'
          ? true
          : settings.get(key as 'pause.global')) as ApiDeps['settings']['get'],
    });
    const providerPaused = blocked({
      isProviderPaused: async (provider) =>
        provider === 'fixture' ? true : settings.isProviderPaused(provider),
    });
    // A live display load is checked against the spend ceilings, which have no room left.
    const ceilingSpent = blocked({ skuDailyCeilingMicros: async () => 0 }, 'live');

    const shownWhileBlocked = [];
    for (const spendBlocked of [pausedGlobally, providerPaused, ceilingSpent]) {
      shownWhileBlocked.push(await framedDisplayUrlOf(spendBlocked, auth, framed));
    }
    expect(shownWhileBlocked).toEqual([null, null, null]);
    expect(await displayLines(project.projectId)).toBe(lines);
    expect(await displayLoads(project.projectId)).toBe(loads);
    expect((await sourceOf(project.sourceAssetId)).viewpoint?.framing).not.toHaveProperty(
      'displayIssuedAt',
    );

    // Once spend is allowed a later read issues it, counted and ledgered once.
    await harness.context.db
      .updateTable('assetPolicies')
      .set({ store: 'denied' })
      .where('id', '=', framed.assetPolicyId!)
      .execute();
    const shown = json<{ project: Project }>(await client.get(`/v1/projects/${project.projectId}`))
      .project.activeSource?.displayUrl;
    expect(shown).toContain(`fov=${framedViewOf(framed.viewpoint!).fov.toFixed(1)}`);
    expect(await displayLines(project.projectId)).toBe(lines + 1);
    expect(await displayLoads(project.projectId)).toBe(loads + 1);
  });
});
