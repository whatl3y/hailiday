import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODE_VALUES, ProjectResponseSchema, buildErrorBody } from '@hailiday/core';
import { isCopyKey } from '../copy';
import { ApiError, errorFromResponse, errorSurface, parseRetryAfter } from './errors';
import { createApiClient } from './http';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('error mapping', () => {
  it('maps every core error envelope to its code and a catalog copy key', () => {
    for (const code of ERROR_CODE_VALUES) {
      const error = errorFromResponse(400, buildErrorBody(code, { requestId: 'req-1' }), null);
      expect(error.code).toBe(code);
      expect(error.copyKey).toBe(`error.${code}`);
      expect(isCopyKey(error.copyKey)).toBe(true);
      expect(error.requestId).toBe('req-1');
    }
  });

  it('routes limits to their own surfaces', () => {
    expect(errorSurface('ALLOWANCE_EXHAUSTED')).toBe('allowance_sheet');
    expect(errorSurface('AT_CAPACITY')).toBe('capacity_sheet');
    expect(errorSurface('BUDGET_PAUSED')).toBe('budget_banner');
    expect(errorSurface('VERIFICATION_REQUIRED')).toBe('verification');
    expect(errorSurface('NOT_FOUND')).toBe('not_found_screen');
    expect(errorSurface('FORBIDDEN')).toBe('not_found_screen');
    expect(errorSurface('RATE_LIMITED')).toBe('inline');
  });

  it('reads Retry-After as seconds or an HTTP date, falling back to details', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThanOrEqual(29);
    expect(parseRetryAfter(null)).toBeNull();
    const fromDetails = errorFromResponse(
      503,
      buildErrorBody('AT_CAPACITY', {
        requestId: 'r',
        details: { retryAfterSeconds: 45, queueDepth: null },
      }),
      null,
    );
    expect(fromDetails.retryAfterSeconds).toBe(45);
  });

  it('validates typed details per code', () => {
    const error = errorFromResponse(
      429,
      buildErrorBody('ALLOWANCE_EXHAUSTED', {
        requestId: 'r',
        details: { scope: 'addresses', resetsAt: null, permittedActions: ['wait_for_reset'] },
      }),
      null,
    );
    expect(error.typedDetails('ALLOWANCE_EXHAUSTED')?.scope).toBe('addresses');
    expect(error.typedDetails('AT_CAPACITY')).toBeNull();
  });

  it('keeps unknown or malformed bodies as generic errors', () => {
    const unknown = errorFromResponse(500, { error: { code: 'SOMETHING_NEW' } }, null);
    expect(unknown.code).toBeNull();
    expect(unknown.copyKey).toBe('error.unknown');
    const empty = errorFromResponse(502, null, null);
    expect(empty.kind).toBe('http');
    expect(empty.copyKey).toBe('error.unknown');
  });
});

describe('api client', () => {
  it('ensures the session first and validates the response with the schema', async () => {
    const ensureSession = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => jsonResponse(200, { unexpected: true }));
    const client = createApiClient({ fetch: fetchMock as typeof fetch, ensureSession });
    const failure = await client
      .request('/v1/projects/x', { schema: ProjectResponseSchema })
      .catch((error: unknown) => error);
    expect(ensureSession).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).kind).toBe('invalid_response');
  });

  it('skips the session for public calls and sends JSON same-origin', async () => {
    const ensureSession = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, { expiresAt: '2026-11-10T00:00:00.000Z' }),
    );
    const client = createApiClient({ fetch: fetchMock as typeof fetch, ensureSession });
    await client.request('/v1/sessions', {
      method: 'POST',
      session: false,
      body: { turnstileToken: 'fixture-pass' },
      query: { a: 'b', skip: undefined },
    });
    expect(ensureSession).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/v1/sessions?a=b');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ turnstileToken: 'fixture-pass' }));
  });

  it('turns an error envelope into a typed ApiError with Retry-After', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        429,
        buildErrorBody('RATE_LIMITED', {
          requestId: 'r',
          details: { scope: 'suggestions', retryAfterSeconds: 5 },
        }),
        { 'Retry-After': '7' },
      ),
    );
    const client = createApiClient({ fetch: fetchMock as typeof fetch });
    const failure = (await client
      .request('/v1/addresses/suggestions')
      .catch((e: unknown) => e)) as ApiError;
    expect(failure.code).toBe('RATE_LIMITED');
    expect(failure.status).toBe(429);
    expect(failure.retryAfterSeconds).toBe(7);
    expect(failure.copyKey).toBe('error.RATE_LIMITED');
    expect(failure.retryable).toBe(true);
  });

  it('retries once with a fresh bot-check token after VERIFICATION_REQUIRED', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(403, buildErrorBody('VERIFICATION_REQUIRED', { requestId: 'r' })),
      )
      .mockResolvedValueOnce(jsonResponse(204, undefined));
    const getVerificationToken = vi.fn(async () => 'fixture-pass');
    const client = createApiClient({ fetch: fetchMock as typeof fetch, getVerificationToken });
    await client.request('/v1/renders', { method: 'POST', body: {} });
    expect(getVerificationToken).toHaveBeenCalledTimes(1);
    const retryInit = fetchMock.mock.calls[1]![1] as RequestInit;
    expect((retryInit.headers as Record<string, string>)['X-Turnstile-Token']).toBe('fixture-pass');
  });

  it('retries a device-scoped render challenge once and never loops', async () => {
    const challenge = () =>
      jsonResponse(
        403,
        buildErrorBody('VERIFICATION_REQUIRED', { requestId: 'r', details: { scope: 'device' } }),
      );
    const fetchMock = vi.fn(async () => challenge());
    const getVerificationToken = vi.fn(async () => 'fixture-pass');
    const client = createApiClient({ fetch: fetchMock as typeof fetch, getVerificationToken });
    const failure = (await client
      .request('/v1/renders', { method: 'POST', body: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('VERIFICATION_REQUIRED');
    expect(failure.typedDetails('VERIFICATION_REQUIRED')).toEqual({ scope: 'device' });
    expect(getVerificationToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps VERIFICATION_REQUIRED when the bot check cannot produce a token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, buildErrorBody('VERIFICATION_REQUIRED', { requestId: 'r' })),
    );
    const getVerificationToken = vi.fn(async () => {
      throw new Error('turnstile_script');
    });
    const client = createApiClient({ fetch: fetchMock as typeof fetch, getVerificationToken });
    const failure = (await client
      .request('/v1/renders', { method: 'POST', body: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.code).toBe('VERIFICATION_REQUIRED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never runs the bot check for a call that must not start a session', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, buildErrorBody('VERIFICATION_REQUIRED', { requestId: 'r' })),
    );
    const getVerificationToken = vi.fn(async () => 'fixture-pass');
    const ensureSession = vi.fn(async () => undefined);
    const client = createApiClient({
      fetch: fetchMock as typeof fetch,
      getVerificationToken,
      ensureSession,
    });
    const failure = (await client
      .request('/v1/gallery', { session: false, verify: false })
      .catch((e: unknown) => e)) as ApiError;
    expect(failure.code).toBe('VERIFICATION_REQUIRED');
    expect(getVerificationToken).not.toHaveBeenCalled();
    expect(ensureSession).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports network failures and aborts distinctly', async () => {
    const network = createApiClient({
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
    });
    const failure = (await network.request('/v1/me').catch((e: unknown) => e)) as ApiError;
    expect(failure.kind).toBe('network');
    expect(failure.copyKey).toBe('error.network');

    const aborted = createApiClient({
      fetch: (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as typeof fetch,
    });
    const abort = (await aborted.request('/v1/me').catch((e: unknown) => e)) as ApiError;
    expect(abort.kind).toBe('aborted');
  });
});
