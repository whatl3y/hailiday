import {
  CRITICAL_FAILURE_CODES,
  JUDGE_RESULT_SCHEMA_VERSION,
  type CriticalFailureCode,
  type DecorationPlan,
  type FailureCode,
  type JudgeDecision,
  type JudgeResult,
  type LocalizedAdditionRecord,
  type MajorFailureCode,
  type NormalizedBox,
  type SceneAnalysis,
} from '@holiday/core';
import { positionWords } from '../plan/phrases.js';
import type {
  FixtureHint,
  ImageInput,
  LocalizeAdditionsResult,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import {
  alignAndComposite,
  registerDelivered,
  type PhotometricRecord,
} from '../imaging/composite.js';
import { runDeterministicChecks, type DeterministicCheckResult } from '../imaging/checks.js';
import type { CompositeMask } from '../imaging/mask.js';
import { decodeRaster, encodeJpeg, toRect, type Raster } from '../imaging/raster.js';
import {
  registrationExclusion,
  type AlignmentRecord,
  type AlignmentResult,
} from '../imaging/registration.js';
import type { WorkingImage } from '../imaging/working.js';
import { PIPELINE_DEFAULTS } from '../versions.js';

/** Judge decision thresholds (critical, uncertainty floor, major). */
export interface QualityThresholds {
  critical: number;
  uncertain: number;
  major: number;
}

const isCritical = (code: FailureCode): code is CriticalFailureCode =>
  (CRITICAL_FAILURE_CODES as readonly string[]).includes(code);

/** A judge result's codes classified by the decision thresholds. */
export interface JudgeClassification {
  critical: CriticalFailureCode[];
  uncertain: CriticalFailureCode[];
  major: MajorFailureCode[];
}

export function classifyJudge(judge: JudgeResult, t: QualityThresholds): JudgeClassification {
  const critical = new Set<CriticalFailureCode>();
  const uncertain = new Set<CriticalFailureCode>();
  const major = new Set<MajorFailureCode>();
  for (const finding of judge.critical) {
    if (finding.confidence >= t.critical) critical.add(finding.code);
    else if (finding.confidence >= t.uncertain) uncertain.add(finding.code);
  }
  for (const finding of judge.major) if (finding.confidence >= t.major) major.add(finding.code);
  return { critical: [...critical], uncertain: [...uncertain], major: [...major] };
}

/**
 * The classification of deterministic codes recorded in the judge's place: critical codes as
 * critical, the rest as major, so the row's decision and codes match the attempt's rejection.
 */
export function deterministicClassification(codes: readonly FailureCode[]): JudgeClassification {
  return {
    critical: [...new Set(codes.filter(isCritical))],
    uncertain: [],
    major: [...new Set(codes.filter((code): code is MajorFailureCode => !isCritical(code)))],
  };
}

/** The decision recorded on one judge result row. */
export function judgeDecision(classification: JudgeClassification): JudgeDecision {
  if (classification.critical.length > 0 || classification.major.length > 0) return 'reject';
  if (classification.uncertain.length > 0) return 'uncertain';
  return 'pass';
}

/** The attempt verdict after deterministic checks, the judge and any escalation. */
export interface AttemptVerdict {
  verdict: 'pass' | 'fail' | 'uncertain';
  /** Codes that failed the attempt (critical and major), or the uncertain critical codes. */
  codes: FailureCode[];
  /** Majors recorded on a passing second attempt. */
  recordedMajors: MajorFailureCode[];
}

/**
 * Decision policy (render spec, quality checks): a deterministic or confident critical code
 * fails; an uncertain critical code (after escalation) is uncertain; confident majors fail the
 * first attempt and are only recorded on the second; otherwise the attempt passes.
 */
export function decideAttempt(input: {
  attemptNumber: 1 | 2;
  deterministic: readonly FailureCode[];
  judge: JudgeClassification | null;
}): AttemptVerdict {
  const deterministicCritical = input.deterministic.filter(isCritical);
  const deterministicMajor = input.deterministic.filter(
    (code): code is MajorFailureCode => !isCritical(code),
  );
  const judge = input.judge ?? { critical: [], uncertain: [], major: [] };
  const critical = [...new Set([...deterministicCritical, ...judge.critical])];
  const majors = [...new Set([...deterministicMajor, ...judge.major])];
  if (critical.length > 0)
    return { verdict: 'fail', codes: [...critical, ...majors], recordedMajors: [] };
  if (judge.uncertain.length > 0) {
    return { verdict: 'uncertain', codes: [...judge.uncertain, ...majors], recordedMajors: [] };
  }
  if (majors.length > 0) {
    return input.attemptNumber === 1
      ? { verdict: 'fail', codes: majors, recordedMajors: [] }
      : { verdict: 'pass', codes: [], recordedMajors: majors };
  }
  return { verdict: 'pass', codes: [], recordedMajors: [] };
}

export interface CompositeResult {
  raw: Raster;
  candidate: Raster;
  fidelityMode: DecorationPlan['fidelityMode'];
  attributionRestored: boolean;
  exposureMatched: boolean;
  /** Photometric alignment before paste-back (`source` mode; stored with the checks). */
  photometric: PhotometricRecord | null;
  /** Registration before compositing (recorded on the attempt). */
  alignment: AlignmentRecord;
  deterministic: DeterministicCheckResult;
}

/** The decoded output registered to the reference image (before compositing). */
export interface RegisteredOutput {
  /** The decoded provider output, as delivered. */
  delivered: Raster;
  /** The registration; `aligned` is the output on the reference grid, null when rejected. */
  registered: AlignmentResult;
}

/**
 * Registration at the start of `checking` (render spec, registration): the provider output is
 * decoded and registered to the reference image (the working image, or for an evening relight the
 * accepted daylight variant on the working grid) over pixels outside the placement shapes (the
 * composite mask in `source`; the dilated shapes and glowing windows otherwise), and warped into
 * alignment when the transform is within the limits.
 */
export async function registerOutput(input: {
  working: WorkingImage;
  /** The image the output must match; defaults to the working image. */
  reference?: Raster;
  rawBytes: Uint8Array;
  plan: Pick<DecorationPlan, 'lightingMode' | 'placements' | 'compositeMask'>;
  mask: CompositeMask | null;
  glowRegions: readonly NormalizedBox[];
  /** More regions registration ignores (localized decorations of a relight's base). */
  extraExclusions?: readonly NormalizedBox[];
  thresholds?: Partial<Record<string, number>>;
}): Promise<RegisteredOutput> {
  const delivered = await decodeRaster(input.rawBytes);
  const reference = input.reference ?? input.working.raster;
  const long = Math.max(reference.width, reference.height);
  const mask = input.plan.lightingMode === 'source' ? input.mask : null;
  const registered = await registerDelivered({
    working: reference,
    delivered,
    lightingMode: input.plan.lightingMode,
    exclude: registrationExclusion({
      width: reference.width,
      height: reference.height,
      mask,
      placements: input.plan.placements,
      dilationFraction:
        input.plan.compositeMask?.dilationFraction ?? PIPELINE_DEFAULTS.dilationFraction,
      extra: mask ? [] : [...input.glowRegions, ...(input.extraExclusions ?? [])],
    }),
    fallbackPx:
      (input.thresholds?.maxTranslationFraction ??
        PIPELINE_DEFAULTS.checks.maxTranslationFraction) * long,
  });
  return { delivered, registered };
}

/**
 * Compositing after registration, then the deterministic checks (render spec, compositing
 * algorithm and quality checks). In `source` mode the output's color and brightness are matched
 * to the working image over the unedited ring around the keep-mask (photometric alignment, kept
 * only when it lowers the seam) and the original pixels are pasted back outside the feathered
 * mask; in `evening` mode (a relight) the aligned output is the candidate and every check runs
 * against the reference (the accepted daylight variant). In both modes the attribution
 * rectangles and any padding are restored verbatim from the reference.
 */
export async function compositeAndCheck(input: {
  working: WorkingImage;
  /** The image the candidate must match; defaults to the working image. */
  reference?: Raster;
  rawBytes: Uint8Array;
  /** A registration already done (`registerOutput`); otherwise it is done here. */
  registration?: RegisteredOutput;
  requested: { width: number; height: number };
  plan: Pick<
    DecorationPlan,
    'lightingMode' | 'fidelityMode' | 'placements' | 'preserve' | 'compositeMask'
  >;
  analysis: SceneAnalysis;
  mask: CompositeMask | null;
  /**
   * Regions of decorations kept beyond the plan's (localized items, or a relight base's): left
   * out of the edge check like placement regions.
   */
  keptRegions?: readonly NormalizedBox[];
  /** The embedded attribution rectangle(s), restored verbatim and compared after restoration. */
  attributionRegion: NormalizedBox | readonly NormalizedBox[] | null;
  glowRegions: readonly NormalizedBox[];
  thresholds?: Partial<Record<string, number>>;
}): Promise<CompositeResult> {
  const reference = input.reference ?? input.working.raster;
  const mask = input.plan.lightingMode === 'source' ? input.mask : null;
  const registration =
    input.registration ??
    (await registerOutput({
      working: input.working,
      reference,
      rawBytes: input.rawBytes,
      plan: input.plan,
      mask,
      glowRegions: input.glowRegions,
      ...(input.keptRegions ? { extraExclusions: input.keptRegions } : {}),
      ...(input.thresholds ? { thresholds: input.thresholds } : {}),
    }));
  const long = Math.max(reference.width, reference.height);
  const composite = await alignAndComposite({
    working: reference,
    delivered: registration.delivered,
    lightingMode: input.plan.lightingMode,
    mask,
    exclude: null,
    registered: registration.registered,
    attributionRegion: input.attributionRegion,
    padRegions: input.working.padRegions,
    seamDeltaE: input.thresholds?.seamDeltaE ?? PIPELINE_DEFAULTS.checks.seamDeltaE,
    fallbackPx:
      (input.thresholds?.maxTranslationFraction ??
        PIPELINE_DEFAULTS.checks.maxTranslationFraction) * long,
  });
  const { raw, candidate, exposureMatched, attributionRestored } = composite;
  const deterministic = runDeterministicChecks({
    working: reference,
    raw,
    candidate,
    requested: input.requested,
    lightingMode: input.plan.lightingMode,
    placementRegions: [
      ...input.plan.placements.map((placement) => placement.region),
      ...(input.keptRegions ?? []),
    ],
    targetFacade: input.analysis.targetFacade ?? null,
    peopleBoxes: input.analysis.peopleBoxes,
    blurRegions: input.analysis.protectedBlurRegions.map((region) => region.box),
    houseNumberRegions: input.analysis.preserveRegions
      .filter((region) => region.kind === 'house_number')
      .map((region) => region.box),
    glowRegions: input.glowRegions,
    attributionRegion: input.attributionRegion,
    mask,
    alignment: composite.alignment,
    ...(input.thresholds ? { thresholds: input.thresholds } : {}),
  });
  deterministic.checks.compositing = {
    exposureMatched,
    attributionRestored,
    registrationApplied: composite.alignment.applied,
    photometric: composite.photometric,
  };
  return {
    raw,
    candidate,
    fidelityMode: input.plan.fidelityMode,
    attributionRestored,
    exposureMatched,
    photometric: composite.photometric,
    alignment: composite.alignment,
    deterministic,
  };
}

/** A judge result standing in for the judge when deterministic checks already failed. */
export function deterministicJudgeResult(
  attemptId: string,
  codes: readonly FailureCode[],
): JudgeResult {
  return {
    schemaVersion: JUDGE_RESULT_SCHEMA_VERSION,
    renderAttemptId: attemptId,
    judgeModel: 'deterministic-checks',
    judgePromptVersion: 'checks-1',
    escalated: false,
    critical: codes.filter(isCritical).map((code) => ({
      code,
      confidence: 1,
      evidence: 'Deterministic check failed.',
    })),
    major: codes
      .filter((code): code is MajorFailureCode => !isCritical(code))
      .map((code) => ({ code, confidence: 1, evidence: 'Deterministic check failed.' })),
    placements: [],
    scores: { realism: 1, appeal: 1, planAdherence: 1 },
    overallConfidence: 1,
    elapsedMs: 0,
  };
}

/** Runs one judge call on the candidate. */
export async function callJudge(input: {
  vision: VisionModel;
  attemptId: string;
  working: WorkingImage;
  candidate: Raster;
  plan: DecorationPlan;
  hints: string[];
  escalated: boolean;
  fixture: FixtureHint;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * `relight`: the candidate must equal `base` (the decorated daylight image) except for the light.
   * Defaults to `decorate`.
   */
  mode?: 'decorate' | 'relight';
  base?: ImageInput;
}): Promise<VisionCallResult<JudgeResult>> {
  const candidateBytes = await encodeJpeg(input.candidate, { quality: 92 });
  return input.vision.judge(
    {
      renderAttemptId: input.attemptId,
      original: {
        bytes: input.working.png,
        width: input.working.width,
        height: input.working.height,
      },
      candidate: {
        bytes: candidateBytes,
        width: input.candidate.width,
        height: input.candidate.height,
      },
      plan: input.plan,
      hints: input.hints,
      escalated: input.escalated,
      fixture: input.fixture,
      ...(input.mode === 'relight' ? { mode: 'relight' as const } : {}),
      ...(input.mode === 'relight' && input.base ? { base: input.base } : {}),
    },
    { signal: input.signal, timeoutMs: input.timeoutMs },
  );
}

/**
 * Asks the vision model which decorations the editor added (render spec, localized compositing):
 * the working image first, the output aligned to the working grid second, the plan's placements
 * as hints so a planned item carries its placement ID.
 */
export async function callLocalizer(input: {
  vision: VisionModel;
  attemptId: string;
  working: WorkingImage;
  aligned: Raster;
  placements: readonly Pick<
    DecorationPlan['placements'][number],
    'id' | 'kitItemId' | 'region' | 'specText'
  >[];
  fixture?: FixtureHint;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<VisionCallResult<LocalizeAdditionsResult>> {
  const candidateBytes = await encodeJpeg(input.aligned, { quality: 92 });
  return input.vision.localizeAdditions(
    {
      renderAttemptId: input.attemptId,
      original: {
        bytes: input.working.png,
        width: input.working.width,
        height: input.working.height,
      },
      candidate: {
        bytes: candidateBytes,
        width: input.aligned.width,
        height: input.aligned.height,
      },
      placements: input.placements.map((placement) => ({
        id: placement.id,
        kitItemId: placement.kitItemId,
        region: placement.region,
        specText: placement.specText,
      })),
      ...(input.fixture ? { fixture: input.fixture } : {}),
    },
    { signal: input.signal, timeoutMs: input.timeoutMs },
  );
}

/** A box clamped to the unit square, or null when nothing of positive area is left. */
function clampBox(box: readonly number[]): NormalizedBox | null {
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value))) return null;
  const [a, b, c, d] = box.map((value) => Math.min(1, Math.max(0, value))) as NormalizedBox;
  const x0 = Math.min(a, c);
  const x1 = Math.max(a, c);
  const y0 = Math.min(b, d);
  const y1 = Math.max(b, d);
  return x1 - x0 > 1e-4 && y1 - y0 > 1e-4 ? [x0, y0, x1, y1] : null;
}

/**
 * The localizer's answer as recorded on the attempt: boxes clamped to the image (degenerate ones
 * dropped), placement IDs kept only when they name a planned placement, text capped.
 */
export function localizationRecords(
  result: LocalizeAdditionsResult,
  placementIds: readonly string[],
): {
  items: LocalizedAdditionRecord[];
  otherChanges: { description: string; box: NormalizedBox }[];
} {
  const planned = new Set(placementIds);
  const items: LocalizedAdditionRecord[] = [];
  for (const added of result.added) {
    const box = clampBox(added.box);
    if (!box) continue;
    items.push({
      label: String(added.label ?? '').slice(0, 200),
      box,
      placementId: added.placementId && planned.has(added.placementId) ? added.placementId : null,
    });
  }
  const otherChanges: { description: string; box: NormalizedBox }[] = [];
  for (const change of result.otherChanges) {
    const box = clampBox(change.box);
    if (!box) continue;
    otherChanges.push({ description: String(change.description ?? '').slice(0, 300), box });
  }
  return { items, otherChanges };
}

/** Share of a box's pixels (on the mask grid) that a hard mask keeps; at least one pixel. */
export function keptShare(
  mask: Pick<CompositeMask, 'hard' | 'width' | 'height'>,
  box: NormalizedBox,
): number {
  const { width, height, hard } = mask;
  if (width === 0 || height === 0) return 0;
  const rect = toRect(box, width, height);
  const x0 = Math.min(rect.x0, width - 1);
  const y0 = Math.min(rect.y0, height - 1);
  const x1 = Math.max(rect.x1, x0 + 1);
  const y1 = Math.max(rect.y1, y0 + 1);
  let kept = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) if (hard[y * width + x]) kept += 1;
  }
  return kept / ((x1 - x0) * (y1 - y0));
}

/**
 * Judge hints for the localizer's other changes. The paste-back restores everything outside the
 * hard keep-mask from the original photograph, so a change whose box lies mostly outside it
 * (less than `restoredHintMaxKeptShare` kept) is named as already put back. A change whose box
 * lies mostly inside the keep-mask was kept with the decorations around it, so it is named as an
 * unrequested change inside the kept decorations for the judge to inspect.
 */
export function restoredChangeHints(
  otherChanges: readonly { description: string; box: NormalizedBox }[],
  keepMask: Pick<CompositeMask, 'hard' | 'width' | 'height'>,
  maxKeptShare: number = PIPELINE_DEFAULTS.restoredHintMaxKeptShare,
): string[] {
  return otherChanges.map((change) => {
    const description = change.description.replace(/[.;\s]+$/, '');
    const where = positionWords(change.box);
    return keptShare(keepMask, change.box) < maxKeptShare
      ? `restored from the original: ${description} (${where})`
      : `unrequested change inside the kept decorations: ${description} (${where})`;
  });
}
