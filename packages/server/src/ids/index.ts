import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock/index.js';
import { systemClock } from '../clock/index.js';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TIMESTAMP_MS = 2 ** 48 - 1;
const COUNTER_MAX = 0xfff;

export interface UuidV7Generator {
  (): string;
}

/**
 * Creates a UUID version 7 generator (RFC 9562 section 5.7): a 48-bit big-endian Unix timestamp in
 * milliseconds, the version, 12 bits of `rand_a` used as a monotonic counter within one
 * millisecond (section 6.2, method 1), the variant, and 62 random bits. IDs from one generator
 * sort in creation order even within a millisecond.
 */
export function createUuidV7Generator(clock: Clock = systemClock): UuidV7Generator {
  let lastMs = -1;
  let counter = 0;
  return () => {
    let ms = clock.now().getTime();
    if (ms <= lastMs) {
      ms = lastMs;
      counter += 1;
      if (counter > COUNTER_MAX) {
        ms = lastMs + 1;
        counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
      }
    } else {
      counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
    }
    if (ms < 0 || ms > MAX_TIMESTAMP_MS) throw new RangeError(`Timestamp out of range: ${ms}`);
    lastMs = ms;
    return formatUuidV7(ms, counter, randomBytes(8));
  };
}

/** Formats a UUIDv7 from its timestamp, 12-bit `rand_a` and 8 random bytes for `rand_b`. */
export function formatUuidV7(timestampMs: number, randA: number, randB: Uint8Array): string {
  const bytes = new Uint8Array(16);
  let ts = timestampMs;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | ((randA >> 8) & 0x0f);
  bytes[7] = randA & 0xff;
  bytes[8] = 0x80 | ((randB[0] ?? 0) & 0x3f);
  for (let i = 1; i < 8; i += 1) bytes[8 + i] = randB[i] ?? 0;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const defaultGenerator = createUuidV7Generator();

/** A new UUID version 7 (time-ordered) entity ID. */
export function uuidv7(): string {
  return defaultGenerator();
}

/** Alias used by domain code: every entity ID comes from here. */
export const newId = uuidv7;

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

/** The Unix timestamp embedded in a UUIDv7. */
export function uuidV7Timestamp(id: string): Date {
  if (!isUuidV7(id)) throw new RangeError(`Not a UUIDv7: ${id}`);
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number.parseInt(hex, 16));
}

/** A random token of `byteLength` bytes, encoded base64url (128-bit share tokens, 256-bit cookies). */
export function randomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Lower-case hex SHA-256 of a string or bytes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Lower-case hex HMAC-SHA-256. */
export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Hash with a daily rotating salt (session and IP hashes in analytics and abuse signals): the
 * same input hashes identically within one UTC day and differently on the next.
 */
export function dailySaltedHash(secret: string, value: string, instant: Date): string {
  const day = instant.toISOString().slice(0, 10);
  return hmacSha256Hex(`${secret}:${day}`, value);
}
