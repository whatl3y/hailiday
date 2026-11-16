import type { DeletionRequester, DeletionStatus } from '@hailiday/core';
import { newId, sha256Hex } from '../../ids/index.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { dropSourceEnhancements } from '../enhance/store.js';
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

export interface PlacePurgeResult extends PurgeResult {
  /** Street View sources of the place that were `ready` and are now `declined`. */
  sourcesDeclined: number;
  /** Stored Street View frames of the place that were deleted. */
  framesDeleted: number;
}

/**
 * Takes the Street View sources of blocked places out of use: each `ready` source becomes
 * `declined` (nothing can be rendered from it again) and every stored frame is deleted with its
 * enhancements and its object key cleared, except for a source under a preservation hold, which keeps its copy.
 * `placeId` limits it to one place; otherwise every place on the opt-out list now is covered, at
 * most `limit` sources per call.
 */
async function retirePlaceSources(
  deps: PipelineDeps,
  input: { placeId?: string; now: Date; limit?: number },
): Promise<{ sourcesDeclined: number; framesDeleted: number }> {
  const held = await loadHeldSet(deps);
  const heldIds = [...held.sources.keys()];
  let query = deps.db
    .selectFrom('sourceAssets')
    .innerJoin('projects', 'projects.id', 'sourceAssets.projectId')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .select([
      'sourceAssets.id',
      'sourceAssets.ownerId',
      'sourceAssets.state',
      'sourceAssets.objectKey',
      'sourceAssets.preservationHoldId',
    ])
    .where('sourceAssets.kind', '=', 'street_view')
    .where('sourceAssets.deletedAt', 'is', null)
    .where((eb) =>
      eb.or([
        eb('sourceAssets.state', '=', 'ready'),
        eb.and([
          eb('sourceAssets.objectKey', 'is not', null),
          eb('sourceAssets.preservationHoldId', 'is', null),
          ...(heldIds.length > 0 ? [eb('sourceAssets.id', 'not in', heldIds)] : []),
        ]),
      ]),
    );
  query = input.placeId
    ? query.where('properties.placeId', '=', input.placeId)
    : query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('blockedAddresses')
            .select('blockedAddresses.id')
            .whereRef('blockedAddresses.placeId', '=', 'properties.placeId')
            .where('blockedAddresses.removedAt', 'is', null)
            .where((inner) =>
              inner.or([
                inner('blockedAddresses.expiresAt', 'is', null),
                inner('blockedAddresses.expiresAt', '>', input.now),
              ]),
            ),
        ),
      );
  const rows = await query
    .orderBy('sourceAssets.id')
    .$if(input.limit !== undefined, (q) => q.limit(input.limit as number))
    .execute();
  let sourcesDeclined = 0;
  let framesDeleted = 0;
  for (const row of rows) {
    if (row.objectKey && !held.sources.has(row.id) && !row.preservationHoldId) {
      await deps.storage.delete('private', row.objectKey);
      await deps.db
        .updateTable('sourceAssets')
        .set({ objectKey: null })
        .where('id', '=', row.id)
        .execute();
      await dropSourceEnhancements(deps, row, { held });
      framesDeleted += 1;
    }
    if (row.state === 'ready') {
      const declined = await deps.db
        .updateTable('sourceAssets')
        .set({ state: 'declined' })
        .where('id', '=', row.id)
        .where('state', '=', 'ready')
        .executeTakeFirst();
      if (Number(declined.numUpdatedRows) > 0) sourcesDeclined += 1;
    }
  }
  return { sourcesDeclined, framesDeleted };
}

/**
 * Homeowner opt-out and whole-house blur: every Street View-derived variant of a place, in every
 * owner's projects, goes through `purgeRenderAssets`, and the place's Street View sources are
 * taken out of use (`declined`, stored frames deleted unless a preservation hold covers them).
 * Uploads are never matched (a photo has no address). The place ID is used only for the lookup;
 * nothing with an address is written.
 */
export async function purgePlace(
  deps: PipelineDeps,
  placeId: string,
  options: { requestedBy: DeletionRequester },
): Promise<PlacePurgeResult> {
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
  const purged = await purgeRenderAssets(deps, {
    renderAssetIds: rows.map((row) => row.id),
    requestedBy: options.requestedBy,
  });
  return { ...purged, ...(await retirePlaceSources(deps, { placeId, now: deps.clock.now() })) };
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
 * Enforces the opt-out list on what already exists: every Street View-derived variant of a place
 * on `blocked_addresses` now (homeowner opt-out, whole-house blur detected at render time,
 * operator block; not removed, not expired) that is not yet deleted goes through
 * `purgeRenderAssets`, and the Street View sources of those places are taken out of use
 * (`declined`, stored frames deleted unless a preservation hold covers them). The retention sweep
 * runs it, so a block written by any path removes existing variants and frames within the hour.
 */
export async function purgeBlockedPlaces(
  deps: PipelineDeps,
  options: { limit?: number } = {},
): Promise<PlacePurgeResult> {
  const now = deps.clock.now();
  const limit = options.limit ?? 200;
  const rows = await deps.db
    .selectFrom('renderAssets')
    .innerJoin('projects', 'projects.id', 'renderAssets.projectId')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .innerJoin('sourceAssets', 'sourceAssets.id', 'renderAssets.sourceAssetId')
    .innerJoin('blockedAddresses', 'blockedAddresses.placeId', 'properties.placeId')
    .select('renderAssets.id')
    .where('blockedAddresses.removedAt', 'is', null)
    .where((eb) =>
      eb.or([
        eb('blockedAddresses.expiresAt', 'is', null),
        eb('blockedAddresses.expiresAt', '>', now),
      ]),
    )
    .where('sourceAssets.kind', '=', 'street_view')
    .where('renderAssets.deletedAt', 'is', null)
    .limit(limit)
    .execute();
  const purged = await purgeRenderAssets(deps, {
    renderAssetIds: rows.map((row) => row.id),
    requestedBy: 'system',
  });
  return { ...purged, ...(await retirePlaceSources(deps, { now, limit })) };
}
