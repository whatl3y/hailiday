import type { Kysely } from 'kysely';
import {
  ATTEMPT_OUTCOMES,
  FAILURE_CODES,
  FAILURE_DETAILS,
  FAILURE_KINDS,
  FIDELITY_MODES,
  HOLIDAY_IDS,
  JUDGE_DECISIONS,
  LEDGER_CATEGORIES,
  LEDGER_KINDS,
  LEDGER_SKUS,
  LIGHTING_MODES,
  NON_TERMINAL_RENDER_JOB_STATES,
  PROVIDER_MODES,
  PROVIDER_WATERMARKS,
  REJECTION_REASONS,
  RENDER_JOB_STATES,
  REVIEW_DECISIONS,
  REVIEW_MODES,
  REVIEW_SUBJECT_KINDS,
  STYLES,
  TERMINAL_RENDER_JOB_STATES,
} from '@hailiday/core';
import {
  ID_AND_CREATED,
  ID_CREATED_UPDATED,
  checkIn,
  checkSubset,
  inList,
  runStatements,
  updatedAtTrigger,
} from '../sql-helpers.js';

const SEMVER = `'^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`;

/** Render jobs, attempts, analyses, plans, judge results, accepted variants, reviews, ledger. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `CREATE TABLE usage_ledger (
      ${ID_AND_CREATED},
      owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
      owner_tombstone_hash text,
      kind text NOT NULL ${checkIn('kind', LEDGER_KINDS)},
      category text NOT NULL ${checkIn('category', LEDGER_CATEGORIES)},
      provider text NOT NULL,
      sku text NOT NULL ${checkIn('sku', LEDGER_SKUS)},
      model_id text,
      stage text,
      units numeric(12,4) NOT NULL,
      unit_price_micros bigint NOT NULL CHECK (unit_price_micros >= 0),
      amount_micros bigint NOT NULL,
      currency char(3) NOT NULL,
      reservation_id uuid REFERENCES usage_ledger(id),
      job_id uuid,
      attempt_id uuid,
      project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
      session_id uuid REFERENCES anonymous_sessions(id) ON DELETE SET NULL,
      is_fixture boolean NOT NULL,
      settled_at timestamptz,
      CONSTRAINT usage_ledger_sign_rule CHECK (
        (kind = 'release' AND amount_micros <= 0) OR (kind <> 'release' AND amount_micros >= 0)
      ),
      CONSTRAINT usage_ledger_reservation_link_rule CHECK (
        (kind IN ('settlement', 'release')) = (reservation_id IS NOT NULL)
      )
    )`,
    `CREATE INDEX usage_ledger_owner_created_idx ON usage_ledger (owner_id, created_at)`,
    `CREATE INDEX usage_ledger_sku_created_idx ON usage_ledger (sku, created_at)`,
    `CREATE INDEX usage_ledger_job_id_idx ON usage_ledger (job_id)`,
    `CREATE INDEX usage_ledger_reservation_id_idx ON usage_ledger (reservation_id)`,
    `CREATE INDEX usage_ledger_created_idx ON usage_ledger (created_at) WHERE NOT is_fixture`,

    `CREATE TABLE scene_analyses (
      ${ID_AND_CREATED},
      source_asset_id uuid NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
      analysis_model text NOT NULL,
      analysis_prompt_version text NOT NULL,
      schema_version text NOT NULL,
      working_width integer NOT NULL CHECK (working_width > 0),
      working_height integer NOT NULL CHECK (working_height > 0),
      working_checksum_sha256 text NOT NULL,
      document jsonb NOT NULL,
      scene_type_mismatch boolean NOT NULL DEFAULT false,
      first_job_id uuid,
      ledger_entry_id uuid REFERENCES usage_ledger(id),
      UNIQUE (source_asset_id, analysis_model, analysis_prompt_version, working_width,
        working_height, working_checksum_sha256)
    )`,

    `CREATE TABLE render_jobs (
      ${ID_CREATED_UPDATED},
      owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      project_version integer NOT NULL,
      source_asset_id uuid NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
      holiday_id text NOT NULL ${checkIn('holiday_id', HOLIDAY_IDS)},
      style text NOT NULL ${checkIn('style', STYLES)},
      lighting_mode text NOT NULL ${checkIn('lighting_mode', LIGHTING_MODES)},
      holiday_pack_version text NOT NULL CHECK (holiday_pack_version ~ ${SEMVER}),
      compiler_version text NOT NULL,
      variant_key text GENERATED ALWAYS AS (
        source_asset_id::text || '|' || holiday_id || '|' || style || '|' || lighting_mode || '|' ||
        substring(holiday_pack_version from '^[0-9]+\\.[0-9]+') || '|' || compiler_version
      ) STORED,
      input_snapshot jsonb NOT NULL,
      permission_evaluation_id uuid NOT NULL REFERENCES permission_evaluations(id),
      scene_analysis_id uuid REFERENCES scene_analyses(id) ON DELETE SET NULL,
      working_width integer,
      working_height integer,
      working_checksum_sha256 text,
      resampler text,
      working_crop_box jsonb,
      working_pad_box jsonb,
      scale_factor numeric(5,3),
      working_object_key text,
      repair_constraints jsonb,
      state text NOT NULL ${checkIn('state', RENDER_JOB_STATES)},
      state_seq integer NOT NULL DEFAULT 0,
      failure_kind text ${checkIn('failure_kind', FAILURE_KINDS)},
      failure_detail text ${checkIn('failure_detail', FAILURE_DETAILS)},
      rejection_reason text ${checkIn('rejection_reason', REJECTION_REASONS)},
      failure_codes text[] ${checkSubset('failure_codes', FAILURE_CODES)},
      idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 64),
      request_hash text NOT NULL,
      attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
      repair_used boolean NOT NULL DEFAULT false,
      review_mode text NOT NULL ${checkIn('review_mode', REVIEW_MODES)},
      superseded_by_job_id uuid REFERENCES render_jobs(id) ON DELETE SET NULL,
      cancel_requested_at timestamptz,
      render_asset_id uuid,
      device_hash text,
      ip_hash text,
      correlation_id text,
      requested_at timestamptz NOT NULL,
      source_ready_at timestamptz,
      started_at timestamptz,
      render_started_at timestamptz,
      render_completed_at timestamptz,
      qa_passed_at timestamptz,
      review_completed_at timestamptz,
      succeeded_at timestamptz,
      terminal_at timestamptz,
      UNIQUE (owner_id, idempotency_key),
      CONSTRAINT render_jobs_failed_kind_rule CHECK (state <> 'failed' OR failure_kind IS NOT NULL),
      CONSTRAINT render_jobs_rejected_reason_rule CHECK (state <> 'rejected' OR rejection_reason IS NOT NULL),
      CONSTRAINT render_jobs_terminal_at_rule CHECK (
        state IN (${inList(NON_TERMINAL_RENDER_JOB_STATES)}) OR terminal_at IS NOT NULL
      ),
      CONSTRAINT render_jobs_succeeded_rule CHECK (state <> 'succeeded' OR succeeded_at IS NOT NULL)
    )`,
    updatedAtTrigger('render_jobs'),
    `CREATE UNIQUE INDEX render_jobs_one_active_per_project_idx ON render_jobs (project_id)
      WHERE state NOT IN (${inList(TERMINAL_RENDER_JOB_STATES)})`,
    `CREATE INDEX render_jobs_owner_succeeded_idx ON render_jobs (owner_id, succeeded_at)`,
    `CREATE INDEX render_jobs_owner_variant_key_idx ON render_jobs (owner_id, variant_key)`,
    `CREATE INDEX render_jobs_state_requested_idx ON render_jobs (state, requested_at)`,
    `CREATE INDEX render_jobs_device_hash_requested_idx ON render_jobs (device_hash, requested_at)`,
    `CREATE INDEX render_jobs_ip_hash_requested_idx ON render_jobs (ip_hash, requested_at)`,
    `CREATE INDEX render_jobs_project_id_idx ON render_jobs (project_id)`,
    `CREATE INDEX render_jobs_source_asset_id_idx ON render_jobs (source_asset_id)`,

    `ALTER TABLE scene_analyses ADD CONSTRAINT scene_analyses_first_job_id_fkey
      FOREIGN KEY (first_job_id) REFERENCES render_jobs(id) ON DELETE SET NULL`,

    `CREATE TABLE decoration_plans (
      ${ID_AND_CREATED},
      job_id uuid NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
      attempt_no smallint NOT NULL CHECK (attempt_no IN (1, 2)),
      scene_analysis_id uuid NOT NULL REFERENCES scene_analyses(id),
      pack_version text NOT NULL,
      style_kit_id uuid NOT NULL REFERENCES style_kits(id),
      compiler_version text NOT NULL,
      document jsonb NOT NULL,
      validator_result jsonb NOT NULL,
      compiled_instruction text,
      UNIQUE (job_id, attempt_no)
    )`,

    `CREATE TABLE render_attempts (
      ${ID_CREATED_UPDATED},
      job_id uuid NOT NULL REFERENCES render_jobs(id) ON DELETE CASCADE,
      attempt_no smallint NOT NULL CHECK (attempt_no IN (1, 2)),
      is_repair boolean NOT NULL,
      decoration_plan_id uuid NOT NULL REFERENCES decoration_plans(id),
      scene_analysis_id uuid NOT NULL REFERENCES scene_analyses(id),
      permission_evaluation_id uuid NOT NULL REFERENCES permission_evaluations(id),
      provider text NOT NULL,
      model_snapshot text NOT NULL,
      prompt_version text NOT NULL,
      compiler_version text NOT NULL,
      settings_hash text NOT NULL,
      provider_mode text NOT NULL ${checkIn('provider_mode', PROVIDER_MODES)},
      provider_operation_id text,
      source_checksum_sha256 text NOT NULL,
      working_checksum_sha256 text NOT NULL,
      fidelity_mode text ${checkIn('fidelity_mode', FIDELITY_MODES)},
      requested_width integer,
      requested_height integer,
      delivered_width integer,
      delivered_height integer,
      composite_mask jsonb,
      registration_transform jsonb,
      dilation_fraction numeric(4,3),
      feather_fraction numeric(4,3),
      provider_manifest_object_key text,
      provider_watermark text ${checkIn('provider_watermark', PROVIDER_WATERMARKS)},
      provider_categories text[],
      request_sent_at timestamptz,
      completed_at timestamptz,
      outcome text NOT NULL ${checkIn('outcome', ATTEMPT_OUTCOMES)},
      transport_retries smallint NOT NULL DEFAULT 0 CHECK (transport_retries >= 0),
      candidate_object_key text,
      latency_ms integer,
      reservation_entry_id uuid REFERENCES usage_ledger(id),
      ledger_entry_id uuid REFERENCES usage_ledger(id),
      reconciled text CHECK (reconciled IN ('settled', 'assumed_charged')),
      error_detail jsonb,
      UNIQUE (job_id, attempt_no),
      CONSTRAINT render_attempts_repair_rule CHECK (is_repair = (attempt_no = 2))
    )`,
    updatedAtTrigger('render_attempts'),
    `CREATE INDEX render_attempts_provider_operation_id_idx ON render_attempts (provider_operation_id)`,
    `CREATE INDEX render_attempts_created_at_idx ON render_attempts (created_at)`,
    `CREATE INDEX render_attempts_outcome_idx ON render_attempts (outcome) WHERE outcome IN ('pending', 'unknown')`,

    `CREATE TABLE judge_results (
      ${ID_AND_CREATED},
      attempt_id uuid NOT NULL REFERENCES render_attempts(id) ON DELETE CASCADE,
      escalated boolean NOT NULL DEFAULT false,
      model_id text NOT NULL,
      prompt_version text NOT NULL,
      deterministic_checks jsonb NOT NULL,
      document jsonb NOT NULL,
      critical_codes text[] NOT NULL DEFAULT '{}' ${checkSubset('critical_codes', FAILURE_CODES)},
      major_codes text[] NOT NULL DEFAULT '{}' ${checkSubset('major_codes', FAILURE_CODES)},
      decision text NOT NULL ${checkIn('decision', JUDGE_DECISIONS)},
      ledger_entry_id uuid REFERENCES usage_ledger(id),
      UNIQUE (attempt_id, escalated)
    )`,

    `CREATE TABLE render_assets (
      ${ID_CREATED_UPDATED},
      owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      job_id uuid NOT NULL UNIQUE REFERENCES render_jobs(id) ON DELETE CASCADE,
      source_asset_id uuid NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
      variant_key text NOT NULL,
      holiday_id text NOT NULL ${checkIn('holiday_id', HOLIDAY_IDS)},
      style text NOT NULL ${checkIn('style', STYLES)},
      lighting_mode text NOT NULL ${checkIn('lighting_mode', LIGHTING_MODES)},
      holiday_pack_version text NOT NULL,
      compiler_version text NOT NULL,
      object_key text NOT NULL,
      width integer NOT NULL,
      height integer NOT NULL,
      content_type text NOT NULL,
      byte_length bigint NOT NULL,
      native_width integer NOT NULL,
      native_height integer NOT NULL,
      scale_factor numeric(5,3),
      fidelity_mode text NOT NULL ${checkIn('fidelity_mode', FIDELITY_MODES)},
      provenance jsonb NOT NULL,
      attribution_text text,
      distributable boolean NOT NULL,
      downloadable boolean NOT NULL,
      download_object_key text,
      existing_decor_conflict boolean NOT NULL DEFAULT false,
      expires_at timestamptz,
      pinned_until timestamptz,
      withdrawn_at timestamptz,
      preservation_hold_id uuid REFERENCES preservation_holds(id),
      deleted_at timestamptz,
      CONSTRAINT render_assets_download_key_rule CHECK (
        downloadable = (download_object_key IS NOT NULL)
      )
    )`,
    updatedAtTrigger('render_assets'),
    `CREATE UNIQUE INDEX render_assets_owner_variant_key_idx ON render_assets (owner_id, variant_key)
      WHERE deleted_at IS NULL`,
    `CREATE INDEX render_assets_project_id_idx ON render_assets (project_id)`,
    `CREATE INDEX render_assets_expires_at_idx ON render_assets (expires_at)`,

    `ALTER TABLE render_jobs ADD CONSTRAINT render_jobs_render_asset_id_fkey
      FOREIGN KEY (render_asset_id) REFERENCES render_assets(id) ON DELETE SET NULL`,
    `ALTER TABLE permission_evaluations ADD CONSTRAINT permission_evaluations_job_id_fkey
      FOREIGN KEY (job_id) REFERENCES render_jobs(id) ON DELETE SET NULL`,
    `ALTER TABLE permission_evaluations ADD CONSTRAINT permission_evaluations_attempt_id_fkey
      FOREIGN KEY (attempt_id) REFERENCES render_attempts(id) ON DELETE SET NULL`,
    `ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_job_id_fkey
      FOREIGN KEY (job_id) REFERENCES render_jobs(id) ON DELETE SET NULL`,
    `ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_attempt_id_fkey
      FOREIGN KEY (attempt_id) REFERENCES render_attempts(id) ON DELETE SET NULL`,
    `ALTER TABLE example_assets ADD CONSTRAINT example_assets_source_asset_id_fkey
      FOREIGN KEY (source_asset_id) REFERENCES source_assets(id) ON DELETE SET NULL`,
    `ALTER TABLE example_assets ADD CONSTRAINT example_assets_render_asset_id_fkey
      FOREIGN KEY (render_asset_id) REFERENCES render_assets(id) ON DELETE SET NULL`,

    `CREATE TABLE reviews (
      ${ID_AND_CREATED},
      subject_kind text NOT NULL ${checkIn('subject_kind', REVIEW_SUBJECT_KINDS)},
      job_id uuid REFERENCES render_jobs(id) ON DELETE SET NULL,
      source_asset_id uuid REFERENCES source_assets(id) ON DELETE SET NULL,
      reviewer_user_id uuid NOT NULL REFERENCES users(id),
      decision text NOT NULL ${checkIn('decision', REVIEW_DECISIONS)},
      reason_codes text[] NOT NULL DEFAULT '{}',
      notes text,
      requested_at timestamptz NOT NULL,
      decided_at timestamptz NOT NULL,
      wait_ms integer GENERATED ALWAYS AS (
        (extract(epoch FROM (decided_at - requested_at)) * 1000)::integer
      ) STORED,
      CONSTRAINT reviews_reject_reasons_rule CHECK (
        decision <> 'reject' OR cardinality(reason_codes) > 0
      )
    )`,
    `CREATE INDEX reviews_job_id_idx ON reviews (job_id)`,
  ]);
}
