import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capabilityMode, createCapabilities } from './capabilities/index.js';
import { loadConfig, type AppConfig, type ImageEditSettings } from './config/index.js';
import { loadContent } from './content/load.js';
import { createDb } from './db/client.js';
import { createLogger } from './logger/index.js';
import { renderAndPublishExamples } from './pipeline/examples.js';
import { createProviders } from './providers/create.js';
import { createStorage } from './storage/client.js';

/**
 * The live editor's model snapshot and the configured request settings (provider mask policy,
 * OpenAI quality, Gemini size and thinking level) the examples are compiled with, as the render
 * job compiles them.
 */
export function exampleEditSettings(
  config: Pick<AppConfig, 'providers' | 'openai' | 'gemini'> & {
    imageEdit: ImageEditSettings;
  },
): { modelSnapshot: string; imageEdit: ImageEditSettings } {
  return {
    modelSnapshot:
      config.providers.imageEditor === 'openai'
        ? config.openai.imageModel
        : config.gemini.imageModel,
    imageEdit: {
      providerMask: config.imageEdit.providerMask,
      openaiQuality: config.imageEdit.openaiQuality,
      geminiImageSize: config.imageEdit.geminiImageSize,
      geminiThinkingLevel: config.imageEdit.geminiThinkingLevel,
    },
  };
}

/**
 * `pnpm --filter @hailiday/server examples:render [exampleId]`: renders the before/after example
 * pairs from the licensed photographs through the configured live image editor and publishes
 * them. Examples are never drawn by fixtures, so without a live image editor that is configured
 * and active, the script explains what is missing and exits.
 */
async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    name: 'examples',
    secrets: config.secrets,
  });
  if (config.providers.imageEditor === 'fixture') {
    console.error(
      'examples:render needs a live image editor. Set OPENAI_API_KEY (or GEMINI_API_KEY) with ' +
        'IMAGE_EDITOR_PROVIDER=auto, openai or gemini, then run it again. Examples are never ' +
        'drawn by the fixture renderer, so they stay hidden until a live render exists.',
    );
    return 2;
  }
  const db = createDb({
    connectionString: config.database.url,
    max: 2,
    applicationName: 'hailiday-examples',
    logger,
  });
  const storage = createStorage(config, { logger });
  try {
    const capabilities = createCapabilities(db, { appEnv: config.appEnv, cacheTtlMs: 0 });
    const state = await capabilities.state('US', 'image_editing');
    if (capabilityMode(state, { roles: ['operator'] }, config.appEnv) !== 'live') {
      console.error(
        `examples:render needs the image_editing capability to be live (it is ${state ?? 'missing'}). ` +
          'In development the seed sets it to live_public when an image editing key is configured; ' +
          'elsewhere an operator activates it through the internal API.',
      );
      return 2;
    }
    const content = await loadContent();
    const providers = createProviders(config, { logger, content });
    const result = await renderAndPublishExamples({
      db,
      storage,
      content,
      imageEditor: providers.imageEditor,
      vision: providers.vision,
      ...exampleEditSettings(config),
      logger,
      only: process.argv[2] ?? null,
    });
    logger.info(result, 'examples rendered');
    return result.failed > 0 ? 1 : 0;
  } finally {
    storage.destroy();
    await db.destroy();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error('examples:render failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
