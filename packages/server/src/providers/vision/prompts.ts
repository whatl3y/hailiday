import { SURFACE_ANCHOR_CATEGORIES, anchorCategoriesForSceneType, boxThirds } from '@holiday/core';
import type {
  AnchorCategory,
  DecorationPlan,
  HolidayId,
  NormalizedBox,
  SceneType,
  SourceKind,
} from '@holiday/core';

/** Prompt versions, recorded with every call. */
export const ANALYSIS_PROMPT_VERSION = 'analysis-2026.11.1';
export const JUDGE_PROMPT_VERSION = 'judge-2026.11.3';
export const TRIAGE_PROMPT_VERSION = 'triage-2026.11.0';
export const LOCALIZE_PROMPT_VERSION = 'localize-2026.11.0';

const COORDINATES =
  'Boxes are [x0, y0, x1, y1] normalized to 0-1 on the image: origin top-left, x to the right, y down, x0 < x1 and y0 < y1.';

/** Pack-independent analysis system prompt (cacheable; contains no holiday, address or user text). */
export const ANALYSIS_SYSTEM_PROMPT = [
  'You analyze one photograph of a home so that a later step can plan where seasonal decorations could go.',
  'Report only what is visibly present. Never invent an element that is implied but not visible; omit it instead.',
  COORDINATES,
  'For each anchor give a confidence from 0 to 1, whether it is occluded, the occluded fraction when it is, and at most a short note describing visible evidence.',
  'Record preserve regions (house numbers, signs, logos, existing decorations, vehicles), access regions (doors, walkways, steps, driveways, gates, hallways), hazards, existing decorations, people boxes and protected blurred regions (faces, plates, whole blurred houses).',
  'Report lighting, season cues and quality flags. Do not estimate age, identity or any attribute of people; return their boxes only.',
].join('\n');

/**
 * What each anchor category's box covers. The plan builder derives decoration geometry from these
 * extents (lights follow the bottom edge of eaves and roof sections, garlands the top edge of
 * rails, frames and shelves, centerpieces the top surface of tables), so the glosses state them.
 */
export const ANCHOR_GLOSSES: Readonly<Record<AnchorCategory, string>> = {
  front_door: 'the main entry door of the target home',
  door_frame: 'the trim around an entry, unit or balcony door',
  porch_rail: 'a porch or stoop railing; the top of the box is the handrail',
  porch_steps: 'the entry steps',
  roofline:
    'one roof section of the target facade from its eave line up to its ridge; for a front-facing gable, from the eave corners up to the apex',
  eaves: 'an eave or gutter line, as a thin box hugging that line',
  window_frame: 'one exterior window with its trim',
  column: 'one porch post or column',
  walkway_edge: 'the path to the door',
  planter: 'an existing planter or urn',
  lawn: 'open lawn in front of the target facade',
  balcony_railing: 'the balcony railing of this unit; the top of the box is the top rail',
  balcony_floor: 'open balcony floor clear of the door swing',
  unit_door: 'the door of this unit',
  banister: 'a stair handrail with its balusters',
  mantel: 'a fireplace mantel; the top of the box is the shelf top',
  dining_table: 'a dining or kitchen table; the top of the box is the far edge of the tabletop',
  sideboard: 'a sideboard, buffet or console; the top of the box is its top surface',
  interior_window: 'one window with its frame, without the curtains beside it',
  wall: 'wall area free of fixtures, art and photographs',
  floor_area: 'open floor beside a wall or window, outside walking paths',
  shelf: 'an open shelf; the top of the box is the shelf top',
};

/** The per-call analysis instruction: scene type hint, anchor vocabulary and target facade rule. */
export function analysisUserPrompt(input: {
  sceneType: SceneType;
  sourceKind: SourceKind;
}): string {
  const categories = anchorCategoriesForSceneType(input.sceneType);
  const vocabulary = categories.map((category) => `- ${category}: ${ANCHOR_GLOSSES[category]}.`);
  const surfaces = categories.filter((category) => SURFACE_ANCHOR_CATEGORIES.includes(category));
  const facadeRule =
    input.sceneType !== 'house_exterior'
      ? 'This is not an exterior: omit targetFacade and set targetFacadeAmbiguous to false.'
      : input.sourceKind === 'street_view'
        ? 'Target facade: the residential facade containing the horizontal center of the frame at mid-height. If the center falls on a boundary between facades or on a non-residential structure, omit targetFacade and set targetFacadeAmbiguous to true. For attached houses the target spans only the centered unit.'
        : 'Target facade: the largest residential facade in frame (the dwelling the photo is of). For attached houses the target spans only that unit.';
  return [
    `Scene type hint: ${input.sceneType}. Report the scene type you see; it may differ from the hint.`,
    'Anchor categories to use (only these; one anchor per visible element, its box covering what the category names):',
    ...vocabulary,
    ...(surfaces.length > 0
      ? [
          `For ${surfaces.join(', ')} anchors, occluded and occlusionFraction describe the top surface only: chairs, legs and objects in front of the furniture below its top do not count.`,
        ]
      : []),
    facadeRule,
  ].join('\n');
}

/** Judge system prompt for decorate mode (cacheable). */
export const JUDGE_SYSTEM_PROMPT = [
  'You are the quality judge for AI-decorated home photographs. Image 1 is the original; image 2 is the decorated candidate at the same size.',
  'Report failures only with these codes. Critical: structure_changed (building geometry, windows, doors, roofline or materials changed), wrong_property (a different building), neighbor_decorated (decor added to a neighboring building), access_blocked (doors, steps or walkways obstructed), privacy_regression (a blurred face, plate or house made clearer or reconstructed), people_altered, text_added (new or altered text, including house numbers), unsafe_or_offensive, camera_changed (framing, crop or perspective shifted), attribution_altered (burned-in attribution cropped, covered or altered).',
  'Major: unrequested_change (any change to what belongs to the home or the scene: an object removed, replaced, moved or restyled, repainting, landscaping, added snow or a season change, a changed sky, vehicles or bins changed, or any addition that is not a decoration), plan_not_followed (a key planned item is missing, the decorations are of the wrong kind, holiday or style, or clearly fewer than planned), implausible_decor (floating, wrong scale, unsupported attachment), lighting_implausible (glow without a source, lit windows that do not exist, neighbors lit).',
  'Plan adherence is about the kinds and counts of decorations in sensible places, not exact positions: a planned item placed in a different natural spot (for example two potted trees flanking the door instead of beside the steps) is present and is not plan_not_followed.',
  'Additional decorations of the requested holiday and style in sensible places (for example matching garlands over more windows than planned) are expected: they are neither unrequested_change nor plan_not_followed; judge them only for implausible_decor and access_blocked. A decoration that replaces or covers up an object of the home (an urn, a planter, a vase, furniture) is still unrequested_change.',
  'Give every code an evidence sentence and a confidence from 0 to 1; add a box when it helps. For each planned placement report whether it is present (anywhere sensible in the image), and whether its category, color family, count and scale match the plan. Score realism, appeal and plan adherence from 1 to 5.',
  COORDINATES,
].join('\n');

/** Judge system prompt for relight mode (cacheable). */
export const JUDGE_RELIGHT_SYSTEM_PROMPT = [
  'You are the quality judge for relit home photographs. Image 1 is a decorated photograph in daylight (the base); image 2 is the candidate, which must be the same photograph with only the light changed to the requested time of day.',
  'Light may change: sky color and brightness, ambient exposure, shadows, the glow of lights that exist in image 1 (string lights, lanterns, candles, porch and window lights) and the light they cast on nearby surfaces. Nothing else may change.',
  'Report failures only with these codes. Critical: structure_changed (anything other than light changed: building geometry, windows, doors, roofline, materials or paint; any object, plant, furniture or decoration added, removed, moved, replaced or restyled), camera_changed (framing, crop or perspective shifted), wrong_property, neighbor_decorated, access_blocked, privacy_regression (a blurred face, plate or house made clearer or reconstructed), people_altered, text_added (new or altered text, including house numbers), unsafe_or_offensive, attribution_altered (burned-in attribution cropped, covered or altered).',
  'Major: lighting_implausible (glow without a source, lit windows that do not exist, neighbors lit, light that contradicts the time of day, flat or painted-looking light patches), plan_not_followed (decorations that should be switched on are not glowing), unrequested_change (added snow, fog or season change).',
  'Give every code an evidence sentence and a confidence from 0 to 1; add a box when it helps. For each listed decoration report whether it is still present where it is in image 1, and whether its category, color family, count and scale are unchanged. Score realism, appeal and plan adherence from 1 to 5.',
  COORDINATES,
].join('\n');

/** Display names of the holidays, for the judge's statement of what was requested. */
const HOLIDAY_WORDS: Readonly<Record<HolidayId, string>> = {
  halloween: 'Halloween',
  thanksgiving_us: 'Thanksgiving',
  christmas: 'Christmas',
  new_years_eve: "New Year's Eve",
};

/** Position words for a placement region (horizontal and vertical thirds). */
function positionWords(box: [number, number, number, number]): string {
  const thirds = boxThirds(box);
  return `${thirds.vertical} ${thirds.horizontal} of the image`;
}

const BLUR_WORDS: Readonly<Record<string, string>> = {
  face: 'a blurred face',
  plate: 'a blurred license plate',
  house: 'a blurred house',
  other: 'a blurred area',
};

/** Preserve-region kinds the judge inspects, with what they are and the code a change earns. */
const PRESERVE_SPOTS: Readonly<Record<string, { words: string; code: string }>> = {
  house_number: { words: 'a house number', code: 'text_added' },
  sign: { words: 'a sign', code: 'text_added' },
  logo: { words: 'a logo or burned-in mark', code: 'text_added' },
  existing_decor: { words: 'an existing decoration', code: 'unrequested_change' },
  vehicle: { words: 'a vehicle', code: 'unrequested_change' },
};

/**
 * The protected spots of a plan the judge must inspect, each with its kind, its position and the
 * code to report when it changed: people and blurred regions, house numbers, signs, logos,
 * existing decorations and vehicles, access regions and the embedded attribution. Kinds and
 * positions only; never an address or any user text.
 */
export function protectedSpotLines(preserve: DecorationPlan['preserve']): string[] {
  const lines: string[] = [];
  const spot = (words: string, box: NormalizedBox, instruction: string) =>
    lines.push(`- ${words} (${positionWords(box)}): ${instruction}.`);
  for (const box of preserve.peopleBoxes) {
    spot('a person', box, 'must stay unchanged; report people_altered if not');
  }
  for (const region of preserve.protectedBlurRegions) {
    spot(
      BLUR_WORDS[region.kind] ?? 'a blurred area',
      region.box,
      'must stay blurred and unchanged; report privacy_regression if it is clearer or reconstructed',
    );
  }
  for (const region of preserve.regions) {
    const known = PRESERVE_SPOTS[region.kind];
    if (!known) continue;
    spot(known.words, region.box, `must stay unchanged; report ${known.code} if not`);
  }
  for (const region of preserve.accessRegions) {
    spot(
      `the ${region.kind.replace(/_/g, ' ')}`,
      region.box,
      'must stay clear; report access_blocked if decor obstructs it',
    );
  }
  const attribution =
    preserve.attributionRegions ?? (preserve.attributionRegion ? [preserve.attributionRegion] : []);
  for (const box of attribution) {
    spot(
      'the burned-in imagery attribution',
      box,
      'must stay exactly as in the original; report attribution_altered if it is covered, cropped or changed',
    );
  }
  return lines;
}

/** The judge's system prompt for a mode. */
export function judgeSystemPrompt(mode: 'decorate' | 'relight' = 'decorate'): string {
  return mode === 'relight' ? JUDGE_RELIGHT_SYSTEM_PROMPT : JUDGE_SYSTEM_PROMPT;
}

/**
 * The per-call judge instruction built from the plan; it contains no address or user text. In
 * relight mode the plan's placements are the decorations of the base image, which must all stay,
 * and the requested light is always early evening (a relight only ever produces the evening
 * variant), whatever lighting mode the plan carries.
 */
export function judgeUserPrompt(
  plan: DecorationPlan,
  hints: readonly string[] = [],
  options: { mode?: 'decorate' | 'relight' } = {},
): string {
  const relight = options.mode === 'relight';
  const lines = relight
    ? [
        `Scene type: ${plan.sceneType}. Requested light: early evening at dusk, with the decorations that are switched on glowing, warm light in the existing windows and the porch light on.`,
        'A darker sky, lower ambient exposure and the glow of existing lights are expected and are not changes to report.',
        'Decorations in image 1 (each must still be there, unchanged, wherever it is in image 1):',
        ...plan.placements.map(
          (placement) =>
            `- ${placement.id}: ${placement.count} x ${placement.specText}${placement.lit ? ', switched on (should glow)' : ''}.`,
        ),
      ]
    : [
        `Scene type: ${plan.sceneType}. Lighting mode: ${plan.lightingMode}.`,
        `Requested decorations: ${HOLIDAY_WORDS[plan.holidayId]}, ${plan.style} style.`,
        plan.lightingMode === 'evening'
          ? 'An evening relight is expected: a darker sky and lower ambient exposure are not changes to report.'
          : 'The lighting, sky and time of day should match the original.',
        'Planned placements (the kinds and counts matter: each must be present; a different natural spot is fine, and so are additional decorations of the requested holiday and style in sensible places):',
        ...plan.placements.map(
          (placement) =>
            `- ${placement.id}: ${placement.count} x ${placement.specText} (${placement.placementRule} the ${placement.anchorCategory.replace(/_/g, ' ')}, ${positionWords(placement.region)})${placement.lit ? ', switched on' : ''}.`,
        ),
      ];
  lines.push(`Must not appear: ${plan.negatives.join(', ') || 'none listed'}.`);
  const spots = protectedSpotLines(plan.preserve);
  if (spots.length > 0) lines.push('Protected spots to inspect:', ...spots);
  if (hints.length > 0) {
    lines.push(
      `Deterministic check hints (a change described as restored from the original was already put back in image 2 and is not a failure; a change described as inside the kept decorations is still in image 2: inspect it and report unrequested_change or structure_changed if it changed what belongs to the home): ${hints.join('; ')}.`,
    );
  }
  return lines.join('\n');
}

/** Localization system prompt (cacheable; contains no holiday, address or user text). */
export const LOCALIZE_SYSTEM_PROMPT = [
  'You compare two photographs of a home to find what an AI image editor added. Image 1 is the original photograph; image 2 is the edited photograph, aligned to image 1 at the same size.',
  'added: every decoration present in image 2 and absent from image 1 (wreaths, garlands, string lights, bows, trees, planters and urns, lanterns, candles, pumpkins, ornaments, table settings and similar), including its visible lights and the glow they cast on nearby surfaces. Give each item one tight box in image 2 coordinates covering the whole item.',
  'Split an item that turns a corner or runs along several edges (a garland up a column and along a rail, lights along two roof sections) into several boxes so each box stays tight; repeat its label and placementId on every part.',
  'placementId: when the item realizes one of the planned placements listed in the request, that placement id, even when it sits in a different spot than planned; several items may share one id (a pair of potted trees). Use null for an item that matches no planned placement.',
  'otherChanges: everything else that differs between the images: an object moved, removed, replaced or restyled; architecture, materials, paint, plants or landscaping changed; a light switched on that is not a decoration; camera or framing shifted. One short description and one box each (in image 2 coordinates; for a moved object, a box covering where it was and where it is). Empty when nothing else changed.',
  'Never box an object that was already in image 1 as added, even when it changed; report it under otherChanges. Ignore differences in compression noise, sharpness and overall exposure. Report only what is visible.',
  COORDINATES,
].join('\n');

/** One planned placement offered to the localizer. */
export interface LocalizePromptPlacement {
  id: string;
  kitItemId: string;
  region: NormalizedBox;
  specText?: string;
}

/** The per-call localization request: the planned placements as hints (kinds and positions only). */
export function localizeUserPrompt(placements: readonly LocalizePromptPlacement[]): string {
  if (placements.length === 0) {
    return 'No placements were planned; report every added decoration with placementId null.';
  }
  return [
    'Planned placements (hints for placementId; the editor may have put an item elsewhere, and may have added items that are not listed):',
    ...placements.map(
      (placement) =>
        `- ${placement.id}: ${placement.specText ?? placement.kitItemId.replace(/_/g, ' ')} (planned in the ${positionWords(placement.region)}).`,
    ),
    'Report every added decoration, listed or not.',
  ].join('\n');
}

/** Upload triage system prompt (cacheable). */
export const TRIAGE_SYSTEM_PROMPT = [
  'You triage a photo a person uploaded to see their own home decorated.',
  'subjectClass is living_space when the subject is a home exterior, an apartment entry, a balcony or a room; people when people are the subject; document_or_screen for documents, IDs, mail or screens; other for vehicles, animals, food, landscapes, artwork or text.',
  'Choose the scene type (house_exterior, apartment_entry, balcony, interior) with a confidence, and the building form or room type with a confidence. Set multiUnitFacade when the subject is a whole multi-unit building facade.',
  'Report quality flags, existing decorations (none, or a holiday guess with density) and season cues. Return people boxes only; never estimate age or identity.',
  COORDINATES,
].join('\n');
