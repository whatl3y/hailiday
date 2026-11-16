import { afterAll, describe, expect, it } from 'vitest';
import { testConfig } from '../config/index.js';
import { toJson } from '../db/client.js';
import { createTestDb } from '../db/testing.js';
import { createCapabilities } from '../capabilities/index.js';
import { createSettings, seedSettingDefaults } from './index.js';

const db = createTestDb();
afterAll(() => db.destroy());

describe('runtime settings', () => {
  it('reads defaults, writes with optimistic versions and rejects stale writes', async () => {
    const settings = createSettings(db, { config: testConfig(), cacheTtlMs: 0 });
    const key = 'rate.geocode_per_session_10m';
    expect(await settings.get(key)).toBe(10);
    const written = await settings.set(key, 12, { expectedVersion: 0 });
    expect(written.version).toBe(1);
    expect(await settings.get(key)).toBe(12);
    await expect(settings.set(key, 13, { expectedVersion: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'version_conflict', currentVersion: 1 },
    });
    await expect(settings.set(key, -1, { expectedVersion: 1 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(settings.set('unknown.key', 1, { expectedVersion: 0 })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('keeps seeded version-0 rows on the configured default', async () => {
    await seedSettingDefaults(db, testConfig());
    const overridden = createSettings(db, {
      config: testConfig({ POLL_RENDER_MS: '2500' }),
      cacheTtlMs: 0,
    });
    const record = await overridden.getRecord('poll.render_ms');
    expect(record).toMatchObject({ value: 2500, version: 0, isDefault: true });
    expect(await overridden.reviewModeFor('interior')).toBe('sampled_audit');
  });

  it('reads the current vision ceiling over a seeded row holding an earlier default', async () => {
    const key = 'spend.sku_daily_micros.vision_call';
    await seedSettingDefaults(db, testConfig());
    await db
      .updateTable('runtimeSettings')
      .set({ value: toJson(170_000_000) })
      .where('key', '=', key)
      .where('version', '=', 0)
      .execute();
    const settings = createSettings(db, { config: testConfig(), cacheTtlMs: 0 });
    expect(await settings.skuDailyCeilingMicros('vision_call')).toBe(280_000_000);
    await seedSettingDefaults(db, testConfig());
    const row = await db
      .selectFrom('runtimeSettings')
      .select(['value', 'version'])
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ value: 280_000_000, version: 0 });
  });
});

describe('capabilities', () => {
  it('changes states with optimistic versions and requires confirm for live_public', async () => {
    const capabilities = createCapabilities(db, { appEnv: 'test', cacheTtlMs: 0 });
    const base = {
      countryCode: 'ZZ',
      capability: 'uploads' as const,
      evidenceRef: 'test:evidence',
      reviewedAt: new Date(),
      reviewedBy: null,
    };
    const { after } = await capabilities.set({ ...base, state: 'fixture', expectedVersion: 0 });
    expect(after.version).toBe(1);
    await expect(
      capabilities.set({ ...base, state: 'live_public', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const updated = await capabilities.set({
      ...base,
      state: 'live_public',
      expectedVersion: 1,
      confirm: true,
    });
    expect(updated.before?.state).toBe('fixture');
    expect(updated.after).toMatchObject({ state: 'live_public', version: 2 });
    expect(await capabilities.mode('ZZ', 'uploads', { roles: [] })).toBe('live');
    await expect(
      capabilities.set({ ...base, state: 'fixture', expectedVersion: 1 }),
    ).rejects.toMatchObject({ details: { reason: 'version_conflict', currentVersion: 2 } });
  });
});
