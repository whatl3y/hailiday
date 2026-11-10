import type { AnchorCategory, NormalizedBox, PlacementRule } from '@holiday/core';

/** A planned placement as the compositor needs it (a subset of `DecorationPlan.placements`). */
export interface FixturePlacement {
  id: string;
  kitItemId: string;
  anchorCategory: AnchorCategory;
  region: NormalizedBox;
  placementRule: PlacementRule;
  count: number;
  lit: boolean;
  specText?: string;
  archetype?: string | null;
}
