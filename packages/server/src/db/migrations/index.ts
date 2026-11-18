import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_foundation.js';
import * as m0002 from './0002_places_and_sources.js';
import * as m0003 from './0003_content_and_commerce.js';
import * as m0004 from './0004_rendering_and_spend.js';
import * as m0005 from './0005_sharing_trust_and_ops.js';
import * as m0006 from './0006_property_geometry.js';
import * as m0007 from './0007_allowance_residue.js';
import * as m0008 from './0008_holds_and_tombstone_mirror.js';
import * as m0009 from './0009_usage_and_fallback.js';
import * as m0010 from './0010_session_gpc.js';
import * as m0011 from './0011_attempt_repair_flag.js';
import * as m0012 from './0012_project_look_defaults.js';
import * as m0013 from './0013_bright_lighting.js';
import * as m0014 from './0014_three_attempt_relights.js';
import * as m0015 from './0015_keep_every_rendering.js';
import * as m0016 from './0016_street_view_template_mark.js';
import * as m0017 from './0017_display_load_window.js';
import * as m0018 from './0018_street_view_enhancement.js';
import * as m0019 from './0019_framing_sub_stage.js';
import * as m0020 from './0020_shop_groups_and_search_links.js';

/**
 * Every migration, in order. A static registry (no filesystem scanning) so the compiled release
 * image runs exactly the migrations it was built with. Names never change once released; new
 * migrations are appended with the next number. Migrations are expand-and-contract so the
 * previous release keeps working on the new schema.
 */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  '0001_foundation': m0001,
  '0002_places_and_sources': m0002,
  '0003_content_and_commerce': m0003,
  '0004_rendering_and_spend': m0004,
  '0005_sharing_trust_and_ops': m0005,
  '0006_property_geometry': m0006,
  '0007_allowance_residue': m0007,
  '0008_holds_and_tombstone_mirror': m0008,
  '0009_usage_and_fallback': m0009,
  '0010_session_gpc': m0010,
  '0011_attempt_repair_flag': m0011,
  '0012_project_look_defaults': m0012,
  '0013_bright_lighting': m0013,
  '0014_three_attempt_relights': m0014,
  '0015_keep_every_rendering': m0015,
  '0016_street_view_template_mark': m0016,
  '0017_display_load_window': m0017,
  '0018_street_view_enhancement': m0018,
  '0019_framing_sub_stage': m0019,
  '0020_shop_groups_and_search_links': m0020,
};
