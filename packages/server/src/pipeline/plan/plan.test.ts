import { beforeAll, describe, expect, it } from 'vitest';
import {
  SCENE_ANALYSIS_SCHEMA_VERSION,
  STYLES,
  type Anchor,
  type HolidayPack,
  type NormalizedBox,
  type SceneAnalysis,
  type SceneType,
} from '@holiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { genericUploadGeometry } from '../../fixtures/layouts.js';
import { geometryToModelOutput } from '../../fixtures/scene.js';
import { buildPlan, withoutPlacements } from './builder.js';
import { shrinkToAllowed } from './geometry.js';
import { deriveRepair, isRepairable } from './repair.js';
import type { BuildPlanInput } from './types.js';
import { existingDecorConflict, forbiddenViolations } from './validator.js';

let content: Content;
beforeAll(async () => {
  content = await loadContent();
});

const anchor = (
  id: string,
  category: Anchor['category'],
  box: NormalizedBox,
  confidence = 0.9,
  occlusionFraction?: number,
): Anchor => ({
  id,
  category,
  box,
  confidence,
  occluded: (occlusionFraction ?? 0) > 0.05,
  ...(occlusionFraction !== undefined ? { occlusionFraction } : {}),
});

/** A hand-built exterior analysis on a 1024×1024 grid. */
function exterior(overrides: Partial<SceneAnalysis> = {}): SceneAnalysis {
  return {
    schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION,
    sourceAssetId: 'sa_test',
    workingImage: { width: 1024, height: 1024, checksum: 'c' },
    sceneType: 'house_exterior',
    sceneTypeConfidence: 0.95,
    sceneTypeMismatch: false,
    buildingForm: 'detached',
    targetFacade: [0.14, 0.18, 0.86, 0.95],
    targetFacadeAmbiguous: false,
    anchors: [
      anchor('a1', 'front_door', [0.46, 0.5, 0.54, 0.8]),
      anchor('a2', 'porch_rail', [0.22, 0.64, 0.42, 0.72], 0.85),
      anchor('a3', 'porch_steps', [0.42, 0.8, 0.58, 0.92], 0.88),
      anchor('a4', 'eaves', [0.16, 0.3, 0.84, 0.34], 0.55),
      anchor('a5', 'roofline', [0.15, 0.2, 0.85, 0.25], 0.92, 0.5),
      anchor('a6', 'door_frame', [0.44, 0.48, 0.56, 0.81], 0.9),
    ],
    preserveRegions: [{ kind: 'house_number', box: [0.58, 0.6, 0.62, 0.64] }],
    accessRegions: [
      { kind: 'door', box: [0.46, 0.5, 0.54, 0.8] },
      { kind: 'steps', box: [0.42, 0.8, 0.58, 0.95] },
    ],
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
    ...overrides,
  };
}

function input(
  pack: HolidayPack,
  analysis: SceneAnalysis,
  overrides: Partial<BuildPlanInput> = {},
): BuildPlanInput {
  return {
    renderJobId: 'job',
    planVersion: 1,
    sourceAssetId: 'sa_test',
    sceneAnalysisId: 'an_test',
    analysis,
    sourceKind: 'upload',
    pack,
    holidayPackVersion: pack.version,
    styleKitVersionId: 'kit',
    sceneType: analysis.sceneType,
    style: 'classic',
    lightingMode: 'source',
    compilerVersion: 'test-1',
    permissionEvaluationId: 'pe',
    ...overrides,
  };
}

const pack = (holidayId: 'christmas' | 'thanksgiving_us' | 'halloween' | 'new_years_eve') =>
  content.packFor(holidayId)?.pack as HolidayPack;

describe('decoration plan validator rules', () => {
  it('only places on anchors above the confidence and occlusion floors', () => {
    const built = buildPlan(input(pack('christmas'), exterior()));
    expect(built.validator.passed).toBe(true);
    const anchors = built.draft.placements.map((p) => p.anchorId);
    expect(anchors).not.toContain('a4');
    expect(anchors).not.toContain('a5');
  });

  it('removes placements over people or blurred regions (zero tolerance)', () => {
    const analysis = exterior({ peopleBoxes: [[0.3, 0.6, 0.35, 0.75]] });
    const built = buildPlan(input(pack('christmas'), analysis));
    expect(built.draft.placements.some((p) => p.anchorId === 'a2')).toBe(false);
    expect(
      built.validator.events.some((e) => e.rule === 'protected_regions' && e.action === 'removed'),
    ).toBe(true);
  });

  it('keeps access and preserve overlap within the tolerance (shrinks, else removes)', () => {
    const shrunk = shrinkToAllowed([0.3, 0.3, 0.6, 0.6], [[0.5, 0.3, 0.7, 0.6]], 0.1);
    expect(shrunk).toEqual([0.3, 0.3, 0.5, 0.6]);
    expect(shrinkToAllowed([0.5, 0.3, 0.6, 0.6], [[0.4, 0.2, 0.7, 0.7]], 0.1)).toBeNull();
    const built = buildPlan(input(pack('christmas'), exterior()));
    // A hung wreath may sit on the door; standing items never block the steps.
    expect(built.draft.placements.some((p) => p.anchorCategory === 'front_door')).toBe(true);
    for (const placement of built.draft.placements.filter((p) => p.placementRule === 'beside')) {
      const [x0, y0, x1, y1] = placement.region;
      const overlapX = Math.max(0, Math.min(x1, 0.58) - Math.max(x0, 0.42));
      const overlapY = Math.max(0, Math.min(y1, 0.95) - Math.max(y0, 0.8));
      expect((overlapX * overlapY) / ((x1 - x0) * (y1 - y0))).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it('keeps exterior placements on the target facade and away from its side edges', () => {
    const analysis = exterior({ targetFacade: [0.3, 0.18, 0.86, 0.95] });
    const built = buildPlan(input(pack('christmas'), analysis));
    for (const placement of built.draft.placements) {
      expect(placement.region[0]).toBeGreaterThanOrEqual(0.3 + 0.02 - 1e-6);
      expect(placement.region[2]).toBeLessThanOrEqual(0.86 - 0.02 + 1e-6);
    }
    const none = buildPlan(
      input(pack('christmas'), exterior({ targetFacade: undefined, targetFacadeAmbiguous: true })),
    );
    expect(none.validator).toMatchObject({ passed: false, failure: 'non_empty' });
  });

  it('fails the plan when reviewed text introduces a forbidden item', () => {
    expect(
      forbiddenViolations(['people', 'religious_symbols'], ['a nativity scene', 'a Santa figure']),
    ).toEqual(['people', 'religious_symbols']);
    const bad = structuredClone(pack('christmas'));
    const section = bad.sceneSections.house_exterior;
    if (!section) throw new Error('missing section');
    section.kit[1] = { ...section.kit[1]!, specText: 'a wreath held by a smiling Santa figure' };
    const built = buildPlan(input(bad, exterior()));
    expect(built.validator).toMatchObject({ passed: false, failure: 'forbidden_list' });
  });

  it('never compiles snow unless the source shows it', () => {
    const snowy = structuredClone(pack('christmas'));
    const section = snowy.sceneSections.house_exterior;
    if (!section) throw new Error('missing section');
    section.kit[1] = { ...section.kit[1]!, specText: 'a snow-dusted evergreen wreath' };
    const plain = buildPlan(input(snowy, exterior()));
    expect(plain.draft.placements.some((p) => p.specText.includes('snow'))).toBe(false);
    expect(plain.draft.preserve.noSnow).toBe(true);
    // The pack's own negative fragment already states the snow rule, so it is not repeated.
    expect(`${plain.draft.negatives.join(', ')} ${section.promptFragments.negative}`).toMatch(
      /snow/,
    );
    const winter = buildPlan(
      input(snowy, exterior({ seasonCues: { snowVisible: true, foliage: 'bare' } })),
    );
    expect(winter.draft.placements.some((p) => p.specText.includes('snow'))).toBe(true);
    expect(winter.draft.negatives).not.toContain('snow or frost');
  });

  it('keeps Thanksgiving exteriors unlit', () => {
    const built = buildPlan(input(pack('thanksgiving_us'), exterior()));
    expect(built.draft.placements.every((p) => !p.lit)).toBe(true);
    expect(built.draft.lightingInstruction.text).toContain('No electric lights');
  });

  it('flags a conflicting existing decoration, never covers it, and steps the style down at high density', () => {
    expect(
      existingDecorConflict(
        { present: true, holidayGuess: 'halloween', density: 'medium', boxes: [] },
        'christmas',
      ),
    ).toBe(true);
    expect(
      existingDecorConflict(
        { present: true, holidayGuess: 'christmas', density: 'high', boxes: [] },
        'christmas',
      ),
    ).toBe(false);
    expect(
      existingDecorConflict(
        { present: true, holidayGuess: 'halloween', density: 'low', boxes: [] },
        'christmas',
      ),
    ).toBe(false);
    const analysis = exterior({
      existingDecorations: {
        present: true,
        holidayGuess: 'halloween',
        density: 'high',
        boxes: [[0.22, 0.6, 0.42, 0.75]],
      },
    });
    const built = buildPlan(input(pack('christmas'), analysis, { style: 'abundant' }));
    expect(built.draft.existingDecorConflict).toBe(true);
    expect(built.validator.effectiveStyle).toBe('classic');
    expect(built.draft.placements.some((p) => p.anchorId === 'a2')).toBe(false);
  });

  it('clamps counts to the style rule and the section cap', () => {
    for (const style of STYLES) {
      const built = buildPlan(input(pack('christmas'), exterior(), { style }));
      const section = pack('christmas').sceneSections.house_exterior;
      expect(built.draft.placements.length).toBeLessThanOrEqual(
        section?.limits.maxPlacements[style] ?? 0,
      );
      for (const item of section?.kit ?? []) {
        const total = built.draft.placements
          .filter((p) => p.kitItemId === item.kitItemId)
          .reduce((s, p) => s + p.count, 0);
        expect(total).toBeLessThanOrEqual(item.quantity[style][1]);
      }
    }
  });

  it('fails non-empty when no anchor survives', () => {
    const analysis = exterior({
      anchors: exterior().anchors.map((a) => ({ ...a, confidence: 0.3 })),
    });
    expect(buildPlan(input(pack('christmas'), analysis)).validator).toMatchObject({
      passed: false,
      failure: 'non_empty',
    });
  });

  it('builds a valid, deterministic plan for every pack scene section, style and lighting mode', () => {
    for (const { pack: holidayPack } of content.packs) {
      for (const [sceneType, section] of Object.entries(holidayPack.sceneSections) as [
        SceneType,
        NonNullable<HolidayPack['sceneSections'][SceneType]>,
      ][]) {
        const roomTypes =
          sceneType === 'interior' ? (section.roomTypes ?? ['living_room']) : [null];
        for (const roomType of roomTypes) {
          const geometry = genericUploadGeometry({
            sceneType,
            roomType,
            width: 1024,
            height: 1024,
          });
          const analysis: SceneAnalysis = {
            schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION,
            sourceAssetId: 'sa',
            workingImage: { width: 1024, height: 1024, checksum: 'c' },
            ...geometryToModelOutput(geometry),
            sceneTypeMismatch: false,
            model: { analysisModel: 't', analysisPromptVersion: 't' },
            elapsedMs: 0,
          };
          for (const style of STYLES) {
            for (const lightingMode of holidayPack.lightingPolicy.bySceneType[sceneType]?.offered ??
              []) {
              const args = input(holidayPack, analysis, {
                sceneType,
                roomType,
                style,
                lightingMode,
              });
              const built = buildPlan(args);
              expect(
                built.validator.failure,
                `${holidayPack.holidayId}.${sceneType}.${roomType}.${style}`,
              ).not.toBe('forbidden_list');
              expect(JSON.stringify(buildPlan(args))).toBe(JSON.stringify(built));
            }
          }
        }
      }
    }
  });

  it('removes placements and renumbers them', () => {
    const built = buildPlan(input(pack('christmas'), exterior()));
    const last = built.draft.placements[built.draft.placements.length - 1]?.id as string;
    const fewer = withoutPlacements(built, [last]);
    expect(fewer.draft.placements).toHaveLength(built.draft.placements.length - 1);
    expect(fewer.draft.placements.map((p) => p.id)).toEqual(
      fewer.draft.placements.map((_, i) => `p${i + 1}`),
    );
  });
});

describe('repair constraints', () => {
  it('classifies repairable codes', () => {
    expect(isRepairable(['structure_changed', 'implausible_decor'])).toBe(true);
    expect(isRepairable(['wrong_property'])).toBe(false);
    expect(isRepairable(['camera_changed', 'unsafe_or_offensive'])).toBe(false);
    expect(isRepairable([])).toBe(false);
  });

  it('derives plan version 2 adjustments from the failure codes', () => {
    const first = buildPlan(input(pack('christmas'), exterior()));
    const plan = {
      ...first.draft,
      compiled: {
        provider: 'fixture',
        modelSnapshot: 'f',
        instructionText: 'x',
        parameters: {},
        hash: 'h',
      },
    };
    const structure = deriveRepair(
      plan,
      first.placementKeys,
      [{ code: 'structure_changed' }],
      null,
    );
    expect(structure.adjustments.excludePairs).toHaveLength(1);
    expect(structure.adjustments.dilationFraction).toBeCloseTo(0.03);
    const second = buildPlan(
      input(pack('christmas'), exterior(), { planVersion: 2, repair: structure }),
    );
    expect(second.draft.placements.length).toBe(first.draft.placements.length - 1);
    expect(second.draft.repairConstraints?.[0]?.code).toBe('structure_changed');
    expect(second.draft.compositeMask?.dilationFraction).toBeCloseTo(0.03);

    const access = deriveRepair(plan, first.placementKeys, [{ code: 'access_blocked' }], null);
    expect(access.adjustments.accessTolerance).toBe(0);
    const camera = deriveRepair(plan, first.placementKeys, [{ code: 'camera_changed' }], null);
    expect(camera.adjustments.lowerQuality).toBe(true);
    const plausibility = deriveRepair(
      plan,
      first.placementKeys,
      [{ code: 'implausible_decor' }],
      null,
    );
    expect(plausibility.adjustments.countsToMinimum).toBe(true);
  });
});
