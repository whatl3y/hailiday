import type { CandidateFlag } from '@hailiday/core';
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

/**
 * Error statuses that end discovery at once (after the target's one retry): a refused key, an
 * exhausted quota or a malformed request answers the same at every nearby point.
 */
export const METADATA_FATAL_STATUSES: readonly MetadataStatus[] = [
  'OVER_QUERY_LIMIT',
  'REQUEST_DENIED',
  'INVALID_REQUEST',
];

/** Compass bearings of the probe cross around the target when the road bearing is unknown. */
export const TARGET_CROSS_BEARINGS: readonly { bearingDeg: number; label: string }[] = [
  { bearingDeg: 0, label: 'n' },
  { bearingDeg: 90, label: 'e' },
  { bearingDeg: 180, label: 's' },
  { bearingDeg: 270, label: 'w' },
];

export interface DiscoverOptions {
  params?: ViewpointParameters;
  budgetMs?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class BudgetExceeded extends Error {}

interface ProbePoint {
  location: LatLng;
  label: string;
}

const offsetLabel = (offset: number) => `offset_${offset > 0 ? '+' : '-'}${Math.abs(offset)}m`;

/** The point `offset` meters from `target` along `roadBearing` (negative: the other way). */
function alongRoad(target: LatLng, roadBearing: number, offset: number): LatLng {
  return destinationPoint(target, offset >= 0 ? roadBearing : roadBearing + 180, Math.abs(offset));
}

/**
 * Points probed when the target itself answers `UNKNOWN_ERROR`: the alternate offsets along the
 * road when its bearing is known, else a cross at the smallest alternate offset around the target.
 */
function targetFallbackPoints(input: DiscoveryInput, params: ViewpointParameters): ProbePoint[] {
  if (input.roadBearingDeg !== null) {
    const roadBearing = input.roadBearingDeg;
    return params.alternateOffsetsM.map((offset) => ({
      location: alongRoad(input.target, roadBearing, offset),
      label: offsetLabel(offset),
    }));
  }
  const distances = params.alternateOffsetsM.map(Math.abs).filter((value) => value > 0);
  if (distances.length === 0) return [];
  const distance = Math.min(...distances);
  return TARGET_CROSS_BEARINGS.map(({ bearingDeg, label }) => ({
    location: destinationPoint(input.target, bearingDeg, distance),
    label: `cross_${label}_${distance}m`,
  }));
}

const usable = (
  metadata: StreetViewMetadata,
): metadata is StreetViewMetadata & { location: LatLng } =>
  metadata.status === 'OK' && Boolean(metadata.panoId) && metadata.location !== null;

/**
 * The viewpoint algorithm: primary panorama by radius ladder, up to four alternate probes along
 * the road, per-candidate view parameters, then primary selection and ordering.
 *
 * Every metadata error at the target is retried once. When both attempts answer with an error
 * status and either was `OVER_QUERY_LIMIT`, `REQUEST_DENIED` or `INVALID_REQUEST`, discovery ends
 * with status `error`; a retry that answers without an error status (such as `OK` or
 * `ZERO_RESULTS`) is taken as the answer. A persistent `UNKNOWN_ERROR` at the target
 * (Google answers it for some small patches of the map) is followed by one probe of each
 * fallback point at the same radius; the first `OK` panorama within the alternate distance limit
 * becomes the primary. The step ends with `error` only when every one of its probes errors; when
 * some answered without a usable panorama, the ladder continues. An exhausted time budget also
 * ends with `error`. With the default parameters a discovery makes at most 26 metadata calls:
 * 6 per ladder step (target, its retry, four fallback points) and 8 for the alternates (four
 * points, each retried once; a point already probed at the same radius reuses that answer, except
 * that a single `UNKNOWN_ERROR` there gets its one retry, so no point takes more than two calls).
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
  /** The settled answer per point and radius, with the attempts it took. */
  const answered = new Map<string, { metadata: StreetViewMetadata; attempts: number }>();
  const keyOf = (location: LatLng, radius: number) =>
    `${location.latitude.toFixed(7)},${location.longitude.toFixed(7)}@${radius}`;
  const isError = (metadata: StreetViewMetadata) =>
    METADATA_ERROR_STATUSES.includes(metadata.status);
  const isFatal = (metadata: StreetViewMetadata) =>
    METADATA_FATAL_STATUSES.includes(metadata.status);

  /**
   * Probes a point with up to `attempts` attempts in all, counting attempts already made there at
   * the same radius: a cached answer is reused unless it is an error with attempts left. When
   * every attempt errors and any of them answered a fatal status, the fatal answer is the one
   * returned, so a refusal is never masked by a later `UNKNOWN_ERROR`.
   */
  const call = async (
    location: LatLng,
    radius: number,
    attempts = 2,
  ): Promise<StreetViewMetadata> => {
    const key = keyOf(location, radius);
    const known = answered.get(key);
    if (known && (!isError(known.metadata) || known.attempts >= attempts)) return known.metadata;
    let made = known?.attempts ?? 0;
    let last: StreetViewMetadata = known?.metadata ?? {
      status: 'UNKNOWN_ERROR',
      panoId: null,
      location: null,
      date: null,
      copyright: null,
    };
    let fatal = known && isFatal(known.metadata) ? known.metadata : null;
    while (made < attempts) {
      if (made > 0) await sleep(options.retryDelayMs ?? 250);
      if (now() - started > budgetMs) throw new BudgetExceeded();
      calls += 1;
      made += 1;
      last = await probe(location, radius);
      if (!isError(last)) break;
      if (!fatal && isFatal(last)) fatal = last;
    }
    const settled = isError(last) && fatal ? fatal : last;
    answered.set(key, { metadata: settled, attempts: made });
    return settled;
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
    let primary: (StreetViewMetadata & { location: LatLng }) | null = null;
    let primaryProbe = 'target';
    let primaryRadius: number | null = null;
    const fallbackPoints = targetFallbackPoints(input, params);
    ladder: for (const radius of params.radiusLadderM) {
      const metadata = await call(input.target, radius);
      if (METADATA_FATAL_STATUSES.includes(metadata.status)) return result('error');
      if (usable(metadata)) {
        primary = metadata;
        primaryRadius = radius;
        break;
      }
      if (metadata.status !== 'UNKNOWN_ERROR') continue;
      let anyAnswer = false;
      for (const point of fallbackPoints) {
        const nearby = await call(point.location, radius, 1);
        if (METADATA_FATAL_STATUSES.includes(nearby.status)) return result('error');
        if (nearby.status === 'UNKNOWN_ERROR') continue;
        anyAnswer = true;
        if (
          usable(nearby) &&
          haversineDistanceM(nearby.location, input.target) <= params.maxAlternateDistanceM
        ) {
          primary = nearby;
          primaryProbe = point.label;
          primaryRadius = radius;
          break ladder;
        }
      }
      if (!anyAnswer) return result('error');
    }
    if (!primary || primaryRadius === null) return result('no_imagery');
    const deepSetback = primaryRadius > (params.radiusLadderM[0] ?? 50);

    // Step 2: alternates along the road bearing (perpendicular to camera→target when unknown).
    const roadBearing =
      input.roadBearingDeg ??
      normalizeDegrees(initialBearingDeg(primary.location, input.target) + 90);
    const found: { metadata: StreetViewMetadata; probe: string }[] = [
      { metadata: primary, probe: primaryProbe },
    ];
    for (const offset of params.alternateOffsetsM) {
      const metadata = await call(alongRoad(input.target, roadBearing, offset), primaryRadius);
      if (!usable(metadata)) continue;
      if (found.some((item) => item.metadata.panoId === metadata.panoId)) continue;
      if (haversineDistanceM(metadata.location, input.target) > params.maxAlternateDistanceM)
        continue;
      found.push({ metadata, probe: offsetLabel(offset) });
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
