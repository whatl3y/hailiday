import type { IncomingMessage } from 'node:http';
import { forbidden } from '@hailiday/server/errors';
import { newId } from '@hailiday/server/ids';
import type { AppConfig } from '@hailiday/server/config';
import type { App } from './types.js';
import { isApiPath, pathOnly } from './types.js';
import { sendAppError } from './errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Uses a client `X-Request-Id` when it is a UUID; otherwise generates a UUIDv7. */
export function requestIdFor(raw: IncomingMessage): string {
  const header = raw.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && UUID_PATTERN.test(value) ? value.toLowerCase() : newId();
}

/** The origins a state-changing request may come from (the app origin; the Vite dev server locally). */
export function allowedOrigins(config: AppConfig): Set<string> {
  const origins = new Set<string>([new URL(config.publicBaseUrl).origin]);
  if (config.isLocal) {
    for (const origin of config.storage.corsOrigins) {
      try {
        origins.add(new URL(origin).origin);
      } catch {
        // Ignore malformed configuration entries.
      }
    }
  }
  return origins;
}

/**
 * Request plumbing shared by every route: the request ID echoed as `X-Request-Id`, `Cache-Control:
 * no-store` on `/v1` and `/internal/v1` (decided on the matched route, or on the decoded path when
 * nothing matched), the same-origin check on every state-changing request whatever its path
 * (`Origin`, else `Sec-Fetch-Site: same-origin`; `SameSite=Lax` is the backstop) and one access log
 * line per request that records the path without its query string.
 */
export function registerRequestHooks(app: App, config: AppConfig): void {
  const origins = allowedOrigins(config);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    if (isApiPath(request.routeOptions.url ?? request.url)) {
      reply.header('Cache-Control', 'no-store');
    }
    if (!STATE_CHANGING.has(request.method)) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    const sameOrigin = origin ? origins.has(origin) : fetchSite === 'same-origin';
    if (!sameOrigin) {
      return sendAppError(request, reply, forbidden('origin_mismatch'));
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        path: request.routeOptions.url ?? pathOnly(request.url),
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });
}
