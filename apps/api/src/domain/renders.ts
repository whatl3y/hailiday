import {
  AI_PREVIEW_LABEL_KEY,
  AnchorCategorySchema,
  FAILURE_CODES,
  renderErrorCodeFor,
  stageLabelKeyFor,
  variantPlacements,
  type AnchorCategory,
  type FailureCode,
  type PermittedAction,
  type RenderStatus,
  type Variant,
} from '@holiday/core';
import type { RenderAsset, RenderJob, SourceAsset } from '@holiday/server/db';
import { notFound } from '@holiday/server/errors';
import type { ApiDeps } from '../deps.js';
import type { AuthState } from '../auth/session.js';
import { allowanceFor } from './allowance.js';
import { queuePositionOf } from './capacity.js';
import { loadSource } from './projects.js';
import { displayUrlForViewpoint } from './sources.js';

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
 * for Street View, the same signed display URL the confirmation screen used.
 */
export async function variantDto(
  deps: ApiDeps,
  auth: AuthState,
  asset: RenderAsset,
  source: SourceAsset | null,
): Promise<Variant> {
  const imageUrl = await deps.storage.presignGet('private', asset.objectKey);
  let beforeImageUrl: string | null = null;
  if (source?.objectKey && source.state !== 'deleted') {
    beforeImageUrl = await deps.storage.presignGet('private', source.objectKey);
  } else if (source?.viewpoint) {
    beforeImageUrl = await displayUrlForViewpoint(deps, auth.audience, source.viewpoint);
  }
  const privateOnly = source?.privateOnly ?? false;
  const downloadable = asset.downloadable && !privateOnly && asset.downloadObjectKey !== null;
  const downloadUrl =
    downloadable && asset.downloadObjectKey
      ? await deps.storage.presignGet('private', asset.downloadObjectKey, {
          contentDisposition: 'attachment; filename="holiday-preview.jpg"',
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
      ? { required: true, text: asset.attributionText ?? 'Google Maps', logo: 'google_maps' }
      : null,
    distributable: asset.distributable && !privateOnly,
    downloadable,
    downloadUrl,
    privateOnly,
    existingDecorConflict: asset.existingDecorConflict,
    placements: await acceptedPlacements(deps, asset),
    sourceState: source?.state === 'stale' ? 'stale' : 'ready',
    createdAt: asset.createdAt.toISOString(),
    expiresAt: asset.expiresAt ? asset.expiresAt.toISOString() : null,
  };
}

/** The accepted variant of a succeeded job, if it is still available. */
export async function variantOfJob(deps: ApiDeps, auth: AuthState, job: RenderJob) {
  if (job.state !== 'succeeded' || !job.renderAssetId) return null;
  const asset = await deps.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('id', '=', job.renderAssetId)
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
    stageLabelKey: stageLabelKeyFor(job.state),
    seq: job.stateSeq,
    attempt: Math.min(2, Math.max(0, job.attemptCount)),
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
