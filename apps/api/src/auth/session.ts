import type { FastifyReply, FastifyRequest } from 'fastify';
import { isValidTimeZone, normalizeEmail, type UserRole } from '@holiday/core';
import type { Audience } from '@holiday/server/capabilities';
import { DAY_MS, HOUR_MS, MINUTE_MS, addMs } from '@holiday/server/clock';
import type { AnonymousSession, DbOrTx, User } from '@holiday/server/db';
import { AppError, forbidden } from '@holiday/server/errors';
import { dailySaltedHash, hmacSha256Hex, newId, randomToken, sha256Hex } from '@holiday/server/ids';
import { verifyTurnstile } from '@holiday/server/turnstile';
import type { ApiDeps } from '../deps.js';
import { ipHashOf } from './ip.js';
import { enforceSessionCreationLimit } from './limits.js';

export { ipHashOf };

export const SESSION_COOKIE = 'holiday_session';
/** A random per-browser identifier that keys the device dimension of the render backstop. */
export const DEVICE_COOKIE = 'holiday_device';
/** Browsers cap cookie lifetimes at 400 days. */
const DEVICE_COOKIE_MAX_MS = 400 * DAY_MS;
/** `randomToken(16)`: 128 random bits, base64url. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Anonymous sessions follow anonymous projects: 24 h after last activity, at most 7 days. */
export const ANONYMOUS_SESSION_IDLE_MS = 24 * HOUR_MS;
export const ANONYMOUS_SESSION_MAX_MS = 7 * DAY_MS;
/** Signed-in sessions slide for 30 days. */
export const USER_SESSION_IDLE_MS = 30 * DAY_MS;
/** How often a session's last-seen time is written. */
const TOUCH_INTERVAL_MS = MINUTE_MS;

/** Who is calling: the session, its owner, and the signed-in account when there is one. */
export interface AuthState {
  session: AnonymousSession;
  ownerId: string;
  user: User | null;
  roles: UserRole[];
  audience: Audience;
}

const resolved = new WeakMap<FastifyRequest, Promise<AuthState | null>>();
const tokenChecks = new WeakMap<FastifyRequest, Promise<boolean>>();

/** The request's `X-Turnstile-Token` header, when it sends one. */
function turnstileTokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers['x-turnstile-token'];
  return Array.isArray(header) ? header[0] : header;
}

/** Whether the request sends an `X-Turnstile-Token` header. */
export function hasTurnstileToken(request: FastifyRequest): boolean {
  return Boolean(turnstileTokenOf(request));
}

/**
 * Whether the request's `X-Turnstile-Token` verifies. Tokens are single-use, so the token is sent
 * to the verifier at most once per request and every later check of the same request (the session
 * check, the render backstop and its locked re-check) reuses that answer.
 */
export function requestTokenVerified(deps: ApiDeps, request: FastifyRequest): Promise<boolean> {
  let check = tokenChecks.get(request);
  if (!check) {
    check = verifyTurnstile(deps.config, turnstileTokenOf(request), {
      remoteIp: request.ip,
      logger: deps.logger,
    }).then((result) => result.success);
    tokenChecks.set(request, check);
  }
  return check;
}

function sessionExpiry(session: Pick<AnonymousSession, 'createdAt'>, signedIn: boolean, now: Date) {
  if (signedIn) return addMs(now, USER_SESSION_IDLE_MS);
  const idle = addMs(now, ANONYMOUS_SESSION_IDLE_MS);
  const cap = addMs(session.createdAt, ANONYMOUS_SESSION_MAX_MS);
  return idle < cap ? idle : cap;
}

/** True when the configured operator allowlist holds `email`. */
export function isOperatorEmail(deps: Pick<ApiDeps, 'config'>, email: string): boolean {
  return deps.config.auth.operatorEmails.includes(normalizeEmail(email));
}

/**
 * The roles that take effect for an account: the stored roles, except that `operator` counts only
 * while the email is on the allowlist, so removing an email revokes operator access (internal
 * routes and private-audience capabilities) on the next request.
 */
export function effectiveRoles(deps: Pick<ApiDeps, 'config'>, user: User | null): UserRole[] {
  if (!user) return [];
  const operator = isOperatorEmail(deps, user.emailNormalized);
  return user.roles.filter((role) => role !== 'operator' || operator);
}

function deviceCookieId(request: FastifyRequest): string | null {
  const value = request.cookies?.[DEVICE_COOKIE];
  return value && DEVICE_ID_PATTERN.test(value) ? value : null;
}

function deviceHashForId(deps: Pick<ApiDeps, 'config'>, id: string): string {
  return hmacSha256Hex(deps.config.sessionSecret, `device:id:${id}`);
}

/**
 * The device key of a request, a keyed hash and a signal, never identity: the browser's
 * `holiday_device` cookie when it sends one; otherwise its user agent and language together with
 * its IP address, so two unrelated browsers share a key only behind the same address.
 */
export function deviceHashOf(deps: Pick<ApiDeps, 'config'>, request: FastifyRequest) {
  const id = deviceCookieId(request);
  if (id) return deviceHashForId(deps, id);
  const ua = String(request.headers['user-agent'] ?? '').slice(0, 256);
  const language = String(request.headers['accept-language'] ?? '').slice(0, 64);
  return hmacSha256Hex(deps.config.sessionSecret, `device:signals:${ua}|${language}|${request.ip}`);
}

/**
 * Sets the `holiday_device` cookie when the request carries none and returns the device key to
 * record for the session. A freshly minted cookie only counts from the browser's next request, so
 * a client that discards it falls back to the signal key rather than a new key per request.
 */
function ensureDeviceCookie(
  deps: Pick<ApiDeps, 'config'>,
  request: FastifyRequest,
  reply: FastifyReply,
): string {
  if (deviceCookieId(request)) return deviceHashOf(deps, request);
  const id = randomToken(16);
  reply.setCookie(DEVICE_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !deps.config.isLocal,
    path: '/',
    maxAge: Math.floor(DEVICE_COOKIE_MAX_MS / 1000),
  });
  return deviceHashForId(deps, id);
}

/** True when the request carries the Global Privacy Control signal. */
export function hasGpcSignal(request: FastifyRequest): boolean {
  const header = request.headers['sec-gpc'];
  return (Array.isArray(header) ? header[0] : header)?.trim() === '1';
}

/** The analytics session hash of an owner (daily rotating salt), shared with worker events. */
export function sessionHashOf(deps: Pick<ApiDeps, 'config' | 'clock'>, ownerId: string) {
  return dailySaltedHash(deps.config.sessionSecret, `owner:${ownerId}`, deps.clock.now());
}

function cookieToken(request: FastifyRequest): string | null {
  const value = request.cookies?.[SESSION_COOKIE];
  return value && value.length >= 16 && value.length <= 128 ? value : null;
}

async function loadAuth(deps: ApiDeps, request: FastifyRequest): Promise<AuthState | null> {
  const token = cookieToken(request);
  if (!token) return null;
  const now = deps.clock.now();
  const session = await deps.db
    .selectFrom('anonymousSessions')
    .selectAll()
    .where('tokenHash', '=', sha256Hex(token))
    .where('expiresAt', '>', now)
    .executeTakeFirst();
  if (!session) return null;
  const user =
    (await deps.db
      .selectFrom('users')
      .selectAll()
      .where('ownerId', '=', session.ownerId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst()) ?? null;
  let current = session;
  const gpc = hasGpcSignal(request) && session.gpcSignaledAt === null;
  if (gpc || now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const expiresAt = sessionExpiry(session, user !== null, now);
    current =
      (await deps.db
        .updateTable('anonymousSessions')
        .set({ lastSeenAt: now, expiresAt, ...(gpc ? { gpcSignaledAt: now } : {}) })
        .where('id', '=', session.id)
        .returningAll()
        .executeTakeFirst()) ?? session;
  }
  const roles = effectiveRoles(deps, user);
  return { session: current, ownerId: current.ownerId, user, roles, audience: { roles } };
}

/** The caller's session, or null when the request carries no valid session cookie. */
export function currentAuth(deps: ApiDeps, request: FastifyRequest): Promise<AuthState | null> {
  let promise = resolved.get(request);
  if (!promise) {
    promise = loadAuth(deps, request);
    resolved.set(request, promise);
  }
  return promise;
}

/** Forgets the cached session of a request (after sign-in or sign-out changed it). */
export function resetAuth(request: FastifyRequest): void {
  resolved.delete(request);
}

export function setSessionCookie(
  deps: Pick<ApiDeps, 'config'>,
  reply: FastifyReply,
  token: string,
  maxAgeMs: number,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !deps.config.isLocal,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(deps: Pick<ApiDeps, 'config'>, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: !deps.config.isLocal,
    path: '/',
  });
}

/**
 * Creates an anonymous owner and session (after a verified Turnstile token, or with
 * `turnstileVerifiedAt` null when the next paid action must run the challenge) and sets the
 * cookie, plus the `holiday_device` cookie when the browser has none. Only the SHA-256 hash of the
 * 256-bit cookie value is stored.
 */
export async function createAnonymousSession(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { timezone?: string | null; turnstileVerifiedAt: Date | null },
): Promise<AuthState> {
  const now = deps.clock.now();
  const token = randomToken(32);
  const ownerId = newId();
  const deviceHash = ensureDeviceCookie(deps, request, reply);
  const session = await deps.db.transaction().execute(async (trx) => {
    await trx.insertInto('owners').values({ id: ownerId, kind: 'anonymous' }).execute();
    return trx
      .insertInto('anonymousSessions')
      .values({
        id: newId(),
        ownerId,
        tokenHash: sha256Hex(token),
        turnstileVerifiedAt: input.turnstileVerifiedAt,
        deviceHash,
        ipHash: ipHashOf(deps, request),
        timezone: input.timezone && isValidTimeZone(input.timezone) ? input.timezone : null,
        countryCode: 'US',
        lastSeenAt: now,
        expiresAt: addMs(now, ANONYMOUS_SESSION_IDLE_MS),
        gpcSignaledAt: hasGpcSignal(request) ? now : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  setSessionCookie(deps, reply, token, ANONYMOUS_SESSION_MAX_MS);
  const auth: AuthState = { session, ownerId, user: null, roles: [], audience: { roles: [] } };
  resolved.set(request, Promise.resolve(auth));
  return auth;
}

/**
 * Auth level `session`. A request without a valid session may carry `X-Turnstile-Token`: a token
 * that verifies creates the session on the spot, under the same per-IP creation limit as
 * `POST /v1/sessions`; otherwise `VERIFICATION_REQUIRED` tells the client to run the widget (and
 * call `POST /v1/sessions`).
 */
export async function requireSession(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthState> {
  const auth = await currentAuth(deps, request);
  if (auth) {
    if (auth.session.turnstileVerifiedAt || auth.user) return auth;
    if (!(await requestTokenVerified(deps, request))) {
      throw new AppError('VERIFICATION_REQUIRED', {});
    }
    const session = await deps.db
      .updateTable('anonymousSessions')
      .set({ turnstileVerifiedAt: deps.clock.now() })
      .where('id', '=', auth.session.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...auth, session };
  }
  if (turnstileTokenOf(request)) {
    await enforceSessionCreationLimit(deps, request, reply);
    if (await requestTokenVerified(deps, request)) {
      return createAnonymousSession(deps, request, reply, {
        turnstileVerifiedAt: deps.clock.now(),
      });
    }
  }
  throw new AppError('VERIFICATION_REQUIRED', {});
}

/** Auth level `user`: a signed-in session. */
export async function requireUser(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthState & { user: User }> {
  const auth = await requireSession(deps, request, reply);
  if (!auth.user) throw forbidden();
  return auth as AuthState & { user: User };
}

/** The per-session CSRF token for the internal API: an HMAC of the session, never stored. */
export function csrfTokenFor(deps: Pick<ApiDeps, 'config'>, session: AnonymousSession): string {
  return hmacSha256Hex(deps.config.sessionSecret, `csrf:${session.id}:${session.tokenHash}`).slice(
    0,
    43,
  );
}

/**
 * Rewrites one session after sign-in: new owner, the signed-in lifetime and a new token. The row
 * keeps its id, so claims and audit rows still refer to it, but the cookie value it had while
 * anonymous stops working. Returns the new cookie value and the updated row.
 */
export async function attachSessionToOwner(
  deps: ApiDeps,
  sessionId: string,
  ownerId: string,
  db: DbOrTx = deps.db,
): Promise<{ token: string; session: AnonymousSession }> {
  const now = deps.clock.now();
  const token = randomToken(32);
  const session = await db
    .updateTable('anonymousSessions')
    .set({
      ownerId,
      tokenHash: sha256Hex(token),
      lastSeenAt: now,
      expiresAt: addMs(now, USER_SESSION_IDLE_MS),
    })
    .where('id', '=', sessionId)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { token, session };
}
