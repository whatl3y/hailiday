import { z } from 'zod';
import {
  ANCHOR_SCENE_TYPES,
  AnchorCategorySchema,
  AttachmentIntentSchema,
  BASELINE_FORBIDDEN_ITEMS,
  BuildingFormSchema,
  ClimateSourceSchema,
  DEFAULT_STYLE,
  ForbiddenItemSchema,
  HeroOrientationSchema,
  HeroPermittedUseSchema,
  HeroSourceKindSchema,
  HolidayIdSchema,
  JourneyEmphasisSchema,
  KitStatusSchema,
  LightingModeSchema,
  PlacementRuleSchema,
  RoomTypeSchema,
  SCENE_TYPES,
  STYLES,
  SceneTypeSchema,
  StyleSchema,
} from '../types/content.js';
import type {
  AnchorCategory,
  BuildingForm,
  LightingMode,
  RoomType,
  SceneType,
  Style,
} from '../types/content.js';
import {
  ApiAccessStateSchema,
  AvailabilitySchema,
  IndoorOutdoorSchema,
  LightTypeSchema,
  LinkMethodSchema,
  MerchantProgramStatusSchema,
  OfferLifecycleStatusSchema,
  PriceSourceSchema,
  VerificationMethodSchema,
} from '../types/commerce.js';
import { AssetPolicyUseStateSchema } from '../types/rights.js';
import { PackVersionSchema } from '../types/variant-key.js';
import { NormalizedBoxSchema } from './box.js';
import {
  CopyKeySchema,
  CountryCodeSchema,
  CurrencyCodeSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  RegionSchema,
  SlugSchema,
} from './common.js';

/** Defaults for a scene section's `limits`. */
export const DEFAULT_SECTION_LIMITS = {
  maxPlacements: { subtle: 3, classic: 6, abundant: 10 },
  overlapTolerance: 0.1,
  groundMarginFraction: 0.03,
  edgeMarginFraction: 0.02,
} as const;

/**
 * Length limits of a section's lavish description. With them the decorate request of the lavish
 * tier stays within its instruction cap for every scene type, with two house-number sentences
 * and every repair constraint.
 */
export const LAVISH_TEXT_LIMITS = {
  scene: 300,
  decorationsMin: 200,
  decorations: 2000,
  negative: 600,
} as const;

const fraction = z.number().min(0).max(1);
const nonEmptyText = z.string().trim().min(1);
const quantityRange = z.tuple([z.int().nonnegative(), z.int().nonnegative()]);

/** Structured spec attributes of a kit item, written in-house. */
export const SpecAttributesSchema = z.strictObject({
  category: nonEmptyText,
  sizeRange: z.string().optional(),
  material: z.string().optional(),
  colorFamily: z.array(nonEmptyText).min(1),
  lit: z.boolean(),
  lightType: LightTypeSchema.optional(),
  lightColor: z.string().optional(),
  indoorOutdoor: IndoorOutdoorSchema,
  countRange: z.string().optional(),
});
export type SpecAttributes = z.infer<typeof SpecAttributesSchema>;

/** Flattens spec attributes to the `Record<string, string | number>` a plan placement carries. */
export function flattenSpecAttributes(attributes: SpecAttributes): Record<string, string | number> {
  const flat: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) flat[key] = value.join(', ');
    else if (typeof value === 'boolean') flat[key] = value ? 'yes' : 'no';
    else flat[key] = value;
  }
  return flat;
}

/** One kit archetype authored inside a pack's scene section. */
export const KitArchetypeSchema = z.strictObject({
  kitItemId: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/, 'Expected <kitId>.<name>'),
  archetype: z.string().optional(),
  anchors: z.array(AnchorCategorySchema).min(1),
  attachment: AttachmentIntentSchema,
  placementRule: PlacementRuleSchema,
  priority: z.int().positive().optional(),
  specText: nonEmptyText.max(400),
  specAttributes: SpecAttributesSchema.optional(),
  quantity: z.strictObject({
    subtle: quantityRange,
    classic: quantityRange,
    abundant: quantityRange,
  }),
  required: z.array(StyleSchema).default([]),
});
export type KitArchetype = z.infer<typeof KitArchetypeSchema>;

export const SectionLimitsSchema = z.strictObject({
  maxPlacements: z
    .strictObject({
      subtle: z.int().positive(),
      classic: z.int().positive(),
      abundant: z.int().positive(),
    })
    .default({ ...DEFAULT_SECTION_LIMITS.maxPlacements }),
  overlapTolerance: fraction.default(DEFAULT_SECTION_LIMITS.overlapTolerance),
  groundMarginFraction: fraction.default(DEFAULT_SECTION_LIMITS.groundMarginFraction),
  edgeMarginFraction: fraction.default(DEFAULT_SECTION_LIMITS.edgeMarginFraction),
});
export type SectionLimits = z.infer<typeof SectionLimitsSchema>;

/**
 * A section's description of the whole display for the lavish tier (the `abundant` style): the
 * decorate request states it in place of one sentence per placement.
 */
export const LavishFragmentSchema = z.strictObject({
  /** What the picture shows, in place of the section's `scene` fragment. */
  scene: nonEmptyText.max(LAVISH_TEXT_LIMITS.scene),
  /** The paragraph that lists what is added, in full sentences. */
  decorations: nonEmptyText
    .min(LAVISH_TEXT_LIMITS.decorationsMin)
    .max(LAVISH_TEXT_LIMITS.decorations),
  /** In place of the section's `negative` fragment. */
  negative: nonEmptyText.max(LAVISH_TEXT_LIMITS.negative),
  /** Whether the paragraph asks for electric lights. */
  lit: z.boolean(),
});
export type LavishFragment = z.infer<typeof LavishFragmentSchema>;

export const PromptFragmentsSchema = z.strictObject({
  scene: nonEmptyText,
  preserve: nonEmptyText,
  negative: nonEmptyText,
  lavish: LavishFragmentSchema.optional(),
});
export type PromptFragments = z.infer<typeof PromptFragmentsSchema>;

/** A pack's rules for one scene type. */
export const SceneSectionSchema = z.strictObject({
  buildingForms: z.array(BuildingFormSchema).optional(),
  formRules: z
    .partialRecord(
      BuildingFormSchema,
      z.strictObject({
        excludeAnchors: z.array(AnchorCategorySchema).default([]),
        note: z.string().optional(),
      }),
    )
    .optional(),
  roomTypes: z.array(RoomTypeSchema).optional(),
  roomRules: z
    .partialRecord(
      RoomTypeSchema,
      z.strictObject({
        anchors: z.array(AnchorCategorySchema).min(1),
        note: z.string().optional(),
      }),
    )
    .optional(),
  anchors: z.array(AnchorCategorySchema).min(1),
  preserve: z.array(nonEmptyText).default([]),
  keepClear: z.array(nonEmptyText).default([]),
  limits: SectionLimitsSchema.default({
    maxPlacements: { ...DEFAULT_SECTION_LIMITS.maxPlacements },
    overlapTolerance: DEFAULT_SECTION_LIMITS.overlapTolerance,
    groundMarginFraction: DEFAULT_SECTION_LIMITS.groundMarginFraction,
    edgeMarginFraction: DEFAULT_SECTION_LIMITS.edgeMarginFraction,
  }),
  kitId: z.string(),
  kit: z.array(KitArchetypeSchema).min(1).max(6),
  promptFragments: PromptFragmentsSchema,
});
export type SceneSection = z.infer<typeof SceneSectionSchema>;

export const LightingPolicyEntrySchema = z.strictObject({
  default: LightingModeSchema,
  offered: z.array(LightingModeSchema).min(1),
});
export type LightingPolicyEntry = z.infer<typeof LightingPolicyEntrySchema>;

const holidayPackShape = z.strictObject({
  id: z.string(),
  version: PackVersionSchema,
  holidayId: HolidayIdSchema,
  region: RegionSchema,
  displayName: nonEmptyText,
  journeyEmphasis: JourneyEmphasisSchema,
  traditionNotes: z.string().default(''),
  lightingPolicy: z.strictObject({
    bySceneType: z.partialRecord(SceneTypeSchema, LightingPolicyEntrySchema),
    eveningGuidance: z.string().optional(),
  }),
  climateRule: z.strictObject({
    sourcePrecedence: z.array(ClimateSourceSchema).min(1),
    snow: z.literal('only_if_visible_in_source'),
    coldClimateOnlyItems: z.array(z.string()).default([]),
  }),
  existingDecorPolicy: z.literal('preserve_and_complement'),
  forbidden: z.array(ForbiddenItemSchema).min(1),
  sceneSections: z.partialRecord(SceneTypeSchema, SceneSectionSchema),
  heroRefs: z
    .array(z.strictObject({ heroAssetId: nonEmptyText, orientation: HeroOrientationSchema }))
    .default([]),
  exampleRefs: z
    .array(
      z.strictObject({
        exampleAssetId: nonEmptyText,
        sceneType: SceneTypeSchema,
        style: StyleSchema,
        lightingMode: LightingModeSchema,
      }),
    )
    .default([]),
  review: z.strictObject({
    checklistVersion: z.int().positive(),
    approvedBy: z.array(z.string()).default([]),
    approvedAt: z.union([IsoDateSchema, IsoDateTimeSchema]).nullable().default(null),
    goldenRunId: z.string().nullable().default(null),
  }),
});

type HolidayPackShape = z.infer<typeof holidayPackShape>;

/** Cross-field rules a pack must satisfy beyond its shape. */
function validatePack(pack: HolidayPackShape, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });

  if (pack.id !== `${pack.holidayId}.${pack.region}`) {
    issue(['id'], `id must be ${pack.holidayId}.${pack.region}`);
  }

  const forbidden = new Set(pack.forbidden);
  for (const item of BASELINE_FORBIDDEN_ITEMS) {
    if (!forbidden.has(item)) issue(['forbidden'], `forbidden must include baseline item ${item}`);
  }
  if (!forbidden.has('religious_symbols')) {
    issue(['forbidden'], 'forbidden must include religious_symbols in US Release packs');
  }

  const sections = Object.entries(pack.sceneSections) as [SceneType, SceneSection][];
  if (sections.length === 0) issue(['sceneSections'], 'a pack needs at least one scene section');

  const allKitItemIds = new Set<string>();
  for (const [sceneType, section] of sections) {
    const base = ['sceneSections', sceneType];
    const allowed = new Set(section.anchors);

    section.anchors.forEach((anchor, i) => {
      if (!ANCHOR_SCENE_TYPES[anchor].includes(sceneType)) {
        issue([...base, 'anchors', i], `anchor ${anchor} is not allowed for ${sceneType}`);
      }
    });

    if (section.kitId !== `${pack.holidayId}.${sceneType}`) {
      issue([...base, 'kitId'], `kitId must be ${pack.holidayId}.${sceneType}`);
    }

    if (sceneType !== 'house_exterior' && (section.buildingForms || section.formRules)) {
      issue(base, 'buildingForms and formRules apply only to house_exterior');
    }
    if (sceneType !== 'interior' && (section.roomTypes || section.roomRules)) {
      issue(base, 'roomTypes and roomRules apply only to interior');
    }

    for (const [form, rule] of Object.entries(section.formRules ?? {})) {
      rule?.excludeAnchors.forEach((anchor, i) => {
        if (!allowed.has(anchor)) {
          issue([...base, 'formRules', form, 'excludeAnchors', i], `${anchor} is not in anchors`);
        }
      });
    }
    for (const [room, rule] of Object.entries(section.roomRules ?? {})) {
      rule?.anchors.forEach((anchor, i) => {
        if (!allowed.has(anchor)) {
          issue([...base, 'roomRules', room, 'anchors', i], `${anchor} is not in anchors`);
        }
      });
    }

    const priorities = new Set<number>();
    const requiredCount: Record<Style, number> = { subtle: 0, classic: 0, abundant: 0 };
    section.kit.forEach((item, i) => {
      const itemPath = [...base, 'kit', i];
      if (!item.kitItemId.startsWith(`${section.kitId}.`)) {
        issue([...itemPath, 'kitItemId'], `kitItemId must start with ${section.kitId}.`);
      }
      if (allKitItemIds.has(item.kitItemId)) {
        issue([...itemPath, 'kitItemId'], `duplicate kitItemId ${item.kitItemId}`);
      }
      allKitItemIds.add(item.kitItemId);
      item.anchors.forEach((anchor, j) => {
        if (!allowed.has(anchor)) {
          issue([...itemPath, 'anchors', j], `${anchor} is not in the section's anchors`);
        }
      });
      const priority = item.priority ?? i + 1;
      if (priorities.has(priority))
        issue([...itemPath, 'priority'], `duplicate priority ${priority}`);
      priorities.add(priority);
      for (const style of STYLES) {
        const [min, max] = item.quantity[style];
        if (min > max) issue([...itemPath, 'quantity', style], 'minimum is above maximum');
      }
      for (const style of item.required) {
        requiredCount[style] += 1;
        if (item.quantity[style][0] < 1) {
          issue([...itemPath, 'quantity', style], `required style ${style} needs a minimum of 1`);
        }
      }
    });

    const max = section.limits.maxPlacements;
    if (max.subtle > max.classic || max.classic > max.abundant) {
      issue([...base, 'limits', 'maxPlacements'], 'maxPlacements must not decrease by style');
    }
    for (const style of STYLES) {
      if (max[style] < requiredCount[style]) {
        issue(
          [...base, 'limits', 'maxPlacements', style],
          `maxPlacements.${style} is below the ${requiredCount[style]} archetypes requiring it`,
        );
      }
    }

    if (sceneType === 'interior' && !forbidden.has('open_flame_indoors')) {
      issue(['forbidden'], 'packs with an interior section must forbid open_flame_indoors');
    }

    const lighting = pack.lightingPolicy.bySceneType[sceneType];
    if (!lighting) {
      issue(['lightingPolicy', 'bySceneType', sceneType], 'every scene section needs a policy');
    }
  }

  for (const [sceneType, entry] of Object.entries(pack.lightingPolicy.bySceneType)) {
    if (entry && !entry.offered.includes(entry.default)) {
      issue(['lightingPolicy', 'bySceneType', sceneType, 'default'], 'default must be offered');
    }
    if (!pack.sceneSections[sceneType as SceneType]) {
      issue(['lightingPolicy', 'bySceneType', sceneType], 'policy for a missing scene section');
    }
  }

  pack.climateRule.coldClimateOnlyItems.forEach((id, i) => {
    if (!allKitItemIds.has(id)) {
      issue(['climateRule', 'coldClimateOnlyItems', i], `unknown kitItemId ${id}`);
    }
  });

  pack.exampleRefs.forEach((ref, i) => {
    if (!isContentCellOffered(pack, ref.sceneType, ref.style, ref.lightingMode)) {
      issue(['exampleRefs', i], 'example references a content cell the pack does not offer');
    }
  });
}

/** A holiday pack file (`pack.yaml`), validated field for field plus cross-field rules. */
export const HolidayPackSchema = holidayPackShape.superRefine(validatePack);
export type HolidayPack = z.infer<typeof HolidayPackSchema>;

/** The scene types a pack has sections for. */
export function packSceneTypes(pack: Pick<HolidayPack, 'sceneSections'>): SceneType[] {
  return SCENE_TYPES.filter((sceneType) => pack.sceneSections[sceneType] !== undefined);
}

/** Offered styles and lighting modes (upper bound from the pack) for one scene type. */
export function packOfferFor(
  pack: Pick<HolidayPack, 'sceneSections' | 'lightingPolicy'>,
  sceneType: SceneType,
): {
  styles: Style[];
  defaultStyle: Style;
  lightingModes: LightingMode[];
  defaultLightingMode: LightingMode;
} | null {
  const section = pack.sceneSections[sceneType];
  const lighting = pack.lightingPolicy.bySceneType[sceneType];
  if (!section || !lighting) return null;
  return {
    styles: [...STYLES],
    defaultStyle: DEFAULT_STYLE,
    lightingModes: [...lighting.offered],
    defaultLightingMode: lighting.default,
  };
}

/** Whether (scene type, style, lighting mode) is a content cell the pack offers. */
export function isContentCellOffered(
  pack: Pick<HolidayPack, 'sceneSections' | 'lightingPolicy'>,
  sceneType: SceneType,
  style: Style,
  lightingMode: LightingMode,
): boolean {
  const offer = packOfferFor(pack, sceneType);
  return (
    offer !== null && offer.styles.includes(style) && offer.lightingModes.includes(lightingMode)
  );
}

/** Eligible anchor categories of a section for a building form or room type. */
export function effectiveSectionAnchors(
  section: Pick<SceneSection, 'anchors' | 'formRules' | 'roomRules'>,
  attribute: { buildingForm?: BuildingForm | null; roomType?: RoomType | null } = {},
): AnchorCategory[] {
  if (attribute.roomType) {
    const roomRule = section.roomRules?.[attribute.roomType];
    if (roomRule) return [...roomRule.anchors];
  }
  if (attribute.buildingForm) {
    const formRule = section.formRules?.[attribute.buildingForm];
    if (formRule) {
      const excluded = new Set(formRule.excludeAnchors);
      return section.anchors.filter((anchor) => !excluded.has(anchor));
    }
  }
  return [...section.anchors];
}

/** Kit archetypes of a section in priority order. */
export function kitInPriorityOrder(section: Pick<SceneSection, 'kit'>): KitArchetype[] {
  return section.kit
    .map((item, index) => ({ item, priority: item.priority ?? index + 1 }))
    .sort((a, b) => a.priority - b.priority)
    .map(({ item }) => item);
}

/**
 * The lavish description a section applies for the style whose quantities a plan uses, or null:
 * only the `abundant` style has one, and only where the section carries it.
 */
export function lavishFragmentFor(
  section: Pick<SceneSection, 'promptFragments'>,
  effectiveStyle: Style,
): LavishFragment | null {
  return effectiveStyle === 'abundant' ? (section.promptFragments.lavish ?? null) : null;
}

/** One kit item in a published style kit (`kit_items`). */
export const StyleKitItemSchema = z.strictObject({
  kitItemId: z.string().min(1),
  anchorCategory: AnchorCategorySchema,
  anchorCategories: z.array(AnchorCategorySchema).min(1).optional(),
  specText: nonEmptyText,
  specAttributes: SpecAttributesSchema,
  styleQuantities: z.strictObject({
    subtle: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
    classic: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
    abundant: z.strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() }),
  }),
  sortOrder: z.int().nonnegative(),
  currentProductKey: SlugSchema.nullable().optional(),
});
export type StyleKitItem = z.infer<typeof StyleKitItemSchema>;

/** A style kit version for one (holiday, scene type). */
export const StyleKitSchema = z
  .strictObject({
    kitKey: z.string(),
    holidayId: HolidayIdSchema,
    sceneType: SceneTypeSchema,
    version: PackVersionSchema,
    status: KitStatusSchema.default('published'),
    items: z.array(StyleKitItemSchema).min(1).max(6),
  })
  .superRefine((kit, ctx) => {
    if (kit.kitKey !== `${kit.holidayId}.${kit.sceneType}`) {
      ctx.addIssue({
        code: 'custom',
        path: ['kitKey'],
        message: `kitKey must be ${kit.holidayId}.${kit.sceneType}`,
      });
    }
    const seen = new Set<string>();
    kit.items.forEach((item, i) => {
      if (seen.has(item.kitItemId)) {
        ctx.addIssue({ code: 'custom', path: ['items', i, 'kitItemId'], message: 'duplicate' });
      }
      seen.add(item.kitItemId);
      if (!ANCHOR_SCENE_TYPES[item.anchorCategory].includes(kit.sceneType)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', i, 'anchorCategory'],
          message: `anchor ${item.anchorCategory} is not allowed for ${kit.sceneType}`,
        });
      }
      for (const style of STYLES) {
        const q = item.styleQuantities[style];
        if (q.min > q.max) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', i, 'styleQuantities', style],
            message: 'minimum is above maximum',
          });
        }
      }
    });
  });
export type StyleKit = z.infer<typeof StyleKitSchema>;

/** Derives the style kit seeded from a pack's scene section. */
export function styleKitFromSection(
  pack: Pick<HolidayPack, 'holidayId' | 'version'>,
  sceneType: SceneType,
  section: SceneSection,
): StyleKit {
  return {
    kitKey: section.kitId,
    holidayId: pack.holidayId,
    sceneType,
    version: pack.version,
    status: 'published',
    items: kitInPriorityOrder(section).map((item, index) => ({
      kitItemId: item.kitItemId,
      anchorCategory: item.anchors[0] as AnchorCategory,
      anchorCategories: [...item.anchors],
      specText: item.specText,
      specAttributes: item.specAttributes ?? {
        category: item.archetype ?? item.kitItemId.split('.').pop() ?? 'decor',
        colorFamily: ['unspecified'],
        lit: false,
        indoorOutdoor: sceneType === 'interior' ? 'indoor' : 'outdoor',
      },
      styleQuantities: {
        subtle: { min: item.quantity.subtle[0], max: item.quantity.subtle[1] },
        classic: { min: item.quantity.classic[0], max: item.quantity.classic[1] },
        abundant: { min: item.quantity.abundant[0], max: item.quantity.abundant[1] },
      },
      sortOrder: index,
    })),
  };
}

/** A merchant program content record. */
export const MerchantProgramContentSchema = z.strictObject({
  programKey: SlugSchema,
  displayName: nonEmptyText,
  network: nonEmptyText,
  status: MerchantProgramStatusSchema,
  appliedAt: IsoDateTimeSchema.nullable().optional(),
  approvedAt: IsoDateTimeSchema.nullable().optional(),
  endedAt: IsoDateTimeSchema.nullable().optional(),
  requiredDisclosureKey: CopyKeySchema.nullable().optional(),
  disclosureText: z.string().nullable().optional(),
  redirectPermitted: z.boolean().default(false),
  linkMethod: LinkMethodSchema.default('manual_links'),
  subIdCapability: z.boolean().default(false),
  apiAccess: ApiAccessStateSchema.default('none'),
  attributionWindowHours: z.int().positive().nullable().optional(),
  commissionSchedule: z
    .array(
      z.strictObject({
        category: nonEmptyText,
        ratePercent: z.number().min(0).max(100),
        effectiveFrom: IsoDateSchema,
      }),
    )
    .default([]),
  policyVersion: z.string().nullable().optional(),
  reviewedAt: IsoDateTimeSchema.nullable().optional(),
});
export type MerchantProgramContent = z.infer<typeof MerchantProgramContentSchema>;

/** A real product described in our own words, merchant-agnostic. */
export const ProductContentSchema = z.strictObject({
  productKey: SlugSchema,
  kitItemIds: z.array(z.string().min(1)).min(1),
  ourTitle: nonEmptyText.max(120),
  ourDescription: nonEmptyText.max(500),
  category: nonEmptyText,
  specAttributes: SpecAttributesSchema,
  archivedAt: IsoDateTimeSchema.nullable().optional(),
});
export type ProductContent = z.infer<typeof ProductContentSchema>;

/** Occurrence keys: `<holidayId>.<region>.<year>`. */
export const OccurrenceKeySchema = z
  .string()
  .regex(
    /^(halloween|thanksgiving_us|christmas|new_years_eve)\.[A-Z]{2}(-[A-Z0-9]{1,3})?\.\d{4}$/,
    'Expected <holidayId>.<region>.<year>',
  );
export type OccurrenceKey = z.infer<typeof OccurrenceKeySchema>;

/** One merchant's sellable listing of a product. */
export const OfferContentSchema = z
  .strictObject({
    offerKey: SlugSchema,
    productKey: SlugSchema,
    merchantProgramKey: SlugSchema,
    merchantItemId: nonEmptyText,
    destinationCountry: CountryCodeSchema,
    currency: CurrencyCodeSchema,
    priceMinor: z.int().nonnegative().nullable().default(null),
    priceSource: PriceSourceSchema.default('none'),
    priceObservedAt: IsoDateTimeSchema.nullable().default(null),
    availability: AvailabilitySchema.default('unknown'),
    availabilityCheckedAt: IsoDateTimeSchema.nullable().default(null),
    destinationUrl: z.url({ protocol: /^https$/ }),
    trackingUrlTemplate: z.string().nullable().default(null),
    contentRights: z
      .strictObject({
        imageDisplay: AssetPolicyUseStateSchema,
        imageAiInput: AssetPolicyUseStateSchema,
        textUse: AssetPolicyUseStateSchema,
      })
      .default({ imageDisplay: 'unknown', imageAiInput: 'unknown', textUse: 'unknown' }),
    status: OfferLifecycleStatusSchema,
    seasonalEligibility: z.array(OccurrenceKeySchema).default([]),
    sponsored: z.boolean().default(false),
    lastVerifiedAt: IsoDateTimeSchema.nullable().default(null),
    verificationMethod: VerificationMethodSchema.nullable().default(null),
    notes: z.string().optional(),
  })
  .superRefine((offer, ctx) => {
    if (offer.priceMinor !== null && offer.priceSource !== 'none' && !offer.priceObservedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceObservedAt'],
        message: 'a displayable price needs priceObservedAt',
      });
    }
    if (
      offer.trackingUrlTemplate !== null &&
      !offer.trackingUrlTemplate.includes('{destinationUrl}') &&
      !offer.trackingUrlTemplate.includes('{subId}')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['trackingUrlTemplate'],
        message: 'template needs a {destinationUrl} or {subId} placeholder',
      });
    }
    if (/[?&](tag|subid|sid|u1)=/i.test(offer.destinationUrl)) {
      ctx.addIssue({
        code: 'custom',
        path: ['destinationUrl'],
        message: 'destinationUrl must not carry tracking parameters',
      });
    }
  });
export type OfferContent = z.infer<typeof OfferContentSchema>;

/** The commerce content set: programs, products and offers with cross-references checked. */
export const CommerceCatalogSchema = z
  .strictObject({
    merchantPrograms: z.array(MerchantProgramContentSchema),
    products: z.array(ProductContentSchema),
    offers: z.array(OfferContentSchema),
  })
  .superRefine((catalog, ctx) => {
    const programs = new Set<string>();
    catalog.merchantPrograms.forEach((p, i) => {
      if (programs.has(p.programKey)) {
        ctx.addIssue({ code: 'custom', path: ['merchantPrograms', i], message: 'duplicate key' });
      }
      programs.add(p.programKey);
    });
    const products = new Set<string>();
    catalog.products.forEach((p, i) => {
      if (products.has(p.productKey)) {
        ctx.addIssue({ code: 'custom', path: ['products', i], message: 'duplicate key' });
      }
      products.add(p.productKey);
    });
    const offers = new Set<string>();
    catalog.offers.forEach((o, i) => {
      if (offers.has(o.offerKey)) {
        ctx.addIssue({ code: 'custom', path: ['offers', i], message: 'duplicate key' });
      }
      offers.add(o.offerKey);
      if (!products.has(o.productKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['offers', i, 'productKey'],
          message: 'unknown product',
        });
      }
      if (!programs.has(o.merchantProgramKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['offers', i, 'merchantProgramKey'],
          message: 'unknown merchant program',
        });
      }
    });
  });
export type CommerceCatalog = z.infer<typeof CommerceCatalogSchema>;

/** One image rendition of a hero crop. */
export const HeroRenditionContentSchema = z.strictObject({
  cdnPath: nonEmptyText,
  width: z.int().positive(),
  height: z.int().positive(),
  format: z.enum(['avif', 'webp', 'jpeg', 'png', 'svg']),
});

export const HeroCropContentSchema = z.strictObject({
  focalPoint: z.tuple([fraction, fraction]),
  safeArea: NormalizedBoxSchema,
  renditions: z.array(HeroRenditionContentSchema).min(1),
});

/** Hero art record (`hero_assets`). */
export const HeroAssetContentSchema = z.strictObject({
  heroAssetId: nonEmptyText,
  holidayId: HolidayIdSchema.nullable(),
  sceneType: SceneTypeSchema.nullable(),
  renditions: z.strictObject({ landscape: HeroCropContentSchema, portrait: HeroCropContentSchema }),
  altTextKey: CopyKeySchema,
  rights: z.strictObject({
    sourceKind: HeroSourceKindSchema,
    creator: z.string(),
    licensor: z.string().nullable().default(null),
    licenseRef: z.string(),
    licenseVersion: z.string().nullable().default(null),
    territory: z.string(),
    permittedUses: z.array(HeroPermittedUseSchema).min(1),
    attribution: z.string().nullable().default(null),
    expiresAt: IsoDateTimeSchema.nullable().default(null),
    generation: z.record(z.string(), z.string()).nullable().default(null),
  }),
  approvedCrops: z.array(HeroOrientationSchema).default(['landscape', 'portrait']),
  active: z.boolean().default(true),
});
export type HeroAssetContent = z.infer<typeof HeroAssetContentSchema>;

/** Example before/after record (`example_assets`). */
export const ExampleAssetContentSchema = z.strictObject({
  exampleAssetId: nonEmptyText,
  holidayId: HolidayIdSchema,
  sceneType: SceneTypeSchema,
  style: StyleSchema,
  lightingMode: LightingModeSchema,
  packVersion: PackVersionSchema,
  beforeCdnPath: nonEmptyText,
  afterCdnPath: nonEmptyText,
  width: z.int().positive(),
  height: z.int().positive(),
  captionKey: CopyKeySchema,
  rights: z.record(z.string(), z.unknown()),
  active: z.boolean().default(true),
});
export type ExampleAssetContent = z.infer<typeof ExampleAssetContentSchema>;
