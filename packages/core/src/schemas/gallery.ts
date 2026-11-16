import { z } from 'zod';
import { AttributionLogoSchema } from '../types/api.js';
import {
  HolidayIdSchema,
  LightingModeSchema,
  SceneTypeSchema,
  StyleSchema,
} from '../types/content.js';
import { IsoDateTimeSchema, MAX_PAGE_LIMIT, UuidSchema, paginated } from './common.js';

/** How gallery items are grouped: by place for address projects, by project for uploads. */
export const GALLERY_GROUP_KINDS = ['address', 'upload'] as const;
export const GalleryGroupKindSchema = z.enum(GALLERY_GROUP_KINDS);
export type GalleryGroupKind = z.infer<typeof GalleryGroupKindSchema>;

/** Where the photo a rendering decorates came from. */
export const GALLERY_SOURCE_KINDS = ['upload', 'street_view'] as const;
export const GallerySourceKindSchema = z.enum(GALLERY_SOURCE_KINDS);
export type GallerySourceKind = z.infer<typeof GallerySourceKindSchema>;

/** Default page size of `GET /v1/gallery`. */
export const GALLERY_DEFAULT_LIMIT = 60;

/** `GET /v1/gallery` query. */
export const GalleryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(GALLERY_DEFAULT_LIMIT),
  cursor: z.string().max(512).optional(),
});
export type GalleryQuery = z.infer<typeof GalleryQuerySchema>;

/**
 * The group a gallery item belongs to. `key` is the same for every rendering of the owner at one
 * place (address projects) or of one project (uploads); `label` is the stored display address of
 * the place, or null when none is stored (and always null for uploads).
 */
export const GalleryGroupSchema = z.strictObject({
  key: z.string().min(1).max(128),
  kind: GalleryGroupKindSchema,
  label: z.string().nullable(),
});
export type GalleryGroup = z.infer<typeof GalleryGroupSchema>;

/**
 * The credit a Street View-origin rendering is shown with: the stored attribution line (the policy
 * text and the image copyright) and the logo to draw beside it. Null for uploads.
 */
export const GalleryAttributionSchema = z.strictObject({
  text: z.string().min(1),
  logo: AttributionLogoSchema,
});
export type GalleryAttribution = z.infer<typeof GalleryAttributionSchema>;

/**
 * One rendering in the owner's gallery. URLs are signed and short-lived (at most 15 minutes).
 * `beforeImageUrl` is present only when a stored original exists; `downloadUrl` only when the
 * rendering may be downloaded; `attribution` exactly when `sourceKind` is `street_view`.
 */
export const GalleryItemSchema = z.strictObject({
  /** The render asset id. */
  id: UuidSchema,
  projectId: UuidSchema,
  group: GalleryGroupSchema,
  holidayId: HolidayIdSchema,
  style: StyleSchema,
  lightingMode: LightingModeSchema,
  sceneType: SceneTypeSchema,
  sourceKind: GallerySourceKindSchema,
  createdAt: IsoDateTimeSchema,
  imageUrl: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
  beforeImageUrl: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  attribution: GalleryAttributionSchema.nullable(),
});
export type GalleryItem = z.infer<typeof GalleryItemSchema>;

/** `GET /v1/gallery` 200 response, newest first. */
export const GalleryResponseSchema = paginated(GalleryItemSchema);
export type GalleryResponse = z.infer<typeof GalleryResponseSchema>;
