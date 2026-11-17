import type { HolidayPack, SceneType, Style } from '@hailiday/core';
import {
  compilePlan,
  type CompileContent,
  type CompileOptions,
  type CompileResult,
} from '../compile/compiler.js';
import { PlanConfigurationError, buildPlan, withoutPlacements } from './builder.js';
import type { BuildPlanInput, BuiltPlan } from './types.js';

export * from './types.js';
export * from './phrases.js';
export * from './geometry.js';
export * from './shapes.js';
export * from './validator.js';
export * from './builder.js';
export * from './repair.js';

/**
 * The reviewed pack content the compiler needs for one scene section, its lavish description
 * included.
 */
export function compileContentFor(
  pack: Pick<HolidayPack, 'sceneSections'>,
  sceneType: SceneType,
  style?: Style,
): CompileContent {
  const section = pack.sceneSections[sceneType];
  if (!section) throw new PlanConfigurationError('missing_scene_section', [sceneType]);
  return {
    fragments: section.promptFragments,
    preserveItems: section.preserve,
    attachments: Object.fromEntries(section.kit.map((item) => [item.kitItemId, item.attachment])),
    requiredKitItems: style
      ? section.kit.filter((item) => item.required.includes(style)).map((item) => item.kitItemId)
      : [],
  };
}

export interface PlannedAttempt {
  built: BuiltPlan;
  compile: CompileResult | null;
}

/**
 * Builds, validates and compiles one attempt's plan. Placements the compiler drops for the length
 * cap are removed from the plan too, so the prompt and Shop the look list the same items. The
 * compile result is null when the plan fails validation.
 */
export function planAndCompile(
  input: BuildPlanInput,
  compileOptions: (built: BuiltPlan) => CompileOptions,
): PlannedAttempt {
  let built = buildPlan(input);
  if (!built.validator.passed) return { built, compile: null };
  const content = compileContentFor(input.pack, input.sceneType, input.style);
  let result = compilePlan(built.draft, content, compileOptions(built));
  if (result.droppedPlacementIds.length > 0) {
    built = withoutPlacements(built, result.droppedPlacementIds, 'length_cap');
    result = compilePlan(built.draft, content, compileOptions(built));
  }
  return { built, compile: result };
}
