import { z } from 'zod';
import type { NormalizedBox } from '@hailiday/core';
import type { Content } from '../../content/load.js';
import type { SourceAsset } from '../../db/schema.js';
import { renderGenericScene } from '../../fixtures/art.js';
import {
  RENDER_SCENARIOS,
  renderScenarioForFileName,
  renderScenarioForPlace,
  type RenderScenario,
} from '../../fixtures/data.js';
import type { FixtureSceneGeometry } from '../../fixtures/scene.js';
import { fixturePanoramaGeometry } from '../../fixtures/street-view.js';
import { framedViewOf } from '../../providers/street-view/framing.js';
import type { FixtureHint, FixtureSceneRef } from '../../providers/types.js';

/**
 * Fixture-only metadata a source asset may carry in `screening.fixture`: the original upload file
 * name (screening and render triggers), a generic scene ID for fixture sources, or an explicit
 * render scenario. Written by the API in fixture mode; live paths ignore it.
 */
export const SourceFixtureMetaSchema = z
  .object({
    fileName: z.string().max(255).optional(),
    sceneId: z.string().max(128).optional(),
    scenario: z.enum(RENDER_SCENARIOS).optional(),
  })
  .partial();
export type SourceFixtureMeta = z.infer<typeof SourceFixtureMetaSchema>;

/** Reads `screening.fixture` from a source asset, tolerating anything malformed. */
export function sourceFixtureMeta(source: Pick<SourceAsset, 'screening'>): SourceFixtureMeta {
  const raw = (source.screening as Record<string, unknown> | null)?.fixture;
  const parsed = SourceFixtureMetaSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Everything fixture providers need about a job's source. */
export interface SourceFixtureContext {
  hint: FixtureHint;
  scenario: RenderScenario;
  scene: FixtureSceneRef | undefined;
  /** Exact geometry of procedurally drawn sources (windows, light sources, attribution). */
  geometry: FixtureSceneGeometry | null;
}

/** Builds the fixture hint for a source (scenario from place data or the upload file name). */
export function fixtureContextFor(
  source: Pick<SourceAsset, 'kind' | 'viewpoint' | 'screening'>,
  content: Content,
  grid: { width: number; height: number },
): SourceFixtureContext {
  const meta = sourceFixtureMeta(source);
  let scene: FixtureSceneRef | undefined;
  let scenario: RenderScenario = 'pass';
  let geometry: FixtureSceneGeometry | null = null;
  const viewpoint = source.viewpoint;
  if (viewpoint && (source.kind === 'street_view' || source.kind === 'fixture')) {
    // The view of the frame the job works on: the framed view once the source was framed.
    const view = framedViewOf(viewpoint);
    scene = {
      kind: 'street_view',
      panoId: view.panoId,
      heading: view.heading,
      fov: view.fov,
      pitch: view.pitch,
    };
    scenario = renderScenarioForPlace({ panoId: view.panoId });
    geometry = fixturePanoramaGeometry(view);
  } else if (source.kind === 'fixture' && meta.sceneId) {
    scene = { kind: 'generic_scene', sceneId: meta.sceneId };
    const params = content.genericScenes[meta.sceneId];
    if (params)
      geometry = renderGenericScene(params, grid.width, grid.height, meta.sceneId).geometry;
  } else {
    scene = { kind: 'upload' };
  }
  if (meta.fileName) scenario = renderScenarioForFileName(meta.fileName);
  if (meta.scenario) scenario = meta.scenario;
  return {
    hint: { scenario, ...(scene ? { scene } : {}), fileName: meta.fileName ?? null },
    scenario,
    scene,
    geometry,
  };
}

/** The embedded attribution rectangle of a Street View-shaped fixture frame, if drawn. */
export function fixtureAttributionRegion(context: SourceFixtureContext): NormalizedBox | null {
  return context.geometry?.attributionRegion ?? null;
}
