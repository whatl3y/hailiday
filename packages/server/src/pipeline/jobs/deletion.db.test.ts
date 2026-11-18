import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMs } from '../../clock/index.js';
import { toJson } from '../../db/client.js';
import { factories } from '../../db/factories.js';
import type { DeletionReceiptEntry, SourceAsset } from '../../db/schema.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import { attemptQuota } from '../../limits/index.js';
import { createAssetPolicy, defaultPolicyTemplate } from '../../policy/index.js';
import { createSettings } from '../../settings/index.js';
import { createStorage } from '../../storage/client.js';
import { keys } from '../../storage/keys.js';
import { SERVER_TEST_BUCKETS } from '../../storage/testing.js';
import type { PipelineDeps } from '../context.js';
import { runRenderJob } from '../render/job.js';
import { createPipelineTestDeps, createRenderJobRecord, createUploadSource } from '../testing.js';
import {
  beginProjectDeletion,
  completeProjectDeletion,
  deleteProject,
  resumeAccountDeletion,
} from './deletion.js';
import { copyHeldObjects, loadHeldSet, placePreservationHold } from './holds.js';

let base: PipelineDeps & { close(): Promise<void> };
let deps: PipelineDeps;
let photo: Buffer;

/** This file's own buckets, so its deletions never touch another file's objects. */
const BUCKETS = SERVER_TEST_BUCKETS.deletion;

beforeAll(async () => {
  base = await createPipelineTestDeps();
  const storage = createStorage(base.config, { buckets: { ...BUCKETS } });
  for (const bucket of Object.values(BUCKETS)) await storage.ensureBucket(bucket);
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

async function requestOf(id: string) {
  return deps.db
    .selectFrom('deletionRequests')
    .select(['status', 'receipt'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

const entryOf = (receipt: DeletionReceiptEntry[] | null, store: DeletionReceiptEntry['store']) =>
  (receipt ?? []).find((entry) => entry.store === store);

/** The same database, except that every update of a deletion request's status fails. */
function failRequestStatusWrite(db: PipelineDeps['db']): PipelineDeps['db'] {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'updateTable') {
        return (table: string) => {
          if (table === 'deletionRequests') throw new Error('database unavailable');
          return target.updateTable(table as never);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('deletion residue', () => {
  it('leaves no attempt residue for an attempt that was never sent', async () => {
    const settings = createSettings(deps.db, { config: deps.config, cacheTtlMs: 0 });
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const asset = await renderVariant({ ownerId, projectId, source });
    const sent = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', asset.jobId)
      .executeTakeFirstOrThrow();
    expect(sent.providerOperationId).not.toBeNull();
    // A repair planned and then stopped before dispatch: canceled, never sent.
    await deps.db
      .insertInto('renderAttempts')
      .values({
        ...sent,
        id: newId(),
        attemptNo: 2,
        isRepair: true,
        outcome: 'canceled',
        providerOperationId: null,
        requestSentAt: null,
        ledgerEntryId: null,
        reservationEntryId: null,
        candidateObjectKey: null,
        compositeMask: null,
        registrationTransform: null,
        errorDetail: null,
        providerUsage: null,
        fallback: null,
        createdAt: new Date(),
      } as never)
      .execute();
    const used = async () =>
      (await attemptQuota(deps.db, settings, { ownerId, now: new Date(Date.now() + 1000) })).used;
    expect(await used()).toBe(1);

    const outcome = await deleteProject(deps, {
      project: (await projectOf(projectId))!,
      scope: 'project',
      requestedBy: 'user',
    });
    expect(outcome.status).toBe('completed');
    const residue = await deps.db
      .selectFrom('allowanceResidue')
      .select('kind')
      .where('ownerId', '=', ownerId)
      .where('kind', '=', 'attempt')
      .execute();
    expect(residue).toHaveLength(1);
    expect(await used()).toBe(1);
  });
});

describe('deletion receipts', () => {
  it('a later completion of a pinned expiry keeps the receipt the first one wrote', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const shared = await renderVariant({ ownerId, projectId, source });
    await renderVariant({ ownerId, projectId, source, holidayId: 'halloween' });
    const token = randomToken(16);
    await deps.db
      .insertInto('shareGrants')
      .values({
        id: newId(),
        ownerId,
        renderAssetId: shared.id,
        tokenHash: sha256Hex(token),
        expiresAt: addMs(new Date(), 30 * 86_400_000),
        shareCardObjectKey: keys.card(token),
      })
      .execute();

    const first = await deleteProject(deps, {
      project: (await projectOf(projectId))!,
      scope: 'expiry_sweep',
      requestedBy: 'system',
    });
    expect(first.status).toBe('pinned');
    const written = await requestOf(first.deletionRequestId);
    expect(written.status).toBe('completed');
    const writtenRows = entryOf(written.receipt, 'database')?.rowsDeleted;
    const writtenObjects = entryOf(written.receipt, 'object_storage')?.objectsDeleted;
    expect(writtenRows).toBeGreaterThan(0);
    // Another test file's deletion resume may complete the open request first; otherwise this
    // call removed the rows and wrote the receipt.
    if (first.removedRows) {
      expect(writtenRows).toBe(first.rowsDeleted);
      expect(writtenObjects).toBe(first.objectsDeleted);
    }

    // The same request completed again (a concurrent completion that waited on the lock).
    const again = await completeProjectDeletion(deps, {
      project: (await projectOf(projectId))!,
      requestId: first.deletionRequestId,
      scope: 'expiry_sweep',
    });
    expect(again.status).toBe('pinned');
    expect(again.removedRows).toBe(false);
    const kept = await requestOf(first.deletionRequestId);
    expect(entryOf(kept.receipt, 'database')?.rowsDeleted).toBe(writtenRows);
    expect(entryOf(kept.receipt, 'object_storage')?.objectsDeleted).toBe(writtenObjects);
    // The pinned variant is still there.
    expect(
      await deps.db.selectFrom('renderAssets').select('id').where('id', '=', shared.id).execute(),
    ).toHaveLength(1);
  });

  it('only the concurrent completion that removed the rows reports it, and its receipt stays', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    await renderVariant({ ownerId, projectId, source });
    const project = (await projectOf(projectId))!;
    const results = await Promise.all([
      deleteProject(deps, { project, scope: 'project', requestedBy: 'user' }),
      deleteProject(deps, { project, scope: 'project', requestedBy: 'user' }),
    ]);
    expect(results[1]?.deletionRequestId).toBe(results[0]?.deletionRequestId);
    // At most one completion removes the rows (none of these two when another test file's
    // deletion resume completed the open request first), and the receipt is the remover's.
    const removers = results.filter((result) => result.removedRows);
    expect(removers.length).toBeLessThanOrEqual(1);
    const request = await requestOf(results[0]!.deletionRequestId);
    expect(request.status).toBe('completed');
    expect(entryOf(request.receipt, 'database')?.rowsDeleted).toBeGreaterThan(0);
    const remover = removers[0];
    if (remover) {
      expect(remover.rowsDeleted).toBeGreaterThan(0);
      expect(entryOf(request.receipt, 'database')?.rowsDeleted).toBe(remover.rowsDeleted);
      expect(entryOf(request.receipt, 'object_storage')?.objectsDeleted).toBe(
        remover.objectsDeleted,
      );
    }
    for (const other of results.filter((result) => !result.removedRows)) {
      expect(other.status).toBe('completed');
    }
    expect(await projectOf(projectId)).toBeUndefined();
  });
});

describe('partially held project deletion', () => {
  /**
   * The project's variants as its deletion starts: not deleted, or marked deleted by a request
   * still in progress when it revoked access (the count the API reports with `project_deleted`).
   */
  async function variantsAtDeletion(projectId: string) {
    const row = await deps.db
      .selectFrom('renderAssets')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('projectId', '=', projectId)
      .where((eb) =>
        eb.or([
          eb('deletedAt', 'is', null),
          eb(
            'deletedAt',
            'in',
            eb
              .selectFrom('deletionRequests')
              .select('accessRevokedAt')
              .where('targetId', '=', projectId)
              .where('status', '!=', 'completed'),
          ),
        ]),
      )
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  it('keeps the access-revocation mark on unheld variants when an interrupted completion resumes', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const heldVariant = await renderVariant({ ownerId, projectId, source });
    const unheldVariant = await renderVariant({
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
    });
    const placed = await deps.db.transaction().execute((trx) =>
      placePreservationHold(trx, {
        targetKind: 'render_asset',
        targetId: heldVariant.id,
        reason: 'complaint_investigation',
        authorityRef: `test:${heldVariant.id}`,
        releaseCondition: 'test',
        placedBy: null,
      }),
    );
    await copyHeldObjects(deps, placed.holdId);
    expect(await variantsAtDeletion(projectId)).toBe(2);

    const revokedAt = new Date();
    const requestId = await beginProjectDeletion(
      { ...deps, clock: { now: () => revokedAt } },
      { project: (await projectOf(projectId))!, scope: 'project', requestedBy: 'user' },
    );
    expect(await variantsAtDeletion(projectId)).toBe(2);

    // The first completion runs later and stops after its row update, before the status write
    // (that write fails). The tombstone mirror is not the step that fails here: a sweep in another
    // test file may have mirrored this request's tombstones already, so a failure injected there
    // would never be reached.
    const later = new Date(revokedAt.getTime() + 60_000);
    const interrupted: PipelineDeps = {
      ...deps,
      clock: { now: () => later },
      db: failRequestStatusWrite(deps.db),
    };
    await expect(
      completeProjectDeletion(interrupted, {
        project: (await projectOf(projectId))!,
        requestId,
        scope: 'project',
      }),
    ).rejects.toThrow('database unavailable');
    const unheld = await deps.db
      .selectFrom('renderAssets')
      .select(['deletedAt', 'downloadable', 'downloadObjectKey'])
      .where('id', '=', unheldVariant.id)
      .executeTakeFirstOrThrow();
    expect(unheld).toMatchObject({ downloadable: false, downloadObjectKey: null });
    expect(unheld.deletedAt?.getTime()).toBe(revokedAt.getTime());
    // A repeated request resuming here still counts every variant the project had.
    expect(await variantsAtDeletion(projectId)).toBe(2);

    const repeat = await completeProjectDeletion(
      { ...deps, clock: { now: () => new Date(later.getTime() + 60_000) } },
      { project: (await projectOf(projectId))!, requestId, scope: 'project' },
    );
    expect(repeat.status).toBe('held');
    expect((await requestOf(requestId)).status).toBe('held');
    const marks = await deps.db
      .selectFrom('renderAssets')
      .select('deletedAt')
      .where('projectId', '=', projectId)
      .execute();
    expect(marks.map((mark) => mark.deletedAt?.getTime())).toEqual([
      revokedAt.getTime(),
      revokedAt.getTime(),
    ]);
  });
});

describe('shop targets of a deleted variant', () => {
  /** A shown search link of the variant, and a click on it. */
  async function shownAndClicked(assetId: string) {
    const program = await deps.db
      .selectFrom('merchantPrograms')
      .select(['id', 'programKey'])
      .where('programKey', '=', 'fixture_decor_us')
      .executeTakeFirstOrThrow();
    const link = await deps.db
      .selectFrom('renderProductLinks')
      .select('id')
      .where('renderAssetId', '=', assetId)
      .executeTakeFirst();
    const target = await factories.renderShopTarget(deps.db, {
      renderAssetId: assetId,
      merchantProgramId: program.id,
      programKey: program.programKey,
      renderProductLinkId: link?.id ?? null,
    });
    const click = await factories.affiliateClick(deps.db, {
      merchantProgramId: program.id,
      shopTargetId: target.id,
      renderProductLinkId: link?.id ?? null,
      groupKey: target.groupKey,
    });
    return { target, click };
  }

  const targetsOf = (assetId: string) =>
    deps.db
      .selectFrom('renderShopTargets')
      .select('id')
      .where('renderAssetId', '=', assetId)
      .execute();

  const clickOf = (id: string) =>
    deps.db
      .selectFrom('affiliateClicks')
      .select(['shopTargetId', 'renderProductLinkId', 'linkKind', 'groupKey'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('go with the project, and its clicks stay without them', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const asset = await renderVariant({ ownerId, projectId, source });
    const { target, click } = await shownAndClicked(asset.id);

    const outcome = await deleteProject(deps, {
      project: (await projectOf(projectId))!,
      scope: 'project',
      requestedBy: 'user',
    });
    expect(outcome.status).toBe('completed');
    expect(await targetsOf(asset.id)).toEqual([]);
    expect(await clickOf(click.id)).toEqual({
      shopTargetId: null,
      renderProductLinkId: null,
      linkKind: 'search',
      groupKey: target.groupKey,
    });
  });

  it('go with an unpinned variant and stay with a pinned one', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: photo });
    const pinned = await renderVariant({ ownerId, projectId, source });
    const unpinned = await renderVariant({ ownerId, projectId, source, holidayId: 'halloween' });
    const token = randomToken(16);
    await deps.db
      .insertInto('shareGrants')
      .values({
        id: newId(),
        ownerId,
        renderAssetId: pinned.id,
        tokenHash: sha256Hex(token),
        expiresAt: addMs(new Date(), 30 * 86_400_000),
        shareCardObjectKey: keys.card(token),
      })
      .execute();
    const kept = await shownAndClicked(pinned.id);
    const removed = await shownAndClicked(unpinned.id);

    const outcome = await deleteProject(deps, {
      project: (await projectOf(projectId))!,
      scope: 'expiry_sweep',
      requestedBy: 'system',
    });
    expect(outcome.status).toBe('pinned');
    expect(await targetsOf(pinned.id)).toEqual([{ id: kept.target.id }]);
    expect((await clickOf(kept.click.id)).shopTargetId).toBe(kept.target.id);
    expect(await targetsOf(unpinned.id)).toEqual([]);
    expect(await clickOf(removed.click.id)).toMatchObject({
      shopTargetId: null,
      renderProductLinkId: null,
      groupKey: removed.target.groupKey,
    });
  });
});

describe('account deletion receipt', () => {
  async function accountRequest(ownerId: string) {
    const id = newId();
    await deps.db
      .insertInto('deletionRequests')
      .values({
        id,
        ownerId,
        scope: 'account',
        targetId: ownerId,
        requestedBy: 'user',
        accessRevokedAt: new Date(),
        status: 'failed',
      })
      .execute();
    return id;
  }

  it('counts only the projects actually deleted and never rewrites a completed receipt', async () => {
    const heldProject = await createUploadSource(deps, { image: photo });
    const ownerId = heldProject.ownerId;
    // A second project of the same owner.
    const unheldProjectId = newId();
    await deps.db
      .insertInto('projects')
      .values({
        id: unheldProjectId,
        ownerId,
        kind: 'upload',
        holidayId: 'christmas',
        lastActivityAt: new Date(),
      })
      .execute();
    const unheldKey = `originals/${ownerId}/${newId()}`;
    await deps.storage.put({
      bucket: 'private',
      key: unheldKey,
      body: photo,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    const unheldSourceId = newId();
    const policy = await createAssetPolicy(deps.db, {
      subjectKind: 'source_asset',
      subjectId: unheldSourceId,
      template: defaultPolicyTemplate('upload', { attestationVersion: 'test-1' }),
    });
    const unheldSource = await deps.db
      .insertInto('sourceAssets')
      .values({
        id: unheldSourceId,
        ownerId,
        projectId: unheldProjectId,
        kind: 'upload',
        state: 'ready',
        objectKey: unheldKey,
        sceneType: 'house_exterior',
        peopleResolution: 'none',
        assetPolicyId: policy.id,
        readyAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const placed = await deps.db.transaction().execute((trx) =>
      placePreservationHold(trx, {
        targetKind: 'source_asset',
        targetId: heldProject.source.id,
        reason: 'complaint_investigation',
        authorityRef: `test:${heldProject.source.id}`,
        releaseCondition: 'test',
        placedBy: null,
      }),
    );
    await copyHeldObjects(deps, placed.holdId);

    const requestId = await accountRequest(ownerId);
    const status = await resumeAccountDeletion(
      deps,
      { id: requestId, targetId: ownerId },
      await loadHeldSet(deps),
    );
    expect(status).toBe('held');
    expect(await projectOf(unheldProjectId)).toBeUndefined();
    expect(await projectOf(heldProject.projectId)).toBeDefined();
    expect(await deps.storage.head('private', unheldSource.objectKey!)).toBeNull();
    const written = await requestOf(requestId);
    expect(written.status).toBe('held');
    expect(entryOf(written.receipt, 'database')?.rowsDeleted).toBe(1);
    expect(entryOf(written.receipt, 'object_storage')?.objectsDeleted).toBeGreaterThanOrEqual(1);

    // A receipt already completed (by the account deletion itself) is never rewritten.
    const completed: DeletionReceiptEntry[] = [
      {
        store: 'database',
        objectsDeleted: 0,
        rowsDeleted: 7,
        completedAt: new Date().toISOString(),
        verifiedAt: null,
        error: null,
      },
    ];
    await deps.db
      .updateTable('deletionRequests')
      .set({ status: 'completed', receipt: toJson(completed) })
      .where('id', '=', requestId)
      .execute();
    await resumeAccountDeletion(
      deps,
      { id: requestId, targetId: ownerId },
      await loadHeldSet(deps),
    );
    const kept = await requestOf(requestId);
    expect(kept.status).toBe('completed');
    expect(entryOf(kept.receipt, 'database')?.rowsDeleted).toBe(7);
  });
});
