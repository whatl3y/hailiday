import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  JUDGE_RESULT_SCHEMA_VERSION,
  SCENE_ANALYSIS_SCHEMA_VERSION,
  type DecorationPlan,
  type FailureCode,
  type JudgeResult,
  type NormalizedBox,
  type SceneAnalysis,
} from '@hailiday/core';
import { buildCompositeMask } from '../imaging/mask.js';
import { toRect } from '../imaging/raster.js';
import { prepareWorkingImage } from '../imaging/working.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import {
  GLOBAL_FINDING_CODES,
  criticalSpotsOnly,
  decorationsLeft,
  doubtedSpots,
  enoughDecorationsLeft,
  objectedSpots,
  placementsPutBack,
  restoredAreas,
  restoredBoxesOf,
  withRestoredSpots,
} from './last-resort.js';
import { compositeAndCheck } from './quality.js';

const thresholds = { ...PIPELINE_DEFAULTS.judgeThresholds };
const BOX: NormalizedBox = [0.45, 0.35, 0.5, 0.4];
const OTHER: NormalizedBox = [0.1, 0.1, 0.12, 0.12];

type Finding = { code: FailureCode; confidence: number; box?: NormalizedBox };

function judge(critical: Finding[], major: Finding[] = []): JudgeResult {
  const entry = (f: Finding) => ({
    code: f.code,
    confidence: f.confidence,
    evidence: 'Test finding.',
    ...(f.box ? { box: f.box } : {}),
  });
  return {
    schemaVersion: JUDGE_RESULT_SCHEMA_VERSION,
    renderAttemptId: 'attempt',
    judgeModel: 'test',
    judgePromptVersion: 'test',
    escalated: false,
    critical: critical.map(entry) as JudgeResult['critical'],
    major: major.map(entry) as JudgeResult['major'],
    placements: [],
    scores: { realism: 1, appeal: 1, planAdherence: 1 },
    overallConfidence: 1,
    elapsedMs: 0,
  };
}

describe('the spots a rejected verdict rests on', () => {
  it('are the boxes of every finding behind the verdict, each once', () => {
    const result = objectedSpots({
      judge: judge(
        [
          { code: 'structure_changed', confidence: 0.95, box: BOX },
          { code: 'people_altered', confidence: 0.5, box: OTHER },
          { code: 'structure_changed', confidence: 0.9, box: BOX },
        ],
        [{ code: 'implausible_decor', confidence: 0.9, box: OTHER }],
      ),
      deterministic: [],
      verdict: { codes: ['structure_changed', 'implausible_decor'] },
      thresholds,
    });
    expect(result).toEqual({
      codes: ['structure_changed', 'implausible_decor'],
      boxes: [BOX, OTHER],
      recordedMajors: [],
      criticalBoxes: [BOX, OTHER],
      boxedMajors: ['implausible_decor'],
    });
  });

  it('leave out findings under their floor and majors the verdict does not count', () => {
    const result = objectedSpots({
      judge: judge(
        [
          { code: 'structure_changed', confidence: 0.95, box: BOX },
          { code: 'text_added', confidence: 0.2 },
        ],
        [
          { code: 'implausible_decor', confidence: 0.9 },
          { code: 'plan_not_followed', confidence: 0.3 },
        ],
      ),
      deterministic: [],
      verdict: { codes: ['structure_changed'] },
      thresholds,
    });
    expect(result).toEqual({
      codes: ['structure_changed'],
      boxes: [BOX],
      recordedMajors: [],
      criticalBoxes: [BOX],
      boxedMajors: [],
    });
  });

  it('do not qualify when a critical finding behind the verdict has no box', () => {
    for (const findings of [
      [{ code: 'structure_changed', confidence: 0.95 }],
      [
        { code: 'structure_changed', confidence: 0.95, box: BOX },
        { code: 'access_blocked', confidence: 0.5 },
      ],
    ] satisfies Finding[][]) {
      expect(
        objectedSpots({
          judge: judge(findings),
          deterministic: [],
          verdict: { codes: ['structure_changed'] },
          thresholds,
        }),
      ).toBeNull();
    }
  });

  it('record a confident major without a box instead of putting it back', () => {
    expect(
      objectedSpots({
        judge: judge(
          [{ code: 'structure_changed', confidence: 0.95, box: BOX }],
          [
            { code: 'implausible_decor', confidence: 0.9 },
            { code: 'plan_not_followed', confidence: 0.9, box: OTHER },
          ],
        ),
        deterministic: [],
        verdict: { codes: ['structure_changed', 'implausible_decor', 'plan_not_followed'] },
        thresholds,
      }),
    ).toEqual({
      codes: ['structure_changed', 'implausible_decor', 'plan_not_followed'],
      boxes: [BOX, OTHER],
      recordedMajors: ['implausible_decor'],
      criticalBoxes: [BOX],
      boxedMajors: ['plan_not_followed'],
    });
    // Majors alone with no box leave nothing to put back.
    expect(
      objectedSpots({
        judge: judge([], [{ code: 'implausible_decor', confidence: 0.9 }]),
        deterministic: [],
        verdict: { codes: ['implausible_decor'] },
        thresholds,
      }),
    ).toBeNull();
  });

  it('do not qualify with a global code that is only doubted beside a confident boxed finding', () => {
    for (const code of GLOBAL_FINDING_CODES) {
      expect(
        objectedSpots({
          judge: judge([
            { code: 'structure_changed', confidence: 0.95, box: BOX },
            { code, confidence: 0.5, box: OTHER },
          ]),
          deterministic: [],
          // A doubted code is not among the codes of a verdict a confident finding failed.
          verdict: { codes: ['structure_changed'] },
          thresholds,
        }),
      ).toBeNull();
    }
  });

  it('do not qualify when the verdict rests on a deterministic code', () => {
    expect(
      objectedSpots({
        judge: judge([{ code: 'structure_changed', confidence: 0.95, box: BOX }]),
        deterministic: ['implausible_decor'],
        verdict: { codes: ['structure_changed', 'implausible_decor'] },
        thresholds,
      }),
    ).toBeNull();
  });

  it('do not qualify with a global code, boxed or not', () => {
    expect(GLOBAL_FINDING_CODES).toEqual([
      'wrong_property',
      'camera_changed',
      'unsafe_or_offensive',
      'attribution_altered',
    ]);
    for (const code of GLOBAL_FINDING_CODES) {
      expect(
        objectedSpots({
          judge: judge([
            { code: 'structure_changed', confidence: 0.95, box: BOX },
            { code, confidence: 0.95, box: OTHER },
          ]),
          deterministic: [],
          verdict: { codes: ['structure_changed', code] },
          thresholds,
        }),
      ).toBeNull();
    }
  });

  it('can be put back without the boxes of the confident majors, which are then recorded', () => {
    const spots = objectedSpots({
      judge: judge(
        [{ code: 'structure_changed', confidence: 0.95, box: BOX }],
        [
          { code: 'implausible_decor', confidence: 0.9 },
          { code: 'plan_not_followed', confidence: 0.9, box: OTHER },
          { code: 'unrequested_change', confidence: 0.9, box: BOX },
        ],
      ),
      deterministic: [],
      verdict: {
        codes: [
          'structure_changed',
          'implausible_decor',
          'plan_not_followed',
          'unrequested_change',
        ],
      },
      thresholds,
    });
    expect(spots).not.toBeNull();
    expect(criticalSpotsOnly(spots as NonNullable<typeof spots>)).toEqual({
      codes: ['structure_changed', 'implausible_decor', 'plan_not_followed', 'unrequested_change'],
      boxes: [BOX],
      recordedMajors: ['implausible_decor', 'plan_not_followed', 'unrequested_change'],
      criticalBoxes: [BOX],
      boxedMajors: [],
    });
    // Nothing to leave out without a boxed major, and nothing to put back without a critical box.
    const criticalOnly = objectedSpots({
      judge: judge([{ code: 'structure_changed', confidence: 0.95, box: BOX }]),
      deterministic: [],
      verdict: { codes: ['structure_changed'] },
      thresholds,
    });
    expect(criticalSpotsOnly(criticalOnly as NonNullable<typeof criticalOnly>)).toBeNull();
    const majorsOnly = objectedSpots({
      judge: judge([], [{ code: 'plan_not_followed', confidence: 0.9, box: OTHER }]),
      deterministic: [],
      verdict: { codes: ['plan_not_followed'] },
      thresholds,
    });
    expect(majorsOnly).toMatchObject({ boxes: [OTHER], criticalBoxes: [] });
    expect(criticalSpotsOnly(majorsOnly as NonNullable<typeof majorsOnly>)).toBeNull();
  });

  it('do not qualify without a finding', () => {
    expect(
      objectedSpots({ judge: judge([]), deterministic: [], verdict: { codes: [] }, thresholds }),
    ).toBeNull();
  });
});

describe('the doubted spots of a judge result', () => {
  it('are the boxes of its critical findings between the floor and the critical threshold', () => {
    expect(
      doubtedSpots(
        judge([
          { code: 'structure_changed', confidence: 0.5, box: BOX },
          { code: 'text_added', confidence: 0.45 },
          { code: 'access_blocked', confidence: 0.95, box: OTHER },
          { code: 'camera_changed', confidence: 0.5, box: OTHER },
          { code: 'structure_changed', confidence: 0.3, box: OTHER },
        ]),
        thresholds,
      ),
    ).toEqual({ codes: ['structure_changed'], boxes: [BOX] });
  });

  it('are none when no doubt has a box', () => {
    expect(
      doubtedSpots(judge([{ code: 'structure_changed', confidence: 0.5 }]), thresholds),
    ).toBeNull();
    expect(doubtedSpots(null, thresholds)).toBeNull();
  });
});

describe('what a restore leaves of the decorations', () => {
  const grid = { width: 200, height: 100 };

  it('measures the decorations outside the grown boxes and the best placement', () => {
    const decorations: NormalizedBox[] = [
      [0, 0, 0.5, 1],
      [0.25, 0, 0.75, 1],
    ];
    // The grown box covers x from 0.5 - 0.03 to 1 (6 columns of the 200): the union of the
    // decorations is 150 columns of which 94 stay.
    expect(PIPELINE_DEFAULTS.lastResort.growFraction).toBe(0.03);
    const left = decorationsLeft({
      ...grid,
      decorations,
      placements: decorations,
      boxes: [[0.5, 0, 1, 1]],
    });
    expect(left.keptShare).toBeCloseTo(94 / 150, 5);
    expect(left.placementShare).toBeCloseTo(94 / 100, 5);
  });

  it('leaves everything without boxes and nothing when the boxes cover it all', () => {
    const decorations: NormalizedBox[] = [[0.2, 0.2, 0.4, 0.4]];
    expect(decorationsLeft({ ...grid, decorations, placements: decorations, boxes: [] })).toEqual({
      keptShare: 1,
      placementShare: 1,
    });
    expect(
      decorationsLeft({ ...grid, decorations, placements: decorations, boxes: [[0, 0, 1, 1]] }),
    ).toEqual({ keptShare: 0, placementShare: 0 });
    expect(decorationsLeft({ ...grid, decorations: [], placements: [], boxes: [] })).toEqual({
      keptShare: 0,
      placementShare: 0,
    });
  });

  it('is enough at the configured shares', () => {
    const { minKeptShare, minPlacementShare, minKeptShareDoubt } = PIPELINE_DEFAULTS.lastResort;
    expect([minKeptShare, minPlacementShare, minKeptShareDoubt]).toEqual([0.4, 0.6, 0.85]);
    const at = (keptShare: number, placementShare: number) => ({ keptShare, placementShare });
    expect(enoughDecorationsLeft(at(0.4, 0.6), 'objected')).toBe(true);
    expect(enoughDecorationsLeft(at(0.39, 1), 'objected')).toBe(false);
    expect(enoughDecorationsLeft(at(1, 0.59), 'objected')).toBe(false);
    expect(enoughDecorationsLeft(at(0.85, 0), 'doubted')).toBe(true);
    expect(enoughDecorationsLeft(at(0.84, 1), 'doubted')).toBe(false);
  });

  it('takes out the placements that keep less than the placement share outside the boxes', () => {
    const placements = [
      // Under the grown box but for 6 of its 100 columns: taken out.
      { id: 'covered', region: [0.5, 0, 1, 1] as NormalizedBox },
      // 94 of its 100 columns outside the grown box: kept.
      { id: 'beside', region: [0, 0, 0.5, 1] as NormalizedBox },
      // Half of it under the grown box: kept at a share of 0.5 only with a lower setting.
      { id: 'half', region: [0.32, 0, 0.62, 1] as NormalizedBox },
    ];
    const boxes: NormalizedBox[] = [[0.5, 0, 1, 1]];
    expect(placementsPutBack({ ...grid, placements, boxes })).toEqual(['covered', 'half']);
    expect(
      placementsPutBack({ ...grid, placements, boxes, settings: { minPlacementShare: 0.5 } }),
    ).toEqual(['covered']);
    expect(placementsPutBack({ ...grid, placements, boxes: [] })).toEqual([]);
  });

  it('reads the restored boxes an attempt recorded', () => {
    expect(
      restoredBoxesOf({ rle: 'x', restored: { kind: 'objected', boxes: [BOX, ['x']] } }),
    ).toEqual([BOX]);
    expect(restoredBoxesOf({ rle: 'x' })).toEqual([]);
    expect(restoredBoxesOf(null)).toEqual([]);
  });
});

describe('a composite with spots restored', () => {
  const REGION: NormalizedBox = [0.4, 0.3, 0.6, 0.5];

  const analysis = (width: number, height: number, checksum: string): SceneAnalysis => ({
    schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION,
    sourceAssetId: 'sa',
    workingImage: { width, height, checksum },
    sceneType: 'house_exterior',
    sceneTypeConfidence: 0.9,
    sceneTypeMismatch: false,
    targetFacade: [0.05, 0.1, 0.95, 0.95],
    targetFacadeAmbiguous: false,
    anchors: [],
    preserveRegions: [],
    accessRegions: [],
    hazards: [],
    existingDecorations: { present: false, density: 'none', boxes: [] },
    peopleBoxes: [],
    protectedBlurRegions: [],
    lighting: { timeOfDay: 'day', isDaylight: true, exposure: 'normal' },
    seasonCues: { snowVisible: false, foliage: 'leafy' },
    qualityFlags: {
      blur: false,
      lowLight: false,
      heavyOcclusion: false,
      multipleBuildings: false,
      embeddedPhoto: false,
      tooClose: false,
      tooFar: false,
    },
    model: { analysisModel: 'test', analysisPromptVersion: 'test' },
    elapsedMs: 0,
  });

  const plan: Pick<
    DecorationPlan,
    'lightingMode' | 'fidelityMode' | 'placements' | 'preserve' | 'compositeMask'
  > = {
    lightingMode: 'source',
    fidelityMode: 'composite_additive',
    placements: [
      {
        id: 'p1',
        kitItemId: 'christmas.house_exterior.wreath_evergreen',
        anchorId: 'a1',
        anchorCategory: 'front_door',
        region: REGION,
        placementRule: 'centered_on',
        count: 1,
        specText: 'a wreath',
        specAttributes: {},
        lit: false,
        priority: 1,
      },
    ],
    preserve: {
      regions: [],
      protectedBlurRegions: [],
      peopleBoxes: [],
      accessRegions: [],
      existingDecorations: [],
      keepSkyAndTimeOfDay: true,
      neighborsUnchanged: true,
      noSnow: true,
    },
    compositeMask: { dilationFraction: 0.04, featherFraction: 0.02 },
  };

  it('keeps the original inside the grown boxes and the decorations around them', async () => {
    const photo = new URL(
      '../../../content/photos/samples/sample-front-porch.jpg',
      import.meta.url,
    );
    const working = await prepareWorkingImage(readFileSync(photo), 'upload');
    const { width, height } = working;
    const decorated = { ...working.raster, data: Buffer.from(working.raster.data) };
    const region = toRect(REGION, width, height);
    for (let y = region.y0 + 10; y < region.y1 - 10; y += 1) {
      for (let x = region.x0 + 10; x < region.x1 - 10; x += 1) {
        const p = (y * width + x) * 3;
        decorated.data[p] = 200;
        decorated.data[p + 1] = 30;
        decorated.data[p + 2] = 40;
      }
    }
    const rawBytes = await sharp(decorated.data, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    const mask = buildCompositeMask({
      width,
      height,
      regions: [REGION],
      dilationFraction: 0.04,
      featherFraction: 0.02,
    });
    const restored = withRestoredSpots(mask, [BOX]);
    const [grown] = restoredAreas([BOX], width, height) as [NormalizedBox];
    const rect = toRect(grown, width, height);
    const inside = (i: number) => {
      const x = i % width;
      const y = Math.floor(i / width);
      return x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
    };
    expect(restored.checksum).not.toBe(mask.checksum);
    for (let i = 0; i < mask.hard.length; i += 1) {
      if (inside(i)) {
        expect(restored.hard[i]).toBe(0);
        expect(restored.alpha[i]).toBe(0);
      } else if (restored.hard[i] !== mask.hard[i] || restored.alpha[i] !== mask.alpha[i]) {
        throw new Error(`pixel ${i} outside the grown box changed`);
      }
    }

    const input = {
      working,
      rawBytes,
      requested: { width, height },
      plan,
      analysis: analysis(width, height, working.checksum),
      attributionRegion: null,
      glowRegions: [],
    };
    const before = await compositeAndCheck({ ...input, mask });
    const after = await compositeAndCheck({ ...input, mask: restored });
    let changedInside = 0;
    let decoratedOutside = 0;
    for (let i = 0; i < width * height; i += 1) {
      const differs = (raster: typeof before.candidate) =>
        [0, 1, 2].some((c) => raster.data[i * 3 + c] !== working.raster.data[i * 3 + c]);
      if (inside(i)) {
        if (differs(after.candidate)) changedInside += 1;
      } else if (differs(after.candidate)) {
        decoratedOutside += 1;
      }
    }
    expect(changedInside).toBe(0);
    expect(decoratedOutside).toBeGreaterThan(1000);
    // Before the restore the editor's pixels were inside the box.
    const centre = toRect(BOX, width, height);
    const p = ((centre.y0 + 2) * width + centre.x0 + 2) * 3;
    expect(before.candidate.data[p]).not.toBe(working.raster.data[p]);
    expect(after.deterministic.codes).toEqual([]);
  });
});
