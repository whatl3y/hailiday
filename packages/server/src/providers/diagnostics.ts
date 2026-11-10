import type { Logger } from '../logger/index.js';
import type { EditOutcome } from './types.js';

/** What a vendor said about a failed call, with anything key-like removed. */
export interface ProviderDiagnostics {
  /** The vendor's machine-readable code (`invalid_input_fidelity_model`, `INVALID_ARGUMENT`). */
  code?: string;
  /** The vendor's message, redacted and truncated. */
  message?: string;
  /** The request parameter the vendor named as the cause, when it named one. */
  param?: string;
  /** The vendor's error class when it differs from the code (OpenAI `type`). */
  type?: string;
}

/** Longest vendor message kept on an outcome or a log line. */
export const MAX_PROVIDER_MESSAGE_LENGTH = 500;

const REDACTED = '[redacted]';

/**
 * Patterns that look like credentials or opaque tokens: OpenAI and Anthropic style keys (also
 * partially masked ones such as `sk-proj-****abcd`), Google API keys, bearer tokens, credential
 * query parameters and any long unbroken run of key alphabet characters.
 */
const KEY_LIKE_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9*_-]{4,}/g,
  /\bAIza[0-9A-Za-z_-]{8,}/g,
  /\bBearer\s+\S+/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];
const CREDENTIAL_PARAM =
  /([?&](?:key|api_key|apikey|signature|sig|token|access_token)=)[^&\s"']+/gi;

/**
 * Removes credentials from vendor text: every configured secret verbatim, then anything key-like.
 * Whitespace is collapsed and the result is truncated to `MAX_PROVIDER_MESSAGE_LENGTH`.
 */
export function redactProviderText(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 6) result = result.split(secret).join(REDACTED);
  }
  result = result.replace(CREDENTIAL_PARAM, `$1${REDACTED}`);
  for (const pattern of KEY_LIKE_PATTERNS) result = result.replace(pattern, REDACTED);
  result = result.replace(/\s+/g, ' ').trim();
  return result.length > MAX_PROVIDER_MESSAGE_LENGTH
    ? `${result.slice(0, MAX_PROVIDER_MESSAGE_LENGTH - 1)}…`
    : result;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A body that is not JSON (an HTML error page, plain text) keeps a redacted excerpt. */
function plainTextMessage(bytes: Uint8Array, secrets: readonly string[]): string | undefined {
  const raw = Buffer.from(bytes.subarray(0, 4096)).toString('utf8');
  const stripped = raw.replace(/<[^>]*>/g, ' ');
  return text(stripped) ? redactProviderText(stripped, secrets) : undefined;
}

function compact(diagnostics: ProviderDiagnostics): ProviderDiagnostics {
  return Object.fromEntries(
    Object.entries(diagnostics).filter(([, value]) => value !== undefined && value !== ''),
  ) as ProviderDiagnostics;
}

/**
 * Reads an OpenAI error body: `{ "error": { "message", "type", "param", "code" } }`. The code is
 * `code`, else `type`.
 */
export function openAiErrorDiagnostics(
  bytes: Uint8Array,
  secrets: readonly string[] = [],
): ProviderDiagnostics {
  const body = record(parseJson(bytes));
  if (!body) return compact({ message: plainTextMessage(bytes, secrets) });
  const error = record(body.error);
  const message = text(error?.message);
  return compact({
    code: text(error?.code) ?? text(error?.type),
    message: message ? redactProviderText(message, secrets) : undefined,
    param: text(error?.param),
    type: text(error?.type),
  });
}

/** Request fields a Google message names in prose, mapped to the body field they refer to. */
const GEMINI_MESSAGE_PARAMS: readonly [RegExp, string][] = [
  [/thinking[\s_]*level/i, 'generationConfig.thinkingConfig.thinkingLevel'],
  [/thinking[\s_]*(budget|config)/i, 'generationConfig.thinkingConfig'],
  [/image[\s_]*size/i, 'generationConfig.imageConfig.imageSize'],
  [/aspect[\s_]*ratio/i, 'generationConfig.imageConfig.aspectRatio'],
  [/response[\s_]*modalit/i, 'generationConfig.responseModalities'],
];

/**
 * Reads a Google API error body: `{ "error": { "code", "message", "status", "details" } }` (the
 * parameter comes from a `BadRequest` field violation, an "Unknown name" message or a known field
 * named in the message), or a legacy Maps body `{ "status", "error_message" }`.
 */
export function googleErrorDiagnostics(
  bytes: Uint8Array,
  secrets: readonly string[] = [],
): ProviderDiagnostics {
  const body = record(parseJson(bytes));
  if (!body) return compact({ message: plainTextMessage(bytes, secrets) });
  const error = record(body.error);
  if (!error) {
    const legacy = text(body.error_message);
    return compact({
      code: text(body.status),
      message: legacy ? redactProviderText(legacy, secrets) : undefined,
    });
  }
  const message = text(error.message);
  let param: string | undefined;
  for (const detail of Array.isArray(error.details) ? error.details : []) {
    const violations = record(detail)?.fieldViolations;
    for (const violation of Array.isArray(violations) ? violations : []) {
      param ??= text(record(violation)?.field);
    }
  }
  if (!param && message) {
    param = /Unknown name "([^"]+)"/.exec(message)?.[1];
  }
  if (!param && message) {
    param = GEMINI_MESSAGE_PARAMS.find(([pattern]) => pattern.test(message))?.[1];
  }
  return compact({
    code: text(error.status) ?? (typeof error.code === 'number' ? String(error.code) : undefined),
    message: message ? redactProviderText(message, secrets) : undefined,
    param,
  });
}

/**
 * Reads an Anthropic SDK error: `status`, the parsed body `{ "error": { "type", "message" } }` on
 * `error`, and the request ID. Never reads headers.
 */
export function anthropicErrorDiagnostics(
  error: unknown,
  secrets: readonly string[] = [],
): ProviderDiagnostics {
  const value = record(error);
  const body = record(value?.error);
  const inner = record(body?.error);
  const message = text(inner?.message) ?? text(value?.message);
  return compact({
    code: text(inner?.type) ?? text(body?.type),
    message: message ? redactProviderText(message, secrets) : undefined,
  });
}

/** Fields of a failed outcome or error that carry the diagnostics. */
export function diagnosticFields(diagnostics: ProviderDiagnostics): {
  providerCode?: string;
  providerMessage?: string;
  providerParam?: string;
} {
  return {
    ...(diagnostics.code ? { providerCode: diagnostics.code } : {}),
    ...(diagnostics.message ? { providerMessage: diagnostics.message } : {}),
    ...(diagnostics.param ? { providerParam: diagnostics.param } : {}),
  };
}

/**
 * Logs a failed vendor call at warn level: provider, HTTP status, code, parameter and the redacted
 * message. The logger also scrubs configured secrets and sensitive field names.
 */
export function logProviderFailure(
  logger: Logger | undefined,
  context: {
    provider: string;
    operation: string;
    httpStatus?: number | null;
    kind?: string;
    operationId?: string;
  },
  diagnostics: ProviderDiagnostics,
): void {
  if (!logger) return;
  logger.warn(
    {
      provider: context.provider,
      operation: context.operation,
      ...(context.httpStatus !== undefined && context.httpStatus !== null
        ? { httpStatus: context.httpStatus }
        : {}),
      ...(context.kind ? { failureKind: context.kind } : {}),
      ...(context.operationId ? { operationId: context.operationId } : {}),
      ...diagnosticFields(diagnostics),
    },
    'provider call failed',
  );
}

/** Logs a failed image edit through `logProviderFailure` and returns the outcome unchanged. */
export function reportFailedEdit<T extends Extract<EditOutcome, { status: 'failed' }>>(
  logger: Logger | undefined,
  provider: string,
  outcome: T,
): T {
  logProviderFailure(
    logger,
    {
      provider,
      operation: 'image_edit',
      ...(outcome.httpStatus !== undefined ? { httpStatus: outcome.httpStatus } : {}),
      kind: outcome.kind,
      ...(outcome.operationId ? { operationId: outcome.operationId } : {}),
    },
    {
      ...(outcome.providerCode ? { code: outcome.providerCode } : {}),
      ...(outcome.providerMessage ? { message: outcome.providerMessage } : {}),
      ...(outcome.providerParam ? { param: outcome.providerParam } : {}),
    },
  );
  return outcome;
}
