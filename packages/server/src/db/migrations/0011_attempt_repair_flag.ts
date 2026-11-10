import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * `render_attempts.is_repair` marks an attempt planned with repair constraints. Only the second
 * attempt can be one, but the second attempt is not always a repair: the relight of a daylight
 * base the job rendered itself is attempt 2 without repair constraints.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE render_attempts DROP CONSTRAINT render_attempts_repair_rule`,
    `ALTER TABLE render_attempts
       ADD CONSTRAINT render_attempts_repair_rule CHECK (NOT is_repair OR attempt_no = 2)`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE render_attempts DROP CONSTRAINT render_attempts_repair_rule`,
    `UPDATE render_attempts SET is_repair = (attempt_no = 2)
       WHERE is_repair IS DISTINCT FROM (attempt_no = 2)`,
    `ALTER TABLE render_attempts
       ADD CONSTRAINT render_attempts_repair_rule CHECK (is_repair = (attempt_no = 2))`,
  ]);
}
