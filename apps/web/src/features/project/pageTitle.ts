import type { HolidayId } from '@holiday/core';
import { holidayName, t } from '../../copy';
import type { ProjectPhase } from '../../state/projectStore';

/** The page name for the document title: the heading of the screen the project is on. */
export function projectPageTitle(phase: ProjectPhase, variantHoliday: HolidayId | null): string {
  switch (phase) {
    case 'confirm':
      return t('confirm.heading');
    case 'nosv':
      return t('nosv.heading');
    case 'upload':
      return t('upload.heading');
    case 'starting':
    case 'waiting':
      return t('wait.heading');
    case 'result':
      return variantHoliday
        ? t('result.heading', { holiday: holidayName(variantHoliday) })
        : t('result.headingNeutral');
    case 'render_error':
      return t('result.errorHeading');
    case 'not_found':
      return t('notFound.heading');
    case 'loading':
    case 'error':
    case 'finding':
      return t('pageTitle.project');
  }
}
