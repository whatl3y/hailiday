import { z } from 'zod';
import type { LightingMode } from './content.js';

/** Non-terminal render job states, in pipeline order. */
export const NON_TERMINAL_RENDER_JOB_STATES = [
  'queued',
  'preparing',
  'analyzing',
  'planning',
  'rendering',
  'checking',
  'needs_review',
] as const;
export const NonTerminalRenderJobStateSchema = z.enum(NON_TERMINAL_RENDER_JOB_STATES);
export type NonTerminalRenderJobState = z.infer<typeof NonTerminalRenderJobStateSchema>;

/** Terminal render job states. */
export const TERMINAL_RENDER_JOB_STATES = [
  'succeeded',
  'rejected',
  'failed',
  'canceled',
  'superseded',
  'expired',
] as const;
export const TerminalRenderJobStateSchema = z.enum(TERMINAL_RENDER_JOB_STATES);
export type TerminalRenderJobState = z.infer<typeof TerminalRenderJobStateSchema>;

export const RENDER_JOB_STATES = [
  ...NON_TERMINAL_RENDER_JOB_STATES,
  ...TERMINAL_RENDER_JOB_STATES,
] as const;
export const RenderJobStateSchema = z.enum(RENDER_JOB_STATES);
export type RenderJobState = z.infer<typeof RenderJobStateSchema>;

export function isTerminalRenderJobState(state: RenderJobState): state is TerminalRenderJobState {
  return (TERMINAL_RENDER_JOB_STATES as readonly string[]).includes(state);
}

export function isNonTerminalRenderJobState(
  state: RenderJobState,
): state is NonTerminalRenderJobState {
  return !isTerminalRenderJobState(state);
}

/** Terminal states every active job may enter regardless of stage. */
const ACTIVE_EXITS = ['canceled', 'superseded', 'expired', 'failed'] as const;

/** Allowed render job transitions (normative state machine). */
export const RENDER_JOB_TRANSITIONS: Readonly<Record<RenderJobState, readonly RenderJobState[]>> = {
  queued: ['preparing', ...ACTIVE_EXITS],
  preparing: ['analyzing', ...ACTIVE_EXITS],
  analyzing: ['planning', ...ACTIVE_EXITS],
  planning: ['rendering', ...ACTIVE_EXITS],
  rendering: ['checking', ...ACTIVE_EXITS],
  checking: ['succeeded', 'needs_review', 'planning', 'rejected', ...ACTIVE_EXITS],
  needs_review: ['succeeded', 'rejected', ...ACTIVE_EXITS],
  succeeded: [],
  rejected: [],
  failed: [],
  canceled: [],
  superseded: [],
  expired: [],
};

export function canTransitionRenderJob(from: RenderJobState, to: RenderJobState): boolean {
  return RENDER_JOB_TRANSITIONS[from].includes(to);
}

/**
 * What the worker is doing inside a state when the state alone does not say it: `framing` (state
 * `preparing`: a Street View frame is fetched again zoomed in on the home), `enhancing` (state
 * `analyzing`: the Street View frame is redrawn sharper before planning) and `relight` (states
 * `planning` and `rendering` of a relight attempt).
 */
export const RENDER_SUB_STAGES = ['framing', 'enhancing', 'relight'] as const;
export const RenderSubStageSchema = z.enum(RENDER_SUB_STAGES);
export type RenderSubStage = z.infer<typeof RenderSubStageSchema>;

/** Copy keys of the waiting-screen stage labels, in the order a job can show them. */
export const STAGE_LABEL_KEYS = [
  'stage.preparing',
  'stage.framing',
  'stage.enhancing',
  'stage.planning',
  'stage.rendering',
  'stage.checking',
  'stage.eveningLight',
  'stage.brightLight',
  'stage.review',
] as const;
export const StageLabelKeySchema = z.enum(STAGE_LABEL_KEYS);
export type StageLabelKey = z.infer<typeof StageLabelKeySchema>;

/** Render state to stage label key mapping for non-terminal states. */
export const RENDER_STATE_STAGE_LABEL_KEYS: Readonly<
  Record<NonTerminalRenderJobState, StageLabelKey>
> = {
  queued: 'stage.preparing',
  preparing: 'stage.preparing',
  analyzing: 'stage.planning',
  planning: 'stage.planning',
  rendering: 'stage.rendering',
  checking: 'stage.checking',
  needs_review: 'stage.review',
};

/** The stage label key for a state, or null for terminal states. */
export function stageLabelKeyFor(state: RenderJobState): StageLabelKey | null {
  return isTerminalRenderJobState(state) ? null : RENDER_STATE_STAGE_LABEL_KEYS[state];
}

/**
 * The stage label key for a job: the sub-stage's label where it applies (`framing` in
 * `preparing`; `enhancing` in `analyzing`; `relight` in `planning` or `rendering` of an `evening`
 * or `bright` job), else the state's label. Null for terminal states.
 */
export function stageLabelKeyOf(job: {
  state: RenderJobState;
  subStage?: RenderSubStage | null;
  lightingMode?: LightingMode | null;
}): StageLabelKey | null {
  if (isTerminalRenderJobState(job.state)) return null;
  if (job.subStage === 'framing' && job.state === 'preparing') return 'stage.framing';
  if (job.subStage === 'enhancing' && job.state === 'analyzing') return 'stage.enhancing';
  if (job.subStage === 'relight' && (job.state === 'planning' || job.state === 'rendering')) {
    if (job.lightingMode === 'evening') return 'stage.eveningLight';
    if (job.lightingMode === 'bright') return 'stage.brightLight';
  }
  return RENDER_STATE_STAGE_LABEL_KEYS[job.state];
}

/** Why a job ended `failed`. */
export const FAILURE_KINDS = [
  'provider_error',
  'timeout',
  'policy_denied',
  'moderation_blocked',
  'source_unavailable',
  'source_rejected',
  'unknown_outcome',
  'internal_error',
] as const;
export const FailureKindSchema = z.enum(FAILURE_KINDS);
export type FailureKind = z.infer<typeof FailureKindSchema>;

/** Optional detail of `failed`/`source_rejected`. */
export const FAILURE_DETAILS = [
  'no_usable_anchors',
  'house_number_mismatch',
  'facade_not_in_frame',
  'owner_blurred',
] as const;
export const FailureDetailSchema = z.enum(FAILURE_DETAILS);
export type FailureDetail = z.infer<typeof FailureDetailSchema>;

/** Why a job ended `rejected`. */
export const REJECTION_REASONS = ['qa_critical', 'qa_uncertain', 'reviewer_rejected'] as const;
export const RejectionReasonSchema = z.enum(REJECTION_REASONS);
export type RejectionReason = z.infer<typeof RejectionReasonSchema>;

/** Critical QA failure codes: any one rejects the attempt. */
export const CRITICAL_FAILURE_CODES = [
  'structure_changed',
  'wrong_property',
  'neighbor_decorated',
  'access_blocked',
  'privacy_regression',
  'people_altered',
  'text_added',
  'unsafe_or_offensive',
  'camera_changed',
  'attribution_altered',
] as const;
export const CriticalFailureCodeSchema = z.enum(CRITICAL_FAILURE_CODES);
export type CriticalFailureCode = z.infer<typeof CriticalFailureCodeSchema>;

/** Major QA failure codes: count against acceptability, not structural fidelity. */
export const MAJOR_FAILURE_CODES = [
  'unrequested_change',
  'plan_not_followed',
  'implausible_decor',
  'lighting_implausible',
] as const;
export const MajorFailureCodeSchema = z.enum(MAJOR_FAILURE_CODES);
export type MajorFailureCode = z.infer<typeof MajorFailureCodeSchema>;

export const FAILURE_CODES = [...CRITICAL_FAILURE_CODES, ...MAJOR_FAILURE_CODES] as const;
export const FailureCodeSchema = z.enum(FAILURE_CODES);
export type FailureCode = z.infer<typeof FailureCodeSchema>;

/** Codes that end a job without a repair. */
export const NON_REPAIRABLE_FAILURE_CODES: readonly FailureCode[] = [
  'wrong_property',
  'unsafe_or_offensive',
  'attribution_altered',
];

export function isCriticalFailureCode(code: FailureCode): code is CriticalFailureCode {
  return (CRITICAL_FAILURE_CODES as readonly string[]).includes(code);
}

export function isRepairableFailureCode(code: FailureCode): boolean {
  return !NON_REPAIRABLE_FAILURE_CODES.includes(code);
}

/** Decision recorded on a judge result. */
export const JUDGE_DECISIONS = ['pass', 'reject', 'uncertain'] as const;
export const JudgeDecisionSchema = z.enum(JUDGE_DECISIONS);
export type JudgeDecision = z.infer<typeof JudgeDecisionSchema>;

/**
 * Image-edit attempt numbers of one render job. A job makes at most two attempts (an attempt and
 * its repair), except a relit look (`evening`, `bright`) that decorates its own base first: the
 * base, the relight, and one repair of either, so at most three. A job is repaired at most once.
 */
export const RENDER_ATTEMPT_NUMBERS = [1, 2, 3] as const;
export const RenderAttemptNumberSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type RenderAttemptNumber = (typeof RENDER_ATTEMPT_NUMBERS)[number];
/** The most image-edit attempts any render job makes. */
export const MAX_RENDER_ATTEMPTS = 3;
/** The most image-edit attempts of a job that is not a relit look decorating its own base. */
export const STANDARD_RENDER_ATTEMPTS = 2;

/** Outcome of one render attempt. */
export const ATTEMPT_OUTCOMES = [
  'pending',
  'succeeded',
  'qa_rejected',
  'provider_error',
  'timeout',
  'moderation_blocked',
  'unknown',
  'canceled',
] as const;
export const AttemptOutcomeSchema = z.enum(ATTEMPT_OUTCOMES);
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;

/** Whether an attempt used a contract fixture, a replayed render or a live provider. */
export const PROVIDER_MODES = ['fixture', 'replay', 'live'] as const;
export const ProviderModeSchema = z.enum(PROVIDER_MODES);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

/** Render mode that follows from the lighting mode. */
export const FIDELITY_MODES = ['composite_additive', 'global_relight'] as const;
export const FidelityModeSchema = z.enum(FIDELITY_MODES);
export type FidelityMode = z.infer<typeof FidelityModeSchema>;

/** `global_relight` for the relit modes (`evening`, `bright`); `composite_additive` otherwise. */
export function fidelityModeFor(lightingMode: LightingMode): FidelityMode {
  return lightingMode === 'evening' || lightingMode === 'bright'
    ? 'global_relight'
    : 'composite_additive';
}

/** Review mode per scene type. */
export const REVIEW_MODES = ['pre_delivery', 'sampled_audit'] as const;
export const ReviewModeSchema = z.enum(REVIEW_MODES);
export type ReviewMode = z.infer<typeof ReviewModeSchema>;

/** What a review row decides about. */
export const REVIEW_SUBJECT_KINDS = ['render_job', 'audit_sample', 'upload_hold'] as const;
export const ReviewSubjectKindSchema = z.enum(REVIEW_SUBJECT_KINDS);
export type ReviewSubjectKind = z.infer<typeof ReviewSubjectKindSchema>;

/** A human reviewer's decision. */
export const REVIEW_DECISIONS = ['approve', 'reject'] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/** Provider watermark found on an output. */
export const PROVIDER_WATERMARKS = ['synthid', 'unknown'] as const;
export const ProviderWatermarkSchema = z.enum(PROVIDER_WATERMARKS);
export type ProviderWatermark = z.infer<typeof ProviderWatermarkSchema>;

/** Failure kinds an image-edit adapter reports. */
export const EDIT_FAILURE_KINDS = [
  'provider_error',
  'timeout',
  'moderation_blocked',
  'invalid_request',
] as const;
export const EditFailureKindSchema = z.enum(EDIT_FAILURE_KINDS);
export type EditFailureKind = z.infer<typeof EditFailureKindSchema>;

/** Pipeline stages that call providers and record pre-call evaluations. */
export const PIPELINE_STAGES = ['preparing', 'analyzing', 'rendering', 'checking'] as const;
export const PipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

/** Scene analysis vocabularies. */
export const PRESERVE_REGION_KINDS = [
  'house_number',
  'sign',
  'logo',
  'existing_decor',
  'vehicle',
  'other',
] as const;
export const PreserveRegionKindSchema = z.enum(PRESERVE_REGION_KINDS);
export type PreserveRegionKind = z.infer<typeof PreserveRegionKindSchema>;

export const ACCESS_REGION_KINDS = [
  'door',
  'walkway',
  'steps',
  'driveway',
  'gate',
  'hallway',
] as const;
export const AccessRegionKindSchema = z.enum(ACCESS_REGION_KINDS);
export type AccessRegionKind = z.infer<typeof AccessRegionKindSchema>;

export const HAZARD_KINDS = ['power_line', 'open_flame', 'water', 'fragile', 'other'] as const;
export const HazardKindSchema = z.enum(HAZARD_KINDS);
export type HazardKind = z.infer<typeof HazardKindSchema>;

export const DECOR_DENSITIES = ['none', 'low', 'medium', 'high'] as const;
export const DecorDensitySchema = z.enum(DECOR_DENSITIES);
export type DecorDensity = z.infer<typeof DecorDensitySchema>;

export const PROTECTED_BLUR_KINDS = ['face', 'plate', 'house', 'other'] as const;
export const ProtectedBlurKindSchema = z.enum(PROTECTED_BLUR_KINDS);
export type ProtectedBlurKind = z.infer<typeof ProtectedBlurKindSchema>;

export const TIMES_OF_DAY = ['day', 'dusk', 'night', 'unknown'] as const;
export const TimeOfDaySchema = z.enum(TIMES_OF_DAY);
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

export const EXPOSURES = ['under', 'normal', 'over'] as const;
export const ExposureSchema = z.enum(EXPOSURES);
export type Exposure = z.infer<typeof ExposureSchema>;

export const FOLIAGE_STATES = ['bare', 'leafy', 'evergreen', 'mixed', 'unknown'] as const;
export const FoliageStateSchema = z.enum(FOLIAGE_STATES);
export type FoliageState = z.infer<typeof FoliageStateSchema>;

/** Per-placement adherence values reported by the judge. */
export const ADHERENCE_COUNTS = ['pass', 'under', 'over'] as const;
export const AdherenceCountSchema = z.enum(ADHERENCE_COUNTS);
export type AdherenceCount = z.infer<typeof AdherenceCountSchema>;

export const ADHERENCE_SCALES = ['ok', 'too_small', 'too_large'] as const;
export const AdherenceScaleSchema = z.enum(ADHERENCE_SCALES);
export type AdherenceScale = z.infer<typeof AdherenceScaleSchema>;

/** Image formats provider outputs may arrive in. */
export const OUTPUT_IMAGE_FORMATS = ['jpeg', 'png', 'webp'] as const;
export const OutputImageFormatSchema = z.enum(OUTPUT_IMAGE_FORMATS);
export type OutputImageFormat = z.infer<typeof OutputImageFormatSchema>;
