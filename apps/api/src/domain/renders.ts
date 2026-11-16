import {
  AI_PREVIEW_LABEL_KEY,
  AnchorCategorySchema,
  FAILURE_CODES,
  MAX_RENDER_ATTEMPTS,
  renderErrorCodeFor,
  stageLabelKeyOf,
  variantPlacements,
  type AnchorCategory,
  type FailureCode,
  type PermittedAction,
  type RenderStatus,
  type Variant,
} from '@hailiday/core';
import type { Audience } from '@hailiday/server/capabilities';
import type { RenderAsset, RenderJob, SourceAsset } from '@hailiday/server/db';
import { notFound } from '@hailiday/server/errors';
import { relightBaseIdempotencyKey } from '@hailiday/server/pipeline';
import type { ApiDeps } from '../deps.js';
import type { AuthState } from '../auth/session.js';
import { allowanceFor } from './allowance.js';
import { queuePositionOf } from './capacity.js';
import { loadSource } from './projects.js';
import {
  displayUrlForViewpoint,
  framedDisplayUrlOf,
  lookPredatesFraming,
  streetViewCreditOf,
  streetViewSourcePermissions,
  wideDisplayUrlForViewpoint,
} from './sources.js';

/**
 * Whether the renderings of a Street View source may still be shared or downloadable
 * (`streetViewSourcePermissions`). The stored `distributable` and `downloadable` flags of a
 * rendering only narrow this further.
 */
export async function streetViewDistributionAllowed(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'db' | 'clock'>,
  audience: Audience,
  source: { policyId: string | null; isGoogleImagery: boolean | null; copyright: string | null },
): Promise<boolean> {
  return (await streetViewSourcePermissions(deps, audience, source)).distribute;
}

/**
 * Loads a render job the caller owns (`NOT_FOUND` otherwise, and for a job of a deleted project:
 * deletion revokes access at once, also while a preservation hold keeps the rows).
 */
export async function loadOwnedJob(
  deps: Pick<ApiDeps, 'db'>,
  auth: AuthState,
  jobId: string,
): Promise<RenderJob> {
  const job = await deps.db
    .selectFrom('renderJobs')
    .innerJoin('projects', 'projects.id', 'renderJobs.projectId')
    .selectAll('renderJobs')
    .where('renderJobs.id', '=', jobId)
    .where('renderJobs.ownerId', '=', auth.ownerId)
    .where('projects.deletedAt', 'is', null)
    .executeTakeFirst();
  if (!job) throw notFound();
  return job;
}

/**
 * The decoration plan document of the attempt that rendered a render asset: the job's latest
 * succeeded attempt or, for a daylight variant an evening job published as its relight base (a
 * companion job with no attempts of its own), the evening job's attempt named by the companion's
 * `input_snapshot.relightBaseOf`.
 */
async function acceptedPlanDocument(deps: Pick<ApiDeps, 'db'>, jobId: string): Promise<unknown> {
  const own = await deps.db
    .selectFrom('renderAttempts')
    .innerJoin('decorationPlans', 'decorationPlans.id', 'renderAttempts.decorationPlanId')
    .select('decorationPlans.document')
    .where('renderAttempts.jobId', '=', jobId)
    .where('renderAttempts.outcome', '=', 'succeeded')
    .orderBy('renderAttempts.attemptNo', 'desc')
    .executeTakeFirst();
  if (own) return own.document;
  const job = await deps.db
    .selectFrom('renderJobs')
    .select('inputSnapshot')
    .where('id', '=', jobId)
    .executeTakeFirst();
  const baseOf = (job?.inputSnapshot as { relightBaseOf?: unknown } | null | undefined)
    ?.relightBaseOf as { jobId?: unknown; attemptId?: unknown } | null | undefined;
  if (typeof baseOf?.attemptId !== 'string' || typeof baseOf.jobId !== 'string') return null;
  const base = await deps.db
    .selectFrom('renderAttempts')
    .innerJoin('decorationPlans', 'decorationPlans.id', 'renderAttempts.decorationPlanId')
    .select('decorationPlans.document')
    .where('renderAttempts.id', '=', baseOf.attemptId)
    .where('renderAttempts.jobId', '=', baseOf.jobId)
    .executeTakeFirst();
  return base?.document ?? null;
}

/**
 * The anchor categories of a render asset's accepted plan (the plan of the attempt that rendered
 * it), each once in plan order; empty when the plan is no longer available.
 */
export async function acceptedPlacements(
  deps: Pick<ApiDeps, 'db'>,
  asset: Pick<RenderAsset, 'jobId'>,
): Promise<AnchorCategory[]> {
  const document = await acceptedPlanDocument(deps, asset.jobId);
  const placements = (document as { placements?: unknown } | null | undefined)?.placements;
  if (!Array.isArray(placements)) return [];
  return variantPlacements(
    placements.flatMap((placement: unknown) => {
      const parsed = AnchorCategorySchema.safeParse(
        (placement as { anchorCategory?: unknown } | null)?.anchorCategory,
      );
      return parsed.success ? [{ anchorCategory: parsed.data }] : [];
    }),
  );
}

/**
 * The shared `Variant` object: signed short-lived URLs for the delivered image and (when
 * downloadable) the labeled download file; the before image is the upload's normalized original or,
 * for Street View, the stored frame while one is kept and its policy still allows storing it, and
 * otherwise the provider's display URL of the frame's view (for a framed view, counted against the
 * display budget and ledgered once per source, else none: `framedDisplayUrlOf`). A Street View
 * look made before its source was zoomed in on its home (`lookPredatesFraming`) shows the display
 * URL of the candidate's own view instead, the picture the confirmation screen showed and the
 * look was made from. A Street View rendering is distributable and downloadable only while its
 * source's evaluated policy still allows distribution (`streetViewSourcePermissions`). The expiry
 * is reported only while time-based deletion is on.
 */
export async function variantDto(
  deps: ApiDeps,
  auth: AuthState,
  asset: RenderAsset,
  source: SourceAsset | null,
): Promise<Variant> {
  const imageUrl = await deps.storage.presignGet('private', asset.objectKey);
  const privateOnly = source?.privateOnly ?? false;
  const storedFrame = Boolean(source?.objectKey) && source?.state !== 'deleted';
  const permissions =
    source?.kind === 'street_view' &&
    (storedFrame || ((asset.distributable || asset.downloadable) && !privateOnly))
      ? await streetViewSourcePermissions(deps, auth.audience, {
          policyId: source.assetPolicyId,
          isGoogleImagery: source.isGoogleImagery,
          copyright: source.copyright,
        })
      : { distribute: true, store: true };
  let beforeImageUrl: string | null = null;
  if (source?.kind === 'street_view' && lookPredatesFraming(source.viewpoint, asset.createdAt)) {
    beforeImageUrl = await wideDisplayUrlForViewpoint(deps, auth.audience, source.viewpoint);
  } else if (source?.objectKey && storedFrame && permissions.store) {
    beforeImageUrl = await deps.storage.presignGet('private', source.objectKey);
  } else if (source?.kind === 'street_view' && source.viewpoint) {
    beforeImageUrl = await framedDisplayUrlOf(deps, auth, source);
  } else if (source?.viewpoint) {
    beforeImageUrl = await displayUrlForViewpoint(deps, auth.audience, source.viewpoint);
  }
  const distributionAllowed = permissions.distribute;
  const downloadable =
    asset.downloadable && !privateOnly && asset.downloadObjectKey !== null && distributionAllowed;
  const downloadUrl =
    downloadable && asset.downloadObjectKey
      ? await deps.storage.presignGet('private', asset.downloadObjectKey, {
          contentDisposition: 'attachment; filename="hailiday-preview.jpg"',
        })
      : null;
  const streetView = source?.kind === 'street_view';
  return {
    renderAssetId: asset.id,
    renderJobId: asset.jobId,
    sourceAssetId: asset.sourceAssetId,
    holidayId: asset.holidayId,
    style: asset.style,
    lightingMode: asset.lightingMode,
    holidayPackVersion: asset.holidayPackVersion,
    compilerVersion: asset.compilerVersion,
    imageUrl,
    beforeImageUrl,
    width: asset.width,
    height: asset.height,
    labelKey: AI_PREVIEW_LABEL_KEY,
    attribution: streetView
      ? {
          required: true,
          text: streetViewCreditOf(asset.attributionText, source),
          logo: 'google_maps',
        }
      : null,
    distributable: asset.distributable && !privateOnly && distributionAllowed,
    downloadable,
    downloadUrl,
    privateOnly,
    existingDecorConflict: asset.existingDecorConflict,
    placements: await acceptedPlacements(deps, asset),
    sourceState: source?.state === 'stale' ? 'stale' : 'ready',
    createdAt: asset.createdAt.toISOString(),
    expiresAt:
      asset.expiresAt && (await deps.settings.get('retention.time_based_deletion'))
        ? asset.expiresAt.toISOString()
        : null,
  };
}

/**
 * The render asset of the daylight look a rejected evening job published from its own decorated
 * base: the base attempt records `relight_fallback` with `deliveredAs: 'daylight_variant'`, and
 * the `source` look is the one its companion job (`relightBaseIdempotencyKey`) published from
 * that attempt. Null for any other job, and when the base was held for review or not published.
 */
async function daylightAssetIdOf(
  deps: Pick<ApiDeps, 'db'>,
  job: Pick<RenderJob, 'id' | 'ownerId' | 'state' | 'lightingMode'>,
): Promise<string | null> {
  if (job.state !== 'rejected' || job.lightingMode !== 'evening') return null;
  const attempts = await deps.db
    .selectFrom('renderAttempts')
    .select(['id', 'fallback'])
    .where('jobId', '=', job.id)
    .where('fallback', 'is not', null)
    .orderBy('attemptNo', 'desc')
    .execute();
  const base = attempts.find((attempt) => {
    const record = attempt.fallback as { kind?: unknown; deliveredAs?: unknown } | null;
    return record?.kind === 'relight_fallback' && record.deliveredAs === 'daylight_variant';
  });
  if (!base) return null;
  const companion = await deps.db
    .selectFrom('renderJobs')
    .select(['renderAssetId', 'inputSnapshot'])
    .where('ownerId', '=', job.ownerId)
    .where('idempotencyKey', '=', relightBaseIdempotencyKey(job.id))
    .where('state', '=', 'succeeded')
    .where('lightingMode', '=', 'source')
    .executeTakeFirst();
  const baseOf = (companion?.inputSnapshot as { relightBaseOf?: { attemptId?: unknown } } | null)
    ?.relightBaseOf;
  return baseOf?.attemptId === base.id ? (companion?.renderAssetId ?? null) : null;
}

/**
 * The variant a job's status carries, if it is still available: the accepted variant of a
 * succeeded job, or the daylight look a rejected evening job published from its own base
 * (`daylightAssetIdOf`; the job stays rejected with its codes).
 */
export async function variantOfJob(deps: ApiDeps, auth: AuthState, job: RenderJob) {
  const assetId =
    job.state === 'succeeded' ? job.renderAssetId : await daylightAssetIdOf(deps, job);
  if (!assetId) return null;
  const asset = await deps.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('id', '=', assetId)
    .where('deletedAt', 'is', null)
    .where('withdrawnAt', 'is', null)
    .executeTakeFirst();
  if (!asset) return null;
  return variantDto(deps, auth, asset, await loadSource(deps, asset.sourceAssetId));
}

function permittedActionsFor(
  job: RenderJob,
  source: SourceAsset | null,
  variant: Variant | null,
): PermittedAction[] {
  const streetView = source?.kind === 'street_view';
  switch (job.state) {
    case 'succeeded': {
      const actions: PermittedAction[] = [
        'change_holiday',
        'change_style',
        'change_lighting',
        'save_project',
        'shop',
      ];
      if (variant?.distributable) actions.push('share');
      if (variant?.downloadUrl) actions.push('download');
      actions.push('report');
      return actions;
    }
    case 'rejected':
      return streetView
        ? ['retry', 'upload_photo', 'choose_other_view']
        : ['retry', 'upload_photo'];
    case 'failed': {
      const other: PermittedAction[] = streetView
        ? ['choose_other_view', 'upload_photo']
        : ['upload_photo'];
      if (job.failureKind === 'source_rejected' || job.failureKind === 'source_unavailable') {
        return other;
      }
      if (job.failureKind === 'moderation_blocked' || job.failureKind === 'policy_denied') {
        return other;
      }
      return ['retry', ...other];
    }
    case 'canceled':
    case 'superseded':
    case 'expired':
      return ['retry'];
    default:
      return ['cancel'];
  }
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/** The shared `RenderStatus` object for a job (also the payload of every SSE event). */
export async function renderStatus(
  deps: ApiDeps,
  auth: AuthState,
  job: RenderJob,
): Promise<RenderStatus> {
  const source = await loadSource(deps, job.sourceAssetId);
  const variant = await variantOfJob(deps, auth, job);
  const failureCodes = (job.failureCodes ?? []).filter((code): code is FailureCode =>
    (FAILURE_CODES as readonly string[]).includes(code),
  );
  const failureKind = job.state === 'failed' ? (job.failureKind ?? 'internal_error') : null;
  return {
    renderJobId: job.id,
    projectId: job.projectId,
    projectVersion: job.projectVersion,
    state: job.state,
    stageLabelKey: stageLabelKeyOf({
      state: job.state,
      subStage: job.subStage,
      lightingMode: job.lightingMode,
    }),
    seq: job.stateSeq,
    attempt: Math.min(MAX_RENDER_ATTEMPTS, Math.max(0, job.attemptCount)),
    repairUsed: job.repairUsed,
    queuePosition: await queuePositionOf(deps, job),
    holidayId: job.holidayId,
    style: job.style,
    lightingMode: job.lightingMode,
    failureKind,
    failureDetail: job.state === 'failed' ? job.failureDetail : null,
    rejectionReason: job.state === 'rejected' ? (job.rejectionReason ?? 'qa_critical') : null,
    failureCodes: job.state === 'rejected' ? failureCodes : [],
    errorCode: renderErrorCodeFor(job.state, failureKind),
    permittedActions: permittedActionsFor(job, source, variant),
    variant,
    supersededByRenderJobId: job.state === 'superseded' ? job.supersededByJobId : null,
    timestamps: {
      requestedAt: job.requestedAt.toISOString(),
      sourceReadyAt: iso(job.sourceReadyAt),
      startedAt: iso(job.startedAt),
      renderStartedAt: iso(job.renderStartedAt),
      renderCompletedAt: iso(job.renderCompletedAt),
      qaPassedAt: iso(job.qaPassedAt),
      reviewCompletedAt: iso(job.reviewCompletedAt),
      succeededAt: iso(job.succeededAt),
      terminalAt: iso(job.terminalAt),
    },
    allowance: await allowanceFor(deps, auth.ownerId),
  };
}
