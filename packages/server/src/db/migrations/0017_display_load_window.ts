import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * The per-address display budget becomes a 24-hour window: `display_loads_window_started_at` is
 * when the property's current window opened (its first display URL in the window). A count whose
 * window opened 24 hours ago or more, or has none, no longer counts. Properties that have already
 * issued display URLs start their window now, so no property gains a fresh budget at once.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE properties ADD COLUMN display_loads_window_started_at timestamptz`,
    `UPDATE properties SET display_loads_window_started_at = now() WHERE display_loads_issued > 0`,
  ]);
}

/** Back to a lifetime count: the counts of the current windows stay as the lifetime counts. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE properties DROP COLUMN IF EXISTS display_loads_window_started_at`,
  ]);
}
