import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Content } from '../content/load.js';
import type { HeroRenditionsJson } from '../db/schema.js';
import { exampleImagesStep, heroImagesStep } from '../fixtures/seed-steps.js';
import { createSilentLogger } from '../logger/index.js';
import type { PipelineDeps } from './context.js';
import { publishedKit, renderExamplePair } from './examples.js';
import { createPipelineTestDeps } from './testing.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
  // Another test file may still be seeding the shared test database; wait for its content rows.
  for (let i = 0; i < 300; i += 1) {
    const heroes = await deps.db.selectFrom('heroAssets').select('id').execute();
    const kits = await deps.db
      .selectFrom('styleKits')
      .select('id')
      .where('status', '=', 'published')
      .execute();
    if (heroes.length >= deps.content.heroes.length && kits.length >= deps.content.kits.length) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  await deps.close();
});

function seedContext(content: Content) {
  return {
    db: deps.db,
    config: deps.config,
    logger: createSilentLogger(),
    clock: deps.clock,
    content,
    now: deps.clock.now(),
    refresh: true,
    storage: () => deps.storage,
  };
}

describe('hero renditions from real photos', () => {
  it('renders every planned rendition, records rights and skips when up to date', async () => {
    const hero = deps.content.heroes.find((h) => h.holidayId === 'thanksgiving_us');
    if (!hero) throw new Error('hero');
    // Small renditions keep the test fast; the step plans whatever the content configures.
    const content: Content = {
      ...deps.content,
      heroes: [hero],
      heroCrops: {
        landscape: { aspect: '3:2', renditionWidths: [800] },
        portrait: { aspect: '2:3', renditions: [{ width: 720, height: 1080 }] },
      },
    };
    const first = await heroImagesStep.run(seedContext(content));
    expect(first).toMatchObject({ heroImagesRendered: 1 });
    const row = await deps.db
      .selectFrom('heroAssets')
      .select(['renditions', 'rights', 'active'])
      .where('assetKey', '=', hero.heroAssetId)
      .executeTakeFirstOrThrow();
    expect(row.active).toBe(true);
    expect(row.rights).toMatchObject({
      sourceKind: 'licensed',
      photographer: 'Libby Penner',
      license: 'Unsplash License',
    });
    const renditions = row.renditions as unknown as HeroRenditionsJson;
    expect(Object.keys(renditions).sort()).toEqual(['landscape', 'portrait']);
    expect(renditions.landscape.renditions.map((r) => r.format).sort()).toEqual([
      'avif',
      'jpeg',
      'webp',
    ]);
    for (const rendition of [
      ...renditions.landscape.renditions,
      ...renditions.portrait.renditions,
    ]) {
      const object = await deps.storage.get('public', rendition.cdnPath);
      if (!object) throw new Error(rendition.cdnPath);
      const meta = await sharp(object.body).metadata();
      expect([meta.width, meta.height]).toEqual([rendition.width, rendition.height]);
      expect(object.body.length).toBeLessThanOrEqual(200_000);
    }
    const second = await heroImagesStep.run(seedContext(content));
    expect(second).toMatchObject({ heroImagesRendered: 0, heroImagesSkipped: 1 });
  });
});

describe('examples', () => {
  it('keeps examples without a live render inactive', async () => {
    await deps.db.updateTable('exampleAssets').set({ active: true }).execute();
    await exampleImagesStep.run(seedContext(deps.content));
    const active = await deps.db
      .selectFrom('exampleAssets')
      .select('id')
      .where('active', '=', true)
      .execute();
    expect(active).toEqual([]);
  });

  it('renders an example pair from its photo through the pipeline plan and editor', async () => {
    const example = deps.content.examples.find(
      (e) => e.holidayId === 'christmas' && e.sceneType === 'house_exterior',
    );
    if (!example) throw new Error('example');
    const kit = await publishedKit(deps.db, example);
    if (!kit) throw new Error('kit');
    const pair = await renderExamplePair(
      {
        content: deps.content,
        imageEditor: deps.providers.fixtures.imageEditor,
        vision: deps.providers.fixtures.vision,
        kitAttributes: kit.attributes,
        styleKitVersionId: kit.id,
        modelSnapshot: 'fixture-compositor',
      },
      example,
    );
    expect(pair.placements).toBeGreaterThan(2);
    for (const image of [pair.before, pair.after]) {
      const meta = await sharp(image).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([
        example.width,
        example.height,
        'jpeg',
      ]);
    }
    expect(pair.after.equals(pair.before)).toBe(false);
  });
});
