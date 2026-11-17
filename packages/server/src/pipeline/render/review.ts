import sharp from 'sharp';
import {
  DecorationPlanSchema,
  FAILURE_CODES,
  JudgeResultSchema,
  type FailureCode,
  type JudgeResult,
} from '@hailiday/core';
import { newId } from '../../ids/index.js';
import {
  deniedPermission,
  evaluatePermission,
  isPropertyBlocked,
  permissionSettingsOf,
  refreshStreetViewPolicy,
  streetViewPolicyTemplateFor,
} from '../../policy/index.js';
import type { DbOrTx } from '../../db/client.js';
import type { RenderAsset, RenderAttempt, RenderJob } from '../../db/schema.js';
import { emitServerEvent } from '../analytics.js';
import { aiCapabilityFor, capabilityStateFor, type PipelineDeps } from '../context.js';
import { attributionLine, heldKeys, publishAccepted } from './publish.js';
import { readJob, transitionJob } from './transitions.js';

/** Raised when a review decision does not apply (job missing or not awaiting review). */
export class ReviewStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewStateError';
  }
}

/**
 * The attempt whose candidate a job awaiting review holds (its files are `heldKeys(job.id,
 * attempt.id)`): the attempt whose candidate is the held file (the decorated base a bright job
 * delivers in place of its relight), else the latest. A companion job that holds an evening job's
 * daylight base has no attempts of its own: its attempt is the base attempt its
 * `input_snapshot.relightBaseOf` names. Null when there is none.
 */
export async function heldAttemptOf(
  db: DbOrTx,
  job: Pick<RenderJob, 'id' | 'inputSnapshot'>,
): Promise<RenderAttempt | null> {
  const attempts = await db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', job.id)
    .orderBy('attemptNo', 'desc')
    .execute();
  const own =
    attempts.find((row) => row.candidateObjectKey === heldKeys(job.id, row.id).delivered) ??
    attempts[0];
  if (own) return own;
  const baseAttemptId = (job.inputSnapshot as { relightBaseOf?: { attemptId?: unknown } } | null)
    ?.relightBaseOf?.attemptId;
  if (typeof baseAttemptId !== 'string') return null;
  return (
    (await db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('id', '=', baseAttemptId)
      .executeTakeFirst()) ?? null
  );
}

async function reviewContext(deps: PipelineDeps, jobId: string) {
  const job = await readJob(deps.db, jobId);
  if (!job || job.state !== 'needs_review')
    throw new ReviewStateError('job is not awaiting review');
  const attempt = await heldAttemptOf(deps.db, job);
  if (!attempt) throw new ReviewStateError('job has no attempt');
  return { job, attempt, held: heldKeys(job.id, attempt.id) };
}

async function recordReview(
  deps: PipelineDeps,
  job: RenderJob,
  input: {
    reviewerUserId: string;
    decision: 'approve' | 'reject';
    reasonCodes: string[];
    notes?: string | null;
  },
): Promise<void> {
  const now = deps.clock.now();
  await deps.db
    .insertInto('reviews')
    .values({
      id: newId(),
      subjectKind: 'render_job',
      jobId: job.id,
      sourceAssetId: null,
      reviewerUserId: input.reviewerUserId,
      decision: input.decision,
      reasonCodes: input.reasonCodes,
      notes: input.notes ?? null,
      requestedAt: job.qaPassedAt ?? job.renderCompletedAt ?? job.updatedAt,
      decidedAt: now,
    })
    .execute();
}

/**
 * Reviewer approval of a job in `needs_review` (pre-delivery review mode): publishes the held
 * candidate and download file exactly as an automated acceptance would, with the reviewer's
 * per-placement adherence deciding `described` product links.
 */
export async function approveReview(
  deps: PipelineDeps,
  input: {
    jobId: string;
    reviewerUserId: string;
    notes?: string | null;
    adherence?: Record<string, { category: boolean; colorFamily: boolean; count: boolean }>;
  },
): Promise<RenderAsset> {
  const { job, attempt, held } = await reviewContext(deps, input.jobId);
  // A held evening relight takes its product links from the daylight base's judge result. A
  // deterministic relight held by an earlier release (`evening_relight`) delivered another
  // variant's pixels: its plan and judge are that variant's and the attempt keeps its outcome.
  const fallback = (attempt.fallback ?? null) as {
    kind?: 'relight' | 'evening_relight';
    base?: 'attempt' | 'variant';
    baseAttemptId?: string;
    basePlanId?: string;
  } | null;
  const legacy = fallback?.kind === 'evening_relight';
  const fromVariant = legacy && fallback?.base === 'variant' && !!fallback.basePlanId;
  const judgeAttemptId =
    (fromVariant || fallback?.kind === 'relight') && fallback?.baseAttemptId
      ? fallback.baseAttemptId
      : attempt.id;
  const delivered = await deps.storage.get('private', held.delivered);
  if (!delivered) throw new ReviewStateError('held candidate is missing');
  const download = await deps.storage.get('private', held.download);
  const [project, source, planRow] = await Promise.all([
    deps.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', job.projectId)
      .executeTakeFirstOrThrow(),
    deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', job.sourceAssetId)
      .executeTakeFirstOrThrow(),
    deps.db
      .selectFrom('decorationPlans')
      .selectAll()
      .where('id', '=', fromVariant ? (fallback?.basePlanId as string) : attempt.decorationPlanId)
      .executeTakeFirstOrThrow(),
  ]);
  // A Street View source's policy is first brought up to the current template, so a use policy
  // tightened since the look was held decides the approval.
  const policy = !source.assetPolicyId
    ? null
    : source.kind === 'street_view'
      ? await refreshStreetViewPolicy(
          deps.db,
          source.assetPolicyId,
          streetViewPolicyTemplateFor(deps.config),
        )
      : ((await deps.db
          .selectFrom('assetPolicies')
          .selectAll()
          .where('id', '=', source.assetPolicyId)
          .executeTakeFirst()) ?? null);
  // A capability with no row (outside local environments) permits nothing.
  const capabilityState = await capabilityStateFor(deps, aiCapabilityFor(source.kind));
  const permission = capabilityState
    ? evaluatePermission({
        policy,
        capabilityState,
        ...permissionSettingsOf(deps.config),
        now: deps.clock.now(),
        sourceKind: source.kind,
        isGoogleImagery: source.isGoogleImagery,
        copyright: source.copyright,
      })
    : deniedPermission(policy);
  const judgeRow = await deps.db
    .selectFrom('judgeResults')
    .select('document')
    .where('attemptId', '=', judgeAttemptId)
    .orderBy('escalated', 'desc')
    .limit(1)
    .executeTakeFirst();
  const judgeParsed = JudgeResultSchema.safeParse(judgeRow?.document);
  const judge: JudgeResult | null = judgeParsed.success ? judgeParsed.data : null;
  const meta = await sharp(delivered.body).metadata();
  // A Street View look held before its source's policy stopped allowing edits is never published.
  if (source.kind === 'street_view' && !permission.edit) {
    throw new ReviewStateError('the street photo may no longer be decorated');
  }
  // A Street View place put on the opt-out list since its look was held is never published.
  if (
    source.kind === 'street_view' &&
    (await isPropertyBlocked(deps.db, project.propertyId, deps.clock.now()))
  ) {
    throw new ReviewStateError('the place is on the opt-out list');
  }
  await recordReview(deps, job, {
    reviewerUserId: input.reviewerUserId,
    decision: 'approve',
    reasonCodes: [],
    notes: input.notes ?? null,
  });
  const asset = await publishAccepted(deps, {
    job,
    project,
    source,
    plan: DecorationPlanSchema.parse(planRow.document),
    attempt,
    judge,
    deliverables: {
      delivered: delivered.body,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
      download: download?.body ?? null,
      distributable: permission.distributeDerivative && !source.privateOnly,
      downloadable: download !== null,
      attributionText: attributionLine(source, permission),
      labelApplied: download !== null,
    },
    nativeWidth: source.width ?? meta.width ?? 0,
    nativeHeight: source.height ?? meta.height ?? 0,
    scaleFactor: job.scaleFactor,
    providerMode: attempt.providerMode,
    providerWatermark: attempt.providerWatermark ?? 'unknown',
    providerManifestCaptured: attempt.providerManifestObjectKey !== null,
    permission,
    ...(input.adherence ? { adherence: input.adherence } : {}),
    ...(legacy ? { fidelityMode: 'global_relight' as const } : {}),
    // A held daylight base belongs to the evening job's attempt, which keeps its outcome.
    ...(fromVariant || attempt.jobId !== job.id ? { keepAttemptOutcome: true } : {}),
    from: 'needs_review',
    patch: { reviewCompletedAt: deps.clock.now() },
  });
  await deps.storage.delete('private', held.delivered).catch(() => undefined);
  await deps.storage.delete('private', held.download).catch(() => undefined);
  return asset;
}

/** Reviewer rejection: `rejected` with `reviewer_rejected`; held files are deleted; no repair. */
export async function rejectReview(
  deps: PipelineDeps,
  input: { jobId: string; reviewerUserId: string; reasonCodes: string[]; notes?: string | null },
): Promise<RenderJob> {
  if (input.reasonCodes.length === 0) throw new ReviewStateError('a rejection needs reason codes');
  const { job, held } = await reviewContext(deps, input.jobId);
  await recordReview(deps, job, {
    reviewerUserId: input.reviewerUserId,
    decision: 'reject',
    reasonCodes: input.reasonCodes,
    notes: input.notes ?? null,
  });
  const failureCodes = input.reasonCodes.filter((code): code is FailureCode =>
    (FAILURE_CODES as readonly string[]).includes(code),
  );
  const ended = await transitionJob(deps.db, {
    jobId: job.id,
    from: 'needs_review',
    to: 'rejected',
    clock: deps.clock,
    patch: {
      rejectionReason: 'reviewer_rejected',
      reviewCompletedAt: deps.clock.now(),
      failureCodes: failureCodes.length > 0 ? failureCodes : null,
    },
  });
  await deps.storage.delete('private', held.delivered).catch(() => undefined);
  await deps.storage.delete('private', held.download).catch(() => undefined);
  await emitServerEvent(deps.db, deps, {
    name: 'render_rejected',
    ownerId: job.ownerId,
    holidayId: job.holidayId,
    fixture: deps.config.providers.imageEditor === 'fixture',
    properties: { rejectionReason: 'reviewer_rejected', failureCodes, attempts: job.attemptCount },
  });
  return ended;
}
