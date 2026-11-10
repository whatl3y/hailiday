import type { LedgerSku } from '@holiday/core';
import type { Clock } from '../../clock/index.js';
import type { DbOrTx } from '../../db/client.js';
import type { UsageLedgerEntry } from '../../db/schema.js';
import {
  charge,
  openReservations,
  releaseJobReservations,
  settle,
  VISION_LEDGER_STAGES,
  VISION_PRICES_MICROS,
  type VisionStage,
} from '../../ledger/index.js';

/** An open reservation of a job for one SKU (and stage or price where several exist). */
export async function findOpenReservation(
  db: DbOrTx,
  jobId: string,
  filter: { sku: LedgerSku; stage?: string; unitPriceMicros?: number; exclude?: readonly string[] },
): Promise<UsageLedgerEntry | null> {
  const open = await openReservations(db, jobId);
  const exclude = new Set(filter.exclude ?? []);
  return (
    open.find(
      (row) =>
        row.sku === filter.sku &&
        !exclude.has(row.id) &&
        (filter.stage === undefined || row.stage === filter.stage) &&
        (filter.unitPriceMicros === undefined || row.unitPriceMicros === filter.unitPriceMicros),
    ) ?? null
  );
}

/**
 * The open vision reservation of a job for a call (analysis, judge, escalation or localization),
 * matched by its pipeline stage and price: the judge and the localization are priced alike.
 */
export async function findVisionReservation(
  db: DbOrTx,
  jobId: string,
  stage: Exclude<VisionStage, 'triage'>,
): Promise<UsageLedgerEntry | null> {
  return findOpenReservation(db, jobId, {
    sku: 'vision_call',
    stage: VISION_LEDGER_STAGES[stage],
    unitPriceMicros: VISION_PRICES_MICROS[stage],
  });
}

/**
 * Records the actual cost of one call: settles its reservation (releasing the unused remainder)
 * or, when the job reserved nothing for it, writes a direct charge. Returns the ledger row ID.
 */
export async function settleCall(
  db: DbOrTx,
  input: {
    reservation: UsageLedgerEntry | null;
    jobId: string;
    ownerId: string;
    projectId: string;
    attemptId?: string | null;
    provider: string;
    sku: LedgerSku;
    stage: string;
    units: number;
    unitPriceMicros?: number;
    modelId?: string | null;
    isFixture: boolean;
    clock: Clock;
  },
): Promise<string> {
  if (input.reservation) {
    const { settlement } = await settle(
      db,
      {
        reservationId: input.reservation.id,
        units: input.units,
        ...(input.unitPriceMicros !== undefined ? { unitPriceMicros: input.unitPriceMicros } : {}),
        attemptId: input.attemptId ?? null,
        modelId: input.modelId ?? null,
      },
      input.clock,
    );
    return settlement.id;
  }
  const row = await charge(
    db,
    {
      ownerId: input.ownerId,
      jobId: input.jobId,
      attemptId: input.attemptId ?? null,
      projectId: input.projectId,
      isFixture: input.isFixture,
    },
    {
      provider: input.provider,
      sku: input.sku,
      stage: input.stage,
      units: input.units,
      ...(input.unitPriceMicros !== undefined ? { unitPriceMicros: input.unitPriceMicros } : {}),
      modelId: input.modelId ?? null,
    },
    input.clock,
  );
  return row.id;
}

/** Releases a job's untouched reservations except those of in-flight attempts. */
export async function releaseRemaining(
  db: DbOrTx,
  jobId: string,
  clock: Clock,
  exceptReservationIds: readonly string[] = [],
): Promise<number> {
  const released = await releaseJobReservations(db, jobId, { exceptReservationIds, clock });
  return released.length;
}
