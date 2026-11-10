import { sql } from 'kysely';
import { TERMINAL_RENDER_JOB_STATES } from '@holiday/core';
import { HOUR_MS, addMs } from '../../clock/index.js';
import { reservationBalance, release, settle } from '../../ledger/index.js';
import { PRIVATE_PREFIXES, isHeldKey } from '../../storage/keys.js';
import { pipelineOptions, type PipelineDeps } from '../context.js';
import { inFlightReservationIds } from '../render/terminate.js';
import { loadHeldSet } from './holds.js';

export interface ReconciliationResult {
  attemptsSettled: number;
  attemptsAssumedCharged: number;
  attemptsReleased: number;
  attemptsStillPending: number;
  reservationsReleased: number;
  objectsScanned: number;
  /** Objects with no live owning row (the "objects past expiry" metric; must read zero). */
  objectsPastExpiry: number;
  objectsDeleted: number;
}

const NO_ID = '00000000-0000-0000-0000-000000000000';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The `reconciliation` job: resolves attempts with an unknown or canceled outcome through
 * `getOperation` (settled at the real cost, or as charged when no status can be had after the
 * window), and attempts still `pending` with an operation ID on a job terminal for over an hour
 * (the worker died mid-call and the job was ended elsewhere) the same way; releases reservations
 * left open on terminal jobs; and deletes storage objects with no live owning row, reporting the
 * "objects past expiry" metric. Objects under `held/` and objects of rows covered by a
 * preservation hold are never deleted.
 */
export async function runReconciliation(
  deps: PipelineDeps,
  options: {
    limit?: number;
    scanObjects?: boolean;
    /** Restricts attempt and reservation settlement to these jobs (an operator re-run). */
    jobIds?: readonly string[];
    /** Objects younger than this are never deleted (their row may not have committed yet). */
    objectGraceMs?: number;
  } = {},
): Promise<ReconciliationResult> {
  const opts = pipelineOptions(deps);
  const now = deps.clock.now();
  const limit = options.limit ?? 200;
  const result: ReconciliationResult = {
    attemptsSettled: 0,
    attemptsAssumedCharged: 0,
    attemptsReleased: 0,
    attemptsStillPending: 0,
    reservationsReleased: 0,
    objectsScanned: 0,
    objectsPastExpiry: 0,
    objectsDeleted: 0,
  };

  // 1. Unknown and canceled attempts with an open reservation, and pending attempts orphaned on
  // a job that has been terminal for more than an hour.
  const attempts = await deps.db
    .selectFrom('renderAttempts')
    .innerJoin('renderJobs', 'renderJobs.id', 'renderAttempts.jobId')
    .selectAll('renderAttempts')
    .where((eb) =>
      eb.or([
        eb('renderAttempts.outcome', 'in', ['unknown', 'canceled']),
        eb.and([
          eb('renderAttempts.outcome', '=', 'pending'),
          eb('renderJobs.terminalAt', '<=', addMs(now, -HOUR_MS)),
        ]),
      ]),
    )
    .where('renderAttempts.providerOperationId', 'is not', null)
    .where('renderAttempts.reconciled', 'is', null)
    .where('renderJobs.state', 'in', [...TERMINAL_RENDER_JOB_STATES])
    .$if(options.jobIds !== undefined, (qb) =>
      qb.where('renderJobs.id', 'in', options.jobIds?.length ? [...options.jobIds] : [NO_ID]),
    )
    .limit(limit)
    .execute();
  for (const attempt of attempts) {
    const balance = attempt.reservationEntryId
      ? await reservationBalance(deps.db, attempt.reservationEntryId)
      : null;
    const editor =
      attempt.providerMode === 'fixture'
        ? deps.providers.fixtures.imageEditor
        : deps.providers.imageEditor;
    const outcome = await editor
      .getOperation(attempt.providerOperationId as string)
      .catch(() => null);
    const expired = now.getTime() - attempt.createdAt.getTime() >= opts.reconciliationWindowMs;
    let reconciled: 'settled' | 'assumed_charged' | null = null;
    let units: number | null = null;
    if (outcome?.status === 'completed') {
      reconciled = 'settled';
      units = outcome.usage.images ?? 1;
    } else if (outcome?.status === 'failed') {
      const noStatus =
        outcome.providerCode === 'no_status_api' || outcome.providerCode === 'unknown_operation';
      if (noStatus) {
        reconciled = 'assumed_charged';
        units = 1;
      } else {
        reconciled = 'settled';
        units = 0;
      }
    } else if (expired) {
      reconciled = 'assumed_charged';
      units = 1;
    }
    if (!reconciled || units === null) {
      result.attemptsStillPending += 1;
      continue;
    }
    if (balance && !balance.closed) {
      await settle(
        deps.db,
        { reservationId: balance.reservation.id, units, attemptId: attempt.id },
        deps.clock,
      );
    }
    await deps.db
      .updateTable('renderAttempts')
      .set({ reconciled })
      .where('id', '=', attempt.id)
      .execute();
    if (reconciled === 'assumed_charged') result.attemptsAssumedCharged += 1;
    else if (units === 0) result.attemptsReleased += 1;
    else result.attemptsSettled += 1;
  }

  // 2. Reservations still open on jobs terminal for more than an hour (not in flight).
  const staleJobs = await deps.db
    .selectFrom('renderJobs')
    .select('id')
    .where('state', 'in', [...TERMINAL_RENDER_JOB_STATES])
    .where('terminalAt', '<=', addMs(now, -HOUR_MS))
    .$if(options.jobIds !== undefined, (qb) =>
      qb.where('id', 'in', options.jobIds?.length ? [...options.jobIds] : [NO_ID]),
    )
    .where(
      sql<boolean>`exists (
        select 1 from usage_ledger r
        where r.job_id = render_jobs.id and r.kind = 'reservation'
          and not exists (
            select 1 from usage_ledger c
            where c.reservation_id = r.id and c.kind in ('settlement', 'release')
          )
      )`,
    )
    .limit(limit)
    .execute();
  for (const job of staleJobs) {
    const except = new Set(await inFlightReservationIds(deps.db, job.id));
    const open = await deps.db
      .selectFrom('usageLedger as r')
      .select('r.id')
      .where('r.jobId', '=', job.id)
      .where('r.kind', '=', 'reservation')
      .execute();
    for (const row of open) {
      if (except.has(row.id)) continue;
      if (await release(deps.db, row.id, deps.clock)) result.reservationsReleased += 1;
    }
  }

  // 3. Objects without a live owning row. A row covered by a preservation hold is live whatever
  // its deletion marks.
  if (options.scanObjects !== false) {
    const held = await loadHeldSet(deps);
    const graceMs = options.objectGraceMs ?? HOUR_MS;
    const scan = async (prefix: string, isLive: (key: string) => Promise<boolean>) => {
      const objects = await deps.storage.list('private', prefix, limit * 5);
      for (const key of objects) {
        if (isHeldKey(key)) continue;
        result.objectsScanned += 1;
        if (await isLive(key)) continue;
        // Objects are written just before their row commits; young objects get a grace period.
        const head = await deps.storage.head('private', key);
        if (!head || (head.lastModified && Date.now() - head.lastModified.getTime() < graceMs)) {
          continue;
        }
        result.objectsPastExpiry += 1;
        await deps.storage.delete('private', key);
        result.objectsDeleted += 1;
      }
    };
    const ids = (key: string) => key.match(new RegExp(UUID, 'g')) ?? [];
    await scan(PRIVATE_PREFIXES.outputs, async (key) => {
      const [, assetId] = ids(key);
      if (!assetId) return false;
      if (held.assets.has(assetId)) return true;
      const row = await deps.db
        .selectFrom('renderAssets')
        .select('id')
        .where('id', '=', assetId)
        .where((eb) =>
          eb.or([eb('deletedAt', 'is', null), eb('preservationHoldId', 'is not', null)]),
        )
        .executeTakeFirst();
      return row !== undefined;
    });
    await scan(PRIVATE_PREFIXES.downloads, async (key) => {
      const [, assetId] = ids(key);
      if (assetId && held.assets.has(assetId)) return true;
      const row = await deps.db
        .selectFrom('renderAssets')
        .select('id')
        .where('downloadObjectKey', '=', key)
        .where((eb) =>
          eb.or([eb('deletedAt', 'is', null), eb('preservationHoldId', 'is not', null)]),
        )
        .executeTakeFirst();
      return row !== undefined;
    });
    await scan(PRIVATE_PREFIXES.originals, async (key) => {
      const [, sourceId] = ids(key);
      if (sourceId && held.sources.has(sourceId)) return true;
      const row = await deps.db
        .selectFrom('sourceAssets')
        .select('id')
        .where('objectKey', '=', key)
        .where((eb) =>
          eb.or([
            eb('state', 'not in', ['deleted', 'expired']),
            eb('preservationHoldId', 'is not', null),
          ]),
        )
        .executeTakeFirst();
      return row !== undefined;
    });
    const jobLive = async (key: string) => {
      const [jobId] = ids(key);
      if (!jobId) return false;
      const row = await deps.db
        .selectFrom('renderJobs')
        .select('id')
        .where('id', '=', jobId)
        .executeTakeFirst();
      return row !== undefined;
    };
    await scan(PRIVATE_PREFIXES.reviews, async (key) => {
      const [assetId] = ids(key);
      if (!assetId) return false;
      if (held.sources.has(assetId)) return true;
      const row = await deps.db
        .selectFrom('sourceAssets')
        .select('id')
        .where('id', '=', assetId)
        .where('state', '=', 'screening')
        .where('holdForReview', '=', true)
        .executeTakeFirst();
      return row !== undefined;
    });
    await scan(PRIVATE_PREFIXES.attempts, jobLive);
    await scan(PRIVATE_PREFIXES.working, jobLive);
    await scan(PRIVATE_PREFIXES.quarantine, async (key) => {
      const [assetId] = ids(key);
      if (!assetId) return false;
      const row = await deps.db
        .selectFrom('sourceAssets')
        .select('id')
        .where('id', '=', assetId)
        .where('state', 'in', ['pending_upload', 'quarantined', 'screening'])
        .executeTakeFirst();
      return row !== undefined;
    });
  }
  if (result.objectsPastExpiry > 0) {
    deps.logger.warn(
      { objectsPastExpiry: result.objectsPastExpiry },
      'objects past expiry deleted',
    );
  }
  return result;
}
