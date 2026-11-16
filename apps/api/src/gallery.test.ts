import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GalleryResponseSchema,
  type GalleryItem,
  type LightingMode,
  type Style,
} from '@hailiday/core';
import { sql } from '@hailiday/server/db';
import { renderFixturePanorama } from '@hailiday/server/fixtures';
import { createRenderJobRecord, createUploadSource, runRenderJob } from '@hailiday/server/pipeline';
import { encodeCursor, encodePreciseCursor } from './http/cursor.js';
import { galleryPageQuery } from './routes/gallery.js';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { placesTokenForClient } from './test/places-token.js';
import { adoptStreetViewProject, ownerIdOf } from './test/projects.js';

const TEMPLATE = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Hailiday</title><!--hailiday:head--></head>
  <body><div id="root"></div><!--hailiday:experience--></body>
</html>
`;

const LANTERN_HILL = 'ChIJfxLanternHillColonial01';

let harness: Harness;
let distDir: string;
let clients = 0;

beforeAll(async () => {
  distDir = mkdtempSync(path.join(tmpdir(), 'hailiday-gallery-'));
  writeFileSync(path.join(distDir, 'index.html'), TEMPLATE);
  mkdirSync(path.join(distDir, 'assets'));
  harness = await createHarness({ webDistDir: distDir });
});

afterAll(async () => {
  await harness?.close();
  rmSync(distDir, { recursive: true, force: true });
});

async function newClient(): Promise<TestClient> {
  clients += 1;
  const client = harness.client({ remoteAddress: `10.71.${clients >> 8}.${clients & 255}` });
  await client.createSession();
  return client;
}

/** A fixture house photograph (JPEG) to upload. */
async function photo(): Promise<Buffer> {
  const frame = await renderFixturePanorama({
    panoId: 'fxSvLanternHillC01p1Sv',
    heading: 0,
    fov: 80,
    pitch: 2,
  });
  if (!frame) throw new Error('fixture panorama missing');
  return frame.image;
}

/** An upload project with a real stored original, given to the client's owner. */
async function adoptRenderableUpload(client: TestClient): Promise<string> {
  const ownerId = await ownerIdOf(harness, client);
  const created = await createUploadSource(harness.pipeline, { image: await photo() });
  await harness.context.db.transaction().execute(async (trx) => {
    for (const table of ['projects', 'sourceAssets'] as const) {
      await trx
        .updateTable(table)
        .set({ ownerId })
        .where('ownerId', '=', created.ownerId)
        .execute();
    }
  });
  return created.projectId;
}

/** Renders one look of a project in the worker and returns its render asset id. */
async function renderLook(
  client: TestClient,
  projectId: string,
  look: { style: Style; lightingMode?: LightingMode },
): Promise<string> {
  const ownerId = await ownerIdOf(harness, client);
  const db = harness.context.db;
  const project = await db
    .selectFrom('projects')
    .select('activeSourceAssetId')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  const source = await db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', project.activeSourceAssetId as string)
    .executeTakeFirstOrThrow();
  const job = await createRenderJobRecord(harness.pipeline, {
    ownerId,
    projectId,
    source,
    style: look.style,
    lightingMode: look.lightingMode ?? 'source',
  });
  expect((await runRenderJob(harness.pipeline, { renderJobId: job.id })).state).toBe('succeeded');
  const asset = await db
    .selectFrom('renderAssets')
    .select('id')
    .where('jobId', '=', job.id)
    .executeTakeFirstOrThrow();
  return asset.id;
}

async function gallery(client: TestClient, query = '') {
  const response = await client.get(`/v1/gallery${query}`);
  expect(response.statusCode).toBe(200);
  return GalleryResponseSchema.parse(response.json());
}

async function allItems(client: TestClient, limit: number): Promise<GalleryItem[]> {
  const items: GalleryItem[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const body = await gallery(client, query);
    expect(body.items.length).toBeLessThanOrEqual(limit);
    items.push(...body.items);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return items;
}

describe('GET /v1/gallery', () => {
  it('lists every rendering of the owner, grouped by place and by upload, newest first', async () => {
    const client = await newClient();
    const first = await adoptStreetViewProject(harness, client, LANTERN_HILL);
    const second = await adoptStreetViewProject(harness, client, LANTERN_HILL);
    const upload = await adoptRenderableUpload(client);
    const a = await renderLook(client, first.projectId, { style: 'classic' });
    const b = await renderLook(client, first.projectId, { style: 'subtle' });
    const c = await renderLook(client, second.projectId, { style: 'abundant' });
    const d = await renderLook(client, upload, { style: 'abundant' });

    // The same place typed again opens the most recent project there and stores its address.
    const resolved = await client.post('/v1/addresses/resolve', {
      placeId: LANTERN_HILL,
      sessionToken: await placesTokenForClient(harness, client),
      holidayId: 'christmas',
    });
    expect(resolved.statusCode).toBe(200);
    expect([first.projectId, second.projectId]).toContain(
      json<{ project: { id: string } }>(resolved).project.id,
    );

    const body = await gallery(client);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((item) => item.id)).toEqual([d, c, b, a]);
    const byId = new Map(body.items.map((item) => [item.id, item]));
    const place = byId.get(a)?.group;
    expect(place).toMatchObject({ kind: 'address' });
    expect(place?.label).toBe('14 Lantern Hill Rd, Maplebrook, VT 05341, USA');
    expect(place?.key).not.toContain(LANTERN_HILL);
    expect(byId.get(b)?.group).toEqual(place);
    expect(byId.get(c)?.group).toEqual(place);
    expect(byId.get(d)?.group).toEqual({ key: `project-${upload}`, kind: 'upload', label: null });

    expect(byId.get(a)).toMatchObject({
      projectId: first.projectId,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
      sceneType: 'house_exterior',
      sourceKind: 'street_view',
      beforeImageUrl: null,
    });
    expect(byId.get(c)?.projectId).toBe(second.projectId);
    const uploaded = byId.get(d);
    expect(uploaded).toMatchObject({ sourceKind: 'upload', style: 'abundant' });
    // Street View-origin renderings carry their stored credit; uploads carry none.
    const credits = await harness.context.db
      .selectFrom('renderAssets')
      .select(['id', 'attributionText'])
      .where('id', 'in', [a, b, c])
      .execute();
    for (const credit of credits) {
      expect(credit.attributionText).toBeTruthy();
      expect(byId.get(credit.id)?.attribution).toEqual({
        text: credit.attributionText,
        logo: 'google_maps',
      });
    }
    expect(uploaded?.attribution).toBeNull();
    // The stored original is the before image; a Street View source has none stored.
    expect(uploaded?.beforeImageUrl).toContain('/originals/');
    expect(uploaded?.imageUrl).toContain('/outputs/');
    expect(uploaded?.imageUrl).toContain('X-Amz-Expires=900');
    for (const item of body.items) {
      expect(item.width).toBeGreaterThan(0);
      expect(item.beforeImageUrl ?? '').not.toContain('google');
      if (item.downloadUrl) expect(item.downloadUrl).toContain('/downloads/');
    }
  });

  it('pages by creation time without repeating or skipping a rendering', async () => {
    const client = await newClient();
    const project = await adoptStreetViewProject(harness, client, LANTERN_HILL);
    const made: string[] = [];
    for (const style of ['subtle', 'classic', 'abundant'] as const) {
      made.push(await renderLook(client, project.projectId, { style }));
    }
    made.push(
      await renderLook(client, project.projectId, { style: 'classic', lightingMode: 'evening' }),
    );
    const everything = (await gallery(client)).items.map((item) => item.id);
    // The evening look relights the daylight `classic` look the owner already has: both stay.
    expect(everything).toEqual([...made].reverse());
    const paged = (await allItems(client, 2)).map((item) => item.id);
    expect(paged).toEqual(everything);
    const one = await gallery(client, '?limit=1');
    expect(one.items).toHaveLength(1);
    expect(one.nextCursor).not.toBeNull();
    expect((await client.get('/v1/gallery?limit=101')).statusCode).toBe(400);
    expect((await client.get('/v1/gallery?cursor=not-a-cursor')).statusCode).toBe(400);
  });

  it("leaves out other owners' renderings, deleted and withdrawn ones and deleted projects", async () => {
    const owner = await newClient();
    const stranger = await newClient();
    const kept = await adoptStreetViewProject(harness, owner, LANTERN_HILL);
    const removed = await adoptStreetViewProject(harness, owner, LANTERN_HILL);
    const shown = await renderLook(owner, kept.projectId, { style: 'classic' });
    const deleted = await renderLook(owner, kept.projectId, { style: 'subtle' });
    const withdrawn = await renderLook(owner, kept.projectId, { style: 'abundant' });
    const ofDeletedProject = await renderLook(owner, removed.projectId, { style: 'classic' });
    const strangers = await renderLook(
      stranger,
      (await adoptStreetViewProject(harness, stranger, LANTERN_HILL)).projectId,
      { style: 'classic' },
    );
    const db = harness.context.db;
    await db
      .updateTable('renderAssets')
      .set({ deletedAt: new Date() })
      .where('id', '=', deleted)
      .execute();
    await db
      .updateTable('renderAssets')
      .set({ withdrawnAt: new Date() })
      .where('id', '=', withdrawn)
      .execute();
    expect((await owner.delete(`/v1/projects/${removed.projectId}`)).statusCode).toBe(202);

    const ids = (await gallery(owner)).items.map((item) => item.id);
    expect(ids).toEqual([shown]);
    expect(ids).not.toContain(ofDeletedProject);
    expect((await gallery(stranger)).items.map((item) => item.id)).toEqual([strangers]);
    const fresh = await newClient();
    expect((await gallery(fresh)).items).toEqual([]);
  });

  it('offers no download of a Street View look once its source policy stops distribution', async () => {
    const client = await newClient();
    const street = await adoptStreetViewProject(harness, client, LANTERN_HILL);
    const look = await renderLook(client, street.projectId, { style: 'classic' });
    const upload = await renderLook(client, await adoptRenderableUpload(client), {
      style: 'classic',
    });
    const db = harness.context.db;
    const downloads = async () =>
      new Map((await gallery(client)).items.map((item) => [item.id, item.downloadUrl]));
    const before = await downloads();
    expect(before.get(look)).toContain('/downloads/');
    expect(before.get(upload)).toContain('/downloads/');

    // A policy recorded deliberately (not a template row) that no longer allows distribution.
    const source = await db
      .selectFrom('sourceAssets')
      .select('assetPolicyId')
      .where('id', '=', street.sourceAssetId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable('assetPolicies')
      .set({
        distributeDerivative: 'denied',
        createdBy: 'operator:test',
        evidenceRef: 'test:denied',
      })
      .where('id', '=', source.assetPolicyId as string)
      .execute();
    const after = await downloads();
    expect(after.has(look)).toBe(true);
    expect(after.get(look)).toBeNull();
    expect(after.get(upload)).toContain('/downloads/');
    const stored = await db
      .selectFrom('renderAssets')
      .select('downloadable')
      .where('id', '=', look)
      .executeTakeFirstOrThrow();
    expect(stored.downloadable).toBe(true);
  });

  it('offers no download of a Street View look made under full once the use policy becomes decorate', async () => {
    const client = await newClient();
    const street = await adoptStreetViewProject(harness, client, LANTERN_HILL);
    const look = await renderLook(client, street.projectId, { style: 'classic' });
    const upload = await renderLook(client, await adoptRenderableUpload(client), {
      style: 'classic',
    });
    expect((await gallery(client)).items.find((item) => item.id === look)?.downloadUrl).toContain(
      '/downloads/',
    );

    // The same database served by a process whose use policy was tightened.
    const tightened = await createHarness({
      webDistDir: distDir,
      mapConfig: (config) => ({
        ...config,
        streetView: { ...config.streetView, usePolicy: 'decorate' },
      }),
    });
    try {
      const sameBrowser = tightened.client({ remoteAddress: client.remoteAddress });
      sameBrowser.cookie = client.cookie;
      const response = await sameBrowser.get('/v1/gallery');
      expect(response.statusCode).toBe(200);
      const items = new Map(
        GalleryResponseSchema.parse(response.json()).items.map((item) => [item.id, item]),
      );
      expect(items.get(look)).toMatchObject({ sourceKind: 'street_view', downloadUrl: null });
      expect(items.get(look)?.attribution).not.toBeNull();
      expect(items.get(upload)?.downloadUrl).toContain('/downloads/');
    } finally {
      await tightened.close();
    }
    const policy = await harness.context.db
      .selectFrom('sourceAssets')
      .innerJoin('assetPolicies', 'assetPolicies.id', 'sourceAssets.assetPolicyId')
      .select('assetPolicies.distributeDerivative')
      .where('sourceAssets.id', '=', street.sourceAssetId)
      .executeTakeFirstOrThrow();
    expect(policy.distributeDerivative).toBe('denied');
  });

  it('answers an empty page without a session and never creates one', async () => {
    const client = harness.client({ remoteAddress: '10.71.250.1' });
    const sessions = async () =>
      Number(
        (
          await harness.context.db
            .selectFrom('anonymousSessions')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .executeTakeFirstOrThrow()
        ).count,
      );
    const before = await sessions();
    const empty = await client.get('/v1/gallery');
    expect(empty.statusCode).toBe(200);
    expect(json(empty)).toEqual({ items: [], nextCursor: null });
    const withToken = await client.get('/v1/gallery', { 'x-turnstile-token': 'fixture-pass' });
    expect(withToken.statusCode).toBe(200);
    expect(json(withToken)).toEqual({ items: [], nextCursor: null });
    expect(withToken.cookies.find((cookie) => cookie.name === 'hailiday_session')).toBeUndefined();
    const stale = harness.client({ remoteAddress: '10.71.250.2' });
    stale.cookie = 'no-such-session-token-0123456789';
    expect(json(await stale.get('/v1/gallery'))).toEqual({ items: [], nextCursor: null });
    expect(await sessions()).toBe(before);
  });

  it('keeps microseconds in the cursor so renderings made within one millisecond all appear', async () => {
    const client = await newClient();
    const project = await adoptStreetViewProject(harness, client, LANTERN_HILL);
    const made: string[] = [];
    for (const style of ['subtle', 'classic', 'abundant'] as const) {
      made.push(await renderLook(client, project.projectId, { style }));
    }
    // Three renderings inside one millisecond, newest last.
    for (const [index, id] of made.entries()) {
      const at = `2026-11-10T12:00:00.1231${index}5Z`;
      await sql`update render_assets set created_at = ${at}::timestamptz where id = ${id}`.execute(
        harness.context.db,
      );
    }
    const paged = await allItems(client, 1);
    expect(paged.map((item) => item.id)).toEqual([...made].reverse());
    expect(paged.map((item) => item.createdAt)).toEqual([
      '2026-11-10T12:00:00.123Z',
      '2026-11-10T12:00:00.123Z',
      '2026-11-10T12:00:00.123Z',
    ]);
  });

  it('refuses crafted cursors with VALIDATION_FAILED, including dates PostgreSQL cannot store', async () => {
    const client = await newClient();
    const id = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e';
    const raw = (at: string) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
    const crafted = [
      raw('-000001-01-01T00:00:00.000000Z'),
      raw('0000-01-01T00:00:00.000000Z'),
      raw('+275760-09-13T00:00:00.000000Z'),
      raw('2026-02-30T00:00:00.000000Z'),
      raw('2026-11-10T12:00:00Z'),
      raw('2026-11-10 12:00:00.000000+00'),
      // A millisecond cursor is not a gallery cursor.
      encodeCursor(new Date('2026-11-10T12:00:00.000Z'), id),
    ];
    for (const cursor of crafted) {
      const response = await client.get(`/v1/gallery?cursor=${encodeURIComponent(cursor)}`);
      expect(response.statusCode).toBe(400);
      expect(json(response).error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: [{ path: 'querystring.cursor', reason: 'invalid' }] },
      });
    }
    const projects = await client.get(
      `/v1/projects?cursor=${encodeURIComponent(raw('-000001-01-01T00:00:00.000Z'))}`,
    );
    expect(projects.statusCode).toBe(400);
    expect(json(projects).error).toMatchObject({ code: 'VALIDATION_FAILED' });
    const earliest = await client.get(
      `/v1/gallery?cursor=${encodeURIComponent(encodePreciseCursor('0001-01-01T00:00:00.000000Z', id))}`,
    );
    expect(earliest.statusCode).toBe(200);
  });

  it('reads a page through the owner index, in index order, without sorting', async () => {
    const owner = await ownerIdOf(harness, await newClient());
    const plan = await harness.context.db.transaction().execute(async (trx) => {
      for (const setting of [
        'enable_seqscan',
        'enable_bitmapscan',
        'enable_sort',
        'enable_incremental_sort',
      ]) {
        await sql`select set_config(${setting}, 'off', true)`.execute(trx);
      }
      const rows = await galleryPageQuery(trx, {
        ownerId: owner,
        cursor: ['2026-11-10T12:00:00.123456Z', '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e'],
        limit: 60,
      }).explain();
      return rows.map((row) => String(Object.values(row)[0])).join('\n');
    });
    expect(plan).toContain('render_assets_owner_created_idx');
    expect(plan).not.toMatch(/\bSort\b/);
    expect(plan).toMatch(/Index Cond: .*created_at/);
  });
});

describe('the /gallery page', () => {
  it('is a client route served with the app shell', async () => {
    const page = await harness.client().get('/gallery');
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('id="experience"');
  });
});
