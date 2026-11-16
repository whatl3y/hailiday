import { createServerContext, type ServerContext } from '@hailiday/server';
import type { AppConfig } from '@hailiday/server/config';
import { loadContent, type Content } from '@hailiday/server/content';
import type { Logger } from '@hailiday/server/logger';
import {
  registerConsumers,
  type PipelineDeps,
  type PipelineOptions,
} from '@hailiday/server/pipeline';
import {
  createProviders,
  summarizeProviders,
  type ProviderDependencies,
} from '@hailiday/server/providers';
import type { QueueName } from '@hailiday/server/queue';

export interface WorkerOptions {
  config?: AppConfig;
  logger?: Logger;
  content?: Content;
  /** Pipeline tuning (tests shorten backoffs). */
  pipeline?: Partial<PipelineOptions>;
  providers?: Omit<ProviderDependencies, 'logger' | 'content'>;
  /** Queue polling interval (pg-boss default 2 s). */
  pollingIntervalSeconds?: number;
  /** How long a graceful stop waits for running jobs (default `DEFAULT_SHUTDOWN_TIMEOUT_MS`). */
  shutdownTimeoutMs?: number;
}

/**
 * Default wait for running jobs at a graceful stop. Heroku sends SIGKILL 30 s after SIGTERM, so
 * the wait ends well before that and leaves time to close the queue and database pools; a job cut
 * off here is retried by the queue's heartbeat expiry.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

/** The parts of a server context a graceful stop uses. */
export interface StoppableContext {
  queue: Pick<ServerContext['queue'], 'stop'>;
  close(): Promise<void>;
}

/**
 * Stops a worker: stops taking jobs and waits for running ones up to `timeoutMs`, then closes
 * every connection whether or not the wait finished.
 */
export async function stopWorkerContext(
  context: StoppableContext,
  options: { logger: Logger; reason: string; timeoutMs?: number },
): Promise<void> {
  const { logger } = options;
  logger.info({ reason: options.reason }, 'workers stopping');
  await context.queue
    .stop({ graceful: true, timeoutMs: options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS })
    .catch((error: unknown) => logger.warn({ err: error }, 'graceful queue stop failed'));
  await context.close();
  logger.info('workers stopped');
}

export interface WorkerHandle {
  context: ServerContext;
  deps: PipelineDeps;
  concurrency: Record<QueueName, number>;
  /** Stops taking jobs, waits for running ones (bounded), then closes every connection. */
  stop(reason?: string): Promise<void>;
}

/**
 * Starts a worker process: the server context in the `worker` queue role (supervision and cron
 * schedules on), content and providers, every queue created and scheduled, and one consumer per
 * queue with its concurrency from settings and provider limits.
 */
export async function startWorker(options: WorkerOptions = {}): Promise<WorkerHandle> {
  const context = createServerContext({
    ...(options.config ? { config: options.config } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    queueRole: 'worker',
    name: 'workers',
  });
  const { config, logger } = context;
  try {
    const content = options.content ?? (await loadContent());
    const providers = createProviders(config, {
      ...(options.providers ?? {}),
      logger,
      content,
    });
    await context.start();
    await context.queue.ensureQueues();
    await context.queue.ensureSchedules();
    const deps: PipelineDeps = {
      db: context.db,
      storage: context.storage,
      queue: context.queue,
      settings: context.settings,
      capabilities: context.capabilities,
      config,
      logger,
      clock: context.clock,
      providers,
      content,
      ...(options.pipeline ? { options: options.pipeline } : {}),
    };
    const concurrency = await registerConsumers(context.queue, deps, {
      ...(options.pollingIntervalSeconds !== undefined
        ? { pollingIntervalSeconds: options.pollingIntervalSeconds }
        : {}),
    });
    const summary = summarizeProviders(config, providers);
    logger.info(
      {
        appEnv: config.appEnv,
        concurrency,
        providerModes: { ...summary.providerModes, emailProvider: config.email.provider },
        imageEditor: summary.imageEditor,
        vision: summary.vision,
      },
      'workers ready',
    );
    let stopping: Promise<void> | null = null;
    return {
      context,
      deps,
      concurrency,
      stop(reason = 'stop') {
        stopping ??= stopWorkerContext(context, {
          logger,
          reason,
          ...(options.shutdownTimeoutMs !== undefined
            ? { timeoutMs: options.shutdownTimeoutMs }
            : {}),
        });
        return stopping;
      },
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}
