import type { Kysely } from 'kysely';
import {
  ANCHOR_CATEGORIES,
  API_ACCESS_STATES,
  AVAILABILITIES,
  HERO_ORIENTATIONS,
  HOLIDAY_IDS,
  KIT_STATUSES,
  LIGHTING_MODES,
  LINK_METHODS,
  MERCHANT_PROGRAM_STATUSES,
  OFFER_LIFECYCLE_STATUSES,
  PACK_VERSION_STATUSES,
  PRICE_SOURCES,
  SCENE_TYPES,
  STYLES,
  VERIFICATION_METHODS,
} from '@hailiday/core';
import {
  ID_CREATED_UPDATED,
  checkIn,
  checkSubset,
  runStatements,
  updatedAtTrigger,
} from '../sql-helpers.js';

const SEMVER = `'^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`;

/** Holiday packs, occurrences, hero and example art, style kits and the commerce catalog. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `CREATE TABLE holiday_pack_versions (
      ${ID_CREATED_UPDATED},
      holiday_id text NOT NULL ${checkIn('holiday_id', HOLIDAY_IDS)},
      region text NOT NULL,
      version text NOT NULL CHECK (version ~ ${SEMVER}),
      major_minor text GENERATED ALWAYS AS (substring(version from '^[0-9]+\\.[0-9]+')) STORED,
      status text NOT NULL ${checkIn('status', PACK_VERSION_STATUSES)},
      content_ref text NOT NULL,
      content_sha256 text NOT NULL,
      review_record jsonb,
      published_at timestamptz,
      retired_at timestamptz,
      UNIQUE (holiday_id, region, version)
    )`,
    updatedAtTrigger('holiday_pack_versions'),
    `CREATE UNIQUE INDEX holiday_pack_versions_one_published_idx ON holiday_pack_versions (holiday_id, region)
      WHERE status = 'published'`,

    `CREATE TABLE hero_assets (
      ${ID_CREATED_UPDATED},
      asset_key text NOT NULL UNIQUE,
      holiday_id text ${checkIn('holiday_id', HOLIDAY_IDS)},
      scene_type text ${checkIn('scene_type', SCENE_TYPES)},
      renditions jsonb NOT NULL,
      alt_text_key text NOT NULL,
      rights jsonb NOT NULL,
      approved_at timestamptz NOT NULL,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_crops text[] NOT NULL ${checkSubset('approved_crops', HERO_ORIENTATIONS)},
      active boolean NOT NULL
    )`,
    updatedAtTrigger('hero_assets'),
    `CREATE INDEX hero_assets_holiday_active_idx ON hero_assets (holiday_id, active)`,

    `CREATE TABLE holiday_occurrences (
      ${ID_CREATED_UPDATED},
      occurrence_key text NOT NULL UNIQUE,
      holiday_id text NOT NULL ${checkIn('holiday_id', HOLIDAY_IDS)},
      region text NOT NULL,
      year integer NOT NULL,
      celebration_start date NOT NULL,
      celebration_end date NOT NULL,
      promotion_start date NOT NULL,
      promotion_end date NOT NULL,
      commerce_start date,
      commerce_end date,
      catalog_retire_at date,
      editorial_priority smallint NOT NULL,
      editorial_timezone text NOT NULL,
      hero_asset_id uuid REFERENCES hero_assets(id) ON DELETE SET NULL,
      pack_version_id uuid REFERENCES holiday_pack_versions(id),
      enabled boolean NOT NULL DEFAULT false,
      reviewed_at timestamptz NOT NULL,
      reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (holiday_id, region, year),
      CONSTRAINT holiday_occurrences_pack_rule CHECK (NOT enabled OR pack_version_id IS NOT NULL),
      CONSTRAINT holiday_occurrences_window_rule CHECK (promotion_start <= promotion_end),
      CONSTRAINT holiday_occurrences_celebration_rule CHECK (celebration_start <= celebration_end)
    )`,
    updatedAtTrigger('holiday_occurrences'),
    `CREATE INDEX holiday_occurrences_window_idx ON holiday_occurrences (region, promotion_start, promotion_end)`,

    `CREATE TABLE example_assets (
      ${ID_CREATED_UPDATED},
      asset_key text NOT NULL UNIQUE,
      holiday_id text NOT NULL ${checkIn('holiday_id', HOLIDAY_IDS)},
      scene_type text NOT NULL ${checkIn('scene_type', SCENE_TYPES)},
      style text NOT NULL ${checkIn('style', STYLES)},
      lighting_mode text NOT NULL ${checkIn('lighting_mode', LIGHTING_MODES)},
      source_asset_id uuid,
      render_asset_id uuid,
      pack_version text NOT NULL CHECK (pack_version ~ ${SEMVER}),
      before_cdn_path text NOT NULL,
      after_cdn_path text NOT NULL,
      width integer NOT NULL CHECK (width > 0),
      height integer NOT NULL CHECK (height > 0),
      caption_key text NOT NULL,
      rights jsonb NOT NULL,
      approved_at timestamptz NOT NULL,
      active boolean NOT NULL
    )`,
    updatedAtTrigger('example_assets'),
    `CREATE UNIQUE INDEX example_assets_active_cell_idx
      ON example_assets (holiday_id, scene_type, style, lighting_mode) WHERE active`,

    `CREATE TABLE style_kits (
      ${ID_CREATED_UPDATED},
      kit_key text NOT NULL,
      holiday_id text NOT NULL ${checkIn('holiday_id', HOLIDAY_IDS)},
      scene_type text NOT NULL ${checkIn('scene_type', SCENE_TYPES)},
      version text NOT NULL CHECK (version ~ ${SEMVER}),
      status text NOT NULL ${checkIn('status', KIT_STATUSES)},
      published_at timestamptz,
      UNIQUE (kit_key, version),
      CONSTRAINT style_kits_key_rule CHECK (kit_key = holiday_id || '.' || scene_type)
    )`,
    updatedAtTrigger('style_kits'),
    `CREATE UNIQUE INDEX style_kits_one_published_idx ON style_kits (kit_key) WHERE status = 'published'`,

    `CREATE TABLE kit_items (
      ${ID_CREATED_UPDATED},
      kit_id uuid NOT NULL REFERENCES style_kits(id) ON DELETE CASCADE,
      kit_item_id text NOT NULL,
      anchor_category text NOT NULL ${checkIn('anchor_category', ANCHOR_CATEGORIES)},
      anchor_categories text[] NOT NULL DEFAULT '{}' ${checkSubset('anchor_categories', ANCHOR_CATEGORIES)},
      spec_text text NOT NULL,
      spec_attributes jsonb NOT NULL,
      style_quantities jsonb NOT NULL,
      sort_order integer NOT NULL,
      current_product_id uuid,
      UNIQUE (kit_id, kit_item_id)
    )`,
    updatedAtTrigger('kit_items'),
    `CREATE INDEX kit_items_kit_id_idx ON kit_items (kit_id)`,
    `CREATE INDEX kit_items_kit_item_id_idx ON kit_items (kit_item_id)`,

    `CREATE TABLE merchant_programs (
      ${ID_CREATED_UPDATED},
      program_key text NOT NULL UNIQUE CHECK (program_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
      display_name text NOT NULL,
      program_type text NOT NULL DEFAULT 'network',
      network text NOT NULL,
      status text NOT NULL ${checkIn('status', MERCHANT_PROGRAM_STATUSES)},
      status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
      applied_at timestamptz,
      approved_at timestamptz,
      ended_at timestamptz,
      required_disclosure_key text,
      disclosure_text text,
      redirect_permitted boolean NOT NULL DEFAULT false,
      link_method text NOT NULL ${checkIn('link_method', LINK_METHODS)},
      sub_id_capability boolean NOT NULL DEFAULT false,
      sub_id_param text,
      tracking_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      api_access text NOT NULL ${checkIn('api_access', API_ACCESS_STATES)},
      attribution_window_hours integer CHECK (attribution_window_hours > 0),
      commission_schedule jsonb NOT NULL DEFAULT '[]'::jsonb,
      policy_version text,
      reviewed_at timestamptz,
      logo_permitted boolean NOT NULL DEFAULT false,
      notes text,
      capability_key text GENERATED ALWAYS AS ('commerce:' || program_key) STORED
    )`,
    updatedAtTrigger('merchant_programs'),

    `CREATE TABLE products (
      ${ID_CREATED_UPDATED},
      product_key text NOT NULL UNIQUE,
      kit_item_id uuid REFERENCES kit_items(id) ON DELETE SET NULL,
      kit_item_keys text[] NOT NULL DEFAULT '{}',
      our_title text NOT NULL,
      our_description text NOT NULL,
      category text NOT NULL,
      spec_attributes jsonb NOT NULL,
      notes text,
      archived_at timestamptz
    )`,
    updatedAtTrigger('products'),
    `CREATE INDEX products_kit_item_id_idx ON products (kit_item_id)`,

    `ALTER TABLE kit_items ADD CONSTRAINT kit_items_current_product_id_fkey
      FOREIGN KEY (current_product_id) REFERENCES products(id) ON DELETE SET NULL`,

    `CREATE TABLE offers (
      ${ID_CREATED_UPDATED},
      offer_key text NOT NULL UNIQUE,
      product_id uuid NOT NULL REFERENCES products(id),
      merchant_program_id uuid NOT NULL REFERENCES merchant_programs(id),
      merchant_item_id text NOT NULL,
      destination_country char(2) NOT NULL,
      currency char(3) NOT NULL,
      price_minor integer CHECK (price_minor >= 0),
      price_source text NOT NULL DEFAULT 'none' ${checkIn('price_source', PRICE_SOURCES)},
      price_observed_at timestamptz,
      availability text ${checkIn('availability', AVAILABILITIES)},
      availability_checked_at timestamptz,
      destination_url text NOT NULL CHECK (destination_url ~ '^https://'),
      tracking_url_template text,
      content_rights jsonb NOT NULL,
      status text NOT NULL ${checkIn('status', OFFER_LIFECYCLE_STATUSES)},
      seasonal_eligibility text[] NOT NULL DEFAULT '{}',
      sponsored boolean NOT NULL DEFAULT false,
      last_verified_at timestamptz,
      verification_method text ${checkIn('verification_method', VERIFICATION_METHODS)},
      verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
      notes text,
      UNIQUE (merchant_program_id, merchant_item_id, destination_country),
      CONSTRAINT offers_price_observed_rule CHECK (
        price_minor IS NULL OR price_source = 'none' OR price_observed_at IS NOT NULL
      )
    )`,
    updatedAtTrigger('offers'),
    `CREATE INDEX offers_product_id_idx ON offers (product_id)`,
    `CREATE INDEX offers_status_idx ON offers (status)`,
  ]);
}
