import { detectClientTimeZone, type HolidayId } from '@holiday/core';
import { analytics } from '../analytics';
import { getExperience, hasSession, onSessionReady } from '../api/endpoints';
import { currentHolidayId, useAppStore } from '../state/appStore';
import { readInlineExperience } from './payload';

let inflight: Promise<void> | null = null;
let requestedFor: string | null = null;
let deepLinkReported = false;
let stopWaitingForSession: (() => void) | null = null;

/** Fetches `GET /v1/experience` (optionally for a holiday) and applies it. */
export function fetchExperience(holidayId?: HolidayId | null): Promise<void> {
  const key = holidayId ?? '';
  if (inflight && requestedFor === key) return inflight;
  requestedFor = key;
  const store = useAppStore.getState();
  if (!store.experience) store.setExperienceStatus('loading');
  const promise = getExperience(holidayId)
    .then((snapshot) => {
      if (requestedFor !== key) return;
      useAppStore.getState().applyExperience(snapshot, new Date(), detectClientTimeZone());
      reportDeepLink();
    })
    .catch(() => {
      if (!useAppStore.getState().experience) useAppStore.getState().setExperienceStatus('error');
    })
    .finally(() => {
      if (inflight === promise) inflight = null;
    });
  inflight = promise;
  return promise;
}

/**
 * Records a `?holiday=` deep link that set the selection, once the experience is known: the
 * event is sent only when the deep link is what decides the holiday (no explicit choice wins
 * over it) and it differs from the visitor's default.
 */
function reportDeepLink(): void {
  if (deepLinkReported) return;
  const state = useAppStore.getState();
  const deepLink = state.deepLinkHolidayId;
  if (!deepLink || !state.experience) return;
  deepLinkReported = true;
  if (currentHolidayId(state) !== deepLink) return;
  const from = state.clientDefaultHolidayId;
  if (from === deepLink) return;
  analytics.track(
    'holiday_changed',
    { fromHolidayId: from, toHolidayId: deepLink, surface: 'deep_link' },
    { holidayId: deepLink },
  );
}

/** Fetches the session's allowance snapshot as soon as a session exists. */
function fetchAllowanceWithSession(): void {
  stopWaitingForSession?.();
  stopWaitingForSession = null;
  const fetchIfMissing = () => {
    const state = useAppStore.getState();
    if (!state.allowance) void fetchExperience(currentHolidayId(state));
  };
  if (hasSession()) {
    fetchIfMissing();
    return;
  }
  stopWaitingForSession = onSessionReady(() => {
    stopWaitingForSession?.();
    stopWaitingForSession = null;
    fetchIfMissing();
  });
}

/**
 * Hydrates from the landing shell's inline JSON when present (no request, no second hero
 * paint) and otherwise fetches the experience. Deep links preselect the holiday. The inline
 * JSON carries no session allowance, so that snapshot is fetched once the session exists
 * (the session itself is created on the first interaction).
 */
export function bootstrapExperience(search: string = window.location.search): void {
  const store = useAppStore.getState();
  store.setDeepLink(new URLSearchParams(search).get('holiday'));
  const inline = readInlineExperience();
  if (inline) {
    store.applyExperience(inline, new Date(), detectClientTimeZone());
    reportDeepLink();
    fetchAllowanceWithSession();
    return;
  }
  void fetchExperience(useAppStore.getState().deepLinkHolidayId);
}

/**
 * Fetches the session's allowance snapshot for the selected holiday when it is not known yet
 * and a session exists. The hero follows the editorial window, not the holiday choice, so a
 * choice alone never refetches the experience (and never starts a session).
 */
export function syncExperienceWithSelection(): void {
  const state = useAppStore.getState();
  if (!state.experience) return;
  if (!state.allowance && hasSession()) void fetchExperience(currentHolidayId(state));
}
