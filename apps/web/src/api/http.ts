import { ApiError, errorFromResponse, sessionError } from './errors';

/** The part of a zod schema the client needs; core schemas satisfy it structurally. */
export interface ResponseSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions<T> {
  method?: HttpMethod;
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  /** Validates the 2xx body. Omit for endpoints that answer with no content. */
  schema?: ResponseSchema<T>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Whether a session must exist before the call (default true). */
  session?: boolean;
  /**
   * Whether `VERIFICATION_REQUIRED` is retried once with a fresh bot-check token (default
   * true). Calls that must never start a session turn it off.
   */
  verify?: boolean;
  keepalive?: boolean;
}

export interface HttpResult<T> {
  data: T;
  status: number;
  headers: Headers;
}

export interface ApiClientDeps {
  fetch: typeof fetch;
  baseUrl?: string;
  /** Creates the session cookie once; called before session-level requests. */
  ensureSession?: () => Promise<void>;
  /** Produces a fresh bot-check token after `VERIFICATION_REQUIRED`. */
  getVerificationToken?: () => Promise<string>;
}

export interface ApiClient {
  request<T>(path: string, options?: RequestOptions<T>): Promise<HttpResult<T>>;
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions<unknown>['query']): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const qs = search.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

/**
 * A typed fetch client for the same-origin `/v1` API. Every 2xx body is validated with the
 * core schema the caller passes; every non-2xx body becomes an `ApiError` carrying the error
 * code, copy key and details. `VERIFICATION_REQUIRED` is retried once with a fresh token.
 */
export function createApiClient(deps: ApiClientDeps): ApiClient {
  const baseUrl = deps.baseUrl ?? '';

  async function send<T>(
    path: string,
    options: RequestOptions<T>,
    verificationToken: string | null,
  ): Promise<HttpResult<T>> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (verificationToken) headers['X-Turnstile-Token'] = verificationToken;

    let response: Response;
    try {
      response = await deps.fetch(buildUrl(baseUrl, path, options.query), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'same-origin',
        signal: options.signal,
        keepalive: options.keepalive,
      });
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === 'AbortError';
      throw new ApiError({
        kind: aborted ? 'aborted' : 'network',
        status: null,
        code: null,
        details: {},
        requestId: null,
        retryAfterSeconds: null,
      });
    }

    let body: unknown;
    try {
      body = await readJson(response);
    } catch {
      if (!response.ok) {
        throw errorFromResponse(response.status, null, response.headers.get('Retry-After'));
      }
      throw invalid(response.status);
    }

    if (!response.ok) {
      throw errorFromResponse(response.status, body, response.headers.get('Retry-After'));
    }

    if (!options.schema) {
      return { data: undefined as T, status: response.status, headers: response.headers };
    }
    const parsed = options.schema.safeParse(body ?? {});
    if (!parsed.success) throw invalid(response.status);
    return { data: parsed.data, status: response.status, headers: response.headers };
  }

  return {
    async request<T>(path: string, options: RequestOptions<T> = {}) {
      if (options.session !== false && deps.ensureSession) {
        // A session that cannot start fails the call at once, marked so the interface says why.
        await deps.ensureSession().catch((error: unknown) => {
          throw sessionError(error);
        });
      }
      try {
        return await send(path, options, null);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === 'VERIFICATION_REQUIRED' &&
          options.verify !== false &&
          deps.getVerificationToken
        ) {
          // A challenge that cannot produce a token leaves the request needing verification.
          const token = await deps.getVerificationToken().catch(() => {
            throw error;
          });
          return send(path, options, token);
        }
        throw error;
      }
    },
  };
}

function invalid(status: number): ApiError {
  return new ApiError({
    kind: 'invalid_response',
    status,
    code: null,
    details: {},
    requestId: null,
    retryAfterSeconds: null,
    message: 'The response did not match the expected schema.',
  });
}
