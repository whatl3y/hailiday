import {
  boxArea,
  type LocalizedAdditionRecord,
  type NormalizedBox,
  type Placement,
  type SceneAnalysis,
} from '@holiday/core';
import {
  buildCompositeMask,
  compositeProtection,
  dilationHang,
  maskCoverage,
  placementMaskParts,
  unionLocalizedMask,
  type CompositeMask,
} from '../imaging/mask.js';
import { protectedBoxes } from '../plan/index.js';
import { PIPELINE_DEFAULTS } from '../versions.js';

/** Preserve-region kinds whose pixels are never editable (text and marks). */
const TEXT_PRESERVE_KINDS: readonly string[] = ['house_number', 'sign', 'logo'];

/**
 * The composite mask of a render attempt (render spec, compositing algorithm): band shapes of
 * `along` placements dilated by the band dilation, every other shape by the box dilation; people,
 * blurred regions, the attribution rectangles, text marks, padding and window interiors excluded;
 * access regions and existing decorations kept out of the dilation band. A window carrying its
 * own garland keeps its top band to the band dilation's depth (the garland's hang).
 */
export function renderCompositeMask(input: {
  analysis: SceneAnalysis;
  placements: readonly Pick<Placement, 'anchorId' | 'placementRule' | 'region' | 'maskShapes'>[];
  width: number;
  height: number;
  padRegions: readonly NormalizedBox[];
  attributionRegions: readonly NormalizedBox[];
  dilationFraction: number;
  featherFraction: number;
  /** Defaults to `PIPELINE_DEFAULTS.bandDilationFraction`; never more than `dilationFraction`. */
  bandDilationFraction?: number;
}): CompositeMask {
  const { analysis, placements, width, height } = input;
  const bandDilationFraction = Math.min(
    input.dilationFraction,
    input.bandDilationFraction ?? PIPELINE_DEFAULTS.bandDilationFraction,
  );
  const protection = compositeProtection(
    analysis,
    placements,
    dilationHang(bandDilationFraction, width, height),
  );
  return buildCompositeMask({
    width,
    height,
    ...placementMaskParts(placements),
    dilationFraction: input.dilationFraction,
    bandDilationFraction,
    featherFraction: input.featherFraction,
    exclusions: [
      ...protectedBoxes(analysis, input.attributionRegions),
      ...analysis.preserveRegions
        .filter((region) => TEXT_PRESERVE_KINDS.includes(region.kind))
        .map((region) => region.box),
      ...input.padRegions,
      ...protection.exclusions,
    ],
    access: protection.keepOuts,
  });
}

/** What the vision model localized in an aligned output (boxes on the working grid). */
export interface LocalizedItems {
  added: readonly LocalizedAdditionRecord[];
}

export interface LocalizedKeepMask {
  mask: CompositeMask;
  /** Localized items the keep-mask keeps. */
  kept: LocalizedAdditionRecord[];
  /** Unplanned items the coverage cap dropped, largest first. */
  dropped: LocalizedAdditionRecord[];
  dilationPx: number;
  coverageBeforeCap: number;
  coverage: number;
}

/**
 * The privacy and legal exclusions of a keep-mask: people, blurred regions (including padding
 * added for the aspect), the attribution rectangles, house numbers, signs and logos, and padding.
 * Window interiors, doors and access regions are not among them: they protect the plan's shapes,
 * never a decoration the editor placed and the localizer found.
 */
export function privacyExclusions(input: {
  analysis: SceneAnalysis;
  attributionRegions: readonly NormalizedBox[];
  padRegions: readonly NormalizedBox[];
}): NormalizedBox[] {
  return [
    ...protectedBoxes(input.analysis, input.attributionRegions),
    ...input.analysis.preserveRegions
      .filter((region) => TEXT_PRESERVE_KINDS.includes(region.kind))
      .map((region) => region.box),
    ...input.padRegions,
  ];
}

/**
 * Localized compositing's keep-mask (render spec, compositing algorithm): the plan's composite
 * mask united with every localized box dilated by `localizedDilationFraction` of the long edge,
 * minus the privacy and legal exclusions. When the hard mask would cover more than `cap` of the
 * image, localized boxes that are not planned items are dropped, largest first, until it does not
 * (or none is left); planned items are never dropped.
 */
export function localizedKeepMask(input: {
  planMask: CompositeMask;
  items: readonly LocalizedAdditionRecord[];
  analysis: SceneAnalysis;
  attributionRegions: readonly NormalizedBox[];
  padRegions: readonly NormalizedBox[];
  dilationFraction?: number;
  cap?: number;
}): LocalizedKeepMask {
  const { planMask } = input;
  const long = Math.max(planMask.width, planMask.height);
  const dilationPx = Math.max(
    0,
    Math.round((input.dilationFraction ?? PIPELINE_DEFAULTS.localizedDilationFraction) * long),
  );
  const cap = input.cap ?? PIPELINE_DEFAULTS.localizedMaskCap;
  const exclusions = privacyExclusions(input);
  const build = (items: readonly LocalizedAdditionRecord[]) =>
    unionLocalizedMask(planMask, {
      boxes: items.map((item) => item.box),
      dilationPx,
      exclusions,
    });
  let kept = [...input.items];
  let mask = build(kept);
  const coverageBeforeCap = maskCoverage(mask.hard);
  let coverage = coverageBeforeCap;
  const dropped: LocalizedAdditionRecord[] = [];
  const droppable = kept
    .filter((item) => item.placementId === null)
    .sort((a, b) => boxArea(b.box) - boxArea(a.box));
  for (const item of droppable) {
    if (coverage <= cap) break;
    kept = kept.filter((other) => other !== item);
    dropped.push(item);
    mask = build(kept);
    coverage = maskCoverage(mask.hard);
  }
  return { mask, kept, dropped, dilationPx, coverageBeforeCap, coverage };
}
