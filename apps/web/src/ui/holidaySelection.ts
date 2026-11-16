import { useEffect } from 'react';
import type { HolidayChangeSurface, HolidayId } from '@hailiday/core';
import { analytics } from '../analytics';
import { currentHolidayId, useAppStore } from '../state/appStore';

/** Sets the seasonal accent family for the whole document. */
export function useHolidayTheme(holidayId: HolidayId | null): void {
  useEffect(() => {
    const root = document.documentElement;
    if (holidayId) root.dataset.holiday = holidayId;
    else delete root.dataset.holiday;
  }, [holidayId]);
}

/** Records a deliberate holiday choice and its analytics event. */
export function chooseHolidayExplicitly(holidayId: HolidayId, surface: HolidayChangeSurface): void {
  const state = useAppStore.getState();
  const from = currentHolidayId(state);
  state.chooseHoliday(holidayId);
  if (from !== holidayId) {
    analytics.track(
      'holiday_changed',
      { fromHolidayId: from, toHolidayId: holidayId, surface },
      { holidayId },
    );
  }
}
