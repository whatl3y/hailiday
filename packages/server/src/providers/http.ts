import { ProviderError } from './errors.js';

/** The `fetch` signature providers use; tests inject a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** HTTPS hosts providers may call. Every other host is refused before any request. */
export const PROVIDER_HOSTS: ReadonlySet<string> = new Set([
  'places.googleapis.com',
  'maps.googleapis.com',
  'geocode.googleapis.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.anthropic.com',
]);

export interface ProviderResponse {
  status: number;
  headers: Headers;
  bytes: Buffer;
  json<T = unknown>(): T;
}

export interface ProviderFetchOptions {
  provider: string;
  timeoutMs: number;
  maxBytes?: number;
  signal?: AbortSignal;
  allowedHosts?: ReadonlySet<string>;
}

/**
 * Calls a provider endpoint: HTTPS to an allowlisted host only, no redirects, a timeout, and a
 * maximum response size. Network failures become `ProviderError` (`timeout` or
 * `provider_error`); HTTP error statuses are returned for the adapter to classify.
 */
export async function providerFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  options: ProviderFetchOptions,
): Promise<ProviderResponse> {
  const parsed = new URL(url);
  const hosts = options.allowedHosts ?? PROVIDER_HOSTS;
  if (parsed.protocol !== 'https:' || !hosts.has(parsed.hostname)) {
    throw new ProviderError(
      options.provider,
      'invalid_request',
      'Host is not an allowed provider',
      {
        retryable: false,
      },
    );
  }
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal });
  } catch (error) {
    if (timeout.aborted) {
      throw new ProviderError(options.provider, 'timeout', 'Provider request timed out', {
        cause: error,
      });
    }
    if (options.signal?.aborted) {
      throw new ProviderError(options.provider, 'timeout', 'Provider request was aborted', {
        retryable: false,
        cause: error,
      });
    }
    throw new ProviderError(options.provider, 'provider_error', 'Provider request failed', {
      cause: error,
    });
  }
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new ProviderError(options.provider, 'provider_error', 'Provider response too large', {
      retryable: false,
    });
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new ProviderError(
      options.provider,
      timeout.aborted ? 'timeout' : 'provider_error',
      'Provider response could not be read',
      { cause: error },
    );
  }
  if (bytes.length > maxBytes) {
    throw new ProviderError(options.provider, 'provider_error', 'Provider response too large', {
      retryable: false,
    });
  }
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    json<T>() {
      try {
        return JSON.parse(bytes.toString('utf8')) as T;
      } catch (error) {
        throw new ProviderError(
          options.provider,
          'provider_error',
          'Provider returned invalid JSON',
          {
            cause: error,
            httpStatus: response.status,
          },
        );
      }
    },
  };
}
