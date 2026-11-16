import { sql } from 'kysely';
import {
  JudgeResultSchema,
  TERMINAL_RENDER_JOB_STATES,
  isTerminalRenderJobState,
  type FailureCode,
  type JobEnhancementRecord,
  type JudgeResult,
  type NormalizedBox,
  type ProviderMode,
  type SceneAnalysis,
  type SceneType,
} from '@hailiday/core';
import { toJson, type DbOrTx } from '../../db/client.js';
import type { Project, RenderJob, SourceAsset, SourceEnhancement } from '../../db/schema.js';
import { newId, sha256Hex } from '../../ids/index.js';
import {
  ENHANCE_LEDGER_STAGE,
  VISION_PRICES_MICROS,
  charge,
  openReservations,
  release,
  unitPriceFor,
  usageCostMicros,
  type ReportedUsage,
} from '../../ledger/index.js';
import type { Logger } from '../../logger/index.js';
import { isEditable, type AssetPermission } from '../../policy/index.js';
import { isProviderError } from '../../providers/errors.js';
import type { EditOutcome, FixtureHint, VisionCallResult } from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import { compileEnhanceRequest, compilerProviderFor } from '../compile/compiler.js';
import type { PipelineDeps, PipelineOptions, ProviderLegs } from '../context.js';
import { encodeJpeg, encodePng } from '../imaging/raster.js';
import { registrationRecord } from '../imaging/registration.js';
import type { WorkingImage } from '../imaging/working.js';
import { JobAborted, JobFailure, unreadableAnswer, vendorAnswered } from '../render/errors.js';
import { findOpenReservation, settleCall } from '../render/ledger.js';
import { classifyJudge, deterministicJudgeResult } from '../render/quality.js';
import type { LoadedSource } from '../render/source.js';
import { loadHeldSet } from '../jobs/holds.js';
import { readJob, setJobSubStage } from '../render/transitions.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import {
  EnhancementUndecodable,
  enhanceJudgePreserve,
  enhanceProtectedBoxes,
  restoreAndCheckEnhancement,
} from './checks.js';
import {
  enhancementAwaitsJudge,
  enhancementDecided,
  findEnhancement,
  loadEnhancedWorking,
} from './store.js';

/**
 * The enhancement's edit was refused because another actor ended the job while it ran: the run
 * stops like any run whose job is no longer its own.
 */
export class EnhancementRunStopped extends Error {
  constructor() {
    super('render run stopped during the enhancement');
    this.name = 'EnhancementRunStopped';
  }
}

/**
 * The enhancement's edit was refused because the row is no longer this job's `pending` row while
 * the job still runs (the frame was dropped): nothing was sent and the job goes on with the frame.
 */
class EnhancementRowLost extends Error {
  constructor() {
    super('the enhancement row was removed before the edit was sent');
    this.name = 'EnhancementRowLost';
  }
}

/**
 * The enhance judge is called only with at least this much of the job's time left: what the look
 * still needs after the enhancement (the two edits of an evening look, about 47 s and 29 s, with
 * the repair guard open) and a judge answer (7 to 12 s). With less, the stored output waits for
 * the next job.
 */
export const JUDGE_MIN_TIME_LEFT_MS = 90_000;

/** What the enhancement step of a render job needs from the run. */
export interface EnhanceContext {
  deps: PipelineDeps;
  options: PipelineOptions;
  job: RenderJob;
  project: Project;
  source: SourceAsset;
  legs: ProviderLegs;
  /** Google's frame on the working grid. */
  frame: WorkingImage;
  loaded: LoadedSource;
  analysis: SceneAnalysis;
  sceneType: SceneType;
  attributionRegions: readonly NormalizedBox[];
  fixtureHint: FixtureHint | undefined;
  signal: AbortSignal;
  deadlineHit(): boolean;
  now(): Date;
  log: Logger;
  /** The permission last evaluated for the job. */
  permission(): AssetPermission;
  /** Evaluates and records the permission before a paid call (throws `JobFailure` when denied). */
  evaluate(stage: 'analyzing'): Promise<{ permission: AssetPermission }>;
  isPaused(provider: string): Promise<boolean>;
  visionProvider(): string;
  compilerFamily(): ReturnType<typeof compilerProviderFor>;
  modelSnapshot(): string;
  providerMode(): ProviderMode;
  withVisionRetries<T>(call: () => Promise<T>): Promise<T>;
}

/** The result of the enhancement step: the job's record and the working image to use, if any. */
export interface EnhanceResult {
  /** Null for a source that is not Street View (the job's column stays null). */
  record: JobEnhancementRecord | null;
  /** The accepted enhancement on the working grid; null when the job goes on with the frame. */
  working: WorkingImage | null;
}

/** Reasons of a `failed` row after which no job tries again. */
const FINAL_REASONS: ReadonlySet<string> = new Set([
  'moderation_blocked',
  'invalid_request',
  'frame_changed',
  'internal_error',
]);

/** An edit a run sent whose cost is not on the ledger yet. */
export interface SentEdit {
  /** The operation the editor reported before it sent; null when it reported none. */
  operationId: string | null;
  provider: string;
  isFixture: boolean;
  modelId: string | null;
}

/** The job a run's costs are written against. */
type RunJob = Pick<RenderJob, 'id' | 'ownerId' | 'projectId'>;

/** How a `pending` row ends without a decision. */
export interface CloseHow {
  reason: string;
  /**
   * An edit that was sent and has no ledger entry is charged once at the editor's list price,
   * unless this is false.
   */
  assumeCharged?: boolean;
  /** Settles the edit now with these units (and price): an answered edit that failed. */
  edit?: { units: number; unitPriceMicros?: number; modelId?: string | null };
  /**
   * The edit `job` sent for this row and has not recorded. When the row is gone, or is no longer
   * `job`'s `pending` row and none of its tries records the edit, the edit's cost (`edit`, else
   * one unit at the list price unless `assumeCharged` is false) is written against `job`, and the
   * row is left as it is.
   */
  sent?: { job: RunJob; edit: SentEdit };
  /** Clears the stored raw output and the judge's answer on it, so the next try sends an edit. */
  dropOutput?: boolean;
  /** Further columns written with the close. */
  patch?: {
    checks?: Record<string, unknown>;
    registration?: Record<string, unknown> | null;
    providerUsage?: Record<string, unknown> | null;
    editCompletedAt?: Date;
    editLatencyMs?: number;
  };
}

/**
 * Records the cost of a row's edit on the ledger: settles the open enhancement reservation of the
 * row's job, or writes a direct charge (attributed to the job when it still exists, and to the
 * source's owner and project). Returns the ledger row ID.
 */
async function recordEditCost(
  db: DbOrTx,
  deps: Pick<PipelineDeps, 'clock'>,
  row: SourceEnhancement,
  edit: { units: number; unitPriceMicros?: number; modelId?: string | null },
): Promise<string> {
  const source = await db
    .selectFrom('sourceAssets')
    .select(['ownerId', 'projectId'])
    .where('id', '=', row.sourceAssetId)
    .executeTakeFirst();
  const job = row.jobId ? await readJob(db, row.jobId) : null;
  const unitPriceMicros =
    edit.unitPriceMicros ??
    unitPriceFor('image_edit_attempt', {
      provider: compilerProviderFor(row.provider ?? 'fixture'),
    });
  const isFixture = row.providerMode !== 'live';
  if (job) {
    const reservation = await findOpenReservation(db, job.id, {
      sku: 'image_edit_attempt',
      stage: ENHANCE_LEDGER_STAGE,
    });
    return settleCall(db, {
      reservation,
      jobId: job.id,
      ownerId: source?.ownerId ?? job.ownerId,
      projectId: source?.projectId ?? job.projectId,
      provider: row.provider ?? 'fixture',
      sku: 'image_edit_attempt',
      stage: ENHANCE_LEDGER_STAGE,
      units: edit.units,
      unitPriceMicros,
      modelId: edit.modelId ?? row.modelSnapshot,
      isFixture,
      clock: deps.clock,
    });
  }
  const entry = await charge(
    db,
    {
      ownerId: source?.ownerId ?? null,
      jobId: null,
      projectId: source?.projectId ?? null,
      isFixture,
    },
    {
      provider: row.provider ?? 'fixture',
      sku: 'image_edit_attempt',
      stage: ENHANCE_LEDGER_STAGE,
      units: edit.units,
      unitPriceMicros,
      modelId: edit.modelId ?? row.modelSnapshot,
    },
    deps.clock,
  );
  return entry.id;
}

/**
 * Records the cost of one call of a run against its job: settles the job's open enhancement
 * reservation of the SKU, or writes a direct charge. When the job row is gone (its project was
 * deleted), the charge carries no job ID, and the owner and the project only while their rows
 * exist. Returns the ledger row ID.
 */
async function recordRunCost(
  db: DbOrTx,
  deps: Pick<PipelineDeps, 'clock'>,
  job: RunJob,
  line: {
    sku: 'image_edit_attempt' | 'vision_call';
    provider: string;
    units: number;
    unitPriceMicros: number;
    modelId: string | null;
    isFixture: boolean;
  },
): Promise<string> {
  const live = await readJob(db, job.id);
  if (live) {
    const reservation = await findOpenReservation(db, live.id, {
      sku: line.sku,
      stage: ENHANCE_LEDGER_STAGE,
    });
    return settleCall(db, {
      reservation,
      jobId: live.id,
      ownerId: live.ownerId,
      projectId: live.projectId,
      provider: line.provider,
      sku: line.sku,
      stage: ENHANCE_LEDGER_STAGE,
      units: line.units,
      unitPriceMicros: line.unitPriceMicros,
      modelId: line.modelId,
      isFixture: line.isFixture,
      clock: deps.clock,
    });
  }
  const owner = await db
    .selectFrom('owners')
    .select('id')
    .where('id', '=', job.ownerId)
    .executeTakeFirst();
  const project = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', job.projectId)
    .executeTakeFirst();
  const entry = await charge(
    db,
    {
      ownerId: owner?.id ?? null,
      jobId: null,
      projectId: project?.id ?? null,
      isFixture: line.isFixture,
    },
    {
      provider: line.provider,
      sku: line.sku,
      stage: ENHANCE_LEDGER_STAGE,
      units: line.units,
      unitPriceMicros: line.unitPriceMicros,
      modelId: line.modelId,
    },
    deps.clock,
  );
  return entry.id;
}

/**
 * Whether a row records the cost of the edit `jobId` sent as `operationId`, on its current try or
 * on an earlier one (`checks.previous`): another job or the reconciliation closed that try and
 * charged the edit.
 */
function recordsEdit(row: SourceEnhancement, jobId: string, operationId: string | null): boolean {
  if (operationId === null) return false;
  const tries: unknown[] = [
    {
      jobId: row.jobId,
      providerOperationId: row.providerOperationId,
      editLedgerEntryId: row.editLedgerEntryId,
    },
    ...(previousOf(row).previous ?? []),
  ];
  return tries.some((entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    const tried = entry as Record<string, unknown>;
    return (
      tried.jobId === jobId &&
      tried.providerOperationId === operationId &&
      typeof tried.editLedgerEntryId === 'string'
    );
  });
}

/**
 * Records the cost of an edit a run sent for a row that is gone (`row` undefined) or is no longer
 * the run's `pending` row, unless the row records it already. The row is not changed.
 */
async function recordLostEdit(
  db: DbOrTx,
  deps: Pick<PipelineDeps, 'clock'>,
  row: SourceEnhancement | undefined,
  sent: NonNullable<CloseHow['sent']>,
  edit: { units: number; unitPriceMicros?: number; modelId?: string | null },
): Promise<void> {
  if (row && recordsEdit(row, sent.job.id, sent.edit.operationId)) return;
  await recordRunCost(db, deps, sent.job, {
    sku: 'image_edit_attempt',
    provider: sent.edit.provider,
    units: edit.units,
    unitPriceMicros:
      edit.unitPriceMicros ??
      unitPriceFor('image_edit_attempt', { provider: compilerProviderFor(sent.edit.provider) }),
    modelId: edit.modelId ?? sent.edit.modelId,
    isFixture: sent.edit.isFixture,
  });
}

/**
 * Ends a `pending` enhancement row without a decision, in one transaction and only while the row
 * is still `pending` for the same job: `failed` with the reason, retryable unless the reason is
 * final or the row has used its edits (`maxEdits`) with no stored output awaiting the judge. An edit that was sent and has no ledger
 * entry is charged once at the editor's list price (unless `assumeCharged` is false), because
 * neither live editor can say later whether it billed; `edit` settles an answered edit instead.
 * With `sent`, the job's edit is recorded even when the row is gone or no longer the job's.
 * Returns the closed row, or null when the row was no longer this job's `pending` row.
 */
export async function closeEnhancement(
  deps: Pick<PipelineDeps, 'db' | 'clock'>,
  row: Pick<SourceEnhancement, 'id' | 'jobId'>,
  how: CloseHow,
): Promise<SourceEnhancement | null> {
  return deps.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('sourceEnhancements')
      .selectAll()
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .where(sql<boolean>`job_id is not distinct from ${row.jobId}::uuid`)
      .forUpdate()
      .executeTakeFirst();
    if (!current) {
      const units = how.edit?.units ?? (how.assumeCharged === false ? null : 1);
      if (how.sent && units !== null) {
        const found = await trx
          .selectFrom('sourceEnhancements')
          .selectAll()
          .where('id', '=', row.id)
          .forUpdate()
          .executeTakeFirst();
        await recordLostEdit(trx, deps, found, how.sent, { ...how.edit, units });
      }
      return null;
    }
    let editLedgerEntryId = current.editLedgerEntryId;
    if (!editLedgerEntryId && how.edit) {
      editLedgerEntryId = await recordEditCost(trx, deps, current, how.edit);
    } else if (
      !editLedgerEntryId &&
      current.providerOperationId !== null &&
      how.assumeCharged !== false
    ) {
      editLedgerEntryId = await recordEditCost(trx, deps, current, { units: 1 });
    }
    // A row with edits left stays retryable, and so does one whose stored output still awaits
    // the judge (the next job judges it without sending an edit).
    const awaitsJudge = !how.dropOutput && enhancementAwaitsJudge(current);
    const retryable =
      !FINAL_REASONS.has(how.reason) &&
      (current.editCount < PIPELINE_DEFAULTS.enhance.maxEdits || awaitsJudge);
    const patch = how.patch ?? {};
    return (
      (await trx
        .updateTable('sourceEnhancements')
        .set({
          status: 'failed',
          reason: how.reason,
          retryable,
          editLedgerEntryId,
          ...(how.dropOutput
            ? {
                rawObjectKey: null,
                judge: null,
                judgeUsage: null,
                judgeLedgerEntryId: null,
                registration: null,
              }
            : {}),
          ...(patch.checks ? { checks: toJson(patch.checks) } : {}),
          ...(patch.registration !== undefined
            ? { registration: patch.registration ? toJson(patch.registration) : null }
            : {}),
          ...(patch.providerUsage !== undefined
            ? { providerUsage: patch.providerUsage ? toJson(patch.providerUsage) : null }
            : {}),
          ...(patch.editCompletedAt ? { editCompletedAt: patch.editCompletedAt } : {}),
          ...(patch.editLatencyMs !== undefined ? { editLatencyMs: patch.editLatencyMs } : {}),
        })
        .where('id', '=', current.id)
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  });
}

/** A vision call's reported token usage, for settlement from usage. */
function visionUsage(call: Pick<VisionCallResult<unknown>, 'usage'>): ReportedUsage {
  const { inputTokens, outputTokens, cacheReadInputTokens } = call.usage;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
  };
}

const record = (
  outcome: JobEnhancementRecord['outcome'],
  enhancementId: string | null,
  reason: string | null,
): JobEnhancementRecord => ({ outcome, enhancementId, reason });

/** Releases the job's open reservations of the enhancement (stage `enhancing`). */
async function releaseEnhancementReservations(ctx: EnhanceContext): Promise<void> {
  const open = await openReservations(ctx.deps.db, ctx.job.id);
  for (const row of open) {
    if (row.stage === ENHANCE_LEDGER_STAGE) await release(ctx.deps.db, row.id, ctx.deps.clock);
  }
}

/** What a run holds while it enhances: its row, and an edit it sent whose cost is not recorded. */
interface RunState {
  row: SourceEnhancement | null;
  sent: SentEdit | null;
}

/**
 * Closes the run's row while it is this job's `pending` row (the fence is always this job's ID).
 * An edit the run sent and has not recorded goes with it, so its cost is written even when the
 * row is gone or was taken over by another job.
 */
async function closeOwn(
  ctx: EnhanceContext,
  state: RunState,
  rowId: string,
  how: CloseHow,
): Promise<SourceEnhancement | null> {
  const closed = await closeEnhancement(
    ctx.deps,
    { id: rowId, jobId: ctx.job.id },
    { ...how, ...(state.sent ? { sent: { job: ctx.job, edit: state.sent } } : {}) },
  );
  state.sent = null;
  return closed;
}

/**
 * The job's record when its row was removed (the frame was dropped or the project deleted) or was
 * taken over by another job after this job ended: the job goes on with the frame and the row is
 * left as it is.
 */
async function lostRow(ctx: EnhanceContext, rowId: string): Promise<EnhanceResult> {
  const still = await ctx.deps.db
    .selectFrom('sourceEnhancements')
    .select('id')
    .where('id', '=', rowId)
    .executeTakeFirst();
  return {
    record: record('failed', rowId, still ? 'abandoned' : 'frame_changed'),
    working: null,
  };
}

/** Whether the row is still this job's `pending` row. */
async function holdsRow(ctx: EnhanceContext, rowId: string): Promise<boolean> {
  const row = await ctx.deps.db
    .selectFrom('sourceEnhancements')
    .select('id')
    .where('id', '=', rowId)
    .where('status', '=', 'pending')
    .where('jobId', '=', ctx.job.id)
    .executeTakeFirst();
  return row !== undefined;
}

/** The job's time left before its duration limit. */
function timeLeftMs(ctx: EnhanceContext): number {
  const now = ctx.now();
  return ctx.options.maxJobDurationMs - (now.getTime() - (ctx.job.startedAt ?? now).getTime());
}

/**
 * The Street View enhancement of a render job (render spec, enhancing), run in `analyzing` after
 * the scene analysis and the Street View refusals. The stored frame is sent once to the image
 * editor with the fixed enhance instruction; the answer is registered to the frame, its protected
 * pixels and attribution are put back, the deterministic checks and one judge call in enhance mode
 * decide it, and an accepted picture is stored and becomes the job's working image. The result is
 * recorded once per (source, stored frame, compiler version) and reused by every later job.
 *
 * Every write of the run to its row is fenced on the row being this job's `pending` row. When the
 * row is gone or another job holds it, the run leaves it as it is, records the cost of what it
 * paid for against its own job, and goes on with the frame.
 *
 * The step never fails a look: whatever goes wrong (a refusal, a provider error, a rejection, an
 * internal error), the job goes on with the frame and the job's record says why. Only an abort of
 * the job (`JobAborted`) or the end of the job by another actor (`EnhancementRunStopped`)
 * propagates, after the row is closed. The job's enhancement reservations still open at the end
 * are released.
 */
export async function resolveEnhancement(ctx: EnhanceContext): Promise<EnhanceResult> {
  if (ctx.source.kind !== 'street_view') return { record: null, working: null };
  const state: RunState = { row: null, sent: null };
  try {
    return await runEnhancement(ctx, state);
  } catch (error) {
    if (error instanceof EnhancementRunStopped) throw error;
    const mine = state.row;
    if (error instanceof JobAborted || ctx.signal.aborted) {
      if (mine) {
        await closeOwn(ctx, state, mine.id, {
          reason: ctx.deadlineHit() ? 'deadline' : 'aborted',
        }).catch(() => null);
      }
      throw new JobAborted(ctx.deadlineHit() ? 'deadline' : 'signal');
    }
    ctx.log.error({ err: error }, 'street view enhancement failed with an internal error');
    if (mine) {
      await closeOwn(ctx, state, mine.id, { reason: 'internal_error' }).catch(
        (closeError: unknown) => {
          ctx.log.error({ err: closeError }, 'could not record the enhancement failure');
        },
      );
    }
    return { record: record('failed', mine?.id ?? null, 'internal_error'), working: null };
  } finally {
    await releaseEnhancementReservations(ctx).catch((error: unknown) => {
      ctx.log.error({ err: error }, 'could not release the enhancement reservations');
    });
  }
}

async function runEnhancement(ctx: EnhanceContext, state: RunState): Promise<EnhanceResult> {
  const { deps, job, frame } = ctx;
  const db = deps.db;
  const skipped = (reason: string): EnhanceResult => ({
    record: record('skipped', null, reason),
    working: null,
  });

  // 1. Eligibility: the switch, the stored frame the job works on, and the permission.
  if (!deps.config.streetView.enhance) return skipped('disabled');
  const source = await db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', ctx.source.id)
    .executeTakeFirst();
  if (
    !source ||
    ctx.loaded.streetViewMode !== 'persist' ||
    !source.objectKey ||
    source.checksumSha256 !== ctx.loaded.checksum
  ) {
    return skipped('not_stored');
  }
  const permission = ctx.permission();
  if (!(permission.store && isEditable(permission))) return skipped('policy');

  const key = {
    sourceAssetId: source.id,
    frameChecksum: ctx.loaded.checksum,
    compilerVersion: job.compilerVersion,
  };

  // 2. The row: reused, decided, claimed, waited for or inserted.
  let row: SourceEnhancement | null = null;
  for (let round = 0; round < 3 && !row; round += 1) {
    const found = await findEnhancement(db, key);
    if (!found) {
      const free = freeRejection(ctx);
      const now = ctx.now();
      const inserted = await db
        .insertInto('sourceEnhancements')
        .values({
          id: newId(),
          sourceAssetId: source.id,
          frameChecksumSha256: ctx.loaded.checksum,
          compilerVersion: job.compilerVersion,
          workingWidth: frame.width,
          workingHeight: frame.height,
          status: free ? 'rejected' : 'pending',
          reason: free?.reason ?? null,
          jobId: job.id,
          editCount: 0,
          ...(free ? { checks: toJson(free.checks), decidedAt: now } : {}),
        })
        .onConflict((oc) =>
          oc.columns(['sourceAssetId', 'frameChecksumSha256', 'compilerVersion']).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      if (!inserted) continue;
      if (free) return { record: record('rejected', inserted.id, free.reason), working: null };
      row = inserted;
      break;
    }
    if (found.status === 'accepted') {
      const working = await loadEnhancedWorking(deps, { row: found, frame });
      if (working) return { record: record('reused', found.id, null), working };
      // The picture is gone or damaged: the row may be made again.
      if (found.objectKey) await deps.storage.delete('private', found.objectKey);
      await db
        .updateTable('sourceEnhancements')
        .set({
          status: 'failed',
          reason: 'object_missing',
          retryable: true,
          objectKey: null,
          enhancedChecksumSha256: null,
          byteLength: null,
          decidedAt: null,
        })
        .where('id', '=', found.id)
        .where('status', '=', 'accepted')
        .execute();
      continue;
    }
    if (enhancementDecided(found)) {
      return {
        record: record(found.status === 'rejected' ? 'rejected' : 'failed', found.id, found.reason),
        working: null,
      };
    }
    if (found.status === 'failed') {
      row = await claim(ctx, found);
      continue;
    }
    // `pending`.
    if (found.jobId === job.id) {
      row = found;
      break;
    }
    const other = found.jobId ? await readJob(db, found.jobId) : null;
    if (!other || isTerminalRenderJobState(other.state)) {
      // Another job's row, closed with that job's ID; a sent edit of it is charged to that job.
      await closeEnhancement(deps, found, { reason: 'abandoned' });
      continue;
    }
    // The row of another job that is still active. A source belongs to one project and a project
    // has at most one active job (render_jobs_one_active_per_project_idx), so this is not
    // expected; should it happen, the job waits a little for the row and otherwise goes on with
    // the frame (`busy`).
    if (!(await waitWhilePending(ctx, found.id))) return skipped('busy');
  }
  if (!row) return skipped('busy');
  state.row = row;
  const held = row;

  // 4. Resume from a stored output, or the guards before a new edit.
  let rawBytes: Uint8Array | null = null;
  if (row.rawObjectKey) {
    rawBytes = (await deps.storage.get('private', row.rawObjectKey))?.body ?? null;
  }
  if (rawBytes) {
    await setJobSubStage(db, { jobId: job.id, state: 'analyzing', subStage: 'enhancing' });
  } else {
    const failed = (reason: string): EnhanceResult => ({
      record: record('failed', held.id, reason),
      working: null,
    });
    if (timeLeftMs(ctx) < PIPELINE_DEFAULTS.enhance.minJobTimeLeftMs) {
      await closeOwn(ctx, state, row.id, { reason: 'no_time' });
      return failed('no_time');
    }
    if (await ctx.isPaused(ctx.compilerFamily())) {
      await closeOwn(ctx, state, row.id, { reason: 'paused' });
      return failed('paused');
    }
    if (!(await allowed(ctx, (p) => p.store && isEditable(p)))) {
      await closeOwn(ctx, state, row.id, { reason: 'policy' });
      return failed('policy');
    }
    if (row.editCount >= PIPELINE_DEFAULTS.enhance.maxEdits) {
      // Both edits were sent and their output is gone: nothing more may be sent for this frame.
      await closeOwn(ctx, state, row.id, { reason: 'object_missing' });
      return failed('object_missing');
    }
    const sent = await sendEdit(ctx, state, row);
    if ('result' in sent) return sent.result;
    rawBytes = sent.rawBytes;
    row = sent.row;
    state.row = row;
  }
  ctxCheckAbort(ctx);

  // 6. Registration, protected pixels, attribution and the deterministic checks.
  let check: Awaited<ReturnType<typeof restoreAndCheckEnhancement>>;
  try {
    check = await restoreAndCheckEnhancement({
      frame,
      rawBytes,
      analysis: ctx.analysis,
      attributionRegions: ctx.attributionRegions,
    });
  } catch (error) {
    if (!(error instanceof EnhancementUndecodable)) throw error;
    ctxCheckAbort(ctx);
    // The output goes, so the next job sends the remaining edit instead of resuming from it.
    const closed = await closeOwn(ctx, state, row.id, { reason: 'undecodable', dropOutput: true });
    if (closed && row.rawObjectKey) await deps.storage.delete('private', row.rawObjectKey);
    return { record: record('failed', row.id, 'undecodable'), working: null };
  }
  ctxCheckAbort(ctx);
  const registration = registrationRecord(check.alignment);
  const checks = { ...check.checks, ...previousOf(row) };
  if (check.codes.length > 0 || !check.candidate) {
    const decided = await decide(ctx, row, {
      status: 'rejected',
      reason: 'qa',
      codes: check.codes,
      registration,
      checks,
    });
    if (!decided) return lostRow(ctx, row.id);
    return { record: record('rejected', row.id, 'qa'), working: null };
  }
  const candidate = check.candidate;

  // 7. The judge, in enhance mode (a document already on the row is reused).
  const recorded = JudgeResultSchema.safeParse(row.judge);
  let judge: JudgeResult;
  let refused = false;
  if (recorded.success) {
    judge = recorded.data;
    refused = judge.judgeModel === 'refusal';
  } else {
    if (timeLeftMs(ctx) < JUDGE_MIN_TIME_LEFT_MS) {
      // Too little time for the judge and the look: the stored output waits for the next job.
      await closeOwn(ctx, state, row.id, { reason: 'no_time', patch: { checks, registration } });
      return { record: record('failed', row.id, 'no_time'), working: null };
    }
    if (!(await allowed(ctx, (p) => p.aiProcess))) {
      await closeOwn(ctx, state, row.id, { reason: 'policy', patch: { checks, registration } });
      return { record: record('failed', row.id, 'policy'), working: null };
    }
    if (await ctx.isPaused(ctx.visionProvider())) {
      await closeOwn(ctx, state, row.id, { reason: 'paused', patch: { checks, registration } });
      return { record: record('failed', row.id, 'paused'), working: null };
    }
    const enhancementId = row.id;
    let call: VisionCallResult<JudgeResult> | null = null;
    try {
      const candidateJpeg = await encodeJpeg(candidate, { quality: 92 });
      call = await ctx.withVisionRetries(() =>
        ctx.legs.vision.judgeEnhancement(
          {
            enhancementId,
            original: { bytes: frame.png, width: frame.width, height: frame.height },
            candidate: { bytes: candidateJpeg, width: candidate.width, height: candidate.height },
            sceneType: ctx.sceneType,
            preserve: enhanceJudgePreserve(ctx.analysis, ctx.attributionRegions),
            ...(ctx.fixtureHint ? { fixture: ctx.fixtureHint } : {}),
          },
          { signal: ctx.signal, timeoutMs: ctx.options.judgeTimeoutMs },
        ),
      );
    } catch (error) {
      ctxCheckAbort(ctx);
      if (!(isProviderError(error) && error.kind === 'moderation_blocked')) {
        await closeOwn(ctx, state, row.id, {
          reason: 'judge_unavailable',
          patch: { checks, registration },
        });
        return { record: record('failed', row.id, 'judge_unavailable'), working: null };
      }
      // A safety refusal of the candidate counts as `unsafe_or_offensive`.
      refused = true;
    }
    judge = call
      ? call.result
      : {
          ...deterministicJudgeResult(enhancementId, ['unsafe_or_offensive']),
          judgeModel: 'refusal',
        };
    const judged = await recordJudge(ctx, row, judge, call);
    if (!judged) return lostRow(ctx, row.id);
    row = judged;
  }
  ctxCheckAbort(ctx);
  const classification = refused
    ? { critical: ['unsafe_or_offensive' as const], uncertain: [], major: [] }
    : classifyJudge(judge, ctx.options.judgeThresholds);
  const judgeCodes: FailureCode[] = [
    ...new Set<FailureCode>([
      ...classification.critical,
      ...classification.uncertain,
      ...classification.major,
    ]),
  ];
  if (judgeCodes.length > 0) {
    const decided = await decide(ctx, row, {
      status: 'rejected',
      reason: 'qa',
      codes: judgeCodes,
      registration,
      checks,
    });
    if (!decided) return lostRow(ctx, row.id);
    return { record: record('rejected', row.id, 'qa'), working: null };
  }

  // 8. Accept: the picture is stored, then the row accepted while the frame is still stored.
  // The picture's key is the row's, so nothing is written once another job holds the row.
  if (!(await holdsRow(ctx, row.id))) return lostRow(ctx, row.id);
  const png = await encodePng(candidate);
  const checksum = sha256Hex(png);
  const objectKey = keys.enhanced(source.ownerId, source.id, row.id);
  await deps.storage.put({
    bucket: 'private',
    key: objectKey,
    body: png,
    contentType: 'image/png',
    provenance: { sourceKind: 'street_view', permission: ctx.permission(), derivative: false },
  });
  const pendingRow = row;
  const accepted = await db
    .transaction()
    .execute(async (trx): Promise<{ row: SourceEnhancement } | 'frame_changed' | 'lost'> => {
      const current = await trx
        .selectFrom('sourceAssets')
        .select(['state', 'deletedAt', 'objectKey', 'checksumSha256'])
        .where('id', '=', source.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !current ||
        current.deletedAt ||
        current.state !== 'ready' ||
        !current.objectKey ||
        current.checksumSha256 !== ctx.loaded.checksum
      ) {
        return 'frame_changed';
      }
      const updated = await trx
        .updateTable('sourceEnhancements')
        .set({
          status: 'accepted',
          reason: null,
          retryable: false,
          failureCodes: [],
          objectKey,
          enhancedChecksumSha256: checksum,
          byteLength: png.length,
          decidedAt: ctx.now(),
          registration: toJson(registration),
          checks: toJson(checks),
        })
        .where('id', '=', pendingRow.id)
        .where('status', '=', 'pending')
        .where('jobId', '=', job.id)
        .returningAll()
        .executeTakeFirst();
      return updated ? { row: updated } : 'lost';
    });
  if (typeof accepted === 'string') {
    // The picture goes, unless another job's accepted row names it.
    const holder = await db
      .selectFrom('sourceEnhancements')
      .select(['status', 'objectKey'])
      .where('id', '=', row.id)
      .executeTakeFirst();
    if (!(holder?.status === 'accepted' && holder.objectKey === objectKey)) {
      await deps.storage.delete('private', objectKey);
    }
    if (accepted === 'lost') return lostRow(ctx, row.id);
    await closeOwn(ctx, state, row.id, {
      reason: 'frame_changed',
      patch: { checks, registration },
    });
    return { record: record('failed', row.id, 'frame_changed'), working: null };
  }
  await dropSuperseded(ctx, source);
  return {
    record: record('made', accepted.row.id, null),
    working: { ...frame, raster: candidate, png, checksum },
  };
}

/** Throws `JobAborted` when the job's abort signal fired. */
function ctxCheckAbort(ctx: EnhanceContext): void {
  if (ctx.signal.aborted) throw new JobAborted(ctx.deadlineHit() ? 'deadline' : 'signal');
}

/**
 * Whether the permission evaluated now (and recorded) allows `use`. A denied evaluation
 * (`JobFailure`) reads as not allowed: the job fails at its own next evaluation.
 */
async function allowed(
  ctx: EnhanceContext,
  use: (permission: AssetPermission) => boolean,
): Promise<boolean> {
  try {
    return use((await ctx.evaluate('analyzing')).permission);
  } catch (error) {
    if (error instanceof JobFailure) return false;
    throw error;
  }
}

/**
 * The rejections decided before any edit, which cost nothing: a photo that is not in daylight
 * (the instruction asks for daylight), or protected boxes covering more than
 * `maxProtectedCoverage` of the frame.
 */
function freeRejection(
  ctx: EnhanceContext,
): { reason: 'not_daylight' | 'protected_coverage'; checks: Record<string, unknown> } | null {
  if (!ctx.analysis.lighting.isDaylight) {
    return {
      reason: 'not_daylight',
      checks: { lighting: { timeOfDay: ctx.analysis.lighting.timeOfDay } },
    };
  }
  const boxes = enhanceProtectedBoxes({
    analysis: ctx.analysis,
    attributionRegions: ctx.attributionRegions,
    width: ctx.frame.width,
    height: ctx.frame.height,
  });
  if (boxes.coverage > PIPELINE_DEFAULTS.enhance.maxProtectedCoverage) {
    return {
      reason: 'protected_coverage',
      checks: { protected: { boxes: boxes.paste, coverage: boxes.coverage } },
    };
  }
  return null;
}

/** The earlier tries of a row kept in its checks (`checks.previous`). */
function previousOf(row: SourceEnhancement): { previous?: unknown[] } {
  const previous = (row.checks as { previous?: unknown } | null)?.previous;
  return Array.isArray(previous) ? { previous } : {};
}

/**
 * Claims an undecided `failed` row for this job (compare-and-set on its status and edit count):
 * `pending`, this job's, without a reason. The earlier try's facts move to `checks.previous`,
 * and its operation, send and completion times and edit ledger entry are cleared, so they are
 * never mistaken for this job's. A stored raw output is kept while its object exists (it is
 * resumed without a second edit); otherwise the output's judge goes with it. Null when another
 * job claimed it first.
 */
async function claim(
  ctx: EnhanceContext,
  row: SourceEnhancement,
): Promise<SourceEnhancement | null> {
  const { deps } = ctx;
  const rawKept =
    row.rawObjectKey !== null && (await deps.storage.head('private', row.rawObjectKey)) !== null;
  const previous = [
    ...(previousOf(row).previous ?? []),
    {
      reason: row.reason,
      jobId: row.jobId,
      providerOperationId: row.providerOperationId,
      editLedgerEntryId: row.editLedgerEntryId,
      judgeLedgerEntryId: row.judgeLedgerEntryId,
    },
  ];
  return (
    (await deps.db
      .updateTable('sourceEnhancements')
      .set({
        status: 'pending',
        jobId: ctx.job.id,
        reason: null,
        retryable: false,
        failureCodes: [],
        providerOperationId: null,
        editSentAt: null,
        editCompletedAt: null,
        editLedgerEntryId: null,
        checks: toJson({ previous }),
        ...(rawKept
          ? {}
          : {
              rawObjectKey: null,
              judge: null,
              judgeUsage: null,
              judgeLedgerEntryId: null,
              registration: null,
            }),
      })
      .where('id', '=', row.id)
      .where('status', '=', 'failed')
      .where('editCount', '=', row.editCount)
      .returningAll()
      .executeTakeFirst()) ?? null
  );
}

/**
 * Waits up to `pendingWaitMs` for another job's `pending` row to leave `pending`. True when it
 * did (or is gone); false when it is still pending, or the job was aborted meanwhile.
 */
async function waitWhilePending(ctx: EnhanceContext, rowId: string): Promise<boolean> {
  const { pendingWaitMs, pendingPollMs } = PIPELINE_DEFAULTS.enhance;
  const until = Date.now() + pendingWaitMs;
  while (Date.now() < until) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pendingPollMs);
      ctx.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    ctxCheckAbort(ctx);
    const current = await ctx.deps.db
      .selectFrom('sourceEnhancements')
      .select('status')
      .where('id', '=', rowId)
      .executeTakeFirst();
    if (!current || current.status !== 'pending') return true;
  }
  return false;
}

/**
 * Decides a row this job holds (`rejected` with its codes, checks and registration). The raw
 * output stays under the job's attempts prefix for the usual retention. False when the row is no
 * longer this job's `pending` row (nothing is written).
 */
async function decide(
  ctx: EnhanceContext,
  row: SourceEnhancement,
  decision: {
    status: 'rejected';
    reason: string;
    codes: readonly FailureCode[];
    registration: Record<string, unknown>;
    checks: Record<string, unknown>;
  },
): Promise<boolean> {
  const updated = await ctx.deps.db
    .updateTable('sourceEnhancements')
    .set({
      status: decision.status,
      reason: decision.reason,
      retryable: false,
      failureCodes: [...new Set(decision.codes)],
      registration: toJson(decision.registration),
      checks: toJson(decision.checks),
      decidedAt: ctx.now(),
    })
    .where('id', '=', row.id)
    .where('status', '=', 'pending')
    .where('jobId', '=', ctx.job.id)
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0;
}

/**
 * Records the judge's answer on the row and settles the call in one transaction (the job's
 * enhancement judge reservation, else a direct charge), so a redelivery reuses the document and
 * never pays for it again. A refusal is recorded without a charge. The answer is written only on
 * this job's `pending` row; otherwise the call is still paid for against the job, the row is left
 * as it is and the result is null.
 */
async function recordJudge(
  ctx: EnhanceContext,
  row: SourceEnhancement,
  judge: JudgeResult,
  call: VisionCallResult<JudgeResult> | null,
): Promise<SourceEnhancement | null> {
  const { deps, job } = ctx;
  return deps.db.transaction().execute(async (trx) => {
    let judgeLedgerEntryId: string | null = null;
    if (call) {
      judgeLedgerEntryId = await recordRunCost(trx, deps, job, {
        sku: 'vision_call',
        provider: ctx.visionProvider(),
        units: 1,
        unitPriceMicros:
          usageCostMicros(call.model, visionUsage(call)) ?? VISION_PRICES_MICROS.enhancement,
        modelId: call.model,
        isFixture: call.providerMode === 'fixture',
      });
    }
    return (
      (await trx
        .updateTable('sourceEnhancements')
        .set({
          judge: toJson(judge),
          judgeUsage: call ? toJson(call.usage) : null,
          judgeLedgerEntryId,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .where('jobId', '=', job.id)
        .returningAll()
        .executeTakeFirst()) ?? null
    );
  });
}

/**
 * Sends the enhance edit for a row this job holds (render spec, enhancing, step 5) and records
 * its outcome: a completed answer is stored under the job's attempts prefix and settled from its
 * usage; any other answer closes the row (flow of provider failures) and returns the job's
 * record. An abort closes the row and throws `JobAborted`; an edit refused because another actor
 * ended the job closes it and throws `EnhancementRunStopped`. When the row is gone or another job
 * holds it, the edit's cost is still written against this job and the row is left as it is.
 */
async function sendEdit(
  ctx: EnhanceContext,
  state: RunState,
  pending: SourceEnhancement,
): Promise<{ rawBytes: Uint8Array; row: SourceEnhancement } | { result: EnhanceResult }> {
  const { deps, job, frame } = ctx;
  const db = deps.db;
  const editor = ctx.legs.imageEditor;
  const failed = (reason: string): { result: EnhanceResult } => ({
    result: { record: record('failed', pending.id, reason), working: null },
  });
  const rowId = pending.id;
  let outcome: EditOutcome;
  let sent = pending.providerOperationId !== null;
  const started = ctx.now().getTime();
  const timeoutMs = PIPELINE_DEFAULTS.enhance.editTimeoutMs;
  let request = null as ReturnType<typeof compileEnhanceRequest> | null;

  if (pending.providerOperationId && !pending.editLedgerEntryId) {
    // Sent by an earlier delivery of this job: its answer, if the provider can still give it.
    state.sent = {
      operationId: pending.providerOperationId,
      provider: pending.provider ?? editor.providerId,
      isFixture: pending.providerMode !== 'live',
      modelId: pending.modelSnapshot,
    };
    outcome = await editor
      .getOperation(pending.providerOperationId)
      .catch((): EditOutcome => ({ status: 'failed', kind: 'provider_error', retryable: true }));
    if (outcome.status !== 'completed') {
      await closeOwn(ctx, state, rowId, { reason: 'unknown_outcome' });
      return failed('unknown_outcome');
    }
  } else {
    await setJobSubStage(db, { jobId: job.id, state: 'analyzing', subStage: 'enhancing' });
    const compiled = compileEnhanceRequest({
      provider: ctx.compilerFamily(),
      settings: deps.config.imageEdit,
      modelSnapshot: ctx.modelSnapshot(),
      image: { width: frame.width, height: frame.height, checksum: frame.checksum },
      compilerVersion: job.compilerVersion,
    });
    request = compiled;
    await db
      .updateTable('sourceEnhancements')
      .set({
        provider: editor.providerId,
        providerMode: ctx.providerMode(),
        modelSnapshot: compiled.modelSnapshot,
        settingsHash: compiled.settingsHash,
        request: toJson(compiled),
      })
      .where('id', '=', rowId)
      .where('status', '=', 'pending')
      .where('jobId', '=', job.id)
      .execute();
    // The editor reports the operation before it sends. Only a row still `pending` for this job,
    // on a job that is still running, records it; otherwise nothing is sent.
    const onOperation = async (operationId: string) => {
      const updated = await db
        .updateTable('sourceEnhancements')
        .set({
          providerOperationId: operationId,
          editSentAt: ctx.now(),
          editCount: sql<number>`edit_count + 1`,
        })
        .where('id', '=', rowId)
        .where('status', '=', 'pending')
        .where('jobId', '=', job.id)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('renderJobs')
              .select('renderJobs.id')
              .where('renderJobs.id', '=', job.id)
              .where('renderJobs.state', 'not in', [...TERMINAL_RENDER_JOB_STATES]),
          ),
        )
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        const current = await readJob(db, job.id);
        if (!current || isTerminalRenderJobState(current.state)) throw new EnhancementRunStopped();
        throw new EnhancementRowLost();
      }
      sent = true;
      state.sent = {
        operationId,
        provider: editor.providerId,
        isFixture: ctx.providerMode() !== 'live',
        modelId: compiled.modelSnapshot,
      };
    };
    try {
      outcome = await editor.edit(
        compiled,
        { image: frame.png },
        {
          attemptId: rowId,
          timeoutMs,
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
          onOperation,
        },
      );
    } catch (error) {
      if (error instanceof EnhancementRunStopped) {
        await closeOwn(ctx, state, rowId, { reason: 'aborted' });
        throw error;
      }
      if (error instanceof EnhancementRowLost) return { result: await lostRow(ctx, rowId) };
      outcome = { status: 'failed', kind: 'provider_error', retryable: true };
    }
  }
  const latencyMs = ctx.now().getTime() - started;

  if (ctx.signal.aborted && outcome.status !== 'completed') {
    // Cancellation, supersede, expiry, the duration limit or a worker shutdown: a sent edit is
    // charged at the list price (neither live editor can say later whether it billed).
    const operationId = state.sent?.operationId;
    if (sent && operationId && editor.cancel) {
      await editor.cancel(operationId).catch(() => undefined);
    }
    await closeOwn(ctx, state, rowId, {
      reason: ctx.deadlineHit() ? 'deadline' : 'aborted',
      assumeCharged: sent,
    });
    throw new JobAborted(ctx.deadlineHit() ? 'deadline' : 'signal');
  }

  if (outcome.status === 'completed') {
    const rawKey = keys.attempt(
      job.id,
      rowId,
      `raw.${outcome.format === 'jpeg' ? 'jpg' : outcome.format}`,
    );
    await deps.storage.put({
      bucket: 'private',
      key: rawKey,
      body: outcome.image,
      contentType: `image/${outcome.format}`,
      provenance: { sourceKind: 'street_view', permission: ctx.permission(), derivative: true },
    });
    const units = outcome.usage.images ?? 1;
    const imageSize = request?.parameters.image_size;
    const cost = usageCostMicros(outcome.modelSnapshot, outcome.usage, {
      imageSize: typeof imageSize === 'string' ? imageSize : null,
    });
    const answered = outcome;
    const editCost = {
      units,
      ...(cost === null ? {} : { unitPriceMicros: Math.round(cost / Math.max(1, units)) }),
      modelId: answered.modelSnapshot,
    };
    const sentEdit: SentEdit = state.sent ?? {
      operationId: answered.operationId,
      provider: editor.providerId,
      isFixture: ctx.providerMode() !== 'live',
      modelId: answered.modelSnapshot,
    };
    const written = await db
      .transaction()
      .execute(
        async (trx): Promise<{ row: SourceEnhancement } | { lost: SourceEnhancement | null }> => {
          const current = await trx
            .selectFrom('sourceEnhancements')
            .selectAll()
            .where('id', '=', rowId)
            .forUpdate()
            .executeTakeFirst();
          if (!current || current.status !== 'pending' || current.jobId !== job.id) {
            await recordLostEdit(trx, deps, current, { job, edit: sentEdit }, editCost);
            return { lost: current ?? null };
          }
          const editLedgerEntryId =
            current.editLedgerEntryId ?? (await recordEditCost(trx, deps, current, editCost));
          const updated = await trx
            .updateTable('sourceEnhancements')
            .set({
              editLedgerEntryId,
              providerOperationId: answered.operationId,
              rawObjectKey: rawKey,
              providerUsage: toJson(answered.usage),
              modelSnapshot: answered.modelSnapshot,
              providerWatermark: answered.provenance.watermark ?? 'unknown',
              editCompletedAt: ctx.now(),
              editLatencyMs: latencyMs,
              judge: null,
              judgeUsage: null,
              judgeLedgerEntryId: null,
            })
            .where('id', '=', rowId)
            .returningAll()
            .executeTakeFirstOrThrow();
          return { row: updated };
        },
      );
    state.sent = null;
    if ('lost' in written) {
      // Nothing will resume from this output: the row is gone or another job holds it.
      if (written.lost?.rawObjectKey !== rawKey) await deps.storage.delete('private', rawKey);
      return { result: await lostRow(ctx, rowId) };
    }
    if (ctx.signal.aborted) {
      // Answered and paid: the next job resumes from the stored output.
      await closeOwn(ctx, state, rowId, {
        reason: ctx.deadlineHit() ? 'deadline' : 'aborted',
      });
      throw new JobAborted(ctx.deadlineHit() ? 'deadline' : 'signal');
    }
    return { rawBytes: answered.image, row: written.row };
  }

  const patch = { editCompletedAt: ctx.now(), editLatencyMs: latencyMs };
  if (outcome.status === 'pending') {
    await closeOwn(ctx, state, rowId, {
      reason: 'unknown_outcome',
      edit: { units: 1 },
      patch,
    });
    return failed('unknown_outcome');
  }
  const detail = {
    kind: outcome.kind,
    providerCode: outcome.providerCode ?? null,
    httpStatus: outcome.httpStatus ?? null,
  };
  switch (outcome.kind) {
    case 'moderation_blocked':
      ctx.log.warn(
        { categories: outcome.providerCategories ?? [] },
        'provider refused the street view enhancement',
      );
      await closeOwn(ctx, state, rowId, {
        reason: 'moderation_blocked',
        edit: { units: 0 },
        patch,
      });
      return failed('moderation_blocked');
    case 'invalid_request':
      ctx.log.error({ providerCode: outcome.providerCode }, 'enhance request rejected by provider');
      await closeOwn(ctx, state, rowId, {
        reason: 'invalid_request',
        edit: { units: 0 },
        patch,
      });
      return failed('invalid_request');
    case 'timeout':
      // No answer within the timeout: settled as charged.
      await closeOwn(ctx, state, rowId, { reason: 'timeout', edit: { units: 1 }, patch });
      return failed('timeout');
    default: {
      if (unreadableAnswer(outcome) || (sent && !vendorAnswered(outcome))) {
        // Sent and unanswered, or answered unreadably: a charge may exist.
        ctx.log.warn(detail, 'street view enhancement outcome unknown');
        await closeOwn(ctx, state, rowId, {
          reason: 'unknown_outcome',
          edit: { units: 1 },
          patch,
        });
        return failed('unknown_outcome');
      }
      ctx.log.warn(detail, 'street view enhancement provider error');
      await closeOwn(ctx, state, rowId, {
        reason: 'provider_error',
        ...(sent ? { edit: { units: 0 } } : { assumeCharged: false }),
        patch,
      });
      return failed('provider_error');
    }
  }
}

/**
 * Removes the source's enhancements of other compiler versions not written for
 * `supersededAfterMs` (a job in flight across a deploy keeps its picture meanwhile), unless a
 * preservation hold covers the source: its own, or one on its project, its owner or a report.
 */
async function dropSuperseded(
  ctx: EnhanceContext,
  source: Pick<SourceAsset, 'id' | 'preservationHoldId'>,
): Promise<void> {
  if (source.preservationHoldId) return;
  const held = await loadHeldSet(ctx.deps);
  if (held.sources.has(source.id)) return;
  const before = new Date(ctx.now().getTime() - PIPELINE_DEFAULTS.enhance.supersededAfterMs);
  const removed = await ctx.deps.db
    .deleteFrom('sourceEnhancements')
    .where('sourceAssetId', '=', source.id)
    .where('compilerVersion', '!=', ctx.job.compilerVersion)
    .where('status', '!=', 'pending')
    .where('updatedAt', '<', before)
    .returning('objectKey')
    .execute();
  for (const row of removed) {
    if (row.objectKey) await ctx.deps.storage.delete('private', row.objectKey);
  }
}
