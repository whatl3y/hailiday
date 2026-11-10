import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger/index.js';

/** Token the fixture verifier accepts. */
export const FIXTURE_PASS_TOKEN = 'fixture-pass';
/** Token the fixture verifier rejects (any other token is rejected as well). */
export const FIXTURE_FAIL_TOKEN = 'fixture-fail';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileResult {
  success: boolean;
  errorCodes: string[];
  /** `fixture` when no network call was made. */
  mode: 'fixture' | 'live';
  hostname?: string | null;
  action?: string | null;
}

export interface VerifyTurnstileOptions {
  remoteIp?: string | null;
  idempotencyKey?: string;
  fetch?: typeof fetch;
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * Verifies a Turnstile token at session creation. Fixture mode never calls Cloudflare: it accepts
 * `fixture-pass` and rejects everything else. Live mode posts to siteverify with the secret key.
 */
export async function verifyTurnstile(
  config: AppConfig,
  token: string | null | undefined,
  options: VerifyTurnstileOptions = {},
): Promise<TurnstileResult> {
  if (!token || token.length > 2048) {
    return { success: false, errorCodes: ['missing-input-response'], mode: config.turnstile.mode };
  }
  if (config.turnstile.mode === 'fixture') {
    return token === FIXTURE_PASS_TOKEN
      ? { success: true, errorCodes: [], mode: 'fixture' }
      : { success: false, errorCodes: ['invalid-input-response'], mode: 'fixture' };
  }

  const body = new URLSearchParams({ secret: config.turnstile.secretKey, response: token });
  if (options.remoteIp) body.set('remoteip', options.remoteIp);
  if (options.idempotencyKey) body.set('idempotency_key', options.idempotencyKey);
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    if (!response.ok) {
      return { success: false, errorCodes: [`http-${response.status}`], mode: 'live' };
    }
    const result = (await response.json()) as {
      success?: boolean;
      'error-codes'?: string[];
      hostname?: string;
      action?: string;
    };
    return {
      success: result.success === true,
      errorCodes: result['error-codes'] ?? [],
      mode: 'live',
      hostname: result.hostname ?? null,
      action: result.action ?? null,
    };
  } catch (error) {
    options.logger?.warn({ err: error }, 'turnstile verification failed');
    return { success: false, errorCodes: ['internal-error'], mode: 'live' };
  }
}
