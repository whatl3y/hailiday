import {
  DECORATION_PLAN_SCHEMA_VERSION,
  effectiveSectionAnchors,
  fidelityModeFor,
  flattenSpecAttributes,
  kitInPriorityOrder,
  type ForbiddenItem,
  type HolidayPack,
  type LightingMode,
  type MaskBudget,
  type MaskShape,
  type NormalizedBox,
  type SceneSection,
  type SceneType,
  type SpecAttributes,
  type Style,
} from '@hailiday/core';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { PLACEMENT_GEOMETRY, placementGeometry, roundBox, type Grid } from './geometry.js';
import { FORBIDDEN_NEGATIVES } from './phrases.js';
import { clipShapes, shapesCoverage } from './shapes.js';
import type { BuildPlanInput, BuiltPlan, PlanDraft, PlanKitItem, ValidatorEvent } from './types.js';
import {
  applyQuantityRules,
  attributionBoxes,
  checkPlacement,
  effectiveStyleFor,
  eligibleAnchorsFor,
  existingDecorConflict,
  forbiddenViolations,
  lightsAllowedFor,
  type CandidatePlacement,
  type PlacementCheckContext,
} from './validator.js';

/** Raised when a plan cannot be built because content is missing or invalid (a Hailiday defect). */
export class PlanConfigurationError extends Error {
  readonly reason: 'missing_scene_section' | 'forbidden_list';
  readonly detail: string[];
  constructor(reason: PlanConfigurationError['reason'], detail: string[] = []) {
    super(`Plan configuration error: ${reason}${detail.length ? ` (${detail.join(', ')})` : ''}`);
    this.name = 'PlanConfigurationError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** The pack's archetypes for a section in priority order, joined with kit spec attributes. */
export function planKitItems(
  section: SceneSection,
  kitAttributes?: ReadonlyMap<string, SpecAttributes>,
): PlanKitItem[] {
  return kitInPriorityOrder(section).map((item, index) => ({
    kitItemId: item.kitItemId,
    archetype: item.archetype ?? null,
    anchors: [...item.anchors],
    attachment: item.attachment,
    placementRule: item.placementRule,
    priority: item.priority ?? index + 1,
    specText: item.specText,
    specAttributes: kitAttributes?.get(item.kitItemId) ?? item.specAttributes ?? null,
    quantity: {
      subtle: [...item.quantity.subtle],
      classic: [...item.quantity.classic],
      abundant: [...item.quantity.abundant],
    },
    required: [...item.required],
  }));
}

const EVENING_BLOCK =
  'Shift the whole scene to early dusk: deepen the sky and lower the ambient light moderately so the lit decorations read clearly. Keep every roof line, window, door, wall, material and color, and every neighboring building identical in shape and position. Windows that already exist may show a soft warm interior glow. Add no light sources other than the decorations.';

/**
 * The compiled lighting instruction for a plan (render spec, lighting modes). Decorate attempts
 * are planned as photographed; a relit look (`evening`, `bright`) relights the decorated photo
 * afterwards, so only the legacy combined `evening` plan carries the dusk block.
 */
export function lightingInstructionFor(input: {
  lightingMode: LightingMode;
  anyLit: boolean;
  lightsAllowed: boolean;
  eveningGuidance?: string | undefined;
}): string {
  if (input.lightingMode === 'evening') {
    return input.eveningGuidance
      ? `${EVENING_BLOCK} ${input.eveningGuidance.trim()}`
      : EVENING_BLOCK;
  }
  const base = 'Keep the lighting, sky and time of day of the original photograph.';
  if (!input.lightsAllowed) return `${base} No electric lights.`;
  return input.anyLit
    ? `${base} The lit decorations are switched on and glow softly in the existing light.`
    : base;
}

/** Words that show a negative is already stated by the pack's own negative fragment. */
const NEGATIVE_COVERAGE: Readonly<Partial<Record<ForbiddenItem, RegExp>>> = {
  people: /\bpeople\b/i,
  pets: /\bpets?\b/i,
  text_or_signage: /\b(text|signage|lettering)\b/i,
  brand_logos: /\b(logos?|brands?)\b/i,
  cartoon_or_licensed_characters: /\b(cartoon|characters?)\b/i,
  mascots_and_inflatables: /\b(inflatables?|mascots?)\b/i,
  snow_or_frost_unless_visible: /\bsnow\b/i,
  sky_effects: /\b(sky|fireworks?)\b/i,
  religious_symbols: /\breligious\b/i,
  open_flame_indoors: /\bflames?\b/i,
  gore: /\bgore\b/i,
  realistic_weapons: /\bweapons?\b/i,
  costume_caricature: /\b(costumes?|caricatures?)\b/i,
  new_structures: /\bstructures?\b/i,
};

/**
 * Negatives compiled from the pack's forbidden list: snow only when the source shows none, open
 * flames only indoors, and items the section's negative fragment already states are left out so
 * the compiled text stays within its cap.
 */
export function negativesFor(
  pack: Pick<HolidayPack, 'forbidden'>,
  options: { snowVisible: boolean; sceneType?: SceneType; coveredBy?: string },
): string[] {
  const negatives: string[] = [];
  for (const item of pack.forbidden) {
    if (item === 'snow_or_frost_unless_visible' && options.snowVisible) continue;
    if (item === 'open_flame_indoors' && options.sceneType && options.sceneType !== 'interior') {
      continue;
    }
    const covered = NEGATIVE_COVERAGE[item];
    if (covered && options.coveredBy && covered.test(options.coveredBy)) continue;
    const phrase = FORBIDDEN_NEGATIVES[item];
    if (phrase && !negatives.includes(phrase)) negatives.push(phrase);
  }
  return negatives;
}

function lit(item: PlanKitItem): boolean {
  return item.specAttributes?.lit === true;
}

/**
 * Recomputes a validated placement's mask shapes with a garland drape scale and clips them to
 * its validated region (which keeps bounding them). Null when no shape remains.
 */
function shapedPlacement(
  candidate: CandidatePlacement,
  anchors: ReadonlyMap<string, BuildPlanInput['analysis']['anchors'][number]>,
  grid: Grid,
  drapeScale: number,
): CandidatePlacement | null {
  const anchor = anchors.get(candidate.anchorId);
  if (!anchor) return null;
  const geometry = placementGeometry(candidate.placementRule, anchor, grid, {
    attachment: candidate.attachment,
    drapeScale,
  });
  if (!geometry) return null;
  const maskShapes = clipShapes(geometry.shapes, candidate.region);
  if (maskShapes.length === 0) return null;
  return { ...candidate, maskShapes };
}

/** Whether a placement's shapes add nothing beyond its region (one box equal to it). */
function regionOnly(shapes: readonly MaskShape[] | undefined, region: NormalizedBox): boolean {
  if (!shapes || shapes.length !== 1) return !shapes;
  const [shape] = shapes;
  return shape?.kind === 'box' && shape.box.every((value, i) => value === region[i]);
}

/**
 * Source-mode mask budget (render spec, placement geometry): while the union of mask shapes
 * covers more than the cap, garland drapes are shortened (half, then the lights band), then the
 * lowest-priority optional placements are dropped; a placement is optional when its archetype is
 * not required for the style or another placement of the archetype remains.
 */
function applyMaskBudget(
  validated: readonly CandidatePlacement[],
  reshape: (candidate: CandidatePlacement, drapeScale: number) => CandidatePlacement | null,
  required: ReadonlySet<string>,
  minimums: ReadonlyMap<string, number>,
  grid: Grid,
  events: ValidatorEvent[],
): { placements: CandidatePlacement[]; budget: MaskBudget } {
  const cap = PLACEMENT_GEOMETRY.sourceMaskCap;
  const shapeAll = (scale: number) =>
    validated.map((c) => reshape(c, scale)).filter((c): c is CandidatePlacement => c !== null);
  const coverageOf = (list: readonly CandidatePlacement[]) =>
    shapesCoverage(
      list.flatMap((c) => c.maskShapes ?? []),
      grid,
    );
  let drapeScale = 1;
  let placements = shapeAll(drapeScale);
  let coverage = coverageOf(placements);
  for (const scale of [0.5, 0]) {
    if (coverage <= cap) break;
    drapeScale = scale;
    placements = shapeAll(scale);
    coverage = coverageOf(placements);
    events.push({ rule: 'mask_cap', action: 'shrunk', detail: `drape:${scale}` });
  }
  const dropped: MaskBudget['dropped'] = [];
  while (coverage > cap) {
    let victimIndex = -1;
    for (let i = placements.length - 1; i >= 0; i -= 1) {
      const candidate = placements[i] as CandidatePlacement;
      const siblings = placements.filter((p) => p.kitItemId === candidate.kitItemId).length;
      if (!required.has(candidate.kitItemId) || siblings > 1) {
        victimIndex = i;
        break;
      }
    }
    if (victimIndex < 0) break;
    const [victim] = placements.splice(victimIndex, 1) as [CandidatePlacement];
    if (required.has(victim.kitItemId)) {
      const keeper = placements.find((p) => p.kitItemId === victim.kitItemId);
      const min = minimums.get(victim.kitItemId) ?? 1;
      if (keeper) keeper.count = Math.max(keeper.count, Math.min(min, keeper.count + victim.count));
    }
    dropped.push({ kitItemId: victim.kitItemId, anchorId: victim.anchorId });
    events.push({ rule: 'mask_cap', action: 'removed', placementKey: victim.key });
    coverage = coverageOf(placements);
  }
  return {
    placements,
    budget: { cap, coverage: Math.round(coverage * 10_000) / 10_000, drapeScale, dropped },
  };
}

/**
 * Builds and validates the decoration plan for one attempt (render spec, decoration plan):
 * deterministic, no I/O. Kit archetypes are placed in priority order on eligible anchors of
 * their categories in descending analysis confidence; each placement is checked by the validator
 * rules; quantities and the section cap are applied; then the plan-level rules run.
 */
export function buildPlan(input: BuildPlanInput): BuiltPlan {
  const section = input.pack.sceneSections[input.sceneType];
  if (!section) throw new PlanConfigurationError('missing_scene_section', [input.sceneType]);
  const analysis = input.analysis;
  const floors = input.options?.anchorFloors ?? PIPELINE_DEFAULTS.anchorFloors;
  const events: ValidatorEvent[] = [];
  const adjustments = input.repair?.adjustments ?? null;
  const lightsAllowed = lightsAllowedFor(input.pack.holidayId, input.sceneType);
  const style: Style = effectiveStyleFor(input.style, analysis.existingDecorations);
  if (style !== input.style) {
    events.push({ rule: 'existing_decorations', action: 'flagged', detail: `style:${style}` });
  }
  const kit = planKitItems(section, input.kitAttributes);
  const allowed = new Set<string>(
    effectiveSectionAnchors(section, {
      buildingForm: input.buildingForm ?? analysis.buildingForm ?? null,
      roomType: input.roomType ?? analysis.roomType ?? null,
    }),
  );
  const coldOnly = new Set(input.pack.climateRule.coldClimateOnlyItems);
  const attribution = attributionBoxes(input.attributionRegion);
  const ctx: PlacementCheckContext = {
    analysis,
    sceneType: input.sceneType,
    holidayId: input.pack.holidayId,
    section,
    floors,
    lightsAllowed,
    attributionRegion: attribution,
    adjustments,
  };
  const grid = { width: analysis.workingImage.width, height: analysis.workingImage.height };

  let candidates: CandidatePlacement[] = [];
  for (const item of kit) {
    const [min, max] = item.quantity[style];
    if (max <= 0) continue;
    if (coldOnly.has(item.kitItemId) && input.climate?.climateClass !== 'cold') continue;
    const passing: CandidatePlacement[] = [];
    for (const anchor of eligibleAnchorsFor(item, allowed, analysis, floors)) {
      const geometry = placementGeometry(item.placementRule, anchor, grid, {
        attachment: item.attachment,
      });
      if (!geometry) continue;
      const checked = checkPlacement(
        {
          id: 'pending',
          key: `${item.kitItemId}@${anchor.id}`,
          kitItemId: item.kitItemId,
          anchorId: anchor.id,
          anchorCategory: anchor.category,
          region: geometry.region,
          maskShapes: geometry.shapes,
          placementRule: item.placementRule,
          count: 1,
          specText: item.specText,
          specAttributes: item.specAttributes ? flattenSpecAttributes(item.specAttributes) : {},
          lit: lit(item) && lightsAllowed,
          priority: item.priority,
          attachment: item.attachment,
          anchorConfidence: anchor.confidence,
        },
        ctx,
        events,
      );
      if (checked) passing.push(checked);
    }
    if (passing.length === 0) continue;
    // count = clamp(eligible anchors, min, max); instances go one per anchor in turn.
    const count = Math.max(1, Math.min(max, Math.max(min, passing.length)));
    const counts = passing.map(() => 0);
    for (let i = 0; i < count; i += 1)
      counts[i % passing.length] = (counts[i % passing.length] ?? 0) + 1;
    passing.forEach((placement, index) => {
      const assigned = counts[index] ?? 0;
      if (assigned > 0) candidates.push({ ...placement, count: assigned });
    });
  }

  candidates = applyQuantityRules(
    candidates,
    kit,
    style,
    section.limits.maxPlacements[style],
    events,
    { countsToMinimum: adjustments?.countsToMinimum ?? false },
  );

  // Order: restated placements first (repair), then archetype priority, then confidence.
  const restate = new Set(adjustments?.restateFirst ?? []);
  candidates.sort(
    (a, b) =>
      Number(restate.has(b.key)) - Number(restate.has(a.key)) ||
      a.priority - b.priority ||
      b.anchorConfidence - a.anchorConfidence ||
      a.anchorId.localeCompare(b.anchorId),
  );

  // Mask shapes follow the validated regions; in source lighting the mask budget applies.
  const anchorsById = new Map(analysis.anchors.map((anchor) => [anchor.id, anchor]));
  const reshape = (candidate: CandidatePlacement, drapeScale: number) =>
    shapedPlacement(candidate, anchorsById, grid, drapeScale);
  const validated = candidates;
  let maskBudget: MaskBudget | null = null;
  if (input.lightingMode === 'source') {
    const budgeted = applyMaskBudget(
      candidates,
      reshape,
      new Set(kit.filter((item) => item.required.includes(style)).map((item) => item.kitItemId)),
      new Map(kit.map((item) => [item.kitItemId, Math.max(1, item.quantity[style][0])])),
      grid,
      events,
    );
    candidates = budgeted.placements;
    maskBudget = budgeted.budget;
  } else {
    candidates = candidates
      .map((candidate) => reshape(candidate, 1))
      .filter((candidate): candidate is CandidatePlacement => candidate !== null);
  }
  // A placement whose validated region kept none of its shapes has nowhere to go.
  const shaped = new Set(candidates.map((candidate) => candidate.key));
  const capped = new Set(
    (maskBudget?.dropped ?? []).map((pair) => `${pair.kitItemId}@${pair.anchorId}`),
  );
  for (const candidate of validated) {
    if (shaped.has(candidate.key) || capped.has(candidate.key)) continue;
    events.push({
      rule: 'on_target',
      action: 'removed',
      placementKey: candidate.key,
      detail: 'no_mask_shape',
    });
  }

  const placementKeys: Record<string, string> = {};
  const placements = candidates
    .map((candidate) => ({ ...candidate, region: roundBox(candidate.region) }))
    .filter(
      (candidate) =>
        candidate.region[0] < candidate.region[2] && candidate.region[1] < candidate.region[3],
    )
    .map((candidate, index) => {
      const id = `p${index + 1}`;
      placementKeys[id] = candidate.key;
      return {
        id,
        kitItemId: candidate.kitItemId,
        anchorId: candidate.anchorId,
        anchorCategory: candidate.anchorCategory,
        region: candidate.region,
        ...(regionOnly(candidate.maskShapes, candidate.region)
          ? {}
          : { maskShapes: candidate.maskShapes as MaskShape[] }),
        placementRule: candidate.placementRule,
        count: candidate.count,
        specText: candidate.specText,
        specAttributes: candidate.specAttributes,
        lit: candidate.lit,
        priority: index + 1,
      };
    });

  const violations = forbiddenViolations(input.pack.forbidden, [
    section.promptFragments.scene,
    ...placements.map((placement) => placement.specText),
  ]);
  const conflict = existingDecorConflict(analysis.existingDecorations, input.pack.holidayId);
  if (conflict)
    events.push({ rule: 'existing_decorations', action: 'flagged', detail: 'conflict' });
  let failure: BuiltPlan['validator']['failure'] = null;
  if (violations.length > 0) {
    failure = 'forbidden_list';
    events.push({ rule: 'forbidden_list', action: 'failed', detail: violations.join(',') });
  } else if (placements.length === 0) {
    failure = 'non_empty';
    events.push({ rule: 'non_empty', action: 'failed' });
  }

  const snowVisible = analysis.seasonCues.snowVisible;
  const fidelityMode = fidelityModeFor(input.lightingMode);
  const draft: PlanDraft = {
    schemaVersion: DECORATION_PLAN_SCHEMA_VERSION,
    renderJobId: input.renderJobId,
    planVersion: input.planVersion,
    attemptNumber: input.planVersion,
    sourceAssetId: input.sourceAssetId,
    sceneAnalysisId: input.sceneAnalysisId,
    countryCode: input.options?.countryCode ?? 'US',
    locale: input.options?.locale ?? 'en-US',
    sceneType: input.sceneType,
    ...(input.sceneType === 'house_exterior' && (input.buildingForm ?? analysis.buildingForm)
      ? {
          buildingForm: (input.buildingForm ?? analysis.buildingForm) as NonNullable<
            PlanDraft['buildingForm']
          >,
        }
      : {}),
    ...(input.sceneType === 'interior' && (input.roomType ?? analysis.roomType)
      ? { roomType: (input.roomType ?? analysis.roomType) as NonNullable<PlanDraft['roomType']> }
      : {}),
    holidayId: input.pack.holidayId,
    holidayPackVersion: input.holidayPackVersion,
    styleKitVersionId: input.styleKitVersionId,
    style: input.style,
    lightingMode: input.lightingMode,
    fidelityMode,
    compilerVersion: input.compilerVersion,
    ...(input.climate ? { climate: input.climate } : {}),
    placements,
    ...(maskBudget ? { maskBudget } : {}),
    preserve: {
      ...(analysis.targetFacade ? { targetFacade: analysis.targetFacade } : {}),
      regions: analysis.preserveRegions,
      protectedBlurRegions: analysis.protectedBlurRegions,
      peopleBoxes: analysis.peopleBoxes,
      accessRegions: analysis.accessRegions,
      existingDecorations: analysis.existingDecorations.boxes,
      keepSkyAndTimeOfDay: input.lightingMode === 'source',
      neighborsUnchanged: true,
      noSnow: !snowVisible,
      // The first rectangle is kept alone too, for readers of plans written before the list.
      ...(attribution[0] ? { attributionRegion: attribution[0] } : {}),
      ...(attribution.length > 0 ? { attributionRegions: attribution } : {}),
    },
    negatives: negativesFor(input.pack, {
      snowVisible,
      sceneType: input.sceneType,
      coveredBy: section.promptFragments.negative,
    }),
    lightingInstruction: {
      mode: input.lightingMode,
      text: lightingInstructionFor({
        lightingMode: input.lightingMode,
        anyLit: placements.some((placement) => placement.lit),
        lightsAllowed,
        eveningGuidance: input.pack.lightingPolicy.eveningGuidance,
      }),
    },
    ...(input.repair && input.repair.constraints.length > 0
      ? {
          // Constraints name placements by `kitItemId@anchorId`; map them to this plan's IDs.
          repairConstraints: input.repair.constraints.map((constraint) => ({
            ...constraint,
            placementIds: constraint.placementIds
              .map((key) => Object.entries(placementKeys).find(([, value]) => value === key)?.[0])
              .filter((id): id is string => id !== undefined),
          })),
        }
      : {}),
    existingDecorConflict: conflict,
    permissionEvaluationId: input.permissionEvaluationId,
    referenceAssetIds: [],
    compositeMask: {
      dilationFraction:
        adjustments?.dilationFraction ??
        input.options?.dilationFraction ??
        PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: input.options?.featherFraction ?? PIPELINE_DEFAULTS.featherFraction,
    },
  };

  const archetypes: Record<string, string | null> = {};
  for (const item of kit) archetypes[item.kitItemId] = item.archetype;

  return {
    draft,
    validator: {
      passed: failure === null,
      failure,
      events,
      existingDecorConflict: conflict,
      effectiveStyle: style,
      placementCount: placements.length,
    },
    placementKeys,
    archetypes,
  };
}

/** Removes placements (by ID) from a draft and renumbers the rest in order. */
export function withoutPlacements(
  built: BuiltPlan,
  placementIds: readonly string[],
  rule: 'length_cap' | 'repair' = 'length_cap',
): BuiltPlan {
  if (placementIds.length === 0) return built;
  const drop = new Set(placementIds);
  const placementKeys: Record<string, string> = {};
  const events = [...built.validator.events];
  const kept = built.draft.placements.filter((placement) => {
    if (!drop.has(placement.id)) return true;
    events.push({ rule, action: 'removed', placementKey: built.placementKeys[placement.id] });
    return false;
  });
  const placements = kept.map((placement, index) => {
    const id = `p${index + 1}`;
    placementKeys[id] = built.placementKeys[placement.id] ?? placement.id;
    return { ...placement, id, priority: index + 1 };
  });
  const failure = placements.length === 0 ? 'non_empty' : built.validator.failure;
  return {
    ...built,
    draft: { ...built.draft, placements },
    placementKeys,
    validator: {
      ...built.validator,
      events,
      failure,
      passed: failure === null,
      placementCount: placements.length,
    },
  };
}
