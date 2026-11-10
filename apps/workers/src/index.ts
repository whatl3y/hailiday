import { startWorker } from './worker.js';

/** Worker process entry: start, then stop gracefully on SIGTERM or SIGINT. */
async function main(): Promise<void> {
  const worker = await startWorker();
  const { logger } = worker.context;
  let exiting = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    worker
      .stop(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.on('unhandledRejection', (error) => {
    logger.error({ err: error }, 'unhandled rejection in worker');
  });
}

main().catch((error: unknown) => {
  console.error('workers failed to start', error);
  process.exit(1);
});
