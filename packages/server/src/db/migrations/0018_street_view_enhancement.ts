import type { Kysely } from 'kysely';
import {
  FAILURE_CODES,
  PROVIDER_MODES,
  PROVIDER_WATERMARKS,
  RENDER_SUB_STAGES,
} from '@hailiday/core';
import {
  ID_CREATED_UPDATED,
  checkIn,
  checkSubset,
  runStatements,
  updatedAtTrigger,
} from '../sql-helpers.js';

/** Statuses of a Street View enhancement row. */
export const SOURCE_ENHANCEMENT_STATUSES = ['pending', 'accepted', 'rejected', 'failed'] as const;

/**
 * Street View enhancements: one row per (source, stored-frame checksum, compiler version) records
 * the image editor's sharper, cleaner redraw of a stored frame, its checks and judge verdict, and,
 * when accepted, the stored picture jobs decorate in place of the frame. The row goes with its
 * source; `job_id` names the job that made or is making it, without a foreign key, because job
 * rows go with their project.
 *
 * Render jobs gain `sub_stage` (what the worker does inside a state when the state alone does not
 * say it) and `enhancement` (the outcome of the enhancement step for the job).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `CREATE TABLE source_enhancements (
      ${ID_CREATED_UPDATED},
      source_asset_id uuid NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
      frame_checksum_sha256 text NOT NULL,
      compiler_version text NOT NULL,
      working_width integer NOT NULL CHECK (working_width > 0),
      working_height integer NOT NULL CHECK (working_height > 0),
      status text NOT NULL ${checkIn('status', SOURCE_ENHANCEMENT_STATUSES)},
      reason text,
      failure_codes text[] NOT NULL DEFAULT '{}' ${checkSubset('failure_codes', FAILURE_CODES)},
      retryable boolean NOT NULL DEFAULT false,
      edit_count smallint NOT NULL DEFAULT 0 CHECK (edit_count BETWEEN 0 AND 2),
      job_id uuid,
      provider text,
      provider_mode text ${checkIn('provider_mode', PROVIDER_MODES)},
      model_snapshot text,
      settings_hash text,
      request jsonb,
      provider_operation_id text,
      edit_sent_at timestamptz,
      edit_completed_at timestamptz,
      edit_latency_ms integer,
      provider_usage jsonb,
      provider_watermark text ${checkIn('provider_watermark', PROVIDER_WATERMARKS)},
      raw_object_key text,
      edit_ledger_entry_id uuid REFERENCES usage_ledger(id),
      judge_ledger_entry_id uuid REFERENCES usage_ledger(id),
      registration jsonb,
      checks jsonb,
      judge jsonb,
      judge_usage jsonb,
      object_key text,
      enhanced_checksum_sha256 text,
      byte_length bigint,
      decided_at timestamptz,
      UNIQUE (source_asset_id, frame_checksum_sha256, compiler_version),
      CONSTRAINT source_enhancements_accepted_rule CHECK (
        status <> 'accepted' OR (object_key IS NOT NULL AND enhanced_checksum_sha256 IS NOT NULL)
      )
    )`,
    updatedAtTrigger('source_enhancements'),
    `CREATE INDEX source_enhancements_object_key_idx ON source_enhancements (object_key)
      WHERE object_key IS NOT NULL`,
    `CREATE INDEX source_enhancements_pending_idx ON source_enhancements (status)
      WHERE status = 'pending'`,
    `ALTER TABLE render_jobs ADD COLUMN sub_stage text ${checkIn('sub_stage', RENDER_SUB_STAGES)}`,
    `ALTER TABLE render_jobs ADD COLUMN enhancement jsonb`,
  ]);
}

/** Drops the two job columns and the enhancement table (stored pictures are left to the sweep). */
export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE render_jobs DROP COLUMN IF EXISTS enhancement`,
    `ALTER TABLE render_jobs DROP COLUMN IF EXISTS sub_stage`,
    `DROP TABLE IF EXISTS source_enhancements`,
  ]);
}
