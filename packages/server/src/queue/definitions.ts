import { z } from 'zod';
import type { AppConfig } from '../config/index.js';

/** Every pg-boss queue the system uses. */
export const QUEUE_NAMES = [
  'render',
  'render_dead',
  'upload_validate',
  'upload_validate_dead',
  'upload_screen',
  'upload_screen_dead',
  'share_card',
  'retention_sweep',
  'attempt_sweep',
  'coordinate_expiry',
  'reconciliation',
  'street_view_revalidation',
  'offer_verification',
  'affiliate_report_import',
  'coverage_probe',
] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

const uuid = z.uuid();

const RenderPayloadSchema = z.strictObject({
  renderJobId: uuid,
  projectId: uuid,
  ownerId: uuid,
  correlationId: z.string().max(128).nullable().default(null),
});

const SourceAssetPayloadSchema = z.strictObject({
  sourceAssetId: uuid,
  ownerId: uuid,
  correlationId: z.string().max(128).nullable().default(null),
});

const ShareCardPayloadSchema = z.strictObject({
  shareGrantId: uuid,
  /** The raw share token; public object keys (`shared/{token}/`, `cards/{token}.jpg`) use it. */
  shareToken: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

const ScheduledPayloadSchema = z.strictObject({
  /** Optional cap on rows processed by one run. */
  limit: z.int().positive().optional(),
});

const CoverageProbePayloadSchema = z.strictObject({
  probeRunId: uuid,
  sampleSize: z.int().positive().max(10_000).optional(),
});

/** Payload schema per queue. Payloads carry opaque IDs only, never image bytes or addresses. */
export const QUEUE_PAYLOAD_SCHEMAS = {
  render: RenderPayloadSchema,
  render_dead: RenderPayloadSchema,
  upload_validate: SourceAssetPayloadSchema,
  upload_validate_dead: SourceAssetPayloadSchema,
  upload_screen: SourceAssetPayloadSchema,
  upload_screen_dead: SourceAssetPayloadSchema,
  share_card: ShareCardPayloadSchema,
  retention_sweep: ScheduledPayloadSchema,
  attempt_sweep: ScheduledPayloadSchema,
  coordinate_expiry: ScheduledPayloadSchema,
  reconciliation: ScheduledPayloadSchema,
  street_view_revalidation: ScheduledPayloadSchema,
  offer_verification: ScheduledPayloadSchema,
  affiliate_report_import: ScheduledPayloadSchema,
  coverage_probe: CoverageProbePayloadSchema,
} as const satisfies Record<QueueName, z.ZodType>;

export type QueuePayload<N extends QueueName> = z.output<(typeof QUEUE_PAYLOAD_SCHEMAS)[N]>;
export type QueuePayloadInput<N extends QueueName> = z.input<(typeof QUEUE_PAYLOAD_SCHEMAS)[N]>;

export type RenderJobPayload = QueuePayload<'render'>;
export type SourceAssetJobPayload = QueuePayload<'upload_validate'>;
export type ShareCardJobPayload = QueuePayload<'share_card'>;

export type QueuePolicyName = 'standard' | 'exclusive' | 'singleton';

/** How a queue is created in pg-boss. */
export interface QueueDefinition {
  name: QueueName;
  /**
   * `exclusive` admits at most one queued-or-active job per singleton key, which is the
   * queue-level guard for one active render per project and for one validation, screening or
   * share-card job per asset or grant.
   */
  policy: QueuePolicyName;
  expireInSeconds: number;
  retryLimit: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  heartbeatSeconds?: number;
  deadLetter?: QueueName;
  /** Cron expression (UTC) for scheduled queues. */
  schedule?: string;
}

/**
 * How long the `render` queue keeps a job past the render job's time limit before it expires it
 * (seconds). The pipeline's own deadline, set at the limit from the job's start, therefore always
 * fires first, and the fallbacks that run on it (delivering a picture the job already has) finish
 * before the queue aborts the handler.
 */
export const RENDER_QUEUE_EXPIRY_MARGIN_S = 30;

/** Queue definitions with values from configuration (architecture "Jobs and queue"). */
export function queueDefinitions(config: AppConfig): Record<QueueName, QueueDefinition> {
  const q = config.queue;
  const scheduled = (
    name: QueueName,
    schedule: string,
    expireInSeconds = 600,
  ): QueueDefinition => ({
    name,
    policy: 'exclusive',
    expireInSeconds,
    retryLimit: 0,
    schedule,
  });
  const deadLetterQueue = (name: QueueName, expireInSeconds: number): QueueDefinition => ({
    name,
    policy: 'standard',
    expireInSeconds,
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    retryDelayMax: 60,
  });
  return {
    render_dead: deadLetterQueue('render_dead', 120),
    upload_validate_dead: deadLetterQueue('upload_validate_dead', 60),
    upload_screen_dead: deadLetterQueue('upload_screen_dead', 60),
    render: {
      name: 'render',
      policy: 'exclusive',
      expireInSeconds: q.renderMaxJobDurationSeconds + RENDER_QUEUE_EXPIRY_MARGIN_S,
      retryLimit: q.renderTransportRetryLimit,
      retryDelay: q.renderRetryDelaySeconds,
      retryBackoff: true,
      retryDelayMax: q.renderRetryDelayMaxSeconds,
      heartbeatSeconds: q.renderHeartbeatSeconds,
      deadLetter: 'render_dead',
    },
    upload_validate: {
      name: 'upload_validate',
      policy: 'exclusive',
      expireInSeconds: q.uploadValidateMaxDurationSeconds,
      retryLimit: 1,
      retryDelay: 2,
      deadLetter: 'upload_validate_dead',
    },
    upload_screen: {
      name: 'upload_screen',
      policy: 'exclusive',
      expireInSeconds: q.uploadScreenMaxDurationSeconds,
      retryLimit: 1,
      retryDelay: 2,
      deadLetter: 'upload_screen_dead',
    },
    share_card: {
      name: 'share_card',
      policy: 'exclusive',
      expireInSeconds: 120,
      retryLimit: 2,
      retryDelay: 5,
      retryBackoff: true,
    },
    retention_sweep: scheduled('retention_sweep', '*/15 * * * *'),
    attempt_sweep: scheduled('attempt_sweep', '5 * * * *'),
    coordinate_expiry: scheduled('coordinate_expiry', '20 3 * * *'),
    reconciliation: scheduled('reconciliation', '*/10 * * * *'),
    // Expires after 55 minutes: above the run's 50-minute batch budget, below the hourly interval.
    street_view_revalidation: scheduled('street_view_revalidation', '35 * * * *', 3300),
    offer_verification: scheduled('offer_verification', '40 4 * * *'),
    affiliate_report_import: scheduled('affiliate_report_import', '50 5 * * *', 1800),
    coverage_probe: {
      name: 'coverage_probe',
      policy: 'exclusive',
      expireInSeconds: 3600,
      retryLimit: 0,
    },
  };
}

/** Creation order: dead-letter queues before the queues that reference them. */
export function orderedQueueDefinitions(config: AppConfig): QueueDefinition[] {
  const definitions = Object.values(queueDefinitions(config));
  return [
    ...definitions.filter((definition) => !definition.deadLetter),
    ...definitions.filter((definition) => definition.deadLetter),
  ];
}

/** Singleton key a queue uses for a payload (one active job per project, asset or grant). */
export function singletonKeyFor<N extends QueueName>(name: N, payload: QueuePayload<N>): string {
  switch (name) {
    case 'render':
      return (payload as RenderJobPayload).projectId;
    case 'upload_validate':
    case 'upload_screen':
      return (payload as SourceAssetJobPayload).sourceAssetId;
    case 'share_card':
      return (payload as ShareCardJobPayload).shareGrantId;
    case 'coverage_probe':
      return (payload as QueuePayload<'coverage_probe'>).probeRunId;
    default:
      return name;
  }
}
