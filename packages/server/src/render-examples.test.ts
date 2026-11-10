import { describe, expect, it } from 'vitest';
import { parseConfig } from './config/index.js';
import { exampleEditSettings } from './render-examples.js';

describe('examples:render request settings', () => {
  it('compiles the examples with the configured settings and the live model snapshot', () => {
    const config = parseConfig({
      IMAGE_EDITOR_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-123456',
      OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst',
      OPENAI_IMAGE_QUALITY: 'high',
      IMAGE_EDIT_PROVIDER_MASK: 'tight',
      GEMINI_IMAGE_SIZE: '2K',
      GEMINI_THINKING_LEVEL: 'medium',
    });
    expect(exampleEditSettings(config)).toEqual({
      modelSnapshot: 'gpt-image-2.5-sunburst',
      imageEdit: {
        providerMask: 'tight',
        openaiQuality: 'high',
        geminiImageSize: '2K',
        geminiThinkingLevel: 'medium',
      },
    });
  });

  it('uses the Gemini model snapshot when Gemini edits', () => {
    const config = parseConfig({
      IMAGE_EDITOR_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-test-123456',
    });
    expect(exampleEditSettings(config)).toMatchObject({
      modelSnapshot: 'gemini-nano-banana-2.1',
      imageEdit: { providerMask: 'none', geminiImageSize: '1K', geminiThinkingLevel: 'minimal' },
    });
  });
});
