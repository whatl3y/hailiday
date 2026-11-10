import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../config/index.js';
import { loadFixtureData } from '../../fixtures/data.js';
import type { FetchLike } from '../http.js';
import { createFixtureStreetViewProvider, FIXTURE_METADATA_ERROR_PANO_PREFIX } from './fixture.js';
import { DEFAULT_VIEWPOINT_PARAMETERS } from '../geo.js';
import { createGoogleStreetViewProvider } from './google.js';
import { REFRESH_TARGET_POINT_RADIUS_M } from './refresh.js';

const PINNED = 'CAoSLEFGMVFpcE1waW5uZWQ';
const NEWER = 'CAoSLEFGMVFpcE5ld2VyUGFubw';
const LOCATION = { latitude: 40.7128001, longitude: -74.0060001 };

const okBody = (panoId: string) => ({
  copyright: '© Google',
  date: '2025-06',
  location: { lat: 40.7128, lng: -74.006 },
  pano_id: panoId,
  status: 'OK',
});

type Reply = { status: number; body: unknown } | Error;

/** A Google adapter over recorded metadata replies: one for the pano query, one for location. */
function adapter(byPano: Reply, byLocation?: Reply) {
  const urls: string[] = [];
  const respond = (reply: Reply) => {
    if (reply instanceof Error) throw reply;
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const fetch = vi.fn<FetchLike>(async (url) => {
    urls.push(url);
    const query = new URL(url).searchParams;
    if (query.has('pano')) return respond(byPano);
    if (!byLocation) throw new Error('unexpected location probe');
    return respond(byLocation);
  });
  const provider = createGoogleStreetViewProvider({
    serverKey: 'server-key-123456',
    browserKey: 'browser-key-123456',
    signingSecret: 'c2lnbmluZy1zZWNyZXQ=',
    fetch,
  });
  return { provider, urls, fetch };
}

describe('Google refreshPanorama', () => {
  it('is unchanged when metadata still serves the pinned pano', async () => {
    const { provider } = adapter({ status: 200, body: okBody(PINNED) });
    const result = await provider.refreshPanorama(PINNED, { location: LOCATION });
    expect(result.status).toBe('unchanged');
    expect(result.metadata.panoId).toBe(PINNED);
  });

  it('is an error, never missing, for quota, denied, invalid, unknown, non-200 and network failures', async () => {
    const replies: Reply[] = [
      { status: 200, body: { status: 'OVER_QUERY_LIMIT', error_message: 'quota' } },
      { status: 200, body: { status: 'REQUEST_DENIED', error_message: 'denied' } },
      { status: 200, body: { status: 'INVALID_REQUEST' } },
      { status: 200, body: { status: 'UNKNOWN_ERROR' } },
      { status: 200, body: { status: 'SOMETHING_NEW' } },
      { status: 429, body: { error_message: 'Too many requests' } },
      { status: 403, body: { error_message: 'The provided API key is invalid.' } },
      { status: 500, body: 'Internal error' },
      new TypeError('fetch failed'),
    ];
    for (const reply of replies) {
      const { provider, fetch } = adapter(reply);
      const result = await provider.refreshPanorama(PINNED, { location: LOCATION });
      expect(result.status).toBe('error');
      // No location probe is made after a failed pano query.
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('is missing for ZERO_RESULTS or NOT_FOUND when no location is known', async () => {
    for (const status of ['ZERO_RESULTS', 'NOT_FOUND']) {
      const { provider, fetch } = adapter({ status: 200, body: { status } });
      const result = await provider.refreshPanorama(PINNED);
      expect(result.status).toBe('missing');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('is replaced when the pinned pano is gone and the location answers with another pano', async () => {
    const { provider, urls } = adapter(
      { status: 200, body: { status: 'ZERO_RESULTS' } },
      { status: 200, body: okBody(NEWER) },
    );
    const result = await provider.refreshPanorama(PINNED, { location: LOCATION });
    expect(result.status).toBe('replaced');
    expect(result.metadata.panoId).toBe(NEWER);
    const probe = new URL(urls[1] ?? '').searchParams;
    expect(probe.get('location')).toBe('40.7128001,-74.0060001');
    expect(probe.get('radius')).toBe('15');
    expect(probe.get('source')).toBe('outdoor');
  });

  it('uses a wider probe radius when asked', async () => {
    const { provider, urls } = adapter(
      { status: 200, body: { status: 'NOT_FOUND' } },
      { status: 200, body: okBody(NEWER) },
    );
    await provider.refreshPanorama(PINNED, { location: LOCATION, locationRadiusM: 50 });
    expect(new URL(urls[1] ?? '').searchParams.get('radius')).toBe('50');
  });

  it('is missing when the pinned pano is gone and the location has no imagery', async () => {
    const { provider } = adapter(
      { status: 200, body: { status: 'NOT_FOUND' } },
      { status: 200, body: { status: 'ZERO_RESULTS' } },
    );
    const result = await provider.refreshPanorama(PINNED, { location: LOCATION });
    expect(result.status).toBe('missing');
    expect(result.metadata.status).toBe('NOT_FOUND');
  });

  it('is an error when the location probe fails or still answers with the pinned pano', async () => {
    for (const probe of [
      { status: 200, body: { status: 'OVER_QUERY_LIMIT' } },
      { status: 503, body: 'unavailable' },
      new TypeError('fetch failed'),
      { status: 200, body: okBody(PINNED) },
    ] as Reply[]) {
      const { provider } = adapter({ status: 200, body: { status: 'ZERO_RESULTS' } }, probe);
      expect((await provider.refreshPanorama(PINNED, { location: LOCATION })).status).toBe('error');
    }
  });
});

describe('fixture refreshPanorama', () => {
  const config = testConfig();
  const streetView = createFixtureStreetViewProvider({
    publicBaseUrl: config.publicBaseUrl,
    sessionSecret: config.sessionSecret,
  });
  const place = loadFixtureData().places.find((candidate) => candidate.panoramas.length > 0);
  if (!place) throw new Error('no fixture place with imagery');
  const panorama = place.panoramas[0];
  if (!panorama) throw new Error('no fixture panorama');
  const target = place.destinations.targetPoint ?? place.location;

  it('is unchanged for a known pano', async () => {
    expect((await streetView.refreshPanorama(panorama.panoId)).status).toBe('unchanged');
  });

  it('is an error for the metadata-error pano prefix', async () => {
    const result = await streetView.refreshPanorama(`${FIXTURE_METADATA_ERROR_PANO_PREFIX}01`, {
      location: target,
    });
    expect(result.status).toBe('error');
    expect(result.metadata.status).toBe('UNKNOWN_ERROR');
  });

  it('is replaced for a retired pano at a place that still has imagery', async () => {
    const result = await streetView.refreshPanorama('fxSvRetiredPano', {
      location: target,
      locationRadiusM: 200,
    });
    expect(result.status).toBe('replaced');
    expect(result.metadata.panoId).not.toBe('fxSvRetiredPano');
  });

  it('finds the newer pano from the target point at the target-point probe radius', async () => {
    expect(REFRESH_TARGET_POINT_RADIUS_M).toBeGreaterThan(
      DEFAULT_VIEWPOINT_PARAMETERS.radiusLadderM[0] ?? Infinity,
    );
    let probed = 0;
    for (const candidate of loadFixtureData().places) {
      const atTarget = candidate.panoramas.find((p) => p.probe === 'target');
      if (candidate.metadataStatus !== 'OK' || !atTarget) continue;
      // A deep-setback place's panorama lies beyond the probe (discovery found it at 100 m).
      if (atTarget.probeRadiusM > DEFAULT_VIEWPOINT_PARAMETERS.radiusLadderM[0]!) continue;
      probed += 1;
      const result = await streetView.refreshPanorama('fxSvRetiredPano', {
        location: candidate.destinations.targetPoint ?? candidate.location,
        locationRadiusM: REFRESH_TARGET_POINT_RADIUS_M,
      });
      expect(result.status, candidate.placeId).toBe('replaced');
    }
    expect(probed).toBeGreaterThan(10);
  });

  it('is missing for a retired pano with no location or no imagery there', async () => {
    expect((await streetView.refreshPanorama('fxSvRetiredPano')).status).toBe('missing');
    const far = { latitude: 10, longitude: 10 };
    expect((await streetView.refreshPanorama('fxSvRetiredPano', { location: far })).status).toBe(
      'missing',
    );
  });
});
