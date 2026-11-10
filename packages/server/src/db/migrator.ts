import { sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider, MigrationResult } from 'kysely/migration';
import type { Logger } from '../logger/index.js';
import type { Db } from './client.js';
import { MIGRATIONS } from './migrations/index.js';

export const MIGRATION_TABLE = 'kysely_migration';
export const MIGRATION_LOCK_TABLE = 'kysely_migration_lock';

/** Advisory lock key held for the whole migration run (in addition to Kysely's own lock). */
export const MIGRATION_ADVISORY_LOCK_KEY = 72_610_401;

class StaticMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: Readonly<Record<string, Migration>>) {}
  async getMigrations(): Promise<Record<string, Migration>> {
    return { ...this.migrations };
  }
}

export interface MigrateResult {
  applied: string[];
  results: MigrationResult[];
}

function createMigrator(db: Db, migrations: Readonly<Record<string, Migration>>): Migrator {
  return new Migrator({
    db: db.withoutPlugins(),
    provider: new StaticMigrationProvider(migrations),
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
  });
}

/**
 * Applies every pending migration in registry order. Concurrent runs serialize on a
 * session-level Postgres advisory lock held for the whole run, and Kysely additionally takes a
 * transaction-level advisory lock around each batch, so two release processes never interleave.
 */
export async function migrateToLatest(
  db: Db,
  options: { logger?: Logger; migrations?: Readonly<Record<string, Migration>> } = {},
): Promise<MigrateResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  return db.connection().execute(async (connection) => {
    await sql`select pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`.execute(connection);
    try {
      const migrator = createMigrator(connection as Db, migrations);
      const { error, results = [] } = await migrator.migrateToLatest();
      for (const result of results) {
        if (result.status === 'Success') {
          options.logger?.info({ migration: result.migrationName }, 'migration applied');
        } else if (result.status === 'Error') {
          options.logger?.error({ migration: result.migrationName }, 'migration failed');
        }
      }
      if (error) throw error instanceof Error ? error : new Error(String(error));
      return {
        applied: results
          .filter((result) => result.status === 'Success')
          .map((result) => result.migrationName),
        results,
      };
    } finally {
      await sql`select pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`.execute(connection);
    }
  });
}

/** Names of migrations recorded as applied, in order. */
export async function appliedMigrations(db: Db): Promise<string[]> {
  const migrator = createMigrator(db, MIGRATIONS);
  const info = await migrator.getMigrations();
  return info.filter((migration) => migration.executedAt).map((migration) => migration.name);
}
