import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateUploadResponseSchema, UploadStatusSchema, type Project } from '@holiday/core';
import { renderFixturePanorama } from '@holiday/server/fixtures';
import { fixturePlace, screenUpload, validateUpload } from '@holiday/server/pipeline';
import { UPLOAD_BYTES_PER_OWNER_24H } from '@holiday/server/limits';
import { keys } from '@holiday/server/storage';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';

let harness: Harness;
let client: TestClient;
let project: Project;
let photo: Buffer;

const attestation = { accepted: true, attestationVersion: 'upload-attestation-2026-11' };

beforeAll(async () => {
  harness = await createHarness();
  client = harness.client();
  await client.createSession();
  const created = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
  expect(created.statusCode).toBe(201);
  project = (created.json() as { project: Project }).project;
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

/** Presigns, posts the bytes to storage like the browser does, and completes the upload. */
async function upload(fileName: string): Promise<string> {
  const response = await client.post('/v1/uploads', {
    projectId: project.id,
    contentType: 'image/jpeg',
    byteLength: photo.length,
    clientPrepared: true,
    attestation,
    fileName,
  });
  expect(response.statusCode).toBe(201);
  const created = CreateUploadResponseSchema.parse(response.json());
  expect(created.state).toBe('pending_upload');
  expect(created.upload.fields.key).toBe(`quarantine/${created.sourceAssetId}`);
  const form = new FormData();
  for (const [key, value] of Object.entries(created.upload.fields)) form.append(key, value);
  form.append('file', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'photo.jpg');
  const stored = await fetch(created.upload.url, { method: 'POST', body: form });
  expect(stored.status).toBeLessThan(300);

  const completed = await client.post(`/v1/uploads/${created.sourceAssetId}/complete`, {});
  expect(completed.statusCode).toBe(202);
  expect(json(completed)).toMatchObject({ state: 'quarantined' });
  const repeat = await client.post(`/v1/uploads/${created.sourceAssetId}/complete`, {});
  expect(repeat.statusCode).toBe(202);
  const job = await harness.context.queue.boss.findJobs('upload_validate', {
    key: created.sourceAssetId,
  });
  expect(job.length).toBe(1);
  await validateUpload(harness.pipeline, { sourceAssetId: created.sourceAssetId });
  await screenUpload(harness.pipeline, { sourceAssetId: created.sourceAssetId });
  return created.sourceAssetId;
}

describe('uploads', () => {
  it('refuses unsupported types and oversized files before presigning', async () => {
    const heic = await client.post('/v1/uploads', {
      projectId: project.id,
      contentType: 'image/heic',
      byteLength: 1000,
      clientPrepared: false,
      attestation,
    });
    expect(heic.statusCode).toBe(415);
    expect(json(heic).error).toMatchObject({ code: 'UPLOAD_UNSUPPORTED_FORMAT' });
    const huge = await client.post('/v1/uploads', {
      projectId: project.id,
      contentType: 'image/png',
      byteLength: 500 * 1024 * 1024,
      clientPrepared: false,
      attestation,
    });
    expect(huge.statusCode).toBe(413);
    const incomplete = await client.post('/v1/uploads', {
      projectId: project.id,
      contentType: 'image/jpeg',
      byteLength: 1000,
      clientPrepared: false,
      attestation,
    });
    const id = json(incomplete).sourceAssetId as string;
    const complete = await client.post(`/v1/uploads/${id}/complete`, {});
    expect(complete.statusCode).toBe(400);
    expect(json(complete).error).toMatchObject({ details: { reason: 'upload_incomplete' } });
  });

  it('presigns, completes, screens and binds an upload as the project source', async () => {
    const sourceAssetId = await upload('front-of-house.jpg');
    const status = UploadStatusSchema.parse(
      (await client.get(`/v1/uploads/${sourceAssetId}`)).json(),
    );
    expect(status).toMatchObject({ state: 'ready', detectedFormat: 'jpeg', holdForReview: false });
    expect(status.width).toBe(640);

    const bound = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: 0,
      sourceAssetId,
      sceneType: 'house_exterior',
      buildingForm: 'detached',
    });
    expect(bound.statusCode).toBe(200);
    const updated = (bound.json() as { project: Project }).project;
    expect(updated.projectVersion).toBe(1);
    expect(updated.activeSource).toMatchObject({ kind: 'upload', sourceAssetId, sourceMode: null });
    expect(updated.activeSource?.displayUrl).toContain('X-Amz-Signature');
    expect(updated.offered?.lightingModes).toContain('source');
    project = updated;
  });

  it('asks for a people resolution and keeps the photo private on keep', async () => {
    const sourceAssetId = await upload('people-on-porch.jpg');
    const status = UploadStatusSchema.parse(
      (await client.get(`/v1/uploads/${sourceAssetId}`)).json(),
    );
    expect(status.people.detected).toBe(true);
    const refused = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: project.projectVersion,
      sourceAssetId,
      sceneType: 'house_exterior',
    });
    expect(refused.statusCode).toBe(409);
    expect(json(refused).error).toMatchObject({
      code: 'PEOPLE_DETECTED',
      details: { permittedActions: ['crop', 'keep', 'replace'] },
    });
    const tooSmall = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: project.projectVersion,
      sourceAssetId,
      sceneType: 'house_exterior',
      peopleResolution: { action: 'crop', box: [0, 0, 0.5, 1] },
    });
    expect(tooSmall.statusCode).toBe(400);
    expect(json(tooSmall).error).toMatchObject({ details: { reason: 'image_too_small' } });
    const kept = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: project.projectVersion,
      sourceAssetId,
      sceneType: 'house_exterior',
      peopleResolution: { action: 'keep' },
    });
    expect(kept.statusCode).toBe(200);
    expect((kept.json() as { project: Project }).project.activeSource?.privateOnly).toBe(true);
  });

  it('reports declined uploads with their guidance reason', async () => {
    const sourceAssetId = await upload('decline-this.jpg');
    const status = UploadStatusSchema.parse(
      (await client.get(`/v1/uploads/${sourceAssetId}`)).json(),
    );
    expect(status).toMatchObject({
      state: 'declined',
      declineCode: 'UPLOAD_DECLINED',
      declineReasonClass: 'guidance',
      declineReason: 'not_a_living_space',
    });
    const current = (await client.get(`/v1/projects/${project.id}`)).json() as { project: Project };
    const bind = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: current.project.projectVersion,
      sourceAssetId,
      sceneType: 'interior',
    });
    expect(bind.statusCode).toBe(422);
    expect(json(bind).error).toMatchObject({ code: 'UPLOAD_DECLINED' });
  });

  it('presigns for the declared length and refuses bytes beyond it at complete', async () => {
    const response = await client.post('/v1/uploads', {
      projectId: project.id,
      contentType: 'image/jpeg',
      byteLength: 1000,
      clientPrepared: true,
      attestation,
    });
    expect(response.statusCode).toBe(201);
    const created = CreateUploadResponseSchema.parse(response.json());
    expect(created.upload.maxBytes).toBe(1000);
    // Bytes that bypass the policy (larger than declared) are discarded and refused.
    await harness.context.storage.put({
      bucket: 'private',
      key: keys.quarantine(created.sourceAssetId),
      body: photo,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    expect(photo.length).toBeGreaterThan(1000);
    const complete = await client.post(`/v1/uploads/${created.sourceAssetId}/complete`, {});
    expect(complete.statusCode).toBe(413);
    expect(json(complete).error).toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
    expect(
      await harness.context.storage.head('private', keys.quarantine(created.sourceAssetId)),
    ).toBeNull();
    const row = await harness.context.db
      .selectFrom('sourceAssets')
      .select(['state', 'originalByteLength'])
      .where('id', '=', created.sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ state: 'pending_upload', originalByteLength: null });
  });

  it('applies the upload byte quota to verified bytes at complete', async () => {
    const other = harness.client();
    await other.createSession();
    const created = await other.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
    const otherProject = (created.json() as { project: Project }).project;
    const response = await other.post('/v1/uploads', {
      projectId: otherProject.id,
      contentType: 'image/jpeg',
      byteLength: photo.length,
      clientPrepared: true,
      attestation,
    });
    const upload = CreateUploadResponseSchema.parse(response.json());
    await harness.context.storage.put({
      bucket: 'private',
      key: keys.quarantine(upload.sourceAssetId),
      body: photo,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    const owner = await harness.context.db
      .selectFrom('sourceAssets')
      .select('ownerId')
      .where('id', '=', upload.sourceAssetId)
      .executeTakeFirstOrThrow();
    // An earlier upload of this owner declared small but verified at the full rolling quota.
    await harness.context.db
      .insertInto('sourceAssets')
      .values({
        id: randomUUID(),
        ownerId: owner.ownerId,
        projectId: otherProject.id,
        kind: 'upload',
        state: 'ready',
        byteLength: 10,
        originalByteLength: UPLOAD_BYTES_PER_OWNER_24H,
        peopleResolution: 'none',
      })
      .execute();
    const complete = await other.post(`/v1/uploads/${upload.sourceAssetId}/complete`, {});
    expect(complete.statusCode).toBe(429);
    expect(json(complete).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'upload_bytes' },
    });
  });

  it('shows reviewers a reduced-size copy of a held upload, never the original', async () => {
    const sourceAssetId = await upload('hold-for-review.jpg');
    const held = await harness.context.db
      .selectFrom('sourceAssets')
      .select(['state', 'holdForReview', 'objectKey', 'screening'])
      .where('id', '=', sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(held).toMatchObject({ state: 'screening', holdForReview: true });
    const { client: operator, csrf } = await operatorClient(harness);
    const list = await operator.get('/internal/v1/upload-holds?limit=100');
    expect(list.statusCode).toBe(200);
    const item = json<{ items: { sourceAssetId: string; imageUrl: string | null }[] }>(
      list,
    ).items.find((entry) => entry.sourceAssetId === sourceAssetId);
    expect(item?.imageUrl).toContain(`/${keys.review(sourceAssetId)}?`);
    expect(item?.imageUrl).not.toContain(String(held.objectKey));
    const image = await fetch(item?.imageUrl ?? '');
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/jpeg');

    const decided = await operator.post(
      `/internal/v1/upload-holds/${sourceAssetId}/decision`,
      { decision: 'approve' },
      { 'x-csrf-token': csrf },
    );
    expect(decided.statusCode).toBe(200);
    expect(await harness.context.storage.head('private', keys.review(sourceAssetId))).toBeNull();
  });
});
