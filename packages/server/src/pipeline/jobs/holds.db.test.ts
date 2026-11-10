import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMs } from '../../clock/index.js';
import { toJson } from '../../db/client.js';
import type { SourceAsset } from '../../db/schema.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import type { SafetyProvider, ScreeningResult } from '../../providers/types.js';
import { createStorage } from '../../storage/client.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { runRenderJob } from '../render/job.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { screenUpload } from '../uploads/screen.js';
import { runStreetViewRevalidation } from './commerce-and-coverage.js';
import { deleteProject, deleteSharePublicObjects, resumeDeletionRequests } from './deletion.js';
import { copyHeldObjects, placePreservationHold } from './holds.js';
import { runReconciliation } from './reconciliation.js';
import { purgePlace } from './takedown.js';
import { replayTombstoneMirror } from './tombstones.js';

let base: PipelineDeps & { close(): Promise<void> };
let deps: PipelineDeps;
let photo: Buffer;

/** This file's own buckets, so object scans and mirror replays see only its objects. */
const BUCKETS = { private: 'test-holds-private', public: 'test-holds-public' } as const;

beforeAll(async () => {
  base = await createPipelineTestDeps();
  const storage = createStorage(base.config, { buckets: { ...BUCKETS } });
  for (const bucket of Object.values(BUCKETS)) await storage.ensureBucket(bucket);
  for (const prefix of ['originals/', 'outputs/', 'downloads/', 'tombstones/', 'attempts/']) {
    await storage.deletePrefix('private', prefix);
  }
  deps = { ...base, storage };
  const frame = await renderFixturePanorama({
    panoId: 'fxSvLanternHillC01p1Sv',
    heading: 0,
    fov: 80,
    pitch: 2,
  });
  photo = await sharp(frame?.image ?? Buffer.alloc(0))
    .resize(1200, 800, { fit: 'fill' })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  deps.storage.destroy();
  await base.close();
});

async function renderVariant(input: {
  ownerId: string;
  projectId: string;
  source: SourceAsset;
  holidayId?: 'christmas' | 'halloween';
}) {
  const job = await createRenderJobRecord(deps, input);
  expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
  return deps.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('jobId', '=', job.id)
    .executeTakeFirstOrThrow();
}

async function projectOf(id: string) {
  return deps.db.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst();
}

async function hold(
  targetKind: 'source_asset' | 'render_asset' | 'report' | 'project',
  id: string,
) {
  const placed = await deps.db.transaction().execute((trx) =>
    placePreservationHold(trx, {
      targetKind,
      targetId: id,
      reason: 'complaint_investigation',
      authorityRef: `test:${id}`,
      releaseCondition: 'test',
      placedBy: null,
    }),
  );
  await copyHeldObjects(deps, placed.holdId);
  return placed.holdId;
}

async function exists(key: string | null, bucket: 'private' | 'public' = 'private') {
  return key !== null && (await deps.storage.head(bucket, key)) !== null;
}

async function outputs(ownerId: string, assetId: string) {
  return deps.storage.list('private', keys.outputPrefix(ownerId, assetId));
}

async function grantFor(ownerId: string, renderAssetId: string) {
  const token = randomToken(16);
  const id = newId();
  await deps.db
    .insertInto('shareGrants')
    .values({
      id,
      ownerId,
      renderAssetId,
      tokenHash: sha256Hex(token),
      expiresAt: addMs(new Date(), 30 * 86_400_000),
      shareCardObjectKey: keys.card(token),
    })
    .execute();
  await deps.storage.put({
    bucket: 'public',
    key: keys.card(token),
    body: 'card',
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'system' },
  });
  return { id, token };
}

describe('preservation holds', () => {
  it('a source-asset hold keeps the source, its original and its variants through deletion and reconciliation', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const asset = await renderVariant({ ownerId, projectId, source });
    const holdId = await hold('source_asset', source.id);
    const orphan = keys.original(newId(), newId());
    await deps.storage.put({
      bucket: 'private',
      key: orphan,
      body: 'orphan',
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });

    const project = await projectOf(projectId);
    const outcome = await deleteProject(deps, {
      project: project!,
      scope: 'project',
      requestedBy: 'user',
    });
    expect(outcome.status).toBe('held');
    expect((await projectOf(projectId))?.deletedAt).not.toBeNull();
    const kept = await deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(kept).toMatchObject({ objectKey: source.objectKey, preservationHoldId: holdId });
    expect(kept.deletedAt).not.toBeNull();
    expect(await exists(source.objectKey)).toBe(true);
    expect(await exists(keys.held(holdId, source.objectKey!))).toBe(true);
    expect(await outputs(ownerId, asset.id)).not.toEqual([]);
    const request = await deps.db
      .selectFrom('deletionRequests')
      .selectAll()
      .where('id', '=', outcome.deletionRequestId)
      .executeTakeFirstOrThrow();
    expect(request.status).toBe('held');

    const reconciled = await runReconciliation(deps, {
      scanObjects: true,
      jobIds: [],
      objectGraceMs: 0,
    });
    expect(await exists(orphan)).toBe(false);
    expect(reconciled.objectsDeleted).toBeGreaterThanOrEqual(1);
    expect(await exists(source.objectKey)).toBe(true);
    expect(await exists(asset.objectKey)).toBe(true);
    expect(await exists(keys.held(holdId, source.objectKey!))).toBe(true);
  });

  it('a report hold on a variant keeps it and its source; everything else in the project goes', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const asset = await renderVariant({ ownerId, projectId, source });
    // A second, unrelated upload in the same project.
    const otherId = newId();
    const otherKey = keys.original(ownerId, otherId);
    await deps.storage.put({
      bucket: 'private',
      key: otherKey,
      body: photo,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    await deps.db
      .insertInto('sourceAssets')
      .values({
        id: otherId,
        ownerId,
        projectId,
        kind: 'upload',
        state: 'ready',
        objectKey: otherKey,
        peopleResolution: 'none',
        attestationVersion: 'test-2',
        attestedAt: new Date(),
      })
      .execute();
    const reportId = newId();
    await deps.db
      .insertInto('reports')
      .values({
        id: reportId,
        targetKind: 'render',
        targetId: asset.id,
        reason: 'harmful_or_offensive',
      })
      .execute();
    const holdId = await hold('report', reportId);
    expect(
      (
        await deps.db
          .selectFrom('reports')
          .select('preservationHoldId')
          .where('id', '=', reportId)
          .executeTakeFirstOrThrow()
      ).preservationHoldId,
    ).toBe(holdId);

    const outcome = await deleteProject(deps, {
      project: (await projectOf(projectId))!,
      scope: 'project',
      requestedBy: 'user',
    });
    expect(outcome.status).toBe('held');
    expect(await exists(asset.objectKey)).toBe(true);
    expect(await exists(source.objectKey)).toBe(true);
    expect(await exists(otherKey)).toBe(false);
    const other = await deps.db
      .selectFrom('sourceAssets')
      .select(['state', 'objectKey'])
      .where('id', '=', otherId)
      .executeTakeFirstOrThrow();
    expect(other).toEqual({ state: 'deleted', objectKey: null });
    // The held variant is hidden from its owner.
    const heldAsset = await deps.db
      .selectFrom('renderAssets')
      .select('deletedAt')
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(heldAsset.deletedAt).not.toBeNull();
    // The tombstone records the attestation of each source.
    const tombstone = await deps.db
      .selectFrom('tombstones')
      .selectAll()
      .where('kind', '=', 'source_asset')
      .where('hashSha256', '=', sha256Hex(otherId))
      .executeTakeFirstOrThrow();
    expect(tombstone.attestationVersion).toBe('test-2');
    expect(tombstone.attestedAt).not.toBeNull();
  });

  it('a child-safety signal at screening places a mandatory-report hold that deletion respects', async () => {
    const { projectId, source } = await createUploadSource(deps, { image: photo });
    await deps.db
      .updateTable('sourceAssets')
      .set({ state: 'screening', readyAt: null })
      .where('id', '=', source.id)
      .execute();
    const declined: ScreeningResult = {
      outcome: 'declined',
      reasonClass: 'safety',
      reason: 'hash_match',
      childSafety: true,
      triage: null,
      peopleDetected: false,
      peopleBoxes: [],
      suggestedCropBox: null,
      qualityHints: [],
      checks: [{ check: 'hash_match', outcome: 'flag' }],
      providerMode: 'fixture',
      usage: { visionCalls: 0, moderationCalls: 0 },
    };
    const safety: SafetyProvider = {
      providerId: 'fixture-safety',
      mode: 'fixture',
      screenUpload: async () => declined,
    };
    const screeningDeps: PipelineDeps = {
      ...deps,
      providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, safety } },
    };
    expect((await screenUpload(screeningDeps, { sourceAssetId: source.id })).outcome).toBe(
      'declined',
    );
    const holdRow = await deps.db
      .selectFrom('preservationHolds')
      .selectAll()
      .where('targetKind', '=', 'source_asset')
      .where('targetId', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(holdRow).toMatchObject({ reason: 'mandatory_report', placedBy: null, releasedAt: null });
    expect(holdRow.heldObjects.map((record) => record.heldKey)).toEqual([
      keys.held(holdRow.id, source.objectKey!),
    ]);
    expect(await exists(keys.held(holdRow.id, source.objectKey!))).toBe(true);

    const outcome = await deleteProject(deps, {
      project: (await projectOf(projectId))!,
      scope: 'project',
      requestedBy: 'user',
    });
    expect(outcome.status).toBe('held');
    expect(await exists(source.objectKey)).toBe(true);
  });
});

describe('interrupted deletion', () => {
  it('resumes a failed account deletion for projects it never reached', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const requestId = newId();
    await deps.db
      .insertInto('deletionRequests')
      .values({
        id: requestId,
        ownerId,
        scope: 'account',
        targetId: ownerId,
        requestedBy: 'user',
        accessRevokedAt: new Date(),
        status: 'failed',
      })
      .execute();
    await resumeDeletionRequests(deps, { olderThanMs: 0, limit: 500 });
    expect(await projectOf(projectId)).toBeUndefined();
    expect(await exists(source.objectKey)).toBe(false);
    const account = await deps.db
      .selectFrom('deletionRequests')
      .select('status')
      .where('id', '=', requestId)
      .executeTakeFirstOrThrow();
    expect(account.status).toBe('completed');
  });
});

describe('concurrent deletion', () => {
  it('two concurrent first deletions of a project share one deletion request', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    await renderVariant({ ownerId, projectId, source });
    const project = (await projectOf(projectId))!;

    const [first, second] = await Promise.all([
      deleteProject(deps, { project, scope: 'project', requestedBy: 'user' }),
      deleteProject(deps, { project, scope: 'project', requestedBy: 'user' }),
    ]);
    expect(second.deletionRequestId).toBe(first.deletionRequestId);
    const requests = await deps.db
      .selectFrom('deletionRequests')
      .select(['id', 'status', 'receipt'])
      .where('targetId', '=', projectId)
      .execute();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('completed');
    // The receipt of the completion that removed the rows is the one kept.
    const database = requests[0]?.receipt?.find((entry) => entry.store === 'database');
    expect(database?.rowsDeleted).toBeGreaterThan(0);
    expect(await projectOf(projectId)).toBeUndefined();
    expect(await exists(source.objectKey)).toBe(false);
  });
});

describe('tombstone mirror', () => {
  it('appends each deletion to tombstones/ and replays it after a restore', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    await renderVariant({ ownerId, projectId, source });
    const project = (await projectOf(projectId))!;
    const outcome = await deleteProject(deps, { project, scope: 'project', requestedBy: 'user' });
    expect(outcome.status).toBe('completed');

    const lines: Record<string, unknown>[] = [];
    for (const key of await deps.storage.list('private', 'tombstones/')) {
      expect(key).toMatch(/^tombstones\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.jsonl$/);
      const body = (await deps.storage.get('private', key))?.body.toString() ?? '';
      for (const line of body.split('\n').filter(Boolean)) lines.push(JSON.parse(line));
    }
    const mine = lines.filter((line) => line.deletionRequestId === outcome.deletionRequestId);
    expect(mine.find((line) => line.kind === 'project')?.hashSha256).toBe(sha256Hex(projectId));
    expect(mine.find((line) => line.kind === 'source_asset')).toMatchObject({
      hashSha256: sha256Hex(source.id),
      attestationVersion: 'test-1',
    });
    expect(mine.some((line) => line.kind === 'object_key')).toBe(true);
    expect(JSON.stringify(mine)).not.toContain(projectId);

    // A restore from before the deletion: the project row is back and its tombstones are gone.
    await deps.db
      .insertInto('projects')
      .values({ ...project, activeSourceAssetId: null, deletedAt: null } as never)
      .execute();
    await deps.db
      .deleteFrom('tombstones')
      .where('deletionRequestId', '=', outcome.deletionRequestId)
      .execute();
    const replayed = await replayTombstoneMirror(deps);
    expect(replayed.projectsRedeleted).toBeGreaterThanOrEqual(1);
    expect((await projectOf(projectId))?.deletedAt).not.toBeNull();
    expect(
      await deps.db
        .selectFrom('tombstones')
        .select('id')
        .where('kind', '=', 'project')
        .where('hashSha256', '=', sha256Hex(projectId))
        .executeTakeFirst(),
    ).toBeDefined();
    await resumeDeletionRequests(deps, { olderThanMs: 0, limit: 500 });
    expect(await projectOf(projectId)).toBeUndefined();
  });
});

describe('place and panorama purges', () => {
  it('a blocked place purges every owner’s Street View variants and revokes their shares', async () => {
    // A place no other test file renders: the purge reaches every owner's variants of it.
    const placeId = 'ChIJfxLarkspurCourtBungal03';
    const first = await createStreetViewSource(deps, { placeId });
    const second = await createStreetViewSource(deps, { placeId });
    const asset = await renderVariant(second);
    const grant = await grantFor(second.ownerId, asset.id);
    expect(first.ownerId).not.toBe(second.ownerId);

    const result = await purgePlace(deps, placeId, { requestedBy: 'operator' });
    expect(result.purged).toBeGreaterThanOrEqual(1);
    const row = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(row.withdrawnAt).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(await outputs(second.ownerId, asset.id)).toEqual([]);
    const revoked = await deps.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('id', '=', grant.id)
      .executeTakeFirstOrThrow();
    expect(revoked.revokedAt).not.toBeNull();
    expect(await exists(keys.card(grant.token), 'public')).toBe(false);
    const request = await deps.db
      .selectFrom('deletionRequests')
      .select(['scope', 'status'])
      .where('targetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(request).toEqual({ scope: 'asset', status: 'completed' });
  });

  it('a removed persisted panorama purges the variants made from it', async () => {
    const created = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const asset = await renderVariant(created);
    const grant = await grantFor(created.ownerId, asset.id);
    const storedKey = keys.original(created.ownerId, created.source.id);
    await deps.storage.put({
      bucket: 'private',
      key: storedKey,
      body: photo,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    await deps.db
      .updateTable('sourceAssets')
      .set({
        streetViewMode: 'persist',
        objectKey: storedKey,
        revalidatedAt: null,
        viewpoint: toJson({ ...created.source.viewpoint, panoId: 'fxSvRemovedPanorama00' }),
      })
      .where('id', '=', created.source.id)
      .execute();

    const result = await runStreetViewRevalidation(deps);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    const source = await deps.db
      .selectFrom('sourceAssets')
      .select(['state', 'objectKey'])
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    expect(source).toEqual({ state: 'stale', objectKey: null });
    expect(await exists(storedKey)).toBe(false);
    const row = await deps.db
      .selectFrom('renderAssets')
      .select(['withdrawnAt', 'deletedAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(row.withdrawnAt).not.toBeNull();
    expect(await outputs(created.ownerId, asset.id)).toEqual([]);
    const revoked = await deps.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('id', '=', grant.id)
      .executeTakeFirstOrThrow();
    expect(revoked.revokedAt).not.toBeNull();
  });

  it('a source marked stale at render time is revisited: a removed panorama purges its variants', async () => {
    const created = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const asset = await renderVariant(created);
    const grant = await grantFor(created.ownerId, asset.id);
    const storedKey = keys.original(created.ownerId, created.source.id);
    await deps.storage.put({
      bucket: 'private',
      key: storedKey,
      body: photo,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    // The render-time path marked the source stale (recently checked) and purged nothing.
    const checkedAt = new Date(Date.now() - 60_000);
    await deps.db
      .updateTable('sourceAssets')
      .set({
        state: 'stale',
        staleAt: new Date(),
        revalidatedAt: checkedAt,
        streetViewMode: 'persist',
        objectKey: storedKey,
        viewpoint: toJson({ ...created.source.viewpoint, panoId: 'fxSvRemovedPanorama00' }),
      })
      .where('id', '=', created.source.id)
      .execute();

    const result = await runStreetViewRevalidation(deps);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    const source = await deps.db
      .selectFrom('sourceAssets')
      .select(['state', 'objectKey', 'revalidatedAt'])
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    expect(source.state).toBe('stale');
    expect(source.objectKey).toBeNull();
    expect(source.revalidatedAt!.getTime()).toBeGreaterThan(checkedAt.getTime());
    expect(await exists(storedKey)).toBe(false);
    const row = await deps.db
      .selectFrom('renderAssets')
      .select(['withdrawnAt', 'deletedAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(row.withdrawnAt).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(await outputs(created.ownerId, asset.id)).toEqual([]);
    const revoked = await deps.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('id', '=', grant.id)
      .executeTakeFirstOrThrow();
    expect(revoked.revokedAt).not.toBeNull();
    expect(await exists(keys.card(grant.token), 'public')).toBe(false);
  });

  it('a stale transient source whose panorama is still present keeps its variants labeled', async () => {
    const created = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const asset = await renderVariant(created);
    const grant = await grantFor(created.ownerId, asset.id);
    await deps.db
      .updateTable('sourceAssets')
      .set({ state: 'stale', staleAt: new Date(), revalidatedAt: null })
      .where('id', '=', created.source.id)
      .execute();

    await runStreetViewRevalidation(deps);
    const source = await deps.db
      .selectFrom('sourceAssets')
      .select(['state', 'revalidatedAt'])
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    expect(source.state).toBe('stale');
    expect(source.revalidatedAt).not.toBeNull();
    const row = await deps.db
      .selectFrom('renderAssets')
      .select(['withdrawnAt', 'deletedAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ withdrawnAt: null, deletedAt: null });
    expect((await outputs(created.ownerId, asset.id)).length).toBeGreaterThan(0);
    const live = await deps.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('id', '=', grant.id)
      .executeTakeFirstOrThrow();
    expect(live.revokedAt).toBeNull();
  });
});

describe('share revocation', () => {
  it('purges the CDN paths of a grant’s public copies', async () => {
    const token = randomToken(16);
    await deleteSharePublicObjects(deps, keys.card(token));
    const purged = (deps.storage.cdn as unknown as { purged: string[] }).purged;
    expect(purged).toEqual(
      expect.arrayContaining([
        keys.card(token),
        keys.shared(token, 'after'),
        keys.shared(token, 'before'),
      ]),
    );
  });
});

describe('reconciliation of orphaned attempts', () => {
  it('settles a pending attempt with an operation ID on a job terminal for over an hour', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    const analysis = newId();
    await deps.db
      .insertInto('sceneAnalyses')
      .values({
        id: analysis,
        sourceAssetId: source.id,
        analysisModel: 'orphan-test',
        analysisPromptVersion: 'x',
        schemaVersion: '1.0',
        workingWidth: 1024,
        workingHeight: 1024,
        workingChecksumSha256: newId(),
        document: toJson({}),
      })
      .execute();
    const kit = await deps.db.selectFrom('styleKits').select('id').executeTakeFirstOrThrow();
    const plan = newId();
    await deps.db
      .insertInto('decorationPlans')
      .values({
        id: plan,
        jobId: job.id,
        attemptNo: 1,
        sceneAnalysisId: analysis,
        packVersion: '1.0.0',
        styleKitId: kit.id,
        compilerVersion: 'x',
        document: toJson({}),
        validatorResult: toJson({}),
      })
      .execute();
    const reservation = await deps.db
      .selectFrom('usageLedger')
      .select('id')
      .where('jobId', '=', job.id)
      .where('sku', '=', 'image_edit_attempt')
      .executeTakeFirstOrThrow();
    const attemptId = newId();
    await deps.db
      .insertInto('renderAttempts')
      .values({
        id: attemptId,
        jobId: job.id,
        attemptNo: 1,
        isRepair: false,
        decorationPlanId: plan,
        sceneAnalysisId: analysis,
        permissionEvaluationId: job.permissionEvaluationId,
        provider: 'fixture-editor',
        modelSnapshot: 'x',
        promptVersion: 'x',
        compilerVersion: 'x',
        settingsHash: 'x',
        providerMode: 'fixture',
        providerOperationId: 'fixture:orphaned',
        sourceChecksumSha256: 'x',
        workingChecksumSha256: 'x',
        outcome: 'pending',
        reservationEntryId: reservation.id,
      })
      .execute();
    await deps.db
      .updateTable('renderJobs')
      .set({ state: 'canceled', terminalAt: new Date(Date.now() - 2 * 3_600_000) })
      .where('id', '=', job.id)
      .execute();

    const result = await runReconciliation(deps, { scanObjects: false, jobIds: [job.id] });
    expect(result.attemptsAssumedCharged).toBe(1);
    const attempt = await deps.db
      .selectFrom('renderAttempts')
      .select('reconciled')
      .where('id', '=', attemptId)
      .executeTakeFirstOrThrow();
    expect(attempt.reconciled).toBe('assumed_charged');
    const ledger = await deps.db
      .selectFrom('usageLedger')
      .selectAll()
      .where('jobId', '=', job.id)
      .execute();
    const open = ledger.filter(
      (row) => row.kind === 'reservation' && !ledger.some((o) => o.reservationId === row.id),
    );
    expect(open).toEqual([]);
    expect(
      ledger.some((row) => row.kind === 'settlement' && row.reservationId === reservation.id),
    ).toBe(true);
  });
});
