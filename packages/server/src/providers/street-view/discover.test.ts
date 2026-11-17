import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWPOINT_PARAMETERS,
  angleDifference,
  destinationPoint,
  fromLocalMeters,
  haversineDistanceM,
  initialBearingDeg,
  type LatLng,
} from '../geo.js';
import type {
  DiscoveryInput,
  DiscoveryResult,
  MetadataStatus,
  StreetViewMetadata,
} from '../types.js';
import { discoverCandidates, type MetadataProbe } from './discover.js';

const TARGET: LatLng = { latitude: 37.776074, longitude: -122.432727 };

const input = (overrides: Partial<DiscoveryInput> = {}): DiscoveryInput => ({
  target: TARGET,
  geometryAvailable: true,
  facadeWidthM: 8,
  roadBearingDeg: 0,
  facadeNormalDeg: 270,
  attachedFacade: false,
  ...overrides,
});

const NONE = { panoId: null, location: null, date: null, copyright: null };
const answer = (status: MetadataStatus): StreetViewMetadata => ({ status, ...NONE });
const pano = (panoId: string, location: LatLng): StreetViewMetadata => ({
  status: 'OK',
  panoId,
  location,
  date: '2025-06',
  copyright: '© Google',
});

/** A panorama 12 m north of the target and one 10 m south of it. */
const NORTH = pano('panoNorth', destinationPoint(TARGET, 0, 12));
const SOUTH = pano('panoSouth', destinationPoint(TARGET, 180, 10));

interface Where {
  atTarget: boolean;
  bearing: number;
  radius: number;
}

/** The rule also sees the point's distance from the target, rounded to the meter. */
type Rule = (where: Where & { distanceM: number }) => StreetViewMetadata;

/** A recorded probe: the rule answers per point; every call is kept for assertions. */
function stubProbe(rule: Rule) {
  const calls: Where[] = [];
  const probe: MetadataProbe = async (location, radius) => {
    const distance = haversineDistanceM(TARGET, location);
    const atTarget = distance < 0.5;
    const north = location.latitude > TARGET.latitude + 1e-7;
    const south = location.latitude < TARGET.latitude - 1e-7;
    const bearing = atTarget
      ? -1
      : north
        ? 0
        : south
          ? 180
          : location.longitude > TARGET.longitude
            ? 90
            : 270;
    const where = { atTarget, bearing, radius };
    calls.push(where);
    return rule({ ...where, distanceM: Math.round(distance) });
  };
  return { probe, calls };
}

const options = { retryDelayMs: 0 };

describe('discoverCandidates when the target point answers UNKNOWN_ERROR', () => {
  it('takes the first OK panorama along the road as the primary', async () => {
    const { probe, calls } = stubProbe(({ atTarget, bearing }) => {
      if (atTarget) return answer('UNKNOWN_ERROR');
      return bearing === 0 ? NORTH : SOUTH;
    });
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('ok');
    expect(result.probeRadiusM).toBe(50);
    expect(result.deepSetback).toBe(false);
    expect(result.candidates[0]).toMatchObject({
      panoId: 'panoNorth',
      isPrimary: true,
      probe: 'offset_+15m',
      distanceM: 12,
    });
    expect(result.candidates.map((candidate) => candidate.panoId)).toEqual([
      'panoNorth',
      'panoSouth',
    ]);
    // Target and its retry, the first fallback point, then the three alternates not yet probed.
    expect(calls.filter((call) => call.atTarget)).toHaveLength(2);
    expect(result.metadataCalls).toBe(6);
    expect(calls).toHaveLength(6);
  });

  it('probes a cross around the target when the road bearing is unknown', async () => {
    const { probe, calls } = stubProbe(({ atTarget, bearing }) => {
      if (atTarget || bearing === 0) return answer('UNKNOWN_ERROR');
      if (bearing === 90) return answer('ZERO_RESULTS');
      return SOUTH;
    });
    const result = await discoverCandidates(probe, input({ roadBearingDeg: null }), options);
    expect(result.status).toBe('ok');
    expect(result.candidates[0]).toMatchObject({ panoId: 'panoSouth', probe: 'cross_s_15m' });
    expect(calls.slice(0, 5).map((call) => call.bearing)).toEqual([-1, -1, 0, 90, 180]);
  });

  it('continues the ladder when the fallback points answer without imagery', async () => {
    const { probe, calls } = stubProbe(({ atTarget, radius }) => {
      if (atTarget) return answer('UNKNOWN_ERROR');
      return radius < 100 ? answer('ZERO_RESULTS') : NORTH;
    });
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('ok');
    expect(result.probeRadiusM).toBe(100);
    expect(result.deepSetback).toBe(true);
    expect(result.candidates[0]?.panoId).toBe('panoNorth');
    expect(calls.filter((call) => call.atTarget).map((call) => call.radius)).toEqual([
      50, 50, 100, 100,
    ]);
  });

  it('skips fallback panoramas beyond the alternate distance limit', async () => {
    const far = pano('panoFar', destinationPoint(TARGET, 0, 90));
    const { probe, calls } = stubProbe(({ atTarget }) =>
      atTarget ? answer('UNKNOWN_ERROR') : far,
    );
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('no_imagery');
    expect(result.candidates).toEqual([]);
    // Bounded: six calls per ladder step, three steps.
    expect(result.metadataCalls).toBe(18);
    expect(calls).toHaveLength(18);
  });

  it('is an error when every probe of the step errors', async () => {
    const { probe, calls } = stubProbe(() => answer('UNKNOWN_ERROR'));
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('error');
    expect(result.timedOut).toBe(false);
    expect(result.metadataCalls).toBe(6);
    expect(calls.every((call) => call.radius === 50)).toBe(true);
    const cross = stubProbe(() => answer('UNKNOWN_ERROR'));
    const crossResult = await discoverCandidates(
      cross.probe,
      input({ roadBearingDeg: null }),
      options,
    );
    expect(crossResult.status).toBe('error');
    expect(crossResult.metadataCalls).toBe(6);
  });

  it('is an error when the time budget runs out during the fallback probes', async () => {
    let clock = 0;
    const { probe } = stubProbe(({ atTarget }) => {
      clock += 1000;
      return atTarget ? answer('UNKNOWN_ERROR') : answer('ZERO_RESULTS');
    });
    const result = await discoverCandidates(probe, input(), {
      ...options,
      budgetMs: 2500,
      now: () => clock,
    });
    expect(result).toMatchObject({ status: 'error', timedOut: true });
  });

  it('retries a fallback point that errored once when the alternates reuse it', async () => {
    let northProbes = 0;
    const { probe, calls } = stubProbe(({ atTarget, bearing, distanceM }) => {
      if (atTarget) return answer('UNKNOWN_ERROR');
      if (distanceM === 15 && bearing === 0) {
        northProbes += 1;
        return northProbes === 1 ? answer('UNKNOWN_ERROR') : NORTH;
      }
      if (distanceM === 15 && bearing === 180) return SOUTH;
      return answer('ZERO_RESULTS');
    });
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('ok');
    expect(result.candidates.map(({ panoId, probe: name }) => [panoId, name])).toEqual([
      ['panoSouth', 'offset_-15m'],
      ['panoNorth', 'offset_+15m'],
    ]);
    // Target and its retry, +15 m (error) and -15 m (the primary) in Step 1; then the retry of
    // +15 m and one probe each at +30 m and -30 m. -15 m is reused.
    expect(northProbes).toBe(2);
    expect(result.metadataCalls).toBe(7);
    expect(calls).toHaveLength(7);
  });

  it('stays within 26 metadata calls for a place with building geometry', async () => {
    const west = pano('panoWest', destinationPoint(TARGET, 250, 20));
    const { probe, calls } = stubProbe(({ atTarget, bearing, radius }) => {
      if (atTarget) return answer('UNKNOWN_ERROR');
      if (radius < 200) return answer('ZERO_RESULTS');
      return bearing === 270 ? west : answer('UNKNOWN_ERROR');
    });
    const result = await discoverCandidates(probe, input({ roadBearingDeg: null }), options);
    expect(result.status).toBe('ok');
    expect(result.candidates.map(({ panoId, probe: name }) => [panoId, name])).toEqual([
      ['panoWest', 'cross_w_15m'],
    ]);
    // Six calls per radius step, then four alternates off the cross, each retried once.
    expect(result.metadataCalls).toBe(26);
    expect(calls).toHaveLength(26);
  });

  it('ends at once when a fallback point answers a refusal', async () => {
    const { probe, calls } = stubProbe(({ atTarget }) =>
      atTarget ? answer('UNKNOWN_ERROR') : answer('OVER_QUERY_LIMIT'),
    );
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('error');
    expect(calls).toHaveLength(3);
  });
});

describe('discoverCandidates refusals at the target point', () => {
  for (const status of ['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'INVALID_REQUEST'] as const) {
    it(`${status} ends with error after its one retry and no other probe`, async () => {
      const { probe, calls } = stubProbe(({ atTarget }) => (atTarget ? answer(status) : NORTH));
      const result = await discoverCandidates(probe, input(), options);
      expect(result.status).toBe('error');
      expect(result.metadataCalls).toBe(2);
      expect(calls).toEqual([
        { atTarget: true, bearing: -1, radius: 50 },
        { atTarget: true, bearing: -1, radius: 50 },
      ]);
    });
  }

  for (const status of ['REQUEST_DENIED', 'OVER_QUERY_LIMIT', 'INVALID_REQUEST'] as const) {
    it(`${status} on the first attempt ends with error when the retry answers UNKNOWN_ERROR`, async () => {
      let targetProbes = 0;
      const { probe, calls } = stubProbe(({ atTarget }) => {
        if (!atTarget) return NORTH;
        targetProbes += 1;
        return answer(targetProbes === 1 ? status : 'UNKNOWN_ERROR');
      });
      const result = await discoverCandidates(probe, input(), options);
      expect(result.status).toBe('error');
      expect(result.metadataCalls).toBe(2);
      expect(calls.every((call) => call.atTarget)).toBe(true);
    });
  }

  it('a refusal at the target that clears on the retry is not an error', async () => {
    let targetProbes = 0;
    const { probe } = stubProbe(({ atTarget }) => {
      if (!atTarget) return SOUTH;
      targetProbes += 1;
      return targetProbes === 1 ? answer('OVER_QUERY_LIMIT') : NORTH;
    });
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('ok');
    expect(result.candidates[0]).toMatchObject({ panoId: 'panoNorth', probe: 'target' });
  });

  it('a transient error at the target is retried once and then succeeds there', async () => {
    let first = true;
    const { probe } = stubProbe(({ atTarget }) => {
      if (atTarget && first) {
        first = false;
        return answer('UNKNOWN_ERROR');
      }
      return atTarget ? NORTH : SOUTH;
    });
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('ok');
    expect(result.candidates[0]).toMatchObject({ panoId: 'panoNorth', probe: 'target' });
  });
});

describe('discoverCandidates with contributor imagery at the target', () => {
  /** A contributor's panorama 8 m east of the target (not attributed to Google). */
  const CONTRIBUTOR: StreetViewMetadata = {
    ...pano('panoContributor', destinationPoint(TARGET, 90, 8)),
    copyright: '© GIS1 Street Imagery',
  };

  it('makes a Google-attributed alternate within range the primary', async () => {
    const { probe } = stubProbe(({ atTarget, bearing }) =>
      atTarget ? CONTRIBUTOR : bearing === 0 ? NORTH : SOUTH,
    );
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('ok');
    const primary = result.candidates.find((candidate) => candidate.isPrimary);
    expect(primary).toMatchObject({ isGoogleImagery: true });
    expect(primary?.panoId).not.toBe('panoContributor');
    const contributor = result.candidates.find((c) => c.panoId === 'panoContributor');
    expect(contributor).toMatchObject({ isPrimary: false, isGoogleImagery: false });
    expect(contributor?.flags).toContain('contributorImagery');
  });

  it('keeps the contributor panorama as the primary when no Google alternate is found', async () => {
    const { probe } = stubProbe(({ atTarget }) =>
      atTarget ? CONTRIBUTOR : answer('ZERO_RESULTS'),
    );
    const result = await discoverCandidates(probe, input(), options);
    expect(result.status).toBe('ok');
    expect(result.candidates[0]).toMatchObject({
      panoId: 'panoContributor',
      isPrimary: true,
      isGoogleImagery: false,
      copyright: '© GIS1 Street Imagery',
    });
  });
});

describe('discoverCandidates for a place without building geometry', () => {
  /** A point `x` meters east and `y` meters north of the target. */
  const at = (x: number, y: number) => fromLocalMeters(TARGET, { x, y });
  const noGeometry = (overrides: Partial<DiscoveryInput> = {}) =>
    input({
      geometryAvailable: false,
      facadeWidthM: null,
      roadBearingDeg: null,
      facadeNormalDeg: null,
      ...overrides,
    });

  /**
   * A target interpolated onto the road, 1 m right of the track: the first panorama 5 m west of
   * the target, the second 13 m east of it.
   */
  const P1 = pano('panoOne', at(-4.709, 1.701));
  const P2 = pano('panoTwo', at(8.008, -0.145));
  /** The same place mirrored north to south. */
  const P1_MIRRORED = pano('panoOne', at(-4.709, -1.701));
  const P2_MIRRORED = pano('panoTwo', at(8.008, 0.145));

  interface WorldCall {
    location: LatLng;
    radius: number;
  }

  /**
   * Answers a probe with the nearest listed panorama within the radius (`ZERO_RESULTS` when none),
   * unless `rule` answers it first; every call is kept.
   */
  function world(
    panoramas: readonly StreetViewMetadata[],
    rule?: (location: LatLng, radius: number) => StreetViewMetadata | undefined,
  ) {
    const calls: WorldCall[] = [];
    const probe: MetadataProbe = async (location, radius) => {
      calls.push({ location, radius });
      const ruled = rule?.(location, radius);
      if (ruled) return ruled;
      let nearest: { metadata: StreetViewMetadata; distance: number } | null = null;
      for (const metadata of panoramas) {
        const distance = haversineDistanceM(metadata.location as LatLng, location);
        if (distance <= radius && (!nearest || distance < nearest.distance)) {
          nearest = { metadata, distance };
        }
      }
      return nearest?.metadata ?? answer('ZERO_RESULTS');
    };
    return { probe, calls };
  }

  /** Whether `location` is the cross point `bearing` of `origin` (15 m away). */
  const crossPoint = (origin: StreetViewMetadata, bearing: number, location: LatLng) =>
    haversineDistanceM(destinationPoint(origin.location as LatLng, bearing, 15), location) < 0.01;

  /** Within 0.2 of the expected value. */
  const expectNear = (value: number | null | undefined, expected: number) =>
    expect(Math.abs((value ?? Number.NaN) - expected)).toBeLessThanOrEqual(0.2);

  const views = (result: DiscoveryResult) =>
    result.candidates.map(({ panoId, heading, headingMode, pitch, fov, roadView, rank }) => ({
      panoId,
      heading,
      headingMode,
      pitch,
      fov,
      roadView,
      rank,
    }));

  it('offers both sides of the road and the view along it from the nearest panorama', async () => {
    const { probe, calls } = world([P1, P2]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.status).toBe('ok');
    expect(result.candidates).toHaveLength(3);
    const [first, second, along] = result.candidates;
    expectNear(first?.heading, 171.3);
    expectNear(second?.heading, 27.6);
    expectNear(along?.heading, 109.9);
    expect(result.candidates.map(({ pitch }) => pitch)).toEqual([3.4, 3.9, 3.8]);
    for (const candidate of result.candidates) {
      expect(candidate).toMatchObject({
        panoId: 'panoOne',
        headingMode: 'road',
        fov: 90,
        width: 640,
        height: 640,
        distanceM: 5,
        estimatedFacadePx: null,
        probe: 'target',
      });
    }
    expect(result.candidates.map(({ roadView }) => roadView)).toEqual(['side', 'side', 'along']);
    expect(result.candidates.map(({ rank, isPrimary }) => [rank, isPrimary])).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
    expect(result.road).toMatchObject({
      onRoad: true,
      trackSource: 'alternates',
      crossTrackM: 1,
      crossProbes: 4,
    });
    expectNear(result.road?.trackBearingDeg, 98.3);
    // The target, four alternates, then the cross around the first panorama.
    expect(result.metadataCalls).toBe(9);
    expect(calls).toHaveLength(9);
  });

  it('puts the side the target point lies on first', async () => {
    const { probe } = world([P1_MIRRORED, P2_MIRRORED]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.road?.crossTrackM).toBe(-1);
    const [first, second] = result.candidates;
    expectNear(first?.heading, 8.7);
    expect(Math.abs((second?.heading ?? 0) - 180)).toBeLessThan(90);
    expect(result.candidates.map(({ roadView }) => roadView)).toEqual(['side', 'side', 'along']);
  });

  it('shows the same side first whichever way the second panorama lies, when the target is on the track', async () => {
    for (const second of [at(8, 0), at(-18, 0)]) {
      const { probe } = world([pano('panoOne', at(-5, 0)), pano('panoTwo', second)]);
      const result = await discoverCandidates(probe, noGeometry(), options);
      expect(result.road).toMatchObject({ onRoad: true, trackSource: 'cross', crossTrackM: 0 });
      const heading = result.candidates[0]?.heading ?? 0;
      expect(heading).toBeGreaterThan(90);
      expect(heading).toBeLessThan(270);
      expectNear(heading, 161.6);
    }
  });

  it('offers the view along the track when the target is under 3 m from the panorama', async () => {
    const { probe } = world([pano('panoOne', at(-2, 0)), pano('panoTwo', at(10, 0))]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.road).toMatchObject({ onRoad: true, trackAgreement: 0 });
    expectNear(result.road?.trackBearingDeg, 90);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map(({ roadView }) => roadView)).toEqual(['side', 'side', 'along']);
    expect(result.candidates[2]).toMatchObject({
      panoId: 'panoOne',
      heading: result.road?.trackBearingDeg,
      headingMode: 'road',
      pitch: 3.8,
      roadView: 'along',
    });
  });

  it('turns the third view along the track when the view toward the target would repeat a side view', async () => {
    // The target 4 m north of the panorama, abeam of an east-west road.
    const { probe } = world([pano('panoOne', at(0, -4)), pano('panoTwo', at(10, -4))]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.road).toMatchObject({ onRoad: true, trackAgreement: 0, crossTrackM: -4 });
    expectNear(result.road?.trackBearingDeg, 90);
    const [first, second, along] = result.candidates;
    expectNear(angleDifference(first?.heading ?? Number.NaN, 0), 0);
    expectNear(second?.heading, 180);
    expect(along).toMatchObject({
      heading: result.road?.trackBearingDeg,
      pitch: 3.8,
      roadView: 'along',
    });
  });

  it('keeps the views aimed at the point when it is more than 6 m off the track', async () => {
    const first = pano('panoOne', at(-5, -12));
    const second = pano('panoTwo', at(8, -12));
    const { probe, calls } = world([first, second]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.candidates.map(({ panoId }) => panoId)).toEqual(['panoOne', 'panoTwo']);
    for (const candidate of result.candidates) {
      expect(candidate.headingMode).toBe('point');
      expect(candidate.roadView).toBeUndefined();
      expect(candidate.heading).toBeCloseTo(initialBearingDeg(candidate.location, TARGET), 1);
    }
    expect(result.road).toMatchObject({
      onRoad: false,
      trackSource: 'alternates',
      crossProbes: 0,
    });
    expectNear(result.road?.trackBearingDeg, 90);
    expectNear(result.road?.crossTrackM, -12);
    expect(calls.some((call) => call.radius === 13)).toBe(false);
  });

  it('never tests for the road with building geometry', async () => {
    const { probe, calls } = world([P1, P2]);
    const result = await discoverCandidates(
      probe,
      input({ facadeWidthM: null, roadBearingDeg: null, facadeNormalDeg: null }),
      options,
    );
    expect(result.candidates.every((candidate) => candidate.headingMode === 'geometry')).toBe(true);
    expect(result.road).toBeNull();
    expect(calls.some((call) => call.radius === 13)).toBe(false);
    expect(result.metadataCalls).toBe(5);
  });

  it('with equal agreement the track the target lies nearest to is taken', async () => {
    const first = pano('panoOne', at(-5, 0));
    const two = pano('panoTwo', at(8, 0));
    const north = pano('panoNorth', at(-5, 20));
    // Alone, and each with one agreeing panorama: 11 degrees off the line of panoTwo, and on the
    // line of panoNorth.
    for (const [extra, agreement] of [
      [[], 0],
      [[pano('panoWest', at(-20, 3)), pano('panoSouth', at(-5, -12))], 1],
    ] as const) {
      const { probe } = world([first, two, north, ...extra]);
      const result = await discoverCandidates(probe, noGeometry(), options);
      expect(result.road).toMatchObject({
        onRoad: true,
        trackSource: 'cross',
        crossTrackM: 0,
        trackAgreement: agreement,
      });
      expectNear(result.road?.trackBearingDeg, 90);
      expect(result.candidates.map(({ roadView }) => roadView)).toEqual(['side', 'side', 'along']);
    }
  });

  it('takes the track most panoramas lie along, not the one most in line with the target', async () => {
    // The panorama 1.6 m south of the target on an east-west road, with neighbours 10 m east and
    // west of it, and a panorama of a cross street 10 m north of it.
    const lead = pano('panoLead', at(0, -1.6));
    const { probe } = world([
      lead,
      pano('panoEast', at(10, -1.6)),
      pano('panoWest', at(-10, -1.6)),
      pano('panoCross', at(0, 8.4)),
    ]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.road).toMatchObject({ onRoad: true, trackAgreement: 1 });
    const track = result.road?.trackBearingDeg ?? Number.NaN;
    expect(Math.min(angleDifference(track, 90), angleDifference(track, 270))).toBeLessThan(1);
    expectNear(Math.abs(result.road?.crossTrackM ?? Number.NaN), 1.6);
    expect(result.candidates.map(({ panoId }) => panoId)).toEqual([
      'panoLead',
      'panoLead',
      'panoLead',
    ]);
    const [first, second, along] = result.candidates;
    expect(first?.roadView).toBe('side');
    expectNear(angleDifference(first?.heading ?? Number.NaN, 0), 0);
    expect(second?.roadView).toBe('side');
    expectNear(second?.heading, 180);
    expect(along).toMatchObject({ roadView: 'along', heading: track });
  });

  it('takes the nearer of two panoramas on one line', async () => {
    // The target at the lead panorama: both tracks pass through it. The farther panorama is seen
    // first (the alternate 15 m east) and has the smaller ID.
    const { probe } = world([
      pano('panoLead', at(0, 0)),
      pano('panoFar', at(12, 0)),
      pano('panoNear', at(-6, 0)),
    ]);
    const result = await discoverCandidates(probe, noGeometry({ roadBearingDeg: 90 }), options);
    expect(result.road).toMatchObject({ onRoad: true, trackAgreement: 1, crossTrackM: 0 });
    expectNear(result.road?.trackBearingDeg, 270);
  });

  it('a panorama not attributed to Google gives no track', async () => {
    const contributor = (panoId: string, location: LatLng): StreetViewMetadata => ({
      ...pano(panoId, location),
      copyright: '© GIS1 Street Imagery',
    });
    // The lead 13 m west of the target and a contributor panorama 27 m east of it, on a line
    // through the target.
    const far = world([pano('panoOne', at(-13, 0)), contributor('panoContributor', at(14, 0))]);
    const farResult = await discoverCandidates(
      far.probe,
      noGeometry({ roadBearingDeg: 90 }),
      options,
    );
    expect(farResult.candidates.map(({ panoId }) => panoId)).toEqual([
      'panoOne',
      'panoContributor',
    ]);
    for (const candidate of farResult.candidates) expect(candidate.headingMode).toBe('point');
    expect(farResult.road).toEqual({
      onRoad: false,
      trackBearingDeg: null,
      trackAgreement: null,
      trackSource: null,
      crossTrackM: null,
      crossProbes: 0,
    });

    // A Google panorama 10 m north of the lead; a contributor panorama on a line through the
    // target and another on the line of the Google one.
    const near = world([
      pano('panoOne', at(-5, 0)),
      pano('panoNorth', at(-5, 10)),
      contributor('panoContributor', at(8, 0)),
      contributor('panoContributorSouth', at(-5, -10)),
    ]);
    const nearResult = await discoverCandidates(near.probe, noGeometry(), options);
    expect(nearResult.road).toMatchObject({
      onRoad: true,
      trackAgreement: 0,
      trackSource: 'alternates',
      crossTrackM: 5,
    });
    expectNear(angleDifference(nearResult.road?.trackBearingDeg ?? Number.NaN, 0), 0);
  });

  it('looks around the lead panorama: four probes 15 m north, east, south and west of it', async () => {
    const { probe, calls } = world([P1, P2], (_location, radius) =>
      radius === 13 ? answer('UNKNOWN_ERROR') : undefined,
    );
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.status).toBe('ok');
    expect(calls.slice(0, 5).every((call) => call.radius === 50)).toBe(true);
    const cross = calls.slice(5);
    // One attempt each, even for an error status.
    expect(cross).toHaveLength(4);
    expect(cross.every((call) => call.radius === 13)).toBe(true);
    [0, 90, 180, 270].forEach((bearing, index) => {
      expect(crossPoint(P1, bearing, cross[index]?.location as LatLng)).toBe(true);
    });
    expect(result.road).toMatchObject({ onRoad: true, trackSource: 'alternates', crossProbes: 4 });
  });

  it('takes no track from a panorama under 4 m or over 45 m from the first', async () => {
    const first = pano('panoOne', at(-5, 0));
    const { probe } = world([first], (location, radius) => {
      if (radius !== 13) return undefined;
      if (crossPoint(first, 90, location)) {
        return pano('panoBeside', destinationPoint(first.location as LatLng, 90, 2));
      }
      if (crossPoint(first, 0, location)) {
        return pano('panoFar', destinationPoint(first.location as LatLng, 0, 50));
      }
      return undefined;
    });
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.road).toEqual({
      onRoad: false,
      trackBearingDeg: null,
      trackAgreement: null,
      trackSource: null,
      crossTrackM: null,
      crossProbes: 4,
    });
    expect(result.candidates.map(({ roadView }) => roadView)).toEqual([
      'around',
      'around',
      'around',
    ]);
  });

  it('takes no track from the lead panorama when a cross point answers it', async () => {
    // The probe radius is not a strict filter: a cross point 15 m away may answer the lead
    // panorama itself.
    const first = pano('panoOne', at(0, -5));
    const neighbour = pano('panoTwo', at(13, -5));
    const rule = (location: LatLng, radius: number) => {
      if (radius !== 13) return undefined;
      if (crossPoint(first, 180, location)) return first;
      if (crossPoint(first, 90, location)) return neighbour;
      return undefined;
    };
    for (const params of [
      DEFAULT_VIEWPOINT_PARAMETERS,
      { ...DEFAULT_VIEWPOINT_PARAMETERS, trackMinSeparationM: 0 },
    ]) {
      const { probe } = world([first], rule);
      const result = await discoverCandidates(probe, noGeometry(), { ...options, params });
      expect(result.road).toMatchObject({
        onRoad: true,
        trackSource: 'cross',
        crossTrackM: -5,
        crossProbes: 4,
      });
      expectNear(result.road?.trackBearingDeg, 90);
      expectNear(result.candidates[0]?.heading, 0);
    }
  });

  it('does not look around a panorama more than 12 m from the target', async () => {
    const { probe, calls } = world([pano('panoOne', at(-13, 0))]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(calls.some((call) => call.radius === 13)).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ headingMode: 'point', heading: 90 });
    expect(result.road).toEqual({
      onRoad: false,
      trackBearingDeg: null,
      trackAgreement: null,
      trackSource: null,
      crossTrackM: null,
      crossProbes: 0,
    });
  });

  it('offers three views 120 degrees apart when no second panorama is found', async () => {
    const lone = pano('panoOne', at(-3, 4));
    const toTarget = initialBearingDeg(lone.location as LatLng, TARGET);
    const near = pano('panoOne', at(-2, 0));
    for (const [panorama, base] of [
      [lone, toTarget],
      [near, 0],
    ] as const) {
      const { probe } = world([panorama]);
      const result = await discoverCandidates(probe, noGeometry(), options);
      expect(result.metadataCalls).toBe(9);
      expect(result.road).toEqual({
        onRoad: false,
        trackBearingDeg: null,
        trackAgreement: null,
        trackSource: null,
        crossTrackM: null,
        crossProbes: 4,
      });
      const headings = [0, 120, 240].map((turn) => Math.round(((base + turn) % 360) * 10) / 10);
      expect(views(result)).toEqual(
        headings.map((heading, index) => ({
          panoId: 'panoOne',
          heading,
          headingMode: 'road',
          pitch: 3.8,
          fov: 90,
          roadView: 'around',
          rank: index + 1,
        })),
      );
    }
  });

  it('stays within 30 metadata calls without building geometry', async () => {
    const west = pano('panoWest', destinationPoint(TARGET, 250, 10));
    const { probe, calls } = stubProbe(({ atTarget, bearing, radius }) => {
      if (atTarget) return answer('UNKNOWN_ERROR');
      if (radius < 200) return answer('ZERO_RESULTS');
      return bearing === 270 ? west : answer('UNKNOWN_ERROR');
    });
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.status).toBe('ok');
    // Six calls per radius step, eight for the alternates, four single probes around the primary.
    expect(result.metadataCalls).toBe(30);
    expect(calls).toHaveLength(30);
    expect(result.road?.crossProbes).toBe(4);
  });

  it('goes on without looking around when the time budget is spent after Step 2', async () => {
    let clock = 0;
    const lone = world([pano('panoOne', at(-5, 0))]);
    const probe: MetadataProbe = async (location, radius) => {
      clock += 1000;
      return lone.probe(location, radius);
    };
    const result = await discoverCandidates(probe, noGeometry(), {
      ...options,
      budgetMs: 4500,
      now: () => clock,
    });
    expect(result).toMatchObject({ status: 'ok', timedOut: false, metadataCalls: 5 });
    expect(result.road?.crossProbes).toBe(0);
    expect(result.candidates.map(({ roadView }) => roadView)).toEqual([
      'around',
      'around',
      'around',
    ]);
    expect(lone.calls).toHaveLength(5);
  });

  it('is not failed by a refusal at a cross point', async () => {
    const first = pano('panoOne', at(-5, 0));
    const { probe, calls } = world([first], (location, radius) => {
      if (radius !== 13) return undefined;
      if (crossPoint(first, 0, location)) return answer('OVER_QUERY_LIMIT');
      if (crossPoint(first, 90, location)) {
        return pano('panoTwo', destinationPoint(first.location as LatLng, 90, 13));
      }
      return undefined;
    });
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.status).toBe('ok');
    expect(result.road).toMatchObject({ onRoad: true, trackSource: 'cross', crossProbes: 4 });
    expect(result.candidates.map(({ roadView }) => roadView)).toEqual(['side', 'side', 'along']);
    expect(calls).toHaveLength(9);
  });

  it('looks around from the panorama that replaces a contributor primary', async () => {
    const contributor = { ...P1, copyright: '© GIS1 Street Imagery' };
    const { probe } = world([contributor, P2]);
    const result = await discoverCandidates(probe, noGeometry(), options);
    expect(result.candidates).toHaveLength(3);
    for (const candidate of result.candidates) {
      expect(candidate).toMatchObject({
        panoId: 'panoTwo',
        headingMode: 'road',
        distanceM: 8,
        isGoogleImagery: true,
        flags: [],
      });
    }
    // The contributor panorama is the only other one seen, and it gives no track.
    expect(result.road).toMatchObject({ onRoad: false, trackBearingDeg: null, crossProbes: 4 });
    expect(result.candidates.map(({ roadView }) => roadView)).toEqual([
      'around',
      'around',
      'around',
    ]);
  });
});
