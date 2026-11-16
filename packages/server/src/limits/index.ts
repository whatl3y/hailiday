import { sql } from 'kysely';
import { LEDGER_SKU_CEILING_KEYS, NON_TERMINAL_RENDER_JOB_STATES } from '@hailiday/core';
import type { LedgerSku, RateLimitScope, SpendCeilingKey } from '@hailiday/core';
import { HOUR_MS, MINUTE_MS, startOfNextUtcDay, startOfNextUtcMonth } from '../clock/index.js';
import { startOfUtcDay, startOfUtcMonth } from '../clock/index.js';
import type { DbOrTx, Tx } from '../db/client.js';
import { rateLimited } from '../errors/index.js';
import { newId } from '../ids/index.js';
import type { RuntimeSettings } from '../settings/index.js';
import type { AllowanceResidueKind } from './residue.js';
import { ROLLING_WINDOW_MS, counterState, inRollingWindow, rollingWindowStart } from './windows.js';
import type { CounterState, RateLimitRule } from './windows.js';

export * from './residue.js';
export * from './windows.js';

async function timestamps(query: Promise<{ at: Date | null }[]>): Promise<Date[]> {
  return (await query).map((row) => row.at).filter((at): at is Date => at instanceof Date);
}

/** Residue timestamps of an owner and kind inside the rolling window ending at `now`. */
function residueTimestamps(
  db: DbOrTx,
  input: { ownerId: string; kind: AllowanceResidueKind; now: Date },
): Promise<Date[]> {
  return timestamps(
    db
      .selectFrom('allowanceResidue')
      .select('countedAt as at')
      .where('ownerId', '=', input.ownerId)
      .where('kind', '=', input.kind)
      .where('countedAt', '>', rollingWindowStart(input.now))
      .where('countedAt', '<=', input.now)
      .execute(),
  );
}

/**
 * Records allowance residue for units whose authoritative rows are about to be deleted: one
 * non-identifying row (owner, kind, counted timestamp) per unit still inside the rolling window,
 * expiring when the unit leaves it. Units already outside the window are skipped. Run it in the
 * same transaction as the row deletion so the count never drops in between. Returns the rows
 * written.
 */
export async function recordAllowanceResidue(
  db: DbOrTx,
  input: {
    ownerId: string;
    now: Date;
    units: readonly { kind: AllowanceResidueKind; countedAt: Date | null }[];
  },
): Promise<number> {
  const rows = input.units
    .filter(
      (unit): unit is { kind: AllowanceResidueKind; countedAt: Date } =>
        unit.countedAt instanceof Date && inRollingWindow(unit.countedAt, input.now),
    )
    .map((unit) => ({
      id: newId(),
      ownerId: input.ownerId,
      kind: unit.kind,
      countedAt: unit.countedAt,
      expiresAt: new Date(unit.countedAt.getTime() + ROLLING_WINDOW_MS),
    }));
  if (rows.length === 0) return 0;
  await db.insertInto('allowanceResidue').values(rows).execute();
  return rows.length;
}

/** First key of the two-key advisory lock that serializes an owner's allowance work. */
export const ALLOWANCE_LOCK_NAMESPACE = 0x486c6c77;

/**
 * Takes the transaction-scoped advisory lock of an owner's allowance work, so the allowance,
 * attempt-quota and backstop checks and the row they admit commit one request at a time per
 * owner. Released at commit or rollback. Inside the lock, use only the transaction handle: a
 * query on the pool would wait behind the very connections queued on this lock.
 */
export async function lockOwnerAllowance(trx: Tx, ownerId: string): Promise<void> {
  if (!trx.isTransaction) throw new Error('lockOwnerAllowance needs a transaction');
  await sql`select pg_advisory_xact_lock(${ALLOWANCE_LOCK_NAMESPACE}::int4, hashtext(${ownerId}))`.execute(
    trx,
  );
}

/**
 * Whether a render job is the companion row under which an evening job published the daylight
 * variant it rendered as the base of its relight (`input_snapshot.relightBaseOf`, written only by
 * the pipeline, never from a request). The evening request is one look: it consumes one allowance
 * unit and delivers both variants, so a companion never counts toward the variants allowance and
 * leaves no residue when deleted.
 */
export function isRelightBaseCompanion(inputSnapshot: unknown): boolean {
  return (
    typeof inputSnapshot === 'object' &&
    inputSnapshot !== null &&
    (inputSnapshot as { relightBaseOf?: unknown }).relightBaseOf != null
  );
}

/**
 * The accepted variants allowance: variants that entered `succeeded` in the rolling window
 * (including deleted ones, through their residue) plus non-terminal jobs held against it. Cached
 * variants, the daylight companion of an evening request (`isRelightBaseCompanion`) and
 * rejected, failed, canceled, superseded or expired jobs never count. The limit is
 * `allowance.variants_per_24h`, or `allowance.new_owner_variants_per_24h` for owners created
 * after that setting was set; pass `limit` (from an earlier state) to skip the settings read.
 */
export async function variantAllowance(
  db: DbOrTx,
  settings: RuntimeSettings,
  input: { ownerId: string; now: Date; limit?: number },
): Promise<CounterState> {
  const limit = input.limit ?? (await effectiveVariantLimit(db, settings, input.ownerId));
  const start = rollingWindowStart(input.now);
  const live = await timestamps(
    db
      .selectFrom('renderJobs')
      .select('succeededAt as at')
      .where('ownerId', '=', input.ownerId)
      .where('state', '=', 'succeeded')
      .where('succeededAt', '>', start)
      .where('succeededAt', '<=', input.now)
      .where(sql`input_snapshot -> 'relightBaseOf'`, 'is', null)
      .execute(),
  );
  const residue = await residueTimestamps(db, {
    ownerId: input.ownerId,
    kind: 'variant',
    now: input.now,
  });
  const counted = [...live, ...residue];
  const held = await db
    .selectFrom('renderJobs')
    .select(sql<number>`count(*)`.as('count'))
    .where('ownerId', '=', input.ownerId)
    .where('state', 'in', [...NON_TERMINAL_RENDER_JOB_STATES])
    .executeTakeFirstOrThrow();
  return counterState({ limit, counted, held: Number(held.count), now: input.now });
}

async function effectiveVariantLimit(
  db: DbOrTx,
  settings: RuntimeSettings,
  ownerId: string,
): Promise<number> {
  const standard = await settings.get('allowance.variants_per_24h');
  const reduced = await settings.getRecord('allowance.new_owner_variants_per_24h');
  if (typeof reduced.value !== 'number' || !reduced.updatedAt || reduced.isDefault) return standard;
  const owner = await db
    .selectFrom('owners')
    .select('createdAt')
    .where('id', '=', ownerId)
    .executeTakeFirst();
  return owner && owner.createdAt > reduced.updatedAt ? reduced.value : standard;
}

/**
 * The new addresses allowance: address projects created in the rolling window, including deleted
 * ones through their residue. Pass `limit` to skip the settings read.
 */
export async function addressAllowance(
  db: DbOrTx,
  settings: RuntimeSettings,
  input: { ownerId: string; now: Date; limit?: number },
): Promise<CounterState> {
  const limit = input.limit ?? (await settings.get('allowance.addresses_per_24h'));
  const live = await timestamps(
    db
      .selectFrom('projects')
      .select('createdAt as at')
      .where('ownerId', '=', input.ownerId)
      .where('kind', '=', 'address')
      .where('createdAt', '>', rollingWindowStart(input.now))
      .where('createdAt', '<=', input.now)
      .execute(),
  );
  const residue = await residueTimestamps(db, {
    ownerId: input.ownerId,
    kind: 'address',
    now: input.now,
  });
  return counterState({ limit, counted: [...live, ...residue], now: input.now });
}

/**
 * Attempt outcomes that end an attempt the worker may have stopped before dispatch (a pause or a
 * deadline between planning and sending).
 */
export const UNSENT_ATTEMPT_OUTCOMES = ['canceled', 'timeout'] as const;

/** The fields of a `render_attempts` row that say whether it was ever sent. */
export interface AttemptSendRecord {
  outcome: string;
  providerOperationId: string | null;
  requestSentAt: Date | null;
  ledgerEntryId: string | null;
}

/**
 * Whether an attempt was never sent: it ended `canceled` or `timeout` with no provider operation,
 * no send time and no ledger entry. Such an attempt counts toward no attempt quota, live or as
 * deletion residue (the same predicate as the `attemptQuota` query).
 */
export function isUnsentAttempt(attempt: AttemptSendRecord): boolean {
  return (
    (UNSENT_ATTEMPT_OUTCOMES as readonly string[]).includes(attempt.outcome) &&
    attempt.providerOperationId === null &&
    attempt.requestSentAt === null &&
    attempt.ledgerEntryId === null
  );
}

/**
 * The paid attempts quota: `render_attempts` rows of the owner's jobs created in the window,
 * including deleted ones through their residue. An attempt that was never sent does not count:
 * it ended `canceled` or `timeout` with no provider operation, no send time and no ledger entry,
 * so the provider never saw it and nothing was charged. `projected` adds attempts about to be
 * made: at `POST /v1/renders` two for every job (`STANDARD_RENDER_ATTEMPTS`: the first attempt and
 * its repair or relight), and 1 before each further attempt in the worker, which is how a relit
 * look's third attempt is checked. Pass `limit` to skip the settings read.
 */
export async function attemptQuota(
  db: DbOrTx,
  settings: RuntimeSettings,
  input: { ownerId: string; now: Date; projected?: number; limit?: number },
): Promise<CounterState> {
  const limit = input.limit ?? (await settings.get('quota.attempts_per_owner_24h'));
  const live = await timestamps(
    db
      .selectFrom('renderAttempts')
      .innerJoin('renderJobs', 'renderJobs.id', 'renderAttempts.jobId')
      .select('renderAttempts.createdAt as at')
      .where('renderJobs.ownerId', '=', input.ownerId)
      .where('renderAttempts.createdAt', '>', rollingWindowStart(input.now))
      .where('renderAttempts.createdAt', '<=', input.now)
      .where((eb) =>
        eb.not(
          eb.and([
            eb('renderAttempts.outcome', 'in', [...UNSENT_ATTEMPT_OUTCOMES]),
            eb('renderAttempts.providerOperationId', 'is', null),
            eb('renderAttempts.requestSentAt', 'is', null),
            eb('renderAttempts.ledgerEntryId', 'is', null),
          ]),
        ),
      )
      .execute(),
  );
  const residue = await residueTimestamps(db, {
    ownerId: input.ownerId,
    kind: 'attempt',
    now: input.now,
  });
  return counterState({
    limit,
    counted: [...live, ...residue],
    held: input.projected ?? 0,
    now: input.now,
  });
}

/**
 * The backstop's state: the worst dimension's counter, plus each dimension's own counter (null
 * when the request carried no key for it).
 */
export interface BackstopState extends CounterState {
  device: CounterState | null;
  ip: CounterState | null;
}

/** The backstop's per-dimension limits, from the runtime settings. */
export async function backstopLimits(
  settings: RuntimeSettings,
): Promise<{ deviceLimit: number; ipLimit: number }> {
  return {
    deviceLimit: await settings.get('quota.render_requests_per_device_24h'),
    ipLimit: await settings.get('quota.render_requests_per_ip_24h'),
  };
}

/**
 * The device and IP backstop: render jobs created per device hash and per IP in the window, each
 * dimension against its own limit (`quota.render_requests_per_device_24h` and
 * `quota.render_requests_per_ip_24h`). `ipHashes` lists every salted hash of the request's address
 * a job in the window may carry (the salt rotates daily, so the current and the previous day's),
 * counted as one dimension. Pass `deviceLimit` and `ipLimit` (from an earlier state) to skip the
 * settings reads; `limit` applies one value to both dimensions where its own is not given.
 */
export async function deviceBackstop(
  db: DbOrTx,
  settings: RuntimeSettings,
  input: {
    deviceHash: string | null;
    ipHashes: readonly string[];
    now: Date;
    deviceLimit?: number;
    ipLimit?: number;
    limit?: number;
  },
): Promise<BackstopState> {
  const deviceLimit =
    input.deviceLimit ??
    input.limit ??
    (await settings.get('quota.render_requests_per_device_24h'));
  const ipLimit =
    input.ipLimit ?? input.limit ?? (await settings.get('quota.render_requests_per_ip_24h'));
  const start = rollingWindowStart(input.now);
  const count = async (
    column: 'deviceHash' | 'ipHash',
    values: readonly string[],
    limit: number,
  ) => {
    if (values.length === 0) return null;
    const counted = await timestamps(
      db
        .selectFrom('renderJobs')
        .select('requestedAt as at')
        .where(column, 'in', [...values])
        .where('requestedAt', '>', start)
        .where('requestedAt', '<=', input.now)
        .execute(),
    );
    return counterState({ limit, counted, now: input.now });
  };
  const device = await count('deviceHash', input.deviceHash ? [input.deviceHash] : [], deviceLimit);
  const ip = await count('ipHash', [...new Set(input.ipHashes.filter((hash) => hash))], ipLimit);
  const states = [device, ip].filter((state): state is CounterState => state !== null);
  const worst =
    states.length === 0
      ? {
          limit: deviceLimit,
          used: 0,
          remaining: deviceLimit,
          resetsAt: null,
          exhausted: deviceLimit === 0,
        }
      : states.reduce((a, b) => (b.remaining < a.remaining ? b : a));
  return { ...worst, device, ip };
}

/** Why a spend check failed, with when the affected ceiling resets. */
export interface SpendBlock {
  reason: 'daily_ceiling' | 'monthly_ceiling' | 'sku_ceiling' | 'paused';
  resumesAt: Date | null;
  ceilingKey?: SpendCeilingKey;
}

/**
 * Live spend counted toward ceilings since `since` (and before `until` when given): reservations
 * and charges, net of releases (a released remainder no longer holds budget). Every row counts in
 * the period of the spend it belongs to: a release is attributed to its reservation's creation
 * time, not its own, so a job reserved before a UTC day or month boundary and settled after it
 * does not lower the new period's spend. Fixture rows never count.
 */
export async function spendSince(
  db: DbOrTx,
  since: Date,
  skus?: readonly LedgerSku[],
  until?: Date,
): Promise<number> {
  const attributedAt = sql`coalesce(r.created_at, c.created_at)`;
  let query = db
    .selectFrom('usageLedger as c')
    .leftJoin('usageLedger as r', 'r.id', 'c.reservationId')
    .select(sql<number>`coalesce(sum(c.amount_micros), 0)`.as('total'))
    .where('c.isFixture', '=', false)
    .where('c.kind', 'in', ['reservation', 'charge', 'release'])
    // A row is never older than its reservation, so this bound only narrows the scan.
    .where('c.createdAt', '>=', since)
    .where(sql<boolean>`${attributedAt} >= ${since}`);
  if (until) query = query.where(sql<boolean>`${attributedAt} < ${until}`);
  if (skus && skus.length > 0) query = query.where('c.sku', 'in', [...skus]);
  const row = await query.executeTakeFirstOrThrow();
  return Number(row.total);
}

/** Ledger SKUs that count toward a ceiling key. */
export function skusForCeiling(key: SpendCeilingKey): LedgerSku[] {
  return (Object.entries(LEDGER_SKU_CEILING_KEYS) as [LedgerSku, SpendCeilingKey][])
    .filter(([, ceiling]) => ceiling === key)
    .map(([sku]) => sku);
}

/**
 * Checks the global pause, the service-wide daily and monthly ceilings and the per-SKU daily
 * ceilings before paid work. `additional` is the spend about to be reserved or charged, by SKU.
 * Fixture work (`isFixture`) is exempt from ceilings but not from the global pause. Returns null
 * when the work may proceed.
 */
export async function checkSpend(
  db: DbOrTx,
  settings: RuntimeSettings,
  input: { now: Date; additional: ReadonlyMap<LedgerSku, number>; isFixture: boolean },
): Promise<SpendBlock | null> {
  if (await settings.get('pause.global')) return { reason: 'paused', resumesAt: null };
  if (input.isFixture) return null;
  const additionalTotal = [...input.additional.values()].reduce((a, b) => a + b, 0);
  const dayStart = startOfUtcDay(input.now);

  const ceilingKeys = new Set<SpendCeilingKey>();
  for (const sku of input.additional.keys()) ceilingKeys.add(LEDGER_SKU_CEILING_KEYS[sku]);
  for (const key of ceilingKeys) {
    const skus = skusForCeiling(key);
    const ceiling = await settings.skuDailyCeilingMicros(key);
    const extra = skus.reduce((sum, sku) => sum + (input.additional.get(sku) ?? 0), 0);
    const spent = await spendSince(db, dayStart, skus);
    if (extra > 0 && spent + extra > ceiling) {
      return { reason: 'sku_ceiling', resumesAt: startOfNextUtcDay(input.now), ceilingKey: key };
    }
  }

  const daily = await settings.get('spend.daily_micros');
  if (additionalTotal > 0 && (await spendSince(db, dayStart)) + additionalTotal > daily) {
    return { reason: 'daily_ceiling', resumesAt: startOfNextUtcDay(input.now) };
  }
  const monthly = await settings.get('spend.monthly_micros');
  if (
    additionalTotal > 0 &&
    (await spendSince(db, startOfUtcMonth(input.now))) + additionalTotal > monthly
  ) {
    return { reason: 'monthly_ceiling', resumesAt: startOfNextUtcMonth(input.now) };
  }
  return null;
}

/**
 * How long a property's display budget window lasts: the budget counts the display URLs issued
 * since the window opened, and the first URL issued 24 hours or more after it opens a new one.
 */
export const DISPLAY_LOAD_WINDOW_MS = ROLLING_WINDOW_MS;

/** Whether a display budget window that opened at `startedAt` still counts at `now`. */
function displayWindowOpen(startedAt: Date | null, now: Date): boolean {
  return startedAt !== null && now.getTime() - startedAt.getTime() < DISPLAY_LOAD_WINDOW_MS;
}

/**
 * The display URLs a property may still issue at `now`: the limit less the count of its open
 * window (a window that opened 24 hours ago or more counts nothing). Read sites that report
 * `remainingDisplayLoads` use this rather than the stored count alone.
 */
export function displayLoadsRemaining(
  property: { displayLoadsIssued: number; displayLoadsWindowStartedAt: Date | null } | null,
  limit: number,
  now: Date,
): number {
  if (!property || !displayWindowOpen(property.displayLoadsWindowStartedAt, now)) {
    return Math.max(0, limit);
  }
  return Math.max(0, limit - property.displayLoadsIssued);
}

/**
 * Counts Static display URLs against the per-address display budget atomically: within the
 * property's open 24-hour window the count grows; when the window opened 24 hours ago or more (or
 * none is open) a new window opens at `now` with this issue as its first count. Throws
 * `RATE_LIMITED` (`scope: viewpoints`, no `Retry-After`) when the budget cannot cover `count`.
 * Returns the loads remaining in the window after this issue.
 */
export async function consumeDisplayLoads(
  db: DbOrTx,
  input: { propertyId: string; limit: number; count?: number; now?: Date },
): Promise<number> {
  const count = input.count ?? 1;
  const now = input.now ?? new Date();
  const expired = sql<boolean>`(display_loads_window_started_at is null
    or display_loads_window_started_at <= ${new Date(now.getTime() - DISPLAY_LOAD_WINDOW_MS)})`;
  const issued = sql<number>`(case when ${expired} then 0 else display_loads_issued end) + ${count}`;
  const row = await db
    .updateTable('properties')
    .set({
      displayLoadsIssued: issued,
      displayLoadsWindowStartedAt: sql<Date>`case when ${expired} then ${now}::timestamptz
        else display_loads_window_started_at end`,
    })
    .where('id', '=', input.propertyId)
    .where(sql<boolean>`${issued} <= ${input.limit}`)
    .returning('displayLoadsIssued')
    .executeTakeFirst();
  if (!row) throw rateLimited('viewpoints', null);
  return Math.max(0, input.limit - row.displayLoadsIssued);
}

/**
 * Clears a property's display count when its window opened 24 hours ago or more, so readers of
 * the stored count see the fresh budget before the next display URL is issued. Returns whether
 * anything changed.
 */
export async function resetExpiredDisplayLoads(
  db: DbOrTx,
  input: { propertyId: string; now: Date },
): Promise<boolean> {
  const result = await db
    .updateTable('properties')
    .set({ displayLoadsIssued: 0, displayLoadsWindowStartedAt: null })
    .where('id', '=', input.propertyId)
    .where('displayLoadsIssued', '>', 0)
    .where((eb) =>
      eb.or([
        eb('displayLoadsWindowStartedAt', 'is', null),
        eb(
          'displayLoadsWindowStartedAt',
          '<=',
          new Date(input.now.getTime() - DISPLAY_LOAD_WINDOW_MS),
        ),
      ]),
    )
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/**
 * Default per-endpoint request limits for the API's rate-limit middleware (sliding windows keyed
 * by IP hash, email hash or session). Values are configuration; upload limits come from the
 * uploads spec, the rest are conservative defaults for endpoints whose values no spec fixes.
 * Session creation is limited separately, from the `rate.sessions_per_ip_10m` runtime setting
 * (see `sessionCreationRule`).
 */
export const ENDPOINT_RATE_LIMITS: Readonly<
  Partial<
    Record<
      RateLimitScope,
      readonly (RateLimitRule & { per: 'ip' | 'session' | 'email' | 'owner' })[]
    >
  >
> = {
  magic_link: [
    { per: 'email', limit: 5, windowMs: HOUR_MS },
    { per: 'ip', limit: 20, windowMs: HOUR_MS },
  ],
  auth_verify: [{ per: 'ip', limit: 30, windowMs: 10 * MINUTE_MS }],
  reports: [{ per: 'ip', limit: 10, windowMs: HOUR_MS }],
  shares: [{ per: 'session', limit: 30, windowMs: HOUR_MS }],
  uploads: [
    { per: 'owner', limit: 10, windowMs: HOUR_MS },
    { per: 'owner', limit: 30, windowMs: 24 * HOUR_MS },
  ],
  clicks: [{ per: 'session', limit: 120, windowMs: 10 * MINUTE_MS }],
  analytics: [{ per: 'session', limit: 120, windowMs: MINUTE_MS }],
  projects: [{ per: 'session', limit: 60, windowMs: HOUR_MS }],
  feedback: [{ per: 'session', limit: 30, windowMs: HOUR_MS }],
};

/** Upload bytes per owner per rolling 24 h (uploads spec). */
export const UPLOAD_BYTES_PER_OWNER_24H = 250 * 1024 * 1024;

/** New anonymous sessions per IP hash: the `rate.sessions_per_ip_10m` setting over 10 minutes. */
export async function sessionCreationRule(settings: RuntimeSettings): Promise<RateLimitRule> {
  return { limit: await settings.get('rate.sessions_per_ip_10m'), windowMs: 10 * MINUTE_MS };
}

/** Address-path limits read from runtime settings (address spec, pre-render spend controls). */
export async function addressPathRules(settings: RuntimeSettings) {
  return {
    suggestionsPerToken: await settings.get('rate.suggestions_per_token'),
    suggestionsPerSession: {
      limit: await settings.get('rate.suggestions_per_session_10m'),
      windowMs: 10 * MINUTE_MS,
    } satisfies RateLimitRule,
    sessionTokens: {
      limit: await settings.get('rate.session_tokens_per_10m'),
      windowMs: 10 * MINUTE_MS,
    } satisfies RateLimitRule,
    resolvePerToken: await settings.get('rate.resolve_per_token'),
    geocodePerSession: {
      limit: await settings.get('rate.geocode_per_session_10m'),
      windowMs: 10 * MINUTE_MS,
    } satisfies RateLimitRule,
    staticDisplayLoadsPerAddress: await settings.get('rate.static_display_loads_per_address'),
  };
}
