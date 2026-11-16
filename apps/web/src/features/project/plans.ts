import {
  PROVIDER_UNAVAILABLE_FAILURE_KINDS,
  type ClientSkipReason,
  type RenderStatus,
} from '@hailiday/core';
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

export type RenderErrorAction = 'try_again' | 'another_photo' | 'another_view';

export interface RenderErrorPlan {
  messageKey: CopyKey;
  actions: RenderErrorAction[];
}

/** Whether a look is made in two passes, the second setting its light (evening or bright). */
export function isRelitLook(render: Pick<RenderStatus, 'lightingMode'>): boolean {
  return render.lightingMode === 'evening' || render.lightingMode === 'bright';
}

/**
 * Whether a look that ended with nothing to show may arrive on a second try: a rejection by the
 * quality checks or a reviewer, or a failure of the decorating service (provider error, timeout,
 * unknown outcome, internal error). A refused photo, a place without a usable photo, a policy
 * refusal and an expired job are not.
 */
export function secondPassMayCure(render: RenderStatus): boolean {
  if (render.state === 'rejected') return true;
  if (render.state !== 'failed') return false;
  return (
    render.failureKind === null || PROVIDER_UNAVAILABLE_FAILURE_KINDS.includes(render.failureKind)
  );
}

/**
 * The notice and actions for a look that ended with nothing to show, per the render errors table:
 * a look that could simply not be finished says so calmly and offers it again; a photo that cannot
 * be decorated says why and offers another view or photo.
 */
export function renderErrorPlan(render: RenderStatus, streetViewSource: boolean): RenderErrorPlan {
  if (render.state !== 'failed') {
    return { messageKey: 'result.lookUnfinished', actions: ['try_again', 'another_photo'] };
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
      // A street photo whose home is not clearly in frame says so; an uploaded photo is told
      // that nothing decoratable was found in it.
      const messageKey: CopyKey =
        render.failureDetail === 'house_number_mismatch'
          ? 'wait.wrongHouse'
          : render.failureDetail === 'facade_not_in_frame' && streetViewSource
            ? 'wait.noClearView'
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
      return { messageKey: 'result.lookUnfinished', actions: ['try_again', 'another_photo'] };
  }
}
