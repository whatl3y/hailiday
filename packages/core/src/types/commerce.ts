import { z } from 'zod';

/** How a product relates to a specific render. */
export const PRODUCT_RELATIONSHIPS = ['similar', 'described', 'reference', 'verified'] as const;
export const ProductRelationshipSchema = z.enum(PRODUCT_RELATIONSHIPS);
export type ProductRelationship = z.infer<typeof ProductRelationshipSchema>;

/** Relationships available in the US Release. */
export const US_RELEASE_PRODUCT_RELATIONSHIPS: readonly ProductRelationship[] = [
  'similar',
  'described',
];

/** Copy keys of the customer label for each relationship. */
export const PRODUCT_RELATIONSHIP_LABEL_KEYS: Readonly<Record<ProductRelationship, string>> = {
  similar: 'commerce.relationship.similar',
  described: 'commerce.relationship.described',
  reference: 'commerce.relationship.reference',
  verified: 'commerce.relationship.verified',
};

/** Offer lifecycle status. */
export const OFFER_LIFECYCLE_STATUSES = ['draft', 'active', 'paused', 'retired'] as const;
export const OfferLifecycleStatusSchema = z.enum(OFFER_LIFECYCLE_STATUSES);
export type OfferLifecycleStatus = z.infer<typeof OfferLifecycleStatusSchema>;

/** Merchant program status. */
export const MERCHANT_PROGRAM_STATUSES = [
  'planned',
  'applied',
  'provisional',
  'approved',
  'declined',
  'withdrawn',
  'suspended',
] as const;
export const MerchantProgramStatusSchema = z.enum(MERCHANT_PROGRAM_STATUSES);
export type MerchantProgramStatus = z.infer<typeof MerchantProgramStatusSchema>;

/** Program statuses whose offers may carry tracking links. */
export const TRACKING_LINK_PROGRAM_STATUSES: readonly MerchantProgramStatus[] = [
  'provisional',
  'approved',
];

/** What Shop the look shows for a variant. */
export const PANEL_STATES = ['active', 'no_offers', 'off_season', 'hidden'] as const;
export const PanelStateSchema = z.enum(PANEL_STATES);
export type PanelState = z.infer<typeof PanelStateSchema>;

/** Where an offer's price comes from. */
export const PRICE_SOURCES = [
  'none',
  'api',
  'feed',
  'merchant_served_link',
  'manual_non_amazon',
] as const;
export const PriceSourceSchema = z.enum(PRICE_SOURCES);
export type PriceSource = z.infer<typeof PriceSourceSchema>;

/** Whether a product link is the plain merchant URL or the program's tracking link. */
export const LINK_MODES = ['plain', 'tracking'] as const;
export const LinkModeSchema = z.enum(LINK_MODES);
export type LinkMode = z.infer<typeof LinkModeSchema>;

/** Result of the adherence check for a placement. */
export const ADHERENCE_STATUSES = ['pass', 'fail', 'uncertain', 'not_checked'] as const;
export const AdherenceStatusSchema = z.enum(ADHERENCE_STATUSES);
export type AdherenceStatus = z.infer<typeof AdherenceStatusSchema>;

/** Who checked adherence. */
export const ADHERENCE_CHECKERS = ['human', 'judge'] as const;
export const AdherenceCheckerSchema = z.enum(ADHERENCE_CHECKERS);
export type AdherenceChecker = z.infer<typeof AdherenceCheckerSchema>;

/** Offer availability. */
export const AVAILABILITIES = ['in_stock', 'unknown', 'out_of_stock'] as const;
export const AvailabilitySchema = z.enum(AVAILABILITIES);
export type Availability = z.infer<typeof AvailabilitySchema>;

/** How an offer was last verified. */
export const VERIFICATION_METHODS = ['feed', 'api', 'manual'] as const;
export const VerificationMethodSchema = z.enum(VERIFICATION_METHODS);
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>;

/** How a merchant program's links are produced. */
export const LINK_METHODS = ['manual_links', 'api'] as const;
export const LinkMethodSchema = z.enum(LINK_METHODS);
export type LinkMethod = z.infer<typeof LinkMethodSchema>;

/** Merchant API access state. */
export const API_ACCESS_STATES = ['none', 'requested', 'granted'] as const;
export const ApiAccessStateSchema = z.enum(API_ACCESS_STATES);
export type ApiAccessState = z.infer<typeof ApiAccessStateSchema>;

/** Affiliate conversion status. */
export const AFFILIATE_CONVERSION_STATUSES = ['pending', 'approved', 'reversed', 'paid'] as const;
export const AffiliateConversionStatusSchema = z.enum(AFFILIATE_CONVERSION_STATUSES);
export type AffiliateConversionStatus = z.infer<typeof AffiliateConversionStatusSchema>;

/** Copy keys of the commerce disclosure lines. */
export const DISCLOSURE_COPY_KEYS = [
  'commerce.disclosure.paid',
  'commerce.disclosure.amazon',
  'commerce.disclosure.plain',
] as const;
export const DisclosureCopyKeySchema = z.enum(DISCLOSURE_COPY_KEYS);
export type DisclosureCopyKey = z.infer<typeof DisclosureCopyKeySchema>;

/** Indoor or outdoor suitability of a kit item or product. */
export const INDOOR_OUTDOOR = ['indoor', 'outdoor', 'indoor_or_outdoor'] as const;
export const IndoorOutdoorSchema = z.enum(INDOOR_OUTDOOR);
export type IndoorOutdoor = z.infer<typeof IndoorOutdoorSchema>;

/** Light type of a lit kit item. */
export const LIGHT_TYPES = ['electric', 'flameless'] as const;
export const LightTypeSchema = z.enum(LIGHT_TYPES);
export type LightType = z.infer<typeof LightTypeSchema>;

/** Whether a merchant program is example data or an actual retailer. */
export const PROGRAM_KINDS = ['fixture', 'real'] as const;
export const ProgramKindSchema = z.enum(PROGRAM_KINDS);
export type ProgramKind = z.infer<typeof ProgramKindSchema>;

/** Which kind of merchant program is served; fixture and real programs are never served together. */
export const COMMERCE_MODES = ['fixture', 'real'] as const;
export const CommerceModeSchema = z.enum(COMMERCE_MODES);
export type CommerceMode = z.infer<typeof CommerceModeSchema>;

/** Where a program's links sit in Shop the look: in a group's row, or on a line of their own. */
export const PROGRAM_PLACEMENTS = ['group', 'separate'] as const;
export const ProgramPlacementSchema = z.enum(PROGRAM_PLACEMENTS);
export type ProgramPlacement = z.infer<typeof ProgramPlacementSchema>;

/** Whether a shop target is a product offer or a link to a retailer's search results. */
export const SHOP_LINK_KINDS = ['product', 'search'] as const;
export const ShopLinkKindSchema = z.enum(SHOP_LINK_KINDS);
export type ShopLinkKind = z.infer<typeof ShopLinkKindSchema>;

/** Why a decoration is in the panel: the plan placed it, or it is typical of the look. */
export const SHOP_GROUP_BASES = ['placed', 'typical'] as const;
export const ShopGroupBasisSchema = z.enum(SHOP_GROUP_BASES);
export type ShopGroupBasis = z.infer<typeof ShopGroupBasisSchema>;

/** Whether a commerce window is open for the variant's holiday. */
export const SHOP_SEASONS = ['in_window', 'off_season'] as const;
export const ShopSeasonSchema = z.enum(SHOP_SEASONS);
export type ShopSeason = z.infer<typeof ShopSeasonSchema>;

/** Look item status. */
export const LOOK_ITEM_STATUSES = ['active', 'retired'] as const;
export const LookItemStatusSchema = z.enum(LOOK_ITEM_STATUSES);
export type LookItemStatus = z.infer<typeof LookItemStatusSchema>;

/** Uses of retailer data or links that a program's terms may allow. */
export const PROGRAM_RIGHT_USES = [
  'tracked_product_links',
  'tracked_search_links',
  'product_name',
  'picture',
  'picture_storage',
  'price',
  'data_storage',
  'beside_other_retailers',
  'beside_ai_picture',
  'retailer_name',
] as const;
export const ProgramRightUseSchema = z.enum(PROGRAM_RIGHT_USES);
export type ProgramRightUse = z.infer<typeof ProgramRightUseSchema>;

/** What a program's terms say about one use; `unknown` counts as denied. */
export const PROGRAM_RIGHT_STATES = ['allowed', 'denied', 'unknown'] as const;
export const ProgramRightStateSchema = z.enum(PROGRAM_RIGHT_STATES);
export type ProgramRightState = z.infer<typeof ProgramRightStateSchema>;

/** One recorded right: evidence is required unless the state is `unknown`. */
export const ProgramRightSchema = z
  .strictObject({
    state: ProgramRightStateSchema,
    evidence: z.string().min(1).max(500).nullable(),
    recordedAt: z.iso.datetime().nullable(),
  })
  .refine((right) => right.state === 'unknown' || right.evidence !== null, {
    message: 'evidence is required',
    path: ['evidence'],
  });
export type ProgramRight = z.infer<typeof ProgramRightSchema>;

/** Rights by use; a missing use is `unknown`. */
export const ProgramRightsSchema = z.partialRecord(ProgramRightUseSchema, ProgramRightSchema);
export type ProgramRights = z.infer<typeof ProgramRightsSchema>;

/** True only when the use is recorded as `allowed`. */
export function programRightAllowed(rights: ProgramRights, use: ProgramRightUse): boolean {
  return rights[use]?.state === 'allowed';
}

/** Placeholder of a search link pattern. */
export const SEARCH_QUERY_PLACEHOLDER = '{query}';
