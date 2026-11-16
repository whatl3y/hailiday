import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneAnalysisModelOutput } from '@hailiday/core';
import { parseConfig } from '../../config/index.js';
import { createProviders } from '../create.js';
import { ProviderError, isProviderError } from '../errors.js';
import type { FetchLike } from '../http.js';
import {
  createAnthropicVisionModel,
  guardedAnthropicFetch,
  sdkFetchFrom,
  type AnthropicMessagesClient,
  type SdkFetch,
} from './anthropic.js';
import {
  FRAME_PROMPT_VERSION,
  FRAME_SYSTEM_PROMPT,
  FRAME_USER_PROMPT,
  JUDGE_ENHANCE_SYSTEM_PROMPT,
  JUDGE_PROMPT_VERSION,
} from './prompts.js';

const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#406080' } })
  .jpeg()
  .toBuffer();

const modelOutput: SceneAnalysisModelOutput = {
  sceneType: 'house_exterior',
  sceneTypeConfidence: 0.95,
  buildingForm: 'detached',
  targetFacade: [0.1, 0.1, 0.9, 0.9],
  targetFacadeAmbiguous: false,
  anchors: [
    {
      id: 'a1',
      category: 'front_door',
      box: [0.45, 0.5, 0.55, 0.75],
      confidence: 0.95,
      occluded: false,
    },
  ],
  preserveRegions: [],
  accessRegions: [],
  hazards: [],
  existingDecorations: { present: false, density: 'none', boxes: [] },
  peopleBoxes: [],
  protectedBlurRegions: [],
  lighting: { timeOfDay: 'day', isDaylight: true, exposure: 'normal' },
  seasonCues: { snowVisible: false, foliage: 'leafy' },
  qualityFlags: {
    blur: false,
    lowLight: false,
    heavyOcclusion: false,
    multipleBuildings: false,
    embeddedPhoto: false,
    tooClose: false,
    tooFar: false,
  },
};

const analyzeInput = {
  image: { bytes: jpeg, width: 64, height: 64, checksum: 'abc' },
  sourceAssetId: 'source-1',
  sourceKind: 'upload' as const,
  sceneType: 'house_exterior' as const,
  buildingForm: 'detached' as const,
};

function messageResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text: JSON.stringify(modelOutput) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const REDIRECT_VARIABLES = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS'] as const;
const saved = Object.fromEntries(REDIRECT_VARIABLES.map((name) => [name, process.env[name]]));

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of REDIRECT_VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('Anthropic vision transport', () => {
  it('calls only the vendor host without redirects, even when ANTHROPIC_BASE_URL is set', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example';
    const seen: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const stub = vi.fn<SdkFetch>(async (input, init) => {
      seen.push({ url: String(input), redirect: init?.redirect });
      return messageResponse();
    });
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch: stub,
      maxRetries: 0,
    });
    const result = await vision.analyzeScene(analyzeInput);
    expect(result.result.anchors[0]?.category).toBe('front_door');
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? '').host).toBe('api.anthropic.com');
    expect(seen[0]?.redirect).toBe('error');
  });

  it('refuses a host outside the provider allowlist before any request', async () => {
    const stub = vi.fn<SdkFetch>(async () => messageResponse());
    const guarded = guardedAnthropicFetch(stub);
    for (const url of [
      'https://gateway.example/v1/messages',
      'http://api.anthropic.com/v1/messages',
      'not a url',
    ]) {
      const error = await guarded(url, { method: 'POST' }).catch((caught: unknown) => caught);
      expect(isProviderError(error)).toBe(true);
      expect(error).toMatchObject({
        provider: 'anthropic',
        kind: 'invalid_request',
        retryable: false,
      });
    }
    expect(stub).not.toHaveBeenCalled();

    await guarded('https://api.anthropic.com/v1/messages', { method: 'POST' });
    expect(stub).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
    });
  });

  it('surfaces a transport refusal as the provider error, not a connection failure', async () => {
    const stub = vi.fn<SdkFetch>(async () => {
      throw new ProviderError('anthropic', 'invalid_request', 'Host is not an allowed provider', {
        retryable: false,
      });
    });
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch: stub,
      maxRetries: 0,
    });
    const error = await vision.analyzeScene(analyzeInput).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ provider: 'anthropic', kind: 'invalid_request' });
  });
});

describe('Anthropic vision from the provider factory', () => {
  const config = parseConfig({
    APP_ENV: 'development',
    VISION_PROVIDER: 'anthropic',
    ANTHROPIC_API_KEY: 'sk-ant-test-123456',
  });

  it('sends the vision call through the injected transport, to the vendor host only', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example';
    // The global transport is never reached; it fails instead of touching the network.
    const network = vi.fn(async () => {
      throw new Error('network disabled in tests');
    });
    vi.stubGlobal('fetch', network);
    const seen: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const stub = vi.fn<FetchLike>(async (url, init) => {
      seen.push({ url, redirect: init?.redirect });
      return messageResponse();
    });
    const vision = createProviders(config, { fetch: stub }).vision;
    expect(vision.mode).toBe('live');
    const result = await vision.analyzeScene(analyzeInput);
    expect(result.result.anchors[0]?.category).toBe('front_door');
    expect(stub).toHaveBeenCalledTimes(1);
    expect(new URL(seen[0]?.url ?? '').host).toBe('api.anthropic.com');
    expect(seen[0]?.redirect).toBe('error');
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps the host guard in front of the injected transport', async () => {
    const stub = vi.fn<FetchLike>(async () => messageResponse());
    const guarded = guardedAnthropicFetch(sdkFetchFrom(stub));
    for (const url of [
      'https://gateway.example/v1/messages',
      new URL('http://api.anthropic.com/'),
    ]) {
      const error = await guarded(url, { method: 'POST' }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ provider: 'anthropic', kind: 'invalid_request' });
    }
    expect(stub).not.toHaveBeenCalled();
    await guarded(new URL('https://api.anthropic.com/v1/messages'), { method: 'POST' });
    expect(stub).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
    });
  });
});

describe('Anthropic enhance judge', () => {
  it('sends the original then the candidate with the enhance prompts, and returns no placements', async () => {
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#808080' },
    })
      .png()
      .toBuffer();
    const sent: { params: Record<string, unknown>; options?: { timeout?: number } }[] = [];
    const client: AnthropicMessagesClient = {
      beta: {
        messages: {
          async parse(params, options) {
            sent.push({ params, ...(options ? { options } : {}) });
            return {
              model: 'claude-opus-5-5',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: '{}' }],
              parsed_output: {
                ok: true,
                value: {
                  critical: [
                    {
                      code: 'structure_changed',
                      confidence: 0.8,
                      evidence: 'A dish on the roof moved.',
                    },
                  ],
                  major: [],
                  placements: [
                    {
                      placementId: 'p1',
                      present: true,
                      confidence: 0.9,
                      adherence: { category: true, colorFamily: true, count: 'pass', scale: 'ok' },
                    },
                  ],
                  scores: { realism: 4, appeal: 4, planAdherence: 3 },
                  overallConfidence: 0.8,
                },
              },
              usage: { input_tokens: 1200, output_tokens: 300 },
            };
          },
        },
      },
    };
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      client,
    });
    const enhancementId = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e';
    const call = await vision.judgeEnhancement({
      enhancementId,
      original: { bytes: png, width: 32, height: 32 },
      candidate: { bytes: jpeg, width: 64, height: 64 },
      sceneType: 'house_exterior',
      preserve: {
        regions: [],
        protectedBlurRegions: [],
        peopleBoxes: [[0.1, 0.5, 0.2, 0.9]],
        attributionRegions: [[0, 0.95, 0.12, 1]],
      },
    });
    expect(sent).toHaveLength(1);
    const params = sent[0]?.params as {
      system: { text: string }[];
      messages: {
        content: { type: string; text?: string; source?: { media_type: string; data: string } }[];
      }[];
      output_config: { effort: string };
    };
    expect(params.system[0]?.text).toBe(JUDGE_ENHANCE_SYSTEM_PROMPT);
    const content = params.messages[0]?.content ?? [];
    expect(content.map((block) => block.type)).toEqual(['image', 'image', 'text']);
    expect(content[0]?.source).toMatchObject({
      media_type: 'image/png',
      data: png.toString('base64'),
    });
    expect(content[1]?.source).toMatchObject({
      media_type: 'image/jpeg',
      data: jpeg.toString('base64'),
    });
    expect(content[2]?.text).toContain('Requested change: image quality only.');
    expect(content[2]?.text).toContain('- a person (lower left of the image)');
    expect(params.output_config.effort).toBe('medium');
    expect(sent[0]?.options?.timeout).toBe(30_000);
    expect(call.result.renderAttemptId).toBe(enhancementId);
    expect(call.result.placements).toEqual([]);
    expect(call.result.escalated).toBe(false);
    expect(call.result.critical.map((finding) => finding.code)).toEqual(['structure_changed']);
    expect(call.result.judgePromptVersion).toBe(JUDGE_PROMPT_VERSION);
    expect(call.promptVersion).toBe(JUDGE_PROMPT_VERSION);
    expect(call.providerMode).toBe('live');
    expect(call.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300, calls: 1 });
  });
});

describe('Anthropic locate home', () => {
  /** A client whose reply text is parsed by the request's own structured-output format. */
  function replying(reply: unknown) {
    const sent: { params: Record<string, unknown>; options?: { timeout?: number } }[] = [];
    const client: AnthropicMessagesClient = {
      beta: {
        messages: {
          async parse(params, options) {
            sent.push({ params, ...(options ? { options } : {}) });
            const text = JSON.stringify(reply);
            const format = (params.output_config as { format: { parse(text: string): unknown } })
              .format;
            return {
              model: 'claude-opus-5-5',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text }],
              parsed_output: format.parse(text),
              usage: { input_tokens: 900, output_tokens: 40 },
            };
          },
        },
      },
    };
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      client,
      reasks: 0,
    });
    return { vision, sent };
  }

  const input = { image: { bytes: jpeg, width: 64, height: 64 }, sourceAssetId: 'source-1' };

  it('sends the frame as it is with the frame prompts at low effort and reads one box', async () => {
    const { vision, sent } = replying({
      home: [0.495, 0.615, 0.165, 0.26],
      ambiguous: false,
      confidence: 0.92,
    });
    const call = await vision.locateHome(input);
    expect(sent).toHaveLength(1);
    const params = sent[0]?.params as {
      system: { text: string }[];
      messages: {
        content: { type: string; text?: string; source?: { media_type: string; data: string } }[];
      }[];
      output_config: { effort: string };
    };
    expect(params.system[0]?.text).toBe(FRAME_SYSTEM_PROMPT);
    const content = params.messages[0]?.content ?? [];
    expect(content.map((block) => block.type)).toEqual(['image', 'text']);
    expect(content[0]?.source).toMatchObject({
      media_type: 'image/jpeg',
      data: jpeg.toString('base64'),
    });
    expect(content[1]?.text).toBe(FRAME_USER_PROMPT);
    expect(params.output_config.effort).toBe('low');
    expect(sent[0]?.options?.timeout).toBe(20_000);
    // Corners come back ordered.
    expect(call.result).toEqual({
      home: [0.165, 0.26, 0.495, 0.615],
      ambiguous: false,
      confidence: 0.92,
    });
    expect(call.promptVersion).toBe(FRAME_PROMPT_VERSION);
    expect(call.providerMode).toBe('live');
    expect(call.usage).toMatchObject({ inputTokens: 900, outputTokens: 40, calls: 1 });
  });

  it('reads no home, an ambiguous frame and a degenerate box', async () => {
    expect(
      (await replying({ home: null, ambiguous: false, confidence: 0.9 }).vision.locateHome(input))
        .result,
    ).toEqual({ home: null, ambiguous: false, confidence: 0.9 });
    expect(
      (await replying({ home: null, ambiguous: true, confidence: 0.4 }).vision.locateHome(input))
        .result,
    ).toEqual({ home: null, ambiguous: true, confidence: 0.4 });
    expect(
      (
        await replying({
          home: [0.3, 0.3, 0.3, 0.6],
          ambiguous: false,
          confidence: 0.8,
        }).vision.locateHome(input)
      ).result.home,
    ).toBeNull();
  });

  it('fails as a schema violation when the reply is not a locate answer', async () => {
    const { vision } = replying({ home: [0.1, 0.2, 0.3], confidence: 2 });
    await expect(vision.locateHome(input)).rejects.toMatchObject({ kind: 'schema_violation' });
  });

  it('asks the SDK to send the locate request once', async () => {
    const { vision, sent } = replying({ home: null, ambiguous: false, confidence: 0.9 });
    await vision.locateHome(input);
    expect(sent[0]?.options).toMatchObject({ maxRetries: 0 });
  });

  it('sends a locate request that fails only once, where other calls are sent again', async () => {
    // The vendor answers every request as overloaded and invites an immediate retry.
    const stub = vi.fn<SdkFetch>(
      async () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
          {
            status: 529,
            headers: {
              'content-type': 'application/json',
              'retry-after-ms': '0',
              'x-should-retry': 'true',
            },
          },
        ),
    );
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      fetch: stub,
      maxRetries: 2,
      reasks: 0,
    });
    await expect(vision.locateHome(input)).rejects.toSatisfy(isProviderError);
    expect(stub).toHaveBeenCalledTimes(1);
    stub.mockClear();
    await expect(vision.analyzeScene(analyzeInput)).rejects.toSatisfy(isProviderError);
    expect(stub).toHaveBeenCalledTimes(3);
  });
});
