import { ERROR_CODES, ERROR_DETAILS_SCHEMAS, buildErrorBody, isErrorCode } from '@hailiday/core';
import type {
  ErrorBody,
  ErrorCode,
  ErrorDetails,
  ForbiddenReason,
  PermittedAction,
  RateLimitScope,
  ValidationFailedReason,
} from '@hailiday/core';

export interface AppErrorOptions {
  /** Developer-facing message; never shown to users. Defaults to the error table's message. */
  message?: string;
  cause?: unknown;
  /** Seconds for the `Retry-After` header on 429 and 503 responses. */
  retryAfterSeconds?: number | null;
  /** Extra response headers (rate-limit fields). */
  headers?: Record<string, string>;
}

/**
 * The single server error type. It carries a core error code and its `details`; HTTP status,
 * retryability and the copy key come from the core error table. Vendor errors are wrapped as the
 * `cause` and never serialized.
 */
export class AppError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly details: ErrorDetails<C>;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly copyKey: `error.${C}`;
  readonly retryAfterSeconds: number | null;
  readonly headers: Record<string, string>;

  constructor(code: C, details?: ErrorDetails<C>, options: AppErrorOptions = {}) {
    const definition = ERROR_CODES[code];
    super(options.message ?? definition.defaultMessage, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    const parsed = ERROR_DETAILS_SCHEMAS[code].safeParse(details ?? {});
    if (!parsed.success) {
      throw new TypeError(
        `Invalid details for ${code}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    this.details = parsed.data as ErrorDetails<C>;
    this.httpStatus = definition.httpStatus;
    this.retryable = definition.retryable;
    this.copyKey = definition.copyKey;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.headers = { ...(options.headers ?? {}) };
  }

  /** The `{ error: { code, message, requestId, retryable, details } }` response body. */
  toBody(requestId: string): ErrorBody {
    return buildErrorBody(this.code, {
      requestId,
      details: this.details,
      message: this.message,
    });
  }

  /** Response headers including `Retry-After` when set. */
  responseHeaders(): Record<string, string> {
    const headers = { ...this.headers };
    if (this.retryAfterSeconds !== null) headers['Retry-After'] = String(this.retryAfterSeconds);
    return headers;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function appError<C extends ErrorCode>(
  code: C,
  details?: ErrorDetails<C>,
  options?: AppErrorOptions,
): AppError<C> {
  return new AppError(code, details, options);
}

/** Wraps any thrown value: an AppError passes through, anything else is an internal failure. */
export function toAppError(error: unknown): AppError | null {
  if (isAppError(error)) return error;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    isErrorCode((error as { code: string }).code) &&
    'details' in error
  ) {
    const { code, details } = error as { code: ErrorCode; details: unknown };
    try {
      return new AppError(code, details as never, { cause: error });
    } catch {
      return null;
    }
  }
  return null;
}

export const notFound = (message?: string) =>
  new AppError('NOT_FOUND', {}, message ? { message } : {});

export const forbidden = (reason?: ForbiddenReason, message?: string) =>
  new AppError('FORBIDDEN', reason ? { reason } : {}, message ? { message } : {});

export function validationFailed(
  input: {
    reason?: ValidationFailedReason;
    fields?: { path: string; reason: string }[];
    currentVersion?: number;
  } = {},
  message?: string,
): AppError<'VALIDATION_FAILED'> {
  return new AppError('VALIDATION_FAILED', input, message ? { message } : {});
}

export function rateLimited(
  scope: RateLimitScope,
  retryAfterSeconds: number | null,
  headers?: Record<string, string>,
): AppError<'RATE_LIMITED'> {
  return new AppError(
    'RATE_LIMITED',
    { scope, retryAfterSeconds },
    { retryAfterSeconds, ...(headers ? { headers } : {}) },
  );
}

export function allowanceExhausted(
  scope: 'variants' | 'addresses',
  resetsAt: Date | null,
  permittedActions: PermittedAction[],
): AppError<'ALLOWANCE_EXHAUSTED'> {
  return new AppError('ALLOWANCE_EXHAUSTED', {
    scope,
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
    permittedActions,
  });
}

export function budgetPaused(
  reason: 'daily_ceiling' | 'monthly_ceiling' | 'sku_ceiling' | 'paused',
  resumesAt: Date | null,
  now: Date = new Date(),
): AppError<'BUDGET_PAUSED'> {
  const retryAfterSeconds = resumesAt
    ? Math.max(1, Math.ceil((resumesAt.getTime() - now.getTime()) / 1000))
    : null;
  return new AppError(
    'BUDGET_PAUSED',
    { reason, resumesAt: resumesAt ? resumesAt.toISOString() : null },
    { retryAfterSeconds },
  );
}

export function atCapacity(
  retryAfterSeconds: number,
  queueDepth: number | null,
): AppError<'AT_CAPACITY'> {
  return new AppError('AT_CAPACITY', { retryAfterSeconds, queueDepth }, { retryAfterSeconds });
}

export function providerUnavailable(
  provider: string | null,
  cause?: unknown,
): AppError<'PROVIDER_UNAVAILABLE'> {
  return new AppError('PROVIDER_UNAVAILABLE', { provider }, cause ? { cause } : {});
}

/** An internal invariant failure. Serialized by the API as a generic 500 without details. */
export class InternalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InternalError';
  }
}
