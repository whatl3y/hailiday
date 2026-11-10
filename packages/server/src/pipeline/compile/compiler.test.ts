import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SCENE_ANALYSIS_SCHEMA_VERSION,
  STYLES,
  type FailureCode,
  type HolidayPack,
  type SceneAnalysis,
  type SceneType,
} from '@holiday/core';
import { loadContent, type Content } from '../../content/load.js';
import { genericUploadGeometry } from '../../fixtures/layouts.js';
import { geometryToModelOutput } from '../../fixtures/scene.js';
import { buildPlan, compileContentFor, deriveRepair, planAndCompile } from '../plan/index.js';
import { COMPILER_RELEASE, PIPELINE_DEFAULTS } from '../versions.js';
import {
  COMPILER_PROVIDERS,
  EVENING_KEEP,
  RELIGHT_KEEP,
  RELIGHT_REPAIR_KEEP,
  RELIGHT_REPAIR_LIGHT,
  compilePlan,
  compileRelightRequest,
  isRelightRequest,
  providerParameters,
  type CompilerProvider,
} from './compiler.js';

/**
 * Golden files: every example pack scene section × style × offered lighting mode, and every
 * repair constraint type, compiled per provider. Regenerate with `UPDATE_GOLDEN=1` only together
 * with a `COMPILER_RELEASE` bump.
 */
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
  };
}

/** The relight of a `source` plan of one pack cell (the evening variant's request). */
function relightCase(
  pack: HolidayPack,
  sceneType: SceneType,
  roomType: string | null,
  style: (typeof STYLES)[number],
  provider: CompilerProvider,
  repairCodes: FailureCode[] = [],
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
      for (const style of STYLES) {
        for (const lightingMode of pack.lightingPolicy.bySceneType[sceneType]?.offered ?? []) {
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
  // Evening relights of the daylight plan of every cell that offers evening, and relight repairs.
  for (const { pack } of content.packs) {
    for (const sceneType of Object.keys(pack.sceneSections) as SceneType[]) {
      if (!(pack.lightingPolicy.bySceneType[sceneType]?.offered ?? []).includes('evening'))
        continue;
      const section = pack.sceneSections[sceneType];
      const roomType = sceneType === 'interior' ? (section?.roomTypes?.[0] ?? 'living_room') : null;
      for (const provider of COMPILER_PROVIDERS) {
        cases[`relight.${pack.holidayId}.${sceneType}.classic.${provider}`] = relightCase(
          pack,
          sceneType,
          roomType,
          'classic',
          provider,
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
    }
  }
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
      style: 'abundant',
      lightingMode: 'source',
      compilerVersion: 'test',
      permissionEvaluationId: 'pe',
    });
    const contentFor = compileContentFor(pack, 'house_exterior', 'abundant');
    const caps = { source: 1500, evening: 2000 };
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

  it('fits every planned placement of classic and abundant within the default caps', () => {
    expect(PIPELINE_DEFAULTS.instructionCaps).toEqual({ source: 4000, evening: 5000 });
    let checked = 0;
    for (const { pack } of content.packs) {
      for (const sceneType of Object.keys(pack.sceneSections) as SceneType[]) {
        const section = pack.sceneSections[sceneType];
        const roomType =
          sceneType === 'interior' ? (section?.roomTypes?.[0] ?? 'living_room') : null;
        for (const style of ['classic', 'abundant'] as const) {
          for (const lightingMode of pack.lightingPolicy.bySceneType[sceneType]?.offered ?? []) {
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
      if (!text || label.startsWith('relight.')) continue;
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

  it('compiles the relight of a daylight variant: keep clause, lit decorations, no mask', () => {
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
      expect(compiled.instructionText, label).toContain(RELIGHT_KEEP);
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
      basePlan: lit,
      provider: 'openai',
      modelSnapshot: 'm',
      image: WORKING,
    });
    // The lit decorations of the daylight plan are named once; the porch light and windows glow.
    expect(day.instructionText).toContain(
      'glow warmly and cast soft light on nearby surfaces: the outdoor warm-white LED string lights on the roofline',
    );
    expect(day.instructionText.match(/string lights on the roofline/g)).toHaveLength(1);
    expect(day.instructionText).toContain('porch and entry lights are on');
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
      basePlan: built.draft,
      provider: 'openai',
      modelSnapshot: 'm',
      image: WORKING,
      settings: { openaiQuality: 'high', providerMask: 'tight' },
    });
    expect(isRelightRequest(request)).toBe(true);
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
