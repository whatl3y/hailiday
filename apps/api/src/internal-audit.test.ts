import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '@holiday/core';
import { toJson } from '@holiday/server/db';
import { newId } from '@holiday/server/ids';
import { createRenderJobRecord } from '@holiday/server/pipeline';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';
import { placesTokenForClient } from './test/places-token.js';

let harness: Harness;
let operator: TestClient;
let csrf: string;
let reviewJobId: string;
let heldAssetId: string;

beforeAll(async () => {
  harness = await createHarness();
  ({ client: operator, csrf } = await operatorClient(harness));

  const customer = harness.client();
  await customer.createSession();
  const resolved = await customer.post('/v1/addresses/resolve', {
    placeId: 'ChIJfxLanternHillColonial01',
    sessionToken: await placesTokenForClient(harness, customer),
    holidayId: 'christmas',
  });
  expect(resolved.statusCode).toBe(201);
  const created = (resolved.json() as { project: Project }).project;
  const discovered = await customer.post(`/v1/projects/${created.id}/source-discovery`, {
    projectVersion: 0,
  });
  const project = (discovered.json() as { project: Project }).project;
  const source = await harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', project.activeSource?.sourceAssetId ?? '')
    .executeTakeFirstOrThrow();
  const job = await createRenderJobRecord(harness.pipeline, {
    ownerId: source.ownerId,
    projectId: project.id,
    source,
    style: 'abundant',
  });
  await harness.context.db
    .updateTable('renderJobs')
    .set({ state: 'needs_review' })
    .where('id', '=', job.id)
    .execute();
  reviewJobId = job.id;

  const uploadProject = await customer.post('/v1/projects', {
    kind: 'upload',
    holidayId: 'christmas',
  });
  const uploadProjectId = (uploadProject.json() as { project: Project }).project.id;
  heldAssetId = newId();
  await harness.context.db
    .insertInto('sourceAssets')
    .values({
      id: heldAssetId,
      ownerId: source.ownerId,
      projectId: uploadProjectId,
      kind: 'upload',
      state: 'screening',
      holdForReview: true,
      peopleResolution: 'none',
      objectKey: `quarantine/${heldAssetId}`,
      screening: toJson({ reviewObjectKey: `reviews/${heldAssetId}.jpg` }),
    })
    .execute();
});

afterAll(async () => {
  await harness?.close();
});

async function auditRows(requestId: string) {
  return harness.context.db
    .selectFrom('auditLog')
    .selectAll()
    .where('requestId', '=', requestId)
    .execute();
}

describe('image views through internal tools', () => {
  it('writes one audit row per review item shown, with the actor and request id', async () => {
    const response = await operator.get('/internal/v1/reviews?limit=100');
    expect(response.statusCode).toBe(200);
    const items = json<{ items: { renderJobId: string; sourceUrl: string | null }[] }>(
      response,
    ).items;
    const rows = await auditRows(String(response.headers['x-request-id']));
    expect(rows.map((row) => row.targetId).sort()).toEqual(
      items.map((item) => item.renderJobId).sort(),
    );
    expect(rows.every((row) => row.action === 'review.view')).toBe(true);
    expect(rows.every((row) => row.actorKind === 'operator' && row.actorUserId)).toBe(true);
    expect(rows.every((row) => row.targetKind === 'render_job')).toBe(true);
    if (items.some((item) => item.renderJobId === reviewJobId)) {
      expect(rows.some((row) => row.targetId === reviewJobId)).toBe(true);
    }
    expect(JSON.stringify(rows)).not.toContain('X-Amz');
  });

  it('writes one audit row per held upload shown', async () => {
    const response = await operator.get('/internal/v1/upload-holds?limit=100');
    expect(response.statusCode).toBe(200);
    const items = json<{ items: { sourceAssetId: string; imageUrl: string | null }[] }>(
      response,
    ).items;
    expect(items.length).toBeGreaterThan(0);
    const rows = await auditRows(String(response.headers['x-request-id']));
    expect(rows.map((row) => row.targetId).sort()).toEqual(
      items
        .filter((item) => item.imageUrl)
        .map((item) => item.sourceAssetId)
        .sort(),
    );
    expect(rows.every((row) => row.action === 'upload_hold.view')).toBe(true);
    if (items.some((item) => item.sourceAssetId === heldAssetId)) {
      expect(rows.some((row) => row.targetId === heldAssetId)).toBe(true);
    }
  });
});

describe('reporter contact details through internal tools', () => {
  it('writes one report.view row per report shown with contact details (target only)', async () => {
    const withContact = newId();
    const anonymous = newId();
    await harness.context.db
      .insertInto('reports')
      .values([
        {
          id: withContact,
          reporterContactEmail: 'reporter@example.com',
          targetKind: 'share',
          reason: 'privacy',
          details: 'audit test',
        },
        { id: anonymous, targetKind: 'share', reason: 'privacy', details: 'audit test' },
      ])
      .execute();
    const response = await operator.get('/internal/v1/reports?limit=100');
    expect(response.statusCode).toBe(200);
    const items = json<{ items: { id: string; contactEmail: string | null }[] }>(response).items;
    expect(items.some((item) => item.id === withContact)).toBe(true);
    expect(items.some((item) => item.id === anonymous)).toBe(true);
    const rows = await auditRows(String(response.headers['x-request-id']));
    expect(rows.map((row) => row.targetId).sort()).toEqual(
      items
        .filter((item) => item.contactEmail)
        .map((item) => item.id)
        .sort(),
    );
    expect(rows.some((row) => row.targetId === withContact)).toBe(true);
    expect(rows.some((row) => row.targetId === anonymous)).toBe(false);
    for (const row of rows) {
      expect(row).toMatchObject({
        action: 'report.view',
        targetKind: 'report',
        actorKind: 'operator',
        before: null,
        after: null,
      });
    }
    expect(JSON.stringify(rows)).not.toContain('reporter@example.com');
  });
});

describe('internal mutations', () => {
  it('commit the change and its audit row together', async () => {
    const decided = await operator.post(
      `/internal/v1/upload-holds/${heldAssetId}/decision`,
      { decision: 'reject', reasonCode: 'review_declined' },
      { 'x-csrf-token': csrf },
    );
    expect(decided.statusCode, decided.body).toBe(200);
    const rows = await auditRows(String(decided.headers['x-request-id']));
    expect(rows.map((row) => [row.action, row.targetId])).toEqual([
      ['upload_hold.decide', heldAssetId],
    ]);

    const now = new Date();
    await harness.context.db
      .updateTable('renderJobs')
      .set({ state: 'succeeded', succeededAt: now, terminalAt: now, renderAssetId: null })
      .where('id', '=', reviewJobId)
      .execute();
    const notReviewable = await operator.post(
      `/internal/v1/reviews/${reviewJobId}/decision`,
      { decision: 'reject', reasonCodes: ['reviewer_rejected'] },
      { 'x-csrf-token': csrf },
    );
    expect(notReviewable.statusCode).toBe(400);
    expect(json(notReviewable).error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await auditRows(String(notReviewable.headers['x-request-id']))).toEqual([]);
  });
});
