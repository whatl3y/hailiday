import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneAnalysisModelOutput } from '@holiday/core';
import { parseConfig } from '../../config/index.js';
import { createProviders } from '../create.js';
import { ProviderError, isProviderError } from '../errors.js';
import type { FetchLike } from '../http.js';
import {
  createAnthropicVisionModel,
  guardedAnthropicFetch,
  sdkFetchFrom,
  type SdkFetch,
} from './anthropic.js';

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
