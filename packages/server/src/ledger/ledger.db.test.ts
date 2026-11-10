import { afterAll, describe, expect, it } from 'vitest';
import { factories } from '../db/factories.js';
import { createTestDb } from '../db/testing.js';
import {
  charge,
  openReservationMicros,
  openReservations,
  release,
  releaseJobReservations,
  renderReservationLines,
  reservationBalance,
  reserve,
  settle,
} from './index.js';

const db = createTestDb();
afterAll(() => db.destroy());

async function job() {
  const owner = await factories.owner(db);
  const project = await factories.project(db, { ownerId: owner.id });
  const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
  const renderJob = await factories.renderJob(db, {
    ownerId: owner.id,
    projectId: project.id,
    sourceAssetId: source.id,
  });
  return { owner, project, renderJob };
}

describe('usage ledger', () => {
  it('reserves the worst case, settles actual cost and releases the remainder', async () => {
    const { owner, project, renderJob } = await job();
    const rows = await db.transaction().execute((trx) =>
      reserve(
        trx,
        { ownerId: owner.id, jobId: renderJob.id, projectId: project.id, isFixture: true },
        renderReservationLines({
          imageEditProvider: 'fixture',
          visionProvider: 'fixture',
          streetViewFetch: false,
          reuseAnalysis: false,
        }),
      ),
    );
    expect(rows).toHaveLength(8);
    expect(await openReservationMicros(db, renderJob.id)).toBe(410_000);
    // Open reservations come back in line order, so the judge rows precede the localization rows
    // that share their price.
    expect((await openReservations(db, renderJob.id)).map((row) => row.stage)).toEqual([
      'analyzing',
      'rendering',
      'rendering',
      'checking',
      'checking',
      'checking',
      'localizing',
      'localizing',
    ]);

    const attempt = rows.find((row) => row.sku === 'image_edit_attempt')!;
    const { settlement, release: remainder } = await db
      .transaction()
      .execute((trx) => settle(trx, { reservationId: attempt.id, amountMicros: 100_000 }));
    expect(settlement.kind).toBe('settlement');
    expect(settlement.amountMicros).toBe(100_000);
    expect(remainder?.amountMicros).toBe(-30_000);
    const balance = await reservationBalance(db, attempt.id);
    expect(balance).toMatchObject({
      settledMicros: 100_000,
      releasedMicros: -30_000,
      openMicros: 0,
    });
    expect(await release(db, attempt.id)).toBeNull();

    const judge = rows.find((row) => row.stage === 'checking')!;
    await settle(db, { reservationId: judge.id, keepOpen: true, amountMicros: 5_000 });
    expect((await reservationBalance(db, judge.id)).openMicros).toBe(15_000);

    const inFlight = rows.filter((row) => row.sku === 'image_edit_attempt')[1]!;
    const released = await releaseJobReservations(db, renderJob.id, {
      exceptReservationIds: [inFlight.id],
    });
    expect(released.map((row) => row.amountMicros).sort((a, b) => a - b)).toEqual([
      -40_000, -30_000, -20_000, -20_000, -20_000,
    ]);
    expect((await openReservations(db, renderJob.id)).map((row) => row.id)).toEqual([inFlight.id]);
    expect(await openReservationMicros(db, renderJob.id)).toBe(130_000 + 15_000);
  });

  it('records charges with list prices and no reservation', async () => {
    const owner = await factories.owner(db);
    const row = await charge(
      db,
      { ownerId: owner.id, isFixture: true },
      { provider: 'fixture', sku: 'places_autocomplete_requests', stage: 'suggestions' },
    );
    expect(row).toMatchObject({
      kind: 'charge',
      category: 'google',
      unitPriceMicros: 2_830,
      amountMicros: 2_830,
      reservationId: null,
      isFixture: true,
    });
    expect(row.units).toBe(1);
  });

  it('records a fixture line as fixture work under a live context, like a reservation', async () => {
    const { owner, project, renderJob } = await job();
    const context = { ownerId: owner.id, jobId: renderJob.id, projectId: project.id };
    const fixtureLine = {
      provider: 'fixture',
      sku: 'vision_call' as const,
      stage: 'localizing',
      isFixture: true,
    };
    const charged = await charge(db, { ...context, isFixture: false }, fixtureLine);
    const [reserved] = await reserve(db, { ...context, isFixture: false }, [fixtureLine]);
    expect(charged.isFixture).toBe(true);
    expect(reserved?.isFixture).toBe(true);
    // A line that says nothing follows the context, and a live line stays live.
    const contextual = await charge(
      db,
      { ...context, isFixture: false },
      { provider: 'anthropic', sku: 'vision_call', stage: 'checking' },
    );
    expect(contextual.isFixture).toBe(false);
    const live = await charge(
      db,
      { ...context, isFixture: true },
      { provider: 'anthropic', sku: 'vision_call', stage: 'checking', isFixture: false },
    );
    expect(live.isFixture).toBe(false);
  });
});
