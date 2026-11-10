import type { Clock } from '../clock/index.js';
import { systemClock } from '../clock/index.js';
import type { AppConfig } from '../config/index.js';
import {
  capabilityKeysFor,
  defaultCapabilityState,
  seedCapabilities,
} from '../capabilities/index.js';
import { loadContent } from '../content/load.js';
import type { Content } from '../content/load.js';
import {
  occurrenceYears,
  publishCommerce,
  publishExamplePlaceholders,
  publishHeroPlaceholders,
  publishKits,
  publishOccurrences,
  publishPacks,
} from '../content/publish.js';
import type { PublishCounts, PublishOptions } from '../content/publish.js';
import type { Logger } from '../logger/index.js';
import { seedSettingDefaults } from '../settings/index.js';
import { createStorage } from '../storage/client.js';
import type { Storage } from '../storage/client.js';
import type { Db } from './client.js';

/** Everything a seed step may use. Storage is created lazily for steps that need it. */
export interface SeedContext {
  db: Db;
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  content: Content;
  now: Date;
  /** Development and test refresh seeded content rows; staging and production insert only. */
  refresh: boolean;
  storage(): Storage;
}

/**
 * One idempotent seed step. Core steps run first, in order; later stages add steps (for example
 * image generation and upload for heroes and examples) by exporting `seedSteps` from one of the
 * extension modules listed in `SEED_EXTENSION_MODULES`.
 */
export interface SeedStep {
  name: string;
  run(context: SeedContext): Promise<PublishCounts | void>;
}

/** Modules (relative to the package's `src`/`dist` root) that may export `seedSteps: SeedStep[]`. */
export const SEED_EXTENSION_MODULES = [
  './fixtures/seed-steps.js',
  './providers/seed-steps.js',
  './pipeline/seed-steps.js',
] as const;

const transactional = (
  name: string,
  run: (db: Db, context: SeedContext, options: PublishOptions) => Promise<PublishCounts>,
) =>
  ({
    name,
    run: (context: SeedContext) =>
      context.db
        .transaction()
        .execute((trx) =>
          run(trx, context, { now: context.now, refresh: context.refresh, logger: context.logger }),
        ),
  }) satisfies SeedStep;

/** The core steps: capabilities, settings, packs, kits, commerce, hero and example rows. */
export const CORE_SEED_STEPS: readonly SeedStep[] = [
  transactional('country_capabilities', async (db, context) => {
    const programKeys = context.content.commerce.catalog.merchantPrograms.map((p) => p.programKey);
    const inserted = await seedCapabilities(db, {
      countryCode: 'US',
      keys: capabilityKeysFor(programKeys),
      state: (key) => defaultCapabilityState(context.config, key),
      evidenceRef: `seed:default-profile:${context.config.appEnv}`,
      now: context.now,
      refreshSeeded: context.config.appEnv === 'development',
    });
    return { countryCapabilities: inserted };
  }),
  transactional('runtime_settings', async (db, context) => ({
    runtimeSettings: await seedSettingDefaults(db, context.config),
  })),
  transactional('holiday_pack_versions', (db, context, options) =>
    publishPacks(db, context.content, options),
  ),
  transactional('style_kits', (db, context, options) => publishKits(db, context.content, options)),
  transactional('commerce', (db, context, options) =>
    publishCommerce(db, context.content, options),
  ),
  transactional('hero_assets', (db, context, options) =>
    publishHeroPlaceholders(db, context.content, options),
  ),
  transactional('holiday_occurrences', (db, context, options) =>
    publishOccurrences(db, context.content, { ...options, years: occurrenceYears(context.now) }),
  ),
  transactional('example_assets', (db, context, options) =>
    publishExamplePlaceholders(db, context.content, options),
  ),
];

export interface SeedResult {
  steps: { name: string; counts: PublishCounts; durationMs: number }[];
}

/** Runs seed steps in order. Every step is idempotent, so the seed can run on every release. */
export async function runSeed(input: {
  db: Db;
  config: AppConfig;
  logger: Logger;
  clock?: Clock;
  content?: Content;
  steps?: readonly SeedStep[];
  extraSteps?: readonly SeedStep[];
}): Promise<SeedResult> {
  const clock = input.clock ?? systemClock;
  const content = input.content ?? (await loadContent());
  let storage: Storage | null = null;
  const context: SeedContext = {
    db: input.db,
    config: input.config,
    logger: input.logger,
    clock,
    content,
    now: clock.now(),
    refresh: input.config.isLocal,
    storage: () => (storage ??= createStorage(input.config, { logger: input.logger })),
  };
  const result: SeedResult = { steps: [] };
  try {
    for (const step of [...(input.steps ?? CORE_SEED_STEPS), ...(input.extraSteps ?? [])]) {
      const started = Date.now();
      const counts = (await step.run(context)) ?? {};
      const durationMs = Date.now() - started;
      result.steps.push({ name: step.name, counts, durationMs });
      input.logger.info({ step: step.name, counts, durationMs }, 'seed step complete');
    }
  } finally {
    (storage as Storage | null)?.destroy();
  }
  return result;
}

function isMissingModule(error: unknown, url: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: string; message?: string };
  if (code !== 'ERR_MODULE_NOT_FOUND') return false;
  const path = new URL(url).pathname;
  return typeof message === 'string' && (message.includes(path) || message.includes(url));
}

/**
 * Loads extension seed steps. A missing extension module is skipped; a module that exists but
 * fails to load is an error.
 */
export async function loadExtensionSeedSteps(baseUrl: string): Promise<SeedStep[]> {
  const steps: SeedStep[] = [];
  for (const specifier of SEED_EXTENSION_MODULES) {
    const url = new URL(specifier, baseUrl).href;
    let module: { seedSteps?: SeedStep[] };
    try {
      module = (await import(url)) as { seedSteps?: SeedStep[] };
    } catch (error) {
      if (isMissingModule(error, url)) continue;
      throw error;
    }
    if (Array.isArray(module.seedSteps)) steps.push(...module.seedSteps);
  }
  return steps;
}
