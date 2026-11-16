import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ProductsPanelSchema,
  ProjectSchema,
  SourceDiscoveryResponseSchema,
  type Project,
} from '@hailiday/core';
import type { AppConfig } from '@hailiday/server/config';
import {
  STREET_VIEW_OWNER_DECISION_EVIDENCE,
  STREET_VIEW_STANDARD_TERMS_EVIDENCE,
  defaultPolicyTemplate,
} from '@hailiday/server/policy';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';
import { adoptStreetViewProject } from './test/projects.js';

const PLACES = {
  autoStart: 'ChIJfxLanternHillColonial01',
  confirm: 'ChIJfxDriftwoodCoveCapeXX15',
} as const;

/** The uses of the Street View template recorded before Street View could be decorated. */
const STANDARD_TERMS = defaultPolicyTemplate('street_view', {
  usePolicy: 'display_only',
  imagery: 'live',
});

let clientIndex = 0;

async function newClient(harness: Harness): Promise<TestClient> {
  clientIndex += 1;
  const client = harness.client({
    remoteAddress: `10.72.${Math.floor(clientIndex / 200)}.${clientIndex % 200}`,
  });
  await client.createSession();
  return client;
}

/**
 * A harness whose API sees live Street View imagery, a live Street View AI leg and live display
 * (capability states for this server only); every adapter stays a fixture.
 */
async function liveStubHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const harness = await createHarness({
    overrides: {
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
      ...overrides,
    },
    mapConfig: (config): AppConfig => ({
      ...config,
      providers: { ...config.providers, streetView: 'google', imageEditor: 'openai' },
    }),
  });
  const states: Record<string, string> = {
    street_view_ai: 'live_public',
    street_view_display: 'live_public',
    vision_analysis: 'fixture',
  };
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

/** Requests a daylight render in an offered style (the first, or the `styleIndex`th). */
async function render(client: TestClient, project: { projectId: string }, styleIndex = 0) {
  const current = ProjectSchema.parse(
    json<{ project: unknown }>(await client.get(`/v1/projects/${project.projectId}`)).project,
  );
  const styles = current.offered?.styles ?? [];
  expect(styles.length).toBeGreaterThan(styleIndex);
  return client.post(
    '/v1/renders',
    {
      projectId: project.projectId,
      projectVersion: current.projectVersion,
      holidayId: 'christmas',
      style: styles[styleIndex],
      lightingMode: 'source',
    },
    { 'idempotency-key': randomUUID() },
  );
}

/** Sets a stored policy back to the standard-terms template (a row recorded before the change). */
async function recordStandardTerms(harness: Harness, policyId: string) {
  await harness.context.db
    .updateTable('assetPolicies')
    .set({
      display: STANDARD_TERMS.display,
      store: STANDARD_TERMS.store,
      aiProcess: STANDARD_TERMS.aiProcess,
      edit: STANDARD_TERMS.edit,
      distributeDerivative: STANDARD_TERMS.distributeDerivative,
      commerceAdjacent: STANDARD_TERMS.commerceAdjacent,
      evidenceRef: STANDARD_TERMS.evidenceRef,
    })
    .where('id', '=', policyId)
    .execute();
}

async function sourceRow(harness: Harness, sourceAssetId: string) {
  return harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', sourceAssetId)
    .executeTakeFirstOrThrow();
}

async function policyRow(harness: Harness, policyId: string) {
  return harness.context.db
    .selectFrom('assetPolicies')
    .selectAll()
    .where('id', '=', policyId)
    .executeTakeFirstOrThrow();
}

async function ledgerOf(harness: Harness, jobId: string) {
  return harness.context.db
    .selectFrom('usageLedger')
    .select(['id', 'kind', 'sku', 'provider', 'isFixture', 'reservationId'])
    .where('jobId', '=', jobId)
    .where('sku', '=', 'street_view_static_fetch')
    .execute();
}

describe('Street View under the default use policy with live-mode stubs', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await liveStubHarness();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await harness?.close();
  });

  it('discovery auto-starts a clean match in persist mode with the owner-decision policy', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.autoStart);
    const result = await discover(client, project);
    expect(result.discovery).toMatchObject({
      matchClass: 'auto_start',
      sourceMode: 'persist',
      nextAction: 'render',
    });
    expect(result.project.activeSource).toMatchObject({
      kind: 'street_view',
      sourceMode: 'persist',
    });
    const source = await sourceRow(harness, result.discovery.sourceAssetId as string);
    expect((await policyRow(harness, source.assetPolicyId as string)).evidenceRef).toBe(
      STREET_VIEW_OWNER_DECISION_EVIDENCE,
    );
  });

  it('discovery asks to confirm an amber match in a decoratable mode and binds it', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const result = await discover(client, project);
    expect(result.discovery).toMatchObject({ matchClass: 'confirm', sourceMode: 'persist' });
    const primary = result.discovery.candidates.find((candidate) => candidate.isPrimary);
    const bound = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: result.project.projectVersion,
      candidateId: primary?.candidateId,
    });
    expect(bound.statusCode).toBe(200);
    expect(
      ProjectSchema.parse(json<{ project: unknown }>(bound).project).activeSource,
    ).toMatchObject({ kind: 'street_view', sourceMode: 'persist' });
  });

  it('re-derives a discovery recorded under the standard-terms template when it is replayed', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const first = await discover(client, project);
    // The rows as the standard-terms template left them: display only.
    const discoveryPolicy = await harness.context.db
      .selectFrom('assetPolicies')
      .select('id')
      .where('subjectId', '=', first.discovery.discoveryId)
      .executeTakeFirstOrThrow();
    await recordStandardTerms(harness, discoveryPolicy.id);
    await harness.context.db
      .updateTable('sourceDiscoveries')
      .set({ sourceMode: 'display_only' })
      .where('id', '=', first.discovery.discoveryId)
      .execute();
    const before = ProjectSchema.parse(
      json<{ project: unknown }>(await client.get(`/v1/projects/${project.id}`)).project,
    );
    expect(before.discovery?.sourceMode).toBe('display_only');

    const replay = await discover(client, first.project);
    expect(replay.discovery.discoveryId).toBe(first.discovery.discoveryId);
    expect(replay.discovery).toMatchObject({ matchClass: 'confirm', sourceMode: 'persist' });
    expect(replay.project.discovery?.sourceMode).toBe('persist');
    expect((await policyRow(harness, discoveryPolicy.id)).evidenceRef).toBe(
      STREET_VIEW_OWNER_DECISION_EVIDENCE,
    );
  });

  it('brings a reused source recorded under the standard-terms template along when it is confirmed again', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.confirm);
    const first = await discover(client, project);
    const primary = first.discovery.candidates.find((candidate) => candidate.isPrimary);
    const bound = ProjectSchema.parse(
      json<{ project: unknown }>(
        await client.put(`/v1/projects/${project.id}/source`, {
          projectVersion: first.project.projectVersion,
          candidateId: primary?.candidateId,
        }),
      ).project,
    );
    const sourceAssetId = bound.activeSource?.sourceAssetId as string;
    const source = await sourceRow(harness, sourceAssetId);
    await recordStandardTerms(harness, source.assetPolicyId as string);
    await harness.context.db
      .updateTable('sourceAssets')
      .set({ streetViewMode: 'display_only' })
      .where('id', '=', sourceAssetId)
      .execute();

    const again = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: bound.projectVersion,
      candidateId: primary?.candidateId,
    });
    expect(again.statusCode).toBe(200);
    expect(
      ProjectSchema.parse(json<{ project: unknown }>(again).project).activeSource,
    ).toMatchObject({ sourceAssetId, sourceMode: 'persist' });
    expect(await policyRow(harness, source.assetPolicyId as string)).toMatchObject({
      aiProcess: 'allowed',
      edit: 'allowed',
      store: 'allowed',
      evidenceRef: STREET_VIEW_OWNER_DECISION_EVIDENCE,
    });
  });

  it('admits a render of a source recorded under the standard-terms template and reserves its live fetch', async () => {
    const client = await newClient(harness);
    const project = await adoptStreetViewProject(harness, client);
    const source = await sourceRow(harness, project.sourceAssetId);
    await recordStandardTerms(harness, source.assetPolicyId as string);
    await harness.context.db
      .updateTable('sourceAssets')
      .set({ streetViewMode: 'display_only' })
      .where('id', '=', source.id)
      .execute();

    const response = await render(client, project);
    expect(response.statusCode).toBe(202);
    const refreshed = await sourceRow(harness, source.id);
    expect(refreshed.streetViewMode).toBe('persist');
    expect((await policyRow(harness, source.assetPolicyId as string)).evidenceRef).toBe(
      STREET_VIEW_OWNER_DECISION_EVIDENCE,
    );
    const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
    expect(await ledgerOf(harness, renderJobId)).toEqual([
      expect.objectContaining({ kind: 'reservation', provider: 'google', isFixture: false }),
    ]);
    await client.post(`/v1/renders/${renderJobId}/cancel`, {});
  });

  it('never changes an operator-recorded Street View policy', async () => {
    const client = await newClient(harness);
    const project = await adoptStreetViewProject(harness, client);
    const source = await sourceRow(harness, project.sourceAssetId);
    await recordStandardTerms(harness, source.assetPolicyId as string);
    await harness.context.db
      .updateTable('assetPolicies')
      .set({ evidenceRef: 'grant:google-denied-2026', aiProcess: 'denied', edit: 'denied' })
      .where('id', '=', source.assetPolicyId as string)
      .execute();
    const before = await policyRow(harness, source.assetPolicyId as string);

    const response = await render(client, project);
    expect(response.statusCode).toBe(409);
    expect(json(response).error).toMatchObject({
      code: 'SOURCE_NOT_EDITABLE',
      details: { reason: 'display_only' },
    });
    expect(await policyRow(harness, source.assetPolicyId as string)).toEqual(before);
    expect((await sourceRow(harness, source.id)).streetViewMode).toBe(source.streetViewMode);
  });
});

describe('Street View under the display_only use policy with live-mode stubs', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await liveStubHarness({ STREET_VIEW_USE_POLICY: 'display_only' });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await harness?.close();
  });

  it('keeps the address path display-only: confirm, never auto-start', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.autoStart);
    const result = await discover(client, project);
    expect(result.discovery).toMatchObject({
      matchClass: 'confirm',
      sourceMode: 'display_only',
      nextAction: 'confirm_place',
    });
    const policy = await harness.context.db
      .selectFrom('assetPolicies')
      .select('evidenceRef')
      .where('subjectId', '=', result.discovery.discoveryId)
      .executeTakeFirstOrThrow();
    expect(policy.evidenceRef).toBe(STREET_VIEW_STANDARD_TERMS_EVIDENCE);
  });
});

describe('Street View under the decorate use policy with live-mode stubs', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await liveStubHarness({ STREET_VIEW_USE_POLICY: 'decorate' });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await harness?.close();
  });

  it('auto-starts in transient mode', async () => {
    const client = await newClient(harness);
    const project = await resolve(harness, client, PLACES.autoStart);
    const result = await discover(client, project);
    expect(result.discovery).toMatchObject({
      matchClass: 'auto_start',
      sourceMode: 'transient',
      nextAction: 'render',
    });
  });
});

/** Renders a Street View project to completion and returns its delivered variant row. */
async function renderedVariant(harness: Harness, client: TestClient, persist: boolean) {
  const project = await adoptStreetViewProject(harness, client);
  if (persist) {
    await harness.context.db
      .updateTable('sourceAssets')
      .set({ streetViewMode: 'persist' })
      .where('id', '=', project.sourceAssetId)
      .execute();
  }
  const response = await render(client, project);
  expect(response.statusCode).toBe(202);
  const renderJobId = json<{ renderJobId: string }>(response).renderJobId;
  expect(await harness.completeRender(renderJobId)).toBe('succeeded');
  const asset = await harness.context.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('projectId', '=', project.projectId)
    .where('deletedAt', 'is', null)
    .executeTakeFirstOrThrow();
  return { project, renderJobId, asset };
}

describe('Street View deliverables under the default use policy', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      overrides: { RENDER_QUEUE_DEPTH_MAX: '100000', RENDER_MAX_WAIT_S: '1000000' },
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('settles the reserved fetch of a first persist render and reserves none once stored', async () => {
    const client = await newClient(harness);
    const { project, renderJobId } = await renderedVariant(harness, client, true);
    const lines = await ledgerOf(harness, renderJobId);
    const reservation = lines.find((line) => line.kind === 'reservation');
    expect(reservation).toBeDefined();
    expect(lines.filter((line) => line.kind === 'charge')).toEqual([]);
    expect(lines.filter((line) => line.kind === 'settlement')).toEqual([
      expect.objectContaining({ reservationId: reservation?.id }),
    ]);
    expect((await sourceRow(harness, project.sourceAssetId)).objectKey).not.toBeNull();

    // Another look of the same source reads the stored frame: no fetch is reserved or charged.
    const next = await render(client, project, 1);
    expect(next.statusCode).toBe(202);
    const nextJobId = json<{ renderJobId: string }>(next).renderJobId;
    expect(await harness.completeRender(nextJobId)).toBe('succeeded');
    expect(await ledgerOf(harness, nextJobId)).toEqual([]);
  });

  it('allows download, sharing and Shop the look, never a shared before image', async () => {
    const client = await newClient(harness);
    const { renderJobId, asset } = await renderedVariant(harness, client, false);
    expect(asset).toMatchObject({ distributable: true, downloadable: true });
    expect(asset.downloadObjectKey).not.toBeNull();
    const share = await client.post(
      '/v1/shares',
      { renderAssetId: asset.id },
      { 'idempotency-key': randomUUID() },
    );
    expect(share.statusCode).toBe(201);
    const before = await client.post('/v1/shares', {
      renderAssetId: asset.id,
      includeBefore: true,
    });
    expect(before.statusCode).toBe(400);
    expect(json(before).error).toMatchObject({ details: { reason: 'source_not_exportable' } });
    const panel = ProductsPanelSchema.parse(
      (await client.get(`/v1/renders/${renderJobId}/products`)).json(),
    );
    expect(panel.panelState).not.toBe('hidden');
  });
});

describe('Street View deliverables under the decorate use policy', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness({
      overrides: {
        RENDER_QUEUE_DEPTH_MAX: '100000',
        RENDER_MAX_WAIT_S: '1000000',
        STREET_VIEW_USE_POLICY: 'decorate',
      },
    });
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('keeps results private: no download, share or Shop the look', async () => {
    const client = await newClient(harness);
    const { project, renderJobId, asset } = await renderedVariant(harness, client, true);
    // The source's template row follows the decorate template, which never stores the frame.
    const source = await sourceRow(harness, project.sourceAssetId);
    expect(source.streetViewMode).toBe('transient');
    expect(source.objectKey).toBeNull();
    expect(asset).toMatchObject({ distributable: false, downloadable: false });
    expect(asset.downloadObjectKey).toBeNull();
    const share = await client.post(
      '/v1/shares',
      { renderAssetId: asset.id },
      { 'idempotency-key': randomUUID() },
    );
    expect(share.statusCode).toBe(403);
    expect(json(share).error).toMatchObject({ details: { reason: 'distribution_not_permitted' } });
    const panel = ProductsPanelSchema.parse(
      (await client.get(`/v1/renders/${renderJobId}/products`)).json(),
    );
    expect(panel.panelState).toBe('hidden');
  });
});
