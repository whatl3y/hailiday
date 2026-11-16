import type { AnalyticsEventProperties, NavigationType, WebVitalsPage } from '@hailiday/core';

export type WebVitals = AnalyticsEventProperties<'web_vitals'>;

/** The page class a path reports web vitals as; other pages do not report. */
export function webVitalsPageFor(pathname: string): WebVitalsPage | null {
  if (pathname === '/') return 'landing';
  if (pathname.startsWith('/p/')) return 'project';
  if (pathname.startsWith('/s/')) return 'share';
  return null;
}

/** The navigation type in the web-vitals vocabulary. */
export function navigationTypeFrom(
  entryType: string | undefined,
  prerendering = false,
): NavigationType {
  if (prerendering) return 'prerender';
  switch (entryType) {
    case 'reload':
      return 'reload';
    case 'back_forward':
      return 'back-forward';
    case 'prerender':
      return 'prerender';
    default:
      return 'navigate';
  }
}

interface ShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface InteractionEntry extends PerformanceEntry {
  interactionId?: number;
}

export interface WebVitalsDeps {
  track: (vitals: WebVitals) => void;
  /** Sends what was tracked right away (the page is being hidden). */
  flush?: () => void;
  Observer?: typeof PerformanceObserver | undefined;
  navigationType?: () => NavigationType;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

function defaultNavigationType(): NavigationType {
  const entry = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  const prerendering = Boolean((document as Document & { prerendering?: boolean }).prerendering);
  return navigationTypeFrom(entry?.type, prerendering);
}

/**
 * Measures the page's largest contentful paint, interaction to next paint (the slowest
 * interaction) and cumulative layout shift (the largest session window), and reports them
 * once as `web_vitals` when the page is first hidden. Returns a stop function, or null when the
 * page does not report or the browser cannot measure.
 */
export function startWebVitals(pathname: string, deps: WebVitalsDeps): (() => void) | null {
  const page = webVitalsPageFor(pathname);
  const Observer =
    'Observer' in deps
      ? deps.Observer
      : typeof PerformanceObserver === 'undefined'
        ? undefined
        : PerformanceObserver;
  if (!page || !Observer) return null;
  const target = deps.target ?? window;
  const doc = deps.doc ?? document;
  const supported = Observer.supportedEntryTypes ?? [];

  let lcpMs: number | null = null;
  let inpMs: number | null = null;
  let cls: number | null = supported.includes('layout-shift') ? 0 : null;
  let windowValue = 0;
  let windowStart = 0;
  let lastShift = 0;
  let reported = false;
  const observers: Array<{
    observer: PerformanceObserver;
    onEntries: (entries: PerformanceEntry[]) => void;
  }> = [];

  function observe(type: string, onEntries: (entries: PerformanceEntry[]) => void, extra = {}) {
    if (!supported.includes(type)) return;
    try {
      const observer = new Observer!((list) => onEntries(list.getEntries()));
      observer.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      observers.push({ observer, onEntries });
    } catch {
      // A browser that cannot observe this entry type reports the metric as null.
    }
  }

  observe('largest-contentful-paint', (entries) => {
    const last = entries.at(-1);
    if (last) lcpMs = Math.max(0, last.startTime);
  });
  observe(
    'event',
    (entries) => {
      for (const entry of entries as InteractionEntry[]) {
        if (!entry.interactionId) continue;
        inpMs = Math.max(inpMs ?? 0, entry.duration);
      }
    },
    { durationThreshold: 40 },
  );
  observe('layout-shift', (entries) => {
    for (const entry of entries as ShiftEntry[]) {
      if (entry.hadRecentInput) continue;
      const time = entry.startTime;
      if (windowValue > 0 && time - lastShift < 1000 && time - windowStart < 5000) {
        windowValue += entry.value;
      } else {
        windowValue = entry.value;
        windowStart = time;
      }
      lastShift = time;
      cls = Math.max(cls ?? 0, windowValue);
    }
  });

  const navigationType = (deps.navigationType ?? defaultNavigationType)();

  function stop() {
    for (const { observer } of observers) observer.disconnect();
    observers.length = 0;
    doc.removeEventListener('visibilitychange', onVisibility);
    target.removeEventListener('pagehide', report);
  }

  function report() {
    if (reported) return;
    reported = true;
    // Entries still queued are read through their handlers before reporting.
    for (const { observer, onEntries } of observers) {
      const pending = observer.takeRecords?.() ?? [];
      if (pending.length > 0) onEntries(pending);
    }
    stop();
    deps.track({ lcpMs, inpMs, cls, page: page!, navigationType });
    deps.flush?.();
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') report();
  }

  doc.addEventListener('visibilitychange', onVisibility);
  target.addEventListener('pagehide', report);
  return stop;
}
