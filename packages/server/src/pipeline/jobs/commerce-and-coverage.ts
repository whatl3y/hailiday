import { sql } from 'kysely';
import { localDateIn } from '@holiday/core';
import { DAY_MS, addMs } from '../../clock/index.js';
import { toJson } from '../../db/client.js';
import type { SourceAsset, ViewpointJson } from '../../db/schema.js';
import { loadFixtureData } from '../../fixtures/data.js';
import { newId } from '../../ids/index.js';
import { copyrightClassOf, decideMatch } from '../../providers/match.js';
import { precisionFromLocationType } from '../../providers/address/signals.js';
import { REFRESH_TARGET_POINT_RADIUS_M } from '../../providers/street-view/refresh.js';
import type { PipelineDeps } from '../context.js';
import { panoramaVerdict, pinnedLocationOf } from '../render/source.js';
import { loadHeldSet } from './holds.js';
import { purgeSourceDerivatives } from './takedown.js';

/** Revalidation interval of persisted Street View sources (at most 24 h; configuration). */
export const STREET_VIEW_REVALIDATION_MS = DAY_MS;

/**
 * The `street_view_revalidation` job (address spec, revalidation rules; privacy spec, Street View
 * privacy rule 5): in `persist` mode only, re-requests metadata for stored panoramas not checked
 * within the interval, probing the pinned location when a pano ID no longer resolves. An unchanged
 * panorama is marked checked. A panorama replaced by newer imagery (another pano at the spot)
 * marks the asset `stale` and deletes the stored copy, keeping its variants, labeled by the stale
 * source; a panorama that was removed or blurred (no imagery for it any more) also purges every
 * variant made from it, with its share grants and public copies. A call that fails or says
 * nothing about the imagery (quota, denied, invalid request, network) changes nothing and leaves
 * the check due for the next run.
 *
 * Sources already `stale` (in either Street View mode, typically marked at render time) that still
 * have live variants are checked as well, when they were marked stale after their last check or
 * that check is older than the interval, so a removal noticed at render time is purged even when
 * the render-time path did not purge it: a removed or blurred panorama purges the variants, a
 * replaced or still present one keeps them labeled, and any stored copy left is deleted; a failed
 * call leaves the source as it is, due again.
 *
 * A source under a preservation hold keeps its stored copy and object key on every path (it is
 * still marked stale and checked).
 */
export async function runStreetViewRevalidation(
  deps: PipelineDeps,
  options: { limit?: number } = {},
): Promise<{
  checked: number;
  stale: number;
  removed: number;
  variantsPurged: number;
  /** Checks whose metadata call failed or said nothing about the imagery (still due). */
  failed: number;
}> {
  const now = deps.clock.now();
  const due = addMs(now, -STREET_VIEW_REVALIDATION_MS);
  const limit = options.limit ?? 200;
  const ready = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('kind', '=', 'street_view')
    .where('streetViewMode', '=', 'persist')
    .where('state', '=', 'ready')
    .where('objectKey', 'is not', null)
    .where('deletedAt', 'is', null)
    .where((eb) => eb.or([eb('revalidatedAt', 'is', null), eb('revalidatedAt', '<=', due)]))
    .limit(limit)
    .execute();
  const staleWithVariants = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('kind', '=', 'street_view')
    .where('state', '=', 'stale')
    .where('deletedAt', 'is', null)
    .where((eb) =>
      eb.or([
        eb('revalidatedAt', 'is', null),
        eb('revalidatedAt', '<=', due),
        eb('staleAt', '>', eb.ref('revalidatedAt')),
      ]),
    )
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('renderAssets')
          .select('renderAssets.id')
          .whereRef('renderAssets.sourceAssetId', '=', 'sourceAssets.id')
          .where('renderAssets.deletedAt', 'is', null)
          .where('renderAssets.withdrawnAt', 'is', null),
      ),
    )
    .orderBy('staleAt')
    .limit(limit)
    .execute();
  const provider =
    deps.config.providers.streetView === 'fixture'
      ? deps.providers.fixtures.streetView
      : deps.providers.streetView;
  let stale = 0;
  let removed = 0;
  let variantsPurged = 0;
  let failed = 0;
  const held = staleWithVariants.length + ready.length > 0 ? await loadHeldSet(deps) : null;

  const verdictOf = async (asset: SourceAsset & { viewpoint: ViewpointJson }) => {
    const location = await pinnedLocationOf(deps, asset);
    const refreshed = await provider
      .refreshPanorama(asset.viewpoint.panoId, {
        location,
        locationRadiusM: REFRESH_TARGET_POINT_RADIUS_M,
      })
      .catch(() => null);
    return panoramaVerdict(refreshed, asset.viewpoint.panoId);
  };
  /** Deletes a source's stored copy unless a preservation hold keeps it; the key to record. */
  const dropStoredCopy = async (asset: SourceAsset): Promise<string | null> => {
    if (!asset.objectKey || held?.sources.has(asset.id)) return asset.objectKey;
    await deps.storage.delete('private', asset.objectKey);
    return null;
  };
  const purgeDerivatives = async (asset: SourceAsset) => {
    removed += 1;
    variantsPurged += (await purgeSourceDerivatives(deps, asset.id, { requestedBy: 'system' }))
      .purged;
  };

  for (const asset of staleWithVariants) {
    if (!asset.viewpoint) continue;
    const verdict = await verdictOf({ ...asset, viewpoint: asset.viewpoint });
    if (verdict === 'unknown') {
      // Nothing is known about the imagery: no change, and the check stays due.
      failed += 1;
      continue;
    }
    const objectKey = await dropStoredCopy(asset);
    await deps.db
      .updateTable('sourceAssets')
      .set({ revalidatedAt: now, objectKey })
      .where('id', '=', asset.id)
      .execute();
    if (verdict === 'removed') await purgeDerivatives(asset);
  }

  for (const asset of ready) {
    if (!asset.viewpoint) continue;
    const verdict = await verdictOf({ ...asset, viewpoint: asset.viewpoint });
    if (verdict === 'unknown') {
      failed += 1;
      continue;
    }
    if (verdict === 'present') {
      await deps.db
        .updateTable('sourceAssets')
        .set({
          revalidatedAt: now,
          viewpoint: toJson({ ...asset.viewpoint, sourceCheckedAt: now.toISOString() }),
        })
        .where('id', '=', asset.id)
        .execute();
      continue;
    }
    const objectKey = await dropStoredCopy(asset);
    await deps.db
      .updateTable('sourceAssets')
      .set({ state: 'stale', staleAt: now, revalidatedAt: now, objectKey })
      .where('id', '=', asset.id)
      .execute();
    stale += 1;
    if (verdict === 'removed') await purgeDerivatives(asset);
  }
  return {
    checked: ready.length + staleWithVariants.length,
    stale,
    removed,
    variantsPurged,
    failed,
  };
}

/** Offer freshness limits (commerce spec, verification cadence; configuration). */
export const OFFER_FRESHNESS = { inWindowMs: 4 * DAY_MS, outOfWindowMs: 8 * DAY_MS } as const;

export interface OfferVerificationResult {
  verified: number;
  paused: number;
  reactivated: number;
}

/**
 * The `offer_verification` job: runs `api` or `feed` checks for offers whose program grants
 * access (in fixture mode the check confirms the stored record without any network call, since
 * Holiday never scrapes merchant pages), then auto-pauses active offers past their freshness limit
 * (4 days inside a commerce window of an eligible occurrence, 8 days outside), out of stock, at a
 * paused or suspended program, or with every eligible occurrence retired. Offers paused only for
 * staleness are reactivated by a passing automated check.
 */
export async function runOfferVerification(
  deps: PipelineDeps,
  options: { offerIds?: readonly string[] } = {},
): Promise<OfferVerificationResult> {
  const now = deps.clock.now();
  const today = localDateIn(now, 'America/New_York');
  const offers = await deps.db
    .selectFrom('offers')
    .innerJoin('merchantPrograms', 'merchantPrograms.id', 'offers.merchantProgramId')
    .select([
      'offers.id',
      'offers.status',
      'offers.priceSource',
      'offers.availability',
      'offers.lastVerifiedAt',
      'offers.seasonalEligibility',
      'offers.notes',
      'merchantPrograms.status as programStatus',
      'merchantPrograms.apiAccess',
    ])
    .where('offers.status', 'in', ['active', 'paused'])
    .$if(options.offerIds !== undefined, (qb) =>
      qb.where(
        'offers.id',
        'in',
        options.offerIds?.length
          ? [...(options.offerIds ?? [])]
          : ['00000000-0000-0000-0000-000000000000'],
      ),
    )
    .execute();
  const occurrences = await deps.db
    .selectFrom('holidayOccurrences')
    .select(['occurrenceKey', 'commerceStart', 'commerceEnd', 'catalogRetireAt'])
    .execute();
  const byKey = new Map(occurrences.map((row) => [row.occurrenceKey, row]));
  const fixture = deps.config.isLocal;
  const result: OfferVerificationResult = { verified: 0, paused: 0, reactivated: 0 };

  for (const offer of offers) {
    const eligible = offer.seasonalEligibility
      .map((key) => byKey.get(key))
      .filter((row) => row !== undefined);
    const inWindow = eligible.some(
      (row) =>
        row.commerceStart !== null &&
        row.commerceEnd !== null &&
        row.commerceStart <= today &&
        today <= row.commerceEnd,
    );
    const allRetired =
      eligible.length > 0 &&
      eligible.every((row) => row.catalogRetireAt !== null && row.catalogRetireAt <= today);
    const freshness = inWindow ? OFFER_FRESHNESS.inWindowMs : OFFER_FRESHNESS.outOfWindowMs;
    let lastVerifiedAt = offer.lastVerifiedAt;
    const automated =
      offer.apiAccess === 'granted' || offer.priceSource === 'api' || offer.priceSource === 'feed';
    if (automated && fixture) {
      lastVerifiedAt = now;
      await deps.db
        .updateTable('offers')
        .set({
          lastVerifiedAt: now,
          verificationMethod: offer.priceSource === 'feed' ? 'feed' : 'api',
          verifiedBy: null,
          availabilityCheckedAt: now,
          ...(offer.priceSource === 'api' || offer.priceSource === 'feed'
            ? { priceObservedAt: now }
            : {}),
        })
        .where('id', '=', offer.id)
        .execute();
      result.verified += 1;
    }
    const stale = !lastVerifiedAt || now.getTime() - lastVerifiedAt.getTime() > freshness;
    const programBlocked = ['suspended', 'withdrawn', 'declined'].includes(offer.programStatus);
    const pauseReason = stale
      ? 'verification_stale'
      : offer.availability === 'out_of_stock'
        ? 'out_of_stock'
        : programBlocked
          ? 'program_status'
          : allRetired
            ? 'occurrences_retired'
            : null;
    if (offer.status === 'active' && pauseReason) {
      await deps.db
        .updateTable('offers')
        .set({
          status: 'paused',
          notes: sql<string>`coalesce(notes || ' ', '') || ${`[auto-paused ${now.toISOString()}: ${pauseReason}]`}`,
        })
        .where('id', '=', offer.id)
        .execute();
      result.paused += 1;
    } else if (
      offer.status === 'paused' &&
      !pauseReason &&
      automated &&
      (offer.notes ?? '').includes('auto-paused') &&
      (offer.notes ?? '').includes('verification_stale')
    ) {
      await deps.db
        .updateTable('offers')
        .set({ status: 'active' })
        .where('id', '=', offer.id)
        .execute();
      result.reactivated += 1;
    }
  }
  return result;
}

/** One reported conversion row (network API or an operator's CSV export). */
export interface AffiliateReportRow {
  sentSubId: string | null;
  trackingId: string | null;
  orderAt: Date;
  reportedAt: Date;
  commissionAmountMinor: number;
  currency: string;
  status: 'pending' | 'approved' | 'reversed' | 'paid';
  reportRef: string;
}

/** Upserts one program's report rows into `affiliate_conversions` by report reference. */
export async function importAffiliateReport(
  deps: Pick<PipelineDeps, 'db'>,
  merchantProgramId: string,
  rows: readonly AffiliateReportRow[],
): Promise<number> {
  let written = 0;
  for (const row of rows) {
    const result = await deps.db
      .insertInto('affiliateConversions')
      .values({ id: newId(), merchantProgramId, ...row })
      .onConflict((oc) =>
        oc.columns(['merchantProgramId', 'reportRef']).doUpdateSet({
          status: row.status,
          commissionAmountMinor: row.commissionAmountMinor,
          reportedAt: row.reportedAt,
        }),
      )
      .executeTakeFirst();
    written += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  return written;
}

/**
 * The `affiliate_report_import` job: imports each program's reports where an API is granted (no
 * network adapters exist yet, and fixture programs report nothing, so no conversion is ever
 * synthesized) and reconciles conversions with clicks by sent SubId, reporting the totals.
 */
export async function runAffiliateReportImport(deps: PipelineDeps): Promise<{
  programs: number;
  imported: number;
  matchedToClicks: number;
  unmatched: number;
}> {
  const programs = await deps.db
    .selectFrom('merchantPrograms')
    .select(['id', 'apiAccess'])
    .where('status', 'in', ['approved', 'provisional'])
    .execute();
  const reconciliation = await deps.db
    .selectFrom('affiliateConversions as c')
    .select([
      sql<number>`count(*) filter (where exists (select 1 from affiliate_clicks k where k.sent_sub_id = c.sent_sub_id))`.as(
        'matched',
      ),
      sql<number>`count(*) filter (where c.sent_sub_id is not null and not exists (select 1 from affiliate_clicks k where k.sent_sub_id = c.sent_sub_id))`.as(
        'unmatched',
      ),
    ])
    .executeTakeFirstOrThrow();
  return {
    programs: programs.length,
    imported: 0,
    matchedToClicks: Number(reconciliation.matched),
    unmatched: Number(reconciliation.unmatched),
  };
}

export interface CoverageProbeSummary {
  probeRunId: string;
  sampleSize: number;
  availability: { within50m: number; within100m: number; within200m: number };
  distanceMeters: number[];
  copyrightMix: Record<string, number>;
  matchClasses: Record<string, number>;
  deepSetbackRate: number;
  providerMode: 'fixture' | 'live';
}

/**
 * The `coverage_probe` job (address spec, coverage probe): metadata-only discovery over a sample,
 * with no image analysis. In fixture mode the sample is the fixture places; live probes need the
 * consented address sample, which is supplied by the probe script, so without one nothing runs.
 */
export async function runCoverageProbe(
  deps: PipelineDeps,
  payload: { probeRunId: string; sampleSize?: number },
): Promise<CoverageProbeSummary | null> {
  if (deps.config.providers.streetView !== 'fixture') {
    deps.logger.info({ probeRunId: payload.probeRunId }, 'coverage probe needs a consented sample');
    return null;
  }
  const places = loadFixtureData()
    .places.filter((place) => place.countryCode === 'US')
    .slice(0, payload.sampleSize ?? 100);
  const summary: CoverageProbeSummary = {
    probeRunId: payload.probeRunId,
    sampleSize: places.length,
    availability: { within50m: 0, within100m: 0, within200m: 0 },
    distanceMeters: [],
    copyrightMix: {},
    matchClasses: {},
    deepSetbackRate: 0,
    providerMode: 'fixture',
  };
  let deepSetback = 0;
  const now = deps.clock.now();
  for (const place of places) {
    const target = place.destinations.targetPoint ?? place.location;
    const discovery = await deps.providers.fixtures.streetView.discoverCandidates({
      target,
      geometryAvailable: place.destinations.hasOutline,
      facadeWidthM: place.destinations.facadeWidthM,
      roadBearingDeg: place.destinations.roadBearingDeg,
      facadeNormalDeg: place.destinations.facadeNormalDeg,
      attachedFacade: place.destinations.attachedFacade,
    });
    const primary = discovery.candidates.find((candidate) => candidate.isPrimary) ?? null;
    if (discovery.probeRadiusM !== null) {
      if (discovery.probeRadiusM <= 50) summary.availability.within50m += 1;
      if (discovery.probeRadiusM <= 100) summary.availability.within100m += 1;
      if (discovery.probeRadiusM <= 200) summary.availability.within200m += 1;
    }
    if (discovery.deepSetback) deepSetback += 1;
    if (primary) summary.distanceMeters.push(Math.round(primary.distanceM * 10) / 10);
    const copyright = primary ? copyrightClassOf(primary.copyright) : 'none';
    summary.copyrightMix[copyright] = (summary.copyrightMix[copyright] ?? 0) + 1;
    const decision = decideMatch({
      countryCode: place.countryCode,
      blockedAddress: place.blocked,
      multiUnit: place.multiUnit,
      precision: precisionFromLocationType(place.geocode.locationType),
      partialMatch: place.geocode.partialMatch,
      structureType: place.destinations.structureType,
      discoveryStatus: discovery.status,
      probeRadiusM: discovery.probeRadiusM,
      primaryDistanceM: primary?.distanceM ?? null,
      headingMode: primary?.headingMode ?? null,
      facadeWidthM: place.destinations.facadeWidthM,
      attachedFacade: place.destinations.attachedFacade,
      captureDate: primary?.captureDate ?? null,
      captureGranularity: primary?.captureGranularity ?? null,
      copyrightClass: primary ? copyrightClassOf(primary.copyright) : null,
      entryMethod: 'autocomplete',
      sourceMode: 'transient',
      now,
    });
    const label = decision.reason
      ? `${decision.matchClass}:${decision.reason}`
      : decision.matchClass;
    summary.matchClasses[label] = (summary.matchClasses[label] ?? 0) + 1;
  }
  summary.deepSetbackRate = places.length > 0 ? deepSetback / places.length : 0;
  deps.logger.info({ coverageProbe: summary }, 'coverage probe complete');
  return summary;
}
