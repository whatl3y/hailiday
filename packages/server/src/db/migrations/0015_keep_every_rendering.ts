import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * An owner may keep several live renderings of one variant key (a look rendered again is a new
 * rendering, and the earlier one stays). The unique index on `(owner_id, variant_key)` of live
 * rows becomes a plain index that also serves "the newest live rendering of a key".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `DROP INDEX IF EXISTS render_assets_owner_variant_key_idx`,
    `CREATE INDEX IF NOT EXISTS render_assets_owner_variant_key_created_idx
       ON render_assets (owner_id, variant_key, created_at DESC, id DESC)
       WHERE deleted_at IS NULL`,
  ]);
}

/**
 * Restores the unique index when no owner holds two live renderings of one key. Otherwise the
 * plain index stays and no rendering is removed: the previous release retires the older copies of
 * a key the next time it publishes that key, which needs no unique index.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `DO $$
     BEGIN
       CREATE UNIQUE INDEX IF NOT EXISTS render_assets_owner_variant_key_idx
         ON render_assets (owner_id, variant_key) WHERE deleted_at IS NULL;
       DROP INDEX IF EXISTS render_assets_owner_variant_key_created_idx;
     EXCEPTION WHEN unique_violation THEN
       RAISE NOTICE 'render_assets keeps several live renderings of one variant key: the unique index is not restored';
     END $$`,
  ]);
}
