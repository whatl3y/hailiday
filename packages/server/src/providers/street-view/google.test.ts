import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../logger/index.js';
import type { FetchLike } from '../http.js';
import { createGoogleStreetViewProvider } from './google.js';

const SERVER_KEY = 'AIzaSyServerKeyForTests-0123456789abc';
const BROWSER_KEY = 'AIzaSyBrowserKeyForTests-0123456789ab';
const SIGNING_SECRET = 'c2lnbmluZy1zZWNyZXQtZm9yLXRlc3Rz';
const LOCATION = { latitude: 37.776074, longitude: -122.432727 };

/** Captures the JSON lines of a real logger created without configured secrets. */
function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ level: 'info', destination });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, logger, parsed };
}

function adapter(reply: () => Response | Promise<Response>) {
  const log = capture();
  const fetch = vi.fn<FetchLike>(async () => reply());
  const provider = createGoogleStreetViewProvider({
    serverKey: SERVER_KEY,
    browserKey: BROWSER_KEY,
    signingSecret: SIGNING_SECRET,
    fetch,
    logger: log.logger,
  });
  return { provider, fetch, ...log };
}

const json = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Recorded 200 bodies whose JSON status is an error. */
const RECORDED: { status: string; body: Record<string, unknown>; message?: string }[] = [
  {
    status: 'REQUEST_DENIED',
    body: {
      status: 'REQUEST_DENIED',
      error_message: `The provided API key is invalid. key=${SERVER_KEY}`,
    },
    message: 'The provided API key is invalid. key=[redacted]',
  },
  {
    status: 'OVER_QUERY_LIMIT',
    body: {
      status: 'OVER_QUERY_LIMIT',
      error_message: `You have exceeded your daily request quota for this API. (${BROWSER_KEY})`,
    },
    message: 'You have exceeded your daily request quota for this API. ([redacted])',
  },
  {
    status: 'INVALID_REQUEST',
    body: {
      status: 'INVALID_REQUEST',
      error_message: `Invalid request. Invalid 'signature' parameter: ${SIGNING_SECRET}`,
    },
    message: "Invalid request. Invalid 'signature' parameter: [redacted]",
  },
  { status: 'UNKNOWN_ERROR', body: { status: 'UNKNOWN_ERROR' } },
];

describe('Google Street View metadata diagnostics', () => {
  for (const recorded of RECORDED) {
    it(`logs a 200 ${recorded.status} once at warn with the redacted error_message`, async () => {
      const { provider, lines, parsed } = adapter(() => json(recorded.body));
      const metadata = await provider.metadataByLocation({ location: LOCATION, radiusM: 50 });
      expect(metadata).toEqual({
        status: recorded.status,
        panoId: null,
        location: null,
        date: null,
        copyright: null,
      });
      expect(parsed()).toHaveLength(1);
      expect(parsed()[0]).toMatchObject({
        level: 'warn',
        msg: 'provider call failed',
        provider: 'google-street-view',
        operation: 'Street View metadata',
        httpStatus: 200,
        providerCode: recorded.status,
      });
      if (recorded.message) expect(parsed()[0]?.providerMessage).toBe(recorded.message);
      else expect(parsed()[0]).not.toHaveProperty('providerMessage');
      const output = lines.join('');
      for (const secret of [SERVER_KEY, BROWSER_KEY, SIGNING_SECRET, 'AIza']) {
        expect(output).not.toContain(secret);
      }
      expect(output).not.toContain('37.776');
    });
  }

  it('logs an unrecognized status under its own name and returns UNKNOWN_ERROR', async () => {
    const { provider, parsed } = adapter(() => json({ status: 'SOMETHING_NEW' }));
    const metadata = await provider.metadataByPano('CAoSLEFGMVFpcE1waW5uZWQ');
    expect(metadata.status).toBe('UNKNOWN_ERROR');
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({ providerCode: 'SOMETHING_NEW', httpStatus: 200 });
  });

  it('treats a 200 body that is not JSON as UNKNOWN_ERROR and logs it', async () => {
    const { provider, parsed } = adapter(() => json('<html>Server Error</html>'));
    const metadata = await provider.metadataByLocation({ location: LOCATION, radiusM: 50 });
    expect(metadata.status).toBe('UNKNOWN_ERROR');
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({
      providerCode: 'UNKNOWN_ERROR',
      providerMessage: 'Server Error',
    });
  });

  it('logs a network failure once without any request detail', async () => {
    const { provider, lines, parsed } = adapter(() => {
      throw new TypeError(`fetch failed for key=${SERVER_KEY}`);
    });
    const metadata = await provider.metadataByLocation({ location: LOCATION, radiusM: 50 });
    expect(metadata.status).toBe('UNKNOWN_ERROR');
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({
      operation: 'Street View metadata',
      failureKind: 'provider_error',
    });
    expect(lines.join('')).not.toContain(SERVER_KEY);
  });

  it('does not log an OK or ZERO_RESULTS answer', async () => {
    for (const body of [
      {
        status: 'OK',
        pano_id: 'CAoSLEFGMVFpcE1waW5uZWQ',
        location: { lat: 37.7761, lng: -122.4327 },
        date: '2025-06',
        copyright: '© Google',
      },
      { status: 'ZERO_RESULTS' },
    ]) {
      const { provider, lines } = adapter(() => json(body));
      const metadata = await provider.metadataByLocation({ location: LOCATION, radiusM: 50 });
      expect(metadata.status).toBe(body.status);
      expect(lines).toEqual([]);
    }
  });

  it('discovery with a persistent UNKNOWN_ERROR at the target finds a panorama along the road', async () => {
    const north = { lat: 37.7761819, lng: -122.432727 };
    const { provider, fetch, parsed } = adapter(() => json({ status: 'UNKNOWN_ERROR' }));
    fetch.mockImplementation(async (url) => {
      const [lat] = (new URL(url).searchParams.get('location') ?? '').split(',').map(Number);
      if (lat !== undefined && lat > LOCATION.latitude + 1e-5) {
        return json({
          status: 'OK',
          pano_id: 'CAoSLEFGMVFpcE5vcnRoUGFubw',
          location: north,
          date: '2025-06',
          copyright: '© Google',
        });
      }
      return json({ status: 'UNKNOWN_ERROR' });
    });
    const result = await provider.discoverCandidates(
      {
        target: LOCATION,
        geometryAvailable: true,
        facadeWidthM: 8,
        roadBearingDeg: 0,
        facadeNormalDeg: 270,
        attachedFacade: false,
      },
      { budgetMs: 6000 },
    );
    expect(result.status).toBe('ok');
    expect(result.candidates[0]).toMatchObject({
      panoId: 'CAoSLEFGMVFpcE5vcnRoUGFubw',
      probe: 'offset_+15m',
    });
    // Every UNKNOWN_ERROR answer was logged, one line each.
    const failed = parsed().filter((line) => line.providerCode === 'UNKNOWN_ERROR');
    expect(failed.length).toBe(result.metadataCalls - 2);
  }, 10_000);
});
