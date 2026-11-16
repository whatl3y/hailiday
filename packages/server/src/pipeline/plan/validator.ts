import {
  boxArea,
  clampBox,
  expandBox,
  intersectBoxes,
  isAnchorEligible,
  regionOverlapFraction,
  SURFACE_ANCHOR_CATEGORIES,
  type Anchor,
  type AttachmentIntent,
  type ExistingDecorations,
  type AnchorCategory,
  type ForbiddenItem,
  type HolidayId,
  type NormalizedBox,
  type Placement,
  type PlacementRule,
  type SceneAnalysis,
  type SceneSection,
  type SceneType,
  type Style,
} from '@hailiday/core';
import { shrinkToAllowed } from './geometry.js';
import {
  FORBIDDEN_PATTERNS,
  GROUND_ANCHORS,
  HOLIDAY_GUESS_WORDS,
  SNOW_PATTERN,
} from './phrases.js';
import type { PlanKitItem, RepairAdjustments, ValidatorEvent } from './types.js';

/** Attachments that hang on a door or frame rather than standing in the way. */
const ATTACHED_TO_SURFACE: readonly AttachmentIntent[] = [
  'hung',
  'draped',
  'strung',
  'wrapped',
  'stretched',
];

/**
 * Largest occlusion a surface anchor may report for an `on_surface` placement. Chairs, legs and
 * objects in front of the furniture count toward its occlusion but leave the top surface usable.
 */
export const SURFACE_MAX_OCCLUSION = 0.6;

/** Preserve regions that carry text: nothing is placed over them. */
const TEXT_MARK_KINDS: readonly string[] = ['house_number', 'sign', 'logo'];

/** How far a placement stays from a text mark, as a fraction of the image on every side. */
export const TEXT_MARK_CLEARANCE = 0.01;

/**
 * The share of its region a placement must keep after it is shrunk clear of a text mark. A
 * decoration beside a house number keeps nearly all of it; one that wraps the thing the number
 * is on (a garland on that column) would lose more and is removed.
 */
export const TEXT_MARK_MIN_KEEP = 0.6;

/**
 * Whether an existing decoration constrains where new ones go. Indoors it does: nothing covers a
 * vase or a centerpiece. Outside a house a decoration may take the place of a removable one (a
 * door wreath, a planter, a hanging basket), so existing decorations do not move a placement.
 */
export function existingDecorationsConstrain(sceneType: SceneType): boolean {
  return sceneType !== 'house_exterior';
}

/** The anchor floors that apply to one anchor category under one placement rule. */
export function floorsFor(
  category: AnchorCategory,
  rule: PlacementRule | undefined,
  floors: { minConfidence: number; maxOcclusion: number },
): { minConfidence: number; maxOcclusion: number } {
  if (rule !== 'on_surface' || !SURFACE_ANCHOR_CATEGORIES.includes(category)) return floors;
  return { ...floors, maxOcclusion: Math.max(floors.maxOcclusion, SURFACE_MAX_OCCLUSION) };
}

/** Everything the per-placement rules read. */
export interface PlacementCheckContext {
  analysis: SceneAnalysis;
  sceneType: SceneType;
  holidayId: HolidayId;
  section: Pick<SceneSection, 'limits'>;
  floors: { minConfidence: number; maxOcclusion: number };
  lightsAllowed: boolean;
  /** The embedded attribution rectangle(s). */
  attributionRegion?: NormalizedBox | readonly NormalizedBox[] | null;
  adjustments?: RepairAdjustments | null;
}

/** The embedded attribution rectangles as a list (one rectangle, several, or none). */
export function attributionBoxes(
  value: NormalizedBox | readonly NormalizedBox[] | null | undefined,
): NormalizedBox[] {
  if (!value || value.length === 0) return [];
  return typeof value[0] === 'number'
    ? [value as NormalizedBox]
    : [...(value as readonly NormalizedBox[])];
}

/** A placement before validation: the plan record plus the fields the rules need. */
export interface CandidatePlacement extends Placement {
  key: string;
  attachment: AttachmentIntent;
  anchorConfidence: number;
}

/** Whether the pack's lighting policy allows electric decor for a holiday and scene type. */
export function lightsAllowedFor(holidayId: HolidayId, sceneType: SceneType): boolean {
  return !(holidayId === 'thanksgiving_us' && sceneType !== 'interior');
}

/** Protected regions (people, blurred regions and the attribution rectangles), never covered. */
export function protectedBoxes(
  analysis: SceneAnalysis,
  attributionRegion: NormalizedBox | readonly NormalizedBox[] | null | undefined,
  marginFraction = 0,
): NormalizedBox[] {
  const boxes = [
    ...analysis.peopleBoxes,
    ...analysis.protectedBlurRegions.map((region) => region.box),
    ...attributionBoxes(attributionRegion),
  ];
  if (marginFraction <= 0) return boxes;
  return boxes
    .map((box) => expandBox(box, marginFraction))
    .filter((box): box is NormalizedBox => box !== null);
}

/** Runs the per-placement validator rules; returns the (possibly changed) placement or null. */
export function checkPlacement(
  candidate: CandidatePlacement,
  ctx: PlacementCheckContext,
  events: ValidatorEvent[],
): CandidatePlacement | null {
  const remove = (rule: ValidatorEvent['rule'], detail?: string) => {
    events.push({
      rule,
      action: 'removed',
      placementKey: candidate.key,
      ...(detail ? { detail } : {}),
    });
    return null;
  };
  const { analysis, section } = ctx;
  const limits = section.limits;

  // Anchor exists and passes the confidence and occlusion floors.
  const anchor = analysis.anchors.find((item) => item.id === candidate.anchorId);
  if (
    !anchor ||
    !isAnchorEligible(anchor, floorsFor(anchor.category, candidate.placementRule, ctx.floors))
  ) {
    return remove('anchor_exists');
  }
  if (ctx.adjustments?.excludePairs.includes(candidate.key)) return remove('repair');

  let region: NormalizedBox = candidate.region;

  // Protected regions: zero tolerance.
  const protectedRegions = protectedBoxes(
    analysis,
    ctx.attributionRegion,
    ctx.adjustments?.protectedMarginFraction ?? 0,
  );
  if (protectedRegions.some((box) => intersectBoxes(region, box) !== null)) {
    return remove('protected_regions');
  }

  // On target: exteriors stay inside the target facade (plus the ground margin for ground
  // anchors) and away from its side edges; everything stays inside the image.
  if (ctx.sceneType === 'house_exterior') {
    const facade = analysis.targetFacade;
    if (!facade) return remove('on_target', 'no_target_facade');
    const edge = limits.edgeMarginFraction * (ctx.adjustments?.edgeMarginMultiplier ?? 1);
    const ground = GROUND_ANCHORS.includes(candidate.anchorCategory)
      ? limits.groundMarginFraction
      : 0;
    const allowed = clampBox([facade[0] + edge, facade[1], facade[2] - edge, facade[3] + ground]);
    const clipped = allowed ? intersectBoxes(region, allowed) : null;
    if (!clipped || boxArea(clipped) < boxArea(region) * 0.25) return remove('on_target');
    if (boxArea(clipped) < boxArea(region) - 1e-9) {
      events.push({ rule: 'on_target', action: 'clipped', placementKey: candidate.key });
    }
    region = clipped;
  } else {
    const clamped = clampBox(region);
    if (!clamped) return remove('on_target');
    region = clamped;
  }

  // Existing decorations are preserved where they constrain the scene: nothing covers them. The
  // region is shrunk clear of them (a table keeps its free part beside a vase), else the
  // placement is removed.
  const decorBoxes = existingDecorationsConstrain(ctx.sceneType)
    ? [
        ...analysis.existingDecorations.boxes,
        ...analysis.preserveRegions.filter((r) => r.kind === 'existing_decor').map((r) => r.box),
      ]
    : [];
  if (regionOverlapFraction(region, decorBoxes) > limits.overlapTolerance) {
    const clear = shrinkToAllowed(region, decorBoxes, limits.overlapTolerance);
    if (!clear) return remove('existing_decorations');
    events.push({ rule: 'existing_decorations', action: 'shrunk', placementKey: candidate.key });
    region = clear;
  }

  // House numbers, signs and logos: nothing covers them or touches their clearance. The region
  // is shrunk clear of them (cut on one side, or on both when a mark sits at each end) when it
  // keeps most of itself, else the placement is removed.
  const textMarks = analysis.preserveRegions
    .filter((r) => TEXT_MARK_KINDS.includes(r.kind))
    .map((r) => expandBox(r.box, TEXT_MARK_CLEARANCE))
    .filter((box): box is NormalizedBox => box !== null);
  if (textMarks.some((box) => intersectBoxes(region, box) !== null)) {
    const clear = shrinkToAllowed(region, textMarks, 0, TEXT_MARK_MIN_KEEP, 2);
    if (!clear) return remove('preserve_and_access', 'text_mark');
    events.push({
      rule: 'preserve_and_access',
      action: 'shrunk',
      placementKey: candidate.key,
      detail: 'text_mark',
    });
    region = clear;
  }

  // Other preserve regions and access regions: at most the tolerance; shrink, else remove.
  const surfaceAttached = ATTACHED_TO_SURFACE.includes(candidate.attachment);
  const blockers = [
    ...analysis.preserveRegions
      .filter((r) => r.kind !== 'existing_decor' && !TEXT_MARK_KINDS.includes(r.kind))
      .map((r) => r.box),
    ...analysis.accessRegions
      .filter((r) => !(surfaceAttached && r.kind === 'door'))
      .map((r) => r.box),
  ];
  const tolerance = Math.min(
    limits.overlapTolerance,
    ctx.adjustments?.accessTolerance ?? limits.overlapTolerance,
  );
  const allowedRegion = shrinkToAllowed(region, blockers, tolerance);
  if (!allowedRegion) return remove('preserve_and_access');
  if (allowedRegion !== region) {
    events.push({ rule: 'preserve_and_access', action: 'shrunk', placementKey: candidate.key });
    region = allowedRegion;
  }

  // Snow: never compiled unless the source shows snow.
  if (!analysis.seasonCues.snowVisible && SNOW_PATTERN.test(candidate.specText)) {
    return remove('snow');
  }

  // Lighting policy: electric items are lit only where the policy allows.
  let lit = candidate.lit;
  if (lit && !ctx.lightsAllowed) {
    lit = false;
    events.push({ rule: 'lighting_policy', action: 'unlit', placementKey: candidate.key });
  }

  return { ...candidate, region, lit };
}

/** Plan-level forbidden-list check over reviewed pack text that reaches the prompt. */
export function forbiddenViolations(
  forbidden: readonly ForbiddenItem[],
  texts: readonly string[],
): ForbiddenItem[] {
  const found = new Set<ForbiddenItem>();
  for (const item of forbidden) {
    const pattern = FORBIDDEN_PATTERNS[item];
    if (!pattern) continue;
    if (texts.some((text) => pattern.test(text))) found.add(item);
  }
  return [...found];
}

/** Whether existing decorations belong to a different holiday at medium or high density. */
export function existingDecorConflict(
  existing: ExistingDecorations,
  holidayId: HolidayId,
): boolean {
  if (!existing.present || !existing.holidayGuess) return false;
  if (existing.density !== 'medium' && existing.density !== 'high') return false;
  const guess = existing.holidayGuess.toLowerCase();
  const words = HOLIDAY_GUESS_WORDS[holidayId] ?? [holidayId];
  return !words.some((word) => guess.includes(word));
}

/** The style whose quantities apply: one step lower when existing decor density is high. */
export function effectiveStyleFor(style: Style, existing: ExistingDecorations): Style {
  if (existing.density !== 'high') return style;
  return style === 'abundant' ? 'classic' : 'subtle';
}

/**
 * Quantity and cap: each archetype's instances stay within its quantity rule and the plan's
 * placements within the section cap. Over the cap, placements are removed from the
 * lowest-priority archetype upward, lowest-confidence anchor first; an archetype required for the
 * style keeps one placement, which takes over its instances so its count stays at the minimum.
 */
export function applyQuantityRules(
  placements: CandidatePlacement[],
  kit: readonly PlanKitItem[],
  style: Style,
  cap: number,
  events: ValidatorEvent[],
  options: { countsToMinimum?: boolean } = {},
): CandidatePlacement[] {
  const byItem = new Map(kit.map((item) => [item.kitItemId, item]));
  let result = placements.map((placement) => ({ ...placement }));

  for (const item of kit) {
    const own = result.filter((placement) => placement.kitItemId === item.kitItemId);
    if (own.length === 0) continue;
    const [min, max] = item.quantity[style];
    const target = options.countsToMinimum ? Math.max(1, min) : max;
    let total = own.reduce((sum, placement) => sum + placement.count, 0);
    // Reduce from the lowest-confidence anchor until within the maximum.
    const order = [...own].sort((a, b) => a.anchorConfidence - b.anchorConfidence);
    for (const placement of order) {
      while (total > target && placement.count > 1) {
        placement.count -= 1;
        total -= 1;
        events.push({ rule: 'quantity', action: 'clamped', placementKey: placement.key });
      }
    }
    for (const placement of order) {
      if (total <= target) break;
      if (own.length > 1 && placement.count === 1) {
        result = result.filter((p) => p !== placement);
        own.splice(own.indexOf(placement), 1);
        total -= 1;
        events.push({ rule: 'quantity', action: 'removed', placementKey: placement.key });
      }
    }
  }

  while (result.length > cap) {
    const ranked = [...result].sort((a, b) => {
      const pa = byItem.get(a.kitItemId)?.priority ?? 99;
      const pb = byItem.get(b.kitItemId)?.priority ?? 99;
      return pb - pa || a.anchorConfidence - b.anchorConfidence;
    });
    let removed = false;
    for (const victim of ranked) {
      const item = byItem.get(victim.kitItemId);
      const siblings = result.filter((p) => p.kitItemId === victim.kitItemId);
      if (item?.required.includes(style) && siblings.length === 1) continue;
      result = result.filter((p) => p !== victim);
      if (item?.required.includes(style)) {
        const keeper = siblings.find((p) => p !== victim);
        if (keeper) {
          const [min] = item.quantity[style];
          keeper.count = Math.max(keeper.count, Math.min(min, keeper.count + victim.count));
        }
      }
      events.push({ rule: 'quantity', action: 'removed', placementKey: victim.key, detail: 'cap' });
      removed = true;
      break;
    }
    if (!removed) break;
  }
  return result;
}

/**
 * Eligible anchors of an archetype in descending confidence (ties by ID). Surface anchors under
 * `on_surface` use the surface occlusion floor.
 */
export function eligibleAnchorsFor(
  item: Pick<PlanKitItem, 'anchors'> & { placementRule?: PlacementRule },
  allowedCategories: ReadonlySet<string>,
  analysis: SceneAnalysis,
  floors: { minConfidence: number; maxOcclusion: number },
): Anchor[] {
  return analysis.anchors
    .filter(
      (anchor) =>
        item.anchors.includes(anchor.category) &&
        allowedCategories.has(anchor.category) &&
        isAnchorEligible(anchor, floorsFor(anchor.category, item.placementRule, floors)),
    )
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}
