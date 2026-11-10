import pg from 'pg';
import { createDb } from './client.js';
import type { Db } from './client.js';
import { migrateToLatest } from './migrator.js';

/** Default URL of the integration-test database. */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:5434/holiday_test';

export function testDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL_TEST;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_TEST_DATABASE_URL;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new RangeError(`Unsafe database name: ${name}`);
  return `"${name}"`;
}

function splitUrl(url: string): { adminUrl: string; database: string } {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) throw new RangeError('The test database URL needs a database name');
  if (!/test/.test(database)) {
    throw new RangeError(`Refusing to manage a database whose name lacks "test": ${database}`);
  }
  parsed.pathname = '/postgres';
  return { adminUrl: parsed.toString(), database };
}

/**
 * Prepares the integration-test database. With `fresh` (the default) it drops and recreates it so
 * every test run migrates up from empty; otherwise it only creates it when missing. Migrations are
 * then applied. Call once per test run (a Vitest global setup), not per test file.
 */
export async function prepareTestDatabase(
  options: { url?: string; fresh?: boolean } = {},
): Promise<{ url: string }> {
  const url = options.url ?? testDatabaseUrl();
  const { adminUrl, database } = splitUrl(url);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [database]);
    if (options.fresh !== false && exists.rowCount) {
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [database],
      );
      await admin.query(`drop database if exists ${quoteIdent(database)}`);
    }
    if (options.fresh !== false || !exists.rowCount) {
      await admin.query(`create database ${quoteIdent(database)}`);
    }
  } finally {
    await admin.end();
  }
  const db = createDb({ connectionString: url, max: 2, applicationName: 'holiday-test-setup' });
  try {
    await migrateToLatest(db);
  } finally {
    await db.destroy();
  }
  return { url };
}

/** A Kysely handle on the test database (already prepared by the global setup). */
export function createTestDb(options: { max?: number } = {}): Db {
  return createDb({
    connectionString: testDatabaseUrl(),
    max: options.max ?? 4,
    applicationName: 'holiday-test',
  });
}
