import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SCENE_ANALYSIS_SCHEMA_VERSION,
  STYLES,
  isCriticalFailureCode,
  isRelightLightingMode,
  type FailureCode,
  type HolidayPack,
  type LightingMode,
  type NormalizedBox,
  type RelightLightingMode,
  type SceneAnalysis,
  type SceneType,
} from '@hailiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { genericUploadGeometry } from '../../fixtures/layouts.js';
import { geometryToModelOutput } from '../../fixtures/scene.js';
import {
  buildPlan,
  compileContentFor,
  deriveRepair,
  planAndCompile,
  positionWords,
} from '../plan/index.js';
import { COMPILER_RELEASE, PIPELINE_DEFAULTS } from '../versions.js';
import {
  BRIGHT_RELIGHT_EXPOSURE,
  BRIGHT_RELIGHT_KEEP,
  BRIGHT_RELIGHT_LIGHT,
  BRIGHT_RELIGHT_SCOPE,
  COMPILER_PROVIDERS,
  ENHANCE_KEEP,
  ENHANCE_PROTECT,
  ENHANCE_QUALITY,
  ENHANCE_SCOPE,
  ENHANCE_STYLE,
  EVENING_KEEP,
  KEEP_MARKS,
  KEEP_MARKS_EXTERIOR,
  LAVISH_ACCESS_EXTERIOR,
  LAVISH_ACCESS_INTERIOR,
  LAVISH_ADDED,
  LAVISH_BRIGHT_RELIGHT_DECORATIONS,
  LAVISH_LIGHTS_ON,
  LAVISH_OUTPUT,
  LAVISH_REALISM,
  LAVISH_RELIGHT_AMBIENT,
  LAVISH_RELIGHT_DECORATIONS,
  LAVISH_RELIGHT_EXPOSURE,
  houseNumberSentences,
  RELIGHT_KEEP,
  RELIGHT_REPAIR_BRIGHT_LIGHT,
  RELIGHT_REPAIR_KEEP,
  RELIGHT_REPAIR_LIGHT,
  compilePlan,
  compileEnhanceRequest,
  compileRelightRequest,
  isEnhanceRequest,
  isRelightRequest,
  providerParameters,
  relightTargetOf,
  type CompilerProvider,
} from './compiler.js';

/**
 * Golden files: every example pack scene section × style × offered lighting mode (a `bright` cell
 * decorates as photographed, so it compiles as the `source` request), the relight of every cell
 * that offers a relit mode, every repair constraint type and the Street View enhancement, compiled
 * per provider. Regenerate
 * with `UPDATE_GOLDEN=1` only together with a `COMPILER_RELEASE` bump.
 */

/** The lighting a cell's decorate request is compiled in: as photographed, or legacy evening. */
function decorateLightingOf(mode: LightingMode): 'source' | 'evening' {
  return mode === 'evening' ? 'evening' : 'source';
}
/** A copy of a pack whose sections carry no lavish description. */
function withoutLavish(pack: HolidayPack): HolidayPack {
  const copy = structuredClone(pack);
  for (const section of Object.values(copy.sceneSections)) delete section?.promptFragments.lavish;
  return copy;
}

const GOLDEN = fileURLToPath(new URL('./compiler.golden.json', import.meta.url));
const SNAPSHOTS: Record<CompilerProvider, string> = {
  openai: 'gpt-image-golden',
  gemini: 'gemini-image-golden',
  fixture: 'fixture-compositor-golden',
};
const WORKING = { width: 1024, height: 1024, checksum: 'golden-working' };
const MASK = { width: 1024, height: 1024, checksum: 'golden-mask' };

let content: Content;
beforeAll(async () => {
  content = await loadContent();
});

function analysisFor(sceneType: SceneType, roomType: string | null): SceneAnalysis {
  const geometry = genericUploadGeometry({
    sceneType,
    roomType: roomType as Parameters<typeof genericUploadGeometry>[0]['roomType'],
    width: 1024,
    height: 1024,
  });
  return {
    schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION,
    sourceAssetId: 'sa_golden',
    workingImage: { width: 1024, height: 1024, checksum: 'golden-working' },
    ...geometryToModelOutput(geometry),
    sceneTypeMismatch: false,
    model: { analysisModel: 'golden', analysisPromptVersion: 'golden' },
    elapsedMs: 0,
  };
}

function compileCase(
  pack: HolidayPack,
  sceneType: SceneType,
  roomType: string | null,
  style: (typeof STYLES)[number],
  lightingMode: 'source' | 'evening',
  provider: CompilerProvider,
  repairCode?: FailureCode,
) {
  const analysis = analysisFor(sceneType, roomType);
  const baseInput = {
    renderJobId: 'job_golden',
    planVersion: 1 as const,
    sourceAssetId: 'sa_golden',
    sceneAnalysisId: 'an_golden',
    analysis,
    sourceKind: 'upload' as const,
    pack,
    holidayPackVersion: pack.version,
    styleKitVersionId: 'kit_golden',
    sceneType,
    roomType: roomType as never,
    style,
    lightingMode,
    compilerVersion: `${COMPILER_RELEASE}-${provider}`,
    permissionEvaluationId: 'pe_golden',
  };
  const options = () => ({
    provider,
    modelSnapshot: SNAPSHOTS[provider],
    working: WORKING,
    mask: MASK,
    supportsMask: provider !== 'gemini',
  });
  let repair = null;
  if (repairCode) {
    const first = buildPlan(baseInput);
    const plan = {
      ...first.draft,
      compiled: { provider, modelSnapshot: 'x', instructionText: 'x', parameters: {}, hash: 'x' },
    };
    repair = deriveRepair(plan, first.placementKeys, [{ code: repairCode }], null);
  }
  const result = planAndCompile(
    { ...baseInput, ...(repair ? { planVersion: 2 as const, repair } : {}) },
    () => ({ ...options(), lowerQuality: repair?.adjustments.lowerQuality ?? false }),
  );
  if (!result.compile) return { failure: result.built.validator.failure };
  return {
    instructionText: result.compile.request.instructionText,
    parameters: result.compile.request.parameters,
    settingsHash: result.compile.request.settingsHash,
    mask: result.compile.request.mask !== undefined,
    placements: result.built.draft.placements.map((p) => `${p.kitItemId}@${p.anchorId}x${p.count}`),
    ...(result.built.draft.lavish ? { lavish: result.built.draft.lavish } : {}),
  };
}

/** The enhance request of a Street View frame on the working grid. */
function enhanceCase(provider: CompilerProvider) {
  const request = compileEnhanceRequest({
    provider,
    modelSnapshot: SNAPSHOTS[provider],
    image: { width: 1024, height: 1024, checksum: 'golden-frame' },
    compilerVersion: `${COMPILER_RELEASE}-${provider}`,
  });
  return {
    instructionText: request.instructionText,
    parameters: request.parameters,
    settingsHash: request.settingsHash,
    mask: request.mask !== undefined,
    kind: request.kind,
  };
}

/** The relight of a `source` plan of one pack cell (the relit variant's request). */
function relightCase(
  pack: HolidayPack,
  sceneType: SceneType,
  roomType: string | null,
  style: (typeof STYLES)[number],
  provider: CompilerProvider,
  repairCodes: FailureCode[] = [],
  target: RelightLightingMode = 'evening',
) {
  const built = buildPlan({
    renderJobId: 'job_golden',
    planVersion: 1,
    sourceAssetId: 'sa_golden',
    sceneAnalysisId: 'an_golden',
    analysis: analysisFor(sceneType, roomType),
    sourceKind: 'upload',
    pack,
    holidayPackVersion: pack.version,
    styleKitVersionId: 'kit_golden',
    sceneType,
    roomType: roomType as never,
    style,
    lightingMode: 'source',
    compilerVersion: `${COMPILER_RELEASE}-${provider}`,
    permissionEvaluationId: 'pe_golden',
  });
  if (!built.validator.passed) return { failure: built.validator.failure };
  const request = compileRelightRequest({
    target,
    basePlan: built.draft,
    provider,
    modelSnapshot: SNAPSHOTS[provider],
    image: { width: 1024, height: 1024, checksum: 'golden-base' },
    repair: repairCodes.length > 0 ? { codes: repairCodes } : null,
    lowerQuality: repairCodes.includes('camera_changed'),
  });
  return {
    instructionText: request.instructionText,
    parameters: request.parameters,
    settingsHash: request.settingsHash,
    mask: request.mask !== undefined,
    kind: request.kind,
  };
}

function allCases(): Record<string, unknown> {
  const cases: Record<string, unknown> = {};
  for (const { pack } of content.packs) {
    for (const sceneType of Object.keys(pack.sceneSections) as SceneType[]) {
      const section = pack.sceneSections[sceneType];
      const roomType = sceneType === 'interior' ? (section?.roomTypes?.[0] ?? 'living_room') : null;
      const offered = pack.lightingPolicy.bySceneType[sceneType]?.offered ?? [];
      const decorateModes = [...new Set(offered.map(decorateLightingOf))];
      for (const style of STYLES) {
        for (const lightingMode of decorateModes) {
          for (const provider of COMPILER_PROVIDERS) {
            cases[`${pack.holidayId}.${sceneType}.${style}.${lightingMode}.${provider}`] =
              compileCase(pack, sceneType, roomType, style, lightingMode, provider);
          }
        }
      }
    }
  }
  const christmas = content.packFor('christmas')?.pack as HolidayPack;
  const repairCodes: FailureCode[] = [
    'structure_changed',
    'neighbor_decorated',
    'access_blocked',
    'privacy_regression',
    'people_altered',
    'text_added',
    'camera_changed',
    'unrequested_change',
    'plan_not_followed',
    'implausible_decor',
    'lighting_implausible',
  ];
  for (const code of repairCodes) {
    for (const provider of COMPILER_PROVIDERS) {
      cases[`repair.${code}.${provider}`] = compileCase(
        christmas,
        'house_exterior',
        null,
        'classic',
        'source',
        provider,
        code,
      );
    }
  }
  // Repairs of a lavish attempt: after a major code alone, the same description with the
  // constraint sentences appended; after a critical code, the ordinary look of the same style
  // (no mark, placement sentences, the constraints worded as for a plan without the mark).
  for (const code of repairCodes) {
    for (const provider of COMPILER_PROVIDERS) {
      cases[`repair.abundant.${code}.${provider}`] = compileCase(
        christmas,
        'house_exterior',
        null,
        'abundant',
        'source',
        provider,
        code,
      );
    }
  }
  // Relights of the daylight plan of every cell that offers a relit mode, and relight repairs.
  for (const { pack } of content.packs) {
    for (const sceneType of Object.keys(pack.sceneSections) as SceneType[]) {
      const section = pack.sceneSections[sceneType];
      const roomType = sceneType === 'interior' ? (section?.roomTypes?.[0] ?? 'living_room') : null;
      for (const target of pack.lightingPolicy.bySceneType[sceneType]?.offered ?? []) {
        if (!isRelightLightingMode(target)) continue;
        for (const provider of COMPILER_PROVIDERS) {
          cases[`relight.${target}.${pack.holidayId}.${sceneType}.classic.${provider}`] =
            relightCase(pack, sceneType, roomType, 'classic', provider, [], target);
        }
      }
    }
  }
  // Relights of the lavish daylight plan of every cell that offers the evening look.
  for (const { pack } of content.packs) {
    for (const sceneType of Object.keys(pack.sceneSections) as SceneType[]) {
      if (!pack.lightingPolicy.bySceneType[sceneType]?.offered.includes('evening')) continue;
      for (const provider of COMPILER_PROVIDERS) {
        cases[`relight.evening.${pack.holidayId}.${sceneType}.abundant.${provider}`] = relightCase(
          pack,
          sceneType,
          null,
          'abundant',
          provider,
        );
      }
    }
  }
  // Relights of the lavish daylight plan of every cell that offers the bright look.
  for (const { pack } of content.packs) {
    for (const sceneType of Object.keys(pack.sceneSections) as SceneType[]) {
      if (!pack.lightingPolicy.bySceneType[sceneType]?.offered.includes('bright')) continue;
      const section = pack.sceneSections[sceneType];
      const roomType = sceneType === 'interior' ? (section?.roomTypes?.[0] ?? 'living_room') : null;
      for (const provider of COMPILER_PROVIDERS) {
        cases[`relight.bright.${pack.holidayId}.${sceneType}.abundant.${provider}`] = relightCase(
          pack,
          sceneType,
          roomType,
          'abundant',
          provider,
          [],
          'bright',
        );
      }
    }
  }
  const relightRepairs: FailureCode[][] = [
    ['structure_changed'],
    ['camera_changed'],
    ['lighting_implausible'],
    ['structure_changed', 'lighting_implausible'],
  ];
  for (const codes of relightRepairs) {
    for (const provider of COMPILER_PROVIDERS) {
      cases[`relight.repair.${codes.join('+')}.${provider}`] = relightCase(
        christmas,
        'house_exterior',
        null,
        'classic',
        provider,
        codes,
      );
      cases[`relight.repair.bright.${codes.join('+')}.${provider}`] = relightCase(
        christmas,
        'interior',
        'living_room',
        'classic',
        provider,
        codes,
        'bright',
      );
    }
  }
  for (const provider of COMPILER_PROVIDERS) cases[`enhance.${provider}`] = enhanceCase(provider);
  return cases;
}

describe('prompt compiler', () => {
  it('matches the golden files for every pack cell, provider and repair constraint', () => {
    const cases = allCases();
    const golden = { compilerRelease: COMPILER_RELEASE, cases };
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
    }
    const stored = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof golden;
    expect(stored.compilerRelease).toBe(COMPILER_RELEASE);
    expect(cases).toEqual(stored.cases);
  });

  it('compiles the repair of a lavish attempt as the ordinary look after a critical code, with the mark after a major one', () => {
    const cases = allCases();
    const christmas = content.packFor('christmas')?.pack as HolidayPack;
    const repairCases = Object.keys(cases).filter((key) => key.startsWith('repair.abundant.'));
    expect(repairCases).toHaveLength(33);
    const critical: string[] = [];
    for (const key of repairCases) {
      const [, , code, provider] = key.split('.') as [
        string,
        string,
        FailureCode,
        CompilerProvider,
      ];
      if (isCriticalFailureCode(code)) {
        if (!critical.includes(code)) critical.push(code);
        expect(cases[key], key).not.toHaveProperty('lavish');
        expect(cases[key], key).toEqual(
          compileCase(
            withoutLavish(christmas),
            'house_exterior',
            null,
            'abundant',
            'source',
            provider,
            code,
          ),
        );
      } else {
        expect(cases[key], key).toMatchObject({ lavish: { lit: true } });
      }
    }
    expect(critical).toEqual([
      'structure_changed',
      'neighbor_decorated',
      'access_blocked',
      'privacy_regression',
      'people_altered',
      'text_added',
      'camera_changed',
    ]);
  });

  it('is deterministic', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const first = compileCase(pack, 'house_exterior', null, 'abundant', 'evening', 'openai');
    const second = compileCase(pack, 'house_exterior', null, 'abundant', 'evening', 'openai');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('never carries an address, unit, resident, user text or merchant title', () => {
    const denylist = [
      '1427 Lantern Hill Rd',
      'Apt 4B',
      'Margaret Ellison',
      "my mom's house",
      'MegaMart Deluxe Wreath',
      '02134',
    ];
    // Surrounding records hold the tokens; only the plan and reviewed pack content reach the compiler.
    const surrounding = {
      property: { formattedAddress: `${denylist[0]}, ${denylist[1]}, Springfield ${denylist[5]}` },
      user: { name: denylist[2], note: denylist[3] },
      offer: { merchantTitle: denylist[4] },
    };
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    for (const provider of COMPILER_PROVIDERS) {
      const compiled = compileCase(pack, 'house_exterior', null, 'abundant', 'source', provider);
      const text = JSON.stringify(compiled);
      for (const token of denylist) expect(text).not.toContain(token);
    }
    expect(surrounding.property.formattedAddress).toContain(denylist[0]);
  });

  it('caps the length by dropping the lowest-priority placements first', () => {
    // The cap acts on placement sentences, which a lavish request does not have.
    const pack = withoutLavish(content.packFor('christmas')?.pack as HolidayPack);
    const built = buildPlan({
      renderJobId: 'job',
      planVersion: 1,
      sourceAssetId: 'sa',
      sceneAnalysisId: 'an',
      analysis: analysisFor('house_exterior', null),
      sourceKind: 'upload',
      pack,
      holidayPackVersion: pack.version,
      styleKitVersionId: 'kit',
      sceneType: 'house_exterior',
      style: 'abundant',
      lightingMode: 'source',
      compilerVersion: 'test',
      permissionEvaluationId: 'pe',
    });
    const contentFor = compileContentFor(pack, 'house_exterior', 'abundant');
    const caps = { source: 1600, evening: 2000 };
    const result = compilePlan(built.draft, contentFor, {
      provider: 'openai',
      modelSnapshot: 'm',
      working: WORKING,
      supportsMask: true,
      caps,
    });
    expect(result.request.instructionText.length).toBeLessThanOrEqual(caps.source);
    expect(result.droppedPlacementIds.length).toBeGreaterThan(0);
    // Extra placements of an archetype and non-required archetypes go first; the first
    // placement of each required archetype is kept while anything else can be dropped.
    const kept = built.draft.placements.filter((p) => !result.droppedPlacementIds.includes(p.id));
    const keptItems = new Set(kept.map((p) => p.kitItemId));
    for (const required of contentFor.requiredKitItems ?? []) {
      if (built.draft.placements.some((p) => p.kitItemId === required)) {
        expect(keptItems.has(required)).toBe(true);
      }
    }
    expect(new Set(kept.map((p) => p.kitItemId)).size).toBe(kept.length);
    // Preserve and protect text is never shortened.
    expect(result.request.instructionText).toContain('do not sharpen, reconstruct or replace them');
    expect(result.request.instructionText.startsWith('Edit only the target house')).toBe(true);
  });

  it('fits every planned placement of classic, and of abundant on packs without the lavish description, within the default caps', () => {
    expect(PIPELINE_DEFAULTS.instructionCaps).toEqual({ source: 6000, evening: 5000 });
    // The cap acts on placement sentences: the abundant half runs on the placement path, which a
    // section without a lavish description takes.
    let checked = 0;
    for (const { pack: shipped } of content.packs) {
      const placementPack = withoutLavish(shipped);
      for (const sceneType of Object.keys(shipped.sceneSections) as SceneType[]) {
        const section = shipped.sceneSections[sceneType];
        const roomType =
          sceneType === 'interior' ? (section?.roomTypes?.[0] ?? 'living_room') : null;
        const offered = shipped.lightingPolicy.bySceneType[sceneType]?.offered ?? [];
        for (const style of ['classic', 'abundant'] as const) {
          const pack = style === 'abundant' ? placementPack : shipped;
          for (const lightingMode of [...new Set(offered.map(decorateLightingOf))]) {
            for (const provider of COMPILER_PROVIDERS) {
              const built = buildPlan({
                renderJobId: 'job',
                planVersion: 1,
                sourceAssetId: 'sa',
                sceneAnalysisId: 'an',
                analysis: analysisFor(sceneType, roomType),
                sourceKind: 'upload',
                pack,
                holidayPackVersion: pack.version,
                styleKitVersionId: 'kit',
                sceneType,
                roomType: roomType as never,
                style,
                lightingMode,
                compilerVersion: 'test',
                permissionEvaluationId: 'pe',
              });
              if (!built.validator.passed) continue;
              const result = compilePlan(built.draft, compileContentFor(pack, sceneType, style), {
                provider,
                modelSnapshot: 'm',
                working: WORKING,
                supportsMask: true,
              });
              const label = `${pack.holidayId}.${sceneType}.${style}.${lightingMode}.${provider}`;
              expect(built.draft.lavish, label).toBeUndefined();
              expect(result.request.instructionText, label).toContain(', at the ');
              expect(result.droppedPlacementIds, label).toEqual([]);
              expect(result.request.instructionText.length, label).toBeLessThanOrEqual(
                PIPELINE_DEFAULTS.instructionCaps[lightingMode],
              );
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('tells evening edits that every existing object stays and only the light changes', () => {
    const cases = allCases();
    let evening = 0;
    for (const [label, value] of Object.entries(cases)) {
      const text = (value as { instructionText?: string }).instructionText;
      if (!text || label.startsWith('relight.') || label.startsWith('enhance.')) continue;
      if (label.includes('.evening.')) {
        evening += 1;
        expect(text, label).toContain(EVENING_KEEP);
        expect(text, label).toContain('nothing is removed, replaced, moved or restyled');
        expect(text, label).toMatch(/everything else in the photograph stays as it is\.$/);
        // The keep clause sits in the preserve block, ahead of every placement.
        expect(text.indexOf(EVENING_KEEP), label).toBeLessThan(text.indexOf(' at the '));
      } else {
        expect(text, label).not.toContain(EVENING_KEEP);
      }
    }
    expect(evening).toBeGreaterThan(10);
  });

  it('asks every decorate edit to neither alter nor cover house numbers, signs and logos', () => {
    const cases = allCases();
    let decorate = 0;
    for (const [label, value] of Object.entries(cases)) {
      const text = (value as { instructionText?: string }).instructionText;
      if (!text || label.startsWith('relight.') || label.startsWith('enhance.')) continue;
      decorate += 1;
      // Outside a house a listed decoration may take the place of a removable one.
      const exterior = /^Edit only the target house\b/.test(text);
      expect(text, label).toContain(exterior ? KEEP_MARKS_EXTERIOR : KEEP_MARKS);
      expect(text, label).not.toContain(exterior ? KEEP_MARKS : KEEP_MARKS_EXTERIOR);
    }
    expect(decorate).toBeGreaterThan(50);
    const textRepair = (cases['repair.text_added.openai'] as { instructionText: string })
      .instructionText;
    expect(textRepair).toContain(
      'Do not add any text, lettering, signage or numbers. Keep every house number and sign exactly as it is and fully visible, with no decoration over it.',
    );
  });

  it('tells the editor where each recorded house number is, for at most two of them', () => {
    const preserve = (boxes: NormalizedBox[]) =>
      ({
        preserve: {
          regions: [
            { kind: 'sign', box: [0.1, 0.1, 0.2, 0.2] },
            ...boxes.map((box) => ({ kind: 'house_number', box })),
          ],
        },
      }) as unknown as Parameters<typeof houseNumberSentences>[0];
    expect(houseNumberSentences(preserve([]))).toEqual([]);
    expect(houseNumberSentences(preserve([[0.44, 0.45, 0.47, 0.55]]))).toEqual([
      'The house number in the center of the image stays fully visible: put no decoration on or in front of it.',
    ]);
    expect(houseNumberSentences(preserve([[0.44, 0.62, 0.47, 0.72]]))).toEqual([
      'The house number in the lower middle of the image stays fully visible: put no decoration on or in front of it.',
    ]);
    expect(
      houseNumberSentences(
        preserve([
          [0.05, 0.8, 0.1, 0.9],
          [0.9, 0.1, 0.95, 0.2],
          [0.44, 0.62, 0.47, 0.72],
        ]),
      ),
    ).toHaveLength(2);
    // A compiled decorate request of a plan with a house number carries the sentence.
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const built = buildPlan({
      renderJobId: 'job',
      planVersion: 1,
      sourceAssetId: 'sa',
      sceneAnalysisId: 'an',
      analysis: {
        ...analysisFor('house_exterior', null),
        preserveRegions: [{ kind: 'house_number', box: [0.9, 0.45, 0.93, 0.55] }],
      },
      sourceKind: 'upload',
      pack,
      holidayPackVersion: pack.version,
      styleKitVersionId: 'kit',
      sceneType: 'house_exterior',
      style: 'classic',
      lightingMode: 'source',
      compilerVersion: 'test',
      permissionEvaluationId: 'pe',
    });
    const result = compilePlan(built.draft, compileContentFor(pack, 'house_exterior', 'classic'), {
      provider: 'openai',
      modelSnapshot: 'm',
      working: WORKING,
      supportsMask: true,
    });
    expect(result.request.instructionText).toContain(
      `${KEEP_MARKS_EXTERIOR} The house number on the right side of the image stays fully visible: put no decoration on or in front of it.`,
    );
  });

  it('never compiles input_fidelity for OpenAI or the low thinking level for Gemini', () => {
    const cases = allCases();
    let openai = 0;
    let gemini = 0;
    for (const [label, value] of Object.entries(cases)) {
      const parameters = (value as { parameters?: Record<string, unknown> }).parameters;
      if (!parameters) continue;
      expect(parameters, label).not.toHaveProperty('input_fidelity');
      if (label.endsWith('.openai')) {
        openai += 1;
        expect(parameters.quality, label).toBe('medium');
      }
      if (label.endsWith('.gemini')) {
        gemini += 1;
        expect(parameters.thinking_level, label).toBe('minimal');
        expect(parameters.image_size, label).toBe('1K');
      }
    }
    expect(openai).toBeGreaterThan(10);
    expect(gemini).toBeGreaterThan(10);
  });

  it('takes quality, size and thinking level from the configured settings', () => {
    const working = { width: 1536, height: 1024 };
    expect(providerParameters('openai', working)).toEqual({
      size: '1536x1024',
      quality: 'medium',
      output_format: 'jpeg',
    });
    expect(providerParameters('openai', working, false, { openaiQuality: 'high' }).quality).toBe(
      'high',
    );
    expect(providerParameters('gemini', working)).toEqual({
      image_size: '1K',
      aspect_ratio: '3:2',
      thinking_level: 'minimal',
    });
    expect(
      providerParameters('gemini', working, false, {
        geminiImageSize: '2K',
        geminiThinkingLevel: 'high',
      }),
    ).toMatchObject({ image_size: '2K', thinking_level: 'high' });
  });

  it('lowers quality and thinking one step on repair, never below the budget floor', () => {
    const working = { width: 1024, height: 1024 };
    const openai = (openaiQuality: 'low' | 'medium' | 'high' | 'auto') =>
      providerParameters('openai', working, true, { openaiQuality }).quality;
    expect(openai('high')).toBe('medium');
    expect(openai('auto')).toBe('medium');
    expect(openai('medium')).toBe('medium');
    expect(openai('low')).toBe('low');
    const gemini = (geminiThinkingLevel: 'minimal' | 'medium' | 'high') =>
      providerParameters('gemini', working, true, { geminiThinkingLevel }).thinking_level;
    expect(gemini('high')).toBe('medium');
    expect(gemini('medium')).toBe('minimal');
    expect(gemini('minimal')).toBe('minimal');
  });

  it('sends the composite mask only under the tight mask policy', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const built = buildPlan({
      renderJobId: 'job',
      planVersion: 1,
      sourceAssetId: 'sa',
      sceneAnalysisId: 'an',
      analysis: analysisFor('house_exterior', null),
      sourceKind: 'upload',
      pack,
      holidayPackVersion: pack.version,
      styleKitVersionId: 'kit',
      sceneType: 'house_exterior',
      style: 'classic',
      lightingMode: 'source',
      compilerVersion: 'test',
      permissionEvaluationId: 'pe',
    });
    expect(built.draft.fidelityMode).toBe('composite_additive');
    const contentFor = compileContentFor(pack, 'house_exterior', 'classic');
    const compile = (options: { providerMask?: 'none' | 'tight'; supportsMask?: boolean }) =>
      compilePlan(built.draft, contentFor, {
        provider: 'openai',
        modelSnapshot: 'm',
        working: WORKING,
        mask: MASK,
        supportsMask: options.supportsMask ?? true,
        ...(options.providerMask ? { settings: { providerMask: options.providerMask } } : {}),
      }).request;
    const byDefault = compile({});
    const none = compile({ providerMask: 'none' });
    const tight = compile({ providerMask: 'tight' });
    expect(byDefault.mask).toBeUndefined();
    expect(none.mask).toBeUndefined();
    expect(tight.mask).toEqual(MASK);
    expect(compile({ providerMask: 'tight', supportsMask: false }).mask).toBeUndefined();
    // Mask use is part of the frozen settings.
    expect(byDefault.settingsHash).toBe(none.settingsHash);
    expect(tight.settingsHash).not.toBe(none.settingsHash);
  });

  it('compiles the enhancement of a Street View frame: five sentences, no mask, the marker', () => {
    const input = {
      provider: 'openai' as const,
      modelSnapshot: 'gpt-image-golden',
      image: WORKING,
      compilerVersion: `${COMPILER_RELEASE}-openai`,
    };
    const request = compileEnhanceRequest(input);
    expect(request.instructionText).toBe(
      [ENHANCE_SCOPE, ENHANCE_KEEP, ENHANCE_QUALITY, ENHANCE_STYLE, ENHANCE_PROTECT].join(' '),
    );
    expect(request.kind).toBe('enhance');
    expect(request.mask).toBeUndefined();
    expect(request.images).toEqual([{ role: 'source', ...WORKING }]);
    expect(request.compilerVersion).toBe(`${COMPILER_RELEASE}-openai`);
    expect(request.parameters).toEqual({
      size: '1024x1024',
      quality: 'medium',
      output_format: 'jpeg',
      enhance: true,
    });
    expect(
      compileEnhanceRequest({ ...input, settings: { openaiQuality: 'high' } }).parameters.quality,
    ).toBe('high');
    expect(isEnhanceRequest(request)).toBe(true);
    expect(isRelightRequest(request)).toBe(false);
    expect(isEnhanceRequest({ parameters: { enhance: true } })).toBe(true);
    expect(JSON.stringify(compileEnhanceRequest(input))).toBe(JSON.stringify(request));
    for (const provider of COMPILER_PROVIDERS) {
      const enhance = enhanceCase(provider);
      expect(enhance.kind).toBe('enhance');
      expect(enhance.mask).toBe(false);
      expect(enhance.parameters.enhance).toBe(true);
    }
    // Another kind of request of the same image never shares its frozen settings.
    const relight = compileRelightRequest({
      target: 'evening',
      basePlan: {
        sceneType: 'house_exterior',
        placements: [],
        compilerVersion: input.compilerVersion,
      },
      provider: 'openai',
      modelSnapshot: input.modelSnapshot,
      image: WORKING,
    });
    expect(relight.settingsHash).not.toBe(request.settingsHash);
    expect(isEnhanceRequest(relight)).toBe(false);
    const decorate = compileCase(
      content.packFor('christmas')?.pack as HolidayPack,
      'house_exterior',
      null,
      'classic',
      'source',
      'openai',
    ) as { parameters: Record<string, string | number | boolean> };
    expect(isEnhanceRequest({ parameters: decorate.parameters })).toBe(false);
  });

  it('compiles the relight of a decorated photo: keep clause, lit decorations, no mask', () => {
    const cases = allCases();
    let relights = 0;
    for (const [label, value] of Object.entries(cases)) {
      if (!label.startsWith('relight.')) continue;
      const compiled = value as {
        instructionText?: string;
        parameters?: Record<string, unknown>;
        mask?: boolean;
        kind?: string;
      };
      if (!compiled.instructionText) continue;
      relights += 1;
      expect(compiled.kind, label).toBe('relight');
      expect(compiled.mask, label).toBe(false);
      expect(compiled.parameters?.relight, label).toBe(true);
      expect(compiled.instructionText, label).toContain(
        label.includes('.bright.') ? BRIGHT_RELIGHT_KEEP : RELIGHT_KEEP,
      );
      expect(compiled.instructionText, label).toContain('Only the lighting changes');
      expect(compiled.instructionText, label).toContain(
        'do not sharpen, reconstruct or replace them',
      );
      expect(compiled.instructionText, label).toMatch(/only the light changed\.$/);
      // A relight never adds decorations: no placement verbs from the decorate compiler.
      expect(compiled.instructionText, label).not.toMatch(
        /\b(Hang|Drape|String|Stand|Place) (a|an|one|two)\b/,
      );
      if (label.endsWith('.openai')) expect(compiled.parameters?.quality, label).toBe('medium');
    }
    expect(relights).toBeGreaterThan(10);

    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const built = buildPlan({
      renderJobId: 'job',
      planVersion: 1,
      sourceAssetId: 'sa',
      sceneAnalysisId: 'an',
      analysis: analysisFor('house_exterior', null),
      sourceKind: 'upload',
      pack,
      holidayPackVersion: pack.version,
      styleKitVersionId: 'kit',
      sceneType: 'house_exterior',
      style: 'classic',
      lightingMode: 'source',
      compilerVersion: 'test',
      permissionEvaluationId: 'pe',
    });
    const lit = {
      ...built.draft,
      placements: built.draft.placements.map((placement) =>
        placement.kitItemId.includes('string_lights') ? { ...placement, lit: true } : placement,
      ),
    };
    const day = compileRelightRequest({
      target: 'evening',
      basePlan: lit,
      provider: 'openai',
      modelSnapshot: 'm',
      image: WORKING,
    });
    // The lit decorations of the daylight plan are named once; the decorated home's porch light
    // and windows glow, and the other buildings get no new light.
    expect(day.instructionText).toContain(
      'glow warmly and cast soft light on nearby surfaces: the outdoor warm-white LED string lights on the roofline',
    );
    expect(day.instructionText.match(/string lights on the roofline/g)).toHaveLength(1);
    expect(day.instructionText).toContain(
      'On the decorated home the existing porch and entry lights are on and warm interior light shows through its existing windows. Other buildings in the photograph get no new light: their windows and lamps stay as they are.',
    );
    expect(day.instructionText).not.toContain('The existing porch and entry lights are on');
    expect(day.instructionText).not.toContain(RELIGHT_REPAIR_KEEP);
    const structure = relightCase(pack, 'house_exterior', null, 'classic', 'openai', [
      'structure_changed',
    ]) as { instructionText: string };
    expect(structure.instructionText).toContain(RELIGHT_REPAIR_KEEP);
    expect(structure.instructionText).not.toContain(RELIGHT_REPAIR_LIGHT);
    const light = relightCase(pack, 'house_exterior', null, 'classic', 'openai', [
      'lighting_implausible',
    ]) as { instructionText: string };
    expect(light.instructionText).toContain(RELIGHT_REPAIR_LIGHT);
    expect(light.instructionText).not.toContain(RELIGHT_REPAIR_KEEP);
    const camera = relightCase(pack, 'house_exterior', null, 'classic', 'openai', [
      'camera_changed',
    ]) as { parameters: Record<string, unknown> };
    expect(camera.parameters.quality).toBe('medium');
    // A room's evening relight keeps its own fixtures sentence.
    const room = relightCase(pack, 'interior', 'living_room', 'classic', 'openai') as {
      instructionText: string;
    };
    expect(room.instructionText).toContain('The existing lamps and ceiling fixtures are on.');
    expect(room.instructionText).not.toContain('Other buildings');
  });

  it('compiles the bright relight from the tested instruction, naming the lit decorations', () => {
    const cases = allCases();
    const bright = Object.entries(cases).filter(([label]) => label.startsWith('relight.bright.'));
    // Every interior and apartment entry of every pack relights to the bright look, from a
    // classic base and from a lavish one.
    expect(bright.map(([label]) => label.split('.').slice(2, 5).join('.')).sort()).toEqual(
      ['classic', 'abundant']
        .flatMap((style) => [
          ...['christmas', 'halloween', 'thanksgiving_us'].flatMap((h) =>
            COMPILER_PROVIDERS.map(() => `${h}.apartment_entry.${style}`),
          ),
          ...['christmas', 'halloween', 'new_years_eve', 'thanksgiving_us'].flatMap((h) =>
            COMPILER_PROVIDERS.map(() => `${h}.interior.${style}`),
          ),
        ])
        .sort(),
    );
    expect(bright).toHaveLength(42);
    expect(
      Object.keys(cases).some(
        (label) => label.includes('.bright.') && !label.startsWith('relight.'),
      ),
    ).toBe(false);
    for (const [label, value] of bright) {
      const compiled = value as {
        instructionText: string;
        parameters: Record<string, unknown>;
        mask: boolean;
        kind: string;
      };
      expect(compiled.kind, label).toBe('relight');
      expect(compiled.mask, label).toBe(false);
      expect(compiled.parameters.relight_target, label).toBe('bright');
      const text = compiled.instructionText;
      expect(text.startsWith(BRIGHT_RELIGHT_SCOPE), label).toBe(true);
      for (const sentence of [BRIGHT_RELIGHT_LIGHT, BRIGHT_RELIGHT_KEEP, BRIGHT_RELIGHT_EXPOSURE]) {
        expect(text, label).toContain(sentence);
      }
      expect(text, label).toContain('The lights on the holiday decorations stay on and glow');
      // A lavish base: the fixed decorations sentence, never a list of names.
      if (label.includes('.abundant.')) expect(text, label).not.toContain(' glow: the ');
      expect(
        text.includes(
          'The lights on the holiday decorations stay on and glow; any other bulbs, candles and lanterns on the decorations stay lit too.',
        ),
        label,
      ).toBe(label.includes('.abundant.'));
      expect(text, label).not.toMatch(/dusk|evening|blue hour/i);
      expect(text, label).not.toContain(RELIGHT_KEEP);
      expect(text, label).toMatch(/only the light changed\.$/);
    }
    // The tested sentences, verbatim.
    expect(BRIGHT_RELIGHT_SCOPE).toBe(
      'Relight this exact photograph so the space is bright, airy and cheerful, as on a sunny day with every light on.',
    );
    expect(BRIGHT_RELIGHT_KEEP).toContain('Nothing is added, removed, moved, replaced or restyled');

    // A base decorated from its placements; a lavish base names none.
    const pack = withoutLavish(content.packFor('christmas')?.pack as HolidayPack);
    const built = buildPlan({
      renderJobId: 'job',
      planVersion: 1,
      sourceAssetId: 'sa',
      sceneAnalysisId: 'an',
      analysis: analysisFor('interior', 'living_room'),
      sourceKind: 'upload',
      pack,
      holidayPackVersion: pack.version,
      styleKitVersionId: 'kit',
      sceneType: 'interior',
      roomType: 'living_room',
      style: 'abundant',
      lightingMode: 'source',
      compilerVersion: 'test',
      permissionEvaluationId: 'pe',
    });
    const lit = {
      ...built.draft,
      placements: built.draft.placements.map((p, i) => (i === 0 ? { ...p, lit: true } : p)),
    };
    const request = compileRelightRequest({
      target: 'bright',
      basePlan: lit,
      provider: 'openai',
      modelSnapshot: 'm',
      image: WORKING,
    });
    expect(request.instructionText).toMatch(
      /The lights on the holiday decorations stay on and glow: the [^;]+ on the [^;]+; any other bulbs, candles and lanterns on the decorations stay lit too\./,
    );
    expect(relightTargetOf(request)).toBe('bright');
    const evening = compileRelightRequest({
      target: 'evening',
      basePlan: lit,
      provider: 'openai',
      modelSnapshot: 'm',
      image: WORKING,
    });
    expect(evening.settingsHash).not.toBe(request.settingsHash);
    // A bright repair after implausible light uses the bright light sentence, never the dusk one.
    const light = relightCase(
      pack,
      'interior',
      'living_room',
      'classic',
      'openai',
      ['lighting_implausible'],
      'bright',
    ) as { instructionText: string };
    expect(light.instructionText).toContain(RELIGHT_REPAIR_BRIGHT_LIGHT);
    expect(light.instructionText).not.toContain(RELIGHT_REPAIR_LIGHT);
    const structure = relightCase(
      pack,
      'interior',
      'living_room',
      'classic',
      'openai',
      ['structure_changed'],
      'bright',
    ) as { instructionText: string };
    expect(structure.instructionText).toContain(RELIGHT_REPAIR_KEEP);
  });

  it('marks relight requests for the fixture editor and keeps them deterministic', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const first = relightCase(pack, 'house_exterior', null, 'abundant', 'fixture');
    const second = relightCase(pack, 'house_exterior', null, 'abundant', 'fixture');
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const built = buildPlan({
      renderJobId: 'job',
      planVersion: 1,
      sourceAssetId: 'sa',
      sceneAnalysisId: 'an',
      analysis: analysisFor('house_exterior', null),
      sourceKind: 'upload',
      pack,
      holidayPackVersion: pack.version,
      styleKitVersionId: 'kit',
      sceneType: 'house_exterior',
      style: 'classic',
      lightingMode: 'source',
      compilerVersion: 'test',
      permissionEvaluationId: 'pe',
    });
    const request = compileRelightRequest({
      target: 'evening',
      basePlan: built.draft,
      provider: 'openai',
      modelSnapshot: 'm',
      image: WORKING,
      settings: { openaiQuality: 'high', providerMask: 'tight' },
    });
    expect(isRelightRequest(request)).toBe(true);
    expect(relightTargetOf(request)).toBe('evening');
    expect(request.parameters.relight_target).toBe('evening');
    expect(request.mask).toBeUndefined();
    expect(request.parameters).toMatchObject({ quality: 'high', size: '1024x1024' });
    expect(request.images).toEqual([{ role: 'source', ...WORKING }]);
    const decorate = compilePlan(
      built.draft,
      compileContentFor(pack, 'house_exterior', 'classic'),
      {
        provider: 'openai',
        modelSnapshot: 'm',
        working: WORKING,
        supportsMask: true,
      },
    ).request;
    expect(isRelightRequest(decorate)).toBe(false);
    expect(request.settingsHash).not.toBe(decorate.settingsHash);
  });
});

/** The plan input of one pack cell on the golden analysis (or another analysis). */
function cellInput(
  pack: HolidayPack,
  sceneType: SceneType,
  style: (typeof STYLES)[number],
  analysis?: SceneAnalysis,
) {
  const roomType =
    sceneType === 'interior'
      ? (pack.sceneSections.interior?.roomTypes?.[0] ?? 'living_room')
      : null;
  return {
    renderJobId: 'job',
    planVersion: 1 as const,
    sourceAssetId: 'sa',
    sceneAnalysisId: 'an',
    analysis: analysis ?? analysisFor(sceneType, roomType),
    sourceKind: 'upload' as const,
    pack,
    holidayPackVersion: pack.version,
    styleKitVersionId: 'kit',
    sceneType,
    roomType: roomType as never,
    style,
    lightingMode: 'source' as const,
    compilerVersion: 'test',
    permissionEvaluationId: 'pe',
  };
}

const OPENAI = {
  provider: 'openai' as const,
  modelSnapshot: 'm',
  working: WORKING,
  supportsMask: true,
};

/** Every pack cell: holiday pack and scene type. */
function cells(): { pack: HolidayPack; sceneType: SceneType }[] {
  return content.packs.flatMap(({ pack }) =>
    (Object.keys(pack.sceneSections) as SceneType[]).map((sceneType) => ({ pack, sceneType })),
  );
}

/** Pack text as the compiler states it: one line, capitalized, with a final period. */
function asSentence(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ');
  const capitalized = `${line[0]?.toUpperCase()}${line.slice(1)}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

describe('lavish tier', () => {
  it('compiles the lavish description of a house exterior in place of placement sentences', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const section = pack.sceneSections.house_exterior;
    const lavish = section?.promptFragments.lavish;
    if (!section || !lavish) throw new Error('the Christmas house exterior has no description');
    const result = planAndCompile(cellInput(pack, 'house_exterior', 'abundant'), () => OPENAI);
    const draft = result.built.draft;
    expect(draft.lavish).toEqual({ lit: true });
    expect(draft.placements.length).toBeGreaterThan(3);
    const facade = draft.preserve.targetFacade as NormalizedBox;
    expect(facade).toBeDefined();
    const expected = [
      `Edit only the target house, the building ${positionWords(facade)}, and its own yard in the attached photo to show ${lavish.scene.trim().replace(/\s+/g, ' ')}, in the lighting of the original photograph.`,
      asSentence(section.promptFragments.preserve),
      LAVISH_ADDED,
      asSentence(lavish.decorations),
      LAVISH_LIGHTS_ON,
      LAVISH_REALISM,
      'Keep the lighting, sky and time of day of the original photograph.',
      'Leave any blurred or pixelated areas, people, vehicles and license plates exactly as they appear; do not sharpen, reconstruct or replace them.',
      asSentence(lavish.negative),
      `Also add no ${draft.negatives.slice(0, -1).join(', ')}${draft.negatives.length > 1 ? ' or ' : ''}${draft.negatives[draft.negatives.length - 1]}.`,
      KEEP_MARKS_EXTERIOR,
      LAVISH_ACCESS_EXTERIOR,
      LAVISH_OUTPUT,
    ].join(' ');
    const text = result.compile?.request.instructionText as string;
    expect(text).toBe(expected);
    expect(text).not.toContain(', at the ');
    expect(text).not.toContain('only these decorations added');
    expect(text).not.toContain('tasteful');
    expect(text).not.toContain('glow softly');
    expect(result.compile?.droppedPlacementIds).toEqual([]);
    expect(result.built.draft.placements).toEqual(draft.placements);
  });

  it('names where the target house is in the scope only when the plan has a target facade', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const built = buildPlan(cellInput(pack, 'house_exterior', 'abundant'));
    const contentFor = compileContentFor(pack, 'house_exterior', 'abundant');
    const scene = pack.sceneSections.house_exterior?.promptFragments.lavish?.scene
      .trim()
      .replace(/\s+/g, ' ');
    const left = {
      ...built.draft,
      preserve: { ...built.draft.preserve, targetFacade: [0.02, 0.1, 0.3, 0.9] as NormalizedBox },
    };
    expect(compilePlan(left, contentFor, OPENAI).request.instructionText).toMatch(
      new RegExp(
        `^Edit only the target house, the building on the left side of the image, and its own yard in the attached photo to show ${scene}, in the lighting of the original photograph\\. `,
      ),
    );
    const { targetFacade: _facade, ...preserve } = built.draft.preserve;
    const unplaced = { ...built.draft, preserve };
    const text = compilePlan(unplaced, contentFor, OPENAI).request.instructionText;
    expect(
      text.startsWith(
        `Edit only the target house and its own yard in the attached photo to show ${scene}, in the lighting of the original photograph. `,
      ),
    ).toBe(true);
    expect(text).not.toContain('the building');
    // Other scene types keep their scope wording, whatever the plan's facade.
    const balcony = buildPlan(cellInput(pack, 'balcony', 'abundant'));
    const balconyText = compilePlan(
      {
        ...balcony.draft,
        preserve: { ...balcony.draft.preserve, targetFacade: [0.1, 0.1, 0.9, 0.9] },
      },
      compileContentFor(pack, 'balcony', 'abundant'),
      OPENAI,
    ).request.instructionText;
    expect(
      balconyText.startsWith('Edit only the target balcony in the attached photo to show '),
    ).toBe(true);
  });

  it('words the scope, the marks and the access sentence of a lavish request by scene type', () => {
    let checked = 0;
    for (const { pack, sceneType } of cells()) {
      const label = `${pack.holidayId}.${sceneType}`;
      const lavish = pack.sceneSections[sceneType]?.promptFragments.lavish;
      expect(lavish, label).toBeDefined();
      const result = planAndCompile(cellInput(pack, sceneType, 'abundant'), () => OPENAI);
      const text = result.compile?.request.instructionText as string;
      expect(result.built.draft.lavish, label).toEqual({ lit: lavish?.lit });
      expect(text.includes('and its own yard'), label).toBe(sceneType === 'house_exterior');
      expect(text.includes(KEEP_MARKS_EXTERIOR), label).toBe(sceneType === 'house_exterior');
      expect(text.includes(KEEP_MARKS), label).toBe(sceneType !== 'house_exterior');
      const outdoors = sceneType === 'house_exterior' || sceneType === 'balcony';
      expect(text.includes(LAVISH_ACCESS_EXTERIOR), label).toBe(outdoors);
      expect(text.includes(LAVISH_ACCESS_INTERIOR), label).toBe(!outdoors);
      expect(text.includes(LAVISH_LIGHTS_ON), label).toBe(lavish?.lit === true);
      if (lavish?.lit) expect(text, label).not.toContain('No electric lights');
      expect(text, label).not.toContain(', at the ');
      expect(
        text.endsWith(
          `${outdoors ? LAVISH_ACCESS_EXTERIOR : LAVISH_ACCESS_INTERIOR} ${LAVISH_OUTPUT}`,
        ),
        label,
      ).toBe(true);
      checked += 1;
    }
    expect(checked).toBe(15);
  });

  it('asks for the lights of a lavish description only when it is lit', () => {
    const lavishWith = (holidayId: 'thanksgiving_us' | 'christmas', lit: boolean) => {
      const pack = structuredClone(content.packFor(holidayId)?.pack as HolidayPack);
      const lavish = pack.sceneSections.house_exterior?.promptFragments.lavish;
      if (!lavish) throw new Error(`the ${holidayId} house exterior has no lavish description`);
      lavish.lit = lit;
      const result = planAndCompile(cellInput(pack, 'house_exterior', 'abundant'), () => OPENAI);
      expect(result.built.draft.lavish, `${holidayId} ${lit}`).toEqual({ lit });
      return result.compile?.request.instructionText as string;
    };
    const keep = 'Keep the lighting, sky and time of day of the original photograph.';
    // Thanksgiving allows no electric lights outdoors.
    const unlit = lavishWith('thanksgiving_us', false);
    expect(unlit).not.toContain(LAVISH_LIGHTS_ON);
    expect(unlit).toContain(`${keep} No electric lights.`);
    const lit = lavishWith('thanksgiving_us', true);
    expect(lit).toContain(LAVISH_LIGHTS_ON);
    expect(lit).not.toContain('No electric lights.');
    expect(lit).toContain(keep);
    // Christmas allows lights: an unlit description asks for none and forbids none.
    const christmas = lavishWith('christmas', false);
    expect(christmas).not.toContain(LAVISH_LIGHTS_ON);
    expect(christmas).not.toContain('No electric lights.');
    expect(christmas).toContain(keep);
    expect(LAVISH_LIGHTS_ON).toBe(
      'Every light on the decorations is switched on and visibly glowing.',
    );
  });

  it('never cuts a lavish request and never drops its placements', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const input = cellInput(pack, 'house_exterior', 'abundant');
    const uncapped = planAndCompile(input, () => OPENAI);
    const capped = planAndCompile(input, () => ({
      ...OPENAI,
      caps: { source: 500, evening: 500 },
    }));
    expect(capped.compile?.request.instructionText).toBe(uncapped.compile?.request.instructionText);
    expect(capped.compile?.droppedPlacementIds).toEqual([]);
    expect(capped.built.draft.placements).toEqual(buildPlan(input).draft.placements);
    expect(capped.built.draft.placements.length).toBeGreaterThan(1);
  });

  it('keeps every lavish request within the source cap with two house numbers and every major repair constraint, and the ordinary repair after every code too', () => {
    const codes: FailureCode[] = [
      'structure_changed',
      'neighbor_decorated',
      'access_blocked',
      'privacy_regression',
      'people_altered',
      'text_added',
      'camera_changed',
      'unrequested_change',
      'plan_not_followed',
      'implausible_decor',
      'lighting_implausible',
    ];
    // The largest lavish repair: every major code (a critical code makes the repair ordinary).
    const majors = codes.filter((code) => !isCriticalFailureCode(code));
    expect(majors).toHaveLength(4);
    let longest = 0;
    let checked = 0;
    let ordinaryChecked = 0;
    for (const { pack, sceneType } of cells()) {
      const roomType =
        sceneType === 'interior'
          ? (pack.sceneSections.interior?.roomTypes?.[0] ?? 'living_room')
          : null;
      const base = analysisFor(sceneType, roomType);
      const analysis: SceneAnalysis = {
        ...base,
        preserveRegions: [
          ...base.preserveRegions,
          { kind: 'house_number', box: [0.9, 0.45, 0.93, 0.55] },
          { kind: 'house_number', box: [0.05, 0.85, 0.08, 0.9] },
        ],
      };
      const input = cellInput(pack, sceneType, 'abundant', analysis);
      const first = buildPlan(input);
      expect(first.validator.passed, `${pack.holidayId}.${sceneType}`).toBe(true);
      const plan = {
        ...first.draft,
        compiled: {
          provider: 'openai',
          modelSnapshot: 'm',
          instructionText: 'x',
          parameters: {},
          hash: 'x',
        },
      };
      // The repairs as the pipeline derives them: constraint sentences and placement adjustments.
      const repairOf = (repairCodes: FailureCode[]) =>
        deriveRepair(
          plan,
          first.placementKeys,
          repairCodes.map((code) => ({ code })),
          null,
        );
      const lavishRepair = repairOf(majors);
      expect(lavishRepair.constraints.length).toBe(majors.length);
      expect(lavishRepair.adjustments.ordinary).toBeUndefined();
      const ordinaryRepair = repairOf(codes);
      expect(ordinaryRepair.constraints.length).toBe(codes.length);
      expect(ordinaryRepair.adjustments.excludePairs.length).toBeGreaterThan(0);
      expect(ordinaryRepair.adjustments.ordinary).toBe(true);
      for (const provider of COMPILER_PROVIDERS) {
        const compileWith = (repair: typeof lavishRepair) =>
          planAndCompile({ ...input, planVersion: 2, repair }, () => ({
            ...OPENAI,
            provider,
            supportsMask: provider !== 'gemini',
            lowerQuality: repair.adjustments.lowerQuality ?? false,
          }));
        const label = `${pack.holidayId}.${sceneType}.${provider}`;
        const result = compileWith(lavishRepair);
        const text = result.compile?.request.instructionText as string;
        expect(result.built.validator.passed, label).toBe(true);
        expect(result.built.draft.lavish, label).toBeDefined();
        expect(text, label).toContain('The house number');
        expect(text.length, label).toBeLessThanOrEqual(PIPELINE_DEFAULTS.instructionCaps.source);
        longest = Math.max(longest, text.length);
        checked += 1;
        // The repair after every code, a critical one among them, is the ordinary look.
        const ordinary = compileWith(ordinaryRepair);
        const ordinaryText = ordinary.compile?.request.instructionText as string;
        expect(ordinary.built.validator.passed, label).toBe(true);
        expect(ordinary.built.draft.lavish, label).toBeUndefined();
        expect(ordinaryText, label).not.toContain(LAVISH_ADDED);
        expect(ordinaryText.length, label).toBeLessThanOrEqual(
          PIPELINE_DEFAULTS.instructionCaps.source,
        );
        ordinaryChecked += 1;
      }
    }
    expect(checked).toBe(45);
    expect(ordinaryChecked).toBe(45);
    expect(longest).toBeGreaterThan(3500);
  });

  it('sends no mask with a lavish request under the tight mask policy', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const tight = { ...OPENAI, mask: MASK, settings: { providerMask: 'tight' as const } };
    const lavish = buildPlan(cellInput(pack, 'house_exterior', 'abundant'));
    const classic = buildPlan(cellInput(pack, 'house_exterior', 'classic'));
    expect(lavish.draft.lavish).toBeDefined();
    expect(lavish.draft.fidelityMode).toBe('composite_additive');
    const lavishRequest = compilePlan(
      lavish.draft,
      compileContentFor(pack, 'house_exterior', 'abundant'),
      tight,
    ).request;
    const classicRequest = compilePlan(
      classic.draft,
      compileContentFor(pack, 'house_exterior', 'classic'),
      tight,
    ).request;
    expect(lavishRequest.mask).toBeUndefined();
    expect(classicRequest.mask).toEqual(MASK);
  });

  it('appends the repair constraints to the same lavish description after a major code; a critical code repairs with the placement request', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const input = cellInput(pack, 'house_exterior', 'abundant');
    const first = planAndCompile(input, () => OPENAI);
    const firstText = first.compile?.request.instructionText as string;
    const plan = {
      ...first.built.draft,
      compiled: {
        provider: 'openai',
        modelSnapshot: 'm',
        instructionText: 'x',
        parameters: {},
        hash: 'x',
      },
    };
    const repairedFor = (code: FailureCode) => {
      const repair = deriveRepair(plan, first.built.placementKeys, [{ code }], null);
      return planAndCompile({ ...input, planVersion: 2, repair }, () => OPENAI);
    };
    for (const code of [
      'plan_not_followed',
      'unrequested_change',
      'implausible_decor',
      'lighting_implausible',
    ] as const) {
      const repaired = repairedFor(code);
      expect(repaired.built.draft.lavish, code).toEqual({ lit: true });
      const constraints = (repaired.built.draft.repairConstraints ?? []).map((constraint) =>
        asSentence(constraint.instruction),
      );
      expect(constraints.length, code).toBeGreaterThan(0);
      expect(repaired.compile?.request.instructionText, code).toBe(
        firstText.replace(
          ` ${LAVISH_ACCESS_EXTERIOR} `,
          ` ${constraints.join(' ')} ${LAVISH_ACCESS_EXTERIOR} `,
        ),
      );
      if (code === 'plan_not_followed') {
        expect(JSON.stringify(repaired.built.draft.placements), code).not.toBe(
          JSON.stringify(first.built.draft.placements),
        );
      }
    }
    // After a critical code the repaired plan has no mark: its request is the placement request
    // and does not state the description.
    const description = pack.sceneSections.house_exterior?.promptFragments.lavish;
    if (!description) throw new Error('the Christmas house exterior has no description');
    const structural = repairedFor('structure_changed');
    expect(structural.built.draft.lavish).toBeUndefined();
    const text = structural.compile?.request.instructionText as string;
    expect(text).toContain(', at the ');
    expect(text).toContain(
      'Keep the roof line, walls, windows, doors, trim and materials exactly as in the original; change nothing about the structure.',
    );
    expect(text).not.toContain(LAVISH_ADDED);
    expect(text).not.toContain(LAVISH_ACCESS_EXTERIOR);
    expect(text).not.toContain(asSentence(description.decorations));
    expect(text.endsWith('Return the same photograph with only these decorations added.')).toBe(
      true,
    );
  });

  it('refuses to compile a lavish plan without its description', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const built = buildPlan(cellInput(pack, 'house_exterior', 'abundant'));
    expect(built.draft.lavish).toBeDefined();
    expect(() =>
      compilePlan(
        built.draft,
        compileContentFor(withoutLavish(pack), 'house_exterior', 'abundant'),
        OPENAI,
      ),
    ).toThrow(/no lavish description/);
  });

  it('compiles a section without a lavish description as before', () => {
    const pack = withoutLavish(content.packFor('christmas')?.pack as HolidayPack);
    const result = planAndCompile(cellInput(pack, 'house_exterior', 'abundant'), () => OPENAI);
    expect(result.built.draft.lavish).toBeUndefined();
    const text = result.compile?.request.instructionText as string;
    expect(text).toContain(', at the ');
    expect(text).not.toContain(LAVISH_ADDED);
    expect(text).not.toContain(LAVISH_ACCESS_EXTERIOR);
    expect(text.endsWith('Return the same photograph with only these decorations added.')).toBe(
      true,
    );
  });

  it('relights a lavish base brightly and names no decoration', () => {
    const pack = content.packFor('christmas')?.pack as HolidayPack;
    const built = buildPlan(cellInput(pack, 'house_exterior', 'abundant'));
    const base = {
      ...built.draft,
      placements: built.draft.placements.map((placement) =>
        placement.kitItemId.includes('string_lights') ? { ...placement, lit: true } : placement,
      ),
    };
    expect(base.lavish).toEqual({ lit: true });
    expect(base.placements.some((placement) => placement.lit)).toBe(true);
    const relight = (
      basePlan: Parameters<typeof compileRelightRequest>[0]['basePlan'],
      target: RelightLightingMode = 'evening',
      codes: FailureCode[] = [],
    ) =>
      compileRelightRequest({
        target,
        basePlan,
        provider: 'openai',
        modelSnapshot: 'm',
        image: WORKING,
        repair: codes.length > 0 ? { codes } : null,
      }).instructionText;
    const fixtures =
      'On the decorated home the existing porch and entry lights are on and warm interior light shows through its existing windows. Other buildings in the photograph get no new light: their windows and lamps stay as they are.';
    const protect =
      'Leave any blurred or pixelated areas, people, vehicles and license plates exactly as they appear; do not sharpen, reconstruct or replace them.';
    const evening = relight(base);
    expect(evening).toBe(
      [
        'Relight this exact photograph to early evening at blue hour, about twenty minutes after sunset.',
        RELIGHT_KEEP,
        LAVISH_RELIGHT_AMBIENT,
        LAVISH_RELIGHT_DECORATIONS,
        fixtures,
        LAVISH_RELIGHT_EXPOSURE,
        protect,
        'Return the same photograph with only the light changed.',
      ].join(' '),
    );
    for (const phrase of [
      'darker overall',
      'glow warmly and cast soft light',
      'natural dusk exposure',
      'string lights on the',
    ]) {
      expect(evening).not.toContain(phrase);
    }
    // The bright relight of a lavish base keeps its sentences and names no decoration.
    const brightDecorations =
      'The lights on the holiday decorations stay on and glow; any other bulbs, candles and lanterns on the decorations stay lit too.';
    expect(LAVISH_BRIGHT_RELIGHT_DECORATIONS).toBe(brightDecorations);
    const plain = { ...base, lavish: undefined };
    const bright = relight(base, 'bright');
    expect(relight(plain, 'bright')).toMatch(/stay on and glow: the /);
    expect(bright).toBe(
      [
        BRIGHT_RELIGHT_SCOPE,
        BRIGHT_RELIGHT_LIGHT,
        brightDecorations,
        BRIGHT_RELIGHT_KEEP,
        BRIGHT_RELIGHT_EXPOSURE,
        protect,
        'Return the same photograph with only the light changed.',
      ].join(' '),
    );
    expect(bright).not.toContain('glow: the ');
    // A lavish base without electric lights, or a room, keeps the ordinary evening wording
    // without a list of names.
    const unlit = relight({ ...base, lavish: { lit: false } });
    expect(unlit).toContain('the scene is darker overall');
    expect(unlit).toContain(
      'Any bulbs, candles and lanterns already on the decorations glow warmly and cast soft light on nearby surfaces.',
    );
    expect(unlit).not.toContain(LAVISH_RELIGHT_AMBIENT);
    expect(relight(plain)).toContain('cast soft light on nearby surfaces: the ');
    const room = buildPlan(cellInput(pack, 'interior', 'abundant'));
    const roomBase = {
      ...room.draft,
      placements: room.draft.placements.map((p, i) => (i === 0 ? { ...p, lit: true } : p)),
    };
    expect(roomBase.lavish).toEqual({ lit: true });
    const roomEvening = relight(roomBase);
    expect(roomEvening).toContain('The existing lamps and ceiling fixtures are on.');
    expect(roomEvening).not.toContain(LAVISH_RELIGHT_AMBIENT);
    expect(roomEvening).not.toContain('nearby surfaces: the ');
    const roomBright = relight(roomBase, 'bright');
    expect(roomBright).toContain(brightDecorations);
    expect(roomBright).not.toContain('glow: the ');
    // A relight repair inserts its sentences after the keep clause, as for any base.
    const structure = relight(base, 'evening', ['structure_changed', 'lighting_implausible']);
    expect(structure).toBe(
      evening.replace(
        `${RELIGHT_KEEP} `,
        `${RELIGHT_KEEP} ${RELIGHT_REPAIR_KEEP} ${RELIGHT_REPAIR_LIGHT} `,
      ),
    );
    const brightRepair = relight(base, 'bright', ['lighting_implausible']);
    expect(brightRepair).toContain(RELIGHT_REPAIR_BRIGHT_LIGHT);
    expect(brightRepair).toContain(brightDecorations);
  });
});
