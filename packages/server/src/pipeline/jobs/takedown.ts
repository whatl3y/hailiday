import type { DeletionRequester, DeletionStatus } from '@holiday/core';
import { newId, sha256Hex } from '../../ids/index.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import {
  deleteSharePublicObjects,
  objectKeyTombstones,
  setDeletionRequestStatus,
} from './deletion.js';
import { loadHeldSet, type HeldSet } from './holds.js';
import { mirrorTombstones, writeTombstones } from './tombstones.js';

export interface PurgeResult {
  purged: number;
  held: number;
  deletionRequestIds: string[];
}

/**
 * Removes delivered variants through the deletion order, one `asset` deletion request each:
 * withdrawn and marked deleted (owners and share pages lose access at once), share grants revoked
 * with their public copies and CDN paths, output and download objects deleted, tombstones written
 * and mirrored. A variant under a preservation hold loses access but keeps its objects (`held`).
 */
export async function purgeRenderAssets(
  deps: PipelineDeps,
  input: { renderAssetIds: readonly string[]; requestedBy: DeletionRequester },
): Promise<PurgeResult> {
  const result: PurgeResult = { purged: 0, held: 0, deletionRequestIds: [] };
  if (input.renderAssetIds.length === 0) return result;
  const held = await loadHeldSet(deps);
  for (const renderAssetId of new Set(input.renderAssetIds)) {
    const asset = await deps.db
      .selectFrom('renderAssets')
      .select(['id', 'ownerId', 'objectKey', 'downloadObjectKey'])
      .where('id', '=', renderAssetId)
      .executeTakeFirst();
    if (!asset) continue;
    const now = deps.clock.now();
    const requestId = newId();
    await deps.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('deletionRequests')
        .values({
          id: requestId,
          ownerId: asset.ownerId,
          scope: 'asset',
          targetId: asset.id,
          requestedBy: input.requestedBy,
          accessRevokedAt: now,
          status: 'in_progress',
        })
        .execute();
      await writeTombstones(trx, {
        deletionRequestId: requestId,
        now,
        entries: [
          { kind: 'render_asset', hash: sha256Hex(asset.id) },
          ...objectKeyTombstones([asset.objectKey, asset.downloadObjectKey]),
        ],
      });
      await trx
        .updateTable('renderAssets')
        .set((eb) => ({
          withdrawnAt: eb.fn.coalesce('withdrawnAt', eb.val(now)),
          deletedAt: eb.fn.coalesce('deletedAt', eb.val(now)),
        }))
        .where('id', '=', asset.id)
        .execute();
      await trx
        .updateTable('shareGrants')
        .set({ revokedAt: now })
        .where('renderAssetId', '=', asset.id)
        .where('revokedAt', 'is', null)
        .execute();
    });
    result.deletionRequestIds.push(requestId);
    const status = await completeAssetPurge(deps, { renderAssetId: asset.id, requestId, held });
    if (status === 'held') result.held += 1;
    else result.purged += 1;
  }
  return result;
}

/**
 * Completes one variant purge whose request exists (also the deletion resume of an `asset`
 * request): grants revoked and their public copies deleted, objects deleted unless held, receipt.
 * Idempotent.
 */
export async function completeAssetPurge(
  deps: PipelineDeps,
  input: { renderAssetId: string; requestId: string; held?: HeldSet },
): Promise<DeletionStatus> {
  const now = deps.clock.now();
  const asset = await deps.db
    .selectFrom('renderAssets')
    .select(['id', 'ownerId', 'downloadObjectKey', 'preservationHoldId', 'deletedAt'])
    .where('id', '=', input.renderAssetId)
    .executeTakeFirst();
  if (!asset) {
    await setDeletionRequestStatus(deps, input.requestId, 'completed', {
      objectsDeleted: 0,
      rowsDeleted: 0,
    });
    return 'completed';
  }
  let objectsDeleted = 0;
  const grants = await deps.db
    .selectFrom('shareGrants')
    .selectAll()
    .where('renderAssetId', '=', asset.id)
    .execute();
  for (const grant of grants) {
    if (!grant.revokedAt) {
      await deps.db
        .updateTable('shareGrants')
        .set({ revokedAt: now })
        .where('id', '=', grant.id)
        .execute();
    }
    objectsDeleted += await deleteSharePublicObjects(deps, grant.shareCardObjectKey);
    await writeTombstones(deps.db, {
      deletionRequestId: input.requestId,
      now,
      entries: [{ kind: 'share_token', hash: grant.tokenHash }],
    });
  }
  const held = input.held ?? (await loadHeldSet(deps));
  if (held.assets.has(asset.id) || asset.preservationHoldId) {
    await mirrorTombstones(deps, { deletionRequestId: input.requestId });
    await setDeletionRequestStatus(deps, input.requestId, 'held', {
      objectsDeleted,
      rowsDeleted: 0,
    });
    return 'held';
  }
  objectsDeleted += await deps.storage.deletePrefix(
    'private',
    keys.outputPrefix(asset.ownerId, asset.id),
  );
  if (asset.downloadObjectKey) {
    await deps.storage.delete('private', asset.downloadObjectKey);
    objectsDeleted += 1;
  }
  await deps.db
    .updateTable('renderAssets')
    .set({
      downloadable: false,
      downloadObjectKey: null,
      distributable: false,
      deletedAt: asset.deletedAt ?? now,
    })
    .where('id', '=', asset.id)
    .execute();
  await mirrorTombstones(deps, { deletionRequestId: input.requestId });
  await setDeletionRequestStatus(deps, input.requestId, 'completed', {
    objectsDeleted,
    rowsDeleted: 0,
  });
  return 'completed';
}

/**
 * Homeowner opt-out and whole-house blur: every Street View-derived variant of a place, in every
 * owner's projects, goes through `purgeRenderAssets`. Uploads are never matched (a photo has no
 * address). The place ID is used only for the lookup; nothing with an address is written.
 */
export async function purgePlace(
  deps: PipelineDeps,
  placeId: string,
  options: { requestedBy: DeletionRequester },
): Promise<PurgeResult> {
  const rows = await deps.db
    .selectFrom('renderAssets')
    .innerJoin('projects', 'projects.id', 'renderAssets.projectId')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .innerJoin('sourceAssets', 'sourceAssets.id', 'renderAssets.sourceAssetId')
    .select('renderAssets.id')
    .where('properties.placeId', '=', placeId)
    .where('sourceAssets.kind', '=', 'street_view')
    .where('renderAssets.deletedAt', 'is', null)
    .execute();
  return purgeRenderAssets(deps, {
    renderAssetIds: rows.map((row) => row.id),
    requestedBy: options.requestedBy,
  });
}

/**
 * A removed or blurred panorama: every variant made from the source asset goes through
 * `purgeRenderAssets` (address spec, panorama changes, blur and takedown).
 */
export async function purgeSourceDerivatives(
  deps: PipelineDeps,
  sourceAssetId: string,
  options: { requestedBy: DeletionRequester },
): Promise<PurgeResult> {
  const rows = await deps.db
    .selectFrom('renderAssets')
    .select('id')
    .where('sourceAssetId', '=', sourceAssetId)
    .where('deletedAt', 'is', null)
    .execute();
  return purgeRenderAssets(deps, {
    renderAssetIds: rows.map((row) => row.id),
    requestedBy: options.requestedBy,
  });
}

/**
 * Enforces the opt-out list on variants that already exist: every Street View-derived variant of
 * a place on `blocked_addresses` (homeowner opt-out, whole-house blur detected at render time,
 * operator block) that is not yet deleted goes through `purgeRenderAssets`. The retention sweep
 * runs it, so a block written by any path removes existing variants within the hour.
 */
export async function purgeBlockedPlaces(
  deps: PipelineDeps,
  options: { limit?: number } = {},
): Promise<PurgeResult> {
  const rows = await deps.db
    .selectFrom('renderAssets')
    .innerJoin('projects', 'projects.id', 'renderAssets.projectId')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .innerJoin('sourceAssets', 'sourceAssets.id', 'renderAssets.sourceAssetId')
    .innerJoin('blockedAddresses', 'blockedAddresses.placeId', 'properties.placeId')
    .select('renderAssets.id')
    .where('blockedAddresses.removedAt', 'is', null)
    .where('sourceAssets.kind', '=', 'street_view')
    .where('renderAssets.deletedAt', 'is', null)
    .limit(options.limit ?? 200)
    .execute();
  return purgeRenderAssets(deps, {
    renderAssetIds: rows.map((row) => row.id),
    requestedBy: 'system',
  });
}
