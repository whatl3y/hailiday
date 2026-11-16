import type { FastifyReply, FastifyRequest } from 'fastify';
import { isValidTimeZone, normalizeEmail, type UserRole } from '@hailiday/core';
import type { Audience } from '@hailiday/server/capabilities';
import { DAY_MS, HOUR_MS, MINUTE_MS, addMs } from '@hailiday/server/clock';
import type { AnonymousSession, DbOrTx, User } from '@hailiday/server/db';
import { AppError, forbidden } from '@hailiday/server/errors';
import {
  dailySaltedHash,
  hmacSha256Hex,
  newId,
  randomToken,
  sha256Hex,
} from '@hailiday/server/ids';
import { verifyTurnstile } from '@hailiday/server/turnstile';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { ipHashOf } from './ip.js';
import { enforceSessionCreationLimit } from './limits.js';

export { ipHashOf };

/** The session cookie on local stacks, where it is sent over plain HTTP without `Secure`. */
export const SESSION_COOKIE = 'hailiday_session';
/**
 * The session cookie wherever it is issued with `Secure`: the `__Host-` prefix makes the browser
 * accept it only with `Secure`, `Path=/` and no `Domain`, so a sibling subdomain or a plain-HTTP
 * page cannot plant or overwrite it.
 */
export const SECURE_SESSION_COOKIE = '__Host-hailiday_session';

/** Whether the session and device cookies carry `Secure` (everywhere except local stacks). */
function secureCookies(config: Pick<ApiDeps['config'], 'isLocal'>): boolean {
  return !config.isLocal;
}

/** The name the session cookie is issued and read under for this configuration. */
export function sessionCookieName(config: Pick<ApiDeps['config'], 'isLocal'>): string {
  return secureCookies(config) ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}
/** A random per-browser identifier that keys the device dimension of the render backstop. */
export const DEVICE_COOKIE = 'hailiday_device';
/** Browsers cap cookie lifetimes at 400 days. */
const DEVICE_COOKIE_MAX_MS = 400 * DAY_MS;
/** `randomToken(16)`: 128 random bits, base64url. */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * While time-based deletion is on, anonymous sessions follow anonymous projects: 24 h after last
 * activity, at most 7 days.
 */
export const ANONYMOUS_SESSION_IDLE_MS = 24 * HOUR_MS;
export const ANONYMOUS_SESSION_MAX_MS = 7 * DAY_MS;
/**
 * While time-based deletion is off, an anonymous session lasts 400 days after its last activity
 * (the longest lifetime browsers give a cookie), and its cookie is refreshed on activity.
 */
export const ANONYMOUS_SESSION_KEPT_MS = 400 * DAY_MS;
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
/** Requests whose session was extended: the cookie value and the session's new expiry. */
const cookieRefreshes = new WeakMap<FastifyRequest, { token: string; expiresAt: Date }>();
/** Replies that already set or cleared the session cookie. */
const sessionCookieWritten = new WeakSet<FastifyReply>();

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

/** Whether projects and anonymous sessions expire by age and inactivity. */
function timeBasedDeletion(deps: Pick<ApiDeps, 'settings'>): Promise<boolean> {
  return deps.settings.get('retention.time_based_deletion');
}

/**
 * The lifetime of a new anonymous session: its first expiry and the cookie's maximum age. While
 * time-based deletion is off both are `ANONYMOUS_SESSION_KEPT_MS`.
 */
export async function anonymousSessionLifetime(
  deps: Pick<ApiDeps, 'settings'>,
): Promise<{ idleMs: number; cookieMaxAgeMs: number }> {
  return (await timeBasedDeletion(deps))
    ? { idleMs: ANONYMOUS_SESSION_IDLE_MS, cookieMaxAgeMs: ANONYMOUS_SESSION_MAX_MS }
    : { idleMs: ANONYMOUS_SESSION_KEPT_MS, cookieMaxAgeMs: ANONYMOUS_SESSION_KEPT_MS };
}

async function sessionExpiry(
  deps: Pick<ApiDeps, 'settings'>,
  session: Pick<AnonymousSession, 'createdAt'>,
  signedIn: boolean,
  now: Date,
): Promise<Date> {
  if (signedIn) return addMs(now, USER_SESSION_IDLE_MS);
  if (!(await timeBasedDeletion(deps))) return addMs(now, ANONYMOUS_SESSION_KEPT_MS);
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
 * `hailiday_device` cookie when it sends one; otherwise its user agent and language together with
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
 * Sets the `hailiday_device` cookie when the request carries none and returns the device key to
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
  setDeviceCookie(deps, reply, id);
  return deviceHashForId(deps, id);
}

/** Sets the `hailiday_device` cookie to `id` for the longest lifetime browsers allow. */
function setDeviceCookie(deps: Pick<ApiDeps, 'config'>, reply: FastifyReply, id: string): void {
  reply.setCookie(DEVICE_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(deps.config),
    path: '/',
    maxAge: Math.floor(DEVICE_COOKIE_MAX_MS / 1000),
  });
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

function cookieToken(deps: Pick<ApiDeps, 'config'>, request: FastifyRequest): string | null {
  const value = request.cookies?.[sessionCookieName(deps.config)];
  return value && value.length >= 16 && value.length <= 128 ? value : null;
}

async function loadAuth(
  deps: ApiDeps,
  request: FastifyRequest,
  touch: boolean,
): Promise<AuthState | null> {
  const token = cookieToken(deps, request);
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
  if (!touch) {
    // The signal is still recorded; the session's last-seen time and expiry stay as they are.
    if (gpc) {
      current =
        (await deps.db
          .updateTable('anonymousSessions')
          .set({ gpcSignaledAt: now })
          .where('id', '=', session.id)
          .returningAll()
          .executeTakeFirst()) ?? session;
    }
  } else if (gpc || now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const expiresAt = await sessionExpiry(deps, session, user !== null, now);
    const touched = await deps.db
      .updateTable('anonymousSessions')
      .set({ lastSeenAt: now, expiresAt, ...(gpc ? { gpcSignaledAt: now } : {}) })
      .where('id', '=', session.id)
      .returningAll()
      .executeTakeFirst();
    if (touched) {
      current = touched;
      if (touched.expiresAt > session.expiresAt) {
        cookieRefreshes.set(request, { token, expiresAt: touched.expiresAt });
      }
    }
  }
  const roles = effectiveRoles(deps, user);
  return { session: current, ownerId: current.ownerId, user, roles, audience: { roles } };
}

/**
 * The caller's session, or null when the request carries no valid session cookie. By default a
 * session last seen more than a minute ago is touched: its last-seen time and expiry move, and a
 * response no shared cache may store carries the refreshed cookie. With `touch: false` (pages a
 * shared cache may store, which never carry the cookie) the session is read only, so the next
 * private response still finds it due and refreshes the cookie.
 */
export function currentAuth(
  deps: ApiDeps,
  request: FastifyRequest,
  options: { touch?: boolean } = {},
): Promise<AuthState | null> {
  const cached = resolved.get(request);
  if (cached) return cached;
  if (options.touch === false) return loadAuth(deps, request, false);
  const promise = loadAuth(deps, request, true);
  resolved.set(request, promise);
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
  sessionCookieWritten.add(reply);
  reply.setCookie(sessionCookieName(deps.config), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(deps.config),
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(deps: Pick<ApiDeps, 'config'>, reply: FastifyReply): void {
  sessionCookieWritten.add(reply);
  reply.clearCookie(sessionCookieName(deps.config), {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies(deps.config),
    path: '/',
  });
}

/** Whether a response may only be stored by the browser (never by a shared cache). */
function isPrivateResponse(reply: FastifyReply): boolean {
  const cacheControl = String(reply.getHeader('cache-control') ?? '').toLowerCase();
  return /\b(no-store|private)\b/.test(cacheControl) && !/\bpublic\b/.test(cacheControl);
}

/**
 * Slides the session cookie with the session: when a request extended its session's expiry and
 * set or cleared no session cookie itself, a response that no shared cache may store sets the
 * same cookie value again with a maximum age that reaches the new expiry. The same response sets
 * the `hailiday_device` cookie the request carried again for another 400 days, so an active
 * browser keeps its device key as long as its session. Publicly cacheable responses (the landing
 * page) never carry either, so they read the session without touching it.
 */
export function registerSessionCookieRefresh(
  app: App,
  deps: Pick<ApiDeps, 'config' | 'clock'>,
): void {
  app.addHook('onSend', async (request, reply, payload) => {
    const refresh = cookieRefreshes.get(request);
    if (!refresh || sessionCookieWritten.has(reply) || !isPrivateResponse(reply)) return payload;
    const maxAgeMs = refresh.expiresAt.getTime() - deps.clock.now().getTime();
    if (maxAgeMs > 0) {
      setSessionCookie(deps, reply, refresh.token, maxAgeMs);
      const deviceId = deviceCookieId(request);
      if (deviceId) setDeviceCookie(deps, reply, deviceId);
    }
    return payload;
  });
}

/**
 * Creates an anonymous owner and session (after a verified Turnstile token, or with
 * `turnstileVerifiedAt` null when the next paid action must run the challenge) and sets the
 * cookie, plus the `hailiday_device` cookie when the browser has none. Only the SHA-256 hash of the
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
  const lifetime = await anonymousSessionLifetime(deps);
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
        expiresAt: addMs(now, lifetime.idleMs),
        gpcSignaledAt: hasGpcSignal(request) ? now : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
  setSessionCookie(deps, reply, token, lifetime.cookieMaxAgeMs);
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
