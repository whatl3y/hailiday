import type { ClientSkipReason, RenderStatus } from '@holiday/core';
import type { CopyKey } from '../../copy';

/** The honest reason line for each client-visible skip reason. */
export function noStreetViewReasonKey(reason: ClientSkipReason | null): CopyKey {
  switch (reason) {
    case 'no_imagery':
      return 'nosv.no_imagery';
    case 'multi_unit':
      return 'nosv.multi_unit';
    case 'low_precision':
      return 'nosv.low_precision';
    case 'error':
      return 'nosv.error';
    case 'unavailable':
    case 'out_of_scope':
    case null:
      return 'nosv.unavailable';
  }
}

export type RenderErrorAction =
  'try_again' | 'another_photo' | 'another_view' | 'show_as_photographed';

export interface RenderErrorPlan {
  messageKey: CopyKey;
  actions: RenderErrorAction[];
}

/** The copy and actions for a failed or rejected render, per the render errors table. */
export function renderErrorPlan(render: RenderStatus, streetViewSource: boolean): RenderErrorPlan {
  if (render.state === 'rejected') {
    return {
      messageKey: 'error.RENDER_REJECTED',
      actions: [
        'try_again',
        'another_photo',
        ...(render.lightingMode === 'evening' ? (['show_as_photographed'] as const) : []),
      ],
    };
  }
  switch (render.failureKind) {
    case 'source_unavailable':
      return streetViewSource
        ? { messageKey: 'wait.sourceUnavailable', actions: ['another_view'] }
        : { messageKey: 'wait.sourceUnavailableUpload', actions: ['another_photo'] };
    case 'source_rejected': {
      if (render.failureDetail === 'owner_blurred') {
        return { messageKey: 'wait.ownerBlurred', actions: ['another_photo'] };
      }
      const messageKey: CopyKey =
        render.failureDetail === 'house_number_mismatch'
          ? 'wait.wrongHouse'
          : 'wait.nothingToDecorate';
      return {
        messageKey,
        actions: streetViewSource ? ['another_view', 'another_photo'] : ['another_photo'],
      };
    }
    case 'moderation_blocked':
    case 'policy_denied':
      return { messageKey: 'wait.policyDeclined', actions: ['another_photo'] };
    default:
      return { messageKey: 'error.PROVIDER_UNAVAILABLE', actions: ['try_again', 'another_photo'] };
  }
}
