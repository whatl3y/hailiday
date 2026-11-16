import { sql } from 'kysely';
import {
  NON_TERMINAL_RENDER_JOB_STATES,
  isTerminalRenderJobState,
  type NormalizedBox,
  type SceneType,
} from '@hailiday/core';
import { toJson, type DbOrTx, type Tx } from '../../db/client.js';
import type { RenderJob, SourceAsset, ViewpointFraming, ViewpointJson } from '../../db/schema.js';
import {
  FRAMING_LEDGER_STAGE,
  VISION_PRICES_MICROS,
  usageCostMicros,
  type ReportedUsage,
} from '../../ledger/index.js';
import { consumeDisplayLoads, displayLoadsRemaining } from '../../limits/index.js';
import type { Logger } from '../../logger/index.js';
import type { AssetPermission } from '../../policy/index.js';
import {
  ViewpointFramingSchema,
  frameView,
  framedViewOf,
  framingOf,
  viewpointFramed,
} from '../../providers/street-view/framing.js';
import type { LocateHomeResult, StreetViewView, VisionCallResult } from '../../providers/types.js';
import type { PipelineDeps, ProviderLegs } from '../context.js';
import { dropSourceEnhancements } from '../enhance/store.js';
import { decodeRaster } from '../imaging/raster.js';
import { loadHeldSet } from '../jobs/holds.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { JobFailure } from './errors.js';
import { fixtureContextFor } from './fixture-hints.js';
import { settleCall } from './ledger.js';
import { fetchFrame, loadSourcePixels, type LoadedSource } from './source.js';
import { setJobSubStage } from './transitions.js';

/** What the framing step needs from the render run. */
export interface FramingContext {
  job: RenderJob;
  /** The source row as the job read it before loading its pixels. */
  source: SourceAsset;
  /** The frame `loadSourcePixels` returned. */
  loaded: LoadedSource;
  /** The permission evaluated in `preparing`. */
  permission: AssetPermission;
  legs: ProviderLegs;
  sceneType: SceneType;
  signal: AbortSignal;
  log: Logger;
  /** Throws `JobAborted` when the job's signal fired. */
  checkAbort(): void;
  isPaused(provider: string): Promise<boolean>;
  /** The provider name the kill switches and the ledger use for the vision leg. */
  visionProvider(): string;
}

/** The frame the job goes on with and the source row as it now stands. */
export interface FramingResult {
  loaded: LoadedSource;
  source: SourceAsset;
}

/** The horizontal middle third of a frame: a located home must reach into it. */
const MIDDLE_THIRD: readonly [number, number] = [1 / 3, 2 / 3];

function reportedUsage(call: Pick<VisionCallResult<unknown>, 'usage'>): ReportedUsage {
  const { inputTokens, outputTokens, cacheReadInputTokens } = call.usage;
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
  };
}

async function readSource(deps: PipelineDeps, id: string): Promise<SourceAsset | null> {
  return (
    (await deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()) ?? null
  );
}

/**
 * Whether another render job of the source is unfinished: in any state that is not final, a look
 * held for pre-delivery review included. Such a job works on, or will publish a look made from,
 * the frame the source has now.
 */
async function otherJobUnfinished(
  db: DbOrTx,
  sourceAssetId: string,
  jobId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('renderJobs')
    .select('id')
    .where('sourceAssetId', '=', sourceAssetId)
    .where('id', '!=', jobId)
    .where('state', 'in', [...NON_TERMINAL_RENDER_JOB_STATES])
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Where a framed view the browser loads from the provider's display URL is counted: the property
 * of the job's project and its display budget per address, with how the load is ledgered.
 */
interface DisplayBudget {
  propertyId: string;
  limit: number;
  provider: string;
  isFixture: boolean;
}

async function displayBudgetOf(
  deps: PipelineDeps,
  ctx: FramingContext,
): Promise<{ budget: DisplayBudget; remaining: number } | null> {
  const property = await deps.db
    .selectFrom('projects')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .select([
      'properties.id as propertyId',
      'properties.displayLoadsIssued',
      'properties.displayLoadsWindowStartedAt',
    ])
    .where('projects.id', '=', ctx.job.projectId)
    .executeTakeFirst();
  if (!property) return null;
  const limit = await deps.settings.get('rate.static_display_loads_per_address');
  const live = ctx.legs.mode === 'live';
  return {
    budget: {
      propertyId: property.propertyId,
      limit,
      provider: live ? 'google' : 'fixture-street-view',
      isFixture: !live,
    },
    remaining: displayLoadsRemaining(property, limit, deps.clock.now()),
  };
}

/** Where the decision leaves the source: zoomed in on the home, or its wide frame for good. */
type Decision =
  | { status: 'framed'; view: StreetViewView; box: NormalizedBox; zoom: number }
  | { status: 'kept'; reason: 'no_home' | 'ambiguous' | 'small_gain'; box: NormalizedBox | null };

/**
 * What a locate answer means for a frame seen at `view`: a home found unambiguously, with enough
 * confidence and reaching into the frame's horizontal middle third is framed when the framed view
 * zooms in at least `minZoom`; otherwise the wide frame is kept.
 */
export function framingDecision(view: StreetViewView, located: LocateHomeResult): Decision {
  const params = PIPELINE_DEFAULTS.framing;
  if (located.ambiguous) return { status: 'kept', reason: 'ambiguous', box: located.home };
  if (!located.home) return { status: 'kept', reason: 'no_home', box: null };
  if (located.confidence < params.minConfidence) {
    return { status: 'kept', reason: 'ambiguous', box: located.home };
  }
  // The target home is the one at or nearest the frame's middle: a box off to one side is
  // more likely a neighbour than the home asked for.
  if (located.home[2] <= MIDDLE_THIRD[0] || located.home[0] >= MIDDLE_THIRD[1]) {
    return { status: 'kept', reason: 'ambiguous', box: located.home };
  }
  const framed = frameView(view, located.home, {
    marginFraction: params.marginFraction,
    minFovDeg: params.minFovDeg,
    slackBelowShare: params.slackBelowShare,
  });
  if (framed.zoom < params.minZoom) {
    return { status: 'kept', reason: 'small_gain', box: located.home };
  }
  return {
    status: 'framed',
    view: { ...view, heading: framed.heading, pitch: framed.pitch, fov: framed.fov },
    box: located.home,
    zoom: Math.round(framed.zoom * 1000) / 1000,
  };
}

type Recorded =
  | { outcome: 'recorded'; row: SourceAsset; bytesReplaced: boolean }
  | { outcome: 'taken'; row: SourceAsset }
  | { outcome: 'over_budget' }
  | { outcome: 'gone' };

/**
 * Takes the job's project row `FOR KEY SHARE` in `trx`. A transaction that changes a framing
 * takes it first, before the source row: render admission and project deletion lock that row
 * `FOR UPDATE` before they touch the job and source rows, so the two wait for each other in
 * turn instead of each holding a row the other needs.
 */
async function lockProject(trx: Tx, projectId: string): Promise<void> {
  await trx
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projectId)
    .forKeyShare()
    .executeTakeFirst();
}

/** The database's clock now (the clock that stamps a look's `created_at`), as an ISO string. */
async function databaseNow(trx: Tx, deps: PipelineDeps): Promise<string> {
  const clock = await sql<{ at: Date | string }>`select clock_timestamp() as at`.execute(trx);
  return new Date(clock.rows[0]?.at ?? deps.clock.now()).toISOString();
}

/**
 * Counts the framed view a source without a stored frame shows (the browser loads it from the
 * provider's display URL) against the property's display budget and ledgers it, in `trx` and
 * under a lock on the property. False when the budget has no room left.
 */
async function issueFramedDisplay(
  deps: PipelineDeps,
  ctx: FramingContext,
  trx: Tx,
  display: DisplayBudget,
): Promise<boolean> {
  const now = deps.clock.now();
  const property = await trx
    .selectFrom('properties')
    .select(['displayLoadsIssued', 'displayLoadsWindowStartedAt'])
    .where('id', '=', display.propertyId)
    .forUpdate()
    .executeTakeFirst();
  if (!property || displayLoadsRemaining(property, display.limit, now) < 1) return false;
  await consumeDisplayLoads(trx, { propertyId: display.propertyId, limit: display.limit, now });
  await settleCall(trx, {
    reservation: null,
    jobId: ctx.job.id,
    ownerId: ctx.job.ownerId,
    projectId: ctx.job.projectId,
    provider: display.provider,
    sku: 'street_view_static_display',
    stage: FRAMING_LEDGER_STAGE,
    units: 1,
    isFixture: display.isFixture,
    clock: deps.clock,
  });
  return true;
}

/**
 * Records the framing on the source with a compare-and-set (no framing recorded yet, the row not
 * deleted and still `ready`), under a lock on the row taken after the project row
 * (`lockProject`). The record is `taken` (nothing written)
 * when a framing is recorded already, a preservation hold now covers the source, the job is no
 * longer in `preparing` (canceled or superseded while it located the home) or another job of the
 * source is unfinished (`otherJobUnfinished`). The record's `framedAt` is the database's clock
 * once those checks passed, the clock that stamps a look's `created_at`: every look created
 * before it was made from the frame the source had before, and every look created at or after
 * it from the recorded frame. With `frame`, a stored frame is replaced first under the source's
 * object key and its checksum, size and fetch time follow; a `framed` record without a stored
 * frame (`transient`) changes only the viewpoint and counts the framed view the browser will load
 * against the property's display budget (`over_budget`, nothing written, when it has no room);
 * the record's `displayIssuedAt` then says that load is ledgered.
 */
async function recordFraming(
  deps: PipelineDeps,
  ctx: FramingContext,
  sourceId: string,
  framing: ViewpointFraming,
  frame: { bytes: Buffer; checksum: string } | null,
  display: DisplayBudget | null,
): Promise<Recorded> {
  return deps.db.transaction().execute(async (trx): Promise<Recorded> => {
    await lockProject(trx, ctx.job.projectId);
    const current = await trx
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', sourceId)
      .forUpdate()
      .executeTakeFirst();
    if (!current || current.deletedAt || current.state !== 'ready' || !current.viewpoint) {
      return { outcome: 'gone' };
    }
    if (viewpointFramed(current.viewpoint) || current.preservationHoldId) {
      return { outcome: 'taken', row: current };
    }
    const job = await trx
      .selectFrom('renderJobs')
      .select('state')
      .where('id', '=', ctx.job.id)
      .forShare()
      .executeTakeFirst();
    if (job?.state !== 'preparing' || (await otherJobUnfinished(trx, sourceId, ctx.job.id))) {
      return { outcome: 'taken', row: current };
    }
    const framedAt = await databaseNow(trx, deps);
    let record: ViewpointFraming = { ...framing, framedAt };
    const now = deps.clock.now();
    const replace = frame !== null && current.objectKey !== null;
    if (record.status === 'framed' && !replace) {
      if (!display || !(await issueFramedDisplay(deps, ctx, trx, display))) {
        return { outcome: 'over_budget' };
      }
      record = { ...record, displayIssuedAt: framedAt };
    }
    if (replace) {
      await deps.storage.put({
        bucket: 'private',
        key: current.objectKey as string,
        body: frame.bytes,
        contentType: 'image/jpeg',
        provenance: { sourceKind: 'street_view', permission: ctx.permission },
      });
    }
    const viewpoint: ViewpointJson = replace
      ? {
          ...current.viewpoint,
          framing: record,
          fetchedAt: now.toISOString(),
          sourceCheckedAt: now.toISOString(),
        }
      : { ...current.viewpoint, framing: record };
    const updated = await trx
      .updateTable('sourceAssets')
      .set({
        viewpoint: toJson(viewpoint),
        ...(replace && frame
          ? {
              checksumSha256: frame.checksum,
              byteLength: frame.bytes.length,
              revalidatedAt: now,
            }
          : {}),
      })
      .where('id', '=', sourceId)
      .where(sql<boolean>`viewpoint -> 'framing' is null`)
      .where('deletedAt', 'is', null)
      .where('state', '=', 'ready')
      .returningAll()
      .executeTakeFirst();
    if (!updated) return { outcome: 'taken', row: current };
    return { outcome: 'recorded', row: updated, bytesReplaced: replace };
  });
}

/**
 * Framing a Street View source on its home (render spec, preparing): at the source's next look
 * while no framing is recorded (its first look, or the next look of a source whose looks were
 * made before), the vision model locates the home in the frame just loaded, the view that shows
 * just that home is computed and fetched from the same panorama, and that frame becomes the
 * source's frame (the stored copy in `persist` mode, whose enhancements are dropped with the frame
 * it replaces; the viewpoint's framing in either mode, so every later fetch and display uses the
 * framed view). A home that is missing, ambiguous, located with too little confidence, off to one
 * side of the frame, or too large to gain from zooming in records `kept`, and the source keeps its
 * wide frame for good. A framed frame a scene analysis then refuses is taken back
 * (`keepWideFrame`).
 *
 * It applies to a Street View source of an exterior with the switch on, in `persist` or
 * `transient` mode (a `transient` job whose source still has a stored frame is skipped), whose
 * viewpoint records no framing and that no preservation hold covers, for a job still in
 * `preparing`; a source without a stored frame needs room in its property's display budget for
 * the framed view the browser will load. Looks made before do not stop it. Once the locate call
 * is about to be made, the job's sub-stage is `framing`; the move to `analyzing` clears it. A
 * failure that says nothing about the picture (permission, pause, a provider error or refusal, a
 * failed or unreadable fetch, a record that does not read back, no display budget left) records
 * nothing, and neither does a record refused because another job of the source is unfinished
 * (`recordFraming`), so the source's next look tries again, and the job goes on with the frame it
 * loaded. The locate call
 * gets one try. The only failure of its own is a source deleted or no longer ready when the
 * framing is recorded (`source_unavailable`). When another job recorded a framing first, its
 * frame is loaded instead. The calls are charged directly on the ledger (stage `framing`): the
 * locate call, the framed fetch and, for a source without a stored frame, the framed view's
 * display load.
 */
export async function frameStreetViewSource(
  deps: PipelineDeps,
  ctx: FramingContext,
): Promise<FramingResult> {
  const unchanged: FramingResult = { loaded: ctx.loaded, source: ctx.source };
  const mode = ctx.loaded.streetViewMode;
  if (
    ctx.source.kind !== 'street_view' ||
    ctx.sceneType !== 'house_exterior' ||
    !deps.config.streetView.framing ||
    ctx.job.state !== 'preparing' ||
    (mode !== 'persist' && mode !== 'transient') ||
    viewpointFramed(ctx.source.viewpoint)
  ) {
    return unchanged;
  }

  // The row as it stands after the frame was loaded (a first `persist` load stores it).
  const row = await readSource(deps, ctx.source.id);
  if (!row || row.deletedAt || row.state !== 'ready' || !row.viewpoint) return unchanged;
  if (viewpointFramed(row.viewpoint)) return adoptRecorded(deps, ctx, row);
  const keep: FramingResult = { loaded: ctx.loaded, source: row };
  // A stored frame the job may not store any more is neither replaced nor framed around.
  if (mode !== 'persist' && row.objectKey) return keep;
  if (row.preservationHoldId) return keep;
  const held = await loadHeldSet(deps);
  if (held.sources.has(row.id)) return keep;

  if (!ctx.permission.aiProcess) return keep;
  const visionProvider = ctx.visionProvider();
  if (await ctx.isPaused(visionProvider)) return keep;
  const display = await displayBudgetOf(deps, ctx);
  if (!row.objectKey && (!display || display.remaining < 1)) return keep;

  await setJobSubStage(deps.db, { jobId: ctx.job.id, state: 'preparing', subStage: 'framing' });
  return frame(
    deps,
    ctx,
    { ...row, viewpoint: row.viewpoint },
    keep,
    held,
    display?.budget ?? null,
  );
}

async function frame(
  deps: PipelineDeps,
  ctx: FramingContext,
  row: SourceAsset & { viewpoint: ViewpointJson },
  keep: FramingResult,
  held: Awaited<ReturnType<typeof loadHeldSet>>,
  display: DisplayBudget | null,
): Promise<FramingResult> {
  const viewpoint = row.viewpoint;
  const wide = framedViewOf(viewpoint);
  const fixture = fixtureContextFor(row, deps.content, {
    width: viewpoint.width,
    height: viewpoint.height,
  }).hint;

  // 1. Locate the home in the frame as fetched (one try).
  let call: VisionCallResult<LocateHomeResult>;
  try {
    call = await ctx.legs.vision.locateHome(
      {
        image: { bytes: ctx.loaded.bytes, width: viewpoint.width, height: viewpoint.height },
        sourceAssetId: row.id,
        fixture,
      },
      { signal: ctx.signal, timeoutMs: PIPELINE_DEFAULTS.framing.locateTimeoutMs },
    );
  } catch (error) {
    ctx.checkAbort();
    ctx.log.warn({ err: error }, 'locating the home failed; the job goes on with the frame');
    return keep;
  }
  await settleCall(deps.db, {
    reservation: null,
    jobId: ctx.job.id,
    ownerId: ctx.job.ownerId,
    projectId: ctx.job.projectId,
    provider: ctx.visionProvider(),
    sku: 'vision_call',
    stage: FRAMING_LEDGER_STAGE,
    units: 1,
    unitPriceMicros:
      usageCostMicros(call.model, reportedUsage(call)) ?? VISION_PRICES_MICROS.locate,
    modelId: call.model,
    isFixture: call.providerMode === 'fixture',
    clock: deps.clock,
  });
  ctx.checkAbort();

  const decision = framingDecision(wide, call.result);
  const recorded = {
    promptVersion: call.promptVersion,
    model: call.model,
    framedAt: deps.clock.now().toISOString(),
  };
  const framing: ViewpointFraming =
    decision.status === 'kept'
      ? { status: 'kept', reason: decision.reason, box: decision.box, ...recorded }
      : {
          status: 'framed',
          heading: decision.view.heading,
          pitch: decision.view.pitch,
          fov: decision.view.fov,
          box: decision.box,
          zoom: decision.zoom,
          ...recorded,
        };
  // A record that would not read back (framedViewOf ignores it) is never written.
  if (!ViewpointFramingSchema.safeParse(framing).success) {
    ctx.log.warn(
      { status: framing.status },
      'the framing record does not read back; the job goes on with the frame',
    );
    return keep;
  }
  if (decision.status === 'kept') {
    const outcome = await recordFraming(deps, ctx, row.id, framing, null, display);
    return settle(deps, ctx, outcome, keep);
  }

  // 2. Fetch the framed view from the same panorama.
  const streetViewProvider = ctx.legs.mode === 'live' ? 'google' : 'fixture';
  if (await ctx.isPaused(streetViewProvider)) return keep;
  let fetched: { bytes: Buffer; checksum: string };
  try {
    fetched = await fetchFrame(deps, ctx.legs, decision.view, ctx.signal);
  } catch (error) {
    ctx.checkAbort();
    ctx.log.warn({ err: error }, 'fetching the framed view failed; the job goes on with the frame');
    return keep;
  }
  await settleCall(deps.db, {
    reservation: null,
    jobId: ctx.job.id,
    ownerId: ctx.job.ownerId,
    projectId: ctx.job.projectId,
    provider: streetViewProvider,
    sku: 'street_view_static_fetch',
    stage: FRAMING_LEDGER_STAGE,
    units: 1,
    isFixture: ctx.legs.mode !== 'live',
    clock: deps.clock,
  });
  ctx.checkAbort();
  try {
    await decodeRaster(fetched.bytes);
  } catch (error) {
    ctx.log.warn({ err: error }, 'the framed view could not be decoded; the job goes on');
    return keep;
  }

  // 3. Record it: the framed frame becomes the source's frame.
  const outcome = await recordFraming(deps, ctx, row.id, framing, fetched, display);
  if (outcome.outcome === 'recorded' && outcome.bytesReplaced) {
    // Enhancements of the replaced frame go with it.
    await dropSourceEnhancements(deps, outcome.row, { held });
  }
  return settle(deps, ctx, outcome, keep, {
    bytes: fetched.bytes,
    checksum: fetched.checksum,
    streetViewMode: ctx.loaded.streetViewMode,
    fetched: true,
  });
}

/**
 * The job's frame and row after a record attempt: the recorded frame (`loaded`, else the frame
 * the job loaded), the frame another job recorded, or the frame the job loaded when nothing could
 * be recorded.
 */
async function settle(
  deps: PipelineDeps,
  ctx: FramingContext,
  outcome: Recorded,
  keep: FramingResult,
  loaded: LoadedSource = keep.loaded,
): Promise<FramingResult> {
  if (outcome.outcome === 'gone') throw new JobFailure('source_unavailable');
  if (outcome.outcome === 'over_budget') return keep;
  if (outcome.outcome === 'recorded') return { loaded, source: outcome.row };
  return adoptRecorded(deps, ctx, outcome.row);
}

/**
 * Another job recorded a framing first (or the record was refused): a `framed` source's frame is
 * loaded again, because that frame is the truth; otherwise the job goes on with the frame it
 * loaded.
 */
async function adoptRecorded(
  deps: PipelineDeps,
  ctx: FramingContext,
  row: SourceAsset,
): Promise<FramingResult> {
  if (framingOf(row.viewpoint)?.status !== 'framed') return { loaded: ctx.loaded, source: row };
  const loaded = await loadSourcePixels(deps, {
    job: ctx.job,
    source: row,
    permission: ctx.permission,
    legs: ctx.legs,
    signal: ctx.signal,
  });
  return { loaded, source: row };
}

/**
 * What the take-back of a refused framed frame (`keepWideFrame`) finds on the source row and the
 * job row as `db` reads them:
 * - `stopped`: the job is gone or final (canceled, superseded). The run stops; the job that
 *   replaced it decides.
 * - `refused`: the source is no longer ready, a look of the source was created at or after the
 *   framing's `framedAt` (its framed frame has produced a look), or the job is past `analyzing`.
 *   The source checks decide as before.
 * - `blocked`: the row no longer holds the frame the run analyzed (its framing or its stored frame
 *   changed), a preservation hold covers the source, or another job of the source is unfinished.
 *   Nothing is written and the source is not declined.
 * - `eligible`: the framing can be taken back.
 */
type TakeBackCheck = 'eligible' | 'refused' | 'blocked' | 'stopped';

async function takeBackCheck(
  db: DbOrTx,
  ctx: FramingContext,
  framedAt: string,
  row: SourceAsset | null | undefined,
): Promise<TakeBackCheck> {
  const job = await db
    .selectFrom('renderJobs')
    .select('state')
    .where('id', '=', ctx.job.id)
    .forShare()
    .executeTakeFirst();
  if (!job || isTerminalRenderJobState(job.state)) return 'stopped';
  if (job.state !== 'analyzing') return 'refused';
  if (!row || row.deletedAt || row.state !== 'ready' || !row.viewpoint) return 'refused';
  const now = framingOf(row.viewpoint);
  if (
    now?.status !== 'framed' ||
    now.framedAt !== framedAt ||
    (ctx.loaded.streetViewMode === 'persist' &&
      row.objectKey &&
      row.checksumSha256 !== ctx.loaded.checksum)
  ) {
    return 'blocked';
  }
  const since = Date.parse(framedAt);
  if (!Number.isFinite(since)) return 'refused';
  const look = await db
    .selectFrom('renderAssets')
    .select('id')
    .where('sourceAssetId', '=', row.id)
    .where('createdAt', '>=', new Date(since))
    .limit(1)
    .executeTakeFirst();
  if (look) return 'refused';
  if (row.preservationHoldId || (await otherJobUnfinished(db, row.id, ctx.job.id))) {
    return 'blocked';
  }
  return 'eligible';
}

/** What the take-back of a refused framed frame leaves the run with. */
export type TakeBack =
  /** The wide frame and the source row for the run to analyze. */
  | { outcome: 'taken'; loaded: LoadedSource; source: SourceAsset }
  /** Nothing taken back: the source checks decide as before. */
  | { outcome: 'refused' }
  /** The job is no longer active: the run stops without declining the source. */
  | { outcome: 'stopped' };

/**
 * A framing the scene analysis refused (render spec, analyzing): when an analysis of a framed frame
 * says the home is not in the frame, the framing is taken back instead of losing the place,
 * whichever run meets that frame (the run that framed it, its redelivery or a later job). The
 * decision is the source row's, not the run's: the framing is the `framed` record the run's frame
 * was loaded from (and, in `persist` mode, the stored frame is the one the run analyzed), and no
 * look of the source was created at or after its `framedAt` (`takeBackCheck`). The candidate's own
 * view is then fetched again (one Static fetch, charged directly on stage `framing`) and becomes the
 * source's frame again: in `persist` mode it replaces the stored framed frame under the same key
 * (its enhancements go with it), and the viewpoint's framing becomes `kept` with reason
 * `refused_framed`, so the source keeps its wide frame for good.
 *
 * The checks run before the fetch and again under the project row's and then the source row's lock
 * before the write, like the framing record (`recordFraming`). A job no longer active
 * (`stopped`) neither fetches nor writes. A frame the row no longer holds, a preservation hold and
 * another unfinished job of the source (`blocked`) fail the job `source_unavailable`; a paused
 * provider fails it `provider_error`; a failed or unreadable fetch fails it `source_unavailable`.
 * None of these declines the source, so its next look tries the take-back again. `refused` (a
 * frame that is not framed, a framed frame that has produced a look) leaves the source checks to
 * decline the source as before.
 */
export async function keepWideFrame(deps: PipelineDeps, ctx: FramingContext): Promise<TakeBack> {
  const framing = framingOf(ctx.source.viewpoint);
  const viewpoint = ctx.source.viewpoint;
  const mode = ctx.loaded.streetViewMode;
  if (
    ctx.source.kind !== 'street_view' ||
    framing?.status !== 'framed' ||
    !viewpoint ||
    (mode !== 'persist' && mode !== 'transient')
  ) {
    return { outcome: 'refused' };
  }
  const blocked = () =>
    new JobFailure('source_unavailable', null, 'the refused framing could not be taken back');
  const before = await takeBackCheck(
    deps.db,
    ctx,
    framing.framedAt,
    await readSource(deps, ctx.source.id),
  );
  if (before === 'stopped' || before === 'refused') return { outcome: before };
  const held = await loadHeldSet(deps);
  if (before === 'blocked' || held.sources.has(ctx.source.id)) throw blocked();
  ctx.checkAbort();
  const streetViewProvider = ctx.legs.mode === 'live' ? 'google' : 'fixture';
  if (await ctx.isPaused(streetViewProvider)) {
    throw new JobFailure('provider_error', null, 'paused');
  }
  const wide: StreetViewView = {
    panoId: viewpoint.panoId,
    heading: viewpoint.heading,
    pitch: viewpoint.pitch,
    fov: viewpoint.fov,
    width: viewpoint.width,
    height: viewpoint.height,
  };
  const fetched = await fetchFrame(deps, ctx.legs, wide, ctx.signal);
  await settleCall(deps.db, {
    reservation: null,
    jobId: ctx.job.id,
    ownerId: ctx.job.ownerId,
    projectId: ctx.job.projectId,
    provider: streetViewProvider,
    sku: 'street_view_static_fetch',
    stage: FRAMING_LEDGER_STAGE,
    units: 1,
    isFixture: ctx.legs.mode !== 'live',
    clock: deps.clock,
  });
  ctx.checkAbort();
  try {
    await decodeRaster(fetched.bytes);
  } catch {
    throw new JobFailure('source_unavailable', null, 'Street View frame could not be decoded');
  }

  const taken = await deps.db.transaction().execute(async (trx) => {
    await lockProject(trx, ctx.job.projectId);
    const current = await trx
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', ctx.source.id)
      .forUpdate()
      .executeTakeFirst();
    const check = await takeBackCheck(trx, ctx, framing.framedAt, current);
    if (check !== 'eligible') return check;
    if (!current?.viewpoint) return 'refused';
    const record: ViewpointFraming = {
      status: 'kept',
      reason: 'refused_framed',
      box: framing.box,
      promptVersion: framing.promptVersion,
      model: framing.model,
      framedAt: await databaseNow(trx, deps),
    };
    const replace = mode === 'persist' && current.objectKey !== null;
    if (replace) {
      await deps.storage.put({
        bucket: 'private',
        key: current.objectKey as string,
        body: fetched.bytes,
        contentType: 'image/jpeg',
        provenance: { sourceKind: 'street_view', permission: ctx.permission },
      });
    }
    const at = deps.clock.now();
    const updated = await trx
      .updateTable('sourceAssets')
      .set({
        viewpoint: toJson(
          replace
            ? {
                ...current.viewpoint,
                framing: record,
                fetchedAt: at.toISOString(),
                sourceCheckedAt: at.toISOString(),
              }
            : { ...current.viewpoint, framing: record },
        ),
        ...(replace
          ? {
              checksumSha256: fetched.checksum,
              byteLength: fetched.bytes.length,
              revalidatedAt: at,
            }
          : {}),
      })
      .where('id', '=', current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { row: updated, replaced: replace };
  });
  if (taken === 'stopped' || taken === 'refused') return { outcome: taken };
  if (taken === 'blocked') throw blocked();
  // Enhancements of the framed frame go with it.
  if (taken.replaced) await dropSourceEnhancements(deps, taken.row, { held });
  return {
    outcome: 'taken',
    loaded: {
      bytes: fetched.bytes,
      checksum: fetched.checksum,
      streetViewMode: mode,
      fetched: true,
    },
    source: taken.row,
  };
}
