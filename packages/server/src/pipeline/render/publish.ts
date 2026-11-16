import sharp from 'sharp';
import {
  type DecorationPlan,
  type FidelityMode,
  type JudgeResult,
  type NormalizedBox,
  type ProviderMode,
  type ProviderWatermark,
} from '@hailiday/core';
import { toJson, type DbOrTx, type Tx } from '../../db/client.js';
import type {
  Project,
  ProvenanceJson,
  RenderAsset,
  RenderAttempt,
  RenderJob,
  SourceAsset,
} from '../../db/schema.js';
import { isFixturePhotoCopyright } from '../../fixtures/copyright.js';
import { newId } from '../../ids/index.js';
import type { AssetPermission } from '../../policy/index.js';
import { keys } from '../../storage/keys.js';
import { emitServerEvent } from '../analytics.js';
import type { PipelineDeps } from '../context.js';
import {
  addAttributionBand,
  burnPreviewMark,
  deliveredXmp,
  previewMarkCorner,
} from '../imaging/label.js';
import { encodeJpeg, toRect, type Raster } from '../imaging/raster.js';
import { IPTC_DIGITAL_SOURCE_TYPE } from '../versions.js';
import { placementsPutBack, restoredBoxesOf } from './last-resort.js';
import { releaseRemaining } from './ledger.js';
import { LostRaceError, transitionJob } from './transitions.js';

/** The delivered file and the optional download file of an accepted candidate. */
export interface Deliverables {
  delivered: Buffer;
  width: number;
  height: number;
  download: Buffer | null;
  distributable: boolean;
  downloadable: boolean;
  attributionText: string | null;
  labelApplied: boolean;
}

/**
 * Street View attribution line: the policy text or "Google Maps", plus the image copyright. A
 * fixture stand-in photograph is credited to its photographer alone (it is not Google imagery).
 */
export function attributionLine(
  source: Pick<SourceAsset, 'kind' | 'copyright'>,
  permission: Pick<AssetPermission, 'attribution'>,
): string | null {
  if (source.kind !== 'street_view') return null;
  if (isFixturePhotoCopyright(source.copyright)) return source.copyright;
  const base = permission.attribution ?? 'Google Maps';
  return source.copyright ? `${base} · ${source.copyright}` : base;
}

/**
 * Builds the delivered JPEG (quality 90, progressive, sRGB, IPTC digital source type and credit,
 * padding cropped out) and, when the variant is downloadable, the download file with the burned-in
 * "AI preview" corner mark (upper left on Street View-origin variants, lower right otherwise) and,
 * for Street View-origin variants, the attribution band.
 */
export async function buildDeliverables(input: {
  candidate: Raster;
  contentBox: NormalizedBox | null;
  source: Pick<SourceAsset, 'kind' | 'copyright' | 'privateOnly'>;
  permission: AssetPermission;
  quality: number;
  downloadMark: boolean;
}): Promise<Deliverables> {
  let raster = input.candidate;
  if (input.contentBox) {
    const rect = toRect(input.contentBox, raster.width, raster.height);
    const data = await sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: 3 },
    })
      .extract({ left: rect.x0, top: rect.y0, width: rect.x1 - rect.x0, height: rect.y1 - rect.y0 })
      .raw()
      .toBuffer();
    raster = { data, width: rect.x1 - rect.x0, height: rect.y1 - rect.y0 };
  }
  const xmp = deliveredXmp();
  const delivered = await encodeJpeg(raster, { quality: input.quality, progressive: true, xmp });
  const distributable = input.permission.distributeDerivative && !input.source.privateOnly;
  const downloadable = distributable;
  const attributionText = attributionLine(input.source, input.permission);
  let download: Buffer | null = null;
  if (downloadable) {
    // Street View-origin images carry burned-in attribution in both lower corners, so the mark
    // goes to the upper left.
    let image: Buffer = input.downloadMark
      ? await burnPreviewMark(delivered, { corner: previewMarkCorner(input.source.kind) })
      : delivered;
    if (attributionText) image = await addAttributionBand(image, attributionText);
    download = await sharp(image)
      .jpeg({ quality: input.quality, progressive: true, chromaSubsampling: '4:4:4' })
      .withXmp(xmp)
      .toBuffer();
  }
  return {
    delivered,
    width: raster.width,
    height: raster.height,
    download,
    distributable,
    downloadable,
    attributionText,
    labelApplied: download !== null && input.downloadMark,
  };
}

/** The working grid a job's normalized boxes are measured on when the job did not record one. */
const DEFAULT_GRID = { width: 1024, height: 1024 };

/**
 * The placements of `plan` that spots put back from the original took out of the published
 * picture: the attempt whose pixels are published (for a relight, the base it relit) recorded a
 * restore (`composite_mask.restored`), and the placement keeps less than
 * `lastResort.minPlacementShare` of its region outside the restored boxes (`placementsPutBack`,
 * on the job's working grid).
 */
async function placementsTakenOut(
  db: DbOrTx,
  input: {
    job: Pick<RenderJob, 'workingWidth' | 'workingHeight'>;
    plan: DecorationPlan;
    attempt: Pick<RenderAttempt, 'id'>;
  },
): Promise<Set<string>> {
  const attemptId = input.plan.relightOf?.baseAttemptId ?? input.attempt.id;
  const row = await db
    .selectFrom('renderAttempts')
    .select('compositeMask')
    .where('id', '=', attemptId)
    .executeTakeFirst();
  const boxes = restoredBoxesOf(row?.compositeMask);
  if (boxes.length === 0) return new Set();
  const grid =
    input.job.workingWidth && input.job.workingHeight
      ? { width: input.job.workingWidth, height: input.job.workingHeight }
      : DEFAULT_GRID;
  return new Set(placementsPutBack({ ...grid, placements: input.plan.placements, boxes }));
}

/**
 * Product links for an accepted variant: one per kit item the plan placed (commerce spec). A link
 * is hidden (`not_present`) when the judge found its placement absent, or when spots put back
 * from the original took out every placement of its kit item (`takenOut`).
 */
async function insertProductLinks(
  trx: Tx,
  input: {
    renderAssetId: string;
    plan: DecorationPlan;
    judge: JudgeResult | null;
    adherence?: Readonly<
      Record<string, { category: boolean; colorFamily: boolean; count: boolean }>
    >;
    takenOut?: ReadonlySet<string>;
    now: Date;
  },
): Promise<void> {
  const kitItems = await trx
    .selectFrom('kitItems')
    .select(['id', 'kitItemId', 'currentProductId'])
    .where('kitId', '=', input.plan.styleKitVersionId)
    .execute();
  const byKey = new Map(kitItems.map((item) => [item.kitItemId, item]));
  const seen = new Set<string>();
  let rank = 0;
  for (const placement of [...input.plan.placements].sort((a, b) => a.priority - b.priority)) {
    if (seen.has(placement.kitItemId)) continue;
    seen.add(placement.kitItemId);
    const item = byKey.get(placement.kitItemId);
    if (!item?.currentProductId) continue;
    rank += 1;
    const judged = input.judge?.placements.find((p) => p.placementId === placement.id) ?? null;
    const takenOut = input.plan.placements
      .filter((other) => other.kitItemId === placement.kitItemId)
      .every((other) => input.takenOut?.has(other.id) ?? false);
    const absent = (judged !== null && !judged.present) || takenOut;
    const human = input.adherence?.[placement.id];
    const failedCriteria = human
      ? (['category', 'colorFamily', 'count'] as const).filter((key) => !human[key])
      : [];
    const status = human ? (failedCriteria.length === 0 ? 'pass' : 'fail') : 'not_checked';
    // `described` needs a recorded human pass; a failed category hides the item.
    const relationship = status === 'pass' ? 'described' : 'similar';
    const hidden = absent || (human !== undefined && !human.category) ? input.now : null;
    await trx
      .insertInto('renderProductLinks')
      .values({
        id: newId(),
        renderAssetId: input.renderAssetId,
        kitItemId: item.id,
        productId: item.currentProductId,
        placementRef: placement.id,
        relationship,
        adherenceStatus: status,
        adherenceCheck: toJson({
          status,
          checkedBy: human ? 'human' : null,
          checkedAt: human ? input.now.toISOString() : null,
          failedCriteria,
          judgeAdvisory: judged
            ? {
                present: judged.present,
                adherence: judged.adherence,
                confidence: judged.confidence,
              }
            : null,
        }),
        rankPosition: rank,
        hiddenAt: hidden,
        hiddenReason: hidden ? (absent ? 'not_present' : 'adherence_failed') : null,
      })
      .onConflict((oc) => oc.columns(['renderAssetId', 'kitItemId']).doNothing())
      .execute();
  }
}

/**
 * The stored expiry of a new render asset: the project's expiry while time-based deletion is on;
 * none while it is off, so the variant cache never treats a kept rendering as expired.
 */
async function renderAssetExpiry(
  deps: Pick<PipelineDeps, 'settings'>,
  project: Pick<Project, 'expiresAt'>,
): Promise<Date | null> {
  return (await deps.settings.get('retention.time_based_deletion')) ? project.expiresAt : null;
}

export interface AcceptInput {
  job: RenderJob;
  project: Project;
  source: SourceAsset;
  plan: DecorationPlan;
  attempt: RenderAttempt;
  judge: JudgeResult | null;
  deliverables: Deliverables;
  nativeWidth: number;
  nativeHeight: number;
  scaleFactor: number | null;
  providerMode: ProviderMode;
  providerWatermark: ProviderWatermark;
  providerManifestCaptured: boolean;
  permission: AssetPermission;
  /** Per-placement human adherence (pre-delivery review). */
  adherence?: Readonly<Record<string, { category: boolean; colorFamily: boolean; count: boolean }>>;
  /** The variant's fidelity mode when it differs from the plan's (the evening fallback relight). */
  fidelityMode?: FidelityMode;
  /**
   * Leaves the attempt's recorded outcome as it is: the delivered pixels came from another
   * variant (the evening fallback), not from this attempt's output.
   */
  keepAttemptOutcome?: boolean;
}

/**
 * Publishes an accepted variant: writes the output (and download) objects, then in one
 * transaction moves the job to `succeeded` by compare-and-set from the expected state, inserts
 * the render asset and its product links, and releases the remaining reservations. A lost race
 * deletes the written objects and publishes nothing.
 */
export async function publishAccepted(
  deps: PipelineDeps,
  input: AcceptInput & {
    from: 'checking' | 'needs_review';
    patch: { qaPassedAt?: Date; reviewCompletedAt?: Date };
  },
): Promise<RenderAsset> {
  const now = deps.clock.now();
  const fidelityMode = input.fidelityMode ?? input.plan.fidelityMode;
  const expiresAt = await renderAssetExpiry(deps, input.project);
  const renderAssetId = newId();
  const outputKey = keys.output(input.job.ownerId, renderAssetId, 'full.jpg');
  const downloadKey = input.deliverables.download
    ? keys.download(input.job.ownerId, renderAssetId)
    : null;
  const provenance = {
    sourceKind: input.source.kind,
    permission: input.permission,
    derivative: true,
  };
  await deps.storage.put({
    bucket: 'private',
    key: outputKey,
    body: input.deliverables.delivered,
    contentType: 'image/jpeg',
    provenance,
  });
  if (downloadKey && input.deliverables.download) {
    await deps.storage.put({
      bucket: 'private',
      key: downloadKey,
      body: input.deliverables.download,
      contentType: 'image/jpeg',
      contentDisposition: 'attachment; filename="hailiday-preview.jpg"',
      provenance,
    });
  }
  const provenanceJson: ProvenanceJson = {
    iptcDigitalSourceType: IPTC_DIGITAL_SOURCE_TYPE,
    labelApplied: input.deliverables.labelApplied,
    iptcWritten: true,
    providerManifestCaptured: input.providerManifestCaptured,
    providerWatermark: input.providerWatermark,
    holidayManifest: 'none',
    providerMode: input.providerMode,
  };
  try {
    let asset: RenderAsset | null = null;
    await transitionJob(deps.db, {
      jobId: input.job.id,
      from: input.from,
      to: 'succeeded',
      clock: deps.clock,
      patch: {
        ...input.patch,
        succeededAt: now,
        renderAssetId: null,
        failureCodes: null,
      },
      within: async (trx, job) => {
        // An earlier rendering of the same key stays: every rendering is kept.
        asset = await trx
          .insertInto('renderAssets')
          .values({
            id: renderAssetId,
            ownerId: job.ownerId,
            projectId: job.projectId,
            jobId: job.id,
            sourceAssetId: job.sourceAssetId,
            variantKey: job.variantKey,
            holidayId: job.holidayId,
            style: job.style,
            lightingMode: job.lightingMode,
            holidayPackVersion: job.holidayPackVersion,
            compilerVersion: job.compilerVersion,
            objectKey: outputKey,
            width: input.deliverables.width,
            height: input.deliverables.height,
            contentType: 'image/jpeg',
            byteLength: input.deliverables.delivered.length,
            nativeWidth: input.nativeWidth,
            nativeHeight: input.nativeHeight,
            scaleFactor: input.scaleFactor,
            fidelityMode,
            provenance: toJson(provenanceJson),
            attributionText: input.deliverables.attributionText,
            distributable: input.deliverables.distributable,
            downloadable: input.deliverables.downloadable,
            downloadObjectKey: downloadKey,
            existingDecorConflict: input.plan.existingDecorConflict,
            expiresAt,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('renderJobs')
          .set({ renderAssetId })
          .where('id', '=', job.id)
          .execute();
        await insertProductLinks(trx, {
          renderAssetId,
          plan: input.plan,
          judge: input.judge,
          ...(input.adherence ? { adherence: input.adherence } : {}),
          takenOut: await placementsTakenOut(trx, input),
          now,
        });
        if (!input.keepAttemptOutcome) {
          await trx
            .updateTable('renderAttempts')
            .set({ outcome: 'succeeded' })
            .where('id', '=', input.attempt.id)
            .execute();
        }
        await releaseRemaining(trx, job.id, deps.clock);
      },
    });
    if (!asset) throw new Error('render asset not written');
    const published = asset as RenderAsset;
    const job = input.job;
    const qaPassedAt = input.patch.qaPassedAt ?? job.qaPassedAt;
    const startInstant = Math.max(
      job.requestedAt.getTime(),
      job.sourceReadyAt?.getTime() ?? job.requestedAt.getTime(),
    );
    await emitServerEvent(deps.db, deps, {
      name: 'render_succeeded',
      ownerId: job.ownerId,
      holidayId: job.holidayId,
      sceneType: input.plan.sceneType,
      sourceKind: input.source.kind,
      fixture: input.providerMode === 'fixture',
      properties: {
        latencyMs: Math.max(0, (qaPassedAt?.getTime() ?? now.getTime()) - startInstant),
        // Every attempt the job made, also when an earlier attempt's base is what is delivered.
        attempts: Math.max(job.attemptCount, input.attempt.attemptNo),
        repaired: job.repairUsed || (input.plan.repairConstraints?.length ?? 0) > 0,
        reviewMode: job.reviewMode,
        reviewWaitMs:
          input.patch.reviewCompletedAt && job.qaPassedAt
            ? Math.max(0, input.patch.reviewCompletedAt.getTime() - job.qaPassedAt.getTime())
            : null,
        style: job.style,
        lightingMode: job.lightingMode,
        fidelityMode,
      },
    });
    return published;
  } catch (error) {
    await deps.storage.delete('private', outputKey).catch(() => undefined);
    if (downloadKey) await deps.storage.delete('private', downloadKey).catch(() => undefined);
    throw error;
  }
}

/** The idempotency key of the daylight variant an evening job published as its relight base. */
export function relightBaseIdempotencyKey(eveningJobId: string): string {
  return `relight-base:${eveningJobId}`;
}

/**
 * Publishes the daylight (`source`) variant an evening job rendered as the base of its relight
 * (render spec, lighting modes): the variant gets its own key, labels and download like any
 * accepted variant. A render asset belongs to one job, so the variant is recorded under a
 * succeeded companion job of the same project and key inputs in `source` lighting (no attempts of
 * its own; `input_snapshot.relightBaseOf` names the evening job and the attempt that rendered
 * it). Idempotent per evening job: a redelivery returns the asset already published. The evening
 * job's state and reservations are not touched.
 */
export async function publishBaseVariant(
  deps: PipelineDeps,
  input: Omit<AcceptInput, 'fidelityMode' | 'keepAttemptOutcome' | 'adherence'>,
): Promise<RenderAsset> {
  const idempotencyKey = relightBaseIdempotencyKey(input.job.id);
  const findExisting = async () => {
    const companion = await deps.db
      .selectFrom('renderJobs')
      .select('renderAssetId')
      .where('ownerId', '=', input.job.ownerId)
      .where('idempotencyKey', '=', idempotencyKey)
      .executeTakeFirst();
    if (!companion?.renderAssetId) return null;
    return (
      (await deps.db
        .selectFrom('renderAssets')
        .selectAll()
        .where('id', '=', companion.renderAssetId)
        .executeTakeFirst()) ?? null
    );
  };
  const existing = await findExisting();
  if (existing) return existing;

  const now = deps.clock.now();
  const expiresAt = await renderAssetExpiry(deps, input.project);
  const renderAssetId = newId();
  const companionJobId = newId();
  const outputKey = keys.output(input.job.ownerId, renderAssetId, 'full.jpg');
  const downloadKey = input.deliverables.download
    ? keys.download(input.job.ownerId, renderAssetId)
    : null;
  const provenance = {
    sourceKind: input.source.kind,
    permission: input.permission,
    derivative: true,
  };
  await deps.storage.put({
    bucket: 'private',
    key: outputKey,
    body: input.deliverables.delivered,
    contentType: 'image/jpeg',
    provenance,
  });
  if (downloadKey && input.deliverables.download) {
    await deps.storage.put({
      bucket: 'private',
      key: downloadKey,
      body: input.deliverables.download,
      contentType: 'image/jpeg',
      contentDisposition: 'attachment; filename="hailiday-preview.jpg"',
      provenance,
    });
  }
  const provenanceJson: ProvenanceJson = {
    iptcDigitalSourceType: IPTC_DIGITAL_SOURCE_TYPE,
    labelApplied: input.deliverables.labelApplied,
    iptcWritten: true,
    providerManifestCaptured: input.providerManifestCaptured,
    providerWatermark: input.providerWatermark,
    holidayManifest: 'none',
    providerMode: input.providerMode,
  };
  try {
    return await deps.db.transaction().execute(async (trx) => {
      const evening = await trx
        .selectFrom('renderJobs')
        .selectAll()
        .where('id', '=', input.job.id)
        .executeTakeFirstOrThrow();
      const companion = await trx
        .insertInto('renderJobs')
        .values({
          id: companionJobId,
          ownerId: evening.ownerId,
          projectId: evening.projectId,
          projectVersion: evening.projectVersion,
          sourceAssetId: evening.sourceAssetId,
          holidayId: evening.holidayId,
          style: evening.style,
          lightingMode: 'source',
          holidayPackVersion: evening.holidayPackVersion,
          compilerVersion: evening.compilerVersion,
          inputSnapshot: toJson({
            ...((evening.inputSnapshot as Record<string, unknown> | null) ?? {}),
            relightBaseOf: { jobId: evening.id, attemptId: input.attempt.id },
          }),
          permissionEvaluationId: input.attempt.permissionEvaluationId,
          sceneAnalysisId: evening.sceneAnalysisId,
          workingWidth: evening.workingWidth,
          workingHeight: evening.workingHeight,
          workingChecksumSha256: evening.workingChecksumSha256,
          enhancement: evening.enhancement ? toJson(evening.enhancement) : null,
          resampler: evening.resampler,
          workingCropBox: evening.workingCropBox ? toJson(evening.workingCropBox) : null,
          workingPadBox: evening.workingPadBox ? toJson(evening.workingPadBox) : null,
          scaleFactor: evening.scaleFactor,
          workingObjectKey: null,
          state: 'succeeded',
          idempotencyKey,
          requestHash: evening.requestHash,
          reviewMode: evening.reviewMode,
          correlationId: evening.correlationId,
          requestedAt: evening.requestedAt,
          sourceReadyAt: evening.sourceReadyAt,
          startedAt: evening.startedAt,
          renderStartedAt: evening.renderStartedAt,
          renderCompletedAt: evening.renderCompletedAt,
          qaPassedAt: now,
          succeededAt: now,
          terminalAt: now,
        })
        .returning(['id', 'variantKey'])
        .executeTakeFirstOrThrow();
      // An earlier daylight rendering of the same key stays: every rendering is kept.
      const asset = await trx
        .insertInto('renderAssets')
        .values({
          id: renderAssetId,
          ownerId: evening.ownerId,
          projectId: evening.projectId,
          jobId: companion.id,
          sourceAssetId: evening.sourceAssetId,
          variantKey: companion.variantKey,
          holidayId: evening.holidayId,
          style: evening.style,
          lightingMode: 'source',
          holidayPackVersion: evening.holidayPackVersion,
          compilerVersion: evening.compilerVersion,
          objectKey: outputKey,
          width: input.deliverables.width,
          height: input.deliverables.height,
          contentType: 'image/jpeg',
          byteLength: input.deliverables.delivered.length,
          nativeWidth: input.nativeWidth,
          nativeHeight: input.nativeHeight,
          scaleFactor: input.scaleFactor,
          fidelityMode: input.plan.fidelityMode,
          provenance: toJson(provenanceJson),
          attributionText: input.deliverables.attributionText,
          distributable: input.deliverables.distributable,
          downloadable: input.deliverables.downloadable,
          downloadObjectKey: downloadKey,
          existingDecorConflict: input.plan.existingDecorConflict,
          expiresAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('renderJobs')
        .set({ renderAssetId })
        .where('id', '=', companion.id)
        .execute();
      await insertProductLinks(trx, {
        renderAssetId,
        plan: input.plan,
        judge: input.judge,
        takenOut: await placementsTakenOut(trx, { ...input, job: evening }),
        now,
      });
      return asset;
    });
  } catch (error) {
    await deps.storage.delete('private', outputKey).catch(() => undefined);
    if (downloadKey) await deps.storage.delete('private', downloadKey).catch(() => undefined);
    // A concurrent run of the same job may have published it first.
    const raced = await findExisting();
    if (raced) return raced;
    throw error;
  }
}

/**
 * The newest rendering of each variant key, newest first (by `createdAt`, then `id`). An owner
 * keeps every rendering, so a key may have several live rows; a list of a project's looks shows
 * one per look.
 */
export function newestPerVariantKey<T extends Pick<RenderAsset, 'id' | 'variantKey' | 'createdAt'>>(
  assets: readonly T[],
): T[] {
  const ordered = [...assets].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const seen = new Set<string>();
  return ordered.filter((asset) => {
    if (seen.has(asset.variantKey)) return false;
    seen.add(asset.variantKey);
    return true;
  });
}

/** Object keys of the held candidate and download of an attempt awaiting review. */
export function heldKeys(jobId: string, attemptId: string) {
  return {
    delivered: keys.attempt(jobId, attemptId, 'held-delivered.jpg'),
    download: keys.attempt(jobId, attemptId, 'held-download.jpg'),
  };
}

/**
 * Holds an accepted candidate for pre-delivery review: the delivered file and the download file
 * are stored unpublished under the attempt's prefix, and the job moves to `needs_review`.
 */
export async function holdForReview(
  deps: PipelineDeps,
  input: {
    job: RenderJob;
    source: SourceAsset;
    attempt: RenderAttempt;
    deliverables: Deliverables;
    permission: AssetPermission;
    qaPassed: boolean;
  },
): Promise<RenderJob> {
  const held = heldKeys(input.job.id, input.attempt.id);
  const provenance = {
    sourceKind: input.source.kind,
    permission: input.permission,
    derivative: true,
  };
  await deps.storage.put({
    bucket: 'private',
    key: held.delivered,
    body: input.deliverables.delivered,
    contentType: 'image/jpeg',
    provenance,
  });
  if (input.deliverables.download) {
    await deps.storage.put({
      bucket: 'private',
      key: held.download,
      body: input.deliverables.download,
      contentType: 'image/jpeg',
      provenance,
    });
  }
  const now = deps.clock.now();
  try {
    return await transitionJob(deps.db, {
      jobId: input.job.id,
      from: 'checking',
      to: 'needs_review',
      clock: deps.clock,
      patch: input.qaPassed ? { qaPassedAt: now } : {},
      within: async (trx, job) => {
        await trx
          .updateTable('renderAttempts')
          .set({ candidateObjectKey: held.delivered })
          .where('id', '=', input.attempt.id)
          .execute();
        await releaseRemaining(trx, job.id, deps.clock);
      },
    });
  } catch (error) {
    if (error instanceof LostRaceError) {
      await deps.storage.delete('private', held.delivered).catch(() => undefined);
      await deps.storage.delete('private', held.download).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * The daylight base of an evening job held for pre-delivery review, staged by
 * `holdBaseVariant`: its files are written, its companion job is not inserted yet.
 */
export interface StagedBaseVariant {
  /** The companion of an earlier call (nothing was written), or null. */
  existing: RenderJob | null;
  /**
   * Inserts the companion job in `trx`, the transaction that ends the evening job (the evening
   * row is no longer active there, so the companion can be the project's active job). When it
   * inserts nothing, the held files are deleted and the result is the companion of a concurrent
   * call that inserted it first, or null (another job of the project is active).
   */
  insert(trx: Tx): Promise<RenderJob | null>;
  /** Deletes the held files (the transaction that was to insert the companion failed). */
  discard(): Promise<void>;
}

/**
 * Holds the daylight base of an evening job that ended without its relight in pre-delivery review
 * (render spec, lighting modes): the base's delivered and download files are stored unpublished
 * under a companion job of the same project and key inputs in `source` lighting, created in
 * `needs_review` (no attempts of its own; `input_snapshot.relightBaseOf` names the evening job and
 * the base attempt, and the held files sit under `heldKeys(companion, base attempt)`). A reviewer's
 * approval publishes it as the daylight variant. This writes the files and returns the staged
 * hold; the caller inserts the companion (`insert`) in the same transaction that ends the evening
 * job, so the job never ends without its companion, and deletes the files (`discard`) when that
 * transaction fails. Idempotent per evening job: the companion of an earlier
 * call is returned as `existing`, with nothing written.
 */
export async function holdBaseVariant(
  deps: PipelineDeps,
  input: {
    job: RenderJob;
    source: SourceAsset;
    attempt: RenderAttempt;
    deliverables: Deliverables;
    permission: AssetPermission;
    qaPassed: boolean;
  },
): Promise<StagedBaseVariant> {
  const idempotencyKey = relightBaseIdempotencyKey(input.job.id);
  const findExisting = async (db: DbOrTx) =>
    (await db
      .selectFrom('renderJobs')
      .selectAll()
      .where('ownerId', '=', input.job.ownerId)
      .where('idempotencyKey', '=', idempotencyKey)
      .executeTakeFirst()) ?? null;
  const existing = await findExisting(deps.db);
  if (existing) {
    return { existing, insert: async () => existing, discard: async () => undefined };
  }

  const companionJobId = newId();
  const held = heldKeys(companionJobId, input.attempt.id);
  const provenance = {
    sourceKind: input.source.kind,
    permission: input.permission,
    derivative: true,
  };
  const discard = async () => {
    await deps.storage.delete('private', held.delivered).catch(() => undefined);
    await deps.storage.delete('private', held.download).catch(() => undefined);
  };
  try {
    await deps.storage.put({
      bucket: 'private',
      key: held.delivered,
      body: input.deliverables.delivered,
      contentType: 'image/jpeg',
      provenance,
    });
    if (input.deliverables.download) {
      await deps.storage.put({
        bucket: 'private',
        key: held.download,
        body: input.deliverables.download,
        contentType: 'image/jpeg',
        provenance,
      });
    }
  } catch (error) {
    await discard();
    throw error;
  }
  const now = deps.clock.now();
  const insert = async (trx: Tx): Promise<RenderJob | null> => {
    const evening = await trx
      .selectFrom('renderJobs')
      .selectAll()
      .where('id', '=', input.job.id)
      .executeTakeFirstOrThrow();
    // A conflict on the one-active-job index (another job of the project is active) or on the
    // idempotency key (a concurrent call inserted the companion) inserts nothing.
    const inserted = await trx
      .insertInto('renderJobs')
      .values({
        id: companionJobId,
        ownerId: evening.ownerId,
        projectId: evening.projectId,
        projectVersion: evening.projectVersion,
        sourceAssetId: evening.sourceAssetId,
        holidayId: evening.holidayId,
        style: evening.style,
        lightingMode: 'source',
        holidayPackVersion: evening.holidayPackVersion,
        compilerVersion: evening.compilerVersion,
        inputSnapshot: toJson({
          ...((evening.inputSnapshot as Record<string, unknown> | null) ?? {}),
          relightBaseOf: { jobId: evening.id, attemptId: input.attempt.id },
        }),
        permissionEvaluationId: input.attempt.permissionEvaluationId,
        sceneAnalysisId: evening.sceneAnalysisId,
        workingWidth: evening.workingWidth,
        workingHeight: evening.workingHeight,
        workingChecksumSha256: evening.workingChecksumSha256,
        enhancement: evening.enhancement ? toJson(evening.enhancement) : null,
        resampler: evening.resampler,
        workingCropBox: evening.workingCropBox ? toJson(evening.workingCropBox) : null,
        workingPadBox: evening.workingPadBox ? toJson(evening.workingPadBox) : null,
        scaleFactor: evening.scaleFactor,
        workingObjectKey: null,
        state: 'needs_review',
        idempotencyKey,
        requestHash: evening.requestHash,
        reviewMode: evening.reviewMode,
        correlationId: evening.correlationId,
        requestedAt: evening.requestedAt,
        sourceReadyAt: evening.sourceReadyAt,
        startedAt: evening.startedAt,
        renderStartedAt: evening.renderStartedAt,
        renderCompletedAt: evening.renderCompletedAt,
        qaPassedAt: input.qaPassed ? now : null,
      })
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return inserted;
    await discard();
    return findExisting(trx);
  };
  return { existing: null, insert, discard };
}
