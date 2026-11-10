import { TERMINAL_RENDER_JOB_STATES } from '@holiday/core';
import { DAY_MS, HOUR_MS, addMs } from '../../clock/index.js';
import { keys } from '../../storage/keys.js';
import { pipelineOptions, type PipelineDeps } from '../context.js';
import { expireUploadHolds } from '../uploads/screen.js';
import { deleteProject, deleteSharePublicObjects, resumeDeletionRequests } from './deletion.js';
import { loadHeldSet } from './holds.js';
import { purgeBlockedPlaces } from './takedown.js';
import { ageOutTombstoneMirror, mirrorTombstones, writeTombstones } from './tombstones.js';

/** Retention defaults (privacy spec, retention schedule; configuration). */
export const RETENTION = {
  anonymousInactivityMs: 24 * HOUR_MS,
  anonymousHardCapMs: 7 * DAY_MS,
  savedInactivityMs: 395 * DAY_MS,
  pendingUploadMs: HOUR_MS,
  sessionGraceMs: DAY_MS,
  /** Hashed IP and device signals (rolling expiry). */
  signalMs: 7 * DAY_MS,
  /** Expired magic-link and re-authentication tokens are purged after this grace. */
  authTokenGraceMs: DAY_MS,
  /** Reports are kept this long after resolution. */
  resolvedReportMs: 365 * DAY_MS,
} as const;

export interface RetentionSweepResult {
  deletionsResumed: number;
  projectsExpired: number;
  projectsPinned: number;
  projectsHeld: number;
  blockedPlaceVariantsPurged: number;
  sharesExpired: number;
  uploadsExpired: number;
  holdsTimedOut: number;
  sessionsRemoved: number;
  authTokensPurged: number;
  signalsCleared: number;
  reportsAged: number;
  tombstonesAged: number;
  tombstonesMirrored: number;
  tombstoneBatchesAged: number;
  allowanceResidueAged: number;
}

/**
 * The `retention_sweep` job: completes deletions that did not finish (and held ones whose holds
 * were released), expires anonymous projects (24 h after last activity, at most 7 days after
 * creation without saving) and saved projects (13 months without activity) through the deletion
 * order, purges existing Street View variants of places on the opt-out list, expires share grants (public copies deleted; a pinned variant of an expired project goes
 * with its last grant), expires uploads that never completed, declines holds past their window,
 * removes expired sessions and auth tokens, clears hashed IP and device signals older than 7 days,
 * ages out resolved reports after 12 months, mirrors new tombstones outside the database and ages
 * out tombstones, mirror batches and allowance residue past their window. Rows and objects under
 * a preservation hold are kept.
 */
export async function runRetentionSweep(
  deps: PipelineDeps,
  options: { limit?: number } = {},
): Promise<RetentionSweepResult> {
  const now = deps.clock.now();
  const limit = options.limit ?? 200;
  const result: RetentionSweepResult = {
    deletionsResumed: 0,
    projectsExpired: 0,
    projectsPinned: 0,
    projectsHeld: 0,
    blockedPlaceVariantsPurged: 0,
    sharesExpired: 0,
    uploadsExpired: 0,
    holdsTimedOut: 0,
    sessionsRemoved: 0,
    authTokensPurged: 0,
    signalsCleared: 0,
    reportsAged: 0,
    tombstonesAged: 0,
    tombstonesMirrored: 0,
    tombstoneBatchesAged: 0,
    allowanceResidueAged: 0,
  };

  result.deletionsResumed = (await resumeDeletionRequests(deps, { limit })).resumed;

  const projects = await deps.db
    .selectFrom('projects')
    .selectAll()
    .where('deletedAt', 'is', null)
    .where((eb) =>
      eb.or([
        eb('expiresAt', '<=', now),
        eb.and([
          eb('savedAt', 'is', null),
          eb.or([
            eb('lastActivityAt', '<=', addMs(now, -RETENTION.anonymousInactivityMs)),
            eb('createdAt', '<=', addMs(now, -RETENTION.anonymousHardCapMs)),
          ]),
        ]),
        eb.and([
          eb('savedAt', 'is not', null),
          eb('lastActivityAt', '<=', addMs(now, -RETENTION.savedInactivityMs)),
        ]),
      ]),
    )
    .orderBy('lastActivityAt')
    .limit(limit)
    .execute();
  for (const project of projects) {
    const outcome = await deleteProject(deps, {
      project,
      scope: 'expiry_sweep',
      requestedBy: 'system',
    });
    if (outcome.status === 'held') result.projectsHeld += 1;
    else if (outcome.status === 'pinned') result.projectsPinned += 1;
    else result.projectsExpired += 1;
  }

  // Variants of places on the opt-out list (homeowner request, whole-house blur, operator).
  result.blockedPlaceVariantsPurged = (await purgeBlockedPlaces(deps, { limit })).purged;

  // Share grants past expiry.
  const grants = await deps.db
    .selectFrom('shareGrants')
    .selectAll()
    .where('revokedAt', 'is', null)
    .where('expiresAt', '<=', now)
    .limit(limit)
    .execute();
  for (const grant of grants) {
    await deps.db
      .updateTable('shareGrants')
      .set({ revokedAt: now })
      .where('id', '=', grant.id)
      .execute();
    await deleteSharePublicObjects(deps, grant.shareCardObjectKey);
    await writeTombstones(deps.db, {
      deletionRequestId: null,
      now,
      entries: [{ kind: 'share_token', hash: grant.tokenHash }],
    });
    result.sharesExpired += 1;
    // A variant pinned only by this grant on an already deleted project goes now.
    const asset = await deps.db
      .selectFrom('renderAssets')
      .innerJoin('projects', 'projects.id', 'renderAssets.projectId')
      .select(['renderAssets.id', 'renderAssets.projectId', 'projects.deletedAt'])
      .where('renderAssets.id', '=', grant.renderAssetId)
      .executeTakeFirst();
    if (!asset?.deletedAt) continue;
    const otherLive = await deps.db
      .selectFrom('shareGrants')
      .select('id')
      .where('renderAssetId', '=', asset.id)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', now)
      .executeTakeFirst();
    if (otherLive) continue;
    const project = await deps.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', asset.projectId)
      .executeTakeFirst();
    if (project)
      await deleteProject(deps, { project, scope: 'expiry_sweep', requestedBy: 'system' });
  }

  // Uploads that never completed: quarantine bytes (if any) and the record expire.
  const pending = await deps.db
    .selectFrom('sourceAssets')
    .select(['id'])
    .where('state', '=', 'pending_upload')
    .where('createdAt', '<=', addMs(now, -RETENTION.pendingUploadMs))
    .limit(limit)
    .execute();
  for (const asset of pending) {
    await deps.storage.delete('private', keys.quarantine(asset.id)).catch(() => undefined);
    await deps.db
      .updateTable('sourceAssets')
      .set({ state: 'expired', expiresAt: now })
      .where('id', '=', asset.id)
      .where('state', '=', 'pending_upload')
      .execute();
    result.uploadsExpired += 1;
  }

  result.holdsTimedOut = await expireUploadHolds(deps, limit);

  const sessions = await deps.db
    .deleteFrom('anonymousSessions')
    .where('expiresAt', '<=', addMs(now, -RETENTION.sessionGraceMs))
    .executeTakeFirst();
  result.sessionsRemoved = Number(sessions.numDeletedRows ?? 0);

  // Magic-link and re-authentication tokens (email, IP hash, return path) after expiry plus a
  // grace longer than the operator re-authentication window.
  const tokens = await deps.db
    .deleteFrom('authTokens')
    .where('expiresAt', '<=', addMs(now, -RETENTION.authTokenGraceMs))
    .executeTakeFirst();
  result.authTokensPurged = Number(tokens.numDeletedRows ?? 0);

  // Hashed IP and device signals: 7-day rolling expiry (the device backstop reads 24 hours).
  const signalCutoff = addMs(now, -RETENTION.signalMs);
  const jobSignals = await deps.db
    .updateTable('renderJobs')
    .set({ deviceHash: null, ipHash: null })
    .where('requestedAt', '<=', signalCutoff)
    .where((eb) => eb.or([eb('deviceHash', 'is not', null), eb('ipHash', 'is not', null)]))
    .executeTakeFirst();
  const reportSignals = await deps.db
    .updateTable('reports')
    .set({ ipHash: null })
    .where('createdAt', '<=', signalCutoff)
    .where('ipHash', 'is not', null)
    .executeTakeFirst();
  const tokenSignals = await deps.db
    .updateTable('authTokens')
    .set({ ipHash: null })
    .where('createdAt', '<=', signalCutoff)
    .where('ipHash', 'is not', null)
    .executeTakeFirst();
  const sessionSignals = await deps.db
    .updateTable('anonymousSessions')
    .set({ ipHash: null, deviceHash: null })
    .where('createdAt', '<=', signalCutoff)
    .where((eb) => eb.or([eb('deviceHash', 'is not', null), eb('ipHash', 'is not', null)]))
    .executeTakeFirst();
  result.signalsCleared =
    Number(jobSignals.numUpdatedRows ?? 0) +
    Number(reportSignals.numUpdatedRows ?? 0) +
    Number(tokenSignals.numUpdatedRows ?? 0) +
    Number(sessionSignals.numUpdatedRows ?? 0);

  // Reports 12 months after resolution, unless a preservation hold covers them.
  const reports = await deps.db
    .deleteFrom('reports')
    .where('resolvedAt', '<=', addMs(now, -RETENTION.resolvedReportMs))
    .where('preservationHoldId', 'is', null)
    .executeTakeFirst();
  result.reportsAged = Number(reports.numDeletedRows ?? 0);

  result.tombstonesMirrored = await mirrorTombstones(deps, { limit: 5000 });

  const aged = await deps.db
    .deleteFrom('tombstones')
    .where('retainUntil', '<=', now)
    .executeTakeFirst();
  result.tombstonesAged = Number(aged.numDeletedRows ?? 0);
  result.tombstoneBatchesAged = await ageOutTombstoneMirror(deps, { limit: limit * 5 });

  const residue = await deps.db
    .deleteFrom('allowanceResidue')
    .where('expiresAt', '<=', now)
    .executeTakeFirst();
  result.allowanceResidueAged = Number(residue.numDeletedRows ?? 0);
  return result;
}

export interface AttemptSweepResult {
  attemptPrefixesSwept: number;
  workingPrefixesSwept: number;
  objectsDeleted: number;
}

/**
 * The `attempt_sweep` job: deletes `attempts/` objects of jobs terminal for longer than the
 * rejected-candidate period (7 days) and `working/` objects past their grace period (1 hour).
 * Jobs whose project, source or variant is under a preservation hold (of any kind) are skipped.
 */
export async function runAttemptSweep(
  deps: PipelineDeps,
  options: { limit?: number } = {},
): Promise<AttemptSweepResult> {
  const opts = pipelineOptions(deps);
  const now = deps.clock.now();
  const limit = options.limit ?? 500;
  const result: AttemptSweepResult = {
    attemptPrefixesSwept: 0,
    workingPrefixesSwept: 0,
    objectsDeleted: 0,
  };
  const terminal = [...TERMINAL_RENDER_JOB_STATES];
  const held = await loadHeldSet(deps);
  const isHeld = (job: {
    projectId: string;
    ownerId: string;
    sourceAssetId: string;
    renderAssetId: string | null;
  }) =>
    held.projects.has(job.projectId) ||
    held.owners.has(job.ownerId) ||
    held.sources.has(job.sourceAssetId) ||
    (job.renderAssetId !== null && held.assets.has(job.renderAssetId));

  const workingJobs = await deps.db
    .selectFrom('renderJobs')
    .select(['id', 'projectId', 'ownerId', 'sourceAssetId', 'renderAssetId'])
    .where('state', 'in', terminal)
    .where('terminalAt', '<=', addMs(now, -opts.workingGraceMs))
    .where('workingObjectKey', 'is not', null)
    .limit(limit)
    .execute();
  for (const job of workingJobs) {
    if (isHeld(job)) continue;
    result.objectsDeleted += await deps.storage.deletePrefix('private', keys.workingPrefix(job.id));
    await deps.db
      .updateTable('renderJobs')
      .set({ workingObjectKey: null })
      .where('id', '=', job.id)
      .execute();
    result.workingPrefixesSwept += 1;
  }

  const attemptJobs = await deps.db
    .selectFrom('renderJobs')
    .select(['id', 'projectId', 'ownerId', 'sourceAssetId', 'renderAssetId'])
    .where('state', 'in', terminal)
    .where('terminalAt', '<=', addMs(now, -opts.rejectedCandidateRetentionMs))
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('renderAttempts')
          .select('renderAttempts.id')
          .whereRef('renderAttempts.jobId', '=', 'renderJobs.id')
          .where('renderAttempts.candidateObjectKey', 'is not', null),
      ),
    )
    .limit(limit)
    .execute();
  for (const job of attemptJobs) {
    if (isHeld(job)) continue;
    result.objectsDeleted += await deps.storage.deletePrefix('private', `attempts/${job.id}/`);
    await deps.db
      .updateTable('renderAttempts')
      .set({ candidateObjectKey: null, providerManifestObjectKey: null })
      .where('jobId', '=', job.id)
      .execute();
    result.attemptPrefixesSwept += 1;
  }
  return result;
}

/**
 * The `coordinate_expiry` job: deletes Places and Geocoding coordinates past `coordsExpireAt`
 * (30 days from retrieval); a project that needs them again re-resolves from the place ID.
 */
export async function runCoordinateExpiry(
  deps: PipelineDeps,
): Promise<{ propertiesCleared: number }> {
  const result = await deps.db
    .updateTable('properties')
    .set({ targetLat: null, targetLng: null, coordsSource: null, coordsExpireAt: null })
    .where('coordsExpireAt', '<=', deps.clock.now())
    .where((eb) =>
      eb.or([
        eb('targetLat', 'is not', null),
        eb('targetLng', 'is not', null),
        eb('coordsExpireAt', 'is not', null),
      ]),
    )
    .executeTakeFirst();
  return { propertiesCleared: Number(result.numUpdatedRows ?? 0) };
}
