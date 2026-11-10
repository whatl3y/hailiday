import type { ActivationState, SourceKind, UserRole } from '@holiday/core';
import {
  capabilityMode,
  defaultCapabilityState,
  type Capabilities,
  type CapabilityMode,
} from '../capabilities/index.js';
import type { Clock } from '../clock/index.js';
import type { AppConfig } from '../config/index.js';
import type { Content } from '../content/load.js';
import type { Db } from '../db/client.js';
import type { Logger } from '../logger/index.js';
import type { Providers } from '../providers/types.js';
import type { JobQueue } from '../queue/client.js';
import type { RuntimeSettings } from '../settings/index.js';
import type { Storage } from '../storage/client.js';
import { PIPELINE_DEFAULTS } from './versions.js';

/** Tunable pipeline values (render spec configuration), with defaults from the specs. */
export interface PipelineOptions {
  maxJobDurationMs: number;
  repairBudgetMs: number;
  transportRetryLimit: number;
  /** Backoff before transport retry `n` (1-based). */
  retryDelayMs: (retry: number) => number;
  analysisTimeoutMs: number;
  renderTimeoutMs: number;
  judgeTimeoutMs: number;
  escalationTimeoutMs: number;
  /** Interval of status recovery polls through `getOperation`. */
  statusPollMs: number;
  judgeThresholds: { critical: number; uncertain: number; major: number };
  anchorFloors: { minConfidence: number; maxOcclusion: number };
  dilationFraction: number;
  featherFraction: number;
  deliveredJpegQuality: number;
  /** Burn the "AI preview" corner mark into downloads. */
  downloadMark: boolean;
  /** How long an upload held for review waits for a reviewer. */
  uploadHoldWindowMs: number;
  /** Wall-clock limit of one decode in the decoder child process. */
  decodeTimeoutMs: number;
  /** How long reconciliation polls an unknown attempt outcome. */
  reconciliationWindowMs: number;
  /** Rejected and failed candidates are kept this long after the job is terminal. */
  rejectedCandidateRetentionMs: number;
  /** Working images are kept this long after the job is terminal. */
  workingGraceMs: number;
}

/** Everything the pipeline stages and job handlers use. */
export interface PipelineDeps {
  db: Db;
  storage: Storage;
  queue: JobQueue | null;
  settings: RuntimeSettings;
  capabilities: Capabilities;
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  providers: Providers;
  content: Content;
  options?: Partial<PipelineOptions>;
}

/** Resolves pipeline options from configuration and overrides. */
export function pipelineOptions(deps: Pick<PipelineDeps, 'config' | 'options'>): PipelineOptions {
  const q = deps.config.queue;
  const defaults: PipelineOptions = {
    maxJobDurationMs: q.renderMaxJobDurationSeconds * 1000,
    repairBudgetMs: q.renderRepairBudgetSeconds * 1000,
    transportRetryLimit: q.renderTransportRetryLimit,
    retryDelayMs: (retry) =>
      Math.min(q.renderRetryDelayMaxSeconds, q.renderRetryDelaySeconds * 2 ** (retry - 1)) * 1000,
    analysisTimeoutMs: PIPELINE_DEFAULTS.analysisTimeoutMs,
    renderTimeoutMs: PIPELINE_DEFAULTS.renderTimeoutMs,
    judgeTimeoutMs: PIPELINE_DEFAULTS.judgeTimeoutMs,
    escalationTimeoutMs: PIPELINE_DEFAULTS.escalationTimeoutMs,
    statusPollMs: 2000,
    judgeThresholds: { ...PIPELINE_DEFAULTS.judgeThresholds },
    anchorFloors: { ...PIPELINE_DEFAULTS.anchorFloors },
    dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
    featherFraction: PIPELINE_DEFAULTS.featherFraction,
    deliveredJpegQuality: PIPELINE_DEFAULTS.deliveredJpegQuality,
    downloadMark: true,
    uploadHoldWindowMs: PIPELINE_DEFAULTS.uploadHoldWindowMs,
    decodeTimeoutMs: 20_000,
    reconciliationWindowMs: PIPELINE_DEFAULTS.reconciliationWindowMs,
    rejectedCandidateRetentionMs: 7 * 24 * 3_600_000,
    workingGraceMs: 3_600_000,
  };
  return { ...defaults, ...(deps.options ?? {}) };
}

/** The capability that governs a source kind's AI legs. */
export function aiCapabilityFor(kind: SourceKind): 'street_view_ai' | 'image_editing' {
  return kind === 'street_view' ? 'street_view_ai' : 'image_editing';
}

/**
 * The activation state applied to a permission evaluation. A missing capability row takes the
 * environment's default in development and test (local data without a seed) and is unavailable
 * elsewhere.
 */
export async function capabilityStateFor(
  deps: Pick<PipelineDeps, 'capabilities' | 'config'>,
  capability: Parameters<Capabilities['state']>[1],
): Promise<ActivationState | null> {
  const state = await deps.capabilities.state('US', capability);
  if (state) return state;
  return deps.config.isLocal ? defaultCapabilityState(deps.config, capability) : null;
}

/**
 * The provider legs a job uses, each chosen from its own capability (fixture adapters for
 * `fixture`): the editor from `image_editing` (`street_view_ai` for Street View sources), the
 * vision model from `vision_analysis`, the Street View fetch from `street_view_ai`.
 */
export interface ProviderLegs {
  /** Mode of the editing leg (the source kind's AI capability). */
  mode: CapabilityMode;
  /** Mode of the vision leg (analysis, judge and escalation). */
  visionMode: CapabilityMode;
  vision: Providers['vision'];
  imageEditor: Providers['imageEditor'];
  streetView: Providers['streetView'];
}

/**
 * The mode of the vision leg for a job whose editing leg runs in `editMode`. Vision runs live
 * only when `vision_analysis` is live for the audience and the editing leg is live too (a fixture
 * edit is judged by the fixture model, as the API prices it); it is unavailable when the editing
 * leg is live but `vision_analysis` is not available to the audience.
 */
export async function visionModeFor(
  deps: Pick<PipelineDeps, 'capabilities' | 'config'>,
  editMode: CapabilityMode,
  roles: readonly UserRole[],
): Promise<CapabilityMode> {
  if (editMode !== 'live') return editMode;
  const state = await capabilityStateFor(deps, 'vision_analysis');
  return capabilityMode(state, { roles }, deps.config.appEnv);
}

export async function providerLegsFor(
  deps: Pick<PipelineDeps, 'capabilities' | 'config' | 'providers'>,
  kind: SourceKind,
  roles: readonly UserRole[],
): Promise<ProviderLegs> {
  const { providers } = deps;
  if (kind === 'fixture') {
    return {
      mode: 'fixture',
      visionMode: 'fixture',
      vision: providers.fixtures.vision,
      imageEditor: providers.fixtures.imageEditor,
      streetView: providers.fixtures.streetView,
    };
  }
  const state = await capabilityStateFor(deps, aiCapabilityFor(kind));
  const mode = capabilityMode(state, { roles }, deps.config.appEnv);
  const visionMode = await visionModeFor(deps, mode, roles);
  const streetViewMode =
    kind === 'street_view'
      ? mode
      : capabilityMode(
          await capabilityStateFor(deps, 'street_view_ai'),
          { roles },
          deps.config.appEnv,
        );
  return {
    mode,
    visionMode,
    vision: visionMode === 'live' ? providers.vision : providers.fixtures.vision,
    imageEditor: mode === 'live' ? providers.imageEditor : providers.fixtures.imageEditor,
    streetView: streetViewMode === 'live' ? providers.streetView : providers.fixtures.streetView,
  };
}
