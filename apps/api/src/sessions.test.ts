import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorBodySchema, ExperienceSchema } from '@holiday/core';
import { createLogger } from '@holiday/server/logger';
import { buildFixtureDisplayUrl } from '@holiday/server/providers';
import { createHarness, json, type Harness } from './test/harness.js';

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Holiday</title>
    <!--holiday:head-->
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body>
    <div id="ssr-hero" class="ssr-hero"><!--holiday:hero--></div>
    <div id="root"></div>
    <!--holiday:experience-->
  </body>
</html>
`;

const logLines: string[] = [];
let harness: Harness;
let distDir: string;

beforeAll(async () => {
  distDir = mkdtempSync(path.join(tmpdir(), 'holiday-web-'));
  writeFileSync(path.join(distDir, 'index.html'), TEMPLATE);
  mkdirSync(path.join(distDir, 'assets'));
  writeFileSync(path.join(distDir, 'assets', 'index-abc123.js'), 'console.log(1);');
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      logLines.push(String(chunk));
      callback();
    },
  });
  harness = await createHarness({
    webDistDir: distDir,
    logger: createLogger({ level: 'info', destination }),
  });
});

afterAll(async () => {
  await harness?.close();
  rmSync(distDir, { recursive: true, force: true });
});

describe('sessions and Turnstile', () => {
  it('requires a Turnstile token and sets an HttpOnly, SameSite=Lax session cookie', async () => {
    const client = harness.client();
    const refused = await client.post('/v1/sessions', { turnstileToken: 'fixture-fail' });
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });
    expect(ErrorBodySchema.safeParse(json(refused)).success).toBe(true);
    expect(refused.headers['x-request-id']).toBeTruthy();

    const created = await client.post('/v1/sessions', {
      turnstileToken: 'fixture-pass',
      timezone: 'America/Chicago',
    });
    expect(created.statusCode).toBe(201);
    const cookie = created.cookies.find((entry) => entry.name === 'holiday_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe('lax');
    expect(created.headers['cache-control']).toBe('no-store');
    const { expiresAt } = json<{ expiresAt: string }>(created);

    const again = await client.post('/v1/sessions', { turnstileToken: 'anything' });
    expect(again.statusCode).toBe(201);
    expect(json<{ expiresAt: string }>(again).expiresAt).toBe(expiresAt);
    expect(again.cookies.find((entry) => entry.name === 'holiday_session')).toBeUndefined();
  });

  it('refuses session-level endpoints without a session and state changes from other origins', async () => {
    const client = harness.client();
    const anonymous = await client.get('/v1/experience');
    expect(anonymous.statusCode).toBe(403);
    expect(json(anonymous).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });

    const viaHeader = await client.get('/v1/me', { 'x-turnstile-token': 'fixture-pass' });
    expect(viaHeader.statusCode).toBe(200);
    expect(client.cookie).toBeTruthy();

    const crossSite = await client.request({
      method: 'POST',
      url: '/v1/projects',
      payload: { kind: 'upload' },
      headers: { origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(json(crossSite).error).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'origin_mismatch' },
    });

    const noOrigin = await client.request({
      method: 'POST',
      url: '/v1/projects',
      payload: { kind: 'upload' },
      noOrigin: true,
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('validates bodies against the core schemas', async () => {
    const client = harness.client();
    await client.createSession();
    const response = await client.post('/v1/projects', { kind: 'upload', extra: true });
    expect(response.statusCode).toBe(400);
    expect(json(response).error).toMatchObject({ code: 'VALIDATION_FAILED' });
    const missing = await client.get('/v1/projects/0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e');
    expect(missing.statusCode).toBe(404);
    expect(json(missing).error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('experience', () => {
  it('returns the default holiday, picker, calendar, hero, allowance and client configuration', async () => {
    const client = harness.client();
    await client.createSession();
    const response = await client.get('/v1/experience?holiday=christmas');
    expect(response.statusCode).toBe(200);
    const experience = ExperienceSchema.parse(response.json());
    expect(experience.requestedHolidayId).toBe('christmas');
    expect(experience.holidays.length).toBeGreaterThanOrEqual(3);
    expect(experience.holidays.map((holiday) => holiday.id)).toContain('christmas');
    if (experience.defaultHolidayId) {
      expect(experience.holidays[0]?.id).toBe(experience.defaultHolidayId);
      expect(experience.holidays[0]?.isDefault).toBe(true);
    }
    const christmas = experience.holidays.find((holiday) => holiday.id === 'christmas');
    expect(christmas?.sceneTypes.house_exterior?.styles).toEqual(['subtle', 'classic', 'abundant']);
    expect(experience.calendar.length).toBeGreaterThan(0);
    expect(experience.hero?.renditions.landscape.length).toBeGreaterThan(0);
    expect(experience.allowance.variants).toMatchObject({ limit: 3, remaining: 3 });
    expect(experience.capabilities.addressLookup).toBe(true);
    expect(experience.clientConfig.uploadAcceptedTypes).toContain('image/jpeg');
    expect(experience.fixtureCapabilities).toEqual(
      expect.arrayContaining(['image_editing', 'street_view_display']),
    );
    const fixtureRows = await harness.context.db
      .selectFrom('countryCapabilities')
      .select('capability')
      .where('countryCode', '=', 'US')
      .where('state', '=', 'fixture')
      .execute();
    const fixtureKeys = fixtureRows.map((row) => row.capability);
    for (const key of experience.fixtureCapabilities ?? []) expect(fixtureKeys).toContain(key);

    const me = await client.get('/v1/me');
    expect(json(me)).toMatchObject({ user: null, savedProjects: 0 });
  });

  it('ingests client analytics and drops server-only or invalid events', async () => {
    const client = harness.client();
    await client.createSession();
    const response = await client.post('/v1/analytics', {
      events: [
        {
          name: 'compare_used',
          occurredAt: new Date().toISOString(),
          properties: { mode: 'slider' },
        },
        { name: 'render_requested', occurredAt: new Date().toISOString(), properties: {} },
        { name: 'compare_used', occurredAt: new Date().toISOString(), properties: { mode: 'bad' } },
      ],
    });
    expect(response.statusCode).toBe(202);
    const rows = await harness.context.db
      .selectFrom('analyticsEvents')
      .select(['eventName', 'emitter'])
      .where('emitter', '=', 'client')
      .execute();
    expect(rows.filter((row) => row.eventName === 'compare_used')).toHaveLength(1);
    expect(rows.some((row) => row.eventName === 'render_requested')).toBe(false);
  });
});

describe('server-rendered pages and static delivery', () => {
  it('renders the landing shell with the hero preload, srcset and inline experience JSON', async () => {
    const response = await harness.client().get('/');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.headers['cache-control']).toContain('max-age=60');
    expect(response.headers.etag).toBeTruthy();
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    const html = response.body;
    expect(html).toMatch(/<link rel="preload" as="image" imagesrcset="[^"]+" imagesizes="100vw"/);
    expect(html).toContain('fetchpriority="high"');
    expect(html).toMatch(/<img class="ssr-hero__image" src="[^"]+" srcset="[^"]+ \d+w/);
    expect(html).toMatch(/width="\d+" height="\d+"/);
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain('/assets/index-abc123.js');
    const match = /<script type="application\/json" id="experience">([^<]*)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    const experience = ExperienceSchema.parse(JSON.parse(match?.[1] ?? '{}'));
    expect(experience.hero).not.toBeNull();
    expect(experience.fixtureCapabilities).toEqual(
      expect.arrayContaining(['image_editing', 'street_view_display']),
    );

    const cached = await harness
      .client()
      .get('/', { 'if-none-match': String(response.headers.etag) });
    expect(cached.statusCode).toBe(304);
  });

  it('serves hashed assets with long caching and client routes with the shell', async () => {
    const asset = await harness.client().get('/assets/index-abc123.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    const route = await harness.client().get('/p/0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e');
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('id="experience"');
    expect(route.body).not.toContain('ssr-hero__image');

    const unknownPage = await harness.client().get('/no-such-page');
    expect(unknownPage.statusCode).toBe(404);
    expect(unknownPage.headers['content-type']).toContain('text/html');

    const unknownApi = await harness.client().get('/v1/no-such-endpoint');
    expect(unknownApi.statusCode).toBe(404);
    expect(json(unknownApi).error).toMatchObject({ code: 'NOT_FOUND' });

    const health = await harness.client().get('/healthz');
    expect(health.statusCode).toBe(200);
  });

  it('serves signed fixture Street View frames and refuses a bad signature', async () => {
    const place = await import('@holiday/server/pipeline').then((pipeline) =>
      pipeline.fixturePlace('ChIJfxLanternHillColonial01'),
    );
    const pano = place.panoramas[0]?.panoId ?? '';
    const signed = buildFixtureDisplayUrl(
      harness.config.publicBaseUrl,
      harness.config.sessionSecret,
      {
        panoId: pano,
        heading: 200,
        pitch: 5,
        fov: 75,
        width: 640,
        height: 640,
      },
    );
    const pathAndQuery = signed.slice(harness.config.publicBaseUrl.length);
    const ok = await harness.client().get(pathAndQuery);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    const tampered = await harness
      .client()
      .get(pathAndQuery.replace('heading=200.0', 'heading=201.0'));
    expect(tampered.statusCode).toBe(403);
    expect(signed).toContain('/fixture/streetview?');
  });

  it('never writes the suggestions query text to the logs', async () => {
    const client = harness.client();
    await client.createSession();
    const sentinel = 'Zyxwvut Sentinel Lane';
    const response = await client.get(
      `/v1/addresses/suggestions?q=${encodeURIComponent(sentinel)}`,
    );
    expect(response.statusCode).toBe(200);
    const logs = logLines.join('');
    expect(logs).toContain('request completed');
    expect(logs).not.toContain('Zyxwvut');
    expect(logs).not.toContain('Sentinel');
  });
});
