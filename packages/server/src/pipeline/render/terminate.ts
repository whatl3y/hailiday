import { isTerminalRenderJobState } from '@hailiday/core';
import type { Clock } from '../../clock/index.js';
import type { AppConfig } from '../../config/index.js';
import type { DbOrTx } from '../../db/client.js';
import type { RenderJob } from '../../db/schema.js';
import type { Logger } from '../../logger/index.js';
import type { JobQueue } from '../../queue/client.js';
import { emitServerEvent } from '../analytics.js';
import { releaseRemaining } from './ledger.js';
import { LostRaceError, readJob, transitionJob } from './transitions.js';

/** Reservations of a job's attempts that were sent and may still bill. */
export async function inFlightReservationIds(db: DbOrTx, jobId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('renderAttempts')
    .select('reservationEntryId')
    .where('jobId', '=', jobId)
    .where('outcome', 'in', ['pending', 'unknown', 'canceled'])
    .where('providerOperationId', 'is not', null)
    .execute();
  return rows.map((row) => row.reservationEntryId).filter((id): id is string => id !== null);
}

/**
 * Ends a non-terminal render job as `canceled`, `superseded` or `expired` (render spec,
 * cancellation and late-result suppression): compare-and-set from whatever non-terminal state it
 * is in, `NOTIFY` with the next sequence, mark a sent attempt still `pending` as `unknown` and an
 * unsent one as `canceled`, release every untouched reservation except an in-flight attempt's
 * (the reservation of an attempt that was never sent is released too), then cancel the queue job
 * (which fires the worker's abort signal). Returns null when the job was already terminal.
 */
export async function terminateRenderJob(
  deps: { db: DbOrTx; clock: Clock; config: AppConfig; logger: Logger; queue?: JobQueue | null },
  input: {
    jobId: string;
    to: 'canceled' | 'superseded' | 'expired';
    supersededByJobId?: string | null;
  },
): Promise<RenderJob | null> {
  for (let tries = 0; tries < 5; tries += 1) {
    const job = await readJob(deps.db, input.jobId);
    if (!job || isTerminalRenderJobState(job.state)) return null;
    const now = deps.clock.now();
    try {
      const ended = await transitionJob(deps.db, {
        jobId: job.id,
        from: job.state,
        to: input.to,
        clock: deps.clock,
        patch: {
          ...(input.to === 'canceled' ? { cancelRequestedAt: now } : {}),
          ...(input.supersededByJobId ? { supersededByJobId: input.supersededByJobId } : {}),
        },
        within: async (trx) => {
          // A sent attempt still `pending` can no longer be answered to this job: its outcome is
          // unknown (a charge may exist), and its reservation stays open for reconciliation.
          await trx
            .updateTable('renderAttempts')
            .set({ outcome: 'unknown' })
            .where('jobId', '=', job.id)
            .where('outcome', '=', 'pending')
            .where('providerOperationId', 'is not', null)
            .execute();
          // A `pending` attempt with no operation was never sent (the editor reports the
          // operation before sending): it ends `canceled`, counts toward no attempt quota, and
          // its reservation is released below with the job's other untouched ones.
          await trx
            .updateTable('renderAttempts')
            .set({ outcome: 'canceled', completedAt: now })
            .where('jobId', '=', job.id)
            .where('outcome', '=', 'pending')
            .where('providerOperationId', 'is', null)
            .execute();
          const except = await inFlightReservationIds(trx, job.id);
          await releaseRemaining(trx, job.id, deps.clock, except);
        },
      });
      await deps.queue?.cancel('render', job.id).catch((error: unknown) => {
        deps.logger.warn({ err: error, renderJobId: job.id }, 'queue cancel failed');
      });
      const elapsedMs = Math.max(0, now.getTime() - (job.startedAt ?? job.requestedAt).getTime());
      const attemptInFlight = (await inFlightReservationIds(deps.db, job.id)).length > 0;
      const stateBefore = job.state as Exclude<typeof job.state, 'succeeded'>;
      await emitServerEvent(deps.db, deps, {
        name:
          input.to === 'canceled'
            ? 'render_canceled'
            : input.to === 'superseded'
              ? 'render_superseded'
              : 'render_expired',
        ownerId: job.ownerId,
        holidayId: job.holidayId,
        fixture: deps.config.providers.imageEditor === 'fixture',
        properties:
          input.to === 'canceled'
            ? { stateAtCancel: stateBefore, elapsedMs }
            : input.to === 'superseded'
              ? { stateAtSupersede: stateBefore, elapsedMs, attemptInFlight }
              : { stateAtExpiry: stateBefore, elapsedMs },
      });
      return ended;
    } catch (error) {
      if (error instanceof LostRaceError) continue;
      throw error;
    }
  }
  return null;
}
