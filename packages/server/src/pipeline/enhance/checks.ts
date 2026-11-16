import type { FailureCode, NormalizedBox, SceneAnalysis } from '@hailiday/core';
import { meanSsim, runDeterministicChecks } from '../imaging/checks.js';
import { registerDelivered, restoreProtectedRectangles } from '../imaging/composite.js';
import {
  protectedCoverage,
  restoreProtectedPixels,
  tileStructureAgreement,
} from '../imaging/enhancement.js';
import { decodeRaster, toGray, toRect, type Raster } from '../imaging/raster.js';
import type { AlignmentRecord } from '../imaging/registration.js';
import type { WorkingImage } from '../imaging/working.js';
import { textMarkExclusions } from '../render/mask.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import type { EnhanceJudgeInput } from '../../providers/types.js';

/** Preserve-region kinds whose pixels an enhancement must not redraw (text and marks). */
const TEXT_MARK_KINDS: readonly string[] = ['house_number', 'sign', 'logo'];

/** Text-mark kinds that are left to the attribution restore inside an attribution rectangle. */
const ATTRIBUTION_GOVERNED_KINDS: readonly string[] = ['logo', 'sign'];

/** Whether more than half of the area of `region` lies inside `container`. */
function mostlyInside(region: NormalizedBox, container: NormalizedBox): boolean {
  const area = (region[2] - region[0]) * (region[3] - region[1]);
  if (!(area > 0)) return false;
  const width = Math.min(region[2], container[2]) - Math.max(region[0], container[0]);
  const height = Math.min(region[3], container[3]) - Math.max(region[1], container[1]);
  return width > 0 && height > 0 && width * height > area / 2;
}

/** The analysis's preserve regions an enhancement keeps by their own entry (text marks). */
function enhanceTextMarks(
  analysis: Pick<SceneAnalysis, 'preserveRegions'>,
  attributionRegions: readonly NormalizedBox[],
): SceneAnalysis['preserveRegions'] {
  return analysis.preserveRegions.filter(
    (region) =>
      TEXT_MARK_KINDS.includes(region.kind) &&
      !(
        ATTRIBUTION_GOVERNED_KINDS.includes(region.kind) &&
        attributionRegions.some((box) => mostlyInside(region.box, box))
      ),
  );
}

/** The protected boxes of an enhancement on a `width` x `height` grid. */
export interface EnhanceProtectedBoxes {
  /** The analysis's people boxes. */
  people: NormalizedBox[];
  /** The boxes of the analysis's protected blur regions. */
  blur: NormalizedBox[];
  /**
   * The analysis boxes of house numbers, signs and logos, without a logo or sign lying mostly
   * inside an attribution rectangle (the attribution restore covers it).
   */
  textMarks: NormalizedBox[];
  /** What takes the frame's pixels back: people, blur and each text mark grown by its margin. */
  paste: NormalizedBox[];
  /** Share of the frame the paste boxes cover. */
  coverage: number;
}

/**
 * The boxes of a Street View frame whose pixels an enhancement must give back: people, blurred
 * areas, and house numbers, signs and logos grown by the text-mark margin (`textMarkExclusions`),
 * so the whole mark comes back even when the analysis box is narrower than it.
 */
export function enhanceProtectedBoxes(input: {
  analysis: Pick<SceneAnalysis, 'peopleBoxes' | 'protectedBlurRegions' | 'preserveRegions'>;
  attributionRegions: readonly NormalizedBox[];
  width: number;
  height: number;
}): EnhanceProtectedBoxes {
  const { analysis, width, height } = input;
  const people = analysis.peopleBoxes.map((box) => [...box] as NormalizedBox);
  const blur = analysis.protectedBlurRegions.map((region) => [...region.box] as NormalizedBox);
  const marks = enhanceTextMarks(analysis, input.attributionRegions);
  const textMarks = marks.map((region) => [...region.box] as NormalizedBox);
  const grown = textMarkExclusions({ preserveRegions: marks }, width, height);
  const paste = [...people, ...blur, ...grown];
  return {
    people,
    blur,
    textMarks,
    paste,
    coverage: Math.round(protectedCoverage(paste, width, height) * 10_000) / 10_000,
  };
}

/** The protected spots the enhance judge inspects. */
export function enhanceJudgePreserve(
  analysis: Pick<SceneAnalysis, 'peopleBoxes' | 'protectedBlurRegions' | 'preserveRegions'>,
  attributionRegions: readonly NormalizedBox[],
): EnhanceJudgeInput['preserve'] {
  return {
    regions: analysis.preserveRegions.map((region) => ({ ...region })),
    protectedBlurRegions: analysis.protectedBlurRegions.map((region) => ({ ...region })),
    peopleBoxes: analysis.peopleBoxes.map((box) => [...box] as NormalizedBox),
    attributionRegions: attributionRegions.map((box) => [...box] as NormalizedBox),
  };
}

/** The result of `restoreAndCheckEnhancement`. */
export interface EnhancementCheck {
  /** The restored enhancement on the working grid; null when registration rejected it. */
  candidate: Raster | null;
  alignment: AlignmentRecord;
  /** Deterministic failure codes, deduplicated; empty when the checks passed. */
  codes: FailureCode[];
  /** What each check measured (stored on the enhancement row). */
  checks: Record<string, unknown>;
}

/** The editor's output does not decode as an image. */
export class EnhancementUndecodable extends Error {
  constructor(cause: unknown) {
    super('the enhancement output does not decode', { cause });
    this.name = 'EnhancementUndecodable';
  }
}

/** The parts of the checks a test can switch off to prove each one is needed. */
export interface EnhancementCheckSkips {
  paste?: boolean;
  attribution?: boolean;
  tiles?: boolean;
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** A 0/1 mask of `boxes` on the grid. */
function boxesMask(width: number, height: number, boxes: readonly NormalizedBox[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const box of boxes) {
    const rect = toRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1)
      mask.fill(1, y * width + rect.x0, y * width + rect.x1);
  }
  return mask;
}

/**
 * Registers the editor's enhancement of a Street View frame to the frame, puts the protected
 * pixels back and runs the deterministic checks:
 *
 * 1. The output is decoded; bytes that do not decode throw `EnhancementUndecodable`.
 * 2. It is registered to the frame outside the attribution rectangles and the padding, with the
 *    rules of a relight (`lightingMode: 'evening'`: nothing is pasted back around the whole
 *    picture, so the uncovered-strip limit applies). Not accepted: `camera_changed`, no candidate.
 * 3. People, blurred areas and text marks take the frame's pixels back, tone-matched
 *    (`restoreProtectedPixels`).
 * 4. Each attribution rectangle keeps the frame's logo and copyright strokes over the enhanced
 *    ground, the padding the frame's pixels (`restoreProtectedRectangles` in relight form).
 * 5. The relight form of the deterministic checks: edge agreement over the whole frame outside the
 *    pasted boxes, relative sharpness and new-edge share of every people and blur box, the
 *    attribution strokes.
 * 6. The tile structure check (`structure_changed`).
 * 7. Each text mark's analysis box must equal the frame's (mean SSIM at `houseNumberSsim`), else
 *    `text_added`; after the paste this holds by construction, so it guards the paste.
 */
export async function restoreAndCheckEnhancement(input: {
  frame: WorkingImage;
  rawBytes: Uint8Array;
  analysis: Pick<SceneAnalysis, 'peopleBoxes' | 'protectedBlurRegions' | 'preserveRegions'>;
  attributionRegions: readonly NormalizedBox[];
  /** Test-only: skip a step to prove it is needed. */
  skip?: EnhancementCheckSkips;
}): Promise<EnhancementCheck> {
  const { frame, attributionRegions } = input;
  const working = frame.raster;
  const { width, height } = working;
  const long = Math.max(width, height);
  const t = PIPELINE_DEFAULTS.checks;

  let delivered: Raster;
  try {
    delivered = await decodeRaster(input.rawBytes);
  } catch (error) {
    throw new EnhancementUndecodable(error);
  }
  const registered = await registerDelivered({
    working,
    delivered,
    // A relight's rules: the whole picture is the editor's, so the uncovered-strip limit applies.
    lightingMode: 'evening',
    exclude: boxesMask(width, height, [...attributionRegions, ...frame.padRegions]),
    fallbackPx: t.maxTranslationFraction * long,
  });
  if (!registered.aligned) {
    return {
      candidate: null,
      alignment: registered.record,
      codes: ['camera_changed'],
      checks: { alignment: registered.record, codes: ['camera_changed'] },
    };
  }
  const aligned = registered.aligned;

  const boxes = enhanceProtectedBoxes({
    analysis: input.analysis,
    attributionRegions,
    width,
    height,
  });
  const pasted = input.skip?.paste
    ? { raster: aligned, photometric: null, coverage: 0 }
    : restoreProtectedPixels({
        candidate: aligned,
        frame: working,
        boxes: boxes.paste,
        attributionRegions,
        padRegions: frame.padRegions,
      });
  const restored = input.skip?.attribution
    ? { candidate: pasted.raster, attribution: [] }
    : restoreProtectedRectangles({
        candidate: pasted.raster,
        working,
        lightingMode: 'evening',
        attribution: attributionRegions,
        padRegions: frame.padRegions,
      });
  const candidate = restored.candidate;

  const deterministic = runDeterministicChecks({
    working,
    raw: aligned,
    candidate,
    requested: { width, height },
    lightingMode: 'evening',
    placementRegions: boxes.paste,
    targetFacade: null,
    peopleBoxes: boxes.people,
    blurRegions: boxes.blur,
    houseNumberRegions: [],
    glowRegions: [],
    contentBox: frame.contentBox,
    attributionRegion: attributionRegions,
    mask: null,
    alignment: registered.record,
  });
  const codes = new Set<FailureCode>(deterministic.codes);

  const tiles = tileStructureAgreement(working, candidate, {
    exclude: [...attributionRegions, ...boxes.paste, ...frame.padRegions],
  });
  if (!tiles.passed && !input.skip?.tiles) codes.add('structure_changed');

  const grayFrame = toGray(working);
  const grayCandidate = toGray(candidate);
  const textMarks = boxes.textMarks.map((box) => {
    const ssim = meanSsim(grayFrame, grayCandidate, width, toRect(box, width, height));
    const passed = ssim >= t.houseNumberSsim;
    if (!passed) codes.add('text_added');
    return { box, ssim: round4(ssim), passed };
  });

  const list = [...codes];
  return {
    candidate,
    alignment: registered.record,
    codes: list,
    checks: {
      protected: {
        boxes: boxes.paste,
        coverage: boxes.coverage,
        photometric: pasted.photometric,
      },
      attribution: restored.attribution,
      deterministic: deterministic.checks,
      tileCorrelation: tiles,
      textMarks,
      codes: list,
    },
  };
}
