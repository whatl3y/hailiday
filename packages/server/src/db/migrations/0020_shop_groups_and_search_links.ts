import type { Kysely } from 'kysely';
import {
  ANCHOR_CATEGORIES,
  HOLIDAY_IDS,
  LINK_MODES,
  LOOK_ITEM_STATUSES,
  PRODUCT_RELATIONSHIPS,
  PROGRAM_KINDS,
  PROGRAM_PLACEMENTS,
  SCENE_TYPES,
  SHOP_GROUP_BASES,
  SHOP_LINK_KINDS,
  STYLES,
} from '@hailiday/core';
import { ID_CREATED_UPDATED, checkIn, runStatements, updatedAtTrigger } from '../sql-helpers.js';

/** The columns this migration adds to `merchant_programs`, dropped on the way down. */
const PROGRAM_COLUMNS = [
  'kind',
  'placement',
  'search_url_template',
  'tracking_link_template',
  'display_rights',
  'refresh_term_hours',
] as const;

/** The columns this migration adds to `affiliate_clicks`, dropped on the way down. */
const CLICK_COLUMNS = [
  'shop_target_id',
  'link_kind',
  'group_basis',
  'group_key',
  'group_position',
  'option_position',
] as const;

/** `https://`, a literal host with an optional port, then `/`, as a Postgres regular expression. */
const LITERAL_HTTPS_ORIGIN = String.raw`^https://[A-Za-z0-9.-]+(:[0-9]+)?/`;

/**
 * The search pattern rule: `https://` and a literal host followed by `/`, a `{query}`
 * placeholder, no tracking placeholder and no affiliate parameter. `isSearchUrlTemplate` in
 * `content/load.ts` applies the same rule; keep the two in step.
 */
const SEARCH_URL_TEMPLATE_CHECK = `search_url_template IS NULL OR (
          search_url_template ~ '${LITERAL_HTTPS_ORIGIN}'
          AND position('{query}' in search_url_template) > 0
          AND position('{subId}' in search_url_template) = 0
          AND position('{trackingId}' in search_url_template) = 0
          AND position('{destinationUrl}' in search_url_template) = 0
          AND search_url_template !~* '[?&](tag|subid|sid|u1)=')`;

/**
 * The tracking pattern rule: it holds `{destinationUrl}` and starts either with that placeholder
 * or with `https://` and a literal host followed by `/`. `isTrackingLinkTemplate` in
 * `content/load.ts` applies the same rule; keep the two in step.
 */
const TRACKING_LINK_TEMPLATE_CHECK = `tracking_link_template IS NULL OR (
          position('{destinationUrl}' in tracking_link_template) > 0
          AND (left(tracking_link_template, 16) = '{destinationUrl}'
            OR tracking_link_template ~ '${LITERAL_HTTPS_ORIGIN}'))`;

/**
 * Shop the look by decoration: a merchant program records whether it is example data or an actual
 * retailer (`kind`), where its links sit (`placement`), the pattern of a link to its own search
 * results (`search_url_template`, with a `{query}` placeholder), its program-level tracking link
 * pattern, what its terms allow per use (`display_rights`) and how long its data may be kept
 * before a refresh. The words sent to a retailer's search are operator-editable data: one phrase
 * per kit item key (`kit_item_search_phrases`) and one on each look item (`look_items`, the
 * decorations typical of a look that no kit item covers). Every option or link shown for a
 * rendering is a shop target (`render_shop_targets`, gone with its rendering); a click names the
 * shop target it came from, keeps no offer or relationship for a search link, and keeps its row
 * when the shop target goes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `ALTER TABLE merchant_programs
      ADD COLUMN kind text NOT NULL DEFAULT 'fixture' ${checkIn('kind', PROGRAM_KINDS)},
      ADD COLUMN placement text NOT NULL DEFAULT 'group' ${checkIn('placement', PROGRAM_PLACEMENTS)},
      ADD COLUMN search_url_template text CHECK (${SEARCH_URL_TEMPLATE_CHECK}),
      ADD COLUMN tracking_link_template text CHECK (${TRACKING_LINK_TEMPLATE_CHECK}),
      ADD COLUMN display_rights jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN refresh_term_hours integer CHECK (refresh_term_hours > 0)`,

    `CREATE TABLE kit_item_search_phrases (
      ${ID_CREATED_UPDATED},
      kit_item_key text NOT NULL UNIQUE,
      phrase text NOT NULL CHECK (char_length(phrase) BETWEEN 2 AND 120),
      program_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL
    )`,
    updatedAtTrigger('kit_item_search_phrases'),

    `CREATE TABLE look_items (
      ${ID_CREATED_UPDATED},
      look_item_key text NOT NULL UNIQUE CHECK (look_item_key ~ '^[a-z0-9][a-z0-9_.-]{0,127}$'),
      holiday_id text NOT NULL ${checkIn('holiday_id', HOLIDAY_IDS)},
      scene_type text NOT NULL ${checkIn('scene_type', SCENE_TYPES)},
      style text NOT NULL ${checkIn('style', STYLES)},
      our_title text NOT NULL CHECK (char_length(our_title) BETWEEN 2 AND 120),
      anchor_category text ${checkIn('anchor_category', ANCHOR_CATEGORIES)},
      search_phrase text NOT NULL CHECK (char_length(search_phrase) BETWEEN 2 AND 120),
      program_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
      sort_order integer NOT NULL,
      status text NOT NULL DEFAULT 'active' ${checkIn('status', LOOK_ITEM_STATUSES)},
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL
    )`,
    updatedAtTrigger('look_items'),
    `CREATE INDEX look_items_look_idx ON look_items (holiday_id, scene_type, style)
      WHERE status = 'active'`,

    `CREATE TABLE render_shop_targets (
      ${ID_CREATED_UPDATED},
      render_asset_id uuid NOT NULL REFERENCES render_assets(id) ON DELETE CASCADE,
      target_key text NOT NULL,
      link_kind text NOT NULL ${checkIn('link_kind', SHOP_LINK_KINDS)},
      group_basis text NOT NULL ${checkIn('group_basis', SHOP_GROUP_BASES)},
      group_key text NOT NULL,
      render_product_link_id uuid REFERENCES render_product_links(id) ON DELETE SET NULL,
      look_item_id uuid REFERENCES look_items(id) ON DELETE SET NULL,
      offer_id uuid REFERENCES offers(id) ON DELETE SET NULL,
      merchant_program_id uuid NOT NULL REFERENCES merchant_programs(id),
      link_mode text NOT NULL ${checkIn('link_mode', LINK_MODES)},
      placement text NOT NULL ${checkIn('placement', PROGRAM_PLACEMENTS)},
      relationship text ${checkIn('relationship', PRODUCT_RELATIONSHIPS)},
      group_position smallint NOT NULL,
      option_position smallint NOT NULL,
      sponsored boolean NOT NULL DEFAULT false,
      last_shown_at timestamptz NOT NULL,
      UNIQUE (render_asset_id, target_key)
    )`,
    updatedAtTrigger('render_shop_targets'),
    `CREATE INDEX render_shop_targets_render_product_link_id_idx
      ON render_shop_targets (render_product_link_id) WHERE render_product_link_id IS NOT NULL`,
    `CREATE INDEX render_shop_targets_offer_id_idx ON render_shop_targets (offer_id)
      WHERE offer_id IS NOT NULL`,
    `CREATE INDEX render_shop_targets_look_item_id_idx ON render_shop_targets (look_item_id)
      WHERE look_item_id IS NOT NULL`,

    `ALTER TABLE affiliate_clicks
      ALTER COLUMN offer_id DROP NOT NULL,
      ALTER COLUMN relationship DROP NOT NULL,
      ADD COLUMN shop_target_id uuid REFERENCES render_shop_targets(id) ON DELETE SET NULL,
      ADD COLUMN link_kind text NOT NULL DEFAULT 'product' ${checkIn('link_kind', SHOP_LINK_KINDS)},
      ADD COLUMN group_basis text NOT NULL DEFAULT 'placed' ${checkIn('group_basis', SHOP_GROUP_BASES)},
      ADD COLUMN group_key text,
      ADD COLUMN group_position smallint,
      ADD COLUMN option_position smallint`,
    `CREATE INDEX affiliate_clicks_shop_target_id_idx ON affiliate_clicks (shop_target_id)
      WHERE shop_target_id IS NOT NULL`,
  ]);
}

/**
 * Drops the shop targets, look items and search phrases and the new program and click columns.
 * A click's offer and relationship become required again only when no stored click lacks them
 * (a click on a search link has neither); otherwise they stay optional, so those clicks are kept.
 * The program rows of kind `real` are kept, so after a down and an up outside a local
 * environment their `kind`, `placement` and search pattern have to be restored by hand (a local
 * seed restores them).
 */
export async function down(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `DROP INDEX IF EXISTS affiliate_clicks_shop_target_id_idx`,
    `ALTER TABLE affiliate_clicks ${CLICK_COLUMNS.map((column) => `DROP COLUMN IF EXISTS ${column}`).join(', ')}`,
    ...(['offer_id', 'relationship'] as const).map(
      (column) => `DO $$
        BEGIN
          ALTER TABLE affiliate_clicks ALTER COLUMN ${column} SET NOT NULL;
        EXCEPTION WHEN not_null_violation THEN
          RAISE NOTICE 'affiliate_clicks.${column} stays optional: stored clicks have none';
        END $$`,
    ),
    `DROP TABLE IF EXISTS render_shop_targets`,
    `DROP TABLE IF EXISTS look_items`,
    `DROP TABLE IF EXISTS kit_item_search_phrases`,
    `ALTER TABLE merchant_programs ${PROGRAM_COLUMNS.map((column) => `DROP COLUMN IF EXISTS ${column}`).join(', ')}`,
  ]);
}
