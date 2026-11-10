import { z } from 'zod';

/** Holidays supported by the US Release catalog. */
export const HOLIDAY_IDS = ['halloween', 'thanksgiving_us', 'christmas', 'new_years_eve'] as const;
export const HolidayIdSchema = z.enum(HOLIDAY_IDS);
export type HolidayId = z.infer<typeof HolidayIdSchema>;

/** The kind of space a source photo shows. Selects the pack's scene section. */
export const SCENE_TYPES = ['house_exterior', 'apartment_entry', 'balcony', 'interior'] as const;
export const SceneTypeSchema = z.enum(SCENE_TYPES);
export type SceneType = z.infer<typeof SceneTypeSchema>;

/** Attribute of `house_exterior`. */
export const BUILDING_FORMS = ['detached', 'attached', 'other'] as const;
export const BuildingFormSchema = z.enum(BUILDING_FORMS);
export type BuildingForm = z.infer<typeof BuildingFormSchema>;

/** Attribute of `interior`. */
export const ROOM_TYPES = [
  'dining_room',
  'living_room',
  'entryway',
  'kitchen',
  'bedroom',
  'other',
] as const;
export const RoomTypeSchema = z.enum(ROOM_TYPES);
export type RoomType = z.infer<typeof RoomTypeSchema>;

/** How much decoration a render adds. */
export const STYLES = ['subtle', 'classic', 'abundant'] as const;
export const StyleSchema = z.enum(STYLES);
export type Style = z.infer<typeof StyleSchema>;
export const DEFAULT_STYLE: Style = 'classic';

/** Whether a render keeps the photo's light or relights it for evening. */
export const LIGHTING_MODES = ['source', 'evening'] as const;
export const LightingModeSchema = z.enum(LIGHTING_MODES);
export type LightingMode = z.infer<typeof LightingModeSchema>;
export const DEFAULT_LIGHTING_MODE: LightingMode = 'source';

/** Which path the landing and result screens invite more strongly for a holiday. */
export const JOURNEY_EMPHASES = ['exterior', 'interior', 'balanced'] as const;
export const JourneyEmphasisSchema = z.enum(JOURNEY_EMPHASES);
export type JourneyEmphasis = z.infer<typeof JourneyEmphasisSchema>;

/** Fixed anchor vocabulary shared by packs, scene analysis and kits. */
export const ANCHOR_CATEGORIES = [
  'front_door',
  'door_frame',
  'porch_rail',
  'porch_steps',
  'roofline',
  'eaves',
  'window_frame',
  'column',
  'walkway_edge',
  'planter',
  'lawn',
  'balcony_railing',
  'balcony_floor',
  'unit_door',
  'banister',
  'mantel',
  'dining_table',
  'sideboard',
  'interior_window',
  'wall',
  'floor_area',
  'shelf',
] as const;
export const AnchorCategorySchema = z.enum(ANCHOR_CATEGORIES);
export type AnchorCategory = z.infer<typeof AnchorCategorySchema>;

/** Scene types in which each anchor category may appear. */
export const ANCHOR_SCENE_TYPES: Readonly<Record<AnchorCategory, readonly SceneType[]>> = {
  front_door: ['house_exterior'],
  door_frame: ['house_exterior', 'apartment_entry', 'balcony'],
  porch_rail: ['house_exterior'],
  porch_steps: ['house_exterior'],
  roofline: ['house_exterior'],
  eaves: ['house_exterior'],
  window_frame: ['house_exterior'],
  column: ['house_exterior'],
  walkway_edge: ['house_exterior'],
  planter: ['house_exterior', 'balcony', 'apartment_entry'],
  lawn: ['house_exterior'],
  balcony_railing: ['balcony'],
  balcony_floor: ['balcony'],
  unit_door: ['apartment_entry'],
  banister: ['apartment_entry', 'interior'],
  mantel: ['interior'],
  dining_table: ['interior'],
  sideboard: ['interior'],
  interior_window: ['interior'],
  wall: ['interior', 'apartment_entry', 'balcony'],
  floor_area: ['interior', 'apartment_entry'],
  shelf: ['interior'],
};

/**
 * Furniture anchors whose top surface carries `on_surface` decorations. Their occlusion is read
 * as the top surface's: chairs, legs and objects in front of the furniture leave the top usable.
 */
export const SURFACE_ANCHOR_CATEGORIES: readonly AnchorCategory[] = [
  'dining_table',
  'sideboard',
  'mantel',
  'shelf',
];

/** Anchor categories allowed for a scene type. */
export function anchorCategoriesForSceneType(sceneType: SceneType): AnchorCategory[] {
  return ANCHOR_CATEGORIES.filter((category) => ANCHOR_SCENE_TYPES[category].includes(sceneType));
}

/** How a kit item attaches to its anchor. */
export const ATTACHMENT_INTENTS = [
  'hung',
  'wrapped',
  'draped',
  'strung',
  'standing',
  'placed',
  'stretched',
] as const;
export const AttachmentIntentSchema = z.enum(ATTACHMENT_INTENTS);
export type AttachmentIntent = z.infer<typeof AttachmentIntentSchema>;

/** How a placement region is derived from an anchor box. */
export const PLACEMENT_RULES = [
  'centered_on',
  'along',
  'beside',
  'on_surface',
  'cluster_at',
  'hang_from',
] as const;
export const PlacementRuleSchema = z.enum(PLACEMENT_RULES);
export type PlacementRule = z.infer<typeof PlacementRuleSchema>;

/** Items a pack may never place and the compiler always negates. */
export const FORBIDDEN_ITEMS = [
  'people',
  'pets',
  'text_or_signage',
  'house_number_changes',
  'new_structures',
  'structural_changes',
  'landscaping_changes',
  'neighbor_decor',
  'blocked_access',
  'brand_logos',
  'cartoon_or_licensed_characters',
  'mascots_and_inflatables',
  'snow_or_frost_unless_visible',
  'sky_effects',
  'religious_symbols',
  'open_flame_indoors',
  'gore',
  'realistic_weapons',
  'costume_caricature',
] as const;
export const ForbiddenItemSchema = z.enum(FORBIDDEN_ITEMS);
export type ForbiddenItem = z.infer<typeof ForbiddenItemSchema>;

/** Forbidden items every pack must list. */
export const BASELINE_FORBIDDEN_ITEMS: readonly ForbiddenItem[] = [
  'people',
  'pets',
  'text_or_signage',
  'house_number_changes',
  'new_structures',
  'structural_changes',
  'landscaping_changes',
  'neighbor_decor',
  'blocked_access',
  'brand_logos',
  'cartoon_or_licensed_characters',
  'mascots_and_inflatables',
  'snow_or_frost_unless_visible',
  'sky_effects',
];

/** Climate class resolved for planning. */
export const CLIMATE_CLASSES = ['cold', 'mild', 'warm', 'neutral'] as const;
export const ClimateClassSchema = z.enum(CLIMATE_CLASSES);
export type ClimateClass = z.infer<typeof ClimateClassSchema>;

/** Where the climate class may come from, in pack precedence order. */
export const CLIMATE_SOURCES = ['scene_analysis', 'address_region', 'neutral'] as const;
export const ClimateSourceSchema = z.enum(CLIMATE_SOURCES);
export type ClimateSource = z.infer<typeof ClimateSourceSchema>;

/** Publication status of a holiday pack version. */
export const PACK_VERSION_STATUSES = ['draft', 'in_review', 'published', 'retired'] as const;
export const PackVersionStatusSchema = z.enum(PACK_VERSION_STATUSES);
export type PackVersionStatus = z.infer<typeof PackVersionStatusSchema>;

/** Publication status of a style kit version. */
export const KIT_STATUSES = ['draft', 'published', 'retired'] as const;
export const KitStatusSchema = z.enum(KIT_STATUSES);
export type KitStatus = z.infer<typeof KitStatusSchema>;

/** Hero art sources. */
export const HERO_SOURCE_KINDS = ['commissioned', 'licensed', 'generated'] as const;
export const HeroSourceKindSchema = z.enum(HERO_SOURCE_KINDS);
export type HeroSourceKind = z.infer<typeof HeroSourceKindSchema>;

/** Uses a hero rights record may permit. */
export const HERO_PERMITTED_USES = ['landing', 'share_card', 'example_pages', 'marketing'] as const;
export const HeroPermittedUseSchema = z.enum(HERO_PERMITTED_USES);
export type HeroPermittedUse = z.infer<typeof HeroPermittedUseSchema>;

/** Hero crops. */
export const HERO_ORIENTATIONS = ['landscape', 'portrait'] as const;
export const HeroOrientationSchema = z.enum(HERO_ORIENTATIONS);
export type HeroOrientation = z.infer<typeof HeroOrientationSchema>;

/** Catalog status of a holiday in the US Release. */
export const HOLIDAY_RELEASE_STATUSES = ['release', 'optional'] as const;
export const HolidayReleaseStatusSchema = z.enum(HOLIDAY_RELEASE_STATUSES);
export type HolidayReleaseStatus = z.infer<typeof HolidayReleaseStatusSchema>;
