import {
  DEFAULT_SCENE_TYPE_AUTO_ACCEPT,
  type SourceAssetState,
  type UploadStatus,
} from '@hailiday/core';
import type { CopyKey } from '../../copy';
import type { PrepareFailureReason } from './prepare';

export type { PresignedPost, UploadStatus } from '@hailiday/core';

/** States after which polling stops. */
export function isTerminalSourceUploadState(state: SourceAssetState): boolean {
  return (
    state === 'ready' ||
    state === 'declined' ||
    state === 'failed' ||
    state === 'expired' ||
    state === 'deleted'
  );
}

export type UploadOutcome =
  | { kind: 'screening' }
  | { kind: 'held' }
  | { kind: 'ready'; needsSceneChoice: boolean; peopleDetected: boolean }
  | { kind: 'declined'; messageKey: CopyKey; safety: boolean }
  | { kind: 'failed' };

/** Interprets an upload status for the screen. */
export function uploadOutcome(
  status: UploadStatus,
  autoAccept: number = DEFAULT_SCENE_TYPE_AUTO_ACCEPT,
): UploadOutcome {
  switch (status.state) {
    case 'pending_upload':
    case 'quarantined':
      return { kind: 'screening' };
    case 'screening':
      return status.holdForReview ? { kind: 'held' } : { kind: 'screening' };
    case 'ready':
      return {
        kind: 'ready',
        needsSceneChoice:
          status.sceneType === null || (status.sceneTypeConfidence ?? 0) < autoAccept,
        peopleDetected: status.people.detected,
      };
    case 'declined':
      return { kind: 'declined', ...declineMessage(status) };
    default:
      return { kind: 'failed' };
  }
}

/**
 * The decline line: guidance-class declines name their reason; safety-class declines get the
 * neutral line with no detail of which check declined the photo.
 */
export function declineMessage(
  status: Pick<UploadStatus, 'declineCode' | 'declineReasonClass' | 'declineReason'>,
): {
  messageKey: CopyKey;
  safety: boolean;
} {
  if (status.declineReasonClass === 'safety')
    return { messageKey: 'error.UPLOAD_DECLINED', safety: true };
  switch (status.declineCode) {
    case 'UPLOAD_UNSUPPORTED_FORMAT':
      return { messageKey: 'error.UPLOAD_UNSUPPORTED_FORMAT', safety: false };
    case 'UPLOAD_TOO_LARGE':
      return { messageKey: 'error.UPLOAD_TOO_LARGE', safety: false };
    case 'VALIDATION_FAILED':
      return {
        messageKey:
          status.declineReason === 'image_too_small' ? 'upload.imageTooSmall' : 'upload.unreadable',
        safety: false,
      };
    default:
      break;
  }
  switch (status.declineReason) {
    case 'not_a_living_space':
    case 'subject_is_people':
    case 'document_or_screen':
    case 'multi_unit_facade':
      return { messageKey: `upload.declined.${status.declineReason}`, safety: false };
    default:
      return {
        messageKey: 'error.UPLOAD_DECLINED',
        safety: status.declineReasonClass !== 'guidance',
      };
  }
}

/** The copy for a file the browser refused before upload. */
export function prepareFailureMessage(reason: PrepareFailureReason): CopyKey[] {
  switch (reason) {
    case 'too_large':
      return ['error.UPLOAD_TOO_LARGE'];
    case 'image_too_small':
      return ['upload.imageTooSmall'];
    case 'heic_unsupported':
      return ['error.UPLOAD_UNSUPPORTED_FORMAT', 'upload.heicHint'];
    case 'unsupported_format':
      return ['error.UPLOAD_UNSUPPORTED_FORMAT'];
  }
}
