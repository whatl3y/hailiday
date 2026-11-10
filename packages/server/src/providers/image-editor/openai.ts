import sharp from 'sharp';
import type { CompiledRequest } from '@holiday/core';
import type { Logger } from '../../logger/index.js';
import {
  diagnosticFields,
  openAiErrorDiagnostics,
  redactProviderText,
  reportFailedEdit,
} from '../diagnostics.js';
import { ProviderError, kindForHttpStatus } from '../errors.js';
import { providerFetch, type FetchLike } from '../http.js';
import { imageMediaType } from '../vision/records.js';
import type { EditInput, EditOptions, EditOutcome, ImageEditor } from '../types.js';
import { requestedSize } from './fixture.js';

const PROVIDER = 'openai';
export const OPENAI_EDITS_URL = 'https://api.openai.com/v1/images/edits';

/**
 * Converts a pipeline mask (an image whose first channel is 255 where the edit may change pixels
 * and 0 where it may not) to the RGBA PNG OpenAI requires, whose fully transparent pixels mark
 * the editable area: black, with alpha = 255 − value.
 */
export async function toOpenAiMask(mask: Uint8Array): Promise<Buffer> {
  const { data, info } = await sharp(Buffer.from(mask))
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i += 1) {
    rgba[i * 4 + 3] = 255 - (data[i * info.channels] as number);
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Builds the multipart body of `POST /v1/images/edits` from a compiled request. `input_fidelity`
 * is never sent (the GPT image 2.5 models reject it). The mask is sent only when the compiled
 * request carries one (the provider mask policy), converted to RGBA.
 */
export async function buildOpenAiEditForm(
  request: CompiledRequest,
  input: EditInput,
  model: string,
): Promise<FormData> {
  const form = new FormData();
  const size = requestedSize(request);
  form.set('model', model);
  form.set('prompt', request.instructionText);
  form.set('n', '1');
  if (size) form.set('size', `${size.width}x${size.height}`);
  form.set('quality', String(request.parameters.quality ?? 'medium'));
  form.set('output_format', String(request.parameters.output_format ?? 'jpeg'));
  const type = imageMediaType(input.image);
  form.set(
    'image',
    new Blob([Buffer.from(input.image)], { type }),
    type === 'image/png' ? 'image.png' : 'image.jpg',
  );
  if (input.mask && request.mask) {
    form.set(
      'mask',
      new Blob([Buffer.from(await toOpenAiMask(input.mask))], { type: 'image/png' }),
      'mask.png',
    );
  }
  return form;
}

const tokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The text and image input tokens of `usage.input_tokens_details`, when both are reported. */
function inputSplit(details: { text_tokens?: unknown; image_tokens?: unknown } | undefined): {
  inputTextTokens?: number;
  inputImageTokens?: number;
} {
  if (!details || !tokenCount(details.text_tokens) || !tokenCount(details.image_tokens)) return {};
  return { inputTextTokens: details.text_tokens, inputImageTokens: details.image_tokens };
}

/**
 * Live OpenAI image editor (`POST /v1/images/edits`, synchronous, base64 output). The operation
 * ID is derived from the attempt ID and reported before the request is awaited; there is no
 * status API, so `getOperation` cannot recover a lost result.
 */
export function createOpenAiImageEditor(options: {
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
      supportsMask: true,
      supportsMarkup: false,
      maxReferenceImages: 0,
      supportedOutputSizes: [
        { width: 1024, height: 1024 },
        { width: 1536, height: 1024 },
        { width: 1024, height: 1536 },
      ],
      asyncOperations: false,
      supportsIdempotencyKey: false,
      supportsCancel: false,
      qualityLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
    },

    async edit(
      request: CompiledRequest,
      input: EditInput,
      editOptions: EditOptions,
    ): Promise<EditOutcome> {
      const operationId = `openai:${editOptions.attemptId}`;
      await editOptions.onOperation?.(operationId);
      let form: FormData;
      try {
        form = await buildOpenAiEditForm(request, input, options.model);
      } catch (error) {
        return fail({
          status: 'failed',
          operationId,
          kind: 'invalid_request',
          providerCode: 'request_build_failed',
          ...(error instanceof Error
            ? { providerMessage: redactProviderText(error.message, secrets) }
            : {}),
          retryable: false,
        });
      }
      let response;
      try {
        response = await providerFetch(
          fetchImpl,
          OPENAI_EDITS_URL,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${options.apiKey}` },
            body: form,
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
        const diagnostics = openAiErrorDiagnostics(response.bytes, secrets);
        const fields = diagnosticFields(diagnostics);
        if (
          diagnostics.code === 'moderation_blocked' ||
          (diagnostics.type === 'image_generation_user_error' &&
            /safety|moderation/i.test(diagnostics.message ?? ''))
        ) {
          return fail({
            status: 'failed',
            operationId,
            kind: 'moderation_blocked',
            ...fields,
            providerCode: diagnostics.code ?? 'moderation_blocked',
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
        data?: { b64_json?: string }[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { text_tokens?: number; image_tokens?: number };
        } & Record<string, unknown>;
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
      const b64 = body.data?.[0]?.b64_json;
      if (!b64)
        return fail({
          status: 'failed',
          operationId,
          kind: 'provider_error',
          providerCode: 'no_image',
          httpStatus: response.status,
          retryable: false,
        });
      const image = Buffer.from(b64, 'base64');
      const meta = await sharp(image).metadata();
      const format = meta.format === 'png' ? 'png' : meta.format === 'webp' ? 'webp' : 'jpeg';
      return {
        status: 'completed',
        operationId,
        image,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        format,
        usage: {
          ...(body.usage?.input_tokens !== undefined
            ? { inputTokens: body.usage.input_tokens }
            : {}),
          ...(body.usage?.output_tokens !== undefined
            ? { outputTokens: body.usage.output_tokens }
            : {}),
          ...inputSplit(body.usage?.input_tokens_details),
          images: 1,
          raw: { ...(body.usage ?? {}), requestId: response.headers.get('x-request-id') },
        },
        modelSnapshot: options.model,
        provenance: { watermark: 'unknown' },
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
