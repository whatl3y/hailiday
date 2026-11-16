import { beforeAll, describe, expect, it } from 'vitest';
import {
  DecorationPlanSchema,
  MAX_RESTORE_BOXES,
  SCENE_ANALYSIS_SCHEMA_VERSION,
  STYLES,
  type Anchor,
  type HolidayPack,
  type NormalizedBox,
  type SceneAnalysis,
  type SceneType,
} from '@hailiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { genericUploadGeometry } from '../../fixtures/layouts.js';
import { geometryToModelOutput } from '../../fixtures/scene.js';
import { buildPlan, withoutPlacements } from './builder.js';
import { shrinkToAllowed } from './geometry.js';
import { deriveRepair, findingsFrom, isRepairable } from './repair.js';
import type { BuildPlanInput, ValidatorEvent } from './types.js';
import {
  checkPlacement,
  existingDecorConflict,
  existingDecorationsConstrain,
  forbiddenViolations,
  TEXT_MARK_CLEARANCE,
  TEXT_MARK_MIN_KEEP,
  type CandidatePlacement,
} from './validator.js';

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

  it('flags a conflicting existing decoration and steps the style down at high density', () => {
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
    // Outside a house the new decoration may take the old one's place on the rail.
    expect(built.draft.placements.some((p) => p.anchorId === 'a2')).toBe(true);
  });

  describe('what a placement may cover', () => {
    const candidate = (region: NormalizedBox): CandidatePlacement => ({
      id: 'p1',
      key: 'k|a2',
      kitItemId: 'k',
      anchorId: 'a2',
      anchorCategory: 'porch_rail',
      region,
      placementRule: 'along',
      count: 1,
      specText: 'mixed evergreen garland',
      specAttributes: {},
      lit: false,
      priority: 1,
      attachment: 'draped',
      anchorConfidence: 0.9,
    });
    const check = (
      analysis: SceneAnalysis,
      sceneType: SceneType,
      region: NormalizedBox,
    ): { placement: CandidatePlacement | null; events: ValidatorEvent[] } => {
      const events: ValidatorEvent[] = [];
      const limits = pack('christmas').sceneSections.house_exterior?.limits;
      if (!limits) throw new Error('the Christmas pack has no exterior section');
      const placement = checkPlacement(
        candidate(region),
        {
          analysis,
          sceneType,
          holidayId: 'christmas',
          section: { limits },
          floors: { minConfidence: 0.5, maxOcclusion: 0.5 },
          lightsAllowed: true,
        },
        events,
      );
      return { placement, events };
    };
    const rail: NormalizedBox = [0.22, 0.64, 0.42, 0.72];
    const withDecor = (sceneType: SceneType) =>
      exterior({
        sceneType,
        preserveRegions: [],
        existingDecorations: {
          present: true,
          holidayGuess: 'halloween',
          density: 'low',
          boxes: [[0.22, 0.6, 0.42, 0.75]],
        },
      });

    it('lets a decoration take the place of an existing one outside a house', () => {
      expect(existingDecorationsConstrain('house_exterior')).toBe(false);
      const { placement, events } = check(withDecor('house_exterior'), 'house_exterior', rail);
      expect(placement?.region).toEqual(rail);
      expect(events).toEqual([]);
    });

    it('never covers an existing decoration anywhere else', () => {
      for (const sceneType of ['interior', 'apartment_entry', 'balcony'] as const) {
        expect(existingDecorationsConstrain(sceneType)).toBe(true);
        const { placement, events } = check(withDecor(sceneType), sceneType, rail);
        expect(placement, sceneType).toBeNull();
        expect(events.map((event) => event.rule)).toEqual(['existing_decorations']);
      }
    });

    it('keeps a placement clear of a house number, with its clearance', () => {
      // The number sits at the right end of the rail: the garland gives up that end.
      const analysis = exterior({
        preserveRegions: [{ kind: 'house_number', box: [0.39, 0.66, 0.41, 0.7] }],
      });
      const { placement, events } = check(analysis, 'house_exterior', rail);
      expect(placement).not.toBeNull();
      const region = placement?.region as NormalizedBox;
      expect(region[2]).toBeLessThanOrEqual(0.39 - TEXT_MARK_CLEARANCE + 1e-9);
      expect(region[0]).toBe(rail[0]);
      expect(events).toEqual([
        {
          rule: 'preserve_and_access',
          action: 'shrunk',
          placementKey: 'k|a2',
          detail: 'text_mark',
        },
      ]);
    });

    it('keeps the free middle of a garland with a text mark at each end', () => {
      const analysis = exterior({
        preserveRegions: [
          { kind: 'house_number', box: [0.225, 0.66, 0.235, 0.7] },
          { kind: 'sign', box: [0.405, 0.66, 0.415, 0.7] },
        ],
      });
      const { placement, events } = check(analysis, 'house_exterior', rail);
      expect(placement).not.toBeNull();
      const region = placement?.region as NormalizedBox;
      // Both ends are cut clear of the marks and their clearance; the middle keeps 75%.
      expect(region[0]).toBeCloseTo(0.235 + TEXT_MARK_CLEARANCE, 9);
      expect(region[2]).toBeCloseTo(0.405 - TEXT_MARK_CLEARANCE, 9);
      expect([region[1], region[3]]).toEqual([rail[1], rail[3]]);
      expect(events).toEqual([
        {
          rule: 'preserve_and_access',
          action: 'shrunk',
          placementKey: 'k|a2',
          detail: 'text_mark',
        },
      ]);
      // A middle under the minimum share is still removed.
      const narrow = exterior({
        preserveRegions: [
          { kind: 'house_number', box: [0.27, 0.66, 0.28, 0.7] },
          { kind: 'sign', box: [0.36, 0.66, 0.37, 0.7] },
        ],
      });
      expect(check(narrow, 'house_exterior', rail).placement).toBeNull();
      // Other blockers keep the one cut.
      const ends: NormalizedBox[] = [
        [0.2, 0.6, 0.25, 0.8],
        [0.39, 0.6, 0.44, 0.8],
      ];
      expect(shrinkToAllowed(rail, ends, 0, TEXT_MARK_MIN_KEEP)).toBeNull();
      expect(shrinkToAllowed(rail, ends, 0, TEXT_MARK_MIN_KEEP, 2)).toEqual([
        0.25, 0.64, 0.39, 0.72,
      ]);
    });

    it('removes a placement that would wrap what a house number, sign or logo is on', () => {
      for (const kind of ['house_number', 'sign', 'logo'] as const) {
        // The mark sits in the middle of the rail: either side keeps less than the minimum.
        const analysis = exterior({ preserveRegions: [{ kind, box: [0.31, 0.66, 0.33, 0.7] }] });
        const { placement, events } = check(analysis, 'house_exterior', rail);
        expect(placement, kind).toBeNull();
        expect(events).toEqual([
          {
            rule: 'preserve_and_access',
            action: 'removed',
            placementKey: 'k|a2',
            detail: 'text_mark',
          },
        ]);
      }
      expect(TEXT_MARK_MIN_KEEP).toBeGreaterThan(0.5);
    });

    it('still allows the tolerance over a vehicle or another preserve region', () => {
      // 8% of the rail overlaps a parked vehicle's box: within the 10% tolerance.
      const analysis = exterior({
        preserveRegions: [{ kind: 'vehicle', box: [0.404, 0.5, 0.6, 0.9] }],
      });
      const { placement, events } = check(analysis, 'house_exterior', rail);
      expect(placement?.region).toEqual(rail);
      expect(events).toEqual([]);
    });
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

  describe('restore boxes', () => {
    const repairOf = (findings: Parameters<typeof deriveRepair>[2]) => {
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
      return deriveRepair(plan, first.placementKeys, findings, null);
    };
    // The live hallway's door-number plaque: about 0.14% of the frame.
    const plaque: NormalizedBox = [0.322, 0.29, 0.342, 0.36];

    it('restores a small box of a restoring code', () => {
      for (const code of [
        'text_added',
        'people_altered',
        'privacy_regression',
        'unrequested_change',
        'structure_changed',
      ] as const) {
        expect(repairOf([{ code, box: plaque }]).adjustments.restoreBoxes, code).toEqual([plaque]);
      }
      // One box per distinct judge box.
      expect(
        repairOf([
          { code: 'text_added', box: plaque },
          { code: 'unrequested_change', box: plaque },
        ]).adjustments.restoreBoxes,
      ).toEqual([plaque]);
    });

    it('restores no large box, no boxless finding and no other code', () => {
      const tenPercent: NormalizedBox = [0.2, 0.2, 0.52, 0.5125];
      expect(repairOf([{ code: 'text_added', box: tenPercent }]).adjustments.restoreBoxes).toBe(
        undefined,
      );
      expect(repairOf([{ code: 'text_added' }]).adjustments.restoreBoxes).toBe(undefined);
      expect(repairOf([{ code: 'implausible_decor', box: plaque }]).adjustments.restoreBoxes).toBe(
        undefined,
      );
      // The constraint is still written for a finding that restores nothing.
      expect(repairOf([{ code: 'text_added' }]).constraints.map((c) => c.code)).toEqual([
        'text_added',
      ]);
    });

    it('keeps the first boxes up to the plan limit when the judge reports more', () => {
      const boxes = Array.from({ length: 40 }, (_, i): NormalizedBox => {
        const x = 0.1 + 0.05 * (i % 8);
        const y = 0.1 + 0.1 * Math.floor(i / 8);
        return [x, y, x + 0.02, y + 0.02];
      });
      const repair = repairOf(boxes.map((box) => ({ code: 'unrequested_change' as const, box })));
      expect(MAX_RESTORE_BOXES).toBe(32);
      expect(repair.adjustments.restoreBoxes).toEqual(boxes.slice(0, MAX_RESTORE_BOXES));
      // The repaired plan's composite mask accepts them.
      const first = buildPlan(input(pack('christmas'), exterior()));
      expect(() =>
        DecorationPlanSchema.shape.compositeMask.parse({
          dilationFraction: first.draft.compositeMask?.dilationFraction ?? 0.02,
          featherFraction: first.draft.compositeMask?.featherFraction ?? 0.01,
          restoreBoxes: repair.adjustments.restoreBoxes,
        }),
      ).not.toThrow();
    });

    it('asks the repair of added text to keep every house number and sign fully visible', () => {
      expect(repairOf([{ code: 'text_added', box: plaque }]).constraints).toEqual([
        {
          code: 'text_added',
          instruction:
            'Do not add any text, lettering, signage or numbers. Keep every house number and sign exactly as it is and fully visible, with no decoration over it.',
          placementIds: [],
        },
      ]);
    });

    it('carries the box of an uncertain critical finding when given the uncertainty floor', () => {
      const judge = {
        schemaVersion: '1',
        renderAttemptId: 'att',
        judgeModel: 'claude',
        judgePromptVersion: 'p',
        escalated: true,
        critical: [
          { code: 'text_added' as const, confidence: 0.55, evidence: 'plaque', box: plaque },
        ],
        major: [],
        placements: [],
        scores: { realism: 0.8, appeal: 0.8, planAdherence: 0.8 },
        overallConfidence: 0.6,
        elapsedMs: 1,
      };
      expect(findingsFrom(judge, [], { critical: 0.7, major: 0.7 })).toEqual([]);
      const findings = findingsFrom(judge, [], { critical: 0.7, uncertain: 0.4, major: 0.7 });
      expect(findings).toEqual([{ code: 'text_added', box: plaque }]);
      expect(repairOf(findings).adjustments.restoreBoxes).toEqual([plaque]);
      // Below the floor nothing is carried.
      expect(findingsFrom(judge, [], { critical: 0.7, uncertain: 0.6, major: 0.7 })).toEqual([]);
    });
  });
});
