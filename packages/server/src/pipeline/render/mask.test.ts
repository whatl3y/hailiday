import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalizedAdditionRecord, NormalizedBox, SceneAnalysis } from '@holiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { buildPlan } from '../plan/builder.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { localizedKeepMask, renderCompositeMask } from './mask.js';

let content: Content;
beforeAll(async () => {
  content = await loadContent();
});

/** The real Claude analysis of the bungalow example photograph (recorded from a live run). */
function bungalow(): SceneAnalysis {
  const file = new URL(
    '../plan/testdata/live-analyses/christmas.house_exterior.classic.source.json',
    import.meta.url,
  );
  return (JSON.parse(readFileSync(file, 'utf8')) as { analysis: SceneAnalysis }).analysis;
}

const coverage = (plane: Uint8Array) =>
  plane.reduce((sum, v) => sum + (v ? 1 : 0), 0) / plane.length;

describe('render job composite mask', () => {
  it('dilates the bungalow bands by the band dilation and stays at or under 25% of the frame', () => {
    const analysis = bungalow();
    const pack = content.packFor('christmas');
    if (!pack) throw new Error('christmas pack');
    const built = buildPlan({
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
      style: 'classic',
      lightingMode: 'source',
      compilerVersion: 'test-1',
      permissionEvaluationId: 'pe',
    });
    const placements = built.draft.placements;
    expect(placements.some((p) => p.placementRule === 'along' && p.maskShapes?.length)).toBe(true);
    const { width, height } = analysis.workingImage;
    const mask = renderCompositeMask({
      analysis,
      placements,
      width,
      height,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
    });
    const long = Math.max(width, height);
    expect(mask.dilationPx).toBe(Math.round(PIPELINE_DEFAULTS.dilationFraction * long));
    expect(mask.bandDilationPx).toBe(Math.round(PIPELINE_DEFAULTS.bandDilationFraction * long));
    expect(coverage(mask.hard)).toBeLessThanOrEqual(0.25);
  });

  it('never dilates bands more than boxes, and excludes the attribution rectangles', () => {
    const analysis = bungalow();
    const { width, height } = analysis.workingImage;
    const region: [number, number, number, number] = [0.3, 0.3, 0.7, 0.32];
    const placement = {
      anchorId: 'none',
      placementRule: 'along' as const,
      region,
      maskShapes: [{ kind: 'box' as const, box: region }],
    };
    const repaired = renderCompositeMask({
      analysis: { ...analysis, anchors: [], peopleBoxes: [], protectedBlurRegions: [] },
      placements: [placement],
      width,
      height,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: 0.01,
      featherFraction: 0,
    });
    expect(repaired.bandDilationPx).toBe(repaired.dilationPx);
    const attribution: [number, number, number, number] = [0.4, 0.28, 0.5, 0.34];
    const excluded = renderCompositeMask({
      analysis: { ...analysis, anchors: [], peopleBoxes: [], protectedBlurRegions: [] },
      placements: [placement],
      width,
      height,
      padRegions: [],
      attributionRegions: [attribution],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: 0,
    });
    const at = (x: number, y: number) =>
      excluded.hard[Math.round(y * height) * width + Math.round(x * width)];
    expect(at(0.35, 0.31)).toBe(255);
    expect(at(0.45, 0.31)).toBe(0);
  });
});

describe('localized keep-mask', () => {
  const width = 400;
  const height = 300;
  const window: NormalizedBox = [0.6, 0.2, 0.8, 0.6];
  const analysis = (): SceneAnalysis => {
    const real = bungalow();
    return {
      ...real,
      workingImage: { width, height, checksum: 'x' },
      anchors: [
        {
          ...(real.anchors[0] as SceneAnalysis['anchors'][number]),
          id: 'w1',
          category: 'window_frame',
          box: window,
        },
      ],
      accessRegions: [{ kind: 'walkway', box: [0.3, 0.8, 0.5, 1] }],
      existingDecorations: { ...real.existingDecorations, boxes: [] },
      peopleBoxes: [[0.05, 0.6, 0.15, 0.95]],
      protectedBlurRegions: [{ kind: 'face', box: [0.2, 0.1, 0.26, 0.2] }],
      preserveRegions: [{ kind: 'house_number', box: [0.45, 0.45, 0.5, 0.5] }],
    };
  };
  const planMask = (a: SceneAnalysis) =>
    renderCompositeMask({
      analysis: a,
      placements: [
        {
          anchorId: 'door',
          placementRule: 'centered_on',
          region: [0.4, 0.3, 0.55, 0.5],
        },
      ],
      width,
      height,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
    });
  const item = (
    box: NormalizedBox,
    placementId: string | null = null,
  ): LocalizedAdditionRecord => ({
    label: 'item',
    box,
    placementId,
  });
  const at = (plane: Uint8Array, x: number, y: number) =>
    plane[Math.floor(y * height) * width + Math.floor(x * width)];

  it('keeps localized items whole, across window and access protections', () => {
    const a = analysis();
    const plan = planMask(a);
    // A tree standing on the walkway and a garland across the window glass.
    const keep = localizedKeepMask({
      planMask: plan,
      items: [item([0.32, 0.7, 0.4, 0.95]), item([0.62, 0.3, 0.78, 0.4])],
      analysis: a,
      attributionRegions: [],
      padRegions: [],
    });
    expect(at(plan.hard, 0.36, 0.85)).toBe(0);
    expect(at(keep.mask.hard, 0.36, 0.85)).toBe(255);
    expect(at(keep.mask.alpha, 0.36, 0.85)).toBe(255);
    expect(at(keep.mask.alpha, 0.7, 0.35)).toBe(255);
    // Each item box grows by 1% of the long edge; beyond that the original stays.
    expect(keep.dilationPx).toBe(Math.round(0.01 * width));
    expect(at(keep.mask.hard, 0.32 - 3 / width, 0.85)).toBe(255);
    expect(at(keep.mask.hard, 0.32 - 8 / width, 0.85)).toBe(0);
    // The plan mask is still part of the keep-mask.
    expect(at(keep.mask.alpha, 0.47, 0.4)).toBe(255);
    expect(keep.coverage).toBeGreaterThan(keep.coverageBeforeCap - 1e-9);
  });

  it('fades a localized item to 0 within its band: full on the item, no step at the edge', () => {
    // The production working size, where the plan feather (2%) is wider than the 1% band.
    const W = 1536;
    const H = 1024;
    const a: SceneAnalysis = {
      ...analysis(),
      workingImage: { width: W, height: H, checksum: 'x' },
    };
    const plan = renderCompositeMask({
      analysis: a,
      placements: [
        { anchorId: 'door', placementRule: 'centered_on', region: [0.4, 0.3, 0.55, 0.5] },
      ],
      width: W,
      height: H,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
    });
    const box: NormalizedBox = [0.25, 0.62, 0.3, 0.72];
    const keep = localizedKeepMask({
      planMask: plan,
      items: [item(box)],
      analysis: a,
      attributionRegions: [],
      padRegions: [],
    });
    const { hard, alpha } = keep.mask;
    expect(keep.dilationPx).toBe(Math.round(0.01 * W));
    expect(plan.featherPx).toBeGreaterThan(keep.dilationPx);
    const x0 = Math.round(box[0] * W);
    const x1 = Math.round(box[2] * W);
    const y0 = Math.round(box[1] * H);
    const y1 = Math.round(box[3] * H);
    const midY = Math.round((y0 + y1) / 2);
    const midX = Math.round((x0 + x1) / 2);
    // Four outward profiles from the item's edges: left, right, up and down.
    const profiles: { inside: number; step: (d: number) => number }[] = [
      { inside: midY * W + x0, step: (d) => midY * W + (x0 - d) },
      { inside: midY * W + (x1 - 1), step: (d) => midY * W + (x1 - 1 + d) },
      { inside: y0 * W + midX, step: (d) => (y0 - d) * W + midX },
      { inside: (y1 - 1) * W + midX, step: (d) => (y1 - 1 + d) * W + midX },
    ];
    for (const { inside, step } of profiles) {
      expect(alpha[inside]).toBe(255);
      let outermost = 0;
      for (let d = 1; hard[step(d)]; d += 1) {
        outermost = d;
        expect(alpha[step(d)] as number).toBeLessThanOrEqual(alpha[step(d - 1)] as number);
      }
      expect(outermost).toBe(keep.dilationPx);
      expect(alpha[step(outermost)] as number).toBeLessThanOrEqual(16);
      expect(alpha[step(outermost + 1)]).toBe(0);
    }
    // The whole item keeps full alpha.
    for (let y = y0; y < y1; y += 7) {
      for (let x = x0; x < x1; x += 7) expect(alpha[y * W + x]).toBe(255);
    }
  });

  it('never keeps an item over people, blurred regions, text marks, attribution or padding', () => {
    const a = analysis();
    const attribution: NormalizedBox = [0.7, 0.9, 0.95, 0.98];
    const pad: NormalizedBox = [0.97, 0, 1, 1];
    const keep = localizedKeepMask({
      planMask: planMask(a),
      // One large unplanned item over every protected spot.
      items: [item([0.0, 0.05, 1, 0.99])],
      analysis: a,
      attributionRegions: [attribution],
      padRegions: [pad],
      cap: 1,
    });
    for (const [x, y] of [
      [0.1, 0.8], // person
      [0.23, 0.15], // blurred face
      [0.475, 0.475], // house number
      [0.8, 0.94], // attribution
      [0.985, 0.5], // padding
    ] as const) {
      expect(at(keep.mask.hard, x, y), `${x},${y}`).toBe(0);
      expect(at(keep.mask.alpha, x, y), `${x},${y}`).toBe(0);
    }
    expect(at(keep.mask.alpha, 0.5, 0.2)).toBe(255);
  });

  it('caps coverage by dropping unplanned items largest first, never planned ones', () => {
    const a = analysis();
    const big = item([0.0, 0.0, 0.9, 0.6]);
    const medium = item([0.0, 0.62, 0.3, 0.98]);
    const planned = item([0.5, 0.62, 0.95, 0.98], 'p1');
    const keep = localizedKeepMask({
      planMask: planMask(a),
      items: [medium, big, planned],
      analysis: a,
      attributionRegions: [],
      padRegions: [],
      cap: 0.5,
    });
    expect(keep.coverageBeforeCap).toBeGreaterThan(0.5);
    expect(keep.dropped).toEqual([big]);
    expect(keep.kept).toEqual([medium, planned]);
    expect(keep.coverage).toBeLessThanOrEqual(0.5);
    // A cap no unplanned item can meet drops every unplanned item and keeps the planned one.
    const tight = localizedKeepMask({
      planMask: planMask(a),
      items: [medium, big, planned],
      analysis: a,
      attributionRegions: [],
      padRegions: [],
      cap: 0.01,
    });
    expect(tight.dropped).toEqual([big, medium]);
    expect(tight.kept).toEqual([planned]);
  });
});
