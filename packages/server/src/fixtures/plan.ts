import { isAnchorEligible } from '@holiday/core';
import type {
  Anchor,
  HolidayId,
  HolidayPack,
  LightingMode,
  NormalizedBox,
  SceneType,
  Style,
  StyleKit,
} from '@holiday/core';
import type { FixturePlacement } from './decor.js';
import type { FixtureSceneGeometry } from './scene.js';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Derives a placement region from an anchor box by placement rule. */
export function regionFor(rule: string, box: NormalizedBox): NormalizedBox {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  switch (rule) {
    case 'beside':
      return [clamp01(x0 - w * 0.6), y0, clamp01(x1 + w * 0.6), y1];
    case 'hang_from':
      return [x0, y0, x1, clamp01(y1 + Math.max(h, 0.14))];
    default:
      return box;
  }
}

/**
 * A simple deterministic placement list from pack content and exact scene geometry, used to
 * produce example and hero art in fixture mode (the production plan builder belongs to the
 * render pipeline). Kit items included for the style take eligible anchors of their categories
 * in kit priority order, within the section's placement cap.
 */
export function fixturePlacements(input: {
  pack: HolidayPack;
  kit?: StyleKit | null;
  holidayId: HolidayId;
  sceneType: SceneType;
  style: Style;
  lightingMode: LightingMode;
  geometry: FixtureSceneGeometry;
}): FixturePlacement[] {
  const section = input.pack.sceneSections[input.sceneType];
  if (!section) return [];
  let allowed = new Set<string>(section.anchors);
  const form = input.geometry.buildingForm;
  if (form && section.formRules?.[form]) {
    for (const excluded of section.formRules[form].excludeAnchors) allowed.delete(excluded);
  }
  const room = input.geometry.roomType;
  if (room && section.roomRules?.[room]) allowed = new Set(section.roomRules[room].anchors);
  const eligible = input.geometry.anchors.filter(
    (anchor) => allowed.has(anchor.category) && isAnchorEligible(anchor),
  );
  const used = new Map<string, number>();
  const placements: FixturePlacement[] = [];
  const cap = section.limits.maxPlacements[input.style];
  const litByItem = new Map(
    (input.kit?.items ?? []).map((item) => [item.kitItemId, item.specAttributes.lit]),
  );
  const noOutdoorLights = input.holidayId === 'thanksgiving_us' && input.sceneType !== 'interior';
  for (const item of section.kit) {
    if (placements.length >= cap) break;
    const [, max] = item.quantity[input.style];
    if (max <= 0) continue;
    const candidates: Anchor[] = [];
    for (const category of item.anchors) {
      for (const anchor of eligible) if (anchor.category === category) candidates.push(anchor);
    }
    if (candidates.length === 0) continue;
    // Runs (lights, garland) and centered items take one anchor each; groups stay together.
    const perAnchor = item.placementRule === 'along' || item.placementRule === 'centered_on';
    const distinct = candidates.filter((anchor) => (used.get(anchor.id) ?? 0) === 0);
    const pool = distinct.length > 0 ? distinct : candidates;
    const targets = perAnchor
      ? pool.slice(0, Math.max(1, Math.min(max, cap - placements.length)))
      : candidates.slice(0, 1);
    for (const anchor of targets) {
      used.set(anchor.id, (used.get(anchor.id) ?? 0) + 1);
      placements.push({
        id: `p${placements.length + 1}`,
        kitItemId: item.kitItemId,
        anchorCategory: anchor.category,
        region: regionFor(item.placementRule, anchor.box),
        placementRule: item.placementRule,
        count: perAnchor ? 1 : Math.max(1, max),
        lit: Boolean(litByItem.get(item.kitItemId)) && !noOutdoorLights,
        specText: item.specText,
        archetype: item.archetype,
      });
    }
  }
  return placements;
}
