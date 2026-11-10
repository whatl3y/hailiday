import { sql } from 'kysely';
import {
  canTransitionRenderJob,
  isTerminalRenderJobState,
  type RenderJobState,
} from '@holiday/core';
import type { Clock } from '../../clock/index.js';
import { withTransaction, type DbOrTx, type Tx } from '../../db/client.js';
import type { RenderJob, RowUpdate } from '../../db/schema.js';
import { notifyRenderJobChanged } from '../../queue/notify.js';

/** Another actor changed the job's state first; the caller stops without side effects. */
export class LostRaceError extends Error {
  readonly jobId: string;
  readonly expected: RenderJobState;
  constructor(jobId: string, expected: RenderJobState) {
    super(`Render job ${jobId} is no longer ${expected}`);
    this.name = 'LostRaceError';
    this.jobId = jobId;
    this.expected = expected;
  }
}

export type JobPatch = Omit<
  RowUpdate<'renderJobs'>,
  'id' | 'state' | 'stateSeq' | 'variantKey' | 'createdAt' | 'updatedAt'
>;

/**
 * Compare-and-set state change on a render job (render spec, rules for every transition):
 * `UPDATE … WHERE state = <from>`, `state_seq` incremented, terminal states stamp `terminal_at`,
 * and `NOTIFY render_job_changed` with the new sequence in the same transaction. A lost race
 * throws `LostRaceError`. `within` runs extra writes in the same transaction after the update.
 */
export async function transitionJob(
  db: DbOrTx,
  input: {
    jobId: string;
    from: RenderJobState | readonly RenderJobState[];
    to: RenderJobState;
    patch?: JobPatch;
    clock: Clock;
    within?: (trx: Tx, job: RenderJob) => Promise<void>;
  },
): Promise<RenderJob> {
  const from = Array.isArray(input.from) ? [...input.from] : [input.from as RenderJobState];
  for (const state of from) {
    if (!canTransitionRenderJob(state, input.to)) {
      throw new RangeError(`Illegal render job transition ${state} → ${input.to}`);
    }
  }
  const now = input.clock.now();
  return withTransaction(db, async (trx) => {
    const updated = await trx
      .updateTable('renderJobs')
      .set({
        ...(input.patch ?? {}),
        state: input.to,
        stateSeq: sql<number>`state_seq + 1`,
        ...(isTerminalRenderJobState(input.to)
          ? { terminalAt: input.patch?.terminalAt ?? now }
          : {}),
      })
      .where('id', '=', input.jobId)
      .where('state', 'in', from)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new LostRaceError(input.jobId, from[0] as RenderJobState);
    await notifyRenderJobChanged(trx, { jobId: updated.id, seq: updated.stateSeq });
    if (input.within) await input.within(trx, updated);
    return updated;
  });
}

/** Re-reads a render job. */
export async function readJob(db: DbOrTx, jobId: string): Promise<RenderJob | null> {
  return (
    (await db.selectFrom('renderJobs').selectAll().where('id', '=', jobId).executeTakeFirst()) ??
    null
  );
}
