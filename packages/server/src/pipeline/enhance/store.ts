import type { DbOrTx } from '../../db/client.js';
import type { SourceAsset, SourceEnhancement } from '../../db/schema.js';
import { sha256Hex } from '../../ids/index.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { decodeRaster, type Raster } from '../imaging/raster.js';
import type { WorkingImage } from '../imaging/working.js';
import type { HeldSet } from '../jobs/holds.js';
import { PIPELINE_DEFAULTS } from '../versions.js';

/**
 * Whether a `failed` row can still be resumed from its stored output: the raw output is stored
 * and has no judge answer, so the next job judges it without sending an edit.
 */
export function enhancementAwaitsJudge(
  row: Partial<Pick<SourceEnhancement, 'rawObjectKey' | 'judge'>>,
): boolean {
  return (
    row.rawObjectKey !== undefined &&
    row.rawObjectKey !== null &&
    (row.judge === undefined || row.judge === null)
  );
}

/**
 * Whether an enhancement row is decided, so no job may try it again: `accepted` and `rejected`
 * always; `failed` when it is final (`retryable` false) or has used its edits (`maxEdits`) with
 * no stored output awaiting the judge (`enhancementAwaitsJudge`). `pending` is never decided.
 */
export function enhancementDecided(
  row: Pick<SourceEnhancement, 'status' | 'retryable' | 'editCount'> &
    Partial<Pick<SourceEnhancement, 'rawObjectKey' | 'judge'>>,
): boolean {
  if (row.status === 'accepted' || row.status === 'rejected') return true;
  if (row.status !== 'failed') return false;
  if (!row.retryable) return true;
  return row.editCount >= PIPELINE_DEFAULTS.enhance.maxEdits && !enhancementAwaitsJudge(row);
}

/** The enhancement row of a stored frame for a compiler version, if any. */
export async function findEnhancement(
  db: DbOrTx,
  key: { sourceAssetId: string; frameChecksum: string; compilerVersion: string },
): Promise<SourceEnhancement | null> {
  return (
    (await db
      .selectFrom('sourceEnhancements')
      .selectAll()
      .where('sourceAssetId', '=', key.sourceAssetId)
      .where('frameChecksumSha256', '=', key.frameChecksum)
      .where('compilerVersion', '=', key.compilerVersion)
      .executeTakeFirst()) ?? null
  );
}

/**
 * The working image of an accepted enhancement: the stored PNG, when its SHA-256 is the row's
 * `enhanced_checksum_sha256` and it decodes to the frame's working size. The frame's grid facts
 * (padding, content box, scale) carry over. Null when the object is missing, other bytes or
 * another size.
 */
export async function loadEnhancedWorking(
  deps: Pick<PipelineDeps, 'storage'>,
  input: { row: SourceEnhancement; frame: WorkingImage },
): Promise<WorkingImage | null> {
  const { row, frame } = input;
  if (!row.objectKey || !row.enhancedChecksumSha256) return null;
  const object = await deps.storage.get('private', row.objectKey);
  if (!object) return null;
  if (sha256Hex(object.body) !== row.enhancedChecksumSha256) return null;
  let raster: Raster;
  try {
    raster = await decodeRaster(object.body);
  } catch {
    return null;
  }
  if (raster.width !== frame.width || raster.height !== frame.height) return null;
  return { ...frame, raster, png: object.body, checksum: row.enhancedChecksumSha256 };
}

/**
 * Removes a source's enhancement rows and their stored pictures, because the frame they were
 * made from is deleted or replaced. Nothing is removed while a preservation hold covers the source
 * (the row's own hold, or `held` when the caller has resolved the holds). With `exceptId`, that
 * row and its picture stay and every other row's picture is deleted by its key; otherwise the
 * whole `enhanced/` prefix of the source goes. Returns the number of objects deleted.
 */
export async function dropSourceEnhancements(
  deps: Pick<PipelineDeps, 'db' | 'storage'>,
  source: Pick<SourceAsset, 'id' | 'ownerId' | 'preservationHoldId'>,
  options: { held?: Pick<HeldSet, 'sources'>; exceptId?: string } = {},
): Promise<number> {
  if (source.preservationHoldId || options.held?.sources.has(source.id)) return 0;
  const exceptId = options.exceptId;
  const deleted = await deps.db
    .deleteFrom('sourceEnhancements')
    .where('sourceAssetId', '=', source.id)
    .$if(exceptId !== undefined, (query) => query.where('id', '!=', exceptId as string))
    .returning('objectKey')
    .execute();
  if (exceptId === undefined) {
    return deps.storage.deletePrefix('private', keys.enhancedPrefix(source.ownerId, source.id));
  }
  let objects = 0;
  for (const row of deleted) {
    if (!row.objectKey) continue;
    await deps.storage.delete('private', row.objectKey);
    objects += 1;
  }
  return objects;
}

/** The stored pictures of the enhancements of these sources. */
export async function enhancementObjectKeys(
  db: DbOrTx,
  sourceAssetIds: readonly string[],
): Promise<string[]> {
  if (sourceAssetIds.length === 0) return [];
  const rows = await db
    .selectFrom('sourceEnhancements')
    .select('objectKey')
    .where('sourceAssetId', 'in', [...sourceAssetIds])
    .where('objectKey', 'is not', null)
    .orderBy('objectKey')
    .execute();
  return rows.flatMap((row) => (row.objectKey ? [row.objectKey] : []));
}

/**
 * Whether render admission reserves the enhancement's edit and judge call for a job of `source`:
 * the switch is on, the source is a Street View source in `persist` mode, and either the job will
 * fetch pixels (no stored frame yet, or the stored frame is due to be fetched again, so its bytes
 * may change) or no decided enhancement exists for the stored frame's checksum and the compiler
 * version. A stored frame without a recorded checksum is reserved for (no row can be looked up).
 */
export async function enhancementReservationExpected(
  db: DbOrTx,
  input: {
    enabled: boolean;
    source: Pick<SourceAsset, 'id' | 'kind' | 'objectKey' | 'checksumSha256' | 'streetViewMode'>;
    streetViewFetch: boolean;
    compilerVersion: string;
  },
): Promise<boolean> {
  const { source } = input;
  if (!input.enabled || source.kind !== 'street_view' || source.streetViewMode !== 'persist') {
    return false;
  }
  if (input.streetViewFetch || !source.objectKey || !source.checksumSha256) return true;
  const row = await findEnhancement(db, {
    sourceAssetId: source.id,
    frameChecksum: source.checksumSha256,
    compilerVersion: input.compilerVersion,
  });
  return !(row && enhancementDecided(row));
}
