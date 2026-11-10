import {
  JUDGE_RESULT_SCHEMA_VERSION,
  JudgeResultSchema,
  SCENE_ANALYSIS_SCHEMA_VERSION,
  SceneAnalysisSchema,
} from '@holiday/core';
import type {
  JudgeModelOutput,
  JudgeResult,
  NormalizedBox,
  SceneAnalysis,
  SceneAnalysisModelOutput,
} from '@holiday/core';
import { z } from 'zod';
import type {
  AnalyzeSceneInput,
  JudgeInput,
  LocalizeAdditionsInput,
  LocalizeAdditionsResult,
} from '../types.js';

const unit = z.number().min(0).max(1);
/** Four numbers in [0, 1]; corner order and degenerate boxes are handled after parsing. */
const LooseBoxSchema = z.tuple([unit, unit, unit, unit]);

/** What the localization model returns. */
export const LocalizeModelOutputSchema = z.strictObject({
  added: z.array(
    z.strictObject({
      label: z.string().max(300),
      box: LooseBoxSchema,
      placementId: z.string().nullable(),
    }),
  ),
  otherChanges: z.array(
    z.strictObject({
      description: z.string().max(500),
      box: LooseBoxSchema,
    }),
  ),
});
export type LocalizeModelOutput = z.infer<typeof LocalizeModelOutputSchema>;

/** Most added items and other changes kept from one reply. */
export const LOCALIZE_MAX_ITEMS = 48;
/** Boxes thinner than this (normalized) on either side are dropped as degenerate. */
const MIN_BOX_SIDE = 0.002;

function orderedBox([a, b, c, d]: readonly [number, number, number, number]): NormalizedBox | null {
  const box: NormalizedBox = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  return box[2] - box[0] < MIN_BOX_SIDE || box[3] - box[1] < MIN_BOX_SIDE ? null : box;
}

/**
 * Turns a localization reply into the result: corners ordered, degenerate boxes dropped, at most
 * `LOCALIZE_MAX_ITEMS` of each list, and a placement id kept only when it names a planned
 * placement (otherwise null).
 */
export function toLocalizeResult(
  output: LocalizeModelOutput,
  input: Pick<LocalizeAdditionsInput, 'placements'>,
): LocalizeAdditionsResult {
  const ids = new Set(input.placements.map((placement) => placement.id));
  const added: LocalizeAdditionsResult['added'] = [];
  for (const item of output.added) {
    const box = orderedBox(item.box);
    if (!box) continue;
    const placementId = item.placementId?.trim() ?? null;
    added.push({
      label: item.label.trim(),
      box,
      placementId: placementId && ids.has(placementId) ? placementId : null,
    });
  }
  const otherChanges: LocalizeAdditionsResult['otherChanges'] = [];
  for (const change of output.otherChanges) {
    const box = orderedBox(change.box);
    if (box) otherChanges.push({ description: change.description.trim(), box });
  }
  return {
    added: added.slice(0, LOCALIZE_MAX_ITEMS),
    otherChanges: otherChanges.slice(0, LOCALIZE_MAX_ITEMS),
  };
}

/** Wraps a model's scene output into the full record; the confirmed scene type wins. */
export function toSceneAnalysis(
  output: SceneAnalysisModelOutput,
  input: AnalyzeSceneInput,
  meta: { analysisModel: string; analysisPromptVersion: string; elapsedMs: number },
): SceneAnalysis {
  const record: SceneAnalysis = {
    schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION,
    sourceAssetId: input.sourceAssetId,
    workingImage: {
      width: input.image.width,
      height: input.image.height,
      checksum: input.image.checksum,
    },
    ...output,
    sceneType: input.sceneType,
    sceneTypeMismatch: output.sceneType !== input.sceneType,
    model: { analysisModel: meta.analysisModel, analysisPromptVersion: meta.analysisPromptVersion },
    elapsedMs: meta.elapsedMs,
  };
  if (input.sceneType === 'house_exterior' && input.buildingForm)
    record.buildingForm = input.buildingForm;
  if (input.sceneType === 'interior' && input.roomType) record.roomType = input.roomType;
  if (input.sceneType !== 'house_exterior') delete record.buildingForm;
  if (input.sceneType !== 'interior') delete record.roomType;
  return SceneAnalysisSchema.parse(record);
}

/** Wraps a judge's output into the full record, keeping only placements of the plan. */
export function toJudgeResult(
  output: JudgeModelOutput,
  input: JudgeInput,
  meta: { judgeModel: string; judgePromptVersion: string; elapsedMs: number },
): JudgeResult {
  const ids = new Set(input.plan.placements.map((placement) => placement.id));
  return JudgeResultSchema.parse({
    schemaVersion: JUDGE_RESULT_SCHEMA_VERSION,
    renderAttemptId: input.renderAttemptId,
    judgeModel: meta.judgeModel,
    judgePromptVersion: meta.judgePromptVersion,
    escalated: input.escalated ?? false,
    ...output,
    placements: output.placements.filter((placement) => ids.has(placement.placementId)),
    elapsedMs: meta.elapsedMs,
  });
}

/** Clamps every four-number array (normalized boxes) into [0, 1] before validation. */
export function clampBoxes(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 4 && value.every((item) => typeof item === 'number')) {
      return value.map((item) => Math.min(1, Math.max(0, item as number)));
    }
    return value.map(clampBoxes);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clampBoxes(item)]));
  }
  return value;
}

/** Detects an image media type from magic bytes. */
export function imageMediaType(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}
