import { describe, expect, it } from 'vitest';
import {
  destinationPoint,
  estimatedFacadePx,
  haversineDistanceM,
  initialBearingDeg,
  viewFovDeg,
  viewPitchDeg,
} from './geo.js';
import {
  captureAgeYears,
  captureGranularityOf,
  copyrightClassOf,
  DISCOVERY_ALGORITHM_VERSION,
  decideMatch,
  type MatchInputs,
} from './match.js';

describe('discovery algorithm version', () => {
  it('is 2, the version whose Step 1 probes fallback points around an erroring target', () => {
    expect(DISCOVERY_ALGORITHM_VERSION).toBe('2');
  });
});

describe('geometry', () => {
  it('computes initial great-circle bearings', () => {
    expect(
      initialBearingDeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }),
    ).toBeCloseTo(90, 6);
    expect(
      initialBearingDeg({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 }),
    ).toBeCloseTo(0, 6);
    expect(
      initialBearingDeg({ latitude: 0, longitude: 0 }, { latitude: -1, longitude: 0 }),
    ).toBeCloseTo(180, 6);
    expect(
      initialBearingDeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: -1 }),
    ).toBeCloseTo(270, 6);
    // A known pair: the initial bearing from 50°N 5°W to 58°N 3°W is about 9.12°.
    expect(
      initialBearingDeg(
        { latitude: 50.0664, longitude: -5.7147 },
        { latitude: 58.6439, longitude: -3.07 },
      ),
    ).toBeCloseTo(9.12, 1);
  });

  it('round-trips destination points and haversine distances', () => {
    const origin = { latitude: 43.0612, longitude: -72.9351 };
    const moved = destinationPoint(origin, 90, 15);
    expect(haversineDistanceM(origin, moved)).toBeCloseTo(15, 3);
    expect(initialBearingDeg(origin, moved)).toBeCloseTo(90, 2);
  });

  it('clamps fov to 60–90 and pitch to 0–10', () => {
    // Without a building outline the facade is taken as 12 m wide.
    expect(viewFovDeg(null, 12)).toBeCloseTo(67.4, 1);
    expect(viewFovDeg(null, 25)).toBe(60);
    expect(viewFovDeg(null, 6)).toBe(90);
    expect(viewFovDeg(0, 12)).toBe(viewFovDeg(null, 12));
    expect(viewFovDeg(13.5, 12)).toBeCloseTo(72.2, 1);
    expect(viewFovDeg(4, 60)).toBe(60);
    expect(viewFovDeg(40, 5)).toBe(90);
    expect(viewPitchDeg(12)).toBeCloseTo(4.76, 2);
    expect(viewPitchDeg(1)).toBe(10);
    expect(estimatedFacadePx(13.5, 12, 72.2)).toBeGreaterThan(450);
    expect(estimatedFacadePx(null, 12, 90)).toBeNull();
  });
});

const NOW = new Date('2026-11-09T12:00:00Z');
const green: MatchInputs = {
  countryCode: 'US',
  blockedAddress: false,
  multiUnit: false,
  precision: 'rooftop_equivalent',
  partialMatch: false,
  structureType: 'BUILDING',
  discoveryStatus: 'ok',
  probeRadiusM: 50,
  primaryDistanceM: 12,
  headingMode: 'geometry',
  facadeWidthM: 13.5,
  attachedFacade: false,
  captureDate: '2025-09',
  captureGranularity: 'month',
  copyrightClass: 'google',
  entryMethod: 'autocomplete',
  sourceMode: 'transient',
  now: NOW,
};

describe('match class decisions', () => {
  it('auto-starts only when every signal is green', () => {
    expect(decideMatch(green)).toMatchObject({ matchClass: 'auto_start', reason: null, amber: [] });
  });

  it.each([
    ['interpolated precision', { precision: 'interpolated' as const }, 'precision'],
    ['partial match', { partialMatch: true }, 'precision'],
    ['grounds structure', { structureType: 'GROUNDS' }, 'precision'],
    ['deep setback', { probeRadiusM: 100 }, 'panoramaAvailability'],
    ['distance 25–60 m', { primaryDistanceM: 41 }, 'panoramaDistance'],
    ['point heading', { headingMode: 'point' as const }, 'headingBasis'],
    ['narrow facade', { facadeWidthM: 5.5 }, 'facadeWidth'],
    ['attached facade', { attachedFacade: true }, 'facadeWidth'],
    ['old capture', { captureDate: '2018-06' }, 'captureAge'],
    ['undated capture', { captureDate: null, captureGranularity: 'none' as const }, 'captureAge'],
    ['contributor imagery', { copyrightClass: 'contributor' as const }, 'copyright'],
    ['manual entry', { entryMethod: 'manual' as const }, 'entryMethod'],
    ['display only', { sourceMode: 'display_only' as const }, 'sourceMode'],
  ])('confirms on amber: %s', (_label, change, signal) => {
    const decision = decideMatch({ ...green, ...change });
    expect(decision.matchClass).toBe('confirm');
    expect(decision.amber).toContain(signal);
  });

  it('never auto-starts contributor imagery, whatever mode it may be decorated in', () => {
    for (const sourceMode of ['persist', 'transient'] as const) {
      const decision = decideMatch({ ...green, sourceMode, copyrightClass: 'contributor' });
      expect(decision.matchClass).toBe('confirm');
      expect(decision.amber).toEqual(['copyright']);
      expect(decideMatch({ ...green, sourceMode }).matchClass).toBe('auto_start');
    }
  });

  it('skips to upload with the first red reason by precedence', () => {
    expect(decideMatch({ ...green, multiUnit: true, blockedAddress: true }).reason).toBe(
      'blocked_address',
    );
    expect(decideMatch({ ...green, countryCode: 'CA', multiUnit: true }).reason).toBe(
      'out_of_scope',
    );
    expect(decideMatch({ ...green, precision: 'low' }).reason).toBe('low_precision');
    expect(
      decideMatch({
        ...green,
        discoveryStatus: 'no_imagery',
        probeRadiusM: null,
        primaryDistanceM: null,
      }).reason,
    ).toBe('no_imagery');
    expect(decideMatch({ ...green, primaryDistanceM: 75 }).reason).toBe('no_imagery');
    const error = decideMatch({
      ...green,
      discoveryStatus: 'error',
      probeRadiusM: null,
      primaryDistanceM: null,
    });
    expect(error).toMatchObject({ matchClass: 'skip_to_upload', reason: 'error', retryable: true });
    expect(decideMatch({ ...green, sourceMode: 'unavailable' }).reason).toBe('no_imagery');
  });

  it('reports auto_start as confirm while auto-start is paused', () => {
    expect(decideMatch({ ...green, autostartPaused: true })).toMatchObject({
      matchClass: 'confirm',
      autostartPaused: true,
    });
  });

  it('classifies copyright, granularity and capture age', () => {
    expect(copyrightClassOf('© 2025 Google')).toBe('google');
    expect(copyrightClassOf('© Desert Lens Collective')).toBe('contributor');
    expect(copyrightClassOf(null)).toBe('unknown');
    expect(captureGranularityOf('2024-06')).toBe('month');
    expect(captureGranularityOf('2024')).toBe('year');
    expect(captureGranularityOf(undefined)).toBe('none');
    expect(captureAgeYears('2021-11', NOW)).toBeCloseTo(5, 1);
  });
});
