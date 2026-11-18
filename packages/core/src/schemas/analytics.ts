import { z } from 'zod';
import { ErrorCodeSchema } from '../errors/codes.js';
import {
  AnalyticsEmitterSchema,
  AnalyticsEventNameSchema,
  ByteBucketSchema,
  CompareModeSchema,
  DistanceBucketSchema,
  HolidayChangeSurfaceSchema,
  NavigationTypeSchema,
  PhotoPromptContextSchema,
  ProjectDeletedScopeSchema,
  ReferrerClassSchema,
  RenderRequestOutcomeSchema,
  WebVitalsPageSchema,
} from '../types/analytics.js';
import type { AnalyticsEventName, ClientAnalyticsEventName } from '../types/analytics.js';
import { isClientAnalyticsEventName } from '../types/analytics.js';
import {
  AllowanceScopeSchema,
  FeedbackReasonSchema,
  FeedbackVerdictSchema,
  ReportReasonSchema,
  ReportTargetKindSchema,
} from '../types/api.js';
import {
  LinkModeSchema,
  PanelStateSchema,
  ProductRelationshipSchema,
  ShopGroupBasisSchema,
  ShopLinkKindSchema,
  ShopSeasonSchema,
} from '../types/commerce.js';
import {
  HolidayIdSchema,
  LightingModeSchema,
  RoomTypeSchema,
  SceneTypeSchema,
  StyleSchema,
} from '../types/content.js';
import {
  FailureCodeSchema,
  FailureDetailSchema,
  FailureKindSchema,
  FidelityModeSchema,
  MAX_RENDER_ATTEMPTS,
  NonTerminalRenderJobStateSchema,
  RejectionReasonSchema,
  ReviewModeSchema,
} from '../types/render.js';
import {
  CaptureMethodSchema,
  EntryMethodSchema,
  MatchClassSchema,
  PrecisionSchema,
  SkipReasonSchema,
  SourceKindSchema,
  StreetViewSourceModeSchema,
  UploadDeclineReasonSchema,
} from '../types/source.js';
import { CountryCodeSchema, IsoDateTimeSchema } from './common.js';

const count = z.int().nonnegative();
const durationMs = z.number().nonnegative();
const experimentSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

/**
 * Property schemas per event. Properties are enums, counts, durations and error codes only:
 * never addresses, place IDs, coordinates, URLs, object keys, prompts, emails or free text.
 * Unknown keys are stripped.
 */
export const ANALYTICS_EVENT_PROPERTY_SCHEMAS = {
  landing_viewed: z.object({
    defaultHolidayId: HolidayIdSchema.nullable(),
    inWindow: z.boolean(),
    offSeason: z.boolean(),
    referrerClass: ReferrerClassSchema,
  }),
  holiday_changed: z.object({
    fromHolidayId: HolidayIdSchema.nullable(),
    toHolidayId: HolidayIdSchema,
    surface: HolidayChangeSurfaceSchema,
  }),
  address_selected: z.object({
    entryMethod: EntryMethodSchema.extract(['autocomplete']),
    suggestionRank: count.nullable(),
    precision: PrecisionSchema,
    multiUnit: z.boolean(),
  }),
  address_manual_submitted: z.object({
    candidateCount: count,
    precision: PrecisionSchema.nullable(),
    partialMatch: z.boolean().nullable(),
  }),
  source_discovery_completed: z.object({
    matchClass: MatchClassSchema,
    reason: SkipReasonSchema.nullable(),
    sourceMode: StreetViewSourceModeSchema,
    candidateCount: count,
    durationMs,
    isGoogleImagery: z.boolean().nullable(),
    distanceBucket: DistanceBucketSchema,
  }),
  source_confirmed: z.object({
    sourceKind: SourceKindSchema,
    candidateRank: count.nullable(),
    nudged: z.boolean(),
    cropApplied: z.boolean(),
    privateOnly: z.boolean(),
  }),
  source_unavailable: z.object({ reason: SkipReasonSchema }),
  photo_prompt_shown: z.object({ context: PhotoPromptContextSchema }),
  upload_started: z.object({
    captureMethod: CaptureMethodSchema,
    contentType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/i),
    byteBucket: ByteBucketSchema,
  }),
  upload_accepted: z.object({
    sceneType: SceneTypeSchema.nullable(),
    roomType: RoomTypeSchema.nullable(),
    peopleDetected: z.boolean(),
    screeningMs: durationMs,
  }),
  upload_declined: z.object({
    declineCode: ErrorCodeSchema,
    declineReason: UploadDeclineReasonSchema.nullable(),
  }),
  render_requested: z.object({
    style: StyleSchema,
    lightingMode: LightingModeSchema,
    isFirstRender: z.boolean(),
    outcome: RenderRequestOutcomeSchema,
  }),
  render_succeeded: z.object({
    latencyMs: durationMs,
    attempts: z.int().min(1).max(MAX_RENDER_ATTEMPTS),
    repaired: z.boolean(),
    reviewMode: ReviewModeSchema,
    reviewWaitMs: durationMs.nullable(),
    style: StyleSchema,
    lightingMode: LightingModeSchema,
    fidelityMode: FidelityModeSchema,
  }),
  render_rejected: z.object({
    rejectionReason: RejectionReasonSchema,
    failureCodes: z.array(FailureCodeSchema),
    attempts: z.int().min(0).max(MAX_RENDER_ATTEMPTS),
  }),
  render_failed: z.object({
    failureKind: FailureKindSchema,
    failureDetail: FailureDetailSchema.nullable(),
    attempts: z.int().min(0).max(MAX_RENDER_ATTEMPTS),
  }),
  render_canceled: z.object({
    stateAtCancel: NonTerminalRenderJobStateSchema,
    elapsedMs: durationMs,
  }),
  render_superseded: z.object({
    stateAtSupersede: NonTerminalRenderJobStateSchema,
    elapsedMs: durationMs,
    attemptInFlight: z.boolean(),
  }),
  render_expired: z.object({
    stateAtExpiry: NonTerminalRenderJobStateSchema,
    elapsedMs: durationMs,
  }),
  variant_viewed: z.object({
    cached: z.boolean(),
    style: StyleSchema,
    lightingMode: LightingModeSchema,
  }),
  compare_used: z.object({ mode: CompareModeSchema }),
  allowance_reached: z.object({
    scope: AllowanceScopeSchema,
    gateVariant: experimentSlug,
  }),
  shop_panel_viewed: z.object({
    panelState: PanelStateSchema,
    /** Number of groups. */
    cardCount: count,
    optionCount: count,
    /** Search links and separate links together. */
    searchLinkCount: count,
    season: ShopSeasonSchema.nullable(),
    linkMode: LinkModeSchema.nullable(),
    programs: z.array(experimentSlug).max(20),
    relationships: z.array(ProductRelationshipSchema).max(20),
  }),
  product_clicked: z.object({
    /** Null for a search link. */
    relationship: ProductRelationshipSchema.nullable(),
    /** Position of the group. */
    rankPosition: z.int().positive(),
    optionPosition: z.int().positive(),
    linkKind: ShopLinkKindSchema,
    groupBasis: ShopGroupBasisSchema,
    merchantProgramId: z.string().max(64),
    linkMode: LinkModeSchema,
    sponsored: z.boolean(),
  }),
  project_saved: z.object({ newAccount: z.boolean() }),
  share_created: z.object({ includeBefore: z.boolean() }),
  share_viewed: z.object({
    referrerClass: ReferrerClassSchema,
    viewerHasSession: z.boolean(),
  }),
  project_deleted: z.object({
    scope: ProjectDeletedScopeSchema,
    variantCount: count,
  }),
  feedback_submitted: z.object({
    verdict: FeedbackVerdictSchema,
    reasons: z.array(FeedbackReasonSchema),
  }),
  report_submitted: z.object({
    reason: ReportReasonSchema,
    targetKind: ReportTargetKindSchema,
    requestOptOut: z.boolean(),
  }),
  web_vitals: z.object({
    lcpMs: durationMs.nullable(),
    inpMs: durationMs.nullable(),
    cls: z.number().nonnegative().nullable(),
    page: WebVitalsPageSchema,
    navigationType: NavigationTypeSchema,
  }),
  experiment_shown: z.object({ experimentId: experimentSlug, arm: experimentSlug }),
  experiment_clicked: z.object({ experimentId: experimentSlug, arm: experimentSlug }),
  lead_submitted: z.object({ experimentId: experimentSlug, sceneType: SceneTypeSchema }),
} as const satisfies Record<AnalyticsEventName, z.ZodObject>;

export type AnalyticsEventProperties<N extends AnalyticsEventName> = z.infer<
  (typeof ANALYTICS_EVENT_PROPERTY_SCHEMAS)[N]
>;

/** Optional envelope dimensions. */
const dimensions = {
  holidayId: HolidayIdSchema.nullable().optional(),
  sceneType: SceneTypeSchema.nullable().optional(),
  sourceKind: SourceKindSchema.nullable().optional(),
};

/** The stored envelope common to every event. */
export const AnalyticsEnvelopeSchema = z.strictObject({
  name: AnalyticsEventNameSchema,
  occurredAt: IsoDateTimeSchema,
  sessionHash: z.string().min(1),
  emitter: AnalyticsEmitterSchema,
  countryCode: CountryCodeSchema,
  appVersion: z.string().min(1),
  fixture: z.boolean().optional(),
  ...dimensions,
});
export type AnalyticsEnvelope = z.infer<typeof AnalyticsEnvelopeSchema>;

/** Default maximum events per `POST /v1/analytics` batch (configuration). */
export const ANALYTICS_BATCH_MAX_EVENTS = 20;

/** One client-emitted event as it arrives; properties are validated per event afterwards. */
export const ClientAnalyticsEventInputSchema = z.strictObject({
  name: z.string().min(1).max(64),
  occurredAt: IsoDateTimeSchema,
  properties: z.record(z.string(), z.unknown()).default({}),
  ...dimensions,
});
export type ClientAnalyticsEventInput = z.infer<typeof ClientAnalyticsEventInputSchema>;

export function makeAnalyticsBatchSchema(maxEvents: number = ANALYTICS_BATCH_MAX_EVENTS) {
  return z.strictObject({
    events: z.array(ClientAnalyticsEventInputSchema).min(1).max(maxEvents),
  });
}

/** `POST /v1/analytics` body; 202 `{}`. */
export const AnalyticsBatchSchema = makeAnalyticsBatchSchema();
export type AnalyticsBatch = z.infer<typeof AnalyticsBatchSchema>;

export interface ValidatedClientEvent {
  name: ClientAnalyticsEventName;
  occurredAt: string;
  properties: Record<string, unknown>;
  holidayId: z.infer<typeof HolidayIdSchema> | null;
  sceneType: z.infer<typeof SceneTypeSchema> | null;
  sourceKind: z.infer<typeof SourceKindSchema> | null;
}

/**
 * Validates one client event: only client-emitted names are accepted and properties must
 * match the event's schema. Returns null for anything that must be dropped.
 */
export function validateClientAnalyticsEvent(
  event: ClientAnalyticsEventInput,
): ValidatedClientEvent | null {
  if (!isClientAnalyticsEventName(event.name)) return null;
  const parsed = ANALYTICS_EVENT_PROPERTY_SCHEMAS[event.name].safeParse(event.properties);
  if (!parsed.success) return null;
  return {
    name: event.name,
    occurredAt: event.occurredAt,
    properties: parsed.data as Record<string, unknown>,
    holidayId: event.holidayId ?? null,
    sceneType: event.sceneType ?? null,
    sourceKind: event.sourceKind ?? null,
  };
}

/** Validates server-emitted properties for an event; throws on mismatch. */
export function parseAnalyticsProperties<N extends AnalyticsEventName>(
  name: N,
  properties: unknown,
): AnalyticsEventProperties<N> {
  return ANALYTICS_EVENT_PROPERTY_SCHEMAS[name].parse(properties) as AnalyticsEventProperties<N>;
}
