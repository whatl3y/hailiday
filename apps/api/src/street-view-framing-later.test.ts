import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GalleryItem, Project, Variant } from '@hailiday/core';
import { sql, toJson, type SourceAsset } from '@hailiday/server/db';
import { openReservations } from '@hailiday/server/ledger';
import {
  createRenderJobRecord,
  createStreetViewSource,
  runRenderJob,
  type PipelineDeps,
} from '@hailiday/server/pipeline';
import { framedViewOf } from '@hailiday/server/providers';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';
import { adoptStreetViewProject } from './test/projects.js';

/** A fixture place whose wide frame shows its home small enough to zoom in on. */
const FRAMED_PLACE = 'ChIJfxOldQuarryRoadColoni19';
/** What a fixture provider display URL contains. */
const DISPLAY_URL = '/fixture/streetview?';

let harness: Harness;
let operator: TestClient;

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      SESSION_SECRET: 'street-view-framing-later-secret-0123456789ab',
      STREET_VIEW_FRAMING: 'on',
      STREET_VIEW_ENHANCE: 'on',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
  });
  ({ client: operator } = await operatorClient(harness));
});

afterAll(async () => {
  await harness?.close();
});

/** The pipeline with the framing switched off: looks are made from the wide frame. */
function wideOnly(): PipelineDeps {
  const base = harness.pipeline;
  return {
    ...base,
    config: { ...base.config, streetView: { ...base.config.streetView, framing: false } },
  };
}

async function sourceRow(id: string): Promise<SourceAsset> {
  return harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function readProject(client: TestClient, projectId: string): Promise<Project> {
  return json<{ project: Project }>(await client.get(`/v1/projects/${projectId}`)).project;
}

/** Requests a look through the API and runs its job; returns the job's ID. */
async function requestLook(
  client: TestClient,
  projectId: string,
  holidayId: 'christmas' | 'halloween',
  pipeline: PipelineDeps = harness.pipeline,
): Promise<string> {
  const project = await readProject(client, projectId);
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
  expect((await runRenderJob(pipeline, { renderJobId: jobId })).state).toBe('succeeded');
  return jobId;
}

/** The project's variants, by the job that rendered each. */
async function variantsByJob(client: TestClient, projectId: string) {
  const response = await client.get(`/v1/projects/${projectId}/variants`);
  expect(response.statusCode).toBe(200);
  const items = json<{ items: Variant[] }>(response).items;
  return new Map(items.map((item) => [item.renderJobId, item]));
}

/** The caller's gallery items, by render asset. */
async function galleryById(client: TestClient) {
  const response = await client.get('/v1/gallery?limit=50');
  expect(response.statusCode).toBe(200);
  const items = json<{ items: GalleryItem[] }>(response).items;
  return new Map(items.map((item) => [item.id, item]));
}

/** A job's ledger rows of one stage. */
async function ledgerOf(jobId: string, stage: string) {
  return harness.context.db
    .selectFrom('usageLedger')
    .select(['kind', 'sku', 'reservationId'])
    .where('jobId', '=', jobId)
    .where('stage', '=', stage)
    .orderBy('createdAt')
    .execute();
}

describe('a place that already has looks gets the zoom at its next look', () => {
  it("frames the source at the next look and keeps the first look's wide before", async () => {
    const client = harness.client({ remoteAddress: '10.64.0.1' });
    await client.createSession();
    const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'persist');
    // Before any look the project shows the candidate's view, as the confirmation screen did.
    const candidateUrl = (await readProject(client, project.projectId)).activeSource?.displayUrl;
    expect(candidateUrl).toContain(DISPLAY_URL);

    // The first look is made while the framing is off: from the wide frame, which is stored.
    const firstJob = await requestLook(client, project.projectId, 'christmas', wideOnly());
    const wide = await sourceRow(project.sourceAssetId);
    expect(wide.viewpoint?.framing).toBeUndefined();
    expect(wide.objectKey).not.toBeNull();
    expect(
      (await variantsByJob(client, project.projectId)).get(firstJob)?.beforeImageUrl,
    ).toContain(wide.objectKey!);

    // The next look zooms in on the home and replaces the stored frame.
    const secondJob = await requestLook(client, project.projectId, 'halloween');
    const framed = await sourceRow(project.sourceAssetId);
    expect(framed.viewpoint?.framing?.status).toBe('framed');
    expect(framed.objectKey).toBe(wide.objectKey);
    expect(framed.checksumSha256).not.toBe(wide.checksumSha256);

    // The first look's before is the wide view it was made from; the second look's is the
    // stored framed frame.
    const variants = await variantsByJob(client, project.projectId);
    const first = variants.get(firstJob);
    const second = variants.get(secondJob);
    expect(first?.beforeImageUrl).toBe(candidateUrl);
    expect(first?.beforeImageUrl).toContain(`fov=${wide.viewpoint!.fov.toFixed(1)}`);
    expect(second?.beforeImageUrl).toContain(framed.objectKey!);
    expect(second?.beforeImageUrl).not.toContain(DISPLAY_URL);
    // The render status of the first look says the same.
    const status = json<{ variant: Variant | null }>(await client.get(`/v1/renders/${firstJob}`));
    expect(status.variant?.beforeImageUrl).toBe(candidateUrl);

    // The gallery has no before for the first look and the stored framed frame for the second.
    const gallery = await galleryById(client);
    expect(gallery.get(first!.renderAssetId)?.beforeImageUrl).toBeNull();
    expect(gallery.get(second!.renderAssetId)?.beforeImageUrl).toContain(framed.objectKey!);

    // The project shows the stored framed frame.
    const shown = (await readProject(client, project.projectId)).activeSource?.displayUrl;
    expect(shown).toContain(framed.objectKey!);
  });

  it('settles the analysis and the enhancement the next look made without a reservation', async () => {
    const client = harness.client({ remoteAddress: '10.64.0.2' });
    await client.createSession();
    const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'persist');
    const firstJob = await requestLook(client, project.projectId, 'christmas', wideOnly());
    // The first look analyzed and enhanced the wide frame.
    expect((await ledgerOf(firstJob, 'analyzing')).map((row) => row.kind)).toContain('settlement');
    expect((await ledgerOf(firstJob, 'enhancing')).map((row) => row.kind)).toContain('settlement');

    const secondJob = await requestLook(client, project.projectId, 'halloween');
    expect((await sourceRow(project.sourceAssetId)).viewpoint?.framing?.status).toBe('framed');
    // Admission found an analysis since the frame was fetched and a decided enhancement of the
    // stored frame, so it reserved neither; the framed frame was analyzed and enhanced again and
    // each call was charged directly, and the look succeeded.
    const analysis = await ledgerOf(secondJob, 'analyzing');
    expect(analysis.filter((row) => row.kind === 'reservation')).toEqual([]);
    expect(analysis).toContainEqual({ kind: 'charge', sku: 'vision_call', reservationId: null });
    const enhancement = await ledgerOf(secondJob, 'enhancing');
    expect(enhancement.filter((row) => row.kind === 'reservation')).toEqual([]);
    expect(enhancement).toContainEqual({
      kind: 'charge',
      sku: 'image_edit_attempt',
      reservationId: null,
    });
    const job = await harness.context.db
      .selectFrom('renderJobs')
      .select(['state', 'enhancement'])
      .where('id', '=', secondJob)
      .executeTakeFirstOrThrow();
    expect(job.state).toBe('succeeded');
    expect(job.enhancement).toMatchObject({ outcome: expect.stringMatching(/made|rejected/) });
    expect(await openReservations(harness.context.db, secondJob)).toEqual([]);
  });

  it('leaves the looks and the picture of a source kept wide unchanged', async () => {
    const client = harness.client({ remoteAddress: '10.64.0.4' });
    await client.createSession();
    // A place whose home already fills its frame: its framing is recorded `kept`.
    const project = await adoptStreetViewProject(
      harness,
      client,
      'ChIJfxLanternHillColonial01',
      'persist',
    );
    const candidateUrl = (await readProject(client, project.projectId)).activeSource?.displayUrl;
    expect(candidateUrl).toContain(DISPLAY_URL);
    const firstJob = await requestLook(client, project.projectId, 'christmas', wideOnly());
    const secondJob = await requestLook(client, project.projectId, 'halloween');
    const kept = await sourceRow(project.sourceAssetId);
    expect(kept.viewpoint?.framing).toMatchObject({ status: 'kept', reason: 'small_gain' });
    expect(kept.objectKey).not.toBeNull();

    // The first look was made before the framing was recorded; both looks keep the stored frame
    // as their before, and the project keeps the candidate's view.
    const variants = await variantsByJob(client, project.projectId);
    const first = variants.get(firstJob);
    expect(Date.parse(first!.createdAt)).toBeLessThan(
      Date.parse(kept.viewpoint?.framing?.framedAt ?? ''),
    );
    for (const variant of [first, variants.get(secondJob)]) {
      expect(variant?.beforeImageUrl).toContain(kept.objectKey!);
      expect(variant?.beforeImageUrl).not.toContain(DISPLAY_URL);
    }
    expect((await galleryById(client)).get(first!.renderAssetId)?.beforeImageUrl).toContain(
      kept.objectKey!,
    );
    expect((await readProject(client, project.projectId)).activeSource?.displayUrl).toBe(
      candidateUrl,
    );
  });

  it('leaves a source framed at its first look unchanged', async () => {
    const client = harness.client({ remoteAddress: '10.64.0.3' });
    await client.createSession();
    const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, 'persist');
    const jobId = await requestLook(client, project.projectId, 'christmas');
    const framed = await sourceRow(project.sourceAssetId);
    expect(framed.viewpoint?.framing?.status).toBe('framed');
    const variant = (await variantsByJob(client, project.projectId)).get(jobId);
    expect(variant?.beforeImageUrl).toContain(framed.objectKey!);
    expect(variant?.beforeImageUrl).not.toContain(DISPLAY_URL);
    expect((await galleryById(client)).get(variant!.renderAssetId)?.beforeImageUrl).toContain(
      framed.objectKey!,
    );
  });
});

describe('the review queue shows a held look beside the picture it was made from', () => {
  interface ReviewItem {
    renderJobId: string;
    sourceUrl: string | null;
  }

  async function reviewItem(jobId: string): Promise<ReviewItem> {
    const response = await operator.get('/internal/v1/reviews?limit=100');
    expect(response.statusCode).toBe(200);
    const item = json<{ items: ReviewItem[] }>(response).items.find(
      (entry) => entry.renderJobId === jobId,
    );
    if (!item) throw new Error(`job ${jobId} is not in the review queue`);
    return item;
  }

  async function heldJob(made: Awaited<ReturnType<typeof createStreetViewSource>>) {
    const job = await createRenderJobRecord(harness.pipeline, {
      ...made,
      source: await sourceRow(made.source.id),
      reviewMode: 'pre_delivery',
    });
    await harness.context.db
      .updateTable('renderJobs')
      .set({ state: 'needs_review' })
      .where('id', '=', job.id)
      .execute();
    return job;
  }

  /** The database's clock, which stamps a job's `created_at`. */
  async function databaseNow(): Promise<Date> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await sql<{ at: Date | string }>`select clock_timestamp() as at`.execute(
      harness.context.db,
    );
    return new Date(result.rows[0]!.at);
  }

  async function endJob(jobId: string) {
    await harness.context.db
      .updateTable('renderJobs')
      .set({ state: 'canceled', terminalAt: new Date() })
      .where('id', '=', jobId)
      .execute();
  }

  it('the wide view for a look held before the framing, the stored frame after it', async () => {
    const made = await createStreetViewSource(harness.pipeline, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const first = await createRenderJobRecord(wideOnly(), made);
    expect((await runRenderJob(wideOnly(), { renderJobId: first.id })).state).toBe('succeeded');
    const wide = await sourceRow(made.source.id);
    expect(wide.objectKey).not.toBeNull();

    // A look held for review, then a framing recorded on the source after it.
    const before = await heldJob(made);
    const framedAt = await databaseNow();
    await harness.context.db
      .updateTable('sourceAssets')
      .set({
        viewpoint: toJson({
          ...wide.viewpoint!,
          framing: {
            status: 'framed',
            heading: wide.viewpoint!.heading,
            pitch: wide.viewpoint!.pitch,
            fov: wide.viewpoint!.fov / 2,
            box: [0.3, 0.2, 0.7, 0.8],
            zoom: 2,
            promptVersion: 'frame-2026.11.0',
            model: 'test',
            framedAt: framedAt.toISOString(),
          },
        }),
      })
      .where('id', '=', made.source.id)
      .execute();
    const held = await reviewItem(before.id);
    expect(held.sourceUrl).toContain(DISPLAY_URL);
    expect(held.sourceUrl).toContain(`fov=${wide.viewpoint!.fov.toFixed(1)}`);
    expect(held.sourceUrl).not.toContain(
      `fov=${framedViewOf((await sourceRow(made.source.id)).viewpoint!).fov.toFixed(1)}`,
    );
    await endJob(before.id);

    // A look held after the framing is shown beside the stored frame.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await heldJob(made);
    expect(after.createdAt.getTime()).toBeGreaterThan(framedAt.getTime());
    expect((await reviewItem(after.id)).sourceUrl).toContain(wide.objectKey!);
    await endJob(after.id);
  });

  it('the stored framed frame for a look held by the job that framed its source', async () => {
    const made = await createStreetViewSource(harness.pipeline, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(harness.pipeline, {
      ...made,
      reviewMode: 'pre_delivery',
    });
    expect((await runRenderJob(harness.pipeline, { renderJobId: job.id })).state).toBe(
      'needs_review',
    );
    const framed = await sourceRow(made.source.id);
    expect(framed.viewpoint?.framing?.status).toBe('framed');
    // The job was created before the framing it recorded; its held look was made after it.
    expect(job.createdAt.getTime()).toBeLessThan(
      Date.parse(framed.viewpoint?.framing?.framedAt ?? ''),
    );
    const item = await reviewItem(job.id);
    expect(item.sourceUrl).toContain(framed.objectKey!);
    expect(item.sourceUrl).not.toContain(DISPLAY_URL);
    await endJob(job.id);
  });
});
