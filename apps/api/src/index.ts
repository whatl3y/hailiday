import { createServerContext } from '@holiday/server';
import { loadContent } from '@holiday/server/content';
import { createProviders, summarizeProviders } from '@holiday/server/providers';
import { buildServer } from './server.js';

/** API process entry: the server context as a queue producer, the HTTP server, graceful stop. */
async function main(): Promise<void> {
  const context = createServerContext({ queueRole: 'producer', name: 'api' });
  const { config, logger } = context;
  let server: Awaited<ReturnType<typeof buildServer>> | null = null;
  try {
    await context.start();
    await context.queue.ensureQueues().catch((error: unknown) => {
      // The release phase creates the queues; a concurrent create by the workers is harmless.
      logger.warn({ err: error }, 'queue setup skipped');
    });
    const content = await loadContent();
    const providers = createProviders(config, { logger, content });
    server = await buildServer({ context, content, providers });
    await server.app.listen({ port: config.port, host: '0.0.0.0' });
    const summary = summarizeProviders(config, providers);
    logger.info(
      {
        port: config.port,
        appEnv: config.appEnv,
        web: server.deps.web.built ? 'built' : 'fallback shell',
        providerModes: {
          ...summary.providerModes,
          emailProvider: config.email.provider,
          turnstileMode: config.turnstile.mode,
        },
        imageEditor: summary.imageEditor,
        vision: summary.vision,
      },
      'api ready',
    );
  } catch (error) {
    logger.error({ err: error }, 'api failed to start');
    await server?.close().catch(() => undefined);
    await context.close().catch(() => undefined);
    process.exit(1);
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'api stopping');
    const timer = setTimeout(() => process.exit(1), 15_000);
    timer.unref();
    void (async () => {
      try {
        await server?.close();
        await context.close();
        logger.info('api stopped');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'api shutdown failed');
        process.exit(1);
      }
    })();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.on('unhandledRejection', (error) => {
    logger.error({ err: error }, 'unhandled rejection in api');
  });
}

void main();
