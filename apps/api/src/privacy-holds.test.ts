import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateShareResponseSchema, CreateUploadResponseSchema, type Project } from '@holiday/core';
import { renderFixturePanorama } from '@holiday/server/fixtures';
import { sha256Hex } from '@holiday/server/ids';
import {
  createRenderJobRecord,
  fixturePlace,
  screenUpload,
  validateUpload,
} from '@holiday/server/pipeline';
import { keys } from '@holiday/server/storage';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient, signInSameSession } from './test/operator.js';
import { adoptStreetViewProject, ownerIdOf } from './test/projects.js';

let harness: Harness;
let operator: TestClient;
let csrf: string;

beforeAll(async () => {
  harness = await createHarness();
  ({ client: operator, csrf } = await operatorClient(harness));
});

afterAll(async () => {
  await harness?.close();
});

/** A customer with an address project and one rendered variant. */
async function customerWithVariant(placeId?: string) {
  const client = harness.client();
  await client.createSession();
  const adopted = await adoptStreetViewProject(harness, client, placeId);
  const db = harness.context.db;
  const source = await db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', adopted.sourceAssetId)
    .executeTakeFirstOrThrow();
  const job = await createRenderJobRecord(harness.pipeline, {
    ownerId: source.ownerId,
    projectId: adopted.projectId,
    source,
  });
  expect(await harness.completeRender(job.id)).toBe('succeeded');
  const asset = await db
    .selectFrom('renderAssets')
    .selectAll()
    .where('jobId', '=', job.id)
    .executeTakeFirstOrThrow();
  return { client, projectId: adopted.projectId, jobId: job.id, asset };
}

describe('preservation holds through the API', () => {
  it('a held project answers NOT_FOUND on every render endpoint after deletion', async () => {
    const { client, projectId, jobId, asset } = await customerWithVariant();
    const placed = await operator.post(
      '/internal/v1/preservation-holds',
      {
        targetKind: 'project',
        targetId: projectId,
        reason: 'complaint_investigation',
        authorityRef: 'case-1',
        releaseCondition: 'investigation closed',
      },
      { 'x-csrf-token': csrf },
    );
    expect(placed.statusCode).toBe(201);
    const holdId = json<{ id: string }>(placed).id;
    expect((await client.get(`/v1/renders/${jobId}`)).statusCode).toBe(200);

    const deleted = await client.delete(`/v1/projects/${projectId}`);
    expect(deleted.statusCode).toBe(202);
    expect(json(deleted)).toMatchObject({ status: 'held' });
    expect((await client.get(`/v1/renders/${jobId}`)).statusCode).toBe(404);
    expect((await client.get(`/v1/renders/${jobId}/events`)).statusCode).toBe(404);
    expect((await client.get(`/v1/renders/${jobId}/products`)).statusCode).toBe(404);
    expect((await client.get(`/v1/projects/${projectId}/variants`)).statusCode).toBe(404);
    // The held output is still stored. Street View-derived pixels are protected in place (the
    // storage client writes them only under an evaluated permission), and the hold records them.
    expect(await harness.context.storage.head('private', asset.objectKey)).not.toBeNull();
    const holdRow = await harness.context.db
      .selectFrom('preservationHolds')
      .select('heldObjects')
      .where('id', '=', holdId)
      .executeTakeFirstOrThrow();
    expect(holdRow.heldObjects).toContainEqual({
      bucket: 'private',
      originalKeyHash: sha256Hex(asset.objectKey),
      heldKey: null,
      inPlace: true,
    });
  });

  it('triage places a hold that covers the reported variant and its source', async () => {
    const { asset } = await customerWithVariant();
    const reporter = harness.client();
    await reporter.createSession();
    const report = await reporter.post('/v1/reports', {
      target: { kind: 'render', id: asset.id },
      reason: 'harmful_or_offensive',
    });
    expect(report.statusCode).toBe(201);
    const reportId = json<{ reportId: string }>(report).reportId;
    const triaged = await operator.post(
      `/internal/v1/reports/${reportId}/triage`,
      { status: 'triaged', resolution: { action: 'preservation_hold' } },
      { 'x-csrf-token': csrf },
    );
    expect(triaged.statusCode).toBe(200);
    const db = harness.context.db;
    const row = await db
      .selectFrom('reports')
      .select('preservationHoldId')
      .where('id', '=', reportId)
      .executeTakeFirstOrThrow();
    expect(row.preservationHoldId).not.toBeNull();
    const variant = await db
      .selectFrom('renderAssets')
      .select('preservationHoldId')
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    const source = await db
      .selectFrom('sourceAssets')
      .select('preservationHoldId')
      .where('id', '=', asset.sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(variant.preservationHoldId).toBe(row.preservationHoldId);
    expect(source.preservationHoldId).toBe(row.preservationHoldId);
  });

  it('repeating DELETE completes a deletion that did not finish', async () => {
    const { client, projectId, asset } = await customerWithVariant();
    const db = harness.context.db;
    const requestId = randomUUID();
    const ownerId = await ownerIdOf(harness, client);
    await db
      .insertInto('deletionRequests')
      .values({
        id: requestId,
        ownerId,
        scope: 'project',
        targetId: projectId,
        requestedBy: 'user',
        accessRevokedAt: new Date(),
        status: 'in_progress',
      })
      .execute();
    await db
      .updateTable('projects')
      .set({ deletedAt: new Date() })
      .where('id', '=', projectId)
      .execute();
    const repeated = await client.delete(`/v1/projects/${projectId}`);
    expect(repeated.statusCode).toBe(202);
    expect(json(repeated)).toEqual({ deletionRequestId: requestId, status: 'completed' });
    expect(
      await db.selectFrom('projects').select('id').where('id', '=', projectId).executeTakeFirst(),
    ).toBeUndefined();
    expect(await harness.context.storage.head('private', asset.objectKey)).toBeNull();
  });
});

describe('homeowner opt-out', () => {
  it('blocks the place, purges every owner’s variants of it, confirms once and keeps only a hash', async () => {
    const placeId = 'ChIJfxHearthstoneLaneColo13';
    const { asset } = await customerWithVariant(placeId);
    const homeowner = harness.client();
    await homeowner.createSession();
    const email = `Homeowner-${randomUUID().slice(0, 8)}@Example.com`;
    const submitted = await homeowner.post('/v1/reports', {
      target: { kind: 'address', placeId, addressText: '13 Hearthstone Lane' },
      reason: 'this_is_my_home',
      requestOptOut: true,
      contactEmail: email,
    });
    expect(submitted.statusCode).toBe(201);
    const reportId = json<{ reportId: string }>(submitted).reportId;
    const triaged = await operator.post(
      `/internal/v1/reports/${reportId}/triage`,
      { status: 'actioned', resolution: { action: 'block_address' } },
      { 'x-csrf-token': csrf },
    );
    expect(triaged.statusCode).toBe(200);

    const db = harness.context.db;
    const hash = sha256Hex(email.trim().toLowerCase());
    const blocked = await db
      .selectFrom('blockedAddresses')
      .select(['source', 'requesterContactHash'])
      .where('placeId', '=', placeId)
      .executeTakeFirstOrThrow();
    expect(blocked).toEqual({ source: 'homeowner_request', requesterContactHash: hash });
    const report = await db
      .selectFrom('reports')
      .select(['reporterContactEmail', 'addressText'])
      .where('id', '=', reportId)
      .executeTakeFirstOrThrow();
    expect(report).toEqual({ reporterContactEmail: hash, addressText: null });
    const sent = harness.email.outbox.filter((message) => message.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('https://www.google.com/streetview/privacy/');
    expect(sent[0]?.text).not.toContain('Hearthstone');

    const variant = await db
      .selectFrom('renderAssets')
      .select(['withdrawnAt', 'deletedAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(variant.withdrawnAt).not.toBeNull();
    expect(variant.deletedAt).not.toBeNull();
    expect(await harness.context.storage.head('private', asset.objectKey)).toBeNull();
  });
});

describe('sharing privacy', () => {
  it('revoking a share purges the CDN paths of its public copies', async () => {
    const { client, asset } = await customerWithVariant();
    const created = await client.post(
      '/v1/shares',
      { renderAssetId: asset.id, includeBefore: false },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.statusCode).toBe(201);
    const { token } = CreateShareResponseSchema.parse(created.json());
    const revoked = await client.delete(`/v1/shares/${token}`);
    expect(revoked.statusCode).toBe(204);
    const purged = (harness.context.storage.cdn as unknown as { purged: string[] }).purged;
    expect(purged).toEqual(expect.arrayContaining([keys.card(token), keys.shared(token, 'after')]));
  });

  it('keeping people in a photo makes existing variants private and revokes their shares', async () => {
    const client = harness.client();
    await client.createSession();
    const createdProject = await client.post('/v1/projects', {
      kind: 'upload',
      holidayId: 'christmas',
    });
    let project = json<{ project: Project }>(createdProject).project;
    const pano = fixturePlace('ChIJfxBirchfieldPikeFarmh04').panoramas[0];
    const rendered = await renderFixturePanorama({
      panoId: pano?.panoId ?? '',
      heading: pano?.headingDeg ?? 0,
      fov: 75,
      pitch: 5,
      width: 640,
      height: 640,
    });
    const photo = rendered?.image ?? Buffer.alloc(0);
    const upload = await client.post('/v1/uploads', {
      projectId: project.id,
      contentType: 'image/jpeg',
      byteLength: photo.length,
      clientPrepared: true,
      attestation: { accepted: true, attestationVersion: 'upload-attestation-2026-11' },
      fileName: 'front-of-house.jpg',
    });
    expect(upload.statusCode).toBe(201);
    const created = CreateUploadResponseSchema.parse(upload.json());
    const form = new FormData();
    for (const [key, value] of Object.entries(created.upload.fields)) form.append(key, value);
    form.append('file', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'photo.jpg');
    expect((await fetch(created.upload.url, { method: 'POST', body: form })).status).toBeLessThan(
      300,
    );
    expect(
      (await client.post(`/v1/uploads/${created.sourceAssetId}/complete`, {})).statusCode,
    ).toBe(202);
    await validateUpload(harness.pipeline, { sourceAssetId: created.sourceAssetId });
    await screenUpload(harness.pipeline, { sourceAssetId: created.sourceAssetId });
    const attached = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: project.projectVersion,
      sourceAssetId: created.sourceAssetId,
      sceneType: 'house_exterior',
    });
    expect(attached.statusCode).toBe(200);
    project = json<{ project: Project }>(attached).project;

    const db = harness.context.db;
    const source = await db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', created.sourceAssetId)
      .executeTakeFirstOrThrow();
    const job = await createRenderJobRecord(harness.pipeline, {
      ownerId: source.ownerId,
      projectId: project.id,
      source,
    });
    expect(await harness.completeRender(job.id)).toBe('succeeded');
    const asset = await db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(asset.downloadObjectKey).not.toBeNull();
    const shared = await client.post(
      '/v1/shares',
      { renderAssetId: asset.id, includeBefore: true },
      { 'idempotency-key': randomUUID() },
    );
    expect(shared.statusCode).toBe(201);
    const { token } = CreateShareResponseSchema.parse(shared.json());

    const kept = await client.put(`/v1/projects/${project.id}/source`, {
      projectVersion: project.projectVersion,
      sourceAssetId: created.sourceAssetId,
      sceneType: 'house_exterior',
      peopleResolution: { action: 'keep' },
    });
    expect(kept.statusCode).toBe(200);
    const after = await db
      .selectFrom('renderAssets')
      .select(['downloadable', 'downloadObjectKey', 'distributable'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ downloadable: false, downloadObjectKey: null, distributable: false });
    expect(
      await harness.context.storage.head('private', asset.downloadObjectKey as string),
    ).toBeNull();
    const view = await harness.client().get(`/v1/shares/${token}`);
    expect(view.statusCode).toBe(410);
    expect(json(view).error).toMatchObject({ code: 'SHARE_REVOKED' });
  });
});

describe('internal API CSRF', () => {
  it('refuses a wrong token of the same or a different length and accepts the right one', async () => {
    const pause = await operator.get('/internal/v1/pause');
    const body = { ...json(pause), reason: 'csrf test' };
    const sameLength = csrf.replace(/.$/, (last) => (last === 'a' ? 'b' : 'a'));
    for (const token of [sameLength, `${csrf}x`, 'short']) {
      const refused = await operator.put('/internal/v1/pause', body, { 'x-csrf-token': token });
      expect(refused.statusCode).toBe(403);
      expect(json(refused).error).toMatchObject({ details: { reason: 'csrf' } });
    }
    const accepted = await operator.put('/internal/v1/pause', body, { 'x-csrf-token': csrf });
    expect(accepted.statusCode).toBe(200);
  });
});

describe('account deletion', () => {
  async function accountRequest(deletionRequestId: string) {
    const db = harness.context.db;
    const request = await db
      .selectFrom('deletionRequests')
      .select(['status', 'completedAt', 'receipt'])
      .where('id', '=', deletionRequestId)
      .executeTakeFirstOrThrow();
    const tombstone = await db
      .selectFrom('tombstones')
      .select('mirroredAt')
      .where('deletionRequestId', '=', deletionRequestId)
      .where('kind', '=', 'owner')
      .executeTakeFirstOrThrow();
    const database = (request.receipt as { store: string; rowsDeleted: number }[]).find(
      (entry) => entry.store === 'database',
    );
    return { request, tombstone, rowsDeleted: database?.rowsDeleted };
  }

  it('stays held while a project is under a hold, counts only deleted projects and mirrors the owner tombstone at once', async () => {
    const { client, projectId: heldProjectId } = await customerWithVariant();
    await signInSameSession(harness, client, `held-${randomUUID()}@example.com`);
    const other = await adoptStreetViewProject(harness, client);
    const placed = await operator.post(
      '/internal/v1/preservation-holds',
      {
        targetKind: 'project',
        targetId: heldProjectId,
        reason: 'complaint_investigation',
        authorityRef: 'case-account',
        releaseCondition: 'investigation closed',
      },
      { 'x-csrf-token': csrf },
    );
    expect(placed.statusCode).toBe(201);

    const deleted = await client.delete('/v1/me');
    expect(deleted.statusCode).toBe(202);
    const { deletionRequestId } = json<{ deletionRequestId: string }>(deleted);
    const { request, tombstone, rowsDeleted } = await accountRequest(deletionRequestId);
    expect(request).toMatchObject({ status: 'held', completedAt: null });
    expect(rowsDeleted).toBe(1);
    expect(tombstone.mirroredAt).toBeInstanceOf(Date);
    const remaining = await harness.context.db
      .selectFrom('projects')
      .select('id')
      .where('id', 'in', [heldProjectId, other.projectId])
      .execute();
    expect(remaining).toEqual([{ id: heldProjectId }]);
  });

  it('completes when nothing is held', async () => {
    const client = harness.client();
    await client.createSession();
    await signInSameSession(harness, client, `leaver-${randomUUID()}@example.com`);
    await adoptStreetViewProject(harness, client);
    await adoptStreetViewProject(harness, client);

    const deleted = await client.delete('/v1/me');
    expect(deleted.statusCode).toBe(202);
    const { deletionRequestId } = json<{ deletionRequestId: string }>(deleted);
    const { request, tombstone, rowsDeleted } = await accountRequest(deletionRequestId);
    expect(request).toMatchObject({ status: 'completed', completedAt: expect.any(Date) });
    expect(rowsDeleted).toBe(2);
    expect(tombstone.mirroredAt).toBeInstanceOf(Date);
  });
});
