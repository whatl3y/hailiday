import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { createManualClock } from '../clock/index.js';
import { parseConfig, testConfig } from '../config/index.js';
import {
  loadContent,
  publishExamplePlaceholders,
  publishLookItems,
  publishSearchPhrases,
} from '../content/index.js';
import { newId } from '../ids/index.js';
import { toJson } from './client.js';
import { createSilentLogger } from '../logger/index.js';
import { runSeed, seedDefaultCapabilities } from './seed.js';
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
  'kit_item_search_phrases',
  'look_items',
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
    expect(first.kit_item_search_phrases).toBe(content.commerce.searchPhrases.length);
    expect(first.look_items).toBe(content.commerce.lookItems.length);
    expect(first.look_items).toBeGreaterThan(0);
    const commerce = second.steps.find((step) => step.name === 'commerce');
    expect(commerce?.counts).toMatchObject({ searchPhrases: 0, lookItems: 0 });

    const capabilities = await db
      .selectFrom('countryCapabilities')
      .select(['capability', 'state'])
      .where('countryCode', '=', 'US')
      .execute();
    expect(capabilities.every((row) => row.state === 'fixture')).toBe(true);
    expect(capabilities.map((row) => row.capability)).toContain('commerce:fixture_decor_us');
    expect(capabilities.map((row) => row.capability)).toContain('commerce:walmart_us');

    const programs = await db
      .selectFrom('merchantPrograms')
      .select(['programKey', 'kind', 'placement', 'searchUrlTemplate', 'displayRights'])
      .where('programKey', 'in', ['amazon_us', 'walmart_us', 'fixture_home_garden_us'])
      .orderBy('programKey')
      .execute();
    expect(programs).toEqual([
      {
        programKey: 'amazon_us',
        kind: 'real',
        placement: 'separate',
        searchUrlTemplate: 'https://www.amazon.com/s?k={query}',
        displayRights: {},
      },
      {
        programKey: 'fixture_home_garden_us',
        kind: 'fixture',
        placement: 'group',
        searchUrlTemplate: 'https://example.com/fixture-home-garden/search?q={query}',
        displayRights: expect.objectContaining({
          tracked_search_links: {
            state: 'allowed',
            evidence: 'Fixture data',
            recordedAt: '2026-11-01T00:00:00.000Z',
          },
        }),
      },
      {
        programKey: 'walmart_us',
        kind: 'real',
        placement: 'group',
        searchUrlTemplate: 'https://www.walmart.com/search?q={query}',
        displayRights: {},
      },
    ]);

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
      version: '2.1.0',
      majorMinor: '2.1',
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

  it('updates untouched search phrases and look items locally and never an operator edit', async () => {
    const config = testConfig();
    const content = await loadContent();
    const clock = createManualClock('2026-11-09T15:00:00.000Z');
    const logger = createSilentLogger();
    await runSeed({ db, config, logger, clock, content });
    const [phrase, untouchedPhrase] = content.commerce.searchPhrases;
    const [lookItem, untouchedLookItem] = content.commerce.lookItems;
    if (!phrase || !untouchedPhrase || !lookItem || !untouchedLookItem) {
      throw new Error('too few search phrases or look items in content');
    }
    const ownerId = newId();
    const operatorId = newId();
    await db.insertInto('owners').values({ id: ownerId, kind: 'user' }).execute();
    await db
      .insertInto('users')
      .values({
        id: operatorId,
        ownerId,
        emailNormalized: `operator-${operatorId}@example.com`,
        roles: ['operator'],
      })
      .execute();
    /** The content with the second phrase and the second look item changed. */
    const changed = (suffix: string) => ({
      ...content,
      commerce: {
        ...content.commerce,
        searchPhrases: content.commerce.searchPhrases.map((entry) =>
          entry === untouchedPhrase
            ? {
                ...entry,
                phrase: `changed phrase ${suffix}`,
                programOverrides: { walmart_us: 'w' },
              }
            : entry,
        ),
        lookItems: content.commerce.lookItems.map((entry) =>
          entry === untouchedLookItem
            ? {
                ...entry,
                ourTitle: `Changed title ${suffix}`,
                searchPhrase: `changed look phrase ${suffix}`,
                sortOrder: entry.sortOrder + 100,
              }
            : entry,
        ),
      },
    });
    const phraseRow = (kitItemKey: string) =>
      db
        .selectFrom('kitItemSearchPhrases')
        .select(['phrase', 'programOverrides'])
        .where('kitItemKey', '=', kitItemKey)
        .executeTakeFirstOrThrow();
    const lookItemRow = (lookItemKey: string) =>
      db
        .selectFrom('lookItems')
        .select(['ourTitle', 'searchPhrase', 'sortOrder', 'status'])
        .where('lookItemKey', '=', lookItemKey)
        .executeTakeFirstOrThrow();
    try {
      await db
        .updateTable('kitItemSearchPhrases')
        .set({
          phrase: 'edited phrase',
          programOverrides: toJson({ walmart_us: 'edited too' }),
          updatedBy: operatorId,
        })
        .where('kitItemKey', '=', phrase.kitItemKey)
        .execute();
      await db
        .updateTable('lookItems')
        .set({ ourTitle: 'Edited title', status: 'retired', updatedBy: operatorId })
        .where('lookItemKey', '=', lookItem.lookItemKey)
        .execute();

      // A local seed brings the untouched rows up to the content and leaves the edited ones.
      clock.advance(60_000);
      const again = await runSeed({ db, config, logger, clock, content: changed('one') });
      expect(again.steps.find((step) => step.name === 'commerce')?.counts).toMatchObject({
        searchPhrases: 1,
        lookItems: 1,
      });
      expect(await phraseRow(untouchedPhrase.kitItemKey)).toEqual({
        phrase: 'changed phrase one',
        programOverrides: { walmart_us: 'w' },
      });
      expect(await lookItemRow(untouchedLookItem.lookItemKey)).toEqual({
        ourTitle: 'Changed title one',
        searchPhrase: 'changed look phrase one',
        sortOrder: untouchedLookItem.sortOrder + 100,
        status: 'active',
      });
      expect(await phraseRow(phrase.kitItemKey)).toEqual({
        phrase: 'edited phrase',
        programOverrides: { walmart_us: 'edited too' },
      });
      expect(await lookItemRow(lookItem.lookItemKey)).toMatchObject({
        ourTitle: 'Edited title',
        status: 'retired',
      });

      // Outside a local environment nothing is updated.
      const deployed = { now: clock.now(), refresh: false };
      expect(await publishSearchPhrases(db, changed('two'), deployed)).toEqual({
        searchPhrases: 0,
      });
      expect(await publishLookItems(db, changed('two'), deployed)).toEqual({ lookItems: 0 });
      expect((await phraseRow(untouchedPhrase.kitItemKey)).phrase).toBe('changed phrase one');
      expect((await lookItemRow(untouchedLookItem.lookItemKey)).ourTitle).toBe('Changed title one');
    } finally {
      await db
        .updateTable('kitItemSearchPhrases')
        .set({
          phrase: phrase.phrase,
          programOverrides: toJson(phrase.programOverrides),
          updatedBy: null,
        })
        .where('kitItemKey', '=', phrase.kitItemKey)
        .execute();
      await db
        .updateTable('lookItems')
        .set({ ourTitle: lookItem.ourTitle, status: 'active', updatedBy: null })
        .where('lookItemKey', '=', lookItem.lookItemKey)
        .execute();
      await db.deleteFrom('users').where('id', '=', operatorId).execute();
      await db.deleteFrom('owners').where('id', '=', ownerId).execute();
      const restore = { now: clock.now(), refresh: true };
      await publishSearchPhrases(db, content, restore);
      await publishLookItems(db, content, restore);
    }
  });

  it('keeps an operator record of a real program and refreshes a fixture program locally', async () => {
    const config = testConfig();
    const content = await loadContent();
    const clock = createManualClock('2026-11-09T15:00:00.000Z');
    const logger = createSilentLogger();
    await runSeed({ db, config, logger, clock, content });
    const record = (programKey: string) =>
      db
        .selectFrom('merchantPrograms')
        .select(['searchUrlTemplate', 'displayRights'])
        .where('programKey', '=', programKey)
        .executeTakeFirstOrThrow();
    const realBefore = await record('target_us');
    const fixtureBefore = await record('fixture_decor_us');
    const operatorRights = {
      tracked_search_links: { state: 'allowed', evidence: 'Terms 4.2', recordedAt: null },
    } as const;
    try {
      await db
        .updateTable('merchantPrograms')
        .set({
          searchUrlTemplate: 'https://www.target.com/s?searchTerm={query}&category=holiday',
          displayRights: toJson(operatorRights),
        })
        .where('programKey', '=', 'target_us')
        .execute();
      await db
        .updateTable('merchantPrograms')
        .set({
          searchUrlTemplate: 'https://example.com/elsewhere/search?q={query}',
          displayRights: toJson(operatorRights),
        })
        .where('programKey', '=', 'fixture_decor_us')
        .execute();
      clock.advance(60_000);
      await runSeed({ db, config, logger, clock, content });
      expect(await record('target_us')).toEqual({
        searchUrlTemplate: 'https://www.target.com/s?searchTerm={query}&category=holiday',
        displayRights: operatorRights,
      });
      expect(await record('fixture_decor_us')).toEqual(fixtureBefore);
    } finally {
      await db
        .updateTable('merchantPrograms')
        .set({
          searchUrlTemplate: realBefore.searchUrlTemplate,
          displayRights: toJson(realBefore.displayRights),
        })
        .where('programKey', '=', 'target_us')
        .execute();
    }
  });

  it('seeds the real programs live only in development with the real programs served', async () => {
    const content = await loadContent();
    // A country code no other test seeds, so the shared US rows are never touched.
    const countryCode = 'XR';
    const states = async () =>
      Object.fromEntries(
        (
          await db
            .selectFrom('countryCapabilities')
            .select(['capability', 'state'])
            .where('countryCode', '=', countryCode)
            .where('capability', 'like', 'commerce:%')
            .execute()
        ).map((row) => [row.capability, row.state]),
      );
    const real = content.commerce.catalog.merchantPrograms
      .map((program) => program.programKey)
      .filter((key) => content.commerce.programExtras.get(key)?.kind === 'real');
    expect(real.sort()).toEqual([
      'amazon_us',
      'home_depot_us',
      'lowes_us',
      'target_us',
      'walmart_us',
    ]);
    const seed = (config: ReturnType<typeof parseConfig>, minute: number) =>
      seedDefaultCapabilities(db, {
        config,
        content,
        now: new Date(`2026-11-17T09:0${minute}:00Z`),
        countryCode,
      });
    try {
      await seed(parseConfig({}), 0);
      const development = await states();
      for (const [capability, state] of Object.entries(development)) {
        const key = capability.slice('commerce:'.length);
        expect(state, capability).toBe(real.includes(key) ? 'live_public' : 'fixture');
      }
      expect(Object.keys(development)).toHaveLength(
        content.commerce.catalog.merchantPrograms.length,
      );

      // Seeded rows follow the default when the fixture programs are served instead.
      await seed(parseConfig({ COMMERCE_PROGRAMS: 'fixture' }), 1);
      expect(Object.values(await states()).every((state) => state === 'fixture')).toBe(true);

      for (const config of [
        testConfig(),
        { ...parseConfig({ COMMERCE_PROGRAMS: 'real' }), appEnv: 'staging' as const },
        { ...parseConfig({ COMMERCE_PROGRAMS: 'real' }), appEnv: 'production' as const },
      ]) {
        await db.deleteFrom('countryCapabilities').where('countryCode', '=', countryCode).execute();
        await seed(config, 2);
        const seeded = await states();
        expect(Object.keys(seeded), config.appEnv).toHaveLength(
          content.commerce.catalog.merchantPrograms.length,
        );
        expect(
          Object.values(seeded).every((state) => state === 'fixture'),
          config.appEnv,
        ).toBe(true);
      }
    } finally {
      await db.deleteFrom('countryCapabilities').where('countryCode', '=', countryCode).execute();
    }
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
