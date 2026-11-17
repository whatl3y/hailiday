import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LocalizedAdditionRecord, NormalizedBox, SceneAnalysis } from '@hailiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { buildPlan } from '../plan/builder.js';
import type { Raster } from '../imaging/raster.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import {
  decideProtectedBoxes,
  lavishKeepMask,
  localizedKeepMask,
  placementDecorationBoxes,
  protectedCompositing,
  renderCompositeMask,
  restoreExclusions,
  textMarkExclusions,
} from './mask.js';

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

describe('lavish keep-mask', () => {
  const width = 400;
  const height = 300;
  const window: NormalizedBox = [0.6, 0.2, 0.8, 0.6];
  const person: NormalizedBox = [0.05, 0.6, 0.15, 0.95];
  const face: NormalizedBox = [0.2, 0.1, 0.26, 0.2];
  const houseNumber: NormalizedBox = [0.45, 0.45, 0.5, 0.5];
  const attribution: NormalizedBox = [0.7, 0.9, 0.95, 0.98];
  const pad: NormalizedBox = [0.97, 0, 1, 1];
  const restore: NormalizedBox = [0.3, 0.3, 0.34, 0.34];
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
      peopleBoxes: [person],
      // The padding is listed as a blurred region too, as the render job records it.
      protectedBlurRegions: [
        { kind: 'face', box: face },
        { kind: 'other', box: pad },
      ],
      preserveRegions: [{ kind: 'house_number', box: houseNumber }],
    };
  };
  const planMask = (a: SceneAnalysis) =>
    renderCompositeMask({
      analysis: a,
      placements: [
        { anchorId: 'door', placementRule: 'centered_on', region: [0.4, 0.3, 0.55, 0.5] },
      ],
      width,
      height,
      padRegions: [pad],
      attributionRegions: [attribution],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
    });
  const at = (plane: Uint8Array, x: number, y: number) =>
    plane[Math.floor(y * height) * width + Math.floor(x * width)];
  const flat = (): Raster => ({
    data: Buffer.alloc(width * height * 3, 128),
    width,
    height,
  });
  const lavishCompositing = (
    items: LocalizedAdditionRecord[] | null,
    extra: Partial<Parameters<typeof protectedCompositing>[0]> = {},
  ) => {
    const a = analysis();
    const plan = planMask(a);
    return protectedCompositing({
      working: flat(),
      aligned: flat(),
      analysis: a,
      padRegions: [pad],
      attributionRegions: [attribution],
      planMask: plan,
      items,
      placements: [{ region: [0.4, 0.3, 0.55, 0.5] }],
      buildMask: () => plan,
      lavish: true,
      ...extra,
    });
  };

  it('is the whole frame minus people, blurred regions, text marks, restore boxes and padding', () => {
    const a = analysis();
    const featherPx = 8;
    const mask = lavishKeepMask({
      width,
      height,
      analysis: a,
      padRegions: [pad],
      restoreBoxes: [restore],
      featherPx,
    });
    // Each excluded box shows the original: 0 in the hard mask and the alpha.
    const grownMark = textMarkExclusions(a, width, height)[0] as NormalizedBox;
    const grownRestore = restoreExclusions([restore], width, height)[0] as NormalizedBox;
    for (const box of [person, face, grownMark, grownRestore, pad]) {
      const [x0, y0, x1, y1] = [
        Math.round(box[0] * width),
        Math.round(box[1] * height),
        Math.round(box[2] * width),
        Math.round(box[3] * height),
      ];
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          expect(mask.hard[y * width + x], `${box.join(',')} ${x},${y}`).toBe(0);
          expect(mask.alpha[y * width + x], `${box.join(',')} ${x},${y}`).toBe(0);
        }
      }
    }
    // A window interior, the door, an access region and the attribution rectangles are kept:
    // the attribution is restored after the paste, over the kept picture's own ground.
    for (const [x, y] of [
      [0.7, 0.45], // window interior
      [0.47, 0.35], // door (the plan's region)
      [0.4, 0.9], // walkway
      [0.8, 0.94], // attribution
    ] as const) {
      expect(at(mask.hard, x, y), `${x},${y}`).toBe(255);
      expect(at(mask.alpha, x, y), `${x},${y}`).toBe(255);
    }
    // People and blurred regions fade into the picture; text marks and restore boxes cut hard.
    const personRow = Math.round(0.8 * height) * width;
    const personRight = Math.round(person[2] * width);
    expect(mask.alpha[personRow + personRight] as number).toBeGreaterThan(0);
    expect(mask.alpha[personRow + personRight] as number).toBeLessThan(64);
    expect(mask.alpha[personRow + personRight + featherPx]).toBe(255);
    const faceRow = Math.round(0.15 * height) * width;
    const faceRight = Math.round(face[2] * width);
    expect(mask.alpha[faceRow + faceRight] as number).toBeGreaterThan(0);
    expect(mask.alpha[faceRow + faceRight] as number).toBeLessThan(64);
    expect(mask.alpha[faceRow + faceRight + featherPx]).toBe(255);
    const markRow = Math.round(0.475 * height) * width;
    const markRight = Math.round(grownMark[2] * width);
    expect(mask.alpha[markRow + markRight - 1]).toBe(0);
    expect(mask.alpha[markRow + markRight]).toBe(255);
    expect(coverage(mask.hard)).toBeGreaterThan(0.85);
  });

  it('keeps the picture at full strength up to the padding', () => {
    const mask = lavishKeepMask({
      width,
      height,
      analysis: analysis(),
      padRegions: [pad],
      featherPx: 8,
    });
    const row = Math.round(0.5 * height) * width;
    const padLeft = Math.round(pad[0] * width);
    expect(mask.alpha[row + padLeft]).toBe(0);
    expect(mask.alpha[row + padLeft - 1]).toBe(255);
  });

  it('is the same with localized items, with none and with items over the cap, and drops nothing', () => {
    const three = [
      { label: 'wreath', box: [0.42, 0.32, 0.52, 0.45] as NormalizedBox, placementId: 'p1' },
      { label: 'garland', box: [0.3, 0.1, 0.9, 0.18] as NormalizedBox, placementId: null },
      { label: 'tree', box: [0.6, 0.6, 0.7, 0.9] as NormalizedBox, placementId: null },
    ];
    // Unplanned items covering 70% of the frame.
    const over = [{ label: 'lights', box: [0, 0, 0.7, 1] as NormalizedBox, placementId: null }];
    const none = lavishCompositing(null);
    const some = lavishCompositing(three);
    const many = lavishCompositing(over);
    for (const result of [some, many]) {
      expect(result.mask.checksum).toBe(none.mask.checksum);
      expect(Buffer.from(result.mask.alpha).equals(Buffer.from(none.mask.alpha))).toBe(true);
      expect(result.keep?.dropped).toEqual([]);
      expect(result.keep?.mask.checksum).toBe(none.mask.checksum);
      expect(result.keep?.coverage).toBeGreaterThan(0.5);
    }
    expect(some.keep?.kept).toEqual(three);
    expect(many.keep?.kept).toEqual(over);
    expect(none.keep).toBeNull();
    // The attribution rectangle is kept for its restore after the paste; padding is not.
    expect(at(none.mask.hard, 0.8, 0.94)).toBe(255);
    expect(at(none.mask.hard, 0.985, 0.5)).toBe(0);
  });

  it('records what it kept', () => {
    const result = lavishCompositing(null);
    const kept = result.mask.hard.reduce((sum, v) => sum + (v ? 1 : 0), 0) / (width * height);
    expect(result.wholeFrame).toEqual({
      area: 'whole_frame',
      coverage: Math.round(kept * 10_000) / 10_000,
      featherPx: planMask(analysis()).featherPx,
    });
    expect(result.mask.featherPx).toBe(Math.round(PIPELINE_DEFAULTS.featherFraction * width));
    // An attempt that is not lavish records nothing of the kind.
    expect(lavishCompositing(null, { lavish: false }).wholeFrame).toBeUndefined();
  });
});

describe('text marks and restore boxes', () => {
  // The live dim hallway (1536x1024 working grid): the analysis's house number is a sliver of the
  // door-number plaque on the door frame, inside the garland band on that frame; the judge's
  // evidence box around the plaque is about twice as wide.
  const W = 1536;
  const H = 1024;
  const houseNumber: NormalizedBox = [0.329, 0.3, 0.338, 0.355];
  const judgeBox: NormalizedBox = [0.322, 0.29, 0.342, 0.36];
  const frameGarland: NormalizedBox = [0.325, 0.13, 0.355, 0.835];
  const analysis = (): SceneAnalysis => ({
    ...bungalow(),
    workingImage: { width: W, height: H, checksum: 'x' },
    anchors: [],
    accessRegions: [],
    peopleBoxes: [],
    protectedBlurRegions: [],
    existingDecorations: { ...bungalow().existingDecorations, boxes: [] },
    preserveRegions: [{ kind: 'house_number', box: houseNumber }],
  });
  const band = {
    anchorId: 'frame',
    placementRule: 'along' as const,
    region: frameGarland,
    maskShapes: [{ kind: 'box' as const, box: frameGarland }],
  };
  const pixels = (box: NormalizedBox) => {
    const out: number[] = [];
    for (let y = Math.round(box[1] * H); y < Math.round(box[3] * H); y += 1) {
      for (let x = Math.round(box[0] * W); x < Math.round(box[2] * W); x += 1) out.push(y * W + x);
    }
    return out;
  };
  const kept = (plane: Uint8Array, box: NormalizedBox) =>
    pixels(box).filter((i) => (plane[i] as number) > 0).length;
  const planMask = (restoreBoxes?: NormalizedBox[]) =>
    renderCompositeMask({
      analysis: analysis(),
      placements: [band],
      width: W,
      height: H,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
      ...(restoreBoxes ? { restoreBoxes } : {}),
    });

  it('grows a narrow text box that touches a band placement so the whole plaque is restored', () => {
    const mask = planMask();
    // The judge's plaque box lies inside the band, yet none of it is editable.
    expect(kept(mask.hard, judgeBox)).toBe(0);
    expect(kept(mask.alpha, judgeBox)).toBe(0);
    // The margin is the larger of 1% of the long edge and half the box's short side.
    const margin = Math.max(0.01 * W, 0.5 * (houseNumber[2] - houseNumber[0]) * W);
    expect(margin).toBeCloseTo(15.36);
    const row = Math.round(0.33 * H) * W;
    expect(mask.hard[row + Math.round(houseNumber[0] * W - margin) - 2]).toBe(255);
    expect(mask.hard[row + Math.round(houseNumber[0] * W - margin) + 1]).toBe(0);
    // The band stays editable away from the plaque.
    expect(kept(mask.hard, [0.33, 0.5, 0.35, 0.6])).toBe(pixels([0.33, 0.5, 0.35, 0.6]).length);
  });

  it('grows a larger mark by half its short side', () => {
    const sign: NormalizedBox = [0.4, 0.4, 0.5, 0.48];
    const mask = renderCompositeMask({
      analysis: { ...analysis(), preserveRegions: [{ kind: 'sign', box: sign }] },
      placements: [
        { anchorId: 'x', placementRule: 'centered_on', region: [0.35, 0.35, 0.55, 0.55] },
      ],
      width: W,
      height: H,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: 0,
    });
    // Short side 0.08 * 1024 = 82 px: the margin is 41 px, more than 1% of the long edge.
    const row = Math.round(0.44 * H) * W;
    expect(mask.hard[row + Math.round(0.4 * W) - 39]).toBe(0);
    expect(mask.hard[row + Math.round(0.4 * W) - 44]).toBe(255);
  });

  it('excludes a restore box inside a band placement from the composite mask', () => {
    const restore: NormalizedBox = [0.33, 0.6, 0.345, 0.62];
    expect(kept(planMask().hard, restore)).toBe(pixels(restore).length);
    const repaired = planMask([restore]);
    expect(kept(repaired.hard, restore)).toBe(0);
    expect(kept(repaired.alpha, restore)).toBe(0);
    // Grown by 1% of the long edge on every side (15 px), clamped to the frame.
    const row = Math.round(0.61 * H) * W;
    expect(repaired.hard[row + Math.round(0.33 * W) - 13]).toBe(0);
    expect(kept(repaired.hard, [0.33, 0.7, 0.345, 0.72])).toBeGreaterThan(0);
    const edge = planMask([[0.995, 0.6, 1, 0.62]]);
    expect(edge.hard.length).toBe(W * H);
  });

  it('excludes a restore box inside a localized box from the keep-mask', () => {
    const restore: NormalizedBox = [0.6, 0.6, 0.62, 0.63];
    const items: LocalizedAdditionRecord[] = [
      { label: 'wreath', box: [0.55, 0.55, 0.7, 0.7], placementId: null },
    ];
    const without = localizedKeepMask({
      planMask: planMask(),
      items,
      analysis: analysis(),
      attributionRegions: [],
      padRegions: [],
    });
    expect(kept(without.mask.hard, restore)).toBe(pixels(restore).length);
    const keep = localizedKeepMask({
      planMask: planMask([restore]),
      items,
      analysis: analysis(),
      attributionRegions: [],
      padRegions: [],
      restoreBoxes: [restore],
    });
    expect(kept(keep.mask.hard, restore)).toBe(0);
    expect(kept(keep.mask.alpha, restore)).toBe(0);
    expect(kept(keep.mask.hard, [0.56, 0.66, 0.58, 0.68])).toBeGreaterThan(0);
    // The grown text mark is excluded from localized items too.
    const overPlaque = localizedKeepMask({
      planMask: planMask(),
      items: [{ label: 'garland', box: [0.3, 0.25, 0.36, 0.4], placementId: null }],
      analysis: analysis(),
      attributionRegions: [],
      padRegions: [],
    });
    expect(kept(overPlaque.mask.hard, judgeBox)).toBe(0);
  });
});

describe('the surroundings of text marks and restore boxes decide their compositing', () => {
  // A 400 x 300 grid: 1% of the long edge is 4 px; the ring measure blurs by 1 px.
  const W = 400;
  const H = 300;
  // Three marks 8 x 18 px; each grows by max(4, 4) px to 16 x 26 px (a 272-pixel ring).
  const covered: NormalizedBox = [0.2, 0.4, 0.22, 0.46];
  const touched: NormalizedBox = [0.5, 0.4, 0.52, 0.46];
  const untouched: NormalizedBox = [0.8, 0.4, 0.82, 0.46];
  const grownOf = (box: NormalizedBox, px = 4): NormalizedBox => [
    box[0] - px / W,
    box[1] - px / H,
    box[2] + px / W,
    box[3] + px / H,
  ];
  const analysis = (): SceneAnalysis => ({
    ...bungalow(),
    workingImage: { width: W, height: H, checksum: 'x' },
    anchors: [],
    accessRegions: [],
    peopleBoxes: [],
    protectedBlurRegions: [],
    existingDecorations: { ...bungalow().existingDecorations, boxes: [] },
    preserveRegions: [
      { kind: 'house_number', box: covered },
      { kind: 'house_number', box: touched },
      { kind: 'sign', box: untouched },
    ],
  });
  const PLATE: [number, number, number] = [70, 70, 75];
  const GREEN: [number, number, number] = [30, 90, 40];
  const GLOW: [number, number, number] = [250, 240, 205];
  const paint = (raster: Raster, box: NormalizedBox, rgb: [number, number, number]) => {
    for (let y = Math.round(box[1] * H); y < Math.round(box[3] * H); y += 1) {
      for (let x = Math.round(box[0] * W); x < Math.round(box[2] * W); x += 1) {
        const p = (y * W + x) * 3;
        raster.data[p] = rgb[0];
        raster.data[p + 1] = rgb[1];
        raster.data[p + 2] = rgb[2];
      }
    }
    return raster;
  };
  /** A textured pale wall with a dark plate in every mark. */
  const wall = (): Raster => {
    const data = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const p = (y * W + x) * 3;
        const v = 190 + ((x * 5 + y * 3) % 11);
        data[p] = v;
        data[p + 1] = v - 6;
        data[p + 2] = v - 18;
      }
    }
    const raster = { data, width: W, height: H };
    for (const box of [covered, touched, untouched]) paint(raster, box, PLATE);
    return raster;
  };
  const copy = (raster: Raster): Raster => ({ ...raster, data: Buffer.from(raster.data) });
  /** One byte per pixel, 1 inside any of `boxes`: the edited area the tone curves skip. */
  const areaOf = (...boxes: NormalizedBox[]) => {
    const area = new Uint8Array(W * H);
    for (const box of boxes) {
      for (let y = Math.round(box[1] * H); y < Math.round(box[3] * H); y += 1) {
        area.fill(1, y * W + Math.round(box[0] * W), y * W + Math.round(box[2] * W));
      }
    }
    return area;
  };
  // A garland band hung straight across the first mark.
  const garland: NormalizedBox = [0.17, 0.1, 0.25, 0.9];
  /** The garland, and the whole ring of the second mark lit by a glow (its plate kept). */
  const glowing = (): Raster => {
    const out = paint(copy(wall()), garland, GREEN);
    paint(out, grownOf(touched), GLOW);
    return paint(out, touched, PLATE);
  };
  const decide = (
    aligned: Raster,
    decorationBoxes: NormalizedBox[],
    extra: { restoreBoxes?: NormalizedBox[] } = {},
  ) =>
    decideProtectedBoxes({
      working: wall(),
      aligned,
      analysis: analysis(),
      padRegions: [],
      attributionRegions: [],
      edited: areaOf(garland, ...decorationBoxes),
      decorationBoxes,
      ...extra,
    });

  it('opens a covered mark only under a decoration; a changed ring alone keeps the analysis box', () => {
    // A decoration is localized over the untouched sign too, with its surroundings clean.
    const overSign: NormalizedBox = [0.79, 0.38, 0.83, 0.48];
    const decisions = decide(glowing(), [garland, overSign]);
    expect(decisions.textMarks.map((mark) => [mark.kind, mark.mode, mark.decorated])).toEqual([
      ['house_number', 'open', true],
      ['house_number', 'exact', false],
      ['sign', 'grown', true],
    ]);
    // The garland covers the first ring; the glow lights most of the second (its outer edge
    // blurs into the unlit wall); the third is clean.
    expect(decisions.textMarks.map((mark) => mark.changedShare)).toEqual([1, 0.7059, 0]);
    expect(decisions.textMarks[0]?.ringPixels).toBe(16 * 26 - 8 * 18);
    expect(decisions.tone).toEqual({ sampled: 'outside_edits', samples: expect.any(Number) });
    expect(decisions.tone.samples).toBeGreaterThan(
      PIPELINE_DEFAULTS.protectedSurround.minToneSamples,
    );
    // Without a decoration box on it, the covered mark keeps its analysis box too.
    const bare = decide(glowing(), []);
    expect(bare.textMarks.map((mark) => mark.mode)).toEqual(['exact', 'exact', 'grown']);
    // Unedited output: every mark is grown.
    const same = decide(wall(), [garland]);
    expect(same.textMarks.every((mark) => mark.mode === 'grown')).toBe(true);
  });

  it('keeps the original in the analysis box of a mark whose ring changed with no decoration on it', () => {
    const a = analysis();
    const planMask = renderCompositeMask({
      analysis: a,
      placements: [],
      width: W,
      height: H,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
    });
    // A localized item that spans the glowing mark's surroundings but not its grown box.
    const beside: NormalizedBox = [grownOf(touched)[2], 0.3, 0.6, 0.6];
    const compositing = protectedCompositing({
      working: wall(),
      aligned: glowing(),
      analysis: a,
      padRegions: [],
      attributionRegions: [],
      planMask,
      items: [{ label: 'garland', box: beside, placementId: null }],
      placements: [],
      buildMask: ({ textMarks }) =>
        renderCompositeMask({
          analysis: a,
          placements: [],
          width: W,
          height: H,
          padRegions: [],
          attributionRegions: [],
          dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
          featherFraction: PIPELINE_DEFAULTS.featherFraction,
          textMarks,
        }),
      cap: 1,
    });
    expect(compositing.decisions.textMarks[1]).toMatchObject({
      box: touched,
      mode: 'exact',
      decorated: false,
    });
    expect(compositing.openHouseNumbers).toEqual([]);
    // The keep-mask (localized boxes dilated by 3% of the long edge reach the mark) leaves the
    // analysis box to the original.
    const keep = compositing.keep;
    if (!keep) throw new Error('keep-mask');
    for (let y = Math.round(touched[1] * H); y < Math.round(touched[3] * H); y += 1) {
      for (let x = Math.round(touched[0] * W); x < Math.round(touched[2] * W); x += 1) {
        expect(keep.mask.alpha[y * W + x]).toBe(0);
      }
    }
    // The ring right of it keeps the editor's pixels.
    expect(keep.mask.hard[Math.round(0.43 * H) * W + Math.round(touched[2] * W) + 2]).toBe(255);
  });

  it('reads a plate redrawn beyond its analysis box as exact unless a decoration lies on it', () => {
    // The plate redrawn 3 px wider and taller on every side, in another colour.
    const redrawn = paint(copy(wall()), grownOf(touched, 3), [120, 40, 40]);
    const grown = grownOf(touched);
    // A localized item that touches the grown box's right edge without overlapping it.
    const beside: NormalizedBox = [grown[2], 0.3, 0.6, 0.6];
    const decisions = decide(redrawn, [beside]);
    expect(decisions.textMarks[1]).toMatchObject({ mode: 'exact', decorated: false });
    expect(decisions.textMarks[1]?.changedShare).toBeGreaterThanOrEqual(
      PIPELINE_DEFAULTS.protectedSurround.coveredShare,
    );
    // A decoration that reaches into the mark is still beside it while it holds less than
    // half of the mark's own box.
    const into: NormalizedBox = [touched[2] - 0.009, 0.3, 0.6, 0.6];
    expect(decide(redrawn, [into]).textMarks[1]).toMatchObject({ mode: 'exact', decorated: false });
    // Half of the mark under a decoration is a decoration on it.
    const over: NormalizedBox = [(touched[0] + touched[2]) / 2, 0.3, 0.6, 0.6];
    expect(decide(redrawn, [over]).textMarks[1]).toMatchObject({
      mode: 'open',
      decorated: true,
    });
  });

  it('skips a restore box amid a painted area and applies one on a plain wall', () => {
    const amid: NormalizedBox = [0.2, 0.6, 0.22, 0.63];
    const plain: NormalizedBox = [0.6, 0.6, 0.62, 0.63];
    const decisions = decide(glowing(), [garland], { restoreBoxes: [amid, plain] });
    expect(decisions.restoreBoxes.map((box) => [box.box, box.applied])).toEqual([
      [amid, false],
      [plain, true],
    ]);
    expect(decisions.restoreBoxes[0]?.changedShare).toBe(1);
    expect(decisions.restoreBoxes[1]?.changedShare).toBe(0);
    // The ring is 4 px around the box grown by 4 px: (16 + 8) x (9 + 8 + 8) less 16 x 17.
    expect(decisions.restoreBoxes[1]?.ringPixels).toBe(24 * 25 - 16 * 17);
  });

  // The garland over the first mark; one column of the second mark's ring redrawn (with the
  // blur, 2 of its 16 columns read as changed: under 25%); the third mark untouched.
  const edited = (): Raster => {
    const out = paint(copy(wall()), garland, GREEN);
    return paint(out, [0.5 - 4 / W, 0.4 - 4 / H, 0.5 - 3 / W, 0.46 + 4 / H], GREEN);
  };
  const placements = [
    {
      anchorId: 'band',
      placementRule: 'along' as const,
      region: garland,
      maskShapes: [{ kind: 'box' as const, box: garland }],
    },
  ];
  const build = (
    a: SceneAnalysis,
    textMarks?: Parameters<typeof renderCompositeMask>[0]['textMarks'],
  ) =>
    renderCompositeMask({
      analysis: a,
      placements,
      width: W,
      height: H,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
      ...(textMarks ? { textMarks } : {}),
    });

  it('keeps the editor over an open mark, pastes back a grown mark whole and an exact mark by its box', () => {
    const a = analysis();
    const planMask = build(a);
    // Localized boxes over every mark and well beyond its grown box.
    const around = (box: NormalizedBox): NormalizedBox => [
      box[0] - 0.05,
      box[1] - 0.08,
      box[2] + 0.05,
      box[3] + 0.08,
    ];
    const compositing = protectedCompositing({
      working: wall(),
      aligned: edited(),
      analysis: a,
      padRegions: [],
      attributionRegions: [],
      planMask,
      items: [covered, touched, untouched].map((box) => ({
        label: 'garland',
        box: around(box),
        placementId: null,
      })),
      placements,
      buildMask: ({ textMarks }) => build(a, textMarks),
      cap: 1,
    });
    expect(compositing.decisions.textMarks.map((mark) => mark.mode)).toEqual([
      'open',
      'exact',
      'grown',
    ]);
    expect(compositing.decisions.textMarks[1]?.changedShare).toBeLessThan(
      PIPELINE_DEFAULTS.protectedSurround.coveredShare,
    );
    expect(compositing.mask).not.toBe(planMask);
    expect(compositing.openHouseNumbers).toEqual([covered]);
    // The rebuilt plan mask keeps the band over the open mark; the plan mask sent to the editor
    // excludes it.
    const center = Math.round(0.43 * H) * W + Math.round(0.21 * W);
    expect(compositing.mask.alpha[center]).toBe(255);
    expect(planMask.alpha[center]).toBe(0);
    const keep = compositing.keep;
    if (!keep) throw new Error('keep-mask');
    const alphaIn = (box: NormalizedBox) => {
      const values = new Set<number>();
      for (let y = Math.round(box[1] * H); y < Math.round(box[3] * H); y += 1) {
        for (let x = Math.round(box[0] * W); x < Math.round(box[2] * W); x += 1) {
          values.add(keep.mask.alpha[y * W + x] as number);
        }
      }
      return [...values];
    };
    // Open: the editor's pixels stay across the mark and its surroundings.
    expect(alphaIn(grownOf(covered))).toEqual([255]);
    // With house numbers kept, the covered number is never open: its analysis box is the
    // original's, the decoration stays around it, and no number is left to the judge alone.
    const kept = protectedCompositing({
      working: wall(),
      aligned: edited(),
      analysis: a,
      padRegions: [],
      attributionRegions: [],
      planMask,
      items: [covered, touched, untouched].map((box) => ({
        label: 'garland',
        box: around(box),
        placementId: null,
      })),
      placements,
      buildMask: ({ textMarks }) => build(a, textMarks),
      cap: 1,
      keepHouseNumbers: true,
    });
    expect(kept.decisions.textMarks.map((mark) => [mark.kind, mark.mode, mark.decorated])).toEqual([
      ['house_number', 'exact', true],
      ['house_number', 'exact', true],
      ['sign', 'grown', true],
    ]);
    expect(kept.openHouseNumbers).toEqual([]);
    const keptMask = kept.keep?.mask;
    if (!keptMask) throw new Error('keep-mask');
    for (let y = Math.round(covered[1] * H); y < Math.round(covered[3] * H); y += 1) {
      for (let x = Math.round(covered[0] * W); x < Math.round(covered[2] * W); x += 1) {
        expect(keptMask.alpha[y * W + x]).toBe(0);
      }
    }
    expect(keptMask.hard[Math.round(0.43 * H) * W + Math.round(covered[2] * W) + 2]).toBe(255);
    // Grown: the whole grown box is the original's.
    expect(alphaIn(grownOf(untouched))).toEqual([0]);
    // Exact: the analysis box is the original's; the ring around it keeps the editor's pixels.
    expect(alphaIn(touched)).toEqual([0]);
    expect(alphaIn([touched[0] - 4 / W, touched[1], touched[0] - 1 / W, touched[3]])).toEqual([
      255,
    ]);
    // Without decisions every mark is grown, as in the mask sent to the editor.
    const plain = localizedKeepMask({
      planMask,
      items: [{ label: 'garland', box: around(covered), placementId: null }],
      analysis: a,
      attributionRegions: [],
      padRegions: [],
      cap: 1,
    });
    const r = grownOf(covered);
    expect(
      plain.mask.alpha[Math.round((r[1] + 0.01) * H) * W + Math.round((r[0] + 0.005) * W)],
    ).toBe(0);
  });

  describe('lavish keep-mask', () => {
    const around = (box: NormalizedBox): NormalizedBox => [
      box[0] - 0.05,
      box[1] - 0.08,
      box[2] + 0.05,
      box[3] + 0.08,
    ];

    it('never leaves a text mark open: a covered mark keeps its analysis box', () => {
      const a = analysis();
      const planMask = build(a);
      const compositing = protectedCompositing({
        working: wall(),
        aligned: edited(),
        analysis: a,
        padRegions: [],
        attributionRegions: [],
        planMask,
        items: [covered, touched, untouched].map((box) => ({
          label: 'garland',
          box: around(box),
          placementId: null,
        })),
        placements,
        buildMask: ({ textMarks }) => build(a, textMarks),
        lavish: true,
      });
      expect(
        compositing.decisions.textMarks.map((mark) => [mark.kind, mark.mode, mark.decorated]),
      ).toEqual([
        ['house_number', 'exact', false],
        ['house_number', 'exact', false],
        ['sign', 'grown', false],
      ]);
      expect(compositing.openHouseNumbers).toEqual([]);
      for (let y = Math.round(covered[1] * H); y < Math.round(covered[3] * H); y += 1) {
        for (let x = Math.round(covered[0] * W); x < Math.round(covered[2] * W); x += 1) {
          expect(compositing.mask.alpha[y * W + x]).toBe(0);
        }
      }
      // The garland around the covered mark is kept.
      expect(compositing.mask.hard[Math.round(0.43 * H) * W + Math.round(covered[2] * W) + 2]).toBe(
        255,
      );
    });

    it("applies a repair's restore box on a plain wall and skips one amid a painted area", () => {
      const a = analysis();
      const planMask = build(a);
      const amid: NormalizedBox = [0.2, 0.6, 0.22, 0.63];
      const plain: NormalizedBox = [0.6, 0.6, 0.62, 0.63];
      const compositing = protectedCompositing({
        working: wall(),
        aligned: glowing(),
        analysis: a,
        restoreBoxes: [amid, plain],
        padRegions: [],
        attributionRegions: [],
        planMask,
        items: null,
        placements,
        buildMask: ({ textMarks }) => build(a, textMarks),
        lavish: true,
      });
      expect(compositing.decisions.restoreBoxes.map((box) => [box.box, box.applied])).toEqual([
        [amid, false],
        [plain, true],
      ]);
      expect(compositing.restoreBoxes).toEqual([plain]);
      const center = (box: NormalizedBox) =>
        Math.round(((box[1] + box[3]) / 2) * H) * W + Math.round(((box[0] + box[2]) / 2) * W);
      expect(compositing.mask.hard[center(plain)]).toBe(0);
      expect(compositing.mask.alpha[center(plain)]).toBe(0);
      expect(compositing.mask.hard[center(amid)]).toBe(255);
      expect(compositing.mask.alpha[center(amid)]).toBe(255);
    });
  });

  it('counts the plan shapes as the decorations when localization falls back', () => {
    const a = analysis();
    const planMask = build(a);
    const compositing = protectedCompositing({
      working: wall(),
      aligned: edited(),
      analysis: a,
      padRegions: [],
      attributionRegions: [],
      planMask,
      items: null,
      placements,
      buildMask: ({ textMarks }) => build(a, textMarks),
    });
    expect(compositing.keep).toBeNull();
    expect(compositing.decisions.textMarks.map((mark) => [mark.mode, mark.decorated])).toEqual([
      ['open', true],
      ['exact', false],
      ['grown', false],
    ]);
    // The rebuilt plan mask is the whole mask: the band stays over the open mark.
    expect(compositing.mask.alpha[Math.round(0.43 * H) * W + Math.round(0.21 * W)]).toBe(255);
    // Without shapes the region counts; a polygon counts by its bounding box.
    expect(
      placementDecorationBoxes([
        { region: [0.1, 0.1, 0.2, 0.2] },
        {
          region: [0.3, 0.3, 0.9, 0.9],
          maskShapes: [
            { kind: 'box', box: [0.3, 0.3, 0.4, 0.4] },
            {
              kind: 'polygon',
              points: [
                [0.5, 0.6],
                [0.8, 0.55],
                [0.7, 0.9],
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      [0.1, 0.1, 0.2, 0.2],
      [0.3, 0.3, 0.4, 0.4],
      [0.5, 0.55, 0.8, 0.9],
    ]);
  });

  it('keeps the plan mask when every mark is grown and every restore box applies', () => {
    const planMask = renderCompositeMask({
      analysis: analysis(),
      placements: [],
      width: W,
      height: H,
      padRegions: [],
      attributionRegions: [],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
    });
    let built = 0;
    const plainBox: NormalizedBox = [0.6, 0.6, 0.62, 0.63];
    const result = protectedCompositing({
      working: wall(),
      aligned: wall(),
      analysis: analysis(),
      restoreBoxes: [plainBox],
      padRegions: [],
      attributionRegions: [],
      planMask,
      items: null,
      placements: [],
      buildMask: () => {
        built += 1;
        return planMask;
      },
    });
    expect(built).toBe(0);
    expect(result.mask).toBe(planMask);
    expect(result.restoreBoxes).toEqual([plainBox]);
    expect(result.openHouseNumbers).toEqual([]);
  });
});
