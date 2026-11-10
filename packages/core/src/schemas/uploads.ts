import { z } from 'zod';
import { BuildingFormSchema, RoomTypeSchema, SceneTypeSchema } from '../types/content.js';
import {
  DetectedFormatSchema,
  QualityHintSchema,
  SourceAssetStateSchema,
  UploadDeclineCodeSchema,
  UploadDeclineReasonClassSchema,
  UploadGuidanceReasonSchema,
} from '../types/source.js';
import { NormalizedBoxSchema } from './box.js';
import { IsoDateTimeSchema, UuidSchema } from './common.js';

/** Default upload limits (configuration). */
export const DEFAULT_UPLOAD_MAX_BYTES = 26_214_400;
export const DEFAULT_UPLOAD_MAX_PIXELS = 50_000_000;
export const DEFAULT_UPLOAD_MIN_SHORT_EDGE = 640;

/** `POST /v1/uploads` body. The declared content type is advisory. */
export const CreateUploadRequestSchema = z.strictObject({
  projectId: UuidSchema,
  contentType: z
    .string()
    .max(100)
    .regex(/^[a-z]+\/[a-z0-9.+-]+$/i, 'Expected a media type'),
  byteLength: z.int().positive(),
  clientPrepared: z.boolean(),
  attestation: z.strictObject({
    accepted: z.literal(true),
    attestationVersion: z.string().min(1).max(100),
  }),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

/** A presigned POST form the browser submits directly to object storage. */
export const PresignedPostSchema = z.strictObject({
  method: z.literal('POST'),
  url: z.string().min(1),
  fields: z.record(z.string(), z.string()),
  expiresAt: IsoDateTimeSchema,
  maxBytes: z.int().positive(),
});
export type PresignedPost = z.infer<typeof PresignedPostSchema>;

/** `POST /v1/uploads` 201 response. */
export const CreateUploadResponseSchema = z.strictObject({
  sourceAssetId: UuidSchema,
  state: SourceAssetStateSchema,
  upload: PresignedPostSchema,
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

/** `POST /v1/uploads/:id/complete` body and 202 response. */
export const CompleteUploadRequestSchema = z.strictObject({});
export const CompleteUploadResponseSchema = z.strictObject({
  sourceAssetId: UuidSchema,
  state: SourceAssetStateSchema,
});
export type CompleteUploadResponse = z.infer<typeof CompleteUploadResponseSchema>;

export const UploadPeopleSchema = z.strictObject({
  detected: z.boolean(),
  boxes: z.array(NormalizedBoxSchema),
  suggestedCropBox: NormalizedBoxSchema.nullable(),
});
export type UploadPeople = z.infer<typeof UploadPeopleSchema>;

/** `GET /v1/uploads/:id` 200 response. */
export const UploadStatusSchema = z.strictObject({
  sourceAssetId: UuidSchema,
  state: SourceAssetStateSchema,
  holdForReview: z.boolean(),
  sceneType: SceneTypeSchema.nullable(),
  sceneTypeConfidence: z.number().min(0).max(1).nullable(),
  roomType: RoomTypeSchema.nullable(),
  buildingForm: BuildingFormSchema.nullable(),
  multiUnitFacade: z.boolean(),
  people: UploadPeopleSchema,
  guidance: z.array(QualityHintSchema),
  detectedFormat: DetectedFormatSchema.nullable(),
  attestationVersion: z.string().nullable(),
  declineCode: UploadDeclineCodeSchema.nullable(),
  declineReasonClass: UploadDeclineReasonClassSchema.nullable(),
  declineReason: UploadGuidanceReasonSchema.nullable(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
});
export type UploadStatus = z.infer<typeof UploadStatusSchema>;

/** Scene type confidence at or above which detection is accepted without a tap. */
export const DEFAULT_SCENE_TYPE_AUTO_ACCEPT = 0.8;
