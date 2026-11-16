import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import type { Db } from './client.js';
import { factories } from './factories.js';
import { migrateToLatest } from './migrator.js';
import * as displayLoadWindow from './migrations/0017_display_load_window.js';
import { testDatabaseUrl } from './testing.js';

/** A scratch database of its own, named after the test database so parallel runs never share it. */
const testUrl = new URL(testDatabaseUrl());
const scratchName = `${decodeURIComponent(testUrl.pathname.slice(1))}_display_window`;

function urlFor(database: string): string {
  const url = new URL(testUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin(query: string): Promise<void> {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

describe('migration 0017_display_load_window', () => {
  let db: Db;

  beforeAll(async () => {
    if (!/^[a-z_][a-z0-9_]*$/.test(scratchName)) throw new RangeError(scratchName);
    await admin(`drop database if exists ${scratchName} with (force)`);
    await admin(`create database ${scratchName}`);
    db = createDb({ connectionString: urlFor(scratchName), max: 2 });
    await migrateToLatest(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`drop database if exists ${scratchName} with (force)`);
  });

  const raw = () => db.withoutPlugins() as Kysely<unknown>;
  const hasColumn = async () =>
    (
      await sql<{ found: number }>`
        select count(*)::int as found from information_schema.columns
        where table_name = 'properties' and column_name = 'display_loads_window_started_at'
      `.execute(db)
    ).rows[0]?.found === 1;

  it('opens a window now for properties that already issued views, and reverts', async () => {
    expect(await hasColumn()).toBe(true);
    await displayLoadWindow.down(raw());
    expect(await hasColumn()).toBe(false);

    const owner = await factories.owner(db);
    const used = await factories.project(db, { ownerId: owner.id, kind: 'address' });
    const fresh = await factories.project(db, { ownerId: owner.id, kind: 'address' });
    await sql`update properties set display_loads_issued = 4 where id = ${used.propertyId}`.execute(
      db,
    );

    const before = Date.now();
    await displayLoadWindow.up(raw());
    const rows = await db
      .selectFrom('properties')
      .select(['id', 'displayLoadsIssued', 'displayLoadsWindowStartedAt'])
      .where('id', 'in', [used.propertyId!, fresh.propertyId!])
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const opened = byId.get(used.propertyId!);
    expect(opened?.displayLoadsIssued).toBe(4);
    expect(opened?.displayLoadsWindowStartedAt?.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(byId.get(fresh.propertyId!)).toMatchObject({
      displayLoadsIssued: 0,
      displayLoadsWindowStartedAt: null,
    });

    await displayLoadWindow.down(raw());
    expect(await hasColumn()).toBe(false);
    await displayLoadWindow.up(raw());
    expect(await hasColumn()).toBe(true);
  });
});
