import { sql } from 'kysely';
import {
  DEFAULT_ENABLED_HOLIDAY_IDS,
  HERO_ORIENTATIONS,
  HOLIDAY_IDS,
  localDateIn,
  occurrenceFor,
} from '@hailiday/core';
import type { HolidayId } from '@hailiday/core';
import type { Logger } from '../logger/index.js';
import { toJson } from '../db/client.js';
import type { DbOrTx } from '../db/client.js';
import type { HeroCropJson, HeroRenditionsJson } from '../db/schema.js';
import { newId } from '../ids/index.js';
import { keys } from '../storage/keys.js';
import { ContentError } from './load.js';
import type { Content, HeroContent, HeroCropConfig, PackContent } from './load.js';

/** Counts of rows a publication step inserted or changed. */
export type PublishCounts = Record<string, number>;

export interface PublishOptions {
  now: Date;
  /** Development and test refresh seeded rows from content; elsewhere rows are insert-only. */
  refresh: boolean;
  logger?: Logger;
}

/**
 * Publishes one pack version: inserts it as `published` and retires the previously published
 * version for the holiday and region. A published version whose file changed without a version
 * bump is an error unless `refresh` is set (local development), where its checksum is updated.
 */
export async function publishPack(
  db: DbOrTx,
  pack: PackContent,
  options: PublishOptions,
): Promise<{ id: string; changed: boolean }> {
  const existing = await db
    .selectFrom('holidayPackVersions')
    .selectAll()
    .where('holidayId', '=', pack.holidayId)
    .where('region', '=', pack.region)
    .where('version', '=', pack.version)
    .executeTakeFirst();
  const reviewRecord = toJson(pack.pack.review);

  if (existing && existing.contentSha256 !== pack.sha256) {
    if (!options.refresh) {
      throw new ContentError([
        `${pack.contentRef}: version ${pack.version} changed without a version bump`,
      ]);
    }
    options.logger?.warn(
      { holidayId: pack.holidayId, version: pack.version },
      'pack content changed without a version bump; checksum refreshed',
    );
    await db
      .updateTable('holidayPackVersions')
      .set({ contentSha256: pack.sha256, contentRef: pack.contentRef, reviewRecord })
      .where('id', '=', existing.id)
      .execute();
  }
  if (existing && existing.status === 'published') {
    return { id: existing.id, changed: existing.contentSha256 !== pack.sha256 };
  }

  await db
    .updateTable('holidayPackVersions')
    .set({ status: 'retired', retiredAt: options.now })
    .where('holidayId', '=', pack.holidayId)
    .where('region', '=', pack.region)
    .where('status', '=', 'published')
    .execute();
  if (existing) {
    await db
      .updateTable('holidayPackVersions')
      .set({ status: 'published', publishedAt: options.now, retiredAt: null })
      .where('id', '=', existing.id)
      .execute();
    return { id: existing.id, changed: true };
  }
  const id = newId();
  await db
    .insertInto('holidayPackVersions')
    .values({
      id,
      holidayId: pack.holidayId,
      region: pack.region,
      version: pack.version,
      status: 'published',
      contentRef: pack.contentRef,
      contentSha256: pack.sha256,
      reviewRecord,
      publishedAt: options.now,
    })
    .execute();
  return { id, changed: true };
}

export async function publishPacks(
  db: DbOrTx,
  content: Content,
  options: PublishOptions,
): Promise<PublishCounts> {
  let changed = 0;
  for (const pack of content.packs) {
    if ((await publishPack(db, pack, options)).changed) changed += 1;
  }
  return { packVersions: changed };
}

/**
 * Upserts style kits by (`kit_key`, `version`) and their items by (`kit_id`, `kit_item_id`), and
 * retires any other published version of the same kit key.
 */
export async function publishKits(
  db: DbOrTx,
  content: Content,
  options: PublishOptions,
): Promise<PublishCounts> {
  let kitsChanged = 0;
  let itemsChanged = 0;
  for (const { kit } of content.kits) {
    let row = await db
      .selectFrom('styleKits')
      .selectAll()
      .where('kitKey', '=', kit.kitKey)
      .where('version', '=', kit.version)
      .executeTakeFirst();
    if (!row || row.status !== kit.status) {
      if (kit.status === 'published') {
        await db
          .updateTable('styleKits')
          .set({ status: 'retired' })
          .where('kitKey', '=', kit.kitKey)
          .where('status', '=', 'published')
          .where('version', '<>', kit.version)
          .execute();
      }
      if (row) {
        row = await db
          .updateTable('styleKits')
          .set({
            status: kit.status,
            publishedAt: kit.status === 'published' ? options.now : row.publishedAt,
          })
          .where('id', '=', row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        row = await db
          .insertInto('styleKits')
          .values({
            id: newId(),
            kitKey: kit.kitKey,
            holidayId: kit.holidayId,
            sceneType: kit.sceneType,
            version: kit.version,
            status: kit.status,
            publishedAt: kit.status === 'published' ? options.now : null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      kitsChanged += 1;
    }
    for (const item of kit.items) {
      const values = {
        anchorCategory: item.anchorCategory,
        anchorCategories: item.anchorCategories ?? [item.anchorCategory],
        specText: item.specText,
        specAttributes: toJson(item.specAttributes),
        styleQuantities: toJson(item.styleQuantities),
        sortOrder: item.sortOrder,
      };
      const result = await db
        .insertInto('kitItems')
        .values({ id: newId(), kitId: row.id, kitItemId: item.kitItemId, ...values })
        .onConflict((oc) => {
          const conflict = oc.columns(['kitId', 'kitItemId']);
          return options.refresh
            ? conflict.doUpdateSet(values).where(
                sql<boolean>`(kit_items.spec_text, kit_items.spec_attributes, kit_items.style_quantities, kit_items.sort_order, kit_items.anchor_category, kit_items.anchor_categories)
                    is distinct from
                    (excluded.spec_text, excluded.spec_attributes, excluded.style_quantities, excluded.sort_order, excluded.anchor_category, excluded.anchor_categories)`,
              )
            : conflict.doNothing();
        })
        .executeTakeFirst();
      itemsChanged += Number(result.numInsertedOrUpdatedRows ?? 0);
    }
  }
  return { styleKits: kitsChanged, kitItems: itemsChanged };
}

/** Shifts an ISO timestamp by a number of milliseconds (offer timestamps rebased on seed). */
function shift(value: string | null | undefined, offsetMs: number): Date | null {
  if (!value) return null;
  return new Date(new Date(value).getTime() + offsetMs);
}

/**
 * Upserts merchant programs, products and offers by their content keys, then links kit items to
 * their current product and products to a kit item. Offer timestamps are rebased by
 * (now − authoredAt) when the content asks for it, so freshness rules behave the same any day.
 */
export async function publishCommerce(
  db: DbOrTx,
  content: Content,
  options: PublishOptions,
): Promise<PublishCounts> {
  const { catalog, programExtras, offerExtras } = content.commerce;
  const counts: PublishCounts = { merchantPrograms: 0, products: 0, offers: 0, kitProductLinks: 0 };

  const programIds = new Map<string, string>();
  for (const program of catalog.merchantPrograms) {
    const extras = programExtras.get(program.programKey);
    const values = {
      displayName: program.displayName,
      programType: extras?.programType ?? 'network',
      network: program.network,
      status: program.status,
      statusHistory: toJson(extras?.statusHistory ?? []),
      appliedAt: program.appliedAt ?? null,
      approvedAt: program.approvedAt ?? null,
      endedAt: program.endedAt ?? null,
      requiredDisclosureKey: program.requiredDisclosureKey ?? null,
      disclosureText: program.disclosureText ?? null,
      redirectPermitted: program.redirectPermitted,
      linkMethod: program.linkMethod,
      subIdCapability: program.subIdCapability,
      subIdParam: extras?.subIdParam ?? null,
      trackingIds: toJson(extras?.trackingIds ?? []),
      apiAccess: program.apiAccess,
      attributionWindowHours: program.attributionWindowHours ?? null,
      commissionSchedule: toJson(program.commissionSchedule),
      policyVersion: program.policyVersion ?? null,
      reviewedAt: program.reviewedAt ?? null,
      logoPermitted: extras?.logoPermitted ?? false,
      notes: extras?.notes ?? null,
    };
    const result = await db
      .insertInto('merchantPrograms')
      .values({ id: newId(), programKey: program.programKey, ...values })
      .onConflict((oc) =>
        options.refresh
          ? oc.column('programKey').doUpdateSet(values)
          : oc.column('programKey').doNothing(),
      )
      .executeTakeFirst();
    counts.merchantPrograms =
      (counts.merchantPrograms ?? 0) + Number(result.numInsertedOrUpdatedRows ?? 0);
    const row = await db
      .selectFrom('merchantPrograms')
      .select('id')
      .where('programKey', '=', program.programKey)
      .executeTakeFirstOrThrow();
    programIds.set(program.programKey, row.id);
  }

  const kitItemRows = await db
    .selectFrom('kitItems')
    .innerJoin('styleKits', 'styleKits.id', 'kitItems.kitId')
    .select(['kitItems.id', 'kitItems.kitItemId'])
    .where('styleKits.status', '=', 'published')
    .execute();
  const kitItemIds = new Map(kitItemRows.map((row) => [row.kitItemId, row.id]));

  const productIds = new Map<string, string>();
  for (const product of catalog.products) {
    const primaryKitItem = product.kitItemIds.map((id) => kitItemIds.get(id)).find(Boolean) ?? null;
    const values = {
      kitItemId: primaryKitItem,
      kitItemKeys: product.kitItemIds,
      ourTitle: product.ourTitle,
      ourDescription: product.ourDescription,
      category: product.category,
      specAttributes: toJson(product.specAttributes),
      archivedAt: product.archivedAt ?? null,
    };
    const result = await db
      .insertInto('products')
      .values({ id: newId(), productKey: product.productKey, ...values })
      .onConflict((oc) =>
        options.refresh
          ? oc.column('productKey').doUpdateSet(values)
          : oc.column('productKey').doNothing(),
      )
      .executeTakeFirst();
    counts.products = (counts.products ?? 0) + Number(result.numInsertedOrUpdatedRows ?? 0);
    const row = await db
      .selectFrom('products')
      .select('id')
      .where('productKey', '=', product.productKey)
      .executeTakeFirstOrThrow();
    productIds.set(product.productKey, row.id);
  }

  const authoredAt = content.commerce.authoredAt ? new Date(content.commerce.authoredAt) : null;
  const offsetMs =
    content.commerce.rebaseTimestampsOnSeed && authoredAt
      ? options.now.getTime() - authoredAt.getTime()
      : 0;
  for (const offer of catalog.offers) {
    const productId = productIds.get(offer.productKey);
    const programId = programIds.get(offer.merchantProgramKey);
    if (!productId || !programId) continue;
    const extras = offerExtras.get(offer.offerKey);
    const values = {
      productId,
      merchantProgramId: programId,
      merchantItemId: offer.merchantItemId,
      destinationCountry: offer.destinationCountry,
      currency: offer.currency,
      priceMinor: offer.priceMinor,
      priceSource: offer.priceSource,
      priceObservedAt: shift(offer.priceObservedAt, offsetMs),
      availability: offer.availability,
      availabilityCheckedAt: shift(offer.availabilityCheckedAt, offsetMs),
      destinationUrl: offer.destinationUrl,
      trackingUrlTemplate: offer.trackingUrlTemplate,
      contentRights: toJson({
        imageDisplay: {
          state: offer.contentRights.imageDisplay,
          evidenceRef: extras?.contentRightsEvidence.imageDisplay ?? null,
        },
        imageAiInput: {
          state: offer.contentRights.imageAiInput,
          evidenceRef: extras?.contentRightsEvidence.imageAiInput ?? null,
        },
        textUse: {
          state: offer.contentRights.textUse,
          evidenceRef: extras?.contentRightsEvidence.textUse ?? null,
        },
      }),
      status: offer.status,
      seasonalEligibility: offer.seasonalEligibility,
      sponsored: offer.sponsored,
      lastVerifiedAt: shift(offer.lastVerifiedAt, offsetMs),
      verificationMethod: offer.verificationMethod,
      notes: offer.notes ?? null,
    };
    const result = await db
      .insertInto('offers')
      .values({ id: newId(), offerKey: offer.offerKey, ...values })
      .onConflict((oc) =>
        options.refresh
          ? oc.column('offerKey').doUpdateSet(values)
          : oc.column('offerKey').doNothing(),
      )
      .executeTakeFirst();
    counts.offers = (counts.offers ?? 0) + Number(result.numInsertedOrUpdatedRows ?? 0);
  }

  for (const { kit, currentProducts } of content.kits) {
    const kitRow = await db
      .selectFrom('styleKits')
      .select('id')
      .where('kitKey', '=', kit.kitKey)
      .where('version', '=', kit.version)
      .executeTakeFirst();
    if (!kitRow) continue;
    for (const [kitItemId, productKey] of currentProducts) {
      const productId = productKey ? (productIds.get(productKey) ?? null) : null;
      const result = await db
        .updateTable('kitItems')
        .set({ currentProductId: productId })
        .where('kitId', '=', kitRow.id)
        .where('kitItemId', '=', kitItemId)
        .where(sql<boolean>`current_product_id is distinct from ${productId}`)
        .executeTakeFirst();
      counts.kitProductLinks = (counts.kitProductLinks ?? 0) + Number(result.numUpdatedRows ?? 0);
    }
  }
  return counts;
}

/** Target pixel size of each rendition of a crop. */
export function heroRenditionSizes(crop: HeroCropConfig): { width: number; height: number }[] {
  if (crop.renditions) return crop.renditions;
  const [w, h] = crop.aspect.split(':').map(Number) as [number, number];
  return (crop.renditionWidths ?? (crop.master ? [crop.master.width] : [])).map((width) => ({
    width,
    height: Math.round((width * h) / w),
  }));
}

/** Planned renditions for a hero: object paths the image seed step writes. */
export function plannedHeroRenditions(
  hero: HeroContent,
  heroId: string,
  crops: Record<string, HeroCropConfig>,
  formats: readonly string[],
): HeroRenditionsJson {
  const result: Record<string, HeroCropJson> = {};
  for (const [cropName, spec] of Object.entries(hero.crops)) {
    const config = crops[cropName];
    if (!config) continue;
    const renditions = heroRenditionSizes(config).flatMap(({ width, height }) =>
      formats.map((format) => ({
        cdnPath: keys.hero(heroId, cropName, `w${width}`, format === 'jpeg' ? 'jpg' : format),
        width,
        height,
        format,
      })),
    );
    result[cropName] = {
      focalPoint: [spec.focalPoint.x, spec.focalPoint.y],
      safeArea: spec.safeArea,
      renditions,
    };
  }
  if (!result.landscape || !result.portrait) {
    throw new ContentError([`hero ${hero.heroAssetId} needs landscape and portrait crops`]);
  }
  return result as HeroRenditionsJson;
}

/**
 * Inserts a placeholder `hero_assets` row per hero specification (inactive, with planned
 * rendition paths); the image seed step renders and uploads the art, then activates the row.
 * Existing rows keep their renditions and active flag.
 */
export async function publishHeroPlaceholders(
  db: DbOrTx,
  content: Content,
  options: PublishOptions,
): Promise<PublishCounts> {
  let inserted = 0;
  for (const hero of content.heroes) {
    const id = newId();
    const approvedCrops = hero.approval.approvedCrops.filter((crop) =>
      (HERO_ORIENTATIONS as readonly string[]).includes(crop),
    );
    const metadata = {
      holidayId: hero.holidayId,
      sceneType: hero.sceneType,
      altTextKey: hero.altKey,
      rights: toJson(hero.rights),
      approvedAt: new Date(hero.approval.approvedAt),
      approvedCrops,
    };
    const result = await db
      .insertInto('heroAssets')
      .values({
        id,
        assetKey: hero.heroAssetId,
        renditions: toJson(plannedHeroRenditions(hero, id, content.heroCrops, content.heroFormats)),
        approvedBy: null,
        active: false,
        ...metadata,
      })
      .onConflict((oc) =>
        options.refresh
          ? oc
              .column('assetKey')
              .doUpdateSet(metadata)
              .where(
                sql<boolean>`(hero_assets.alt_text_key, hero_assets.rights, hero_assets.approved_crops)
                  is distinct from (excluded.alt_text_key, excluded.rights, excluded.approved_crops)`,
              )
          : oc.column('assetKey').doNothing(),
      )
      .executeTakeFirst();
    inserted += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  return { heroAssets: inserted };
}

/**
 * Inserts a placeholder `example_assets` row per example specification (inactive, with planned
 * before and after paths); the image seed step produces the pair and activates the row.
 */
export async function publishExamplePlaceholders(
  db: DbOrTx,
  content: Content,
  options: PublishOptions,
): Promise<PublishCounts> {
  let inserted = 0;
  for (const example of content.examples) {
    const id = newId();
    const result = await db
      .insertInto('exampleAssets')
      .values({
        id,
        assetKey: example.exampleId,
        holidayId: example.holidayId,
        sceneType: example.sceneType,
        style: example.style,
        lightingMode: example.lightingMode,
        sourceAssetId: null,
        renderAssetId: null,
        packVersion: example.packVersion,
        beforeCdnPath: keys.example(id, 'before', 'jpg'),
        afterCdnPath: keys.example(id, 'after', 'jpg'),
        width: example.width,
        height: example.height,
        captionKey: example.captionKey,
        rights: toJson({ ...example.rights, approval: example.approval }),
        approvedAt: new Date(example.approval.approvedAt),
        active: false,
      })
      .onConflict((oc) =>
        options.refresh
          ? oc
              .column('assetKey')
              .doUpdateSet({
                captionKey: example.captionKey,
                packVersion: example.packVersion,
              })
              .where(
                sql<boolean>`(example_assets.caption_key, example_assets.pack_version)
                  is distinct from (excluded.caption_key, excluded.pack_version)`,
              )
          : oc.column('assetKey').doNothing(),
      )
      .executeTakeFirst();
    inserted += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  // An example whose specification left the content (its content cell is no longer offered) is
  // no longer shown; its row and images stay for the record.
  const current = content.examples.map((example) => example.exampleId);
  let retire = db.updateTable('exampleAssets').set({ active: false }).where('active', '=', true);
  if (current.length > 0) retire = retire.where('assetKey', 'not in', current);
  const retired = await retire.executeTakeFirst();
  inserted += Number(retired.numUpdatedRows ?? 0);
  return { exampleAssets: inserted };
}

/** The occurrence years to seed around an instant: last, current and next editorial year. */
export function occurrenceYears(now: Date, timeZone = 'America/New_York'): number[] {
  const year = Number(localDateIn(now, timeZone).slice(0, 4));
  return [year - 1, year, year + 1];
}

/**
 * Upserts holiday occurrences by occurrence key for the given years. New rows pin the published
 * pack version and the holiday's hero and are enabled for the default-enabled holidays. On later
 * runs (the publication step) occurrences that have not ended are repinned to the published pack
 * version and gain a hero if they had none; dates and the enabled flag stay as operators left them.
 */
export async function publishOccurrences(
  db: DbOrTx,
  content: Content,
  options: PublishOptions & { years: readonly number[]; region?: string },
): Promise<PublishCounts> {
  const region = options.region ?? 'US';
  const published = await db
    .selectFrom('holidayPackVersions')
    .select(['id', 'holidayId'])
    .where('region', '=', region)
    .where('status', '=', 'published')
    .execute();
  const packIds = new Map<HolidayId, string>(published.map((row) => [row.holidayId, row.id]));
  const heroRows = await db
    .selectFrom('heroAssets')
    .select(['id', 'holidayId', 'assetKey'])
    .orderBy('assetKey')
    .execute();
  const heroFor = (holidayId: HolidayId) =>
    heroRows.find((row) => row.holidayId === holidayId)?.id ?? null;
  const today = localDateIn(options.now, 'America/New_York');

  let changed = 0;
  for (const year of options.years) {
    for (const holidayId of HOLIDAY_IDS) {
      const occurrence = occurrenceFor(holidayId, year, region);
      const packVersionId = packIds.get(holidayId) ?? null;
      const enabled =
        packVersionId !== null &&
        DEFAULT_ENABLED_HOLIDAY_IDS.includes(holidayId) &&
        content.packFor(holidayId) !== undefined;
      const inserted = await db
        .insertInto('holidayOccurrences')
        .values({
          id: newId(),
          occurrenceKey: occurrence.occurrenceKey,
          holidayId,
          region,
          year,
          celebrationStart: occurrence.celebrationStart,
          celebrationEnd: occurrence.celebrationEnd,
          promotionStart: occurrence.promotionStart,
          promotionEnd: occurrence.promotionEnd,
          commerceStart: occurrence.commerceStart,
          commerceEnd: occurrence.commerceEnd,
          catalogRetireAt: occurrence.catalogRetireAt,
          editorialPriority: occurrence.editorialPriority,
          editorialTimezone: occurrence.editorialTimezone,
          heroAssetId: heroFor(holidayId),
          packVersionId,
          enabled,
          reviewedAt: options.now,
          reviewedBy: null,
        })
        .onConflict((oc) => oc.column('occurrenceKey').doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0) {
        changed += 1;
        continue;
      }
      if (packVersionId) {
        const repinned = await db
          .updateTable('holidayOccurrences')
          .set({ packVersionId })
          .where('occurrenceKey', '=', occurrence.occurrenceKey)
          .where('promotionEnd', '>=', today)
          .where(sql<boolean>`pack_version_id is distinct from ${packVersionId}`)
          .executeTakeFirst();
        changed += Number(repinned.numUpdatedRows ?? 0);
      }
      const hero = heroFor(holidayId);
      if (hero) {
        const withHero = await db
          .updateTable('holidayOccurrences')
          .set({ heroAssetId: hero })
          .where('occurrenceKey', '=', occurrence.occurrenceKey)
          .where('heroAssetId', 'is', null)
          .executeTakeFirst();
        changed += Number(withHero.numUpdatedRows ?? 0);
      }
    }
  }
  return { holidayOccurrences: changed };
}
