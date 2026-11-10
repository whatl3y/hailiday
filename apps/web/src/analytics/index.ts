import { hasSession, onSessionReady, sendAnalytics } from '../api/endpoints';
import { createAnalyticsQueue } from './analytics';

export { createAnalyticsQueue, type AnalyticsQueue, type AnalyticsDimensions } from './analytics';

/**
 * The app-wide analytics queue; flushed when the page is hidden. Its events wait until the page
 * has a session for another reason, and go out as soon as it does.
 */
export const analytics = createAnalyticsQueue({
  send: sendAnalytics,
  hasSession,
  onSessionReady,
});

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => analytics.flush(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') analytics.flush(true);
  });
}
