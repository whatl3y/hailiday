import { createHmac, timingSafeEqual } from 'node:crypto';

/** Decodes a URL-safe base64 string (Google signing secrets use `-` and `_`). */
export function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Encodes bytes as URL-safe base64, keeping `=` padding as Google's signer does. */
export function encodeBase64UrlPadded(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Google Maps Platform URL signature: HMAC-SHA1 over the path and query of the URL (everything
 * from the path through the query string, before `&signature=`), keyed with the URL-safe
 * base64-decoded signing secret, encoded as URL-safe base64.
 */
export function googleUrlSignature(pathAndQuery: string, signingSecret: string): string {
  const key = decodeBase64Url(signingSecret);
  const digest = createHmac('sha1', key).update(pathAndQuery).digest();
  return encodeBase64UrlPadded(digest);
}

/** Appends `signature=` to a Google Maps Platform URL. */
export function signGoogleUrl(url: string, signingSecret: string): string {
  const parsed = new URL(url);
  const pathAndQuery = `${parsed.pathname}${parsed.search}`;
  const signature = googleUrlSignature(pathAndQuery, signingSecret);
  return `${url}${parsed.search ? '&' : '?'}signature=${signature}`;
}

function hmacBase64Url(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Canonical form of the fixture Street View parameters that the signature covers. */
export function fixtureStreetViewCanonical(params: {
  pano: string;
  heading: string | number;
  fov: string | number;
  pitch: string | number;
  size: string;
}): string {
  return `pano=${params.pano}&heading=${params.heading}&fov=${params.fov}&pitch=${params.pitch}&size=${params.size}`;
}

/** Signature of a fixture Street View display URL (HMAC-SHA256 with `SESSION_SECRET`). */
export function signFixtureStreetView(
  secret: string,
  params: Parameters<typeof fixtureStreetViewCanonical>[0],
): string {
  return hmacBase64Url(`fixture-streetview:${secret}`, fixtureStreetViewCanonical(params)).slice(
    0,
    32,
  );
}

/** Verifies a fixture Street View display URL signature in constant time. */
export function verifyFixtureStreetView(
  secret: string,
  params: Parameters<typeof fixtureStreetViewCanonical>[0] & { sig: string },
): boolean {
  return constantTimeEqual(signFixtureStreetView(secret, params), params.sig);
}

/**
 * A signed, session-bound, expiring token: `v1.<payload>.<mac>` where the payload is base64url
 * JSON. Used for manual-entry geocode candidates so resolving one needs no second Geocoding call
 * and nothing is stored before the user chooses.
 */
export function signToken<T extends object>(
  secret: string,
  purpose: string,
  payload: T,
  options: { sessionId: string; expiresAt: Date },
): string {
  const body = Buffer.from(
    JSON.stringify({
      p: payload,
      s: hmacBase64Url(secret, `session:${options.sessionId}`).slice(0, 22),
      e: options.expiresAt.getTime(),
    }),
  ).toString('base64url');
  const mac = hmacBase64Url(`${purpose}:${secret}`, `v1.${body}`);
  return `v1.${body}.${mac}`;
}

/** Verifies a token from `signToken`; returns its payload, or null when invalid or expired. */
export function verifyToken<T>(
  secret: string,
  purpose: string,
  token: string,
  options: { sessionId: string; now: Date },
): T | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, body, mac] = parts as [string, string, string];
  if (!constantTimeEqual(hmacBase64Url(`${purpose}:${secret}`, `v1.${body}`), mac)) return null;
  let decoded: { p?: T; s?: string; e?: number };
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof decoded;
  } catch {
    return null;
  }
  const sessionMac = hmacBase64Url(secret, `session:${options.sessionId}`).slice(0, 22);
  if (typeof decoded.s !== 'string' || !constantTimeEqual(decoded.s, sessionMac)) return null;
  if (typeof decoded.e !== 'number' || decoded.e <= options.now.getTime()) return null;
  return decoded.p ?? null;
}
