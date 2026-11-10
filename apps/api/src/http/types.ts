import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

/** The Fastify instance with the zod type provider every route module registers on. */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

/** Path prefixes of the JSON APIs (no-store, JSON errors). */
export const API_PREFIXES = ['/v1/', '/internal/'] as const;

/** The path of a URL without its query string (query text is never logged). */
export function pathOnly(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

/**
 * The path the router sees: the query string removed, percent-encoding decoded (the router
 * decodes before matching, so `/%76%31/me` is `/v1/me`), repeated slashes collapsed and
 * lower-cased. Returns null when the path is not valid percent-encoding.
 */
export function normalizedPath(url: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(pathOnly(url));
  } catch {
    return null;
  }
  return path.replace(/\/{2,}/g, '/').toLowerCase();
}

/**
 * Whether a request URL (or a matched route pattern) addresses a JSON API. A path that cannot be
 * decoded counts as an API path, so it gets the stricter treatment.
 */
export function isApiPath(url: string): boolean {
  const path = normalizedPath(url);
  if (path === null) return true;
  return API_PREFIXES.some((prefix) => path.startsWith(prefix) || `${path}/` === prefix);
}
