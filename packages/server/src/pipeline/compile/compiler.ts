import {
  COMPILED_REQUEST_SCHEMA_VERSION,
  CompiledRequestSchema,
  type AttachmentIntent,
  type CompiledRequest,
  type DecorationPlan,
  type FailureCode,
  type PromptFragments,
} from '@holiday/core';
import {
  DEFAULT_IMAGE_EDIT_SETTINGS,
  type GeminiThinkingLevel,
  type ImageEditSettings,
  type OpenAiImageQuality,
} from '../../config/index.js';
import { sha256Hex } from '../../ids/index.js';
import {
  ANCHOR_WORDS,
  ATTACHMENT_VERBS,
  SUBJECT_WORDS,
  countWord,
  positionWords,
} from '../plan/phrases.js';
import type { PlanDraft } from '../plan/types.js';
import { PIPELINE_DEFAULTS } from '../versions.js';

/** Image-edit provider families the compiler has a variant for. */
export const COMPILER_PROVIDERS = ['openai', 'gemini', 'fixture'] as const;
export type CompilerProvider = (typeof COMPILER_PROVIDERS)[number];

/**
 * Reviewed pack content the compiler reads besides the plan: the section's prompt fragments,
 * its preserve list and each archetype's attachment. None of it can carry an address or user
 * text; the project, property, user and merchant records are never inputs.
 */
export interface CompileContent {
  fragments: PromptFragments;
  preserveItems: readonly string[];
  attachments: Readonly<Record<string, AttachmentIntent>>;
  /** Kit items the style requires; the length cap drops their first placement last. */
  requiredKitItems?: readonly string[];
}

export interface CompileOptions {
  provider: CompilerProvider;
  modelSnapshot: string;
  working: { width: number; height: number; checksum: string };
  /**
   * The edit mask; sent only when the mask policy is `tight`, the provider supports masks and the
   * plan is additive.
   */
  mask?: { width: number; height: number; checksum: string } | null;
  supportsMask: boolean;
  caps?: { source: number; evening: number };
  /** Lower the quality or thinking setting (repair after `camera_changed`). */
  lowerQuality?: boolean;
  /**
   * Configured request settings (`AppConfig.imageEdit`): mask policy, OpenAI quality, Gemini size
   * and thinking level. Unset fields take `DEFAULT_IMAGE_EDIT_SETTINGS`.
   */
  settings?: Partial<ImageEditSettings>;
}

export interface CompileResult {
  request: CompiledRequest;
  compiled: DecorationPlan['compiled'];
  /** Placements dropped to stay within the length cap (lowest priority first). */
  droppedPlacementIds: string[];
}

const PROTECT =
  'Leave any blurred or pixelated areas, people, vehicles and license plates exactly as they appear; do not sharpen, reconstruct or replace them.';

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const capitalized = trimmed[0]?.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function stripArticle(text: string): string {
  return text.replace(/^(a|an|one)\s+/i, '');
}

/** Stable JSON (sorted keys) for hashing. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function aspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** The configured settings with defaults for every unset field. */
export function resolveImageEditSettings(
  settings: Partial<ImageEditSettings> = {},
): ImageEditSettings {
  return {
    providerMask: settings.providerMask ?? DEFAULT_IMAGE_EDIT_SETTINGS.providerMask,
    openaiQuality: settings.openaiQuality ?? DEFAULT_IMAGE_EDIT_SETTINGS.openaiQuality,
    geminiImageSize: settings.geminiImageSize ?? DEFAULT_IMAGE_EDIT_SETTINGS.geminiImageSize,
    geminiThinkingLevel:
      settings.geminiThinkingLevel ?? DEFAULT_IMAGE_EDIT_SETTINGS.geminiThinkingLevel,
  };
}

/**
 * The OpenAI quality a repair uses: one step down, never below `medium` (lower settings are not
 * photographic enough to deliver); `auto` becomes `medium`.
 */
export function lowerOpenAiQuality(quality: OpenAiImageQuality): OpenAiImageQuality {
  if (quality === 'high' || quality === 'auto') return 'medium';
  return quality;
}

/** The Gemini thinking level a repair uses: one step down, `minimal` stays `minimal`. */
export function lowerGeminiThinkingLevel(level: GeminiThinkingLevel): GeminiThinkingLevel {
  if (level === 'high') return 'medium';
  return 'minimal';
}

/**
 * Provider parameters per provider family (render spec, provider parameters), from the
 * configured settings. OpenAI never receives `input_fidelity` (the GPT image 2.5 models reject
 * it) and Gemini never receives the `low` thinking level (its image models reject it).
 */
export function providerParameters(
  provider: CompilerProvider,
  working: { width: number; height: number },
  lowerQuality = false,
  settings: Partial<ImageEditSettings> = {},
): Record<string, string | number | boolean> {
  const resolved = resolveImageEditSettings(settings);
  const size = `${working.width}x${working.height}`;
  switch (provider) {
    case 'openai':
      return {
        size,
        quality: lowerQuality ? lowerOpenAiQuality(resolved.openaiQuality) : resolved.openaiQuality,
        output_format: 'jpeg',
      };
    case 'gemini':
      return {
        image_size: resolved.geminiImageSize,
        aspect_ratio: aspectRatio(working.width, working.height),
        thinking_level: lowerQuality
          ? lowerGeminiThinkingLevel(resolved.geminiThinkingLevel)
          : resolved.geminiThinkingLevel,
      };
    case 'fixture':
      return { size, output_format: 'jpeg', fixture_id: 'fixture-compositor' };
  }
}

/** One placement sentence: verb, count, spec text, anchor and position words (no coordinates). */
export function placementSentence(
  placement: DecorationPlan['placements'][number],
  attachment: AttachmentIntent,
  lightingMode: 'source' | 'evening',
): string {
  const verb = ATTACHMENT_VERBS[attachment];
  const spec = placement.specText.trim().replace(/[.\s]+$/, '');
  const what =
    placement.count === 1
      ? /^(a|an|one|the|two|three|four|five|six|pair|set|group|\d)\b/i.test(spec)
        ? spec
        : `one ${spec}`
      : `${countWord(placement.count)} instances of ${stripArticle(spec)}`;
  const anchor = ANCHOR_WORDS[placement.anchorCategory];
  const litClause = placement.lit
    ? lightingMode === 'evening'
      ? ', switched on so it glows warm with soft bloom'
      : ', switched on so it glows softly'
    : '';
  return `${verb} ${what}, at the ${anchor} ${positionWords(placement.region)}${litClause}.`;
}

/**
 * The `evening` keep clause: a relight re-renders the whole frame, and editors tend to replace
 * doors or drop furniture while doing so, so the instruction states outright that every
 * existing object stays and only the light changes.
 */
export const EVENING_KEEP =
  'Every existing door, window, piece of furniture and object stays exactly as it is, in the same place, with the same shape, material and color; nothing is removed, replaced, moved or restyled. Only the lighting changes, and only the planned decorations below are added.';

/**
 * The preserve block: the pack fragment in `source` mode; in `evening`, shape and position plus
 * the keep clause.
 */
function preserveBlock(plan: PlanDraft, content: CompileContent): string {
  if (plan.lightingMode === 'source') {
    return sentence(content.fragments.preserve);
  }
  const items = content.preserveItems.filter((item) => !/\b(sky|time of day)\b/i.test(item));
  const list = items.length > 0 ? `the ${items.join(', ')}` : 'the building';
  return `Keep the camera position, crop and perspective, and keep ${list} exactly as they are in shape and position. ${EVENING_KEEP}`;
}

/**
 * Compiles a plan into the provider request (render spec, prompt compilation): fixed blocks in
 * order (scope, preserve, placements, lighting, protect, negatives, output), capped by length so
 * lower-priority placements are dropped before preserve or protect text is shortened.
 * Deterministic: the same plan compiles to byte-identical output.
 */
export function compilePlan(
  plan: PlanDraft,
  content: CompileContent,
  options: CompileOptions,
): CompileResult {
  const evening = plan.lightingMode === 'evening';
  const scope = `Edit only the target ${SUBJECT_WORDS[plan.sceneType]} in the attached photo to show ${content.fragments.scene.trim().replace(/[.\s]+$/, '')}, ${evening ? 'shifted to early dusk' : 'in the lighting of the original photograph'}.`;
  const preserve = preserveBlock(plan, content);
  const realism = `Use believable scale, secure attachments and contact shadows that match the ${evening ? 'dusk light' : 'existing light'}.`;
  const negatives = [
    sentence(content.fragments.negative),
    plan.negatives.length > 0 ? `Also add no ${joinList(plan.negatives)}.` : '',
    'Do not alter house numbers, logos or existing decorations.',
    ...(plan.repairConstraints ?? []).map((constraint) => sentence(constraint.instruction)),
  ]
    .filter(Boolean)
    .join(' ');
  const output = evening
    ? 'Return the same photograph with only these decorations added and the light shifted to early dusk; everything else in the photograph stays as it is.'
    : 'Return the same photograph with only these decorations added.';
  const cap = (options.caps ?? PIPELINE_DEFAULTS.instructionCaps)[plan.lightingMode];

  const placements = [...plan.placements].sort((a, b) => a.priority - b.priority);
  const sentenceOf = new Map(
    placements.map((placement) => [
      placement.id,
      placementSentence(
        placement,
        content.attachments[placement.kitItemId] ?? 'placed',
        plan.lightingMode,
      ),
    ]),
  );
  // Drop order under the cap: extra placements of an archetype first, then archetypes the style
  // does not require, then the rest, each from the lowest priority up.
  const required = new Set(content.requiredKitItems ?? []);
  const seen = new Set<string>();
  const tier = new Map<string, number>();
  for (const placement of placements) {
    const first = !seen.has(placement.kitItemId);
    seen.add(placement.kitItemId);
    tier.set(placement.id, !first ? 0 : required.has(placement.kitItemId) ? 2 : 1);
  }
  const dropOrder = [...placements]
    .reverse()
    .sort((a, b) => (tier.get(a.id) ?? 0) - (tier.get(b.id) ?? 0));
  const kept = new Set(placements.map((placement) => placement.id));
  const assemble = () =>
    [
      scope,
      preserve,
      ...placements.filter((p) => kept.has(p.id)).map((p) => sentenceOf.get(p.id) as string),
      realism,
      plan.lightingInstruction.text,
      PROTECT,
      negatives,
      output,
    ]
      .filter(Boolean)
      .join(' ');
  let instructionText = assemble();
  for (const candidate of dropOrder) {
    if (instructionText.length <= cap || kept.size <= 1) break;
    kept.delete(candidate.id);
    instructionText = assemble();
  }
  const droppedPlacementIds = placements.filter((p) => !kept.has(p.id)).map((p) => p.id);

  const settings = resolveImageEditSettings(options.settings);
  const parameters = providerParameters(
    options.provider,
    options.working,
    options.lowerQuality,
    settings,
  );
  const useMask =
    settings.providerMask === 'tight' &&
    options.supportsMask &&
    plan.fidelityMode === 'composite_additive' &&
    options.mask
      ? options.mask
      : null;
  const settingsHash = `sha256:${sha256Hex(
    stableJson({
      provider: options.provider,
      modelSnapshot: options.modelSnapshot,
      compilerVersion: plan.compilerVersion,
      parameters,
      mask: useMask !== null,
      referenceOrder: [],
    }),
  )}`;
  const request = CompiledRequestSchema.parse({
    schemaVersion: COMPILED_REQUEST_SCHEMA_VERSION,
    compilerVersion: plan.compilerVersion,
    provider: options.provider,
    modelSnapshot: options.modelSnapshot,
    images: [
      {
        role: 'source',
        width: options.working.width,
        height: options.working.height,
        checksum: options.working.checksum,
      },
    ],
    ...(useMask ? { mask: useMask } : {}),
    instructionText,
    parameters,
    settingsHash,
  });
  const compiled: DecorationPlan['compiled'] = {
    provider: options.provider,
    modelSnapshot: options.modelSnapshot,
    instructionText,
    parameters,
    hash: `sha256:${sha256Hex(`${instructionText}\n${stableJson(parameters)}`)}`,
  };
  return { request, compiled, droppedPlacementIds };
}

// ---- relight -------------------------------------------------------------------------------------

/**
 * The relight keep clause: a relight re-renders the whole frame of an already decorated photo, so
 * the instruction states outright that every object and decoration stays and nothing is added.
 */
export const RELIGHT_KEEP =
  'Every existing object, decoration, architectural detail, plant and piece of furniture stays exactly as it is, in the same place, with the same shape, material and color. Nothing is added, removed, moved, replaced or restyled, and the camera position, lens and framing do not change.';

/** The stronger keep clause of a relight repair after the first relight changed the photo. */
export const RELIGHT_REPAIR_KEEP =
  'The previous relight changed the photograph itself. Change nothing but the light: every edge, object, decoration, window and door must line up exactly with the input photograph, and nothing may be added, removed, redrawn or restyled.';

/** The relight repair sentence after the first relight's light looked artificial. */
export const RELIGHT_REPAIR_LIGHT =
  'The previous relight looked artificial. Keep the dusk natural and believable: soft ambient blue light, a warm glow only from the existing bulbs, lamps and windows, and no glowing outlines or flat colored areas.';

/** Codes a relight repair answers with the lighting sentence alone. */
const RELIGHT_LIGHT_CODES: readonly FailureCode[] = ['lighting_implausible'];

/** Most lit decorations a relight instruction names. */
const RELIGHT_MAX_NAMED = 6;

/** The repair of a relight: the codes that rejected the first relight. */
export interface RelightRepair {
  codes: readonly FailureCode[];
}

export interface RelightCompileInput {
  /** The accepted daylight plan whose decorations the relight keeps (and names when lit). */
  basePlan: Pick<DecorationPlan, 'sceneType' | 'placements' | 'compilerVersion'>;
  provider: CompilerProvider;
  /** Configured request settings; unset fields take `DEFAULT_IMAGE_EDIT_SETTINGS`. */
  settings?: Partial<ImageEditSettings>;
  repair?: RelightRepair | null;
  modelSnapshot: string;
  /** The base variant's image on the working grid: the provider input. */
  image: { width: number; height: number; checksum: string };
  /** Defaults to the base plan's compiler version. */
  compilerVersion?: string;
  /** Lower the quality or thinking setting (repair after `camera_changed`). */
  lowerQuality?: boolean;
}

/** The leading noun phrase of a placement's spec text ("mixed evergreen garland"). */
function decorationName(specText: string): string {
  const head = specText
    .trim()
    .split(
      /,|;|\s(?:with|following|centered|beside|flanking|along|on|at|in|lit|hung|hanging|draped|wrapped|standing|placed)\s/i,
    )[0] as string;
  return stripArticle(head.trim().replace(/[.\s]+$/, ''));
}

/** Whether a scene is relit as a room (lamps) rather than an exterior (dusk sky, porch light). */
function interiorScene(sceneType: DecorationPlan['sceneType']): boolean {
  return sceneType === 'interior';
}

/**
 * Compiles the relight of an accepted daylight variant (render spec, lighting modes): the editor
 * receives the decorated daylight image, no mask and an instruction that changes only the light
 * (dusk ambient light, the decorations' own bulbs glowing, warm windows, porch or room lights on)
 * and keeps every object and decoration. A repair adds a stronger keep clause (or, for implausible
 * light alone, a natural-light sentence) and may lower the quality one step. The request is marked
 * as a relight (`kind` and `parameters.relight`), which the fixture editor answers with the
 * deterministic evening grade. Deterministic: the same input compiles to byte-identical output.
 */
export function compileRelightRequest(input: RelightCompileInput): CompiledRequest {
  const interior = interiorScene(input.basePlan.sceneType);
  const named: string[] = [];
  for (const placement of [...input.basePlan.placements].sort((a, b) => a.priority - b.priority)) {
    if (!placement.lit) continue;
    const name = `the ${decorationName(placement.specText)} on the ${ANCHOR_WORDS[placement.anchorCategory]}`;
    if (!named.includes(name)) named.push(name);
    if (named.length >= RELIGHT_MAX_NAMED) break;
  }
  const scope = interior
    ? 'Relight this exact photograph of a room to early evening: dusk outside the windows and the room lit warmly by its own lamps.'
    : 'Relight this exact photograph to early evening at blue hour, about twenty minutes after sunset.';
  const ambient = interior
    ? 'Only the lighting changes: the daylight fades to a warm, dim lamp-lit evening and the windows show deep dusk blue outside.'
    : 'Only the lighting changes: the ambient light becomes a deep dusk blue and the scene is darker overall.';
  const decorations =
    named.length > 0
      ? `The lights already on the decorations glow warmly and cast soft light on nearby surfaces: ${named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`}; any other bulbs, candles and lanterns already on the decorations glow too.`
      : 'Any bulbs, candles and lanterns already on the decorations glow warmly and cast soft light on nearby surfaces.';
  const fixtures = interior
    ? 'The existing lamps and ceiling fixtures are on.'
    : 'The existing porch and entry lights are on, and warm interior light shows through the existing windows.';
  const codes = input.repair?.codes ?? [];
  const repair =
    codes.length === 0
      ? ''
      : codes.every((code) => RELIGHT_LIGHT_CODES.includes(code))
        ? RELIGHT_REPAIR_LIGHT
        : codes.some((code) => RELIGHT_LIGHT_CODES.includes(code))
          ? `${RELIGHT_REPAIR_KEEP} ${RELIGHT_REPAIR_LIGHT}`
          : RELIGHT_REPAIR_KEEP;
  const instructionText = [
    scope,
    RELIGHT_KEEP,
    repair,
    ambient,
    decorations,
    fixtures,
    'Photorealistic, natural dusk exposure as photographed with a good camera.',
    PROTECT,
    'Return the same photograph with only the light changed.',
  ]
    .filter(Boolean)
    .join(' ');
  const parameters = {
    ...providerParameters(
      input.provider,
      input.image,
      input.lowerQuality ?? false,
      resolveImageEditSettings(input.settings),
    ),
    relight: true,
  };
  const compilerVersion = input.compilerVersion ?? input.basePlan.compilerVersion;
  const settingsHash = `sha256:${sha256Hex(
    stableJson({
      provider: input.provider,
      modelSnapshot: input.modelSnapshot,
      compilerVersion,
      kind: 'relight',
      parameters,
      mask: false,
      referenceOrder: [],
    }),
  )}`;
  return CompiledRequestSchema.parse({
    schemaVersion: COMPILED_REQUEST_SCHEMA_VERSION,
    compilerVersion,
    kind: 'relight',
    provider: input.provider,
    modelSnapshot: input.modelSnapshot,
    images: [{ role: 'source', ...input.image }],
    instructionText,
    parameters,
    settingsHash,
  });
}

/** Whether a compiled request is a relight of an accepted daylight variant. */
export function isRelightRequest(request: Pick<CompiledRequest, 'kind' | 'parameters'>): boolean {
  return request.kind === 'relight' || request.parameters.relight === true;
}

/** The plan's `compiled` record of a compiled request. */
export function compiledRecordOf(request: CompiledRequest): DecorationPlan['compiled'] {
  return {
    provider: request.provider,
    modelSnapshot: request.modelSnapshot,
    instructionText: request.instructionText,
    parameters: request.parameters,
    hash: `sha256:${sha256Hex(`${request.instructionText}\n${stableJson(request.parameters)}`)}`,
  };
}

/** Maps a configured image-editor provider name to its compiler family. */
export function compilerProviderFor(provider: string): CompilerProvider {
  return (COMPILER_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as CompilerProvider)
    : 'fixture';
}
