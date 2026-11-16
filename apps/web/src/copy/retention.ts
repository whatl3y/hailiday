import { DISPLAY_VALUES } from '../config/values';
import { useAppStore } from '../state/appStore';
import { t } from './index';

/** Places where the interface tells people how long their photos and previews are kept. */
export type RetentionLine = 'upload' | 'longWait' | 'save' | 'privacy';

/**
 * What a retention line says. While time-based deletion is off nothing is deleted by age, so
 * the line makes no promise of deletion; when it is on, it names the schedule.
 */
export function retentionText(line: RetentionLine, timeBasedDeletion: boolean): string {
  switch (line) {
    case 'upload':
      return timeBasedDeletion
        ? t('upload.retentionLine', { anonymousRetention: DISPLAY_VALUES.anonymousRetention })
        : t('upload.retentionLineKept');
    case 'longWait':
      return timeBasedDeletion
        ? t('wait.longWait', { anonymousRetention: DISPLAY_VALUES.anonymousRetention })
        : t('wait.longWaitKept');
    case 'save':
      return timeBasedDeletion
        ? t('save.body', { savedRetention: DISPLAY_VALUES.savedRetention })
        : t('save.bodyKept');
    case 'privacy':
      return timeBasedDeletion
        ? t('legal.privacy.summary', DISPLAY_VALUES)
        : t('legal.privacy.summaryKept');
  }
}

/**
 * Whether the service deletes projects and previews on a schedule, from the experience
 * payload. Until the payload is known it counts as off, the service default.
 */
export function useTimeBasedDeletion(): boolean {
  return useAppStore(
    (state) => state.experience?.clientConfig.retention?.timeBasedDeletion ?? false,
  );
}

/** A retention line that follows the service's current retention setting. */
export function useRetentionText(line: RetentionLine): string {
  return retentionText(line, useTimeBasedDeletion());
}
