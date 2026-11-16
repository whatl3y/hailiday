import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildErrorBody } from '@hailiday/core';
import {
  SESSION_REQUEST_TIMEOUT_MS,
  createRender,
  createUpload,
  ensureSession,
  getMe,
  getRender,
  hasSession,
  listGallery,
  listVariants,
  onSessionReady,
  resetSession,
  verifyMagicLink,
} from './endpoints';
import { isApiError, type ApiError } from './errors';
import { inlineMessage } from './present';
import { allowance, renderStatus, variant } from '../test/fixtures';

const PROJECT = '018f0000-0000-7000-8000-aaaaaaaaaaaa';
const ASSET = '018f0000-0000-7000-8000-bbbbbbbbbbbb';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers the session request and records every other call. */
function stubFetch(answer: (path: string) => Response) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input).split('?')[0]!;
    if (path === '/v1/sessions') return json(201, { expiresAt: '2026-11-10T12:00:00.000Z' });
    calls.push({ path, init: init ?? {} });
    return answer(path);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('endpoints', () => {
  it('sends the original file name in the upload body, never in a header', async () => {
    const calls = stubFetch(() =>
      json(201, {
        sourceAssetId: ASSET,
        upload: {
          method: 'POST',
          url: 'http://storage.test/bucket',
          fields: { key: 'k' },
          expiresAt: '2026-11-09T13:00:00.000Z',
          maxBytes: 100,
        },
        state: 'uploading',
      }),
    );
    await createUpload(
      {
        projectId: PROJECT,
        contentType: 'image/jpeg',
        byteLength: 10,
        clientPrepared: true,
        attestation: { accepted: true, attestationVersion: '2026-11' },
      },
      'decline-kitchen.jpg',
    ).catch(() => undefined);
    const upload = calls.find((call) => call.path === '/v1/uploads')!;
    expect(JSON.parse(String(upload.init.body))).toMatchObject({
      projectId: PROJECT,
      fileName: 'decline-kitchen.jpg',
    });
    expect(Object.keys(upload.init.headers as Record<string, string>)).not.toContain(
      'X-Hailiday-Upload-Name',
    );
  });

  it('verifies a magic link, then confirms it with confirm: true', async () => {
    const calls = stubFetch(() =>
      json(200, { confirmationRequired: true, emailHint: 't•••@x.com' }),
    );
    await expect(verifyMagicLink('tok')).resolves.toEqual({
      confirmationRequired: true,
      emailHint: 't•••@x.com',
    });
    await verifyMagicLink('tok', true);
    const bodies = calls.map((call) => JSON.parse(String(call.init.body)) as unknown);
    expect(bodies).toEqual([{ token: 'tok' }, { token: 'tok', confirm: true }]);
  });

  describe('when the session cannot start', () => {
    const NOW = Date.parse('2026-11-09T12:00:00.000Z');

    /** Answers `POST /v1/sessions` with `session(n)` (n counts from 1) and records every call. */
    function stubSessions(session: (n: number) => Response | Promise<Response>) {
      const calls: string[] = [];
      let sessions = 0;
      vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
        const path = String(input).split('?')[0]!;
        calls.push(path);
        if (path === '/v1/sessions') {
          sessions += 1;
          return session(sessions);
        }
        return json(200, { user: null, allowance: allowance(), savedProjects: 0 });
      });
      return calls;
    }

    const refused = () =>
      new Response(
        JSON.stringify(
          buildErrorBody('RATE_LIMITED', {
            requestId: 'r',
            details: { scope: 'sessions', retryAfterSeconds: 120 },
          }),
        ),
        { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '120' } },
      );

    beforeEach(() => {
      resetSession();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
      resetSession();
    });

    it('fails the waiting call at once with a warm session line and the server wait', async () => {
      const calls = stubSessions(() => refused());
      const failure = await getMe().catch((error: unknown) => error);
      expect(isApiError(failure)).toBe(true);
      const error = failure as ApiError;
      expect(error.session).toBe(true);
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryAfterSeconds).toBe(120);
      expect(error.surface).toBe('inline');
      expect(inlineMessage(error).message).toBe(
        'We need a short breather: lots of visits came from your connection just now. ' +
          'Try again in about 2 minutes.',
      );
      // The action itself was never sent.
      expect(calls).toEqual(['/v1/sessions']);
    });

    it('sends no new session request until Retry-After has passed, then starts again', async () => {
      const calls = stubSessions((n) =>
        n === 1 ? refused() : json(201, { expiresAt: '2026-11-10T12:00:00.000Z' }),
      );
      await expect(ensureSession()).rejects.toMatchObject({ code: 'RATE_LIMITED', session: true });

      vi.setSystemTime(NOW + 90_000);
      const during = (await ensureSession().catch((error: unknown) => error)) as ApiError;
      expect(during.session).toBe(true);
      expect(during.retryAfterSeconds).toBe(30);
      const action = (await getMe().catch((error: unknown) => error)) as ApiError;
      expect(action.copyKey).toBe('session.limited');
      expect(calls).toEqual(['/v1/sessions']);

      vi.setSystemTime(NOW + 121_000);
      await expect(getMe()).resolves.toBeTruthy();
      expect(calls).toEqual(['/v1/sessions', '/v1/sessions', '/v1/me']);
      expect(hasSession()).toBe(true);
    });

    it('treats a 429 without the JSON envelope as a rate limit with its Retry-After', async () => {
      const calls = stubSessions((n) =>
        n === 1
          ? new Response('<html><body>Too Many Requests</body></html>', {
              status: 429,
              headers: { 'Content-Type': 'text/html', 'Retry-After': '90' },
            })
          : json(201, { expiresAt: '2026-11-10T12:00:00.000Z' }),
      );
      const failure = (await getMe().catch((error: unknown) => error)) as ApiError;
      expect(failure.session).toBe(true);
      expect(failure.code).toBe('RATE_LIMITED');
      expect(failure.retryAfterSeconds).toBe(90);
      expect(failure.copyKey).toBe('session.limited');
      expect(inlineMessage(failure).message).toBe(
        'We need a short breather: lots of visits came from your connection just now. ' +
          'Try again in about 2 minutes.',
      );

      vi.setSystemTime(NOW + 30_000);
      const during = (await ensureSession().catch((error: unknown) => error)) as ApiError;
      expect(during.retryAfterSeconds).toBe(60);
      expect(calls).toEqual(['/v1/sessions']);

      vi.setSystemTime(NOW + 91_000);
      await expect(getMe()).resolves.toBeTruthy();
      expect(calls).toEqual(['/v1/sessions', '/v1/sessions', '/v1/me']);
    });

    it('treats a 429 with an unknown JSON body as a rate limit too', async () => {
      stubSessions(() => json(429, { statusCode: 429, error: 'Too Many Requests' }));
      const failure = (await getMe().catch((error: unknown) => error)) as ApiError;
      expect(failure.code).toBe('RATE_LIMITED');
      expect(failure.copyKey).toBe('session.limited');
      expect(failure.retryAfterSeconds).toBe(30);
    });

    it('reports any other failure as a session that could not start, and retries at once', async () => {
      const calls = stubSessions((n) => {
        if (n === 1) throw new TypeError('Failed to fetch');
        return json(201, { expiresAt: '2026-11-10T12:00:00.000Z' });
      });
      const failure = (await getMe().catch((error: unknown) => error)) as ApiError;
      expect(failure.session).toBe(true);
      expect(failure.copyKey).toBe('session.failed');
      expect(inlineMessage(failure).message).toBe(
        "We couldn't get Hailiday ready for you. Check your connection and try again.",
      );
      await expect(getMe()).resolves.toBeTruthy();
      expect(calls).toEqual(['/v1/sessions', '/v1/sessions', '/v1/me']);
    });

    it('gives the session request a deadline so a stalled start cannot hang a flow', async () => {
      let signal: AbortSignal | null | undefined;
      vi.spyOn(window, 'fetch').mockImplementation(async (_input, init) => {
        signal = init?.signal;
        return json(201, { expiresAt: '2026-11-10T12:00:00.000Z' });
      });
      await ensureSession();
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(SESSION_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    });
  });

  it('reads the gallery without starting a session or running the bot check', async () => {
    resetSession();
    const calls: string[] = [];
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      calls.push(String(input));
      return json(200, { items: [], nextCursor: null });
    });
    await expect(listGallery('c1', 60)).resolves.toEqual({ items: [], nextCursor: null });
    expect(calls).toEqual(['/v1/gallery?cursor=c1&limit=60']);
    expect(hasSession()).toBe(false);
  });

  it('tells listeners when the session exists', async () => {
    stubFetch(() => json(200, {}));
    resetSession();
    expect(hasSession()).toBe(false);
    const listener = vi.fn();
    const stop = onSessionReady(listener);
    await ensureSession();
    expect(hasSession()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('statuses from a newer server', () => {
  const NEW_KEY = 'stage.somethingNew';

  it('reads a render status with an unknown stage key as a status without one', async () => {
    const status = renderStatus({ state: 'preparing' });
    stubFetch(() => json(200, { ...status, stageLabelKey: NEW_KEY }));
    const read = await getRender(status.renderJobId);
    expect(read.renderJobId).toBe(status.renderJobId);
    expect(read.stageLabelKey).toBeNull();
  });

  it('reads a variants list whose running job has an unknown stage key', async () => {
    const running = renderStatus({ state: 'rendering' });
    const items = [variant()];
    stubFetch(() =>
      json(200, { items, activeRender: { ...running, stageLabelKey: NEW_KEY }, offered: null }),
    );
    const list = await listVariants(PROJECT);
    expect(list.items).toHaveLength(1);
    expect(list.activeRender?.renderJobId).toBe(running.renderJobId);
    expect(list.activeRender?.stageLabelKey).toBeNull();
  });

  it('reads a queued render answer with an unknown stage key', async () => {
    const status = renderStatus();
    stubFetch(() =>
      json(202, { ...status, stageLabelKey: NEW_KEY, cached: false, supersededRenderJobId: null }),
    );
    const response = await createRender(
      {
        projectId: PROJECT,
        projectVersion: 3,
        holidayId: 'christmas',
        style: 'classic',
        lightingMode: 'source',
      },
      'key-new-stage',
    );
    expect(response).toMatchObject({ cached: false, stageLabelKey: null });
  });
});

describe('a render request that needs the bot check', () => {
  const RENDER = {
    projectId: PROJECT,
    projectVersion: 3,
    holidayId: 'christmas',
    style: 'classic',
    lightingMode: 'source',
  } as const;
  const verificationRequired = () =>
    json(403, buildErrorBody('VERIFICATION_REQUIRED', { requestId: 'r', details: {} }));

  function renderCalls(answers: Array<() => Response>) {
    const calls: Array<Record<string, string>> = [];
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const path = String(input).split('?')[0]!;
      if (path === '/v1/sessions') return json(201, { expiresAt: '2026-11-10T12:00:00.000Z' });
      calls.push({ ...(init?.headers as Record<string, string>) });
      return answers[calls.length - 1]!();
    });
    return calls;
  }

  it('is sent again once with a fresh token and the same Idempotency-Key', async () => {
    const status = renderStatus();
    const calls = renderCalls([
      verificationRequired,
      () => json(202, { ...status, cached: false, supersededRenderJobId: null }),
    ]);
    const response = await createRender(RENDER, 'key-1');
    expect(response).toMatchObject({ cached: false, renderJobId: status.renderJobId });
    expect(calls).toHaveLength(2);
    expect(calls[0]!['Idempotency-Key']).toBe('key-1');
    expect(calls[0]!['X-Turnstile-Token']).toBeUndefined();
    expect(calls[1]!['Idempotency-Key']).toBe('key-1');
    expect(calls[1]!['X-Turnstile-Token']).toBe('fixture-pass');
  });

  it('fails with the verification copy after a second refusal instead of asking again', async () => {
    const calls = renderCalls([verificationRequired, verificationRequired, verificationRequired]);
    const failure = (await createRender(RENDER, 'key-2').catch((e: unknown) => e)) as ApiError;
    expect(isApiError(failure)).toBe(true);
    expect(failure.code).toBe('VERIFICATION_REQUIRED');
    expect(calls).toHaveLength(2);
    expect(inlineMessage(failure).message).toBe(
      "Quick check: confirm you're a person to continue.",
    );
  });
});
