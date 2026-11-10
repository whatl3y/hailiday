import {
  NON_TERMINAL_RENDER_JOB_STATES,
  type DeletionRequester,
  type DeletionScope,
  type DeletionStatus,
} from '@holiday/core';
import { HOUR_MS, MINUTE_MS, addMs } from '../../clock/index.js';
import { toJson } from '../../db/client.js';
import type { DeletionReceiptEntry, Project } from '../../db/schema.js';
import { newId, sha256Hex } from '../../ids/index.js';
import {
  isRelightBaseCompanion,
  isUnsentAttempt,
  recordAllowanceResidue,
} from '../../limits/index.js';
import { PUBLIC_PREFIXES, keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { reviewObjectKeyOf } from '../uploads/screen.js';
import { terminateRenderJob } from '../render/terminate.js';
import { heldWithin, loadHeldSet, projectHoldOf, type HeldSet } from './holds.js';
import { completeAssetPurge } from './takedown.js';
import { mirrorTombstones, writeTombstones, type TombstoneEntry } from './tombstones.js';

const NO_ID = '00000000-0000-0000-0000-000000000000';

/** The share token of a grant, recovered from its card key (`cards/{token}.jpg`). */
export function shareTokenFromCardKey(cardKey: string | null): string | null {
  if (!cardKey?.startsWith(PUBLIC_PREFIXES.cards) || !cardKey.endsWith('.jpg')) return null;
  return cardKey.slice(PUBLIC_PREFIXES.cards.length, -'.jpg'.length);
}

/**
 * Deletes a grant's public copies (shared images and card) and purges their CDN paths. Returns
 * the objects deleted.
 */
export async function deleteSharePublicObjects(
  deps: Pick<PipelineDeps, 'storage'>,
  cardKey: string | null,
): Promise<number> {
  const token = shareTokenFromCardKey(cardKey);
  if (!token) return 0;
  let deleted = await deps.storage.deletePrefix('public', keys.sharedPrefix(token));
  if (cardKey) {
    await deps.storage.delete('public', cardKey);
    deleted += 1;
  }
  await deps.storage.purgePublic([
    keys.shared(token, 'after'),
    keys.shared(token, 'before'),
    keys.card(token),
  ]);
  return deleted;
}

export interface ProjectDeletionResult {
  deletionRequestId: string;
  status: 'completed' | 'held' | 'pinned';
  objectsDeleted: number;
  rowsDeleted: number;
  /**
   * Whether this call's completion removed the project's rows and wrote the request's receipt.
   * False when another completion of the same request (a concurrent or earlier caller) did, when
   * the request was already completed, and when a hold kept the rows.
   */
  removedRows: boolean;
}

async function projectRows(deps: Pick<PipelineDeps, 'db'>, projectId: string) {
  const sources = await deps.db
    .selectFrom('sourceAssets')
    .select([
      'id',
      'objectKey',
      'ownerId',
      'kind',
      'screening',
      'attestationVersion',
      'attestedAt',
      'preservationHoldId',
    ])
    .where('projectId', '=', projectId)
    .execute();
  const assets = await deps.db
    .selectFrom('renderAssets')
    .select([
      'id',
      'objectKey',
      'downloadObjectKey',
      'jobId',
      'sourceAssetId',
      'preservationHoldId',
      'deletedAt',
    ])
    .where('projectId', '=', projectId)
    .execute();
  const jobs = await deps.db
    .selectFrom('renderJobs')
    .select(['id', 'state', 'sourceAssetId', 'renderAssetId'])
    .where('projectId', '=', projectId)
    .execute();
  return { sources, assets, jobs };
}

/** Live grants of the given variants (expiry pinning). */
async function liveGrantAssets(
  deps: Pick<PipelineDeps, 'db'>,
  assetIds: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const rows = await deps.db
    .selectFrom('shareGrants')
    .select('renderAssetId')
    .where('renderAssetId', 'in', [...assetIds])
    .where('revokedAt', 'is', null)
    .where('expiresAt', '>', now)
    .execute();
  return new Set(rows.map((row) => row.renderAssetId));
}

/**
 * Step 1 of the deletion order, in one transaction: the `deletion_requests` row (`in_progress`),
 * tombstones (project, source and variant ID hashes, object-key hashes, and each source's
 * attestation version and timestamp), and the project, its source assets and its variants marked
 * deleted, so every endpoint answers `NOT_FOUND` from here on. An expiry sweep leaves variants
 * with a live share grant unmarked (they stay pinned to the grant). Returns the request ID.
 *
 * The transaction locks the project row first, so concurrent first deletions of one project share
 * one request: a caller that finds the project already marked deleted (or already removed) writes
 * nothing and returns the latest request of the project, the one the other caller created.
 */
export async function beginProjectDeletion(
  deps: PipelineDeps,
  input: { project: Project; scope: DeletionScope; requestedBy: DeletionRequester },
): Promise<string> {
  return (await startProjectDeletion(deps, input)).requestId;
}

interface StartedDeletion {
  requestId: string;
  scope: DeletionScope;
  /** Set when the request was created by a concurrent or earlier caller. */
  joined: { status: DeletionStatus } | null;
}

async function startProjectDeletion(
  deps: PipelineDeps,
  input: { project: Project; scope: DeletionScope; requestedBy: DeletionRequester },
): Promise<StartedDeletion> {
  const { project } = input;
  const now = deps.clock.now();
  const requestId = newId();
  const { sources, assets } = await projectRows(deps, project.id);
  const pinned =
    input.scope === 'expiry_sweep'
      ? await liveGrantAssets(
          deps,
          assets.map((asset) => asset.id),
          now,
        )
      : new Set<string>();
  const entries: TombstoneEntry[] = [
    { kind: 'project', hash: sha256Hex(project.id) },
    ...sources.map((source) => ({
      kind: 'source_asset' as const,
      hash: sha256Hex(source.id),
      attestationVersion: source.attestationVersion,
      attestedAt: source.attestedAt,
    })),
    ...assets
      .filter((asset) => !pinned.has(asset.id))
      .map((asset) => ({ kind: 'render_asset' as const, hash: sha256Hex(asset.id) })),
    ...objectKeyTombstones([
      ...sources.flatMap((source) => [
        source.objectKey,
        keys.quarantine(source.id),
        reviewObjectKeyOf(source.screening),
      ]),
      ...assets
        .filter((asset) => !pinned.has(asset.id))
        .flatMap((asset) => [asset.objectKey, asset.downloadObjectKey]),
    ]),
  ];
  return deps.db.transaction().execute(async (trx): Promise<StartedDeletion> => {
    const locked = await trx
      .selectFrom('projects')
      .select('deletedAt')
      .where('id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();
    if (!locked || locked.deletedAt) {
      const existing = await trx
        .selectFrom('deletionRequests')
        .select(['id', 'scope', 'status'])
        .where('targetId', '=', project.id)
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .executeTakeFirst();
      // A completed request on a row that still exists is an earlier expiry that kept variants
      // pinned to a live share grant: deleting what remains takes a new request.
      if (existing && (existing.status !== 'completed' || !locked)) {
        return {
          requestId: existing.id,
          scope: existing.scope,
          joined: { status: existing.status },
        };
      }
    }
    await trx
      .insertInto('deletionRequests')
      .values({
        id: requestId,
        ownerId: project.ownerId,
        scope: input.scope,
        targetId: project.id,
        requestedBy: input.requestedBy,
        accessRevokedAt: now,
        status: 'in_progress',
      })
      .execute();
    await writeTombstones(trx, { deletionRequestId: requestId, now, entries });
    await trx
      .updateTable('projects')
      .set({ deletedAt: now })
      .where('id', '=', project.id)
      .where('deletedAt', 'is', null)
      .execute();
    await trx
      .updateTable('sourceAssets')
      .set({ deletedAt: now })
      .where('projectId', '=', project.id)
      .where('deletedAt', 'is', null)
      .execute();
    await trx
      .updateTable('renderAssets')
      .set({ deletedAt: now })
      .where('projectId', '=', project.id)
      .where('deletedAt', 'is', null)
      .where('id', 'not in', pinned.size > 0 ? [...pinned] : [NO_ID])
      .execute();
    return { requestId, scope: input.scope, joined: null };
  });
}

/** `object_key` tombstones for the non-empty keys. */
export function objectKeyTombstones(keyList: readonly (string | null)[]): TombstoneEntry[] {
  return [...new Set(keyList.filter((key): key is string => !!key))].map((key) => ({
    kind: 'object_key' as const,
    hash: sha256Hex(key),
  }));
}

/**
 * Sets a deletion request's status and receipt. With `keepCompleted`, a request that is already
 * `completed` keeps its receipt (the write is skipped in the same statement).
 */
export async function setDeletionRequestStatus(
  deps: Pick<PipelineDeps, 'db' | 'clock'>,
  requestId: string,
  status: DeletionStatus,
  counts: { objectsDeleted: number; rowsDeleted: number },
  options: { keepCompleted?: boolean } = {},
) {
  const at = deps.clock.now();
  const receipt: DeletionReceiptEntry[] = [
    {
      store: 'object_storage',
      objectsDeleted: counts.objectsDeleted,
      rowsDeleted: 0,
      completedAt: at.toISOString(),
      verifiedAt: null,
      error: null,
    },
    {
      store: 'database',
      objectsDeleted: 0,
      rowsDeleted: counts.rowsDeleted,
      completedAt: status === 'completed' ? at.toISOString() : null,
      verifiedAt: null,
      error: null,
    },
  ];
  await deps.db
    .updateTable('deletionRequests')
    .set({
      status,
      receipt: toJson(receipt),
      completedAt: status === 'completed' ? at : null,
      providerDeletion: toJson({ requested: false, reason: 'no_provider_deletion_api' }),
    })
    .where('id', '=', requestId)
    .$if(options.keepCompleted === true, (qb) => qb.where('status', '<>', 'completed'))
    .execute();
}

/**
 * Steps 2 to 7 of the deletion order for a project whose step 1 has run: cancel work, revoke
 * shares (an expiry sweep keeps a live grant's variant pinned), delete objects, delete or redact
 * rows, receipt. Idempotent, so an interrupted deletion is completed by running it again.
 *
 * Preservation holds suspend steps 4 and 5 for what they cover. When anything in the project is
 * held, the project row is never deleted (its cascade would remove the held rows): objects and
 * rows that are not held are deleted or marked deleted, held rows keep their objects and stay
 * marked deleted for the owner, and the request is `held`. Once every hold is released, running
 * this again completes the deletion.
 */
export async function completeProjectDeletion(
  deps: PipelineDeps,
  input: { project: Project; requestId: string; scope: DeletionScope; held?: HeldSet },
): Promise<ProjectDeletionResult> {
  const { project, requestId } = input;
  const now = deps.clock.now();
  const expirySweep = input.scope === 'expiry_sweep';
  const { sources, assets, jobs } = await projectRows(deps, project.id);
  const held = heldWithin(input.held ?? (await loadHeldSet(deps)), project, { sources, assets });

  // 2. Cancel work.
  for (const job of jobs) {
    if ((NON_TERMINAL_RENDER_JOB_STATES as readonly string[]).includes(job.state)) {
      await terminateRenderJob(deps, { jobId: job.id, to: expirySweep ? 'expired' : 'canceled' });
    }
  }

  // 3. Revoke shares. An expiry sweep keeps live grants: their variant stays pinned.
  const grants = await deps.db
    .selectFrom('shareGrants')
    .selectAll()
    .where('renderAssetId', 'in', assets.length > 0 ? assets.map((asset) => asset.id) : [NO_ID])
    .execute();
  const pinned = new Set<string>();
  let objectsDeleted = 0;
  for (const grant of grants) {
    const live = !grant.revokedAt && grant.expiresAt.getTime() > now.getTime();
    if (live && expirySweep && !held.any) {
      pinned.add(grant.renderAssetId);
      continue;
    }
    if (!grant.revokedAt) {
      await deps.db
        .updateTable('shareGrants')
        .set({ revokedAt: now })
        .where('id', '=', grant.id)
        .execute();
    }
    objectsDeleted += await deleteSharePublicObjects(deps, grant.shareCardObjectKey);
    await writeTombstones(deps.db, {
      deletionRequestId: requestId,
      now,
      entries: [{ kind: 'share_token', hash: grant.tokenHash }],
    });
  }
  if (held.projectHold) {
    await deps.db
      .updateTable('renderAssets')
      .set({ deletedAt: now })
      .where('projectId', '=', project.id)
      .where('deletedAt', 'is', null)
      .execute();
    await mirrorTombstones(deps, { deletionRequestId: requestId });
    await setDeletionRequestStatus(deps, requestId, 'held', { objectsDeleted, rowsDeleted: 0 });
    return {
      deletionRequestId: requestId,
      status: 'held',
      objectsDeleted,
      rowsDeleted: 0,
      removedRows: false,
    };
  }

  // 4. Delete objects (never under held/, never a held row's objects).
  const deleteKey = async (key: string | null) => {
    if (!key) return;
    await deps.storage.delete('private', key);
    objectsDeleted += 1;
  };
  for (const source of sources) {
    if (held.sources.has(source.id)) continue;
    await deleteKey(source.objectKey);
    await deleteKey(keys.quarantine(source.id));
    await deleteKey(reviewObjectKeyOf(source.screening));
  }
  for (const job of jobs) {
    if (held.sources.has(job.sourceAssetId)) continue;
    if (job.renderAssetId && held.assets.has(job.renderAssetId)) continue;
    objectsDeleted += await deps.storage.deletePrefix('private', keys.workingPrefix(job.id));
    objectsDeleted += await deps.storage.deletePrefix('private', `attempts/${job.id}/`);
  }
  for (const asset of assets) {
    if (pinned.has(asset.id) || held.assets.has(asset.id)) continue;
    objectsDeleted += await deps.storage.deletePrefix(
      'private',
      keys.outputPrefix(project.ownerId, asset.id),
    );
    await deleteKey(asset.downloadObjectKey);
  }

  if (held.any) {
    // 5 (partial). Rows that are not held are marked deleted and lose their object references;
    // held rows keep theirs. The project row and everything else stay until the hold is released.
    // A row already marked deleted keeps its mark (step 1 stamps it with the request's
    // access-revocation time, which the variant count of a resumed deletion matches on).
    await deps.db.transaction().execute(async (trx) => {
      const unheldSources = sources.filter((source) => !held.sources.has(source.id));
      if (unheldSources.length > 0) {
        await trx
          .updateTable('sourceAssets')
          .set((eb) => ({
            state: 'deleted',
            deletedAt: eb.fn.coalesce('deletedAt', eb.val(now)),
            objectKey: null,
            viewpoint: null,
            screening: null,
          }))
          .where(
            'id',
            'in',
            unheldSources.map((source) => source.id),
          )
          .execute();
      }
      const unheldAssets = assets.filter((asset) => !held.assets.has(asset.id));
      if (unheldAssets.length > 0) {
        await trx
          .updateTable('renderAssets')
          .set((eb) => ({
            deletedAt: eb.fn.coalesce('deletedAt', eb.val(now)),
            downloadable: false,
            downloadObjectKey: null,
          }))
          .where(
            'id',
            'in',
            unheldAssets.map((asset) => asset.id),
          )
          .execute();
      }
    });
    await mirrorTombstones(deps, { deletionRequestId: requestId });
    await setDeletionRequestStatus(deps, requestId, 'held', { objectsDeleted, rowsDeleted: 0 });
    return {
      deletionRequestId: requestId,
      status: 'held',
      objectsDeleted,
      rowsDeleted: 0,
      removedRows: false,
    };
  }

  // 5. Delete or redact rows. Counted allowance units of the removed rows leave residue in the
  // same transaction, so deletion never returns units to a rolling window. Null when another
  // completion of the same request already removed them (nothing is recorded again).
  const removed = await deps.db.transaction().execute(async (trx): Promise<number | null> => {
    // The project row lock serializes concurrent completions of the same deletion (a repeated
    // request, a concurrent first request and the sweep's resume): the second sees the first's
    // result and records nothing. A project kept for a pinned variant keeps its row, so there the
    // request's own status (or finding nothing left to remove) tells a later completion apart.
    const projectRow = await trx
      .selectFrom('projects')
      .select('id')
      .where('id', '=', project.id)
      .forUpdate()
      .executeTakeFirst();
    if (!projectRow) return null;
    const request = await trx
      .selectFrom('deletionRequests')
      .select('status')
      .where('id', '=', requestId)
      .forUpdate()
      .executeTakeFirst();
    if (request?.status === 'completed') return null;
    const currentJobs = await trx
      .selectFrom('renderJobs')
      .select(['id', 'state', 'succeededAt', 'inputSnapshot'])
      .where('projectId', '=', project.id)
      .execute();
    const keepJobs = new Set(
      assets.filter((asset) => pinned.has(asset.id)).map((asset) => asset.jobId),
    );
    const removedJobs = currentJobs.filter((job) => !keepJobs.has(job.id));
    // An attempt that was never sent counts toward no attempt quota, so it leaves no residue.
    const attempts =
      removedJobs.length > 0
        ? (
            await trx
              .selectFrom('renderAttempts')
              .select([
                'createdAt',
                'outcome',
                'providerOperationId',
                'requestSentAt',
                'ledgerEntryId',
              ])
              .where(
                'jobId',
                'in',
                removedJobs.map((job) => job.id),
              )
              .execute()
          ).filter((attempt) => !isUnsentAttempt(attempt))
        : [];
    await recordAllowanceResidue(trx, {
      ownerId: project.ownerId,
      now,
      units: [
        ...(project.kind === 'address' && pinned.size === 0
          ? [{ kind: 'address' as const, countedAt: project.createdAt }]
          : []),
        ...removedJobs
          .filter((job) => job.state === 'succeeded' && !isRelightBaseCompanion(job.inputSnapshot))
          .map((job) => ({ kind: 'variant' as const, countedAt: job.succeededAt })),
        ...attempts.map((attempt) => ({ kind: 'attempt' as const, countedAt: attempt.createdAt })),
      ],
    });

    let deleted = 0;
    if (pinned.size === 0) {
      const result = await trx
        .deleteFrom('projects')
        .where('id', '=', project.id)
        .executeTakeFirst();
      deleted += Number(result.numDeletedRows ?? 0);
      if (project.propertyId) {
        const property = await trx
          .deleteFrom('properties')
          .where('id', '=', project.propertyId)
          .executeTakeFirst();
        deleted += Number(property.numDeletedRows ?? 0);
      }
      return deleted;
    }
    const keep = [...pinned];
    const removedAssets = await trx
      .deleteFrom('renderAssets')
      .where('projectId', '=', project.id)
      .where('id', 'not in', keep)
      .executeTakeFirst();
    deleted += Number(removedAssets.numDeletedRows ?? 0);
    if (removedJobs.length > 0) {
      const removedJobRows = await trx
        .deleteFrom('renderJobs')
        .where(
          'id',
          'in',
          removedJobs.map((job) => job.id),
        )
        .executeTakeFirst();
      deleted += Number(removedJobRows.numDeletedRows ?? 0);
    }
    // A pinned variant's job keeps its plans and attempts, and with them the analysis they cite.
    await trx
      .deleteFrom('sceneAnalyses')
      .where('sourceAssetId', 'in', sources.length > 0 ? sources.map((s) => s.id) : [NO_ID])
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('decorationPlans')
              .select('decorationPlans.id')
              .whereRef('decorationPlans.sceneAnalysisId', '=', 'sceneAnalyses.id'),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('renderAttempts')
              .select('renderAttempts.id')
              .whereRef('renderAttempts.sceneAnalysisId', '=', 'sceneAnalyses.id'),
          ),
        ),
      )
      .execute();
    await trx
      .updateTable('sourceAssets')
      .set({ state: 'deleted', deletedAt: now, objectKey: null, viewpoint: null, screening: null })
      .where('projectId', '=', project.id)
      .execute();
    if (project.propertyId) {
      await trx
        .updateTable('properties')
        .set({
          placeId: 'redacted',
          targetLat: null,
          targetLng: null,
          coordsSource: null,
          coordsExpireAt: null,
          displayAddress: null,
          displayAddressBasis: null,
          manualEntry: null,
        })
        .where('id', '=', project.propertyId)
        .execute();
    }
    // Nothing left to remove: a completion of the same request that committed first removed it.
    return deleted > 0 ? deleted : null;
  });

  // 7. Receipt (and the tombstone mirror outside the database). Only the completion that removed
  // the rows writes over a receipt; any other one writes only while the request is not yet
  // completed, so a completed receipt (rows and objects alike) is never rewritten by it.
  await mirrorTombstones(deps, { deletionRequestId: requestId });
  const rowsDeleted = removed ?? 0;
  await setDeletionRequestStatus(
    deps,
    requestId,
    'completed',
    { objectsDeleted, rowsDeleted },
    { keepCompleted: removed === null },
  );
  return {
    deletionRequestId: requestId,
    status: pinned.size > 0 ? 'pinned' : 'completed',
    objectsDeleted,
    rowsDeleted,
    removedRows: removed !== null,
  };
}

/**
 * Deletes a project in the privacy spec's order of operations: tombstone and refuse (project and
 * its rows marked deleted, hashes recorded), cancel or expire running jobs, revoke shares (an
 * expiry sweep keeps a live grant's shared variant pinned), delete objects, delete rows, write the
 * receipt. Objects and rows under a preservation hold are kept and the request is marked `held`.
 *
 * A caller that joins a request already created for the project (a concurrent first deletion)
 * completes that request: a completed request of a removed project is returned as it is, and an
 * expiry sweep joining a user's or operator's request completes it with that request's scope.
 */
export async function deleteProject(
  deps: PipelineDeps,
  input: { project: Project; scope: DeletionScope; requestedBy: DeletionRequester },
): Promise<ProjectDeletionResult> {
  const started = await startProjectDeletion(deps, input);
  if (started.joined?.status === 'completed') {
    return {
      deletionRequestId: started.requestId,
      status: 'completed',
      objectsDeleted: 0,
      rowsDeleted: 0,
      removedRows: false,
    };
  }
  const scope = input.scope === 'expiry_sweep' ? started.scope : input.scope;
  return completeProjectDeletion(deps, {
    project: input.project,
    requestId: started.requestId,
    scope,
  });
}

/** Deletion requests older than this without completing are overdue (the alert threshold). */
export const DELETION_OVERDUE_MS = HOUR_MS;

export interface DeletionResumeResult {
  resumed: number;
  completed: number;
  held: number;
  failed: number;
  overdue: number;
}

/**
 * Completes deletion requests that did not finish (`pending`, `in_progress` or `failed`, for
 * example after a storage error) and re-checks `held` requests whose holds may have been released.
 * Project-scoped requests (`project`, `expiry_sweep`, `takedown`, and `account` per project)
 * re-run steps 2 to 7 on the same request; an account request deletes the owner's remaining
 * projects; an `asset` request completes its variant purge. A request still open after
 * `DELETION_OVERDUE_MS` is logged at error level (the deletion-failure alert).
 */
export async function resumeDeletionRequests(
  deps: PipelineDeps,
  options: { olderThanMs?: number; limit?: number } = {},
): Promise<DeletionResumeResult> {
  const now = deps.clock.now();
  const result: DeletionResumeResult = { resumed: 0, completed: 0, held: 0, failed: 0, overdue: 0 };
  // Unfinished requests and held ones are selected separately, so long-lived holds never crowd
  // unfinished deletions out of a run.
  const due = (statuses: DeletionStatus[]) =>
    deps.db
      .selectFrom('deletionRequests')
      .selectAll()
      .where('status', 'in', statuses)
      .where('createdAt', '<=', addMs(now, -(options.olderThanMs ?? 5 * MINUTE_MS)))
      .orderBy('updatedAt')
      .limit(options.limit ?? 50)
      .execute();
  const requests = [...(await due(['pending', 'in_progress', 'failed'])), ...(await due(['held']))];
  if (requests.length === 0) return result;
  const heldSet = await loadHeldSet(deps);

  for (const request of requests) {
    const ageMs = now.getTime() - request.createdAt.getTime();
    try {
      let status: DeletionStatus | 'pinned' | null = null;
      if (request.scope === 'asset') {
        status = await completeAssetPurge(deps, {
          renderAssetId: request.targetId,
          requestId: request.id,
          held: heldSet,
        });
      } else {
        const project = await deps.db
          .selectFrom('projects')
          .selectAll()
          .where('id', '=', request.targetId)
          .executeTakeFirst();
        if (project) {
          if (request.status === 'held') {
            const rows = await projectRows(deps, project.id);
            if (heldWithin(heldSet, project, rows).any) {
              // Still held: touched so the next run checks the other held requests first.
              await deps.db
                .updateTable('deletionRequests')
                .set({ status: 'held' })
                .where('id', '=', request.id)
                .execute();
              continue;
            }
          }
          status = (
            await completeProjectDeletion(deps, {
              project,
              requestId: request.id,
              scope: request.scope,
              held: heldSet,
            })
          ).status;
        } else if (request.scope === 'account') {
          status = await resumeAccountDeletion(deps, request, heldSet);
        } else {
          await setDeletionRequestStatus(deps, request.id, 'completed', {
            objectsDeleted: 0,
            rowsDeleted: 0,
          });
          status = 'completed';
        }
      }
      if (status === null) continue;
      result.resumed += 1;
      if (status === 'held') result.held += 1;
      else if (status === 'completed' || status === 'pinned') result.completed += 1;
    } catch (error) {
      result.failed += 1;
      await deps.db
        .updateTable('deletionRequests')
        .set({ status: 'failed' })
        .where('id', '=', request.id)
        .execute();
      deps.logger.error(
        { err: error, deletionRequestId: request.id, scope: request.scope, ageMs },
        'deletion request retry failed',
      );
    }
    const after = await deps.db
      .selectFrom('deletionRequests')
      .select('status')
      .where('id', '=', request.id)
      .executeTakeFirst();
    if (after && after.status !== 'completed' && after.status !== 'held') {
      if (ageMs >= DELETION_OVERDUE_MS) {
        result.overdue += 1;
        deps.logger.error(
          { deletionRequestId: request.id, scope: request.scope, ageMs },
          'deletion request overdue',
        );
      }
    }
  }
  return result;
}

/**
 * An account request: deletes the owner's projects that were never started, then settles the
 * request once every remaining project is gone or held. The receipt counts what the account's
 * per-project requests actually did (see `accountDeletionTotals`), and a completed receipt is never
 * rewritten.
 */
export async function resumeAccountDeletion(
  deps: PipelineDeps,
  request: { id: string; targetId: string },
  heldSet: HeldSet,
): Promise<DeletionStatus | null> {
  const projects = await deps.db
    .selectFrom('projects')
    .selectAll()
    .where('ownerId', '=', request.targetId)
    .execute();
  let anyHeld = false;
  let open = false;
  for (const project of projects) {
    if (!project.deletedAt) {
      const outcome = await deleteProject(deps, {
        project,
        scope: 'account',
        requestedBy: 'user',
      });
      if (outcome.status === 'held') anyHeld = true;
      continue;
    }
    if (projectHoldOf(heldSet, project)) {
      anyHeld = true;
      continue;
    }
    const rows = await projectRows(deps, project.id);
    if (heldWithin(heldSet, project, rows).any) anyHeld = true;
    else open = true;
  }
  if (open) return null;
  const status: DeletionStatus = anyHeld ? 'held' : 'completed';
  await setDeletionRequestStatus(
    deps,
    request.id,
    status,
    await accountDeletionTotals(deps, { ownerId: request.targetId, requestId: request.id }),
    { keepCompleted: true },
  );
  return status;
}

/**
 * The receipt totals of an account deletion, from what its per-project requests (scope `account`,
 * one per project) did: rows deleted counts the projects whose row is gone, so a project kept
 * under a preservation hold does not count; objects deleted sums the object-storage entries of
 * those requests' receipts, held projects included (their unheld objects were deleted).
 */
export async function accountDeletionTotals(
  deps: Pick<PipelineDeps, 'db'>,
  input: { ownerId: string; requestId: string },
): Promise<{ objectsDeleted: number; rowsDeleted: number }> {
  const requests = await deps.db
    .selectFrom('deletionRequests')
    .select(['targetId', 'receipt'])
    .where('ownerId', '=', input.ownerId)
    .where('scope', '=', 'account')
    .where('id', '<>', input.requestId)
    .where('targetId', '<>', input.ownerId)
    .execute();
  const targets = [...new Set(requests.map((row) => row.targetId))];
  const remaining =
    targets.length > 0
      ? await deps.db.selectFrom('projects').select('id').where('id', 'in', targets).execute()
      : [];
  const present = new Set(remaining.map((row) => row.id));
  const objectsDeleted = requests
    .flatMap((row) => row.receipt ?? [])
    .filter((entry) => entry.store === 'object_storage')
    .reduce((sum, entry) => sum + entry.objectsDeleted, 0);
  return {
    objectsDeleted,
    rowsDeleted: targets.filter((id) => !present.has(id)).length,
  };
}
