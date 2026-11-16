import { loadConfig } from './config/index.js';
import { createDb } from './db/client.js';
import { loadExtensionSeedSteps, runSeed } from './db/seed.js';
import { createLogger } from './logger/index.js';

/**
 * Release-phase seed: country capabilities (default fixture profile), runtime setting defaults,
 * published holiday pack versions, style kits, the commerce catalog, placeholder hero and example
 * rows, and occurrences around the current year; then any extension steps. Idempotent.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'seed', secrets: config.secrets });
  const db = createDb({
    connectionString: config.database.url,
    max: 2,
    applicationName: 'hailiday-seed',
    logger,
  });
  try {
    const extraSteps = await loadExtensionSeedSteps(import.meta.url);
    const result = await runSeed({ db, config, logger, extraSteps });
    logger.info({ steps: result.steps.length }, 'seed complete');
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error('seed failed:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
