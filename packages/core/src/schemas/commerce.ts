import { z } from 'zod';
import {
  DisclosureCopyKeySchema,
  LinkModeSchema,
  PanelStateSchema,
  ProductRelationshipSchema,
  ShopGroupBasisSchema,
  ShopSeasonSchema,
} from '../types/commerce.js';
import { AnchorCategorySchema } from '../types/content.js';
import { CopyKeySchema, CurrencyCodeSchema, IsoDateTimeSchema, UuidSchema } from './common.js';

/** Price of a shop option: shown only when a permitted, timestamped price exists. */
export const CardPriceSchema = z.discriminatedUnion('policy', [
  z.strictObject({ policy: z.literal('check_at_retailer') }),
  z.strictObject({
    policy: z.literal('show'),
    amountMinor: z.int().nonnegative(),
    currency: CurrencyCodeSchema,
    observedAt: IsoDateTimeSchema,
  }),
]);
export type CardPrice = z.infer<typeof CardPriceSchema>;

/** A link to a retailer's own search results for one decoration. */
export const ShopSearchLinkSchema = z.strictObject({
  clickToken: z.string().min(1),
  programKey: z.string(),
  merchantName: z.string(),
  linkMode: LinkModeSchema,
  sponsored: z.boolean(),
  href: z.string(),
});
export type ShopSearchLink = z.infer<typeof ShopSearchLinkSchema>;

/** One product offered for a decoration. */
export const ShopOptionSchema = z.strictObject({
  clickToken: z.string().min(1),
  programKey: z.string(),
  title: z.string(),
  merchantName: z.string(),
  relationship: ProductRelationshipSchema,
  relationshipLabelKey: CopyKeySchema,
  price: CardPriceSchema,
  linkMode: LinkModeSchema,
  sponsored: z.boolean(),
  href: z.string(),
  position: z.int().positive(),
});
export type ShopOption = z.infer<typeof ShopOptionSchema>;

/** One decoration of the look with what can be bought for it. */
export const ShopGroupSchema = z.strictObject({
  groupKey: z.string(),
  basis: ShopGroupBasisSchema,
  title: z.string(),
  anchorCategory: AnchorCategorySchema.nullable(),
  options: z.array(ShopOptionSchema),
  searchLinks: z.array(ShopSearchLinkSchema),
  separateLinks: z.array(ShopSearchLinkSchema),
  position: z.int().positive(),
});
export type ShopGroup = z.infer<typeof ShopGroupSchema>;

/** `GET /v1/renders/:id/products` 200 response. */
export const ProductsPanelSchema = z
  .strictObject({
    panelState: PanelStateSchema,
    linkMode: LinkModeSchema.nullable(),
    /** Null unless `panelState` is `active`. */
    season: ShopSeasonSchema.nullable(),
    disclosure: z.strictObject({
      copyKeys: z.array(DisclosureCopyKeySchema),
      programs: z.array(z.string()),
    }),
    retailers: z.array(z.strictObject({ programKey: z.string(), merchantName: z.string() })),
    groups: z.array(ShopGroupSchema),
  })
  .refine(
    (panel) =>
      panel.panelState === 'active' || (panel.groups.length === 0 && panel.retailers.length === 0),
    {
      message: 'groups and retailers must be empty unless panelState is active',
      path: ['groups'],
    },
  )
  .refine(
    (panel) =>
      panel.groups.every(
        (group) =>
          group.options.length > 0 ||
          group.searchLinks.length > 0 ||
          group.separateLinks.length > 0,
      ),
    {
      message: 'every group needs an option, a search link or a separate link',
      path: ['groups'],
    },
  );
export type ProductsPanel = z.infer<typeof ProductsPanelSchema>;

/** `POST /v1/clicks` body and 201 response. */
export const CreateClickRequestSchema = z.strictObject({
  clickToken: z.string().min(1).max(512),
});
export type CreateClickRequest = z.infer<typeof CreateClickRequestSchema>;

export const CreateClickResponseSchema = z.strictObject({ clickId: UuidSchema });
export type CreateClickResponse = z.infer<typeof CreateClickResponseSchema>;
