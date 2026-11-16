import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExperienceSchema, ProjectSchema, type Project } from '@hailiday/core';
import { DAY_MS } from '@hailiday/server/clock';
import type { AppConfig } from '@hailiday/server/config';
import { sha256Hex } from '@hailiday/server/ids';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';
import { adoptStreetViewProject, ownerIdOf } from './test/projects.js';

/** A clock the tests move forward by hand. */
class ManualClock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

const timeBasedDeletion = (config: AppConfig): AppConfig => ({
  ...config,
  settingOverrides: { ...config.settingOverrides, RETENTION_TIME_BASED_DELETION: 'true' },
});

/** Admission control opened up; each harness also gets its own secret (device and IP hashes). */
const OPEN_ADMISSION = {
  RENDER_QUEUE_DEPTH_MAX: '100000',
  RENDER_MAX_WAIT_S: '1000000',
};

const PLACES = {
  lanternHill: 'ChIJfxLanternHillColonial01',
  saguaro: 'ChIJfxSaguaroBendRanchXXX02',
  larkspur: 'ChIJfxLarkspurCourtBungal03',
  birchfield: 'ChIJfxBirchfieldPikeFarmh04',
} as const;

let kept: Harness;
let timed: Harness;
const clock = new ManualClock();
let clients = 0;

let distDir: string;

beforeAll(async () => {
  distDir = mkdtempSync(path.join(tmpdir(), 'hailiday-retention-'));
  writeFileSync(
    path.join(distDir, 'index.html'),
    '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>Hailiday</title>' +
      '<!--hailiday:head--></head><body><div id="ssr-hero"><!--hailiday:hero--></div>' +
      '<div id="root"></div><!--hailiday:experience--></body></html>',
  );
  mkdirSync(path.join(distDir, 'assets'));
  kept = await createHarness({
    clock,
    webDistDir: distDir,
    overrides: {
      ...OPEN_ADMISSION,
      SESSION_SECRET: 'retention-kept-session-secret-0123456789abcdef',
    },
  });
  timed = await createHarness({
    mapConfig: timeBasedDeletion,
    overrides: {
      ...OPEN_ADMISSION,
      SESSION_SECRET: 'retention-timed-session-secret-0123456789abcd',
    },
  });
});

afterAll(async () => {
  await kept?.close();
  await timed?.close();
  rmSync(distDir, { recursive: true, force: true });
});

async function newClient(harness: Harness): Promise<TestClient> {
  clients += 1;
  const client = harness.client({ remoteAddress: `10.61.${clients >> 8}.${clients & 255}` });
  await client.createSession();
  return client;
}

async function sessionRow(harness: Harness, client: TestClient) {
  return harness.context.db
    .selectFrom('anonymousSessions')
    .selectAll()
    .where('tokenHash', '=', sha256Hex(client.cookie as string))
    .executeTakeFirstOrThrow();
}

function sessionCookie(response: {
  cookies: {
    name: string;
    value: string;
    maxAge?: number;
    sameSite?: unknown;
    httpOnly?: boolean;
  }[];
}) {
  return response.cookies.find((cookie) => cookie.name === 'hailiday_session');
}

async function resolve(harness: Harness, client: TestClient, placeId: string) {
  return client.post('/v1/addresses/resolve', {
    placeId,
    sessionToken: await placesTokenForClient(harness, client),
    holidayId: 'christmas',
  });
}

async function addressesRemaining(client: TestClient) {
  return json<{ allowance: { addresses: { remaining: number } } }>(await client.get('/v1/me'))
    .allowance.addresses.remaining;
}

describe('anonymous sessions while time-based deletion is off', () => {
  it('lives 400 days and slides its cookie with activity', async () => {
    const client = kept.client({ remoteAddress: '10.61.250.1' });
    const created = await client.post('/v1/sessions', { turnstileToken: 'fixture-pass' });
    expect(created.statusCode).toBe(201);
    expect(sessionCookie(created)?.maxAge).toBe(400 * 86_400);
    const first = await sessionRow(kept, client);
    expect(first.expiresAt.getTime() - first.lastSeenAt.getTime()).toBe(400 * DAY_MS);

    // Within a minute nothing is written and no cookie is sent again.
    const quiet = await client.get('/v1/me');
    expect(quiet.statusCode).toBe(200);
    expect(sessionCookie(quiet)).toBeUndefined();

    // Thirty days later the session is still valid, its expiry moves and the cookie is refreshed.
    clock.advance(30 * DAY_MS);
    const later = await client.get('/v1/me');
    expect(later.statusCode).toBe(200);
    const refreshed = sessionCookie(later);
    expect(refreshed?.value).toBe(client.cookie);
    expect(refreshed?.maxAge).toBeGreaterThan(399 * 86_400);
    expect(refreshed?.maxAge).toBeLessThanOrEqual(400 * 86_400);
    expect(String(refreshed?.sameSite).toLowerCase()).toBe('lax');
    expect(refreshed?.httpOnly).toBe(true);
    const second = await sessionRow(kept, client);
    expect(second.expiresAt.getTime() - second.lastSeenAt.getTime()).toBe(400 * DAY_MS);
    expect(second.expiresAt.getTime() - first.expiresAt.getTime()).toBeGreaterThanOrEqual(
      30 * DAY_MS,
    );
  });
});

describe('the sliding session cookie', () => {
  it('is never set on a publicly cacheable page', async () => {
    const client = kept.client({ remoteAddress: '10.61.250.2' });
    await client.createSession();
    clock.advance(2 * 60_000);
    const landing = await client.get('/');
    expect(landing.statusCode).toBe(200);
    expect(String(landing.headers['cache-control'])).toContain('public');
    expect(sessionCookie(landing)).toBeUndefined();
    // The page did not use up the touch, so the next API request carries the refreshed cookie.
    const api = await client.get('/v1/me');
    expect(sessionCookie(api)?.value).toBe(client.cookie);
  });

  it('is refreshed by the first private response after a visit that starts on the landing page', async () => {
    const client = kept.client({ remoteAddress: '10.61.250.3' });
    await client.createSession();
    const created = await sessionRow(kept, client);
    clock.advance(30 * DAY_MS);
    const landing = await client.get('/');
    expect(landing.statusCode).toBe(200);
    expect(sessionCookie(landing)).toBeUndefined();
    // The landing page reads the session without moving its last-seen time or expiry.
    const afterLanding = await sessionRow(kept, client);
    expect(afterLanding.lastSeenAt).toEqual(created.lastSeenAt);
    expect(afterLanding.expiresAt).toEqual(created.expiresAt);
    // Well within the touch interval of the landing visit, the API extends the session and the
    // browser's cookie with it.
    clock.advance(10_000);
    const api = await client.get('/v1/me');
    expect(api.statusCode).toBe(200);
    const refreshed = sessionCookie(api);
    expect(refreshed?.value).toBe(client.cookie);
    expect(refreshed?.maxAge).toBeGreaterThan(399 * 86_400);
    const touched = await sessionRow(kept, client);
    expect(touched.expiresAt.getTime() - created.expiresAt.getTime()).toBeGreaterThanOrEqual(
      30 * DAY_MS,
    );
  });

  it('carries the device cookie again with every refreshed session cookie', async () => {
    const client = kept.client({ remoteAddress: '10.61.250.5' });
    const created = await client.post('/v1/sessions', { turnstileToken: 'fixture-pass' });
    const minted = created.cookies.find((cookie) => cookie.name === 'hailiday_device');
    expect(minted?.maxAge).toBe(400 * 86_400);
    expect(client.deviceCookie).toBe(minted?.value);

    // A response that sends no session cookie sends no device cookie either.
    const quiet = await client.get('/v1/me');
    expect(quiet.cookies.find((cookie) => cookie.name === 'hailiday_device')).toBeUndefined();

    clock.advance(30 * DAY_MS);
    const later = await client.get('/v1/me');
    expect(later.statusCode).toBe(200);
    expect(sessionCookie(later)?.maxAge).toBeGreaterThan(399 * 86_400);
    const device = later.cookies.find((cookie) => cookie.name === 'hailiday_device');
    expect(device?.value).toBe(minted?.value);
    expect(device?.maxAge).toBeGreaterThan(399 * 86_400);
    expect(device?.httpOnly).toBe(true);
    expect(String(device?.sameSite).toLowerCase()).toBe('lax');
  });

  it('records the Global Privacy Control signal on a landing visit without touching the session', async () => {
    const client = kept.client({ remoteAddress: '10.61.250.4' });
    await client.createSession();
    const created = await sessionRow(kept, client);
    clock.advance(2 * 60_000);
    expect((await client.get('/', { 'sec-gpc': '1' })).statusCode).toBe(200);
    const after = await sessionRow(kept, client);
    expect(after.gpcSignaledAt).toBeInstanceOf(Date);
    expect(after.lastSeenAt).toEqual(created.lastSeenAt);
  });
});

describe('anonymous sessions while time-based deletion is on', () => {
  it('keeps the specified 24-hour idle expiry and 7-day cookie', async () => {
    const client = timed.client({ remoteAddress: '10.62.250.1' });
    const created = await client.post('/v1/sessions', { turnstileToken: 'fixture-pass' });
    expect(created.statusCode).toBe(201);
    expect(sessionCookie(created)?.maxAge).toBe(7 * 86_400);
    const row = await sessionRow(timed, client);
    expect(row.expiresAt.getTime() - row.lastSeenAt.getTime()).toBe(DAY_MS);
  });
});

describe('the experience payload', () => {
  it('tells the client whether time-based deletion is on', async () => {
    for (const [harness, expected] of [
      [kept, false],
      [timed, true],
    ] as const) {
      const client = await newClient(harness);
      const experience = ExperienceSchema.parse(json(await client.get('/v1/experience')));
      expect(experience.clientConfig.retention).toEqual({ timeBasedDeletion: expected });
    }
  });

  it('returns no project expiry while time-based deletion is off', async () => {
    for (const [harness, hasExpiry] of [
      [kept, false],
      [timed, true],
    ] as const) {
      const client = await newClient(harness);
      const response = await client.post('/v1/projects', { kind: 'upload' });
      expect(response.statusCode).toBe(201);
      const { project } = json<{ project: Project }>(response);
      expect(project.expiresAt !== null).toBe(hasExpiry);
    }
  });
});

describe('the variant cache while time-based deletion is off', () => {
  it('serves a look after its stored expiry has passed and renders nothing new', async () => {
    const client = await newClient(kept);
    const project = await adoptStreetViewProject(kept, client);
    const look = {
      projectId: project.projectId,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
    };
    const render = () => client.post('/v1/renders', look, { 'idempotency-key': randomUUID() });
    const queued = await render();
    expect(queued.statusCode).toBe(202);
    const renderJobId = json<{ renderJobId: string }>(queued).renderJobId;
    expect(await kept.completeRender(renderJobId)).toBe('succeeded');
    const db = kept.context.db;
    await db
      .updateTable('renderAssets')
      .set({ expiresAt: new Date(Date.now() - DAY_MS) })
      .where('jobId', '=', renderJobId)
      .execute();

    const again = await render();
    expect(again.statusCode).toBe(200);
    expect(json(again)).toMatchObject({ cached: true });
    const jobs = await db
      .selectFrom('renderJobs')
      .select('id')
      .where('projectId', '=', project.projectId)
      .execute();
    expect(jobs).toHaveLength(1);
    const assets = await db
      .selectFrom('renderAssets')
      .select('id')
      .where('projectId', '=', project.projectId)
      .where('deletedAt', 'is', null)
      .execute();
    expect(assets).toHaveLength(1);
  });

  it('renders again once the stored expiry has passed while time-based deletion is on', async () => {
    const client = await newClient(timed);
    const project = await adoptStreetViewProject(timed, client);
    const look = {
      projectId: project.projectId,
      projectVersion: project.projectVersion,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
    };
    const render = () => client.post('/v1/renders', look, { 'idempotency-key': randomUUID() });
    const queued = await render();
    const renderJobId = json<{ renderJobId: string }>(queued).renderJobId;
    expect(await timed.completeRender(renderJobId)).toBe('succeeded');
    expect((await render()).statusCode).toBe(200);
    await timed.context.db
      .updateTable('renderAssets')
      .set({ expiresAt: new Date(Date.now() - DAY_MS) })
      .where('jobId', '=', renderJobId)
      .execute();
    const expired = await render();
    expect(expired.statusCode).toBe(202);
    await client.post(
      `/v1/renders/${json<{ renderJobId: string }>(expired).renderJobId}/cancel`,
      {},
    );
  });
});

describe('resolving a place the owner already has', () => {
  it('returns the same project and consumes no address allowance unit', async () => {
    const client = await newClient(kept);
    const ownerId = await ownerIdOf(kept, client);
    const first = await resolve(kept, client, PLACES.lanternHill);
    expect(first.statusCode).toBe(201);
    const created = ProjectSchema.parse(json<{ project: unknown }>(first).project);
    expect(await addressesRemaining(client)).toBe(2);

    const again = await resolve(kept, client, PLACES.lanternHill);
    expect(again.statusCode).toBe(200);
    const reused = ProjectSchema.parse(json<{ project: unknown }>(again).project);
    expect(reused.id).toBe(created.id);
    expect(reused.property?.formattedAddress).toContain('Lantern Hill');
    expect(await addressesRemaining(client)).toBe(2);

    // With the allowance used up, the known place still opens; a new place is refused.
    expect((await resolve(kept, client, PLACES.saguaro)).statusCode).toBe(201);
    expect((await resolve(kept, client, PLACES.larkspur)).statusCode).toBe(201);
    expect(await addressesRemaining(client)).toBe(0);
    const known = await resolve(kept, client, PLACES.lanternHill);
    expect(known.statusCode).toBe(200);
    expect(json<{ project: { id: string } }>(known).project.id).toBe(created.id);
    const refused = await resolve(kept, client, PLACES.birchfield);
    expect(refused.statusCode).toBe(429);
    expect(json(refused).error).toMatchObject({
      code: 'ALLOWANCE_EXHAUSTED',
      details: { scope: 'addresses' },
    });

    const projects = await kept.context.db
      .selectFrom('projects')
      .innerJoin('properties', 'properties.id', 'projects.propertyId')
      .select('projects.id')
      .where('projects.ownerId', '=', ownerId)
      .where('properties.placeId', '=', PLACES.lanternHill)
      .execute();
    expect(projects).toHaveLength(1);
  });

  it('gives another owner its own project at the same place', async () => {
    const one = await newClient(kept);
    const other = await newClient(kept);
    const a = await resolve(kept, one, PLACES.lanternHill);
    const b = await resolve(kept, other, PLACES.lanternHill);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(json<{ project: { id: string } }>(a).project.id).not.toBe(
      json<{ project: { id: string } }>(b).project.id,
    );
  });

  it('creates a new project once the earlier one is deleted', async () => {
    const client = await newClient(kept);
    const first = json<{ project: { id: string } }>(await resolve(kept, client, PLACES.saguaro));
    expect((await client.delete(`/v1/projects/${first.project.id}`)).statusCode).toBe(202);
    const second = await resolve(kept, client, PLACES.saguaro);
    expect(second.statusCode).toBe(201);
    expect(json<{ project: { id: string } }>(second).project.id).not.toBe(first.project.id);
  });

  it('finds the place for parallel resolves and keeps one project', async () => {
    const client = await newClient(kept);
    const ownerId = await ownerIdOf(kept, client);
    const tokens = [];
    for (let i = 0; i < 4; i += 1) tokens.push(await placesTokenForClient(kept, client));
    const responses = await Promise.all(
      tokens.map((sessionToken) =>
        client.post('/v1/addresses/resolve', {
          placeId: PLACES.birchfield,
          sessionToken,
          holidayId: 'christmas',
        }),
      ),
    );
    const codes = responses.map((response) => response.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 201]);
    const ids = new Set(
      responses.map((response) => json<{ project: { id: string } }>(response).project.id),
    );
    expect(ids.size).toBe(1);
    const rows = await kept.context.db
      .selectFrom('projects')
      .select('id')
      .where('ownerId', '=', ownerId)
      .where('kind', '=', 'address')
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('the stored display address', () => {
  it('stores the Geocoding address while time-based deletion is off', async () => {
    const client = await newClient(kept);
    const resolved = json<{ project: Project }>(await resolve(kept, client, PLACES.larkspur));
    const property = await kept.context.db
      .selectFrom('properties')
      .select(['displayAddress', 'displayAddressBasis', 'displayAddressStoredAt'])
      .where('id', '=', resolved.project.property?.id as string)
      .executeTakeFirstOrThrow();
    expect(property.displayAddressBasis).toBe('geocoding_place_id');
    expect(property.displayAddress).toBe('418 Larkspur Ct, Alder Glen, CA 93117, USA');
    expect(property.displayAddressStoredAt).not.toBeNull();
    const reread = json<{ project: Project }>(
      await client.get(`/v1/projects/${resolved.project.id}`),
    );
    expect(reread.project.property?.formattedAddress).toBe(property.displayAddress);
  });

  it('keeps the address transient while time-based deletion is on', async () => {
    const client = await newClient(timed);
    const response = await resolve(timed, client, PLACES.larkspur);
    expect(response.statusCode).toBe(201);
    const resolved = json<{ project: Project }>(response);
    expect(resolved.project.property?.formattedAddress).toContain('Larkspur');
    const property = await timed.context.db
      .selectFrom('properties')
      .select(['displayAddress', 'displayAddressBasis'])
      .where('id', '=', resolved.project.property?.id as string)
      .executeTakeFirstOrThrow();
    expect(property).toEqual({
      displayAddress: null,
      displayAddressBasis: 'autocomplete_transient',
    });
    const reread = json<{ project: Project }>(
      await client.get(`/v1/projects/${resolved.project.id}`),
    );
    expect(reread.project.property?.formattedAddress).toBeNull();
  });
});
