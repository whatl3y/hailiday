import type { CandidateFlag } from '@holiday/core';
import { captureGranularityOf, copyrightClassOf } from '../match.js';
import {
  DEFAULT_VIEWPOINT_PARAMETERS,
  angleDifference,
  destinationPoint,
  estimatedFacadePx,
  haversineDistanceM,
  initialBearingDeg,
  normalizeDegrees,
  round,
  viewFovDeg,
  viewPitchDeg,
  type LatLng,
  type ViewpointParameters,
} from '../geo.js';
import type {
  DiscoveryInput,
  DiscoveryResult,
  MetadataStatus,
  StreetViewMetadata,
  ViewCandidate,
} from '../types.js';

export type MetadataProbe = (location: LatLng, radiusM: number) => Promise<StreetViewMetadata>;

/** Metadata statuses that say nothing about the imagery: the call failed or was refused. */
export const METADATA_ERROR_STATUSES: readonly MetadataStatus[] = [
  'OVER_QUERY_LIMIT',
  'REQUEST_DENIED',
  'INVALID_REQUEST',
  'UNKNOWN_ERROR',
];

export interface DiscoverOptions {
  params?: ViewpointParameters;
  budgetMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class BudgetExceeded extends Error {}

/**
 * The viewpoint algorithm: primary panorama by radius ladder, up to four alternate probes along
 * the road, per-candidate view parameters, then primary selection and ordering. Metadata errors
 * are retried once; persistent errors or an exhausted time budget end with status `error`.
 */
export async function discoverCandidates(
  probe: MetadataProbe,
  input: DiscoveryInput,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const params = options.params ?? DEFAULT_VIEWPOINT_PARAMETERS;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const budgetMs = options.budgetMs ?? 6000;
  const started = now();
  let calls = 0;

  const call = async (location: LatLng, radius: number): Promise<StreetViewMetadata> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (now() - started > budgetMs) throw new BudgetExceeded();
      calls += 1;
      const result = await probe(location, radius);
      if (!METADATA_ERROR_STATUSES.includes(result.status)) return result;
      if (attempt === 0) await sleep(options.retryDelayMs ?? 250);
      else return result;
    }
    return { status: 'UNKNOWN_ERROR', panoId: null, location: null, date: null, copyright: null };
  };

  const result = (
    status: DiscoveryResult['status'],
    extra: Partial<DiscoveryResult> = {},
  ): DiscoveryResult => ({
    status,
    candidates: [],
    probeRadiusM: null,
    deepSetback: false,
    metadataCalls: calls,
    durationMs: now() - started,
    timedOut: false,
    ...extra,
  });

  try {
    // Step 1: primary panorama.
    let primary: StreetViewMetadata | null = null;
    let primaryRadius: number | null = null;
    for (const radius of params.radiusLadderM) {
      const metadata = await call(input.target, radius);
      if (METADATA_ERROR_STATUSES.includes(metadata.status)) return result('error');
      if (metadata.status === 'OK' && metadata.panoId && metadata.location) {
        primary = metadata;
        primaryRadius = radius;
        break;
      }
    }
    if (!primary || primaryRadius === null || !primary.location) return result('no_imagery');
    const deepSetback = primaryRadius > (params.radiusLadderM[0] ?? 50);

    // Step 2: alternates along the road bearing (perpendicular to camera→target when unknown).
    const roadBearing =
      input.roadBearingDeg ??
      normalizeDegrees(initialBearingDeg(primary.location, input.target) + 90);
    const found: { metadata: StreetViewMetadata; probe: string }[] = [
      { metadata: primary, probe: 'target' },
    ];
    for (const offset of params.alternateOffsetsM) {
      const point = destinationPoint(
        input.target,
        offset >= 0 ? roadBearing : roadBearing + 180,
        Math.abs(offset),
      );
      const metadata = await call(point, primaryRadius);
      if (metadata.status !== 'OK' || !metadata.panoId || !metadata.location) continue;
      if (found.some((item) => item.metadata.panoId === metadata.panoId)) continue;
      if (haversineDistanceM(metadata.location, input.target) > params.maxAlternateDistanceM)
        continue;
      found.push({ metadata, probe: `offset_${offset > 0 ? '+' : '-'}${Math.abs(offset)}m` });
    }

    // Step 3: view parameters per candidate, aimed at the same target.
    const candidates: ViewCandidate[] = found.map(({ metadata, probe: probeName }) => {
      const location = metadata.location as LatLng;
      const distance = haversineDistanceM(location, input.target);
      const fov = viewFovDeg(input.facadeWidthM, distance, params);
      const copyrightClass = copyrightClassOf(metadata.copyright);
      const granularity = captureGranularityOf(metadata.date);
      const flags: CandidateFlag[] = [];
      if (deepSetback) flags.push('deepSetback');
      if (copyrightClass !== 'google') flags.push('contributorImagery');
      if (granularity === 'none') flags.push('undated');
      if (distance > params.farFromTargetM) flags.push('farFromTarget');
      if (input.attachedFacade) flags.push('attachedFacade');
      return {
        panoId: metadata.panoId as string,
        heading: round(initialBearingDeg(location, input.target), 1),
        headingMode: input.geometryAvailable ? 'geometry' : 'point',
        pitch: round(viewPitchDeg(distance, params), 1),
        fov: round(fov, 1),
        width: params.size,
        height: params.size,
        distanceM: Math.round(distance),
        captureDate: metadata.date ?? null,
        captureGranularity: granularity,
        copyright: metadata.copyright ?? null,
        isGoogleImagery: copyrightClass === 'google',
        estimatedFacadePx: estimatedFacadePx(input.facadeWidthM, distance, fov, params.size),
        flags,
        rank: 0,
        isPrimary: false,
        location,
        probe: probeName,
      };
    });

    // Step 4: primary selection and ordering.
    let primaryCandidate = candidates[0] as ViewCandidate;
    const weak =
      !primaryCandidate.isGoogleImagery || primaryCandidate.captureGranularity === 'none';
    if (weak) {
      const replacement = candidates
        .slice(1)
        .find(
          (candidate) =>
            candidate.isGoogleImagery &&
            candidate.captureGranularity !== 'none' &&
            candidate.distanceM <= params.primaryReplacementMaxDistanceM,
        );
      if (replacement) primaryCandidate = replacement;
    }
    const facing =
      input.facadeNormalDeg === null ? null : normalizeDegrees(input.facadeNormalDeg + 180);
    const rest = candidates
      .filter((candidate) => candidate !== primaryCandidate)
      .sort((a, b) => {
        if (a.isGoogleImagery !== b.isGoogleImagery) return a.isGoogleImagery ? -1 : 1;
        const da = Math.abs(a.distanceM - params.preferredDistanceM);
        const db = Math.abs(b.distanceM - params.preferredDistanceM);
        if (da !== db) return da - db;
        if (facing !== null)
          return angleDifference(a.heading, facing) - angleDifference(b.heading, facing);
        return a.panoId.localeCompare(b.panoId);
      });
    const ordered = [primaryCandidate, ...rest]
      .slice(0, params.maxCandidates)
      .map((candidate, index) => ({
        ...candidate,
        rank: index + 1,
        isPrimary: index === 0,
      }));
    return result('ok', { candidates: ordered, probeRadiusM: primaryRadius, deepSetback });
  } catch (error) {
    if (error instanceof BudgetExceeded) return result('error', { timedOut: true });
    throw error;
  }
}
