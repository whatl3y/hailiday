import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { MaskShape, NormalizedBox, SceneAnalysis } from '@holiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { buildPlan } from '../plan/builder.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { toRect } from './raster.js';
import {
  boxesHardMask,
  buildCompositeMask,
  compositeProtection,
  dilationHang,
  placementMaskParts,
  placementMaskShapes,
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

describe('composite mask dilation by shape class', () => {
  it('dilates band shapes by the band dilation and boxes by the box dilation', () => {
    const band: MaskShape = { kind: 'box', box: [0.1, 0.5, 0.4, 0.52] };
    const box: MaskShape = { kind: 'box', box: [0.6, 0.5, 0.7, 0.6] };
    const mask = buildCompositeMask({
      width: 1000,
      height: 1000,
      shapes: [box],
      bands: [band],
      dilationFraction: 0.04,
      bandDilationFraction: 0.0125,
      featherFraction: 0,
    });
    expect(mask).toMatchObject({ dilationPx: 40, bandDilationPx: 13 });
    const at = (x: number, y: number) => mask.hard[y * 1000 + x];
    // Band: 13 px above its top edge (y 500) is editable, 14 px is not.
    expect(at(250, 487)).toBe(255);
    expect(at(250, 486)).toBe(0);
    // Box: 40 px above its top edge.
    expect(at(650, 460)).toBe(255);
    expect(at(650, 459)).toBe(0);
    // Bands never dilate more than boxes.
    const capped = buildCompositeMask({
      width: 1000,
      height: 1000,
      bands: [band],
      dilationFraction: 0.01,
      bandDilationFraction: 0.0125,
      featherFraction: 0,
    });
    expect(capped.bandDilationPx).toBe(10);
  });

  it('fades each shape class to 0 inside its own band: full on the shape, no step at the edge', () => {
    // The production working size, where the 2% feather is wider than the band dilation.
    const W = 1536;
    const H = 1024;
    const box: NormalizedBox = [0.2, 0.3, 0.35, 0.5];
    const band: NormalizedBox = [0.5, 0.6, 0.9, 0.62];
    const access: NormalizedBox = [0.1, 0.38, 0.19, 0.42];
    const exclusion: NormalizedBox = [0.36, 0.3, 0.4, 0.5];
    const mask = buildCompositeMask({
      width: W,
      height: H,
      shapes: [{ kind: 'box', box }],
      bands: [{ kind: 'box', box: band }],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      bandDilationFraction: PIPELINE_DEFAULTS.bandDilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
      exclusions: [exclusion],
      access: [access],
    });
    expect(mask).toMatchObject({ dilationPx: 61, bandDilationPx: 19, featherPx: 31 });
    // The hard mask is the dilated shapes minus the cuts, as before.
    const expected = boxesHardMask(W, H, [box], mask.dilationPx);
    const bandHard = boxesHardMask(W, H, [band], mask.bandDilationPx);
    for (const rect of [toRect(access, W, H), toRect(exclusion, W, H)]) {
      for (let y = rect.y0; y < rect.y1; y += 1)
        for (let x = rect.x0; x < rect.x1; x += 1) expected[y * W + x] = 0;
    }
    for (let i = 0; i < expected.length; i += 1) if (bandHard[i]) expected[i] = 255;
    expect(Buffer.from(mask.hard).equals(Buffer.from(expected))).toBe(true);
    const { hard, alpha } = mask;
    for (const [shape, dilationPx] of [
      [box, mask.dilationPx],
      [band, mask.bandDilationPx],
    ] as const) {
      const x0 = Math.round(shape[0] * W);
      const x1 = Math.round(shape[2] * W);
      const y0 = Math.round(shape[1] * H);
      const y1 = Math.round(shape[3] * H);
      const midY = Math.floor((y0 + y1) / 2);
      const midX = Math.floor((x0 + x1) / 2);
      // Outward profiles from the shape's edges (the box's right edge meets the exclusion).
      const profiles: { inside: number; step: (d: number) => number }[] = [
        { inside: (y0 + 2) * W + x0, step: (d) => (y0 + 2) * W + (x0 - d) },
        { inside: y0 * W + midX, step: (d) => (y0 - d) * W + midX },
        { inside: (y1 - 1) * W + midX, step: (d) => (y1 - 1 + d) * W + midX },
      ];
      if (shape === band)
        profiles.push({ inside: midY * W + (x1 - 1), step: (d) => midY * W + (x1 - 1 + d) });
      for (const { inside, step } of profiles) {
        expect(alpha[inside]).toBe(255);
        let outermost = 0;
        for (let d = 1; hard[step(d)]; d += 1) {
          outermost = d;
          expect(alpha[step(d)] as number).toBeLessThanOrEqual(alpha[step(d - 1)] as number);
        }
        expect(outermost).toBe(dilationPx);
        expect(alpha[step(outermost)] as number).toBeLessThanOrEqual(16);
        expect(alpha[step(outermost + 1)]).toBe(0);
        // A gradual ramp: no adjacent pair of pixels differs by more than an eighth.
        for (let d = 1; d <= outermost + 1; d += 1) {
          const drop = (alpha[step(d - 1)] as number) - (alpha[step(d)] as number);
          expect(drop, `${dilationPx} px band, offset ${d}`).toBeLessThanOrEqual(32);
        }
      }
      // The whole shape keeps full alpha.
      for (let y = y0; y < y1; y += 3) {
        for (let x = x0; x < x1; x += 3) expect(alpha[y * W + x], `${x},${y}`).toBe(255);
      }
    }
    // Exclusions and access cut-outs are 0 in the alpha too.
    for (const cut of [access, exclusion]) {
      const rect = toRect(cut, W, H);
      for (let y = rect.y0; y < rect.y1; y += 5)
        for (let x = rect.x0; x < rect.x1; x += 5) expect(alpha[y * W + x]).toBe(0);
    }
    // Without a feather the alpha is the hard mask.
    const unfeathered = buildCompositeMask({
      width: W,
      height: H,
      shapes: [{ kind: 'box', box }],
      bands: [{ kind: 'box', box: band }],
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      bandDilationFraction: PIPELINE_DEFAULTS.bandDilationFraction,
      featherFraction: 0,
      exclusions: [exclusion],
      access: [access],
    });
    expect(Buffer.from(unfeathered.alpha).equals(Buffer.from(unfeathered.hard))).toBe(true);
  });

  it('classes the tight shapes of `along` placements as bands and everything else as boxes', () => {
    const parts = placementMaskParts([
      {
        region: [0.1, 0.4, 0.9, 0.6],
        placementRule: 'along',
        maskShapes: [{ kind: 'box', box: [0.1, 0.585, 0.9, 0.615] }],
      },
      { region: [0.45, 0.5, 0.55, 0.65], placementRule: 'centered_on' },
      {
        region: [0.2, 0.7, 0.3, 0.8],
        placementRule: 'cluster_at',
        maskShapes: [{ kind: 'box', box: [0.2, 0.7, 0.3, 0.8] }],
      },
    ]);
    expect(parts.bands).toEqual([{ kind: 'box', box: [0.1, 0.585, 0.9, 0.615] }]);
    expect(parts.shapes).toEqual([
      { kind: 'box', box: [0.45, 0.5, 0.55, 0.65] },
      { kind: 'box', box: [0.2, 0.7, 0.3, 0.8] },
    ]);
  });

  it('keeps the bungalow composite at or under 25% of the frame', () => {
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
    const { width, height } = analysis.workingImage;
    const placements = built.draft.placements;
    const exclusions = analysis.preserveRegions
      .filter((region) => ['house_number', 'sign', 'logo'].includes(region.kind))
      .map((region) => region.box);
    const maskWith = (bandDilationFraction: number) => {
      const protection = compositeProtection(
        analysis,
        placements,
        dilationHang(bandDilationFraction, width, height),
      );
      return buildCompositeMask({
        width,
        height,
        ...placementMaskParts(placements),
        dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
        bandDilationFraction,
        featherFraction: PIPELINE_DEFAULTS.featherFraction,
        exclusions: [...exclusions, ...protection.exclusions],
        access: protection.keepOuts,
      });
    };
    // Every shape at the box dilation, as before: well over the quarter.
    const uniform = buildCompositeMask({
      width,
      height,
      shapes: placementMaskShapes(placements),
      dilationFraction: PIPELINE_DEFAULTS.dilationFraction,
      featherFraction: PIPELINE_DEFAULTS.featherFraction,
      exclusions: [
        ...exclusions,
        ...compositeProtection(
          analysis,
          placements,
          dilationHang(PIPELINE_DEFAULTS.dilationFraction, width, height),
        ).exclusions,
      ],
    });
    expect(coverage(uniform.hard)).toBeGreaterThan(0.25);
    const banded = maskWith(PIPELINE_DEFAULTS.bandDilationFraction);
    expect(coverage(banded.hard)).toBeLessThanOrEqual(0.25);
    expect(banded.bandDilationPx).toBe(Math.round(0.0125 * 1536));
  });
});
