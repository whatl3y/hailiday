import type { Kysely } from 'kysely';
import { literal, runStatements } from '../sql-helpers.js';

/** `created_by` of a Street View policy row written from a template. */
const TEMPLATE_CREATOR = 'system:street-view-template';

/**
 * The Street View templates as they stand when this migration is written: uses in the order
 * display, store, ai_process, edit, distribute_derivative, commerce_adjacent, and the evidence
 * each may carry.
 */
const TEMPLATES: readonly { uses: readonly string[]; evidence: readonly string[] }[] = [
  {
    uses: ['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed'],
    evidence: ['owner-decision:2026-11-10'],
  },
  {
    uses: ['allowed', 'denied', 'allowed', 'allowed', 'denied', 'denied'],
    evidence: ['owner-decision:2026-11-10'],
  },
  {
    uses: ['allowed', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
    evidence: ['google-maps-platform:standard-terms', 'fixture:street-view-stand-in'],
  },
];

const USE_COLUMNS = [
  'display',
  'store',
  'ai_process',
  'edit',
  'distribute_derivative',
  'commerce_adjacent',
] as const;

const templateMatch = TEMPLATES.map(
  ({ uses, evidence }) =>
    `(${USE_COLUMNS.map((column, index) => `${column} = ${literal(uses[index] as string)}`).join(
      ' AND ',
    )} AND evidence_ref IN (${evidence.map(literal).join(', ')}))`,
).join(' OR ');

/**
 * Street View policy rows written from a template are marked with their own `created_by`, so a
 * row an operator edits (and records with another `created_by`) is never mistaken for a template
 * row and brought back to the configured use policy. Every existing unchanged template row of a
 * Street View source or discovery (created by `system`, territory `US`, no license version, expiry
 * or revocation, uses and evidence of one of the templates) is stamped.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `UPDATE asset_policies SET created_by = ${literal(TEMPLATE_CREATOR)}
      WHERE created_by = 'system'
        AND subject_kind = 'source_asset'
        AND territory = 'US'
        AND license_version IS NULL
        AND expires_at IS NULL
        AND revoked_at IS NULL
        AND (${templateMatch})`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `UPDATE asset_policies SET created_by = 'system' WHERE created_by = ${literal(TEMPLATE_CREATOR)}`,
  ]);
}
