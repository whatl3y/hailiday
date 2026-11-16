import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createManualClock } from '../clock/index.js';
import { testConfig } from '../config/index.js';
import { loadContent, publishExamplePlaceholders } from '../content/index.js';
import { newId } from '../ids/index.js';
import { toJson } from './client.js';
import { createSilentLogger } from '../logger/index.js';
import { runSeed } from './seed.js';
import { createTestDb } from './testing.js';

const db = createTestDb();
afterAll(() => db.destroy());

const TABLES = [
  'country_capabilities',
  'runtime_settings',
  'holiday_pack_versions',
  'style_kits',
  'kit_items',
  'merchant_programs',
  'products',
  'offers',
  'hero_assets',
  'holiday_occurrences',
  'example_assets',
] as const;

async function counts(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of TABLES) {
    const scope = table === 'country_capabilities' ? sql`where country_code = 'US'` : sql``;
    const row = await sql<{
      count: number;
    }>`select count(*)::int as count from ${sql.table(table)} ${scope}`.execute(db);
    result[table] = row.rows[0]?.count ?? 0;
  }
  return result;
}

describe('seed', () => {
  it('is idempotent and publishes content, capabilities and settings', async () => {
    const config = testConfig();
    const content = await loadContent();
    const clock = createManualClock('2026-11-09T15:00:00.000Z');
    const logger = createSilentLogger();
    await runSeed({ db, config, logger, clock, content });
    const first = await counts();
    const ids = await db
      .selectFrom('offers')
      .select(['id', 'offerKey'])
      .orderBy('offerKey')
      .execute();

    clock.advance(60_000);
    const second = await runSeed({ db, config, logger, clock, content });
    expect(await counts()).toEqual(first);
    expect(
      await db.selectFrom('offers').select(['id', 'offerKey']).orderBy('offerKey').execute(),
    ).toEqual(ids);
    const unchanged = second.steps.filter((step) =>
      [
        'country_capabilities',
        'runtime_settings',
        'holiday_pack_versions',
        'style_kits',
        'hero_assets',
        'holiday_occurrences',
        'example_assets',
      ].includes(step.name),
    );
    for (const step of unchanged) {
      expect(
        Object.values(step.counts).every((count) => count === 0),
        step.name,
      ).toBe(true);
    }

    expect(first.country_capabilities).toBe(8 + content.commerce.catalog.merchantPrograms.length);
    expect(first.holiday_pack_versions).toBe(content.packs.length);
    expect(first.style_kits).toBe(content.kits.length);
    expect(first.holiday_occurrences).toBe(3 * 4);
    expect(first.hero_assets).toBe(content.heroes.length);
    expect(first.example_assets).toBe(content.examples.length);

    const capabilities = await db
      .selectFrom('countryCapabilities')
      .select(['capability', 'state'])
      .where('countryCode', '=', 'US')
      .execute();
    expect(capabilities.every((row) => row.state === 'fixture')).toBe(true);
    expect(capabilities.map((row) => row.capability)).toContain('commerce:fixture_decor_us');

    const christmas = await db
      .selectFrom('holidayOccurrences')
      .innerJoin(
        'holidayPackVersions',
        'holidayPackVersions.id',
        'holidayOccurrences.packVersionId',
      )
      .select([
        'holidayOccurrences.enabled',
        'holidayOccurrences.promotionStart',
        'holidayOccurrences.heroAssetId',
        'holidayPackVersions.version',
        'holidayPackVersions.majorMinor',
      ])
      .where('holidayOccurrences.occurrenceKey', '=', 'christmas.US.2026')
      .executeTakeFirstOrThrow();
    expect(christmas).toMatchObject({
      enabled: true,
      promotionStart: '2026-11-27',
      version: '2.0.0',
      majorMinor: '2.0',
    });
    expect(christmas.heroAssetId).not.toBeNull();
    const nye = await db
      .selectFrom('holidayOccurrences')
      .select('enabled')
      .where('occurrenceKey', '=', 'new_years_eve.US.2026')
      .executeTakeFirstOrThrow();
    expect(nye.enabled).toBe(false);

    const unlinked = await db
      .selectFrom('kitItems')
      .select('kitItemId')
      .where('currentProductId', 'is', null)
      .execute();
    expect(unlinked).toEqual([]);

    const offer = await db
      .selectFrom('offers')
      .select(['lastVerifiedAt'])
      .where('offerKey', '=', 'offer_foam_jack_o_lanterns_lit__home_garden')
      .executeTakeFirstOrThrow();
    // Authored 2026-11-09T06:00Z relative to 12:00Z; rebased onto the seed clock.
    expect(offer.lastVerifiedAt?.toISOString()).toBe('2026-11-09T09:01:00.000Z');

    const setting = await db
      .selectFrom('runtimeSettings')
      .select(['value', 'version'])
      .where('key', '=', 'allowance.variants_per_24h')
      .executeTakeFirstOrThrow();
    expect(setting).toEqual({ value: 3, version: 0 });
  });

  it('stops showing an example whose specification left the content', async () => {
    const content = await loadContent();
    const options = { now: new Date('2026-11-10T15:00:00.000Z'), refresh: true };
    // Rolled back at the end, so the shared test database keeps its example rows as they were.
    const rollback = new Error('rollback');
    const run = db.transaction().execute(async (trx) => {
      await publishExamplePlaceholders(trx, content, options);
      const kept = content.examples[0];
      if (!kept) throw new Error('no example in content');
      const template = await trx
        .selectFrom('exampleAssets')
        .selectAll()
        .where('assetKey', '=', kept.exampleId)
        .executeTakeFirstOrThrow();
      await trx
        .updateTable('exampleAssets')
        .set({ active: true })
        .where('assetKey', '=', kept.exampleId)
        .execute();
      const retiredKey = 'example.thanksgiving_us.interior.classic.evening.v1';
      await trx
        .insertInto('exampleAssets')
        .values({
          id: newId(),
          assetKey: retiredKey,
          holidayId: 'thanksgiving_us',
          sceneType: 'interior',
          style: 'classic',
          lightingMode: 'evening',
          sourceAssetId: null,
          renderAssetId: null,
          packVersion: '1.0.1',
          beforeCdnPath: template.beforeCdnPath,
          afterCdnPath: template.afterCdnPath,
          width: template.width,
          height: template.height,
          captionKey: 'example.thanksgiving_us.interior',
          rights: toJson(template.rights),
          approvedAt: template.approvedAt,
          active: true,
        })
        .execute();

      expect(await publishExamplePlaceholders(trx, content, options)).toEqual({ exampleAssets: 1 });
      const rows = await trx
        .selectFrom('exampleAssets')
        .select(['assetKey', 'active'])
        .where('assetKey', 'in', [kept.exampleId, retiredKey])
        .orderBy('assetKey')
        .execute();
      expect(Object.fromEntries(rows.map((row) => [row.assetKey, row.active]))).toEqual({
        [kept.exampleId]: true,
        [retiredKey]: false,
      });
      expect(await publishExamplePlaceholders(trx, content, options)).toEqual({ exampleAssets: 0 });
      throw rollback;
    });
    await expect(run).rejects.toBe(rollback);
  });
});
