import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * Global Privacy Control: when a session first arrived with `Sec-GPC: 1`. Recorded as evidence
 * that the signal was received; Hailiday has no sale or sharing, so honoring it changes nothing.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE anonymous_sessions ADD COLUMN gpc_signaled_at timestamptz`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [`ALTER TABLE anonymous_sessions DROP COLUMN gpc_signaled_at`]);
}
