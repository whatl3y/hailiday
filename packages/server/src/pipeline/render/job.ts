import { z } from 'zod';
import {
  BuildingFormSchema,
  CompiledRequestSchema,
  COMPILED_REQUEST_SCHEMA_VERSION,
  DecorationPlanSchema,
  JudgeResultSchema,
  LocalizationRecordSchema,
  RelightBaseSchema,
  RoomTypeSchema,
  SceneAnalysisSchema,
  SceneTypeSchema,
  SpecAttributesSchema,
  TERMINAL_RENDER_JOB_STATES,
  isCriticalFailureCode,
  isTerminalRenderJobState,
  type BuildingForm,
  type CompiledRequest,
  type DecorationPlan,
  type FailureCode,
  type FailureDetail,
  type FailureKind,
  type HolidayPack,
  type JudgeResult,
  type LightingMode,
  type LocalizationRecord,
  type LocalizedAdditionRecord,
  type NormalizedBox,
  type ProviderMode,
  type RelightAttemptRecord,
  type RelightBase,
  type RenderJobState,
  type RoomType,
  type SceneAnalysis,
  type SceneType,
  type SpecAttributes,
  type UserRole,
} from '@holiday/core';
import { readPackByRef } from '../../content/load.js';
import { toJson } from '../../db/client.js';
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
  VISION_PRICES_MICROS,
  release,
  unitPriceFor,
  usageCostMicros,
  type ReportedUsage,
} from '../../ledger/index.js';
import { attemptQuota } from '../../limits/index.js';
import { evaluateAndRecord, isEditable, type AssetPermission } from '../../policy/index.js';
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
import { JobAborted, JobFailure, sleep } from './errors.js';
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
import { localizedKeepMask, renderCompositeMask } from './mask.js';
import {
  buildDeliverables,
  holdForReview,
  publishAccepted,
  publishBaseVariant,
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
  registerOutput,
  restoredChangeHints,
  type AttemptVerdict,
  type CompositeResult,
  type JudgeClassification,
} from './quality.js';
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

/** The editor answered with a reply that carries no image (nothing billed for an image). */
const NO_IMAGE = 'no_image';

/**
 * Whether a failed edit carries the vendor's answer (an HTTP status, or a reply without an
 * image). A failure without one (connection loss, unreadable body, client timeout, a status
 * query a provider cannot answer) may have been billed.
 */
function vendorAnswered(outcome: Extract<EditOutcome, { status: 'failed' }>): boolean {
  return outcome.httpStatus !== undefined || outcome.providerCode === NO_IMAGE;
}

/**
 * A 200 response whose body could not be read: the vendor most likely rendered and billed the
 * image, so the outcome is unknown rather than an unbilled provider error.
 */
function unreadableAnswer(outcome: Extract<EditOutcome, { status: 'failed' }>): boolean {
  return outcome.httpStatus === 200 && outcome.providerCode === 'invalid_json';
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

/** The daylight image an evening relight starts from, loaded on the working grid. */
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
}

/** One judge call's result before it is recorded. */
interface JudgeCall {
  result: JudgeResult;
  refused: boolean;
  call: VisionCallResult<JudgeResult> | null;
}

/** Where an evening job's own daylight base is stored when it is not published (review mode). */
const RELIGHT_BASE_FILE = 'relight-base.png';

function sameItem(a: LocalizedAdditionRecord, b: LocalizedAdditionRecord): boolean {
  return a.label === b.label && a.placementId === b.placementId && a.box.join() === b.box.join();
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
  private working!: WorkingImage;
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
  /** The daylight image of the current evening relight, once loaded. */
  private relightInput: RelightInput | null = null;
  /** This job's own accepted daylight composite, when an evening job rendered its base first. */
  private baseComposite: { attemptId: string; raster: Raster } | null = null;

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
      appEnv: this.deps.config.appEnv,
      sourceKind: this.source.kind,
      isGoogleImagery: this.source.isGoogleImagery,
      jobId: this.job.id,
      stage,
      clock: this.deps.clock,
    });
    this.permission = result.permission;
    return result;
  }

  private async prepare(): Promise<void> {
    await this.ensureActive();
    const source = await this.deps.db
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
    }
    this.loaded = await loadSourcePixels(this.deps, {
      job: this.job,
      source,
      permission,
      legs: this.legs,
      signal: this.signal,
    });
    this.checkAbort();
    try {
      this.working = await prepareWorkingImage(this.loaded.bytes, source.kind);
    } catch {
      throw new JobFailure('source_unavailable', null, 'source image could not be decoded');
    }
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
    await this.deps.db
      .updateTable('renderJobs')
      .set({
        workingWidth: this.working.width,
        workingHeight: this.working.height,
        workingChecksumSha256: this.working.checksum,
        resampler: this.working.resampler,
        workingCropBox: this.working.cropBox ? toJson(this.working.cropBox) : null,
        workingPadBox: this.working.contentBox ? toJson(this.working.contentBox) : null,
        scaleFactor: Math.min(99.999, this.working.scaleFactor),
        workingObjectKey,
      })
      .where('id', '=', this.job.id)
      .execute();
    if (this.job.state === 'preparing') await this.advance('analyzing');
  }

  /**
   * The embedded attribution rectangles of a Street View-origin source on the working grid: for a
   * live frame, the rectangles configured for its requested size (`STREET_VIEW_ATTRIBUTION_REGIONS`,
   * normalized to the Static image) mapped through the aspect crop and the padding; for a fixture
   * frame, the rectangle its renderer drew. Other sources have none.
   */
  private attributionRegionsOf(source: SourceAsset): NormalizedBox[] {
    if (source.kind === 'street_view' && this.legs.mode === 'live') {
      const viewpoint = source.viewpoint;
      if (!viewpoint) return [];
      const configured =
        this.deps.config.streetView.attributionRegions[`${viewpoint.width}x${viewpoint.height}`];
      return configured ? nativeBoxesOnWorkingGrid(configured, this.working) : [];
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

  private async declineSource(
    reason: 'provider_refused' | null,
    extra: { providerRefusedAt?: Date } = {},
  ): Promise<void> {
    await this.deps.db
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
      .execute();
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
    await this.sourceChecks();
    if (this.job.state === 'analyzing') await this.advance('planning');
  }

  /** Street View refusals before any paid edit (render spec rule 4a; address spec blur rules). */
  private async sourceChecks(): Promise<void> {
    const analysis = this.analysis;
    const streetView = this.source.kind === 'street_view';
    if (streetView && this.sceneType === 'house_exterior') {
      const facade = analysis.targetFacade;
      if (!facade || analysis.targetFacadeAmbiguous) {
        await this.declineSource(null);
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
    if (this.job.lightingMode === 'evening' && !analysis.lighting.isDaylight) {
      throw new JobFailure('source_rejected', null, 'evening needs a daylight source');
    }
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
    await this.deps.db
      .insertInto('blockedAddresses')
      .values({
        id: newId(),
        placeId: property.placeId,
        source: 'google_blur_detected',
        evidenceRef: `render_job:${this.job.id}`,
        createdBy: null,
      })
      .onConflict((oc) => oc.column('placeId').doNothing())
      .execute();
  }

  // ---- planning, rendering, checking ---------------------------------------------------------

  private async runAttempts(): Promise<void> {
    const attempts = await this.attemptRows();
    let attemptNo: 1 | 2;
    const latest = attempts[attempts.length - 1];
    if (this.job.state === 'planning') {
      attemptNo =
        latest && latest.outcome === 'pending' && !latest.providerOperationId
          ? (latest.attemptNo as 1 | 2)
          : (Math.min(2, attempts.length + 1) as 1 | 2);
    } else {
      attemptNo = (latest?.attemptNo ?? 1) as 1 | 2;
    }
    for (;;) {
      if (this.job.state === 'planning') await this.planAttempt(attemptNo);
      if (this.job.state === 'rendering') await this.renderAttempt(attemptNo);
      if (this.job.state === 'checking') {
        const next = await this.checkAttempt(attemptNo);
        if (next === 'repair') {
          attemptNo = 2;
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

  /** The attempt's composite mask: bands at the band dilation, boxes at `dilationFraction`. */
  private maskFor(
    placements: readonly Pick<
      DecorationPlan['placements'][number],
      'anchorId' | 'placementRule' | 'region' | 'maskShapes'
    >[],
    dilationFraction: number,
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
    });
  }

  /**
   * The lighting a decorate attempt is planned and composited in: always `source`. An evening job
   * relights an accepted daylight variant, and renders that daylight base itself first when none
   * exists.
   */
  private attemptLighting(): LightingMode {
    return 'source';
  }

  private repairInput(): RepairInput | null {
    const stored = this.job.repairConstraints as {
      constraints?: unknown;
      adjustments?: unknown;
    } | null;
    if (!stored?.constraints || !stored.adjustments) return null;
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

  private async planAttempt(attemptNo: 1 | 2): Promise<void> {
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
    const relight =
      !existingPlan && this.job.lightingMode === 'evening'
        ? await this.relightBaseFor(attemptNo)
        : null;
    if (existingPlan) {
      planned = this.restorePlanned(existingPlan.document, existingPlan.validatorResult);
      planRowId = existingPlan.id;
    } else if (relight) {
      ({ planned, planRowId } = await this.planRelight(attemptNo, relight.base, relight.codes));
    } else {
      const lighting = this.attemptLighting();
      const repair = attemptNo === 2 ? this.repairInput() : null;
      const dilation = repair?.adjustments.dilationFraction ?? this.options.dilationFraction;
      const masks = new Map<string, CompositeMask>();
      const maskOf = (placements: DecorationPlan['placements']) => {
        const key = placements
          .map((p) => `${p.id}:${p.region.join(',')}:${JSON.stringify(p.maskShapes ?? null)}`)
          .join('|');
        let mask = masks.get(key);
        if (!mask) {
          mask = this.maskFor(placements, dilation);
          masks.set(key, mask);
        }
        return mask;
      };
      let result;
      try {
        result = planAndCompile(
          {
            renderJobId: this.job.id,
            planVersion: attemptNo,
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
    // A repair is an attempt planned with repair constraints. The relight of a daylight base this
    // job rendered itself is attempt 2 but carries none, so it uses no repair.
    const repairPlanned = (planned.plan.repairConstraints?.length ?? 0) > 0;

    // Guard: remaining time.
    const elapsed = this.now().getTime() - (this.job.startedAt ?? this.now()).getTime();
    if (elapsed >= this.options.maxJobDurationMs) throw new JobFailure('timeout');

    // Permission re-evaluated immediately before the paid call.
    const evaluation = await this.evaluate('rendering');
    if (!isEditable(evaluation.permission)) throw new JobFailure('policy_denied');

    const existingAttempt = (await this.attemptRows()).find((row) => row.attemptNo === attemptNo);
    if (!existingAttempt) {
      // Guard: the owner's paid-attempt cap allows one more attempt.
      if (!(await this.attemptCapAllows())) {
        throw new JobFailure('policy_denied', null, 'paid-attempt cap reached');
      }
      const linked = (await this.attemptRows())
        .map((row) => row.reservationEntryId)
        .filter((id): id is string => id !== null);
      const reservation = await findOpenReservation(this.deps.db, this.job.id, {
        sku: 'image_edit_attempt',
        exclude: linked,
      });
      // Kill switches, immediately before the attempt row (the paid-attempt cap counts rows).
      await this.assertNotPaused(this.compilerFamily());
      const attemptId = newId();
      await this.deps.db
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
              })
            : null,
          dilationFraction: planned.plan.compositeMask?.dilationFraction ?? null,
          featherFraction: planned.plan.compositeMask?.featherFraction ?? null,
          outcome: 'pending',
          reservationEntryId: reservation?.id ?? null,
          fallback: planned.plan.relightOf
            ? toJson({ kind: 'relight', ...planned.plan.relightOf } satisfies RelightAttemptRecord)
            : null,
        })
        .execute();
      await this.deps.db
        .updateTable('permissionEvaluations')
        .set({ attemptId })
        .where('id', '=', evaluation.evaluationId)
        .execute();
    }
    await this.advance('rendering', {
      renderStartedAt: this.now(),
      attemptCount: attemptNo,
      repairUsed: repairPlanned,
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

  private async currentPlanned(attemptNo: 1 | 2): Promise<PlannedRun> {
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

  // ---- evening relight -----------------------------------------------------------------------

  /**
   * The daylight variant an evening attempt relights (render spec, lighting modes). Attempt 1
   * relights the accepted `source` variant of the same key, or (none existing) renders that
   * daylight base itself and returns null. Attempt 2 is the repair of a rejected relight (same
   * base, the rejecting codes) or the relight of the base attempt 1 rendered and published.
   */
  private async relightBaseFor(
    attemptNo: 1 | 2,
  ): Promise<{ base: RelightBase; codes: FailureCode[] } | null> {
    if (attemptNo === 1) {
      const variant = await this.acceptedSourceVariant();
      return variant ? { base: variant, codes: [] } : null;
    }
    const first = await this.deps.db
      .selectFrom('decorationPlans')
      .select('document')
      .where('jobId', '=', this.job.id)
      .where('attemptNo', '=', 1)
      .executeTakeFirst();
    const firstPlan = DecorationPlanSchema.safeParse(first?.document);
    const stored = (this.job.repairConstraints ?? {}) as {
      codes?: FailureCode[];
      relightBase?: unknown;
    };
    if (firstPlan.success && firstPlan.data.relightOf) {
      return { base: firstPlan.data.relightOf, codes: stored.codes ?? [] };
    }
    const base = RelightBaseSchema.safeParse(stored.relightBase);
    if (!base.success) throw new JobFailure('internal_error', null, 'relight base not recorded');
    return { base: base.data, codes: [] };
  }

  /**
   * Loads the daylight image a relight starts from on the working grid: the published variant's
   * delivered image, or this job's own daylight composite (in memory, or stored when the job runs
   * in pre-delivery review and did not publish it).
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
   * Plans an evening relight attempt: the base plan's decorations and preserve set, in `evening`
   * lighting as `global_relight`, with the compiled relight request (no mask) and the base it
   * relights. A repair carries the rejecting codes as constraints of the stronger instruction.
   */
  private async planRelight(
    attemptNo: 1 | 2,
    base: RelightBase,
    codes: FailureCode[],
  ): Promise<{ planned: PlannedRun; planRowId: string }> {
    const input = await this.loadRelightInput(base);
    const request = compileRelightRequest({
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
      lightingMode: 'evening',
      fidelityMode: 'global_relight',
      compilerVersion: this.job.compilerVersion,
      permissionEvaluationId: this.job.permissionEvaluationId,
      lightingInstruction: {
        mode: 'evening',
        text: 'Relight the accepted daylight variant to early evening: dusk ambient light, the decorations’ own lights glowing, existing windows and porch or room lights on; nothing else changes.',
      },
      ...(codes.length > 0
        ? {
            repairConstraints: codes.map((code) => ({
              code,
              instruction:
                code === 'lighting_implausible' ? RELIGHT_REPAIR_LIGHT : RELIGHT_REPAIR_KEEP,
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

  private async renderAttempt(attemptNo: 1 | 2): Promise<void> {
    await this.ensureActive();
    const planned = await this.currentPlanned(attemptNo);
    let attempt = await this.currentAttempt(attemptNo);
    const editor = this.legs.imageEditor;
    const family = this.compilerFamily();
    const callDeadline = this.now().getTime() + this.options.renderTimeoutMs;
    const fixture = editor.mode === 'fixture' ? this.fixtureEditContext(planned) : undefined;
    const relightOf = planned.plan.relightOf;
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
    const editOnce = (reopen = false) =>
      editor.edit(planned.request, input, {
        attemptId: attempt.id,
        timeoutMs: this.options.renderTimeoutMs,
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(this.options.renderTimeoutMs)]),
        onOperation: (operationId) => persistOperation(operationId, reopen),
      });
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
    if (deterministic.codes.some((code) => isCriticalFailureCode(code))) {
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

  /** Writes the localization onto the attempt's composite-mask record. */
  private async writeLocalization(
    db: Pick<PipelineDeps['db'], 'updateTable'>,
    attempt: RenderAttempt,
    record: LocalizationRecord,
  ): Promise<void> {
    await db
      .updateTable('renderAttempts')
      .set({
        compositeMask: toJson({
          ...((attempt.compositeMask as Record<string, unknown> | null) ?? {}),
          localization: record,
        }),
      })
      .where('id', '=', attempt.id)
      .execute();
  }

  /**
   * Localized compositing (render spec, compositing algorithm): after registration the vision
   * model localizes the decorations the editor added in the aligned output, and the keep-mask is
   * the plan's mask united with each localized box (dilated, minus the privacy and legal
   * exclusions, capped). The result (items, other changes, model, prompt version, usage,
   * coverage, what the cap dropped) is recorded on the attempt in the same transaction as the
   * call's settlement, and a redelivery reuses it without a second paid call. A call that fails
   * after its retries falls back to the plan mask, recorded as such.
   */
  private async localize(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    planMask: CompositeMask,
    aligned: Raster,
  ): Promise<LocalizedComposite> {
    const keepFrom = (items: readonly LocalizedAdditionRecord[]) =>
      localizedKeepMask({
        planMask,
        items,
        analysis: this.analysis,
        attributionRegions: this.attributionRegions,
        padRegions: this.working.padRegions,
      });
    const composite = (record: LocalizationRecord): LocalizedComposite => {
      if (record.status !== 'localized') return { mask: planMask, keptRegions: [], hints: [] };
      const keep = keepFrom(record.items);
      return {
        mask: keep.mask,
        keptRegions: keep.kept.map((item) => item.box),
        hints: restoredChangeHints(record.otherChanges, keep.mask),
      };
    };
    const recorded = this.recordedLocalization(attempt);
    if (recorded) return composite(recorded);

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
      await this.writeLocalization(this.deps.db, attempt, fallback);
      return composite(fallback);
    }
    const { items, otherChanges } = localizationRecords(
      call.result,
      plan.placements.map((placement) => placement.id),
    );
    const keep = keepFrom(items);
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
      await this.writeLocalization(trx, attempt, record);
    });
    return {
      mask: keep.mask,
      keptRegions: keep.kept.map((item) => item.box),
      hints: restoredChangeHints(otherChanges, keep.mask),
    };
  }

  // ---- checking ------------------------------------------------------------------------------

  private async checkAttempt(attemptNo: 1 | 2): Promise<'repair' | 'done'> {
    await this.ensureActive();
    const planned = await this.currentPlanned(attemptNo);
    if (planned.plan.relightOf)
      return this.checkRelight(attemptNo, planned, planned.plan.relightOf);
    const plan = planned.plan;
    let attempt = await this.currentAttempt(attemptNo);
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
    if (plan.lightingMode === 'source' && planned.mask && registration.registered.aligned) {
      localized = await this.localize(attempt, plan, planned.mask, registration.registered.aligned);
      attempt = await this.currentAttempt(attemptNo);
    }
    const composite = await compositeAndCheck({
      working: this.working,
      rawBytes,
      registration,
      requested: { width: this.working.width, height: this.working.height },
      plan,
      analysis: this.analysis,
      mask: localized?.mask ?? planned.mask,
      ...(localized ? { keptRegions: localized.keptRegions } : {}),
      attributionRegion: this.attributionRegions,
      glowRegions: this.glowRegions(),
    }).catch(undecodable);
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
    const verdict = decideAttempt({
      attemptNumber: attemptNo,
      deterministic: composite.deterministic.codes,
      judge: classification,
    });
    await this.ensureActive();

    const accepted =
      verdict.verdict === 'pass' ||
      (verdict.verdict === 'uncertain' && this.job.reviewMode === 'pre_delivery');
    if (accepted && this.job.lightingMode === 'evening' && plan.lightingMode === 'source') {
      return this.acceptRelightBase(attempt, plan, judge, composite.candidate, verdict);
    }
    if (accepted) {
      await this.deliver(attempt, plan, judge, composite.candidate, verdict);
      return 'done';
    }

    // Failed (or uncertain in sampled audit mode).
    await this.deps.db
      .updateTable('renderAttempts')
      .set({ outcome: 'qa_rejected' })
      .where('id', '=', attempt.id)
      .execute();
    const codes = verdict.codes;
    // An evening job's own daylight base is never repaired: a rejected base rejects the job, so
    // a home whose structure changed is never relit and delivered.
    if (
      this.job.lightingMode !== 'evening' &&
      attemptNo === 1 &&
      isRepairable(codes) &&
      (await this.repairAllowed())
    ) {
      const thresholds = this.options.judgeThresholds;
      const findings = findingsFrom(judge, composite.deterministic.codes, thresholds);
      if (verdict.verdict === 'uncertain') {
        for (const code of codes)
          if (!findings.some((f) => f.code === code)) findings.push({ code });
      }
      const repair = deriveRepair(plan, planned.placementKeys, findings, judge);
      await this.advance('planning', {
        repairConstraints: toJson({ ...repair, codes }),
      });
      return 'repair';
    }
    await this.reject(attemptNo, attempt, verdict);
    return 'done';
  }

  /**
   * Checks an evening relight against its daylight base (render spec, lighting modes): the relit
   * output is registered to the base (`camera_changed` and uncovered strips as for any output),
   * the attribution rectangles and padding are restored verbatim, the protected regions and
   * structure are compared with the base, and the judge runs in relight mode with the base as the
   * reference. A relight that passes is delivered as the evening variant (`global_relight`); a
   * repairable rejection of the first relight is repaired once with the stronger keep clause;
   * anything else rejects the job. The deterministic relight is never delivered in its place.
   */
  private async checkRelight(
    attemptNo: 1 | 2,
    planned: PlannedRun,
    base: RelightBase,
  ): Promise<'repair' | 'done'> {
    const plan = planned.plan;
    const attempt = await this.currentAttempt(attemptNo);
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
    const verdict = decideAttempt({
      attemptNumber: attemptNo,
      deterministic: composite.deterministic.codes,
      judge: classification,
    });
    await this.ensureActive();
    if (
      verdict.verdict === 'pass' ||
      (verdict.verdict === 'uncertain' && this.job.reviewMode === 'pre_delivery')
    ) {
      await this.deliver(attempt, plan, input.judge ?? judge, composite.candidate, verdict);
      return 'done';
    }
    await this.deps.db
      .updateTable('renderAttempts')
      .set({ outcome: 'qa_rejected' })
      .where('id', '=', attempt.id)
      .execute();
    const codes = verdict.codes;
    if (attemptNo === 1 && isRepairable(codes) && (await this.repairAllowed())) {
      await this.advance('planning', { repairConstraints: toJson({ relight: true, codes }) });
      return 'repair';
    }
    await this.reject(attemptNo, attempt, verdict);
    return 'done';
  }

  /**
   * An evening job's own daylight base passed: it is published as the `source` variant (its own
   * key, labels and download) unless the job runs in pre-delivery review, where it is kept
   * unpublished for the relight. The attempt succeeded; attempt 2 relights it.
   */
  private async acceptRelightBase(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    judge: JudgeResult,
    candidate: Raster,
    verdict: AttemptVerdict,
  ): Promise<'repair'> {
    this.baseComposite = { attemptId: attempt.id, raster: candidate };
    let baseRenderAssetId: string | null = null;
    if (this.job.reviewMode !== 'pre_delivery' && verdict.verdict === 'pass') {
      const deliverables = await buildDeliverables({
        candidate,
        contentBox: this.working.contentBox,
        source: this.source,
        permission: this.permission,
        quality: this.options.deliveredJpegQuality,
        downloadMark: this.options.downloadMark,
      });
      const asset = await publishBaseVariant(this.deps, {
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
      baseRenderAssetId = asset.id;
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
    await this.advance('planning', { repairConstraints: toJson({ relightBase: base }) });
    return 'repair';
  }

  /** Delivers an accepted candidate: held for pre-delivery review, or published. */
  private async deliver(
    attempt: RenderAttempt,
    plan: DecorationPlan,
    judge: JudgeResult,
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
    attemptNo: 1 | 2,
    attempt: RenderAttempt,
    verdict: AttemptVerdict,
  ): Promise<void> {
    const codes = verdict.codes;
    const rejectionReason = verdict.verdict === 'uncertain' ? 'qa_uncertain' : 'qa_critical';
    if (codes.includes('attribution_altered')) {
      this.log.error('attribution region altered after restoration');
    }
    if (codes.includes('unsafe_or_offensive')) {
      this.log.warn({ attemptId: attempt.id }, 'attempt flagged for content review');
    }
    await this.finish('rejected', {
      rejectionReason,
      failureCodes: codes as FailureCode[],
    });
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
  private async attemptCapAllows(): Promise<boolean> {
    const quota = await attemptQuota(this.deps.db, this.deps.settings, {
      ownerId: this.job.ownerId,
      now: this.now(),
      projected: 1,
    });
    return quota.used <= quota.limit;
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

  private async finish(to: 'failed' | 'rejected', patch: JobPatch): Promise<void> {
    const except = await this.inFlightReservations();
    this.job = await transitionJob(this.deps.db, {
      jobId: this.job.id,
      from: this.job.state,
      to,
      patch,
      clock: this.deps.clock,
      within: async (trx) => {
        await releaseRemaining(trx, this.job.id, this.deps.clock, except);
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
      if (error instanceof RunStopped || error instanceof LostRaceError) {
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
