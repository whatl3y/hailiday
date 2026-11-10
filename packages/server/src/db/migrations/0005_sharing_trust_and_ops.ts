import type { Kysely } from 'kysely';
import {
  ADHERENCE_STATUSES,
  AFFILIATE_CONVERSION_STATUSES,
  ANALYTICS_EMITTERS,
  ANALYTICS_EVENT_NAMES,
  DELETION_REQUESTERS,
  DELETION_SCOPES,
  DELETION_STATUSES,
  FEEDBACK_REASONS,
  FEEDBACK_VERDICTS,
  LINK_MODES,
  PRODUCT_RELATIONSHIPS,
  REPORT_PRIORITIES,
  REPORT_REASONS,
  REPORT_STATUSES,
  REPORT_TARGET_KINDS,
  TOMBSTONE_KINDS,
} from '@holiday/core';
import {
  ID_AND_CREATED,
  ID_CREATED_UPDATED,
  checkIn,
  checkSubset,
  runStatements,
  updatedAtTrigger,
} from '../sql-helpers.js';

/** Shop the look links and clicks, conversions, shares, feedback, reports, deletion, analytics. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `CREATE TABLE render_product_links (
      ${ID_CREATED_UPDATED},
      render_asset_id uuid NOT NULL REFERENCES render_assets(id) ON DELETE CASCADE,
      kit_item_id uuid NOT NULL REFERENCES kit_items(id),
      product_id uuid NOT NULL REFERENCES products(id),
      placement_ref text,
      relationship text NOT NULL ${checkIn('relationship', PRODUCT_RELATIONSHIPS)},
      adherence_status text NOT NULL ${checkIn('adherence_status', ADHERENCE_STATUSES)},
      adherence_check jsonb,
      rank_position smallint NOT NULL,
      chosen_offer_id uuid REFERENCES offers(id) ON DELETE SET NULL,
      link_mode text ${checkIn('link_mode', LINK_MODES)},
      candidate_offer_ids uuid[],
      ranking_reason text,
      ranked_at timestamptz,
      sponsored boolean NOT NULL DEFAULT false,
      hidden_at timestamptz,
      hidden_reason text,
      UNIQUE (render_asset_id, kit_item_id),
      CONSTRAINT render_product_links_described_rule CHECK (
        relationship <> 'described' OR adherence_status = 'pass'
      )
    )`,
    updatedAtTrigger('render_product_links'),

    `CREATE TABLE affiliate_clicks (
      ${ID_AND_CREATED},
      click_token text NOT NULL UNIQUE,
      render_product_link_id uuid REFERENCES render_product_links(id) ON DELETE SET NULL,
      offer_id uuid NOT NULL REFERENCES offers(id),
      merchant_program_id uuid NOT NULL REFERENCES merchant_programs(id),
      link_mode text NOT NULL ${checkIn('link_mode', LINK_MODES)},
      sent_sub_id text,
      tracking_id text,
      relationship text NOT NULL ${checkIn('relationship', PRODUCT_RELATIONSHIPS)},
      rank_position smallint NOT NULL,
      holiday_id text NOT NULL,
      occurrence_key text NOT NULL,
      scene_type text NOT NULL,
      source_kind text NOT NULL,
      acquisition_channel text,
      session_hash text NOT NULL,
      country_code char(2) NOT NULL
    )`,
    `CREATE INDEX affiliate_clicks_program_created_idx ON affiliate_clicks (merchant_program_id, created_at)`,
    `CREATE INDEX affiliate_clicks_sent_sub_id_idx ON affiliate_clicks (sent_sub_id)`,

    `CREATE TABLE affiliate_conversions (
      ${ID_CREATED_UPDATED},
      merchant_program_id uuid NOT NULL REFERENCES merchant_programs(id),
      sent_sub_id text,
      tracking_id text,
      order_at timestamptz NOT NULL,
      reported_at timestamptz NOT NULL,
      commission_amount_minor integer NOT NULL,
      currency char(3) NOT NULL,
      status text NOT NULL ${checkIn('status', AFFILIATE_CONVERSION_STATUSES)},
      report_ref text NOT NULL,
      UNIQUE (merchant_program_id, report_ref)
    )`,
    updatedAtTrigger('affiliate_conversions'),
    `CREATE INDEX affiliate_conversions_program_order_idx ON affiliate_conversions (merchant_program_id, order_at)`,
    `CREATE INDEX affiliate_conversions_sent_sub_id_idx ON affiliate_conversions (sent_sub_id)`,

    `CREATE TABLE share_grants (
      ${ID_CREATED_UPDATED},
      owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      render_asset_id uuid NOT NULL REFERENCES render_assets(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      include_before boolean NOT NULL DEFAULT false,
      idempotency_key text,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      view_count integer NOT NULL DEFAULT 0,
      last_viewed_at timestamptz,
      share_card_object_key text,
      UNIQUE (owner_id, idempotency_key)
    )`,
    updatedAtTrigger('share_grants'),
    `CREATE INDEX share_grants_owner_id_idx ON share_grants (owner_id)`,
    `CREATE INDEX share_grants_render_asset_id_idx ON share_grants (render_asset_id)`,
    `CREATE INDEX share_grants_expires_at_idx ON share_grants (expires_at)`,

    `CREATE TABLE feedback (
      ${ID_AND_CREATED},
      owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
      render_asset_id uuid REFERENCES render_assets(id) ON DELETE SET NULL,
      job_id uuid REFERENCES render_jobs(id) ON DELETE SET NULL,
      verdict text NOT NULL ${checkIn('verdict', FEEDBACK_VERDICTS)},
      reasons text[] NOT NULL DEFAULT '{}' ${checkSubset('reasons', FEEDBACK_REASONS)},
      note text CHECK (char_length(note) <= 500),
      holiday_id text NOT NULL,
      scene_type text NOT NULL,
      source_kind text NOT NULL,
      idempotency_key text,
      UNIQUE (owner_id, idempotency_key)
    )`,
    `CREATE INDEX feedback_owner_id_idx ON feedback (owner_id)`,

    `CREATE TABLE reports (
      ${ID_CREATED_UPDATED},
      reporter_owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
      reporter_contact_email text,
      target_kind text NOT NULL ${checkIn('target_kind', REPORT_TARGET_KINDS)},
      target_id uuid,
      target_share_token_hash text,
      target_place_id text,
      address_text text,
      reason text NOT NULL ${checkIn('reason', REPORT_REASONS)},
      details text CHECK (char_length(details) <= 2000),
      request_opt_out boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'open' ${checkIn('status', REPORT_STATUSES)},
      priority text NOT NULL DEFAULT 'normal' ${checkIn('priority', REPORT_PRIORITIES)},
      assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      resolution jsonb,
      preservation_hold_id uuid REFERENCES preservation_holds(id),
      acknowledged_at timestamptz,
      resolved_at timestamptz,
      ip_hash text,
      CONSTRAINT reports_address_reason_rule CHECK (
        target_kind <> 'address' OR reason = 'this_is_my_home'
      ),
      CONSTRAINT reports_child_priority_rule CHECK (
        reason <> 'child_pictured' OR priority = 'urgent'
      )
    )`,
    updatedAtTrigger('reports'),
    `CREATE INDEX reports_status_created_idx ON reports (status, created_at)`,

    `ALTER TABLE blocked_addresses ADD CONSTRAINT blocked_addresses_report_id_fkey
      FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE SET NULL`,

    `CREATE TABLE deletion_requests (
      ${ID_CREATED_UPDATED},
      owner_id uuid REFERENCES owners(id) ON DELETE SET NULL,
      scope text NOT NULL ${checkIn('scope', DELETION_SCOPES)},
      target_id uuid NOT NULL,
      requested_by text NOT NULL ${checkIn('requested_by', DELETION_REQUESTERS)},
      access_revoked_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'pending' ${checkIn('status', DELETION_STATUSES)},
      receipt jsonb NOT NULL DEFAULT '[]'::jsonb,
      provider_deletion jsonb,
      completed_at timestamptz,
      verified_at timestamptz
    )`,
    updatedAtTrigger('deletion_requests'),
    `CREATE INDEX deletion_requests_status_idx ON deletion_requests (status)`,

    `CREATE TABLE tombstones (
      ${ID_AND_CREATED},
      kind text NOT NULL ${checkIn('kind', TOMBSTONE_KINDS)},
      hash_sha256 text NOT NULL,
      deletion_request_id uuid REFERENCES deletion_requests(id) ON DELETE SET NULL,
      deleted_at timestamptz NOT NULL,
      retain_until timestamptz NOT NULL,
      UNIQUE (kind, hash_sha256)
    )`,
    `CREATE INDEX tombstones_retain_until_idx ON tombstones (retain_until)`,

    `CREATE TABLE analytics_events (
      ${ID_AND_CREATED},
      event_name text NOT NULL ${checkIn('event_name', ANALYTICS_EVENT_NAMES)},
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL,
      session_hash text NOT NULL,
      emitter text NOT NULL ${checkIn('emitter', ANALYTICS_EMITTERS)},
      properties jsonb NOT NULL,
      holiday_id text,
      scene_type text,
      source_kind text,
      country_code char(2) NOT NULL,
      app_version text NOT NULL
    )`,
    `CREATE INDEX analytics_events_name_occurred_idx ON analytics_events (event_name, occurred_at)`,

    `CREATE TABLE fixture_emails (
      ${ID_AND_CREATED},
      to_address text NOT NULL,
      from_address text NOT NULL,
      subject text NOT NULL,
      text_body text NOT NULL,
      html_body text,
      tag text,
      message_id text NOT NULL
    )`,
    `CREATE INDEX fixture_emails_to_created_idx ON fixture_emails (to_address, created_at)`,
  ]);
}
