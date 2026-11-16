import type {
  AnchorCategory,
  AttachmentIntent,
  ForbiddenItem,
  NormalizedBox,
  PlacementRule,
  SceneType,
} from '@hailiday/core';
import { boxThirds } from '@hailiday/core';

/** Plain words for each anchor category, used in compiled sentences. */
export const ANCHOR_WORDS: Readonly<Record<AnchorCategory, string>> = {
  front_door: 'front door',
  door_frame: 'door frame',
  porch_rail: 'porch railing',
  porch_steps: 'entry steps',
  roofline: 'roofline',
  eaves: 'eaves',
  window_frame: 'front window',
  column: 'porch column',
  walkway_edge: 'walkway edge',
  planter: 'planter',
  lawn: 'front lawn',
  balcony_railing: 'balcony railing',
  balcony_floor: 'balcony floor',
  unit_door: 'unit door',
  banister: 'banister',
  mantel: 'mantel',
  dining_table: 'dining table',
  sideboard: 'sideboard',
  interior_window: 'window',
  wall: 'wall',
  floor_area: 'open floor',
  shelf: 'shelf',
};

/** Imperative verb per attachment intent. */
export const ATTACHMENT_VERBS: Readonly<Record<AttachmentIntent, string>> = {
  hung: 'Hang',
  wrapped: 'Wrap',
  draped: 'Drape',
  strung: 'String',
  standing: 'Stand',
  placed: 'Place',
  stretched: 'Stretch',
};

/** Relation words per placement rule. */
export const RULE_RELATIONS: Readonly<Record<PlacementRule, string>> = {
  centered_on: 'centered on',
  along: 'along',
  beside: 'beside',
  on_surface: 'on',
  cluster_at: 'at',
  hang_from: 'hanging from',
};

/** What the scope sentence calls the edited subject. */
export const SUBJECT_WORDS: Readonly<Record<SceneType, string>> = {
  house_exterior: 'house',
  apartment_entry: 'apartment entry',
  balcony: 'balcony',
  interior: 'room',
};

/** Anchors whose placements may extend below the target facade by the ground margin. */
export const GROUND_ANCHORS: readonly AnchorCategory[] = [
  'porch_steps',
  'walkway_edge',
  'planter',
  'lawn',
];

/** Area anchors: `beside` and `cluster_at` placements stay inside them. */
export const AREA_ANCHORS: readonly AnchorCategory[] = [
  'lawn',
  'planter',
  'balcony_floor',
  'floor_area',
  'wall',
];

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

export function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/** Position words for a region from its horizontal and vertical third. */
export function positionWords(region: NormalizedBox): string {
  const { horizontal, vertical } = boxThirds(region);
  if (vertical === 'middle' && horizontal === 'center') return 'in the center of the image';
  if (horizontal === 'center') return `in the ${vertical} middle of the image`;
  if (vertical === 'middle') return `on the ${horizontal} side of the image`;
  return `in the ${vertical} ${horizontal} of the image`;
}

/**
 * Negative phrases for forbidden items that describe something a model could add. Items that
 * describe changes (structure, landscaping, neighbors, access, house numbers) are expressed by the
 * preserve and protect blocks instead.
 */
export const FORBIDDEN_NEGATIVES: Readonly<Partial<Record<ForbiddenItem, string>>> = {
  people: 'people',
  pets: 'pets',
  text_or_signage: 'text or signage',
  brand_logos: 'brand logos',
  cartoon_or_licensed_characters: 'cartoon or licensed characters',
  mascots_and_inflatables: 'mascots or inflatables',
  snow_or_frost_unless_visible: 'snow or frost',
  sky_effects: 'fireworks or other sky effects',
  religious_symbols: 'religious symbols',
  open_flame_indoors: 'open flames',
  gore: 'gore',
  realistic_weapons: 'realistic weapons',
  costume_caricature: 'costumes or caricatures',
  new_structures: 'new structures',
};

/**
 * Patterns that reveal a forbidden item inside reviewed pack text (spec text and the scene
 * fragment). A match fails the plan: it is a content configuration error, never a model output.
 */
export const FORBIDDEN_PATTERNS: Readonly<Partial<Record<ForbiddenItem, RegExp>>> = {
  people: /\b(person|people|man|woman|men|women|child|children|kids?|santa|elf|elves|family)\b/i,
  pets: /\b(dogs?|cats?|pupp(y|ies)|kittens?|pets?)\b/i,
  text_or_signage: /\b(signs?|signage|lettering|letters|banners?|words|numerals|slogan)\b/i,
  religious_symbols: /\b(cross|crucifix|nativity|manger|angels?|menorah|star of david)\b/i,
  mascots_and_inflatables: /\b(inflatables?|mascots?)\b/i,
  cartoon_or_licensed_characters: /\b(cartoons?|characters?|licensed)\b/i,
  brand_logos: /\b(logos?|branded|brand)\b/i,
  gore: /\b(gore|gory|blood|bloody|severed|corpses?|entrails)\b/i,
  realistic_weapons: /\b(guns?|rifles?|pistols?|knives|knife|machetes?|swords?|axes?)\b/i,
  costume_caricature: /\b(pilgrims?|headdress(es)?|caricatures?|costumes?)\b/i,
  sky_effects: /\b(fireworks?|auroras?|meteors?|shooting stars?)\b/i,
  open_flame_indoors:
    /\b(open flames?|real candles?|wax candles? lit|burning candles?|torch(es)?)\b/i,
};

/** Snow, frost and icicle words; never compiled unless the source shows snow. */
export const SNOW_PATTERN = /\b(snow|snowy|snowfall|frost|frosted|frosty|icicles?)\b/i;

/** Normalized holiday words used to compare an existing-decoration guess with the holiday. */
export const HOLIDAY_GUESS_WORDS: Readonly<Record<string, readonly string[]>> = {
  halloween: ['halloween', 'spooky', 'jack'],
  thanksgiving_us: ['thanksgiving', 'harvest', 'autumn', 'fall'],
  christmas: ['christmas', 'xmas', 'winter holiday'],
  new_years_eve: ['new year', 'new_years', 'nye'],
};
