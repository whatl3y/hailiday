import { describe, expect, it } from 'vitest';
import {
  googleUrlSignature,
  signFixtureStreetView,
  signGoogleUrl,
  signToken,
  verifyFixtureStreetView,
  verifyToken,
} from './signing.js';
import { buildStaticUrl } from './street-view/google.js';
import { buildFixtureDisplayUrl, verifyFixtureDisplayQuery } from './street-view/fixture.js';

describe('Google URL signing', () => {
  it('matches the published known vector', () => {
    expect(
      googleUrlSignature(
        '/maps/api/geocode/json?address=New+York&client=clientID',
        'vNIXE0xscrmjlyV-12Nj_BvUPaw=',
      ),
    ).toBe('chaRF2hTJKOScPr-RQCEhZbSzIE=');
  });

  it('appends the signature over the path and query', () => {
    const signed = signGoogleUrl(
      'https://maps.googleapis.com/maps/api/geocode/json?address=New+York&client=clientID',
      'vNIXE0xscrmjlyV-12Nj_BvUPaw=',
    );
    expect(signed).toBe(
      'https://maps.googleapis.com/maps/api/geocode/json?address=New+York&client=clientID&signature=chaRF2hTJKOScPr-RQCEhZbSzIE=',
    );
  });

  it('builds Static URLs by pano with explicit view parameters and no coordinates', () => {
    const url = new URL(
      buildStaticUrl(
        { panoId: 'abcDEF123', heading: 212.44, pitch: 4, fov: 75, width: 640, height: 640 },
        'browser-key',
        'vNIXE0xscrmjlyV-12Nj_BvUPaw=',
      ),
    );
    expect(url.pathname).toBe('/maps/api/streetview');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      size: '640x640',
      pano: 'abcDEF123',
      heading: '212.4',
      pitch: '4.0',
      fov: '75.0',
      return_error_code: 'true',
      key: 'browser-key',
    });
    expect(url.searchParams.has('location')).toBe(false);
    const unsigned = url.href.slice(0, url.href.indexOf('&signature='));
    const parsed = new URL(unsigned);
    expect(url.searchParams.get('signature')).toBe(
      googleUrlSignature(`${parsed.pathname}${parsed.search}`, 'vNIXE0xscrmjlyV-12Nj_BvUPaw='),
    );
  });
});

describe('fixture display URLs', () => {
  const secret = 'test-session-secret-0123456789-abcdefghij';
  const view = {
    panoId: 'fxSvLanternHillC01p1Sv',
    heading: 0,
    fov: 72.2,
    pitch: 4.8,
    width: 640,
    height: 640,
  };

  it('round-trips and rejects tampering', () => {
    const url = new URL(buildFixtureDisplayUrl('http://localhost:8080', secret, view));
    expect(url.pathname).toBe('/fixture/streetview');
    const query = Object.fromEntries(url.searchParams);
    expect(verifyFixtureDisplayQuery(secret, query)).toMatchObject({
      panoId: view.panoId,
      fov: 72.2,
    });
    expect(verifyFixtureDisplayQuery(secret, { ...query, heading: '15.0' })).toBeNull();
    expect(verifyFixtureDisplayQuery('another-secret-0123456789-abcdefghijk', query)).toBeNull();
  });

  it('signs a canonical parameter set', () => {
    const params = { pano: 'p', heading: '1.0', fov: '90.0', pitch: '0.0', size: '640x640' };
    const sig = signFixtureStreetView(secret, params);
    expect(verifyFixtureStreetView(secret, { ...params, sig })).toBe(true);
    expect(verifyFixtureStreetView(secret, { ...params, size: '320x320', sig })).toBe(false);
  });
});

describe('session-bound tokens', () => {
  const secret = 'token-secret-0123456789-abcdefghijklmn';
  const now = new Date('2026-11-09T12:00:00Z');
  const token = signToken(
    secret,
    'geocode-candidate',
    { placeId: 'x' },
    { sessionId: 's1', expiresAt: new Date(now.getTime() + 600_000) },
  );

  it('verifies for the same session before expiry', () => {
    expect(verifyToken(secret, 'geocode-candidate', token, { sessionId: 's1', now })).toEqual({
      placeId: 'x',
    });
  });

  it('rejects another session, expiry, another purpose and tampering', () => {
    expect(verifyToken(secret, 'geocode-candidate', token, { sessionId: 's2', now })).toBeNull();
    expect(
      verifyToken(secret, 'geocode-candidate', token, {
        sessionId: 's1',
        now: new Date(now.getTime() + 700_000),
      }),
    ).toBeNull();
    expect(verifyToken(secret, 'other', token, { sessionId: 's1', now })).toBeNull();
    expect(
      verifyToken(secret, 'geocode-candidate', `${token}x`, { sessionId: 's1', now }),
    ).toBeNull();
  });
});
