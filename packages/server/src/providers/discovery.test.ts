import { describe, expect, it } from 'vitest';
import { testConfig } from '../config/index.js';
import { loadFixtureData } from '../fixtures/data.js';
import { derivePropertySignals } from './address/signals.js';
import { createProviders } from './create.js';
import { copyrightClassOf, decideMatch } from './match.js';
import { createFixtureStreetViewProvider } from './street-view/fixture.js';

const config = testConfig();
const providers = createProviders(config);
const streetView = createFixtureStreetViewProvider({
  publicBaseUrl: config.publicBaseUrl,
  sessionSecret: config.sessionSecret,
  retryDelayMs: 0,
});
const data = loadFixtureData();
const NOW = new Date('2026-11-09T12:00:00Z');

/** Runs the address path of one fixture place the way the API will (autocomplete entry). */
async function discover(placeId: string) {
  const place = data.placeById(placeId);
  if (!place) throw new Error(placeId);
  const resolved = await providers.address.resolve({
    placeId,
    sessionToken: '6c1f0d68-6a48-4f33-9c6d-8a64c4e5b0a1',
  });
  const geocode = await providers.address.geocodeByPlaceId(placeId);
  const destinations = await providers.address.searchDestinations(placeId);
  const signals = derivePropertySignals({
    resolved,
    geocode,
    destinations,
    entryMethod: 'autocomplete',
  });
  const discovery = await streetView.discoverCandidates({
    target: signals.targetPoint,
    geometryAvailable: signals.geometryAvailable,
    facadeWidthM: signals.facadeWidthM,
    roadBearingDeg: signals.roadBearingDeg,
    facadeNormalDeg: signals.facadeNormalDeg,
    attachedFacade: signals.attachedFacade,
  });
  const primary = discovery.candidates[0] ?? null;
  const copyrightClass = primary ? copyrightClassOf(primary.copyright) : null;
  const decision = decideMatch({
    countryCode: signals.countryCode,
    blockedAddress: place.blocked,
    multiUnit: signals.multiUnit,
    precision: signals.precision,
    partialMatch: signals.partialMatch,
    structureType: signals.structureType,
    discoveryStatus: discovery.status,
    probeRadiusM: discovery.probeRadiusM,
    primaryDistanceM: primary?.distanceM ?? null,
    headingMode: primary?.headingMode ?? null,
    facadeWidthM: signals.facadeWidthM,
    attachedFacade: signals.attachedFacade,
    captureDate: primary?.captureDate ?? null,
    captureGranularity: primary?.captureGranularity ?? null,
    copyrightClass,
    entryMethod: 'autocomplete',
    // Contributor imagery is display-only by default.
    sourceMode:
      discovery.status === 'ok'
        ? copyrightClass === 'google'
          ? 'transient'
          : 'display_only'
        : 'unavailable',
    now: NOW,
  });
  return { place, signals, discovery, decision };
}

describe('fixture discovery reproduces every place scenario', () => {
  for (const place of data.places) {
    it(`${place.placeId}: ${place.scenario.match}${place.scenario.reason ? ` (${place.scenario.reason})` : ''}`, async () => {
      const { decision, discovery } = await discover(place.placeId);
      expect(decision.matchClass).toBe(place.scenario.match);
      expect(decision.reason).toBe(place.scenario.reason);
      if (place.scenario.match !== 'skip_to_upload') {
        expect(discovery.candidates.length).toBeGreaterThan(0);
        expect(discovery.candidates.length).toBeLessThanOrEqual(3);
        const primary = discovery.candidates[0];
        const pano = place.panoramas.find((candidate) => candidate.panoId === primary?.panoId);
        expect(pano).toBeDefined();
        expect(Math.abs((primary?.heading ?? 0) - (pano?.headingDeg ?? 0)) % 360).toBeLessThan(0.6);
        expect(primary?.fov).toBeGreaterThanOrEqual(60);
        expect(primary?.fov).toBeLessThanOrEqual(90);
        expect(primary?.pitch).toBeGreaterThanOrEqual(0);
        expect(primary?.pitch).toBeLessThanOrEqual(10);
        expect(new Set(discovery.candidates.map((c) => c.panoId)).size).toBe(
          discovery.candidates.length,
        );
      }
    });
  }

  it('finds three deduplicated candidates for the interpolated confirm place', async () => {
    const { discovery } = await discover('ChIJfxDriftwoodCoveCapeXX15');
    expect(discovery.candidates.map((c) => c.panoId)).toEqual([
      'fxSvDriftwoodCov15p1Sv',
      'fxSvDriftwoodCov15p2Sv',
      'fxSvDriftwoodCov15p3Sv',
    ]);
    expect(discovery.candidates[0]?.isPrimary).toBe(true);
  });

  it('records deep setback and contributor flags', async () => {
    expect((await discover('ChIJfxOldQuarryRoadColoni19')).discovery).toMatchObject({
      deepSetback: true,
      probeRadiusM: 100,
    });
    const pinon = await discover('ChIJfxPinonMesaAdobeXXXXX17');
    expect(pinon.discovery.candidates[0]?.flags).toContain('contributorImagery');
    expect(pinon.discovery.candidates.some((c) => c.flags.includes('undated'))).toBe(true);
  });

  it('manual entry is capped at confirm and candidates are signed for the session', async () => {
    const candidates = await providers.address.geocode(
      { line1: '14 Lantern Hill Rd', city: 'Maplebrook', state: 'VT', postalCode: '05341' },
      { sessionId: 'session-1', now: NOW },
    );
    expect(candidates).toHaveLength(1);
    const token = candidates[0]?.candidate.candidateId ?? '';
    expect(
      providers.address.verifyCandidate(token, { sessionId: 'session-1', now: NOW })?.placeId,
    ).toBe('ChIJfxLanternHillColonial01');
    expect(
      providers.address.verifyCandidate(token, { sessionId: 'session-2', now: NOW }),
    ).toBeNull();
    const partial = await providers.address.geocode(
      { line1: '14 Lantern Hill Road', city: 'Elsewhere', state: 'VT', postalCode: '05341' },
      { sessionId: 'session-1', now: NOW },
    );
    expect(partial[0]?.candidate.partialMatch).toBe(true);
    expect(
      await providers.address.geocode(
        { line1: '1 Nowhere St', city: 'X', state: 'VT', postalCode: '05341' },
        { sessionId: 's', now: NOW },
      ),
    ).toEqual([]);
  });

  it('suggests only after three characters and mints a session token', async () => {
    const short = await providers.address.suggest({ query: 'La' });
    expect(short).toMatchObject({ called: false, suggestions: [] });
    const result = await providers.address.suggest({ query: 'lantern hill' });
    expect(result.sessionToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.suggestions[0]?.placeId).toBe('ChIJfxLanternHillColonial01');
    expect((await providers.address.suggest({ query: 'Thornbury' })).suggestions).toHaveLength(1);
  });
});
