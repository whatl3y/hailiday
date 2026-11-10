import type {
  DetectedFormat,
  UploadDeclineCode,
  UploadDeclineReason,
  UploadDeclineReasonClass,
} from '@holiday/core';
import { DEFAULT_UPLOAD_MAX_BYTES } from '@holiday/core';
import { withTransaction } from '../../db/client.js';
import type { SourceAsset } from '../../db/schema.js';
import { sha256Hex } from '../../ids/index.js';
import { EnqueueConflictError } from '../../queue/client.js';
import { keys } from '../../storage/keys.js';
import { emitServerEvent } from '../analytics.js';
import { pipelineOptions, type PipelineDeps } from '../context.js';
import { decodeInChild } from './decoder.js';
import { ACCEPTED_FORMATS, sniffFormat } from './sniff.js';

export type ValidateOutcome =
  | { outcome: 'promoted'; checksum: string; width: number; height: number }
  | {
      outcome: 'declined';
      code: UploadDeclineCode;
      reason: UploadDeclineReason;
      detectedFormat: DetectedFormat;
    }
  | { outcome: 'skipped'; state: SourceAsset['state'] };

/** Declines an upload with a code, class and reason, and drops its quarantined bytes. */
export async function declineUpload(
  deps: PipelineDeps,
  asset: SourceAsset,
  decline: {
    code: UploadDeclineCode;
    reasonClass: UploadDeclineReasonClass;
    reason: UploadDeclineReason;
    originalFormat?: string | null;
  },
): Promise<void> {
  await deps.db
    .updateTable('sourceAssets')
    .set({
      state: 'declined',
      declinedCode: decline.code,
      declinedReasonClass: decline.reasonClass,
      declinedReason: decline.reason,
      holdForReview: false,
      ...(decline.originalFormat !== undefined ? { originalFormat: decline.originalFormat } : {}),
    })
    .where('id', '=', asset.id)
    .where('state', 'in', ['quarantined', 'screening'])
    .execute();
  await deps.storage.delete('private', keys.quarantine(asset.id)).catch(() => undefined);
  await emitServerEvent(deps.db, deps, {
    name: 'upload_declined',
    ownerId: asset.ownerId,
    fixture: deps.config.providers.safety === 'fixture',
    properties: {
      declineCode: decline.code,
      declineReason: decline.reasonClass === 'guidance' ? decline.reason : null,
    },
  });
}

/**
 * The `upload_validate` job (uploads spec, server-side validation): the asset is `screening` from
 * the start; the quarantined bytes are sniffed, decoded and normalized in the decoder child
 * process; the normalized original is checked against the declined-checksum blocklist, promoted to
 * `originals/`, the quarantine object deleted, and the validation fields recorded and
 * `upload_screen` enqueued in one transaction. Re-running after promotion only re-enqueues.
 */
export async function validateUpload(
  deps: PipelineDeps,
  payload: { sourceAssetId: string; correlationId?: string | null },
): Promise<ValidateOutcome> {
  const options = pipelineOptions(deps);
  const asset = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', payload.sourceAssetId)
    .executeTakeFirst();
  if (!asset || asset.kind !== 'upload')
    return { outcome: 'skipped', state: asset?.state ?? 'deleted' };
  if (asset.state !== 'quarantined' && asset.state !== 'screening') {
    return { outcome: 'skipped', state: asset.state };
  }
  if (asset.state === 'quarantined') {
    await deps.db
      .updateTable('sourceAssets')
      .set({ state: 'screening' })
      .where('id', '=', asset.id)
      .where('state', '=', 'quarantined')
      .execute();
  }
  const current = { ...asset, state: 'screening' as const };

  // A retry after promotion: the normalized original exists; only screening remains.
  if (current.objectKey && current.checksumSha256) {
    await enqueueScreen(deps, current, payload.correlationId ?? null);
    return {
      outcome: 'promoted',
      checksum: current.checksumSha256,
      width: current.width ?? 0,
      height: current.height ?? 0,
    };
  }

  const quarantined = await deps.storage.get('private', keys.quarantine(asset.id));
  if (!quarantined) throw new Error('quarantined upload object is missing');
  const bytes = quarantined.body;
  const decline = async (
    code: UploadDeclineCode,
    reason: UploadDeclineReason,
    detectedFormat: DetectedFormat,
  ): Promise<ValidateOutcome> => {
    await declineUpload(deps, current, {
      code,
      reasonClass: 'guidance',
      reason,
      originalFormat: detectedFormat,
    });
    return { outcome: 'declined', code, reason, detectedFormat };
  };

  const expectedLength = asset.originalByteLength ?? asset.byteLength;
  if (bytes.length === 0) return decline('VALIDATION_FAILED', 'unreadable', 'unknown');
  if (
    bytes.length > deps.config.storage.uploadMaxBytes ||
    bytes.length > DEFAULT_UPLOAD_MAX_BYTES
  ) {
    return decline('UPLOAD_TOO_LARGE', 'file_too_large', sniffFormat(bytes));
  }
  if (expectedLength !== null && expectedLength !== bytes.length) {
    return decline('VALIDATION_FAILED', 'unreadable', sniffFormat(bytes));
  }
  const detected = sniffFormat(bytes);
  if (!ACCEPTED_FORMATS.includes(detected)) {
    return decline('UPLOAD_UNSUPPORTED_FORMAT', 'unsupported_format', detected);
  }
  if (asset.contentType && asset.contentType !== `image/${detected}`) {
    deps.logger.info(
      { sourceAssetId: asset.id, declared: asset.contentType, detected },
      'declared upload type differs from the detected format',
    );
  }

  const result = await decodeInChild(bytes, detected as 'jpeg' | 'png' | 'webp', {
    timeoutMs: options.decodeTimeoutMs,
  });
  if (!result.ok) return decline(result.decline.code, result.decline.reason, detected);

  const checksum = sha256Hex(result.bytes);
  const blocked = await deps.db
    .selectFrom('tombstones')
    .select('id')
    .where('kind', '=', 'declined_checksum')
    .where('hashSha256', '=', checksum)
    .where('retainUntil', '>', deps.clock.now())
    .executeTakeFirst();
  if (blocked) {
    await declineUpload(deps, current, {
      code: 'UPLOAD_DECLINED',
      reasonClass: 'safety',
      reason: 'checksum_blocklisted',
      originalFormat: detected,
    });
    return {
      outcome: 'declined',
      code: 'UPLOAD_DECLINED',
      reason: 'checksum_blocklisted',
      detectedFormat: detected,
    };
  }

  const key = keys.original(asset.ownerId, asset.id);
  await deps.storage.put({
    bucket: 'private',
    key,
    body: result.bytes,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'upload' },
  });
  await deps.storage.delete('private', keys.quarantine(asset.id));
  const promoted: SourceAsset = {
    ...current,
    objectKey: key,
    checksumSha256: checksum,
    contentType: 'image/jpeg',
    byteLength: result.bytes.length,
    width: result.width,
    height: result.height,
    originalFormat: detected,
    originalByteLength: bytes.length,
    originalWidth: result.originalWidth,
    originalHeight: result.originalHeight,
    orientationApplied: result.orientation,
  };
  await withTransaction(deps.db, async (trx) => {
    await trx
      .updateTable('sourceAssets')
      .set({
        objectKey: promoted.objectKey,
        checksumSha256: promoted.checksumSha256,
        contentType: promoted.contentType,
        byteLength: promoted.byteLength,
        width: promoted.width,
        height: promoted.height,
        originalFormat: promoted.originalFormat,
        originalByteLength: promoted.originalByteLength,
        originalWidth: promoted.originalWidth,
        originalHeight: promoted.originalHeight,
        orientationApplied: promoted.orientationApplied,
      })
      .where('id', '=', asset.id)
      .execute();
    await enqueueScreen({ ...deps, db: trx }, promoted, payload.correlationId ?? null);
  });
  return { outcome: 'promoted', checksum, width: result.width, height: result.height };
}

async function enqueueScreen(
  deps: Pick<PipelineDeps, 'db' | 'queue'>,
  asset: SourceAsset,
  correlationId: string | null,
): Promise<void> {
  if (!deps.queue) return;
  try {
    await deps.queue.enqueue(deps.db, 'upload_screen', {
      sourceAssetId: asset.id,
      ownerId: asset.ownerId,
      correlationId,
    });
  } catch (error) {
    if (!(error instanceof EnqueueConflictError)) throw error;
  }
}
