import type {
  AnchorCategory,
  AttachmentIntent,
  BuildingForm,
  ClimateClass,
  ClimateSource,
  DecorationPlan,
  FailureCode,
  HolidayPack,
  LightingMode,
  NormalizedBox,
  PlacementRule,
  RepairConstraint,
  RoomType,
  SceneAnalysis,
  SceneType,
  SourceKind,
  SpecAttributes,
  Style,
} from '@hailiday/core';

/** A decoration plan before compilation (the `compiled` block is added by the compiler). */
export type PlanDraft = Omit<DecorationPlan, 'compiled'>;

/** One kit archetype as the plan builder needs it (pack placement fields plus kit attributes). */
export interface PlanKitItem {
  kitItemId: string;
  archetype: string | null;
  anchors: AnchorCategory[];
  attachment: AttachmentIntent;
  placementRule: PlacementRule;
  /** Priority within the section (1 = placed first). */
  priority: number;
  specText: string;
  specAttributes: SpecAttributes | null;
  quantity: Record<Style, [number, number]>;
  required: Style[];
}

/** Adjustments a repair applies to the rebuilt plan (render spec, repair and retries). */
export interface RepairAdjustments {
  /** `kitItemId@anchorId` pairs that must not be placed again. */
  excludePairs: string[];
  /** Overlap tolerance for access regions (0 after `access_blocked`). */
  accessTolerance?: number;
  /** Multiplier on the pack's edge margin (after `neighbor_decorated`). */
  edgeMarginMultiplier?: number;
  /** Extra margin around protected regions, as a fraction of the long edge. */
  protectedMarginFraction?: number;
  /** Reduce every count to the style's minimum (at least 1). */
  countsToMinimum?: boolean;
  /** Composite mask dilation for the repaired attempt. */
  dilationFraction?: number;
  /** Placements to restate first (keys `kitItemId@anchorId`). */
  restateFirst?: string[];
  /** Lower the provider's quality or complexity setting (after `camera_changed`). */
  lowerQuality?: boolean;
  /**
   * Judge evidence boxes the repaired attempt restores from the original: excluded (grown by
   * `PIPELINE_DEFAULTS.restoreBoxGrowFraction`) from the composite mask and the keep-mask of a
   * decorate step's repair, so those pixels are the original's whatever the editor draws.
   */
  restoreBoxes?: NormalizedBox[];
}

export interface RepairInput {
  constraints: RepairConstraint[];
  adjustments: RepairAdjustments;
}

export interface BuildPlanInput {
  renderJobId: string;
  planVersion: 1 | 2;
  sourceAssetId: string;
  sceneAnalysisId: string;
  analysis: SceneAnalysis;
  sourceKind: SourceKind;
  pack: Pick<
    HolidayPack,
    'holidayId' | 'version' | 'sceneSections' | 'lightingPolicy' | 'forbidden' | 'climateRule'
  >;
  /** Full MAJOR.MINOR.PATCH version stamped on the job. */
  holidayPackVersion: string;
  styleKitVersionId: string;
  /** Spec attributes per kit item from the published style kit version. */
  kitAttributes?: ReadonlyMap<string, SpecAttributes>;
  sceneType: SceneType;
  buildingForm?: BuildingForm | null;
  roomType?: RoomType | null;
  style: Style;
  lightingMode: LightingMode;
  compilerVersion: string;
  permissionEvaluationId: string;
  /**
   * Embedded Street View attribution rectangle(s) on the working grid: one rectangle or a list
   * (configured rectangles of a live frame), or none.
   */
  attributionRegion?: NormalizedBox | readonly NormalizedBox[] | null;
  climate?: { climateClass: ClimateClass; source: ClimateSource };
  repair?: RepairInput | null;
  options?: {
    anchorFloors?: { minConfidence: number; maxOcclusion: number };
    dilationFraction?: number;
    featherFraction?: number;
    countryCode?: string;
    locale?: string;
  };
}

export type ValidatorRule =
  | 'anchor_exists'
  | 'protected_regions'
  | 'preserve_and_access'
  | 'on_target'
  | 'forbidden_list'
  | 'snow'
  | 'lighting_policy'
  | 'existing_decorations'
  | 'quantity'
  | 'non_empty'
  | 'length_cap'
  | 'mask_cap'
  | 'repair';

export interface ValidatorEvent {
  rule: ValidatorRule;
  action: 'removed' | 'shrunk' | 'clipped' | 'unlit' | 'clamped' | 'failed' | 'flagged';
  placementKey?: string;
  detail?: string;
}

/** The validator's record of what it changed and whether the plan passes. */
export interface ValidatorResult {
  passed: boolean;
  /** Plan-level failure (`forbidden_list` or `non_empty`), when the plan fails. */
  failure: 'forbidden_list' | 'non_empty' | null;
  events: ValidatorEvent[];
  existingDecorConflict: boolean;
  effectiveStyle: Style;
  placementCount: number;
}

export interface BuiltPlan {
  draft: PlanDraft;
  validator: ValidatorResult;
  /** `kitItemId@anchorId` per placement ID. */
  placementKeys: Record<string, string>;
  /** Archetype (drawing hint) per kit item. */
  archetypes: Record<string, string | null>;
}

export type { FailureCode };
