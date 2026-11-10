import { z } from 'zod';
import {
  FeedbackReasonSchema,
  FeedbackVerdictSchema,
  ReportAcknowledgementKeySchema,
  ReportReasonSchema,
} from '../types/api.js';
import { HolidayIdSchema, StyleSchema } from '../types/content.js';
import { CopyKeySchema, IsoDateTimeSchema, UuidSchema } from './common.js';
import { AttributionSchema } from './renders.js';

/** Share tokens: 128-bit random values encoded base64url. */
export const ShareTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, 'Expected a share token');

export const ShareTokenParamsSchema = z.strictObject({ token: ShareTokenSchema });

/** `POST /v1/shares` body; accepts `Idempotency-Key`. */
export const CreateShareRequestSchema = z.strictObject({
  renderAssetId: UuidSchema,
  includeBefore: z.boolean().default(false),
});
export type CreateShareRequest = z.infer<typeof CreateShareRequestSchema>;

/** `POST /v1/shares` 201 response. */
export const CreateShareResponseSchema = z.strictObject({
  token: ShareTokenSchema,
  url: z.string(),
  expiresAt: IsoDateTimeSchema,
  cardUrl: z.string(),
});
export type CreateShareResponse = z.infer<typeof CreateShareResponseSchema>;

/** `GET /v1/shares/:token` 200 response: no address, owner or products. */
export const ShareViewSchema = z.strictObject({
  holidayId: HolidayIdSchema,
  style: StyleSchema,
  imageUrl: z.string(),
  beforeImageUrl: z.string().nullable(),
  width: z.int().positive(),
  height: z.int().positive(),
  labelKey: CopyKeySchema,
  attribution: AttributionSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  report: z.strictObject({ targetKind: z.literal('share') }),
});
export type ShareView = z.infer<typeof ShareViewSchema>;

/** Maximum feedback note length. */
export const FEEDBACK_NOTE_MAX_LENGTH = 500;

/** `POST /v1/feedback` body; accepts `Idempotency-Key`. */
export const CreateFeedbackRequestSchema = z.strictObject({
  renderAssetId: UuidSchema,
  verdict: FeedbackVerdictSchema,
  reasons: z.array(FeedbackReasonSchema).max(5).default([]),
  note: z.string().max(FEEDBACK_NOTE_MAX_LENGTH).optional(),
});
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackRequestSchema>;

export const CreateFeedbackResponseSchema = z.strictObject({ feedbackId: UuidSchema });
export type CreateFeedbackResponse = z.infer<typeof CreateFeedbackResponseSchema>;

/** Maximum report details length. */
export const REPORT_DETAILS_MAX_LENGTH = 2000;

/** What a report targets. */
export const ReportTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('share'), token: ShareTokenSchema }),
  z.strictObject({ kind: z.literal('render'), id: UuidSchema }),
  z.strictObject({ kind: z.literal('project'), id: UuidSchema }),
  z.strictObject({
    kind: z.literal('address'),
    placeId: z.string().min(1).max(512),
    addressText: z.string().max(500).optional(),
  }),
]);
export type ReportTarget = z.infer<typeof ReportTargetSchema>;

/** `POST /v1/reports` body. The homeowner opt-out is an `address` target. */
export const CreateReportRequestSchema = z
  .strictObject({
    target: ReportTargetSchema,
    reason: ReportReasonSchema,
    details: z.string().max(REPORT_DETAILS_MAX_LENGTH).optional(),
    contactEmail: z.email().max(320).optional(),
    requestOptOut: z.boolean().default(false),
    turnstileToken: z.string().min(1).max(4096).optional(),
  })
  .refine((body) => body.target.kind !== 'address' || body.reason === 'this_is_my_home', {
    message: 'An address target always has reason this_is_my_home',
    path: ['reason'],
  });
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;

/** `POST /v1/reports` 201 response. */
export const CreateReportResponseSchema = z.strictObject({
  reportId: UuidSchema,
  acknowledgementKey: ReportAcknowledgementKeySchema,
});
export type CreateReportResponse = z.infer<typeof CreateReportResponseSchema>;
