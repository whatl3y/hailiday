import type { Clock } from './clock/index.js';
import { systemClock } from './clock/index.js';
import { loadConfig } from './config/index.js';
import type { AppConfig } from './config/index.js';
import { createCapabilities } from './capabilities/index.js';
import type { Capabilities } from './capabilities/index.js';
import { createDb } from './db/client.js';
import type { Db } from './db/client.js';
import { createEmailSender } from './email/index.js';
import type { EmailSender } from './email/index.js';
import { createLogger } from './logger/index.js';
import type { Logger } from './logger/index.js';
import { setStreetViewImagery } from './policy/index.js';
import { createQueue } from './queue/client.js';
import type { JobQueue, QueueRole } from './queue/client.js';
import { createSettings } from './settings/index.js';
import type { RuntimeSettings } from './settings/index.js';
import { createStorage } from './storage/client.js';
import type { Storage } from './storage/client.js';

export * from './config/index.js';
export * from './logger/index.js';
export * from './clock/index.js';
export * from './ids/index.js';
export * from './errors/index.js';
export * from './db/index.js';
export * from './storage/index.js';
export * from './queue/index.js';
export * from './ledger/index.js';
export * from './policy/index.js';
export * from './settings/index.js';
export * from './capabilities/index.js';
export * from './email/index.js';
export * from './turnstile/index.js';
export * from './limits/index.js';
export * from './content/index.js';

/** The shared infrastructure handles an API or worker process needs. */
export interface ServerContext {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  db: Db;
  storage: Storage;
  queue: JobQueue;
  settings: RuntimeSettings;
  capabilities: Capabilities;
  email: EmailSender;
  /** Starts the queue (pg-boss) connection. */
  start(): Promise<void>;
  /** Stops the queue and closes database pools and clients. */
  close(): Promise<void>;
}

/**
 * Builds the infrastructure bundle from configuration: database, storage, queue (as producer or
 * worker), runtime settings and capabilities with their caches, and the email sender. Records
 * whether Street View imagery is live or fixture for new source policies.
 */
export function createServerContext(
  options: {
    config?: AppConfig;
    logger?: Logger;
    clock?: Clock;
    queueRole?: QueueRole;
    name?: string;
  } = {},
): ServerContext {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger ??
    createLogger({ level: config.logLevel, name: options.name, secrets: config.secrets });
  const clock = options.clock ?? systemClock;
  setStreetViewImagery(config.providers.streetView === 'google' ? 'live' : 'fixture');
  const db = createDb({
    connectionString: config.database.url,
    max: config.database.poolMax,
    applicationName: `hailiday-${options.name ?? 'server'}`,
    logger,
  });
  const storage = createStorage(config, { logger });
  const queue = createQueue(config, { logger, role: options.queueRole ?? 'producer' });
  const settings = createSettings(db, { config, clock });
  const capabilities = createCapabilities(db, {
    appEnv: config.appEnv,
    clock,
    cacheTtlMs: config.settingsCacheSeconds * 1000,
  });
  const email = createEmailSender(config, { logger, db });
  return {
    config,
    logger,
    clock,
    db,
    storage,
    queue,
    settings,
    capabilities,
    email,
    async start() {
      await queue.start();
    },
    async close() {
      await queue
        .stop()
        .catch((error: unknown) => logger.warn({ err: error }, 'queue stop failed'));
      await email.close();
      storage.destroy();
      await db.destroy();
    },
  };
}
