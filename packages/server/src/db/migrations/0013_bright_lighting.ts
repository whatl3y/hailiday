import type { Kysely } from 'kysely';
import { checkIn, runStatements } from '../sql-helpers.js';

/** Every table with a `lighting_mode` column. */
const LIGHTING_TABLES = ['projects', 'render_jobs', 'render_assets', 'example_assets'] as const;

/** The lighting modes this migration allows, and the set it restores on the way down. */
const WITH_BRIGHT = ['source', 'evening', 'bright'] as const;
const WITHOUT_BRIGHT = ['source', 'evening'] as const;

/**
 * The `bright` lighting mode: every check that enumerates lighting modes accepts it. Also the
 * index the owner-wide gallery reads (an owner's renderings, newest first).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    ...LIGHTING_TABLES.flatMap((table) => [
      `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_lighting_mode_check`,
      `ALTER TABLE ${table}
         ADD CONSTRAINT ${table}_lighting_mode_check ${checkIn('lighting_mode', WITH_BRIGHT)}`,
    ]),
    `CREATE INDEX IF NOT EXISTS render_assets_owner_created_idx
       ON render_assets (owner_id, created_at, id)`,
  ]);
}

/**
 * Replaces a table's check with a narrower one only when every stored row satisfies it, and
 * otherwise keeps the current check: the replacement runs in a block of its own, so a row that
 * violates the narrower check rolls back just that block. A check restored `NOT VALID` would
 * instead refuse every later update of such a row (Postgres checks the new row of each update).
 */
function narrowCheck(table: string, constraint: string, check: string): string {
  return `DO $$
    BEGIN
      ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${constraint};
      ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${check};
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE '% keeps its wider check: stored rows need it', '${constraint}';
    END $$`;
}

/**
 * Refuses `bright` again where nothing stored uses it. A project's look falls back to as
 * photographed; a table that still holds a job, rendering or example made in `bright` keeps the
 * check that allows it, so those rows can still be updated.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `DROP INDEX IF EXISTS render_assets_owner_created_idx`,
    `UPDATE projects SET lighting_mode = 'source' WHERE lighting_mode = 'bright'`,
    ...LIGHTING_TABLES.map((table) =>
      narrowCheck(table, `${table}_lighting_mode_check`, checkIn('lighting_mode', WITHOUT_BRIGHT)),
    ),
  ]);
}
