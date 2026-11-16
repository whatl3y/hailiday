import { sql, type ExpressionBuilder } from 'kysely';
import { localDateIn } from '@hailiday/core';
import { DAY_MS, addMs } from '../../clock/index.js';
import type { Database, SourceAsset, ViewpointJson } from '../../db/schema.js';
import { loadFixtureData } from '../../fixtures/data.js';
import { newId } from '../../ids/index.js';
import {
  permissionSettingsOf,
  policyAllowsUse,
  refreshStreetViewPolicy,
  streetViewPolicyTemplateFor,
} from '../../policy/index.js';
import { copyrightClassOf, decideMatch } from '../../providers/match.js';
import { precisionFromLocationType } from '../../providers/address/signals.js';
import { REFRESH_TARGET_POINT_RADIUS_M } from '../../providers/street-view/refresh.js';
import { capabilityStateFor, type PipelineDeps } from '../context.js';
import { dropSourceEnhancements } from '../enhance/store.js';
import {
  dropStoredStreetViewFrame,
  panoramaVerdict,
  pinnedLocationOf,
  streetViewProviderJudges,
} from '../render/source.js';
import { deleteSharePublicObjects } from './deletion.js';
import { loadHeldSet } from './holds.js';
import { purgeSourceDerivatives } from './takedown.js';

/**
 * The stored viewpoint with the time of this check written into it. Only that key is set, in the
 * database, so a field another writer recorded since the row was read (the framing of a first
 * look) is never lost.
 */
function checkedViewpoint(now: Date) {
  return sql<string>`jsonb_set(viewpoint, '{sourceCheckedAt}', to_jsonb(${now.toISOString()}::text))`;
}

/** Revalidation interval of persisted Street View sources (at most 24 h; configuration). */
export const STREET_VIEW_REVALIDATION_MS = DAY_MS;

/**
 * How long one revalidation run keeps taking batches (below the queue's expiry of the job, so a
 * run ends before the next hourly one starts and what it did not reach stays due, oldest first).
 */
export const STREET_VIEW_REVALIDATION_RUN_BUDGET_MS = 50 * 60_000;

export interface StreetViewRevalidationResult {
  checked: number;
  stale: number;
  /** Stale sources whose own panorama is still served, made `ready` again. */
  restored: number;
  removed: number;
  variantsPurged: number;
  /** Checks whose metadata call failed or said nothing about the imagery (still due). */
  failed: number;
  /** Sources the configured provider cannot judge (real imagery and the fixture adapter, or the reverse; still due). */
  skipped: number;
  /** Stored frames deleted because their policy no longer allows storage. */
  framesDropped: number;
  /** Share links revoked (public copies deleted) because their source's policy no longer allows distribution. */
  sharesRevoked: number;
}

/**
 * The `street_view_revalidation` job (address spec, revalidation rules; privacy spec, Street View
 * privacy rule 5): re-requests metadata for every `ready` Street View source not checked within
 * the interval that keeps a stored frame or still has live variants, in either source mode,
 * probing the pinned location when a pano ID no longer resolves. Sources are taken oldest check
 * first (never checked first) in pages of `limit`, one source at a time, until none is due, the
 * run budget is spent or `signal` is aborted; what a run does not reach stays due.
 *
 * Before its metadata call, the policy of every source taken (template-derived rows brought up to
 * the current use policy first) is applied: when the policy itself no longer allows distribution,
 * the unrevoked share links of the source's renderings are revoked and their public copies (shared
 * images and card) deleted, and they stay revoked if the policy is widened again; when it no
 * longer allows storage, a stored frame is deleted. A capability that is merely missing or not live
 * changes neither.
 *
 * An unchanged panorama is marked checked. A panorama replaced by newer imagery (another pano at
 * the spot) marks the asset `stale` and deletes the stored copy, keeping its variants, labeled by
 * the stale source; a panorama that was removed or blurred (no imagery for it any more) also
 * purges every variant made from it, with its share grants and public copies. A call that fails
 * or says nothing about the imagery (quota, denied, invalid request, network) changes nothing and
 * leaves the check due for the next run, as does a source the configured provider cannot know
 * (the fixture adapter never judges real imagery, nor the live provider a fixture stand-in).
 *
 * Sources already `stale` (in either Street View mode, typically marked at render time) or
 * `declined` that keep a stored frame or still have live variants are checked first, in the same
 * order and pages, when a stale one was marked stale after its last check or the check is older
 * than the interval, so a removal noticed at render time is purged even when the render-time path
 * did not purge it, and a declined source's looks and frame follow the policy and the imagery: a
 * removed or blurred panorama purges the variants and deletes any stored copy left; a replaced one
 * keeps the variants labeled and deletes the stored copy; a still present one makes a stale source
 * `ready` again with its stored copy (a declined source stays declined and keeps its copy); a
 * failed call leaves the source as it is, due again.
 *
 * A source under a preservation hold keeps its stored copy and object key on every path (it is
 * still marked stale and checked). `sourceAssetIds` limits a run to those sources.
 */
export async function runStreetViewRevalidation(
  deps: PipelineDeps,
  options: {
    limit?: number;
    maxDurationMs?: number;
    sourceAssetIds?: readonly string[];
    signal?: AbortSignal;
  } = {},
): Promise<StreetViewRevalidationResult> {
  const now = deps.clock.now();
  const due = addMs(now, -STREET_VIEW_REVALIDATION_MS);
  const limit = options.limit ?? 200;
  const deadline = Date.now() + (options.maxDurationMs ?? STREET_VIEW_REVALIDATION_RUN_BUDGET_MS);
  const within = () => Date.now() < deadline && !options.signal?.aborted;
  const scope = options.sourceAssetIds;
  const result: StreetViewRevalidationResult = {
    checked: 0,
    stale: 0,
    restored: 0,
    removed: 0,
    variantsPurged: 0,
    failed: 0,
    skipped: 0,
    framesDropped: 0,
    sharesRevoked: 0,
  };
  if (scope && scope.length === 0) return result;
  const liveVariant = (eb: ExpressionBuilder<Database, 'sourceAssets'>) =>
    eb.exists(
      eb
        .selectFrom('renderAssets')
        .select('renderAssets.id')
        .whereRef('renderAssets.sourceAssetId', '=', 'sourceAssets.id')
        .where('renderAssets.deletedAt', 'is', null)
        .where('renderAssets.withdrawnAt', 'is', null),
    );
  const provider =
    deps.config.providers.streetView === 'fixture'
      ? deps.providers.fixtures.streetView
      : deps.providers.streetView;
  const template = streetViewPolicyTemplateFor(deps.config);
  const capabilityState = (await capabilityStateFor(deps, 'street_view_ai')) ?? 'live_public';
  const held = await loadHeldSet(deps);

  const verdictOf = async (asset: SourceAsset & { viewpoint: ViewpointJson }) => {
    const location = await pinnedLocationOf(deps, asset);
    const refreshed = await provider
      .refreshPanorama(asset.viewpoint.panoId, {
        location,
        locationRadiusM: REFRESH_TARGET_POINT_RADIUS_M,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      .catch(() => null);
    return panoramaVerdict(refreshed, asset.viewpoint.panoId);
  };
  /**
   * Deletes a source's stored copy and its enhancements unless a preservation hold keeps it; the
   * key to record.
   */
  const dropStoredCopy = async (asset: SourceAsset): Promise<string | null> => {
    if (!asset.objectKey || held.sources.has(asset.id) || asset.preservationHoldId) {
      return asset.objectKey;
    }
    await deps.storage.delete('private', asset.objectKey);
    await dropSourceEnhancements(deps, asset, { held });
    return null;
  };
  const purgeDerivatives = async (asset: SourceAsset) => {
    result.removed += 1;
    result.variantsPurged += (
      await purgeSourceDerivatives(deps, asset.id, { requestedBy: 'system' })
    ).purged;
  };
  /** Revokes the unrevoked share links of a source's renderings and deletes their public copies. */
  const revokeShares = async (asset: SourceAsset) => {
    const grants = await deps.db
      .updateTable('shareGrants')
      .set({ revokedAt: now })
      .where('revokedAt', 'is', null)
      .where('renderAssetId', 'in', (eb) =>
        eb
          .selectFrom('renderAssets')
          .select('renderAssets.id')
          .where('renderAssets.sourceAssetId', '=', asset.id),
      )
      .returning(['id', 'shareCardObjectKey'])
      .execute();
    for (const grant of grants) await deleteSharePublicObjects(deps, grant.shareCardObjectKey);
    result.sharesRevoked += grants.length;
  };
  /**
   * Applies a source's policy, brought up to the current template: share links are revoked when
   * the policy no longer allows distribution, and a stored frame is deleted when it no longer
   * allows storage. Returns the source as it stands afterwards.
   */
  const applyPolicy = async (asset: SourceAsset): Promise<SourceAsset> => {
    const policy = asset.assetPolicyId
      ? await refreshStreetViewPolicy(deps.db, asset.assetPolicyId, template)
      : null;
    const input = {
      policy,
      capabilityState,
      ...permissionSettingsOf(deps.config),
      now,
      sourceKind: 'street_view' as const,
      isGoogleImagery: asset.isGoogleImagery,
      copyright: asset.copyright,
    };
    if (!policyAllowsUse(input, 'distributeDerivative')) await revokeShares(asset);
    if (!asset.objectKey || policyAllowsUse(input, 'store')) return asset;
    const dropped = await dropStoredStreetViewFrame(deps, asset, held);
    if (!dropped.objectKey) result.framesDropped += 1;
    return dropped;
  };

  /**
   * Due sources of one group (`ready`, or `retired`: `stale` and `declined`), oldest check first
   * (never checked first), a page at a time. The cursor is the row's position in that order (its
   * check time at full precision, then its ID), so a source that stays due after its check (a
   * failed call) is never taken twice in one run.
   */
  const page = (group: 'ready' | 'retired', after: { at: string; id: string } | null) =>
    deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .select(
        sql<string>`coalesce(revalidated_at, '-infinity'::timestamptz)::text`.as(
          'revalidationCursor',
        ),
      )
      .where('kind', '=', 'street_view')
      .where('state', 'in', group === 'ready' ? ['ready'] : ['stale', 'declined'])
      .where('deletedAt', 'is', null)
      .$if(scope !== undefined, (query) => query.where('id', 'in', scope as readonly string[]))
      .where((eb) =>
        eb.and([
          eb.or([
            eb('revalidatedAt', 'is', null),
            eb('revalidatedAt', '<=', due),
            ...(group === 'retired' ? [eb('staleAt', '>', eb.ref('revalidatedAt'))] : []),
          ]),
          eb.or([eb('objectKey', 'is not', null), liveVariant(eb)]),
        ]),
      )
      .$if(after !== null, (query) =>
        query.where(
          sql<boolean>`(coalesce(revalidated_at, '-infinity'::timestamptz), id) > (${after?.at}::timestamptz, ${after?.id}::uuid)`,
        ),
      )
      .orderBy(sql`coalesce(revalidated_at, '-infinity'::timestamptz)`)
      .orderBy('id')
      .limit(limit)
      .execute();
  /** Hands every due source of `group` to `check`, while the budget lasts and the run is not aborted. */
  const sweep = async (
    group: 'ready' | 'retired',
    check: (asset: SourceAsset) => Promise<void>,
  ): Promise<void> => {
    let cursor: { at: string; id: string } | null = null;
    while (within()) {
      const batch = await page(group, cursor);
      for (const row of batch) {
        if (!within()) return;
        const { revalidationCursor: _position, ...asset } = row;
        await check(asset);
      }
      const last = batch[batch.length - 1];
      if (!last || batch.length < limit) return;
      cursor = { at: last.revalidationCursor, id: last.id };
    }
  };

  await sweep('retired', async (loaded) => {
    const asset = await applyPolicy(loaded);
    if (!asset.viewpoint) return;
    result.checked += 1;
    if (!streetViewProviderJudges(provider, asset)) {
      result.skipped += 1;
      return;
    }
    const verdict = await verdictOf({ ...asset, viewpoint: asset.viewpoint });
    if (verdict === 'unknown') {
      // Nothing is known about the imagery: no change, and the check stays due.
      result.failed += 1;
      return;
    }
    if (verdict === 'present') {
      // A stale source whose own panorama is still served is usable again, with its stored copy;
      // a declined source stays declined and keeps what the policy left it.
      const restored = asset.state === 'stale';
      await deps.db
        .updateTable('sourceAssets')
        .set({
          revalidatedAt: now,
          viewpoint: checkedViewpoint(now),
          ...(restored ? { state: 'ready' as const, staleAt: null } : {}),
        })
        .where('id', '=', asset.id)
        .where('state', '=', asset.state)
        .execute();
      if (restored) result.restored += 1;
      return;
    }
    const objectKey = await dropStoredCopy(asset);
    await deps.db
      .updateTable('sourceAssets')
      .set({ revalidatedAt: now, objectKey })
      .where('id', '=', asset.id)
      .execute();
    if (verdict === 'removed') await purgeDerivatives(asset);
  });

  await sweep('ready', async (loaded) => {
    const asset = await applyPolicy(loaded);
    if (!asset.viewpoint) return;
    result.checked += 1;
    if (!streetViewProviderJudges(provider, asset)) {
      result.skipped += 1;
      return;
    }
    const verdict = await verdictOf({ ...asset, viewpoint: asset.viewpoint });
    if (verdict === 'unknown') {
      result.failed += 1;
      return;
    }
    if (verdict === 'present') {
      await deps.db
        .updateTable('sourceAssets')
        .set({
          revalidatedAt: now,
          viewpoint: checkedViewpoint(now),
        })
        .where('id', '=', asset.id)
        .execute();
      return;
    }
    const objectKey = await dropStoredCopy(asset);
    // Stamped with the time of the write, not the run's start: a discovery stored earlier in a
    // long run is older than the staling.
    const at = deps.clock.now();
    await deps.db
      .updateTable('sourceAssets')
      .set({ state: 'stale', staleAt: at, revalidatedAt: at, objectKey })
      .where('id', '=', asset.id)
      .execute();
    result.stale += 1;
    if (verdict === 'removed') await purgeDerivatives(asset);
  });
  return result;
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
 * Hailiday never scrapes merchant pages), then auto-pauses active offers past their freshness limit
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
