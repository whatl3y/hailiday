import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../config/index.js';
import { uuidv7 } from '../ids/index.js';
import { initializeBuckets } from '../storage-init.js';
import { createStorage, type LifecycleRule } from './client.js';
import { isHeldKey, keys } from './keys.js';
import { lifecycleRulesFor } from './lifecycle.js';

const config = testConfig();
const storage = createStorage(config, {
  buckets: { private: 'test-holiday-private', public: 'test-holiday-public' },
});

beforeAll(async () => {
  for (const bucket of [storage.buckets.private, storage.buckets.public]) {
    await storage.ensureBucket(bucket);
    await storage.putBucketCors(bucket, config.storage.corsOrigins);
  }
  await storage.putPublicReadPolicy(storage.buckets.public);
});

afterAll(async () => {
  await storage.deletePrefix('private', 'quarantine/');
  await storage.deletePrefix('private', 'originals/');
  await storage.deletePrefix('public', 'examples/');
  storage.destroy();
});

describe('object storage', () => {
  it('puts, heads, gets, copies and deletes objects', async () => {
    const owner = uuidv7();
    const asset = uuidv7();
    const key = keys.original(owner, asset);
    await storage.put({
      bucket: 'private',
      key,
      body: Buffer.from('normalized-original'),
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    const head = await storage.head('private', key);
    expect(head).toMatchObject({ contentLength: 19, contentType: 'image/jpeg' });
    expect(head?.metadata['source-kind']).toBe('upload');
    expect((await storage.get('private', key))?.body.toString()).toBe('normalized-original');

    const publicKey = keys.example(asset, 'after', 'jpg');
    await storage.copy({
      from: { bucket: 'private', key },
      to: { bucket: 'public', key: publicKey },
      cacheControl: 'public, max-age=31536000, immutable',
      provenance: { sourceKind: 'system' },
    });
    const publicResponse = await fetch(storage.publicUrl(publicKey));
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toBe('normalized-original');

    expect(await storage.list('private', `originals/${owner}/`)).toEqual([key]);
    await storage.delete('private', key);
    expect(await storage.head('private', key)).toBeNull();
    expect(await storage.get('private', key)).toBeNull();
  });

  it('serves private objects only through presigned GET URLs', async () => {
    const key = keys.original(uuidv7(), uuidv7());
    await storage.put({
      bucket: 'private',
      key,
      body: 'secret-pixels',
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'fixture' },
    });
    const url = await storage.presignGet('private', key, { expiresInSeconds: 60 });
    expect(url.startsWith(config.storage.publicEndpoint)).toBe(true);
    expect(url).toContain('X-Amz-Expires=60');
    const signed = await fetch(url);
    expect(signed.status).toBe(200);
    expect(await signed.text()).toBe('secret-pixels');
    expect(signed.headers.get('cache-control')).toBe('private, no-store');
    const unsigned = await fetch(
      `${config.storage.publicEndpoint}/${storage.buckets.private}/${key}`,
    );
    expect(unsigned.status).toBe(403);
    expect(await storage.presignGet('private', key, { expiresInSeconds: 99_999 })).toContain(
      'X-Amz-Expires=900',
    );
  });

  it('accepts presigned POST uploads only within the size range and declared type', async () => {
    const upload = async (key: string, body: Buffer, contentType: string, maxBytes = 1024) => {
      const policy = await storage.presignUpload({ key, contentType: 'image/jpeg', maxBytes });
      expect(policy.url.startsWith(config.storage.publicEndpoint)).toBe(true);
      const form = new FormData();
      for (const [name, value] of Object.entries(policy.fields)) form.append(name, value);
      form.set('Content-Type', contentType);
      form.append('file', new Blob([new Uint8Array(body)], { type: contentType }));
      return fetch(policy.url, { method: 'POST', body: form });
    };

    const okKey = keys.quarantine(uuidv7());
    const ok = await upload(okKey, Buffer.alloc(100, 1), 'image/jpeg');
    expect(ok.status).toBeLessThan(300);
    expect((await storage.head('private', okKey))?.contentLength).toBe(100);

    const tooLargeKey = keys.quarantine(uuidv7());
    const tooLarge = await upload(tooLargeKey, Buffer.alloc(2048, 1), 'image/jpeg');
    expect(tooLarge.status).toBeGreaterThanOrEqual(400);
    expect(await storage.head('private', tooLargeKey)).toBeNull();

    const wrongTypeKey = keys.quarantine(uuidv7());
    const wrongType = await upload(wrongTypeKey, Buffer.alloc(100, 1), 'image/png');
    expect(wrongType.status).toBeGreaterThanOrEqual(400);
    expect(await storage.head('private', wrongTypeKey)).toBeNull();
  });
});

describe('bucket lifecycle backstop', () => {
  it('defines a rule for every swept prefix and none for held/', () => {
    const privateRules = lifecycleRulesFor('private');
    expect(
      Object.fromEntries(privateRules.map((rule) => [rule.prefix, rule.expirationDays])),
    ).toEqual({
      'quarantine/': 1,
      'working/': 2,
      'attempts/': 8,
      'reviews/': 8,
      'tombstones/': 61,
    });
    expect(lifecycleRulesFor('public').map((rule) => [rule.prefix, rule.expirationDays])).toEqual([
      ['shared/', 31],
      ['cards/', 31],
    ]);
    for (const rule of [...privateRules, ...lifecycleRulesFor('public')]) {
      expect(rule.prefix).toBeDefined();
      expect(rule.prefix).not.toBe('');
      expect(isHeldKey(rule.prefix ?? '')).toBe(false);
      expect(rule.prefix?.startsWith('originals') ?? false).toBe(false);
    }
  });

  it('has no tag rule: nothing writes object tags, so such a rule could never match', () => {
    for (const bucket of ['private', 'public'] as const) {
      expect(lifecycleRulesFor(bucket).filter((rule) => rule.tag !== undefined)).toEqual([]);
    }
  });

  it('storage-init applies the rules to both buckets (or reports an endpoint without support)', async () => {
    const calls: { bucket: string; ids: string[] }[] = [];
    const recording = {
      ...storage,
      putLifecycleRules: async (bucket: string, rules: readonly LifecycleRule[]) => {
        calls.push({ bucket, ids: rules.map((rule) => rule.id) });
        return storage.putLifecycleRules(bucket, rules);
      },
    };
    const result = await initializeBuckets(recording, { corsOrigins: config.storage.corsOrigins });
    expect(calls.map((call) => call.bucket)).toEqual([
      storage.buckets.private,
      storage.buckets.public,
    ]);
    expect(calls[0]?.ids).toContain('quarantine');
    expect(calls[1]?.ids).toEqual(['shared-copies', 'share-cards']);
    const applied = await storage.getLifecycleRules(storage.buckets.private);
    if (result.private.lifecycleApplied && applied) {
      expect(applied.map((rule) => rule.id).sort()).toEqual(
        lifecycleRulesFor('private')
          .map((rule) => rule.id)
          .sort(),
      );
      expect(applied.some((rule) => rule.prefix?.startsWith('held/'))).toBe(false);
    } else {
      expect(result.private.lifecycleApplied).toBe(false);
    }
  });

  it('records CDN purges when no CDN is configured', async () => {
    await storage.purgePublic(['cards/AbCdEfGhIjKlMnOpQrStUv.jpg']);
    expect(storage.cdn.kind).toBe('none');
    expect((storage.cdn as unknown as { purged: string[] }).purged).toContain(
      'cards/AbCdEfGhIjKlMnOpQrStUv.jpg',
    );
  });
});
