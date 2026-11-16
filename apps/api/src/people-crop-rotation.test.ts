import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreateUploadResponseSchema, type Project } from '@hailiday/core';
import { renderFixturePanorama } from '@hailiday/server/fixtures';
import {
  createCroppedChild,
  fixturePlace,
  screenUpload,
  validateUpload,
} from '@hailiday/server/pipeline';
import type * as Pipeline from '@hailiday/server/pipeline';
import { createHarness, type Harness, type TestClient } from './test/harness.js';

vi.mock('@hailiday/server/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof Pipeline>();
  return { ...actual, createCroppedChild: vi.fn(actual.createCroppedChild) };
});

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
  const pano = fixturePlace('ChIJfxBirchfieldPikeFarmh04').panoramas[0];
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

/** Uploads the photo under a name that makes the fixture screening detect people. */
async function uploadWithPeople(): Promise<string> {
  const response = await client.post('/v1/uploads', {
    projectId: project.id,
    contentType: 'image/jpeg',
    byteLength: photo.length,
    clientPrepared: true,
    attestation,
    fileName: 'people-on-the-steps.jpg',
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

describe('people crop with straightening', () => {
  it('passes the straighten rotation through to the server crop, and none when absent', async () => {
    const sourceAssetId = await uploadWithPeople();
    const crop = vi.mocked(createCroppedChild);
    crop.mockClear();

    await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: project.projectVersion,
      sourceAssetId,
      sceneType: 'house_exterior',
      peopleResolution: { action: 'crop', box: [0, 0, 1, 1], rotation: 7 },
    });
    expect(crop).toHaveBeenCalledTimes(1);
    expect(crop.mock.calls[0]?.[1]).toMatchObject({ box: [0, 0, 1, 1], rotation: 7 });

    crop.mockClear();
    await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: project.projectVersion,
      sourceAssetId,
      sceneType: 'house_exterior',
      peopleResolution: { action: 'crop', box: [0, 0, 1, 1] },
    });
    expect(crop).toHaveBeenCalledTimes(1);
    expect(crop.mock.calls[0]?.[1]).not.toHaveProperty('rotation');
  });
});
