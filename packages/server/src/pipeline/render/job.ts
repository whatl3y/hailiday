import { sql } from 'kysely';
import { z } from 'zod';
import {
  BuildingFormSchema,
  CompiledRequestSchema,
  COMPILED_REQUEST_SCHEMA_VERSION,
  DecorationPlanSchema,
  JudgeResultSchema,
  LocalizationRecordSchema,
  MAX_RENDER_ATTEMPTS,
  RelightBaseSchema,
  RoomTypeSchema,
  SceneAnalysisSchema,
  SceneTypeSchema,
  STANDARD_RENDER_ATTEMPTS,
  SpecAttributesSchema,
  TERMINAL_RENDER_JOB_STATES,
  isCriticalFailureCode,
  isRelightLightingMode,
  isTerminalRenderJobState,
  JobEnhancementRecordSchema,
  type BuildingForm,
  type CompiledRequest,
  type DecorationPlan,
  type FailureCode,
  type FailureDetail,
  type FailureKind,
  type HolidayPack,
  type JobEnhancementRecord,
  type JudgeResult,
  type LightingMode,
  type LocalizationRecord,
  type LocalizedAdditionRecord,
  type MajorFailureCode,
  type NormalizedBox,
  type ProviderMode,
  type RelightAttemptRecord,
  type RelightBase,
  type RelightFallbackRecord,
  type RelightLightingMode,
  type RelightSkippedRecord,
  type RenderAttemptNumber,
  type RenderJobState,
  type RoomType,
  type SceneAnalysis,
  type SceneType,
  type SpecAttributes,
  type UserRole,
} from '@hailiday/core';
import { readPackByRef } from '../../content/load.js';
import { toJson, type DbOrTx, type Tx } from '../../db/client.js';
import type {
  Project,
  RenderAsset,
  RenderAttempt,
  RenderJob,
  SourceAsset,
  StyleKitRow,
} from '../../db/schema.js';
import { FIXTURE_COMPOSITOR_VERSION } from '../../fixtures/compositor.js';
import { newId } from '../../ids/index.js';
import {
  ENHANCE_LEDGER_STAGE,
  VISION_PRICES_MICROS,
  release,
  unitPriceFor,
  usageCostMicros,
  type ReportedUsage,
} from '../../ledger/index.js';
import { attemptQuota, lockOwnerAllowance } from '../../limits/index.js';
import {
  evaluateAndRecord,
  isEditable,
  isPropertyBlocked,
  permissionSettingsOf,
  type AssetPermission,
} from '../../policy/index.js';
import { isProviderError, ProviderError } from '../../providers/errors.js';
import type {
  EditOutcome,
  FixtureEditContext,
  ImageEditor,
  ImageInput,
  LocalizeAdditionsResult,
  VisionCallResult,
} from '../../providers/types.js';
import { ANALYSIS_PROMPT_VERSION } from '../../providers/vision/prompts.js';
import { FIXTURE_VISION_MODEL } from '../../providers/vision/fixture.js';
import { keys } from '../../storage/keys.js';
import { emitServerEvent } from '../analytics.js';
import {
  RELIGHT_REPAIR_BRIGHT_LIGHT,
  RELIGHT_REPAIR_KEEP,
  RELIGHT_REPAIR_LIGHT,
  compileRelightRequest,
  compiledRecordOf,
  compilerProviderFor,
} from '../compile/compiler.js';
import {
  aiCapabilityFor,
  capabilityStateFor,
  pipelineOptions,
  providerLegsFor,
  type PipelineDeps,
  type PipelineOptions,
  type ProviderLegs,
} from '../context.js';
import { EnhancementRunStopped, resolveEnhancement, type EnhanceContext } from '../enhance/run.js';
import { loadEnhancedWorking } from '../enhance/store.js';
import {
  copyrightLabelRegions,
  embeddedAttributionRegions,
} from '../imaging/embedded-attribution.js';
import { runLengthEncode, type CompositeMask } from '../imaging/mask.js';
import {
  checksumOf,
  decodeRaster,
  encodeJpeg,
  encodeMaskPng,
  encodePng,
  toRect,
  type Raster,
} from '../imaging/raster.js';
import { registrationRecord } from '../imaging/registration.js';
import { medianLuma } from '../imaging/relight.js';
import {
  nativeBoxesOnWorkingGrid,
  prepareWorkingImage,
  type WorkingImage,
} from '../imaging/working.js';
import {
  PlanConfigurationError,
  deriveRepair,
  findingsFrom,
  isRepairable,
  planAndCompile,
  type RepairInput,
} from '../plan/index.js';
import { COMPILER_RELEASE, PIPELINE_DEFAULTS } from '../versions.js';
import {
  JobAborted,
  JobFailure,
  NO_IMAGE,
  sleep,
  unreadableAnswer,
  vendorAnswered,
} from './errors.js';
import {
  fixtureAttributionRegion,
  fixtureContextFor,
  type SourceFixtureContext,
} from './fixture-hints.js';
import {
  findOpenReservation,
  findVisionReservation,
  releaseRemaining,
  settleCall,
} from './ledger.js';
import {
  protectedCompositing,
  renderCompositeMask,
  type ProtectedCompositing,
  type TextMarkModeOf,
} from './mask.js';
import {
  buildDeliverables,
  holdBaseVariant,
  holdForReview,
  publishAccepted,
  publishBaseVariant,
  type StagedBaseVariant,
} from './publish.js';
import {
  callJudge,
  callLocalizer,
  classifyJudge,
  compositeAndCheck,
  decideAttempt,
  deterministicClassification,
  deterministicJudgeResult,
  judgeDecision,
  localizationRecords,
  openTextMarkHints,
  registerOutput,
  restoredChangeHints,
  uncertainDeliverable,
  type AttemptVerdict,
  type CompositeResult,
  type JudgeClassification,
} from './quality.js';
import { frameStreetViewSource, keepWideFrame } from './framing.js';
import {
  criticalSpotsOnly,
  decorationsLeft,
  doubtedSpots,
  enoughDecorationsLeft,
  objectedSpots,
  withRestoredSpots,
  type DecorationsLeft,
  type JudgedSpots,
  type ObjectedSpots,
  type RestoredRecord,
} from './last-resort.js';
import { loadSourcePixels, type LoadedSource } from './source.js';
import { LostRaceError, readJob, transitionJob, type JobPatch } from './transitions.js';

/**
 * Optional fields of `render_jobs.input_snapshot` the worker reads. The API freezes them at job
 * creation; when absent the worker reads the source asset and the published content instead.
 */
export const RenderInputSnapshotSchema = z
  .object({
    sourceKind: z.string().optional(),
    sceneType: SceneTypeSchema.optional(),
    buildingForm: BuildingFormSchema.nullable().optional(),
    roomType: RoomTypeSchema.nullable().optional(),
    styleKitVersionId: z.string().uuid().optional(),
    packContentSha256: z.string().optional(),
  })
  .partial();
export type RenderInputSnapshot = z.infer<typeof RenderInputSnapshotSchema>;

export interface RenderJobInput {
  renderJobId: string;
  /** Aborts when the queue cancels or expires the job. */
  signal?: AbortSignal;
  retryCount?: number;
}

export interface RenderJobResult {
  state: RenderJobState | 'missing';
  /** True when another actor ended the job and this run stopped without publishing. */
  stopped: boolean;
}

/** Stops the run because the job no longer belongs to this worker. */
class RunStopped extends Error {
  constructor() {
    super('render run stopped');
    this.name = 'RunStopped';
  }
}

/**
 * The owner's paid-attempt cap, checked under the owner's allowance lock, refused the next
 * attempt. The job fails `policy_denied` unless the refused attempt relights a base the job
 * decorated itself (`deliverBaseAfterRefusedRelight`).
 */
class AttemptCapReached extends JobFailure {
  constructor() {
    super('policy_denied', null, 'paid-attempt cap reached');
    this.name = 'AttemptCapReached';
  }
}

const packCache = new Map<string, HolidayPack>();

/**
 * Recorded attempt outcomes that are already settled: a redelivered job ends with the matching
 * failure instead of dispatching again.
 */
const SETTLED_ATTEMPT_FAILURES: Partial<Record<RenderAttempt['outcome'], FailureKind>> = {
  timeout: 'timeout',
  provider_error: 'provider_error',
  moderation_blocked: 'moderation_blocked',
  qa_rejected: 'internal_error',
};

/**
 * The failure an attempt recorded when its edit ended without an output: `timeout` or
 * `provider_error` (already settled), or `canceled` before it was sent (a paused provider, or too
 * little time left for a relight's edit). A redelivery that finds the job already in `checking`
 * (a fallback after the failed edit moved it there: to a relight's base, or to the attempt kept
 * through a repair) ends the job with that failure. Null for any other attempt.
 */
function unfinishedEditFailure(attempt: RenderAttempt): JobFailure | null {
  if (attempt.outcome === 'timeout' || attempt.outcome === 'provider_error') {
    return new JobFailure(attempt.outcome, null, 'attempt outcome already recorded');
  }
  if (attempt.outcome === 'canceled' && attempt.providerOperationId === null) {
    const paused = (attempt.errorDetail as { paused?: unknown } | null)?.paused === true;
    return new JobFailure(paused ? 'provider_error' : 'timeout', null, 'relight edit not sent');
  }
  return null;
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

/** The decorated base a relight starts from, loaded on the working grid. */
interface RelightInput {
  base: RelightBase;
  /** The accepted daylight plan (its placements are the decorations the relight keeps). */
  plan: DecorationPlan;
  raster: Raster;
  /** The provider input: the base image as PNG, and its checksum. */
  png: Buffer;
  checksum: string;
  /** Decorations the base kept beyond its plan (its localized items). */
  keptRegions: NormalizedBox[];
  /** The base attempt's judge result (per-placement presence for the product links). */
  judge: JudgeResult | null;
}

/** A localized keep-mask for one `source` attempt, with the judge hints it implies. */
interface LocalizedComposite {
  mask: CompositeMask;
  keptRegions: NormalizedBox[];
  hints: string[];
  /** House numbers left open: the deterministic comparison skips them. */
  openHouseNumbers: NormalizedBox[];
}

/** One judge call's result before it is recorded. */
interface JudgeCall {
  result: JudgeResult;
  refused: boolean;
  call: VisionCallResult<JudgeResult> | null;
}

/**
 * Where a relight-mode job's own decorated base is stored when it is not published (a bright job
 * always; an evening job in pre-delivery review).
 */
const RELIGHT_BASE_FILE = 'relight-base.png';

/**
 * Failures of a relight (its edit, decoding its output, its judge) after which a bright job
 * delivers its decorated base and an evening job that decorated its own base ends with it as the
 * daylight variant.
 */
const RELIGHT_FALLBACK_FAILURES: readonly FailureKind[] = ['provider_error', 'timeout'];

/**
 * What a job's `repair_constraints` carries between its attempts: the derived repair of a
 * rejected decorate attempt (with the codes and verdict that rejected it); the decorated base the
 * next attempt relights (with the verdict that accepted it, and for a repaired base the codes and
 * verdict that rejected the first one); or, with `relight`, the codes of a
 * rejected relight that the next attempt repairs (keeping the base and its verdict when the job
 * decorated that base itself).
 */
interface StoredAttemptState {
  constraints?: unknown;
  adjustments?: unknown;
  codes?: FailureCode[];
  verdict?: AttemptVerdict['verdict'];
  relight?: boolean;
  relightBase?: unknown;
  baseVerdict?: AttemptVerdict['verdict'];
}

function sameItem(a: LocalizedAdditionRecord, b: LocalizedAdditionRecord): boolean {
  return a.label === b.label && a.placementId === b.placementId && a.box.join() === b.box.join();
}

/**
 * A checked decorate attempt: what the job needs to go on with it, and how to composite it again
 * with spots put back from the original.
 */
interface CheckedAttempt {
  attemptNo: RenderAttemptNumber;
  attempt: RenderAttempt;
  plan: DecorationPlan;
  judge: JudgeResult;
  candidate: Raster;
  verdict: AttemptVerdict;
  /** The deterministic codes of the composite as checked. */
  deterministic: FailureCode[];
  /** The decorations the composite keeps: the localized items kept, else the plan's regions. */
  decorations: NormalizedBox[];
  /**
   * Composites the attempt again exactly as it was checked, with `boxes` (grown) restored from the
   * original; null when the output was not registered.
   */
  restore: ((boxes: readonly NormalizedBox[]) => Promise<CompositeResult>) | null;
}

/**
 * A decorate attempt kept in memory while its repair runs (never across a redelivery), as the
 * job's picture should the repair end without an accepted one: a deliverable doubt (`doubt`); an
 * attempt rejected only because a repair was open, kept with the passing verdict it has with no
 * repair after it, its confident majors recorded (`passing`); or a rejected attempt whose objected
 * spots qualify for the last resort (`objected`). An attempt is kept as one of them, in that order.
 */
interface KeptAttempt {
  checked: CheckedAttempt;
  as: 'doubt' | 'passing' | 'objected';
}

interface PlannedRun {
  plan: DecorationPlan;
  request: CompiledRequest;
  mask: CompositeMask | null;
  maskPng: Buffer | null;
  placementKeys: Record<string, string>;
  archetypes: Record<string, string | null>;
}

/** Executes one render job through the normative state machine (render spec, lifecycle). */
export async function runRenderJob(
  deps: PipelineDeps,
  input: RenderJobInput,
): Promise<RenderJobResult> {
  return new RenderRun(deps, input).execute();
}

class RenderRun {
  private readonly options: PipelineOptions;
  private readonly controller = new AbortController();
  private deadline: NodeJS.Timeout | null = null;
  private deadlineHit = false;
  private job!: RenderJob;
  private project!: Project;
  private source!: SourceAsset;
  private roles: UserRole[] = [];
  private legs!: ProviderLegs;
  private permission!: AssetPermission;
  private loaded!: LoadedSource;
  /** The image every attempt works on: the frame, or its accepted enhancement. */
  private working!: WorkingImage;
  /** The source on the working grid as loaded (for Street View, Google's frame). */
  private frame!: WorkingImage;
  private fixture!: SourceFixtureContext;
  /** Embedded attribution rectangles on the working grid (restored and checked verbatim). */
  private attributionRegions: NormalizedBox[] = [];
  private analysis!: SceneAnalysis;
  private sceneAnalysisId!: string;
  private sceneType!: SceneType;
  private buildingForm: BuildingForm | null = null;
  private roomType: RoomType | null = null;
  private pack: HolidayPack | null = null;
  private kitRow: StyleKitRow | null = null;
  private kitAttributes = new Map<string, SpecAttributes>();
  private planned: PlannedRun | null = null;
  private rawOutput: Uint8Array | null = null;
  /** The decorated base of the current relight, once loaded. */
  private relightInput: RelightInput | null = null;
  /** This job's own accepted decorated base, when a relight-mode job rendered it first. */
  private baseComposite: { attemptId: string; raster: Raster } | null = null;
  /** Median luma of the working image's content area, once measured. */
  private contentLuma: number | null = null;
  /** The decorate attempt kept while its repair runs (`KeptAttempt`). */
  private kept: KeptAttempt | null = null;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly input: RenderJobInput,
  ) {
    this.options = pipelineOptions(deps);
    input.signal?.addEventListener('abort', () => this.controller.abort(), { once: true });
    if (input.signal?.aborted) this.controller.abort();
  }

  private get signal(): AbortSignal {
    return this.controller.signal;
  }

  private get log() {
    return this.deps.logger.child({ renderJobId: this.input.renderJobId });
  }

  private now(): Date {
    return this.deps.clock.now();
  }

  async execute(): Promise<RenderJobResult> {
    const job = await readJob(this.deps.db, this.input.renderJobId);
    if (!job) {
      this.log.warn('render job not found');
      return { state: 'missing', stopped: true };
    }
    this.job = job;
    if (isTerminalRenderJobState(job.state) || job.state === 'needs_review') {
      return { state: job.state, stopped: true };
    }
    try {
      await this.lease();
      await this.prepare();
      await this.analyze();
      await this.runAttempts();
      return { state: this.job.state, stopped: false };
    } catch (error) {
      return await this.handleError(error);
    } finally {
      if (this.deadline) clearTimeout(this.deadline);
    }
  }

  // ---- transitions ---------------------------------------------------------------------------

  private async advance(to: RenderJobState, patch: JobPatch = {}): Promise<void> {
    this.job = await transitionJob(this.deps.db, {
      jobId: this.job.id,
      from: this.job.state,
      to,
      patch,
      clock: this.deps.clock,
    });
  }

  /** Re-reads the job before a stage; a job another actor ended stops the run. */
  private async ensureActive(): Promise<void> {
    const current = await readJob(this.deps.db, this.job.id);
    if (!current || isTerminalRenderJobState(current.state)) throw new RunStopped();
    this.job = current;
    if (this.signal.aborted) throw new JobAborted(this.deadlineHit ? 'deadline' : 'signal');
  }

  private checkAbort(): void {
    if (this.signal.aborted) throw new JobAborted(this.deadlineHit ? 'deadline' : 'signal');
  }

  // ---- queued → preparing --------------------------------------------------------------------

  private async lease(): Promise<void> {
    const project = await this.deps.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', this.job.projectId)
      .executeTakeFirst();
    if (!project || project.deletedAt) {
      await this.endBy('canceled');
      throw new RunStopped();
    }
    this.project = project;
    if (this.job.state === 'queued') {
      if (project.projectVersion !== this.job.projectVersion) {
        await this.endBy('superseded');
        throw new RunStopped();
      }
      await this.advance('preparing', { startedAt: this.now() });
    }
    const started = (this.job.startedAt ?? this.now()).getTime();
    const remaining = started + this.options.maxJobDurationMs - this.now().getTime();
    if (remaining <= 0) throw new JobFailure('timeout');
    this.deadline = setTimeout(() => {
      this.deadlineHit = true;
      this.controller.abort();
    }, remaining);
    this.deadline.unref?.();
  }

  /** Ends a job the worker found canceled-in-effect (project deleted) or superseded. */
  private async endBy(state: 'canceled' | 'superseded'): Promise<void> {
    try {
      await this.advance(state);
      await releaseRemaining(this.deps.db, this.job.id, this.deps.clock);
      await emitServerEvent(this.deps.db, this.deps, {
        name: state === 'canceled' ? 'render_canceled' : 'render_superseded',
        ownerId: this.job.ownerId,
        holidayId: this.job.holidayId,
        fixture: true,
        properties:
          state === 'canceled'
            ? { stateAtCancel: 'queued', elapsedMs: 0 }
            : { stateAtSupersede: 'queued', elapsedMs: 0, attemptInFlight: false },
      });
    } catch (error) {
      if (!(error instanceof LostRaceError)) throw error;
    }
  }

  // ---- preparing -----------------------------------------------------------------------------

  private snapshot(): RenderInputSnapshot {
    const parsed = RenderInputSnapshotSchema.safeParse(this.job.inputSnapshot ?? {});
    return parsed.success ? parsed.data : {};
  }

  private async evaluate(stage: 'preparing' | 'analyzing' | 'rendering' | 'checking') {
    if (!this.source.assetPolicyId) throw new JobFailure('policy_denied');
    const capabilityState = await capabilityStateFor(this.deps, aiCapabilityFor(this.source.kind));
    if (!capabilityState) throw new JobFailure('policy_denied');
    const result = await evaluateAndRecord(this.deps.db, {
      assetPolicyId: this.source.assetPolicyId,
      sourceAssetId: this.source.id,
      context: 'pre_call',
      capabilityState,
      ...permissionSettingsOf(this.deps.config),
      sourceKind: this.source.kind,
      isGoogleImagery: this.source.isGoogleImagery,
      copyright: this.source.copyright,
      jobId: this.job.id,
      stage,
      clock: this.deps.clock,
    });
    this.permission = result.permission;
    return result;
  }

  private async prepare(): Promise<void> {
    await this.ensureActive();
    let source = await this.deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', this.job.sourceAssetId)
      .executeTakeFirst();
    if (!source || source.deletedAt || source.state !== 'ready') {
      throw new JobFailure('source_unavailable');
    }
    this.source = source;
    const user = await this.deps.db
      .selectFrom('users')
      .select('roles')
      .where('ownerId', '=', this.job.ownerId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    this.roles = user?.roles ?? [];
    this.legs = await providerLegsFor(this.deps, source.kind, this.roles);
    if (this.legs.mode === 'unavailable' || this.legs.visionMode === 'unavailable') {
      throw new JobFailure('policy_denied');
    }

    const snapshot = this.snapshot();
    this.sceneType =
      snapshot.sceneType ??
      source.sceneType ??
      (source.kind === 'street_view' ? 'house_exterior' : 'house_exterior');
    this.buildingForm = snapshot.buildingForm ?? source.buildingForm ?? null;
    this.roomType = snapshot.roomType ?? source.roomType ?? null;

    const { permission } = await this.evaluate('preparing');
    if (!isEditable(permission)) throw new JobFailure('policy_denied');
    this.checkAbort();

    if (source.kind === 'street_view') {
      await this.assertNotPaused(this.legs.mode === 'live' ? 'google' : 'fixture');
      // A place on the opt-out list is never decorated, also by a job queued before the block.
      if (await isPropertyBlocked(this.deps.db, this.project.propertyId, this.now())) {
        throw new JobFailure('source_rejected', null, 'Place is on the opt-out list');
      }
    }
    this.loaded = await loadSourcePixels(this.deps, {
      job: this.job,
      source,
      permission,
      legs: this.legs,
      signal: this.signal,
    });
    this.checkAbort();
    // A Street View source with no framing recorded is zoomed in on its home here; the job goes on
    // with the frame and the source row as they stand afterwards.
    const framed = await frameStreetViewSource(this.deps, {
      job: this.job,
      source,
      loaded: this.loaded,
      permission,
      legs: this.legs,
      sceneType: this.sceneType,
      signal: this.signal,
      log: this.log,
      checkAbort: () => this.checkAbort(),
      isPaused: (provider) => this.isPaused(provider),
      visionProvider: () => this.visionProvider(),
    });
    this.loaded = framed.loaded;
    this.source = framed.source;
    source = framed.source;
    this.checkAbort();
    await this.useLoadedFrame(source, permission);
    if (this.job.state === 'preparing') await this.advance('analyzing');
  }

  /**
   * Makes the loaded frame the job's working image: decoded onto the working grid, stored where
   * the source may be stored (never `transient`), and recorded on the job row.
   */
  private async useLoadedFrame(source: SourceAsset, permission: AssetPermission): Promise<void> {
    try {
      this.working = await prepareWorkingImage(this.loaded.bytes, source.kind);
    } catch {
      throw new JobFailure('source_unavailable', null, 'source image could not be decoded');
    }
    this.frame = this.working;
    this.fixture = fixtureContextFor(source, this.deps.content, {
      width: this.working.width,
      height: this.working.height,
    });
    this.attributionRegions = this.attributionRegionsOf(source);

    // Working images are stored only where the source may be stored (never `transient`).
    let workingObjectKey: string | null = null;
    if (this.loaded.streetViewMode !== 'transient') {
      workingObjectKey = keys.working(this.job.id, 'working.png');
      await this.deps.storage.put({
        bucket: 'private',
        key: workingObjectKey,
        body: this.working.png,
        contentType: 'image/png',
        provenance: { sourceKind: source.kind, permission },
      });
    }
    // Past `analyzing` the job has committed the checksum of the image its attempts use.
    const uncommitted = this.job.state === 'preparing' || this.job.state === 'analyzing';
    await this.deps.db
      .updateTable('renderJobs')
      .set({
        workingWidth: this.working.width,
        workingHeight: this.working.height,
        ...(uncommitted ? { workingChecksumSha256: this.working.checksum } : {}),
        resampler: this.working.resampler,
        workingCropBox: this.working.cropBox ? toJson(this.working.cropBox) : null,
        workingPadBox: this.working.contentBox ? toJson(this.working.contentBox) : null,
        scaleFactor: Math.min(99.999, this.working.scaleFactor),
        workingObjectKey,
      })
      .where('id', '=', this.job.id)
      .execute();
  }

  /**
   * The embedded attribution rectangles of a source on the working grid: for a live Street View
   * frame, the rectangles configured for its requested size (`STREET_VIEW_ATTRIBUTION_REGIONS`,
   * normalized to the Static image), the copyright label's widened for the frame's own copyright
   * line when the imagery is not attributed to Google (`copyrightLabelRegions`), mapped through
   * the aspect crop and the padding; for a fixture
   * Street View frame, the rectangle its renderer drew. An upload (or a fixture source that is not
   * a Street View frame) whose picture is a whole Street View Static frame carrying both marks
   * gets the rectangles configured for its native size (`embeddedAttributionRegions`, decided
   * from the working image's own pixels); the source row stays an upload. Other sources have none.
   */
  private attributionRegionsOf(source: SourceAsset): NormalizedBox[] {
    if (source.kind === 'upload' || (source.kind === 'fixture' && !source.viewpoint)) {
      return embeddedAttributionRegions(
        this.working,
        this.deps.config.streetView.attributionRegions,
      );
    }
    if (source.kind === 'street_view' && this.legs.mode === 'live') {
      const viewpoint = source.viewpoint;
      if (!viewpoint) return [];
      const configured =
        this.deps.config.streetView.attributionRegions[`${viewpoint.width}x${viewpoint.height}`];
      if (!configured) return [];
      const fitted = copyrightLabelRegions(configured, {
        frameWidth: viewpoint.width,
        copyright: source.copyright,
        isGoogleImagery: source.isGoogleImagery,
      });
      return nativeBoxesOnWorkingGrid(fitted, this.working);
    }
    if (source.kind === 'street_view' || (source.kind === 'fixture' && source.viewpoint)) {
      const region = fixtureAttributionRegion(this.fixture);
      return region ? [region] : [];
    }
    return [];
  }

  // ---- kill switches ---------------------------------------------------------------------------

  /** The provider name the kill switches use for the vision leg. */
  private visionProvider(): string {
    return this.legs.vision.mode === 'live' ? this.deps.config.providers.vision : 'fixture';
  }

  /** Whether the global pause or the provider's own pause stops paid work right now. */
  private async isPaused(provider: string): Promise<boolean> {
    if (await this.deps.settings.get('pause.global')) return true;
    return this.deps.settings.isProviderPaused(provider);
  }

  /**
   * The worker's kill-switch check before every provider call (data-and-api, allowance, quotas
   * and rate limits): a paused job stops without the call and fails `provider_error`; its unused
   * reservations are released.
   */
  private async assertNotPaused(provider: string): Promise<void> {
    if (!(await this.isPaused(provider))) return;
    this.log.warn({ provider }, 'paid work paused; the job stops before the provider call');
    throw new JobFailure('provider_error', null, 'paused');
  }

  // ---- analyzing -----------------------------------------------------------------------------

  private analysisModel(): string {
    return this.legs.vision.mode === 'fixture'
      ? FIXTURE_VISION_MODEL
      : this.deps.config.anthropic.visionModel;
  }

  private async withVisionRetries<T>(call: () => Promise<T>): Promise<T> {
    for (let retry = 0; ; retry += 1) {
      try {
        return await call();
      } catch (error) {
        const retryable = isProviderError(error) && error.retryable;
        if (!retryable || retry >= this.options.transportRetryLimit || this.signal.aborted) {
          throw error;
        }
        await sleep(this.options.retryDelayMs(retry + 1), this.signal);
      }
    }
  }

  /**
   * Declines the source while it is `ready`. A refusal that holds for every run of the source (its
   * owner's blur, a provider's refusal of the picture) declines it whatever became of the run's
   * job. With `whileActive` (a refusal a later run may answer by taking a framing back) it
   * declines only while the run's job is still active: a job another actor ended (canceled,
   * superseded) declines nothing, the run stops, and the job that replaced it decides.
   */
  private async declineSource(
    reason: 'provider_refused' | null,
    extra: { providerRefusedAt?: Date } = {},
    options: { whileActive?: boolean } = {},
  ): Promise<void> {
    const declined = await this.deps.db
      .updateTable('sourceAssets')
      .set({
        state: 'declined',
        ...(reason
          ? {
              declinedCode: 'UPLOAD_DECLINED' as const,
              declinedReasonClass: 'safety' as const,
              declinedReason: reason,
            }
          : {}),
        ...extra,
      })
      .where('id', '=', this.source.id)
      .where('state', '=', 'ready')
      .$if(options.whileActive === true, (query) =>
        query.where((eb) =>
          eb.exists(
            eb
              .selectFrom('renderJobs')
              .select('renderJobs.id')
              .where('renderJobs.id', '=', this.job.id)
              .where('renderJobs.state', 'not in', [...TERMINAL_RENDER_JOB_STATES]),
          ),
        ),
      )
      .executeTakeFirst();
    if (!options.whileActive || declined.numUpdatedRows > 0n) return;
    const current = await readJob(this.deps.db, this.job.id);
    if (!current || isTerminalRenderJobState(current.state)) throw new RunStopped();
  }

  private async analyze(): Promise<void> {
    await this.ensureActive();
    const model = this.analysisModel();
    const existing = await this.deps.db
      .selectFrom('sceneAnalyses')
      .selectAll()
      .where('sourceAssetId', '=', this.source.id)
      .where('analysisModel', '=', model)
      .where('analysisPromptVersion', '=', ANALYSIS_PROMPT_VERSION)
      .where('workingWidth', '=', this.working.width)
      .where('workingHeight', '=', this.working.height)
      .where('workingChecksumSha256', '=', this.working.checksum)
      .executeTakeFirst();
    if (existing) {
      this.analysis = SceneAnalysisSchema.parse(existing.document);
      this.sceneAnalysisId = existing.id;
      const reservation = await findVisionReservation(this.deps.db, this.job.id, 'analysis');
      if (reservation) await release(this.deps.db, reservation.id, this.deps.clock);
    } else {
      const { permission } = await this.evaluate('analyzing');
      if (!permission.aiProcess) throw new JobFailure('policy_denied');
      await this.assertNotPaused(this.visionProvider());
      let result: VisionCallResult<SceneAnalysis>;
      try {
        result = await this.withVisionRetries(() =>
          this.legs.vision.analyzeScene(
            {
              image: {
                bytes: this.working.png,
                width: this.working.width,
                height: this.working.height,
                checksum: this.working.checksum,
              },
              sourceAssetId: this.source.id,
              sourceKind: this.source.kind,
              sceneType: this.sceneType,
              buildingForm: this.buildingForm,
              roomType: this.roomType,
              fixture: this.fixture.hint,
            },
            { signal: this.signal, timeoutMs: this.options.analysisTimeoutMs },
          ),
        );
      } catch (error) {
        this.checkAbort();
        if (isProviderError(error) && error.kind === 'moderation_blocked') {
          await this.declineSource('provider_refused', { providerRefusedAt: this.now() });
          throw new JobFailure('moderation_blocked');
        }
        throw new JobFailure('provider_error', null, 'scene analysis failed');
      }
      // Padding added for the aspect is protected: nothing is ever placed on it.
      const analysis: SceneAnalysis = {
        ...result.result,
        protectedBlurRegions: [
          ...result.result.protectedBlurRegions,
          ...this.working.padRegions.map((box) => ({ kind: 'other' as const, box })),
        ],
      };
      const reservation = await findVisionReservation(this.deps.db, this.job.id, 'analysis');
      const ledgerEntryId = await settleCall(this.deps.db, {
        reservation,
        jobId: this.job.id,
        ownerId: this.job.ownerId,
        projectId: this.job.projectId,
        provider: this.visionProvider(),
        sku: 'vision_call',
        stage: 'analyzing',
        units: 1,
        unitPriceMicros:
          usageCostMicros(result.model, visionUsage(result)) ?? VISION_PRICES_MICROS.analysis,
        modelId: result.model,
        isFixture: result.providerMode === 'fixture',
        clock: this.deps.clock,
      });
      await this.deps.db
        .insertInto('sceneAnalyses')
        .values({
          id: newId(),
          sourceAssetId: this.source.id,
          analysisModel: model,
          analysisPromptVersion: ANALYSIS_PROMPT_VERSION,
          schemaVersion: analysis.schemaVersion,
          workingWidth: this.working.width,
          workingHeight: this.working.height,
          workingChecksumSha256: this.working.checksum,
          document: toJson(analysis),
          sceneTypeMismatch: analysis.sceneTypeMismatch,
          firstJobId: this.job.id,
          ledgerEntryId,
          usage: toJson(result.usage),
        })
        .onConflict((oc) =>
          oc
            .columns([
              'sourceAssetId',
              'analysisModel',
              'analysisPromptVersion',
              'workingWidth',
              'workingHeight',
              'workingChecksumSha256',
            ])
            .doNothing(),
        )
        .execute();
      const row = await this.deps.db
        .selectFrom('sceneAnalyses')
        .select(['id', 'document'])
        .where('sourceAssetId', '=', this.source.id)
        .where('analysisModel', '=', model)
        .where('analysisPromptVersion', '=', ANALYSIS_PROMPT_VERSION)
        .where('workingChecksumSha256', '=', this.working.checksum)
        .where('workingWidth', '=', this.working.width)
        .where('workingHeight', '=', this.working.height)
        .executeTakeFirstOrThrow();
      this.analysis = SceneAnalysisSchema.parse(row.document);
      this.sceneAnalysisId = row.id;
    }
    await this.deps.db
      .updateTable('renderJobs')
      .set({ sceneAnalysisId: this.sceneAnalysisId })
      .where('id', '=', this.job.id)
      .execute();
    if (await this.takeBackRefusedFraming()) return this.analyze();
    await this.sourceChecks();
    if (this.job.state === 'analyzing') {
      const result = await resolveEnhancement(this.enhanceContext());
      if (result.working) {
        this.working = result.working;
        this.contentLuma = null;
      }
      await this.advance('planning', {
        workingChecksumSha256: this.working.checksum,
        enhancement: result.record ? toJson(result.record) : null,
      });
    } else {
      await this.restoreEnhancedWorking();
    }
  }

  /**
   * An analysis that finds no single home in a framed frame takes the framing back
   * (`keepWideFrame`, decided from the source row): the run's frame becomes the wide frame again,
   * which is then analyzed from the start. False when nothing was taken back (the source checks
   * decide as before). A job no longer active stops the run, which then neither fetches nor
   * declines.
   */
  private async takeBackRefusedFraming(): Promise<boolean> {
    const refused = !this.analysis.targetFacade || this.analysis.targetFacadeAmbiguous;
    if (!refused || this.sceneType !== 'house_exterior') return false;
    const wide = await keepWideFrame(this.deps, {
      job: this.job,
      source: this.source,
      loaded: this.loaded,
      permission: this.permission,
      legs: this.legs,
      sceneType: this.sceneType,
      signal: this.signal,
      log: this.log,
      checkAbort: () => this.checkAbort(),
      isPaused: (provider) => this.isPaused(provider),
      visionProvider: () => this.visionProvider(),
    });
    if (wide.outcome === 'stopped') throw new RunStopped();
    if (wide.outcome === 'refused') return false;
    this.loaded = wide.loaded;
    this.source = wide.source;
    this.contentLuma = null;
    await this.useLoadedFrame(wide.source, this.permission);
    return true;
  }

  /** What the enhancement step needs from this run. */
  private enhanceContext(): EnhanceContext {
    return {
      deps: this.deps,
      options: this.options,
      job: this.job,
      project: this.project,
      source: this.source,
      legs: this.legs,
      frame: this.frame,
      loaded: this.loaded,
      analysis: this.analysis,
      sceneType: this.sceneType,
      attributionRegions: this.attributionRegions,
      fixtureHint: this.fixture.hint,
      signal: this.signal,
      deadlineHit: () => this.deadlineHit,
      now: () => this.now(),
      log: this.log,
      permission: () => this.permission,
      evaluate: (stage) => this.evaluate(stage),
      isPaused: (provider) => this.isPaused(provider),
      visionProvider: () => this.visionProvider(),
      compilerFamily: () => this.compilerFamily(),
      modelSnapshot: () => this.modelSnapshot(),
      providerMode: () => this.providerMode(),
      withVisionRetries: (call) => this.withVisionRetries(call),
    };
  }

  /**
   * A job redelivered past `analyzing` whose record says it uses an enhancement (`made` or
   * `reused`) works on that picture again: the row must still be accepted with the job's working
   * checksum and its picture intact, else the job fails `source_unavailable` (the frame and its
   * enhancement were removed while the job ran).
   */
  private async restoreEnhancedWorking(): Promise<void> {
    const parsed = JobEnhancementRecordSchema.safeParse(this.job.enhancement);
    const used: JobEnhancementRecord | null =
      parsed.success && (parsed.data.outcome === 'made' || parsed.data.outcome === 'reused')
        ? parsed.data
        : null;
    if (!used) return;
    const row = used.enhancementId
      ? await this.deps.db
          .selectFrom('sourceEnhancements')
          .selectAll()
          .where('id', '=', used.enhancementId)
          .executeTakeFirst()
      : undefined;
    const working =
      row &&
      row.status === 'accepted' &&
      row.enhancedChecksumSha256 !== null &&
      row.enhancedChecksumSha256 === this.job.workingChecksumSha256
        ? await loadEnhancedWorking(this.deps, { row, frame: this.frame })
        : null;
    if (!working) {
      throw new JobFailure('source_unavailable', null, 'enhanced working image unavailable');
    }
    this.working = working;
    this.contentLuma = null;
  }

  /** Street View refusals before any paid edit (render spec rule 4a; address spec blur rules). */
  private async sourceChecks(): Promise<void> {
    const analysis = this.analysis;
    const streetView = this.source.kind === 'street_view';
    if (streetView && this.sceneType === 'house_exterior') {
      const facade = analysis.targetFacade;
      if (!facade || analysis.targetFacadeAmbiguous) {
        await this.declineSource(null, {}, { whileActive: true });
        throw new JobFailure('source_rejected', 'facade_not_in_frame');
      }
      const coverage = Math.max(
        0,
        ...analysis.protectedBlurRegions
          .filter((region) => region.kind === 'house')
          .map((region) => {
            const [x0, y0, x1, y1] = region.box;
            const ix = Math.max(0, Math.min(x1, facade[2]) - Math.max(x0, facade[0]));
            const iy = Math.max(0, Math.min(y1, facade[3]) - Math.max(y0, facade[1]));
            const area = (facade[2] - facade[0]) * (facade[3] - facade[1]);
            return area > 0 ? (ix * iy) / area : 0;
          }),
      );
      if (coverage >= 0.5) {
        await this.declineSource(null);
        await this.flagOwnerBlur();
        throw new JobFailure('source_rejected', 'owner_blurred');
      }
    }
    const skip = this.relightSkip();
    if (skip) {
      this.log.info(
        skip,
        skip.reason === 'not_daylight'
          ? 'evening requested for a photo that is not in daylight; decorating it as photographed'
          : 'bright requested for a photo that is already bright; decorating it as photographed',
      );
    }
  }

  /** The relit look this job renders (`evening` or `bright`), or null for `source`. */
  private relightTarget(): RelightLightingMode | null {
    return isRelightLightingMode(this.job.lightingMode) ? this.job.lightingMode : null;
  }

  /** Median luma of the working image over its content area (padding excluded). */
  private photoMedianLuma(): number {
    this.contentLuma ??= medianLuma(this.working.raster, this.working.contentBox);
    return this.contentLuma;
  }

  /**
   * Why this relight-mode job decorates the photo in its own light and delivers that as its
   * result, with no relight (and no daylight companion): an evening look of a photo the scene
   * analysis reports is not in daylight (dusk or night), or a bright look of a photo that is
   * already bright (median luma over its content area at or above
   * `PIPELINE_DEFAULTS.brightMedianLuma`). Null when the job relights or is not a relight mode.
   */
  private relightSkip(): RelightSkippedRecord | null {
    const target = this.relightTarget();
    if (target === 'evening' && !this.analysis.lighting.isDaylight) {
      return {
        kind: 'relight_skipped',
        reason: 'not_daylight',
        timeOfDay: this.analysis.lighting.timeOfDay,
      };
    }
    if (target === 'bright') {
      const luma = this.photoMedianLuma();
      const threshold = PIPELINE_DEFAULTS.brightMedianLuma;
      if (luma >= threshold) {
        return { kind: 'relight_skipped', reason: 'already_bright', medianLuma: luma, threshold };
      }
    }
    return null;
  }

  /** Whether this job decorates a base and relights it (a relight mode that is not skipped). */
  private relights(): boolean {
    return this.relightTarget() !== null && this.relightSkip() === null;
  }

  /** The attempt state stored on the job between attempts. */
  private storedState(): StoredAttemptState {
    return (this.job.repairConstraints ?? {}) as StoredAttemptState;
  }

  /** The `render_attempts.fallback` record of an attempt of this job, when it has one. */
  private attemptRecord(plan: DecorationPlan): Record<string, unknown> | null {
    if (plan.relightOf)
      return { kind: 'relight', ...plan.relightOf } satisfies RelightAttemptRecord;
    return this.relightSkip();
  }

  private async flagOwnerBlur(): Promise<void> {
    if (!this.project.propertyId) return;
    const now = this.now();
    const property = await this.deps.db
      .updateTable('properties')
      .set({ ownerBlurDetectedAt: now })
      .where('id', '=', this.project.propertyId)
      .returning('placeId')
      .executeTakeFirst();
    if (!property) return;
    // An active block keeps its own record; a removed or expired one is listed again as this
    // detection.
    const evidenceRef = `render_job:${this.job.id}`;
    await this.deps.db
      .insertInto('blockedAddresses')
      .values({
        id: newId(),
        placeId: property.placeId,
        source: 'google_blur_detected',
        evidenceRef,
        createdBy: null,
      })
      .onConflict((oc) =>
        oc
          .column('placeId')
          .doUpdateSet({
            removedAt: null,
            expiresAt: null,
            source: 'google_blur_detected',
            evidenceRef,
            createdBy: null,
            reportId: null,
          })
          .where((eb) =>
            eb.or([
              eb('blockedAddresses.removedAt', 'is not', null),
              eb('blockedAddresses.expiresAt', '<=', now),
            ]),
          ),
      )
      .execute();
  }

  // ---- planning, rendering, checking ---------------------------------------------------------

  private async runAttempts(): Promise<void> {
    const attempts = await this.attemptRows();
    let attemptNo: RenderAttemptNumber;
    const latest = attempts[attempts.length - 1];
    if (this.job.state === 'planning') {
      attemptNo =
        latest && latest.outcome === 'pending' && !latest.providerOperationId
          ? (latest.attemptNo as RenderAttemptNumber)
          : (Math.min(MAX_RENDER_ATTEMPTS, attempts.length + 1) as RenderAttemptNumber);
    } else {
      attemptNo = (latest?.attemptNo ?? 1) as RenderAttemptNumber;
    }
    for (;;) {
      if (this.job.state === 'planning') {
        try {
          await this.planAttempt(attemptNo);
        } catch (error) {
          if (error instanceof AttemptCapReached) {
            if (await this.deliverBaseAfterRefusedRelight(attemptNo)) return;
          }
          if (await this.goOnWithKeptAfterFailedRepair(attemptNo, error)) return;
          throw error;
        }
      }
      if (this.job.state === 'rendering') {
        try {
          await this.renderAttempt(attemptNo);
        } catch (error) {
          if (await this.deliverBaseAfterFailedRelight(attemptNo, error)) return;
          if (await this.goOnWithKeptAfterFailedRepair(attemptNo, error)) return;
          throw error;
        }
      }
      if (this.job.state === 'checking') {
        let next: 'next' | 'done';
        try {
          next = await this.checkAttempt(attemptNo);
        } catch (error) {
          if (await this.deliverBaseAfterFailedRelight(attemptNo, error)) return;
          if (await this.goOnWithKeptAfterFailedRepair(attemptNo, error)) return;
          throw error;
        }
        if (next === 'next') {
          if (attemptNo >= MAX_RENDER_ATTEMPTS) {
            throw new JobFailure('internal_error', null, 'no attempt left');
          }
          attemptNo = (attemptNo + 1) as RenderAttemptNumber;
          this.planned = null;
          this.rawOutput = null;
          continue;
        }
      }
      return;
    }
  }

  private async attemptRows(): Promise<RenderAttempt[]> {
    return this.deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', this.job.id)
      .orderBy('attemptNo')
      .execute();
  }

  private async loadContent(): Promise<{ pack: HolidayPack; kit: StyleKitRow }> {
    if (this.pack && this.kitRow) return { pack: this.pack, kit: this.kitRow };
    const version = await this.deps.db
      .selectFrom('holidayPackVersions')
      .selectAll()
      .where('holidayId', '=', this.job.holidayId)
      .where('region', '=', 'US')
      .where('version', '=', this.job.holidayPackVersion)
      .executeTakeFirst();
    if (!version) throw new JobFailure('internal_error', null, 'pack version not published');
    const cacheKey = `${version.contentRef}:${version.contentSha256}`;
    let pack = packCache.get(cacheKey);
    if (!pack) {
      try {
        pack = await readPackByRef(version.contentRef, {
          dir: this.deps.content.dir,
          expectedSha256: version.contentSha256,
        });
      } catch {
        // Local content edited after publication: use the loaded content for that version.
        const loaded = this.deps.content.packFor(this.job.holidayId);
        if (!loaded || loaded.version !== this.job.holidayPackVersion) {
          throw new JobFailure('internal_error', null, 'pack content unavailable');
        }
        pack = loaded.pack;
      }
      packCache.set(cacheKey, pack);
    }
    const snapshot = this.snapshot();
    const kitKey = `${this.job.holidayId}.${this.sceneType}`;
    const kit =
      (snapshot.styleKitVersionId
        ? await this.deps.db
            .selectFrom('styleKits')
            .selectAll()
            .where('id', '=', snapshot.styleKitVersionId)
            .executeTakeFirst()
        : undefined) ??
      (await this.deps.db
        .selectFrom('styleKits')
        .selectAll()
        .where('kitKey', '=', kitKey)
        .where('version', '=', this.job.holidayPackVersion)
        .executeTakeFirst()) ??
      (await this.deps.db
        .selectFrom('styleKits')
        .selectAll()
        .where('kitKey', '=', kitKey)
        .where('status', '=', 'published')
        .executeTakeFirst());
    if (!kit) throw new JobFailure('internal_error', null, 'style kit not published');
    const items = await this.deps.db
      .selectFrom('kitItems')
      .select(['kitItemId', 'specAttributes'])
      .where('kitId', '=', kit.id)
      .execute();
    for (const item of items) {
      const parsed = SpecAttributesSchema.safeParse(item.specAttributes);
      if (parsed.success) this.kitAttributes.set(item.kitItemId, parsed.data);
    }
    this.pack = pack;
    this.kitRow = kit;
    return { pack, kit };
  }

  /**
   * The attempt's composite mask: bands at the band dilation, boxes at `dilationFraction`; a
   * repair's restore boxes are excluded so their pixels stay the original's. Text marks are grown
   * unless the decisions of the edited output (`textMarks`) say otherwise.
   */
  private maskFor(
    placements: readonly Pick<
      DecorationPlan['placements'][number],
      'anchorId' | 'placementRule' | 'region' | 'maskShapes'
    >[],
    dilationFraction: number,
    restoreBoxes: readonly NormalizedBox[] = [],
    textMarks?: readonly TextMarkModeOf[],
  ): CompositeMask {
    return renderCompositeMask({
      analysis: this.analysis,
      placements,
      width: this.working.width,
      height: this.working.height,
      padRegions: this.working.padRegions,
      attributionRegions: this.attributionRegions,
      dilationFraction,
      bandDilationFraction: PIPELINE_DEFAULTS.bandDilationFraction,
      featherFraction: this.options.featherFraction,
      restoreBoxes,
      ...(textMarks ? { textMarks } : {}),
    });
  }

  /**
   * The lighting a decorate attempt is planned and composited in: always `source`. A relight-mode
   * job (`evening`, `bright`) relights a decorated base: an accepted daylight variant (evening), or
   * the base it renders itself first.
   */
  private attemptLighting(): LightingMode {
    return 'source';
  }

  private repairInput(): RepairInput | null {
    const stored = this.storedState();
    if (!stored.constraints || !stored.adjustments) return null;
    return stored as unknown as RepairInput;
  }

  private compilerFamily() {
    return this.legs.imageEditor.mode === 'fixture'
      ? 'fixture'
      : compilerProviderFor(this.legs.imageEditor.providerId);
  }

  private modelSnapshot(): string {
    const family = this.compilerFamily();
    if (family === 'openai') return this.deps.config.openai.imageModel;
    if (family === 'gemini') return this.deps.config.gemini.imageModel;
    return FIXTURE_COMPOSITOR_VERSION;
  }

  private providerMode(): ProviderMode {
    return this.legs.imageEditor.mode === 'fixture' ? 'fixture' : 'live';
  }

  private async planAttempt(attemptNo: RenderAttemptNumber): Promise<void> {
    await this.ensureActive();
    const { pack, kit } = await this.loadContent();
    const existingPlan = await this.deps.db
      .selectFrom('decorationPlans')
      .selectAll()
      .where('jobId', '=', this.job.id)
      .where('attemptNo', '=', attemptNo)
      .executeTakeFirst();

    let planned: PlannedRun;
    let planRowId: string;
    const relight = !existingPlan && this.relights() ? await this.relightBaseFor(attemptNo) : null;
    if (existingPlan) {
      planned = this.restorePlanned(existingPlan.document, existingPlan.validatorResult);
      planRowId = existingPlan.id;
    } else if (relight) {
      ({ planned, planRowId } = await this.planRelight(attemptNo, relight.base, relight.codes));
    } else if (attemptNo > STANDARD_RENDER_ATTEMPTS) {
      // Only a relight is ever a third attempt.
      throw new JobFailure('internal_error', null, 'third attempt without a relight base');
    } else {
      const lighting = this.attemptLighting();
      const repair = attemptNo === 2 ? this.repairInput() : null;
      const dilation = repair?.adjustments.dilationFraction ?? this.options.dilationFraction;
      // The repair of a decorate step pastes the judge's small evidence boxes back from the
      // original (a relight has no keep-mask and never gets here).
      const restoreBoxes = repair?.adjustments.restoreBoxes ?? [];
      const masks = new Map<string, CompositeMask>();
      const maskOf = (placements: DecorationPlan['placements']) => {
        const key = placements
          .map((p) => `${p.id}:${p.region.join(',')}:${JSON.stringify(p.maskShapes ?? null)}`)
          .join('|');
        let mask = masks.get(key);
        if (!mask) {
          mask = this.maskFor(placements, dilation, restoreBoxes);
          masks.set(key, mask);
        }
        return mask;
      };
      let result;
      try {
        result = planAndCompile(
          {
            renderJobId: this.job.id,
            planVersion: attemptNo as 1 | 2,
            sourceAssetId: this.source.id,
            sceneAnalysisId: this.sceneAnalysisId,
            analysis: this.analysis,
            sourceKind: this.source.kind,
            pack,
            holidayPackVersion: this.job.holidayPackVersion,
            styleKitVersionId: kit.id,
            kitAttributes: this.kitAttributes,
            sceneType: this.sceneType,
            buildingForm: this.buildingForm,
            roomType: this.roomType,
            style: this.job.style,
            lightingMode: lighting,
            compilerVersion: this.job.compilerVersion,
            permissionEvaluationId: this.job.permissionEvaluationId,
            attributionRegion: this.attributionRegions,
            ...(this.analysis.seasonCues.snowVisible
              ? { climate: { climateClass: 'cold' as const, source: 'scene_analysis' as const } }
              : { climate: { climateClass: 'neutral' as const, source: 'neutral' as const } }),
            repair,
            options: {
              anchorFloors: this.options.anchorFloors,
              dilationFraction: dilation,
              featherFraction: this.options.featherFraction,
            },
          },
          (built) => ({
            provider: this.compilerFamily(),
            modelSnapshot: this.modelSnapshot(),
            working: {
              width: this.working.width,
              height: this.working.height,
              checksum: this.working.checksum,
            },
            mask: (() => {
              const mask = maskOf(built.draft.placements);
              return { width: mask.width, height: mask.height, checksum: mask.checksum };
            })(),
            supportsMask: this.legs.imageEditor.capabilities.supportsMask,
            lowerQuality: repair?.adjustments.lowerQuality ?? false,
            settings: this.deps.config.imageEdit,
          }),
        );
      } catch (error) {
        if (error instanceof PlanConfigurationError) {
          this.log.error({ reason: error.reason }, 'plan configuration error');
          throw new JobFailure('internal_error', null, error.message);
        }
        throw error;
      }
      if (!result.compile) {
        if (result.built.validator.failure === 'forbidden_list') {
          this.log.error(
            { events: result.built.validator.events },
            'pack forbidden-list violation',
          );
          throw new JobFailure('internal_error', null, 'forbidden list violated');
        }
        throw new JobFailure('source_rejected', 'no_usable_anchors');
      }
      const mask = lighting === 'source' ? maskOf(result.built.draft.placements) : null;
      const maskPng = mask ? await encodeMaskPng(mask.hard, mask.width, mask.height) : null;
      let maskObjectKey: string | undefined;
      if (maskPng && this.loaded.streetViewMode !== 'transient') {
        maskObjectKey = keys.working(this.job.id, `mask-${attemptNo}.png`);
        await this.deps.storage.put({
          bucket: 'private',
          key: maskObjectKey,
          body: maskPng,
          contentType: 'image/png',
          provenance: { sourceKind: this.source.kind, permission: this.permission },
        });
      }
      const plan = DecorationPlanSchema.parse({
        ...result.built.draft,
        compositeMask: {
          ...(result.built.draft.compositeMask ?? {
            dilationFraction: dilation,
            featherFraction: this.options.featherFraction,
          }),
          ...(maskObjectKey ? { objectKey: maskObjectKey } : {}),
          ...(restoreBoxes.length > 0 ? { restoreBoxes } : {}),
        },
        compiled: result.compile.compiled,
      });
      planned = {
        plan,
        request: result.compile.request,
        mask,
        maskPng,
        placementKeys: result.built.placementKeys,
        archetypes: result.built.archetypes,
      };
      planRowId = newId();
      await this.deps.db
        .insertInto('decorationPlans')
        .values({
          id: planRowId,
          jobId: this.job.id,
          attemptNo,
          sceneAnalysisId: this.sceneAnalysisId,
          packVersion: this.job.holidayPackVersion,
          styleKitId: kit.id,
          compilerVersion: this.job.compilerVersion,
          document: toJson(plan),
          validatorResult: toJson({
            ...result.built.validator,
            placementKeys: result.built.placementKeys,
            archetypes: result.built.archetypes,
            request: result.compile.request,
          }),
          compiledInstruction: result.compile.request.instructionText,
        })
        .execute();
    }
    this.planned = planned;
    // A repair is an attempt planned with repair constraints. The relight of a base this job
    // rendered itself (attempt 2, or attempt 3 after the base's repair) carries none, so it uses
    // no repair.
    const repairPlanned = (planned.plan.repairConstraints?.length ?? 0) > 0;

    // Guard: remaining time.
    const elapsed = this.now().getTime() - (this.job.startedAt ?? this.now()).getTime();
    if (elapsed >= this.options.maxJobDurationMs) throw new JobFailure('timeout');

    // Permission re-evaluated immediately before the paid call.
    const evaluation = await this.evaluate('rendering');
    if (!isEditable(evaluation.permission)) throw new JobFailure('policy_denied');

    const existingAttempt = (await this.attemptRows()).find((row) => row.attemptNo === attemptNo);
    if (!existingAttempt) {
      const linked = (await this.attemptRows())
        .map((row) => row.reservationEntryId)
        .filter((id): id is string => id !== null);
      const reservation = await findOpenReservation(this.deps.db, this.job.id, {
        sku: 'image_edit_attempt',
        notStage: ENHANCE_LEDGER_STAGE,
        exclude: linked,
      });
      // Kill switches, immediately before the attempt row (the paid-attempt cap counts rows).
      await this.assertNotPaused(this.compilerFamily());
      const attemptId = newId();
      const attemptRecord = this.attemptRecord(planned.plan);
      const capLimit = await this.deps.settings.get('quota.attempts_per_owner_24h');
      // Guard: the owner's paid-attempt cap allows one more attempt. The check and the insert
      // run under the owner's allowance lock, so two jobs of one owner (or a job and an
      // admission) cannot both take the last attempt.
      const inserted = await this.deps.db.transaction().execute(async (trx) => {
        await lockOwnerAllowance(trx, this.job.ownerId);
        if (!(await this.attemptCapAllows(trx, capLimit))) return false;
        await trx
          .insertInto('renderAttempts')
          .values({
            id: attemptId,
            jobId: this.job.id,
            attemptNo,
            isRepair: repairPlanned,
            decorationPlanId: planRowId,
            sceneAnalysisId: this.sceneAnalysisId,
            permissionEvaluationId: evaluation.evaluationId,
            provider: this.legs.imageEditor.providerId,
            modelSnapshot: planned.request.modelSnapshot,
            promptVersion: COMPILER_RELEASE,
            compilerVersion: this.job.compilerVersion,
            settingsHash: planned.request.settingsHash,
            providerMode: this.providerMode(),
            sourceChecksumSha256: this.loaded.checksum,
            workingChecksumSha256: this.working.checksum,
            fidelityMode: planned.plan.fidelityMode,
            requestedWidth: this.working.width,
            requestedHeight: this.working.height,
            compositeMask: planned.mask
              ? toJson({
                  ...(planned.plan.compositeMask?.objectKey
                    ? { objectKey: planned.plan.compositeMask.objectKey }
                    : {
                        rle: runLengthEncode(planned.mask.hard),
                        width: planned.mask.width,
                        height: planned.mask.height,
                      }),
                  dilationPx: planned.mask.dilationPx,
                  bandDilationPx: planned.mask.bandDilationPx,
                  featherPx: planned.mask.featherPx,
                  ...(planned.plan.compositeMask?.restoreBoxes?.length
                    ? { restoreBoxes: planned.plan.compositeMask.restoreBoxes }
                    : {}),
                })
              : null,
            dilationFraction: planned.plan.compositeMask?.dilationFraction ?? null,
            featherFraction: planned.plan.compositeMask?.featherFraction ?? null,
            outcome: 'pending',
            reservationEntryId: reservation?.id ?? null,
            fallback: attemptRecord ? toJson(attemptRecord) : null,
          })
          .execute();
        return true;
      });
      if (!inserted) throw new AttemptCapReached();
      await this.deps.db
        .updateTable('permissionEvaluations')
        .set({ attemptId })
        .where('id', '=', evaluation.evaluationId)
        .execute();
    }
    await this.advance('rendering', {
      renderStartedAt: this.now(),
      attemptCount: attemptNo,
      subStage: planned.plan.relightOf ? 'relight' : null,
      // A job keeps its one repair once used: a relight after a repaired base is not one.
      repairUsed: this.job.repairUsed || repairPlanned,
    });
  }

  private restorePlanned(document: unknown, validatorResult: unknown): PlannedRun {
    const plan = DecorationPlanSchema.parse(document);
    const stored = (validatorResult ?? {}) as {
      placementKeys?: Record<string, string>;
      archetypes?: Record<string, string | null>;
      request?: unknown;
    };
    const mask =
      plan.lightingMode === 'source'
        ? this.maskFor(
            plan.placements,
            plan.compositeMask?.dilationFraction ?? this.options.dilationFraction,
            plan.compositeMask?.restoreBoxes ?? [],
          )
        : null;
    const parsedRequest = CompiledRequestSchema.safeParse(stored.request);
    const request: CompiledRequest = parsedRequest.success
      ? parsedRequest.data
      : CompiledRequestSchema.parse({
          schemaVersion: COMPILED_REQUEST_SCHEMA_VERSION,
          compilerVersion: plan.compilerVersion,
          provider: plan.compiled.provider,
          modelSnapshot: plan.compiled.modelSnapshot,
          images: [
            {
              role: 'source',
              width: this.working.width,
              height: this.working.height,
              checksum: this.working.checksum,
            },
          ],
          instructionText: plan.compiled.instructionText,
          parameters: plan.compiled.parameters,
          settingsHash: plan.compiled.hash,
        });
    return {
      plan,
      request,
      mask,
      maskPng: null,
      placementKeys: stored.placementKeys ?? {},
      archetypes: stored.archetypes ?? {},
    };
  }

  private async currentPlanned(attemptNo: RenderAttemptNumber): Promise<PlannedRun> {
    if (this.planned) return this.planned;
    const row = await this.deps.db
      .selectFrom('decorationPlans')
      .selectAll()
      .where('jobId', '=', this.job.id)
      .where('attemptNo', '=', attemptNo)
      .executeTakeFirstOrThrow();
    this.planned = this.restorePlanned(row.document, row.validatorResult);
    if (this.planned.mask) {
      this.planned.maskPng = await encodeMaskPng(
        this.planned.mask.hard,
        this.planned.mask.width,
        this.planned.mask.height,
      );
    }
    return this.planned;
  }

  // ---- relight (evening, bright) --------------------------------------------------------------

  /**
   * The decorated base a relight attempt relights (render spec, lighting modes), or null when the
   * attempt decorates. Attempt 1 of an evening job relights the accepted `source` variant of the
   * same key; with none (and always for a bright job) attempt 1 renders the base itself. A later
   * attempt is the repair of the rejected relight before it (same base, the rejecting codes), the
   * relight of the base this job decorated (attempt 2 after an accepted base, attempt 3 after a
   * repaired one), or, with no base recorded (the first base was rejected and is repaired), a
   * decorate attempt.
   */
  private async relightBaseFor(
    attemptNo: RenderAttemptNumber,
  ): Promise<{ base: RelightBase; codes: FailureCode[] } | null> {
    if (attemptNo === 1) {
      if (this.relightTarget() !== 'evening') return null;
      const variant = await this.acceptedSourceVariant();
      return variant ? { base: variant, codes: [] } : null;
    }
    const stored = this.storedState();
    const previous = await this.deps.db
      .selectFrom('decorationPlans')
      .select('document')
      .where('jobId', '=', this.job.id)
      .where('attemptNo', '=', attemptNo - 1)
      .executeTakeFirst();
    const previousPlan = DecorationPlanSchema.safeParse(previous?.document);
    if (previousPlan.success && previousPlan.data.relightOf) {
      // Only a rejected relight is followed by another attempt: its repair.
      return { base: previousPlan.data.relightOf, codes: stored.codes ?? [] };
    }
    const base = RelightBaseSchema.safeParse(stored.relightBase);
    return base.success ? { base: base.data, codes: [] } : null;
  }

  /**
   * Loads the decorated base a relight starts from on the working grid: the published variant's
   * delivered image, or this job's own decorated composite (in memory, or stored when it was not
   * published: a bright job's base, or an evening base in pre-delivery review).
   */
  private async loadRelightInput(base: RelightBase): Promise<RelightInput> {
    if (this.relightInput?.base.baseAttemptId === base.baseAttemptId) return this.relightInput;
    const planRow = await this.deps.db
      .selectFrom('decorationPlans')
      .select('document')
      .where('id', '=', base.basePlanId)
      .executeTakeFirst();
    const plan = DecorationPlanSchema.safeParse(planRow?.document);
    if (!plan.success) throw new JobFailure('internal_error', null, 'relight base plan missing');
    let raster: Raster | null = null;
    if (base.baseRenderAssetId) {
      const asset = await this.deps.db
        .selectFrom('renderAssets')
        .selectAll()
        .where('id', '=', base.baseRenderAssetId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (asset) raster = await this.variantComposite(asset);
    }
    if (!raster && this.baseComposite?.attemptId === base.baseAttemptId) {
      raster = this.baseComposite.raster;
    }
    if (!raster && base.baseJobId === this.job.id) {
      const stored = await this.deps.storage.get(
        'private',
        keys.attempt(this.job.id, base.baseAttemptId, RELIGHT_BASE_FILE),
      );
      if (stored) raster = await decodeRaster(stored.body).catch(() => null);
    }
    if (!raster) throw new JobFailure('source_unavailable', null, 'relight base unavailable');
    const png = await encodePng(raster);
    const baseAttempt = await this.deps.db
      .selectFrom('renderAttempts')
      .select('compositeMask')
      .where('id', '=', base.baseAttemptId)
      .executeTakeFirst();
    const localization = LocalizationRecordSchema.safeParse(
      (baseAttempt?.compositeMask as { localization?: unknown } | null)?.localization,
    );
    const judgeRow = await this.deps.db
      .selectFrom('judgeResults')
      .select('document')
      .where('attemptId', '=', base.baseAttemptId)
      .orderBy('escalated', 'desc')
      .limit(1)
      .executeTakeFirst();
    const judge = JudgeResultSchema.safeParse(judgeRow?.document);
    this.relightInput = {
      base,
      plan: plan.data,
      raster,
      png,
      checksum: checksumOf(png),
      keptRegions:
        localization.success && localization.data.status === 'localized'
          ? localization.data.items
              .filter((item) => !localization.data.dropped.some((d) => sameItem(d, item)))
              .map((item) => item.box)
          : [],
      judge: judge.success && judge.data.judgeModel !== 'deterministic-checks' ? judge.data : null,
    };
    return this.relightInput;
  }

  /**
   * Plans a relight attempt: the base plan's decorations and preserve set, in the job's relit
   * lighting (`evening` or `bright`) as `global_relight`, with the compiled relight request (no
   * mask) and the base it relights. A repair carries the rejecting codes as constraints of the
   * stronger instruction.
   */
  private async planRelight(
    attemptNo: RenderAttemptNumber,
    base: RelightBase,
    codes: FailureCode[],
  ): Promise<{ planned: PlannedRun; planRowId: string }> {
    const target = this.relightTarget() ?? 'evening';
    const input = await this.loadRelightInput(base);
    const request = compileRelightRequest({
      target,
      basePlan: input.plan,
      provider: this.compilerFamily(),
      settings: this.deps.config.imageEdit,
      repair: codes.length > 0 ? { codes } : null,
      modelSnapshot: this.modelSnapshot(),
      image: { width: input.raster.width, height: input.raster.height, checksum: input.checksum },
      compilerVersion: this.job.compilerVersion,
      lowerQuality: codes.includes('camera_changed'),
    });
    const {
      compositeMask: _compositeMask,
      repairConstraints: _repairConstraints,
      relightOf: _relightOf,
      maskBudget: _maskBudget,
      ...kept
    } = input.plan;
    const plan = DecorationPlanSchema.parse({
      ...kept,
      renderJobId: this.job.id,
      planVersion: attemptNo,
      attemptNumber: attemptNo,
      lightingMode: target,
      fidelityMode: 'global_relight',
      compilerVersion: this.job.compilerVersion,
      permissionEvaluationId: this.job.permissionEvaluationId,
      lightingInstruction: {
        mode: target,
        text:
          target === 'bright'
            ? 'Relight the decorated photo to the bright look: bright, airy and cheerful as on a sunny day with every light on, shadows lifted, the decorations’ own lights glowing; nothing else changes.'
            : 'Relight the accepted daylight variant to early evening: dusk ambient light, the decorations’ own lights glowing, existing windows and porch or room lights on; nothing else changes.',
      },
      ...(codes.length > 0
        ? {
            repairConstraints: codes.map((code) => ({
              code,
              instruction:
                code === 'lighting_implausible'
                  ? target === 'bright'
                    ? RELIGHT_REPAIR_BRIGHT_LIGHT
                    : RELIGHT_REPAIR_LIGHT
                  : RELIGHT_REPAIR_KEEP,
              placementIds: [],
            })),
          }
        : {}),
      compiled: compiledRecordOf(request),
      relightOf: base,
    });
    const planRowId = newId();
    await this.deps.db
      .insertInto('decorationPlans')
      .values({
        id: planRowId,
        jobId: this.job.id,
        attemptNo,
        sceneAnalysisId: this.sceneAnalysisId,
        packVersion: this.job.holidayPackVersion,
        styleKitId: input.plan.styleKitVersionId,
        compilerVersion: this.job.compilerVersion,
        document: toJson(plan),
        validatorResult: toJson({ relight: true, codes, request }),
        compiledInstruction: request.instructionText,
      })
      .execute();
    return {
      planned: { plan, request, mask: null, maskPng: null, placementKeys: {}, archetypes: {} },
      planRowId,
    };
  }

  private fixtureEditContext(planned: PlannedRun): FixtureEditContext {
    const geometry = this.fixture.geometry;
    const windows = this.windowBoxes();
    return {
      ...this.fixture.hint,
      holidayId: this.job.holidayId,
      style: this.job.style,
      lightingMode: planned.plan.lightingMode,
      sceneType: this.sceneType,
      placements: planned.plan.placements.map((placement) => ({
        id: placement.id,
        kitItemId: placement.kitItemId,
        anchorCategory: placement.anchorCategory,
        region: placement.region,
        placementRule: placement.placementRule,
        count: placement.count,
        lit: placement.lit,
        specText: placement.specText,
        archetype: planned.archetypes[placement.kitItemId] ?? null,
      })),
      windows,
      lightSources: geometry?.lightSources ?? [],
      attributionRegion: this.attributionRegions[0] ?? null,
      preserveRegions: this.analysis.preserveRegions.map((region) => region.box),
      accessRegions: this.analysis.accessRegions
        .filter((region) => region.kind !== 'door')
        .map((region) => region.box),
      referenceDoor:
        this.analysis.anchors.find((a) => a.category === 'front_door' || a.category === 'unit_door')
          ?.box ?? null,
      targetFacade: this.analysis.targetFacade ?? null,
    };
  }

  private glowRegions(): NormalizedBox[] {
    const geometry = this.fixture.geometry;
    if (geometry) return [...geometry.windows, ...geometry.lightSources];
    return this.analysis.anchors
      .filter((a) => a.category === 'window_frame' || a.category === 'interior_window')
      .map((a) => a.box);
  }

  private async currentAttempt(attemptNo: number): Promise<RenderAttempt> {
    const attempt = (await this.attemptRows()).find((row) => row.attemptNo === attemptNo);
    if (!attempt) throw new JobFailure('internal_error', null, 'attempt row missing');
    return attempt;
  }

  /** Polls `getOperation` until it leaves `pending` or the deadline passes. */
  private async recover(
    editor: ImageEditor,
    operationId: string,
    until: number,
  ): Promise<EditOutcome> {
    for (;;) {
      const outcome = await editor.getOperation(operationId).catch((): EditOutcome => ({
        status: 'failed',
        operationId,
        kind: 'provider_error',
        retryable: true,
      }));
      if (outcome.status !== 'pending') return outcome;
      if (this.now().getTime() >= until || this.signal.aborted) return outcome;
      await sleep(this.options.statusPollMs, this.signal);
    }
  }

  private async renderAttempt(attemptNo: RenderAttemptNumber): Promise<void> {
    await this.ensureActive();
    const planned = await this.currentPlanned(attemptNo);
    let attempt = await this.currentAttempt(attemptNo);
    const editor = this.legs.imageEditor;
    const family = this.compilerFamily();
    const relightOf = planned.plan.relightOf;
    // A relight's edit, and a repair's while the job keeps an attempt to fall back on, is bounded
    // by the job's time left, so a slow edit ends as an attempt timeout with time left to fall
    // back to the base or the kept attempt.
    const bounded = Boolean(relightOf) || this.keptBefore(attemptNo) !== null;
    const editTimeoutMs = () =>
      bounded ? this.boundedEditTimeoutMs() : this.options.renderTimeoutMs;
    const callDeadline = this.now().getTime() + editTimeoutMs();
    const fixture = editor.mode === 'fixture' ? this.fixtureEditContext(planned) : undefined;
    const input = {
      image: relightOf ? (await this.loadRelightInput(relightOf)).png : this.working.png,
      ...(planned.maskPng && planned.request.mask ? { mask: planned.maskPng } : {}),
      ...(fixture ? { fixture } : {}),
    };
    // A provider with neither a status API nor idempotency keys cannot say whether a sent
    // request was billed, so a request it did not answer is never sent again.
    const unresolvable =
      !editor.capabilities.asyncOperations && !editor.capabilities.supportsIdempotencyKey;
    // The editors report the operation before they send. Only an attempt still `pending` on a
    // job that is still running records it; one another actor closed meanwhile (a termination
    // cancels an unsent attempt and releases its reservation, and marks a sent one `unknown`)
    // stops the run here, so the request is never sent (again). The one exception is the
    // re-dispatch of an operation the provider never saw, which a stopped delivery left
    // `unknown`: it reopens the attempt as `pending`, so its own transport retries are guarded
    // the same way.
    const persistOperation = async (operationId: string, reopen: boolean) => {
      const updated = await this.deps.db
        .updateTable('renderAttempts')
        .set({
          providerOperationId: operationId,
          requestSentAt: this.now(),
          ...(reopen ? { outcome: 'pending' as const, completedAt: null } : {}),
        })
        .where('id', '=', attempt.id)
        .where('outcome', 'in', reopen ? ['pending', 'unknown'] : ['pending'])
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('renderJobs')
              .select('renderJobs.id')
              .where('renderJobs.id', '=', this.job.id)
              .where('renderJobs.state', 'not in', [...TERMINAL_RENDER_JOB_STATES]),
          ),
        )
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) throw new RunStopped();
      attempt = {
        ...attempt,
        providerOperationId: operationId,
        ...(reopen ? { outcome: 'pending' as const, completedAt: null } : {}),
      };
    };
    const editOnce = (reopen = false) => {
      const timeoutMs = editTimeoutMs();
      return editor.edit(planned.request, input, {
        attemptId: attempt.id,
        timeoutMs,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]),
        onOperation: (operationId) => persistOperation(operationId, reopen),
      });
    };
    const started = this.now().getTime();
    let latencyMs = 0;
    const reservationOf = async () =>
      attempt.reservationEntryId
        ? await this.deps.db
            .selectFrom('usageLedger')
            .selectAll()
            .where('id', '=', attempt.reservationEntryId)
            .executeTakeFirst()
        : undefined;
    const finishAttempt = (patch: Record<string, unknown>) =>
      this.deps.db
        .updateTable('renderAttempts')
        .set({ completedAt: this.now(), latencyMs, ...patch })
        .where('id', '=', attempt.id)
        .execute();

    // The recorded row decides what a redelivered job may do: a transport retry of the queue job
    // never buys a second call for an attempt whose outcome is recorded or may have been billed.
    if (attempt.outcome === 'succeeded') {
      this.rawOutput = await this.loadRawOutput(attempt);
      await this.advance('checking', { renderCompletedAt: attempt.completedAt ?? this.now() });
      return;
    }
    const settledFailure = SETTLED_ATTEMPT_FAILURES[attempt.outcome];
    if (settledFailure) {
      throw new JobFailure(settledFailure, null, 'attempt outcome already recorded');
    }

    let outcome: EditOutcome;
    if (attempt.providerOperationId) {
      // The request was sent by an earlier delivery: recover the recorded operation first.
      outcome = await this.recover(editor, attempt.providerOperationId, callDeadline);
      if (
        outcome.status === 'failed' &&
        outcome.providerCode === 'unknown_operation' &&
        editor.capabilities.supportsIdempotencyKey
      ) {
        // The provider never saw it; the same attempt ID deduplicates a re-dispatch.
        await this.assertNotPaused(family);
        outcome = await editOnce(true);
      }
    } else {
      if (await this.isPaused(family)) {
        // Never dispatched: nothing was billed and the attempt's reservation is returned.
        await finishAttempt({ outcome: 'canceled', errorDetail: toJson({ paused: true }) });
        const reservation = await reservationOf();
        if (reservation) await release(this.deps.db, reservation.id, this.deps.clock);
        throw new JobFailure('provider_error', null, 'paused');
      }
      const boundedTimeLeftMs = bounded ? this.editTimeLeftMs() : null;
      if (
        boundedTimeLeftMs !== null &&
        boundedTimeLeftMs < PIPELINE_DEFAULTS.relightMinDispatchMs
      ) {
        // Too little time left for a bounded edit to finish: it is never sent, nothing is billed,
        // and the job falls back to its base or its kept attempt as an attempt timeout.
        await finishAttempt({
          outcome: 'canceled',
          errorDetail: toJson({ notDispatched: 'deadline', timeLeftMs: boundedTimeLeftMs }),
        });
        const reservation = await reservationOf();
        if (reservation) await release(this.deps.db, reservation.id, this.deps.clock);
        throw new JobFailure('timeout', null, 'too little time left to send the edit');
      }
      outcome = await editOnce();
    }
    let retries = attempt.transportRetries;
    let noImageRedispatched = false;
    let paused = false;
    for (;;) {
      if (this.signal.aborted) break;
      if (outcome.status === 'completed') break;
      if (outcome.status === 'pending') {
        outcome = await this.recover(editor, outcome.operationId, callDeadline);
        break;
      }
      if (outcome.kind === 'moderation_blocked' || outcome.kind === 'invalid_request') break;
      if (unresolvable && attempt.providerOperationId !== null && !vendorAnswered(outcome)) break;
      // A reply without an image is answered and unbilled as an image: one re-dispatch.
      const noImage = outcome.providerCode === NO_IMAGE && !noImageRedispatched;
      if (!(outcome.retryable || noImage) || retries >= this.options.transportRetryLimit) break;
      if (outcome.operationId && editor.capabilities.asyncOperations) {
        const recovered = await this.recover(editor, outcome.operationId, callDeadline);
        if (recovered.status === 'completed') {
          outcome = recovered;
          break;
        }
      }
      // A bounded edit is sent again only when, after the retry's delay, the job's time left for
      // an edit is still at least `relightMinDispatchMs`; otherwise the attempt ends with this
      // outcome and the job falls back to its base or its kept attempt.
      if (
        bounded &&
        this.editTimeLeftMs() - this.options.retryDelayMs(retries + 1) <
          PIPELINE_DEFAULTS.relightMinDispatchMs
      ) {
        break;
      }
      if (await this.isPaused(family)) {
        paused = true;
        break;
      }
      if (noImage) noImageRedispatched = true;
      retries += 1;
      await this.deps.db
        .updateTable('renderAttempts')
        .set({ transportRetries: retries })
        .where('id', '=', attempt.id)
        .execute();
      if (!(await sleep(this.options.retryDelayMs(retries), this.signal))) break;
      outcome = await editOnce();
    }

    latencyMs = this.now().getTime() - started;
    const reservation = await reservationOf();
    const settleAttempt = async (units: number, unitPriceMicros?: number) =>
      settleCall(this.deps.db, {
        reservation: reservation ?? null,
        jobId: this.job.id,
        ownerId: this.job.ownerId,
        projectId: this.job.projectId,
        attemptId: attempt.id,
        provider: editor.providerId,
        sku: 'image_edit_attempt',
        stage: 'rendering',
        units,
        unitPriceMicros:
          unitPriceMicros ??
          reservation?.unitPriceMicros ??
          unitPriceFor('image_edit_attempt', { provider: family }),
        modelId: planned.request.modelSnapshot,
        isFixture: this.providerMode() === 'fixture',
        clock: this.deps.clock,
      });

    if (this.signal.aborted && outcome.status !== 'completed') {
      // Cancellation, supersede, expiry, the duration limit or a worker shutdown: a charge may
      // exist when the request was sent, so its reservation stays open for the late response,
      // the queue's transport retry or reconciliation.
      const sent = attempt.providerOperationId !== null;
      if (sent && editor.cancel) {
        await editor.cancel(attempt.providerOperationId as string).catch(() => undefined);
      }
      const current = await readJob(this.deps.db, this.job.id);
      const ended = !current || isTerminalRenderJobState(current.state);
      if (this.deadlineHit || ended) {
        await finishAttempt({
          outcome: this.deadlineHit ? (sent ? 'unknown' : 'timeout') : 'canceled',
          transportRetries: retries,
        });
        if (!sent && reservation) await release(this.deps.db, reservation.id, this.deps.clock);
      } else if (sent) {
        // The queue stopped the job without a domain decision: the retry recovers this
        // operation before anything else, and reconciliation sees it if no retry comes.
        await finishAttempt({ outcome: 'unknown', transportRetries: retries });
      }
      // A request never sent stays `pending` with its reservation for the transport retry.
      throw new JobAborted(this.deadlineHit ? 'deadline' : 'signal');
    }

    if (outcome.status === 'completed') {
      // Transient Street View: the raw output stays in memory with the source pixels; only the
      // accepted output is stored. Other sources keep the raw candidate for QA review.
      const rawKey =
        this.loaded.streetViewMode === 'transient'
          ? null
          : keys.attempt(
              this.job.id,
              attempt.id,
              `raw.${outcome.format === 'jpeg' ? 'jpg' : outcome.format}`,
            );
      if (rawKey) {
        await this.deps.storage.put({
          bucket: 'private',
          key: rawKey,
          body: outcome.image,
          contentType: `image/${outcome.format}`,
          provenance: {
            sourceKind: this.source.kind,
            permission: this.permission,
            derivative: true,
          },
        });
      }
      let manifestKey: string | null = null;
      if (outcome.provenance.c2paManifest) {
        manifestKey = keys.attempt(this.job.id, attempt.id, 'manifest.c2pa');
        await this.deps.storage.put({
          bucket: 'private',
          key: manifestKey,
          body: outcome.provenance.c2paManifest,
          contentType: 'application/c2pa',
          provenance: {
            sourceKind: this.source.kind,
            permission: this.permission,
            derivative: true,
          },
        });
      }
      // Settled from the provider's reported usage where the worksheet prices it.
      const units = outcome.usage.images ?? 1;
      const imageSize = planned.request.parameters.image_size;
      const cost = usageCostMicros(outcome.modelSnapshot, outcome.usage, {
        imageSize: typeof imageSize === 'string' ? imageSize : null,
      });
      const ledgerEntryId = await settleAttempt(
        units,
        cost === null ? undefined : Math.round(cost / Math.max(1, units)),
      );
      await finishAttempt({
        outcome: 'succeeded',
        providerOperationId: outcome.operationId,
        deliveredWidth: outcome.width,
        deliveredHeight: outcome.height,
        modelSnapshot: outcome.modelSnapshot,
        candidateObjectKey: rawKey,
        providerManifestObjectKey: manifestKey,
        providerWatermark: outcome.provenance.watermark ?? 'unknown',
        providerUsage: toJson(outcome.usage),
        ledgerEntryId,
        transportRetries: retries,
      });
      this.rawOutput = outcome.image;
      await this.advance('checking', { renderCompletedAt: this.now() });
      return;
    }

    if (outcome.status === 'pending') {
      await finishAttempt({ outcome: 'unknown', transportRetries: retries });
      throw new JobFailure('unknown_outcome');
    }
    if (outcome.kind === 'provider_error' && unreadableAnswer(outcome)) {
      // Billed but unreadable: the reservation stays open and reconciliation settles it as
      // charged (a provider with a status API may still recover the result there).
      await finishAttempt({
        outcome: 'unknown',
        transportRetries: retries,
        errorDetail: toJson({
          kind: outcome.kind,
          providerCode: outcome.providerCode ?? null,
          httpStatus: outcome.httpStatus ?? null,
          unresolved: 'unreadable_response',
        }),
      });
      throw new JobFailure('unknown_outcome');
    }
    if (
      unresolvable &&
      attempt.providerOperationId !== null &&
      outcome.kind === 'provider_error' &&
      !vendorAnswered(outcome)
    ) {
      // Sent, unanswered and unrecoverable: a charge may exist. The reservation stays open and
      // reconciliation settles it as charged.
      await finishAttempt({
        outcome: 'unknown',
        transportRetries: retries,
        errorDetail: toJson({
          kind: outcome.kind,
          providerCode: outcome.providerCode ?? null,
          unresolved: 'no_status_api',
        }),
      });
      throw new JobFailure('unknown_outcome');
    }
    switch (outcome.kind) {
      case 'moderation_blocked': {
        await settleAttempt(0);
        await finishAttempt({
          outcome: 'moderation_blocked',
          providerCategories: outcome.providerCategories ?? [],
          errorDetail: toJson({ providerCode: outcome.providerCode ?? null }),
          transportRetries: retries,
        });
        await this.declineSource('provider_refused', { providerRefusedAt: this.now() });
        this.log.warn(
          { categories: outcome.providerCategories ?? [] },
          'provider refused the input',
        );
        throw new JobFailure('moderation_blocked');
      }
      case 'invalid_request':
        await settleAttempt(0);
        await finishAttempt({
          outcome: 'provider_error',
          errorDetail: toJson({
            kind: 'invalid_request',
            providerCode: outcome.providerCode ?? null,
          }),
          transportRetries: retries,
        });
        this.log.error(
          { providerCode: outcome.providerCode },
          'compiled request rejected by provider',
        );
        throw new JobFailure('internal_error', null, 'provider rejected the compiled request');
      case 'timeout':
        // No response within the timeout after status recovery: settled as charged.
        await settleAttempt(1);
        await finishAttempt({
          outcome: 'timeout',
          reconciled: 'assumed_charged',
          transportRetries: retries,
        });
        throw new JobFailure('timeout');
      default:
        await settleAttempt(0);
        await finishAttempt({
          outcome: 'provider_error',
          errorDetail: toJson({
            providerCode: outcome.providerCode ?? null,
            ...(paused ? { paused: true } : {}),
          }),
          transportRetries: retries,
        });
        throw new JobFailure('provider_error', null, paused ? 'paused' : undefined);
    }
  }

  private async loadRawOutput(attempt: RenderAttempt): Promise<Uint8Array> {
    if (this.rawOutput) return this.rawOutput;
    if (attempt.candidateObjectKey) {
      const object = await this.deps.storage.get('private', attempt.candidateObjectKey);
      if (object) return object.body;
    }
    if (attempt.providerOperationId) {
      const recovered = await this.legs.imageEditor.getOperation(attempt.providerOperationId);
      if (recovered.status === 'completed') return recovered.image;
    }
    throw new JobFailure('unknown_outcome');
  }

  /**
   * Records one judge result. A paid call's settlement is written in the same transaction as the
   * row (and only when the row is new), so a crash can never leave a settled call without its
   * recorded result, which a redelivery would pay for again.
   */
  private async recordJudge(
    attemptId: string,
    result: JudgeResult,
    classification: JudgeClassification,
    deterministicChecks: Record<string, unknown>,
    call: VisionCallResult<JudgeResult> | null = null,
  ): Promise<void> {
    const stage = result.escalated ? 'escalation' : 'judge';
    await this.deps.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('judgeResults')
        .values({
          id: newId(),
          attemptId,
          escalated: result.escalated,
          modelId: result.judgeModel,
          promptVersion: result.judgePromptVersion,
          deterministicChecks: toJson(deterministicChecks),
          document: toJson(result),
          criticalCodes: [...new Set([...classification.critical, ...classification.uncertain])],
          majorCodes: classification.major,
          decision: judgeDecision(classification),
          ledgerEntryId: null,
          usage: call ? toJson(call.usage) : null,
        })
        .onConflict((oc) => oc.columns(['attemptId', 'escalated']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row || !call) return;
      const reservation = await findVisionReservation(trx, this.job.id, stage);
      const ledgerEntryId = await settleCall(trx, {
        reservation,
        jobId: this.job.id,
        ownerId: this.job.ownerId,
        projectId: this.job.projectId,
        attemptId,
        provider: this.visionProvider(),
        sku: 'vision_call',
        stage: 'checking',
        units: 1,
        unitPriceMicros:
          usageCostMicros(call.model, visionUsage(call)) ?? VISION_PRICES_MICROS[stage],
        modelId: call.model,
        isFixture: call.providerMode === 'fixture',
        clock: this.deps.clock,
      });
      await trx
        .updateTable('judgeResults')
        .set({ ledgerEntryId })
        .where('id', '=', row.id)
        .execute();
    });
  }

  /**
   * The judge result already recorded for an attempt (a redelivered job re-runs `checking`):
   * reused instead of paying for the same call again. Results the deterministic checks wrote in
   * the judge's place are not reused.
   */
  private async recordedJudge(attemptId: string, escalated: boolean): Promise<JudgeCall | null> {
    const row = await this.deps.db
      .selectFrom('judgeResults')
      .select(['document'])
      .where('attemptId', '=', attemptId)
      .where('escalated', '=', escalated)
      .executeTakeFirst();
    const parsed = JudgeResultSchema.safeParse(row?.document);
    if (!row || !parsed.success || parsed.data.judgeModel === 'deterministic-checks') return null;
    return { result: parsed.data, refused: parsed.data.judgeModel === 'refusal', call: null };
  }

  /** One judge call (decorate mode, or relight mode against the daylight base). */
  private async judgeOnce(
    attempt: RenderAttempt,
    candidate: Raster,
    plan: DecorationPlan,
    hints: string[],
    escalated: boolean,
    relight: { base: ImageInput } | null,
  ): Promise<JudgeCall> {
    await this.assertNotPaused(this.visionProvider());
    try {
      const call = await this.withVisionRetries(() =>
        callJudge({
          vision: this.legs.vision,
          attemptId: attempt.id,
          working: this.working,
          candidate,
          plan,
          hints,
          escalated,
          fixture: this.fixture.hint,
          timeoutMs: escalated ? this.options.escalationTimeoutMs : this.options.judgeTimeoutMs,
          signal: this.signal,
          ...(relight ? { mode: 'relight' as const, base: relight.base } : {}),
        }),
      );
      return { result: { ...call.result, escalated }, refused: false, call };
    } catch (error) {
      this.checkAbort();
      if (isProviderError(error) && error.kind === 'moderation_blocked') {
        // A safety refusal on the candidate counts as `unsafe_or_offensive`.
        const result = deterministicJudgeResult(attempt.id, ['unsafe_or_offensive']);
        return {
          result: { ...result, judgeModel: 'refusal', escalated },
          refused: true,
          call: null,
        };
      }
      throw new JobFailure('provider_error', null, 'judge unavailable');
    }
  }

  /**
   * The judge step after the deterministic checks: a deterministic critical code is recorded in
   * the judge's place (decision `reject` with its codes); otherwise the judge (reused when already
   * recorded) and, for an uncertain critical code, the escalation. Returns the deciding result and
   * classification.
   */
  private async judgeAttempt(
    attempt: RenderAttempt,
    composite: CompositeResult,
    plan: DecorationPlan,
    hints: string[],
    relight: { base: ImageInput } | null,
  ): Promise<{ judge: JudgeResult; classification: JudgeClassification | null }> {
    const deterministic = composite.deterministic;
    if (
      deterministic.codes.some((code) => isCriticalFailureCode(code)) ||
      (deterministic.decisive?.length ?? 0) > 0
    ) {
      const judge = deterministicJudgeResult(attempt.id, deterministic.codes);
      await this.recordJudge(
        attempt.id,
        judge,
        deterministicClassification(deterministic.codes),
        deterministic.checks,
      );
      return { judge, classification: null };
    }
    const thresholds = this.options.judgeThresholds;
    const evaluation = await this.evaluate('checking');
    if (!evaluation.permission.aiProcess) throw new JobFailure('policy_denied');
    const classify = (judged: JudgeCall): JudgeClassification =>
      judged.refused
        ? { critical: ['unsafe_or_offensive'], uncertain: [], major: [] }
        : classifyJudge(judged.result, thresholds);
    const recorded = await this.recordedJudge(attempt.id, false);
    const first =
      recorded ?? (await this.judgeOnce(attempt, composite.candidate, plan, hints, false, relight));
    let judge = first.result;
    let classification = classify(first);
    if (!recorded) {
      await this.recordJudge(
        attempt.id,
        first.result,
        classification,
        deterministic.checks,
        first.call,
      );
    }
    if (classification.uncertain.length > 0 && classification.critical.length === 0) {
      const recordedSecond = await this.recordedJudge(attempt.id, true);
      const second =
        recordedSecond ??
        (await this.judgeOnce(attempt, composite.candidate, plan, hints, true, relight));
      const escalated = classify(second);
      if (!recordedSecond) {
        await this.recordJudge(
          attempt.id,
          { ...second.result, escalated: true },
          escalated,
          deterministic.checks,
          second.call,
        );
      }
      judge = second.result;
      classification = escalated;
    }
    return { judge, classification };
  }

  // ---- localization ----------------------------------------------------------------------------

  /** The localization recorded on an attempt's composite-mask record, if any. */
  private recordedLocalization(attempt: RenderAttempt): LocalizationRecord | null {
    const parsed = LocalizationRecordSchema.safeParse(
      (attempt.compositeMask as { localization?: unknown } | null)?.localization,
    );
    return parsed.success ? parsed.data : null;
  }

  /**
   * Writes the localization and the protected-box decisions onto the attempt's composite-mask
   * record (either may be left as recorded).
   */
  private async writeLocalization(
    db: Pick<PipelineDeps['db'], 'updateTable'>,
    attempt: RenderAttempt,
    record: LocalizationRecord | null,
    protection: ProtectedCompositing,
  ): Promise<void> {
    await db
      .updateTable('renderAttempts')
      .set({
        compositeMask: toJson({
          ...((attempt.compositeMask as Record<string, unknown> | null) ?? {}),
          ...(record ? { localization: record } : {}),
          protectedBoxes: protection.decisions,
        }),
      })
      .where('id', '=', attempt.id)
      .execute();
  }

  /**
   * Localized compositing (render spec, compositing algorithm): after registration the vision
   * model localizes the decorations the editor added in the aligned output; then the protected
   * boxes are decided on the aligned output with those items (`protectedCompositing`: text marks
   * grown, exact or open, restore boxes applied or skipped), the plan mask is rebuilt when a
   * decision changes it, and the keep-mask is that mask united with each localized box (dilated,
   * minus the privacy and legal exclusions, capped). The result (items, other changes, model,
   * prompt version, usage, coverage, what the cap dropped) and the decisions (`protectedBoxes`)
   * are recorded on the attempt in one write, in the same transaction as the call's settlement;
   * a redelivery reuses the recorded items without a second paid call and recomputes the same
   * decisions. A call that fails after its retries falls back to the plan mask, decided with the
   * plan's shapes as the decorations and recorded as such. Every text mark left open reaches the
   * judge as a hint.
   */
  private async localize(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    planMask: CompositeMask,
    aligned: Raster,
  ): Promise<LocalizedComposite> {
    const dilation = plan.compositeMask?.dilationFraction ?? this.options.dilationFraction;
    const protect = (items: readonly LocalizedAdditionRecord[] | null) =>
      protectedCompositing({
        working: this.working.raster,
        aligned,
        analysis: this.analysis,
        restoreBoxes: plan.compositeMask?.restoreBoxes ?? [],
        padRegions: this.working.padRegions,
        attributionRegions: this.attributionRegions,
        planMask,
        items,
        placements: plan.placements,
        buildMask: ({ restoreBoxes, textMarks }) =>
          this.maskFor(plan.placements, dilation, restoreBoxes, textMarks),
        // On a street photo the number on the house is never the editor's.
        keepHouseNumbers: this.source.kind === 'street_view',
      });
    const composite = (
      record: LocalizationRecord,
      protection: ProtectedCompositing,
    ): LocalizedComposite => {
      const marks = openTextMarkHints(protection.decisions.textMarks);
      const { openHouseNumbers } = protection;
      if (record.status !== 'localized' || !protection.keep) {
        return { mask: protection.mask, keptRegions: [], hints: marks, openHouseNumbers };
      }
      const keep = protection.keep;
      return {
        mask: keep.mask,
        keptRegions: keep.kept.map((item) => item.box),
        hints: [...restoredChangeHints(record.otherChanges, keep.mask), ...marks],
        openHouseNumbers,
      };
    };
    const recorded = this.recordedLocalization(attempt);
    if (recorded) {
      // A redelivery recomputes the same decisions from the recorded items; they are written
      // when missing.
      const protection = protect(recorded.status === 'localized' ? recorded.items : null);
      if (!(attempt.compositeMask as { protectedBoxes?: unknown } | null)?.protectedBoxes) {
        await this.writeLocalization(this.deps.db, attempt, null, protection);
      }
      return composite(recorded, protection);
    }

    const evaluation = await this.evaluate('checking');
    if (!evaluation.permission.aiProcess) throw new JobFailure('policy_denied');
    await this.assertNotPaused(this.visionProvider());
    let call: VisionCallResult<LocalizeAdditionsResult>;
    try {
      call = await this.withVisionRetries(() =>
        callLocalizer({
          vision: this.legs.vision,
          attemptId: attempt.id,
          working: this.working,
          aligned,
          placements: plan.placements,
          fixture: this.fixture.hint,
          timeoutMs: PIPELINE_DEFAULTS.localizationTimeoutMs,
          signal: this.signal,
        }),
      );
    } catch (error) {
      this.checkAbort();
      const reason = isProviderError(error) ? error.kind : 'error';
      this.log.warn({ reason }, 'localization failed; the plan mask is used');
      const fallback: LocalizationRecord = {
        status: 'fallback',
        model: null,
        promptVersion: null,
        items: [],
        otherChanges: [],
        dropped: [],
        dilationPx: 0,
        coverageBeforeCap: 0,
        coverage: 0,
        usage: null,
        ledgerEntryId: null,
        elapsedMs: null,
        fallbackReason: reason,
      };
      const protection = protect(null);
      await this.writeLocalization(this.deps.db, attempt, fallback, protection);
      return composite(fallback, protection);
    }
    const { items, otherChanges } = localizationRecords(
      call.result,
      plan.placements.map((placement) => placement.id),
    );
    const protection = protect(items);
    const keep = protection.keep;
    if (!keep) throw new Error('A localized output has no keep-mask');
    const round = (value: number) => Math.round(value * 10_000) / 10_000;
    const record: LocalizationRecord = {
      status: 'localized',
      model: call.model,
      promptVersion: call.promptVersion,
      items,
      otherChanges,
      dropped: keep.dropped,
      dilationPx: keep.dilationPx,
      coverageBeforeCap: round(keep.coverageBeforeCap),
      coverage: round(keep.coverage),
      usage: { ...call.usage },
      ledgerEntryId: null,
      elapsedMs: call.elapsedMs,
    };
    await this.deps.db.transaction().execute(async (trx) => {
      const reservation = await findVisionReservation(trx, this.job.id, 'localization');
      const ledgerEntryId = await settleCall(trx, {
        reservation,
        jobId: this.job.id,
        ownerId: this.job.ownerId,
        projectId: this.job.projectId,
        attemptId: attempt.id,
        provider: this.visionProvider(),
        sku: 'vision_call',
        stage: 'localizing',
        units: 1,
        unitPriceMicros:
          usageCostMicros(call.model, visionUsage(call)) ?? VISION_PRICES_MICROS.localization,
        modelId: call.model,
        isFixture: call.providerMode === 'fixture',
        clock: this.deps.clock,
      });
      record.ledgerEntryId = ledgerEntryId;
      await this.writeLocalization(trx, attempt, record, protection);
    });
    return composite(record, protection);
  }

  // ---- checking ------------------------------------------------------------------------------

  private async checkAttempt(attemptNo: RenderAttemptNumber): Promise<'next' | 'done'> {
    await this.ensureActive();
    const planned = await this.currentPlanned(attemptNo);
    if (planned.plan.relightOf)
      return this.checkRelight(attemptNo, planned, planned.plan.relightOf);
    const plan = planned.plan;
    let attempt = await this.currentAttempt(attemptNo);
    if (!this.rawOutput && !attempt.candidateObjectKey) {
      // A redelivery of a job whose fallback to the attempt it kept through a repair had moved it
      // to `checking` after the repair's edit failed.
      const recorded = unfinishedEditFailure(attempt);
      if (recorded) throw recorded;
    }
    const rawBytes = await this.loadRawOutput(attempt);
    // Encoding sanity: an undecodable output is an attempt failure.
    const undecodable = (error: unknown): never => {
      if (this.signal.aborted) throw error;
      throw new JobFailure('provider_error', null, 'provider output could not be decoded');
    };
    const registration = await registerOutput({
      working: this.working,
      rawBytes,
      plan,
      mask: planned.mask,
      glowRegions: this.glowRegions(),
    }).catch(undecodable);
    let localized: LocalizedComposite | null = null;
    const aligned = registration.registered.aligned;
    if (plan.lightingMode === 'source' && planned.mask && aligned) {
      // How the text marks and the repair's restore boxes are composited follows how much the
      // editor changed their surroundings and where it put decorations; the mask sent to the
      // editor stays as it was.
      localized = await this.localize(attempt, plan, planned.mask, aligned);
      attempt = await this.currentAttempt(attemptNo);
    }
    const compositeInput = {
      working: this.working,
      rawBytes,
      registration,
      requested: { width: this.working.width, height: this.working.height },
      plan,
      analysis: this.analysis,
      mask: localized?.mask ?? planned.mask,
      ...(localized ? { keptRegions: localized.keptRegions } : {}),
      openHouseNumbers: localized?.openHouseNumbers ?? [],
      attributionRegion: this.attributionRegions,
      glowRegions: this.glowRegions(),
    };
    const composite = await compositeAndCheck(compositeInput).catch(undecodable);
    await this.deps.db
      .updateTable('renderAttempts')
      .set({
        fidelityMode: composite.fidelityMode,
        registrationTransform: toJson(registrationRecord(composite.alignment)),
      })
      .where('id', '=', attempt.id)
      .execute();

    const hints = [...composite.deterministic.hints, ...(localized?.hints ?? [])];
    const { judge, classification } = await this.judgeAttempt(
      attempt,
      composite,
      plan,
      hints,
      null,
    );
    // A repair is open only while the job has it, an attempt is left, and the time budget and the
    // paid-attempt cap allow one; otherwise confident majors are recorded, not rejected.
    const repairOpen =
      this.repairLeft(attemptNo, this.relights() ? MAX_RENDER_ATTEMPTS : null) &&
      (await this.repairAllowed());
    // The base of a relit look that is short on time keeps what is left for its relight: its
    // confident majors are recorded as on an attempt with no repair after it. A critical finding
    // is still repaired while a repair is open.
    const majorsRepaired = repairOpen && !(this.relights() && this.shortForRepairAndRelight());
    const decide = (repairLeft: boolean) =>
      decideAttempt({
        attemptNumber: attemptNo,
        repairLeft,
        deterministic: composite.deterministic.codes,
        judge: classification,
        ...(composite.deterministic.decisive ? { decisive: composite.deterministic.decisive } : {}),
      });
    const verdict = decide(majorsRepaired);
    await this.ensureActive();

    const checkedMask = compositeInput.mask;
    const checked: CheckedAttempt = {
      attemptNo,
      attempt,
      plan,
      judge,
      candidate: composite.candidate,
      verdict,
      deterministic: composite.deterministic.codes,
      decorations:
        localized && localized.keptRegions.length > 0
          ? localized.keptRegions
          : plan.placements.map((placement) => placement.region),
      restore:
        aligned && checkedMask
          ? (boxes) =>
              compositeAndCheck({ ...compositeInput, mask: withRestoredSpots(checkedMask, boxes) })
          : null,
    };
    const accepted =
      verdict.verdict === 'pass' ||
      (verdict.verdict === 'uncertain' &&
        (this.job.reviewMode === 'pre_delivery' ||
          this.deliversUncertain(verdict, repairOpen, this.relights())));
    if (accepted) {
      // A doubt delivered as it stands has its doubted spots put back when that costs little.
      const doubted = verdict.verdict === 'uncertain' && this.job.reviewMode !== 'pre_delivery';
      return this.goOnAccepted({
        ...checked,
        candidate: doubted ? await this.restoreDoubts(checked) : checked.candidate,
      });
    }

    // Failed (or uncertain in sampled audit mode).
    const rejectAttempt = () =>
      this.deps.db
        .updateTable('renderAttempts')
        .set({ outcome: 'qa_rejected' })
        .where('id', '=', attempt.id)
        .execute();
    const codes = verdict.codes;
    // A first decorate attempt with repairable codes is repaired once, the decorated base of a
    // relight-mode job included (its relight then takes the third attempt). An attempt whose
    // verdict is a deliverable doubt, that would pass with no repair after it, or whose objected
    // spots qualify for the last resort, is kept as the job's picture should the repair end
    // without an accepted one.
    if (repairOpen && isRepairable(codes)) {
      await rejectAttempt();
      this.kept = this.keepable(checked, majorsRepaired ? decide(false) : verdict);
      const { critical, uncertain, major } = this.options.judgeThresholds;
      // An uncertain rejection carries the boxes of its findings at or above the uncertainty
      // floor, so the repair can restore them.
      const findings = findingsFrom(
        judge,
        composite.deterministic.codes,
        verdict.verdict === 'uncertain' ? { critical, uncertain, major } : { critical, major },
      );
      if (verdict.verdict === 'uncertain') {
        for (const code of codes)
          if (!findings.some((f) => f.code === code)) findings.push({ code });
      }
      const repair = deriveRepair(plan, planned.placementKeys, findings, judge);
      await this.advance('planning', {
        repairConstraints: toJson({ ...repair, codes, verdict: verdict.verdict }),
      });
      return 'next';
    }
    // The repair of a kept attempt was rejected. A kept deliverable doubt goes on as an accepted
    // doubt, and a kept passing attempt as it stands with its majors recorded, before the
    // repair's own spots are considered.
    const kept = this.keptBefore(attemptNo);
    this.kept = null;
    if (kept?.as === 'doubt' || kept?.as === 'passing') {
      await rejectAttempt();
      this.log.info(
        {
          keptAttemptId: kept.checked.attempt.id,
          keptAs: kept.as,
          codes,
          recordedMajors: kept.checked.verdict.recordedMajors,
        },
        'repair rejected; the kept attempt goes on',
      );
      return this.goOnAccepted(
        kept.as === 'doubt'
          ? { ...kept.checked, candidate: await this.restoreDoubts(kept.checked) }
          : kept.checked,
        attemptNo,
      );
    }
    // The last resort: every spot the judge objected to is put back from the original, and the
    // attempt goes on as a doubt when enough decorations remain; failing that, the same on the
    // first attempt the job kept through this repair.
    const restored = await this.restoreObjections(checked);
    if (restored) return this.goOnAccepted(restored);
    const keptRestored = kept ? await this.restoreObjections(kept.checked) : null;
    if (kept && keptRestored) {
      await rejectAttempt();
      this.log.info(
        { keptAttemptId: kept.checked.attempt.id, codes },
        'repair rejected; the kept attempt goes on with its objected spots put back',
      );
      return this.goOnAccepted(keptRestored, attemptNo);
    }
    await rejectAttempt();
    await this.reject(attemptNo, attempt, verdict);
    return 'done';
  }

  /**
   * Goes on with an accepted decorate attempt (passed, a doubt accepted, or a picture with spots
   * put back) at the job's attempt `attemptNo`: a plain look delivers it; the decorated base of a
   * relit look is relit by the next attempt (after attempt 1; after a later attempt only while
   * the time budget and the paid-attempt cap allow it), and is otherwise the job's fallback.
   */
  private async goOnAccepted(
    checked: CheckedAttempt,
    attemptNo: RenderAttemptNumber = checked.attemptNo,
  ): Promise<'next' | 'done'> {
    this.kept = null;
    const { attempt, plan, judge, candidate, verdict } = checked;
    if (this.relights()) {
      if (attemptNo === 1) return this.acceptRelightBase(attempt, plan, judge, candidate, verdict);
      if (await this.repairAllowed()) {
        return this.acceptRelightBase(attempt, plan, judge, candidate, verdict, { guarded: true });
      }
      return this.endWithRepairedBase(attempt, plan, judge, candidate, verdict);
    }
    await this.deliver(attempt, plan, judge, candidate, verdict);
    return 'done';
  }

  /**
   * The spots of a rejected decorate attempt that the last resort puts back (`objectedSpots`), or
   * null when they do not qualify or the output was not registered.
   */
  private objectionsOf(checked: CheckedAttempt): ObjectedSpots | null {
    if (!checked.restore) return null;
    return objectedSpots({
      judge: checked.judge,
      deterministic: checked.deterministic,
      verdict: checked.verdict,
      thresholds: this.options.judgeThresholds,
    });
  }

  /**
   * A rejected decorate attempt with every spot the judge objected to put back from the original
   * (`objectionsOf`), as an attempt accepted with a doubt: verdict `uncertain` with the verdict's
   * codes, its confident majors without a box recorded. When putting back the boxes of the
   * confident majors too would leave too little of the decorations, the boxes of the critical
   * findings alone are put back and those majors are recorded as well (`criticalSpotsOnly`). Null
   * when the spots do not qualify, too little of the decorations would remain either way, or the
   * deterministic checks of the restored picture report a code. The judge is not called again.
   */
  private async restoreObjections(checked: CheckedAttempt): Promise<CheckedAttempt | null> {
    const objected = this.objectionsOf(checked);
    if (!objected) return null;
    const criticalOnly = criticalSpotsOnly(objected);
    const spots =
      criticalOnly && !this.enoughLeftAfter(checked, objected.boxes, 'objected')
        ? criticalOnly
        : objected;
    const candidate = await this.restoreSpots(checked, spots, 'objected');
    if (!candidate) return null;
    return {
      ...checked,
      candidate,
      verdict: {
        verdict: 'uncertain',
        codes: checked.verdict.codes,
        recordedMajors: spots.recordedMajors,
      },
    };
  }

  /**
   * What the job keeps of a decorate attempt that goes to repair (`KeptAttempt`): a deliverable
   * doubt; an attempt whose verdict with no repair after it (`passing`) is a pass, kept with that
   * verdict; or a rejected attempt whose objected spots qualify for the last resort; else null.
   */
  private keepable(checked: CheckedAttempt, passing: AttemptVerdict): KeptAttempt | null {
    const { verdict } = checked;
    if (verdict.verdict === 'uncertain' && uncertainDeliverable(verdict.codes)) {
      return { checked, as: 'doubt' };
    }
    if (passing.verdict === 'pass')
      return { checked: { ...checked, verdict: passing }, as: 'passing' };
    return this.objectionsOf(checked) ? { checked, as: 'objected' } : null;
  }

  /** The attempt the job kept through the repair at `attemptNo`, if any. */
  private keptBefore(attemptNo: RenderAttemptNumber): KeptAttempt | null {
    return this.kept && this.kept.checked.attemptNo < attemptNo ? this.kept : null;
  }

  /**
   * The picture of a doubted decorate attempt that goes on as it stands, with its doubted spots
   * that have a box put back from the original when that keeps enough of the decorations
   * (`lastResort.minKeptShareDoubt`) and the deterministic checks pass; otherwise the picture as
   * it is.
   */
  private async restoreDoubts(checked: CheckedAttempt): Promise<Raster> {
    const spots = checked.restore
      ? doubtedSpots(checked.judge, this.options.judgeThresholds)
      : null;
    if (!spots) return checked.candidate;
    return (await this.restoreSpots(checked, spots, 'doubted')) ?? checked.candidate;
  }

  /** What putting `boxes` back from the original leaves of a checked attempt's decorations. */
  private decorationsLeftAfter(
    checked: CheckedAttempt,
    boxes: readonly NormalizedBox[],
  ): DecorationsLeft {
    return decorationsLeft({
      width: this.working.width,
      height: this.working.height,
      decorations: checked.decorations,
      placements: checked.plan.placements.map((placement) => placement.region),
      boxes,
    });
  }

  /** Whether putting `boxes` back leaves enough of the decorations for `kind`. */
  private enoughLeftAfter(
    checked: CheckedAttempt,
    boxes: readonly NormalizedBox[],
    kind: RestoredRecord['kind'],
  ): boolean {
    return enoughDecorationsLeft(this.decorationsLeftAfter(checked, boxes), kind);
  }

  /**
   * Composites a checked attempt again with `spots` restored, when enough of the decorations
   * remains for `kind` (`enoughDecorationsLeft`) and the deterministic checks of the restored
   * picture report no code; records what was restored on the attempt
   * (`composite_mask.restored`). Null otherwise.
   */
  private async restoreSpots(
    checked: CheckedAttempt,
    spots: JudgedSpots & { recordedMajors?: MajorFailureCode[] },
    kind: RestoredRecord['kind'],
  ): Promise<Raster | null> {
    if (!checked.restore) return null;
    const left = this.decorationsLeftAfter(checked, spots.boxes);
    if (!enoughDecorationsLeft(left, kind)) {
      this.log.info({ kind, ...left }, 'too little of the decorations would remain; not restored');
      return null;
    }
    let composite: CompositeResult;
    try {
      composite = await checked.restore(spots.boxes);
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.log.warn({ err: error, kind }, 'the restored picture could not be composited');
      return null;
    }
    const { codes, decisive } = composite.deterministic;
    if (codes.length > 0 || (decisive?.length ?? 0) > 0) {
      this.log.info({ kind, codes }, 'the restored picture fails the deterministic checks');
      return null;
    }
    const recordedMajors = spots.recordedMajors ?? [];
    const record: RestoredRecord = {
      kind,
      codes: spots.codes,
      boxes: spots.boxes,
      keptShare: Math.round(left.keptShare * 10_000) / 10_000,
      ...(recordedMajors.length > 0 ? { recordedMajors } : {}),
    };
    const row = await this.deps.db
      .selectFrom('renderAttempts')
      .select('compositeMask')
      .where('id', '=', checked.attempt.id)
      .executeTakeFirst();
    await this.deps.db
      .updateTable('renderAttempts')
      .set({
        compositeMask: toJson({
          ...((row?.compositeMask as Record<string, unknown> | null) ?? {}),
          restored: record,
        }),
      })
      .where('id', '=', checked.attempt.id)
      .execute();
    this.log.info(record, 'spots put back from the original');
    return composite.candidate;
  }

  /**
   * The repair of an attempt the job kept (`KeptAttempt`) ended without a QA decision: its edit or
   * check failed with a failure a relight falls back on (`RELIGHT_FALLBACK_FAILURES`), or the
   * job's deadline passed after the edit was settled; or it was never sent because its planning
   * failed (the paid-attempt cap, a pause, the time guard or the deadline, or no usable anchors
   * after the repair's adjustments). The kept attempt is the job's picture: a deliverable doubt
   * with its doubted spots put back when that costs little, a passing attempt as it stands with
   * its confident majors recorded, otherwise with its objected spots put back (the last resort;
   * when that leaves too little or fails its checks, the failure stands). A plain look delivers
   * it; a bright job delivers it as its result and an evening job ends rejected with it as its
   * daylight variant, neither relit (`relight_not_attempted`; a passing base as a base that passed
   * and could not be relit). The repair
   * attempt is marked rejected when its edit had succeeded. Returns false (the failure stands)
   * without a kept attempt, for any other error, and for an abort while the edit may still be in
   * flight.
   */
  private async goOnWithKeptAfterFailedRepair(
    attemptNo: RenderAttemptNumber,
    error: unknown,
  ): Promise<boolean> {
    const kept = this.keptBefore(attemptNo);
    if (!kept || this.planned?.plan.relightOf) return false;
    if (!(error instanceof JobFailure || error instanceof JobAborted)) return false;
    const current = await readJob(this.deps.db, this.job.id);
    if (!current) return false;
    const planning = current.state === 'planning';
    const afterEdit = current.state === 'checking';
    if (!planning && !afterEdit && current.state !== 'rendering') return false;
    let failureKind: FailureKind;
    if (
      error instanceof JobFailure &&
      (RELIGHT_FALLBACK_FAILURES.includes(error.kind) ||
        (planning &&
          (error instanceof AttemptCapReached ||
            (error.kind === 'source_rejected' && error.detail === 'no_usable_anchors'))))
    ) {
      failureKind = error.kind;
    } else if (error instanceof JobAborted && this.deadlineHit) {
      failureKind = 'timeout';
    } else {
      return false;
    }
    if (this.signal.aborted && !(this.deadlineHit && (afterEdit || planning))) return false;
    // A repair whose planning failed was never written as an attempt.
    const repair = planning ? null : await this.currentAttempt(attemptNo);
    if (planning && (await this.attemptRows()).some((row) => row.attemptNo === attemptNo)) {
      return false;
    }
    this.kept = null;
    const picked =
      kept.as === 'doubt'
        ? { ...kept.checked, candidate: await this.restoreDoubts(kept.checked) }
        : kept.as === 'passing'
          ? kept.checked
          : await this.restoreObjections(kept.checked);
    if (!picked) return false;
    this.job = current;
    if (planning) {
      // The delivery and the rejection start from `checking`, which the job reaches through
      // `rendering` in one transaction.
      this.job = await this.deps.db.transaction().execute(async (trx) => {
        await transitionJob(trx, {
          jobId: this.job.id,
          from: 'planning',
          to: 'rendering',
          clock: this.deps.clock,
        });
        return transitionJob(trx, {
          jobId: this.job.id,
          from: 'rendering',
          to: 'checking',
          clock: this.deps.clock,
        });
      });
    } else if (!afterEdit) {
      await this.advance('checking', { renderCompletedAt: this.now() });
    }
    if (repair?.outcome === 'succeeded') {
      await this.deps.db
        .updateTable('renderAttempts')
        .set({ outcome: 'qa_rejected' })
        .where('id', '=', repair.id)
        .execute();
    }
    this.log.info(
      {
        keptAttemptId: kept.checked.attempt.id,
        keptAs: kept.as,
        failureKind,
        recordedMajors: picked.verdict.recordedMajors,
      },
      'repair ended without a QA decision; the kept attempt goes on',
    );
    const { attempt, plan, judge, candidate, verdict } = picked;
    const baseVerdict = verdict.verdict === 'pass' ? 'pass' : 'uncertain';
    if (!this.relights()) {
      await this.deliver(attempt, plan, judge, candidate, verdict);
      return true;
    }
    const why = {
      reason: 'relight_not_attempted' as const,
      relightAttemptId: null,
      codes: verdict.codes,
    };
    if (this.relightTarget() === 'bright') {
      await this.deliverBase(attempt, plan, judge, candidate, baseVerdict, why);
      return true;
    }
    // An evening job with a passing base ends as one whose relight could not be attempted after
    // its base passed; otherwise with the verdict that rejected the kept attempt.
    const rejectedAs: AttemptVerdict =
      kept.as === 'passing'
        ? { verdict: 'fail', codes: [], recordedMajors: [] }
        : kept.checked.verdict;
    await this.endEveningWithoutRelight({
      baseAttempt: attempt,
      plan,
      judge,
      candidate,
      baseVerdict,
      baseRenderAssetId: null,
      why,
      rejectAs: repair
        ? { attemptNo, attempt: repair, verdict: rejectedAs }
        : { attemptNo: kept.checked.attemptNo, attempt, verdict: rejectedAs },
    });
    return true;
  }

  /**
   * Whether an uncertain verdict is delivered as it stands (outside pre-delivery review, where a
   * reviewer decides): its doubts are all about a detail of the home (`uncertainDeliverable`), and
   * no repair can follow, or the attempt is the base of a relit look and a repair would leave too
   * little of the job's time for the relight (`uncertainRepairWithRelightMs`). A look that may
   * differ in a detail is delivered rather than none; with time for it, the doubt is repaired.
   */
  private deliversUncertain(
    verdict: AttemptVerdict,
    repairOpen: boolean,
    relightAhead: boolean,
  ): boolean {
    if (verdict.verdict !== 'uncertain' || !uncertainDeliverable(verdict.codes)) return false;
    if (!repairOpen || !isRepairable(verdict.codes)) return true;
    return relightAhead && this.shortForRepairAndRelight();
  }

  /**
   * Whether too little of the job's time is left to repair a decorated base and still relight it
   * (`uncertainRepairWithRelightMs`).
   */
  private shortForRepairAndRelight(): boolean {
    const elapsed = this.now().getTime() - (this.job.startedAt ?? this.now()).getTime();
    return this.options.maxJobDurationMs - elapsed < PIPELINE_DEFAULTS.uncertainRepairWithRelightMs;
  }

  /**
   * Whether a repair is still open after this attempt: the job has not used its one repair and
   * has an attempt left. `limit` is the job's attempt count (three for a relit look that decorates
   * its own base, two otherwise; null for two).
   */
  private repairLeft(attemptNo: RenderAttemptNumber, limit: number | null): boolean {
    return !this.job.repairUsed && attemptNo < (limit ?? STANDARD_RENDER_ATTEMPTS);
  }

  /**
   * Checks a relight against its decorated base (render spec, lighting modes): the relit output is
   * registered to the base (`camera_changed` and uncovered strips as for any output), the
   * attribution rectangles and padding are restored verbatim, the protected regions and structure
   * are compared with the base, a bright relight must not be darker than the base, and the judge
   * runs in relight mode for the target with the base as the reference. A relight that passes is
   * delivered (`global_relight`); a repairable rejection is repaired once with the stronger keep
   * clause while the job has its repair and an attempt left (the relight of an accepted daylight
   * variant is attempt 1 of two; the relight of a base this job decorated is attempt 2 or 3 of
   * three). A relight rejected for good ends an evening job rejected (its daylight variant
   * exists) and makes a bright job deliver its decorated base as the result.
   */
  private async checkRelight(
    attemptNo: RenderAttemptNumber,
    planned: PlannedRun,
    base: RelightBase,
  ): Promise<'next' | 'done'> {
    const plan = planned.plan;
    const attempt = await this.currentAttempt(attemptNo);
    if (!this.rawOutput && !attempt.candidateObjectKey) {
      // A redelivery of a job whose fallback to its base had already moved it to `checking`.
      const recorded = unfinishedEditFailure(attempt);
      if (recorded) throw recorded;
    }
    const input = await this.loadRelightInput(base);
    const rawBytes = await this.loadRawOutput(attempt);
    let composite: CompositeResult;
    try {
      composite = await compositeAndCheck({
        working: this.working,
        reference: input.raster,
        rawBytes,
        requested: { width: this.working.width, height: this.working.height },
        plan,
        analysis: this.analysis,
        mask: null,
        keptRegions: input.keptRegions,
        attributionRegion: this.attributionRegions,
        glowRegions: this.glowRegions(),
      });
    } catch (error) {
      if (this.signal.aborted) throw error;
      throw new JobFailure('provider_error', null, 'provider output could not be decoded');
    }
    await this.deps.db
      .updateTable('renderAttempts')
      .set({
        fidelityMode: 'global_relight',
        registrationTransform: toJson(registrationRecord(composite.alignment)),
      })
      .where('id', '=', attempt.id)
      .execute();
    const baseImage: ImageInput = {
      bytes: await encodeJpeg(input.raster, { quality: 92 }),
      width: input.raster.width,
      height: input.raster.height,
    };
    const { judge, classification } = await this.judgeAttempt(
      attempt,
      composite,
      plan,
      composite.deterministic.hints,
      { base: baseImage },
    );
    // A repair is open only while the job has it, an attempt is left, and the time budget and the
    // paid-attempt cap allow one; otherwise confident majors are recorded, not rejected.
    const repairOpen =
      this.repairLeft(attemptNo, base.baseJobId === this.job.id ? MAX_RENDER_ATTEMPTS : null) &&
      (await this.repairAllowed());
    const verdict = decideAttempt({
      attemptNumber: attemptNo,
      repairLeft: repairOpen,
      deterministic: composite.deterministic.codes,
      judge: classification,
      ...(composite.deterministic.decisive ? { decisive: composite.deterministic.decisive } : {}),
    });
    await this.ensureActive();
    if (
      verdict.verdict === 'pass' ||
      (verdict.verdict === 'uncertain' &&
        (this.job.reviewMode === 'pre_delivery' ||
          this.deliversUncertain(verdict, repairOpen, false)))
    ) {
      // A fallback to the base that this job recorded on the base attempt before its worker
      // stopped, while the base was being delivered, no longer holds: the relight is the result.
      await this.deps.db
        .updateTable('renderAttempts')
        .set({ fallback: null })
        .where('id', '=', base.baseAttemptId)
        .where('jobId', '=', this.job.id)
        .where(sql<string>`fallback->>'kind'`, '=', 'relight_fallback')
        .execute();
      await this.deliver(attempt, plan, input.judge ?? judge, composite.candidate, verdict);
      return 'done';
    }
    await this.deps.db
      .updateTable('renderAttempts')
      .set({ outcome: 'qa_rejected' })
      .where('id', '=', attempt.id)
      .execute();
    const codes = verdict.codes;
    if (repairOpen && isRepairable(codes)) {
      // The base and the verdict that accepted it stay with the job for a fallback to the base.
      await this.advance('planning', {
        repairConstraints: toJson({ ...this.storedState(), relight: true, codes }),
        subStage: 'relight',
      });
      return 'next';
    }
    if (plan.lightingMode === 'bright') {
      await this.deliverRelightBase(base, input, input.judge ?? judge, {
        reason: 'relight_rejected',
        relightAttemptId: attempt.id,
        codes,
      });
      return 'done';
    }
    if (base.baseJobId === this.job.id) {
      return this.endEveningWithOwnBase(
        base,
        input,
        { reason: 'relight_rejected', relightAttemptId: attempt.id, codes },
        { attemptNo, attempt, verdict },
      );
    }
    await this.reject(attemptNo, attempt, verdict);
    return 'done';
  }

  /**
   * The decorated base of a relight-mode job passed: attempt 1, or its repair (attempt 2). An
   * evening job publishes it as the `source` variant (its own key, labels and download) unless the
   * job runs in pre-delivery review; a bright job keeps it unpublished (`source` is not an offered
   * cell of its scene types). An unpublished base is stored for the relight unless the source is
   * transient. The attempt succeeded and the next attempt relights it, except when the time budget
   * or the paid-attempt cap allows no further edit: a bright job then delivers the base as its
   * result and an evening job ends rejected with the base as its daylight variant
   * (`endEveningWithoutRelight`). `guarded`: the caller already found that the budget and the cap
   * allow the relight.
   */
  private async acceptRelightBase(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    judge: JudgeResult,
    candidate: Raster,
    verdict: AttemptVerdict,
    options: { guarded?: boolean } = {},
  ): Promise<'next' | 'done'> {
    this.baseComposite = { attemptId: attempt.id, raster: candidate };
    const target = this.relightTarget();
    let baseRenderAssetId: string | null = null;
    if (
      target === 'evening' &&
      this.job.reviewMode !== 'pre_delivery' &&
      verdict.verdict === 'pass'
    ) {
      baseRenderAssetId = (await this.publishDaylightBase(attempt, plan, judge, candidate)).id;
    } else if (this.loaded.streetViewMode !== 'transient') {
      await this.deps.storage.put({
        bucket: 'private',
        key: keys.attempt(this.job.id, attempt.id, RELIGHT_BASE_FILE),
        body: await encodePng(candidate),
        contentType: 'image/png',
        provenance: { sourceKind: this.source.kind, permission: this.permission, derivative: true },
      });
    }
    const base: RelightBase = {
      base: 'attempt',
      baseJobId: this.job.id,
      baseAttemptId: attempt.id,
      basePlanId: attempt.decorationPlanId,
      baseRenderAssetId,
    };
    await this.deps.db
      .updateTable('renderAttempts')
      .set({ outcome: 'succeeded' })
      .where('id', '=', attempt.id)
      .execute();
    if (!options.guarded && !(await this.repairAllowed())) {
      const why = { reason: 'relight_not_attempted' as const, relightAttemptId: null, codes: [] };
      if (target === 'bright') {
        await this.deliverBase(attempt, plan, judge, candidate, verdict.verdict, why);
        return 'done';
      }
      return this.endEveningWithoutRelight({
        baseAttempt: attempt,
        plan,
        judge,
        candidate,
        baseVerdict: verdict.verdict,
        baseRenderAssetId,
        why,
        rejectAs: {
          attemptNo: attempt.attemptNo as RenderAttemptNumber,
          attempt,
          verdict: { verdict: 'fail', codes: [], recordedMajors: [] },
        },
      });
    }
    // A repaired base keeps the codes and verdict that rejected the first base, with which the
    // job ends when its relight cannot be attempted.
    const { codes, verdict: rejectedAs } = this.storedState();
    await this.advance('planning', {
      repairConstraints: toJson({
        relightBase: base,
        baseVerdict: verdict.verdict,
        ...(codes ? { codes, verdict: rejectedAs } : {}),
      }),
      subStage: 'relight',
    });
    return 'next';
  }

  /** Publishes an evening job's own decorated base as the `source` variant (a companion job). */
  private async publishDaylightBase(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    judge: JudgeResult | null,
    candidate: Raster,
  ): Promise<RenderAsset> {
    const deliverables = await buildDeliverables({
      candidate,
      contentBox: this.working.contentBox,
      source: this.source,
      permission: this.permission,
      quality: this.options.deliveredJpegQuality,
      downloadMark: this.options.downloadMark,
    });
    await this.assertPlaceNotBlocked();
    return publishBaseVariant(this.deps, {
      job: this.job,
      project: this.project,
      source: this.source,
      plan,
      attempt,
      judge,
      deliverables,
      nativeWidth: this.working.nativeWidth,
      nativeHeight: this.working.nativeHeight,
      scaleFactor: Math.min(99.999, this.working.scaleFactor),
      providerMode: this.providerMode(),
      providerWatermark: attempt.providerWatermark ?? 'unknown',
      providerManifestCaptured: attempt.providerManifestObjectKey !== null,
      permission: this.permission,
    });
  }

  /**
   * A relight-mode job's base was rejected and repaired (attempt 2), and the repair passed (or a
   * picture after it was accepted: the repair with its objected spots put back, or the first
   * base kept as a doubt), but the
   * time budget or the paid-attempt cap allows no third attempt for the relight. A bright job
   * delivers the repaired base as its result. An evening job ends rejected with the codes that
   * rejected the first base and the repaired base as its daylight variant (held for a reviewer in
   * pre-delivery review). Both record that the relight was not attempted.
   */
  private async endWithRepairedBase(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    judge: JudgeResult,
    candidate: Raster,
    verdict: AttemptVerdict,
  ): Promise<'done'> {
    const stored = this.storedState();
    const codes = stored.codes ?? [];
    const why = { reason: 'relight_not_attempted' as const, relightAttemptId: null, codes };
    if (this.relightTarget() === 'bright') {
      await this.deliverBase(attempt, plan, judge, candidate, verdict.verdict, why);
      return 'done';
    }
    return this.endEveningWithoutRelight({
      baseAttempt: attempt,
      plan,
      judge,
      candidate,
      baseVerdict: verdict.verdict,
      baseRenderAssetId: null,
      why,
      rejectAs: {
        attemptNo: 2,
        attempt,
        verdict: {
          verdict: stored.verdict === 'uncertain' ? 'uncertain' : 'fail',
          codes,
          recordedMajors: [],
        },
      },
    });
  }

  /**
   * Ends an evening job that decorated its own base without delivering its relight (the relight
   * was rejected for good, failed, or could not be attempted). The base is the job's daylight
   * variant: published unless the job runs in pre-delivery review (an earlier publication is
   * reused), and otherwise held for a reviewer as an as-photographed candidate under a companion
   * job in `needs_review`, so approval publishes the daylight look. The job ends rejected
   * (`rejectAs`) and the base attempt records why (`relight_fallback`).
   */
  private async endEveningWithoutRelight(input: {
    baseAttempt: RenderAttempt;
    plan: DecorationPlan;
    judge: JudgeResult | null;
    candidate: Raster;
    baseVerdict: AttemptVerdict['verdict'];
    /** The daylight variant already published from this base, if any. */
    baseRenderAssetId: string | null;
    why: Pick<RelightFallbackRecord, 'reason' | 'relightAttemptId' | 'codes' | 'failureKind'>;
    rejectAs: { attemptNo: RenderAttemptNumber; attempt: RenderAttempt; verdict: AttemptVerdict };
  }): Promise<'done'> {
    const review = this.job.reviewMode === 'pre_delivery';
    // Outside review a base accepted with a doubt is published like one that passed.
    const published =
      input.baseRenderAssetId !== null ||
      (!review && (input.baseVerdict === 'pass' || input.baseVerdict === 'uncertain'));
    if (published && input.baseRenderAssetId === null) {
      await this.publishDaylightBase(input.baseAttempt, input.plan, input.judge, input.candidate);
    }
    // The held files are written first; the companion that holds the base is the project's active
    // job, so it is inserted in the transaction that ends the evening job, after its update.
    const staged =
      !published && review
        ? await this.stageDaylightBase(input.baseAttempt, input.candidate, input.baseVerdict)
        : null;
    let held = staged?.existing ?? null;
    let record: RelightFallbackRecord | null = null;
    try {
      // The base attempt's record is written in the transaction that rejects the job, so a status
      // read at the rejection already finds the daylight variant through it.
      await this.reject(
        input.rejectAs.attemptNo,
        input.rejectAs.attempt,
        input.rejectAs.verdict,
        async (trx) => {
          if (staged && !staged.existing) held = await staged.insert(trx);
          record = {
            kind: 'relight_fallback',
            target: 'evening',
            deliveredAs: published ? 'daylight_variant' : null,
            ...input.why,
            ...(held ? { heldJobId: held.id } : {}),
          };
          await trx
            .updateTable('renderAttempts')
            .set({ outcome: 'succeeded', fallback: toJson(record) })
            .where('id', '=', input.baseAttempt.id)
            .execute();
        },
      );
    } catch (error) {
      await staged?.discard();
      throw error;
    }
    if (staged && !held) {
      this.log.warn('another job of the project is active; the daylight base is not held');
    }
    this.log.info(record, 'evening relight not delivered; the base is the daylight variant');
    return 'done';
  }

  /** `endEveningWithoutRelight` for the base a relight started from (its attempt, plan, pixels). */
  private async endEveningWithOwnBase(
    base: RelightBase,
    input: RelightInput,
    why: Pick<RelightFallbackRecord, 'reason' | 'relightAttemptId' | 'codes' | 'failureKind'>,
    rejectAs: { attemptNo: RenderAttemptNumber; attempt: RenderAttempt; verdict: AttemptVerdict },
  ): Promise<'done'> {
    const baseAttempt = await this.deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('id', '=', base.baseAttemptId)
      .executeTakeFirst();
    if (!baseAttempt) throw new JobFailure('internal_error', null, 'relight base attempt missing');
    return this.endEveningWithoutRelight({
      baseAttempt,
      plan: input.plan,
      judge: input.judge,
      candidate: input.raster,
      baseVerdict: this.storedState().baseVerdict ?? 'pass',
      baseRenderAssetId: base.baseRenderAssetId,
      why,
      rejectAs,
    });
  }

  /**
   * Stages an evening job's own decorated base for pre-delivery review as its as-photographed
   * candidate (`holdBaseVariant`): the held files are written, the companion job is inserted by
   * the caller in the transaction that ends the evening job.
   */
  private async stageDaylightBase(
    attempt: RenderAttempt,
    candidate: Raster,
    verdict: AttemptVerdict['verdict'],
  ): Promise<StagedBaseVariant> {
    const deliverables = await buildDeliverables({
      candidate,
      contentBox: this.working.contentBox,
      source: this.source,
      permission: this.permission,
      quality: this.options.deliveredJpegQuality,
      downloadMark: this.options.downloadMark,
    });
    await this.assertPlaceNotBlocked();
    return holdBaseVariant(this.deps, {
      job: this.job,
      source: this.source,
      attempt,
      deliverables,
      permission: this.permission,
      qaPassed: verdict === 'pass',
    });
  }

  /**
   * Delivers a bright job's decorated base as its result after the relight did not produce one
   * (rejected, failed or not attempted), recording why on the base attempt. The base was accepted
   * by its own QA (`verdict`: pass, or uncertain in pre-delivery review).
   */
  private async deliverBase(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    judge: JudgeResult | null,
    candidate: Raster,
    verdict: AttemptVerdict['verdict'],
    why: Pick<RelightFallbackRecord, 'reason' | 'relightAttemptId' | 'codes' | 'failureKind'>,
  ): Promise<void> {
    const record: RelightFallbackRecord = {
      kind: 'relight_fallback',
      target: 'bright',
      deliveredAs: 'result',
      ...why,
    };
    await this.deps.db
      .updateTable('renderAttempts')
      .set({ fallback: toJson(record) })
      .where('id', '=', attempt.id)
      .execute();
    this.log.info(record, 'bright relight not delivered; the decorated base is the result');
    await this.deliver(attempt, plan, judge, candidate, {
      verdict: verdict === 'uncertain' ? 'uncertain' : 'pass',
      codes: [],
      recordedMajors: [],
    });
  }

  /** Delivers the base a bright relight started from (its attempt, plan and pixels). */
  private async deliverRelightBase(
    base: RelightBase,
    input: RelightInput,
    judge: JudgeResult | null,
    why: Pick<RelightFallbackRecord, 'reason' | 'relightAttemptId' | 'codes' | 'failureKind'>,
  ): Promise<void> {
    const baseAttempt = await this.deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('id', '=', base.baseAttemptId)
      .executeTakeFirst();
    if (!baseAttempt) throw new JobFailure('internal_error', null, 'relight base attempt missing');
    await this.deliverBase(
      baseAttempt,
      input.plan,
      judge,
      input.raster,
      this.storedState().baseVerdict ?? 'pass',
      why,
    );
  }

  /**
   * A relight that ended without a QA decision: its edit failed (`provider_error`, `timeout`,
   * including a timeout bounded by the job's time left), its output could not be decoded, its
   * judge was unavailable, or the job's deadline passed while it was checked (the edit is settled
   * by then). A bright job delivers its decorated base as the result; an evening job that decorated
   * its own base ends rejected with that base as its daylight variant (`endEveningWithoutRelight`).
   * Returns false (the failure stands) for any other error, attempt or job, and for an abort while
   * the edit may still be in flight.
   */
  private async deliverBaseAfterFailedRelight(
    attemptNo: RenderAttemptNumber,
    error: unknown,
  ): Promise<boolean> {
    const relightOf = this.planned?.plan.relightOf;
    const target = this.planned?.plan.lightingMode;
    if (!relightOf || (target !== 'bright' && target !== 'evening')) return false;
    if (target === 'evening' && relightOf.baseJobId !== this.job.id) return false;
    if (!(error instanceof JobFailure || error instanceof JobAborted)) return false;
    const current = await readJob(this.deps.db, this.job.id);
    if (!current || (current.state !== 'rendering' && current.state !== 'checking')) return false;
    const afterEdit = current.state === 'checking';
    let failureKind: FailureKind;
    if (error instanceof JobFailure && RELIGHT_FALLBACK_FAILURES.includes(error.kind)) {
      failureKind = error.kind;
    } else if (error instanceof JobAborted && this.deadlineHit) {
      failureKind = 'timeout';
    } else {
      return false;
    }
    if (this.signal.aborted && !(this.deadlineHit && afterEdit)) return false;
    this.job = current;
    const input = await this.loadRelightInput(relightOf);
    const attempt = await this.currentAttempt(attemptNo);
    if (!afterEdit) await this.advance('checking', { renderCompletedAt: this.now() });
    const why = {
      reason: 'relight_failed' as const,
      relightAttemptId: attempt.id,
      codes: [],
      failureKind,
    };
    if (target === 'bright') {
      await this.deliverRelightBase(relightOf, input, input.judge, why);
      return true;
    }
    await this.endEveningWithOwnBase(relightOf, input, why, {
      attemptNo,
      attempt,
      verdict: { verdict: 'fail', codes: [], recordedMajors: [] },
    });
    return true;
  }

  /**
   * The paid-attempt cap, checked under the owner's allowance lock when the attempt row is
   * written, refused a relight of a base this job decorated itself (another job of the owner took
   * the last attempt after this job's own check). The base ends the job as when the cap closes
   * the relight before it is planned: a bright job delivers it as the result and an evening job
   * ends rejected with it as the daylight variant (held for a reviewer in pre-delivery review).
   * The fallback records `relight_not_attempted` with the codes that rejected a repaired base's
   * first attempt, or, when the refused attempt was the repair of a rejected relight,
   * `relight_rejected` with that relight and its codes. Returns false (the job fails
   * `policy_denied`) for any other attempt: a decorate attempt, or the relight of a variant
   * another job published.
   */
  private async deliverBaseAfterRefusedRelight(attemptNo: RenderAttemptNumber): Promise<boolean> {
    const relightOf = this.planned?.plan.relightOf;
    const target = this.planned?.plan.lightingMode;
    if (!relightOf || relightOf.baseJobId !== this.job.id) return false;
    if (target !== 'bright' && target !== 'evening') return false;
    const stored = this.storedState();
    const codes = stored.codes ?? [];
    const previous = await this.currentAttempt(attemptNo - 1);
    const rejectedRelight = stored.relight === true ? previous : null;
    const input = await this.loadRelightInput(relightOf);
    // No attempt row was written. The delivery and the rejection start from `checking`, which
    // the job reaches through `rendering` in one transaction.
    this.job = await this.deps.db.transaction().execute(async (trx) => {
      await transitionJob(trx, {
        jobId: this.job.id,
        from: 'planning',
        to: 'rendering',
        clock: this.deps.clock,
      });
      return transitionJob(trx, {
        jobId: this.job.id,
        from: 'rendering',
        to: 'checking',
        clock: this.deps.clock,
      });
    });
    const why = rejectedRelight
      ? { reason: 'relight_rejected' as const, relightAttemptId: rejectedRelight.id, codes }
      : { reason: 'relight_not_attempted' as const, relightAttemptId: null, codes };
    this.log.info({ attemptNo, ...why }, 'paid-attempt cap reached; the base ends the job');
    if (target === 'bright') {
      await this.deliverRelightBase(relightOf, input, input.judge, why);
      return true;
    }
    await this.endEveningWithOwnBase(relightOf, input, why, {
      attemptNo: previous.attemptNo as RenderAttemptNumber,
      attempt: previous,
      verdict: {
        verdict: !rejectedRelight && stored.verdict === 'uncertain' ? 'uncertain' : 'fail',
        codes,
        recordedMajors: [],
      },
    });
    return true;
  }

  /**
   * A Street View place put on the opt-out list while its job ran is not published: the job
   * fails as `prepare` fails it for a place blocked before the job started.
   */
  private async assertPlaceNotBlocked(): Promise<void> {
    if (this.source.kind !== 'street_view') return;
    if (await isPropertyBlocked(this.deps.db, this.project.propertyId, this.now())) {
      throw new JobFailure('source_rejected', null, 'Place is on the opt-out list');
    }
  }

  /** Delivers an accepted candidate: held for pre-delivery review, or published. */
  private async deliver(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    judge: JudgeResult | null,
    candidate: Raster,
    verdict: AttemptVerdict,
  ): Promise<void> {
    const deliverables = await buildDeliverables({
      candidate,
      contentBox: this.working.contentBox,
      source: this.source,
      permission: this.permission,
      quality: this.options.deliveredJpegQuality,
      downloadMark: this.options.downloadMark,
    });
    const qaPassed = verdict.verdict === 'pass';
    await this.assertPlaceNotBlocked();
    if (this.job.reviewMode === 'pre_delivery') {
      this.job = await holdForReview(this.deps, {
        job: this.job,
        source: this.source,
        attempt,
        deliverables,
        permission: this.permission,
        qaPassed,
      });
      return;
    }
    await publishAccepted(this.deps, {
      job: this.job,
      project: this.project,
      source: this.source,
      plan,
      attempt,
      judge,
      deliverables,
      nativeWidth: this.working.nativeWidth,
      nativeHeight: this.working.nativeHeight,
      scaleFactor: Math.min(99.999, this.working.scaleFactor),
      providerMode: this.providerMode(),
      providerWatermark: attempt.providerWatermark ?? 'unknown',
      providerManifestCaptured: attempt.providerManifestObjectKey !== null,
      permission: this.permission,
      from: 'checking',
      patch: { qaPassedAt: this.now() },
    });
    this.job = (await readJob(this.deps.db, this.job.id)) ?? this.job;
  }

  /** Ends the job `rejected` after a failed attempt with no repair left. */
  private async reject(
    attemptNo: RenderAttemptNumber,
    attempt: RenderAttempt,
    verdict: AttemptVerdict,
    within?: (trx: Tx) => Promise<void>,
  ): Promise<void> {
    const codes = verdict.codes;
    const rejectionReason = verdict.verdict === 'uncertain' ? 'qa_uncertain' : 'qa_critical';
    if (codes.includes('attribution_altered')) {
      this.log.error('attribution region altered after restoration');
    }
    if (codes.includes('unsafe_or_offensive')) {
      this.log.warn({ attemptId: attempt.id }, 'attempt flagged for content review');
    }
    await this.finish(
      'rejected',
      { rejectionReason, failureCodes: codes as FailureCode[] },
      within,
    );
    await emitServerEvent(this.deps.db, this.deps, {
      name: 'render_rejected',
      ownerId: this.job.ownerId,
      holidayId: this.job.holidayId,
      sceneType: this.sceneType,
      sourceKind: this.source.kind,
      fixture: this.providerMode() === 'fixture',
      properties: { rejectionReason, failureCodes: codes, attempts: attemptNo },
    });
  }

  // ---- daylight variants -----------------------------------------------------------------------

  /** Existing window anchors (measured fixture geometry when known). */
  private windowBoxes(): NormalizedBox[] {
    return (
      this.fixture.geometry?.windows ??
      this.analysis.anchors
        .filter((a) => a.category === 'window_frame' || a.category === 'interior_window')
        .map((a) => a.box)
    );
  }

  /**
   * The accepted `source` variant of the same key (source asset, holiday, style, pack and
   * compiler versions, working grid), as the base of an evening relight: its attempt (the one that
   * rendered it, also when an evening job published it as its base) and plan.
   */
  private async acceptedSourceVariant(): Promise<RelightBase | null> {
    const asset = await this.deps.db
      .selectFrom('renderAssets as a')
      .innerJoin('renderJobs as j', 'j.id', 'a.jobId')
      .selectAll('a')
      .select('j.inputSnapshot as jobInputSnapshot')
      .where('a.ownerId', '=', this.job.ownerId)
      .where('a.sourceAssetId', '=', this.source.id)
      .where('a.holidayId', '=', this.job.holidayId)
      .where('a.style', '=', this.job.style)
      .where('a.lightingMode', '=', 'source')
      .where('a.holidayPackVersion', '=', this.job.holidayPackVersion)
      .where('a.compilerVersion', '=', this.job.compilerVersion)
      .where('a.deletedAt', 'is', null)
      .where('a.withdrawnAt', 'is', null)
      .where('j.workingChecksumSha256', '=', this.working.checksum)
      .orderBy('a.createdAt', 'desc')
      .executeTakeFirst();
    if (!asset) return null;
    const producedBy = (
      asset.jobInputSnapshot as { relightBaseOf?: { attemptId?: unknown } } | null
    )?.relightBaseOf?.attemptId;
    const attempt =
      typeof producedBy === 'string'
        ? await this.deps.db
            .selectFrom('renderAttempts')
            .selectAll()
            .where('id', '=', producedBy)
            .where('outcome', '=', 'succeeded')
            .executeTakeFirst()
        : await this.deps.db
            .selectFrom('renderAttempts')
            .selectAll()
            .where('jobId', '=', asset.jobId)
            .where('outcome', '=', 'succeeded')
            .orderBy('attemptNo', 'desc')
            .executeTakeFirst();
    if (!attempt) return null;
    const planRow = await this.deps.db
      .selectFrom('decorationPlans')
      .select('document')
      .where('id', '=', attempt.decorationPlanId)
      .executeTakeFirst();
    const plan = DecorationPlanSchema.safeParse(planRow?.document);
    if (!plan.success || plan.data.lightingMode !== 'source') return null;
    return {
      base: 'variant',
      baseJobId: attempt.jobId,
      baseAttemptId: attempt.id,
      basePlanId: attempt.decorationPlanId,
      baseRenderAssetId: asset.id,
    };
  }

  /** An accepted variant's delivered pixels back on the working grid (padding restored). */
  private async variantComposite(asset: RenderAsset): Promise<Raster | null> {
    const object = await this.deps.storage.get('private', asset.objectKey);
    if (!object) return null;
    let decoded: Raster;
    try {
      decoded = await decodeRaster(object.body);
    } catch {
      return null;
    }
    const working = this.working.raster;
    const rect = this.working.contentBox
      ? toRect(this.working.contentBox, working.width, working.height)
      : { x0: 0, y0: 0, x1: working.width, y1: working.height };
    if (decoded.width !== rect.x1 - rect.x0 || decoded.height !== rect.y1 - rect.y0) return null;
    if (!this.working.contentBox) return decoded;
    const out: Raster = { ...working, data: Buffer.from(working.data) };
    const row = decoded.width * 3;
    for (let y = 0; y < decoded.height; y += 1) {
      decoded.data.copy(
        out.data,
        ((rect.y0 + y) * working.width + rect.x0) * 3,
        y * row,
        (y + 1) * row,
      );
    }
    return out;
  }

  /** Whether the owner's paid-attempt cap allows one more attempt. */
  private async attemptCapAllows(db: DbOrTx = this.deps.db, limit?: number): Promise<boolean> {
    const quota = await attemptQuota(db, this.deps.settings, {
      ownerId: this.job.ownerId,
      now: this.now(),
      projected: 1,
      ...(limit === undefined ? {} : { limit }),
    });
    return quota.used <= quota.limit;
  }

  /**
   * The timeout of an edit bounded by the job's time left (a relight's, and a repair's while the
   * job keeps an attempt to fall back on): the render timeout, or the job's time left minus
   * `PIPELINE_DEFAULTS.relightDeadlineGuardMs` when that is shorter (at least
   * `relightMinTimeoutMs`).
   */
  private boundedEditTimeoutMs(): number {
    return Math.max(
      PIPELINE_DEFAULTS.relightMinTimeoutMs,
      Math.min(this.options.renderTimeoutMs, Math.floor(this.editTimeLeftMs())),
    );
  }

  /** The job's time left minus `PIPELINE_DEFAULTS.relightDeadlineGuardMs`. */
  private editTimeLeftMs(): number {
    const elapsed = this.now().getTime() - (this.job.startedAt ?? this.now()).getTime();
    return this.options.maxJobDurationMs - elapsed - PIPELINE_DEFAULTS.relightDeadlineGuardMs;
  }

  /** Repair guards: time budget and the owner's paid-attempt cap. */
  private async repairAllowed(): Promise<boolean> {
    const elapsed = this.now().getTime() - (this.job.startedAt ?? this.now()).getTime();
    if (this.options.maxJobDurationMs - elapsed <= this.options.repairBudgetMs) return false;
    return this.attemptCapAllows();
  }

  // ---- terminal handling ---------------------------------------------------------------------

  /** Reservations of attempts whose cost is still unknown (kept open for reconciliation). */
  private async inFlightReservations(): Promise<string[]> {
    const rows = await this.deps.db
      .selectFrom('renderAttempts')
      .select('reservationEntryId')
      .where('jobId', '=', this.job.id)
      .where('outcome', 'in', ['unknown', 'canceled', 'pending'])
      .where('providerOperationId', 'is not', null)
      .execute();
    return rows.map((row) => row.reservationEntryId).filter((id): id is string => id !== null);
  }

  /**
   * Ends the job `failed` or `rejected`, releasing its open reservations (except those of
   * attempts whose cost is still unknown); `within` runs last in the same transaction.
   */
  private async finish(
    to: 'failed' | 'rejected',
    patch: JobPatch,
    within?: (trx: Tx) => Promise<void>,
  ): Promise<void> {
    const except = await this.inFlightReservations();
    this.job = await transitionJob(this.deps.db, {
      jobId: this.job.id,
      from: this.job.state,
      to,
      patch,
      clock: this.deps.clock,
      within: async (trx) => {
        await releaseRemaining(trx, this.job.id, this.deps.clock, except);
        if (within) await within(trx);
      },
    });
  }

  private async fail(kind: FailureKind, detail: FailureDetail | null): Promise<void> {
    const current = await readJob(this.deps.db, this.job.id);
    if (!current || isTerminalRenderJobState(current.state)) return;
    this.job = current;
    await this.finish('failed', { failureKind: kind, failureDetail: detail });
    await emitServerEvent(this.deps.db, this.deps, {
      name: 'render_failed',
      ownerId: this.job.ownerId,
      holidayId: this.job.holidayId,
      sceneType: this.source?.sceneType ?? null,
      sourceKind: this.source?.kind ?? null,
      fixture: (this.legs?.mode ?? 'fixture') !== 'live',
      properties: { failureKind: kind, failureDetail: detail, attempts: this.job.attemptCount },
    });
  }

  /** Releases what a stopped run still holds; an in-flight attempt keeps its reservation. */
  private async releaseStopped(): Promise<void> {
    const except = await this.inFlightReservations();
    await releaseRemaining(this.deps.db, this.job.id, this.deps.clock, except);
  }

  private async handleError(error: unknown): Promise<RenderJobResult> {
    try {
      if (
        error instanceof RunStopped ||
        error instanceof EnhancementRunStopped ||
        error instanceof LostRaceError
      ) {
        await this.releaseStopped();
        const current = await readJob(this.deps.db, this.job.id);
        return { state: current?.state ?? this.job.state, stopped: true };
      }
      if (error instanceof JobAborted || this.signal.aborted) {
        const current = await readJob(this.deps.db, this.job.id);
        if (current && isTerminalRenderJobState(current.state)) {
          await this.releaseStopped();
          return { state: current.state, stopped: true };
        }
        if (this.deadlineHit) {
          await this.fail('timeout', null);
          return { state: this.job.state, stopped: false };
        }
        // The queue aborted the job without a domain decision (worker shutdown): leave it for
        // the transport retry, which resumes from the recorded state.
        throw error;
      }
      if (error instanceof JobFailure) {
        await this.fail(error.kind, error.detail);
        return { state: this.job.state, stopped: false };
      }
      if (error instanceof ProviderError) {
        this.log.warn({ kind: error.kind, provider: error.provider }, 'provider call failed');
        await this.fail(
          error.kind === 'moderation_blocked' ? 'moderation_blocked' : 'provider_error',
          null,
        );
        return { state: this.job.state, stopped: false };
      }
      this.log.error({ err: error }, 'render job failed with an internal error');
      await this.fail('internal_error', null);
      return { state: this.job.state, stopped: false };
    } catch (handlingError) {
      if (handlingError === error) throw error;
      this.log.error({ err: handlingError }, 'could not record the render job failure');
      throw error;
    }
  }
}
