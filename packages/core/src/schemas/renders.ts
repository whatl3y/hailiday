import { z } from 'zod';
import { ErrorCodeSchema } from '../errors/codes.js';
import { AttributionLogoSchema, PermittedActionSchema } from '../types/api.js';
import {
  AnchorCategorySchema,
  type AnchorCategory,
  HolidayIdSchema,
  LightingModeSchema,
  StyleSchema,
} from '../types/content.js';
import {
  FailureCodeSchema,
  FailureDetailSchema,
  FailureKindSchema,
  MAX_RENDER_ATTEMPTS,
  RejectionReasonSchema,
  RenderJobStateSchema,
  StageLabelKeySchema,
} from '../types/render.js';
import { AllowanceSchema, CopyKeySchema, IsoDateTimeSchema, UuidSchema } from './common.js';
import { OfferedSetSchema } from './experience.js';

/** `POST /v1/renders` body; requires the `Idempotency-Key` header. */
export const CreateRenderRequestSchema = z.strictObject({
  projectId: UuidSchema,
  projectVersion: z.int().nonnegative(),
  holidayId: HolidayIdSchema,
  style: StyleSchema,
  lightingMode: LightingModeSchema,
});
export type CreateRenderRequest = z.infer<typeof CreateRenderRequestSchema>;

/** Client-minted idempotency keys: a UUID v4, at most 64 characters. */
export const IdempotencyKeySchema = z.string().min(1).max(64);

/** Attribution that must accompany a Street View-origin image. */
export const AttributionSchema = z.strictObject({
  required: z.boolean(),
  text: z.string(),
  logo: AttributionLogoSchema,
});
export type Attribution = z.infer<typeof AttributionSchema>;

/**
 * Anchor categories a variant's accepted plan decorated, deduplicated, in plan order (the
 * generated image's alt text summarizes them).
 */
export const VariantPlacementsSchema = z
  .array(AnchorCategorySchema)
  .refine((categories) => new Set(categories).size === categories.length, {
    message: 'placements must not repeat a category',
  });

/** `Variant.placements` from a plan's placements: each anchor category once, in plan order. */
export function variantPlacements(
  placements: readonly { anchorCategory: AnchorCategory }[],
): AnchorCategory[] {
  return [...new Set(placements.map((placement) => placement.anchorCategory))];
}

/**
 * Shared `Variant` object (an accepted variant). `sourceAssetId` is the source the variant was
 * rendered from (the first component of its variant key), so a client can tell variants of the
 * project's active source from variants of an earlier one. `placements` lists the anchor
 * categories of the accepted plan.
 */
export const VariantSchema = z.strictObject({
  renderAssetId: UuidSchema,
  renderJobId: UuidSchema,
  sourceAssetId: UuidSchema,
  holidayId: HolidayIdSchema,
  style: StyleSchema,
  lightingMode: LightingModeSchema,
  holidayPackVersion: z.string(),
  compilerVersion: z.string(),
  imageUrl: z.string(),
  beforeImageUrl: z.string().nullable(),
  width: z.int().positive(),
  height: z.int().positive(),
  labelKey: CopyKeySchema,
  attribution: AttributionSchema.nullable(),
  distributable: z.boolean(),
  downloadable: z.boolean(),
  downloadUrl: z.string().nullable(),
  privateOnly: z.boolean(),
  existingDecorConflict: z.boolean(),
  placements: VariantPlacementsSchema,
  sourceState: z.enum(['ready', 'stale']),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
});
export type Variant = z.infer<typeof VariantSchema>;

/** Render job timestamps (UTC, null until written). */
export const RenderTimestampsSchema = z.strictObject({
  requestedAt: IsoDateTimeSchema,
  sourceReadyAt: IsoDateTimeSchema.nullable(),
  startedAt: IsoDateTimeSchema.nullable(),
  renderStartedAt: IsoDateTimeSchema.nullable(),
  renderCompletedAt: IsoDateTimeSchema.nullable(),
  qaPassedAt: IsoDateTimeSchema.nullable(),
  reviewCompletedAt: IsoDateTimeSchema.nullable(),
  succeededAt: IsoDateTimeSchema.nullable(),
  terminalAt: IsoDateTimeSchema.nullable(),
});
export type RenderTimestamps = z.infer<typeof RenderTimestampsSchema>;

/** Shared `RenderStatus` object; also the payload of every SSE `render` event. */
export const RenderStatusSchema = z.strictObject({
  renderJobId: UuidSchema,
  projectId: UuidSchema,
  projectVersion: z.int().nonnegative(),
  state: RenderJobStateSchema,
  stageLabelKey: StageLabelKeySchema.nullable(),
  seq: z.int().nonnegative(),
  attempt: z.int().min(0).max(MAX_RENDER_ATTEMPTS),
  repairUsed: z.boolean(),
  queuePosition: z.int().nonnegative().nullable(),
  holidayId: HolidayIdSchema,
  style: StyleSchema,
  lightingMode: LightingModeSchema,
  failureKind: FailureKindSchema.nullable(),
  failureDetail: FailureDetailSchema.nullable(),
  rejectionReason: RejectionReasonSchema.nullable(),
  failureCodes: z.array(FailureCodeSchema),
  errorCode: ErrorCodeSchema.nullable(),
  permittedActions: z.array(PermittedActionSchema),
  variant: VariantSchema.nullable(),
  supersededByRenderJobId: UuidSchema.nullable(),
  timestamps: RenderTimestampsSchema,
  allowance: AllowanceSchema,
});
export type RenderStatus = z.infer<typeof RenderStatusSchema>;

/** `POST /v1/renders` 200 response: an accepted variant already exists for the key. */
export const CachedRenderResponseSchema = z.strictObject({
  cached: z.literal(true),
  variant: VariantSchema,
  allowance: AllowanceSchema,
});
export type CachedRenderResponse = z.infer<typeof CachedRenderResponseSchema>;

/** `POST /v1/renders` 202 response: a queued job. */
export const QueuedRenderResponseSchema = RenderStatusSchema.extend({
  cached: z.literal(false),
  supersededRenderJobId: UuidSchema.nullable(),
});
export type QueuedRenderResponse = z.infer<typeof QueuedRenderResponseSchema>;

export const CreateRenderResponseSchema = z.discriminatedUnion('cached', [
  CachedRenderResponseSchema,
  QueuedRenderResponseSchema,
]);
export type CreateRenderResponse = z.infer<typeof CreateRenderResponseSchema>;

/** `POST /v1/renders/:id/cancel` body. */
export const CancelRenderRequestSchema = z.strictObject({});

/** `GET /v1/projects/:id/variants` 200 response. */
export const VariantListResponseSchema = z.strictObject({
  items: z.array(VariantSchema),
  activeRender: RenderStatusSchema.nullable(),
  offered: OfferedSetSchema.nullable(),
});
export type VariantListResponse = z.infer<typeof VariantListResponseSchema>;

/** Server-sent events for render progress. */
export const RENDER_SSE_EVENT = 'render';
export const RENDER_SSE_RETRY_MS = 3000;
export const RenderEventSchema = RenderStatusSchema;
export type RenderEvent = RenderStatus;

/** Label key on every generated image. */
export const AI_PREVIEW_LABEL_KEY = 'result.aiPreview';
