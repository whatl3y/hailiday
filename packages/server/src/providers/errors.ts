/** Why a provider call failed, in the vocabulary of the render pipeline's failure kinds. */
export type ProviderFailureKind =
  | 'provider_error'
  | 'timeout'
  | 'moderation_blocked'
  | 'invalid_request'
  | 'schema_violation'
  | 'not_found'
  | 'unsupported';

/**
 * A provider call failed. Vendor diagnostics are kept in `providerCode`, `providerMessage`
 * (redacted of anything key-like) and `providerParam` for logs and internal records; callers map
 * `kind` to a job failure or an API error and never serialize the vendor text to clients.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly kind: ProviderFailureKind;
  readonly retryable: boolean;
  readonly providerCode: string | null;
  readonly providerCategories: string[];
  readonly httpStatus: number | null;
  /** The vendor's error message with credentials removed. */
  readonly providerMessage: string | null;
  /** The request parameter the vendor named as the cause. */
  readonly providerParam: string | null;

  constructor(
    provider: string,
    kind: ProviderFailureKind,
    message: string,
    options: {
      retryable?: boolean;
      providerCode?: string | null;
      providerCategories?: string[];
      httpStatus?: number | null;
      providerMessage?: string | null;
      providerParam?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = provider;
    this.kind = kind;
    this.retryable = options.retryable ?? (kind === 'provider_error' || kind === 'timeout');
    this.providerCode = options.providerCode ?? null;
    this.providerCategories = options.providerCategories ?? [];
    this.httpStatus = options.httpStatus ?? null;
    this.providerMessage = options.providerMessage ?? null;
    this.providerParam = options.providerParam ?? null;
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/** A provider was selected that cannot run with the current configuration. */
export class ProviderConfigError extends Error {
  readonly provider: string;
  constructor(provider: string, message: string) {
    super(message);
    this.name = 'ProviderConfigError';
    this.provider = provider;
  }
}

/** Maps an HTTP status from a vendor to a failure kind and retryability. */
export function kindForHttpStatus(status: number): {
  kind: ProviderFailureKind;
  retryable: boolean;
} {
  if (status === 408 || status === 504) return { kind: 'timeout', retryable: true };
  if (status === 429 || status >= 500) return { kind: 'provider_error', retryable: true };
  if (status === 404) return { kind: 'not_found', retryable: false };
  if (status === 400 || status === 413 || status === 422) {
    return { kind: 'invalid_request', retryable: false };
  }
  return { kind: 'provider_error', retryable: false };
}
