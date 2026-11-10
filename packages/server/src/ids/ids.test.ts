import { describe, expect, it } from 'vitest';
import { createManualClock } from '../clock/index.js';
import {
  createUuidV7Generator,
  dailySaltedHash,
  formatUuidV7,
  isUuidV7,
  randomToken,
  safeEqual,
  sha256Hex,
  uuidV7Timestamp,
  uuidv7,
} from './index.js';

describe('uuidv7', () => {
  it('produces RFC 9562 version 7 identifiers', () => {
    const id = uuidv7();
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('embeds the timestamp in the first 48 bits', () => {
    const clock = createManualClock('2026-11-09T12:00:00.000Z');
    const next = createUuidV7Generator(clock);
    expect(uuidV7Timestamp(next()).toISOString()).toBe('2026-11-09T12:00:00.000Z');
    expect(formatUuidV7(0x017f22e279b0, 0xcc3, new Uint8Array(8)).slice(0, 13)).toBe(
      '017f22e2-79b0',
    );
  });

  it('is strictly increasing within one millisecond and when the clock steps back', () => {
    const clock = createManualClock('2026-11-09T12:00:00.000Z');
    const next = createUuidV7Generator(clock);
    const ids = Array.from({ length: 5000 }, () => next());
    clock.advance(-5000);
    ids.push(...Array.from({ length: 10 }, () => next()));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects non-v7 values', () => {
    expect(isUuidV7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(() => uuidV7Timestamp('not-a-uuid')).toThrow(RangeError);
  });
});

describe('token helpers', () => {
  it('encodes random tokens as base64url of the requested size', () => {
    expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes, compares and salts deterministically', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'b')).toBe(false);
    expect(safeEqual('a', 'aa')).toBe(false);
    const day1 = new Date('2026-11-09T01:00:00Z');
    const day1Later = new Date('2026-11-09T23:00:00Z');
    const day2 = new Date('2026-11-10T00:00:01Z');
    expect(dailySaltedHash('s', 'session', day1)).toBe(dailySaltedHash('s', 'session', day1Later));
    expect(dailySaltedHash('s', 'session', day1)).not.toBe(dailySaltedHash('s', 'session', day2));
  });
});
