import type { Kysely } from 'kysely';
import { runStatements } from '../sql-helpers.js';

/**
 * Preservation and deletion records:
 * - `preservation_holds.placed_by` becomes nullable so an automated child-safety signal can place a
 *   hold without an operator; `held_objects` records the copies made under `held/{holdId}/`.
 * - `tombstones` keeps the attestation version and timestamp of a deleted source asset, and
 *   `mirrored_at` records when the row was appended to the `tombstones/` mirror in object storage.
 * - `blocked_addresses.requester_contact_hash` keeps the homeowner's contact only as a hash.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE preservation_holds ALTER COLUMN placed_by DROP NOT NULL`,
    `ALTER TABLE preservation_holds ADD COLUMN held_objects jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `CREATE INDEX preservation_holds_open_idx ON preservation_holds (target_kind)
      WHERE released_at IS NULL`,
    `ALTER TABLE tombstones ADD COLUMN attestation_version text`,
    `ALTER TABLE tombstones ADD COLUMN attested_at timestamptz`,
    `ALTER TABLE tombstones ADD COLUMN mirrored_at timestamptz`,
    `CREATE INDEX tombstones_unmirrored_idx ON tombstones (created_at) WHERE mirrored_at IS NULL`,
    `ALTER TABLE blocked_addresses ADD COLUMN requester_contact_hash text
      CHECK (requester_contact_hash IS NULL OR requester_contact_hash ~ '^[0-9a-f]{64}$')`,
    `CREATE INDEX deletion_requests_open_idx ON deletion_requests (created_at)
      WHERE status IN ('pending', 'in_progress', 'failed', 'held')`,
    `CREATE INDEX reports_resolved_at_idx ON reports (resolved_at) WHERE resolved_at IS NOT NULL`,
    `CREATE INDEX render_jobs_signal_hashes_idx ON render_jobs (requested_at)
      WHERE device_hash IS NOT NULL OR ip_hash IS NOT NULL`,
  ]);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `DROP INDEX render_jobs_signal_hashes_idx`,
    `DROP INDEX reports_resolved_at_idx`,
    `DROP INDEX deletion_requests_open_idx`,
    `ALTER TABLE blocked_addresses DROP COLUMN requester_contact_hash`,
    `DROP INDEX tombstones_unmirrored_idx`,
    `ALTER TABLE tombstones DROP COLUMN mirrored_at`,
    `ALTER TABLE tombstones DROP COLUMN attested_at`,
    `ALTER TABLE tombstones DROP COLUMN attestation_version`,
    `DROP INDEX preservation_holds_open_idx`,
    `ALTER TABLE preservation_holds DROP COLUMN held_objects`,
    `ALTER TABLE preservation_holds ALTER COLUMN placed_by SET NOT NULL`,
  ]);
}
