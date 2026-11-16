import { describe, expect, it } from 'vitest';
import { testConfig } from '../config/index.js';
import { uuidv7 } from '../ids/index.js';
import { evaluatePermission } from '../policy/index.js';
import { StorageWriteRefusedError, createStorage } from './client.js';
import { UnsafeKeyError, isHeldKey, keys } from './keys.js';

describe('object keys', () => {
  const owner = uuidv7();
  const asset = uuidv7();
  const job = uuidv7();

  it('builds the documented prefixes from opaque identifiers', () => {
    expect(keys.quarantine(asset)).toBe(`quarantine/${asset}`);
    expect(keys.original(owner, asset)).toBe(`originals/${owner}/${asset}`);
    expect(keys.working(job, 'working.jpg')).toBe(`working/${job}/working.jpg`);
    expect(keys.attempt(job, asset, 'raw.png')).toBe(`attempts/${job}/${asset}/raw.png`);
    expect(keys.output(owner, asset, 'full.jpg')).toBe(`outputs/${owner}/${asset}/full.jpg`);
    expect(keys.download(owner, asset)).toBe(`downloads/${owner}/${asset}`);
    expect(keys.held(job, 'originals/x/y')).toMatch(new RegExp(`^held/${job}/[0-9a-f]{64}$`));
    expect(keys.card('AbCdEfGhIjKlMnOpQrStUv')).toBe('cards/AbCdEfGhIjKlMnOpQrStUv.jpg');
    expect(keys.shared('AbCdEfGhIjKlMnOpQrStUv', 'after')).toBe(
      'shared/AbCdEfGhIjKlMnOpQrStUv/after.jpg',
    );
    expect(keys.hero(asset, 'landscape', 'w1600', 'webp')).toBe(
      `hero/${asset}/landscape-w1600.webp`,
    );
    expect(keys.example(asset, 'before', 'jpg')).toBe(`examples/${asset}/before.jpg`);
    expect(isHeldKey(keys.held(job, 'a'))).toBe(true);
    expect(keys.tombstoneLog('2026-11-09', job)).toBe(`tombstones/2026-11-09/${job}.jsonl`);
    expect(keys.enhancedPrefix(owner, asset)).toBe(`enhanced/${owner}/${asset}/`);
    expect(keys.enhanced(owner, asset, job)).toBe(`enhanced/${owner}/${asset}/${job}.png`);
    expect(keys.enhanced(owner, asset, job).startsWith(keys.enhancedPrefix(owner, asset))).toBe(
      true,
    );
  });

  it('refuses anything that is not an opaque identifier', () => {
    expect(() => keys.original('14 Lantern Hill Rd', asset)).toThrow(UnsafeKeyError);
    expect(() => keys.quarantine('../etc/passwd')).toThrow(UnsafeKeyError);
    expect(() => keys.working(job, 'My House.jpg')).toThrow(UnsafeKeyError);
    expect(() => keys.card('short')).toThrow(UnsafeKeyError);
    expect(() => keys.hero(asset, 'landscape', 'w1', 'gif')).toThrow(UnsafeKeyError);
    expect(() => keys.tombstoneLog('2026-11-9', job)).toThrow(UnsafeKeyError);
    expect(() => keys.tombstoneLog('2026-11-09', '../x')).toThrow(UnsafeKeyError);
    expect(() => keys.enhancedPrefix('owner', asset)).toThrow(UnsafeKeyError);
    expect(() => keys.enhanced(owner, '../x', job)).toThrow(UnsafeKeyError);
    expect(() => keys.enhanced(owner, asset, 'enhanced')).toThrow(UnsafeKeyError);
  });
});

describe('Street View write refusal', () => {
  const storage = createStorage(testConfig(), { buckets: { private: 'test-unused' } });
  const now = new Date();
  const policy = {
    display: 'allowed',
    store: 'denied',
    aiProcess: 'allowed',
    edit: 'allowed',
    distributeDerivative: 'unknown',
    commerceAdjacent: 'unknown',
    evidenceRef: 'grant:transient',
    attributionText: null,
    expiresAt: null,
    revokedAt: null,
    territory: 'US',
  } as const;
  const transient = evaluatePermission({
    policy,
    capabilityState: 'live_private',
    appEnv: 'staging',
    contributorImagery: 'decorate',
    now,
  });
  const write = (provenance: Parameters<typeof storage.put>[0]['provenance']) =>
    storage.put({
      bucket: 'private',
      key: keys.working(uuidv7(), 'working.jpg'),
      body: 'pixels',
      contentType: 'image/jpeg',
      provenance,
    });

  it('refuses Street View pixels without an evaluated permission or without store', async () => {
    await expect(write({ sourceKind: 'street_view' })).rejects.toBeInstanceOf(
      StorageWriteRefusedError,
    );
    await expect(write({ sourceKind: 'street_view', permission: transient })).rejects.toThrow(
      /store permission/,
    );
  });

  it('refuses a Street View derivative without edit permission', async () => {
    await expect(
      write({
        sourceKind: 'street_view',
        derivative: true,
        permission: { ...transient, edit: false },
      }),
    ).rejects.toThrow(/edit permission/);
  });
});
