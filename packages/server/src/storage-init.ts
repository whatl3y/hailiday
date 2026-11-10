import { loadConfig } from './config/index.js';
import { createLogger, type Logger } from './logger/index.js';
import { createStorage, type BucketKind, type Storage } from './storage/client.js';
import { lifecycleRulesFor } from './storage/lifecycle.js';

/**
 * Applies the buckets' configuration: CORS for `STORAGE_CORS_ORIGINS` (GET, POST, PUT, HEAD) on
 * both, the lifecycle backstop rules (`lifecycleRulesFor`; an endpoint without lifecycle support,
 * such as some local emulators, is logged and skipped) and a public-read policy on the public
 * bucket. Idempotent.
 */
export async function initializeBuckets(
  storage: Storage,
  options: { corsOrigins: readonly string[]; logger?: Logger },
): Promise<Record<BucketKind, { created: boolean; lifecycleApplied: boolean }>> {
  const result = {} as Record<BucketKind, { created: boolean; lifecycleApplied: boolean }>;
  for (const kind of ['private', 'public'] as const) {
    const bucket = storage.buckets[kind];
    const created = await storage.ensureBucket(bucket);
    await storage.putBucketCors(bucket, options.corsOrigins);
    const lifecycle = await storage.putLifecycleRules(bucket, lifecycleRulesFor(kind));
    result[kind] = { created, lifecycleApplied: lifecycle.applied };
    options.logger?.info(
      {
        bucket,
        created,
        corsOrigins: options.corsOrigins.length,
        lifecycleApplied: lifecycle.applied,
        ...(lifecycle.reason ? { lifecycleSkipped: lifecycle.reason } : {}),
      },
      'bucket ready',
    );
  }
  await storage.putPublicReadPolicy(storage.buckets.public);
  options.logger?.info({ bucket: storage.buckets.public }, 'public-read policy applied');
  return result;
}

/** Release-phase storage setup: creates the private and public buckets and configures them. */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    name: 'storage-init',
    secrets: config.secrets,
  });
  const storage = createStorage(config, { logger });
  try {
    await initializeBuckets(storage, { corsOrigins: config.storage.corsOrigins, logger });
  } finally {
    storage.destroy();
  }
}

if (process.argv[1] && /storage-init\.(js|ts)$/.test(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error('storage-init failed:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exit(1);
  });
}
