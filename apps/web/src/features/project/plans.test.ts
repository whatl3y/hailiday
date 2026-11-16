import { describe, expect, it } from 'vitest';
import type { RenderStatus } from '@hailiday/core';
import { isRelitLook, noStreetViewReasonKey, renderErrorPlan, secondPassMayCure } from './plans';

function terminal(overrides: Partial<RenderStatus>): RenderStatus {
  return {
    state: 'failed',
    failureKind: null,
    failureDetail: null,
    lightingMode: 'source',
    ...overrides,
  } as RenderStatus;
}

describe('no Street View reasons', () => {
  it('never claims there is no imagery for blocked or out-of-scope addresses', () => {
    expect(noStreetViewReasonKey('unavailable')).toBe('nosv.unavailable');
    expect(noStreetViewReasonKey('out_of_scope')).toBe('nosv.unavailable');
    expect(noStreetViewReasonKey('no_imagery')).toBe('nosv.no_imagery');
    expect(noStreetViewReasonKey('multi_unit')).toBe('nosv.multi_unit');
  });
});

describe('render error plans', () => {
  it('says calmly that a look could not be finished and offers it again', () => {
    const unfinished = {
      messageKey: 'result.lookUnfinished',
      actions: ['try_again', 'another_photo'],
    };
    expect(renderErrorPlan(terminal({ failureKind: 'timeout' }), true)).toEqual(unfinished);
    expect(renderErrorPlan(terminal({ failureKind: 'provider_error' }), false)).toEqual(unfinished);
    expect(renderErrorPlan(terminal({ failureKind: null }), true)).toEqual(unfinished);
    expect(
      renderErrorPlan(terminal({ state: 'rejected', rejectionReason: 'qa_critical' }), true),
    ).toEqual(unfinished);
    expect(renderErrorPlan(terminal({ state: 'expired' }), true)).toEqual(unfinished);
  });

  it('never offers retry for nothing to decorate, and offers views only for Street View', () => {
    const failure = terminal({
      failureKind: 'source_rejected',
      failureDetail: 'no_usable_anchors',
    });
    expect(renderErrorPlan(failure, true)).toEqual({
      messageKey: 'wait.nothingToDecorate',
      actions: ['another_view', 'another_photo'],
    });
    expect(renderErrorPlan(failure, false).actions).toEqual(['another_photo']);
  });

  it('handles owner-blurred, wrong house, a street photo without a clear view and refusals', () => {
    expect(
      renderErrorPlan(
        terminal({ failureKind: 'source_rejected', failureDetail: 'owner_blurred' }),
        true,
      ),
    ).toEqual({ messageKey: 'wait.ownerBlurred', actions: ['another_photo'] });
    expect(
      renderErrorPlan(
        terminal({ failureKind: 'source_rejected', failureDetail: 'house_number_mismatch' }),
        true,
      ).messageKey,
    ).toBe('wait.wrongHouse');
    expect(
      renderErrorPlan(
        terminal({ failureKind: 'source_rejected', failureDetail: 'facade_not_in_frame' }),
        true,
      ),
    ).toEqual({ messageKey: 'wait.noClearView', actions: ['another_view', 'another_photo'] });
    expect(
      renderErrorPlan(
        terminal({ failureKind: 'source_rejected', failureDetail: 'facade_not_in_frame' }),
        false,
      ),
    ).toEqual({ messageKey: 'wait.nothingToDecorate', actions: ['another_photo'] });
    expect(renderErrorPlan(terminal({ failureKind: 'moderation_blocked' }), false)).toEqual({
      messageKey: 'wait.policyDeclined',
      actions: ['another_photo'],
    });
  });

  it('takes a second pass only where a second try may cure the reason', () => {
    expect(secondPassMayCure(terminal({ state: 'rejected', rejectionReason: 'qa_critical' }))).toBe(
      true,
    );
    expect(
      secondPassMayCure(terminal({ state: 'rejected', rejectionReason: 'qa_uncertain' })),
    ).toBe(true);
    for (const failureKind of [
      'provider_error',
      'timeout',
      'unknown_outcome',
      'internal_error',
    ] as const) {
      expect(secondPassMayCure(terminal({ failureKind })), failureKind).toBe(true);
    }
    for (const failureKind of [
      'source_rejected',
      'source_unavailable',
      'moderation_blocked',
      'policy_denied',
    ] as const) {
      expect(secondPassMayCure(terminal({ failureKind })), failureKind).toBe(false);
    }
    expect(secondPassMayCure(terminal({ state: 'expired' }))).toBe(false);
    expect(secondPassMayCure(terminal({ state: 'canceled' }))).toBe(false);
  });

  it('knows which looks set their light in a second pass', () => {
    expect(isRelitLook({ lightingMode: 'evening' })).toBe(true);
    expect(isRelitLook({ lightingMode: 'bright' })).toBe(true);
    expect(isRelitLook({ lightingMode: 'source' })).toBe(false);
  });

  it('offers no "Show it as photographed" after any look', () => {
    for (const lightingMode of ['evening', 'bright', 'source'] as const) {
      expect(renderErrorPlan(terminal({ state: 'rejected', lightingMode }), true).actions).toEqual([
        'try_again',
        'another_photo',
      ]);
    }
  });
});
