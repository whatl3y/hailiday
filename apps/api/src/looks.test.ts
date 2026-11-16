import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateUploadResponseSchema,
  QueuedRenderResponseSchema,
  VariantListResponseSchema,
  type Project,
} from '@hailiday/core';
import { renderFixturePanorama } from '@hailiday/server/fixtures';
import { fixturePlace, screenUpload, validateUpload } from '@hailiday/server/pipeline';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';

/** This file's own client address, so its render jobs stay off other files' IP backstop. */
const FILE_ADDRESS = '10.78.0.1';

const ALL_STYLES = ['subtle', 'classic', 'abundant'];
const OUTDOORS = {
  styles: ALL_STYLES,
  defaultStyle: 'abundant',
  lightingModes: ['source', 'evening'],
  defaultLightingMode: 'evening',
};
/** An exterior photo the analysis found at dusk: only the photo's own light is offered. */
const AS_PHOTOGRAPHED = {
  styles: ALL_STYLES,
  defaultStyle: 'abundant',
  lightingModes: ['source'],
  defaultLightingMode: 'source',
};
const BRIGHT = {
  styles: ALL_STYLES,
  defaultStyle: 'abundant',
  lightingModes: ['bright'],
  defaultLightingMode: 'bright',
};

const attestation = { accepted: true, attestationVersion: 'upload-attestation-2026-11' };

let harness: Harness;
let photo: Buffer;

beforeAll(async () => {
  harness = await createHarness();
  const place = fixturePlace('ChIJfxBirchfieldPikeFarmh04');
  const pano = place.panoramas[0];
  const rendered = await renderFixturePanorama({
    panoId: pano?.panoId ?? '',
    heading: pano?.headingDeg ?? 0,
    fov: 75,
    pitch: 5,
    width: 640,
    height: 640,
  });
  if (!rendered) throw new Error('fixture photo missing');
  photo = rendered.image;
});

afterAll(async () => {
  await harness?.close();
});

async function newClient(): Promise<TestClient> {
  const client = harness.client({ remoteAddress: FILE_ADDRESS });
  await client.createSession();
  return client;
}

/** Presigns, stores and completes an upload, then runs its validation and screening. */
async function upload(client: TestClient, projectId: string): Promise<string> {
  const response = await client.post('/v1/uploads', {
    projectId,
    contentType: 'image/jpeg',
    byteLength: photo.length,
    clientPrepared: true,
    attestation,
    fileName: 'my-photo.jpg',
  });
  expect(response.statusCode).toBe(201);
  const created = CreateUploadResponseSchema.parse(response.json());
  const form = new FormData();
  for (const [key, value] of Object.entries(created.upload.fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'photo.jpg');
  const stored = await fetch(created.upload.url, { method: 'POST', body: form });
  expect(stored.status).toBeLessThan(300);
  const completed = await client.post(`/v1/uploads/${created.sourceAssetId}/complete`, {});
  expect(completed.statusCode).toBe(202);
  await validateUpload(harness.pipeline, { sourceAssetId: created.sourceAssetId });
  await screenUpload(harness.pipeline, { sourceAssetId: created.sourceAssetId });
  return created.sourceAssetId;
}

async function bind(
  client: TestClient,
  project: Project,
  body: Record<string, unknown>,
): Promise<Project> {
  const response = await client.put(`/v1/projects/${project.id}/source`, {
    projectVersion: project.projectVersion,
    ...body,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { project: Project }).project;
}

async function resolve(client: TestClient, placeId: string, holidayId: string): Promise<Project> {
  const response = await client.post('/v1/addresses/resolve', {
    placeId,
    sessionToken: await placesTokenForClient(harness, client),
    holidayId,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { project: Project }).project;
}

async function discover(client: TestClient, project: Project): Promise<Project> {
  const response = await client.post(`/v1/projects/${project.id}/source-discovery`, {
    projectVersion: project.projectVersion,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { project: Project }).project;
}

describe('starting looks', () => {
  it('starts every address project abundant in the evening, Thanksgiving included', async () => {
    for (const holidayId of ['christmas', 'thanksgiving_us']) {
      const client = await newClient();
      const created = await resolve(client, 'ChIJfxLanternHillColonial01', holidayId);
      expect(created).toMatchObject({
        holidayId,
        sceneType: 'house_exterior',
        style: 'abundant',
        lightingMode: 'evening',
      });
      const project = await discover(client, created);
      expect(project.activeSource?.kind).toBe('street_view');
      expect(project.offered).toEqual(OUTDOORS);

      // The Thanksgiving exterior evening cell is offered: the request is admitted.
      if (holidayId === 'thanksgiving_us') {
        const response = await client.post(
          '/v1/renders',
          {
            projectId: project.id,
            projectVersion: project.projectVersion,
            holidayId,
            style: 'abundant',
            lightingMode: 'evening',
          },
          { 'idempotency-key': randomUUID() },
        );
        expect(response.statusCode).toBe(202);
        expect(QueuedRenderResponseSchema.parse(response.json()).cached).toBe(false);
      }
    }
  });

  it('starts an upload project from its scene type and holiday', async () => {
    const client = await newClient();
    const cases = [
      { sceneType: undefined, holidayId: 'christmas', look: ['abundant', 'source'], offered: null },
      { sceneType: 'interior', holidayId: 'christmas', look: ['abundant', 'bright'] },
      { sceneType: 'apartment_entry', holidayId: 'halloween', look: ['abundant', 'bright'] },
      { sceneType: 'balcony', holidayId: 'thanksgiving_us', look: ['abundant', 'evening'] },
      { sceneType: 'house_exterior', holidayId: 'christmas', look: ['abundant', 'evening'] },
    ] as const;
    for (const entry of cases) {
      const response = await client.post('/v1/projects', {
        kind: 'upload',
        holidayId: entry.holidayId,
        ...(entry.sceneType ? { sceneType: entry.sceneType } : {}),
      });
      expect(response.statusCode).toBe(201);
      const project = (response.json() as { project: Project }).project;
      expect([project.style, project.lightingMode]).toEqual(entry.look);
      if ('offered' in entry) expect(project.offered).toBeNull();
      else expect(project.offered).toEqual(entry.look[1] === 'evening' ? OUTDOORS : BRIGHT);
    }
  });

  it('resets the look when the scene type changes; indoors only the bright look is offered', async () => {
    const client = await newClient();
    const created = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
    let project = (created.json() as { project: Project }).project;
    const sourceAssetId = await upload(client, project.id);

    project = await bind(client, project, {
      sourceAssetId,
      sceneType: 'house_exterior',
      buildingForm: 'detached',
    });
    expect(project).toMatchObject({
      style: 'abundant',
      lightingMode: 'evening',
      offered: OUTDOORS,
    });

    // A look the person chose stays while the scene type stays the same.
    await harness.context.db
      .updateTable('projects')
      .set({ style: 'classic', lightingMode: 'source' })
      .where('id', '=', project.id)
      .execute();
    project = await bind(client, project, {
      sourceAssetId,
      sceneType: 'house_exterior',
      buildingForm: 'attached',
    });
    expect(project).toMatchObject({ buildingForm: 'attached', style: 'classic' });
    expect(project.lightingMode).toBe('source');

    // Another scene type starts again from its own default look.
    project = await bind(client, project, {
      sourceAssetId,
      sceneType: 'interior',
      roomType: 'living_room',
    });
    expect(project).toMatchObject({
      sceneType: 'interior',
      style: 'abundant',
      lightingMode: 'bright',
      offered: BRIGHT,
    });

    // Indoors, neither the photo's own light nor evening is an offered cell.
    for (const lightingMode of ['evening', 'source']) {
      const refused = await client.post(
        '/v1/renders',
        {
          projectId: project.id,
          projectVersion: project.projectVersion,
          holidayId: 'christmas',
          style: 'abundant',
          lightingMode,
        },
        { 'idempotency-key': randomUUID() },
      );
      expect(refused.statusCode, lightingMode).toBe(400);
      expect(json(refused).error, lightingMode).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'content_cell_not_offered' },
      });
    }

    project = await bind(client, project, {
      sourceAssetId,
      sceneType: 'balcony',
    });
    expect(project).toMatchObject({
      style: 'abundant',
      lightingMode: 'evening',
      offered: OUTDOORS,
    });

    // Outdoors the bright look is not offered.
    const bright = await client.post(
      '/v1/renders',
      {
        projectId: project.id,
        projectVersion: project.projectVersion,
        holidayId: 'christmas',
        style: 'abundant',
        lightingMode: 'bright',
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(bright.statusCode).toBe(400);
    expect(json(bright).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'content_cell_not_offered' },
    });
  });

  it('admits the bright look of an interior and reserves its base, its repair and the relight', async () => {
    const client = await newClient();
    const created = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
    let project = (created.json() as { project: Project }).project;
    const sourceAssetId = await upload(client, project.id);
    project = await bind(client, project, {
      sourceAssetId,
      sceneType: 'interior',
      roomType: 'living_room',
    });
    expect(project.offered).toEqual(BRIGHT);
    const response = await client.post(
      '/v1/renders',
      {
        projectId: project.id,
        projectVersion: project.projectVersion,
        holidayId: 'christmas',
        style: 'abundant',
        lightingMode: 'bright',
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(response.statusCode).toBe(202);
    const queued = QueuedRenderResponseSchema.parse(response.json());
    expect(queued.cached).toBe(false);
    const reserved = await harness.context.db
      .selectFrom('usageLedger')
      .select(['sku', 'stage'])
      .where('jobId', '=', queued.renderJobId)
      .where('kind', '=', 'reservation')
      .execute();
    const count = (sku: string, stage: string) =>
      reserved.filter((row) => row.sku === sku && row.stage === stage).length;
    // Its base, the relight and one repair of either: three edits, and for each a judge and an
    // escalation.
    expect(count('image_edit_attempt', 'rendering')).toBe(3);
    expect(count('vision_call', 'localizing')).toBe(2);
    expect(count('vision_call', 'checking')).toBe(6);
    const job = await harness.context.db
      .selectFrom('renderJobs')
      .select(['lightingMode', 'variantKey'])
      .where('id', '=', queued.renderJobId)
      .executeTakeFirstOrThrow();
    expect(job.lightingMode).toBe('bright');
    expect(job.variantKey).toContain('|bright|');

    // The worker renders it: one bright variant, no daylight companion, one look of allowance.
    expect(await harness.completeRender(queued.renderJobId)).toBe('succeeded');
    const list = VariantListResponseSchema.parse(
      (await client.get(`/v1/projects/${project.id}/variants`)).json(),
    );
    expect(list.items.map((item) => [item.style, item.lightingMode])).toEqual([
      ['abundant', 'bright'],
    ]);
    expect(list.offered).toEqual(BRIGHT);
    const after = (await client.get(`/v1/projects/${project.id}`)).json() as { project: Project };
    expect(after.project.variantCount).toBe(1);
    expect(after.project.allowance.variants.remaining).toBe(
      project.allowance.variants.remaining - 1,
    );
  });

  it('delivers the first evening look of a dusk photo as photographed, then offers it only', async () => {
    const client = await newClient();
    const created = await resolve(client, 'ChIJfxOrchardBluffColonia11', 'christmas');
    const project = await discover(client, created);
    expect(project.offered).toEqual(OUTDOORS);
    const response = await client.post(
      '/v1/renders',
      {
        projectId: project.id,
        projectVersion: project.projectVersion,
        holidayId: 'christmas',
        style: project.offered?.defaultStyle,
        lightingMode: project.offered?.defaultLightingMode,
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(response.statusCode).toBe(202);
    const queued = QueuedRenderResponseSchema.parse(response.json());
    expect(await harness.completeRender(queued.renderJobId)).toBe('succeeded');

    const list = VariantListResponseSchema.parse(
      (await client.get(`/v1/projects/${project.id}/variants`)).json(),
    );
    expect(list.items.map((item) => [item.style, item.lightingMode])).toEqual([
      ['abundant', 'evening'],
    ]);
    // The analysis found dusk light: evening is no longer offered and the default is the photo's.
    expect(list.offered).toEqual(AS_PHOTOGRAPHED);
    const after = (await client.get(`/v1/projects/${project.id}`)).json() as { project: Project };
    expect(after.project.variantCount).toBe(1);
    expect(after.project.allowance.variants.remaining).toBe(
      project.allowance.variants.remaining - 1,
    );
  });
});
