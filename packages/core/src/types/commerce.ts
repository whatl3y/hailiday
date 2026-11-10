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
