import { readFile } from 'node:fs/promises';
import type { HeroContent } from '../content/load.js';
import { plannedHeroRenditions } from '../content/publish.js';
import { toJson } from '../db/client.js';
import type { SeedContext, SeedStep } from '../db/seed.js';
import type { HeroRenditionsJson } from '../db/schema.js';
import { newId, sha256Hex } from '../ids/index.js';
import { CARD_CACHE_CONTROL } from '../storage/client.js';
import { loadFixtureData } from './data.js';
import {
  HERO_ART_VERSION,
  encodeHeroRendition,
  extractHeroCrop,
  heroCropRect,
  type HeroFormat,
  type HeroOrientation,
} from './heroes.js';
import { loadPhotoLibrary, type HeroPhoto, type PhotoLibrary } from './photos.js';

/** Object metadata key holding the fingerprint of the spec an image was rendered from. */
export const ART_FINGERPRINT_METADATA = 'art-sha256';
/** Object metadata key recording how an example image was produced (`live` or `fixture`). */
export const PROVIDER_MODE_METADATA = 'provider-mode';

const CONTENT_TYPES: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  png: 'image/png',
};

/** Default byte budget of the rendition a phone loads first (heroes.json may override it). */
export const FIRST_LOAD_BYTE_BUDGET = 200_000;

/** True when every key exists and carries the expected fingerprint. */
async function upToDate(context: SeedContext, keys: readonly string[], fingerprint: string) {
  const storage = context.storage();
  for (const key of keys) {
    const head = await storage.head('public', key);
    if (!head || head.metadata[ART_FINGERPRINT_METADATA] !== fingerprint) return false;
  }
  return true;
}

async function upload(
  context: SeedContext,
  key: string,
  body: Buffer,
  format: string,
  metadata: Record<string, string>,
): Promise<void> {
  await context.storage().put({
    bucket: 'public',
    key,
    body,
    contentType: CONTENT_TYPES[format] ?? 'application/octet-stream',
    // Keys are stable across art versions, so public caching is bounded.
    cacheControl: CARD_CACHE_CONTROL,
    metadata,
    provenance: { sourceKind: 'system' },
  });
}

/** The library photo a hero is cropped from. */
export function heroPhotoFor(hero: HeroContent, library: PhotoLibrary): HeroPhoto {
  const photoId = hero.photo?.photoId;
  const photo = photoId ? library.photo(photoId) : undefined;
  if (!photo || photo.kind !== 'hero') {
    throw new Error(`Hero ${hero.heroAssetId} names no hero photo in the library`);
  }
  return photo;
}

/**
 * Renditions a phone may load first are held to the byte budget: every portrait rendition, and
 * landscape renditions no wider than the largest portrait one.
 */
function budgetFor(orientation: string, width: number, budget: number): number | undefined {
  return orientation === 'portrait' || width <= 1080 ? budget : undefined;
}

/**
 * Hero renditions from the licensed photographs: each orientation is cropped from the master
 * around its focal point (the portrait crop is art-directed), resampled to every planned size and
 * encoded as AVIF, WebP and JPEG within the first-load byte budget. The row's renditions, rights
 * and activation are rewritten, and objects of crops no longer planned are deleted. Idempotent:
 * a row whose objects carry the current fingerprint is skipped.
 */
export const heroImagesStep: SeedStep = {
  name: 'hero_images',
  async run(context) {
    const library = loadPhotoLibrary();
    const budget = context.content.heroByteBudget ?? FIRST_LOAD_BYTE_BUDGET;
    let rendered = 0;
    let skipped = 0;
    for (const hero of context.content.heroes) {
      const row = await context.db
        .selectFrom('heroAssets')
        .select(['id', 'renditions', 'active'])
        .where('assetKey', '=', hero.heroAssetId)
        .executeTakeFirst();
      if (!row) continue;
      const photo = heroPhotoFor(hero, library);
      const master = await readFile(library.pathOf(photo));
      const renditions = plannedHeroRenditions(
        hero,
        row.id,
        context.content.heroCrops,
        context.content.heroFormats,
      );
      const fingerprint = sha256Hex(
        JSON.stringify({
          version: HERO_ART_VERSION,
          master: sha256Hex(master),
          photo: {
            landscapeFocal: photo.landscapeFocal,
            portraitFocal: photo.portraitFocal,
          },
          renditions,
          budget,
        }),
      );
      const keys = Object.values(renditions).flatMap((crop) =>
        crop.renditions.map((r) => r.cdnPath),
      );
      const previous = row.renditions as unknown as HeroRenditionsJson;
      const stale = Object.values(previous)
        .flatMap((crop) => crop.renditions.map((r) => r.cdnPath))
        .filter((key) => !keys.includes(key));
      if (row.active && stale.length === 0 && (await upToDate(context, keys, fingerprint))) {
        skipped += 1;
        continue;
      }
      const metadata = {
        [ART_FINGERPRINT_METADATA]: fingerprint,
        [PROVIDER_MODE_METADATA]: 'photo',
      };
      for (const [cropName, crop] of Object.entries(renditions)) {
        if (crop.renditions.length === 0) continue;
        const pixels = await extractHeroCrop(
          library.pathOf(photo),
          heroCropRect(photo, cropName as HeroOrientation),
        );
        for (const rendition of crop.renditions) {
          const { body } = await encodeHeroRendition(
            pixels,
            rendition,
            rendition.format as HeroFormat,
            { maxBytes: budgetFor(cropName, rendition.width, budget) },
          );
          await upload(context, rendition.cdnPath, body, rendition.format, metadata);
        }
      }
      for (const key of stale) await context.storage().delete('public', key);
      await context.db
        .updateTable('heroAssets')
        .set({ renditions: toJson(renditions), rights: toJson(hero.rights), active: true })
        .where('id', '=', row.id)
        .execute();
      rendered += 1;
      context.logger.info({ heroAssetId: hero.heroAssetId, photo: photo.id }, 'hero renditions');
    }
    return { heroImagesRendered: rendered, heroImagesSkipped: skipped };
  },
};

/**
 * Examples are produced only by the production image editor from real photographs (the
 * `examples:render` script). The seed never draws illustrated examples: any example row whose
 * images were not rendered live is deactivated and its images are removed, so the landing hides
 * "See an example" until live examples exist.
 */
export const exampleImagesStep: SeedStep = {
  name: 'example_images',
  async run(context) {
    let deactivated = 0;
    let live = 0;
    for (const example of context.content.examples) {
      const row = await context.db
        .selectFrom('exampleAssets')
        .select(['id', 'beforeCdnPath', 'afterCdnPath', 'active'])
        .where('assetKey', '=', example.exampleId)
        .executeTakeFirst();
      if (!row) continue;
      const storage = context.storage();
      const heads = await Promise.all([
        storage.head('public', row.beforeCdnPath),
        storage.head('public', row.afterCdnPath),
      ]);
      const renderedLive = heads.every(
        (head) => head !== null && head.metadata[PROVIDER_MODE_METADATA] === 'live',
      );
      if (renderedLive) {
        live += 1;
        continue;
      }
      for (const [index, head] of heads.entries()) {
        if (head)
          await storage.delete('public', index === 0 ? row.beforeCdnPath : row.afterCdnPath);
      }
      if (row.active) {
        await context.db
          .updateTable('exampleAssets')
          .set({ active: false })
          .where('id', '=', row.id)
          .execute();
        deactivated += 1;
      }
    }
    return { exampleImagesLive: live, exampleImagesDeactivated: deactivated };
  },
};

/** Seeds the homeowner opt-out list with the fixture places marked blocked (fixture mode only). */
export const fixtureBlockedAddressesStep: SeedStep = {
  name: 'fixture_blocked_addresses',
  async run(context) {
    if (context.config.providers.address !== 'fixture') return { optOutPlaces: 0 };
    let inserted = 0;
    for (const place of loadFixtureData().places.filter((candidate) => candidate.blocked)) {
      const result = await context.db
        .insertInto('blockedAddresses')
        .values({
          id: newId(),
          placeId: place.placeId,
          normalizedAddressHash: null,
          source: 'operator',
          reportId: null,
          evidenceRef: 'fixture:places.json',
          createdBy: null,
          expiresAt: null,
          removedAt: null,
        })
        .onConflict((oc) => oc.column('placeId').doNothing())
        .executeTakeFirst();
      inserted += Number(result.numInsertedOrUpdatedRows ?? 0);
    }
    return { optOutPlaces: inserted };
  },
};

/** Extension steps loaded by `dist/seed.js` after the core steps. */
export const seedSteps: SeedStep[] = [
  fixtureBlockedAddressesStep,
  heroImagesStep,
  exampleImagesStep,
];
