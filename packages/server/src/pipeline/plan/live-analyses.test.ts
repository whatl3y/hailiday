import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  anchorCategoriesForSceneType,
  effectiveSectionAnchors,
  type Anchor,
  type HolidayId,
  type HolidayPack,
  type LightingMode,
  type MaskShape,
  type NormalizedBox,
  type SceneAnalysis,
  type SceneType,
  type Style,
} from '@holiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { ANCHOR_GLOSSES, analysisUserPrompt } from '../../providers/vision/prompts.js';
import {
  buildCompositeMask,
  compositeProtection,
  dilationHang,
  placementMaskShapes,
} from '../imaging/mask.js';
import { toRect } from '../imaging/raster.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { buildPlan } from './builder.js';
import {
  PLACEMENT_GEOMETRY,
  WINDOW_ANCHORS,
  garlandDrapeFor,
  placementGeometry,
} from './geometry.js';
import { rasterizeShapes } from './shapes.js';
import type { BuiltPlan } from './types.js';

/** Real Claude scene analyses of the example photographs (recorded from live runs). */
function liveAnalysis(name: string): SceneAnalysis {
  const file = new URL(`./testdata/live-analyses/${name}.json`, import.meta.url);
  return (JSON.parse(readFileSync(file, 'utf8')) as { analysis: SceneAnalysis }).analysis;
}

let content: Content;
beforeAll(async () => {
  content = await loadContent();
});

function plan(
  analysis: SceneAnalysis,
  holidayId: HolidayId,
  options: { style?: Style; lightingMode?: LightingMode } = {},
): BuiltPlan {
  const pack = content.packFor(holidayId);
  if (!pack) throw new Error(holidayId);
  return buildPlan({
    renderJobId: 'job',
    planVersion: 1,
    sourceAssetId: 'sa',
    sceneAnalysisId: 'an',
    analysis,
    sourceKind: 'upload',
    pack: pack.pack,
    holidayPackVersion: pack.version,
    styleKitVersionId: 'kit',
    sceneType: analysis.sceneType,
    buildingForm: analysis.buildingForm ?? null,
    roomType: analysis.roomType ?? null,
    style: options.style ?? 'classic',
    lightingMode: options.lightingMode ?? 'source',
    compilerVersion: 'test-1',
    permissionEvaluationId: 'pe',
  });
}

/** The composite mask the render job builds for a plan (default dilation and feather). */
function jobMask(analysis: SceneAnalysis, built: BuiltPlan) {
  const { width, height } = analysis.workingImage;
  const protection = compositeProtection(
    analysis,
    built.draft.placements,
    dilationHang(PIPELINE_DEFAULTS.dilationFraction, width, height),
  );
  return buildCompositeMask({
    width,
    height,
    shapes: placementMaskShapes(built.draft.placements),
    dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
    featherFraction: PIPELINE_DEFAULTS.featherFraction,
    exclusions: [
      ...analysis.preserveRegions
        .filter((region) => ['house_number', 'sign', 'logo'].includes(region.kind))
        .map((region) => region.box),
      ...protection.exclusions,
    ],
    access: protection.keepOuts,
  });
}

const coverage = (plane: Uint8Array) =>
  plane.reduce((sum, v) => sum + (v ? 1 : 0), 0) / plane.length;

const at = (plane: Uint8Array, width: number, height: number, x: number, y: number) =>
  plane[Math.floor(y * height) * width + Math.floor(x * width)];

describe('tight placement geometry on real analyses', () => {
  it('keeps the bungalow mask tight: shapes within the cap, the composite far below the old regions', () => {
    const analysis = liveAnalysis('christmas.house_exterior.classic.source');
    const built = plan(analysis, 'christmas');
    expect(built.validator.passed).toBe(true);
    const { width, height } = analysis.workingImage;
    const shapes = rasterizeShapes(placementMaskShapes(built.draft.placements), width, height);
    expect(coverage(shapes)).toBeLessThanOrEqual(PLACEMENT_GEOMETRY.sourceMaskCap);
    expect(built.draft.maskBudget?.coverage).toBeLessThanOrEqual(0.25);
    // Whole roof planes were editable before (the composite covered about half the frame);
    // with bands only the dilated band around each edge is.
    expect(coverage(jobMask(analysis, built).hard)).toBeLessThan(0.3);
    // The main roof plane's lights: a band at its bottom (eave) edge, clipped to the facade.
    const roofPlane = built.draft.placements.find((p) => p.anchorId === 'roofline_main');
    expect(roofPlane?.maskShapes).toEqual([{ kind: 'box', box: [0.09, 0.585, 0.95, 0.615] }]);
    // The middle of the main roof plane is not editable.
    expect(at(jobMask(analysis, built).hard, width, height, 0.25, 0.46)).toBe(0);
  });

  it('protects window interiors below a top band', () => {
    for (const [name, holidayId] of [
      ['christmas.house_exterior.classic.source', 'christmas'],
      ['christmas.interior.classic.source', 'christmas'],
      ['thanksgiving_us.interior.classic.source', 'thanksgiving_us'],
      ['halloween.house_exterior.classic.source', 'halloween'],
    ] as const) {
      const analysis = liveAnalysis(name);
      const built = plan(analysis, holidayId);
      const { width, height } = analysis.workingImage;
      const mask = jobMask(analysis, built);
      const anchored = new Set(built.draft.placements.map((p) => p.anchorId));
      // A window carrying its own garland may show it hanging into the dilation band below.
      const hang = (PIPELINE_DEFAULTS.dilationFraction * Math.max(width, height)) / height;
      for (const anchor of analysis.anchors.filter((a) => WINDOW_ANCHORS.includes(a.category))) {
        const [x0, y0, x1, y1] = anchor.box;
        // The top band: the garland drape, or a quarter of a tall (close) window's height.
        const drape = Math.max(
          PLACEMENT_GEOMETRY.garlandDrape,
          PLACEMENT_GEOMETRY.windowDrapeShare * (y1 - y0),
        );
        const band = drape + (anchored.has(anchor.id) ? hang : 0);
        if (y0 + band >= y1) continue;
        const interior = toRect([x0, y0 + band, x1, y1], width, height);
        let editable = 0;
        for (let y = interior.y0; y < interior.y1; y += 1) {
          for (let x = interior.x0; x < interior.x1; x += 1) {
            if (mask.hard[y * width + x]) editable += 1;
          }
        }
        expect(editable, `${name} ${anchor.id}`).toBe(0);
      }
    }
    // The living-room window garland covers the window top only: a quarter of the window's
    // height (0.173 to 0.7), deep enough for the garland's thickness and swag at that distance.
    const room = liveAnalysis('christmas.interior.classic.source');
    const garland = plan(room, 'christmas').draft.placements.find(
      (p) => p.anchorId === 'window_left',
    );
    expect(garland?.maskShapes).toEqual([{ kind: 'box', box: [0, 0.158, 0.212, 0.3047] }]);
  });

  it('follows the gable edges with sloped bands', () => {
    const analysis = liveAnalysis('christmas.house_exterior.classic.source');
    const gable = analysis.anchors.find((a) => a.id === 'roofline_gable') as Anchor;
    const placement = plan(analysis, 'christmas').draft.placements.find(
      (p) => p.anchorId === 'roofline_gable',
    );
    const shapes = placement?.maskShapes as MaskShape[];
    expect(shapes.filter((shape) => shape.kind === 'polygon')).toHaveLength(2);
    const { width, height } = analysis.workingImage;
    const raster = rasterizeShapes(shapes, width, height);
    const [x0, y0, x1, y1] = gable.box;
    const cx = (x0 + x1) / 2;
    for (const t of [0.15, 0.5, 0.85]) {
      // On each edge from a bottom corner to the apex.
      const left: [number, number] = [x0 + (cx - x0) * t, y1 + (y0 - y1) * t];
      const right: [number, number] = [x1 + (cx - x1) * t, y1 + (y0 - y1) * t];
      for (const [x, y] of [left, right]) {
        expect(at(raster, width, height, x, y)).toBe(1);
        // Above the edge (sky) and inside the gable face are not part of the band.
        expect(at(raster, width, height, x, y - 0.05)).toBe(0);
        expect(at(raster, width, height, x, y + 0.05)).toBe(0);
      }
    }
    // The gable face itself stays protected.
    expect(at(raster, width, height, cx, (y0 + y1) / 2 + 0.02)).toBe(0);
  });
});

describe('placement geometry rules', () => {
  const grid = { width: 1536, height: 1024 };
  const anchor = (category: Anchor['category'], box: NormalizedBox): Anchor => ({
    id: 'a',
    category,
    box,
    confidence: 0.9,
    occluded: false,
  });
  const shapesOf = (...args: Parameters<typeof placementGeometry>) =>
    placementGeometry(...args)?.shapes;

  it('puts eave lights in a thin band at the bottom edge and garland in a drape below it', () => {
    const eaves = anchor('eaves', [0.1, 0.4, 0.9, 0.5]);
    expect(shapesOf('along', eaves, grid, { attachment: 'strung' })).toEqual([
      { kind: 'box', box: [0.1, 0.485, 0.9, 0.515] },
    ]);
    expect(shapesOf('along', eaves, grid, { attachment: 'draped' })).toEqual([
      { kind: 'box', box: [0.1, 0.485, 0.9, 0.56] },
    ]);
    expect(shapesOf('along', eaves, grid, { attachment: 'draped', drapeScale: 0.5 })).toEqual([
      { kind: 'box', box: [0.1, 0.485, 0.9, 0.53] },
    ]);
  });

  it('bands rails, frames and mantels at the top edge, and wraps columns', () => {
    expect(
      shapesOf('along', anchor('porch_rail', [0.2, 0.7, 0.5, 0.8]), grid, { attachment: 'draped' }),
    ).toEqual([{ kind: 'box', box: [0.2, 0.685, 0.5, 0.76] }]);
    // A tall window still gets only its top band.
    expect(
      shapesOf('along', anchor('window_frame', [0.3, 0.4, 0.36, 0.6]), grid, {
        attachment: 'strung',
      }),
    ).toEqual([{ kind: 'box', box: [0.3, 0.385, 0.36, 0.415] }]);
    expect(
      shapesOf('along', anchor('mantel', [0.3, 0.4, 0.7, 0.5]), grid, { attachment: 'draped' }),
    ).toEqual([{ kind: 'box', box: [0.3, 0.385, 0.7, 0.46] }]);
    // A garland on a small (distant) window drapes the fixed share of the image height; on a
    // tall (close) window it drapes a quarter of the window's height, halved with the drapes.
    expect(
      shapesOf('along', anchor('window_frame', [0.3, 0.4, 0.36, 0.6]), grid, {
        attachment: 'draped',
      }),
    ).toEqual([{ kind: 'box', box: [0.3, 0.385, 0.36, 0.46] }]);
    const tall = anchor('interior_window', [0.1, 0.2, 0.4, 0.68]);
    expect(shapesOf('along', tall, grid, { attachment: 'draped' })).toEqual([
      { kind: 'box', box: [0.1, 0.185, 0.4, 0.32] },
    ]);
    expect(shapesOf('along', tall, grid, { attachment: 'draped', drapeScale: 0.5 })).toEqual([
      { kind: 'box', box: [0.1, 0.185, 0.4, 0.26] },
    ]);
    expect(shapesOf('along', tall, grid, { attachment: 'strung' })).toEqual([
      { kind: 'box', box: [0.1, 0.185, 0.4, 0.215] },
    ]);
    expect(garlandDrapeFor(tall)).toBeCloseTo(0.12, 10);
    expect(garlandDrapeFor(anchor('mantel', [0.1, 0.2, 0.4, 0.68]))).toBe(0.06);
    // A door frame keeps its top band and both jambs; the opening between them stays protected.
    const door = shapesOf('along', anchor('door_frame', [0.4, 0.5, 0.5, 0.9]), grid, {
      attachment: 'strung',
    });
    expect(door).toEqual([
      { kind: 'box', box: [0.4, 0.485, 0.5, 0.515] },
      { kind: 'box', box: [0.39, 0.5, 0.41, 0.9] },
      { kind: 'box', box: [0.49, 0.5, 0.51, 0.9] },
    ]);
    const wrap = shapesOf('along', anchor('column', [0.5, 0.5, 0.54, 0.8]), grid)?.[0];
    expect(wrap?.kind === 'box' && wrap.box.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([
      0.494, 0.5, 0.546, 0.8,
    ]);
  });

  it('caps hang_from depth and on_surface height', () => {
    const hang = placementGeometry('hang_from', anchor('mantel', [0.2, 0.3, 0.8, 0.5]), grid);
    expect((hang?.region[3] ?? 0) - (hang?.region[1] ?? 0)).toBeCloseTo(0.12, 6);
    const surface = placementGeometry(
      'on_surface',
      anchor('dining_table', [0.2, 0.5, 0.8, 0.9]),
      grid,
    );
    expect((surface?.region[3] ?? 0) - (surface?.region[1] ?? 0)).toBeCloseTo(0.15, 6);
  });
});

describe('source-mode mask budget', () => {
  it('shortens drapes, then drops the lowest-priority optional placements, and records them', () => {
    const base = liveAnalysis('christmas.house_exterior.classic.source');
    // Many tall rails make the garland and lights cover far more than the cap.
    const rails: Anchor[] = Array.from({ length: 6 }, (_, i) => ({
      id: `rail_${i}`,
      category: 'porch_rail',
      box: [0.05 + i * 0.15, 0.05, 0.17 + i * 0.15, 0.95],
      confidence: 0.95 - i * 0.01,
      occluded: false,
    }));
    const analysis: SceneAnalysis = {
      ...base,
      targetFacade: [0, 0, 1, 1],
      anchors: [...base.anchors.filter((a) => a.category === 'front_door'), ...rails],
      accessRegions: [],
      preserveRegions: [],
    };
    const built = plan(analysis, 'christmas', { style: 'abundant' });
    const budget = built.draft.maskBudget;
    expect(budget?.coverage).toBeLessThanOrEqual(0.25);
    // Drapes were shortened all the way before anything was dropped.
    expect(budget?.drapeScale).toBe(0);
    expect(
      built.validator.events.filter((e) => e.rule === 'mask_cap' && e.action === 'shrunk'),
    ).toHaveLength(2);
    expect(budget?.dropped.length).toBeGreaterThan(0);
    expect(
      built.validator.events.some((e) => e.rule === 'mask_cap' && e.action === 'removed'),
    ).toBe(true);
    const { width, height } = analysis.workingImage;
    expect(
      coverage(rasterizeShapes(placementMaskShapes(built.draft.placements), width, height)),
    ).toBeLessThanOrEqual(0.26);
    // Required archetypes keep a placement.
    for (const item of [
      'christmas.house_exterior.wreath_evergreen',
      'christmas.house_exterior.string_lights_warm_white',
    ]) {
      expect(
        built.draft.placements.some((p) => p.kitItemId === item),
        item,
      ).toBe(true);
    }
    // Evening plans have no paste-back and no budget.
    expect(
      plan(analysis, 'christmas', { style: 'abundant', lightingMode: 'evening' }).draft.maskBudget,
    ).toBeUndefined();
  });
});

describe('anchor vocabulary', () => {
  it('plans the Thanksgiving dining room from the real analysis (table runner and centerpiece)', () => {
    const analysis = liveAnalysis('thanksgiving_us.interior.classic.source');
    // The table is partly hidden by chairs; its top surface carries the decorations.
    expect(analysis.anchors.find((a) => a.id === 'dining_table_1')?.occlusionFraction).toBe(0.35);
    for (const style of ['subtle', 'classic', 'abundant'] as const) {
      const built = plan(analysis, 'thanksgiving_us', { style });
      expect(built.validator, style).toMatchObject({ passed: true, failure: null });
      const onTable = built.draft.placements
        .filter((p) => p.anchorId === 'dining_table_1')
        .map((p) => p.kitItemId);
      expect(onTable).toEqual(
        expect.arrayContaining([
          'thanksgiving_us.interior.table_runner',
          'thanksgiving_us.interior.centerpiece_low',
        ]),
      );
      // Clear of the vases already on the table.
      for (const placement of built.draft.placements.filter(
        (p) => p.anchorId === 'dining_table_1',
      )) {
        expect(placement.region[1]).toBeGreaterThanOrEqual(0.67);
      }
    }
    const christmas = plan(analysis, 'christmas');
    expect(christmas.validator.passed).toBe(true);
    expect(christmas.draft.placements.map((p) => `${p.kitItemId}@${p.anchorId}`)).toContain(
      'christmas.interior.table_centerpiece@dining_table_1',
    );
  });

  it('still drops occluded anchors that are not table tops', () => {
    const analysis = liveAnalysis('thanksgiving_us.interior.classic.source');
    const hidden: SceneAnalysis = {
      ...analysis,
      anchors: analysis.anchors.map((a) =>
        a.category === 'interior_window' ? { ...a, occluded: true, occlusionFraction: 0.35 } : a,
      ),
      preserveRegions: [],
    };
    const built = plan(hidden, 'thanksgiving_us', { style: 'abundant' });
    expect(built.draft.placements.some((p) => p.anchorCategory === 'interior_window')).toBe(false);
  });

  it('agrees across the analysis prompt, the packs and the planner', () => {
    for (const { pack } of content.packs as { pack: HolidayPack }[]) {
      for (const [sceneType, section] of Object.entries(pack.sceneSections) as [
        SceneType,
        NonNullable<HolidayPack['sceneSections'][SceneType]>,
      ][]) {
        const vocabulary = new Set(anchorCategoriesForSceneType(sceneType));
        const prompt = analysisUserPrompt({ sceneType, sourceKind: 'upload' });
        for (const category of vocabulary) {
          expect(prompt).toContain(`- ${category}: ${ANCHOR_GLOSSES[category]}.`);
        }
        const where = `${pack.holidayId}.${sceneType}`;
        for (const category of section.anchors) expect(vocabulary.has(category), where).toBe(true);
        for (const room of Object.values(section.roomRules ?? {})) {
          for (const category of room.anchors) {
            expect(section.anchors.includes(category), `${where} room ${category}`).toBe(true);
          }
        }
        for (const item of section.kit) {
          for (const category of item.anchors) {
            expect(section.anchors.includes(category), `${item.kitItemId} ${category}`).toBe(true);
          }
        }
        // Every archetype is reachable for at least one room type or building form.
        const lists =
          sceneType === 'interior'
            ? (section.roomTypes ?? []).map((roomType) =>
                effectiveSectionAnchors(section, { roomType }),
              )
            : [effectiveSectionAnchors(section)];
        for (const item of section.kit) {
          expect(
            lists.some((list) => item.anchors.some((category) => list.includes(category))),
            item.kitItemId,
          ).toBe(true);
        }
      }
    }
    // Table runners and centerpieces stand on the dining table for Thanksgiving and Christmas.
    for (const [holidayId, items] of [
      ['thanksgiving_us', ['table_runner', 'centerpiece_low']],
      ['christmas', ['table_centerpiece']],
    ] as const) {
      const section = content.packFor(holidayId)?.pack.sceneSections.interior;
      for (const name of items) {
        const item = section?.kit.find((k) => k.kitItemId === `${holidayId}.interior.${name}`);
        expect(item, name).toMatchObject({ placementRule: 'on_surface' });
        expect(item?.anchors).toContain('dining_table');
      }
      expect(effectiveSectionAnchors(section as never, { roomType: 'dining_room' })).toContain(
        'dining_table',
      );
    }
    expect(analysisUserPrompt({ sceneType: 'interior', sourceKind: 'upload' })).toContain(
      'occlusionFraction describe the top surface only',
    );
  });
});
