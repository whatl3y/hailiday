import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { DecorationPlanSchema, type DecorationPlan } from '@hailiday/core';
import { createAnthropicVisionModel, type SdkFetch } from './anthropic.js';
import { createFixtureVisionModel } from './fixture.js';
import { modelJsonSchema } from './json-schema.js';
import {
  JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT,
  JUDGE_RELIGHT_SYSTEM_PROMPT,
  JUDGE_SYSTEM_PROMPT,
  LOCALIZE_PROMPT_VERSION,
  LOCALIZE_SYSTEM_PROMPT,
} from './prompts.js';
import { LocalizeModelOutputSchema } from './records.js';
import type { LocalizeAdditionsInput } from '../types.js';

const solid = (background: string) =>
  sharp({ create: { width: 96, height: 64, channels: 3, background } })
    .jpeg()
    .toBuffer();
const original = await solid('#5a7a5a');
const candidate = await solid('#7a5a5a');
const base = await solid('#5a5a7a');

/**
 * A recorded Claude localization of the smoke-run porch (the six decorations the editor added
 * and the rocking chair it moved), as the reply's structured text. Placement ids follow the plan
 * below; the right tree realizes `p2` in a different spot, the lantern matches no placement, and
 * one id names no planned placement.
 */
const recordedReply = {
  added: [
    {
      label: 'wreath with red bow on front door',
      box: [0.413, 0.082, 0.554, 0.3],
      placementId: 'p1',
    },
    {
      label: 'lit potted tree in black urn, left of door',
      box: [0.305, 0.213, 0.418, 0.626],
      placementId: 'p2',
    },
    {
      label: 'lit potted tree in black urn, right of door',
      box: [0.645, 0.213, 0.551, 0.626],
      placementId: 'p2',
    },
    { label: 'black lantern with candle', box: [0.634, 0.487, 0.681, 0.626], placementId: null },
    {
      label: 'lit garland spiraling the right column',
      box: [0.677, 0, 0.773, 0.598],
      placementId: 'p3',
    },
    {
      label: 'lit garland along the right rail',
      box: [0.748, 0.374, 0.932, 0.451],
      placementId: 'p9',
    },
    { label: 'sliver', box: [0.5, 0.5, 0.5005, 0.6], placementId: 'p1' },
  ],
  otherChanges: [
    {
      description: 'rocking chair moved to the left, away from the door',
      box: [0.206, 0.333, 0.366, 0.629],
    },
  ],
};

function recordedResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_localize',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 4210, output_tokens: 610, cache_read_input_tokens: 900 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

interface SentRequest {
  model: string;
  system: { text: string }[];
  messages: {
    role: string;
    content: { type: string; text?: string; source?: { data: string } }[];
  }[];
  output_config: { effort: string; format: { type: string } };
}

function recordingFetch(text: string) {
  const sent: SentRequest[] = [];
  const fetch = vi.fn<SdkFetch>(async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)) as SentRequest);
    return recordedResponse(text);
  });
  return { fetch, sent };
}

const input: LocalizeAdditionsInput = {
  renderAttemptId: 'attempt-1',
  original: { bytes: original, width: 96, height: 64 },
  candidate: { bytes: candidate, width: 96, height: 64 },
  placements: [
    {
      id: 'p1',
      kitItemId: 'xmas_ext_wreath',
      region: [0.42, 0.1, 0.55, 0.3],
      specText: '24-inch fir wreath with a red bow',
    },
    {
      id: 'p2',
      kitItemId: 'xmas_ext_potted_tree',
      region: [0.2, 0.62, 0.3, 0.9],
      specText: 'two lit potted trees',
    },
    { id: 'p3', kitItemId: 'xmas_ext_garland', region: [0.68, 0, 0.77, 0.6] },
  ],
};

describe('Anthropic localization of added decorations', () => {
  it('sends the original then the candidate with the localization prompt and placement hints', async () => {
    const { fetch, sent } = recordingFetch(JSON.stringify(recordedReply));
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch,
      maxRetries: 0,
    });
    const call = await vision.localizeAdditions(input);

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = sent[0] as SentRequest;
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.system[0]?.text).toBe(LOCALIZE_SYSTEM_PROMPT);
    expect(request.output_config.effort).toBe('medium');
    expect(request.output_config.format.type).toBe('json_schema');
    const content = request.messages[0]?.content ?? [];
    expect(content.map((block) => block.type)).toEqual(['image', 'image', 'text']);
    expect(content[0]?.source?.data).toBe(original.toString('base64'));
    expect(content[1]?.source?.data).toBe(candidate.toString('base64'));
    const text = content[2]?.text ?? '';
    expect(text).toContain(
      '- p1: 24-inch fir wreath with a red bow (planned in the upper center of the image).',
    );
    expect(text).toContain('- p3: xmas ext garland (planned in the upper right of the image).');
    expect(text).toContain('Report every added decoration, listed or not.');

    expect(call.promptVersion).toBe(LOCALIZE_PROMPT_VERSION);
    expect(call.promptVersion).toBe('localize-2026.11.0');
    expect(call.model).toBe('claude-opus-5-5');
    expect(call.providerMode).toBe('live');
    expect(call.usage).toEqual({
      inputTokens: 4210,
      outputTokens: 610,
      cacheReadInputTokens: 900,
      calls: 1,
    });
  });

  it('keeps planned ids, nulls unknown ones, orders corners and drops degenerate boxes', async () => {
    const { fetch } = recordingFetch(JSON.stringify(recordedReply));
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch,
      maxRetries: 0,
    });
    const { result } = await vision.localizeAdditions(input);
    expect(result.added).toEqual([
      {
        label: 'wreath with red bow on front door',
        box: [0.413, 0.082, 0.554, 0.3],
        placementId: 'p1',
      },
      {
        label: 'lit potted tree in black urn, left of door',
        box: [0.305, 0.213, 0.418, 0.626],
        placementId: 'p2',
      },
      {
        label: 'lit potted tree in black urn, right of door',
        box: [0.551, 0.213, 0.645, 0.626],
        placementId: 'p2',
      },
      { label: 'black lantern with candle', box: [0.634, 0.487, 0.681, 0.626], placementId: null },
      {
        label: 'lit garland spiraling the right column',
        box: [0.677, 0, 0.773, 0.598],
        placementId: 'p3',
      },
      {
        label: 'lit garland along the right rail',
        box: [0.748, 0.374, 0.932, 0.451],
        placementId: null,
      },
    ]);
    expect(result.otherChanges).toEqual([
      {
        description: 'rocking chair moved to the left, away from the door',
        box: [0.206, 0.333, 0.366, 0.629],
      },
    ]);
  });

  it('produces a structured-output schema the SDK accepts', () => {
    const json = modelJsonSchema(LocalizeModelOutputSchema);
    expect(JSON.stringify(json)).not.toContain('prefixItems');
    expect(() => jsonSchemaOutputFormat(json as { type: 'object' })).not.toThrow();
  });
});

describe('fixture localization', () => {
  it('reports every planned region as added with its placement id and no other change', async () => {
    const vision = createFixtureVisionModel();
    const first = await vision.localizeAdditions(input);
    const second = await vision.localizeAdditions(input);
    expect(first.result).toEqual({
      added: [
        {
          label: '24-inch fir wreath with a red bow',
          box: [0.42, 0.1, 0.55, 0.3],
          placementId: 'p1',
        },
        { label: 'two lit potted trees', box: [0.2, 0.62, 0.3, 0.9], placementId: 'p2' },
        { label: 'xmas_ext_garland', box: [0.68, 0, 0.77, 0.6], placementId: 'p3' },
      ],
      otherChanges: [],
    });
    expect(second.result).toEqual(first.result);
    expect(first.providerMode).toBe('fixture');
    expect(first.promptVersion).toBe(LOCALIZE_PROMPT_VERSION);
  });
});

const plan: DecorationPlan = DecorationPlanSchema.parse({
  schemaVersion: '1.0',
  renderJobId: 'job-1',
  planVersion: 1,
  attemptNumber: 1,
  sourceAssetId: 'source-1',
  sceneAnalysisId: 'analysis-1',
  countryCode: 'US',
  locale: 'en-US',
  sceneType: 'house_exterior',
  buildingForm: 'detached',
  holidayId: 'christmas',
  holidayPackVersion: '1.0.0',
  styleKitVersionId: 'kit-1',
  style: 'classic',
  lightingMode: 'evening',
  fidelityMode: 'global_relight',
  compilerVersion: '2026.11.2-openai',
  placements: [
    {
      id: 'p1',
      kitItemId: 'xmas_ext_wreath',
      anchorId: 'a1',
      anchorCategory: 'front_door',
      region: [0.46, 0.5, 0.54, 0.62],
      placementRule: 'centered_on',
      count: 1,
      specText: '24-inch fresh fir wreath',
      specAttributes: {},
      lit: true,
      priority: 1,
    },
  ],
  preserve: {
    targetFacade: [0.1, 0.15, 0.9, 0.95],
    regions: [],
    protectedBlurRegions: [],
    peopleBoxes: [],
    accessRegions: [],
    existingDecorations: [],
    keepSkyAndTimeOfDay: false,
    neighborsUnchanged: true,
    noSnow: true,
  },
  negatives: [],
  lightingInstruction: { mode: 'evening', text: 'Dusk.' },
  existingDecorConflict: false,
  permissionEvaluationId: 'pe-1',
  referenceAssetIds: [],
  compiled: {
    provider: 'openai',
    modelSnapshot: 'gpt-image-2.5-flare',
    instructionText: 'Relight.',
    parameters: {},
    hash: 'sha256:x',
  },
});

const judgeReply = JSON.stringify({
  critical: [],
  major: [],
  placements: [
    {
      placementId: 'p1',
      present: true,
      confidence: 0.9,
      adherence: { category: true, colorFamily: true, count: 'pass', scale: 'ok' },
    },
  ],
  scores: { realism: 4, appeal: 4, planAdherence: 4 },
  overallConfidence: 0.9,
});

describe('Anthropic judge modes', () => {
  it('relight mode compares the decorated base with the candidate under the relight prompt', async () => {
    const { fetch, sent } = recordingFetch(judgeReply);
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch,
      maxRetries: 0,
    });
    await vision.judge({
      renderAttemptId: 'attempt-2',
      original: { bytes: original, width: 96, height: 64 },
      base: { bytes: base, width: 96, height: 64 },
      candidate: { bytes: candidate, width: 96, height: 64 },
      plan,
      mode: 'relight',
    });
    const request = sent[0] as SentRequest;
    expect(request.system[0]?.text).toBe(JUDGE_RELIGHT_SYSTEM_PROMPT);
    const content = request.messages[0]?.content ?? [];
    expect(content[0]?.source?.data).toBe(base.toString('base64'));
    expect(content[1]?.source?.data).toBe(candidate.toString('base64'));
    expect(content[2]?.text).toContain('Decorations in image 1');
    expect(content[2]?.text).toContain(
      '- p1: 1 x 24-inch fresh fir wreath, switched on (should glow).',
    );
  });

  it('relight mode of a bright relight uses the bright relight prompt', async () => {
    const { fetch, sent } = recordingFetch(judgeReply);
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch,
      maxRetries: 0,
    });
    await vision.judge({
      renderAttemptId: 'attempt-2',
      original: { bytes: original, width: 96, height: 64 },
      base: { bytes: base, width: 96, height: 64 },
      candidate: { bytes: candidate, width: 96, height: 64 },
      plan: { ...plan, lightingMode: 'bright' },
      mode: 'relight',
    });
    const request = sent[0] as SentRequest;
    expect(request.system[0]?.text).toBe(JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT);
    expect(request.messages[0]?.content?.[2]?.text).toContain('Requested light: the bright look');
  });

  it('decorate mode (the default) compares the original with the candidate', async () => {
    const { fetch, sent } = recordingFetch(judgeReply);
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch,
      maxRetries: 0,
    });
    await vision.judge({
      renderAttemptId: 'attempt-1',
      original: { bytes: original, width: 96, height: 64 },
      candidate: { bytes: candidate, width: 96, height: 64 },
      plan: { ...plan, lightingMode: 'source' },
    });
    const request = sent[0] as SentRequest;
    expect(request.system[0]?.text).toBe(JUDGE_SYSTEM_PROMPT);
    const content = request.messages[0]?.content ?? [];
    expect(content[0]?.source?.data).toBe(original.toString('base64'));
    expect(content[2]?.text).toContain('Planned placements (the kinds and counts matter');
  });
});
