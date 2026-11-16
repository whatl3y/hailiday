import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AnchorCategorySchema,
  FAILURE_CODES,
  commerceCapabilityKey,
  type DisclosureCopyKey,
  type FailureCode,
  type LinkMode,
  type ProductCard,
  type ProductsPanel,
} from '@hailiday/core';
import { capabilityMode } from '@hailiday/server/capabilities';
import { DAY_MS, HOUR_MS } from '@hailiday/server/clock';
import type { MerchantProgram, Offer, RenderJob } from '@hailiday/server/db';
import { AppError } from '@hailiday/server/errors';
import type { ApiDeps } from '../deps.js';
import type { AuthState } from '../auth/session.js';
import { commerceOccurrenceOf, holidayCalendar } from './holidays.js';
import { loadSource } from './projects.js';
import { evaluateFor, refreshStreetViewPolicyOf } from './sources.js';

/** Panel configuration (commerce spec defaults). */
export const COMMERCE_DEFAULTS = {
  maxCards: 6,
  minCards: 1,
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
const HIDDEN = (): ProductsPanel => ({
  panelState: 'hidden',
  linkMode: null,
  disclosure: { copyKeys: [], programs: [] },
  items: [],
});

/**
 * Click tokens are pre-issued with each card: the link row ID, a nonce and a MAC bound to the
 * viewer's session, so `POST /v1/clicks` can verify them without storing unused tokens. The chosen
 * offer and link mode are read from the link row (recorded at panel load).
 */
export function issueClickToken(secret: string, sessionId: string, linkId: string): string {
  const id = Buffer.from(linkId.replace(/-/g, ''), 'hex');
  const nonce = randomBytes(6);
  const mac = createHmac('sha256', `click:${secret}`)
    .update(`${sessionId}:${linkId}:${nonce.toString('hex')}`)
    .digest()
    .subarray(0, 12);
  return Buffer.concat([id, nonce, mac]).toString('base64url');
}

/** Verifies a click token for a session; returns the link row ID or null. */
export function verifyClickToken(secret: string, sessionId: string, token: string): string | null {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length !== 34) return null;
  const hex = bytes.subarray(0, 16).toString('hex');
  const linkId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const nonce = bytes.subarray(16, 22);
  const expected = createHmac('sha256', `click:${secret}`)
    .update(`${sessionId}:${linkId}:${nonce.toString('hex')}`)
    .digest()
    .subarray(0, 12);
  const mac = bytes.subarray(22);
  return mac.length === expected.length && timingSafeEqual(mac, expected) ? linkId : null;
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

function commissionRate(program: MerchantProgram): number {
  return program.commissionSchedule.reduce((max, entry) => Math.max(max, entry.ratePercent), 0);
}

interface RankedOffer {
  offer: Offer;
  program: MerchantProgram;
}

const CRITERIA: { name: string; compare: (a: RankedOffer, b: RankedOffer) => number }[] = [
  {
    name: 'in_stock_recently_verified',
    compare: (a, b) => {
      const stock = (x: RankedOffer) => (x.offer.availability === 'in_stock' ? 1 : 0);
      if (stock(a) !== stock(b)) return stock(b) - stock(a);
      return (
        (b.offer.availabilityCheckedAt?.getTime() ?? 0) -
        (a.offer.availabilityCheckedAt?.getTime() ?? 0)
      );
    },
  },
  {
    name: 'program_status',
    compare: (a, b) =>
      Number(TRACKING_STATUSES.has(b.program.status)) -
      Number(TRACKING_STATUSES.has(a.program.status)),
  },
  {
    name: 'price_known',
    compare: (a, b) => Number(b.offer.priceMinor !== null) - Number(a.offer.priceMinor !== null),
  },
  {
    name: 'attribution_window',
    compare: (a, b) =>
      (b.program.attributionWindowHours ?? 0) - (a.program.attributionWindowHours ?? 0),
  },
  {
    name: 'commission_rate',
    compare: (a, b) => commissionRate(b.program) - commissionRate(a.program),
  },
  {
    name: 'offer_id',
    compare: (a, b) => (a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0),
  },
];

/** Orders candidate offers by the ranking tie-break and names the criterion that decided. */
export function rankOffers(candidates: RankedOffer[]): { ordered: RankedOffer[]; reason: string } {
  const ordered = [...candidates].sort((a, b) => {
    for (const criterion of CRITERIA) {
      const result = criterion.compare(a, b);
      if (result !== 0) return result;
    }
    return 0;
  });
  if (ordered.length < 2) return { ordered, reason: 'single_offer' };
  const [first, second] = ordered as [RankedOffer, RankedOffer];
  const decided = CRITERIA.find((criterion) => criterion.compare(first, second) !== 0);
  return { ordered, reason: decided?.name ?? 'offer_id' };
}

/**
 * The Shop the look panel for a job (commerce spec): `hidden` unless the job succeeded, a
 * commerce capability is available to the viewer, the commerce pause is off and the source allows
 * commerce adjacency; `off_season` outside the holiday's commerce window; `no_offers` without an
 * eligible offer; otherwise up to six cards (described before similar, then kit order), each with
 * the offer chosen by the ranking tie-break, recorded on the link row with a pre-issued click token.
 */
export async function buildProductsPanel(
  deps: ApiDeps,
  auth: AuthState,
  job: RenderJob,
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

  const programs = await deps.db.selectFrom('merchantPrograms').selectAll().execute();
  const available = new Map<string, MerchantProgram>();
  for (const program of programs) {
    const state = await deps.capabilities.state('US', commerceCapabilityKey(program.programKey));
    if (capabilityMode(state, auth.audience, deps.config.appEnv) !== 'unavailable') {
      available.set(program.id, program);
    }
  }
  if (available.size === 0) return HIDDEN();

  const now = deps.clock.now();
  const calendar = await holidayCalendar(deps);
  const occurrence = commerceOccurrenceOf(calendar.rows, job.holidayId, now);
  if (!occurrence) {
    return { ...HIDDEN(), panelState: 'off_season' };
  }

  const links = await deps.db
    .selectFrom('renderProductLinks')
    .innerJoin('kitItems', 'kitItems.id', 'renderProductLinks.kitItemId')
    .select([
      'renderProductLinks.id as linkId',
      'renderProductLinks.relationship',
      'renderProductLinks.sponsored',
      'renderProductLinks.productId as linkedProductId',
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

  const freshness = COMMERCE_DEFAULTS.freshnessInWindowMs;
  const cards: ProductCard[] = [];
  const shownPrograms = new Set<string>();
  let anyTracking = false;
  let anyAmazonTracking = false;
  for (const link of links) {
    if (cards.length >= COMMERCE_DEFAULTS.maxCards) break;
    const productId = link.currentProductId ?? link.linkedProductId;
    const product = await deps.db
      .selectFrom('products')
      .selectAll()
      .where('id', '=', productId)
      .where('archivedAt', 'is', null)
      .executeTakeFirst();
    if (!product) continue;
    const offers = await deps.db
      .selectFrom('offers')
      .selectAll()
      .where('productId', '=', product.id)
      .where('status', '=', 'active')
      .where('destinationCountry', '=', 'US')
      .execute();
    const candidates: RankedOffer[] = [];
    for (const offer of offers) {
      const program = available.get(offer.merchantProgramId);
      if (!program) continue;
      if (!offer.seasonalEligibility.includes(occurrence.occurrenceKey)) continue;
      if (!offer.lastVerifiedAt || now.getTime() - offer.lastVerifiedAt.getTime() > freshness) {
        continue;
      }
      if (offer.availability === 'out_of_stock') continue;
      candidates.push({ offer, program });
    }
    if (candidates.length === 0) continue;
    const { ordered, reason } = rankOffers(candidates);
    const chosen = ordered[0] as RankedOffer;
    const tracking =
      TRACKING_STATUSES.has(chosen.program.status) && chosen.offer.trackingUrlTemplate !== null;
    const linkMode: LinkMode = tracking ? 'tracking' : 'plain';
    const clickToken = issueClickToken(deps.config.sessionSecret, auth.session.id, link.linkId);
    const trackingId =
      chosen.program.trackingIds.find(
        (entry) => entry.holidayId === job.holidayId && entry.channel === COMMERCE_DEFAULTS.channel,
      )?.trackingId ?? null;
    const href =
      tracking && chosen.offer.trackingUrlTemplate
        ? fillTrackingTemplate(chosen.offer.trackingUrlTemplate, {
            destinationUrl: chosen.offer.destinationUrl,
            subId: chosen.program.subIdCapability ? clickToken : null,
            trackingId,
          })
        : chosen.offer.destinationUrl;
    await deps.db
      .updateTable('renderProductLinks')
      .set({
        chosenOfferId: chosen.offer.id,
        linkMode,
        candidateOfferIds: ordered.map((entry) => entry.offer.id),
        rankingReason: reason,
        rankedAt: now,
      })
      .where('id', '=', link.linkId)
      .execute();
    const priceShown =
      chosen.offer.priceSource !== 'none' &&
      chosen.offer.priceMinor !== null &&
      chosen.offer.priceObservedAt !== null &&
      now.getTime() - chosen.offer.priceObservedAt.getTime() <= COMMERCE_DEFAULTS.priceFreshnessMs;
    const anchor = AnchorCategorySchema.safeParse(link.anchorCategory);
    if (tracking) {
      anyTracking = true;
      if (chosen.program.programType === 'amazon_associates') anyAmazonTracking = true;
    }
    shownPrograms.add(chosen.program.programKey);
    cards.push({
      clickToken,
      title: product.ourTitle,
      merchantName: chosen.program.displayName,
      relationship: link.relationship,
      relationshipLabelKey: `commerce.relationship.${link.relationship}`,
      anchorCategory: anchor.success ? anchor.data : null,
      price:
        priceShown && chosen.offer.priceObservedAt
          ? {
              policy: 'show',
              amountMinor: chosen.offer.priceMinor as number,
              currency: chosen.offer.currency.trim(),
              observedAt: chosen.offer.priceObservedAt.toISOString(),
            }
          : { policy: 'check_at_retailer' },
      linkMode,
      sponsored: chosen.offer.sponsored || link.sponsored,
      href,
      rankPosition: cards.length + 1,
    });
  }

  if (cards.length < COMMERCE_DEFAULTS.minCards) {
    return { ...HIDDEN(), panelState: 'no_offers' };
  }
  const copyKeys: DisclosureCopyKey[] = anyTracking
    ? [
        'commerce.disclosure.paid',
        ...(anyAmazonTracking ? (['commerce.disclosure.amazon'] as const) : []),
      ]
    : ['commerce.disclosure.plain'];
  return {
    panelState: 'active',
    linkMode: anyTracking ? 'tracking' : 'plain',
    disclosure: { copyKeys, programs: [...shownPrograms] },
    items: cards,
  };
}
