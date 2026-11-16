import { describe, expect, it } from 'vitest';
import { DecorationPlanSchema, JudgeResultSchema, type DecorationPlan } from '@hailiday/core';
import { createFixtureVisionModel } from './fixture.js';
import {
  ACCESS_EDGE_RULE,
  ANALYSIS_PROMPT_VERSION,
  analysisUserPrompt,
  ENHANCE_ATTRIBUTION_CODE,
  FRAME_PROMPT_VERSION,
  FRAME_SYSTEM_PROMPT,
  JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT,
  JUDGE_ENHANCE_SYSTEM_PROMPT,
  JUDGE_PROMPT_VERSION,
  JUDGE_RELIGHT_SYSTEM_PROMPT,
  JUDGE_SYSTEM_PROMPT,
  judgeEnhanceUserPrompt,
  judgeSystemPrompt,
  judgeUserPrompt,
  openTextMarkHint,
  OUTDOOR_EXISTING_DECOR_SPOT,
  OUTDOOR_SWAPS,
  protectedSpotLines,
  relightJudgeTarget,
  STREET_VIEW_NO_TARGET,
  STREET_VIEW_TARGET_HOME,
  STREET_VIEW_TARGET_UNCLEAR,
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

/** The decorate judge's instruction for a house number, sign or logo. */
const TEXT_MARK =
  'its text must stay exactly as in image 1, and readable wherever it is readable there; a decoration beside or around it and the light or shadow the decorations cast on it are expected; report text_added if readable text is altered, replaced, covered or missing; a mark too small to read in image 1 may be covered by a decoration';

describe('judge prompt', () => {
  it('lists every protected spot with its kind, position and the code to report', () => {
    const prompt = judgeUserPrompt(plan);
    expect(prompt).toContain('Protected spots to inspect:');
    for (const line of [
      '- a person (lower left of the image): must stay unchanged; report people_altered if not.',
      '- a blurred face (middle left of the image): must stay blurred and unchanged; report privacy_regression if it is clearer or reconstructed.',
      '- a blurred license plate (lower right of the image): must stay blurred and unchanged; report privacy_regression if it is clearer or reconstructed.',
      `- a house number (middle center of the image): ${TEXT_MARK}.`,
      `- a sign (middle left of the image): ${TEXT_MARK}.`,
      `- a logo or burned-in mark (lower left of the image): ${TEXT_MARK}.`,
      '- an existing decoration (middle right of the image): if it is such an item (one of the removable seasonal items named above), a decoration of the requested holiday may take its place and that swap is expected; otherwise it must stay unchanged; report unrequested_change if it is gone with no decoration in its place, or changed in any other way.',
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

  it('counts a decoration at the edge of steps as blocking only when the way is not clear', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain(ACCESS_EDGE_RULE);
    expect(ACCESS_EDGE_RULE).toContain(
      'is access_blocked only when it leaves less than about two thirds of the width clear or stands in the walking line or in front of a door',
    );
    // The relight judges compare light only: the rule is not theirs.
    expect(judgeSystemPrompt('relight', 'evening')).not.toContain(ACCESS_EDGE_RULE);
    expect(judgeSystemPrompt('relight', 'bright')).not.toContain(ACCESS_EDGE_RULE);
  });

  it('lets a decoration take the place of a removable item outside a house, and nowhere else', () => {
    const outdoors = judgeUserPrompt(plan);
    expect(plan.sceneType).toBe('house_exterior');
    expect(outdoors).toContain(OUTDOOR_SWAPS);
    expect(OUTDOOR_SWAPS).toContain(
      'an existing wreath or door hanger, a potted plant, flower pot, planter or urn, a hanging basket, a seasonal flag or a doormat',
    );
    expect(OUTDOOR_SWAPS).toContain(
      'Furniture, fixtures, mailboxes, anything built, vehicles, bins and plants growing in the ground are still unrequested_change',
    );
    expect(OUTDOOR_SWAPS).toContain('taken away with no decoration in its place');
    // An existing decoration may be swapped only when it is one of those removable items.
    expect(OUTDOOR_EXISTING_DECOR_SPOT.startsWith('if it is such an item')).toBe(true);
    expect(outdoors).toContain(
      `- an existing decoration (middle right of the image): ${OUTDOOR_EXISTING_DECOR_SPOT}.`,
    );
    expect(outdoors.indexOf(OUTDOOR_SWAPS)).toBeLessThan(
      outdoors.indexOf(OUTDOOR_EXISTING_DECOR_SPOT),
    );
    const kept =
      '- an existing decoration (middle right of the image): must stay unchanged; report unrequested_change if not.';
    for (const sceneType of ['interior', 'apartment_entry', 'balcony'] as const) {
      const indoors = judgeUserPrompt({ ...plan, sceneType } as DecorationPlan);
      expect(indoors, sceneType).not.toContain(OUTDOOR_SWAPS);
      expect(indoors, sceneType).toContain(kept);
    }
    // A relight changes the light only: nothing may be swapped there, outdoors included.
    const relit = judgeUserPrompt(plan, [], { mode: 'relight' });
    expect(relit).not.toContain(OUTDOOR_SWAPS);
    expect(relit).toContain(kept);
    expect(protectedSpotLines(plan.preserve)).toContain(kept);
    expect(protectedSpotLines(plan.preserve, 'relight', { outdoorSwaps: true })).toContain(kept);
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
    expect(JUDGE_PROMPT_VERSION).toBe('judge-2026.11.10');
    const vision = createFixtureVisionModel();
    const image = { bytes: new Uint8Array([1]), width: 1024, height: 1024 };
    const call = await vision.judge({
      renderAttemptId: 'attempt-1',
      original: image,
      candidate: image,
      plan,
    });
    const parsed = JudgeResultSchema.parse(call.result);
    expect(parsed.judgePromptVersion).toBe('judge-2026.11.10');
    expect(call.promptVersion).toBe('judge-2026.11.10');
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
      'A decoration that replaces or covers up an object of the home (an urn, a planter, a vase, furniture) is still unrequested_change, unless the instructions for this photo allow that swap.',
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

  it('relight mode asks for the evening light unless the plan is a bright relight', () => {
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

  it('relight mode for the bright look expects brighter light and refuses any other change', () => {
    const prompt = judgeUserPrompt({ ...plan, lightingMode: 'bright' }, [], { mode: 'relight' });
    expect(prompt).toContain('Requested light: the bright look, bright, airy and cheerful');
    expect(prompt).toContain(
      'Brighter light, lamps and fixtures switched on, daylight in the windows (the view outside a window may turn from night to day) and lifted shadows are expected and are not changes to report.',
    );
    expect(prompt).not.toContain('early evening');
    expect(prompt).toContain('- p1: 1 x 24-inch fresh fir wreath.');
    expect(judgeSystemPrompt('relight', 'bright')).toBe(JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT);
    expect(judgeSystemPrompt('relight', 'evening')).toBe(JUDGE_RELIGHT_SYSTEM_PROMPT);
    expect(judgeSystemPrompt('relight')).toBe(JUDGE_RELIGHT_SYSTEM_PROMPT);
    expect(judgeSystemPrompt('decorate', 'bright')).toBe(JUDGE_SYSTEM_PROMPT);
    expect(relightJudgeTarget({ lightingMode: 'bright' })).toBe('bright');
    expect(relightJudgeTarget({ lightingMode: 'evening' })).toBe('evening');
    const system = JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT;
    expect(system).toContain('the view outside a window may turn from night to day');
    expect(system).toContain('lifted shadows');
    expect(system).toContain(
      'structure_changed (anything other than light changed: any object, decoration, piece of furniture, door, wall, floor, fixture, window or architectural detail added, removed, moved, replaced or restyled',
    );
    expect(system).toContain('camera_changed (framing, crop, lens or perspective shifted)');
    expect(system).toContain(
      'Major: lighting_implausible (blown-out highlights, haze, a flat or painted look',
    );
    expect(system).not.toContain('dusk');
  });

  it('in relight mode expects the attribution ground to follow the light, never its strokes', () => {
    const relit =
      "the map provider's logo and copyright text here must stay exactly as in image 1 (same letters, shape and position, still bright and legible); the ground behind them follows the new light, which is expected; report attribution_altered only if the logo or the text is missing, illegible, covered, cropped, moved or redrawn.";
    const code =
      "attribution_altered (the map provider's logo or copyright text at a listed attribution spot missing, illegible, covered, cropped, moved or redrawn; the background behind it following the new light is expected; a faint, semi-transparent watermark of the provider elsewhere in the picture, for example in the sky, is not attribution: a relight repaints it and its loss is never reported)";
    for (const lightingMode of ['evening', 'bright'] as const) {
      const prompt = judgeUserPrompt({ ...plan, lightingMode }, [], { mode: 'relight' });
      expect(prompt).toContain(
        `- the burned-in imagery attribution (lower left of the image): ${relit}`,
      );
      expect(prompt).toContain(
        `- the burned-in imagery attribution (lower right of the image): ${relit}`,
      );
      expect(prompt).not.toContain(
        'report attribution_altered if it is covered, cropped or changed',
      );
    }
    expect(JUDGE_RELIGHT_SYSTEM_PROMPT).toContain(code);
    expect(JUDGE_BRIGHT_RELIGHT_SYSTEM_PROMPT).toContain(code);
    expect(JUDGE_RELIGHT_SYSTEM_PROMPT).not.toContain(
      'burned-in attribution cropped, covered or altered',
    );
    // Decorate mode keeps the strict rule.
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'attribution_altered (burned-in attribution cropped, covered or altered)',
    );
    expect(JUDGE_SYSTEM_PROMPT).not.toContain('following the new light');
    // A relight repaints a faint watermark elsewhere in the picture; decorate mode pastes it back.
    expect(JUDGE_RELIGHT_SYSTEM_PROMPT).toContain('its loss is never reported');
    expect(JUDGE_SYSTEM_PROMPT).not.toContain('watermark');
    const decorate = judgeUserPrompt({ ...plan, lightingMode: 'evening' });
    expect(decorate).toContain(
      '- the burned-in imagery attribution (lower left of the image): must stay exactly as in the original; report attribution_altered if it is covered, cropped or changed.',
    );
    expect(decorate).not.toContain("the map provider's logo");
    // The fixture's logo region lies inside the lower-left attribution rectangle, so in relight
    // mode the attribution line is the only line for that spot.
    expect(protectedSpotLines(plan.preserve, 'relight')).toHaveLength(10);
  });

  it('leaves a logo or sign inside an attribution rectangle to the attribution line in relight mode', () => {
    const lowerLeft: [number, number, number, number] = [0, 0.95, 0.12, 1];
    const preserve = {
      ...plan.preserve,
      regions: [
        { kind: 'logo' as const, box: lowerLeft },
        {
          kind: 'sign' as const,
          box: [0.8, 0.965, 0.95, 0.995] as [number, number, number, number],
        },
        // Less than half of this logo lies inside the lower-left rectangle.
        { kind: 'logo' as const, box: [0.1, 0.9, 0.2, 0.98] as [number, number, number, number] },
        { kind: 'house_number' as const, box: lowerLeft },
      ],
    };
    const relight = protectedSpotLines(preserve, 'relight');
    const relit =
      "the map provider's logo and copyright text here must stay exactly as in image 1 (same letters, shape and position, still bright and legible); the ground behind them follows the new light, which is expected; report attribution_altered only if the logo or the text is missing, illegible, covered, cropped, moved or redrawn.";
    expect(relight).toContain(
      `- the burned-in imagery attribution (lower left of the image): ${relit}`,
    );
    expect(relight).toContain(
      `- the burned-in imagery attribution (lower right of the image): ${relit}`,
    );
    expect(relight.filter((line) => line.startsWith('- a logo or burned-in mark'))).toEqual([
      '- a logo or burned-in mark (lower left of the image): must stay unchanged; report text_added if not.',
    ]);
    expect(relight.filter((line) => line.startsWith('- a sign'))).toEqual([]);
    // A house number keeps its own line wherever it is.
    expect(relight).toContain(
      '- a house number (lower left of the image): must stay unchanged; report text_added if not.',
    );
    expect(relight.join('\n')).not.toContain('(lower right of the image): must stay unchanged');

    const decorate = protectedSpotLines(preserve);
    expect(decorate.filter((line) => line.startsWith('- a logo or burned-in mark'))).toHaveLength(
      2,
    );
    expect(decorate).toContain(
      `- a logo or burned-in mark (lower left of the image): ${TEXT_MARK}.`,
    );
    expect(decorate).toContain(`- a sign (lower right of the image): ${TEXT_MARK}.`);
  });

  it('guards the text of house numbers, signs and logos in decorate mode, and their pixels in a relight', () => {
    const decorate = protectedSpotLines(plan.preserve);
    const relight = protectedSpotLines(plan.preserve, 'relight');
    for (const [words, where] of [
      ['a house number', 'middle center'],
      ['a sign', 'middle left'],
    ] as const) {
      expect(decorate).toContain(`- ${words} (${where} of the image): ${TEXT_MARK}.`);
      expect(relight).toContain(
        `- ${words} (${where} of the image): must stay unchanged; report text_added if not.`,
      );
      expect(relight.join('\n')).not.toContain(`- ${words} (${where} of the image): its text`);
    }
    // The fixture's logo lies inside an attribution rectangle: its own line is a decorate-mode
    // line only.
    expect(decorate).toContain(
      `- a logo or burned-in mark (lower left of the image): ${TEXT_MARK}.`,
    );
    expect(relight.join('\n')).not.toContain('- a logo or burned-in mark');
    // The other kinds keep the same wording in both modes.
    for (const line of [
      '- an existing decoration (middle right of the image): must stay unchanged; report unrequested_change if not.',
      '- a vehicle (lower right of the image): must stay unchanged; report unrequested_change if not.',
    ]) {
      expect(decorate).toContain(line);
      expect(relight).toContain(line);
    }
    expect(judgeUserPrompt(plan, [], { mode: 'relight' })).not.toContain(TEXT_MARK);
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

describe('open text mark hint', () => {
  it('names the kind and position of a mark that keeps the edited pixels, never its text', () => {
    expect(openTextMarkHint('house_number', [0.1, 0.5, 0.11, 0.55])).toBe(
      'a house number (middle left of the image) keeps the edited pixels: compare its text with image 1',
    );
    expect(openTextMarkHint('sign', [0.7, 0.1, 0.8, 0.2])).toBe(
      'a sign (upper right of the image) keeps the edited pixels: compare its text with image 1',
    );
    expect(openTextMarkHint('logo', [0.1, 0.8, 0.2, 0.9])).toBe(
      'a logo or burned-in mark (lower left of the image) keeps the edited pixels: compare its text with image 1',
    );
    expect(JUDGE_PROMPT_VERSION).toBe('judge-2026.11.10');
  });
});

describe('enhance judge prompt', () => {
  const RESTORED = "shows image 1's own pixels again";
  const ATTRIBUTION =
    "the map provider's logo and copyright text here must stay exactly as in image 1 (same letters, shape and position, still bright and legible); the ground behind them follows the new tone, which is expected; report attribution_altered only if the logo or the text is missing, illegible, covered, cropped, moved or redrawn.";

  it('names the critical and major codes it uses and lets faint watermarks go', () => {
    const critical = [
      'structure_changed',
      'wrong_property',
      'camera_changed',
      'privacy_regression',
      'people_altered',
      'text_added',
      'unsafe_or_offensive',
      'attribution_altered',
    ];
    const [criticalLine, majorLine] = JUDGE_ENHANCE_SYSTEM_PROMPT.split('\n').filter(
      (line) => line.startsWith('Report failures') || line.startsWith('Major:'),
    );
    for (const code of critical) expect(criticalLine).toContain(code);
    for (const code of ['unrequested_change', 'lighting_implausible']) {
      expect(majorLine).toContain(code);
    }
    for (const code of ['neighbor_decorated', 'access_blocked', 'plan_not_followed']) {
      expect(JUDGE_ENHANCE_SYSTEM_PROMPT).not.toContain(code);
    }
    expect(JUDGE_ENHANCE_SYSTEM_PROMPT).toContain(ENHANCE_ATTRIBUTION_CODE);
    expect(ENHANCE_ATTRIBUTION_CODE).toContain(
      'an enhancement repaints it and its loss is never reported',
    );
    expect(JUDGE_ENHANCE_SYSTEM_PROMPT).toContain('Judge things, not pixels.');
    expect(JUDGE_ENHANCE_SYSTEM_PROMPT).toContain('Return an empty placements list.');
    expect(JUDGE_ENHANCE_SYSTEM_PROMPT.split('\n').at(-1)).toMatch(/^Boxes are \[x0, y0, x1, y1\]/);
  });

  it('lists one line per protected spot with the code to report', () => {
    const prompt = judgeEnhanceUserPrompt({ sceneType: 'house_exterior', preserve: plan.preserve });
    const lines = prompt.split('\n');
    expect(lines[0]).toBe(
      'Scene type: house_exterior. Requested change: image quality only. Image 2 must show the same place at the same moment as image 1: sharper, cleaner and better exposed, with nothing else different.',
    );
    expect(lines[1]).toBe('Protected spots to inspect:');
    expect(lines.slice(2, -1)).toEqual([
      `- a person (lower left of the image): ${RESTORED}; report people_altered if the person is changed, removed or redrawn.`,
      `- a blurred face (middle left of the image): ${RESTORED}; report privacy_regression if it is clearer or reconstructed.`,
      `- a blurred license plate (lower right of the image): ${RESTORED}; report privacy_regression if it is clearer or reconstructed.`,
      `- a house number (middle center of the image): ${RESTORED}; report text_added if it reads differently than in image 1.`,
      `- a sign (middle left of the image): ${RESTORED}; report text_added if it reads differently than in image 1.`,
      '- an existing decoration (middle right of the image): must stay the same thing in the same place; report structure_changed if not.',
      '- a vehicle (lower right of the image): must stay the same thing in the same place; report structure_changed if not.',
      `- the burned-in imagery attribution (lower left of the image): ${ATTRIBUTION}`,
      `- the burned-in imagery attribution (lower right of the image): ${ATTRIBUTION}`,
    ]);
    // The fixture's logo lies inside the lower-left attribution rectangle: the attribution line
    // governs it. Access regions and `other` regions get no line.
    expect(prompt).not.toContain('a logo or burned-in mark');
    expect(prompt).not.toContain('walkway');
    expect(lines.at(-1)).toBe(
      "Spots that show image 1's own pixels again look softer than their surroundings; that is expected and is not a failure.",
    );
    const logoOutside = judgeEnhanceUserPrompt({
      sceneType: 'house_exterior',
      preserve: { ...plan.preserve, regions: [{ kind: 'logo', box: [0.4, 0.1, 0.5, 0.2] }] },
    });
    expect(logoOutside).toContain(
      `- a logo or burned-in mark (upper center of the image): ${RESTORED}; report text_added if it reads differently than in image 1.`,
    );
  });

  it('has no spots block without spots, and never carries address or user text', () => {
    const bare = judgeEnhanceUserPrompt({
      sceneType: 'house_exterior',
      preserve: { regions: [], protectedBlurRegions: [], peopleBoxes: [] },
    });
    expect(bare.split('\n')).toHaveLength(1);
    expect(bare).not.toContain('Protected spots');
    expect(bare).not.toContain('softer than their surroundings');
    const prompt = judgeEnhanceUserPrompt({ sceneType: 'house_exterior', preserve: plan.preserve });
    for (const token of ['Lantern Hill', 'Apt 4B', '02134', 'Margaret', 'Street', 'Avenue']) {
      expect(prompt).not.toContain(token);
    }
  });

  it('keeps the fixture judge passing an enhancement', async () => {
    const vision = createFixtureVisionModel();
    const image = { bytes: new Uint8Array([1]), width: 1024, height: 1024 };
    const call = await vision.judgeEnhancement({
      enhancementId: '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e',
      original: image,
      candidate: image,
      sceneType: 'house_exterior',
      preserve: plan.preserve,
    });
    const parsed = JudgeResultSchema.parse(call.result);
    expect(parsed.renderAttemptId).toBe('0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e');
    expect(parsed.critical).toEqual([]);
    expect(parsed.major).toEqual([]);
    expect(parsed.placements).toEqual([]);
    expect(parsed.escalated).toBe(false);
    expect(parsed.scores).toEqual({ realism: 4, appeal: 4, planAdherence: 5 });
    expect(parsed.judgePromptVersion).toBe('judge-2026.11.10');
    expect(call.providerMode).toBe('fixture');
  });
});

describe('the frame prompt', () => {
  it('finds the home by the same rule as the Street View analysis, which is unchanged', () => {
    const analysis = analysisUserPrompt({ sceneType: 'house_exterior', sourceKind: 'street_view' });
    expect(analysis.split('\n').at(-1)).toBe(
      'Target facade: the home this frame is aimed at. It is the residential facade containing the horizontal center of the frame at mid-height. When the center falls beside a home instead (on its driveway, yard, fence, garage or the gap next to it), the target is the residential facade nearest to the center, as long as that facade is clearly the main building in the frame. Omit targetFacade and set targetFacadeAmbiguous to true only when no residential facade is in frame, when the center falls on the boundary between two attached or closely neighboring facades, or when two facades are about equally near the center and about equally prominent. For attached houses the target spans only the unit nearest the center.',
    );
    expect(ANALYSIS_PROMPT_VERSION).toBe('analysis-2026.11.2');
    for (const rule of [
      STREET_VIEW_TARGET_HOME,
      STREET_VIEW_NO_TARGET,
      STREET_VIEW_TARGET_UNCLEAR,
    ]) {
      expect(analysis).toContain(rule);
      expect(FRAME_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it('boxes the whole building of the home and nothing around it', () => {
    expect(FRAME_PROMPT_VERSION).toBe('frame-2026.11.0');
    for (const phrase of [
      'top of its roof (chimney included)',
      'where the building meets the ground',
      'porch',
      'attached garage',
      'Leave out the lawn, driveway',
      'trees',
      'fences',
      'every neighboring building',
    ]) {
      expect(FRAME_SYSTEM_PROMPT).toContain(phrase);
    }
  });
});
