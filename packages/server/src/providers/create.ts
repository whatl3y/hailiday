import type { AppConfig } from '../config/index.js';
import type { Content } from '../content/load.js';
import type { Logger } from '../logger/index.js';
import { createFixtureAddressProvider } from './address/fixture.js';
import { createGoogleAddressProvider } from './address/google.js';
import { ProviderConfigError } from './errors.js';
import type { FetchLike } from './http.js';
import { createFixtureImageEditor } from './image-editor/fixture.js';
import { createGeminiImageEditor } from './image-editor/gemini.js';
import { createOpenAiImageEditor } from './image-editor/openai.js';
import { createFixtureSafetyProvider, createLiveSafetyProvider } from './safety/index.js';
import { createFixtureStreetViewProvider } from './street-view/fixture.js';
import { createGoogleStreetViewProvider } from './street-view/google.js';
import type { Providers } from './types.js';
import {
  createAnthropicVisionModel,
  sdkFetchFrom,
  type AnthropicMessagesClient,
} from './vision/anthropic.js';
import { createFixtureVisionModel } from './vision/fixture.js';

export interface ProviderDependencies {
  logger?: Logger;
  /** Injected fetch for live adapters (tests). */
  fetch?: FetchLike;
  /** Injected Anthropic client (tests). */
  anthropicClient?: AnthropicMessagesClient;
  /** Preloaded content for the fixture vision model's generic scenes. */
  content?: Content;
  /** Fixture `slow` scenario delay (defaults to about 20 s). */
  fixtureSlowDelayMs?: number;
}

function requireKey(provider: string, value: string, name: string): string {
  if (!value)
    throw new ProviderConfigError(provider, `${provider} is selected but ${name} is not set`);
  return value;
}

/**
 * Builds every provider leg from configuration: fixture or live per the resolved `*_PROVIDER`
 * (`auto` is resolved by the configuration from the keys that are set). The fixture
 * implementations are always returned too, so request-time capability rows in `fixture` state
 * can select them without a restart.
 */
export function createProviders(config: AppConfig, deps: ProviderDependencies = {}): Providers {
  const fixtureVision = createFixtureVisionModel(deps.content ? { content: deps.content } : {});
  const fixtures = {
    address: createFixtureAddressProvider({ sessionSecret: config.sessionSecret }),
    streetView: createFixtureStreetViewProvider({
      publicBaseUrl: config.publicBaseUrl,
      sessionSecret: config.sessionSecret,
    }),
    vision: fixtureVision,
    imageEditor: createFixtureImageEditor(
      deps.fixtureSlowDelayMs !== undefined ? { slowDelayMs: deps.fixtureSlowDelayMs } : {},
    ),
    safety: createFixtureSafetyProvider(fixtureVision),
  };
  const fetchOption = deps.fetch ? { fetch: deps.fetch } : {};
  const loggerOption = deps.logger ? { logger: deps.logger } : {};

  const address =
    config.providers.address === 'google'
      ? createGoogleAddressProvider({
          serverKey: requireKey(
            'ADDRESS_PROVIDER=google',
            config.google.mapsServerKey,
            'GOOGLE_MAPS_SERVER_KEY',
          ),
          sessionSecret: config.sessionSecret,
          ...fetchOption,
          ...loggerOption,
        })
      : fixtures.address;

  const streetView =
    config.providers.streetView === 'google'
      ? createGoogleStreetViewProvider({
          serverKey: requireKey(
            'STREET_VIEW_PROVIDER=google',
            config.google.mapsServerKey,
            'GOOGLE_MAPS_SERVER_KEY',
          ),
          browserKey: requireKey(
            'STREET_VIEW_PROVIDER=google',
            config.google.streetViewBrowserKey,
            'GOOGLE_STREET_VIEW_BROWSER_KEY',
          ),
          signingSecret: requireKey(
            'STREET_VIEW_PROVIDER=google',
            config.google.streetViewSigningSecret,
            'GOOGLE_STREET_VIEW_SIGNING_SECRET',
          ),
          ...fetchOption,
          ...loggerOption,
        })
      : fixtures.streetView;

  const vision =
    config.providers.vision === 'anthropic'
      ? createAnthropicVisionModel({
          apiKey: requireKey(
            'VISION_PROVIDER=anthropic',
            config.anthropic.apiKey,
            'ANTHROPIC_API_KEY',
          ),
          model: config.anthropic.visionModel,
          ...(deps.anthropicClient ? { client: deps.anthropicClient } : {}),
          // The injected transport still runs under the adapter's host guard.
          ...(deps.fetch ? { fetch: sdkFetchFrom(deps.fetch) } : {}),
          ...loggerOption,
        })
      : fixtures.vision;

  const imageEditor =
    config.providers.imageEditor === 'openai'
      ? createOpenAiImageEditor({
          apiKey: requireKey(
            'IMAGE_EDITOR_PROVIDER=openai',
            config.openai.apiKey,
            'OPENAI_API_KEY',
          ),
          model: config.openai.imageModel,
          ...fetchOption,
          ...loggerOption,
        })
      : config.providers.imageEditor === 'gemini'
        ? createGeminiImageEditor({
            apiKey: requireKey(
              'IMAGE_EDITOR_PROVIDER=gemini',
              config.gemini.apiKey,
              'GEMINI_API_KEY',
            ),
            model: config.gemini.imageModel,
            ...fetchOption,
            ...loggerOption,
          })
        : fixtures.imageEditor;

  const safety =
    (config.providers.safety as string) === 'fixture'
      ? createFixtureSafetyProvider(vision)
      : createLiveSafetyProvider();

  deps.logger?.debug(
    {
      addressProvider: address.mode,
      streetViewProvider: streetView.mode,
      visionProvider: vision.mode,
      imageEditorProvider: imageEditor.mode,
      safetyProvider: safety.mode,
    },
    'providers created',
  );
  return { address, streetView, vision, imageEditor, safety, fixtures };
}
