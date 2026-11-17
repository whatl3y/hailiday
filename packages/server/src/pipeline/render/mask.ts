import {
  boxArea,
  type LocalizedAdditionRecord,
  type NormalizedBox,
  type Placement,
  type SceneAnalysis,
} from '@hailiday/core';
import {
  buildCompositeMask,
  compositeProtection,
  dilationHang,
  maskCoverage,
  placementMaskParts,
  unionLocalizedMask,
  wholeFrameMask,
  type CompositeMask,
} from '../imaging/mask.js';
import type { Raster } from '../imaging/raster.js';
import { ringChange, toneCurves, type ToneCurves } from '../imaging/surround.js';
import { protectedBoxes } from '../plan/index.js';
import { PIPELINE_DEFAULTS } from '../versions.js';

/** Preserve-region kinds whose pixels are never editable (text and marks). */
const TEXT_PRESERVE_KINDS: readonly string[] = ['house_number', 'sign', 'logo'];

/**
 * How a text mark is composited once the edited output is known: `grown` pastes back its grown
 * box, `exact` its analysis box only, `open` nothing (the editor's pixels stay and the judge
 * guards its text).
 */
export type TextMarkMode = 'grown' | 'exact' | 'open';

/** The compositing decision for one house number, sign or logo of the analysis. */
export interface TextMarkDecision {
  kind: 'house_number' | 'sign' | 'logo';
  /** The analysis box. */
  box: NormalizedBox;
  mode: TextMarkMode;
  /** Share of the ring between the analysis box and its grown box the editor changed. */
  changedShare: number;
  ringPixels: number;
  /** Whether a decoration box overlaps the mark's grown box. */
  decorated: boolean;
}

/** The compositing decision for one restore box of a repair attempt. */
export interface RestoreBoxDecision {
  /** The judge box as stored in the repair adjustments. */
  box: NormalizedBox;
  /** Whether the box (grown) is pasted back from the original. */
  applied: boolean;
  /** Share of the ring around its grown box the editor changed. */
  changedShare: number;
  ringPixels: number;
}

/** The decisions for every protected box whose surroundings decide its compositing. */
export interface ProtectedBoxDecisions {
  /** Where the tone curves the rings were measured with were sampled, and how many pixels. */
  tone: Pick<ToneCurves, 'sampled' | 'samples'>;
  /** One per house number, sign and logo, in the analysis's order. */
  textMarks: TextMarkDecision[];
  /** One per restore box, in the stored order. */
  restoreBoxes: RestoreBoxDecision[];
}

/** A text mark's decision as the mask builders read it. */
export type TextMarkModeOf = Pick<TextMarkDecision, 'box' | 'mode'>;

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

const sameBox = (a: NormalizedBox, b: NormalizedBox) => a.every((value, i) => value === b[i]);

function textMarksOf(analysis: Pick<SceneAnalysis, 'preserveRegions'>) {
  return analysis.preserveRegions.filter((region) => TEXT_PRESERVE_KINDS.includes(region.kind));
}

/** A normalized box grown by `px` working pixels on every side, clamped to the frame. */
function growBox(box: NormalizedBox, px: number, width: number, height: number): NormalizedBox {
  const dx = width > 0 ? px / width : 0;
  const dy = height > 0 ? px / height : 0;
  return [
    Math.max(0, box[0] - dx),
    Math.max(0, box[1] - dy),
    Math.min(1, box[2] + dx),
    Math.min(1, box[3] + dy),
  ];
}

/**
 * The analysis's house numbers, signs and logos as exclusions on a `width` x `height` grid: each
 * box grown on every side by the larger of `PIPELINE_DEFAULTS.textMarkMarginFraction` of the long
 * edge and `textMarkMarginShortSideShare` of the box's own short side, clamped to the frame, so
 * the whole mark is restored from the original even when the analysis box is narrower than it.
 * With the decisions of an edited output (`decideProtectedBoxes`), a mark whose surroundings the
 * editor changed is excluded by its analysis box only (`exact`) or not at all (`open`). Without
 * them (the mask sent to the editor) every mark is grown.
 */
export function textMarkExclusions(
  analysis: Pick<SceneAnalysis, 'preserveRegions'>,
  width: number,
  height: number,
  textMarks?: readonly TextMarkModeOf[],
): NormalizedBox[] {
  return textMarksOf(analysis).flatMap(({ box }, index) => {
    const mode = textMarkMode(textMarks, index, box);
    if (mode === 'open') return [];
    if (mode === 'exact') return [box];
    return [grownTextMark(box, width, height)];
  });
}

/** A text mark's box grown by its margin (`textMarkExclusions`). */
function grownTextMark(box: NormalizedBox, width: number, height: number): NormalizedBox {
  const long = Math.max(width, height);
  const shortSide = Math.min((box[2] - box[0]) * width, (box[3] - box[1]) * height);
  const margin = Math.max(
    PIPELINE_DEFAULTS.textMarkMarginFraction * long,
    PIPELINE_DEFAULTS.textMarkMarginShortSideShare * shortSide,
  );
  return growBox(box, margin, width, height);
}

/**
 * The mode of the `index`-th text mark: its decision when one is given for that mark (same
 * position, same box), otherwise `grown`.
 */
function textMarkMode(
  textMarks: readonly TextMarkModeOf[] | undefined,
  index: number,
  box: NormalizedBox,
): TextMarkMode {
  const decision = textMarks?.[index];
  return decision && sameBox(decision.box, box) ? decision.mode : 'grown';
}

/**
 * Restore boxes as exclusions on a `width` x `height` grid: each judge box grown by
 * `growFraction` of the long edge on every side (a repair attempt's:
 * `PIPELINE_DEFAULTS.restoreBoxGrowFraction`), clamped to the frame. Pixels inside them are pasted
 * back from the original whatever the editor drew.
 */
export function restoreExclusions(
  restoreBoxes: readonly NormalizedBox[],
  width: number,
  height: number,
  growFraction: number = PIPELINE_DEFAULTS.restoreBoxGrowFraction,
): NormalizedBox[] {
  const margin = growFraction * Math.max(width, height);
  return restoreBoxes.map((box) => growBox(box, margin, width, height));
}

/** The share of `inner`'s area that lies inside `outer` (0 when `inner` has no area). */
function coveredShareOf(inner: NormalizedBox, outer: NormalizedBox): number {
  const area = (inner[2] - inner[0]) * (inner[3] - inner[1]);
  if (!(area > 0)) return 0;
  const width = Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]);
  const height = Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]);
  return width > 0 && height > 0 ? (width * height) / area : 0;
}

/**
 * The decoration boxes of a plan, for an output whose localization fell back: the bounding box of
 * each placement's mask shape, or the placement's region when it has no shapes.
 */
export function placementDecorationBoxes(
  placements: readonly Pick<Placement, 'region' | 'maskShapes'>[],
): NormalizedBox[] {
  return placements.flatMap((placement) => {
    if (!placement.maskShapes?.length) return [placement.region];
    return placement.maskShapes.map((shape): NormalizedBox => {
      if (shape.kind === 'box') return shape.box;
      const xs = shape.points.map((point) => point[0]);
      const ys = shape.points.map((point) => point[1]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    });
  });
}

/**
 * How the protected boxes whose surroundings matter are composited, decided on the edited output
 * aligned to the working grid (render spec, compositing algorithm). The output's tone curves are
 * sampled outside the edited area (`edited`, one byte per pixel, non-zero where compositing keeps
 * the editor's pixels before any decision), padding, attribution and the boxes being judged (each
 * text mark's grown box and each restore box's grown box). Then, for each house number, sign and
 * logo, the share of the ring between its analysis box and its grown box that the output changed
 * (`ringChange`: through the curves, both images lightly blurred) gives `grown` under
 * `cleanShare`; `open` at or above `coveredShare` when a decoration box (`decorationBoxes`)
 * holds at least `decoratedShare` of the mark's own box (a decoration lies on it: pasting the
 * original back would cut a window into it); otherwise `exact` (the editor redrew the mark's
 * surroundings, a glow lit them, or a decoration stands beside it: the analysis box keeps the
 * original, so the text is never the editor's). Each restore box
 * of a repair is applied while the ring around its grown box (`restoreRingFraction` of the long
 * edge, at least `minRingPx`) changed less than `coveredShare`. People, blurred regions,
 * attribution and padding are not decided here: they stay excluded. Deterministic for the same
 * inputs.
 */
export function decideProtectedBoxes(input: {
  working: Raster;
  aligned: Raster;
  analysis: Pick<SceneAnalysis, 'preserveRegions'>;
  restoreBoxes?: readonly NormalizedBox[];
  padRegions: readonly NormalizedBox[];
  attributionRegions: readonly NormalizedBox[];
  /** The edited area before any decision (one byte per pixel, non-zero inside); null: unknown. */
  edited: Uint8Array | null;
  /** Boxes of the decorations in the output (localized items, or the plan's shapes). */
  decorationBoxes: readonly NormalizedBox[];
}): ProtectedBoxDecisions {
  const { working, aligned } = input;
  const { width, height } = working;
  const settings = PIPELINE_DEFAULTS.protectedSurround;
  const ignore = [...input.padRegions, ...input.attributionRegions];
  const marks = textMarksOf(input.analysis).map((region) => ({
    region,
    grown: grownTextMark(region.box, width, height),
  }));
  const restoreBoxes = input.restoreBoxes ?? [];
  const restoreInners = restoreExclusions(restoreBoxes, width, height);
  const tone = toneCurves(working, aligned, {
    ignore: [...ignore, ...marks.map((mark) => mark.grown), ...restoreInners],
    skip: input.edited,
  });
  const measure = (inner: NormalizedBox, outer: NormalizedBox) => {
    const ring = ringChange(working, aligned, inner, outer, { curves: tone.curves, ignore });
    return { changedShare: round4(ring.share), ringPixels: ring.pixels };
  };
  const textMarks = marks.map(({ region, grown }): TextMarkDecision => {
    const ring = measure(region.box, grown);
    const decorated = input.decorationBoxes.some(
      (box) => coveredShareOf(region.box, box) >= settings.decoratedShare,
    );
    const mode: TextMarkMode =
      ring.changedShare >= settings.coveredShare && decorated
        ? 'open'
        : ring.changedShare >= settings.cleanShare
          ? 'exact'
          : 'grown';
    return {
      kind: region.kind as TextMarkDecision['kind'],
      box: region.box,
      mode,
      ...ring,
      decorated,
    };
  });
  const ringPx = Math.max(
    settings.minRingPx,
    settings.restoreRingFraction * Math.max(width, height),
  );
  const restoreDecisions = restoreBoxes.map((box, index): RestoreBoxDecision => {
    const inner = restoreInners[index] as NormalizedBox;
    const ring = measure(inner, growBox(inner, ringPx, width, height));
    return { box, applied: ring.changedShare < settings.coveredShare, ...ring };
  });
  return {
    tone: { sampled: tone.sampled, samples: tone.samples },
    textMarks,
    restoreBoxes: restoreDecisions,
  };
}

/**
 * Whether any decision differs from compositing without decisions (every mark grown, every
 * restore box applied).
 */
export function decisionsChangeMask(decisions: ProtectedBoxDecisions): boolean {
  return (
    decisions.textMarks.some((mark) => mark.mode !== 'grown') ||
    decisions.restoreBoxes.some((box) => !box.applied)
  );
}

/** What compositing an edited output uses once its protected boxes are decided. */
export interface ProtectedCompositing {
  decisions: ProtectedBoxDecisions;
  /**
   * The mask to composite with. For a lavish attempt it is the whole-frame keep-mask
   * (`lavishKeepMask`); otherwise the plan mask rebuilt with the decisions when they change it, or
   * the plan mask itself. It is the whole mask when localization fell back.
   */
  mask: CompositeMask;
  /**
   * The keep-mask (the decided plan mask united with the localized boxes); null on a fallback.
   * For a lavish attempt: the whole-frame mask with every localized item kept and none dropped.
   */
  keep: LocalizedKeepMask | null;
  /** Restore boxes that apply (the mask builders exclude these). */
  restoreBoxes: NormalizedBox[];
  /** House numbers left `open`: the deterministic comparison skips them; the judge covers them. */
  openHouseNumbers: NormalizedBox[];
  /** Set for a lavish attempt: what its whole-frame keep-mask kept. */
  wholeFrame?: WholeFrameKeep;
}

/** `protectedCompositing` for a lavish attempt. */
function lavishCompositing(
  input: Parameters<typeof protectedCompositing>[0],
): ProtectedCompositing {
  const { planMask, items } = input;
  const decisions = decideProtectedBoxes({
    working: input.working,
    aligned: input.aligned,
    analysis: input.analysis,
    ...(input.restoreBoxes ? { restoreBoxes: input.restoreBoxes } : {}),
    padRegions: input.padRegions,
    attributionRegions: input.attributionRegions,
    // Tone is sampled outside the plan's own shapes.
    edited: planMask.hard,
    // Without decoration boxes no mark is left open: its text is always the original's.
    decorationBoxes: [],
  });
  const restoreBoxes = decisions.restoreBoxes.filter((box) => box.applied).map((box) => box.box);
  const mask = lavishKeepMask({
    width: planMask.width,
    height: planMask.height,
    analysis: input.analysis,
    padRegions: input.padRegions,
    restoreBoxes,
    textMarks: decisions.textMarks,
    featherPx: planMask.featherPx,
  });
  const coverage = maskCoverage(mask.hard);
  return {
    decisions,
    mask,
    keep: items
      ? {
          mask,
          kept: [...items],
          dropped: [],
          dilationPx: 0,
          coverageBeforeCap: coverage,
          coverage,
        }
      : null,
    restoreBoxes,
    openHouseNumbers: [],
    wholeFrame: { area: 'whole_frame', coverage: round4(coverage), featherPx: mask.featherPx },
  };
}

/** A house number a decoration lies on, decided `exact` instead of `open`; any other mark as is. */
function keptHouseNumber(mark: TextMarkDecision): TextMarkDecision {
  return mark.kind === 'house_number' && mark.mode === 'open' ? { ...mark, mode: 'exact' } : mark;
}

/**
 * Composites an edited output's protected boxes (render spec, compositing algorithm), once the
 * output is registered and its decorations are localized (`items`; null when localization fell
 * back). The edited area is the plan mask united with the localized boxes at their dilation (the
 * plan mask alone on a fallback); the decoration boxes are the localized items' boxes (on a
 * fallback, the plan's shapes, `placementDecorationBoxes`). With the decisions
 * (`decideProtectedBoxes`), `buildMask` rebuilds the plan mask from the plan with the applied
 * restore boxes and the text-mark decisions, called only when a decision changes the mask; the
 * keep-mask is then built from that mask. Shared by the render job and the example renderer so
 * both composite alike; the mask sent to the editor and used for registration is never changed.
 * With `keepHouseNumbers`, a house number is never left `open`: a decoration the editor laid on
 * it gets a window the size of the number's analysis box, so its digits are always the original's.
 * A lavish attempt (`lavish`) keeps the whole frame instead: the protected boxes are decided
 * without the localized boxes (a mark is `grown` or `exact`), and the keep-mask is
 * `lavishKeepMask`, the same with or without localized items.
 */
export function protectedCompositing(input: {
  working: Raster;
  aligned: Raster;
  analysis: SceneAnalysis;
  restoreBoxes?: readonly NormalizedBox[];
  padRegions: readonly NormalizedBox[];
  attributionRegions: readonly NormalizedBox[];
  /** The plan mask before any decision (every mark grown, every restore box applied). */
  planMask: CompositeMask;
  /** The localized items, or null when localization fell back. */
  items: readonly LocalizedAdditionRecord[] | null;
  placements: readonly Pick<Placement, 'region' | 'maskShapes'>[];
  buildMask: (options: {
    restoreBoxes: NormalizedBox[];
    textMarks: readonly TextMarkDecision[];
  }) => CompositeMask;
  /** Keep-mask settings (`localizedKeepMask`). */
  localizedDilationFraction?: number;
  cap?: number;
  /** Never leave a house number `open`: its analysis box always keeps the original. */
  keepHouseNumbers?: boolean;
  /**
   * The attempt is lavish: the keep-mask is the whole frame minus the restored boxes
   * (`lavishKeepMask`), whatever was localized; `buildMask`, the dilation and the cap are not
   * used, and a text mark is never left open.
   */
  lavish?: boolean;
}): ProtectedCompositing {
  if (input.lavish) return lavishCompositing(input);
  const { planMask, items } = input;
  const long = Math.max(planMask.width, planMask.height);
  const dilationFraction =
    input.localizedDilationFraction ?? PIPELINE_DEFAULTS.localizedDilationFraction;
  const edited = items
    ? unionLocalizedMask(planMask, {
        boxes: items.map((item) => item.box),
        dilationPx: Math.max(0, Math.round(dilationFraction * long)),
        exclusions: [],
      }).hard
    : planMask.hard;
  const decided = decideProtectedBoxes({
    working: input.working,
    aligned: input.aligned,
    analysis: input.analysis,
    ...(input.restoreBoxes ? { restoreBoxes: input.restoreBoxes } : {}),
    padRegions: input.padRegions,
    attributionRegions: input.attributionRegions,
    edited,
    decorationBoxes: items
      ? items.map((item) => item.box)
      : placementDecorationBoxes(input.placements),
  });
  const decisions: ProtectedBoxDecisions = input.keepHouseNumbers
    ? { ...decided, textMarks: decided.textMarks.map(keptHouseNumber) }
    : decided;
  const restoreBoxes = decisions.restoreBoxes.filter((box) => box.applied).map((box) => box.box);
  const mask = decisionsChangeMask(decisions)
    ? input.buildMask({ restoreBoxes, textMarks: decisions.textMarks })
    : planMask;
  const keep = items
    ? localizedKeepMask({
        planMask: mask,
        items,
        analysis: input.analysis,
        attributionRegions: input.attributionRegions,
        padRegions: input.padRegions,
        restoreBoxes,
        textMarks: decisions.textMarks,
        dilationFraction,
        ...(input.cap !== undefined ? { cap: input.cap } : {}),
      })
    : null;
  return {
    decisions,
    mask,
    keep,
    restoreBoxes,
    openHouseNumbers: decisions.textMarks
      .filter((mark) => mark.kind === 'house_number' && mark.mode === 'open')
      .map((mark) => mark.box),
  };
}

/**
 * The composite mask of a render attempt (render spec, compositing algorithm): band shapes of
 * `along` placements dilated by the band dilation, every other shape by the box dilation; people,
 * blurred regions, the attribution rectangles, text marks (with their margin, or as decided on the
 * edited output), the restore boxes of a repair, padding and window interiors excluded; access
 * regions and existing decorations kept out of the dilation band. A window carrying its own
 * garland keeps its top band to the band dilation's depth (the garland's hang).
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
  /** Judge boxes a repair attempt restores from the original (`RepairAdjustments.restoreBoxes`). */
  restoreBoxes?: readonly NormalizedBox[];
  /** Text-mark decisions of an edited output; without them every mark is grown. */
  textMarks?: readonly TextMarkModeOf[];
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
      ...textMarkExclusions(analysis, width, height, input.textMarks),
      ...restoreExclusions(input.restoreBoxes ?? [], width, height),
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
 * The privacy and legal exclusions of a keep-mask on a `width` x `height` grid: people, blurred
 * regions (including padding added for the aspect), the attribution rectangles, house numbers,
 * signs and logos (with their margin, or as decided on the edited output), the restore boxes of a
 * repair, and padding. Window interiors, doors and access regions are not among them: they
 * protect the plan's shapes, never a decoration the editor placed and the localizer found.
 */
export function privacyExclusions(input: {
  analysis: SceneAnalysis;
  attributionRegions: readonly NormalizedBox[];
  padRegions: readonly NormalizedBox[];
  width: number;
  height: number;
  restoreBoxes?: readonly NormalizedBox[];
  /** Text-mark decisions of an edited output; without them every mark is grown. */
  textMarks?: readonly TextMarkModeOf[];
}): NormalizedBox[] {
  return [
    ...protectedBoxes(input.analysis, input.attributionRegions),
    ...textMarkExclusions(input.analysis, input.width, input.height, input.textMarks),
    ...restoreExclusions(input.restoreBoxes ?? [], input.width, input.height),
    ...input.padRegions,
  ];
}

/** What a lavish attempt keeps (`render_attempts.composite_mask.keep`). */
export interface WholeFrameKeep {
  area: 'whole_frame';
  /** Share of the image the hard keep-mask covers. */
  coverage: number;
  /** Width of the fade around people and blurred regions, in working pixels. */
  featherPx: number;
}

/**
 * The keep-mask of a lavish attempt (render spec, compositing algorithm): the whole frame minus
 * the privacy exclusions (`privacyExclusions`: people, blurred regions, text marks as decided on
 * the edited output, the applied restore boxes of a repair, padding). People and blurred regions
 * that are not padding fade into the kept picture across `featherPx` outside their boxes; text
 * marks, restore boxes and padding have hard edges. The attribution rectangles are kept: the
 * compositing restores them after the paste with the original's strokes over the kept picture's
 * own ground (`restoreProtectedRectangles` with `relitAttribution`), or verbatim where the strokes
 * are not found. It does not depend on what the localizer found and has no coverage cap.
 */
export function lavishKeepMask(input: {
  width: number;
  height: number;
  analysis: SceneAnalysis;
  padRegions: readonly NormalizedBox[];
  /** The restore boxes of a repair that apply. */
  restoreBoxes?: readonly NormalizedBox[];
  /** Text-mark decisions of the edited output; without them every mark is grown. */
  textMarks?: readonly TextMarkModeOf[];
  featherPx: number;
}): CompositeMask {
  const { analysis, width, height } = input;
  const blurred = analysis.protectedBlurRegions
    .map((region) => region.box)
    .filter((box) => !input.padRegions.some((pad) => sameBox(pad, box)));
  return wholeFrameMask({
    width,
    height,
    exclusions: privacyExclusions({
      analysis,
      attributionRegions: [],
      padRegions: input.padRegions,
      width,
      height,
      ...(input.restoreBoxes ? { restoreBoxes: input.restoreBoxes } : {}),
      ...(input.textMarks ? { textMarks: input.textMarks } : {}),
    }),
    soft: [...analysis.peopleBoxes, ...blurred],
    featherPx: input.featherPx,
  });
}

/**
 * Localized compositing's keep-mask (render spec, compositing algorithm): the plan's composite
 * mask united with every localized box dilated by `localizedDilationFraction` of the long edge,
 * minus the privacy and legal exclusions (and the restore boxes of a repair). When the hard mask
 * would cover more than `cap` of the image, localized boxes that are not planned items are
 * dropped, largest first, until it does not (or none is left); planned items are never dropped.
 */
export function localizedKeepMask(input: {
  planMask: CompositeMask;
  items: readonly LocalizedAdditionRecord[];
  analysis: SceneAnalysis;
  attributionRegions: readonly NormalizedBox[];
  padRegions: readonly NormalizedBox[];
  /** Judge boxes a repair attempt restores from the original (`RepairAdjustments.restoreBoxes`). */
  restoreBoxes?: readonly NormalizedBox[];
  /** Text-mark decisions of the edited output; without them every mark is grown. */
  textMarks?: readonly TextMarkModeOf[];
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
  const exclusions = privacyExclusions({
    analysis: input.analysis,
    attributionRegions: input.attributionRegions,
    padRegions: input.padRegions,
    width: planMask.width,
    height: planMask.height,
    ...(input.restoreBoxes ? { restoreBoxes: input.restoreBoxes } : {}),
    ...(input.textMarks ? { textMarks: input.textMarks } : {}),
  });
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
