import { describe, expect, it } from 'vitest';
import {
  AppError,
  allowanceExhausted,
  rateLimited,
  toAppError,
  validationFailed,
} from './index.js';

describe('AppError', () => {
  it('takes status, retryability and copy key from the core error table', () => {
    const error = rateLimited('suggestions', 30);
    expect(error.httpStatus).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.copyKey).toBe('error.RATE_LIMITED');
    expect(error.responseHeaders()).toEqual({ 'Retry-After': '30' });
    expect(error.toBody('req-1')).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests.',
        requestId: 'req-1',
        retryable: true,
        details: { scope: 'suggestions', retryAfterSeconds: 30 },
      },
    });
  });

  it('validates details against the strict per-code schema', () => {
    expect(() => new AppError('NOT_FOUND', { extra: true } as never)).toThrow(TypeError);
    expect(validationFailed({ reason: 'version_conflict', currentVersion: 3 }).details).toEqual({
      reason: 'version_conflict',
      currentVersion: 3,
    });
    const exhausted = allowanceExhausted('variants', new Date('2026-11-10T00:00:00Z'), [
      'view_cached_variants',
    ]);
    expect(exhausted.details.resetsAt).toBe('2026-11-10T00:00:00.000Z');
    expect(exhausted.httpStatus).toBe(429);
  });

  it('wraps only errors that carry a core code', () => {
    expect(toAppError(new Error('boom'))).toBeNull();
    const original = new AppError('FORBIDDEN', { reason: 'csrf' });
    expect(toAppError(original)).toBe(original);
  });
});
