import { z } from 'zod';
import { AdherenceCheckerSchema, AdherenceStatusSchema } from '../types/commerce.js';
import {
  AnchorCategorySchema,
  BuildingFormSchema,
  ClimateClassSchema,
  ClimateSourceSchema,
  HolidayIdSchema,
  LightingModeSchema,
  PlacementRuleSchema,
  RelightLightingModeSchema,
  RoomTypeSchema,
  SceneTypeSchema,
  StyleSchema,
} from '../types/content.js';
import {
  AccessRegionKindSchema,
  AdherenceCountSchema,
  AdherenceScaleSchema,
  CriticalFailureCodeSchema,
  DecorDensitySchema,
  ExposureSchema,
  FailureCodeSchema,
  FidelityModeSchema,
  FoliageStateSchema,
  HazardKindSchema,
  MajorFailureCodeSchema,
  PreserveRegionKindSchema,
  ProtectedBlurKindSchema,
  RenderAttemptNumberSchema,
  TimeOfDaySchema,
} from '../types/render.js';
import {
  QualityHintSchema,
  UploadSeasonCueSchema,
  UploadSubjectClassSchema,
} from '../types/source.js';
import { NormalizedBoxSchema } from './box.js';

/** Schema versions written into pipeline records. */
export const SCENE_ANALYSIS_SCHEMA_VERSION = '1.0';
export const DECORATION_PLAN_SCHEMA_VERSION = '1.0';
export const COMPILED_REQUEST_SCHEMA_VERSION = '1.0';
export const JUDGE_RESULT_SCHEMA_VERSION = '1.0';
export const UPLOAD_TRIAGE_SCHEMA_VERSION = '1.0';

/** Default confidence floors and judge thresholds (configuration). */
export const DEFAULT_ANCHOR_CONFIDENCE_FLOOR = 0.6;
export const DEFAULT_ANCHOR_MAX_OCCLUSION = 0.3;
export const DEFAULT_JUDGE_THRESHOLDS = { critical: 0.7, uncertain: 0.4, major: 0.7 } as const;

/** The most restore boxes a repair plan's composite mask carries. */
export const MAX_RESTORE_BOXES = 32;

const confidence = z.number().min(0).max(1);
const recordId = z.string().min(1).max(64);

export const WorkingImageSchema = z.strictObject({
  width: z.int().positive(),
  height: z.int().positive(),
  checksum: z.string().min(1),
});
export type WorkingImage = z.infer<typeof WorkingImageSchema>;

export const AnchorSchema = z.strictObject({
  id: recordId,
  category: AnchorCategorySchema,
  box: NormalizedBoxSchema,
  confidence,
  occluded: z.boolean(),
  occlusionFraction: z.number().min(0).max(1).optional(),
  note: z.string().max(200).optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const PreserveRegionSchema = z.strictObject({
  kind: PreserveRegionKindSchema,
  box: NormalizedBoxSchema,
});
export type PreserveRegion = z.infer<typeof PreserveRegionSchema>;

export const AccessRegionSchema = z.strictObject({
  kind: AccessRegionKindSchema,
  box: NormalizedBoxSchema,
});
export type AccessRegion = z.infer<typeof AccessRegionSchema>;

export const HazardSchema = z.strictObject({ kind: HazardKindSchema, box: NormalizedBoxSchema });
export type Hazard = z.infer<typeof HazardSchema>;

export const ProtectedBlurRegionSchema = z.strictObject({
  kind: ProtectedBlurKindSchema,
  box: NormalizedBoxSchema,
});
export type ProtectedBlurRegion = z.infer<typeof ProtectedBlurRegionSchema>;

export const ExistingDecorationsSchema = z.strictObject({
  present: z.boolean(),
  holidayGuess: z.string().max(64).optional(),
  density: DecorDensitySchema,
  boxes: z.array(NormalizedBoxSchema),
});
export type ExistingDecorations = z.infer<typeof ExistingDecorationsSchema>;

export const SceneLightingSchema = z.strictObject({
  timeOfDay: TimeOfDaySchema,
  isDaylight: z.boolean(),
  exposure: ExposureSchema,
});

export const SeasonCuesSchema = z.strictObject({
  snowVisible: z.boolean(),
  foliage: FoliageStateSchema,
});
export type SeasonCues = z.infer<typeof SeasonCuesSchema>;

export const SceneQualityFlagsSchema = z.strictObject({
  blur: z.boolean(),
  lowLight: z.boolean(),
  heavyOcclusion: z.boolean(),
  multipleBuildings: z.boolean(),
  embeddedPhoto: z.boolean(),
  tooClose: z.boolean(),
  tooFar: z.boolean(),
});

/** Structured description of what is visible in the working image. Holiday-independent. */
export const SceneAnalysisSchema = z
  .strictObject({
    schemaVersion: z.string(),
    sourceAssetId: z.string().min(1),
    workingImage: WorkingImageSchema,
    sceneType: SceneTypeSchema,
    sceneTypeConfidence: confidence,
    sceneTypeMismatch: z.boolean(),
    buildingForm: BuildingFormSchema.optional(),
    roomType: RoomTypeSchema.optional(),
    targetFacade: NormalizedBoxSchema.optional(),
    targetFacadeAmbiguous: z.boolean(),
    anchors: z.array(AnchorSchema),
    preserveRegions: z.array(PreserveRegionSchema),
    accessRegions: z.array(AccessRegionSchema),
    hazards: z.array(HazardSchema),
    existingDecorations: ExistingDecorationsSchema,
    peopleBoxes: z.array(NormalizedBoxSchema),
    protectedBlurRegions: z.array(ProtectedBlurRegionSchema),
    lighting: SceneLightingSchema,
    seasonCues: SeasonCuesSchema,
    qualityFlags: SceneQualityFlagsSchema,
    model: z.strictObject({
      analysisModel: z.string(),
      analysisPromptVersion: z.string(),
      triageModel: z.string().optional(),
    }),
    elapsedMs: z.number().nonnegative(),
  })
  .superRefine((analysis, ctx) => {
    const ids = new Set<string>();
    analysis.anchors.forEach((anchor, index) => {
      if (ids.has(anchor.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate anchor id ${anchor.id}`,
          path: ['anchors', index, 'id'],
        });
      }
      ids.add(anchor.id);
    });
  });
export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>;

/**
 * The part of a scene analysis a vision model produces. The server adds `schemaVersion`,
 * `sourceAssetId`, `workingImage`, `sceneTypeMismatch`, `model` and `elapsedMs`.
 */
export const SceneAnalysisModelOutputSchema = z.strictObject({
  sceneType: SceneTypeSchema,
  sceneTypeConfidence: confidence,
  buildingForm: BuildingFormSchema.optional(),
  roomType: RoomTypeSchema.optional(),
  targetFacade: NormalizedBoxSchema.optional(),
  targetFacadeAmbiguous: z.boolean(),
  anchors: z.array(AnchorSchema),
  preserveRegions: z.array(PreserveRegionSchema),
  accessRegions: z.array(AccessRegionSchema),
  hazards: z.array(HazardSchema),
  existingDecorations: ExistingDecorationsSchema,
  peopleBoxes: z.array(NormalizedBoxSchema),
  protectedBlurRegions: z.array(ProtectedBlurRegionSchema),
  lighting: SceneLightingSchema,
  seasonCues: SeasonCuesSchema,
  qualityFlags: SceneQualityFlagsSchema,
});
export type SceneAnalysisModelOutput = z.infer<typeof SceneAnalysisModelOutputSchema>;

/** Whether an anchor passes the confidence and occlusion floors. */
export function isAnchorEligible(
  anchor: Anchor,
  floors: { minConfidence: number; maxOcclusion: number } = {
    minConfidence: DEFAULT_ANCHOR_CONFIDENCE_FLOOR,
    maxOcclusion: DEFAULT_ANCHOR_MAX_OCCLUSION,
  },
): boolean {
  return (
    anchor.confidence >= floors.minConfidence &&
    (anchor.occlusionFraction ?? (anchor.occluded ? 1 : 0)) <= floors.maxOcclusion
  );
}

const unitCoordinate = z.number().min(0).max(1);

/** A point `[x, y]` normalized to 0–1 on the working image (same axes as boxes). */
export const NormalizedPointSchema = z.tuple([unitCoordinate, unitCoordinate]);
export type NormalizedPoint = z.infer<typeof NormalizedPointSchema>;

/**
 * One editable shape of a placement's composite mask: an axis-aligned box (a band or a whole
 * item) or a convex polygon (a sloped band along a gable edge). Shapes only build the composite
 * mask; the placement's `region` bounds them and drives compiled text and overlap checks.
 */
export const MaskShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('box'), box: NormalizedBoxSchema }),
  z.strictObject({
    kind: z.literal('polygon'),
    points: z.array(NormalizedPointSchema).min(3).max(16),
  }),
]);
export type MaskShape = z.infer<typeof MaskShapeSchema>;

/** One planned kit item on one existing anchor. */
export const PlacementSchema = z.strictObject({
  id: recordId,
  kitItemId: z.string().min(1),
  anchorId: recordId,
  anchorCategory: AnchorCategorySchema,
  region: NormalizedBoxSchema,
  /** Tight mask geometry inside `region`; absent means the whole region is editable. */
  maskShapes: z.array(MaskShapeSchema).min(1).max(8).optional(),
  placementRule: PlacementRuleSchema,
  count: z.int().positive(),
  specText: z.string().min(1),
  specAttributes: z.record(z.string(), z.union([z.string(), z.number()])),
  lit: z.boolean(),
  priority: z.int().positive(),
});
export type Placement = z.infer<typeof PlacementSchema>;

/**
 * The source-mode mask budget applied by the plan builder: the share of the image the union of
 * mask shapes covers before dilation, the cap, how far garland drapes were shortened and which
 * optional placements were dropped to stay under the cap.
 */
export const MaskBudgetSchema = z.strictObject({
  cap: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  drapeScale: z.number().min(0).max(1),
  dropped: z.array(z.strictObject({ kitItemId: z.string().min(1), anchorId: recordId })),
});
export type MaskBudget = z.infer<typeof MaskBudgetSchema>;

export const RepairConstraintSchema = z.strictObject({
  code: FailureCodeSchema,
  instruction: z.string(),
  placementIds: z.array(recordId),
});
export type RepairConstraint = z.infer<typeof RepairConstraintSchema>;

/**
 * The accepted daylight variant an evening relight starts from: another job's published variant
 * (`variant`) or this job's own first attempt (`attempt`), with that attempt's plan and, once
 * published, its render asset.
 */
export const RelightBaseSchema = z.strictObject({
  base: z.enum(['variant', 'attempt']),
  baseJobId: z.string().min(1),
  baseAttemptId: z.string().min(1),
  basePlanId: z.string().min(1),
  baseRenderAssetId: z.string().min(1).nullable(),
});
export type RelightBase = z.infer<typeof RelightBaseSchema>;

/** Validated, deterministic list of placements and preserve instructions for one attempt. */
export const DecorationPlanSchema = z.strictObject({
  schemaVersion: z.string(),
  renderJobId: z.string().min(1),
  planVersion: RenderAttemptNumberSchema,
  attemptNumber: RenderAttemptNumberSchema,
  sourceAssetId: z.string().min(1),
  sceneAnalysisId: z.string().min(1),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  locale: z.string(),
  sceneType: SceneTypeSchema,
  buildingForm: BuildingFormSchema.optional(),
  roomType: RoomTypeSchema.optional(),
  holidayId: HolidayIdSchema,
  holidayPackVersion: z.string(),
  styleKitVersionId: z.string().min(1),
  style: StyleSchema,
  lightingMode: LightingModeSchema,
  fidelityMode: FidelityModeSchema,
  compilerVersion: z.string().min(1),
  climate: z
    .strictObject({ climateClass: ClimateClassSchema, source: ClimateSourceSchema })
    .optional(),
  placements: z.array(PlacementSchema),
  maskBudget: MaskBudgetSchema.optional(),
  preserve: z.strictObject({
    targetFacade: NormalizedBoxSchema.optional(),
    regions: z.array(PreserveRegionSchema),
    protectedBlurRegions: z.array(ProtectedBlurRegionSchema),
    peopleBoxes: z.array(NormalizedBoxSchema),
    accessRegions: z.array(AccessRegionSchema),
    existingDecorations: z.array(NormalizedBoxSchema),
    keepSkyAndTimeOfDay: z.boolean(),
    neighborsUnchanged: z.boolean(),
    noSnow: z.boolean(),
    /** The first embedded attribution rectangle (plans written before the list carry only this). */
    attributionRegion: NormalizedBoxSchema.optional(),
    /** Every embedded attribution rectangle on the working grid. */
    attributionRegions: z.array(NormalizedBoxSchema).optional(),
  }),
  negatives: z.array(z.string()),
  lightingInstruction: z.strictObject({ mode: LightingModeSchema, text: z.string() }),
  repairConstraints: z.array(RepairConstraintSchema).optional(),
  existingDecorConflict: z.boolean(),
  permissionEvaluationId: z.string().min(1),
  referenceAssetIds: z.array(z.string()),
  compositeMask: z
    .strictObject({
      objectKey: z.string().optional(),
      dilationFraction: z.number().min(0).max(1),
      featherFraction: z.number().min(0).max(1),
      /**
       * A repair attempt's restore boxes: judge evidence boxes excluded (with a margin) from the
       * composite mask and the keep-mask, so their pixels are the original's.
       */
      restoreBoxes: z.array(NormalizedBoxSchema).max(MAX_RESTORE_BOXES).optional(),
    })
    .optional(),
  compiled: z.strictObject({
    provider: z.string(),
    modelSnapshot: z.string(),
    instructionText: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    hash: z.string(),
  }),
  /**
   * Set on an evening relight plan: the daylight variant it relights. Its placements are the base
   * plan's (the decorations the relight keeps); nothing is planned anew.
   */
  relightOf: RelightBaseSchema.optional(),
});
export type DecorationPlan = z.infer<typeof DecorationPlanSchema>;

/** One decoration the localizer found in an aligned output, as recorded on the attempt. */
export const LocalizedAdditionRecordSchema = z.strictObject({
  label: z.string().max(200),
  box: NormalizedBoxSchema,
  /** The plan placement it is, when it is a planned item. */
  placementId: z.string().min(1).max(64).nullable(),
});
export type LocalizedAdditionRecord = z.infer<typeof LocalizedAdditionRecordSchema>;

/**
 * The localization of a `source` attempt (`render_attempts.composite_mask.localization`): the
 * added decorations and other changes the vision model found in the aligned output, what the
 * keep-mask kept, and the call's model, prompt version, usage and ledger row. `fallback` records
 * a failed call after which the plan-only mask was used.
 */
export const LocalizationRecordSchema = z.strictObject({
  status: z.enum(['localized', 'fallback']),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  items: z.array(LocalizedAdditionRecordSchema),
  otherChanges: z.array(
    z.strictObject({ description: z.string().max(300), box: NormalizedBoxSchema }),
  ),
  /** Unplanned items the coverage cap removed from the keep-mask, largest first. */
  dropped: z.array(LocalizedAdditionRecordSchema),
  /** Dilation of each localized box in working pixels. */
  dilationPx: z.int().nonnegative(),
  /** Hard keep-mask coverage before the cap and after it (the mask used). */
  coverageBeforeCap: z.number().min(0).max(1),
  coverage: z.number().min(0).max(1),
  usage: z.record(z.string(), z.unknown()).nullable(),
  ledgerEntryId: z.string().nullable(),
  elapsedMs: z.number().nonnegative().nullable(),
  fallbackReason: z.string().max(200).optional(),
});
export type LocalizationRecord = z.infer<typeof LocalizationRecordSchema>;

/**
 * `render_attempts.fallback` of a relight attempt (`evening` or `bright`): the daylight variant
 * (or this job's own decorated attempt) the relight used as its input. Earlier jobs may carry the
 * retired `evening_relight` record of a deterministic relight instead.
 */
export const RelightAttemptRecordSchema = RelightBaseSchema.extend({
  kind: z.literal('relight'),
});
export type RelightAttemptRecord = z.infer<typeof RelightAttemptRecordSchema>;

/**
 * `render_attempts.fallback` of a decorate attempt of a relight-mode job that is not relit: the
 * photo decorated as photographed is the job's result. `not_daylight`: an evening look of a photo
 * the scene analysis reports as dusk or night. `already_bright`: a bright look of a photo whose
 * median luma over its content area (padding excluded) is at or above the threshold.
 */
export const RelightSkippedRecordSchema = z.discriminatedUnion('reason', [
  z.strictObject({
    kind: z.literal('relight_skipped'),
    reason: z.literal('not_daylight'),
    timeOfDay: TimeOfDaySchema,
  }),
  z.strictObject({
    kind: z.literal('relight_skipped'),
    reason: z.literal('already_bright'),
    medianLuma: z.number().min(0).max(1),
    threshold: z.number().min(0).max(1),
  }),
]);
export type RelightSkippedRecord = z.infer<typeof RelightSkippedRecordSchema>;

/**
 * Why a relight-mode job ended without its relight. `relight_rejected`: the relight failed QA for
 * good; `relight_failed`: the relight's edit failed (`failureKind`); `relight_not_attempted`: the
 * time budget or the paid-attempt cap allowed no further edit for the relight.
 */
export const RELIGHT_FALLBACK_REASONS = [
  'relight_rejected',
  'relight_failed',
  'relight_not_attempted',
] as const;
export const RelightFallbackReasonSchema = z.enum(RELIGHT_FALLBACK_REASONS);
export type RelightFallbackReason = z.infer<typeof RelightFallbackReasonSchema>;

/**
 * `render_attempts.fallback` of the decorated base of a relight-mode job that was not relit. A
 * `bright` job delivers that base as its result (`deliveredAs: 'result'`). An `evening` job that
 * decorated its own base and ends without its relight (rejected, failed or not attempted) has
 * that base as its daylight variant (`daylight_variant`) and ends rejected; in pre-delivery review
 * the base is instead held for a reviewer under a companion job in `needs_review` (`heldJobId`,
 * `deliveredAs: null`). `codes` are the codes that rejected the relight, or, when the relight was
 * not attempted after a repaired base, the codes that rejected the first base.
 */
export const RelightFallbackRecordSchema = z.strictObject({
  kind: z.literal('relight_fallback'),
  target: RelightLightingModeSchema,
  reason: RelightFallbackReasonSchema,
  deliveredAs: z.enum(['result', 'daylight_variant']).nullable(),
  relightAttemptId: z.string().min(1).nullable(),
  codes: z.array(FailureCodeSchema),
  failureKind: z.string().max(64).optional(),
  /** The companion job that holds the daylight base for pre-delivery review. */
  heldJobId: z.string().min(1).optional(),
});
export type RelightFallbackRecord = z.infer<typeof RelightFallbackRecordSchema>;

/** Every record `render_attempts.fallback` may carry. */
export const AttemptFallbackRecordSchema = z.union([
  RelightAttemptRecordSchema,
  RelightSkippedRecordSchema,
  RelightFallbackRecordSchema,
]);
export type AttemptFallbackRecord = z.infer<typeof AttemptFallbackRecordSchema>;

/** Provider-specific edit request compiled deterministically from a plan. */
export const CompiledRequestSchema = z.strictObject({
  schemaVersion: z.string(),
  compilerVersion: z.string(),
  /**
   * What the request asks for: `decorate` (absent on requests written before relights existed)
   * adds the planned decorations; `relight` changes only the light of an accepted daylight
   * variant (no mask; also marked by `parameters.relight`); `enhance` redraws a Street View
   * frame sharper and cleaner with nothing else changed (no mask; also marked by
   * `parameters.enhance`).
   */
  kind: z.enum(['decorate', 'relight', 'enhance']).optional(),
  provider: z.string(),
  modelSnapshot: z.string(),
  images: z
    .array(
      z.strictObject({
        role: z.literal('source'),
        width: z.int().positive(),
        height: z.int().positive(),
        checksum: z.string(),
      }),
    )
    .length(1),
  mask: z
    .strictObject({ width: z.int().positive(), height: z.int().positive(), checksum: z.string() })
    .optional(),
  instructionText: z.string().min(1),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  settingsHash: z.string(),
});
export type CompiledRequest = z.infer<typeof CompiledRequestSchema>;

/** How a job came by its working image with respect to the Street View enhancement. */
export const JOB_ENHANCEMENT_OUTCOMES = [
  'made',
  'reused',
  'rejected',
  'failed',
  'skipped',
] as const;
export const JobEnhancementOutcomeSchema = z.enum(JOB_ENHANCEMENT_OUTCOMES);
export type JobEnhancementOutcome = z.infer<typeof JobEnhancementOutcomeSchema>;

/**
 * `render_jobs.enhancement`: the outcome of the enhancement step for a Street View job, the
 * enhancement row it concerns (null when none) and the reason of a skip, rejection or failure.
 */
export const JobEnhancementRecordSchema = z.strictObject({
  outcome: JobEnhancementOutcomeSchema,
  enhancementId: z.uuid().nullable(),
  reason: z.string().max(64).nullable(),
});
export type JobEnhancementRecord = z.infer<typeof JobEnhancementRecordSchema>;

const score = z.int().min(1).max(5);

export const JudgeFindingSchema = <T extends z.ZodType>(code: T) =>
  z.strictObject({
    code,
    confidence,
    evidence: z.string().max(500),
    box: NormalizedBoxSchema.optional(),
  });

export const PlacementAdherenceSchema = z.strictObject({
  placementId: recordId,
  present: z.boolean(),
  confidence,
  adherence: z.strictObject({
    category: z.boolean(),
    colorFamily: z.boolean(),
    count: AdherenceCountSchema,
    scale: AdherenceScaleSchema,
  }),
});
export type PlacementAdherence = z.infer<typeof PlacementAdherenceSchema>;

/** Structured verdict of the quality checks on one attempt. */
export const JudgeResultSchema = z.strictObject({
  schemaVersion: z.string(),
  renderAttemptId: z.string().min(1),
  judgeModel: z.string(),
  judgePromptVersion: z.string(),
  escalated: z.boolean(),
  critical: z.array(JudgeFindingSchema(CriticalFailureCodeSchema)),
  major: z.array(JudgeFindingSchema(MajorFailureCodeSchema)),
  placements: z.array(PlacementAdherenceSchema),
  scores: z.strictObject({ realism: score, appeal: score, planAdherence: score }),
  overallConfidence: confidence,
  elapsedMs: z.number().nonnegative(),
});
export type JudgeResult = z.infer<typeof JudgeResultSchema>;

/** The part of a judge result a vision model produces. */
export const JudgeModelOutputSchema = z.strictObject({
  critical: z.array(JudgeFindingSchema(CriticalFailureCodeSchema)),
  major: z.array(JudgeFindingSchema(MajorFailureCodeSchema)),
  placements: z.array(PlacementAdherenceSchema),
  scores: z.strictObject({ realism: score, appeal: score, planAdherence: score }),
  overallConfidence: confidence,
});
export type JudgeModelOutput = z.infer<typeof JudgeModelOutputSchema>;

/** Adherence record for a `render_product_links` row. */
export const AdherenceRecordSchema = z.strictObject({
  status: AdherenceStatusSchema,
  checkedBy: AdherenceCheckerSchema.nullable(),
  checkedAt: z.iso.datetime().nullable(),
  failedCriteria: z.array(z.enum(['category', 'colorFamily', 'count'])),
});
export type AdherenceRecord = z.infer<typeof AdherenceRecordSchema>;

/** Structured triage of an upload: living-space check, scene type and quality flags. */
export const UploadTriageSchema = z.strictObject({
  subjectClass: UploadSubjectClassSchema,
  sceneType: SceneTypeSchema.nullable(),
  sceneTypeConfidence: confidence,
  roomType: RoomTypeSchema.nullable(),
  roomTypeConfidence: confidence.nullable(),
  buildingForm: BuildingFormSchema.nullable(),
  buildingFormConfidence: confidence.nullable(),
  multiUnitFacade: z.boolean(),
  qualityFlags: z.array(QualityHintSchema),
  existingDecorations: z.union([
    z.literal('none'),
    z.strictObject({ holidayGuess: z.string().max(64), density: DecorDensitySchema }),
  ]),
  seasonCues: z.array(UploadSeasonCueSchema),
  peopleBoxes: z.array(NormalizedBoxSchema).optional(),
});
export type UploadTriage = z.infer<typeof UploadTriageSchema>;
