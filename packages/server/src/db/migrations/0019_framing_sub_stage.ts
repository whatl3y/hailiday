import type { Kysely } from 'kysely';
import { RENDER_SUB_STAGES } from '@hailiday/core';
import { checkIn, runStatements } from '../sql-helpers.js';

/** The sub-stages the check allowed before `framing`, restored on the way down. */
const WITHOUT_FRAMING = ['enhancing', 'relight'] as const;

const CONSTRAINT = 'render_jobs_sub_stage_check';

/**
 * The `framing` sub-stage of a render job (in `preparing`, while a Street View frame is fetched
 * again zoomed in on the home): the job's sub-stage check accepts every current sub-stage.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE render_jobs DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`,
    `ALTER TABLE render_jobs ADD CONSTRAINT ${CONSTRAINT} ${checkIn('sub_stage', RENDER_SUB_STAGES)}`,
  ]);
}

/**
 * Refuses `framing` again. A job still showing it shows its state's own label instead (the
 * sub-stage is only a label), so the narrower check always holds.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `UPDATE render_jobs SET sub_stage = NULL WHERE sub_stage = 'framing'`,
    `ALTER TABLE render_jobs DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`,
    `ALTER TABLE render_jobs ADD CONSTRAINT ${CONSTRAINT} ${checkIn('sub_stage', WITHOUT_FRAMING)}`,
  ]);
}
