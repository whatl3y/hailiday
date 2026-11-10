import { z } from 'zod';
import {
  AllowanceScopeSchema,
  BudgetPausedReasonSchema,
  ForbiddenReasonSchema,
  PermittedActionSchema,
  RateLimitScopeSchema,
  ShareRevokedReasonSchema,
  SourceNotEditableReasonSchema,
  ValidationFailedReasonSchema,
  VerificationScopeSchema,
} from '../types/api.js';
import { FailureCodeSchema, RejectionReasonSchema } from '../types/render.js';
import type { FailureKind, RenderJobState } from '../types/render.js';
import {
  DetectedFormatSchema,
  StreetViewSourceModeSchema,
  UploadDeclineReasonClassSchema,
  UploadGuidanceReasonSchema,
} from '../types/source.js';
import { NormalizedBoxSchema } from '../schemas/box.js';
import { CountryCodeSchema, IsoDateTimeSchema } from '../schemas/common.js';

/** Stable, machine-readable failure codes. */
export const ERROR_CODE_VALUES = [
  'VALIDATION_FAILED',
  'VERIFICATION_REQUIRED',
  'RATE_LIMITED',
  'ALLOWANCE_EXHAUSTED',
  'BUDGET_PAUSED',
  'AT_CAPACITY',
  'ADDRESS_OUT_OF_SCOPE',
  'ADDRESS_NOT_FOUND',
  'NO_STREET_VIEW',
  'NEEDS_CONFIRMATION',
  'NEEDS_PHOTO',
  'SOURCE_NOT_EDITABLE',
  'UPLOAD_UNSUPPORTED_FORMAT',
  'UPLOAD_TOO_LARGE',
  'UPLOAD_DECLINED',
  'PEOPLE_DETECTED',
  'STALE_PROJECT_VERSION',
  'IDEMPOTENCY_CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'RENDER_REJECTED',
  'NOT_FOUND',
  'FORBIDDEN',
  'SHARE_REVOKED',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODE_VALUES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** When the same request may be retried, as stated in the error table. */
export const RETRY_CONDITIONS = [
  'no',
  'after_challenge',
  'after_retry_after',
  'after_resets_at',
  'later',
  'after_action',
  'after_refresh',
] as const;
export type RetryCondition = (typeof RETRY_CONDITIONS)[number];

/** `details` shape per error code. */
export const ERROR_DETAILS_SCHEMAS = {
  VALIDATION_FAILED: z.strictObject({
    fields: z.array(z.strictObject({ path: z.string(), reason: z.string() })).optional(),
    reason: ValidationFailedReasonSchema.optional(),
    currentVersion: z.int().nonnegative().optional(),
  }),
  VERIFICATION_REQUIRED: z.strictObject({ scope: VerificationScopeSchema.optional() }),
  RATE_LIMITED: z.strictObject({
    scope: RateLimitScopeSchema,
    retryAfterSeconds: z.int().nonnegative().nullable(),
  }),
  ALLOWANCE_EXHAUSTED: z.strictObject({
    scope: AllowanceScopeSchema,
    resetsAt: IsoDateTimeSchema.nullable(),
    permittedActions: z.array(PermittedActionSchema),
  }),
  BUDGET_PAUSED: z.strictObject({
    reason: BudgetPausedReasonSchema,
    resumesAt: IsoDateTimeSchema.nullable(),
  }),
  AT_CAPACITY: z.strictObject({
    retryAfterSeconds: z.int().nonnegative(),
    queueDepth: z.int().nonnegative().nullable(),
  }),
  ADDRESS_OUT_OF_SCOPE: z.strictObject({ countryCode: CountryCodeSchema.nullable() }),
  ADDRESS_NOT_FOUND: z.strictObject({}),
  NO_STREET_VIEW: z.strictObject({}),
  NEEDS_CONFIRMATION: z.strictObject({ candidateCount: z.int().nonnegative() }),
  NEEDS_PHOTO: z.strictObject({ sourceMode: StreetViewSourceModeSchema.nullable() }),
  SOURCE_NOT_EDITABLE: z.strictObject({ reason: SourceNotEditableReasonSchema }),
  UPLOAD_UNSUPPORTED_FORMAT: z.strictObject({
    acceptedTypes: z.array(z.string()),
    detectedFormat: DetectedFormatSchema.nullable(),
  }),
  UPLOAD_TOO_LARGE: z.strictObject({
    maxBytes: z.int().positive(),
    maxPixels: z.int().positive(),
  }),
  UPLOAD_DECLINED: z.strictObject({
    reasonClass: UploadDeclineReasonClassSchema,
    reason: UploadGuidanceReasonSchema.optional(),
  }),
  PEOPLE_DETECTED: z.strictObject({
    boxes: z.array(NormalizedBoxSchema),
    suggestedCropBox: NormalizedBoxSchema.nullable(),
    permittedActions: z.array(PermittedActionSchema),
  }),
  STALE_PROJECT_VERSION: z.strictObject({ currentProjectVersion: z.int().nonnegative() }),
  IDEMPOTENCY_CONFLICT: z.strictObject({ idempotencyKey: z.string() }),
  PROVIDER_UNAVAILABLE: z.strictObject({ provider: z.string().nullable() }),
  RENDER_REJECTED: z.strictObject({
    rejectionReason: RejectionReasonSchema.nullable(),
    failureCodes: z.array(FailureCodeSchema),
  }),
  NOT_FOUND: z.strictObject({}),
  FORBIDDEN: z.strictObject({ reason: ForbiddenReasonSchema.optional() }),
  SHARE_REVOKED: z.strictObject({ reason: ShareRevokedReasonSchema }),
} as const satisfies Record<ErrorCode, z.ZodType>;

export type ErrorDetails<C extends ErrorCode> = z.infer<(typeof ERROR_DETAILS_SCHEMAS)[C]>;

export interface ErrorDefinition<C extends ErrorCode = ErrorCode> {
  code: C;
  httpStatus: number;
  /** Whether the same request may succeed later without the client changing it. */
  retryable: boolean;
  /** The retry condition as written in the error table. */
  retry: RetryCondition;
  /** Summary of the client behavior the experience spec implements. */
  clientBehavior: string;
  /** Copy key: `error.` plus the code. */
  copyKey: `error.${C}`;
  /** Developer-facing English; never shown to users. */
  defaultMessage: string;
  detailsSchema: (typeof ERROR_DETAILS_SCHEMAS)[C];
}

const RETRYABLE_CONDITIONS: readonly RetryCondition[] = [
  'after_retry_after',
  'after_resets_at',
  'later',
];

function define<C extends ErrorCode>(
  code: C,
  httpStatus: number,
  retry: RetryCondition,
  clientBehavior: string,
  defaultMessage: string,
): ErrorDefinition<C> {
  return {
    code,
    httpStatus,
    retryable: RETRYABLE_CONDITIONS.includes(retry),
    retry,
    clientBehavior,
    copyKey: `error.${code}`,
    defaultMessage,
    detailsSchema: ERROR_DETAILS_SCHEMAS[code],
  };
}

/** The error table: status, retryability, client behavior, copy key and details per code. */
export const ERROR_CODES: { readonly [C in ErrorCode]: ErrorDefinition<C> } = {
  VALIDATION_FAILED: define(
    'VALIDATION_FAILED',
    400,
    'no',
    'Show the field message; fix input.',
    'The request failed validation.',
  ),
  VERIFICATION_REQUIRED: define(
    'VERIFICATION_REQUIRED',
    403,
    'after_challenge',
    'Run the Turnstile widget, retry with X-Turnstile-Token.',
    'Human verification is required.',
  ),
  RATE_LIMITED: define(
    'RATE_LIMITED',
    429,
    'after_retry_after',
    'Passive notice; retry after the header; never loop. Without Retry-After the action is not retried.',
    'Too many requests.',
  ),
  ALLOWANCE_EXHAUSTED: define(
    'ALLOWANCE_EXHAUSTED',
    429,
    'after_resets_at',
    'Keep current result and controls usable; show the allowance-reached state.',
    'Allowance exhausted for this owner.',
  ),
  BUDGET_PAUSED: define(
    'BUDGET_PAUSED',
    503,
    'later',
    'Paused for today state; existing results viewable; no retry loop.',
    'Rendering is paused by a spend ceiling or operator pause.',
  ),
  AT_CAPACITY: define(
    'AT_CAPACITY',
    503,
    'after_retry_after',
    'Show the capacity sheet with a countdown from Retry-After; enable Try again at zero; never retry automatically.',
    'The service is at capacity.',
  ),
  ADDRESS_OUT_OF_SCOPE: define(
    'ADDRESS_OUT_OF_SCOPE',
    422,
    'no',
    'Keep the typed text; explain US scope; offer manual entry or upload.',
    'The address is outside the supported scope.',
  ),
  ADDRESS_NOT_FOUND: define(
    'ADDRESS_NOT_FOUND',
    404,
    'no',
    'Offer manual entry or upload.',
    'The address could not be found.',
  ),
  NO_STREET_VIEW: define(
    'NO_STREET_VIEW',
    404,
    'no',
    'No Street View screen; offer upload.',
    'No Street View imagery is available.',
  ),
  NEEDS_CONFIRMATION: define(
    'NEEDS_CONFIRMATION',
    409,
    'after_action',
    'Show the confirm-place screen.',
    'The place must be confirmed before rendering.',
  ),
  NEEDS_PHOTO: define(
    'NEEDS_PHOTO',
    409,
    'after_action',
    'Show the photo prompt.',
    'The project has no editable source; a photo is needed.',
  ),
  SOURCE_NOT_EDITABLE: define(
    'SOURCE_NOT_EDITABLE',
    409,
    'no',
    'For display_only show the interim photo prompt; otherwise offer another view or a photo.',
    'The bound source cannot be decorated.',
  ),
  UPLOAD_UNSUPPORTED_FORMAT: define(
    'UPLOAD_UNSUPPORTED_FORMAT',
    415,
    'no',
    'Explain accepted formats; offer another photo.',
    'The upload format is not supported.',
  ),
  UPLOAD_TOO_LARGE: define(
    'UPLOAD_TOO_LARGE',
    413,
    'no',
    'Explain the limit; client resizes or picks another photo.',
    'The upload is too large.',
  ),
  UPLOAD_DECLINED: define(
    'UPLOAD_DECLINED',
    422,
    'no',
    'Neutral explanation; offer another photo; never resend the same bytes.',
    'The upload was declined.',
  ),
  PEOPLE_DETECTED: define(
    'PEOPLE_DETECTED',
    409,
    'after_action',
    'Offer the one-tap crop, keeping the photo private-only, or another photo.',
    'People were detected in the photo; a resolution is required.',
  ),
  STALE_PROJECT_VERSION: define(
    'STALE_PROJECT_VERSION',
    409,
    'after_refresh',
    'Reload the project, re-render, retry with the current version.',
    'The project version is stale.',
  ),
  IDEMPOTENCY_CONFLICT: define(
    'IDEMPOTENCY_CONFLICT',
    422,
    'no',
    'Client defect: mint a new key for a new request.',
    'The idempotency key was reused with a different request.',
  ),
  PROVIDER_UNAVAILABLE: define(
    'PROVIDER_UNAVAILABLE',
    503,
    'later',
    'Honest status; offer retry later; no automatic loop.',
    'A provider is unavailable.',
  ),
  RENDER_REJECTED: define(
    'RENDER_REJECTED',
    409,
    'no',
    'Rejected-result state; offer a new render or another photo.',
    'The render was rejected by quality checks or review.',
  ),
  NOT_FOUND: define('NOT_FOUND', 404, 'no', 'Generic not-found state.', 'Not found.'),
  FORBIDDEN: define('FORBIDDEN', 403, 'no', 'Depends on reason.', 'Forbidden.'),
  SHARE_REVOKED: define(
    'SHARE_REVOKED',
    410,
    'no',
    'Share-gone page.',
    'The share link is no longer available.',
  ),
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODE_VALUES as readonly string[]).includes(value);
}

/** Looks up an error definition; throws for an unknown code. */
export function getErrorDefinition<C extends ErrorCode>(code: C): ErrorDefinition<C> {
  const definition = ERROR_CODES[code];
  if (!definition) throw new RangeError(`Unknown error code: ${String(code)}`);
  return definition;
}

/** Looks up an error definition by an untrusted string; returns null when unknown. */
export function findErrorDefinition(code: string): ErrorDefinition | null {
  return isErrorCode(code) ? (ERROR_CODES[code] as ErrorDefinition) : null;
}

export function errorCopyKey<C extends ErrorCode>(code: C): `error.${C}` {
  return `error.${code}`;
}

/** Validates details for a code; returns the parsed details or throws. */
export function parseErrorDetails<C extends ErrorCode>(code: C, details: unknown): ErrorDetails<C> {
  return ERROR_DETAILS_SCHEMAS[code].parse(details ?? {}) as ErrorDetails<C>;
}

/** Error envelope returned on every non-2xx response. */
export const ErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** Builds the error envelope for a code from the error table. */
export function buildErrorBody<C extends ErrorCode>(
  code: C,
  options: { requestId: string; details?: ErrorDetails<C>; message?: string },
): ErrorBody {
  const definition = getErrorDefinition(code);
  return {
    error: {
      code,
      message: options.message ?? definition.defaultMessage,
      requestId: options.requestId,
      retryable: definition.retryable,
      details: (options.details ?? {}) as Record<string, unknown>,
    },
  };
}

/** Failure kinds that surface as `PROVIDER_UNAVAILABLE` on a failed render. */
export const PROVIDER_UNAVAILABLE_FAILURE_KINDS: readonly FailureKind[] = [
  'provider_error',
  'timeout',
  'unknown_outcome',
  'internal_error',
];

/** The `errorCode` a render status carries for a terminal state. */
export function renderErrorCodeFor(
  state: RenderJobState,
  failureKind: FailureKind | null,
): ErrorCode | null {
  if (state === 'rejected') return 'RENDER_REJECTED';
  if (
    state === 'failed' &&
    failureKind &&
    PROVIDER_UNAVAILABLE_FAILURE_KINDS.includes(failureKind)
  ) {
    return 'PROVIDER_UNAVAILABLE';
  }
  return null;
}
