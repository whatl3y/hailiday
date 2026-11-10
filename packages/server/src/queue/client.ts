import { PgBoss, fromKysely } from 'pg-boss';
import type { Job, JobWithMetadata, SendOptions, WorkOptions } from 'pg-boss';
import type { AppConfig } from '../config/index.js';
import type { DbOrTx } from '../db/client.js';
import type { Logger } from '../logger/index.js';
import {
  QUEUE_PAYLOAD_SCHEMAS,
  orderedQueueDefinitions,
  queueDefinitions,
  singletonKeyFor,
} from './definitions.js';
import type {
  QueueDefinition,
  QueueName,
  QueuePayload,
  QueuePayloadInput,
  RenderJobPayload,
} from './definitions.js';

/** The schema pg-boss installs its tables into. */
export const PG_BOSS_SCHEMA = 'pgboss';

export type QueueRole = 'producer' | 'worker' | 'admin';

/** A received job with a validated payload. */
export interface QueueJob<N extends QueueName> {
  id: string;
  name: N;
  data: QueuePayload<N>;
  retryCount: number;
  /** Aborts when the job is cancelled or expires; pass it to provider calls. */
  signal: AbortSignal;
}

export interface EnqueueOptions {
  /** Job ID; the render job ID for `render` so both records share one identifier. */
  id?: string;
  /** Defaults to the queue's singleton key for the payload. */
  singletonKey?: string | null;
  startAfter?: Date | number;
  priority?: number;
}

export interface WorkerOptions {
  localConcurrency?: number;
  pollingIntervalSeconds?: number;
}

/** Raised when a singleton-keyed queue already holds a queued or active job for the key. */
export class EnqueueConflictError extends Error {
  readonly queue: QueueName;
  readonly singletonKey: string | null;
  constructor(queue: QueueName, singletonKey: string | null) {
    super(`Queue ${queue} already holds an active job for its singleton key`);
    this.name = 'EnqueueConflictError';
    this.queue = queue;
    this.singletonKey = singletonKey;
  }
}

/**
 * The small queue interface the domain uses; pg-boss stays behind it so the transport can change
 * without touching domain code.
 */
export interface JobQueue {
  readonly boss: PgBoss;
  start(): Promise<void>;
  stop(options?: { graceful?: boolean; timeoutMs?: number }): Promise<void>;
  /** Creates or updates every queue (dead-letter queues first); idempotent. */
  ensureQueues(): Promise<void>;
  /** Registers the cron schedules of the scheduled queues; idempotent. */
  ensureSchedules(): Promise<void>;
  /** Sends outside any caller transaction. Returns the job ID, or null on a singleton conflict. */
  send<N extends QueueName>(
    name: N,
    payload: QueuePayloadInput<N>,
    options?: EnqueueOptions,
  ): Promise<string | null>;
  /**
   * Sends inside the caller's Kysely transaction through pg-boss's Kysely adapter: a rollback
   * also removes the job. Throws `EnqueueConflictError` on a singleton conflict.
   */
  enqueue<N extends QueueName>(
    trx: DbOrTx,
    name: N,
    payload: QueuePayloadInput<N>,
    options?: EnqueueOptions,
  ): Promise<string>;
  /** Enqueues a render with job ID = render job ID and singleton key = project ID. */
  enqueueRender(trx: DbOrTx, payload: QueuePayloadInput<'render'>): Promise<string>;
  /** Cancels jobs (optionally inside a caller transaction). */
  cancel(name: QueueName, ids: string | string[], options?: { trx?: DbOrTx }): Promise<void>;
  work<N extends QueueName>(
    name: N,
    handler: (job: QueueJob<N>) => Promise<void>,
    options?: WorkerOptions,
  ): Promise<string>;
  offWork(name: QueueName): Promise<void>;
  getJob<N extends QueueName>(
    name: N,
    id: string,
  ): Promise<JobWithMetadata<QueuePayload<N>> | null>;
  /** Jobs waiting to run (created or retry, not deferred). */
  queuedCount(name: QueueName): Promise<number>;
  definition(name: QueueName): QueueDefinition;
}

function transactionalDb(trx: DbOrTx) {
  return fromKysely(trx.withoutPlugins());
}

function parsePayload<N extends QueueName>(name: N, data: unknown): QueuePayload<N> {
  return QUEUE_PAYLOAD_SCHEMAS[name].parse(data ?? {}) as QueuePayload<N>;
}

function sendOptions(
  name: QueueName,
  payload: QueuePayload<QueueName>,
  definition: QueueDefinition,
  options: EnqueueOptions,
): SendOptions {
  const singletonKey =
    options.singletonKey === null
      ? undefined
      : (options.singletonKey ??
        (definition.policy === 'standard' ? undefined : singletonKeyFor(name, payload)));
  const result: SendOptions = {};
  if (options.id) result.id = options.id;
  if (singletonKey) result.singletonKey = singletonKey;
  if (options.startAfter !== undefined) result.startAfter = options.startAfter;
  if (options.priority !== undefined) result.priority = options.priority;
  return result;
}

/**
 * Creates the pg-boss wrapper. `producer` (API) and `admin` (release scripts) instances run no
 * maintenance or cron; `worker` instances supervise queues and run schedules.
 */
export function createQueue(
  config: AppConfig,
  options: { logger?: Logger; role?: QueueRole; connectionString?: string; max?: number } = {},
): JobQueue {
  const role = options.role ?? 'producer';
  const definitions = queueDefinitions(config);
  const boss = new PgBoss({
    connectionString: options.connectionString ?? config.database.url,
    schema: PG_BOSS_SCHEMA,
    application_name: `holiday-${role}`,
    max: options.max ?? (role === 'worker' ? 10 : 4),
    migrate: true,
    supervise: role === 'worker',
    schedule: role === 'worker',
  });
  boss.on('error', (error) => options.logger?.error({ err: error }, 'queue error'));
  boss.on('warning', (warning) =>
    options.logger?.warn({ warning: warning.message }, 'queue warning'),
  );

  let started = false;

  const queue: JobQueue = {
    boss,

    async start() {
      if (started) return;
      await boss.start();
      started = true;
    },

    async stop(stopOptions = {}) {
      if (!started) return;
      started = false;
      await boss.stop({
        graceful: stopOptions.graceful ?? true,
        timeout: stopOptions.timeoutMs ?? 10_000,
        close: true,
      });
    },

    async ensureQueues() {
      for (const definition of orderedQueueDefinitions(config)) {
        const queueOptions = {
          expireInSeconds: definition.expireInSeconds,
          retryLimit: definition.retryLimit,
          retryDelay: definition.retryDelay ?? 0,
          retryBackoff: definition.retryBackoff ?? false,
          ...(definition.retryDelayMax !== undefined
            ? { retryDelayMax: definition.retryDelayMax }
            : {}),
          ...(definition.deadLetter ? { deadLetter: definition.deadLetter } : {}),
        };
        const existing = await boss.getQueue(definition.name);
        if (!existing) {
          await boss.createQueue(definition.name, {
            ...queueOptions,
            policy: definition.policy,
            ...(definition.heartbeatSeconds !== undefined
              ? { heartbeatSeconds: definition.heartbeatSeconds }
              : {}),
          });
          options.logger?.info({ queue: definition.name }, 'queue created');
        } else {
          await boss.updateQueue(definition.name, {
            ...queueOptions,
            heartbeatSeconds: definition.heartbeatSeconds ?? null,
          });
        }
      }
    },

    async ensureSchedules() {
      for (const definition of Object.values(definitions)) {
        if (!definition.schedule) continue;
        await boss.schedule(
          definition.name,
          definition.schedule,
          {},
          { tz: 'UTC', singletonKey: definition.name },
        );
      }
    },

    async send(name, payload, sendOpts = {}) {
      const data = parsePayload(name, payload);
      return boss.send(name, data, sendOptions(name, data, definitions[name], sendOpts));
    },

    async enqueue(trx, name, payload, enqueueOpts = {}) {
      const data = parsePayload(name, payload);
      const opts = sendOptions(name, data, definitions[name], enqueueOpts);
      const id = await boss.send(name, data, { ...opts, db: transactionalDb(trx) });
      if (!id) throw new EnqueueConflictError(name, opts.singletonKey ?? null);
      return id;
    },

    async enqueueRender(trx, payload) {
      const data: RenderJobPayload = parsePayload('render', payload);
      return queue.enqueue(trx, 'render', data, {
        id: data.renderJobId,
        singletonKey: data.projectId,
      });
    },

    async cancel(name, ids, cancelOpts = {}) {
      await boss.cancel(name, ids, cancelOpts.trx ? { db: transactionalDb(cancelOpts.trx) } : {});
    },

    async work(name, handler, workerOptions = {}) {
      const options: WorkOptions = {
        batchSize: 1,
        localConcurrency: workerOptions.localConcurrency ?? 1,
        ...(workerOptions.pollingIntervalSeconds !== undefined
          ? { pollingIntervalSeconds: workerOptions.pollingIntervalSeconds }
          : {}),
      };
      return boss.work(name, options, async (jobs: Job<unknown>[]) => {
        for (const job of jobs) {
          await handler({
            id: job.id,
            name,
            data: parsePayload(name, job.data),
            retryCount: job.retryCount,
            signal: job.signal,
          });
        }
      });
    },

    async offWork(name) {
      await boss.offWork(name);
    },

    async getJob(name, id) {
      const jobs = await boss.findJobs<QueuePayload<typeof name>>(name, { id });
      return jobs[0] ?? null;
    },

    async queuedCount(name) {
      const result = await boss.getQueue(name);
      return result?.readyCount ?? 0;
    },

    definition(name) {
      return definitions[name];
    },
  };
  return queue;
}
