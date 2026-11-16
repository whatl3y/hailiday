import { loadConfig } from './config/index.js';
import { createDb } from './db/client.js';
import { migrateToLatest } from './db/migrator.js';
import { createLogger } from './logger/index.js';
import { createQueue } from './queue/client.js';

/**
 * Release-phase migrator: applies pending database migrations under an advisory lock, then
 * installs or upgrades the pg-boss schema and creates or updates every queue and schedule so
 * the API can enqueue as soon as it boots. Idempotent.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'migrate', secrets: config.secrets });
  const db = createDb({
    connectionString: config.database.url,
    max: 2,
    applicationName: 'hailiday-migrate',
    logger,
  });
  try {
    const { applied } = await migrateToLatest(db, { logger });
    logger.info(
      { applied: applied.length },
      applied.length ? 'migrations applied' : 'schema up to date',
    );
  } finally {
    await db.destroy();
  }

  const queue = createQueue(config, { logger, role: 'admin', max: 2 });
  try {
    await queue.start();
    await queue.ensureQueues();
    await queue.ensureSchedules();
    logger.info('queues ready');
  } finally {
    await queue.stop({ graceful: false });
  }
}

main().catch((error: unknown) => {
  console.error('migrate failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
