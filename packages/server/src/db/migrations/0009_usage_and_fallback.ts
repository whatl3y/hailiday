import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * Provider usage as reported (tokens, images, request IDs) on attempts, scene analyses and judge
 * results, so every settled cost can be traced to the vendor's own figures; and the evening
 * fallback record on an attempt (the deterministic relight delivered in place of a rejected
 * evening edit).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE render_attempts ADD COLUMN provider_usage jsonb`,
    `ALTER TABLE render_attempts ADD COLUMN fallback jsonb`,
    `ALTER TABLE scene_analyses ADD COLUMN usage jsonb`,
    `ALTER TABLE judge_results ADD COLUMN usage jsonb`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE judge_results DROP COLUMN usage`,
    `ALTER TABLE scene_analyses DROP COLUMN usage`,
    `ALTER TABLE render_attempts DROP COLUMN fallback`,
    `ALTER TABLE render_attempts DROP COLUMN provider_usage`,
  ]);
}
