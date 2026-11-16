import type { HolidayId } from '@hailiday/core';

/** Decoration archetypes the fixture compositor can draw. */
export const DECOR_ARCHETYPES = [
  'string_lights',
  'garland',
  'wreath',
  'pumpkins',
  'carved_pumpkins',
  'cobweb',
  'potted_plant',
  'potted_plant_and_stalks',
  'stalk_bundle',
  'figure',
  'wall_decal',
  'potted_tree',
  'lantern',
  'table_linen',
  'centerpiece',
  'candles',
  'napkins',
  'arrangement',
  'tree',
  'stocking',
  'gift_wrap',
  'ornament_fill',
] as const;
export type DecorArchetype = (typeof DECOR_ARCHETYPES)[number];

/** Keyword rules from kit item IDs and spec text to archetypes, most specific first. */
const RULES: readonly [RegExp, DecorArchetype][] = [
  [/jack_o_lantern|carved/, 'carved_pumpkins'],
  [/mums_and_corn|mum.*corn/, 'potted_plant_and_stalks'],
  [/corn_stalk|stalk/, 'stalk_bundle'],
  [/skeleton|figure/, 'figure'],
  [/bat_|bats|wall_decal|silhouette/, 'wall_decal'],
  [/cobweb/, 'cobweb'],
  [/wreath/, 'wreath'],
  [/stocking/, 'stocking'],
  [/gift/, 'gift_wrap'],
  [/tree_prelit|christmas_tree|\.tree$|_tree_/, 'tree'],
  [/potted_evergreen|potted_tree/, 'potted_tree'],
  [/table_runner|runner|table_linen/, 'table_linen'],
  [/centerpiece/, 'centerpiece'],
  [/place_accents|napkin/, 'napkins'],
  [/ornament/, 'ornament_fill'],
  [/lantern/, 'lantern'],
  [/candle/, 'candles'],
  [/arrangement|sideboard_harvest/, 'arrangement'],
  [/string_lights|railing_lights|curtain_lights|_lights/, 'string_lights'],
  [/garland/, 'garland'],
  [/mum|potted_plant/, 'potted_plant'],
  [/pumpkin|gourd/, 'pumpkins'],
];

/**
 * The archetype to draw for a kit item: an explicit archetype wins when it is known, then the
 * kit item ID and spec text are matched against keyword rules.
 */
export function archetypeFor(
  kitItemId: string,
  specText = '',
  explicit?: string | null,
): DecorArchetype | null {
  if (explicit) {
    if ((DECOR_ARCHETYPES as readonly string[]).includes(explicit)) {
      return explicit as DecorArchetype;
    }
    const mapped = archetypeFor(explicit.toLowerCase());
    if (mapped) return mapped;
  }
  const key = kitItemId.toLowerCase();
  for (const [pattern, archetype] of RULES) if (pattern.test(key)) return archetype;
  const text = specText.toLowerCase();
  for (const [pattern, archetype] of RULES) if (pattern.test(text)) return archetype;
  return null;
}

/** Colors for one holiday's decorations. */
export interface HolidayPalette {
  bulbs: string[];
  glow: string;
  wire: string;
  foliage: string[];
  accents: string[];
  ribbon: string;
  ribbonShade: string;
  pumpkins: string[];
  flowers: string[];
  metal: string;
  linen: string;
  napkin: string;
  ornaments: string[];
}

export const HOLIDAY_PALETTES: Record<HolidayId, HolidayPalette> = {
  christmas: {
    bulbs: ['#FFE3A0', '#FFEBC0', '#FFDA8A'],
    glow: '#FFC56E',
    wire: '#1F3A24',
    foliage: ['#1E4A2A', '#285C33', '#2F6B3B', '#3A7A45', '#1A3F25'],
    accents: ['#B3122E', '#C9A227', '#7A4A2A'],
    ribbon: '#B3122E',
    ribbonShade: '#7E0C20',
    pumpkins: ['#E07A1F'],
    flowers: ['#B3122E', '#F1E9DA'],
    metal: '#1E1E1E',
    linen: '#9E1B2F',
    napkin: '#A8162C',
    ornaments: ['#B3122E', '#C9A227', '#E9DFC8', '#2E6B3E'],
  },
  halloween: {
    bulbs: ['#FF8A1E', '#A35BFF'],
    glow: '#FF9A3C',
    wire: '#151515',
    foliage: ['#1F1B1A', '#2E2724', '#C8561E', '#E07A1F', '#8E3B1A'],
    accents: ['#E8762C', '#6B3FA0', '#1A1A1A'],
    ribbon: '#E8762C',
    ribbonShade: '#A44F17',
    pumpkins: ['#E8762C', '#DB6A1F', '#F08A35', '#EFE7D6'],
    flowers: ['#B5502A', '#E0A53D', '#7B1E2B'],
    metal: '#151515',
    linen: '#2B2B2B',
    napkin: '#E8762C',
    ornaments: ['#E8762C', '#6B3FA0', '#1A1A1A'],
  },
  thanksgiving_us: {
    bulbs: ['#FFD58A'],
    glow: '#FFB85C',
    wire: '#4A3524',
    foliage: ['#B5502A', '#D07A2E', '#E0A53D', '#8A3B22', '#C9A13B', '#9C6A2A'],
    accents: ['#C8642A', '#EDE3CC', '#7B8B4A', '#D9A441'],
    ribbon: '#B89466',
    ribbonShade: '#8C6E45',
    pumpkins: ['#E07A1F', '#EFE7D6', '#D9952F', '#C8642A', '#8FA06A'],
    flowers: ['#B5502A', '#E0A53D', '#7B1E2B', '#D9792E'],
    metal: '#8C6A3A',
    linen: '#A4492A',
    napkin: '#C17A2E',
    ornaments: ['#C8642A', '#E0A53D', '#EDE3CC'],
  },
  new_years_eve: {
    bulbs: ['#FFF1C9', '#FFE7A8'],
    glow: '#FFDE96',
    wire: '#3A3324',
    foliage: ['#D4AF37', '#E8E8E8', '#C0C0C0', '#F5D76E', '#B8932E'],
    accents: ['#D4AF37', '#E5E4E2', '#FFFFFF'],
    ribbon: '#D4AF37',
    ribbonShade: '#9C7E22',
    pumpkins: ['#D4AF37'],
    flowers: ['#F5F1E6', '#D4AF37'],
    metal: '#B8963E',
    linen: '#D8C08A',
    napkin: '#F2ECDD',
    ornaments: ['#D4AF37', '#E5E4E2', '#FFFFFF', '#C0C0C0', '#F5D76E'],
  },
};

/** How strongly a style dresses each placement. */
export const STYLE_DENSITY = { subtle: 0.7, classic: 1, abundant: 1.35 } as const;
