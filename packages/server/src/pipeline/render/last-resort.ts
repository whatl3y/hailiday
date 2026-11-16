import {
  isCriticalFailureCode,
  type FailureCode,
  type JudgeResult,
  type MajorFailureCode,
  type NormalizedBox,
} from '@hailiday/core';
import type { CompositeMask } from '../imaging/mask.js';
import { checksumOf, toRect } from '../imaging/raster.js';
import { findingsFrom } from '../plan/index.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { restoreExclusions } from './mask.js';
import type { AttemptVerdict, QualityThresholds } from './quality.js';

/**
 * Codes about the picture as a whole: putting spots back from the original cannot answer them
 * (another home, a moved camera, unsafe content, an altered attribution).
 */
export const GLOBAL_FINDING_CODES: readonly FailureCode[] = [
  'wrong_property',
  'camera_changed',
  'unsafe_or_offensive',
  'attribution_altered',
];

/** The spots of a picture the judge objected to or doubted, with the codes they answer. */
export interface JudgedSpots {
  codes: FailureCode[];
  /** The judge's boxes, each once, in the order of the findings (not grown). */
  boxes: NormalizedBox[];
}

/** The shares of `PIPELINE_DEFAULTS.lastResort`. */
export interface LastResortSettings {
  minKeptShare: number;
  minPlacementShare: number;
  minKeptShareDoubt: number;
}

/** How much of the decorations is left once the spots are restored. */
export interface DecorationsLeft {
  /** Share of the decorations' area (their union) outside the grown restore boxes. */
  keptShare: number;
  /** The largest share of one planned placement's region outside the grown restore boxes. */
  placementShare: number;
}

/**
 * `render_attempts.composite_mask.restored`: the spots put back from the original before the
 * attempt went on. `objected`: a rejected attempt with no repair after it, delivered as a doubt;
 * `doubted`: a doubted attempt delivered as it stands. `codes` are the verdict's codes (the
 * doubted codes for `doubted`), `boxes` the judge's boxes (grown when composited) and `keptShare`
 * the share of the decorations' area left. `recordedMajors`, when present, are the confident
 * majors an `objected` restore recorded instead of putting back: those without a box, and those
 * with one when putting their boxes back too would have left too little of the decorations.
 */
export interface RestoredRecord {
  kind: 'objected' | 'doubted';
  codes: FailureCode[];
  boxes: NormalizedBox[];
  keptShare: number;
  recordedMajors?: MajorFailureCode[];
}

const sameBox = (a: NormalizedBox, b: NormalizedBox) => a.every((value, i) => value === b[i]);

function uniqueBoxes(boxes: readonly NormalizedBox[]): NormalizedBox[] {
  const out: NormalizedBox[] = [];
  for (const box of boxes) {
    if (!out.some((other) => sameBox(other, box))) out.push([...box] as NormalizedBox);
  }
  return out;
}

/** The spots behind a rejecting verdict, and the majors that are recorded instead of put back. */
export interface ObjectedSpots extends JudgedSpots {
  /**
   * Confident majors of the verdict without a box: recorded on the attempt, as on an attempt with
   * no repair after it, instead of put back.
   */
  recordedMajors: MajorFailureCode[];
  /** The boxes of the critical findings alone, each once (a subset of `boxes`). */
  criticalBoxes: NormalizedBox[];
  /** The codes of the confident majors whose boxes are in `boxes`. */
  boxedMajors: MajorFailureCode[];
}

/**
 * The spots behind a verdict that rejected an attempt, when putting them back may answer it: every
 * critical finding of the judge at or above the uncertainty floor, which must have a box, and each
 * major finding at or above the major threshold whose code the verdict counts and that has a box
 * (a confident major without one is returned in `recordedMajors` and does not block the restore).
 * Null when a critical finding has no box, when there is a deterministic code (it never has one),
 * when no box is left, or when a code of the verdict or of a critical finding (also a doubted one)
 * is a global code (`GLOBAL_FINDING_CODES`).
 */
export function objectedSpots(input: {
  judge: JudgeResult | null;
  deterministic: readonly FailureCode[];
  verdict: Pick<AttemptVerdict, 'codes'>;
  thresholds: QualityThresholds;
}): ObjectedSpots | null {
  if (input.deterministic.length > 0) return null;
  const { critical, uncertain, major } = input.thresholds;
  const findings = findingsFrom(input.judge, [], { critical, uncertain, major }).filter(
    (finding) => isCriticalFailureCode(finding.code) || input.verdict.codes.includes(finding.code),
  );
  const codes = new Set<FailureCode>([...input.verdict.codes, ...findings.map((f) => f.code)]);
  if ([...codes].some((code) => GLOBAL_FINDING_CODES.includes(code))) return null;
  const boxes: NormalizedBox[] = [];
  const criticalBoxes: NormalizedBox[] = [];
  const recordedMajors = new Set<MajorFailureCode>();
  const boxedMajors = new Set<MajorFailureCode>();
  for (const finding of findings) {
    const isCritical = isCriticalFailureCode(finding.code);
    if (finding.box) {
      boxes.push(finding.box);
      if (isCritical) criticalBoxes.push(finding.box);
      else boxedMajors.add(finding.code as MajorFailureCode);
    } else if (isCritical) {
      return null;
    } else {
      recordedMajors.add(finding.code as MajorFailureCode);
    }
  }
  if (boxes.length === 0) return null;
  return {
    codes: [...input.verdict.codes],
    boxes: uniqueBoxes(boxes),
    recordedMajors: [...recordedMajors],
    criticalBoxes: uniqueBoxes(criticalBoxes),
    boxedMajors: [...boxedMajors],
  };
}

/**
 * The objected spots a restore puts back without the boxes of the confident majors: the critical
 * findings' boxes alone, every confident major recorded (`recordedMajors`) instead of put back.
 * Null when there is no boxed major or no critical box.
 */
export function criticalSpotsOnly(spots: ObjectedSpots): ObjectedSpots | null {
  if (spots.boxedMajors.length === 0 || spots.criticalBoxes.length === 0) return null;
  return {
    codes: [...spots.codes],
    boxes: uniqueBoxes(spots.criticalBoxes),
    recordedMajors: [...new Set([...spots.recordedMajors, ...spots.boxedMajors])],
    criticalBoxes: uniqueBoxes(spots.criticalBoxes),
    boxedMajors: [],
  };
}

/**
 * The doubted spots of a judge result: its critical findings between the uncertainty floor and
 * the critical threshold that have a box and are not of a global code. Null when there is none.
 */
export function doubtedSpots(
  judge: JudgeResult | null,
  thresholds: Pick<QualityThresholds, 'critical' | 'uncertain'>,
): JudgedSpots | null {
  const doubts = (judge?.critical ?? []).filter(
    (finding) =>
      finding.confidence >= thresholds.uncertain &&
      finding.confidence < thresholds.critical &&
      !GLOBAL_FINDING_CODES.includes(finding.code) &&
      finding.box !== undefined,
  );
  if (doubts.length === 0) return null;
  return {
    codes: [...new Set(doubts.map((finding) => finding.code))],
    boxes: uniqueBoxes(doubts.map((finding) => finding.box as NormalizedBox)),
  };
}

/**
 * The judge's boxes as the areas a restore puts back on a `width` x `height` grid: each grown by
 * `PIPELINE_DEFAULTS.lastResort.growFraction` of the long edge on every side, clamped to the frame.
 */
export function restoredAreas(
  boxes: readonly NormalizedBox[],
  width: number,
  height: number,
): NormalizedBox[] {
  return restoreExclusions(boxes, width, height, PIPELINE_DEFAULTS.lastResort.growFraction);
}

/**
 * A composite mask with `boxes` restored from the original: each grown box (`restoredAreas`) is
 * cleared in the hard mask and the alpha, as the mask builders clear every exclusion after
 * feathering, so the paste-back keeps the original there byte for byte.
 */
export function withRestoredSpots(
  mask: CompositeMask,
  boxes: readonly NormalizedBox[],
): CompositeMask {
  const { width, height } = mask;
  const hard = Uint8Array.from(mask.hard);
  const alpha = Uint8Array.from(mask.alpha);
  for (const box of restoredAreas(boxes, width, height)) {
    const rect = toRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      hard.fill(0, y * width + rect.x0, y * width + rect.x1);
      alpha.fill(0, y * width + rect.x0, y * width + rect.x1);
    }
  }
  return { ...mask, hard, alpha, checksum: checksumOf(hard) };
}

/** A box's pixel rectangle on a grid, at least one pixel. */
function pixelRect(box: NormalizedBox, width: number, height: number) {
  const rect = toRect(box, width, height);
  const x0 = Math.min(rect.x0, width - 1);
  const y0 = Math.min(rect.y0, height - 1);
  return { x0, y0, x1: Math.max(rect.x1, x0 + 1), y1: Math.max(rect.y1, y0 + 1) };
}

/** The grown restore areas of `boxes` (`restoredAreas`) as a pixel mask on a grid. */
function restoredMask(boxes: readonly NormalizedBox[], width: number, height: number): Uint8Array {
  const restored = new Uint8Array(width * height);
  for (const box of restoredAreas(boxes, width, height)) {
    const rect = toRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      restored.fill(1, y * width + rect.x0, y * width + rect.x1);
    }
  }
  return restored;
}

/** The share of a region's pixels outside a restore mask. */
function shareOutside(
  region: NormalizedBox,
  restored: Uint8Array,
  width: number,
  height: number,
): number {
  const rect = pixelRect(region, width, height);
  let left = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) if (!restored[y * width + x]) left += 1;
  }
  return left / ((rect.x1 - rect.x0) * (rect.y1 - rect.y0));
}

/**
 * What restoring `boxes` (grown: `restoredAreas`) leaves of the decorations on a `width` x
 * `height` grid: the share of the union of `decorations` outside the grown boxes, and the largest
 * share of one planned placement region outside them. Both are 0 when there is nothing to measure.
 */
export function decorationsLeft(input: {
  width: number;
  height: number;
  decorations: readonly NormalizedBox[];
  placements: readonly NormalizedBox[];
  boxes: readonly NormalizedBox[];
}): DecorationsLeft {
  const { width, height } = input;
  if (width <= 0 || height <= 0) return { keptShare: 0, placementShare: 0 };
  const restored = restoredMask(input.boxes, width, height);
  const decorated = new Uint8Array(width * height);
  for (const box of input.decorations) {
    const rect = pixelRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1) {
      decorated.fill(1, y * width + rect.x0, y * width + rect.x1);
    }
  }
  let total = 0;
  let kept = 0;
  for (let i = 0; i < decorated.length; i += 1) {
    if (!decorated[i]) continue;
    total += 1;
    if (!restored[i]) kept += 1;
  }
  let placementShare = 0;
  for (const region of input.placements) {
    const share = shareOutside(region, restored, width, height);
    if (share > placementShare) placementShare = share;
  }
  return { keptShare: total === 0 ? 0 : kept / total, placementShare };
}

/**
 * The planned placements a restore of `boxes` takes out of the picture on a `width` x `height`
 * grid: the IDs of those keeping less than `lastResort.minPlacementShare` of their region outside
 * the grown boxes (`restoredAreas`).
 */
export function placementsPutBack(input: {
  width: number;
  height: number;
  placements: readonly { id: string; region: NormalizedBox }[];
  boxes: readonly NormalizedBox[];
  settings?: Pick<LastResortSettings, 'minPlacementShare'>;
}): string[] {
  const { width, height } = input;
  if (width <= 0 || height <= 0 || input.boxes.length === 0) return [];
  const minShare = (input.settings ?? PIPELINE_DEFAULTS.lastResort).minPlacementShare;
  const restored = restoredMask(input.boxes, width, height);
  return input.placements
    .filter((placement) => shareOutside(placement.region, restored, width, height) < minShare)
    .map((placement) => placement.id);
}

/**
 * Whether enough decorations are left to go on with the restored picture: for objected spots, at
 * least `lastResort.minKeptShare` of the decorations' area and one placement keeping at least
 * `lastResort.minPlacementShare` of its region; for doubted spots, at least
 * `lastResort.minKeptShareDoubt` of the decorations' area.
 */
export function enoughDecorationsLeft(
  left: DecorationsLeft,
  kind: RestoredRecord['kind'],
  settings: LastResortSettings = PIPELINE_DEFAULTS.lastResort,
): boolean {
  if (kind === 'doubted') return left.keptShare >= settings.minKeptShareDoubt;
  return (
    left.keptShare >= settings.minKeptShare && left.placementShare >= settings.minPlacementShare
  );
}

/** The boxes of the `restored` record on an attempt's `composite_mask` (none without one). */
export function restoredBoxesOf(compositeMask: unknown): NormalizedBox[] {
  const boxes = (compositeMask as { restored?: { boxes?: unknown } } | null)?.restored?.boxes;
  if (!Array.isArray(boxes)) return [];
  return boxes.filter(
    (box: unknown): box is NormalizedBox =>
      Array.isArray(box) &&
      box.length === 4 &&
      box.every((value) => typeof value === 'number' && Number.isFinite(value)),
  );
}
