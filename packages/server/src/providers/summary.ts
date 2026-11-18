import type { CommerceMode } from '@hailiday/core';
import type { AppConfig, ImageEditorProviderName, VisionProviderName } from '../config/index.js';
import type { ProviderImplementationMode, Providers } from './types.js';

/** The live image editor in use, with the model and the budget settings sent on every edit. */
export interface ImageEditorSummary {
  provider: ImageEditorProviderName;
  /** The configured selection (`auto`, or an explicit editor). */
  selection: AppConfig['providerSelection']['imageEditor'];
  /** The editor `auto` prefers when both image keys are set. */
  preference: AppConfig['imageEdit']['preference'];
  model: string | null;
  providerMask: AppConfig['imageEdit']['providerMask'];
  quality?: AppConfig['imageEdit']['openaiQuality'];
  imageSize?: AppConfig['imageEdit']['geminiImageSize'];
  thinkingLevel?: AppConfig['imageEdit']['geminiThinkingLevel'];
}

/** The vision model behind scene analysis, upload triage and the QA judge. */
export interface VisionSummary {
  provider: VisionProviderName;
  model: string | null;
}

/** A log-safe description of the providers a process runs with: modes, vendors and models. */
export interface ProviderSummary {
  providerModes: {
    addressProvider: ProviderImplementationMode;
    streetViewProvider: ProviderImplementationMode;
    imageEditorProvider: ProviderImplementationMode;
    visionProvider: ProviderImplementationMode;
    safetyProvider: ProviderImplementationMode;
    /** Which kind of merchant program Shop the look serves (`fixture` or `real`). */
    commercePrograms: CommerceMode;
  };
  imageEditor: ImageEditorSummary;
  vision: VisionSummary;
}

/**
 * Describes the providers for the startup log. Modes come from the provider instances; the
 * vendor, model and budget settings come from the configuration that selected them. A leg that
 * runs a fixture reports the `fixture` vendor and no model. Never includes a key.
 */
export function summarizeProviders(
  config: AppConfig,
  providers: Pick<Providers, 'address' | 'streetView' | 'imageEditor' | 'vision' | 'safety'>,
): ProviderSummary {
  const editorProvider: ImageEditorProviderName =
    providers.imageEditor.mode === 'fixture' ? 'fixture' : config.providers.imageEditor;
  const imageEditor: ImageEditorSummary = {
    provider: editorProvider,
    selection: config.providerSelection.imageEditor,
    preference: config.imageEdit.preference,
    model:
      editorProvider === 'openai'
        ? config.openai.imageModel
        : editorProvider === 'gemini'
          ? config.gemini.imageModel
          : null,
    providerMask: config.imageEdit.providerMask,
    ...(editorProvider === 'openai' ? { quality: config.imageEdit.openaiQuality } : {}),
    ...(editorProvider === 'gemini'
      ? {
          imageSize: config.imageEdit.geminiImageSize,
          thinkingLevel: config.imageEdit.geminiThinkingLevel,
        }
      : {}),
  };
  const visionProvider: VisionProviderName =
    providers.vision.mode === 'fixture' ? 'fixture' : config.providers.vision;
  return {
    providerModes: {
      addressProvider: providers.address.mode,
      streetViewProvider: providers.streetView.mode,
      imageEditorProvider: providers.imageEditor.mode,
      visionProvider: providers.vision.mode,
      safetyProvider: providers.safety.mode,
      commercePrograms: config.providers.commerce,
    },
    imageEditor,
    vision: {
      provider: visionProvider,
      model: visionProvider === 'anthropic' ? config.anthropic.visionModel : null,
    },
  };
}
