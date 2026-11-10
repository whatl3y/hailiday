import { afterAll, describe, expect, it } from 'vitest';
import { HOUR_MS } from '../clock/index.js';
import { testConfig } from '../config/index.js';
import { toJson } from '../db/client.js';
import { factories } from '../db/factories.js';
import { createTestDb } from '../db/testing.js';
import { newId } from '../ids/index.js';
import { charge, reserve, settle } from '../ledger/index.js';
import { seedPipelineTestContent } from '../pipeline/testing.js';
import { createSettings, type RuntimeSettings } from '../settings/index.js';
import {
  addressAllowance,
  attemptQuota,
  backstopLimits,
  checkSpend,
  consumeDisplayLoads,
  deviceBackstop,
  isRelightBaseCompanion,
  isUnsentAttempt,
  lockOwnerAllowance,
  recordAllowanceResidue,
  spendSince,
  variantAllowance,
} from './index.js';

const db = createTestDb();
afterAll(() => db.destroy());
const config = testConfig();

describe('allowance counters', () => {
  it('counts succeeded variants in the rolling window plus non-terminal jobs', async () => {
    const settings = createSettings(db, { config, cacheTtlMs: 0 });
    const now = new Date();
    const owner = await factories.owner(db);
    const make = async (state: 'succeeded' | 'failed' | 'queued', succeededAt?: Date) => {
      const project = await factories.project(db, { ownerId: owner.id });
      const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
      return factories.renderJob(db, {
        ownerId: owner.id,
        projectId: project.id,
        sourceAssetId: source.id,
        state,
        succeededAt,
        requestedAt: succeededAt,
        deviceHash: 'device-1',
      });
    };
    await make('succeeded', new Date(now.getTime() - 25 * HOUR_MS));
    const counted = await make('succeeded', new Date(now.getTime() - 2 * HOUR_MS));
    await make('failed', new Date(now.getTime() - HOUR_MS));
    let state = await variantAllowance(db, settings, { ownerId: owner.id, now });
    expect(state).toMatchObject({ limit: 3, used: 1, remaining: 2, exhausted: false });
    expect(state.resetsAt?.getTime()).toBe(counted.succeededAt!.getTime() + 24 * HOUR_MS);

    await make('queued');
    await make('queued');
    state = await variantAllowance(db, settings, { ownerId: owner.id, now: new Date() });
    expect(state).toMatchObject({ used: 3, remaining: 0, exhausted: true });

    const device = await deviceBackstop(db, settings, {
      deviceHash: 'device-1',
      ipHashes: [],
      now: new Date(),
    });
    expect(device.used).toBe(4);
  });

  it('does not count the daylight companion of an evening request', async () => {
    const settings = createSettings(db, { config, cacheTtlMs: 0 });
    const now = new Date();
    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id });
    const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
    const succeeded = () =>
      factories.renderJob(db, {
        ownerId: owner.id,
        projectId: project.id,
        sourceAssetId: source.id,
        state: 'succeeded',
        succeededAt: new Date(now.getTime() - HOUR_MS),
      });
    const evening = await succeeded();
    const companion = await succeeded();
    await db
      .updateTable('renderJobs')
      .set({
        idempotencyKey: `relight-base:${evening.id}`,
        inputSnapshot: toJson({ relightBaseOf: { jobId: evening.id, attemptId: newId() } }),
      })
      .where('id', '=', companion.id)
      .execute();
    // A request whose own key merely looks like a companion's still counts.
    const lookalike = await succeeded();
    await db
      .updateTable('renderJobs')
      .set({ idempotencyKey: `relight-base:${lookalike.id}` })
      .where('id', '=', lookalike.id)
      .execute();
    expect(await variantAllowance(db, settings, { ownerId: owner.id, now })).toMatchObject({
      used: 2,
      remaining: 1,
    });
    expect(isRelightBaseCompanion(companion.inputSnapshot)).toBe(false);
    expect(isRelightBaseCompanion({ relightBaseOf: { jobId: evening.id } })).toBe(true);
    expect(isRelightBaseCompanion({ test: true })).toBe(false);
    expect(isRelightBaseCompanion(null)).toBe(false);
  });

  it('reports the device and IP dimensions of the backstop separately', async () => {
    const settings = createSettings(db, { config, cacheTtlMs: 0 });
    const now = new Date();
    const owner = await factories.owner(db);
    const suffix = newId();
    const job = async (deviceHash: string, ipHash: string, requestedAt: Date) => {
      const project = await factories.project(db, { ownerId: owner.id });
      const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
      await factories.renderJob(db, {
        ownerId: owner.id,
        projectId: project.id,
        sourceAssetId: source.id,
        state: 'failed',
        requestedAt,
        deviceHash,
        ipHash,
      });
    };
    // One device behind several addresses: its own dimension fills, each address's does not.
    for (let i = 0; i < 6; i += 1) {
      await job(`device-a-${suffix}`, `ip-${i}-${suffix}`, new Date(now.getTime() - HOUR_MS));
    }
    const deviceFull = await deviceBackstop(db, settings, {
      deviceHash: `device-a-${suffix}`,
      ipHashes: [`ip-new-${suffix}`],
      now,
    });
    expect(deviceFull.device).toMatchObject({ limit: 6, used: 6, exhausted: true });
    expect(deviceFull.ip).toMatchObject({ used: 0, exhausted: false });
    expect(deviceFull).toMatchObject({ used: 6, exhausted: true });

    // The address's previous-day hash and current-day hash count as one dimension.
    for (let i = 0; i < 3; i += 1) {
      await job(
        `device-b${i}-${suffix}`,
        `ip-yesterday-${suffix}`,
        new Date(now.getTime() - 3 * HOUR_MS),
      );
      await job(`device-c${i}-${suffix}`, `ip-today-${suffix}`, new Date(now.getTime() - HOUR_MS));
    }
    const ipFull = await deviceBackstop(db, settings, {
      deviceHash: `device-fresh-${suffix}`,
      ipHashes: [`ip-today-${suffix}`, `ip-yesterday-${suffix}`],
      now,
    });
    expect(ipFull.ip).toMatchObject({ used: 6, exhausted: true });
    expect(ipFull.device).toMatchObject({ used: 0, exhausted: false });
    expect(ipFull.exhausted).toBe(true);
    const todayOnly = await deviceBackstop(db, settings, {
      deviceHash: null,
      ipHashes: [`ip-today-${suffix}`],
      now,
    });
    expect(todayOnly.ip).toMatchObject({ used: 3, exhausted: false });
    expect(todayOnly.device).toBeNull();
  });

  it('holds the device and IP dimensions to their own limits', async () => {
    const now = new Date();
    const owner = await factories.owner(db);
    const suffix = newId();
    const job = async (deviceHash: string, ipHash: string) => {
      const project = await factories.project(db, { ownerId: owner.id });
      const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
      await factories.renderJob(db, {
        ownerId: owner.id,
        projectId: project.id,
        sourceAssetId: source.id,
        state: 'failed',
        requestedAt: new Date(now.getTime() - HOUR_MS),
        deviceHash,
        ipHash,
      });
    };
    // One browser on one address: four requests on the device and on the address.
    for (let i = 0; i < 4; i += 1) await job(`device-${suffix}`, `ip-${suffix}`);
    const input = { deviceHash: `device-${suffix}`, ipHashes: [`ip-${suffix}`], now };

    // From the runtime settings: the device dimension at 4 is exhausted, the IP one at 10 is not.
    const settings = createSettings(db, {
      config: testConfig({
        QUOTA_RENDER_REQUESTS_PER_DEVICE_24H: '4',
        QUOTA_RENDER_REQUESTS_PER_IP_24H: '10',
      }),
      cacheTtlMs: 0,
    });
    expect(await backstopLimits(settings)).toEqual({ deviceLimit: 4, ipLimit: 10 });
    const deviceFirst = await deviceBackstop(db, settings, input);
    expect(deviceFirst.device).toMatchObject({ limit: 4, used: 4, exhausted: true });
    expect(deviceFirst.ip).toMatchObject({ limit: 10, used: 4, remaining: 6, exhausted: false });
    expect(deviceFirst).toMatchObject({ limit: 4, exhausted: true });

    // Passed explicitly: the IP dimension refuses first while the device still has room.
    const ipFirst = await deviceBackstop(db, settings, { ...input, deviceLimit: 9, ipLimit: 4 });
    expect(ipFirst.device).toMatchObject({ limit: 9, used: 4, exhausted: false });
    expect(ipFirst.ip).toMatchObject({ limit: 4, used: 4, exhausted: true });
    expect(ipFirst).toMatchObject({ limit: 4, exhausted: true });

    // The specified defaults keep both dimensions at 6.
    const defaults = createSettings(db, { config, cacheTtlMs: 0 });
    expect(await backstopLimits(defaults)).toEqual({ deviceLimit: 6, ipLimit: 6 });
    const specified = await deviceBackstop(db, defaults, input);
    expect(specified.device).toMatchObject({ limit: 6, used: 4, exhausted: false });
    expect(specified.ip).toMatchObject({ limit: 6, used: 4, exhausted: false });
  });

  it('counts new address projects only', async () => {
    const settings = createSettings(db, { config, cacheTtlMs: 0 });
    const owner = await factories.owner(db);
    await factories.project(db, { ownerId: owner.id, kind: 'address' });
    await factories.project(db, { ownerId: owner.id, kind: 'address' });
    await factories.project(db, { ownerId: owner.id, kind: 'upload' });
    const state = await addressAllowance(db, settings, { ownerId: owner.id, now: new Date() });
    expect(state).toMatchObject({ limit: 3, used: 2, remaining: 1 });
  });

  it('counts deleted units through their residue until they leave the window', async () => {
    const settings = createSettings(db, { config, cacheTtlMs: 0 });
    const owner = await factories.owner(db);
    await factories.project(db, { ownerId: owner.id, kind: 'address' });
    const now = new Date(Date.now() + 1000);
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const written = await recordAllowanceResidue(db, {
      ownerId: owner.id,
      now,
      units: [
        { kind: 'address', countedAt: ago(2 * HOUR_MS) },
        { kind: 'variant', countedAt: ago(HOUR_MS) },
        { kind: 'attempt', countedAt: ago(HOUR_MS) },
        { kind: 'attempt', countedAt: ago(HOUR_MS) },
        { kind: 'variant', countedAt: ago(25 * HOUR_MS) },
        { kind: 'variant', countedAt: null },
      ],
    });
    expect(written).toBe(4);

    const addresses = await addressAllowance(db, settings, { ownerId: owner.id, now });
    expect(addresses).toMatchObject({ limit: 3, used: 2, remaining: 1 });
    expect(addresses.resetsAt?.getTime()).toBe(ago(2 * HOUR_MS).getTime() + 24 * HOUR_MS);
    expect(await variantAllowance(db, settings, { ownerId: owner.id, now })).toMatchObject({
      used: 1,
      remaining: 2,
    });
    expect(
      await attemptQuota(db, settings, { ownerId: owner.id, now, projected: 2 }),
    ).toMatchObject({ used: 4 });

    const rows = await db
      .selectFrom('allowanceResidue')
      .selectAll()
      .where('ownerId', '=', owner.id)
      .execute();
    for (const row of rows) {
      expect(row.expiresAt.getTime()).toBe(row.countedAt.getTime() + 24 * HOUR_MS);
    }
    const later = new Date(now.getTime() + 23 * HOUR_MS);
    expect((await addressAllowance(db, settings, { ownerId: owner.id, now: later })).used).toBe(1);
    expect(
      await variantAllowance(db, settings, { ownerId: owner.id, now: later, limit: 5 }),
    ).toMatchObject({ limit: 5, used: 0 });
  });

  it("serializes an owner's allowance work on the advisory lock", async () => {
    const owner = await factories.owner(db);
    const other = await factories.owner(db);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const first = db.transaction().execute(async (trx) => {
      await lockOwnerAllowance(trx, owner.id);
      firstLocked();
      await held;
      order.push('first done');
    });
    await locked;
    const second = db.transaction().execute(async (trx) => {
      await lockOwnerAllowance(trx, owner.id);
      order.push('second locked');
    });
    await db.transaction().execute(async (trx) => {
      await lockOwnerAllowance(trx, other.id);
      order.push('other owner locked');
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(order).toEqual(['other owner locked']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['other owner locked', 'first done', 'second locked']);
    await expect(lockOwnerAllowance(db as never, owner.id)).rejects.toThrow(/transaction/);
  });

  it('enforces the per-address display budget atomically', async () => {
    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id, kind: 'address' });
    const propertyId = project.propertyId!;
    expect(await consumeDisplayLoads(db, { propertyId, limit: 6, count: 3 })).toBe(3);
    expect(await consumeDisplayLoads(db, { propertyId, limit: 6, count: 3 })).toBe(0);
    await expect(consumeDisplayLoads(db, { propertyId, limit: 6 })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'viewpoints', retryAfterSeconds: null },
    });
  });
});

describe('paid-attempt quota', () => {
  it('does not count an attempt that was never sent to the provider', async () => {
    await seedPipelineTestContent(db, config);
    const settings = createSettings(db, { config, cacheTtlMs: 0 });
    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id });
    const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
    const analysis = newId();
    await db
      .insertInto('sceneAnalyses')
      .values({
        id: analysis,
        sourceAssetId: source.id,
        analysisModel: 'attempt-quota-test',
        analysisPromptVersion: 'x',
        schemaVersion: '1.0',
        workingWidth: 1024,
        workingHeight: 1024,
        workingChecksumSha256: newId(),
        document: toJson({}),
      })
      .execute();
    const kit = await db.selectFrom('styleKits').select('id').executeTakeFirstOrThrow();
    // One failed job per attempt row, each with its first attempt.
    const attempt = async (fields: {
      outcome: 'canceled' | 'timeout' | 'provider_error';
      providerOperationId?: string | null;
      requestSentAt?: Date | null;
    }) => {
      const job = await factories.renderJob(db, {
        ownerId: owner.id,
        projectId: project.id,
        sourceAssetId: source.id,
        state: 'failed',
      });
      const attemptNo = 1;
      const plan = newId();
      await db
        .insertInto('decorationPlans')
        .values({
          id: plan,
          jobId: job.id,
          attemptNo,
          sceneAnalysisId: analysis,
          packVersion: '1.0.0',
          styleKitId: kit.id,
          compilerVersion: 'x',
          document: toJson({}),
          validatorResult: toJson({}),
        })
        .execute();
      await db
        .insertInto('renderAttempts')
        .values({
          id: newId(),
          jobId: job.id,
          attemptNo,
          isRepair: false,
          decorationPlanId: plan,
          sceneAnalysisId: analysis,
          permissionEvaluationId: job.permissionEvaluationId,
          provider: 'openai',
          modelSnapshot: 'x',
          promptVersion: 'x',
          compilerVersion: 'x',
          settingsHash: 'x',
          providerMode: 'live',
          providerOperationId: fields.providerOperationId ?? null,
          requestSentAt: fields.requestSentAt ?? null,
          sourceChecksumSha256: 'x',
          workingChecksumSha256: 'x',
          outcome: fields.outcome,
        })
        .execute();
    };
    const now = () => new Date(Date.now() + 1000);
    // Planned, then stopped by a pause before dispatch: no operation, never sent.
    await attempt({ outcome: 'canceled' });
    // The job deadline passed before dispatch.
    await attempt({ outcome: 'timeout' });
    expect(await attemptQuota(db, settings, { ownerId: owner.id, now: now() })).toMatchObject({
      used: 0,
    });

    // Anything the provider may have seen counts: a canceled or timed-out attempt with an
    // operation, and every other outcome.
    await attempt({
      outcome: 'canceled',
      providerOperationId: 'openai:sent',
      requestSentAt: new Date(),
    });
    await attempt({ outcome: 'timeout', providerOperationId: 'openai:late' });
    await attempt({ outcome: 'provider_error' });
    expect(await attemptQuota(db, settings, { ownerId: owner.id, now: now() })).toMatchObject({
      used: 3,
    });

    // The row predicate (used for deletion residue) agrees with the quota query.
    const rows = await db
      .selectFrom('renderAttempts')
      .innerJoin('renderJobs', 'renderJobs.id', 'renderAttempts.jobId')
      .select([
        'renderAttempts.outcome',
        'renderAttempts.providerOperationId',
        'renderAttempts.requestSentAt',
        'renderAttempts.ledgerEntryId',
      ])
      .where('renderJobs.ownerId', '=', owner.id)
      .execute();
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => !isUnsentAttempt(row))).toHaveLength(3);
    expect(
      isUnsentAttempt({
        outcome: 'canceled',
        providerOperationId: null,
        requestSentAt: null,
        ledgerEntryId: newId(),
      }),
    ).toBe(false);
  });
});

describe('spend ceilings', () => {
  it('ignores fixture work, honors the global pause and blocks at a per-SKU ceiling', async () => {
    const settings = createSettings(db, { config, cacheTtlMs: 0 });
    const now = new Date();
    const additional = new Map([['image_edit_attempt' as const, 260_000]]);
    expect(await checkSpend(db, settings, { now, additional, isFixture: true })).toBeNull();

    await settings.set('spend.sku_daily_micros.geocoding', 9_000, { expectedVersion: 0 });
    const owner = await factories.owner(db);
    await charge(
      db,
      { ownerId: owner.id, isFixture: false },
      { provider: 'google', sku: 'geocoding' },
    );
    await charge(
      db,
      { ownerId: owner.id, isFixture: true },
      { provider: 'fixture', sku: 'geocoding' },
    );
    const block = await checkSpend(db, settings, {
      now,
      additional: new Map([['geocoding_search_destinations' as const, 5_000]]),
      isFixture: false,
    });
    expect(block).toMatchObject({ reason: 'sku_ceiling', ceilingKey: 'geocoding' });
    expect(block?.resumesAt?.toISOString().endsWith('T00:00:00.000Z')).toBe(true);
    expect(
      await checkSpend(db, settings, {
        now,
        additional: new Map([['geocoding' as const, 4_000]]),
        isFixture: false,
      }),
    ).toBeNull();

    // The pause is read through the settings, never written to the shared database: a stored
    // global pause would stop the renders of every other test file running at the same time.
    const pausedSettings: RuntimeSettings = {
      ...settings,
      get: ((key: string) =>
        key === 'pause.global'
          ? Promise.resolve(true)
          : settings.get(key as Parameters<RuntimeSettings['get']>[0])) as RuntimeSettings['get'],
    };
    expect(
      await checkSpend(db, pausedSettings, { now, additional, isFixture: true }),
    ).toMatchObject({ reason: 'paused' });
    expect(await checkSpend(db, settings, { now, additional, isFixture: true })).toBeNull();
  });
});

describe('ceiling spend attribution', () => {
  it('counts a release in the period of the reservation it returns', async () => {
    // Far-future instants so rows of other tests never fall in these periods.
    const oldDay = new Date('2099-03-14T00:00:00.000Z');
    const newDay = new Date('2099-03-15T00:00:00.000Z');
    const owner = await factories.owner(db);
    const [reservation] = await reserve(
      db,
      { ownerId: owner.id, isFixture: false },
      [{ provider: 'openai', sku: 'image_edit_attempt', unitPriceMicros: 380_000 }],
      { now: () => new Date('2099-03-14T23:59:00.000Z') },
    );
    const { release } = await settle(
      db,
      { reservationId: reservation!.id, units: 1, unitPriceMicros: 130_000 },
      { now: () => new Date('2099-03-15T00:01:00.000Z') },
    );
    expect(release?.amountMicros).toBe(-250_000);
    expect(release?.createdAt.toISOString()).toBe('2099-03-15T00:01:00.000Z');
    // The new day starts at zero; the old day carries the settled cost.
    expect(await spendSince(db, newDay)).toBe(0);
    expect(await spendSince(db, oldDay, undefined, newDay)).toBe(130_000);
    expect(await spendSince(db, oldDay, ['image_edit_attempt'], newDay)).toBe(130_000);
  });
});
