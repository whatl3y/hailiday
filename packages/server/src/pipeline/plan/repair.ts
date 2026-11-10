import {
  boxCenter,
  intersectBoxes,
  isRepairableFailureCode,
  type DecorationPlan,
  type FailureCode,
  type JudgeResult,
  type NormalizedBox,
  type RepairConstraint,
} from '@holiday/core';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { positionWords } from './phrases.js';
import type { RepairAdjustments, RepairInput } from './types.js';

/** One failure that led to a repair: the code plus an optional box from the judge. */
export interface RepairFinding {
  code: FailureCode;
  box?: NormalizedBox;
}

/** Whether a set of attempt-1 failure codes allows a repair (repairable and no terminal code). */
export function isRepairable(codes: readonly FailureCode[]): boolean {
  return codes.length > 0 && codes.every((code) => isRepairableFailureCode(code));
}

/** Findings from a judge result and the deterministic codes of one attempt. */
export function findingsFrom(
  judge: JudgeResult | null,
  deterministic: readonly FailureCode[],
  thresholds: { critical: number; major: number },
): RepairFinding[] {
  const findings: RepairFinding[] = deterministic.map((code) => ({ code }));
  for (const finding of judge?.critical ?? []) {
    if (finding.confidence >= thresholds.critical) {
      findings.push({ code: finding.code, ...(finding.box ? { box: finding.box } : {}) });
    }
  }
  for (const finding of judge?.major ?? []) {
    if (finding.confidence >= thresholds.major) {
      findings.push({ code: finding.code, ...(finding.box ? { box: finding.box } : {}) });
    }
  }
  return findings;
}

const distance = (a: NormalizedBox, b: NormalizedBox) => {
  const [ax, ay] = boxCenter(a);
  const [bx, by] = boxCenter(b);
  return Math.hypot(ax - bx, ay - by);
};

/**
 * Builds the repair constraints and plan adjustments for plan version 2 from attempt 1's
 * findings (render spec, repair and retries, code classes). Instructions come from fixed
 * templates and analysis-derived position words, never from model text.
 */
export function deriveRepair(
  previous: DecorationPlan,
  placementKeys: Readonly<Record<string, string>>,
  findings: readonly RepairFinding[],
  judge: JudgeResult | null,
): RepairInput {
  const constraints: RepairConstraint[] = [];
  const adjustments: RepairAdjustments = { excludePairs: [] };
  const keyOf = (placementId: string) => placementKeys[placementId] ?? placementId;
  const codes = [...new Set(findings.map((finding) => finding.code))];
  const byPriority = [...previous.placements].sort((a, b) => b.priority - a.priority);

  for (const code of codes) {
    const boxes = findings
      .filter((f) => f.code === code && f.box)
      .map((f) => f.box as NormalizedBox);
    switch (code) {
      case 'structure_changed': {
        // Drop the lowest-priority placement nearest the evidence; reduce dilation one step.
        const victim =
          boxes.length > 0 && previous.placements.length > 1
            ? [...previous.placements].sort(
                (a, b) =>
                  Math.min(...boxes.map((box) => distance(a.region, box))) -
                    Math.min(...boxes.map((box) => distance(b.region, box))) ||
                  b.priority - a.priority,
              )[0]
            : previous.placements.length > 1
              ? byPriority[0]
              : undefined;
        if (victim) adjustments.excludePairs.push(keyOf(victim.id));
        adjustments.dilationFraction = Math.max(
          0.01,
          (previous.compositeMask?.dilationFraction ?? PIPELINE_DEFAULTS.dilationFraction) - 0.01,
        );
        constraints.push({
          code,
          instruction:
            'Keep the roof line, walls, windows, doors, trim and materials exactly as in the original; change nothing about the structure.',
          placementIds: victim ? [keyOf(victim.id)] : [],
        });
        break;
      }
      case 'neighbor_decorated': {
        adjustments.edgeMarginMultiplier = 2;
        constraints.push({
          code,
          instruction:
            'Make no change at all to the buildings on the left and right side of the image; decorate only the target.',
          placementIds: [],
        });
        break;
      }
      case 'access_blocked': {
        adjustments.accessTolerance = 0;
        const blocked = previous.placements.filter((placement) =>
          previous.preserve.accessRegions.some(
            (region) => intersectBoxes(placement.region, region.box) !== null,
          ),
        );
        constraints.push({
          code,
          instruction: 'Keep every door, step, walkway and path completely clear and passable.',
          placementIds: blocked.map((placement) => keyOf(placement.id)),
        });
        break;
      }
      case 'privacy_regression':
      case 'people_altered': {
        adjustments.protectedMarginFraction = 0.03;
        const protectedBoxes = [
          ...previous.preserve.peopleBoxes,
          ...previous.preserve.protectedBlurRegions.map((region) => region.box),
        ];
        const where =
          protectedBoxes.length > 0 ? ` ${positionWords(protectedBoxes[0] as NormalizedBox)}` : '';
        constraints.push({
          code,
          instruction: `Leave the blurred areas and any people${where} exactly as they appear; do not sharpen, redraw or replace them.`,
          placementIds: [],
        });
        break;
      }
      case 'text_added':
        constraints.push({
          code,
          instruction:
            'Do not add any text, lettering, signage or numbers, and keep house numbers exactly as they are.',
          placementIds: [],
        });
        break;
      case 'camera_changed':
        adjustments.lowerQuality = true;
        constraints.push({
          code,
          instruction:
            'Keep the identical framing, crop, perspective and camera position of the original photograph.',
          placementIds: [],
        });
        break;
      case 'unrequested_change':
        constraints.push({
          code,
          instruction:
            'Change nothing except adding the listed decorations: no repainting, no landscaping changes, no added snow, no removed objects.',
          placementIds: [],
        });
        break;
      case 'plan_not_followed': {
        adjustments.countsToMinimum = true;
        const missing = (judge?.placements ?? [])
          .filter((placement) => !placement.present)
          .map((placement) => keyOf(placement.placementId));
        adjustments.restateFirst = missing;
        constraints.push({
          code,
          instruction: 'Add every listed decoration, each at the stated position and count.',
          placementIds: missing,
        });
        break;
      }
      case 'implausible_decor':
        adjustments.countsToMinimum = true;
        constraints.push({
          code,
          instruction:
            'Give every decoration believable real-world scale, a secure visible attachment and contact shadows.',
          placementIds: [],
        });
        break;
      case 'lighting_implausible':
        constraints.push({
          code,
          instruction:
            'Only the listed lit decorations may glow; add no other light sources and do not light neighboring buildings.',
          placementIds: [],
        });
        break;
      default:
        break;
    }
  }
  return { constraints, adjustments };
}
