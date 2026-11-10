import { describe, expect, it } from 'vitest';
import type { RenderStatus } from '@holiday/core';
import { noStreetViewReasonKey, renderErrorPlan } from './plans';

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
  it('offers retry for provider failures', () => {
    expect(renderErrorPlan(terminal({ failureKind: 'timeout' }), true)).toEqual({
      messageKey: 'error.PROVIDER_UNAVAILABLE',
      actions: ['try_again', 'another_photo'],
    });
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

  it('handles owner-blurred, wrong house and refusals', () => {
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
    expect(renderErrorPlan(terminal({ failureKind: 'moderation_blocked' }), false)).toEqual({
      messageKey: 'wait.policyDeclined',
      actions: ['another_photo'],
    });
  });

  it('offers "Show it as photographed" after a rejected evening look', () => {
    expect(
      renderErrorPlan(terminal({ state: 'rejected', lightingMode: 'evening' }), true).actions,
    ).toEqual(['try_again', 'another_photo', 'show_as_photographed']);
  });
});
