import { z } from 'zod';
import { ReportResolutionActionSchema, ReportStatusSchema } from '../types/api.js';
import { OfferLifecycleStatusSchema } from '../types/commerce.js';
import { SceneTypeSchema } from '../types/content.js';
import type { SceneType } from '../types/content.js';
import {
  BlockedAddressSourceSchema,
  PreservationHoldReasonSchema,
  PreservationHoldTargetKindSchema,
  SPEND_CEILING_KEYS,
  SpendCeilingKeySchema,
} from '../types/ops.js';
import { ReviewDecisionSchema, ReviewModeSchema } from '../types/render.js';
import type { ReviewMode } from '../types/render.js';
import { ActivationStateSchema, CapabilityKeySchema } from '../types/rights.js';
import { CountryCodeSchema, IsoDateTimeSchema, UuidSchema } from './common.js';

const version = z.int().nonnegative();

/** One `country_capabilities` row. */
export const CapabilityRecordSchema = z.strictObject({
  countryCode: CountryCodeSchema,
  capability: CapabilityKeySchema,
  state: ActivationStateSchema,
  evidenceRef: z.string().min(1),
  reviewedAt: IsoDateTimeSchema,
  reviewedBy: UuidSchema.nullable(),
  version,
});
export type CapabilityRecord = z.infer<typeof CapabilityRecordSchema>;

export const CapabilityListResponseSchema = z.strictObject({
  items: z.array(CapabilityRecordSchema),
});

/** `PUT /internal/v1/capabilities/:countryCode/:capability` body. */
export const PutCapabilityRequestSchema = z
  .strictObject({
    state: ActivationStateSchema,
    evidenceRef: z.string().min(1).max(1000),
    reviewedAt: IsoDateTimeSchema,
    version,
    confirm: z.boolean().optional(),
  })
  .refine((body) => body.state !== 'live_public' || body.confirm === true, {
    message: 'live_public requires confirm: true',
    path: ['confirm'],
  });
export type PutCapabilityRequest = z.infer<typeof PutCapabilityRequestSchema>;

export const CapabilityParamsSchema = z.strictObject({
  countryCode: CountryCodeSchema,
  capability: CapabilityKeySchema,
});

/** `GET`/`PUT /internal/v1/pause`. */
export const PauseStateSchema = z.strictObject({
  global: z.boolean(),
  providers: z.record(z.string(), z.boolean()),
  reason: z.string().max(500).optional(),
  version,
});
export type PauseState = z.infer<typeof PauseStateSchema>;

/** `GET`/`PUT /internal/v1/ceilings`. Amounts are USD micros. */
export const CeilingsSchema = z.strictObject({
  dailyMicros: z.int().nonnegative(),
  monthlyMicros: z.int().nonnegative(),
  skuDailyMicros: z.partialRecord(SpendCeilingKeySchema, z.int().nonnegative()),
  version,
});
export type Ceilings = z.infer<typeof CeilingsSchema>;

/** `GET`/`PUT /internal/v1/settings/:key`. */
export const SettingWriteSchema = z.strictObject({ value: z.unknown(), version });
export type SettingWrite = z.infer<typeof SettingWriteSchema>;

export const SettingRecordSchema = z.strictObject({
  key: z.string(),
  value: z.unknown(),
  version,
  updatedAt: IsoDateTimeSchema.nullable(),
});
export type SettingRecord = z.infer<typeof SettingRecordSchema>;

/** `POST /internal/v1/reviews/:renderJobId/decision` body. */
export const ReviewDecisionRequestSchema = z
  .strictObject({
    decision: ReviewDecisionSchema,
    reasonCodes: z.array(z.string().min(1).max(64)).default([]),
    notes: z.string().max(2000).optional(),
    adherence: z
      .array(
        z.strictObject({
          placementId: z.string().min(1),
          status: z.enum(['pass', 'fail', 'uncertain']),
        }),
      )
      .optional(),
  })
  .refine((body) => body.decision !== 'reject' || body.reasonCodes.length > 0, {
    message: 'reject requires reasonCodes',
    path: ['reasonCodes'],
  });
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;

/** `POST /internal/v1/upload-holds/:sourceAssetId/decision` body. */
export const UploadHoldDecisionRequestSchema = z.strictObject({
  decision: ReviewDecisionSchema,
  reasonCode: z.string().min(1).max(64).optional(),
});
export type UploadHoldDecisionRequest = z.infer<typeof UploadHoldDecisionRequestSchema>;

/** `POST /internal/v1/reports/:id/triage` body. */
export const ReportTriageRequestSchema = z.strictObject({
  status: ReportStatusSchema,
  assigneeUserId: UuidSchema.optional(),
  resolution: z
    .strictObject({
      action: ReportResolutionActionSchema,
      placeId: z.string().min(1).optional(),
      evidenceRef: z.string().min(1).optional(),
      notes: z.string().max(2000).optional(),
    })
    .optional(),
});
export type ReportTriageRequest = z.infer<typeof ReportTriageRequestSchema>;

/** `POST /internal/v1/preservation-holds` body. */
export const CreatePreservationHoldRequestSchema = z.strictObject({
  targetKind: PreservationHoldTargetKindSchema,
  targetId: UuidSchema,
  reason: PreservationHoldReasonSchema,
  authorityRef: z.string().min(1),
  releaseCondition: z.string().min(1),
});
export type CreatePreservationHoldRequest = z.infer<typeof CreatePreservationHoldRequestSchema>;

export const ReleasePreservationHoldRequestSchema = z.strictObject({
  releaseReason: z.string().min(1),
});

/** `POST /internal/v1/blocked-addresses` body. */
export const CreateBlockedAddressRequestSchema = z.strictObject({
  placeId: z.string().min(1),
  normalizedAddressHash: z.string().optional(),
  source: BlockedAddressSourceSchema,
  evidenceRef: z.string().min(1),
  expiresAt: IsoDateTimeSchema.nullable().default(null),
});
export type CreateBlockedAddressRequest = z.infer<typeof CreateBlockedAddressRequestSchema>;

/** `PUT /internal/v1/offers/:id/status` body. */
export const OfferStatusRequestSchema = z.strictObject({ status: OfferLifecycleStatusSchema });

/** Runtime setting value schemas, keyed by exact key or prefix pattern. */
const positiveInt = z.int().positive();
const nonNegativeInt = z.int().nonnegative();

export const RUNTIME_SETTING_SCHEMAS = {
  'allowance.variants_per_24h': nonNegativeInt,
  'allowance.addresses_per_24h': nonNegativeInt,
  'allowance.new_owner_variants_per_24h': nonNegativeInt.nullable(),
  'quota.attempts_per_owner_24h': nonNegativeInt,
  'quota.render_requests_per_device_24h': nonNegativeInt,
  'quota.render_requests_per_ip_24h': nonNegativeInt,
  'rate.suggestions_per_token': positiveInt,
  'rate.suggestions_per_session_10m': positiveInt,
  'rate.session_tokens_per_10m': positiveInt,
  'rate.sessions_per_ip_10m': positiveInt,
  'rate.resolve_per_token': positiveInt,
  'rate.geocode_per_session_10m': positiveInt,
  'rate.static_display_loads_per_address': nonNegativeInt,
  'spend.daily_micros': nonNegativeInt,
  'spend.monthly_micros': nonNegativeInt,
  'admission.max_queue_depth': nonNegativeInt,
  'admission.max_wait_s': nonNegativeInt,
  'pause.global': z.boolean(),
  'discovery.autostart_paused': z.boolean(),
  'review.mode': z.partialRecord(SceneTypeSchema, ReviewModeSchema),
  'review.audit_sample_rate': z.number().min(0).max(1),
  'idempotency.retention_h': positiveInt,
  'sse.heartbeat_s': positiveInt,
  'poll.render_ms': positiveInt,
  'poll.upload_ms': positiveInt,
} as const;
export type RuntimeSettingKey = keyof typeof RUNTIME_SETTING_SCHEMAS;

const PATTERNED_SETTING_SCHEMAS: readonly [RegExp, z.ZodType][] = [
  [new RegExp(`^spend\\.sku_daily_micros\\.(${SPEND_CEILING_KEYS.join('|')})$`), nonNegativeInt],
  [/^admission\.provider_concurrency\.[a-z0-9_-]+$/, positiveInt],
  [/^pause\.provider\.[a-z0-9_-]+$/, z.boolean()],
];

/** The value schema for a runtime setting key, or null for an unknown key. */
export function runtimeSettingSchemaFor(key: string): z.ZodType | null {
  if (Object.hasOwn(RUNTIME_SETTING_SCHEMAS, key)) {
    return RUNTIME_SETTING_SCHEMAS[key as RuntimeSettingKey];
  }
  for (const [pattern, schema] of PATTERNED_SETTING_SCHEMAS) {
    if (pattern.test(key)) return schema;
  }
  return null;
}

export function isRuntimeSettingKey(key: string): boolean {
  return runtimeSettingSchemaFor(key) !== null;
}

/** The review mode for a scene type; scene types without an entry stay in `pre_delivery`. */
export function reviewModeFor(
  value: Partial<Record<SceneType, ReviewMode>>,
  sceneType: SceneType,
): ReviewMode {
  return value[sceneType] ?? 'pre_delivery';
}
