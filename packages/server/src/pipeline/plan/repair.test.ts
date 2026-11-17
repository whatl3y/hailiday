import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  isCriticalFailureCode,
  isLavishPlan,
  type DecorationPlan,
  type FailureCode,
  type HolidayPack,
  type NormalizedBox,
  type SceneAnalysis,
  type Style,
} from '@hailiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { buildPlan } from './builder.js';
import { planAndCompile } from './index.js';
import { deriveRepair, type RepairFinding } from './repair.js';
import type { BuildPlanInput } from './types.js';

let content: Content;
beforeAll(async () => {
  content = await loadContent();
});

/** The real Claude analysis of the bungalow example photograph (recorded from a live run). */
function bungalow(): SceneAnalysis {
  const file = new URL(
    './testdata/live-analyses/christmas.house_exterior.classic.source.json',
    import.meta.url,
  );
  return (JSON.parse(readFileSync(file, 'utf8')) as { analysis: SceneAnalysis }).analysis;
}

/** The Christmas pack, or the same pack with no lavish description in any section. */
function christmas(plain = false): HolidayPack {
  const pack = content.packFor('christmas');
  if (!pack) throw new Error('christmas pack');
  if (!plain) return pack.pack;
  const copy = structuredClone(pack.pack);
  for (const section of Object.values(copy.sceneSections)) delete section?.promptFragments.lavish;
  return copy;
}

/** The input that plans the bungalow as a Christmas house exterior in `style`. */
function inputOf(style: Style, plain = false): BuildPlanInput {
  const analysis = bungalow();
  const pack = content.packFor('christmas');
  return {
    renderJobId: 'job',
    planVersion: 1,
    sourceAssetId: 'sa',
    sceneAnalysisId: 'an',
    analysis,
    sourceKind: 'upload',
    pack: christmas(plain),
    holidayPackVersion: pack?.version ?? '0',
    styleKitVersionId: 'kit',
    sceneType: analysis.sceneType,
    buildingForm: analysis.buildingForm ?? null,
    roomType: analysis.roomType ?? null,
    style,
    lightingMode: 'source',
    compilerVersion: 'test-1',
    permissionEvaluationId: 'pe',
  };
}

/** A Christmas house exterior planned in `style`, as the failed attempt's plan. */
function planned(style: Style, plain = false) {
  const built = buildPlan(inputOf(style, plain));
  const plan = {
    ...built.draft,
    compiled: {
      provider: 'fixture',
      modelSnapshot: 'f',
      instructionText: 'x',
      parameters: {},
      hash: 'h',
    },
  } as DecorationPlan;
  return { plan, placementKeys: built.placementKeys };
}

const CODES = [
  'plan_not_followed',
  'unrequested_change',
  'lighting_implausible',
  'structure_changed',
  'text_added',
  'camera_changed',
  'implausible_decor',
  'access_blocked',
  'neighbor_decorated',
  'privacy_regression',
  'people_altered',
] as const;

const MAJORS = CODES.filter((code) => !isCriticalFailureCode(code));
const CRITICALS = CODES.filter((code) => isCriticalFailureCode(code));

const instructions = (repair: ReturnType<typeof deriveRepair>) =>
  Object.fromEntries(repair.constraints.map((c) => [c.code, c.instruction]));

/** The repair of a planned attempt; `plain` drops the plan's lavish mark first. */
const repairOf = (
  { plan, placementKeys }: ReturnType<typeof planned>,
  findings: readonly RepairFinding[],
  plain = false,
) =>
  deriveRepair(
    plain ? (({ lavish: _lavish, ...rest }) => rest)(plan) : plan,
    placementKeys,
    findings,
    null,
  );

const ORDINARY_SENTENCES = {
  plan_not_followed: 'Add every listed decoration, each at the stated position and count.',
  unrequested_change:
    'Change nothing except adding the listed decorations: no repainting, no landscaping changes, no added snow, no removed objects.',
  lighting_implausible:
    'Only the listed lit decorations may glow; add no other light sources and do not light neighboring buildings.',
};

describe('repair instructions of a lavish attempt', () => {
  it('speak of the whole description for three codes after majors only; every other instruction and adjustment is the same', () => {
    expect(MAJORS).toEqual([
      'plan_not_followed',
      'unrequested_change',
      'lighting_implausible',
      'implausible_decor',
    ]);
    const lavish = planned('abundant');
    const classic = planned('classic');
    expect(isLavishPlan(lavish.plan)).toBe(true);
    expect(isLavishPlan(classic.plan)).toBe(false);
    const findings = MAJORS.map((code) => ({ code }));
    const rich = repairOf(lavish, findings);
    const plain = repairOf(lavish, findings, true);
    expect(instructions(rich)).toEqual({
      ...instructions(plain),
      plan_not_followed: 'Decorate far more richly: follow the whole description.',
      unrequested_change:
        'Change nothing except adding decorations: no repainting, no landscaping changes, no added snow, no removed objects.',
      lighting_implausible:
        'Only the lights on the decorations may glow; add no other light sources and do not light neighboring buildings.',
    });
    // The same plan without the mark keeps today's sentences.
    expect(instructions(plain)).toMatchObject(ORDINARY_SENTENCES);
    expect(rich.adjustments).toEqual(plain.adjustments);
    expect(rich.adjustments).not.toHaveProperty('ordinary');
    expect(rich.constraints.map((c) => [c.code, c.placementIds])).toEqual(
      plain.constraints.map((c) => [c.code, c.placementIds]),
    );
    // A classic plan keeps today's sentences.
    expect(instructions(repairOf(classic, findings))).toMatchObject({
      plan_not_followed: ORDINARY_SENTENCES.plan_not_followed,
    });
  });

  it('are the ordinary repair, worded as for a plan without the mark, after a critical finding', () => {
    const lavish = planned('abundant');
    const box: NormalizedBox = [0.1, 0.1, 0.14, 0.14];
    const cases: { label: string; findings: RepairFinding[] }[] = [
      ...CRITICALS.map((code) => ({ label: code, findings: [{ code, box }] })),
      { label: 'boxless critical', findings: [{ code: 'access_blocked' }] },
      { label: 'every code', findings: CODES.map((code) => ({ code })) },
      {
        label: 'a critical among majors',
        findings: [...MAJORS.map((code) => ({ code })), { code: 'structure_changed' }],
      },
    ];
    expect(CRITICALS.length).toBe(7);
    for (const { label, findings } of cases) {
      const repair = repairOf(lavish, findings);
      const plain = repairOf(lavish, findings, true);
      expect(repair.adjustments.ordinary, label).toBe(true);
      expect(repair.adjustments, label).toEqual({ ...plain.adjustments, ordinary: true });
      expect(repair.constraints, label).toEqual(plain.constraints);
    }
    const everything = repairOf(
      lavish,
      CODES.map((code) => ({ code })),
    );
    expect(instructions(everything)).toMatchObject(ORDINARY_SENTENCES);
  });

  it('never set the ordinary repair for a plan without the mark', () => {
    const all = CODES.map((code) => ({ code }) as RepairFinding);
    for (const attempt of [planned('classic'), planned('subtle'), planned('abundant', true)]) {
      expect(isLavishPlan(attempt.plan)).toBe(false);
      for (const findings of [all, [{ code: 'access_blocked' as FailureCode }]]) {
        expect(repairOf(attempt, findings).adjustments).not.toHaveProperty('ordinary');
      }
    }
    // The lavish plan stripped of its mark, too.
    expect(repairOf(planned('abundant'), all, true).adjustments).not.toHaveProperty('ordinary');
  });
});

describe('the plan of an ordinary repair', () => {
  const COMPILE_OPTIONS = () => ({
    provider: 'openai' as const,
    modelSnapshot: 'm',
    working: { width: 1024, height: 1024, checksum: 'c' },
    supportsMask: true,
  });

  it('carries no mark: its placements and constraints are the ordinary repair of the same findings', () => {
    const first = planned('abundant');
    const plainFirst = planned('abundant', true);
    expect(isLavishPlan(first.plan)).toBe(true);
    expect(first.plan.placements).toEqual(plainFirst.plan.placements);
    const findings: RepairFinding[] = [
      { code: 'access_blocked' },
      { code: 'unrequested_change' },
      { code: 'plan_not_followed' },
    ];
    const repair = repairOf(first, findings);
    expect(repair.adjustments.ordinary).toBe(true);
    const plainRepair = repairOf(plainFirst, findings);
    const second = buildPlan({ ...inputOf('abundant'), planVersion: 2, repair });
    const ordinary = buildPlan({
      ...inputOf('abundant', true),
      planVersion: 2,
      repair: plainRepair,
    });
    expect(second.draft.lavish).toBeUndefined();
    expect(second.draft.placements.length).toBeGreaterThan(0);
    expect(second.draft).toEqual(ordinary.draft);
    expect(second.validator).toEqual(ordinary.validator);
    expect(second.placementKeys).toEqual(ordinary.placementKeys);
    expect(second.draft.repairConstraints?.map((c) => c.instruction)).toEqual(
      ordinary.draft.repairConstraints?.map((c) => c.instruction),
    );
    // Compiled with placement sentences, as the ordinary repair is.
    const compiled = planAndCompile(
      { ...inputOf('abundant'), planVersion: 2, repair },
      COMPILE_OPTIONS,
    );
    const compiledPlain = planAndCompile(
      { ...inputOf('abundant', true), planVersion: 2, repair: plainRepair },
      COMPILE_OPTIONS,
    );
    expect(compiled.compile?.request.instructionText).toContain(', at the ');
    expect(compiled.compile?.request).toEqual(compiledPlain.compile?.request);
  });

  it('keeps the mark of a repair after majors only', () => {
    const first = planned('abundant');
    const repair = repairOf(first, [{ code: 'unrequested_change' }, { code: 'plan_not_followed' }]);
    expect(repair.adjustments).not.toHaveProperty('ordinary');
    const second = buildPlan({ ...inputOf('abundant'), planVersion: 2, repair });
    expect(second.draft.lavish).toEqual(first.plan.lavish);
  });
});
