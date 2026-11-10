import { describe, expect, it } from 'vitest';
import { DecorationPlanSchema, JudgeResultSchema, type DecorationPlan } from '@holiday/core';
import { createFixtureVisionModel } from './fixture.js';
import {
  JUDGE_PROMPT_VERSION,
  JUDGE_RELIGHT_SYSTEM_PROMPT,
  JUDGE_SYSTEM_PROMPT,
  judgeUserPrompt,
  protectedSpotLines,
} from './prompts.js';

const plan: DecorationPlan = DecorationPlanSchema.parse({
  schemaVersion: '1.0',
  renderJobId: 'job-1',
  planVersion: 1,
  attemptNumber: 1,
  sourceAssetId: 'source-1',
  sceneAnalysisId: 'analysis-1',
  countryCode: 'US',
  locale: 'en-US',
  sceneType: 'house_exterior',
  buildingForm: 'detached',
  holidayId: 'christmas',
  holidayPackVersion: '1.0.0',
  styleKitVersionId: 'kit-1',
  style: 'classic',
  lightingMode: 'source',
  fidelityMode: 'composite_additive',
  compilerVersion: '2026.11.2-openai',
  placements: [
    {
      id: 'p1',
      kitItemId: 'xmas_ext_wreath',
      anchorId: 'a1',
      anchorCategory: 'front_door',
      region: [0.46, 0.5, 0.54, 0.62],
      placementRule: 'centered_on',
      count: 1,
      specText: '24-inch fresh fir wreath',
      specAttributes: {},
      lit: false,
      priority: 1,
    },
  ],
  preserve: {
    targetFacade: [0.1, 0.15, 0.9, 0.95],
    regions: [
      { kind: 'house_number', box: [0.58, 0.55, 0.62, 0.6] },
      { kind: 'sign', box: [0.05, 0.4, 0.15, 0.5] },
      { kind: 'logo', box: [0.02, 0.95, 0.12, 0.99] },
      { kind: 'existing_decor', box: [0.7, 0.6, 0.8, 0.7] },
      { kind: 'vehicle', box: [0.75, 0.8, 0.98, 0.98] },
      { kind: 'other', box: [0.2, 0.2, 0.3, 0.3] },
    ],
    protectedBlurRegions: [
      { kind: 'face', box: [0.3, 0.6, 0.33, 0.64] },
      { kind: 'plate', box: [0.85, 0.9, 0.92, 0.93] },
    ],
    peopleBoxes: [[0.28, 0.55, 0.36, 0.9]],
    accessRegions: [{ kind: 'walkway', box: [0.4, 0.85, 0.6, 1] }],
    existingDecorations: [],
    keepSkyAndTimeOfDay: true,
    neighborsUnchanged: true,
    noSnow: true,
    attributionRegion: [0, 0.95, 0.12, 1],
    attributionRegions: [
      [0, 0.95, 0.12, 1],
      [0.75, 0.96, 1, 1],
    ],
  },
  negatives: ['people'],
  lightingInstruction: { mode: 'source', text: 'Keep the lighting.' },
  existingDecorConflict: false,
  permissionEvaluationId: 'pe-1',
  referenceAssetIds: [],
  compiled: {
    provider: 'openai',
    modelSnapshot: 'gpt-image-2.5-flare',
    instructionText: 'Edit only the target house.',
    parameters: {},
    hash: 'sha256:x',
  },
});

describe('judge prompt', () => {
  it('lists every protected spot with its kind, position and the code to report', () => {
    const prompt = judgeUserPrompt(plan);
    expect(prompt).toContain('Protected spots to inspect:');
    for (const line of [
      '- a person (lower left of the image): must stay unchanged; report people_altered if not.',
      '- a blurred face (middle left of the image): must stay blurred and unchanged; report privacy_regression if it is clearer or reconstructed.',
      '- a blurred license plate (lower right of the image): must stay blurred and unchanged; report privacy_regression if it is clearer or reconstructed.',
      '- a house number (middle center of the image): must stay unchanged; report text_added if not.',
      '- a sign (middle left of the image): must stay unchanged; report text_added if not.',
      '- a logo or burned-in mark (lower left of the image): must stay unchanged; report text_added if not.',
      '- an existing decoration (middle right of the image): must stay unchanged; report unrequested_change if not.',
      '- a vehicle (lower right of the image): must stay unchanged; report unrequested_change if not.',
      '- the walkway (lower center of the image): must stay clear; report access_blocked if decor obstructs it.',
      '- the burned-in imagery attribution (lower left of the image): must stay exactly as in the original; report attribution_altered if it is covered, cropped or changed.',
      '- the burned-in imagery attribution (lower right of the image): must stay exactly as in the original; report attribution_altered if it is covered, cropped or changed.',
    ]) {
      expect(prompt).toContain(line);
    }
    // A preserve region of kind `other` carries no code of its own.
    expect(protectedSpotLines(plan.preserve)).toHaveLength(11);
  });

  it('reads a stored plan that has only the single attribution rectangle', () => {
    const { attributionRegions: _omitted, ...older } = plan.preserve;
    const lines = protectedSpotLines(older);
    expect(lines.filter((line) => line.includes('attribution_altered'))).toEqual([
      '- the burned-in imagery attribution (lower left of the image): must stay exactly as in the original; report attribution_altered if it is covered, cropped or changed.',
    ]);
  });

  it('adds no block when nothing is protected, and never carries address or user text', () => {
    const bare = judgeUserPrompt({
      ...plan,
      preserve: {
        ...plan.preserve,
        regions: [],
        protectedBlurRegions: [],
        peopleBoxes: [],
        accessRegions: [],
        attributionRegion: undefined,
        attributionRegions: undefined,
      },
    } as DecorationPlan);
    expect(bare).not.toContain('Protected spots');
    expect(judgeUserPrompt(plan)).not.toMatch(/\d+ [A-Z][a-z]+ (Street|Lane|Road|Avenue)/);
  });

  it('keeps the fixture judge result valid under the new prompt version', async () => {
    expect(JUDGE_PROMPT_VERSION).toBe('judge-2026.11.3');
    const vision = createFixtureVisionModel();
    const image = { bytes: new Uint8Array([1]), width: 1024, height: 1024 };
    const call = await vision.judge({
      renderAttemptId: 'attempt-1',
      original: image,
      candidate: image,
      plan,
    });
    const parsed = JudgeResultSchema.parse(call.result);
    expect(parsed.judgePromptVersion).toBe('judge-2026.11.3');
    expect(call.promptVersion).toBe('judge-2026.11.3');
    expect(parsed.placements.map((p) => p.placementId)).toEqual(['p1']);
  });

  it('judges plan adherence by kinds and counts, not exact spots', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'plan_not_followed (a key planned item is missing, the decorations are of the wrong kind, holiday or style, or clearly fewer than planned)',
    );
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'a planned item placed in a different natural spot (for example two potted trees flanking the door instead of beside the steps) is present and is not plan_not_followed',
    );
    expect(judgeUserPrompt(plan)).toContain(
      'Planned placements (the kinds and counts matter: each must be present; a different natural spot is fine, and so are additional decorations of the requested holiday and style in sensible places):',
    );
  });

  it('passes check hints, including changes restored from the original', () => {
    const prompt = judgeUserPrompt(plan, [
      'restored from the original: rocking chair moved to the left',
      'structure_changed drift 0.04',
    ]);
    expect(prompt).toContain(
      'Deterministic check hints (a change described as restored from the original was already put back in image 2 and is not a failure; a change described as inside the kept decorations is still in image 2: inspect it and report unrequested_change or structure_changed if it changed what belongs to the home): restored from the original: rocking chair moved to the left; structure_changed drift 0.04.',
    );
  });

  it('does not count matching extra decorations against the render in decorate mode', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'Additional decorations of the requested holiday and style in sensible places (for example matching garlands over more windows than planned) are expected: they are neither unrequested_change nor plan_not_followed; judge them only for implausible_decor and access_blocked.',
    );
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'A decoration that replaces or covers up an object of the home (an urn, a planter, a vase, furniture) is still unrequested_change.',
    );
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'unrequested_change (any change to what belongs to the home or the scene: an object removed, replaced, moved or restyled, repainting, landscaping, added snow or a season change, a changed sky, vehicles or bins changed, or any addition that is not a decoration)',
    );
    expect(JUDGE_SYSTEM_PROMPT).not.toContain('clearly the wrong count');
    const prompt = judgeUserPrompt(plan);
    expect(prompt).toContain('Requested decorations: Christmas, classic style.');
    expect(
      judgeUserPrompt({ ...plan, holidayId: 'new_years_eve', style: 'abundant' } as DecorationPlan),
    ).toContain("Requested decorations: New Year's Eve, abundant style.");
  });

  it('names a change inside the kept decorations as one to inspect', () => {
    const prompt = judgeUserPrompt(plan, [
      'unrequested change inside the kept decorations: door repainted red (in the center of the image)',
    ]);
    expect(prompt).toContain(
      'a change described as inside the kept decorations is still in image 2: inspect it and report unrequested_change or structure_changed if it changed what belongs to the home',
    );
  });

  it('relight mode always asks for the evening light, whatever the plan carries', () => {
    const prompt = judgeUserPrompt({ ...plan, lightingMode: 'source' }, [], { mode: 'relight' });
    expect(prompt).toContain('Requested light: early evening at dusk');
    expect(prompt).not.toContain('Requested light: source');
    expect(prompt).not.toContain('Requested decorations:');
  });

  it('relight mode lists the decorations that must stay and asks only about light', () => {
    const prompt = judgeUserPrompt({ ...plan, lightingMode: 'evening' }, [], { mode: 'relight' });
    expect(prompt).toContain(
      'Decorations in image 1 (each must still be there, unchanged, wherever it is in image 1):',
    );
    expect(prompt).toContain('- p1: 1 x 24-inch fresh fir wreath.');
    expect(prompt).not.toContain('Planned placements');
    expect(prompt).toContain('Protected spots to inspect:');
    expect(JUDGE_RELIGHT_SYSTEM_PROMPT).toContain(
      'structure_changed (anything other than light changed',
    );
    expect(JUDGE_RELIGHT_SYSTEM_PROMPT).toContain('Major: lighting_implausible');
  });

  it('keeps the fixture judge passing in relight mode', async () => {
    const vision = createFixtureVisionModel();
    const image = { bytes: new Uint8Array([1]), width: 1024, height: 1024 };
    const call = await vision.judge({
      renderAttemptId: 'attempt-2',
      original: image,
      base: image,
      candidate: image,
      plan: { ...plan, lightingMode: 'evening' },
      mode: 'relight',
    });
    expect(call.result.critical).toEqual([]);
    expect(call.result.major).toEqual([]);
  });
});
