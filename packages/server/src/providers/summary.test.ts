import { describe, expect, it } from 'vitest';
import { parseConfig, testConfig } from '../config/index.js';
import { createProviders } from './create.js';
import { summarizeProviders } from './summary.js';

const OPENAI_KEY = 'sk-summary-test-123456';
const GEMINI_KEY = 'gemini-summary-test-123456';
const ANTHROPIC_KEY = 'sk-ant-summary-test-123456';

describe('summarizeProviders', () => {
  it('names the preferred live editor, its model and settings when both image keys are set', () => {
    const config = parseConfig({
      OPENAI_API_KEY: OPENAI_KEY,
      GEMINI_API_KEY: GEMINI_KEY,
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      IMAGE_EDITOR_PREFERENCE: 'gemini',
    });
    const summary = summarizeProviders(config, createProviders(config));
    expect(summary.providerModes).toEqual({
      addressProvider: 'fixture',
      streetViewProvider: 'fixture',
      imageEditorProvider: 'live',
      visionProvider: 'live',
      safetyProvider: 'fixture',
      commercePrograms: 'real',
    });
    expect(summary.imageEditor).toEqual({
      provider: 'gemini',
      selection: 'auto',
      preference: 'gemini',
      model: 'gemini-nano-banana-2.1',
      providerMask: 'none',
      imageSize: '1K',
      thinkingLevel: 'minimal',
    });
    expect(summary.vision).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    const serialized = JSON.stringify(summary);
    for (const key of [OPENAI_KEY, GEMINI_KEY, ANTHROPIC_KEY])
      expect(serialized).not.toContain(key);
  });

  it('reports the OpenAI model and quality when OpenAI is selected', () => {
    const config = parseConfig({
      OPENAI_API_KEY: OPENAI_KEY,
      GEMINI_API_KEY: GEMINI_KEY,
    });
    const summary = summarizeProviders(config, createProviders(config));
    expect(summary.imageEditor).toEqual({
      provider: 'openai',
      selection: 'auto',
      preference: 'openai',
      model: 'gpt-image-2.5-flare',
      providerMask: 'none',
      quality: 'medium',
    });
    expect(summary.vision).toEqual({ provider: 'fixture', model: null });
  });

  it('reports fixtures without a model', () => {
    const config = testConfig();
    const summary = summarizeProviders(config, createProviders(config));
    expect(summary.imageEditor.provider).toBe('fixture');
    expect(summary.imageEditor.model).toBeNull();
    expect(summary.imageEditor.selection).toBe('fixture');
    expect(summary.vision).toEqual({ provider: 'fixture', model: null });
    expect(summary.providerModes.commercePrograms).toBe('fixture');
  });
});
