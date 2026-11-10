import { z } from 'zod';
import {
  DisclosureCopyKeySchema,
  LinkModeSchema,
  PanelStateSchema,
  ProductRelationshipSchema,
} from '../types/commerce.js';
import { AnchorCategorySchema } from '../types/content.js';
import { CopyKeySchema, CurrencyCodeSchema, IsoDateTimeSchema, UuidSchema } from './common.js';

/** Price on a product card: shown only when a permitted, timestamped price exists. */
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

/** One Shop the look card. */
export const ProductCardSchema = z.strictObject({
  clickToken: z.string().min(1),
  title: z.string(),
  merchantName: z.string(),
  relationship: ProductRelationshipSchema,
  relationshipLabelKey: CopyKeySchema,
  anchorCategory: AnchorCategorySchema.nullable(),
  price: CardPriceSchema,
  linkMode: LinkModeSchema,
  sponsored: z.boolean(),
  href: z.string(),
  rankPosition: z.int().positive(),
});
export type ProductCard = z.infer<typeof ProductCardSchema>;

/** `GET /v1/renders/:id/products` 200 response. */
export const ProductsPanelSchema = z
  .strictObject({
    panelState: PanelStateSchema,
    linkMode: LinkModeSchema.nullable(),
    disclosure: z.strictObject({
      copyKeys: z.array(DisclosureCopyKeySchema),
      programs: z.array(z.string()),
    }),
    items: z.array(ProductCardSchema),
  })
  .refine((panel) => panel.panelState === 'active' || panel.items.length === 0, {
    message: 'items must be empty unless panelState is active',
    path: ['items'],
  });
export type ProductsPanel = z.infer<typeof ProductsPanelSchema>;

/** `POST /v1/clicks` body and 201 response. */
export const CreateClickRequestSchema = z.strictObject({
  clickToken: z.string().min(1).max(512),
});
export type CreateClickRequest = z.infer<typeof CreateClickRequestSchema>;

export const CreateClickResponseSchema = z.strictObject({ clickId: UuidSchema });
export type CreateClickResponse = z.infer<typeof CreateClickResponseSchema>;
