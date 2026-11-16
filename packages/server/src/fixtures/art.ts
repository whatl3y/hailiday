import type { HolidayId, LightingMode, SceneType, Style } from '@hailiday/core';
import type { Content } from '../content/load.js';
import { decorateImage } from './compositor.js';
import {
  renderApartmentEntry,
  renderBalcony,
  type BalconyParams,
  type EntryParams,
} from './entry.js';
import { fixturePlacements } from './plan.js';
import { renderRoom, type RoomParams } from './room.js';
import type { FixtureSceneGeometry, RenderedScene } from './scene.js';

/**
 * Renders a generic scene from `examples.json` (`room`, `entry` or `balcony` parameters). Generic
 * scenes are test fixtures for fixture-kind sources; they are never shown as product art.
 */
export function renderGenericScene(
  scene: Record<string, unknown>,
  width: number,
  height: number,
  seed: string,
): RenderedScene {
  if (scene.room) {
    return renderRoom({ room: scene.room as RoomParams, width, height, seed });
  }
  if (scene.entry) {
    return renderApartmentEntry({ entry: scene.entry as EntryParams, width, height, seed });
  }
  if (scene.balcony) {
    return renderBalcony({ balcony: scene.balcony as BalconyParams, width, height, seed });
  }
  throw new Error('Generic scene has no room, entry or balcony parameters');
}

/**
 * Decorates a frame with the fixture compositor from the holiday's pack and kit, placing items on
 * the frame's exact geometry (samples and tests; the render pipeline plans its own placements).
 */
export async function decorateFrame(input: {
  base: Buffer;
  geometry: FixtureSceneGeometry;
  content: Content;
  holidayId: HolidayId;
  sceneType: SceneType;
  style: Style;
  lightingMode: LightingMode;
  seed: string;
  format?: 'jpeg' | 'png';
  quality?: number;
}): Promise<Buffer> {
  const pack = input.content.packFor(input.holidayId)?.pack;
  if (!pack) throw new Error(`No pack for ${input.holidayId}`);
  const placements = fixturePlacements({
    pack,
    kit: input.content.kitFor(input.holidayId, input.sceneType)?.kit ?? null,
    holidayId: input.holidayId,
    sceneType: input.sceneType,
    style: input.style,
    lightingMode: input.lightingMode,
    geometry: input.geometry,
  });
  const result = await decorateImage({
    image: input.base,
    holidayId: input.holidayId,
    style: input.style,
    lightingMode: input.lightingMode,
    sceneType: input.sceneType,
    placements,
    windows: input.geometry.windows,
    lightSources: input.geometry.lightSources,
    preserveRegions: input.geometry.preserveRegions.map((region) => region.box),
    accessRegions: input.geometry.accessRegions
      .filter((region) => region.kind !== 'door')
      .map((region) => region.box),
    referenceDoor:
      input.geometry.anchors.find((anchor) => anchor.category === 'front_door')?.box ?? null,
    targetFacade: input.geometry.targetFacade ?? null,
    attributionRegion: input.geometry.attributionRegion ?? null,
    seed: input.seed,
    format: input.format ?? 'jpeg',
    quality: input.quality ?? 90,
  });
  return result.image;
}
