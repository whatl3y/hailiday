import sharp from 'sharp';
import type { CompiledRequest } from '@holiday/core';
import type { Logger } from '../../logger/index.js';
import {
  diagnosticFields,
  googleErrorDiagnostics,
  redactProviderText,
  reportFailedEdit,
} from '../diagnostics.js';
import { ProviderError, kindForHttpStatus } from '../errors.js';
import { providerFetch, type FetchLike } from '../http.js';
import { imageMediaType } from '../vision/records.js';
import type { EditInput, EditOptions, EditOutcome, ImageEditor } from '../types.js';
import { requestedSize } from './fixture.js';

const PROVIDER = 'gemini';
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const SAFETY_FINISH_REASONS = [
  'SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_SAFETY',
  'BLOCKLIST',
  'SPII',
  'IMAGE_PROHIBITED_CONTENT',
];
/**
 * Finish reasons of a reply that ended without an image for a reason other than safety (the
 * model answered in text, or stopped the image for a non-safety cause). Such a reply bills no
 * image and is answered as `no_image`, which the render job re-sends once.
 */
const NO_IMAGE_FINISH_REASONS = ['NO_IMAGE', 'IMAGE_OTHER', 'IMAGE_RECITATION', 'RECITATION'];

/** How a Gemini finish reason classifies a reply: refused for safety, or ended without an image. */
export function geminiFinishClass(
  finishReason: string | undefined,
): 'moderation' | 'no_image' | 'other' {
  if (!finishReason) return 'other';
  if (SAFETY_FINISH_REASONS.includes(finishReason)) return 'moderation';
  if (NO_IMAGE_FINISH_REASONS.includes(finishReason)) return 'no_image';
  return 'other';
}

function aspectRatio(width: number, height: number): string {
  const ratio = width / height;
  if (Math.abs(ratio - 1.5) < 0.05) return '3:2';
  if (Math.abs(ratio - 2 / 3) < 0.05) return '2:3';
  return '1:1';
}

/**
 * Builds a `generateContent` image-edit request: the instruction text and the source image as
 * inline data, image-only output, an explicit aspect ratio and size tier, and the thinking level
 * when the compiled parameters carry one (the image models accept `minimal`, `medium` and
 * `high`, and reject `low`).
 */
export function buildGeminiEditBody(
  request: CompiledRequest,
  input: EditInput,
): Record<string, unknown> {
  const size = requestedSize(request) ?? { width: 1024, height: 1024 };
  const thinking = request.parameters.thinking_level;
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: request.instructionText },
          {
            inline_data: {
              mime_type: imageMediaType(input.image),
              data: Buffer.from(input.image).toString('base64'),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        aspectRatio: String(
          request.parameters.aspect_ratio ?? aspectRatio(size.width, size.height),
        ),
        imageSize: String(request.parameters.image_size ?? '1K'),
      },
      ...(thinking !== undefined ? { thinkingConfig: { thinkingLevel: String(thinking) } } : {}),
    },
  };
}

/** Live Gemini image editor (`generateContent`); no mask parameter exists, so none is sent. */
export function createGeminiImageEditor(options: {
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  /** Receives a warn line with the redacted vendor diagnostics of every failed call. */
  logger?: Logger;
}): ImageEditor {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const secrets = [options.apiKey];
  const fail = (outcome: Extract<EditOutcome, { status: 'failed' }>): EditOutcome =>
    reportFailedEdit(options.logger, PROVIDER, outcome);
  return {
    providerId: PROVIDER,
    mode: 'live',
    capabilities: {
      supportsMask: false,
      supportsMarkup: false,
      maxReferenceImages: 10,
      supportedOutputSizes: [{ width: 1024, height: 1024 }],
      asyncOperations: false,
      supportsIdempotencyKey: false,
      supportsCancel: false,
      thinkingLevels: ['minimal', 'medium', 'high'],
    },

    async edit(request, input, editOptions: EditOptions): Promise<EditOutcome> {
      const operationId = `gemini:${editOptions.attemptId}`;
      await editOptions.onOperation?.(operationId);
      let response;
      try {
        response = await providerFetch(
          fetchImpl,
          `${BASE}/${encodeURIComponent(options.model)}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey },
            body: JSON.stringify(buildGeminiEditBody(request, input)),
          },
          {
            provider: PROVIDER,
            timeoutMs: editOptions.timeoutMs,
            signal: editOptions.signal,
            maxBytes: 64 * 1024 * 1024,
          },
        );
      } catch (error) {
        const kind =
          error instanceof ProviderError && error.kind === 'timeout' ? 'timeout' : 'provider_error';
        return fail({
          status: 'failed',
          operationId,
          kind,
          ...(error instanceof Error
            ? { providerMessage: redactProviderText(error.message, secrets) }
            : {}),
          retryable: true,
        });
      }
      if (response.status !== 200) {
        const diagnostics = googleErrorDiagnostics(response.bytes, secrets);
        const fields = diagnosticFields(diagnostics);
        if (
          response.status === 400 &&
          /safety|prohibited_content/i.test(
            `${diagnostics.code ?? ''} ${diagnostics.message ?? ''}`,
          )
        ) {
          return fail({
            status: 'failed',
            operationId,
            kind: 'moderation_blocked',
            ...fields,
            providerCode: 'safety',
            providerCategories: [],
            httpStatus: response.status,
            retryable: false,
          });
        }
        const { kind, retryable } = kindForHttpStatus(response.status);
        return fail({
          status: 'failed',
          operationId,
          kind:
            kind === 'timeout'
              ? 'timeout'
              : kind === 'invalid_request'
                ? 'invalid_request'
                : 'provider_error',
          ...fields,
          httpStatus: response.status,
          retryable,
        });
      }
      let body: {
        candidates?: {
          finishReason?: string;
          content?: {
            parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[];
          };
        }[];
        promptFeedback?: { blockReason?: string };
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        } & Record<string, unknown>;
        modelVersion?: string;
      };
      try {
        body = response.json();
      } catch {
        return fail({
          status: 'failed',
          operationId,
          kind: 'provider_error',
          providerCode: 'invalid_json',
          httpStatus: response.status,
          retryable: false,
        });
      }
      const candidate = body.candidates?.[0];
      const blocked =
        body.promptFeedback?.blockReason ??
        (geminiFinishClass(candidate?.finishReason) === 'moderation'
          ? candidate?.finishReason
          : undefined);
      if (blocked) {
        return fail({
          status: 'failed',
          operationId,
          kind: 'moderation_blocked',
          providerCode: blocked,
          providerCategories: [blocked],
          retryable: false,
        });
      }
      const data = candidate?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData
        ?.data;
      if (!data) {
        // Answered without an image (a text-only reply, or NO_IMAGE / IMAGE_OTHER and similar):
        // the model's text is kept, redacted and capped, for the logs and the attempt record.
        const finishReason = candidate?.finishReason;
        const replyText = (candidate?.content?.parts ?? [])
          .map((part) => (typeof part.text === 'string' ? part.text : ''))
          .filter((part) => part.trim() !== '')
          .join(' ');
        const message = [finishReason ? `finishReason ${finishReason}` : null, replyText || null]
          .filter((part): part is string => part !== null)
          .join(': ');
        return fail({
          status: 'failed',
          operationId,
          kind: 'provider_error',
          providerCode: 'no_image',
          ...(message ? { providerMessage: redactProviderText(message, secrets) } : {}),
          httpStatus: response.status,
          retryable: false,
        });
      }
      const image = Buffer.from(data, 'base64');
      const meta = await sharp(image).metadata();
      return {
        status: 'completed',
        operationId,
        image,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        format: meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpeg',
        usage: {
          ...(body.usageMetadata?.promptTokenCount !== undefined
            ? { inputTokens: body.usageMetadata.promptTokenCount }
            : {}),
          ...(body.usageMetadata?.candidatesTokenCount !== undefined
            ? { outputTokens: body.usageMetadata.candidatesTokenCount }
            : {}),
          ...(typeof body.usageMetadata?.thoughtsTokenCount === 'number'
            ? { thoughtsTokens: body.usageMetadata.thoughtsTokenCount }
            : {}),
          images: 1,
          raw: { ...(body.usageMetadata ?? {}) },
        },
        modelSnapshot: body.modelVersion ?? options.model,
        provenance: { watermark: 'synthid' },
        providerMode: 'live',
      };
    },

    async getOperation(operationId) {
      return {
        status: 'failed',
        operationId,
        kind: 'provider_error',
        providerCode: 'no_status_api',
        retryable: false,
      };
    },
  };
}
