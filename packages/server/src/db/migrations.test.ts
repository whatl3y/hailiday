import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RENDER_JOB_STATES } from '@holiday/core';
import { createDb } from './client.js';
import type { Db } from './client.js';
import { appliedMigrations, migrateToLatest } from './migrator.js';
import { MIGRATIONS } from './migrations/index.js';
import * as attemptRepairFlag from './migrations/0011_attempt_repair_flag.js';
import { testDatabaseUrl } from './testing.js';

const scratchName = 'holiday_test_migrations';

function urlFor(database: string): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('migrations', () => {
  let db: Db;

  beforeAll(async () => {
    await admin(async (client) => {
      await client.query(`drop database if exists ${scratchName} with (force)`);
      await client.query(`create database ${scratchName}`);
    });
    db = createDb({ connectionString: urlFor(scratchName), max: 4 });
  });

  afterAll(async () => {
    await db?.destroy();
    await admin((client) => client.query(`drop database if exists ${scratchName} with (force)`));
  });

  it('migrates up from an empty database, once, even when runs race', async () => {
    const [first, second] = await Promise.all([migrateToLatest(db), migrateToLatest(db)]);
    const applied = [...first.applied, ...second.applied].sort();
    expect(applied).toEqual(Object.keys(MIGRATIONS).sort());
    expect(await appliedMigrations(db)).toEqual(Object.keys(MIGRATIONS));
    expect((await migrateToLatest(db)).applied).toEqual([]);
  });

  it('creates every entity table from the data model', async () => {
    const rows = await sql<{ tableName: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(db);
    const tables = new Set(rows.rows.map((row) => row.tableName));
    for (const table of [
      'owners',
      'anonymous_sessions',
      'users',
      'auth_tokens',
      'country_capabilities',
      'runtime_settings',
      'properties',
      'projects',
      'source_discoveries',
      'source_assets',
      'asset_policies',
      'permission_evaluations',
      'holiday_pack_versions',
      'holiday_occurrences',
      'hero_assets',
      'example_assets',
      'style_kits',
      'kit_items',
      'render_jobs',
      'render_attempts',
      'scene_analyses',
      'decoration_plans',
      'judge_results',
      'render_assets',
      'reviews',
      'usage_ledger',
      'merchant_programs',
      'products',
      'offers',
      'render_product_links',
      'affiliate_clicks',
      'affiliate_conversions',
      'share_grants',
      'feedback',
      'reports',
      'blocked_addresses',
      'preservation_holds',
      'deletion_requests',
      'tombstones',
      'allowance_residue',
      'analytics_events',
      'audit_log',
      'fixture_emails',
    ]) {
      expect(tables.has(table), table).toBe(true);
    }
  });

  it('generates CHECK constraints from the core enum arrays', async () => {
    const rows = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'render_jobs'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%state = ANY%'
    `.execute(db);
    const definition = rows.rows.map((row) => row.definition).join(' ');
    for (const state of RENDER_JOB_STATES) expect(definition).toContain(`'${state}'`);
  });

  it('lets only the second attempt be a repair, without making every second attempt one', async () => {
    const repairRule = async () =>
      (
        await sql<{ definition: string }>`
          select pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'render_attempts'::regclass and conname = 'render_attempts_repair_rule'
        `.execute(db)
      ).rows.map((row) => row.definition);
    expect(await repairRule()).toEqual(['CHECK (((NOT is_repair) OR (attempt_no = 2)))']);
    await attemptRepairFlag.down(db.withoutPlugins() as Kysely<unknown>);
    expect(await repairRule()).toEqual(['CHECK ((is_repair = (attempt_no = 2)))']);
    await attemptRepairFlag.up(db.withoutPlugins() as Kysely<unknown>);
    expect(await repairRule()).toEqual(['CHECK (((NOT is_repair) OR (attempt_no = 2)))']);
  });
});
