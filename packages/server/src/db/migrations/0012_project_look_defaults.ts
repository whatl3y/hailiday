import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * A project starts in the abundant style. The API sets the starting style and lighting from the
 * pack's defaults for the scene type whenever the scene type is set or changes; the column
 * default covers a project created before it has a scene type. Existing rows keep their look.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [`ALTER TABLE projects ALTER COLUMN style SET DEFAULT 'abundant'`]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [`ALTER TABLE projects ALTER COLUMN style SET DEFAULT 'classic'`]);
}
