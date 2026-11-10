import type { Kysely } from 'kysely';
import { ALLOWANCE_RESIDUE_KINDS } from '../../limits/residue.js';
import { checkIn, ID_AND_CREATED, runStatements } from '../sql-helpers.js';

/**
 * Allowance residue: one non-identifying row (owner, kind, timestamp) per counted allowance or
 * quota unit whose authoritative row a deletion removed, so deleting a project never returns
 * units to a rolling window. Rows expire with the window and are removed by the retention sweep.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `CREATE TABLE allowance_residue (
      ${ID_AND_CREATED},
      owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      kind text NOT NULL ${checkIn('kind', ALLOWANCE_RESIDUE_KINDS)},
      counted_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    )`,
    `CREATE INDEX allowance_residue_owner_kind_counted_idx
      ON allowance_residue (owner_id, kind, counted_at)`,
    `CREATE INDEX allowance_residue_expires_idx ON allowance_residue (expires_at)`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [`DROP TABLE allowance_residue`]);
}
