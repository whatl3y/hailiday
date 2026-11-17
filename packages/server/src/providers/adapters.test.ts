import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import {
  JudgeModelOutputSchema,
  SceneAnalysisModelOutputSchema,
  UploadTriageSchema,
  type CompiledRequest,
  type SceneAnalysisModelOutput,
} from '@hailiday/core';
import type { Logger } from '../logger/index.js';
import { createGoogleAddressProvider } from './address/google.js';
import { isProviderError } from './errors.js';
import {
  buildGeminiEditBody,
  createGeminiImageEditor,
  geminiFinishClass,
} from './image-editor/gemini.js';
import {
  buildOpenAiEditForm,
  createOpenAiImageEditor,
  toOpenAiMask,
} from './image-editor/openai.js';
import {
  SERVER_SIDE_FALLBACK_BETA,
  createAnthropicVisionModel,
  type AnthropicMessagesClient,
  type AnthropicParsedMessage,
} from './vision/anthropic.js';
import { modelJsonSchema } from './vision/json-schema.js';
import { compilerVersionFor } from '../pipeline/versions.js';

const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } })
  .png()
  .toBuffer();
const jpeg = await sharp({
  create: { width: 1024, height: 1024, channels: 3, background: '#406080' },
})
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

function stubClient(replies: Partial<AnthropicParsedMessage>[]) {
  const calls: { params: Record<string, unknown>; options: unknown }[] = [];
  const client: AnthropicMessagesClient = {
    beta: {
      messages: {
        parse: vi.fn(async (params: Record<string, unknown>, options?: unknown) => {
          calls.push({ params, options });
          const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
          const text = (reply.content?.[0]?.text as string | undefined) ?? '';
          // Emulate the SDK: run the format's parse over the reply text.
          const format = (params.output_config as { format: { parse(content: string): unknown } })
            .format;
          return {
            model: 'claude-opus-5-5',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text }],
            usage: { input_tokens: 1500, output_tokens: 400, cache_read_input_tokens: 0 },
            ...reply,
            parsed_output:
              reply.stop_reason && reply.stop_reason !== 'end_turn' ? null : format.parse(text),
          } as AnthropicParsedMessage;
        }),
      },
    },
  };
  return { client, calls };
}

const analyzeInput = {
  image: { bytes: jpeg, width: 1024, height: 1024, checksum: 'abc' },
  sourceAssetId: 'source-1',
  sourceKind: 'upload' as const,
  sceneType: 'house_exterior' as const,
  buildingForm: 'detached' as const,
};

describe('Anthropic vision adapter', () => {
  it('builds a structured-output request with explicit effort, base64 images and fallbacks', async () => {
    const { client, calls } = stubClient([
      { content: [{ type: 'text', text: JSON.stringify(modelOutput) }] },
    ]);
    const vision = createAnthropicVisionModel({
      apiKey: 'test-key-123456',
      model: 'claude-opus-5-5',
      client,
    });
    const result = await vision.analyzeScene(analyzeInput);
    expect(result.result.anchors[0]?.category).toBe('front_door');
    expect(result.result.sceneTypeMismatch).toBe(false);
    expect(result.usage).toMatchObject({ inputTokens: 1500, outputTokens: 400, calls: 1 });

    const params = calls[0]?.params as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.max_tokens).toBe(16000);
    expect(params.betas).toEqual([SERVER_SIDE_FALLBACK_BETA]);
    expect(params.fallbacks).toBe('default');
    const outputConfig = params.output_config as {
      effort: string;
      format: { type: string; schema: Record<string, unknown> };
    };
    expect(outputConfig.effort).toBe('medium');
    expect(outputConfig.format.type).toBe('json_schema');
    expect(outputConfig.format.schema.type).toBe('object');
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking'])
      expect(params).not.toHaveProperty(forbidden);
    expect(JSON.stringify(params)).not.toContain('budget_tokens');
    const messages = params.messages as {
      role: string;
      content: { type: string; source?: { type: string; media_type: string; data: string } }[];
    }[];
    const image = messages[0]?.content[0];
    expect(image).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg' },
    });
    expect(image?.source?.data).toBe(jpeg.toString('base64'));
    const system = params.system as { cache_control?: unknown }[];
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('maps a refusal to a moderation refusal', async () => {
    const { client } = stubClient([
      { stop_reason: 'refusal', stop_details: { category: 'general_harms' } },
    ]);
    const vision = createAnthropicVisionModel({
      apiKey: 'test-key-123456',
      model: 'claude-opus-5-5',
      client,
    });
    const error = await vision.analyzeScene(analyzeInput).catch((caught: unknown) => caught);
    expect(isProviderError(error) && error.kind).toBe('moderation_blocked');
    expect(isProviderError(error) && error.providerCategories).toEqual(['general_harms']);
  });

  it('treats max_tokens as a provider error', async () => {
    const { client } = stubClient([{ stop_reason: 'max_tokens' }]);
    const vision = createAnthropicVisionModel({
      apiKey: 'test-key-123456',
      model: 'claude-opus-5-5',
      client,
    });
    const error = await vision.analyzeScene(analyzeInput).catch((caught: unknown) => caught);
    expect(isProviderError(error) && error.providerCode).toBe('max_tokens');
  });

  it('re-asks once with the validation errors after a schema failure', async () => {
    const { client, calls } = stubClient([
      { content: [{ type: 'text', text: '{"sceneType":"castle"}' }] },
      { content: [{ type: 'text', text: JSON.stringify(modelOutput) }] },
    ]);
    const vision = createAnthropicVisionModel({
      apiKey: 'test-key-123456',
      model: 'claude-opus-5-5',
      client,
    });
    const result = await vision.analyzeScene(analyzeInput);
    expect(result.usage.calls).toBe(2);
    const second = calls[1]?.params.messages as { role: string; content: { text?: string }[] }[];
    expect(second).toHaveLength(3);
    expect(second[2]?.content[0]?.text).toContain('did not match the required schema');
  });

  it('fails with a schema violation after the re-ask', async () => {
    const { client } = stubClient([{ content: [{ type: 'text', text: 'not json' }] }]);
    const vision = createAnthropicVisionModel({
      apiKey: 'test-key-123456',
      model: 'claude-opus-5-5',
      client,
    });
    const error = await vision.analyzeScene(analyzeInput).catch((caught: unknown) => caught);
    expect(isProviderError(error) && error.kind).toBe('schema_violation');
  });

  it('produces model JSON schemas the SDK output-format helper accepts', () => {
    for (const schema of [
      SceneAnalysisModelOutputSchema,
      JudgeModelOutputSchema,
      UploadTriageSchema,
    ]) {
      const json = modelJsonSchema(schema);
      expect(JSON.stringify(json)).not.toContain('prefixItems');
      expect(() => jsonSchemaOutputFormat(json as { type: 'object' })).not.toThrow();
    }
  });
});

const compiled: CompiledRequest = {
  schemaVersion: '1.0',
  compilerVersion: compilerVersionFor('openai'),
  provider: 'openai',
  modelSnapshot: 'gpt-image-2.5-sunburst',
  images: [{ role: 'source', width: 1024, height: 1024, checksum: 'abc' }],
  instructionText:
    'Edit only the target house in the attached photo for a tasteful US Christmas display.',
  parameters: { size: '1024x1024', quality: 'high', output_format: 'jpeg' },
  settingsHash: 'hash',
};
const compiledWithMask: CompiledRequest = {
  ...compiled,
  mask: { width: 8, height: 8, checksum: 'mask' },
};

/** A single-channel pipeline mask: 255 (editable) in the left half, 0 elsewhere, 128 at (7, 7). */
async function pipelineMask(): Promise<Buffer> {
  const raw = Buffer.alloc(64);
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 4; x += 1) raw[y * 8 + x] = 255;
  raw[63] = 128;
  return sharp(raw, { raw: { width: 8, height: 8, channels: 1 } })
    .png()
    .toBuffer();
}

function capturingLogger() {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

const respondJson = (status: number, body: unknown) =>
  vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );

describe('OpenAI image editor adapter', () => {
  it('posts a multipart edit with model, size, quality and output format and decodes b64 output', async () => {
    const order: string[] = [];
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      order.push('fetch');
      captured = { url, ...(init ? { init } : {}) };
      return new Response(
        JSON.stringify({
          data: [{ b64_json: jpeg.toString('base64') }],
          usage: { input_tokens: 1200, output_tokens: 4200 },
        }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_1' } },
      );
    });
    const editor = createOpenAiImageEditor({
      apiKey: 'sk-test-123456',
      model: 'gpt-image-2.5-sunburst',
      fetch: fetchStub,
    });
    const outcome = await editor.edit(
      compiledWithMask,
      { image: png, mask: await pipelineMask() },
      {
        attemptId: 'attempt-1',
        timeoutMs: 5000,
        signal: new AbortController().signal,
        onOperation: async (id) => {
          order.push(`op:${id}`);
        },
      },
    );
    expect(order).toEqual(['op:openai:attempt-1', 'fetch']);
    expect(outcome).toMatchObject({
      status: 'completed',
      width: 1024,
      height: 1024,
      format: 'jpeg',
      providerMode: 'live',
    });
    const request = captured as unknown as { url: string; init: RequestInit };
    expect(request.url).toBe('https://api.openai.com/v1/images/edits');
    expect(request.init.method).toBe('POST');
    expect((request.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test-123456',
    );
    const form = request.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
    expect(form.get('size')).toBe('1024x1024');
    expect(form.get('quality')).toBe('high');
    expect(form.get('output_format')).toBe('jpeg');
    expect(form.get('prompt')).toBe(compiled.instructionText);
    expect((form.get('image') as Blob).type).toBe('image/png');
    expect((form.get('mask') as Blob).type).toBe('image/png');
  });

  it('maps moderation, server errors and timeouts', async () => {
    const respond = (status: number, body: unknown) =>
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      );
    const run = (fetchImpl: ReturnType<typeof respond>) =>
      createOpenAiImageEditor({ apiKey: 'sk-test-123456', model: 'm', fetch: fetchImpl }).edit(
        compiled,
        { image: png },
        { attemptId: 'a', timeoutMs: 5000, signal: new AbortController().signal },
      );
    expect(
      await run(respond(400, { error: { code: 'moderation_blocked', message: 'blocked' } })),
    ).toMatchObject({
      status: 'failed',
      kind: 'moderation_blocked',
      retryable: false,
    });
    expect(await run(respond(500, { error: { message: 'oops' } }))).toMatchObject({
      status: 'failed',
      kind: 'provider_error',
      retryable: true,
    });
    expect(await run(respond(400, { error: { code: 'invalid_value' } }))).toMatchObject({
      status: 'failed',
      kind: 'invalid_request',
    });
    const hanging = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const timedOut = await createOpenAiImageEditor({
      apiKey: 'sk-test-123456',
      model: 'm',
      fetch: hanging,
    }).edit(
      compiled,
      { image: png },
      { attemptId: 'a', timeoutMs: 20, signal: new AbortController().signal },
    );
    expect(timedOut).toMatchObject({ status: 'failed', kind: 'timeout' });
  });
});

describe('Gemini image editor adapter', () => {
  it('sends inline image data with an explicit size tier and maps safety blocks', async () => {
    let body: Record<string, unknown> | null = null;
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
        { status: 200 },
      );
    });
    const editor = createGeminiImageEditor({
      apiKey: 'gemini-key-123',
      model: 'gemini-nano-banana-2.1',
      fetch: fetchStub,
    });
    const outcome = await editor.edit(
      compiled,
      { image: jpeg },
      { attemptId: 'a', timeoutMs: 5000, signal: new AbortController().signal },
    );
    expect(outcome).toMatchObject({ status: 'failed', kind: 'moderation_blocked' });
    expect(JSON.stringify(body)).toContain('"imageSize":"1K"');
    expect(JSON.stringify(body)).toContain('"aspectRatio":"1:1"');
  });
});

describe('Gemini replies without an image', () => {
  const editOptions = () => ({
    attemptId: 'attempt-9',
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });
  const reply = (candidate: Record<string, unknown>) =>
    respondJson(200, {
      candidates: [candidate],
      usageMetadata: { promptTokenCount: 1531, candidatesTokenCount: 41, totalTokenCount: 1572 },
      modelVersion: 'gemini-nano-banana-2.1',
    });

  it('keeps the text part of a text-only reply, redacted and capped, as a no_image answer', async () => {
    const { logger, warn } = capturingLogger();
    const text = `I can't edit this image as requested. key=gemini-key-123 ${'More detail. '.repeat(80)}`;
    const outcome = await createGeminiImageEditor({
      apiKey: 'gemini-key-123',
      model: 'gemini-nano-banana-2.1',
      fetch: reply({ finishReason: 'STOP', content: { parts: [{ text }], role: 'model' } }),
      logger,
    }).edit(compiled, { image: jpeg }, editOptions());
    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'provider_error',
      providerCode: 'no_image',
      httpStatus: 200,
      retryable: false,
    });
    const message = (outcome as { providerMessage?: string }).providerMessage ?? '';
    expect(message.startsWith("finishReason STOP: I can't edit this image as requested.")).toBe(
      true,
    );
    expect(message).not.toContain('gemini-key-123');
    expect(message.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('gemini-key-123');
  });

  it('answers image-specific finish reasons as no_image and safety reasons as moderation', async () => {
    const run = (finishReason: string) =>
      createGeminiImageEditor({
        apiKey: 'gemini-key-123',
        model: 'gemini-nano-banana-2.1',
        fetch: reply({ finishReason, content: { parts: [] } }),
      }).edit(compiled, { image: jpeg }, editOptions());
    for (const reason of ['NO_IMAGE', 'IMAGE_OTHER', 'IMAGE_RECITATION']) {
      expect(geminiFinishClass(reason)).toBe('no_image');
      expect(await run(reason)).toMatchObject({
        kind: 'provider_error',
        providerCode: 'no_image',
        providerMessage: `finishReason ${reason}`,
      });
    }
    for (const reason of ['IMAGE_SAFETY', 'SAFETY', 'IMAGE_PROHIBITED_CONTENT']) {
      expect(geminiFinishClass(reason)).toBe('moderation');
      expect(await run(reason)).toMatchObject({
        kind: 'moderation_blocked',
        providerCode: reason,
      });
    }
    expect(geminiFinishClass('STOP')).toBe('other');
  });

  it('records the thinking tokens apart, for settlement at the output price', async () => {
    const outcome = await createGeminiImageEditor({
      apiKey: 'gemini-key-123',
      model: 'gemini-nano-banana-2.1',
      fetch: respondJson(200, {
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1531,
          candidatesTokenCount: 1519,
          thoughtsTokenCount: 212,
        },
        modelVersion: 'gemini-nano-banana-2.1',
      }),
    }).edit(compiled, { image: jpeg }, editOptions());
    expect(outcome).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 1531, outputTokens: 1519, thoughtsTokens: 212, images: 1 },
    });
  });
});

describe('OpenAI usage', () => {
  it('records the text and image input split of input_tokens_details', async () => {
    const outcome = await createOpenAiImageEditor({
      apiKey: 'sk-test-123456',
      model: 'gpt-image-2.5-flare',
      fetch: respondJson(200, {
        data: [{ b64_json: jpeg.toString('base64') }],
        usage: {
          input_tokens: 1964,
          output_tokens: 343,
          input_tokens_details: { text_tokens: 428, image_tokens: 1536 },
        },
      }),
    }).edit(
      compiled,
      { image: png },
      { attemptId: 'a', timeoutMs: 5000, signal: new AbortController().signal },
    );
    expect(outcome).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 1964, outputTokens: 343, inputTextTokens: 428, inputImageTokens: 1536 },
    });
  });
});

describe('OpenAI request parameters and mask', () => {
  it('never sends input_fidelity, even when a compiled request carries it', async () => {
    const form = await buildOpenAiEditForm(
      { ...compiled, parameters: { ...compiled.parameters, input_fidelity: 'high' } },
      { image: png },
      'gpt-image-2.5-flare',
    );
    expect(form.has('input_fidelity')).toBe(false);
    expect(form.get('model')).toBe('gpt-image-2.5-flare');
    expect(form.get('quality')).toBe('high');
  });

  it('defaults the quality to medium when the compiled request has none', async () => {
    const form = await buildOpenAiEditForm(
      { ...compiled, parameters: { size: '1024x1024' } },
      { image: png },
      'm',
    );
    expect(form.get('quality')).toBe('medium');
  });

  it('converts the pipeline mask to RGBA with alpha = 255 - value', async () => {
    const rgba = await toOpenAiMask(await pipelineMask());
    const { data, info } = await sharp(rgba).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    expect((await sharp(rgba).metadata()).hasAlpha).toBe(true);
    const pixel = (x: number, y: number) => [
      ...data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 4),
    ];
    // Editable (255) becomes fully transparent; protected (0) becomes opaque black.
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(3, 5)).toEqual([0, 0, 0, 0]);
    expect(pixel(4, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(6, 6)).toEqual([0, 0, 0, 255]);
    expect(pixel(7, 7)).toEqual([0, 0, 0, 127]);
  });

  it('uploads the RGBA mask only when the compiled request carries a mask', async () => {
    const mask = await pipelineMask();
    const withMask = await buildOpenAiEditForm(compiledWithMask, { image: png, mask }, 'm');
    const uploaded = Buffer.from(await (withMask.get('mask') as Blob).arrayBuffer());
    expect(uploaded.equals(await toOpenAiMask(mask))).toBe(true);
    expect((await sharp(uploaded).metadata()).channels).toBe(4);
    // Mask policy `none`: the compiled request has no mask, so none is uploaded.
    const withoutMask = await buildOpenAiEditForm(compiled, { image: png, mask }, 'm');
    expect(withoutMask.has('mask')).toBe(false);
  });
});

describe('provider error diagnostics', () => {
  const editOptions = () => ({
    attemptId: 'att-1',
    timeoutMs: 5000,
    signal: new AbortController().signal,
  });

  it('keeps the OpenAI message, parameter and code of a rejected request and logs them', async () => {
    const { logger, warn } = capturingLogger();
    const editor = createOpenAiImageEditor({
      apiKey: 'sk-test-abcdef123456',
      model: 'gpt-image-2.5-sunburst',
      fetch: respondJson(400, {
        error: {
          message:
            "Invalid value: 'input_fidelity' is not supported for model gpt-image-2.5-sunburst (key sk-test-abcdef123456).",
          type: 'invalid_request_error',
          param: 'input_fidelity',
          code: 'invalid_input_fidelity_model',
        },
      }),
      logger,
    });
    const outcome = await editor.edit(compiled, { image: png }, editOptions());
    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'invalid_request',
      providerCode: 'invalid_input_fidelity_model',
      providerParam: 'input_fidelity',
      httpStatus: 400,
      retryable: false,
    });
    const message = outcome.status === 'failed' ? (outcome.providerMessage ?? '') : '';
    expect(message).toContain("'input_fidelity' is not supported");
    expect(message).not.toContain('sk-test-abcdef123456');
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields] = warn.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({
      provider: 'openai',
      httpStatus: 400,
      providerCode: 'invalid_input_fidelity_model',
      providerParam: 'input_fidelity',
      operationId: 'openai:att-1',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-test-abcdef123456');
  });

  it('keeps the OpenAI mask format error', async () => {
    const outcome = await createOpenAiImageEditor({
      apiKey: 'sk-test-abcdef123456',
      model: 'm',
      fetch: respondJson(400, {
        error: {
          message: 'Invalid mask image format - mask image should be in RGBA format.',
          type: 'invalid_request_error',
          param: 'mask',
          code: 'invalid_mask_image_format',
        },
      }),
    }).edit(compiled, { image: png }, editOptions());
    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'invalid_request',
      providerCode: 'invalid_mask_image_format',
      providerParam: 'mask',
      providerMessage: 'Invalid mask image format - mask image should be in RGBA format.',
    });
  });

  it('returns a failed outcome for a non-JSON error page instead of throwing', async () => {
    const outcome = await createOpenAiImageEditor({
      apiKey: 'sk-test-abcdef123456',
      model: 'm',
      fetch: respondJson(502, '<html><body>502 Bad Gateway</body></html>'),
    }).edit(compiled, { image: png }, editOptions());
    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'provider_error',
      retryable: true,
      httpStatus: 502,
    });
    expect(outcome.status === 'failed' && outcome.providerMessage).toContain('502 Bad Gateway');
  });

  it('keeps the Gemini thinking-level rejection and logs it', async () => {
    const { logger, warn } = capturingLogger();
    const outcome = await createGeminiImageEditor({
      apiKey: 'gemini-key-123456',
      model: 'gemini-nano-banana-2.1',
      fetch: respondJson(400, {
        error: {
          code: 400,
          message: 'Thinking level LOW is not supported for this model.',
          status: 'INVALID_ARGUMENT',
        },
      }),
      logger,
    }).edit(
      { ...compiled, provider: 'gemini', parameters: { thinking_level: 'low' } },
      { image: jpeg },
      editOptions(),
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      kind: 'invalid_request',
      providerCode: 'INVALID_ARGUMENT',
      providerMessage: 'Thinking level LOW is not supported for this model.',
      providerParam: 'generationConfig.thinkingConfig.thinkingLevel',
      httpStatus: 400,
      retryable: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      provider: 'gemini',
      providerCode: 'INVALID_ARGUMENT',
    });
  });

  it('sends the compiled Gemini thinking level and size', () => {
    const body = buildGeminiEditBody(
      {
        ...compiled,
        provider: 'gemini',
        parameters: { image_size: '2K', aspect_ratio: '1:1', thinking_level: 'minimal' },
      },
      { image: jpeg },
    );
    expect(body.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '1:1', imageSize: '2K' },
      thinkingConfig: { thinkingLevel: 'minimal' },
    });
  });

  it('keeps the Anthropic error type and message on the provider error and logs them', async () => {
    const { logger, warn } = capturingLogger();
    const client: AnthropicMessagesClient = {
      beta: {
        messages: {
          parse: vi.fn(async () => {
            throw Object.assign(new Error('400 invalid_request_error'), {
              name: 'BadRequestError',
              status: 400,
              error: {
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: 'output_config.effort: unsupported value',
                },
              },
            });
          }),
        },
      },
    };
    const vision = createAnthropicVisionModel({
      apiKey: 'sk-ant-test-123456',
      model: 'claude-opus-5-5',
      client,
      logger,
    });
    const error = await vision.analyzeScene(analyzeInput).catch((caught: unknown) => caught);
    expect(isProviderError(error)).toBe(true);
    expect(isProviderError(error) && error.kind).toBe('invalid_request');
    expect(isProviderError(error) && error.providerCode).toBe('invalid_request_error');
    expect(isProviderError(error) && error.providerMessage).toBe(
      'output_config.effort: unsupported value',
    );
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      provider: 'anthropic',
      httpStatus: 400,
      providerCode: 'invalid_request_error',
    });
  });
});

describe('Google address diagnostics', () => {
  it('keeps the Geocoding status and message and the Places error details', async () => {
    const { logger, warn } = capturingLogger();
    const denied = createGoogleAddressProvider({
      serverKey: 'AIzaSyTestServerKey1234567890',
      sessionSecret: 'session-secret-for-tests-0123456789',
      fetch: respondJson(200, {
        status: 'REQUEST_DENIED',
        error_message: 'The provided API key is invalid. AIzaSyTestServerKey1234567890',
      }),
      logger,
    });
    const error = await denied.geocodeByPlaceId('place-1').catch((caught: unknown) => caught);
    expect(isProviderError(error) && error.providerCode).toBe('REQUEST_DENIED');
    expect(isProviderError(error) && error.providerMessage).toContain(
      'The provided API key is invalid',
    );
    expect(isProviderError(error) && error.providerMessage).not.toContain('AIzaSy');
    expect(warn).toHaveBeenCalledTimes(1);

    const rejected = createGoogleAddressProvider({
      serverKey: 'AIzaSyTestServerKey1234567890',
      sessionSecret: 'session-secret-for-tests-0123456789',
      fetch: respondJson(400, {
        error: {
          code: 400,
          message: 'Invalid field mask.',
          status: 'INVALID_ARGUMENT',
          details: [{ fieldViolations: [{ field: 'X-Goog-FieldMask' }] }],
        },
      }),
    });
    const placesError = await rejected
      .resolve({ placeId: 'place-1', sessionToken: 'token-1' })
      .catch((caught: unknown) => caught);
    expect(isProviderError(placesError) && placesError.kind).toBe('invalid_request');
    expect(isProviderError(placesError) && placesError.providerCode).toBe('INVALID_ARGUMENT');
    expect(isProviderError(placesError) && placesError.providerParam).toBe('X-Goog-FieldMask');
    expect(isProviderError(placesError) && placesError.providerMessage).toBe('Invalid field mask.');
  });
});

describe('Google address suggestions', () => {
  const KEY = 'AIzaSyTestServerKey1234567890';
  const PREDICTIONS = {
    suggestions: [
      {
        placePrediction: {
          placeId: 'place-1',
          structuredFormat: {
            mainText: { text: '560 Millpond Rd' },
            secondaryText: { text: 'Kettle Fork, GA, USA' },
          },
        },
      },
    ],
  };
  const REJECTED = {
    error: {
      code: 400,
      message: `Invalid value at 'included_primary_types' (${KEY})`,
      status: 'INVALID_ARGUMENT',
    },
  };

  /** A fetch that answers each request with the next status (the last one repeats). */
  function answering(statuses: number[]) {
    const bodies: Record<string, unknown>[] = [];
    let index = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const status = statuses[Math.min(index, statuses.length - 1)] as number;
      index += 1;
      const body = status === 200 ? PREDICTIONS : status === 400 ? REJECTED : { error: {} };
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { fetchImpl, bodies };
  }

  const providerWith = (fetchImpl: ReturnType<typeof answering>['fetchImpl'], logger?: Logger) =>
    createGoogleAddressProvider({
      serverKey: KEY,
      sessionSecret: 'session-secret-for-tests-0123456789',
      fetch: fetchImpl,
      ...(logger ? { logger } : {}),
    });

  it('sends the address types with every request', async () => {
    const { fetchImpl, bodies } = answering([200]);
    const result = await providerWith(fetchImpl).suggest({
      query: '560 Millpond',
      sessionToken: 'token-1',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0]).toEqual({
      input: '560 Millpond',
      sessionToken: 'token-1',
      includedRegionCodes: ['us'],
      includedPrimaryTypes: ['street_address', 'premise', 'subpremise'],
    });
    expect((bodies[0]?.includedPrimaryTypes as string[]).length).toBeLessThanOrEqual(5);
    expect(result).toMatchObject({
      called: true,
      suggestions: [{ placeId: 'place-1', primaryText: '560 Millpond Rd' }],
    });
  });

  it('asks again without the types when Google rejects them, and says so once', async () => {
    const { logger, warn } = capturingLogger();
    const { fetchImpl, bodies } = answering([400, 200, 400, 200]);
    const provider = providerWith(fetchImpl, logger);
    const first = await provider.suggest({ query: '560 Millpond', sessionToken: 'token-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies[1]).toEqual({
      input: '560 Millpond',
      sessionToken: 'token-1',
      includedRegionCodes: ['us'],
    });
    expect(first).toMatchObject({ called: true, sessionToken: 'token-1' });
    expect(first.suggestions.map((suggestion) => suggestion.placeId)).toEqual(['place-1']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      operation: 'Autocomplete type restriction',
      httpStatus: 400,
      failureKind: 'invalid_request',
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);

    const second = await provider.suggest({ query: '560 Millpond', sessionToken: 'token-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(bodies[2]?.includedPrimaryTypes).toBeDefined();
    expect(bodies[3]?.includedPrimaryTypes).toBeUndefined();
    expect(second.suggestions).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fails as before when the unrestricted request is rejected too, or on another status', async () => {
    const twice = answering([400, 400]);
    const rejected = await providerWith(twice.fetchImpl)
      .suggest({ query: '560 Millpond', sessionToken: 'token-1' })
      .catch((caught: unknown) => caught);
    expect(isProviderError(rejected) && rejected.kind).toBe('invalid_request');
    expect(twice.fetchImpl).toHaveBeenCalledTimes(2);

    for (const status of [429, 500]) {
      const once = answering([status, 200]);
      const failed = await providerWith(once.fetchImpl)
        .suggest({ query: '560 Millpond', sessionToken: 'token-1' })
        .catch((caught: unknown) => caught);
      expect(isProviderError(failed)).toBe(true);
      expect(once.fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
