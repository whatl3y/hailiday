import type { Kysely } from 'kysely';
import {
  MAX_RENDER_ATTEMPTS,
  RENDER_ATTEMPT_NUMBERS,
  STANDARD_RENDER_ATTEMPTS,
} from '@hailiday/core';
import { runStatements } from '../sql-helpers.js';

/** The tables whose `attempt_no` enumerates a job's attempts. */
const ATTEMPT_TABLES = ['decoration_plans', 'render_attempts'] as const;

const numbers = (count: number) => RENDER_ATTEMPT_NUMBERS.slice(0, count).join(', ');

/**
 * A relit look (`evening`, `bright`) that decorates its own base may make a third attempt: the
 * base, the relight and one repair of either. Attempt numbers and the job's attempt count allow
 * three; a repair is any attempt after the first, and a job has at most one; a third attempt is
 * always a relight (`global_relight`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    ...ATTEMPT_TABLES.flatMap((table) => [
      `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_attempt_no_check`,
      `ALTER TABLE ${table}
         ADD CONSTRAINT ${table}_attempt_no_check
         CHECK (attempt_no IN (${numbers(MAX_RENDER_ATTEMPTS)}))`,
    ]),
    `ALTER TABLE render_jobs DROP CONSTRAINT IF EXISTS render_jobs_attempt_count_check`,
    `ALTER TABLE render_jobs
       ADD CONSTRAINT render_jobs_attempt_count_check
       CHECK (attempt_count BETWEEN 0 AND ${MAX_RENDER_ATTEMPTS})`,
    `ALTER TABLE render_attempts DROP CONSTRAINT IF EXISTS render_attempts_repair_rule`,
    `ALTER TABLE render_attempts
       ADD CONSTRAINT render_attempts_repair_rule CHECK (NOT is_repair OR attempt_no > 1)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS render_attempts_one_repair_per_job_idx
       ON render_attempts (job_id) WHERE is_repair`,
    `ALTER TABLE render_attempts DROP CONSTRAINT IF EXISTS render_attempts_third_is_relight`,
    `ALTER TABLE render_attempts
       ADD CONSTRAINT render_attempts_third_is_relight
       CHECK (attempt_no < 3 OR fidelity_mode = 'global_relight')`,
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
 * Refuses third attempts again when no stored job made one. Each check returns to its two-attempt
 * form only when every stored row satisfies it; a database holding a three-attempt job keeps the
 * wider check, so that job and its attempts can still be updated (sweeps, reconciliation and the
 * down migration of 0011 update them). The third-is-relight check and the one-repair index are
 * always dropped.
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE render_attempts DROP CONSTRAINT IF EXISTS render_attempts_third_is_relight`,
    `DROP INDEX IF EXISTS render_attempts_one_repair_per_job_idx`,
    narrowCheck(
      'render_attempts',
      'render_attempts_repair_rule',
      'CHECK (NOT is_repair OR attempt_no = 2)',
    ),
    narrowCheck(
      'render_jobs',
      'render_jobs_attempt_count_check',
      `CHECK (attempt_count BETWEEN 0 AND ${STANDARD_RENDER_ATTEMPTS})`,
    ),
    ...ATTEMPT_TABLES.map((table) =>
      narrowCheck(
        table,
        `${table}_attempt_no_check`,
        `CHECK (attempt_no IN (${numbers(STANDARD_RENDER_ATTEMPTS)}))`,
      ),
    ),
  ]);
}
