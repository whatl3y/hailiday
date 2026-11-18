import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AnchorCategorySchema,
  FAILURE_CODES,
  SEARCH_QUERY_PLACEHOLDER,
  commerceCapabilityKey,
  programRightAllowed,
  type AnchorCategory,
  type CardPrice,
  type CommerceMode,
  type DisclosureCopyKey,
  type FailureCode,
  type LinkMode,
  type ProductRelationship,
  type ProductsPanel,
  type ProgramKind,
  type ProgramRightUse,
  type ShopGroup,
  type ShopGroupBasis,
  type ShopLinkKind,
  type ShopSearchLink,
  type ShopSeason,
} from '@hailiday/core';
import { capabilityMode, type Audience, type CapabilityMode } from '@hailiday/server/capabilities';
import { DAY_MS, HOUR_MS } from '@hailiday/server/clock';
import { sql, type MerchantProgram, type Offer, type RenderJob } from '@hailiday/server/db';
import { AppError } from '@hailiday/server/errors';
import { newId, sha256Hex } from '@hailiday/server/ids';
import type { ApiDeps } from '../deps.js';
import type { AuthState } from '../auth/session.js';
import { commerceOccurrenceOf, holidayCalendar } from './holidays.js';
import { loadSource } from './projects.js';
import { acceptedPlanIsLavish } from './renders.js';
import { evaluateFor, refreshStreetViewPolicyOf } from './sources.js';

/** Panel configuration (commerce spec defaults). */
export const COMMERCE_DEFAULTS = {
  /** Groups of decorations the plan placed. */
  maxGroups: 6,
  /** Groups of look items (lavish plans only), after the placed groups. */
  maxTypicalGroups: 9,
  /** Product options in one group. */
  maxOptions: 4,
  /** Fewer groups than this and the panel has nothing to show. */
  minGroups: 1,
  /** Search links show outside the commerce window too; options never do. */
  searchLinksOffSeason: true,
  /** Freshness limits after which an offer is never shown. */
  freshnessInWindowMs: 4 * DAY_MS,
  freshnessOutOfWindowMs: 8 * DAY_MS,
  /** A displayed price must have been observed within this period. */
  priceFreshnessMs: 24 * HOUR_MS,
  /** Acquisition channel of Amazon tracking IDs for direct traffic. */
  channel: 'direct',
} as const;

/** Runtime setting used as the global commerce pause. */
export const COMMERCE_PAUSE_KEY = 'pause.provider.commerce';

const TRACKING_STATUSES = new Set(['provisional', 'approved']);
const TRACKING_ID_PLACEHOLDER = '{trackingId}';
const HIDDEN = (): ProductsPanel => ({
  panelState: 'hidden',
  linkMode: null,
  season: null,
  disclosure: { copyKeys: [], programs: [] },
  retailers: [],
  groups: [],
});

/** Byte length of a click token: a 16-byte ID, a 6-byte nonce and a 12-byte MAC. */
const CLICK_TOKEN_BYTES = 34;

/**
 * Click tokens are pre-issued with each option and link: the shop target ID, a nonce and a MAC
 * bound to the viewer's session, so `POST /v1/clicks` can verify them without storing unused
 * tokens. What a click records is read from the shop target (recorded at panel load).
 */
export function issueClickToken(secret: string, sessionId: string, targetId: string): string {
  const id = Buffer.from(targetId.replace(/-/g, ''), 'hex');
  const nonce = randomBytes(6);
  const mac = createHmac('sha256', `click:${secret}`)
    .update(`${sessionId}:${targetId}:${nonce.toString('hex')}`)
    .digest()
    .subarray(0, 12);
  return Buffer.concat([id, nonce, mac]).toString('base64url');
}

/**
 * Verifies a click token for a session; returns the shop target ID or null. Only the canonical
 * spelling of the token's bytes is accepted, so one token has exactly one form.
 */
export function verifyClickToken(secret: string, sessionId: string, token: string): string | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length !== CLICK_TOKEN_BYTES) return null;
  if (bytes.toString('base64url') !== token) return null;
  const hex = bytes.subarray(0, 16).toString('hex');
  const targetId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const nonce = bytes.subarray(16, 22);
  const expected = createHmac('sha256', `click:${secret}`)
    .update(`${sessionId}:${targetId}:${nonce.toString('hex')}`)
    .digest()
    .subarray(0, 12);
  const mac = bytes.subarray(22);
  return mac.length === expected.length && timingSafeEqual(mac, expected) ? targetId : null;
}

/**
 * The sub-ID sent to a network for a click token: the lowercase hex of SHA-256 over `subid:` and
 * the token's bytes (64 characters). It is opaque: neither the token nor its shop target can be
 * read back from it.
 */
export function subIdOf(token: string): string {
  return createHash('sha256')
    .update('subid:')
    .update(Buffer.from(token, 'base64url'))
    .digest('hex');
}

/** Fills a program's tracking template: `{destinationUrl}` raw at the start, encoded elsewhere. */
export function fillTrackingTemplate(
  template: string,
  values: { destinationUrl: string; subId: string | null; trackingId: string | null },
): string {
  let url = template;
  url = url.startsWith('{destinationUrl}')
    ? values.destinationUrl +
      url
        .slice('{destinationUrl}'.length)
        .replaceAll('{destinationUrl}', encodeURIComponent(values.destinationUrl))
    : url.replaceAll('{destinationUrl}', encodeURIComponent(values.destinationUrl));
  url = url.replaceAll('{subId}', encodeURIComponent(values.subId ?? ''));
  url = url.replaceAll('{trackingId}', encodeURIComponent(values.trackingId ?? ''));
  return url;
}

/** A retailer's search results for a phrase: the pattern with `{query}` as the encoded phrase. */
export function fillSearchTemplate(template: string, phrase: string): string {
  return template.replaceAll(SEARCH_QUERY_PLACEHOLDER, encodeURIComponent(phrase));
}

/**
 * Whether a program is served to a viewer: a fixture program needs the fixture commerce mode and
 * a `fixture` capability mode; a real program needs the real commerce mode and a `live` one. So
 * fixture and real programs are never served together.
 */
export function programServed(
  kind: ProgramKind,
  mode: CapabilityMode,
  commerceMode: CommerceMode,
): boolean {
  return kind === 'fixture'
    ? commerceMode === 'fixture' && mode === 'fixture'
    : commerceMode === 'real' && mode === 'live';
}

/** The merchant programs served to an audience (`programServed`), in no particular order. */
export async function servedPrograms(
  deps: Pick<ApiDeps, 'db' | 'capabilities' | 'config'>,
  audience: Audience,
): Promise<MerchantProgram[]> {
  const [programs, rows] = await Promise.all([
    deps.db.selectFrom('merchantPrograms').selectAll().execute(),
    deps.capabilities.list('US'),
  ]);
  const states = new Map(rows.map((row) => [row.capability, row.state]));
  return programs.filter((program) => {
    const state = states.get(commerceCapabilityKey(program.programKey)) ?? null;
    const mode = capabilityMode(state, audience, deps.config.appEnv);
    return programServed(program.kind, mode, deps.config.providers.commerce);
  });
}

/**
 * Programs in the rotation of one rendering: ordered by the SHA-256 hex of
 * `<renderAssetId>:<programKey>`, so the order is stable for a rendering and differs between
 * renderings. Never ordered by commission, attribution window or program status.
 */
export function rotationOf<T extends Pick<MerchantProgram, 'programKey'>>(
  renderAssetId: string,
  programs: readonly T[],
): T[] {
  return programs
    .map((program) => ({ program, key: sha256Hex(`${renderAssetId}:${program.programKey}`) }))
    .sort((a, b) => compareText(a.key, b.key))
    .map((entry) => entry.program);
}

/**
 * The link mode of an option (`kind` `product`) or search link (`search`): `tracking` only when
 * the program is `provisional` or `approved`, a tracking template exists, the program has a
 * tracking ID for the look's holiday and channel when the template uses `{trackingId}`, and its
 * terms are recorded as allowing tracked links of that kind, links beside an AI picture and, for
 * a program placed in a group, links beside other retailers. Otherwise `plain`.
 */
export function linkModeFor(
  program: Pick<MerchantProgram, 'status' | 'placement' | 'displayRights'>,
  kind: ShopLinkKind,
  template: string | null,
  trackingId: string | null,
): LinkMode {
  if (!TRACKING_STATUSES.has(program.status) || !template) return 'plain';
  if (template.includes(TRACKING_ID_PLACEHOLDER) && !trackingId) return 'plain';
  const uses: ProgramRightUse[] = [
    kind === 'product' ? 'tracked_product_links' : 'tracked_search_links',
    'beside_ai_picture',
    ...(program.placement === 'group' ? (['beside_other_retailers'] as const) : []),
  ];
  return uses.every((use) => programRightAllowed(program.displayRights, use))
    ? 'tracking'
    : 'plain';
}

/** Whether an offer's price may be shown: a permitted source and an observation fresh enough. */
export function priceDisplayable(
  offer: Pick<Offer, 'priceSource' | 'priceMinor' | 'priceObservedAt'>,
  now: Date,
): boolean {
  return (
    offer.priceSource !== 'none' &&
    offer.priceMinor !== null &&
    offer.priceObservedAt !== null &&
    now.getTime() - offer.priceObservedAt.getTime() <= COMMERCE_DEFAULTS.priceFreshnessMs
  );
}

/** Why the first option of a group is first (recorded on the product link). */
export type RankingReason =
  'single_offer' | 'in_stock' | 'price_displayable' | 'retailer_rotation' | 'offer_id' | 'no_offer';

export interface OptionCandidate {
  offer: Offer;
  program: MerchantProgram;
}

/**
 * Orders the options of a group: in stock first, then a displayable price first, then a
 * round-robin across programs in rotation order (each program's first offer, then its second, and
 * so on), and within a program by offer ID. Commission, attribution window and program status
 * never take part. Returns the criterion that put the first option ahead of the second.
 */
export function orderOptions<T extends OptionCandidate>(
  candidates: readonly T[],
  rotation: readonly Pick<MerchantProgram, 'id'>[],
  now: Date,
): { ordered: T[]; reason: RankingReason } {
  const rank = new Map(rotation.map((program, index) => [program.id, index]));
  const inStock = (candidate: T) => candidate.offer.availability === 'in_stock';
  const priced = (candidate: T) => priceDisplayable(candidate.offer, now);
  const tierOf = (candidate: T) => (inStock(candidate) ? 0 : 2) + (priced(candidate) ? 0 : 1);
  const rounds = new Map<string, number>();
  const keyed = [...candidates]
    .sort((a, b) => compareText(a.offer.id, b.offer.id))
    .map((candidate) => {
      const tier = tierOf(candidate);
      const slot = `${tier}:${candidate.program.id}`;
      const round = rounds.get(slot) ?? 0;
      rounds.set(slot, round + 1);
      return { candidate, tier, round, rotation: rank.get(candidate.program.id) ?? rank.size };
    });
  keyed.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.round - b.round ||
      a.rotation - b.rotation ||
      compareText(a.candidate.offer.id, b.candidate.offer.id),
  );
  const ordered = keyed.map((entry) => entry.candidate);
  if (ordered.length === 0) return { ordered, reason: 'no_offer' };
  if (ordered.length === 1) return { ordered, reason: 'single_offer' };
  const [first, second] = ordered as [T, T];
  const reason: RankingReason =
    inStock(first) !== inStock(second)
      ? 'in_stock'
      : priced(first) !== priced(second)
        ? 'price_displayable'
        : first.program.id !== second.program.id
          ? 'retailer_rotation'
          : 'offer_id';
  return { ordered, reason };
}

/** One option or link of the panel before it is stored as a shop target. */
export interface ShopLinkPlan {
  linkKind: ShopLinkKind;
  program: MerchantProgram;
  offer: Offer | null;
  linkMode: LinkMode;
  /** The plain destination: the offer's page or the retailer's search results. */
  destination: string;
  /** The tracking pattern the link is built with when its mode is `tracking`. */
  template: string | null;
  trackingId: string | null;
}

/**
 * A sample sub-ID for checking a link before its token exists: as long as a real one (64 hex
 * characters) and, like it, alphanumeric, so the built link starts with the same characters.
 */
const SAMPLE_SUB_ID = '0'.repeat(64);

/** The link a viewer follows: the plain destination or the filled tracking template. */
export function hrefOf(link: ShopLinkPlan, subId: string | null): string {
  if (link.linkMode !== 'tracking' || !link.template) return link.destination;
  return fillTrackingTemplate(link.template, {
    destinationUrl: link.destination,
    subId,
    trackingId: link.trackingId,
  });
}

/**
 * Whether a link and the destination it leads to are both `https://` (a link that is not is never
 * shown).
 */
export function isHttpsLink(link: ShopLinkPlan): boolean {
  const href = hrefOf(link, link.program.subIdCapability ? SAMPLE_SUB_ID : null);
  return link.destination.startsWith('https://') && href.startsWith('https://');
}

/** The tracking ID of a program for a holiday on the direct channel, or null. */
function trackingIdOf(
  program: Pick<MerchantProgram, 'trackingIds'>,
  holidayId: string,
): string | null {
  return (
    program.trackingIds.find(
      (entry) => entry.holidayId === holidayId && entry.channel === COMMERCE_DEFAULTS.channel,
    )?.trackingId ?? null
  );
}

/** The plan of an option for an offer of a program. */
export function optionLinkOf(candidate: OptionCandidate, holidayId: string): ShopLinkPlan {
  const template = candidate.offer.trackingUrlTemplate ?? candidate.program.trackingLinkTemplate;
  const trackingId = trackingIdOf(candidate.program, holidayId);
  const linkMode = linkModeFor(candidate.program, 'product', template, trackingId);
  return {
    linkKind: 'product',
    program: candidate.program,
    offer: candidate.offer,
    linkMode,
    destination: candidate.offer.destinationUrl,
    template: linkMode === 'tracking' ? template : null,
    trackingId,
  };
}

/**
 * The search links of a decoration: one per program in rotation order that has a search pattern
 * and a phrase (its override, else the decoration's phrase). Programs placed in a group go to
 * `searchLinks`, the others to `separateLinks`. A link that would not be `https://` is left out
 * and reported through `onDropped`.
 */
export function searchLinksOf(
  rotation: readonly MerchantProgram[],
  input: {
    phrase: string | null;
    programOverrides: Readonly<Record<string, string>>;
    holidayId: string;
    onDropped?: (link: ShopLinkPlan) => void;
  },
): { searchLinks: ShopLinkPlan[]; separateLinks: ShopLinkPlan[] } {
  const searchLinks: ShopLinkPlan[] = [];
  const separateLinks: ShopLinkPlan[] = [];
  for (const program of rotation) {
    if (!program.searchUrlTemplate) continue;
    const phrase = input.programOverrides[program.programKey] ?? input.phrase;
    if (!phrase) continue;
    const trackingId = trackingIdOf(program, input.holidayId);
    const linkMode = linkModeFor(program, 'search', program.trackingLinkTemplate, trackingId);
    const link: ShopLinkPlan = {
      linkKind: 'search',
      program,
      offer: null,
      linkMode,
      destination: fillSearchTemplate(program.searchUrlTemplate, phrase),
      template: linkMode === 'tracking' ? program.trackingLinkTemplate : null,
      trackingId,
    };
    if (!isHttpsLink(link)) {
      input.onDropped?.(link);
      continue;
    }
    (program.placement === 'separate' ? separateLinks : searchLinks).push(link);
  }
  return { searchLinks, separateLinks };
}

/** A decoration of the panel before its options and links are stored as shop targets. */
interface GroupPlan {
  groupKey: string;
  basis: ShopGroupBasis;
  title: string;
  anchorCategory: AnchorCategory | null;
  renderProductLinkId: string | null;
  lookItemId: string | null;
  /** The relationship of the plan's product to the picture (placed groups). */
  relationship: ProductRelationship | null;
  /** The product link's own sponsored flag (placed groups). */
  sponsored: boolean;
  options: ShopLinkPlan[];
  searchLinks: ShopLinkPlan[];
  separateLinks: ShopLinkPlan[];
}

function hasSomethingToShow(group: GroupPlan): boolean {
  return group.options.length + group.searchLinks.length + group.separateLinks.length > 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function anchorOf(value: string | null): AnchorCategory | null {
  const parsed = AnchorCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function priceOf(offer: Offer, now: Date): CardPrice {
  return priceDisplayable(offer, now) && offer.priceObservedAt && offer.priceMinor !== null
    ? {
        policy: 'show',
        amountMinor: offer.priceMinor,
        currency: offer.currency.trim(),
        observedAt: offer.priceObservedAt.toISOString(),
      }
    : { policy: 'check_at_retailer' };
}

/**
 * The Shop the look panel for a job (commerce spec). `hidden` unless the job succeeded, a program
 * is served to the viewer, the commerce pause is off and the source allows commerce adjacency.
 * Otherwise one group per decoration: the kit items the plan placed (described first, then kit
 * order, at most six), then, for a lavish plan, the look items typical of the look (at most
 * nine). A group holds up to four product options (inside the commerce window only), a row of
 * search links and the lines of programs kept separate. Every option and link shown is stored as
 * a shop target and carries a click token issued for it. `off_season` outside the commerce window
 * when search links are off then, `no_offers` (or `off_season`) when no group has anything.
 */
export async function buildProductsPanel(
  deps: ApiDeps,
  auth: AuthState,
  job: RenderJob,
  options: { searchLinksOffSeason?: boolean } = {},
): Promise<ProductsPanel> {
  if (job.state === 'rejected') {
    throw new AppError('RENDER_REJECTED', {
      rejectionReason: job.rejectionReason,
      failureCodes: (job.failureCodes ?? []).filter((code): code is FailureCode =>
        (FAILURE_CODES as readonly string[]).includes(code),
      ),
    });
  }
  if (job.state !== 'succeeded' || !job.renderAssetId) return HIDDEN();
  const asset = await deps.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('id', '=', job.renderAssetId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!asset || asset.withdrawnAt) return HIDDEN();
  if ((await deps.settings.getRaw(COMMERCE_PAUSE_KEY)) === true) return HIDDEN();

  const source = await loadSource(deps, asset.sourceAssetId);
  if (source) {
    // A Street View source's template-derived policy is brought up to the current use policy
    // first, so a tightened `STREET_VIEW_USE_POLICY` hides the panel on the first request.
    const policy =
      source.kind === 'street_view'
        ? await refreshStreetViewPolicyOf(deps, deps.db, source.assetPolicyId)
        : undefined;
    const { permission } = await evaluateFor(deps, {
      policyId: source.assetPolicyId,
      ...(policy !== undefined ? { policy } : {}),
      kind: source.kind,
      isGoogleImagery: source.isGoogleImagery,
      copyright: source.copyright,
      audience: auth.audience,
    });
    if (!permission.commerceAdjacent) return HIDDEN();
  }

  const served = await servedPrograms(deps, auth.audience);
  if (served.length === 0) return HIDDEN();

  const now = deps.clock.now();
  const calendar = await holidayCalendar(deps);
  const occurrence = commerceOccurrenceOf(calendar.rows, job.holidayId, now);
  const season: ShopSeason = occurrence ? 'in_window' : 'off_season';
  const searchLinksOffSeason =
    options.searchLinksOffSeason ?? COMMERCE_DEFAULTS.searchLinksOffSeason;
  if (!occurrence && !searchLinksOffSeason) return { ...HIDDEN(), panelState: 'off_season' };

  const rotation = rotationOf(asset.id, served);
  const byId = new Map(rotation.map((program) => [program.id, program]));
  const onDropped = (link: ShopLinkPlan) =>
    deps.logger.warn(
      { programKey: link.program.programKey, linkKind: link.linkKind },
      'shop link left out: not https',
    );

  // Placed groups: the kit items the plan placed, described first, then kit order.
  const links = await deps.db
    .selectFrom('renderProductLinks')
    .innerJoin('kitItems', 'kitItems.id', 'renderProductLinks.kitItemId')
    .select([
      'renderProductLinks.id as linkId',
      'renderProductLinks.relationship',
      'renderProductLinks.sponsored',
      'renderProductLinks.productId as linkedProductId',
      'kitItems.kitItemId as kitItemKey',
      'kitItems.currentProductId',
      'kitItems.sortOrder',
      'kitItems.anchorCategory',
    ])
    .where('renderProductLinks.renderAssetId', '=', asset.id)
    .where('renderProductLinks.hiddenAt', 'is', null)
    .execute();
  links.sort(
    (a, b) =>
      Number(b.relationship === 'described') - Number(a.relationship === 'described') ||
      a.sortOrder - b.sortOrder,
  );
  const productIds = [
    ...new Set(links.map((link) => link.currentProductId ?? link.linkedProductId)),
  ];
  const kitItemKeys = [...new Set(links.map((link) => link.kitItemKey))];
  const products =
    productIds.length > 0
      ? await deps.db
          .selectFrom('products')
          .select(['id', 'ourTitle'])
          .where('id', 'in', productIds)
          .where('archivedAt', 'is', null)
          .execute()
      : [];
  const productById = new Map(products.map((product) => [product.id, product]));
  const phrases =
    kitItemKeys.length > 0
      ? await deps.db
          .selectFrom('kitItemSearchPhrases')
          .select(['kitItemKey', 'phrase', 'programOverrides'])
          .where('kitItemKey', 'in', kitItemKeys)
          .execute()
      : [];
  const phraseByKey = new Map(phrases.map((row) => [row.kitItemKey, row]));
  const groupPrograms = rotation.filter((program) => program.placement === 'group');
  const offers =
    occurrence && products.length > 0 && groupPrograms.length > 0
      ? await deps.db
          .selectFrom('offers')
          .selectAll()
          .where(
            'productId',
            'in',
            products.map((product) => product.id),
          )
          .where('status', '=', 'active')
          .where('destinationCountry', '=', 'US')
          .execute()
      : [];
  const freshness = COMMERCE_DEFAULTS.freshnessInWindowMs;
  const eligibleByProduct = new Map<string, OptionCandidate[]>();
  for (const offer of offers) {
    const program = byId.get(offer.merchantProgramId);
    if (!program || program.placement !== 'group' || !occurrence) continue;
    if (!offer.seasonalEligibility.includes(occurrence.occurrenceKey)) continue;
    if (!offer.lastVerifiedAt || now.getTime() - offer.lastVerifiedAt.getTime() > freshness) {
      continue;
    }
    if (offer.availability === 'out_of_stock') continue;
    const list = eligibleByProduct.get(offer.productId) ?? [];
    list.push({ offer, program });
    eligibleByProduct.set(offer.productId, list);
  }

  const groups: GroupPlan[] = [];
  const seenKeys = new Set<string>();
  const rankings: {
    id: string;
    chosen: string | null;
    mode: LinkMode | null;
    candidates: string[];
    reason: RankingReason;
  }[] = [];
  for (const link of links) {
    if (groups.length >= COMMERCE_DEFAULTS.maxGroups) break;
    if (seenKeys.has(link.kitItemKey)) continue;
    const product = productById.get(link.currentProductId ?? link.linkedProductId);
    if (!product) continue;
    const usable = (eligibleByProduct.get(product.id) ?? []).flatMap((candidate) => {
      const option = optionLinkOf(candidate, job.holidayId);
      if (isHttpsLink(option)) return [{ ...candidate, option }];
      onDropped(option);
      return [];
    });
    const { ordered, reason } = orderOptions(usable, rotation, now);
    const chosen = ordered.slice(0, COMMERCE_DEFAULTS.maxOptions);
    const phrase = phraseByKey.get(link.kitItemKey);
    const group: GroupPlan = {
      groupKey: link.kitItemKey,
      basis: 'placed',
      title: product.ourTitle,
      anchorCategory: anchorOf(link.anchorCategory),
      renderProductLinkId: link.linkId,
      lookItemId: null,
      relationship: link.relationship,
      sponsored: link.sponsored,
      options: chosen.map((candidate) => candidate.option),
      ...searchLinksOf(rotation, {
        phrase: phrase?.phrase ?? null,
        programOverrides: phrase?.programOverrides ?? {},
        holidayId: job.holidayId,
        onDropped,
      }),
    };
    if (!hasSomethingToShow(group)) continue;
    seenKeys.add(group.groupKey);
    groups.push(group);
    const first = group.options[0];
    rankings.push({
      id: link.linkId,
      chosen: first?.offer?.id ?? null,
      mode: first?.linkMode ?? null,
      candidates: chosen.map((candidate) => candidate.offer.id),
      reason: chosen.length > 0 ? reason : 'no_offer',
    });
  }

  // Typical groups: the look items of the look, for a lavish plan only.
  if (source?.sceneType && (await acceptedPlanIsLavish(deps, asset))) {
    const lookItems = await deps.db
      .selectFrom('lookItems')
      .selectAll()
      .where('holidayId', '=', asset.holidayId)
      .where('sceneType', '=', source.sceneType)
      .where('style', '=', asset.style)
      .where('status', '=', 'active')
      .orderBy('sortOrder')
      .orderBy('lookItemKey')
      .execute();
    let typical = 0;
    for (const item of lookItems) {
      if (typical >= COMMERCE_DEFAULTS.maxTypicalGroups) break;
      if (seenKeys.has(item.lookItemKey)) continue;
      const group: GroupPlan = {
        groupKey: item.lookItemKey,
        basis: 'typical',
        title: item.ourTitle,
        anchorCategory: anchorOf(item.anchorCategory),
        renderProductLinkId: null,
        lookItemId: item.id,
        relationship: null,
        sponsored: false,
        options: [],
        ...searchLinksOf(rotation, {
          phrase: item.searchPhrase,
          programOverrides: item.programOverrides,
          holidayId: job.holidayId,
          onDropped,
        }),
      };
      if (!hasSomethingToShow(group)) continue;
      seenKeys.add(group.groupKey);
      groups.push(group);
      typical += 1;
    }
  }

  if (rankings.length > 0) {
    await sql`
      update render_product_links as link set
        chosen_offer_id = ranked.chosen,
        link_mode = ranked.mode,
        candidate_offer_ids = ranked.candidates,
        ranking_reason = ranked.reason,
        ranked_at = ${now}
      from (values ${sql.join(
        rankings.map(
          (row) =>
            sql`(${row.id}::uuid, ${row.chosen}::uuid, ${row.mode}::text, ${row.candidates}::uuid[], ${row.reason}::text)`,
        ),
      )}) as ranked (id, chosen, mode, candidates, reason)
      where link.id = ranked.id`.execute(deps.db);
  }

  if (groups.length < COMMERCE_DEFAULTS.minGroups) {
    return { ...HIDDEN(), panelState: occurrence ? 'no_offers' : 'off_season' };
  }

  // One shop target per option and link shown, upserted in one statement.
  const targetKeyOf = (group: GroupPlan, link: ShopLinkPlan) =>
    link.offer
      ? `${group.groupKey}|product:${link.offer.id}`
      : `${group.groupKey}|search:${link.program.programKey}`;
  const sponsoredOf = (group: GroupPlan, link: ShopLinkPlan) =>
    link.offer ? link.offer.sponsored || group.sponsored : false;
  const targets = groups.flatMap((group, groupIndex) => [
    ...group.options.map((link, index) => ({ group, groupIndex, link, position: index + 1 })),
    ...[...group.searchLinks, ...group.separateLinks].map((link, index) => ({
      group,
      groupIndex,
      link,
      position: index + 1,
    })),
  ]);
  const stored = await deps.db
    .insertInto('renderShopTargets')
    .values(
      targets.map(({ group, groupIndex, link, position }) => ({
        id: newId(),
        renderAssetId: asset.id,
        targetKey: targetKeyOf(group, link),
        linkKind: link.linkKind,
        groupBasis: group.basis,
        groupKey: group.groupKey,
        renderProductLinkId: group.renderProductLinkId,
        lookItemId: group.lookItemId,
        offerId: link.offer?.id ?? null,
        merchantProgramId: link.program.id,
        linkMode: link.linkMode,
        placement: link.program.placement,
        relationship: link.offer ? group.relationship : null,
        groupPosition: groupIndex + 1,
        optionPosition: position,
        sponsored: sponsoredOf(group, link),
        lastShownAt: now,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['renderAssetId', 'targetKey']).doUpdateSet((eb) => ({
        linkMode: eb.ref('excluded.linkMode'),
        placement: eb.ref('excluded.placement'),
        relationship: eb.ref('excluded.relationship'),
        groupPosition: eb.ref('excluded.groupPosition'),
        optionPosition: eb.ref('excluded.optionPosition'),
        sponsored: eb.ref('excluded.sponsored'),
        merchantProgramId: eb.ref('excluded.merchantProgramId'),
        offerId: eb.ref('excluded.offerId'),
        renderProductLinkId: eb.ref('excluded.renderProductLinkId'),
        lookItemId: eb.ref('excluded.lookItemId'),
        groupBasis: eb.ref('excluded.groupBasis'),
        groupKey: eb.ref('excluded.groupKey'),
        lastShownAt: eb.ref('excluded.lastShownAt'),
      })),
    )
    .returning(['id', 'targetKey'])
    .execute();
  const targetIds = new Map(stored.map((row) => [row.targetKey, row.id]));

  let anyTracking = false;
  let anyAmazonTracking = false;
  const shownPrograms = new Set<string>();
  const retailerPrograms = new Set<string>();
  const issue = (group: GroupPlan, link: ShopLinkPlan) => {
    const targetId = targetIds.get(targetKeyOf(group, link));
    if (!targetId) throw new Error('shop target missing after upsert');
    const clickToken = issueClickToken(deps.config.sessionSecret, auth.session.id, targetId);
    const subId = link.program.subIdCapability ? subIdOf(clickToken) : null;
    if (link.linkMode === 'tracking') {
      anyTracking = true;
      if (link.program.programType === 'amazon_associates') anyAmazonTracking = true;
    }
    shownPrograms.add(link.program.id);
    if (link.program.placement === 'group') retailerPrograms.add(link.program.id);
    return { clickToken, href: hrefOf(link, subId) };
  };
  const searchLinkOf = (group: GroupPlan, link: ShopLinkPlan): ShopSearchLink => ({
    ...issue(group, link),
    programKey: link.program.programKey,
    merchantName: link.program.displayName,
    linkMode: link.linkMode,
    sponsored: sponsoredOf(group, link),
  });
  const shown: ShopGroup[] = groups.map((group, groupIndex) => ({
    groupKey: group.groupKey,
    basis: group.basis,
    title: group.title,
    anchorCategory: group.anchorCategory,
    options: group.options.map((link, index) => {
      const offer = link.offer as Offer;
      const relationship = group.relationship ?? 'similar';
      return {
        ...issue(group, link),
        programKey: link.program.programKey,
        title: group.title,
        merchantName: link.program.displayName,
        relationship,
        relationshipLabelKey: `commerce.relationship.${relationship}`,
        price: priceOf(offer, now),
        linkMode: link.linkMode,
        sponsored: sponsoredOf(group, link),
        position: index + 1,
      };
    }),
    searchLinks: group.searchLinks.map((link) => searchLinkOf(group, link)),
    separateLinks: group.separateLinks.map((link) => searchLinkOf(group, link)),
    position: groupIndex + 1,
  }));

  const copyKeys: DisclosureCopyKey[] = anyTracking
    ? [
        'commerce.disclosure.paid',
        ...(anyAmazonTracking ? (['commerce.disclosure.amazon'] as const) : []),
      ]
    : ['commerce.disclosure.plain'];
  return {
    panelState: 'active',
    linkMode: anyTracking ? 'tracking' : 'plain',
    season,
    disclosure: {
      copyKeys,
      programs: rotation
        .filter((program) => shownPrograms.has(program.id))
        .map((program) => program.programKey),
    },
    retailers: rotation
      .filter((program) => retailerPrograms.has(program.id))
      .map((program) => ({ programKey: program.programKey, merchantName: program.displayName })),
    groups: shown,
  };
}
