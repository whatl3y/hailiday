import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Places autocomplete session tokens are UUID v4 strings the server mints for one session: the
 * first 8 bytes are random (with the version nibble), the last 8 an HMAC of the session ID and
 * those bytes (with the variant bits). Any instance can verify a token without shared state, a
 * token works only for the session it was minted for, and a client cannot invent one.
 */
function mac(secret: string, sessionId: string, nonce: Buffer): Buffer {
  const digest = createHmac('sha256', secret)
    .update(`places-session-token:${sessionId}:${nonce.toString('hex')}`)
    .digest()
    .subarray(0, 8);
  digest[0] = (digest[0]! & 0x3f) | 0x80;
  return digest;
}

function format(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mints a token bound to `sessionId`. */
export function mintPlacesSessionToken(secret: string, sessionId: string): string {
  const nonce = randomBytes(8);
  nonce[6] = (nonce[6]! & 0x0f) | 0x40;
  return format(Buffer.concat([nonce, mac(secret, sessionId, nonce)]));
}

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `token` was minted by this server for `sessionId`. */
export function verifyPlacesSessionToken(
  secret: string,
  sessionId: string,
  token: string,
): boolean {
  const normalized = token.toLowerCase();
  if (!TOKEN_PATTERN.test(normalized)) return false;
  const bytes = Buffer.from(normalized.replace(/-/g, ''), 'hex');
  const expected = mac(secret, sessionId, bytes.subarray(0, 8));
  return timingSafeEqual(bytes.subarray(8), expected);
}
