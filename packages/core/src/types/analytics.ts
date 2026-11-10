import { z } from 'zod';

/** First-party analytics event names. */
export const ANALYTICS_EVENT_NAMES = [
  'landing_viewed',
  'holiday_changed',
  'address_selected',
  'address_manual_submitted',
  'source_discovery_completed',
  'source_confirmed',
  'source_unavailable',
  'photo_prompt_shown',
  'upload_started',
  'upload_accepted',
  'upload_declined',
  'render_requested',
  'render_succeeded',
  'render_rejected',
  'render_failed',
  'render_canceled',
  'render_superseded',
  'render_expired',
  'variant_viewed',
  'compare_used',
  'allowance_reached',
  'shop_panel_viewed',
  'product_clicked',
  'project_saved',
  'share_created',
  'share_viewed',
  'project_deleted',
  'feedback_submitted',
  'report_submitted',
  'web_vitals',
  'experiment_shown',
  'experiment_clicked',
  'lead_submitted',
] as const;
export const AnalyticsEventNameSchema = z.enum(ANALYTICS_EVENT_NAMES);
export type AnalyticsEventName = z.infer<typeof AnalyticsEventNameSchema>;

/** Events the browser emits through `POST /v1/analytics`. */
export const CLIENT_ANALYTICS_EVENT_NAMES = [
  'holiday_changed',
  'variant_viewed',
  'compare_used',
  'shop_panel_viewed',
  'web_vitals',
  'experiment_shown',
  'experiment_clicked',
  'lead_submitted',
] as const;
export const ClientAnalyticsEventNameSchema = z.enum(CLIENT_ANALYTICS_EVENT_NAMES);
export type ClientAnalyticsEventName = z.infer<typeof ClientAnalyticsEventNameSchema>;

/** Events the server writes in the transaction of the action they describe. */
export const SERVER_ANALYTICS_EVENT_NAMES = ANALYTICS_EVENT_NAMES.filter(
  (name) => !(CLIENT_ANALYTICS_EVENT_NAMES as readonly string[]).includes(name),
) as readonly Exclude<AnalyticsEventName, ClientAnalyticsEventName>[];

export function isClientAnalyticsEventName(name: string): name is ClientAnalyticsEventName {
  return (CLIENT_ANALYTICS_EVENT_NAMES as readonly string[]).includes(name);
}

export const ANALYTICS_EMITTERS = ['client', 'server'] as const;
export const AnalyticsEmitterSchema = z.enum(ANALYTICS_EMITTERS);
export type AnalyticsEmitter = z.infer<typeof AnalyticsEmitterSchema>;

/** Coarse referrer classes on `landing_viewed` and `share_viewed`. */
export const REFERRER_CLASSES = ['direct', 'share', 'search', 'social', 'other'] as const;
export const ReferrerClassSchema = z.enum(REFERRER_CLASSES);
export type ReferrerClass = z.infer<typeof ReferrerClassSchema>;

/** Where a holiday change happened. */
export const HOLIDAY_CHANGE_SURFACES = ['landing', 'result', 'deep_link'] as const;
export const HolidayChangeSurfaceSchema = z.enum(HOLIDAY_CHANGE_SURFACES);
export type HolidayChangeSurface = z.infer<typeof HolidayChangeSurfaceSchema>;

/** Before/after comparison modes. */
export const COMPARE_MODES = ['slider', 'toggle', 'keyboard'] as const;
export const CompareModeSchema = z.enum(COMPARE_MODES);
export type CompareMode = z.infer<typeof CompareModeSchema>;

/** Why the photo prompt was shown. */
export const PHOTO_PROMPT_CONTEXTS = ['display_only', 'skip_to_upload', 'no_imagery'] as const;
export const PhotoPromptContextSchema = z.enum(PHOTO_PROMPT_CONTEXTS);
export type PhotoPromptContext = z.infer<typeof PhotoPromptContextSchema>;

/** Outcome of a render request. */
export const RENDER_REQUEST_OUTCOMES = [
  'queued',
  'cached',
  'blocked_allowance',
  'blocked_rate',
  'blocked_budget',
  'blocked_capacity',
  'needs_photo',
  'needs_confirmation',
  'source_not_editable',
] as const;
export const RenderRequestOutcomeSchema = z.enum(RENDER_REQUEST_OUTCOMES);
export type RenderRequestOutcome = z.infer<typeof RenderRequestOutcomeSchema>;

/** Pages that report web vitals. */
export const WEB_VITALS_PAGES = ['landing', 'project', 'share'] as const;
export const WebVitalsPageSchema = z.enum(WEB_VITALS_PAGES);
export type WebVitalsPage = z.infer<typeof WebVitalsPageSchema>;

/** Navigation types as reported by the web-vitals library. */
export const NAVIGATION_TYPES = [
  'navigate',
  'reload',
  'back-forward',
  'back-forward-cache',
  'prerender',
  'restore',
] as const;
export const NavigationTypeSchema = z.enum(NAVIGATION_TYPES);
export type NavigationType = z.infer<typeof NavigationTypeSchema>;

/** Deletion scopes reported on `project_deleted`. */
export const PROJECT_DELETED_SCOPES = ['project', 'account'] as const;
export const ProjectDeletedScopeSchema = z.enum(PROJECT_DELETED_SCOPES);
export type ProjectDeletedScope = z.infer<typeof ProjectDeletedScopeSchema>;

/** Panorama distance buckets on `source_discovery_completed`, split at the match thresholds. */
export const DISTANCE_BUCKETS = ['0_25m', '25_60m', 'over_60m', 'none'] as const;
export const DistanceBucketSchema = z.enum(DISTANCE_BUCKETS);
export type DistanceBucket = z.infer<typeof DistanceBucketSchema>;

export function distanceBucket(distanceMeters: number | null | undefined): DistanceBucket {
  if (distanceMeters === null || distanceMeters === undefined || !Number.isFinite(distanceMeters)) {
    return 'none';
  }
  if (distanceMeters <= 25) return '0_25m';
  if (distanceMeters <= 60) return '25_60m';
  return 'over_60m';
}

/** Upload size buckets on `upload_started`. */
export const BYTE_BUCKETS = ['under_1mb', '1_5mb', '5_10mb', '10_25mb', 'over_25mb'] as const;
export const ByteBucketSchema = z.enum(BYTE_BUCKETS);
export type ByteBucket = z.infer<typeof ByteBucketSchema>;

const MB = 1024 * 1024;

export function byteBucket(byteLength: number): ByteBucket {
  if (byteLength < MB) return 'under_1mb';
  if (byteLength < 5 * MB) return '1_5mb';
  if (byteLength < 10 * MB) return '5_10mb';
  if (byteLength <= 25 * MB) return '10_25mb';
  return 'over_25mb';
}
