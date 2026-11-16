import { sql } from 'kysely';
import {
  MAX_RENDER_ATTEMPTS,
  STANDARD_RENDER_ATTEMPTS,
  isRelightLightingMode,
} from '@hailiday/core';
import type { LedgerCategory, LedgerSku, LightingMode } from '@hailiday/core';
import type { Clock } from '../clock/index.js';
import { systemClock } from '../clock/index.js';
import type { DbOrTx } from '../db/client.js';
import type { UsageLedgerEntry } from '../db/schema.js';
import { newId } from '../ids/index.js';

/** One millionth of the currency unit; ledger amounts are integer micros. */
export const MICROS_PER_UNIT = 1_000_000;
export const LEDGER_CURRENCY = 'USD';

/** Decimal places kept for `units` (`numeric(12,4)`). */
const UNIT_SCALE = 10_000n;

/**
 * `units × unitPriceMicros`, rounded half up to whole micros, computed exactly: units are scaled
 * to four decimals (the column's precision) and multiplied as integers.
 */
export function microsFor(units: number, unitPriceMicros: number): number {
  if (!Number.isFinite(units) || units < 0) throw new RangeError(`Invalid units: ${units}`);
  if (!Number.isInteger(unitPriceMicros) || unitPriceMicros < 0) {
    throw new RangeError(`Invalid unit price: ${unitPriceMicros}`);
  }
  const scaledUnits = BigInt(Math.round(units * Number(UNIT_SCALE)));
  const product = scaledUnits * BigInt(unitPriceMicros);
  const rounded = (product + UNIT_SCALE / 2n) / UNIT_SCALE;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new RangeError('Ledger amount exceeds the safe range');
  return result;
}

/** Converts micros to minor units (cents for USD), rounding half up. */
export function microsToMinor(micros: number, minorPerUnit = 100): number {
  const perMinor = MICROS_PER_UNIT / minorPerUnit;
  return Math.sign(micros) * Math.floor((Math.abs(micros) + perMinor / 2) / perMinor);
}

/** Converts a dollar figure to micros (for configuration written in dollars). */
export function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * MICROS_PER_UNIT);
}

/** List unit price of one SKU call, by provider where prices differ. */
export interface PriceEntry {
  category: LedgerCategory;
  /** Price in USD micros per unit. */
  unitPriceMicros: number;
  /** Whether the figure is an estimate (no published per-unit price). */
  estimate: boolean;
}

/**
 * Dated list prices from the economics cost worksheet (retrieved 2026-11-08). Google SKUs are per
 * request; image-edit attempts use the canonical illustration ($0.13); vision calls are priced
 * per call by stage; screening and email are placeholders until priced.
 */
export const PRICE_LIST: Readonly<Record<LedgerSku, PriceEntry>> = {
  places_autocomplete_requests: { category: 'google', unitPriceMicros: 2_830, estimate: false },
  places_details_essentials: { category: 'google', unitPriceMicros: 5_000, estimate: false },
  geocoding: { category: 'google', unitPriceMicros: 5_000, estimate: false },
  geocoding_search_destinations: { category: 'google', unitPriceMicros: 5_000, estimate: false },
  street_view_metadata: { category: 'google', unitPriceMicros: 0, estimate: false },
  street_view_static_display: { category: 'google', unitPriceMicros: 7_000, estimate: false },
  street_view_static_fetch: { category: 'google', unitPriceMicros: 7_000, estimate: false },
  image_edit_attempt: { category: 'image_edit', unitPriceMicros: 130_000, estimate: true },
  vision_call: { category: 'vision', unitPriceMicros: 40_000, estimate: true },
  screened_upload: { category: 'safety', unitPriceMicros: 10_000, estimate: true },
  email: { category: 'email', unitPriceMicros: 1_000, estimate: true },
};

/** Image-edit attempt prices per provider (canonical figures from the worksheet). */
export const IMAGE_EDIT_PRICES_MICROS: Readonly<Record<string, number>> = {
  fixture: 130_000,
  openai: 130_000,
  gemini: 134_000,
};

/**
 * Vision call prices per call by stage, at or above the live settlements measured on 2026-11-10
 * (analysis $0.038 to $0.041, judge $0.035 to $0.039, localization about $0.034, escalation
 * $0.028). Localizing the editor's additions sends two images and a short answer, like a judge
 * call, and is priced like one. An escalation reruns the judge at a higher effort, so its worst
 * case is priced above a judge call; the two share the `checking` stage and are told apart by
 * price. The judge of a Street View enhancement sends two images and a short answer like the
 * relight judge ($0.035 to $0.04) and is priced like a judge call. Locating the home in a Street
 * View frame sends one image at low effort and a short answer (one box), priced at half a judge
 * call.
 */
export const VISION_PRICES_MICROS = {
  analysis: 42_000,
  judge: 40_000,
  escalation: 45_000,
  localization: 40_000,
  enhancement: 40_000,
  locate: 20_000,
  triage: 5_000,
} as const;
export type VisionStage = keyof typeof VISION_PRICES_MICROS;

/**
 * The ledger `stage` of each vision call of a render job. The judge and the localization share a
 * price, so a reservation is told apart by this stage, not by its price.
 */
export const VISION_LEDGER_STAGES: Readonly<Record<Exclude<VisionStage, 'triage'>, string>> = {
  analysis: 'analyzing',
  judge: 'checking',
  escalation: 'checking',
  localization: 'localizing',
  enhancement: 'enhancing',
  locate: 'framing',
};

/**
 * The ledger `stage` of the Street View enhancement's lines: its image edit and its judge call.
 * Attempt lookups exclude it, so an attempt never takes the enhancement's reservation.
 */
export const ENHANCE_LEDGER_STAGE = 'enhancing';

/**
 * The ledger `stage` of the Street View framing's direct charges: the call that locates the home
 * and the fetch of the framed view. Nothing is reserved for them at admission.
 */
export const FRAMING_LEDGER_STAGE = 'framing';

/** Token prices in USD per million tokens, which is the same figure in micros per token. */
export interface TokenPrice {
  /** Input tokens (image input where the vendor prices text and image input apart). */
  input: number;
  output: number;
  /** Text input tokens, when the vendor prices them apart and the usage splits the input. */
  textInput?: number;
  /** Prompt-cache reads; uncached input price when absent. */
  cacheRead?: number;
}

/**
 * Token prices, the single price source for settlement and the model bake-off (economics cost
 * worksheet; docs/research/image-ai-providers.md, Pricing; retrieved 2026-11-08 and 2026-11-09),
 * by provider and model ID. GPT image models price image input at $8 and text input at $5 per
 * million: the split applies when the usage reports it, otherwise all input is priced as image
 * input. Nano Banana 2.1 publishes only its image output price; its prompt tokens are priced at
 * the previous generation's $0.50 per million. Thinking tokens a vendor reports apart from the
 * output (Gemini) are billed at the output price.
 */
export const TOKEN_PRICES: readonly { provider: string; model: RegExp; price: TokenPrice }[] = [
  {
    provider: 'anthropic',
    model: /^claude-opus-5-5(-|$)/,
    price: { input: 4, output: 20, cacheRead: 0.2 },
  },
  {
    provider: 'anthropic',
    model: /^claude-sonnet-5-5(-|$)/,
    price: { input: 2, output: 10, cacheRead: 0.2 },
  },
  { provider: 'anthropic', model: /^claude-haiku-5-5(-|$)/, price: { input: 0.1, output: 0.5 } },
  {
    provider: 'openai',
    model: /^gpt-image-2(\.[56])?(-|$)/,
    price: { input: 8, textInput: 5, output: 30 },
  },
  { provider: 'gemini', model: /^gemini-nano-banana-2\.1(-|$)/, price: { input: 0.5, output: 30 } },
  { provider: 'gemini', model: /^gemini-3\.1-flash-image(-|$)/, price: { input: 0.5, output: 60 } },
  { provider: 'gemini', model: /^gemini-3-pro-image(-|$)/, price: { input: 2, output: 120 } },
];

/**
 * Per-image prices by size tier (worksheet) for image models also priced per image: the
 * settlement fallback when a reply carries no token usage.
 */
export const IMAGE_PRICES_BY_SIZE: readonly {
  model: RegExp;
  micros: Readonly<Record<string, number>>;
}[] = [{ model: /^gemini-nano-banana-2\.1(-|$)/, micros: { '1K': 33_600, '2K': 50_400 } }];

/** The token price of a model, optionally only when it belongs to `provider`. */
export function tokenPriceFor(model: string, provider?: string): TokenPrice | null {
  const entry = TOKEN_PRICES.find((item) => item.model.test(model));
  if (!entry || (provider !== undefined && entry.provider !== provider)) return null;
  return entry.price;
}

/** What a provider reported for one call (image-edit and vision usage both fit). */
export interface ReportedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  /** Text and image input tokens, when the vendor splits the input. */
  inputTextTokens?: number;
  inputImageTokens?: number;
  /** Thinking tokens reported apart from the output tokens; billed at the output price. */
  thoughtsTokens?: number;
  images?: number;
  /** The vendor's own usage record; read for the split and thinking figures when unset above. */
  raw?: Record<string, unknown>;
}

const tokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The input split and thinking tokens, from the usage fields or the vendor's raw record. */
function detailedUsage(usage: ReportedUsage): {
  inputTextTokens?: number;
  inputImageTokens?: number;
  thoughtsTokens?: number;
} {
  const raw = usage.raw ?? {};
  const details = (raw.input_tokens_details ?? {}) as Record<string, unknown>;
  const inputTextTokens = tokenCount(usage.inputTextTokens) ?? tokenCount(details.text_tokens);
  const inputImageTokens = tokenCount(usage.inputImageTokens) ?? tokenCount(details.image_tokens);
  const thoughtsTokens = tokenCount(usage.thoughtsTokens) ?? tokenCount(raw.thoughtsTokenCount);
  return {
    ...(inputTextTokens !== undefined ? { inputTextTokens } : {}),
    ...(inputImageTokens !== undefined ? { inputImageTokens } : {}),
    ...(thoughtsTokens !== undefined ? { thoughtsTokens } : {}),
  };
}

/**
 * The cost of one call from the provider's reported usage, in micros: tokens at the token prices
 * (input split into text and image when the usage splits it and the model prices them apart;
 * thinking tokens at the output price) whenever the usage reports input and output tokens; the
 * per-image price of the size tier otherwise, for models priced per image. Null when the model
 * has no price or the usage lacks the figures (the caller then settles at the list price).
 */
export function usageCostMicros(
  model: string | null | undefined,
  usage: ReportedUsage | null | undefined,
  options: { imageSize?: string | null } = {},
): number | null {
  if (!model || !usage) return null;
  const price = tokenPriceFor(model);
  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  if (price && inputTokens !== undefined && outputTokens !== undefined) {
    const detail = detailedUsage(usage);
    const input =
      price.textInput !== undefined &&
      detail.inputTextTokens !== undefined &&
      detail.inputImageTokens !== undefined
        ? detail.inputTextTokens * price.textInput + detail.inputImageTokens * price.input
        : inputTokens * price.input;
    const cost =
      input +
      (outputTokens + (detail.thoughtsTokens ?? 0)) * price.output +
      (tokenCount(usage.cacheReadInputTokens) ?? 0) * (price.cacheRead ?? price.input);
    return Number.isFinite(cost) ? Math.round(cost) : null;
  }
  const perImage = IMAGE_PRICES_BY_SIZE.find((entry) => entry.model.test(model));
  if (perImage) {
    const tier = perImage.micros[options.imageSize ?? '1K'];
    if (tier === undefined) return null;
    return Math.round((usage.images ?? 1) * tier);
  }
  return null;
}

export function unitPriceFor(
  sku: LedgerSku,
  options: { provider?: string; visionStage?: VisionStage } = {},
): number {
  if (sku === 'image_edit_attempt' && options.provider) {
    return (
      IMAGE_EDIT_PRICES_MICROS[options.provider] ?? PRICE_LIST.image_edit_attempt.unitPriceMicros
    );
  }
  if (sku === 'vision_call' && options.visionStage)
    return VISION_PRICES_MICROS[options.visionStage];
  return PRICE_LIST[sku].unitPriceMicros;
}

/** One ledger line before it is written. */
export interface LedgerLine {
  category?: LedgerCategory;
  provider: string;
  sku: LedgerSku;
  modelId?: string | null;
  stage?: string | null;
  units?: number;
  /** Defaults to the price list. */
  unitPriceMicros?: number;
  /**
   * Marks this line fixture work regardless of the operation's context (a fixture leg of a job
   * whose other legs are live). `reserve` falls back to the context's `isFixture`.
   */
  isFixture?: boolean;
}

/** References shared by the rows of one operation. */
export interface LedgerContext {
  ownerId?: string | null;
  jobId?: string | null;
  attemptId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  isFixture: boolean;
  currency?: string;
}

function resolveLine(line: LedgerLine) {
  const units = line.units ?? 1;
  const unitPriceMicros =
    line.unitPriceMicros ?? unitPriceFor(line.sku, { provider: line.provider });
  return {
    category: line.category ?? PRICE_LIST[line.sku].category,
    provider: line.provider,
    sku: line.sku,
    modelId: line.modelId ?? null,
    stage: line.stage ?? null,
    units,
    unitPriceMicros,
    amountMicros: microsFor(units, unitPriceMicros),
  };
}

function contextColumns(context: LedgerContext) {
  return {
    ownerId: context.ownerId ?? null,
    jobId: context.jobId ?? null,
    attemptId: context.attemptId ?? null,
    projectId: context.projectId ?? null,
    sessionId: context.sessionId ?? null,
    isFixture: context.isFixture,
    currency: context.currency ?? LEDGER_CURRENCY,
  };
}

/**
 * Writes one `reservation` row per line (worst-case spend held before paid work). A line's own
 * `isFixture` wins over the context's, so a job's fixture legs never count toward live ceilings.
 */
export async function reserve(
  db: DbOrTx,
  context: LedgerContext,
  lines: readonly LedgerLine[],
  clock: Clock = systemClock,
): Promise<UsageLedgerEntry[]> {
  if (lines.length === 0) return [];
  const now = clock.now();
  return db
    .insertInto('usageLedger')
    .values(
      lines.map((line) => ({
        id: newId(),
        createdAt: now,
        kind: 'reservation' as const,
        ...resolveLine(line),
        ...contextColumns(context),
        isFixture: line.isFixture ?? context.isFixture,
      })),
    )
    .returningAll()
    .execute();
}

/**
 * Writes a `charge`: a cost with no reservation (address-path Google calls, emails). Like
 * `reserve`, a line's own `isFixture` wins over the context's.
 */
export async function charge(
  db: DbOrTx,
  context: LedgerContext,
  line: LedgerLine,
  clock: Clock = systemClock,
): Promise<UsageLedgerEntry> {
  const now = clock.now();
  return db
    .insertInto('usageLedger')
    .values({
      id: newId(),
      createdAt: now,
      kind: 'charge',
      ...resolveLine(line),
      ...contextColumns(context),
      isFixture: line.isFixture ?? context.isFixture,
      settledAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Held, settled and released totals of one reservation row. */
export interface ReservationBalance {
  reservation: UsageLedgerEntry;
  settledMicros: number;
  releasedMicros: number;
  /** Reserved minus settled minus released, never below zero. */
  openMicros: number;
  closed: boolean;
}

/** Remaining hold of a reservation given what was settled and released (pure arithmetic). */
export function openAmount(reservedMicros: number, settledMicros: number, releasedMicros: number) {
  return Math.max(0, reservedMicros - settledMicros - Math.abs(releasedMicros));
}

export async function reservationBalance(
  db: DbOrTx,
  reservationId: string,
): Promise<ReservationBalance> {
  const reservation = await db
    .selectFrom('usageLedger')
    .selectAll()
    .where('id', '=', reservationId)
    .where('kind', '=', 'reservation')
    .executeTakeFirstOrThrow();
  const totals = await db
    .selectFrom('usageLedger')
    .select([
      sql<number>`coalesce(sum(amount_micros) filter (where kind = 'settlement'), 0)`.as('settled'),
      sql<number>`coalesce(sum(amount_micros) filter (where kind = 'release'), 0)`.as('released'),
      sql<number>`count(*)`.as('count'),
    ])
    .where('reservationId', '=', reservationId)
    .executeTakeFirstOrThrow();
  const settledMicros = Number(totals.settled);
  const releasedMicros = Number(totals.released);
  return {
    reservation,
    settledMicros,
    releasedMicros,
    openMicros: openAmount(reservation.amountMicros, settledMicros, releasedMicros),
    closed: Number(totals.count) > 0,
  };
}

/**
 * Records the actual cost of a reserved call (`settlement`) and, unless `keepOpen`, releases the
 * unused remainder of the reservation in the same call (a negative `release`). Locks the
 * reservation row so concurrent settlements serialize.
 */
export async function settle(
  db: DbOrTx,
  input: {
    reservationId: string;
    units?: number;
    unitPriceMicros?: number;
    /** Overrides units × price (for provider-reported totals). */
    amountMicros?: number;
    attemptId?: string | null;
    modelId?: string | null;
    keepOpen?: boolean;
  },
  clock: Clock = systemClock,
): Promise<{ settlement: UsageLedgerEntry; release: UsageLedgerEntry | null }> {
  const now = clock.now();
  const reservation = await db
    .selectFrom('usageLedger')
    .selectAll()
    .where('id', '=', input.reservationId)
    .where('kind', '=', 'reservation')
    .forUpdate()
    .executeTakeFirstOrThrow();
  const units = input.units ?? reservation.units;
  const unitPriceMicros = input.unitPriceMicros ?? reservation.unitPriceMicros;
  const amountMicros = input.amountMicros ?? microsFor(units, unitPriceMicros);
  const base = {
    category: reservation.category,
    provider: reservation.provider,
    sku: reservation.sku,
    modelId: input.modelId ?? reservation.modelId,
    stage: reservation.stage,
    currency: reservation.currency,
    reservationId: reservation.id,
    ownerId: reservation.ownerId,
    jobId: reservation.jobId,
    attemptId: input.attemptId ?? reservation.attemptId,
    projectId: reservation.projectId,
    sessionId: reservation.sessionId,
    isFixture: reservation.isFixture,
    settledAt: now,
  };
  const settlement = await db
    .insertInto('usageLedger')
    .values({
      id: newId(),
      createdAt: now,
      kind: 'settlement',
      units,
      unitPriceMicros,
      amountMicros,
      ...base,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (input.keepOpen) return { settlement, release: null };
  const balance = await reservationBalance(db, reservation.id);
  if (balance.openMicros === 0) return { settlement, release: null };
  const release = await db
    .insertInto('usageLedger')
    .values({
      id: newId(),
      createdAt: now,
      kind: 'release',
      units: 0,
      unitPriceMicros: reservation.unitPriceMicros,
      amountMicros: -balance.openMicros,
      ...base,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return { settlement, release };
}

/** Releases the whole open remainder of one reservation; returns null when nothing is open. */
export async function release(
  db: DbOrTx,
  reservationId: string,
  clock: Clock = systemClock,
): Promise<UsageLedgerEntry | null> {
  const now = clock.now();
  await db
    .selectFrom('usageLedger')
    .select('id')
    .where('id', '=', reservationId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const balance = await reservationBalance(db, reservationId);
  if (balance.openMicros === 0) return null;
  const { reservation } = balance;
  return db
    .insertInto('usageLedger')
    .values({
      id: newId(),
      createdAt: now,
      kind: 'release',
      category: reservation.category,
      provider: reservation.provider,
      sku: reservation.sku,
      modelId: reservation.modelId,
      stage: reservation.stage,
      units: 0,
      unitPriceMicros: reservation.unitPriceMicros,
      amountMicros: -balance.openMicros,
      currency: reservation.currency,
      reservationId: reservation.id,
      ownerId: reservation.ownerId,
      jobId: reservation.jobId,
      attemptId: reservation.attemptId,
      projectId: reservation.projectId,
      sessionId: reservation.sessionId,
      isFixture: reservation.isFixture,
      settledAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Reservation rows of a job with no settlement or release yet, in the order they were written
 * (rows of one `reserve` call share a timestamp; their time-ordered IDs keep the line order).
 */
export async function openReservations(db: DbOrTx, jobId: string): Promise<UsageLedgerEntry[]> {
  return db
    .selectFrom('usageLedger as r')
    .selectAll('r')
    .where('r.jobId', '=', jobId)
    .where('r.kind', '=', 'reservation')
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('usageLedger as c')
            .select('c.id')
            .whereRef('c.reservationId', '=', 'r.id')
            .where('c.kind', 'in', ['settlement', 'release']),
        ),
      ),
    )
    .orderBy('r.createdAt')
    .orderBy('r.id')
    .execute();
}

/**
 * Releases every untouched reservation of a job (job reached a terminal state, or it was
 * superseded). Reservations listed in `exceptReservationIds` (an in-flight attempt) stay open
 * until the late response or reconciliation settles them.
 */
export async function releaseJobReservations(
  db: DbOrTx,
  jobId: string,
  options: { exceptReservationIds?: readonly string[]; clock?: Clock } = {},
): Promise<UsageLedgerEntry[]> {
  const except = new Set(options.exceptReservationIds ?? []);
  const releases: UsageLedgerEntry[] = [];
  for (const reservation of await openReservations(db, jobId)) {
    if (except.has(reservation.id)) continue;
    const row = await release(db, reservation.id, options.clock);
    if (row) releases.push(row);
  }
  return releases;
}

/** Sum of a job's open holds (reserved minus settled and released) in micros. */
export async function openReservationMicros(db: DbOrTx, jobId: string): Promise<number> {
  const result = await db
    .selectFrom('usageLedger as r')
    .select(
      sql<number>`coalesce(sum(greatest(0, r.amount_micros - coalesce((
        select sum(abs(c.amount_micros)) from usage_ledger c
        where c.reservation_id = r.id and c.kind in ('settlement', 'release')
      ), 0))), 0)`.as('open'),
    )
    .where('r.jobId', '=', jobId)
    .where('r.kind', '=', 'reservation')
    .executeTakeFirstOrThrow();
  return Number(result.open);
}

/** The shape of a render job that decides its worst case. */
export interface RenderJobShape {
  /** The job's lighting mode; `source` when absent. */
  lightingMode?: LightingMode;
  /** A relight-mode job whose accepted daylight variant exists: it relights that variant. */
  relightBase?: boolean;
}

/** A relit look (`evening`, `bright`) with no accepted daylight variant to relight. */
function decoratesOwnBase(input: RenderJobShape): boolean {
  return (
    input.lightingMode !== undefined &&
    isRelightLightingMode(input.lightingMode) &&
    input.relightBase !== true
  );
}

/**
 * How many image-edit attempts a render job may make (render spec, repair and retries). A job
 * makes an attempt and at most one repair: two. A relit look (`evening`, `bright`) that decorates
 * its own base first may make three: the base, the relight, and one repair of either (a rejected
 * base repaired before its relight, or a rejected relight repaired). One that relights an accepted
 * daylight variant makes the relight and its repair: two.
 */
export function renderEditAttempts(input: RenderJobShape): number {
  return decoratesOwnBase(input) ? MAX_RENDER_ATTEMPTS : STANDARD_RENDER_ATTEMPTS;
}

/**
 * How many image-edit attempts of a render job may decorate the photo, each followed by a
 * localization of what the editor added (relight attempts are never localized). A daylight
 * (`source`) job decorates in both attempts. A relight-mode job (`evening`, `bright`) with an
 * accepted daylight variant to relight only relights. Without one, its first attempt decorates
 * the base and, when that base is rejected and repairable, its second attempt repairs it before
 * the relight: two attempts may decorate.
 */
export function decoratingAttempts(input: RenderJobShape): number {
  const relightMode = input.lightingMode !== undefined && isRelightLightingMode(input.lightingMode);
  return relightMode && input.relightBase === true ? 0 : STANDARD_RENDER_ATTEMPTS;
}

/**
 * Worst-case reservation lines for one render job (render spec, cost recording): the Street View
 * fetch when the job will fetch pixels (a transient source always, a persist source before its
 * original is stored), the scene analysis unless a reusable one exists, one image-edit attempt,
 * one judge call and one escalation per attempt the job may make (`renderEditAttempts`: two, or
 * three for a relit look that decorates its own base), and one localization per decorating
 * attempt (`decoratingAttempts`). Without `lightingMode` the daylight shape is reserved. The
 * localization lines follow, so the judge lines, which share their price, are found first by an
 * unfiltered lookup. With `enhance`, one image edit and one judge call of the Street View
 * enhancement (stage `enhancing`) come last of all, for the same reason.
 */
export function renderReservationLines(
  input: RenderJobShape & {
    imageEditProvider: string;
    imageEditModel?: string | null;
    visionProvider: string;
    visionModel?: string | null;
    /** The job will fetch Street View pixels (transient always; persist before its first store). */
    streetViewFetch: boolean;
    /** No analysis call is reserved when a reusable analysis exists. */
    reuseAnalysis: boolean;
    streetViewProvider?: string;
    /** The job may enhance its stored Street View frame (`enhancementReservationExpected`). */
    enhance?: boolean;
  },
): LedgerLine[] {
  const lines: LedgerLine[] = [];
  if (input.streetViewFetch) {
    lines.push({
      provider: input.streetViewProvider ?? 'google',
      sku: 'street_view_static_fetch',
      stage: 'preparing',
    });
  }
  const vision = (stage: Exclude<VisionStage, 'triage'>): LedgerLine => ({
    provider: input.visionProvider,
    sku: 'vision_call',
    modelId: input.visionModel ?? null,
    stage: VISION_LEDGER_STAGES[stage],
    unitPriceMicros: VISION_PRICES_MICROS[stage],
  });
  if (!input.reuseAnalysis) lines.push(vision('analysis'));
  const attempts = renderEditAttempts(input);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lines.push({
      provider: input.imageEditProvider,
      sku: 'image_edit_attempt',
      modelId: input.imageEditModel ?? null,
      stage: 'rendering',
      unitPriceMicros: unitPriceFor('image_edit_attempt', { provider: input.imageEditProvider }),
    });
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) lines.push(vision('judge'));
  for (let attempt = 1; attempt <= attempts; attempt += 1) lines.push(vision('escalation'));
  for (let attempt = 1; attempt <= decoratingAttempts(input); attempt += 1) {
    lines.push(vision('localization'));
  }
  if (input.enhance === true) {
    lines.push({
      provider: input.imageEditProvider,
      sku: 'image_edit_attempt',
      modelId: input.imageEditModel ?? null,
      stage: ENHANCE_LEDGER_STAGE,
      unitPriceMicros: unitPriceFor('image_edit_attempt', { provider: input.imageEditProvider }),
    });
    lines.push(vision('enhancement'));
  }
  // A leg served by a fixture adapter is fixture work even when the job's other legs are live.
  return lines.map((line) => (line.provider === 'fixture' ? { ...line, isFixture: true } : line));
}

/** Total of a set of lines in micros (for ceiling checks before writing). */
export function linesTotalMicros(lines: readonly LedgerLine[]): number {
  return lines.reduce((total, line) => total + resolveLine(line).amountMicros, 0);
}

/** Per-SKU totals of a set of lines. */
export function linesBySku(lines: readonly LedgerLine[]): Map<LedgerSku, number> {
  const totals = new Map<LedgerSku, number>();
  for (const line of lines) {
    const { amountMicros } = resolveLine(line);
    totals.set(line.sku, (totals.get(line.sku) ?? 0) + amountMicros);
  }
  return totals;
}
