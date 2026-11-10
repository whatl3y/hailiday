import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimitScope } from '@holiday/core';
import { rateLimited } from '@holiday/server/errors';
import { sha256Hex } from '@holiday/server/ids';
import {
  ENDPOINT_RATE_LIMITS,
  rateLimitHeaders,
  sessionCreationRule,
  type RateLimitRule,
} from '@holiday/server/limits';
import type { ApiDeps } from '../deps.js';
import { ipHashOf } from './ip.js';
import type { AuthState } from './session.js';

export interface LimitEntry {
  rule: RateLimitRule;
  /** An opaque key (a hash or an ID), never raw user text. */
  key: string;
  /** Whether a refusal carries `Retry-After` (false for budgets that do not refill soon). */
  retryAfter?: boolean;
}

/**
 * Counts one request against every entry. The first refusal throws `RATE_LIMITED` with the scope,
 * `Retry-After` (when the entry refills) and the IETF `RateLimit` fields; otherwise the fields of
 * the first entry are set on the response.
 */
export function enforceLimits(
  deps: Pick<ApiDeps, 'limiter'>,
  reply: FastifyReply,
  scope: RateLimitScope,
  entries: readonly LimitEntry[],
): void {
  let headers: Record<string, string> | null = null;
  for (const entry of entries) {
    const result = deps.limiter.hit(`${scope}:${entry.key}`, entry.rule);
    const fields = rateLimitHeaders(scope, result, entry.rule);
    if (!result.allowed) {
      const retryAfter = entry.retryAfter === false ? null : Math.max(1, result.retryAfterSeconds);
      throw rateLimited(scope, retryAfter, fields);
    }
    headers ??= fields;
  }
  if (headers) reply.headers(headers);
}

/**
 * The endpoint limits from the limits module, keyed per IP hash, session, owner or email hash.
 */
export function enforceEndpointLimit(
  deps: Pick<ApiDeps, 'limiter' | 'config' | 'clock'>,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: RateLimitScope,
  context: { auth?: AuthState | null; email?: string | null } = {},
): void {
  const rules = ENDPOINT_RATE_LIMITS[scope] ?? [];
  const entries: LimitEntry[] = [];
  for (const rule of rules) {
    let key: string | null = null;
    if (rule.per === 'ip') key = `ip:${ipHashOf(deps, request)}`;
    else if (rule.per === 'session')
      key = context.auth ? `session:${context.auth.session.id}` : null;
    else if (rule.per === 'owner') key = context.auth ? `owner:${context.auth.ownerId}` : null;
    else if (rule.per === 'email' && context.email) key = `email:${sha256Hex(context.email)}`;
    if (!key) continue;
    entries.push({
      rule: { limit: rule.limit, windowMs: rule.windowMs },
      key: `${key}:${rule.windowMs}`,
    });
  }
  enforceLimits(deps, reply, scope, entries);
}

/** The per-IP limit on creating anonymous sessions (explicitly or implicitly). */
export async function enforceSessionCreationLimit(
  deps: Pick<ApiDeps, 'limiter' | 'config' | 'clock' | 'settings'>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rule = await sessionCreationRule(deps.settings);
  enforceLimits(deps, reply, 'sessions', [
    { rule, key: `ip:${ipHashOf(deps, request)}:${rule.windowMs}` },
  ]);
}
