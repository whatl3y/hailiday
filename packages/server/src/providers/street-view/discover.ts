import type { CandidateFlag } from '@hailiday/core';
import { captureGranularityOf, copyrightClassOf } from '../match.js';
import {
  DEFAULT_VIEWPOINT_PARAMETERS,
  angleDifference,
  crossTrackOffsetM,
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
  RoadEvidence,
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

/**
 * Compass bearings of a probe cross: around the target when it answers `UNKNOWN_ERROR` and the
 * road bearing is unknown, and around the lead panorama in the road step.
 */
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

/** A panorama found in Steps 1 and 2, with the probe that found it. */
interface FoundPanorama {
  metadata: StreetViewMetadata & { location: LatLng };
  probe: string;
}

/** One view of the road step, before rounding. */
interface RoadView {
  heading: number;
  pitch: number;
  roadView: NonNullable<ViewCandidate['roadView']>;
}

/**
 * The index of the panorama that leads: the first one, unless it is not attributed to Google or
 * is undated and a later one is attributed to Google, dated and within
 * `primaryReplacementMaxDistanceM` of the target (rounded to the meter); then the first such.
 */
function leadIndex(
  found: readonly FoundPanorama[],
  target: LatLng,
  params: ViewpointParameters,
): number {
  const strong = (metadata: StreetViewMetadata) =>
    copyrightClassOf(metadata.copyright) === 'google' &&
    captureGranularityOf(metadata.date) !== 'none';
  const first = found[0];
  if (!first || strong(first.metadata)) return 0;
  const replacement = found.findIndex(
    ({ metadata }, index) =>
      index > 0 &&
      strong(metadata) &&
      Math.round(haversineDistanceM(metadata.location, target)) <=
        params.primaryReplacementMaxDistanceM,
  );
  return replacement === -1 ? 0 : replacement;
}

/** A panorama that may give the road's track, as seen from the lead panorama. */
interface TrackChoice {
  panoId: string;
  /** Bearing from the lead panorama to this one. */
  bearing: number;
  /** Signed offset of the target from the line through both panoramas. */
  offset: number;
  /** Distance from the lead panorama. */
  separation: number;
  /** How many other eligible panoramas lie along the same line through the lead panorama. */
  agreement: number;
}

/** Smallest difference between two bearings taken as lines (modulo 180), in [0, 90]. */
const lineAngleDifference = (a: number, b: number) => {
  const difference = angleDifference(a, b);
  return Math.min(difference, 180 - difference);
};

/** Heading to 0.1 degree in [0, 360). */
const roundedHeading = (degrees: number) => {
  const value = round(normalizeDegrees(degrees), 1);
  return value >= 360 ? 0 : value;
};

/**
 * The viewpoint algorithm: primary panorama by radius ladder, up to four alternate probes along
 * the road, per-candidate view parameters, then primary selection and ordering.
 *
 * Without building geometry a road step runs after the alternates. The panorama that leads (the
 * one Step 4 would make primary) is `A`. When the target is within `roadCrossMaxTargetDistanceM`
 * of `A`, four single probes `roadCrossOffsetM` north, east, south and west of `A` at radius
 * `roadCrossRadiusM` are sent together (none once the time budget is spent; an error status there
 * is no panorama and never fails discovery). Every other panorama seen by any probe that is
 * attributed to Google and lies `trackMinSeparationM` to `trackMaxSeparationM` from `A` gives a
 * track (the bearing from `A` to it). Its agreement is the number of other such panoramas whose
 * bearing from `A` lies within `trackAgreementMaxDeg` of the same line (modulo 180 degrees). The
 * track with the highest agreement is taken; then the one the target lies nearest to, then the
 * nearer panorama, then the smaller panorama ID. A target within `onRoadMaxCrossTrackM` of that
 * track is on the road: the candidates are, all from `A` in mode `road`, the view across the road
 * to the side the target lies on (the south or east side when it is under `roadSideMinCrossTrackM`
 * from the track), the view across to the other side, both aimed at the point `roadsideSetbackM`
 * from the target across the track, and a third view: toward the target when it is at least
 * `alongRoadMinDistanceM` from `A` and that heading differs by at least `alongRoadMinSideAngleDeg`
 * from both side views, otherwise along the track (toward the panorama that gave it). With no
 * track at all after the cross, the candidates are three views from
 * `A` 120 degrees apart in mode `road`, starting toward the target (north under
 * `alongRoadMinDistanceM`). Otherwise Steps 3 and 4 run as with geometry, in mode `point`. Road
 * views have the widest field of view and the pitch of the assumed setback; what was found is
 * returned as `road`.
 *
 * Every metadata error at the target is retried once. When both attempts answer with an error
 * status and either was `OVER_QUERY_LIMIT`, `REQUEST_DENIED` or `INVALID_REQUEST`, discovery ends
 * with status `error`; a retry that answers without an error status (such as `OK` or
 * `ZERO_RESULTS`) is taken as the answer. A persistent `UNKNOWN_ERROR` at the target
 * (Google answers it for some small patches of the map) is followed by one probe of each
 * fallback point at the same radius; the first `OK` panorama within the alternate distance limit
 * becomes the primary. The step ends with `error` only when every one of its probes errors; when
 * some answered without a usable panorama, the ladder continues. An exhausted time budget also
 * ends with `error`. With the default parameters a discovery makes at most 26 metadata calls for
 * a place with building geometry: 6 per ladder step (target, its retry, four fallback points) and
 * 8 for the alternates (four points, each retried once; a point already probed at the same radius
 * reuses that answer, except that a single `UNKNOWN_ERROR` there gets its one retry, so no point
 * takes more than two calls). A place without it may add the 4 single probes of the cross around
 * the primary, 30 in all.
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
  /**
   * Every panorama any probe answered, in the order first seen, with whether its metadata is
   * attributed to Google.
   */
  const seen = new Map<string, { location: LatLng; google: boolean }>();
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
    if (usable(settled) && !seen.has(settled.panoId as string)) {
      seen.set(settled.panoId as string, {
        location: settled.location,
        google: copyrightClassOf(settled.copyright) === 'google',
      });
    }
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
    road: null,
    ...extra,
  });

  /**
   * The on-road test around the panorama that leads, and the road views when it calls for them
   * (`views` null when Steps 3 and 4 make the candidates).
   */
  const roadStep = async (
    lead: FoundPanorama,
  ): Promise<{ road: RoadEvidence; views: RoadView[] | null }> => {
    const origin = lead.metadata.location;
    const leadPanoId = lead.metadata.panoId as string;
    const target = input.target;
    const distance = haversineDistanceM(origin, target);
    const before = new Set(seen.keys());
    const looked = distance <= params.roadCrossMaxTargetDistanceM;
    let crossProbes = 0;
    if (looked) {
      const callsBefore = calls;
      // The four probes start in the order north, east, south, west and run together.
      await Promise.all(
        TARGET_CROSS_BEARINGS.map(({ bearingDeg }) =>
          call(
            destinationPoint(origin, bearingDeg, params.roadCrossOffsetM),
            params.roadCrossRadiusM,
            1,
          ).catch((error: unknown) => {
            if (!(error instanceof BudgetExceeded)) throw error;
          }),
        ),
      );
      crossProbes = calls - callsBefore;
    }

    // Panoramas that may give a track: attributed to Google, at a usable distance from the lead.
    const eligible: TrackChoice[] = [];
    for (const [panoId, { location, google }] of seen) {
      if (panoId === leadPanoId || !google) continue;
      const separation = haversineDistanceM(origin, location);
      if (separation < params.trackMinSeparationM || separation > params.trackMaxSeparationM) {
        continue;
      }
      const bearing = initialBearingDeg(origin, location);
      const offset = crossTrackOffsetM(origin, bearing, target);
      eligible.push({ panoId, bearing, offset, separation, agreement: 0 });
    }

    // The track most other eligible panoramas lie along; then the one the target lies nearest to;
    // then the nearer panorama; then the smaller panorama ID.
    let track: TrackChoice | null = null;
    for (const item of eligible) {
      item.agreement = eligible.filter(
        (other) =>
          other !== item &&
          lineAngleDifference(other.bearing, item.bearing) <= params.trackAgreementMaxDeg,
      ).length;
      const better =
        !track ||
        item.agreement > track.agreement ||
        (item.agreement === track.agreement &&
          (Math.abs(item.offset) < Math.abs(track.offset) ||
            (Math.abs(item.offset) === Math.abs(track.offset) &&
              (item.separation < track.separation ||
                (item.separation === track.separation && item.panoId < track.panoId)))));
      if (better) track = item;
    }

    if (!track) {
      const road: RoadEvidence = {
        onRoad: false,
        trackBearingDeg: null,
        trackAgreement: null,
        trackSource: null,
        crossTrackM: null,
        crossProbes,
      };
      if (!looked) return { road, views: null };
      // No road is known around the panorama: three views 120 degrees apart.
      const base = distance >= params.alongRoadMinDistanceM ? initialBearingDeg(origin, target) : 0;
      const pitch = viewPitchDeg(params.roadsideSetbackM, params);
      return {
        road,
        views: [0, 120, 240].map((turn) => ({
          heading: base + turn,
          pitch,
          roadView: 'around' as const,
        })),
      };
    }

    const onRoad = Math.abs(track.offset) <= params.onRoadMaxCrossTrackM;
    const road: RoadEvidence = {
      onRoad,
      trackBearingDeg: roundedHeading(track.bearing),
      trackAgreement: track.agreement,
      trackSource: before.has(track.panoId) ? 'alternates' : 'cross',
      crossTrackM: round(track.offset, 1),
      crossProbes,
    };
    if (!onRoad) return { road, views: null };

    // The side the target point lies on first; the south or east side when that is unknown.
    const first =
      Math.abs(track.offset) >= params.roadSideMinCrossTrackM
        ? normalizeDegrees(track.bearing + (track.offset > 0 ? 90 : -90))
        : (track.bearing % 180) + 90;
    const views: RoadView[] = [first, normalizeDegrees(first + 180)].map((side) => {
      const aim = destinationPoint(target, side, params.roadsideSetbackM);
      return {
        heading: initialBearingDeg(origin, aim),
        pitch: viewPitchDeg(haversineDistanceM(origin, aim), params),
        roadView: 'side' as const,
      };
    });
    // The third view looks toward the target unless the target is too near or that view would
    // repeat a side view; then it looks along the track.
    const toward = initialBearingDeg(origin, target);
    const towardTarget =
      distance >= params.alongRoadMinDistanceM &&
      views.every(
        (view) => angleDifference(view.heading, toward) >= params.alongRoadMinSideAngleDeg,
      );
    views.push({
      heading: towardTarget ? toward : track.bearing,
      pitch: viewPitchDeg(params.roadsideSetbackM, params),
      roadView: 'along',
    });
    return { road, views };
  };

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
    const found: FoundPanorama[] = [{ metadata: primary, probe: primaryProbe }];
    for (const offset of params.alternateOffsetsM) {
      const metadata = await call(alongRoad(input.target, roadBearing, offset), primaryRadius);
      if (!usable(metadata)) continue;
      if (found.some((item) => item.metadata.panoId === metadata.panoId)) continue;
      if (haversineDistanceM(metadata.location, input.target) > params.maxAlternateDistanceM)
        continue;
      found.push({ metadata, probe: offsetLabel(offset) });
    }

    const flagsOf = (metadata: StreetViewMetadata, distance: number): CandidateFlag[] => {
      const flags: CandidateFlag[] = [];
      if (deepSetback) flags.push('deepSetback');
      if (copyrightClassOf(metadata.copyright) !== 'google') flags.push('contributorImagery');
      if (captureGranularityOf(metadata.date) === 'none') flags.push('undated');
      if (distance > params.farFromTargetM) flags.push('farFromTarget');
      if (input.attachedFacade) flags.push('attachedFacade');
      return flags;
    };
    const lead = found[leadIndex(found, input.target, params)] as FoundPanorama;

    // The road step, for a place without building geometry.
    let road: RoadEvidence | null = null;
    if (!input.geometryAvailable) {
      const step = await roadStep(lead);
      road = step.road;
      if (step.views) {
        const metadata = lead.metadata;
        const distance = haversineDistanceM(metadata.location, input.target);
        const copyrightClass = copyrightClassOf(metadata.copyright);
        const candidates: ViewCandidate[] = step.views
          .slice(0, params.maxCandidates)
          .map((view, index) => ({
            panoId: metadata.panoId as string,
            heading: roundedHeading(view.heading),
            headingMode: 'road',
            pitch: round(view.pitch, 1),
            fov: params.fovMax,
            width: params.size,
            height: params.size,
            distanceM: Math.round(distance),
            captureDate: metadata.date ?? null,
            captureGranularity: captureGranularityOf(metadata.date),
            copyright: metadata.copyright ?? null,
            isGoogleImagery: copyrightClass === 'google',
            estimatedFacadePx: null,
            flags: flagsOf(metadata, distance),
            rank: index + 1,
            isPrimary: index === 0,
            location: metadata.location,
            probe: lead.probe,
            roadView: view.roadView,
          }));
        return result('ok', { candidates, probeRadiusM: primaryRadius, deepSetback, road });
      }
    }

    // Step 3: view parameters per candidate, aimed at the same target.
    const candidates: ViewCandidate[] = found.map(({ metadata, probe: probeName }) => {
      const location = metadata.location;
      const distance = haversineDistanceM(location, input.target);
      const fov = viewFovDeg(input.facadeWidthM, distance, params);
      const copyrightClass = copyrightClassOf(metadata.copyright);
      const granularity = captureGranularityOf(metadata.date);
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
        flags: flagsOf(metadata, distance),
        rank: 0,
        isPrimary: false,
        location,
        probe: probeName,
      };
    });

    // Step 4: primary selection and ordering.
    const primaryCandidate = candidates[found.indexOf(lead)] as ViewCandidate;
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
    return result('ok', {
      candidates: ordered,
      probeRadiusM: primaryRadius,
      deepSetback,
      road,
    });
  } catch (error) {
    if (error instanceof BudgetExceeded) return result('error', { timedOut: true });
    throw error;
  }
}
