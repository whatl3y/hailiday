import { SURFACE_ANCHOR_CATEGORIES, anchorCategoriesForSceneType, boxThirds } from '@hailiday/core';
import type {
  AnchorCategory,
  DecorationPlan,
  HolidayId,
  NormalizedBox,
  RelightLightingMode,
  SceneType,
  SourceKind,
} from '@hailiday/core';
import type { EnhanceJudgeInput } from '../types.js';

/** Prompt versions, recorded with every call. */
export const ANALYSIS_PROMPT_VERSION = 'analysis-2026.11.2';
export const JUDGE_PROMPT_VERSION = 'judge-2026.11.10';
export const TRIAGE_PROMPT_VERSION = 'triage-2026.11.0';
export const LOCALIZE_PROMPT_VERSION = 'localize-2026.11.0';
export const FRAME_PROMPT_VERSION = 'frame-2026.11.0';

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

/**
 * Which home a Street View frame is aimed at. The scene analysis and the call that frames the
 * home share it, so both find the same home.
 */
export const STREET_VIEW_TARGET_HOME =
  'the home this frame is aimed at. It is the residential facade containing the horizontal center of the frame at mid-height. When the center falls beside a home instead (on its driveway, yard, fence, garage or the gap next to it), the target is the residential facade nearest to the center, as long as that facade is clearly the main building in the frame.';

/** A Street View frame without a target home. */
export const STREET_VIEW_NO_TARGET = 'no residential facade is in frame';

/** When a Street View frame's target home cannot be told apart from a neighbor. */
export const STREET_VIEW_TARGET_UNCLEAR =
  'the center falls on the boundary between two attached or closely neighboring facades, or when two facades are about equally near the center and about equally prominent';

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
        ? `Target facade: ${STREET_VIEW_TARGET_HOME} Omit targetFacade and set targetFacadeAmbiguous to true only when ${STREET_VIEW_NO_TARGET}, when ${STREET_VIEW_TARGET_UNCLEAR}. For attached houses the target spans only the unit nearest the center.`
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

/**
 * When a decoration on steps or a path blocks the way, in decorate mode: people set lanterns and
 * planters at the edges of their steps, which narrows them without closing them.
 */
export const ACCESS_EDGE_RULE =
  'A decoration standing at the outer edge of a step, landing or path is access_blocked only when it leaves less than about two thirds of the width clear or stands in the walking line or in front of a door; at the edge with the middle clear it is not.';

/** Judge system prompt for decorate mode (cacheable). */
export const JUDGE_SYSTEM_PROMPT = [
  'You are the quality judge for AI-decorated home photographs. Image 1 is the original; image 2 is the decorated candidate at the same size.',
  'Report failures only with these codes. Critical: structure_changed (building geometry, windows, doors, roofline or materials changed), wrong_property (a different building), neighbor_decorated (decor added to a neighboring building), access_blocked (doors, steps or walkways obstructed), privacy_regression (a blurred face, plate or house made clearer or reconstructed), people_altered, text_added (new or altered text, including house numbers), unsafe_or_offensive, camera_changed (framing, crop or perspective shifted), attribution_altered (burned-in attribution cropped, covered or altered).',
  'Major: unrequested_change (any change to what belongs to the home or the scene: an object removed, replaced, moved or restyled, repainting, landscaping, added snow or a season change, a changed sky, vehicles or bins changed, or any addition that is not a decoration), plan_not_followed (a key planned item is missing, the decorations are of the wrong kind, holiday or style, or clearly fewer than planned), implausible_decor (floating, wrong scale, unsupported attachment), lighting_implausible (glow without a source, lit windows that do not exist, neighbors lit).',
  'Plan adherence is about the kinds and counts of decorations in sensible places, not exact positions: a planned item placed in a different natural spot (for example two potted trees flanking the door instead of beside the steps) is present and is not plan_not_followed.',
  'Additional decorations of the requested holiday and style in sensible places (for example matching garlands over more windows than planned) are expected: they are neither unrequested_change nor plan_not_followed; judge them only for implausible_decor and access_blocked. A decoration that replaces or covers up an object of the home (an urn, a planter, a vase, furniture) is still unrequested_change, unless the instructions for this photo allow that swap.',
  ACCESS_EDGE_RULE,
  'Give every code an evidence sentence and a confidence from 0 to 1; add a box when it helps. For each planned placement report whether it is present (anywhere sensible in the image), and whether its category, color family, count and scale match the plan. Score realism, appeal and plan adherence from 1 to 5.',
  COORDINATES,
].join('\n');

/**
 * The attribution code of the relight judge prompts: in a relit look the logo and copyright at a
 * listed attribution spot keep their pixels while the ground behind them follows the new light,
 * which is not a failure; a faint watermark elsewhere in the picture is repainted by any relight,
 * so it is not attribution and its loss is not reported.
 */
const RELIGHT_ATTRIBUTION_CODE =
  "attribution_altered (the map provider's logo or copyright text at a listed attribution spot missing, illegible, covered, cropped, moved or redrawn; the background behind it following the new light is expected; a faint, semi-transparent watermark of the provider elsewhere in the picture, for example in the sky, is not attribution: a relight repaints it and its loss is never reported)";

/** The relight judge's instruction for an attribution rectangle. */
const RELIGHT_ATTRIBUTION_SPOT =
  "the map provider's logo and copyright text here must stay exactly as in image 1 (same letters, shape and position, still bright and legible); the ground behind them follows the new light, which is expected; report attribution_altered only if the logo or the text is missing, illegible, covered, cropped, moved or redrawn";

/** Judge system prompt for relight mode, evening target (cacheable). */
export const JUDGE_RELIGHT_SYSTEM_PROMPT = [
  'You are the quality judge for relit home photographs. Image 1 is a decorated photograph in daylight (the base); image 2 is the candidate, which must be the same photograph with only the light changed to the requested time of day.',
  'Light may change: sky color and brightness, ambient exposure, shadows, the glow of lights that exist in image 1 (string lights, lanterns, candles, porch and window lights) and the light they cast on nearby surfaces. Nothing else may change.',
  'Report failures only with these codes. Critical: structure_changed (anything other than light changed: building geometry, windows, doors, roofline, materials or paint; any object, plant, furniture or decoration added, removed, moved, replaced or restyled), camera_changed (framing, crop or perspective shifted), wrong_property, neighbor_decorated, access_blocked, privacy_regression (a blurred face, plate or house made clearer or reconstructed), people_altered, text_added (new or altered text, including house numbers), unsafe_or_offensive, ' +
    `${RELIGHT_ATTRIBUTION_CODE}.`,
  'Major: lighting_implausible (glow without a source, lit windows that do not exist, neighbors lit, light that contradicts the time of day, flat or painted-looking light patches), plan_not_followed (decorations that should be switched on are not glowing), unrequested_change (added snow, fog or season change).',
  'Give every code an evidence sentence and a confidence from 0 to 1; add a box when it helps. For each listed decoration report whether it is still present where it is in image 1, and whether its category, color family, count and scale are unchanged. Score realism, appeal and plan adherence from 1 to 5.',
  COORDINATES,
].join('\n');

/** Judge system prompt for relight mode, bright target (cacheable). */
export const JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT = [
  'You are the quality judge for relit home photographs. Image 1 is a decorated photograph (the base); image 2 is the candidate, which must be the same photograph with only the light changed to the bright look: the space bright, airy and cheerful, as on a sunny day with every light on.',
  "Light is expected to change: brighter, fuller light; the existing lamps, ceiling lights and fixtures switched on; daylight in the windows (the view outside a window may turn from night to day); lifted shadows; a fresher, natural white balance; the decorations' lights still glowing and the light they cast on nearby surfaces. None of this is a change to report. Nothing else may change.",
  'Report failures only with these codes. Critical: structure_changed (anything other than light changed: any object, decoration, piece of furniture, door, wall, floor, fixture, window or architectural detail added, removed, moved, replaced or restyled, or its shape, material or color changed), camera_changed (framing, crop, lens or perspective shifted), wrong_property, neighbor_decorated, access_blocked, privacy_regression (a blurred face, plate or house made clearer or reconstructed), people_altered, text_added (new or altered text, including house numbers), unsafe_or_offensive, ' +
    `${RELIGHT_ATTRIBUTION_CODE}.`,
  'Major: lighting_implausible (blown-out highlights, haze, a flat or painted look, glow without a source, or light that is not brighter than in image 1), plan_not_followed (decorations that should be switched on are not glowing), unrequested_change (added snow, fog or season change).',
  'Give every code an evidence sentence and a confidence from 0 to 1; add a box when it helps. For each listed decoration report whether it is still present where it is in image 1, and whether its category, color family, count and scale are unchanged. Score realism, appeal and plan adherence from 1 to 5.',
  COORDINATES,
].join('\n');

/** The light a relight judge checks for: the plan's lighting mode, `evening` unless `bright`. */
export function relightJudgeTarget(
  plan: Pick<DecorationPlan, 'lightingMode'>,
): RelightLightingMode {
  return plan.lightingMode === 'bright' ? 'bright' : 'evening';
}

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

/**
 * A house number, sign or logo in decorate mode: the composite keeps the editor's pixels around
 * (and over) a mark a decoration covers, so the judge guards its text rather than its pixels.
 */
const DECORATE_TEXT_MARK_SPOT =
  'its text must stay exactly as in image 1, and readable wherever it is readable there; a decoration beside or around it and the light or shadow the decorations cast on it are expected; report text_added if readable text is altered, replaced, covered or missing; a mark too small to read in image 1 may be covered by a decoration';

/**
 * What the judge is told about swaps outside a house, in decorate mode: a decoration of the look
 * may take the place of a removable seasonal item at its spot. Everything fixed, built, parked
 * or growing in the ground is still protected.
 */
export const OUTDOOR_SWAPS =
  'Outdoors a decoration of the requested holiday may take the place of a removable seasonal item at the same spot: an existing wreath or door hanger, a potted plant, flower pot, planter or urn, a hanging basket, a seasonal flag or a doormat. That swap is expected and is not unrequested_change, also for an item listed below as an existing decoration. Furniture, fixtures, mailboxes, anything built, vehicles, bins and plants growing in the ground are still unrequested_change when removed, replaced, moved or covered, and so is a removable item taken away with no decoration in its place.';

/**
 * An existing decoration outside a house in decorate mode: the swap is expected only for the
 * removable seasonal items `OUTDOOR_SWAPS` names.
 */
export const OUTDOOR_EXISTING_DECOR_SPOT =
  'if it is such an item (one of the removable seasonal items named above), a decoration of the requested holiday may take its place and that swap is expected; otherwise it must stay unchanged; report unrequested_change if it is gone with no decoration in its place, or changed in any other way';

/** Preserve-region kinds whose text the judge guards. */
const TEXT_MARK_KINDS: readonly string[] = ['house_number', 'sign', 'logo'];

/** Preserve-region kinds the judge inspects, with what they are and the code a change earns. */
const PRESERVE_SPOTS: Readonly<Record<string, { words: string; code: string }>> = {
  house_number: { words: 'a house number', code: 'text_added' },
  sign: { words: 'a sign', code: 'text_added' },
  logo: { words: 'a logo or burned-in mark', code: 'text_added' },
  existing_decor: { words: 'an existing decoration', code: 'unrequested_change' },
  vehicle: { words: 'a vehicle', code: 'unrequested_change' },
};

/**
 * Preserve-region kinds that, in relight mode, are left to the attribution line when they lie
 * mostly inside an attribution rectangle (the burned-in logo recorded as a logo or a sign).
 */
const ATTRIBUTION_GOVERNED_KINDS: readonly string[] = ['logo', 'sign'];

/** Whether more than half of the area of `region` lies inside `container`. */
function mostlyInside(region: NormalizedBox, container: NormalizedBox): boolean {
  const area = (region[2] - region[0]) * (region[3] - region[1]);
  if (!(area > 0)) return false;
  const width = Math.min(region[2], container[2]) - Math.max(region[0], container[0]);
  const height = Math.min(region[3], container[3]) - Math.max(region[1], container[1]);
  return width > 0 && height > 0 && width * height > area / 2;
}

/**
 * The protected spots of a plan the judge must inspect, each with its kind, its position and the
 * code to report when it changed: people and blurred regions, house numbers, signs, logos,
 * existing decorations and vehicles, access regions and the embedded attribution (in relight mode
 * the attribution's ground may follow the new light; its logo and text may not change). In
 * decorate mode a house number, sign or logo keeps its text and legibility while decorations may
 * stand beside or around it; in relight mode it must stay unchanged, except that a logo or sign
 * lying mostly inside an attribution rectangle gets no line of its own there (the attribution
 * line governs that spot). Kinds and positions only; never an address or any user text.
 */
export function protectedSpotLines(
  preserve: DecorationPlan['preserve'],
  mode: 'decorate' | 'relight' = 'decorate',
  options: { outdoorSwaps?: boolean } = {},
): string[] {
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
  const attribution =
    preserve.attributionRegions ?? (preserve.attributionRegion ? [preserve.attributionRegion] : []);
  for (const region of preserve.regions) {
    const known = PRESERVE_SPOTS[region.kind];
    if (!known) continue;
    if (
      mode === 'relight' &&
      ATTRIBUTION_GOVERNED_KINDS.includes(region.kind) &&
      attribution.some((box) => mostlyInside(region.box, box))
    ) {
      continue;
    }
    spot(
      known.words,
      region.box,
      mode === 'decorate' && TEXT_MARK_KINDS.includes(region.kind)
        ? DECORATE_TEXT_MARK_SPOT
        : mode === 'decorate' && region.kind === 'existing_decor' && options.outdoorSwaps
          ? OUTDOOR_EXISTING_DECOR_SPOT
          : `must stay unchanged; report ${known.code} if not`,
    );
  }
  for (const region of preserve.accessRegions) {
    spot(
      `the ${region.kind.replace(/_/g, ' ')}`,
      region.box,
      'must stay clear; report access_blocked if decor obstructs it',
    );
  }
  for (const box of attribution) {
    spot(
      'the burned-in imagery attribution',
      box,
      mode === 'relight'
        ? RELIGHT_ATTRIBUTION_SPOT
        : 'must stay exactly as in the original; report attribution_altered if it is covered, cropped or changed',
    );
  }
  return lines;
}

/**
 * The attribution code of the enhance judge prompt: the logo and copyright at a listed
 * attribution spot keep the frame's strokes while the ground behind them follows the new tone; a
 * faint watermark elsewhere is repainted by any enhancement, so its loss is not reported.
 */
export const ENHANCE_ATTRIBUTION_CODE =
  "attribution_altered (the map provider's logo or copyright text at a listed attribution spot missing, illegible, covered, cropped, moved or redrawn; the background behind it following the new tone is expected; a faint, semi-transparent watermark of the provider elsewhere in the picture, for example in the sky or on the road, is not attribution: an enhancement repaints it and its loss is never reported)";

/** Judge system prompt for enhance mode: a Street View frame redrawn sharper (cacheable). */
export const JUDGE_ENHANCE_SYSTEM_PROMPT = [
  'You are the quality judge for enhanced street photographs of homes. Image 1 is the original street-level photograph: low resolution, often soft, hazy or smeared. Image 2 is the candidate, which must be the same photograph of the same place at the same moment with only its image quality improved.',
  'Image quality may change: sharper fine detail, texture where image 1 is smeared, cleaner and more natural color, contrast and exposure, less haze, blur, noise and compression artifacts, capture seams removed, and a clearer sky of the same weather and time of day (a washed-out, hazy or overexposed sky may turn blue). None of this is a change to report. Nothing else may change.',
  'Judge things, not pixels. Leaves, grass, gravel, shingles, bricks and cloud wisps are drawn anew by any enhancement and are never a failure. A thing has changed when a person comparing the two pictures would name it: something present in one and not in the other, something in another place, a window with another shape or number of panes, another door, another roof line, another color or material, a sign that reads differently.',
  'Report failures only with these codes. Critical: structure_changed (a building, window, door, roof, wall, material or color changed; or any object, plant, tree, vehicle, piece of furniture or existing decoration added, removed, moved, replaced or restyled), wrong_property (the home is no longer recognizably the same building), camera_changed (framing, crop, lens or perspective shifted), privacy_regression (a blurred or pixelated face, license plate, house or area made clearer or reconstructed), people_altered (a person added, removed or changed), text_added (a house number, sign, plate or other lettering that reads differently than in image 1, new lettering, or readable characters where image 1 cannot be read), unsafe_or_offensive, ' +
    `${ENHANCE_ATTRIBUTION_CODE}.`,
  'Major: unrequested_change (another season, weather or time of day; snow, fog, rain, leaves or flowers added or removed; a sky of another kind, for example clouds where image 1 is clear), lighting_implausible (sunlight from another direction, shadows removed or invented, or an artificial, over-processed or painted look).',
  'Give every code an evidence sentence and a confidence from 0 to 1; add a box when it helps. Return an empty placements list. Score realism and appeal from 1 to 5; score planAdherence 5 when nothing but the image quality changed and lower the more the scene itself changed.',
  COORDINATES,
].join('\n');

/** A protected spot of an enhancement that shows the frame's own pixels again. */
const ENHANCE_RESTORED = "shows image 1's own pixels again";

/** Preserve-region kinds the enhance judge inspects, with their instruction. */
const ENHANCE_SPOTS: Readonly<Record<string, { words: string; instruction: string }>> = {
  house_number: {
    words: 'a house number',
    instruction: `${ENHANCE_RESTORED}; report text_added if it reads differently than in image 1`,
  },
  sign: {
    words: 'a sign',
    instruction: `${ENHANCE_RESTORED}; report text_added if it reads differently than in image 1`,
  },
  logo: {
    words: 'a logo or burned-in mark',
    instruction: `${ENHANCE_RESTORED}; report text_added if it reads differently than in image 1`,
  },
  existing_decor: {
    words: 'an existing decoration',
    instruction: 'must stay the same thing in the same place; report structure_changed if not',
  },
  vehicle: {
    words: 'a vehicle',
    instruction: 'must stay the same thing in the same place; report structure_changed if not',
  },
};

/** The enhance judge's instruction for an attribution rectangle. */
const ENHANCE_ATTRIBUTION_SPOT =
  "the map provider's logo and copyright text here must stay exactly as in image 1 (same letters, shape and position, still bright and legible); the ground behind them follows the new tone, which is expected; report attribution_altered only if the logo or the text is missing, illegible, covered, cropped, moved or redrawn";

/**
 * The per-call enhance judge instruction: the scene type, what was requested, and the protected
 * spots (people, blurred areas, house numbers, signs and logos, which show the frame's own pixels
 * again; existing decorations and vehicles, which must stay; the embedded attribution). A logo or
 * sign lying mostly inside an attribution rectangle is left to the attribution line; access and
 * `other` regions get no line. Kinds and positions only; never an address or any user text.
 */
export function judgeEnhanceUserPrompt(
  input: Pick<EnhanceJudgeInput, 'sceneType' | 'preserve'>,
): string {
  const { preserve } = input;
  const spots: string[] = [];
  const spot = (words: string, box: NormalizedBox, instruction: string) =>
    spots.push(`- ${words} (${positionWords(box)}): ${instruction}.`);
  for (const box of preserve.peopleBoxes) {
    spot(
      'a person',
      box,
      `${ENHANCE_RESTORED}; report people_altered if the person is changed, removed or redrawn`,
    );
  }
  for (const region of preserve.protectedBlurRegions) {
    spot(
      BLUR_WORDS[region.kind] ?? 'a blurred area',
      region.box,
      `${ENHANCE_RESTORED}; report privacy_regression if it is clearer or reconstructed`,
    );
  }
  const attribution = preserve.attributionRegions ?? [];
  for (const region of preserve.regions) {
    const known = ENHANCE_SPOTS[region.kind];
    if (!known) continue;
    if (
      ATTRIBUTION_GOVERNED_KINDS.includes(region.kind) &&
      attribution.some((box) => mostlyInside(region.box, box))
    ) {
      continue;
    }
    spot(known.words, region.box, known.instruction);
  }
  for (const box of attribution) {
    spot('the burned-in imagery attribution', box, ENHANCE_ATTRIBUTION_SPOT);
  }
  const lines = [
    `Scene type: ${input.sceneType}. Requested change: image quality only. Image 2 must show the same place at the same moment as image 1: sharper, cleaner and better exposed, with nothing else different.`,
  ];
  if (spots.length > 0) {
    lines.push(
      'Protected spots to inspect:',
      ...spots,
      "Spots that show image 1's own pixels again look softer than their surroundings; that is expected and is not a failure.",
    );
  }
  return lines.join('\n');
}

/**
 * The judge hint for a house number, sign or logo whose box keeps the editor's pixels in the
 * composite (a decoration covers it): its kind and position, never its text.
 */
export function openTextMarkHint(kind: string, box: NormalizedBox): string {
  const words = PRESERVE_SPOTS[kind]?.words ?? 'a mark';
  return `${words} (${positionWords(box)}) keeps the edited pixels: compare its text with image 1`;
}

/** The judge's system prompt for a mode and, in relight mode, its target light. */
export function judgeSystemPrompt(
  mode: 'decorate' | 'relight' = 'decorate',
  target: RelightLightingMode = 'evening',
): string {
  if (mode !== 'relight') return JUDGE_SYSTEM_PROMPT;
  return target === 'bright' ? JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT : JUDGE_RELIGHT_SYSTEM_PROMPT;
}

/**
 * The per-call judge instruction built from the plan; it contains no address or user text. In
 * relight mode the plan's placements are the decorations of the base image, which must all stay,
 * and the requested light follows the relight plan's lighting mode: the bright look for `bright`,
 * otherwise early evening.
 */
export function judgeUserPrompt(
  plan: DecorationPlan,
  hints: readonly string[] = [],
  options: { mode?: 'decorate' | 'relight' } = {},
): string {
  const relight = options.mode === 'relight';
  const bright = relight && relightJudgeTarget(plan) === 'bright';
  const lines = relight
    ? [
        ...(bright
          ? [
              `Scene type: ${plan.sceneType}. Requested light: the bright look, bright, airy and cheerful as on a sunny day with every light on: fuller soft daylight, the existing lamps and fixtures on with a clean warm glow, shadows lifted and the decorations that are switched on still glowing.`,
              'Brighter light, lamps and fixtures switched on, daylight in the windows (the view outside a window may turn from night to day) and lifted shadows are expected and are not changes to report.',
            ]
          : [
              `Scene type: ${plan.sceneType}. Requested light: early evening at dusk, with the decorations that are switched on glowing, warm light in the existing windows and the porch light on.`,
              'A darker sky, lower ambient exposure and the glow of existing lights are expected and are not changes to report.',
            ]),
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
  const outdoorSwaps = !relight && plan.sceneType === 'house_exterior';
  if (outdoorSwaps) lines.push(OUTDOOR_SWAPS);
  const spots = protectedSpotLines(plan.preserve, relight ? 'relight' : 'decorate', {
    outdoorSwaps,
  });
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

/**
 * System prompt of the call that locates the home a Street View frame is aimed at, so that the
 * frame can be fetched again showing just that home (cacheable; contains no address or user text).
 */
export const FRAME_SYSTEM_PROMPT = [
  'You find the home a street-level photograph is aimed at, so that a closer photograph of just that home can be taken from the same spot.',
  `Target home: ${STREET_VIEW_TARGET_HOME}`,
  'home: one tight box around the whole visible building of the target home, from the top of its roof (chimney included) down to where the building meets the ground, with its porch, entry steps and an attached garage. Leave out the lawn, driveway, walkway, sidewalk, street, trees, shrubs, fences, vehicles and every neighboring building. Where a tree or shrub in front hides part of the home, the box still covers the part of the home behind it. For attached homes the box spans only the target unit.',
  `When ${STREET_VIEW_NO_TARGET}, set home to null and ambiguous to false. Set ambiguous to true, with home null, only when ${STREET_VIEW_TARGET_UNCLEAR}. Otherwise set ambiguous to false.`,
  'confidence: from 0 to 1, how sure you are that the box holds the target home and all of it.',
  COORDINATES,
].join('\n');

/** The per-call instruction of the call that locates the home. */
export const FRAME_USER_PROMPT = 'Locate the target home in this frame.';

/** Upload triage system prompt (cacheable). */
export const TRIAGE_SYSTEM_PROMPT = [
  'You triage a photo a person uploaded to see their own home decorated.',
  'subjectClass is living_space when the subject is a home exterior, an apartment entry, a balcony or a room; people when people are the subject; document_or_screen for documents, IDs, mail or screens; other for vehicles, animals, food, landscapes, artwork or text.',
  'Choose the scene type (house_exterior, apartment_entry, balcony, interior) with a confidence, and the building form or room type with a confidence. Set multiUnitFacade when the subject is a whole multi-unit building facade.',
  'Report quality flags, existing decorations (none, or a holiday guess with density) and season cues. Return people boxes only; never estimate age or identity.',
  COORDINATES,
].join('\n');
