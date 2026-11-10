import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import {
  JudgeModelOutputSchema,
  SceneAnalysisModelOutputSchema,
  UploadTriageSchema,
} from '@holiday/core';
import type { z } from 'zod';
import type { Logger } from '../../logger/index.js';
import { anthropicErrorDiagnostics, diagnosticFields, logProviderFailure } from '../diagnostics.js';
import { ProviderError, kindForHttpStatus } from '../errors.js';
import { PROVIDER_HOSTS } from '../http.js';
import type { CallOptions, VisionCallResult, VisionModel, VisionUsage } from '../types.js';
import { modelJsonSchema } from './json-schema.js';
import {
  ANALYSIS_PROMPT_VERSION,
  ANALYSIS_SYSTEM_PROMPT,
  JUDGE_PROMPT_VERSION,
  LOCALIZE_PROMPT_VERSION,
  LOCALIZE_SYSTEM_PROMPT,
  TRIAGE_PROMPT_VERSION,
  TRIAGE_SYSTEM_PROMPT,
  analysisUserPrompt,
  judgeSystemPrompt,
  judgeUserPrompt,
  localizeUserPrompt,
} from './prompts.js';
import {
  LocalizeModelOutputSchema,
  clampBoxes,
  imageMediaType,
  toJudgeResult,
  toLocalizeResult,
  toSceneAnalysis,
} from './records.js';

const PROVIDER = 'anthropic';
/** Server-side refusal fallback beta for the scalar `fallbacks: 'default'` form. */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/**
 * The only API base the client uses. It is passed explicitly so the SDK never reads
 * `ANTHROPIC_BASE_URL` from the environment.
 */
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';

/** The `fetch` signature the Anthropic SDK accepts. */
export type SdkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * Adapts a provider `FetchLike` (URL string and init) to the SDK's transport signature. The SDK
 * calls its transport with a URL and an init; a `Request` input is passed on by URL with its
 * method, headers and body unless the init sets them.
 */
export function sdkFetchFrom(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
): SdkFetch {
  return (input, init) => {
    if (typeof input === 'string' || input instanceof URL)
      return fetchImpl(requestUrl(input), init);
    return fetchImpl(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      duplex: 'half',
      ...init,
    } as RequestInit);
  };
}

/**
 * The SDK's transport: HTTPS to an allowlisted provider host only, with redirects refused, so the
 * API key and the images it carries can never reach another host. A refused host fails before
 * any request with a non-retryable `invalid_request`.
 */
export function guardedAnthropicFetch(fetchImpl: SdkFetch = globalThis.fetch): SdkFetch {
  return (input, init) => {
    let url: URL;
    try {
      url = new URL(requestUrl(input));
    } catch {
      return Promise.reject(hostRefused());
    }
    if (url.protocol !== 'https:' || !PROVIDER_HOSTS.has(url.hostname)) {
      return Promise.reject(hostRefused());
    }
    return fetchImpl(input, { ...init, redirect: 'error' });
  };
}

function hostRefused(): ProviderError {
  return new ProviderError(PROVIDER, 'invalid_request', 'Host is not an allowed provider', {
    retryable: false,
  });
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** The part of a parsed beta message the adapter reads. */
export interface AnthropicParsedMessage {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  content: { type: string; text?: string }[];
  parsed_output: unknown;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
  };
}

/** The client surface the adapter uses (the SDK client satisfies it; tests stub it). */
export interface AnthropicMessagesClient {
  beta: {
    messages: {
      parse(
        params: Record<string, unknown>,
        options?: { signal?: AbortSignal; timeout?: number },
      ): Promise<AnthropicParsedMessage>;
    };
  };
}

/** A structured-output format whose `parse` never throws, so stop reasons stay readable. */
function outputFormat<T>(schema: z.ZodType<T>) {
  const base = jsonSchemaOutputFormat(modelJsonSchema(schema) as { type: 'object' });
  return {
    type: base.type,
    schema: base.schema,
    parse(content: string): ParseOutcome<T> {
      let json: unknown;
      try {
        json = JSON.parse(content);
      } catch (error) {
        return { ok: false, error: `Reply was not valid JSON: ${String(error)}` };
      }
      const parsed = schema.safeParse(clampBoxes(json));
      if (parsed.success) return { ok: true, value: parsed.data };
      return {
        ok: false,
        error: parsed.error.issues
          .slice(0, 8)
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; '),
      };
    },
  };
}

export interface VisionRequestInput {
  model: string;
  system: string;
  images: readonly Uint8Array[];
  text: string;
  format: ReturnType<typeof outputFormat>;
  effort: Effort;
  maxTokens: number;
  priorTurns?: Record<string, unknown>[];
}

/**
 * Builds a Messages request: images as base64 blocks, a cacheable system prompt, structured
 * output through `output_config.format`, an explicit effort, and server-side refusal fallbacks.
 * No sampling parameters, thinking budget or disabled-thinking setting are sent.
 */
export function buildVisionRequest(input: VisionRequestInput): Record<string, unknown> {
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          ...input.images.map((bytes) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: imageMediaType(bytes),
              data: Buffer.from(bytes).toString('base64'),
            },
          })),
          { type: 'text', text: input.text },
        ],
      },
      ...(input.priorTurns ?? []),
    ],
    output_config: { effort: input.effort, format: input.format },
    betas: [SERVER_SIDE_FALLBACK_BETA],
    fallbacks: 'default',
  };
}

function mapSdkError(error: unknown, secrets: readonly string[]): ProviderError {
  if (error instanceof ProviderError) return error;
  // The SDK wraps a transport failure (such as a refused host) as a connection error.
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof ProviderError) return cause;
  const name = (error as { name?: string } | null)?.name ?? '';
  const status = (error as { status?: unknown } | null)?.status;
  const diagnostics = diagnosticFields(anthropicErrorDiagnostics(error, secrets));
  if (name === 'APIConnectionTimeoutError') {
    return new ProviderError(PROVIDER, 'timeout', 'Vision request timed out', { cause: error });
  }
  if (name === 'APIUserAbortError') {
    return new ProviderError(PROVIDER, 'timeout', 'Vision request aborted', {
      retryable: false,
      cause: error,
    });
  }
  if (typeof status === 'number') {
    const { kind, retryable } = kindForHttpStatus(status);
    return new ProviderError(
      PROVIDER,
      kind === 'not_found' ? 'provider_error' : kind,
      'Vision request failed',
      {
        retryable,
        httpStatus: status,
        ...diagnostics,
        cause: error,
      },
    );
  }
  return new ProviderError(PROVIDER, 'provider_error', 'Vision request failed', {
    ...diagnostics,
    cause: error,
  });
}

export interface AnthropicVisionOptions {
  apiKey: string;
  model: string;
  client?: AnthropicMessagesClient;
  /** Transport under the host guard (tests inject a stub); defaults to the global `fetch`. */
  fetch?: SdkFetch;
  /** SDK retries of failed requests (default 2). */
  maxRetries?: number;
  maxTokens?: number;
  /** Re-asks after a schema failure (default 1). */
  reasks?: number;
  effort?: {
    triage?: Effort;
    analysis?: Effort;
    judge?: Effort;
    escalation?: Effort;
    localize?: Effort;
  };
  timeouts?: {
    triage?: number;
    analysis?: number;
    judge?: number;
    escalation?: number;
    localize?: number;
  };
  /** Receives a warn line with the redacted vendor diagnostics of every failed call. */
  logger?: Logger;
}

/**
 * Live vision model on Claude: upload triage, scene analysis, QA judging and localization of the
 * editor's additions. The SDK client is
 * pinned to the vendor's API host and sends every request through `guardedAnthropicFetch`.
 */
export function createAnthropicVisionModel(options: AnthropicVisionOptions): VisionModel {
  const client =
    options.client ??
    (new Anthropic({
      apiKey: options.apiKey,
      baseURL: ANTHROPIC_API_BASE_URL,
      fetch: guardedAnthropicFetch(options.fetch),
      maxRetries: options.maxRetries ?? 2,
    }) as unknown as AnthropicMessagesClient);
  const maxTokens = options.maxTokens ?? 16000;
  const reasks = options.reasks ?? 1;

  async function run<T>(
    schema: z.ZodType<T>,
    request: Omit<VisionRequestInput, 'format' | 'model' | 'maxTokens'>,
    timeoutMs: number,
    callOptions?: CallOptions,
  ): Promise<{ value: T; usage: VisionUsage; model: string; elapsedMs: number }> {
    const started = Date.now();
    const format = outputFormat(schema);
    const usage: VisionUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      calls: 0,
    };
    const priorTurns: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt <= reasks; attempt += 1) {
      const params = buildVisionRequest({
        ...request,
        model: options.model,
        maxTokens,
        format,
        priorTurns,
      });
      let response: AnthropicParsedMessage;
      try {
        response = await client.beta.messages.parse(params, {
          timeout: callOptions?.timeoutMs ?? timeoutMs,
          ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
        });
      } catch (error) {
        const mapped = mapSdkError(error, [options.apiKey]);
        logProviderFailure(
          options.logger,
          {
            provider: PROVIDER,
            operation: 'vision',
            httpStatus: mapped.httpStatus,
            kind: mapped.kind,
          },
          {
            ...(mapped.providerCode ? { code: mapped.providerCode } : {}),
            ...(mapped.providerMessage ? { message: mapped.providerMessage } : {}),
          },
        );
        throw mapped;
      }
      usage.calls += 1;
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadInputTokens =
        (usage.cacheReadInputTokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category;
        throw new ProviderError(
          PROVIDER,
          'moderation_blocked',
          'The vision model refused the request',
          {
            retryable: false,
            providerCode: 'refusal',
            providerCategories: category ? [category] : [],
          },
        );
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ProviderError(
          PROVIDER,
          'provider_error',
          'The vision reply was truncated at max_tokens',
          {
            retryable: false,
            providerCode: 'max_tokens',
          },
        );
      }
      const outcome = response.parsed_output as ParseOutcome<T> | null;
      if (outcome?.ok) {
        return {
          value: outcome.value,
          usage,
          model: response.model ?? options.model,
          elapsedMs: Date.now() - started,
        };
      }
      const replyText = response.content.find((block) => block.type === 'text')?.text ?? '';
      priorTurns.push(
        { role: 'assistant', content: [{ type: 'text', text: replyText }] },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `The reply did not match the required schema: ${outcome?.error ?? 'no structured output'}. Return a corrected reply.`,
            },
          ],
        },
      );
    }
    throw new ProviderError(
      PROVIDER,
      'schema_violation',
      'The vision reply did not match the schema',
      {
        retryable: false,
      },
    );
  }

  return {
    providerId: PROVIDER,
    mode: 'live',

    async classifyUpload(input, callOptions) {
      const result = await run(
        UploadTriageSchema,
        {
          system: TRIAGE_SYSTEM_PROMPT,
          images: [input.image.bytes],
          text: 'Triage this upload.',
          effort: options.effort?.triage ?? 'low',
        },
        options.timeouts?.triage ?? 20_000,
        callOptions,
      );
      return {
        result: result.value,
        usage: result.usage,
        model: result.model,
        promptVersion: TRIAGE_PROMPT_VERSION,
        elapsedMs: result.elapsedMs,
        providerMode: 'live',
      };
    },

    async analyzeScene(input, callOptions) {
      const result = await run(
        SceneAnalysisModelOutputSchema,
        {
          system: ANALYSIS_SYSTEM_PROMPT,
          images: [input.image.bytes],
          text: analysisUserPrompt({ sceneType: input.sceneType, sourceKind: input.sourceKind }),
          effort: options.effort?.analysis ?? 'medium',
        },
        options.timeouts?.analysis ?? 30_000,
        callOptions,
      );
      return {
        result: toSceneAnalysis(result.value, input, {
          analysisModel: result.model,
          analysisPromptVersion: ANALYSIS_PROMPT_VERSION,
          elapsedMs: result.elapsedMs,
        }),
        usage: result.usage,
        model: result.model,
        promptVersion: ANALYSIS_PROMPT_VERSION,
        elapsedMs: result.elapsedMs,
        providerMode: 'live',
      } satisfies VisionCallResult<ReturnType<typeof toSceneAnalysis>>;
    },

    async judge(input, callOptions) {
      const escalated = input.escalated ?? false;
      const mode = input.mode ?? 'decorate';
      const first = mode === 'relight' ? (input.base ?? input.original) : input.original;
      const result = await run(
        JudgeModelOutputSchema,
        {
          system: judgeSystemPrompt(mode),
          images: [first.bytes, input.candidate.bytes],
          text: judgeUserPrompt(input.plan, input.hints, { mode }),
          effort: escalated
            ? (options.effort?.escalation ?? 'high')
            : (options.effort?.judge ?? 'medium'),
        },
        escalated ? (options.timeouts?.escalation ?? 45_000) : (options.timeouts?.judge ?? 30_000),
        callOptions,
      );
      return {
        result: toJudgeResult(result.value, input, {
          judgeModel: result.model,
          judgePromptVersion: JUDGE_PROMPT_VERSION,
          elapsedMs: result.elapsedMs,
        }),
        usage: result.usage,
        model: result.model,
        promptVersion: JUDGE_PROMPT_VERSION,
        elapsedMs: result.elapsedMs,
        providerMode: 'live',
      };
    },

    async localizeAdditions(input, callOptions) {
      const result = await run(
        LocalizeModelOutputSchema,
        {
          system: LOCALIZE_SYSTEM_PROMPT,
          images: [input.original.bytes, input.candidate.bytes],
          text: localizeUserPrompt(input.placements),
          effort: options.effort?.localize ?? 'medium',
        },
        options.timeouts?.localize ?? 30_000,
        callOptions,
      );
      return {
        result: toLocalizeResult(result.value, input),
        usage: result.usage,
        model: result.model,
        promptVersion: LOCALIZE_PROMPT_VERSION,
        elapsedMs: result.elapsedMs,
        providerMode: 'live',
      };
    },
  };
}
