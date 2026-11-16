import {
  ERROR_CODES,
  ERROR_DETAILS_SCHEMAS,
  isErrorCode,
  type ErrorCode,
  type ErrorDetails,
} from '@hailiday/core';
import type { CopyKey } from '../copy';

export type ApiErrorKind = 'http' | 'network' | 'invalid_response' | 'aborted';

/** Where the interface presents an error, per the experience spec's allowance and limits rules. */
export type ErrorSurface =
  | 'allowance_sheet'
  | 'capacity_sheet'
  | 'budget_banner'
  | 'verification'
  | 'not_found_screen'
  | 'inline';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  status: number | null;
  code: ErrorCode | null;
  details: Record<string, unknown>;
  requestId: string | null;
  retryAfterSeconds: number | null;
  message?: string;
  /** The call failed while starting the session (`POST /v1/sessions` or its bot check). */
  session?: boolean;
}

/** A failed API call with its error code, copy key and parsed details. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: ErrorCode | null;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;
  /** Seconds from `Retry-After` (or `details.retryAfterSeconds`), when present. */
  readonly retryAfterSeconds: number | null;
  /** True when the session could not be started, so the action itself never reached the API. */
  readonly session: boolean;

  constructor(init: ApiErrorInit) {
    super(init.message ?? init.code ?? init.kind);
    this.name = 'ApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.session = init.session ?? false;
  }

  /**
   * The copy key the interface shows for this error. A session that could not start has its
   * own lines, so a person never reads it as a problem with what they typed or chose.
   */
  get copyKey(): CopyKey {
    if (this.session && this.code !== 'VERIFICATION_REQUIRED') {
      return this.code === 'RATE_LIMITED' ? 'session.limited' : 'session.failed';
    }
    if (this.code) return ERROR_CODES[this.code].copyKey;
    return this.kind === 'network' ? 'error.network' : 'error.unknown';
  }

  /** Whether the same request may succeed later without a change, per the error table. */
  get retryable(): boolean {
    if (this.session) return true;
    return this.code ? ERROR_CODES[this.code].retryable : this.kind === 'network';
  }

  is<C extends ErrorCode>(code: C): this is ApiError & { code: C } {
    return this.code === code;
  }

  /** Details validated against the code's schema; null when they do not match. */
  typedDetails<C extends ErrorCode>(code: C): ErrorDetails<C> | null {
    if (this.code !== code) return null;
    const parsed = ERROR_DETAILS_SCHEMAS[code].safeParse(this.details);
    return parsed.success ? (parsed.data as ErrorDetails<C>) : null;
  }

  get surface(): ErrorSurface {
    return this.session ? 'inline' : errorSurface(this.code);
  }
}

/**
 * The failure of starting the session, marked as such. An API error keeps its code, details
 * and wait (`retryAfterSeconds` overrides the wait when given); anything else (a bot check
 * that could not run, a request that timed out) reads as a failure to reach Hailiday.
 */
export function sessionError(error: unknown, retryAfterSeconds?: number | null): ApiError {
  if (error instanceof ApiError) {
    if (error.session && retryAfterSeconds === undefined) return error;
    return new ApiError({
      kind: error.kind,
      status: error.status,
      code: error.code,
      details: error.details,
      requestId: error.requestId,
      retryAfterSeconds:
        retryAfterSeconds === undefined ? error.retryAfterSeconds : retryAfterSeconds,
      message: error.message,
      session: true,
    });
  }
  return new ApiError({
    kind: 'network',
    status: null,
    code: null,
    details: {},
    requestId: null,
    retryAfterSeconds: null,
    message: error instanceof Error ? error.message : undefined,
    session: true,
  });
}

export function errorSurface(code: ErrorCode | null): ErrorSurface {
  switch (code) {
    case 'ALLOWANCE_EXHAUSTED':
      return 'allowance_sheet';
    case 'AT_CAPACITY':
      return 'capacity_sheet';
    case 'BUDGET_PAUSED':
      return 'budget_banner';
    case 'VERIFICATION_REQUIRED':
      return 'verification';
    case 'NOT_FOUND':
    case 'FORBIDDEN':
      return 'not_found_screen';
    default:
      return 'inline';
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Parses a `Retry-After` header: delta seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Turns a non-2xx response body into an `ApiError`. The envelope is read leniently so a
 * well-formed code is never lost to an extra or missing field. A 429 without a known code (for
 * example a plain-text or HTML answer from a proxy in front of the API) is still a rate limit,
 * with the wait from its `Retry-After`.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
): ApiError {
  const envelope = asRecord(asRecord(body)?.error);
  const rawCode = envelope?.code;
  const code: ErrorCode | null = isErrorCode(rawCode)
    ? rawCode
    : status === 429
      ? 'RATE_LIMITED'
      : null;
  const details = asRecord(envelope?.details) ?? {};
  const requestId = typeof envelope?.requestId === 'string' ? envelope.requestId : null;
  const fromDetails =
    typeof details.retryAfterSeconds === 'number' ? details.retryAfterSeconds : null;
  return new ApiError({
    kind: 'http',
    status,
    code,
    details,
    requestId,
    retryAfterSeconds: parseRetryAfter(retryAfterHeader) ?? fromDetails,
    message: typeof envelope?.message === 'string' ? envelope.message : undefined,
  });
}
