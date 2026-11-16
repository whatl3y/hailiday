import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RenderStatusSchema } from '@hailiday/core';
import { startOfUtcDay } from '@hailiday/server/clock';
import type { AppConfig } from '@hailiday/server/config';
import { toJson } from '@hailiday/server/db';
import { newId } from '@hailiday/server/ids';
import { skusForCeiling, spendSince } from '@hailiday/server/limits';
import { compilerVersionFor, runRenderJob } from '@hailiday/server/pipeline';
import { notifyRenderJobChanged } from '@hailiday/server/queue';
import { keys } from '@hailiday/server/storage';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { adoptStreetViewProject, adoptUploadProject } from './test/projects.js';

let harness: Harness;
/** The configuration the API reads; the enhancement switch is flipped per test. */
let apiConfig: AppConfig;
/** A per-ceiling headroom over today's spend for this server only (none: the stored ceiling). */
const headroom: Record<string, number> = {};

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      SESSION_SECRET: 'street-view-enhance-test-secret-0123456789abc',
      STREET_VIEW_ENHANCE: 'on',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
    // The API prices legs by the configured provider names; the adapters stay fixtures and the
    // admission tests never run the worker, so nothing live is dispatched.
    mapConfig: (config): AppConfig => {
      apiConfig = {
        ...config,
        providers: { ...config.providers, imageEditor: 'openai', vision: 'anthropic' },
        streetView: { ...config.streetView },
      };
      return apiConfig;
    },
  });
  const capabilities = harness.context.capabilities;
  const stored = capabilities.state.bind(capabilities);
  vi.spyOn(capabilities, 'state').mockImplementation(async (country, capability) =>
    capability === 'street_view_ai' || capability === 'vision_analysis'
      ? ('live_public' as Awaited<ReturnType<typeof stored>>)
      : stored(country, capability),
  );
  vi.spyOn(harness.context.settings, 'isProviderPaused').mockResolvedValue(false);
  const settings = harness.context.settings;
  const ceiling = settings.skuDailyCeilingMicros.bind(settings);
  // A ceiling relative to what is already spent today, so files running alongside cannot move it.
  vi.spyOn(settings, 'skuDailyCeilingMicros').mockImplementation(async (key) => {
    const extra = headroom[key];
    if (extra === undefined) return ceiling(key);
    const now = new Date();
    return (await spendSince(harness.context.db, startOfUtcDay(now), skusForCeiling(key))) + extra;
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await harness?.close();
});

let clients = 0;
async function newClient(): Promise<TestClient> {
  clients += 1;
  const client = harness.client({ remoteAddress: `10.62.0.${clients}` });
  await client.createSession();
  return client;
}

async function render(
  client: TestClient,
  project: { projectId: string; projectVersion: number },
  lightingMode: 'source' | 'evening' = 'evening',
  style = 'classic',
) {
  return client.post(
    '/v1/renders',
    {
      projectId: project.projectId,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style,
      lightingMode,
    },
    { 'idempotency-key': randomUUID() },
  );
}

async function enhancingLines(jobId: string) {
  return harness.context.db
    .selectFrom('usageLedger')
    .select(['sku', 'provider', 'stage', 'unitPriceMicros', 'isFixture'])
    .where('jobId', '=', jobId)
    .where('kind', '=', 'reservation')
    .where('stage', '=', 'enhancing')
    .orderBy('sku')
    .execute();
}

/** Stores a frame for a persist source (its key, checksum and a fresh fetch time). */
async function storeFrame(sourceAssetId: string, checksum: string) {
  const source = await harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', sourceAssetId)
    .executeTakeFirstOrThrow();
  await harness.context.db
    .updateTable('sourceAssets')
    .set({
      objectKey: keys.original(source.ownerId, source.id),
      checksumSha256: checksum,
      viewpoint: toJson({ ...source.viewpoint, fetchedAt: new Date().toISOString() }),
    })
    .where('id', '=', source.id)
    .execute();
}

describe('admission reserves the enhancement of a stored Street View frame', () => {
  it('reserves its edit and judge until a decided enhancement exists for the frame', async () => {
    apiConfig.streetView.enhance = true;
    const client = await newClient();
    const project = await adoptStreetViewProject(harness, client, undefined, 'persist');
    const first = await render(client, project);
    expect(first.statusCode).toBe(202);
    const firstId = json<{ renderJobId: string }>(first).renderJobId;
    // No stored frame yet: the job fetches one, and enhances it.
    expect(await enhancingLines(firstId)).toEqual([
      {
        sku: 'image_edit_attempt',
        provider: 'openai',
        stage: 'enhancing',
        unitPriceMicros: 130_000,
        isFixture: false,
      },
      {
        sku: 'vision_call',
        provider: 'anthropic',
        stage: 'enhancing',
        unitPriceMicros: 40_000,
        isFixture: false,
      },
    ]);
    await client.post(`/v1/renders/${firstId}/cancel`, {});

    // The frame is stored and a later job decided its enhancement: nothing more to reserve.
    const checksum = 'a'.repeat(64);
    await storeFrame(project.sourceAssetId, checksum);
    const row = newId();
    await harness.context.db
      .insertInto('sourceEnhancements')
      .values({
        id: row,
        sourceAssetId: project.sourceAssetId,
        frameChecksumSha256: checksum,
        compilerVersion: compilerVersionFor('openai'),
        workingWidth: 1024,
        workingHeight: 1024,
        status: 'rejected',
        reason: 'qa',
      })
      .execute();
    const second = await render(client, project, 'evening', 'subtle');
    expect(second.statusCode).toBe(202);
    const secondId = json<{ renderJobId: string }>(second).renderJobId;
    expect(await enhancingLines(secondId)).toEqual([]);
    await client.post(`/v1/renders/${secondId}/cancel`, {});

    // An enhancement that ended without a decision may be tried once more: reserved again.
    await harness.context.db
      .updateTable('sourceEnhancements')
      .set({ status: 'failed', reason: 'provider_error', retryable: true, editCount: 1 })
      .where('id', '=', row)
      .execute();
    const third = await render(client, project, 'evening', 'abundant');
    expect(third.statusCode).toBe(202);
    const thirdId = json<{ renderJobId: string }>(third).renderJobId;
    expect(await enhancingLines(thirdId)).toHaveLength(2);
    await client.post(`/v1/renders/${thirdId}/cancel`, {});
  });

  it('reserves nothing with the switch off or for an upload', async () => {
    try {
      apiConfig.streetView.enhance = false;
      const off = await newClient();
      const persist = await adoptStreetViewProject(harness, off, undefined, 'persist');
      const response = await render(off, persist);
      expect(response.statusCode).toBe(202);
      const jobId = json<{ renderJobId: string }>(response).renderJobId;
      expect(await enhancingLines(jobId)).toEqual([]);
      await off.post(`/v1/renders/${jobId}/cancel`, {});
    } finally {
      apiConfig.streetView.enhance = true;
    }
    const uploadClient = await newClient();
    const upload = await adoptUploadProject(harness, uploadClient);
    const uploaded = await render(uploadClient, upload);
    expect(uploaded.statusCode).toBe(202);
    const uploadedId = json<{ renderJobId: string }>(uploaded).renderJobId;
    expect(await enhancingLines(uploadedId)).toEqual([]);
    await uploadClient.post(`/v1/renders/${uploadedId}/cancel`, {});
  });

  it('answers BUDGET_PAUSED when only the enhancement lines exceed the image edit ceiling', async () => {
    // Room for the three edits of an evening look that decorates its own base, not a fourth.
    headroom.image_edit_attempt = 3 * 130_000 + 1_000;
    try {
      const client = await newClient();
      const project = await adoptStreetViewProject(harness, client, undefined, 'persist');
      const refused = await render(client, project);
      expect(refused.statusCode).toBe(503);
      expect(json<{ error: { code: string } }>(refused).error.code).toBe('BUDGET_PAUSED');
      apiConfig.streetView.enhance = false;
      const admitted = await render(client, project);
      expect(admitted.statusCode).toBe(202);
      await client.post(
        `/v1/renders/${json<{ renderJobId: string }>(admitted).renderJobId}/cancel`,
        {},
      );
    } finally {
      delete headroom.image_edit_attempt;
      apiConfig.streetView.enhance = true;
    }
  });
});

describe('the stage label follows the sub-stage', () => {
  async function queuedJob(lightingMode: 'source' | 'evening' | 'bright' = 'evening') {
    const client = await newClient();
    const project = await adoptStreetViewProject(harness, client);
    const response = await render(
      client,
      project,
      lightingMode === 'bright' ? 'source' : lightingMode,
    );
    expect(response.statusCode).toBe(202);
    return { client, jobId: json<{ renderJobId: string }>(response).renderJobId };
  }

  async function setStage(
    jobId: string,
    patch: {
      state: 'analyzing' | 'planning' | 'rendering' | 'checking' | 'canceled';
      subStage: 'enhancing' | 'relight' | null;
      lightingMode?: 'source' | 'evening' | 'bright';
    },
  ) {
    const job = await harness.context.db
      .updateTable('renderJobs')
      .set((eb) => ({
        state: patch.state,
        subStage: patch.subStage,
        ...(patch.lightingMode ? { lightingMode: patch.lightingMode } : {}),
        ...(patch.state === 'canceled' ? { terminalAt: new Date() } : {}),
        stateSeq: eb('stateSeq', '+', 1),
      }))
      .where('id', '=', jobId)
      .returning(['stateSeq'])
      .executeTakeFirstOrThrow();
    await notifyRenderJobChanged(harness.context.db, { jobId, seq: job.stateSeq });
  }

  it('maps each sub-stage to its key in the status', async () => {
    const { client, jobId } = await queuedJob();
    const status = async () =>
      RenderStatusSchema.parse((await client.get(`/v1/renders/${jobId}`)).json()).stageLabelKey;
    await setStage(jobId, { state: 'analyzing', subStage: null });
    expect(await status()).toBe('stage.planning');
    await setStage(jobId, { state: 'analyzing', subStage: 'enhancing' });
    expect(await status()).toBe('stage.enhancing');
    await setStage(jobId, { state: 'planning', subStage: null });
    expect(await status()).toBe('stage.planning');
    await setStage(jobId, { state: 'planning', subStage: 'relight' });
    expect(await status()).toBe('stage.eveningLight');
    await setStage(jobId, { state: 'rendering', subStage: 'relight' });
    expect(await status()).toBe('stage.eveningLight');
    await setStage(jobId, { state: 'rendering', subStage: 'relight', lightingMode: 'bright' });
    expect(await status()).toBe('stage.brightLight');
    await setStage(jobId, { state: 'checking', subStage: null });
    expect(await status()).toBe('stage.checking');
    await setStage(jobId, { state: 'canceled', subStage: null });
    expect(await status()).toBeNull();
  });

  it('sends an event when only the sub-stage changes', async () => {
    const { client, jobId } = await queuedJob();
    await setStage(jobId, { state: 'analyzing', subStage: null });
    const streaming = client.get(`/v1/renders/${jobId}/events`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(harness.server.deps.events.subscriberCount(jobId)).toBe(1);
    await setStage(jobId, { state: 'analyzing', subStage: 'enhancing' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await setStage(jobId, { state: 'canceled', subStage: null });
    const stream = await streaming;
    const events = [...stream.body.matchAll(/id: (\d+)\nevent: render\ndata: (.*)\n\n/g)].map(
      (match) => RenderStatusSchema.parse(JSON.parse(match[2] ?? '{}')),
    );
    expect(events.map((event) => [event.state, event.stageLabelKey])).toEqual([
      ['analyzing', 'stage.planning'],
      ['analyzing', 'stage.enhancing'],
      ['canceled', null],
    ]);
  });
});

describe('an address render enhances the stored frame end to end', () => {
  let fixtureHarness: Harness;

  beforeAll(async () => {
    // Every leg a fixture, as configured: the worker runs the whole job.
    fixtureHarness = await createHarness({
      overrides: {
        SESSION_SECRET: 'street-view-enhance-e2e-secret-0123456789abcdef',
        STREET_VIEW_ENHANCE: 'on',
        RENDER_QUEUE_DEPTH_MAX: '100000',
        RENDER_MAX_WAIT_S: '1000000',
      },
    });
  });

  afterAll(async () => {
    await fixtureHarness?.close();
  });

  it('records `made`, keeps the stored frame as the before image and labels the step', async () => {
    const client = fixtureHarness.client({ remoteAddress: '10.62.1.1' });
    await client.createSession();
    const project = await adoptStreetViewProject(fixtureHarness, client, undefined, 'persist');
    const response = await render(client, project, 'source');
    expect(response.statusCode).toBe(202);
    const jobId = json<{ renderJobId: string }>(response).renderJobId;

    // The enhance answer is held back briefly so the stream sees the step's own label.
    const inner = fixtureHarness.pipeline.providers.fixtures.imageEditor;
    const imageEditor = {
      ...inner,
      async edit(...args: Parameters<typeof inner.edit>) {
        if (args[0].kind === 'enhance') await new Promise((resolve) => setTimeout(resolve, 400));
        return inner.edit(...args);
      },
      getOperation: (operationId: string) => inner.getOperation(operationId),
    };
    const pipeline = {
      ...fixtureHarness.pipeline,
      providers: {
        ...fixtureHarness.pipeline.providers,
        fixtures: { ...fixtureHarness.pipeline.providers.fixtures, imageEditor },
      },
    };
    const streaming = client.get(`/v1/renders/${jobId}/events`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await runRenderJob(pipeline, { renderJobId: jobId })).state).toBe('succeeded');
    const stream = await streaming;
    const labels = [...stream.body.matchAll(/id: (\d+)\nevent: render\ndata: (.*)\n\n/g)]
      .map((match) => RenderStatusSchema.parse(JSON.parse(match[2] ?? '{}')).stageLabelKey)
      .filter((label, i, all) => label !== all[i - 1]);
    expect(labels).toContain('stage.enhancing');
    expect(labels.indexOf('stage.enhancing')).toBeLessThan(labels.indexOf('stage.rendering'));

    const job = await fixtureHarness.context.db
      .selectFrom('renderJobs')
      .select(['enhancement', 'workingChecksumSha256'])
      .where('id', '=', jobId)
      .executeTakeFirstOrThrow();
    const row = await fixtureHarness.context.db
      .selectFrom('sourceEnhancements')
      .selectAll()
      .where('sourceAssetId', '=', project.sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(job.enhancement).toEqual({ outcome: 'made', enhancementId: row.id, reason: null });
    expect(row.status).toBe('accepted');
    expect(job.workingChecksumSha256).toBe(row.enhancedChecksumSha256);

    const variants = await client.get(`/v1/projects/${project.projectId}/variants`);
    expect(variants.statusCode).toBe(200);
    const [variant] = json<{ items: { beforeImageUrl: string | null }[] }>(variants).items;
    const source = await fixtureHarness.context.db
      .selectFrom('sourceAssets')
      .select('objectKey')
      .where('id', '=', project.sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(source.objectKey).not.toBeNull();
    expect(variant?.beforeImageUrl).toContain(source.objectKey as string);
    expect(variant?.beforeImageUrl).not.toContain('enhanced/');
  });
});
