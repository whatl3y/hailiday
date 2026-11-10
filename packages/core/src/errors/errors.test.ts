import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_CODE_VALUES,
  ERROR_DETAILS_SCHEMAS,
  ErrorBodySchema,
  buildErrorBody,
  errorCopyKey,
  findErrorDefinition,
  getErrorDefinition,
  isErrorCode,
  parseErrorDetails,
  renderErrorCodeFor,
} from './index.js';

/** The error table from the data-and-api spec: code, HTTP status, retry condition. */
const TABLE = [
  ['VALIDATION_FAILED', 400, 'no'],
  ['VERIFICATION_REQUIRED', 403, 'after_challenge'],
  ['RATE_LIMITED', 429, 'after_retry_after'],
  ['ALLOWANCE_EXHAUSTED', 429, 'after_resets_at'],
  ['BUDGET_PAUSED', 503, 'later'],
  ['AT_CAPACITY', 503, 'after_retry_after'],
  ['ADDRESS_OUT_OF_SCOPE', 422, 'no'],
  ['ADDRESS_NOT_FOUND', 404, 'no'],
  ['NO_STREET_VIEW', 404, 'no'],
  ['NEEDS_CONFIRMATION', 409, 'after_action'],
  ['NEEDS_PHOTO', 409, 'after_action'],
  ['SOURCE_NOT_EDITABLE', 409, 'no'],
  ['UPLOAD_UNSUPPORTED_FORMAT', 415, 'no'],
  ['UPLOAD_TOO_LARGE', 413, 'no'],
  ['UPLOAD_DECLINED', 422, 'no'],
  ['PEOPLE_DETECTED', 409, 'after_action'],
  ['STALE_PROJECT_VERSION', 409, 'after_refresh'],
  ['IDEMPOTENCY_CONFLICT', 422, 'no'],
  ['PROVIDER_UNAVAILABLE', 503, 'later'],
  ['RENDER_REJECTED', 409, 'no'],
  ['NOT_FOUND', 404, 'no'],
  ['FORBIDDEN', 403, 'no'],
  ['SHARE_REVOKED', 410, 'no'],
] as const;

describe('error table', () => {
  it('covers exactly the 23 codes of the spec', () => {
    expect(ERROR_CODE_VALUES).toHaveLength(23);
    expect(Object.keys(ERROR_CODES).sort()).toEqual(TABLE.map(([code]) => code).sort());
    expect(Object.keys(ERROR_DETAILS_SCHEMAS).sort()).toEqual([...ERROR_CODE_VALUES].sort());
  });

  for (const [code, status, retry] of TABLE) {
    it(`${code}: ${status}, ${retry}, error.${code}`, () => {
      const definition = getErrorDefinition(code);
      expect(definition.code).toBe(code);
      expect(definition.httpStatus).toBe(status);
      expect(definition.retry).toBe(retry);
      expect(definition.copyKey).toBe(`error.${code}`);
      expect(errorCopyKey(code)).toBe(`error.${code}`);
      expect(definition.clientBehavior.length).toBeGreaterThan(0);
      expect(definition.defaultMessage.length).toBeGreaterThan(0);
      expect(definition.retryable).toBe(
        ['after_retry_after', 'after_resets_at', 'later'].includes(retry),
      );
    });
  }

  it('looks up codes safely', () => {
    expect(isErrorCode('NOT_FOUND')).toBe(true);
    expect(isErrorCode('QUOTA_EXCEEDED')).toBe(false);
    expect(findErrorDefinition('QUOTA_EXCEEDED')).toBeNull();
    expect(findErrorDefinition('SHARE_REVOKED')?.httpStatus).toBe(410);
  });
});

describe('error details', () => {
  it('validates documented details shapes', () => {
    expect(
      parseErrorDetails('ALLOWANCE_EXHAUSTED', {
        scope: 'variants',
        resetsAt: '2026-11-10T14:03:00.000Z',
        permittedActions: ['view_cached_variants', 'save_project', 'wait_for_reset'],
      }).scope,
    ).toBe('variants');
    expect(
      parseErrorDetails('PEOPLE_DETECTED', {
        boxes: [[0.12, 0.3, 0.25, 0.7]],
        suggestedCropBox: [0.3, 0, 1, 1],
        permittedActions: ['crop', 'keep', 'replace'],
      }).boxes,
    ).toHaveLength(1);
    expect(parseErrorDetails('NOT_FOUND', undefined)).toEqual({});
    expect(parseErrorDetails('VALIDATION_FAILED', { reason: 'content_cell_not_offered' })).toEqual({
      reason: 'content_cell_not_offered',
    });
  });

  it('rejects undocumented details', () => {
    expect(() => parseErrorDetails('SHARE_REVOKED', { reason: 'gone' })).toThrow();
    expect(() => parseErrorDetails('NOT_FOUND', { extra: true })).toThrow();
    expect(() =>
      parseErrorDetails('RATE_LIMITED', { scope: 'viewpoints', retryAfterSeconds: -1 }),
    ).toThrow();
  });

  it('accepts VERIFICATION_REQUIRED with no scope or the device scope only', () => {
    expect(parseErrorDetails('VERIFICATION_REQUIRED', {})).toEqual({});
    expect(parseErrorDetails('VERIFICATION_REQUIRED', { scope: 'device' })).toEqual({
      scope: 'device',
    });
    expect(() => parseErrorDetails('VERIFICATION_REQUIRED', { scope: 'session' })).toThrow();
    expect(() => parseErrorDetails('VERIFICATION_REQUIRED', { other: true })).toThrow();
  });

  it('builds the error envelope from the table', () => {
    const body = buildErrorBody('ALLOWANCE_EXHAUSTED', {
      requestId: '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e',
      details: { scope: 'variants', resetsAt: null, permittedActions: ['wait_for_reset'] },
    });
    expect(ErrorBodySchema.parse(body)).toEqual(body);
    expect(body.error.code).toBe('ALLOWANCE_EXHAUSTED');
    expect(body.error.retryable).toBe(true);
    expect(buildErrorBody('NOT_FOUND', { requestId: 'r' }).error.details).toEqual({});
  });
});

describe('renderErrorCodeFor', () => {
  it('maps terminal render outcomes to error codes', () => {
    expect(renderErrorCodeFor('rejected', null)).toBe('RENDER_REJECTED');
    for (const kind of [
      'provider_error',
      'timeout',
      'unknown_outcome',
      'internal_error',
    ] as const) {
      expect(renderErrorCodeFor('failed', kind)).toBe('PROVIDER_UNAVAILABLE');
    }
    for (const kind of [
      'policy_denied',
      'moderation_blocked',
      'source_unavailable',
      'source_rejected',
    ] as const) {
      expect(renderErrorCodeFor('failed', kind)).toBeNull();
    }
    expect(renderErrorCodeFor('succeeded', null)).toBeNull();
    expect(renderErrorCodeFor('canceled', null)).toBeNull();
    expect(renderErrorCodeFor('rendering', null)).toBeNull();
  });
});
