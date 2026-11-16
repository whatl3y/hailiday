import { isTerminalRenderJobState, type FailureKind } from '@hailiday/core';
import { toJson } from '../../db/client.js';
import { emitServerEvent } from '../analytics.js';
import type { PipelineDeps } from '../context.js';
import { releaseRemaining, settleCall } from './ledger.js';
import { inFlightReservationIds } from './terminate.js';
import { LostRaceError, readJob, transitionJob } from './transitions.js';

/**
 * Dead-letter consumer for `render` (architecture, dead-letter consumer): a job whose transport
 * retries ran out is settled as `failed`. An attempt that was sent and cannot be recovered through
 * `getOperation` makes it `unknown_outcome` (reconciliation settles the cost later); otherwise the
 * kind follows the last recorded cause. Unused reservations are released and an alert is logged.
 */
export async function settleDeadRender(
  deps: PipelineDeps,
  payload: { renderJobId: string },
): Promise<{ failureKind: FailureKind } | null> {
  const job = await readJob(deps.db, payload.renderJobId);
  if (!job || isTerminalRenderJobState(job.state)) return null;
  const attempts = await deps.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', job.id)
    .orderBy('attemptNo')
    .execute();
  const latest = attempts[attempts.length - 1];
  let failureKind: FailureKind = 'internal_error';
  // A sent attempt whose outcome is open: still `pending` (the worker died mid-call) or
  // `unknown` (the queue stopped the worker mid-call and no retry resolved it).
  if (
    latest &&
    (latest.outcome === 'pending' || latest.outcome === 'unknown') &&
    latest.providerOperationId
  ) {
    const editor =
      latest.providerMode === 'fixture'
        ? deps.providers.fixtures.imageEditor
        : deps.providers.imageEditor;
    const recovered = await editor.getOperation(latest.providerOperationId).catch(() => null);
    if (recovered?.status === 'completed') {
      const reservation = latest.reservationEntryId
        ? ((await deps.db
            .selectFrom('usageLedger')
            .selectAll()
            .where('id', '=', latest.reservationEntryId)
            .executeTakeFirst()) ?? null)
        : null;
      await settleCall(deps.db, {
        reservation,
        jobId: job.id,
        ownerId: job.ownerId,
        projectId: job.projectId,
        attemptId: latest.id,
        provider: latest.provider,
        sku: 'image_edit_attempt',
        stage: 'rendering',
        units: recovered.usage.images ?? 1,
        isFixture: latest.providerMode === 'fixture',
        clock: deps.clock,
      });
      await deps.db
        .updateTable('renderAttempts')
        .set({ outcome: 'succeeded', reconciled: 'settled', completedAt: deps.clock.now() })
        .where('id', '=', latest.id)
        .execute();
      failureKind = 'internal_error';
    } else {
      await deps.db
        .updateTable('renderAttempts')
        .set({ outcome: 'unknown', errorDetail: toJson({ deadLettered: true }) })
        .where('id', '=', latest.id)
        .execute();
      failureKind = 'unknown_outcome';
    }
  } else if (latest?.outcome === 'timeout') {
    failureKind = 'timeout';
  } else if (latest?.outcome === 'provider_error') {
    failureKind = 'provider_error';
  } else if (job.state === 'rendering') {
    failureKind = 'provider_error';
  }
  try {
    await transitionJob(deps.db, {
      jobId: job.id,
      from: job.state,
      to: 'failed',
      clock: deps.clock,
      patch: { failureKind },
      within: async (trx) => {
        const except = await inFlightReservationIds(trx, job.id);
        await releaseRemaining(trx, job.id, deps.clock, except);
      },
    });
  } catch (error) {
    if (error instanceof LostRaceError) return null;
    throw error;
  }
  deps.logger.error({ renderJobId: job.id, failureKind }, 'render job dead-lettered');
  await emitServerEvent(deps.db, deps, {
    name: 'render_failed',
    ownerId: job.ownerId,
    holidayId: job.holidayId,
    fixture: deps.config.providers.imageEditor === 'fixture',
    properties: { failureKind, failureDetail: null, attempts: job.attemptCount },
  });
  return { failureKind };
}

/** Dead-letter consumer for `upload_validate` and `upload_screen`: the source asset is `failed`. */
export async function failDeadUpload(
  deps: PipelineDeps,
  payload: { sourceAssetId: string },
): Promise<boolean> {
  const result = await deps.db
    .updateTable('sourceAssets')
    .set({ state: 'failed', holdForReview: false })
    .where('id', '=', payload.sourceAssetId)
    .where('state', 'in', ['quarantined', 'screening'])
    .executeTakeFirst();
  const failed = Number(result.numUpdatedRows ?? 0) > 0;
  if (failed) deps.logger.error({ sourceAssetId: payload.sourceAssetId }, 'upload dead-lettered');
  return failed;
}
