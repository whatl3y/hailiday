import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ProductsPanelSchema,
  commerceCapabilityKey,
  type ActivationState,
  type CommerceMode,
  type ProductsPanel,
  type ProgramRights,
  type ShopGroup,
  type Style,
} from '@hailiday/core';
import type { Capabilities } from '@hailiday/server/capabilities';
import {
  factories,
  toJson,
  type CountryCapability,
  type MerchantProgram,
  type Offer,
  type RenderJob,
} from '@hailiday/server/db';
import { renderFixturePanorama } from '@hailiday/server/fixtures';
import { newId, sha256Hex } from '@hailiday/server/ids';
import { createRenderJobRecord, createUploadSource, runRenderJob } from '@hailiday/server/pipeline';
import type { AuthState } from './auth/session.js';
import type { ApiDeps } from './deps.js';
import {
  buildProductsPanel,
  issueClickToken,
  subIdOf,
  verifyClickToken,
} from './domain/commerce.js';
import { commerceOccurrenceOf, holidayCalendar } from './domain/holidays.js';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { ownerIdOf } from './test/projects.js';

/**
 * The panel is built with this file's own merchant programs only: they have no capability rows,
 * so no other test file serves them, and the panel here sees them through a capability view that
 * holds nothing else.
 */
let harness: Harness;
let client: TestClient;
let auth: AuthState;
let classic: { job: RenderJob; assetId: string };
let abundant: { job: RenderJob; assetId: string };
let inWindow: Date;
let offSeason: Date;
let occurrenceKey: string;

let decor: MerchantProgram;
let garden: MerchantProgram;
let market: MerchantProgram;
let realStore: MerchantProgram;
let bare: MerchantProgram;
/** The product of the first placed decoration of the classic look and its offers. */
let productId: string;
let kitItemKey: string;
let offers: Record<'decor1' | 'decor2' | 'garden1' | 'garden2' | 'market1', Offer>;

const RIGHTS: ProgramRights = {
  tracked_product_links: { state: 'allowed', evidence: 'Test terms', recordedAt: null },
  tracked_search_links: { state: 'allowed', evidence: 'Test terms', recordedAt: null },
  beside_ai_picture: { state: 'allowed', evidence: 'Test terms', recordedAt: null },
  beside_other_retailers: { state: 'allowed', evidence: 'Test terms', recordedAt: null },
};

let clients = 0;
async function newClient(): Promise<TestClient> {
  clients += 1;
  const created = harness.client({ remoteAddress: `10.83.0.${clients}` });
  await created.createSession();
  return created;
}

async function authOf(of: TestClient): Promise<AuthState> {
  if (!of.cookie) throw new Error('the client has no session');
  const session = await harness.context.db
    .selectFrom('anonymousSessions')
    .selectAll()
    .where('tokenHash', '=', sha256Hex(of.cookie))
    .executeTakeFirstOrThrow();
  return { session, ownerId: session.ownerId, user: null, roles: [], audience: { roles: [] } };
}

/** Renders one look of a new upload project of the client's owner in the worker. */
async function renderLook(style: Style): Promise<{ job: RenderJob; assetId: string }> {
  const ownerId = await ownerIdOf(harness, client);
  const frame = await renderFixturePanorama({
    panoId: 'fxSvLanternHillC01p1Sv',
    heading: 0,
    fov: 80,
    pitch: 2,
  });
  if (!frame) throw new Error('fixture panorama missing');
  const created = await createUploadSource(harness.pipeline, { image: frame.image });
  const db = harness.context.db;
  await db.transaction().execute(async (trx) => {
    for (const table of ['projects', 'sourceAssets'] as const) {
      await trx
        .updateTable(table)
        .set({ ownerId })
        .where('ownerId', '=', created.ownerId)
        .execute();
    }
  });
  const source = await db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', created.source.id)
    .executeTakeFirstOrThrow();
  const record = await createRenderJobRecord(harness.pipeline, {
    ownerId,
    projectId: created.projectId,
    source,
    style,
    lightingMode: 'source',
  });
  expect((await runRenderJob(harness.pipeline, { renderJobId: record.id })).state).toBe(
    'succeeded',
  );
  const job = await db
    .selectFrom('renderJobs')
    .selectAll()
    .where('id', '=', record.id)
    .executeTakeFirstOrThrow();
  return { job, assetId: job.renderAssetId as string };
}

/**
 * The API dependencies of one panel build: the capability states of the given programs only, the
 * commerce mode and a fixed clock.
 */
function depsFor(input: {
  states: [MerchantProgram, ActivationState][];
  commerce?: CommerceMode;
  now?: Date;
}): ApiDeps {
  const base = harness.server.deps;
  const rows = input.states.map(
    ([program, state]) =>
      ({
        countryCode: 'US',
        capability: commerceCapabilityKey(program.programKey),
        state,
      }) as CountryCapability,
  );
  const capabilities: Capabilities = {
    ...base.capabilities,
    list: async () => rows,
    state: async (_country, capability) =>
      rows.find((row) => row.capability === capability)?.state ?? null,
  };
  const now = input.now ?? inWindow;
  return {
    ...base,
    capabilities,
    clock: { now: () => now },
    config: {
      ...base.config,
      providers: { ...base.config.providers, commerce: input.commerce ?? 'fixture' },
    },
  };
}

/** Every fixture program of this file served (and the real one live, which fixture mode ignores). */
const FIXTURE_STATES = (): [MerchantProgram, ActivationState][] => [
  [decor, 'fixture'],
  [garden, 'fixture'],
  [market, 'fixture'],
  [realStore, 'live_public'],
];

async function panelOf(
  job: RenderJob,
  deps: ApiDeps,
  options: { searchLinksOffSeason?: boolean } = {},
): Promise<ProductsPanel> {
  return ProductsPanelSchema.parse(await buildProductsPanel(deps, auth, job, options));
}

async function insertOffer(
  program: MerchantProgram,
  overrides: Partial<{
    availability: 'in_stock' | 'unknown' | 'out_of_stock';
    priceMinor: number | null;
    lastVerifiedAt: Date;
    sponsored: boolean;
    trackingUrlTemplate: string | null;
  }> = {},
): Promise<Offer> {
  const id = newId();
  return harness.context.db
    .insertInto('offers')
    .values({
      id,
      offerKey: `test_offer_${id}`,
      productId,
      merchantProgramId: program.id,
      merchantItemId: `TEST-${id}`,
      destinationCountry: 'US',
      currency: 'USD',
      priceMinor: overrides.priceMinor === undefined ? 2499 : overrides.priceMinor,
      priceSource: 'feed',
      priceObservedAt: new Date(inWindow.getTime() - 3_600_000),
      availability: overrides.availability ?? 'in_stock',
      availabilityCheckedAt: new Date(inWindow.getTime() - 3_600_000),
      destinationUrl: `https://example.com/${program.programKey}/p/${id}`,
      trackingUrlTemplate: overrides.trackingUrlTemplate ?? null,
      contentRights: toJson({
        imageDisplay: { state: 'unknown', evidenceRef: null },
        imageAiInput: { state: 'denied', evidenceRef: 'test' },
        textUse: { state: 'unknown', evidenceRef: null },
      }),
      status: 'active',
      seasonalEligibility: [occurrenceKey],
      sponsored: overrides.sponsored ?? false,
      lastVerifiedAt: overrides.lastVerifiedAt ?? new Date(inWindow.getTime() - 3_600_000),
      verificationMethod: 'manual',
      verifiedBy: null,
      notes: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** Every option, search link and separate link of a panel with its group. */
function linksOf(panel: ProductsPanel) {
  return panel.groups.flatMap((group) => [
    ...group.options.map((link) => ({ group, link, kind: 'product' as const })),
    ...group.searchLinks.map((link) => ({ group, link, kind: 'search' as const })),
    ...group.separateLinks.map((link) => ({ group, link, kind: 'separate' as const })),
  ]);
}

function groupOf(panel: ProductsPanel, key: string): ShopGroup {
  const group = panel.groups.find((entry) => entry.groupKey === key);
  if (!group) throw new Error(`no group ${key}`);
  return group;
}

async function shopTargetsOf(assetId: string) {
  return harness.context.db
    .selectFrom('renderShopTargets')
    .selectAll()
    .where('renderAssetId', '=', assetId)
    .execute();
}

beforeAll(async () => {
  harness = await createHarness();
  client = await newClient();
  auth = await authOf(client);
  const db = harness.context.db;

  const calendar = await holidayCalendar(harness.server.deps);
  const row = calendar.rows.find(
    (entry) => entry.holidayId === 'christmas' && entry.commerceStart && entry.commerceEnd,
  );
  if (!row?.commerceStart) throw new Error('no Christmas commerce window');
  inWindow = new Date(`${row.commerceStart}T17:00:00.000Z`);
  offSeason = new Date(`${row.commerceStart.slice(0, 4)}-07-01T17:00:00.000Z`);
  occurrenceKey = row.occurrenceKey;
  expect(commerceOccurrenceOf(calendar.rows, 'christmas', inWindow)?.occurrenceKey).toBe(
    occurrenceKey,
  );
  expect(commerceOccurrenceOf(calendar.rows, 'christmas', offSeason)).toBeNull();

  const tracking = { holidayId: 'christmas', channel: 'direct', trackingId: 'test-tag-20' };
  decor = await factories.merchantProgram(db, { displayName: 'Test Decor' });
  garden = await factories.merchantProgram(db, {
    displayName: 'Test Garden',
    status: 'approved',
    subIdCapability: true,
    trackingLinkTemplate: 'https://example.com/track?sub={subId}&u={destinationUrl}',
    displayRights: RIGHTS,
    trackingIds: [tracking],
  });
  market = await factories.merchantProgram(db, {
    displayName: 'Test Market',
    placement: 'separate',
    programType: 'amazon_associates',
    status: 'provisional',
    trackingLinkTemplate: '{destinationUrl}&tag={trackingId}',
    displayRights: RIGHTS,
    trackingIds: [tracking],
  });
  realStore = await factories.merchantProgram(db, { displayName: 'Test Store', kind: 'real' });
  bare = await factories.merchantProgram(db, { searchUrlTemplate: null });

  classic = await renderLook('classic');
  abundant = await renderLook('abundant');

  // The first placed decoration of the classic look: described first, then kit order.
  const links = await db
    .selectFrom('renderProductLinks')
    .innerJoin('kitItems', 'kitItems.id', 'renderProductLinks.kitItemId')
    .select([
      'renderProductLinks.relationship',
      'renderProductLinks.productId',
      'kitItems.currentProductId',
      'kitItems.kitItemId',
      'kitItems.sortOrder',
    ])
    .where('renderProductLinks.renderAssetId', '=', classic.assetId)
    .where('renderProductLinks.hiddenAt', 'is', null)
    .execute();
  links.sort(
    (a, b) =>
      Number(b.relationship === 'described') - Number(a.relationship === 'described') ||
      a.sortOrder - b.sortOrder,
  );
  const first = links[0];
  if (!first) throw new Error('the classic look has no product links');
  productId = first.currentProductId ?? first.productId;
  kitItemKey = first.kitItemId;

  offers = {
    decor1: await insertOffer(decor),
    decor2: await insertOffer(decor),
    garden1: await insertOffer(garden),
    garden2: await insertOffer(garden),
    market1: await insertOffer(market),
  };
  // Never shown: out of stock, and verified too long ago.
  await insertOffer(decor, { availability: 'out_of_stock' });
  await insertOffer(garden, { lastVerifiedAt: new Date(inWindow.getTime() - 10 * 86_400_000) });
});

afterAll(async () => {
  await harness?.close();
});

describe('the Shop the look panel', () => {
  it('shows placed groups with options, search links and a separate link in fixture mode', async () => {
    const panel = await panelOf(classic.job, depsFor({ states: FIXTURE_STATES() }));
    expect(panel).toMatchObject({
      panelState: 'active',
      season: 'in_window',
      linkMode: 'tracking',
    });
    expect(panel.groups.length).toBeGreaterThan(0);
    expect(panel.groups.length).toBeLessThanOrEqual(6);
    expect(panel.groups.every((group) => group.basis === 'placed')).toBe(true);
    expect(panel.groups.map((group) => group.position)).toEqual(
      panel.groups.map((_, index) => index + 1),
    );

    const group = groupOf(panel, kitItemKey);
    expect(group.position).toBe(1);
    const product = await harness.context.db
      .selectFrom('products')
      .select('ourTitle')
      .where('id', '=', productId)
      .executeTakeFirstOrThrow();
    expect(group.title).toBe(product.ourTitle);

    // Four options at most, spread across the two programs placed in groups, in rotation order.
    expect(group.options).toHaveLength(4);
    const rotation = panel.retailers.map((retailer) => retailer.programKey);
    expect([...rotation].sort()).toEqual([decor.programKey, garden.programKey].sort());
    expect(group.options.map((option) => option.programKey)).toEqual([...rotation, ...rotation]);
    expect(group.options.map((option) => option.position)).toEqual([1, 2, 3, 4]);
    const shownOffers = new Set(
      [offers.decor1, offers.decor2, offers.garden1, offers.garden2].map(
        (offer) => offer.destinationUrl,
      ),
    );

    for (const option of group.options) {
      if (option.programKey === decor.programKey) {
        expect(option.linkMode).toBe('plain');
        expect(shownOffers.has(option.href)).toBe(true);
      } else {
        expect(option.linkMode).toBe('tracking');
        const [prefix, destination] = option.href.split('&u=') as [string, string];
        expect(prefix).toBe(`https://example.com/track?sub=${subIdOf(option.clickToken)}`);
        expect(shownOffers.has(decodeURIComponent(destination))).toBe(true);
      }
      expect(option.price).toMatchObject({ policy: 'show', amountMinor: 2499, currency: 'USD' });
    }

    // Search links in rotation order; the separate program only on its own line.
    const phrase = await harness.context.db
      .selectFrom('kitItemSearchPhrases')
      .select('phrase')
      .where('kitItemKey', '=', kitItemKey)
      .executeTakeFirstOrThrow();
    const query = encodeURIComponent(phrase.phrase);
    expect(group.searchLinks.map((link) => link.programKey)).toEqual(rotation);
    const plainSearch = group.searchLinks.find((link) => link.programKey === decor.programKey);
    expect(plainSearch).toMatchObject({
      linkMode: 'plain',
      sponsored: false,
      merchantName: 'Test Decor',
      href: `https://example.com/${decor.programKey}/search?q=${query}`,
    });
    const trackedSearch = group.searchLinks.find((link) => link.programKey === garden.programKey);
    expect(trackedSearch?.linkMode).toBe('tracking');
    expect(trackedSearch?.href).toBe(
      `https://example.com/track?sub=${subIdOf(trackedSearch?.clickToken ?? '')}&u=${encodeURIComponent(
        `https://example.com/${garden.programKey}/search?q=${query}`,
      )}`,
    );
    expect(group.separateLinks).toEqual([
      expect.objectContaining({
        programKey: market.programKey,
        merchantName: 'Test Market',
        linkMode: 'tracking',
        href: `https://example.com/${market.programKey}/search?q=${query}&tag=test-tag-20`,
      }),
    ]);

    // The separate program never offers options and is never a retailer of the filter.
    const all = linksOf(panel);
    expect(
      all.filter(({ link }) => link.programKey === market.programKey).map(({ kind }) => kind),
    ).toEqual(panel.groups.map(() => 'separate'));
    expect(all.some(({ link }) => link.programKey === realStore.programKey)).toBe(false);
    expect(all.some(({ link }) => link.programKey === bare.programKey)).toBe(false);
    expect(all.every(({ link }) => link.href.startsWith('https://'))).toBe(true);

    // Every group except the first has no offer of these programs and still shows its links.
    for (const other of panel.groups.slice(1)) {
      expect(other.options).toEqual([]);
      expect(other.searchLinks.length + other.separateLinks.length).toBeGreaterThan(0);
    }

    expect(panel.disclosure.copyKeys).toEqual([
      'commerce.disclosure.paid',
      'commerce.disclosure.amazon',
    ]);
    expect([...panel.disclosure.programs].sort()).toEqual(
      [decor.programKey, garden.programKey, market.programKey].sort(),
    );

    // The product link records the ranking of the shown options.
    const ranked = await harness.context.db
      .selectFrom('renderProductLinks')
      .innerJoin('kitItems', 'kitItems.id', 'renderProductLinks.kitItemId')
      .select([
        'renderProductLinks.chosenOfferId',
        'renderProductLinks.candidateOfferIds',
        'renderProductLinks.linkMode',
        'renderProductLinks.rankingReason',
        'renderProductLinks.rankedAt',
      ])
      .where('renderProductLinks.renderAssetId', '=', classic.assetId)
      .where('kitItems.kitItemId', '=', kitItemKey)
      .executeTakeFirstOrThrow();
    const targets = await shopTargetsOf(classic.assetId);
    const optionOffers = group.options.map((option) => {
      const targetId = verifyClickToken(
        harness.config.sessionSecret,
        auth.session.id,
        option.clickToken,
      );
      return targets.find((target) => target.id === targetId)?.offerId;
    });
    expect(ranked).toMatchObject({
      chosenOfferId: optionOffers[0],
      candidateOfferIds: optionOffers,
      linkMode: group.options[0]?.linkMode,
      rankingReason: 'retailer_rotation',
      rankedAt: inWindow,
    });
  });

  it('serves real programs only in real mode and fixture programs only in fixture mode', async () => {
    const real = await panelOf(
      classic.job,
      depsFor({ commerce: 'real', states: [...FIXTURE_STATES(), [bare, 'fixture']] }),
    );
    expect(real.panelState).toBe('active');
    expect(new Set(linksOf(real).map(({ link }) => link.programKey))).toEqual(
      new Set([realStore.programKey]),
    );
    expect(real.retailers).toEqual([
      { programKey: realStore.programKey, merchantName: 'Test Store' },
    ]);
    expect(real.disclosure).toEqual({
      copyKeys: ['commerce.disclosure.plain'],
      programs: [realStore.programKey],
    });

    // A real program in a fixture state is not live, so nothing is served.
    const notLive = await panelOf(
      classic.job,
      depsFor({
        commerce: 'real',
        states: [
          [realStore, 'fixture'],
          [decor, 'fixture'],
        ],
      }),
    );
    expect(notLive.panelState).toBe('hidden');
    // In fixture mode a live real program is not served either.
    const fixtureMode = await panelOf(
      classic.job,
      depsFor({ commerce: 'fixture', states: [[realStore, 'live_public']] }),
    );
    expect(fixtureMode.panelState).toBe('hidden');
  });

  it('shows search links and no options off-season, unless search links are off then', async () => {
    const deps = depsFor({ states: FIXTURE_STATES(), now: offSeason });
    const panel = await panelOf(classic.job, deps);
    expect(panel).toMatchObject({ panelState: 'active', season: 'off_season' });
    expect(panel.groups.every((group) => group.options.length === 0)).toBe(true);
    expect(panel.groups.every((group) => group.searchLinks.length > 0)).toBe(true);
    expect(panel.groups.every((group) => group.separateLinks.length === 1)).toBe(true);

    const off = await panelOf(classic.job, deps, { searchLinksOffSeason: false });
    expect(off).toMatchObject({
      panelState: 'off_season',
      season: null,
      groups: [],
      retailers: [],
    });
  });

  it('lists the look items of the look after the placed groups for a lavish plan only', async () => {
    const lookItems = await harness.context.db
      .selectFrom('lookItems')
      .selectAll()
      .where('holidayId', '=', 'christmas')
      .where('sceneType', '=', 'house_exterior')
      .where('style', '=', 'abundant')
      .where('status', '=', 'active')
      .orderBy('sortOrder')
      .orderBy('lookItemKey')
      .execute();
    expect(lookItems.length).toBeGreaterThan(0);

    const lavish = await panelOf(abundant.job, depsFor({ states: FIXTURE_STATES() }));
    expect(lavish.panelState).toBe('active');
    const placed = lavish.groups.filter((group) => group.basis === 'placed');
    const typical = lavish.groups.filter((group) => group.basis === 'typical');
    expect(lavish.groups).toEqual([...placed, ...typical]);
    expect(lavish.groups.map((group) => group.position)).toEqual(
      lavish.groups.map((_, index) => index + 1),
    );
    expect(typical.map((group) => group.groupKey)).toEqual(
      lookItems.slice(0, 9).map((item) => item.lookItemKey),
    );
    for (const [index, group] of typical.entries()) {
      const item = lookItems[index];
      expect(group.title).toBe(item?.ourTitle);
      expect(group.options).toEqual([]);
      const plain = group.searchLinks.find((link) => link.programKey === decor.programKey);
      expect(plain?.href).toBe(
        `https://example.com/${decor.programKey}/search?q=${encodeURIComponent(
          item?.programOverrides[decor.programKey] ?? item?.searchPhrase ?? '',
        )}`,
      );
      expect(group.separateLinks.map((link) => link.programKey)).toEqual([market.programKey]);
    }
    const typicalTargets = (await shopTargetsOf(abundant.assetId)).filter(
      (target) => target.groupBasis === 'typical',
    );
    expect(typicalTargets.length).toBeGreaterThan(0);
    expect(
      typicalTargets.every((target) => target.lookItemId && target.linkKind === 'search'),
    ).toBe(true);

    const ordinary = await panelOf(classic.job, depsFor({ states: FIXTURE_STATES() }));
    expect(ordinary.groups.some((group) => group.basis === 'typical')).toBe(false);
  });

  it('makes a link plain when its template needs a tracking ID the program lacks', async () => {
    const db = harness.context.db;
    const gardenTemplate =
      'https://example.com/track?sub={subId}&t={trackingId}&u={destinationUrl}';
    try {
      await db
        .updateTable('merchantPrograms')
        .set({ trackingLinkTemplate: gardenTemplate, trackingIds: toJson([]) })
        .where('id', '=', garden.id)
        .execute();
      await db
        .updateTable('merchantPrograms')
        .set({ trackingIds: toJson([]) })
        .where('id', '=', market.id)
        .execute();
      const panel = await panelOf(classic.job, depsFor({ states: FIXTURE_STATES() }));
      expect(panel).toMatchObject({
        panelState: 'active',
        linkMode: 'plain',
        disclosure: { copyKeys: ['commerce.disclosure.plain'] },
      });
      const group = groupOf(panel, kitItemKey);
      // An option: the offer's own page.
      const option = group.options.find((entry) => entry.programKey === garden.programKey);
      expect(option?.linkMode).toBe('plain');
      expect([offers.garden1.destinationUrl, offers.garden2.destinationUrl]).toContain(
        option?.href,
      );
      // A separate link: the retailer's own search results.
      const query = encodeURIComponent(
        (
          await db
            .selectFrom('kitItemSearchPhrases')
            .select('phrase')
            .where('kitItemKey', '=', kitItemKey)
            .executeTakeFirstOrThrow()
        ).phrase,
      );
      expect(group.separateLinks).toEqual([
        expect.objectContaining({
          programKey: market.programKey,
          linkMode: 'plain',
          href: `https://example.com/${market.programKey}/search?q=${query}`,
        }),
      ]);

      // The clicks are recorded as plain.
      for (const token of [option?.clickToken, group.separateLinks[0]?.clickToken]) {
        const response = await client.post('/v1/clicks', { clickToken: token });
        expect(response.statusCode, response.body).toBe(201);
        const row = await db
          .selectFrom('affiliateClicks')
          .selectAll()
          .where('id', '=', json<{ clickId: string }>(response).clickId)
          .executeTakeFirstOrThrow();
        expect(row).toMatchObject({ linkMode: 'plain', sentSubId: null, trackingId: null });
      }
    } finally {
      await db
        .updateTable('merchantPrograms')
        .set({
          trackingLinkTemplate: garden.trackingLinkTemplate,
          trackingIds: toJson(garden.trackingIds),
        })
        .where('id', '=', garden.id)
        .execute();
      await db
        .updateTable('merchantPrograms')
        .set({ trackingIds: toJson(market.trackingIds) })
        .where('id', '=', market.id)
        .execute();
    }
  });

  it('has nothing to show without an offer or a search pattern', async () => {
    const deps = depsFor({ states: [[bare, 'fixture']] });
    expect(await panelOf(classic.job, deps)).toMatchObject({
      panelState: 'no_offers',
      season: null,
      groups: [],
    });
    expect(
      await panelOf(classic.job, depsFor({ states: [[bare, 'fixture']], now: offSeason })),
    ).toMatchObject({ panelState: 'off_season', groups: [] });
  });

  it('stores each shop target once across loads, and the tokens of both loads resolve', async () => {
    const deps = depsFor({ states: FIXTURE_STATES() });
    const first = await panelOf(classic.job, deps);
    const before = await shopTargetsOf(classic.assetId);
    const second = await panelOf(classic.job, deps);
    const after = await shopTargetsOf(classic.assetId);
    expect(after.map((target) => target.id).sort()).toEqual(
      before.map((target) => target.id).sort(),
    );
    expect(new Set(after.map((target) => target.targetKey)).size).toBe(after.length);
    const resolve = (panel: ProductsPanel) =>
      linksOf(panel).map(({ link }) =>
        verifyClickToken(harness.config.sessionSecret, auth.session.id, link.clickToken),
      );
    const firstIds = resolve(first);
    expect(firstIds.every((id) => id !== null && after.some((target) => target.id === id))).toBe(
      true,
    );
    expect(resolve(second)).toEqual(firstIds);
    expect(linksOf(second).map(({ link }) => link.clickToken)).not.toEqual(
      linksOf(first).map(({ link }) => link.clickToken),
    );
    // Targets are numbered within their list; separate links follow the search links.
    const group = groupOf(second, kitItemKey);
    const targetOf = (token: string) =>
      after.find(
        (target) =>
          target.id === verifyClickToken(harness.config.sessionSecret, auth.session.id, token),
      );
    expect(group.options.map((option) => targetOf(option.clickToken)?.optionPosition)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(
      [...group.searchLinks, ...group.separateLinks].map(
        (link) => targetOf(link.clickToken)?.optionPosition,
      ),
    ).toEqual([1, 2, 3]);
    expect(targetOf(group.separateLinks[0]?.clickToken ?? '')).toMatchObject({
      linkKind: 'search',
      placement: 'separate',
      targetKey: `${kitItemKey}|search:${market.programKey}`,
      offerId: null,
      relationship: null,
    });
  });
});

describe('POST /v1/clicks', () => {
  async function clickRow(clickId: string) {
    return harness.context.db
      .selectFrom('affiliateClicks')
      .selectAll()
      .where('id', '=', clickId)
      .executeTakeFirstOrThrow();
  }

  async function lastClickEvent(sessionHash: string) {
    const event = await harness.context.db
      .selectFrom('analyticsEvents')
      .select('properties')
      .where('eventName', '=', 'product_clicked')
      .where('sessionHash', '=', sessionHash)
      .orderBy('occurredAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    return event.properties;
  }

  it('records a click on an option from its shop target', async () => {
    const panel = await panelOf(classic.job, depsFor({ states: FIXTURE_STATES() }));
    const group = groupOf(panel, kitItemKey);
    const option = group.options.find((entry) => entry.programKey === garden.programKey);
    if (!option) throw new Error('no tracked option');
    const response = await client.post('/v1/clicks', { clickToken: option.clickToken });
    expect(response.statusCode, response.body).toBe(201);
    const row = await clickRow(json<{ clickId: string }>(response).clickId);
    const targetId = verifyClickToken(
      harness.config.sessionSecret,
      auth.session.id,
      option.clickToken,
    );
    const target = (await shopTargetsOf(classic.assetId)).find((entry) => entry.id === targetId);
    expect(target).toBeDefined();
    expect(row).toMatchObject({
      shopTargetId: targetId,
      linkKind: 'product',
      groupBasis: 'placed',
      groupKey: kitItemKey,
      groupPosition: 1,
      optionPosition: option.position,
      rankPosition: 1,
      offerId: target?.offerId,
      renderProductLinkId: target?.renderProductLinkId,
      merchantProgramId: garden.id,
      linkMode: 'tracking',
      sentSubId: subIdOf(option.clickToken),
      trackingId: 'test-tag-20',
      relationship: option.relationship,
      holidayId: 'christmas',
    });
    expect(row.sentSubId).toMatch(/^[0-9a-f]+$/);
    expect([offers.garden1.id, offers.garden2.id]).toContain(row.offerId);
    expect(await lastClickEvent(row.sessionHash)).toMatchObject({
      relationship: option.relationship,
      rankPosition: 1,
      optionPosition: option.position,
      linkKind: 'product',
      groupBasis: 'placed',
      merchantProgramId: garden.programKey,
      linkMode: 'tracking',
      sponsored: false,
    });

    const repeat = await client.post('/v1/clicks', { clickToken: option.clickToken });
    expect(repeat.statusCode).toBe(201);
    expect(json(repeat).clickId).toBe(row.id);
  });

  it('records a click on a search link and on a separate link', async () => {
    const panel = await panelOf(classic.job, depsFor({ states: FIXTURE_STATES() }));
    const group = groupOf(panel, kitItemKey);
    const search = group.searchLinks.find((link) => link.programKey === decor.programKey);
    if (!search) throw new Error('no plain search link');
    const response = await client.post('/v1/clicks', { clickToken: search.clickToken });
    expect(response.statusCode, response.body).toBe(201);
    const row = await clickRow(json<{ clickId: string }>(response).clickId);
    expect(row).toMatchObject({
      linkKind: 'search',
      groupBasis: 'placed',
      groupKey: kitItemKey,
      groupPosition: 1,
      optionPosition: group.searchLinks.indexOf(search) + 1,
      offerId: null,
      relationship: null,
      merchantProgramId: decor.id,
      linkMode: 'plain',
      sentSubId: null,
      trackingId: null,
    });
    expect(await lastClickEvent(row.sessionHash)).toMatchObject({
      relationship: null,
      rankPosition: 1,
      linkKind: 'search',
      groupBasis: 'placed',
      merchantProgramId: decor.programKey,
      linkMode: 'plain',
    });

    const separate = group.separateLinks[0];
    if (!separate) throw new Error('no separate link');
    const separateClick = await client.post('/v1/clicks', { clickToken: separate.clickToken });
    expect(separateClick.statusCode).toBe(201);
    expect(await clickRow(json<{ clickId: string }>(separateClick).clickId)).toMatchObject({
      linkKind: 'search',
      optionPosition: group.searchLinks.length + 1,
      merchantProgramId: market.id,
      linkMode: 'tracking',
      // The separate program has no sub-ID capability; its tracking ID is still recorded.
      sentSubId: null,
      trackingId: 'test-tag-20',
    });
  });

  it('records a click on a look item from its shop target', async () => {
    const panel = await panelOf(abundant.job, depsFor({ states: FIXTURE_STATES() }));
    const typical = panel.groups.find((group) => group.basis === 'typical');
    const link = typical?.searchLinks[0];
    if (!typical || !link) throw new Error('no typical group');
    const response = await client.post('/v1/clicks', { clickToken: link.clickToken });
    expect(response.statusCode).toBe(201);
    expect(await clickRow(json<{ clickId: string }>(response).clickId)).toMatchObject({
      linkKind: 'search',
      groupBasis: 'typical',
      groupKey: typical.groupKey,
      groupPosition: typical.position,
      rankPosition: typical.position,
      renderProductLinkId: null,
      offerId: null,
      relationship: null,
    });
  });

  it("refuses another session's token, a token for another owner's target and a gone target", async () => {
    const panel = await panelOf(classic.job, depsFor({ states: FIXTURE_STATES() }));
    const link = groupOf(panel, kitItemKey).searchLinks[0];
    if (!link) throw new Error('no search link');
    const other = await newClient();
    const stolen = await other.post('/v1/clicks', { clickToken: link.clickToken });
    expect(stolen.statusCode).toBe(404);

    // A token correctly issued to another session still names a target it does not own.
    const targetId = verifyClickToken(
      harness.config.sessionSecret,
      auth.session.id,
      link.clickToken,
    );
    const otherAuth = await authOf(other);
    const reissued = issueClickToken(
      harness.config.sessionSecret,
      otherAuth.session.id,
      targetId as string,
    );
    expect((await other.post('/v1/clicks', { clickToken: reissued })).statusCode).toBe(404);

    // Nothing but the token is accepted from the request.
    const extra = await client.post('/v1/clicks', {
      clickToken: link.clickToken,
      offerId: offers.decor1.id,
    });
    expect(extra.statusCode).toBe(400);

    const gone = await harness.context.db
      .insertInto('renderShopTargets')
      .values({
        id: newId(),
        renderAssetId: classic.assetId,
        targetKey: `removed|search:${decor.programKey}`,
        linkKind: 'search',
        groupBasis: 'placed',
        groupKey: 'removed',
        merchantProgramId: decor.id,
        linkMode: 'plain',
        placement: 'group',
        groupPosition: 1,
        optionPosition: 1,
        lastShownAt: inWindow,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const goneToken = issueClickToken(harness.config.sessionSecret, auth.session.id, gone.id);
    await harness.context.db.deleteFrom('renderShopTargets').where('id', '=', gone.id).execute();
    expect((await client.post('/v1/clicks', { clickToken: goneToken })).statusCode).toBe(404);
  });

  it('refuses a click on a rendering that was withdrawn or deleted', async () => {
    const db = harness.context.db;
    const panel = await panelOf(classic.job, depsFor({ states: FIXTURE_STATES() }));
    const [withdrawnLink, deletedLink] = groupOf(panel, kitItemKey).searchLinks;
    if (!withdrawnLink || !deletedLink) throw new Error('too few search links');
    const setAsset = (values: { withdrawnAt?: Date | null; deletedAt?: Date | null }) =>
      db.updateTable('renderAssets').set(values).where('id', '=', classic.assetId).execute();
    try {
      await setAsset({ withdrawnAt: inWindow });
      const withdrawn = await client.post('/v1/clicks', { clickToken: withdrawnLink.clickToken });
      expect(withdrawn.statusCode).toBe(404);
      await setAsset({ withdrawnAt: null, deletedAt: inWindow });
      const deleted = await client.post('/v1/clicks', { clickToken: deletedLink.clickToken });
      expect(deleted.statusCode).toBe(404);
    } finally {
      await setAsset({ withdrawnAt: null, deletedAt: null });
    }
    // The same tokens are accepted once the rendering is back.
    for (const link of [withdrawnLink, deletedLink]) {
      expect((await client.post('/v1/clicks', { clickToken: link.clickToken })).statusCode).toBe(
        201,
      );
    }
  });
});
