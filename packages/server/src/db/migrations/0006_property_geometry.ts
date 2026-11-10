import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * Derived building numbers that discovery needs and resolve already computes: the facade normal,
 * whether the facade is attached to a neighbor and the SearchDestinations structure type. Like the
 * other geometry columns they are derived numbers only, never the outline itself.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE properties
      ADD COLUMN facade_normal_deg numeric(5,2),
      ADD COLUMN attached_facade boolean NOT NULL DEFAULT false,
      ADD COLUMN structure_type text CHECK (structure_type IN ('BUILDING', 'GROUNDS'))`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE properties
      DROP COLUMN structure_type,
      DROP COLUMN attached_facade,
      DROP COLUMN facade_normal_deg`,
  ]);
}
