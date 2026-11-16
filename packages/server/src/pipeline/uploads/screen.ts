import sharp from 'sharp';
import { UploadTriageSchema, type QualityHint, type UploadTriage } from '@hailiday/core';
import { toJson } from '../../db/client.js';
import type { SourceAsset } from '../../db/schema.js';
import { addMs } from '../../clock/index.js';
import { newId } from '../../ids/index.js';
import { keys } from '../../storage/keys.js';
import { VISION_PRICES_MICROS, charge, usageCostMicros } from '../../ledger/index.js';
import { checkSpend } from '../../limits/index.js';
import { capabilityMode } from '../../capabilities/index.js';
import { ProviderError, isProviderError } from '../../providers/errors.js';
import type {
  SafetyProvider,
  ScreeningResult,
  UploadTriageCall,
  VisionCallResult,
} from '../../providers/types.js';
import { emitServerEvent } from '../analytics.js';
import { capabilityStateFor, pipelineOptions, type PipelineDeps } from '../context.js';
import { sourceFixtureMeta } from '../render/fixture-hints.js';
import { copyHeldObjects, placePreservationHold } from '../jobs/holds.js';

/** Blocklist period of a declined normalized original's checksum (retention schedule). */
export const DECLINED_CHECKSUM_RETENTION_MS = 90 * 24 * 3_600_000;

/** Longest edge of the reduced-size copy reviewers see of a held upload. */
export const REVIEW_COPY_MAX_EDGE_PX = 1024;

/**
 * Writes the reduced-size copy of a held upload (at most 1,024 px on the longest edge, JPEG, no
 * metadata) that the hold review queue presigns instead of the normalized original. Returns its key.
 */
export async function writeReviewCopy(
  deps: Pick<PipelineDeps, 'storage'>,
  input: { sourceAssetId: string; bytes: Uint8Array },
): Promise<string> {
  const body = await sharp(input.bytes)
    .rotate()
    .resize(REVIEW_COPY_MAX_EDGE_PX, REVIEW_COPY_MAX_EDGE_PX, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 80 })
    .toBuffer();
  const key = keys.review(input.sourceAssetId);
  await deps.storage.put({
    bucket: 'private',
    key,
    body,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'upload' },
  });
  return key;
}

/** The reviewer copy key recorded in a screening summary, if any. */
export function reviewObjectKeyOf(screening: unknown): string | null {
  const key = (screening as { reviewObjectKey?: unknown } | null)?.reviewObjectKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** Deletes the reviewer copy of a held upload once its hold ends; a missing copy is fine. */
export async function deleteReviewCopy(
  deps: Pick<PipelineDeps, 'storage' | 'logger'>,
  screening: unknown,
): Promise<void> {
  const key = reviewObjectKeyOf(screening);
  if (!key) return;
  await deps.storage.delete('private', key).catch((error: unknown) => {
    deps.logger.warn({ err: error }, 'review copy deletion failed');
  });
}

/** A screening summary without the reviewer copy reference. */
export function withoutReviewCopy(screening: unknown): Record<string, unknown> {
  const rest = { ...((screening ?? {}) as Record<string, unknown>) };
  delete rest.reviewObjectKey;
  return rest;
}

/**
 * Computed quality hints (uploads spec, quality hints) on the original downscaled to 1,024 px:
 * "dark" when mean luminance is below 0.20 and the 95th percentile below 0.50; "blurry" when the
 * variance of the Laplacian is very low.
 */
export async function computedQualityHints(bytes: Uint8Array): Promise<QualityHint[]> {
  const { data, info } = await sharp(bytes)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  let sum = 0;
  const histogram = new Array<number>(256).fill(0);
  for (let i = 0; i < n; i += 1) {
    const value = data[i] as number;
    sum += value;
    histogram[value] = (histogram[value] as number) + 1;
  }
  let cumulative = 0;
  let p95 = 255;
  for (let v = 0; v < 256; v += 1) {
    cumulative += histogram[v] as number;
    if (cumulative >= n * 0.95) {
      p95 = v;
      break;
    }
  }
  const hints: QualityHint[] = [];
  if (sum / n / 255 < 0.2 && p95 / 255 < 0.5) hints.push('dark');
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  const w = info.width;
  for (let y = 1; y < info.height - 1; y += 2) {
    for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x;
      const lap =
        4 * (data[i] as number) -
        (data[i - 1] as number) -
        (data[i + 1] as number) -
        (data[i - w] as number) -
        (data[i + w] as number);
      lapSum += lap;
      lapSq += lap * lap;
      count += 1;
    }
  }
  const variance = count > 0 ? lapSq / count - (lapSum / count) ** 2 : 0;
  if (variance < 12) hints.push('blurry');
  return hints;
}

function existingDecorationsOf(triage: UploadTriage | null) {
  if (!triage) return null;
  return triage.existingDecorations === 'none'
    ? { present: false, density: 'none' }
    : {
        present: true,
        holidayGuess: triage.existingDecorations.holidayGuess,
        density: triage.existingDecorations.density,
      };
}

/** The screening leg for the `content_screening` capability (fixture adapters in `fixture`). */
async function safetyLeg(deps: PipelineDeps): Promise<SafetyProvider | null> {
  const state = await capabilityStateFor(deps, 'content_screening');
  const mode = capabilityMode(state, { roles: [] }, deps.config.appEnv);
  if (mode === 'unavailable') return null;
  return mode === 'live' ? deps.providers.safety : deps.providers.fixtures.safety;
}

/** Why a screening's triage ran on the fixture model although live vision was wanted. */
export type TriageFallbackReason =
  | 'vision_unavailable'
  | 'paused_global'
  | 'paused_provider'
  | 'spend_sku_ceiling'
  | 'spend_daily_ceiling'
  | 'spend_monthly_ceiling';

/** How a screening's triage ran, recorded on the screening record. */
export interface TriagePlan {
  triageMode: 'live' | 'fixture';
  triageFallbackReason: TriageFallbackReason | null;
}

/** Key of the recorded live triage on a screening summary while the screening is in progress. */
const LIVE_TRIAGE_KEY = 'liveTriage';

/**
 * A live triage call already made and charged for an upload: its answer (absent when the model
 * refused to look at the image) and the `vision_call` charge, recorded on the screening summary
 * in the same transaction as the charge so a redelivered screening reuses it.
 */
interface RecordedLiveTriage {
  ledgerEntryId: string;
  providerId: string;
  call: (VisionCallResult<UploadTriage> & { providerId: string }) | null;
}

function recordedLiveTriageOf(screening: unknown): RecordedLiveTriage | null {
  const value = (screening as Record<string, unknown> | null)?.[LIVE_TRIAGE_KEY] as
    Partial<RecordedLiveTriage> | undefined;
  if (!value || typeof value.ledgerEntryId !== 'string' || typeof value.providerId !== 'string') {
    return null;
  }
  if (value.call === null) {
    return { ledgerEntryId: value.ledgerEntryId, providerId: value.providerId, call: null };
  }
  const result = UploadTriageSchema.safeParse(value.call?.result);
  if (!value.call || !result.success) return null;
  return {
    ledgerEntryId: value.ledgerEntryId,
    providerId: value.providerId,
    call: { ...value.call, result: result.data },
  };
}

/**
 * The triage call of an upload screening, resolved from the vision leg (`vision_analysis` for a
 * public audience), independently of the content-screening leg that runs hash matching and
 * moderation. It is resolved lazily, when the screening reaches the triage step. A live call
 * first honors `pause.global`, `pause.provider.<vision provider>` and the spend ceilings (one
 * `vision_call` line); when blocked, or when vision is unavailable, the fixture triage runs and
 * the reason is kept. After a live call its cost (from reported usage) is charged as a
 * `vision_call` at stage `screening`; a call the model refused (`moderation_blocked`, which
 * reports no usage) is charged at the triage list price. The answer and the charge are recorded
 * on the screening summary together, and a redelivered screening reuses that record instead of
 * calling and charging again. A failed live call fails the screening (the job retries).
 */
function triageLeg(
  deps: PipelineDeps,
  owner: {
    ownerId: string;
    projectId: string;
    sourceAssetId: string;
    recorded: RecordedLiveTriage | null;
  },
): { call: UploadTriageCall; plan: () => TriagePlan | null; ledgerEntryId: () => string | null } {
  let plan: TriagePlan | null = null;
  let ledgerEntryId: string | null = null;
  const fixtureVision = deps.providers.fixtures.vision;
  const resolve = async (): Promise<TriagePlan> => {
    const state = await capabilityStateFor(deps, 'vision_analysis');
    const mode = capabilityMode(state, { roles: [] }, deps.config.appEnv);
    if (mode === 'fixture') return { triageMode: 'fixture', triageFallbackReason: null };
    if (mode === 'unavailable' || deps.providers.vision.mode !== 'live') {
      return { triageMode: 'fixture', triageFallbackReason: 'vision_unavailable' };
    }
    if (await deps.settings.get('pause.global')) {
      return { triageMode: 'fixture', triageFallbackReason: 'paused_global' };
    }
    if (await deps.settings.isProviderPaused(deps.config.providers.vision)) {
      return { triageMode: 'fixture', triageFallbackReason: 'paused_provider' };
    }
    const block = await checkSpend(deps.db, deps.settings, {
      now: deps.clock.now(),
      additional: new Map([['vision_call', VISION_PRICES_MICROS.triage]]),
      isFixture: false,
    });
    if (block) {
      return {
        triageMode: 'fixture',
        triageFallbackReason: block.reason === 'paused' ? 'paused_global' : `spend_${block.reason}`,
      };
    }
    return { triageMode: 'live', triageFallbackReason: null };
  };
  /** Charges a live triage call and records it on the screening summary in one transaction. */
  const record = async (
    line: { unitPriceMicros: number; modelId: string | null },
    call: RecordedLiveTriage['call'],
  ): Promise<void> => {
    ledgerEntryId = await deps.db.transaction().execute(async (trx) => {
      const entry = await charge(
        trx,
        { ownerId: owner.ownerId, projectId: owner.projectId, isFixture: false },
        {
          provider: deps.config.providers.vision,
          sku: 'vision_call',
          stage: 'screening',
          units: 1,
          unitPriceMicros: line.unitPriceMicros,
          modelId: line.modelId,
          isFixture: false,
        },
        deps.clock,
      );
      const row = await trx
        .selectFrom('sourceAssets')
        .select('screening')
        .where('id', '=', owner.sourceAssetId)
        .forUpdate()
        .executeTakeFirst();
      const recorded: RecordedLiveTriage = {
        ledgerEntryId: entry.id,
        providerId: deps.providers.vision.providerId,
        call,
      };
      await trx
        .updateTable('sourceAssets')
        .set({
          screening: toJson({
            ...((row?.screening as Record<string, unknown> | null) ?? {}),
            [LIVE_TRIAGE_KEY]: recorded,
          }),
        })
        .where('id', '=', owner.sourceAssetId)
        .execute();
      return entry.id;
    });
  };
  const call: UploadTriageCall = async (input, options) => {
    if (owner.recorded) {
      plan = { triageMode: 'live', triageFallbackReason: null };
      ledgerEntryId = owner.recorded.ledgerEntryId;
      if (owner.recorded.call) return owner.recorded.call;
      throw new ProviderError(owner.recorded.providerId, 'moderation_blocked', 'Triage refused', {
        retryable: false,
      });
    }
    plan = await resolve();
    if (plan.triageMode === 'fixture') {
      const result = await fixtureVision.classifyUpload(input, options);
      return { ...result, providerId: fixtureVision.providerId };
    }
    const vision = deps.providers.vision;
    let result: VisionCallResult<UploadTriage>;
    try {
      result = await vision.classifyUpload(input, options);
    } catch (error) {
      if (isProviderError(error) && error.kind === 'moderation_blocked') {
        await record({ unitPriceMicros: VISION_PRICES_MICROS.triage, modelId: null }, null);
      }
      throw error;
    }
    const answered = { ...result, providerId: vision.providerId };
    await record(
      {
        unitPriceMicros:
          usageCostMicros(result.model, {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            ...(result.usage.cacheReadInputTokens !== undefined
              ? { cacheReadInputTokens: result.usage.cacheReadInputTokens }
              : {}),
          }) ?? VISION_PRICES_MICROS.triage,
        modelId: result.model,
      },
      answered,
    );
    return answered;
  };
  return { call, plan: () => plan, ledgerEntryId: () => ledgerEntryId };
}

/** Key of the `screened_upload` charge's ledger entry ID on a screening summary. */
const SCREENED_LEDGER_KEY = 'screenedLedgerEntryId';

/**
 * Charges an upload's `screened_upload` line once. The charge and its ledger entry ID on the
 * screening summary are written in one transaction under the source asset's row lock, so a
 * redelivered screening that finds the recorded ID charges nothing again. Returns the entry ID.
 */
async function chargeScreenedUpload(
  deps: PipelineDeps,
  asset: { id: string; ownerId: string; projectId: string },
  line: { providerId: string; isFixture: boolean },
): Promise<string> {
  return deps.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('sourceAssets')
      .select('screening')
      .where('id', '=', asset.id)
      .forUpdate()
      .executeTakeFirst();
    const current = (row?.screening as Record<string, unknown> | null) ?? {};
    const recorded = current[SCREENED_LEDGER_KEY];
    if (typeof recorded === 'string' && recorded.length > 0) return recorded;
    const entry = await charge(
      trx,
      { ownerId: asset.ownerId, projectId: asset.projectId, isFixture: line.isFixture },
      { provider: line.providerId, sku: 'screened_upload', stage: 'screening', units: 1 },
      deps.clock,
    );
    await trx
      .updateTable('sourceAssets')
      .set({ screening: toJson({ ...current, [SCREENED_LEDGER_KEY]: entry.id }) })
      .where('id', '=', asset.id)
      .execute();
    return entry.id;
  });
}

export type ScreenOutcome =
  | { outcome: 'admitted' | 'declined' | 'held'; result: ScreeningResult }
  | { outcome: 'skipped'; state: SourceAsset['state'] };

/**
 * The `upload_screen` job (uploads spec, content admission): hash matching and the moderation
 * classifier before any paid vision call, then the living-space and scene check with people
 * detection, on the normalized original. Ends `ready` (scene type, people flags and boxes,
 * suggested crop, hints, existing decorations, season cues), `declined` (reason class and
 * reason; safety declines blocklist the checksum), or stays `screening` held for review.
 */
export async function screenUpload(
  deps: PipelineDeps,
  payload: { sourceAssetId: string },
): Promise<ScreenOutcome> {
  const asset = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', payload.sourceAssetId)
    .executeTakeFirst();
  if (!asset || asset.state !== 'screening' || asset.holdForReview || !asset.objectKey) {
    return { outcome: 'skipped', state: asset?.state ?? 'deleted' };
  }
  const object = await deps.storage.get('private', asset.objectKey);
  if (!object) throw new Error('normalized original is missing');
  const meta = await sharp(object.body).metadata();
  const started = deps.clock.now();
  const safety = await safetyLeg(deps);
  if (!safety) throw new Error('content screening is unavailable');
  const fixture = sourceFixtureMeta(asset);
  const triageCall = triageLeg(deps, {
    ownerId: asset.ownerId,
    projectId: asset.projectId,
    sourceAssetId: asset.id,
    recorded: recordedLiveTriageOf(asset.screening),
  });
  const result = await safety.screenUpload({
    image: { bytes: object.body, width: meta.width ?? 0, height: meta.height ?? 0 },
    sourceAssetId: asset.id,
    fixture: { fileName: fixture.fileName ?? null },
    triage: triageCall.call,
  });
  const triagePlan = triageCall.plan();
  const triageLedgerEntryId = triageCall.ledgerEntryId();
  // Fixture work only when neither the screener nor the triage reached a live provider.
  const fixtureWork = result.providerMode === 'fixture' && triagePlan?.triageMode !== 'live';
  const now = deps.clock.now();
  const screenedLedgerEntryId = await chargeScreenedUpload(deps, asset, {
    providerId: safety.providerId,
    isFixture: fixtureWork,
  });
  const previous = { ...((asset.screening as Record<string, unknown> | null) ?? {}) };
  delete previous[LIVE_TRIAGE_KEY];
  const screening = {
    ...previous,
    [SCREENED_LEDGER_KEY]: screenedLedgerEntryId,
    providerMode: fixtureWork ? 'fixture' : 'live',
    outcome: result.outcome,
    reasonClass: result.reasonClass,
    reason: result.reason,
    childSafety: result.childSafety,
    checks: result.checks,
    usage: result.usage,
    ...(triagePlan
      ? {
          triageMode: triagePlan.triageMode,
          triageFallbackReason: triagePlan.triageFallbackReason,
        }
      : {}),
    ...(triageLedgerEntryId ? { triageLedgerEntryId } : {}),
    ...(result.triageCall
      ? {
          triageModel: result.triageCall.model,
          triagePromptVersion: result.triageCall.promptVersion,
          triageUsage: result.triageCall.usage,
        }
      : {}),
    screenedAt: now.toISOString(),
  };

  if (result.outcome === 'held') {
    const reviewObjectKey = await writeReviewCopy(deps, {
      sourceAssetId: asset.id,
      bytes: object.body,
    });
    await deps.db
      .updateTable('sourceAssets')
      .set({
        holdForReview: true,
        screening: toJson({
          ...screening,
          reviewObjectKey,
          heldAt: now.toISOString(),
          holdUntil: addMs(now, pipelineOptions(deps).uploadHoldWindowMs).toISOString(),
        }),
      })
      .where('id', '=', asset.id)
      .where('state', '=', 'screening')
      .execute();
    return { outcome: 'held', result };
  }

  if (result.outcome === 'declined') {
    const reasonClass = result.reasonClass ?? 'safety';
    const reason =
      result.reason ?? (reasonClass === 'safety' ? 'classifier' : 'not_a_living_space');
    await deps.db
      .updateTable('sourceAssets')
      .set({
        state: 'declined',
        declinedCode: 'UPLOAD_DECLINED',
        declinedReasonClass: reasonClass,
        declinedReason: reason,
        holdForReview: false,
        screening: toJson({ ...screening, preservationRequired: result.childSafety }),
        ...(result.triage
          ? {
              sceneType: result.triage.sceneType,
              sceneTypeConfidence: result.triage.sceneTypeConfidence,
              multiUnitFacade: result.triage.multiUnitFacade,
            }
          : {}),
      })
      .where('id', '=', asset.id)
      .where('state', '=', 'screening')
      .execute();
    if (reasonClass === 'safety' && asset.checksumSha256) {
      await deps.db
        .insertInto('tombstones')
        .values({
          id: newId(),
          kind: 'declined_checksum',
          hashSha256: asset.checksumSha256,
          deletedAt: now,
          retainUntil: addMs(now, DECLINED_CHECKSUM_RETENTION_MS),
        })
        .onConflict((oc) =>
          oc.columns(['kind', 'hashSha256']).doUpdateSet({
            retainUntil: addMs(now, DECLINED_CHECKSUM_RETENTION_MS),
          }),
        )
        .execute();
    }
    if (result.childSafety) {
      await holdForChildSafety(deps, asset.id, reason);
    }
    await emitServerEvent(deps.db, deps, {
      name: 'upload_declined',
      ownerId: asset.ownerId,
      fixture: fixtureWork,
      properties: {
        declineCode: 'UPLOAD_DECLINED',
        declineReason: reasonClass === 'guidance' ? reason : null,
      },
    });
    return { outcome: 'declined', result };
  }

  const triage = result.triage;
  const hints = [
    ...new Set([...result.qualityHints, ...(await computedQualityHints(object.body))]),
  ];
  await deps.db
    .updateTable('sourceAssets')
    .set({
      state: 'ready',
      readyAt: now,
      holdForReview: false,
      sceneType: triage?.sceneType ?? null,
      sceneTypeConfidence: triage?.sceneTypeConfidence ?? null,
      roomType: triage?.sceneType === 'interior' ? (triage.roomType ?? null) : null,
      buildingForm: triage?.sceneType === 'house_exterior' ? (triage.buildingForm ?? null) : null,
      multiUnitFacade: triage?.multiUnitFacade ?? false,
      peopleDetected: result.peopleDetected,
      peopleBoxes: result.peopleDetected ? toJson(result.peopleBoxes) : null,
      suggestedCropBox: result.suggestedCropBox ? toJson(result.suggestedCropBox) : null,
      qualityHints: hints,
      existingDecorations: toJson(existingDecorationsOf(triage)),
      seasonCues: toJson(triage?.seasonCues ?? []),
      screening: toJson(screening),
    })
    .where('id', '=', asset.id)
    .where('state', '=', 'screening')
    .execute();
  await emitServerEvent(deps.db, deps, {
    name: 'upload_accepted',
    ownerId: asset.ownerId,
    sceneType: triage?.sceneType ?? null,
    fixture: fixtureWork,
    properties: {
      sceneType: triage?.sceneType ?? null,
      roomType: triage?.sceneType === 'interior' ? (triage.roomType ?? null) : null,
      peopleDetected: result.peopleDetected,
      screeningMs: Math.max(0, now.getTime() - started.getTime()),
    },
  });
  return { outcome: 'admitted', result };
}

/**
 * Child-safety procedure step 2 for an automated signal: a `mandatory_report` preservation hold
 * on the declined source asset (no operator; release by an operator only), its normalized original
 * copied under `held/`, and operations paged. The uploader sees only the neutral decline.
 */
async function holdForChildSafety(
  deps: PipelineDeps,
  sourceAssetId: string,
  signal: string,
): Promise<void> {
  const existing = await deps.db
    .selectFrom('sourceAssets')
    .select('preservationHoldId')
    .where('id', '=', sourceAssetId)
    .executeTakeFirst();
  if (existing?.preservationHoldId) return;
  const { holdId } = await deps.db.transaction().execute((trx) =>
    placePreservationHold(trx, {
      targetKind: 'source_asset',
      targetId: sourceAssetId,
      reason: 'mandatory_report',
      authorityRef: `automated:${signal}`,
      releaseCondition:
        'One year after the CyberTipline report, or operator release after review finds no report is required',
      placedBy: null,
    }),
  );
  await copyHeldObjects(deps, holdId);
  deps.logger.error({ sourceAssetId, holdId }, 'child-safety signal on an upload; hold placed');
}

/**
 * Declines uploads held for review whose hold window ended without a decision (internal reason
 * `hold_timeout`). Run by the retention sweep. The `upload_declined` event is fixture work only
 * when the held upload's screening summary records `providerMode` `fixture`.
 */
export async function expireUploadHolds(deps: PipelineDeps, limit = 500): Promise<number> {
  const now = deps.clock.now();
  const held = await deps.db
    .selectFrom('sourceAssets')
    .select(['id', 'ownerId', 'screening', 'updatedAt'])
    .where('state', '=', 'screening')
    .where('holdForReview', '=', true)
    .limit(limit)
    .execute();
  let expired = 0;
  const windowMs = pipelineOptions(deps).uploadHoldWindowMs;
  for (const asset of held) {
    const screening = (asset.screening ?? {}) as { holdUntil?: string; heldAt?: string };
    const until = screening.holdUntil
      ? new Date(screening.holdUntil)
      : addMs(screening.heldAt ? new Date(screening.heldAt) : asset.updatedAt, windowMs);
    if (until.getTime() > now.getTime()) continue;
    const result = await deps.db
      .updateTable('sourceAssets')
      .set({
        state: 'declined',
        holdForReview: false,
        declinedCode: 'UPLOAD_DECLINED',
        declinedReasonClass: 'safety',
        declinedReason: 'hold_timeout',
        screening: toJson(withoutReviewCopy(asset.screening)),
      })
      .where('id', '=', asset.id)
      .where('state', '=', 'screening')
      .where('holdForReview', '=', true)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) > 0) {
      expired += 1;
      await deleteReviewCopy(deps, asset.screening);
      await emitServerEvent(deps.db, deps, {
        name: 'upload_declined',
        ownerId: asset.ownerId,
        fixture: (asset.screening as { providerMode?: unknown } | null)?.providerMode !== 'live',
        properties: { declineCode: 'UPLOAD_DECLINED', declineReason: null },
      });
    }
  }
  return expired;
}
