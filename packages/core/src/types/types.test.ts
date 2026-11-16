import { describe, expect, it } from 'vitest';
import {
  ANCHOR_CATEGORIES,
  CRITICAL_FAILURE_CODES,
  CapabilityKeySchema,
  MAJOR_FAILURE_CODES,
  NON_TERMINAL_RENDER_JOB_STATES,
  RENDER_JOB_STATES,
  RENDER_JOB_TRANSITIONS,
  SKIP_REASONS,
  TERMINAL_RENDER_JOB_STATES,
  anchorCategoriesForSceneType,
  byteBucket,
  canTransitionRenderJob,
  canTransitionSourceAsset,
  commerceCapabilityKey,
  comparePackVersions,
  distanceBucket,
  fidelityModeFor,
  isRelightLightingMode,
  LIGHTING_MODES,
  RELIGHT_LIGHTING_MODES,
  firstSkipReason,
  isCapabilityKey,
  isRepairableFailureCode,
  isTerminalRenderJobState,
  merchantProgramIdFromCapability,
  packMajorMinor,
  parseVariantKey,
  projectSkipReason,
  STAGE_LABEL_KEYS,
  stageLabelKeyFor,
  stageLabelKeyOf,
  variantKey,
} from './index.js';

describe('variantKey', () => {
  const input = {
    sourceAssetId: '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e',
    holidayId: 'christmas',
    style: 'classic',
    lightingMode: 'source',
    holidayPackVersion: '1.2.3',
    compilerVersion: '3',
  } as const;

  it('joins the six parts with the pack version reduced to MAJOR.MINOR', () => {
    expect(variantKey(input)).toBe(
      '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e|christmas|classic|source|1.2|3',
    );
  });

  it('ignores PATCH and changes with MAJOR.MINOR', () => {
    expect(variantKey({ ...input, holidayPackVersion: '1.2.9' })).toBe(variantKey(input));
    expect(variantKey({ ...input, holidayPackVersion: '1.3.0' })).not.toBe(variantKey(input));
    expect(variantKey({ ...input, holidayPackVersion: '2.2.3' })).not.toBe(variantKey(input));
  });

  it('changes with every other component', () => {
    const base = variantKey(input);
    expect(variantKey({ ...input, sourceAssetId: 'other' })).not.toBe(base);
    expect(variantKey({ ...input, holidayId: 'halloween' })).not.toBe(base);
    expect(variantKey({ ...input, style: 'subtle' })).not.toBe(base);
    expect(variantKey({ ...input, lightingMode: 'evening' })).not.toBe(base);
    expect(variantKey({ ...input, lightingMode: 'bright' })).not.toBe(base);
    expect(variantKey({ ...input, lightingMode: 'bright' })).not.toBe(
      variantKey({ ...input, lightingMode: 'evening' }),
    );
    expect(variantKey({ ...input, compilerVersion: '4' })).not.toBe(base);
  });

  it('accepts an already reduced MAJOR.MINOR', () => {
    expect(variantKey({ ...input, holidayPackVersion: '1.2' })).toBe(variantKey(input));
  });

  it('rejects malformed versions and separators', () => {
    expect(() => variantKey({ ...input, holidayPackVersion: '1' })).toThrow(RangeError);
    expect(() => variantKey({ ...input, holidayPackVersion: '01.2.3' })).toThrow(RangeError);
    expect(() => variantKey({ ...input, compilerVersion: 'a|b' })).toThrow(RangeError);
    expect(() => variantKey({ ...input, sourceAssetId: '' })).toThrow(RangeError);
    expect(() => variantKey({ ...input, holidayId: 'easter' as 'christmas' })).toThrow();
  });

  it('round-trips through parseVariantKey', () => {
    expect(parseVariantKey(variantKey(input))).toEqual({
      sourceAssetId: input.sourceAssetId,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
      packMajorMinor: '1.2',
      compilerVersion: '3',
    });
    expect(parseVariantKey('a|b|c')).toBeNull();
    expect(parseVariantKey('a|easter|classic|source|1.2|3')).toBeNull();
  });

  it('reduces and compares pack versions', () => {
    expect(packMajorMinor('10.20.30')).toBe('10.20');
    expect(comparePackVersions('1.10.0', '1.9.9')).toBe(1);
    expect(comparePackVersions('1.0.0', '1.0.0')).toBe(0);
    expect(comparePackVersions('0.9.0', '1.0.0')).toBe(-1);
  });
});

describe('render job states', () => {
  it('splits seven non-terminal and six terminal states', () => {
    expect(NON_TERMINAL_RENDER_JOB_STATES).toHaveLength(7);
    expect(TERMINAL_RENDER_JOB_STATES).toHaveLength(6);
    expect(RENDER_JOB_STATES).toHaveLength(13);
    for (const state of TERMINAL_RENDER_JOB_STATES) {
      expect(isTerminalRenderJobState(state)).toBe(true);
      expect(RENDER_JOB_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('maps states to stage label keys', () => {
    expect(stageLabelKeyFor('queued')).toBe('stage.preparing');
    expect(stageLabelKeyFor('preparing')).toBe('stage.preparing');
    expect(stageLabelKeyFor('analyzing')).toBe('stage.planning');
    expect(stageLabelKeyFor('planning')).toBe('stage.planning');
    expect(stageLabelKeyFor('rendering')).toBe('stage.rendering');
    expect(stageLabelKeyFor('checking')).toBe('stage.checking');
    expect(stageLabelKeyFor('needs_review')).toBe('stage.review');
    for (const state of TERMINAL_RENDER_JOB_STATES) expect(stageLabelKeyFor(state)).toBeNull();
  });

  it('lists the nine stage label keys in the order a job shows them', () => {
    expect(STAGE_LABEL_KEYS).toEqual([
      'stage.preparing',
      'stage.framing',
      'stage.enhancing',
      'stage.planning',
      'stage.rendering',
      'stage.checking',
      'stage.eveningLight',
      'stage.brightLight',
      'stage.review',
    ]);
  });

  it('maps a job with its sub-stage and lighting mode to a stage label key', () => {
    for (const state of NON_TERMINAL_RENDER_JOB_STATES) {
      expect(stageLabelKeyOf({ state })).toBe(stageLabelKeyFor(state));
      expect(stageLabelKeyOf({ state, subStage: null, lightingMode: 'evening' })).toBe(
        stageLabelKeyFor(state),
      );
    }
    expect(stageLabelKeyOf({ state: 'analyzing', subStage: 'enhancing' })).toBe('stage.enhancing');
    expect(stageLabelKeyOf({ state: 'preparing', subStage: 'framing' })).toBe('stage.framing');
    for (const state of ['queued', 'analyzing', 'planning', 'rendering', 'checking'] as const) {
      expect(stageLabelKeyOf({ state, subStage: 'framing' })).toBe(stageLabelKeyFor(state));
    }
    for (const state of ['planning', 'rendering'] as const) {
      expect(stageLabelKeyOf({ state, subStage: 'relight', lightingMode: 'evening' })).toBe(
        'stage.eveningLight',
      );
      expect(stageLabelKeyOf({ state, subStage: 'relight', lightingMode: 'bright' })).toBe(
        'stage.brightLight',
      );
      expect(stageLabelKeyOf({ state, subStage: 'relight', lightingMode: 'source' })).toBe(
        stageLabelKeyFor(state),
      );
      expect(stageLabelKeyOf({ state, subStage: 'enhancing' })).toBe(stageLabelKeyFor(state));
    }
    expect(
      stageLabelKeyOf({ state: 'checking', subStage: 'relight', lightingMode: 'evening' }),
    ).toBe('stage.checking');
    expect(
      stageLabelKeyOf({ state: 'analyzing', subStage: 'relight', lightingMode: 'evening' }),
    ).toBe('stage.planning');
    expect(stageLabelKeyOf({ state: 'preparing', subStage: 'enhancing' })).toBe('stage.preparing');
    for (const state of TERMINAL_RENDER_JOB_STATES) {
      expect(stageLabelKeyOf({ state, subStage: 'enhancing', lightingMode: 'evening' })).toBeNull();
      expect(stageLabelKeyOf({ state, subStage: 'framing' })).toBeNull();
    }
  });

  it('allows the normative transitions only', () => {
    expect(canTransitionRenderJob('queued', 'preparing')).toBe(true);
    expect(canTransitionRenderJob('checking', 'planning')).toBe(true);
    expect(canTransitionRenderJob('checking', 'needs_review')).toBe(true);
    expect(canTransitionRenderJob('needs_review', 'succeeded')).toBe(true);
    expect(canTransitionRenderJob('planning', 'failed')).toBe(true);
    expect(canTransitionRenderJob('queued', 'succeeded')).toBe(false);
    expect(canTransitionRenderJob('needs_review', 'planning')).toBe(false);
    expect(canTransitionRenderJob('succeeded', 'canceled')).toBe(false);
    for (const state of NON_TERMINAL_RENDER_JOB_STATES) {
      for (const exit of ['canceled', 'superseded', 'expired', 'failed'] as const) {
        expect(canTransitionRenderJob(state, exit)).toBe(true);
      }
    }
  });

  it('tracks source asset transitions', () => {
    expect(canTransitionSourceAsset('pending_upload', 'quarantined')).toBe(true);
    expect(canTransitionSourceAsset('screening', 'ready')).toBe(true);
    expect(canTransitionSourceAsset('ready', 'stale')).toBe(true);
    expect(canTransitionSourceAsset('declined', 'ready')).toBe(false);
  });
});

describe('failure codes', () => {
  it('has ten critical codes including attribution_altered and four majors', () => {
    expect(CRITICAL_FAILURE_CODES).toHaveLength(10);
    expect(CRITICAL_FAILURE_CODES).toContain('attribution_altered');
    expect(MAJOR_FAILURE_CODES).toHaveLength(4);
  });

  it('marks wrong_property, unsafe_or_offensive and attribution_altered non-repairable', () => {
    expect(isRepairableFailureCode('wrong_property')).toBe(false);
    expect(isRepairableFailureCode('unsafe_or_offensive')).toBe(false);
    expect(isRepairableFailureCode('attribution_altered')).toBe(false);
    expect(isRepairableFailureCode('structure_changed')).toBe(true);
    expect(isRepairableFailureCode('lighting_implausible')).toBe(true);
  });

  it('derives fidelity mode from lighting mode', () => {
    expect(fidelityModeFor('source')).toBe('composite_additive');
    expect(fidelityModeFor('evening')).toBe('global_relight');
    expect(fidelityModeFor('bright')).toBe('global_relight');
  });

  it('relights the evening and bright modes, never the as-photographed one', () => {
    expect(LIGHTING_MODES).toEqual(['source', 'evening', 'bright']);
    expect(RELIGHT_LIGHTING_MODES).toEqual(['evening', 'bright']);
    expect(LIGHTING_MODES.filter((mode) => isRelightLightingMode(mode))).toEqual([
      'evening',
      'bright',
    ]);
  });
});

describe('discovery reasons', () => {
  it('projects blocked_address to unavailable for clients', () => {
    expect(projectSkipReason('blocked_address')).toBe('unavailable');
    expect(projectSkipReason('no_imagery')).toBe('no_imagery');
    expect(projectSkipReason(null)).toBeNull();
  });

  it('picks the first red reason by precedence', () => {
    expect(SKIP_REASONS[0]).toBe('out_of_scope');
    expect(firstSkipReason(['no_imagery', 'multi_unit', 'blocked_address'])).toBe(
      'blocked_address',
    );
    expect(firstSkipReason(['error', 'low_precision'])).toBe('low_precision');
    expect(firstSkipReason([])).toBeNull();
  });
});

describe('capability keys', () => {
  it('accepts base keys and commerce:<merchantProgramId>', () => {
    expect(CapabilityKeySchema.safeParse('street_view_ai').success).toBe(true);
    expect(CapabilityKeySchema.safeParse('commerce:amazon_associates_us').success).toBe(true);
    expect(
      CapabilityKeySchema.safeParse('commerce:0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e').success,
    ).toBe(true);
    expect(CapabilityKeySchema.safeParse('commerce:').success).toBe(false);
    expect(CapabilityKeySchema.safeParse('commerce:Amazon').success).toBe(false);
    expect(CapabilityKeySchema.safeParse('payments').success).toBe(false);
    expect(isCapabilityKey('sharing')).toBe(true);
    expect(commerceCapabilityKey('fixture_decor_us')).toBe('commerce:fixture_decor_us');
    expect(() => commerceCapabilityKey('Bad Id')).toThrow(RangeError);
    expect(merchantProgramIdFromCapability('commerce:fixture_decor_us')).toBe('fixture_decor_us');
    expect(merchantProgramIdFromCapability('uploads')).toBeNull();
  });
});

describe('anchors and buckets', () => {
  it('assigns every anchor category at least one scene type', () => {
    const covered = new Set(
      (['house_exterior', 'apartment_entry', 'balcony', 'interior'] as const).flatMap(
        anchorCategoriesForSceneType,
      ),
    );
    expect(covered.size).toBe(ANCHOR_CATEGORIES.length);
    expect(anchorCategoriesForSceneType('balcony')).toEqual([
      'door_frame',
      'planter',
      'balcony_railing',
      'balcony_floor',
      'wall',
    ]);
  });

  it('buckets distances and byte sizes', () => {
    expect(distanceBucket(18)).toBe('0_25m');
    expect(distanceBucket(40)).toBe('25_60m');
    expect(distanceBucket(61)).toBe('over_60m');
    expect(distanceBucket(null)).toBe('none');
    expect(byteBucket(500_000)).toBe('under_1mb');
    expect(byteBucket(2_457_600)).toBe('1_5mb');
    expect(byteBucket(26_214_400)).toBe('10_25mb');
    expect(byteBucket(30_000_000)).toBe('over_25mb');
  });
});
