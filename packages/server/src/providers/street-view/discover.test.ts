import { describe, expect, it } from 'vitest';
import { destinationPoint, haversineDistanceM, type LatLng } from '../geo.js';
import type { DiscoveryInput, MetadataStatus, StreetViewMetadata } from '../types.js';
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

  it('stays within 26 metadata calls in the worst case', async () => {
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
