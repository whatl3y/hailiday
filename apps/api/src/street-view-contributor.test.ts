import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateShareResponseSchema,
  GalleryResponseSchema,
  ProjectSchema,
  ShareViewSchema,
  SourceDiscoveryResponseSchema,
  VariantListResponseSchema,
  type Candidate,
  type Project,
} from '@hailiday/core';
import { createHarness, json, TestClient, type Harness } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';

/** The fixture place whose street photos stand in for contributor imagery (not Google's). */
const CONTRIBUTOR_PLACE = 'ChIJfxPinonMesaAdobeXXXXX17';
const CONTRIBUTOR_CREDIT =
  'Fixture photo: Roger Starnes Sr / Unsplash License (contributor imagery stand-in)';
const BASE_OVERRIDES = { RENDER_QUEUE_DEPTH_MAX: '100000', RENDER_MAX_WAIT_S: '1000000' };
const DISPLAY_ONLY = { ...BASE_OVERRIDES, STREET_VIEW_CONTRIBUTOR_IMAGERY: 'display_only' };

let clientIndex = 0;

async function newClient(harness: Harness): Promise<TestClient> {
  clientIndex += 1;
  const client = harness.client({
    remoteAddress: `10.93.${Math.floor(clientIndex / 200)}.${clientIndex % 200}`,
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

async function resolve(harness: Harness, client: TestClient): Promise<Project> {
  const response = await client.post('/v1/addresses/resolve', {
    placeId: CONTRIBUTOR_PLACE,
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

async function currentProject(client: TestClient, projectId: string): Promise<Project> {
  return ProjectSchema.parse(
    json<{ project: unknown }>(await client.get(`/v1/projects/${projectId}`)).project,
  );
}

async function bind(client: TestClient, project: Project, candidate: Candidate): Promise<Project> {
  const response = await client.put(`/v1/projects/${project.id}/source`, {
    projectVersion: project.projectVersion,
    candidateId: candidate.candidateId,
  });
  expect(response.statusCode).toBe(200);
  return ProjectSchema.parse(json<{ project: unknown }>(response).project);
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

function primaryOf(candidates: readonly Candidate[]): Candidate {
  const primary = candidates.find((candidate) => candidate.isPrimary);
  expect(primary).toBeDefined();
  return primary as Candidate;
}

async function sourceRow(harness: Harness, sourceAssetId: string) {
  return harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', sourceAssetId)
    .executeTakeFirstOrThrow();
}

/** Confirms the contributor place's primary view and decorates it: the decorated project. */
async function decorated(harness: Harness, client: TestClient) {
  const project = await resolve(harness, client);
  const found = await discover(client, project);
  const bound = await bind(client, found.project, primaryOf(found.discovery.candidates));
  const started = await render(client, bound.id);
  expect(started.statusCode).toBe(202);
  const renderJobId = json<{ renderJobId: string }>(started).renderJobId;
  expect(await harness.completeRender(renderJobId)).toBe('succeeded');
  const list = VariantListResponseSchema.parse(
    (await client.get(`/v1/projects/${bound.id}/variants`)).json(),
  );
  expect(list.items).toHaveLength(1);
  return {
    project: bound,
    sourceAssetId: bound.activeSource?.sourceAssetId as string,
    variant: list.items[0]!,
  };
}

describe('contributor imagery under the default setting (decorate)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ overrides: BASE_OVERRIDES });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('is confirmed first, then decorated, stored and shown with its own credit', async () => {
    expect(harness.config.streetView.contributorImagery).toBe('decorate');
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const found = await discover(client, project);
    // The confirmation screen comes first, as an ordinary one: never auto-started.
    expect(found.discovery).toMatchObject({
      matchClass: 'confirm',
      sourceMode: 'persist',
      nextAction: 'confirm_place',
      sourceAssetId: null,
      attribution: { logo: 'google_maps', required: true },
    });
    expect(found.discovery.candidates).toHaveLength(2);
    const primary = primaryOf(found.discovery.candidates);
    expect(primary).toMatchObject({ isGoogleImagery: false, copyright: CONTRIBUTOR_CREDIT });
    expect(primary.flags).toContain('contributorImagery');
    expect(primary.displayUrl).toBeTruthy();

    const premature = await render(client, project.id);
    expect(premature.statusCode).toBe(409);
    expect(json(premature).error).toMatchObject({ code: 'NEEDS_CONFIRMATION' });

    // The other view and a look to the side are offered.
    const alternate = found.discovery.candidates.find((candidate) => !candidate.isPrimary);
    const nudged = await client.put(`/v1/projects/${project.id}/viewpoint`, {
      projectVersion: found.project.projectVersion,
      candidateId: alternate?.candidateId,
    });
    expect(nudged.statusCode).toBe(200);

    const bound = await bind(client, found.project, primary);
    expect(bound.activeSource).toMatchObject({
      kind: 'street_view',
      sourceMode: 'persist',
      isGoogleImagery: false,
      copyright: CONTRIBUTOR_CREDIT,
    });
    const started = await render(client, bound.id);
    expect(started.statusCode).toBe(202);
    const renderJobId = json<{ renderJobId: string }>(started).renderJobId;
    expect(await harness.completeRender(renderJobId)).toBe('succeeded');

    const source = await sourceRow(harness, bound.activeSource?.sourceAssetId as string);
    expect(source.streetViewMode).toBe('persist');
    expect(source.objectKey).not.toBeNull();
    expect(
      await harness.context.storage.head('private', source.objectKey as string),
    ).not.toBeNull();

    const list = VariantListResponseSchema.parse(
      (await client.get(`/v1/projects/${bound.id}/variants`)).json(),
    );
    const variant = list.items[0];
    expect(variant).toMatchObject({
      distributable: true,
      downloadable: true,
      attribution: { required: true, text: CONTRIBUTOR_CREDIT, logo: 'google_maps' },
    });
    expect(variant?.attribution?.text).not.toMatch(/google/i);

    const share = await client.post(
      '/v1/shares',
      { renderAssetId: variant?.renderAssetId },
      { 'idempotency-key': randomUUID() },
    );
    expect(share.statusCode).toBe(201);
    const token = CreateShareResponseSchema.parse(share.json()).token;
    const view = ShareViewSchema.parse((await harness.client().get(`/v1/shares/${token}`)).json());
    expect(view.attribution).toMatchObject({ text: CONTRIBUTOR_CREDIT });
    const page = await harness.client().get(`/s/${token}`);
    expect(page.body).toContain('Roger Starnes Sr');
    expect(page.body).not.toContain('attribution__logo');
  });

  it("credits a rendering recorded without a line to its source's own copyright holder", async () => {
    const client = await newClient(harness);
    const { project, sourceAssetId, variant } = await decorated(harness, client);
    const db = harness.context.db;
    await db
      .updateTable('sourceAssets')
      .set({ copyright: '© GIS1 Street Imagery' })
      .where('id', '=', sourceAssetId)
      .execute();
    await db
      .updateTable('renderAssets')
      .set({ attributionText: null })
      .where('id', '=', variant.renderAssetId)
      .execute();
    const expected = 'Google Maps · © GIS1 Street Imagery';

    const list = VariantListResponseSchema.parse(
      (await client.get(`/v1/projects/${project.id}/variants`)).json(),
    );
    expect(list.items[0]?.attribution).toMatchObject({ text: expected, logo: 'google_maps' });
    const gallery = GalleryResponseSchema.parse((await client.get('/v1/gallery')).json());
    const item = gallery.items.find((entry) => entry.id === variant.renderAssetId);
    expect(item?.attribution).toEqual({ text: expected, logo: 'google_maps' });
    const share = await client.post(
      '/v1/shares',
      { renderAssetId: variant.renderAssetId },
      { 'idempotency-key': randomUUID() },
    );
    expect(share.statusCode).toBe(201);
    const token = CreateShareResponseSchema.parse(share.json()).token;
    const view = ShareViewSchema.parse((await harness.client().get(`/v1/shares/${token}`)).json());
    expect(view.attribution).toMatchObject({ text: expected });
    const page = await harness.client().get(`/s/${token}`);
    expect(page.body).toContain('© GIS1 Street Imagery');
  });
});

describe('contributor imagery under STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({ overrides: DISPLAY_ONLY });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('is shown for confirmation only: SOURCE_NOT_EDITABLE (display_only)', async () => {
    expect(harness.config.streetView.contributorImagery).toBe('display_only');
    const client = await newClient(harness);
    const project = await resolve(harness, client);
    const found = await discover(client, project);
    expect(found.discovery).toMatchObject({
      matchClass: 'confirm',
      sourceMode: 'display_only',
      nextAction: 'confirm_place',
    });
    const bound = await bind(client, found.project, primaryOf(found.discovery.candidates));
    expect(bound.activeSource?.sourceMode).toBe('display_only');
    const response = await render(client, bound.id);
    expect(response.statusCode).toBe(409);
    expect(json(response).error).toMatchObject({
      code: 'SOURCE_NOT_EDITABLE',
      details: { reason: 'display_only' },
    });
    const source = await sourceRow(harness, bound.activeSource?.sourceAssetId as string);
    expect(source.objectKey).toBeNull();
  });
});

describe('switching STREET_VIEW_CONTRIBUTOR_IMAGERY', () => {
  let decorate: Harness;
  let displayOnly: Harness;

  beforeAll(async () => {
    decorate = await createHarness({ overrides: BASE_OVERRIDES });
    displayOnly = await createHarness({ overrides: DISPLAY_ONLY });
  });

  afterAll(async () => {
    await Promise.all([decorate?.close(), displayOnly?.close()]);
  });

  it('makes a place found under display_only decoratable under decorate', async () => {
    const client = await newClient(displayOnly);
    const project = await resolve(displayOnly, client);
    const found = await discover(client, project);
    expect(found.discovery.sourceMode).toBe('display_only');

    // The discovery read again offers decoration.
    const later = sameBrowser(decorate, client);
    const again = await discover(later, project);
    expect(again.discovery.discoveryId).toBe(found.discovery.discoveryId);
    expect(again.discovery.sourceMode).toBe('persist');
  });

  it('makes a place confirmed under display_only decoratable under decorate', async () => {
    const client = await newClient(displayOnly);
    const project = await resolve(displayOnly, client);
    const found = await discover(client, project);
    const bound = await bind(client, found.project, primaryOf(found.discovery.candidates));
    expect(bound.activeSource?.sourceMode).toBe('display_only');
    expect((await render(client, bound.id)).statusCode).toBe(409);

    const later = sameBrowser(decorate, client);
    const started = await render(later, bound.id);
    expect(started.statusCode).toBe(202);
    const source = await sourceRow(decorate, bound.activeSource?.sourceAssetId as string);
    expect(source.streetViewMode).toBe('persist');
    const renderJobId = json<{ renderJobId: string }>(started).renderJobId;
    expect(await decorate.completeRender(renderJobId)).toBe('succeeded');
  });

  it('back to display_only: no new look, the stored frame deleted and share links revoked', async () => {
    const client = await newClient(decorate);
    const { project, sourceAssetId, variant } = await decorated(decorate, client);
    const stored = await sourceRow(decorate, sourceAssetId);
    expect(stored.objectKey).not.toBeNull();
    // Under the default setting the look's "Before" is the stored frame.
    expect(variant.beforeImageUrl).toContain(stored.objectKey as string);
    const share = await client.post(
      '/v1/shares',
      { renderAssetId: variant.renderAssetId },
      { 'idempotency-key': randomUUID() },
    );
    expect(share.statusCode).toBe(201);
    const token = CreateShareResponseSchema.parse(share.json()).token;

    const later = sameBrowser(displayOnly, client);
    // The share link is gone for good.
    const view = await displayOnly.client().get(`/v1/shares/${token}`);
    expect(view.statusCode).toBe(410);
    expect(json(view).error).toMatchObject({ code: 'SHARE_REVOKED' });
    const grant = await displayOnly.context.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('renderAssetId', '=', variant.renderAssetId)
      .executeTakeFirstOrThrow();
    expect(grant.revokedAt).not.toBeNull();
    // The look stays private: no download, no new share.
    const list = VariantListResponseSchema.parse(
      (await later.get(`/v1/projects/${project.id}/variants`)).json(),
    );
    expect(list.items[0]).toMatchObject({ distributable: false, downloadable: false });
    // Its "Before" is the provider's display URL of the view, not the stored frame the policy no
    // longer allows keeping (still stored until the next render request or revalidation).
    const before = list.items[0]?.beforeImageUrl;
    expect(before).toMatch(/[?&]pano=/);
    expect(before).not.toContain(stored.objectKey as string);

    // A new look is refused and the stored frame deleted.
    const response = await render(later, project.id, 1);
    expect(response.statusCode).toBe(409);
    expect(json(response).error).toMatchObject({
      code: 'SOURCE_NOT_EDITABLE',
      details: { reason: 'display_only' },
    });
    const after = await sourceRow(displayOnly, sourceAssetId);
    expect(after.objectKey).toBeNull();
    expect(
      await displayOnly.context.storage.head('private', stored.objectKey as string),
    ).toBeNull();
  });
});
