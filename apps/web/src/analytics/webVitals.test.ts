import { describe, expect, it, vi } from 'vitest';
import { navigationTypeFrom, startWebVitals, webVitalsPageFor, type WebVitals } from './webVitals';

type Callback = (list: { getEntries: () => PerformanceEntry[] }) => void;

class FakeObserver {
  static supportedEntryTypes = ['largest-contentful-paint', 'event', 'layout-shift'];
  static instances: FakeObserver[] = [];
  type = '';
  constructor(public callback: Callback) {
    FakeObserver.instances.push(this);
  }
  observe(options: { type: string }) {
    this.type = options.type;
  }
  emit(entries: Array<Record<string, unknown>>) {
    this.callback({ getEntries: () => entries as unknown as PerformanceEntry[] });
  }
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function events() {
  const listeners = new Map<string, () => void>();
  return {
    target: {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
    },
    fire: (type: string) => listeners.get(type)?.(),
    count: () => listeners.size,
  };
}

describe('web vitals', () => {
  it('maps paths to page classes and navigation types to the web-vitals names', () => {
    expect(webVitalsPageFor('/')).toBe('landing');
    expect(webVitalsPageFor('/p/abc')).toBe('project');
    expect(webVitalsPageFor('/s/tok')).toBe('share');
    expect(webVitalsPageFor('/privacy')).toBeNull();
    expect(navigationTypeFrom('back_forward')).toBe('back-forward');
    expect(navigationTypeFrom('navigate', true)).toBe('prerender');
  });

  it('reports LCP, INP and CLS once when the page is hidden', () => {
    FakeObserver.instances = [];
    const track = vi.fn<(vitals: WebVitals) => void>();
    const flush = vi.fn();
    const win = events();
    const docEvents = events();
    const doc = {
      ...docEvents.target,
      visibilityState: 'visible' as DocumentVisibilityState,
    };
    startWebVitals('/', {
      track,
      flush,
      Observer: FakeObserver as unknown as typeof PerformanceObserver,
      navigationType: () => 'navigate',
      target: win.target as never,
      doc: doc as never,
    });
    const byType = (type: string) => FakeObserver.instances.find((item) => item.type === type)!;
    byType('largest-contentful-paint').emit([{ startTime: 900 }, { startTime: 1800 }]);
    byType('event').emit([
      { interactionId: 1, duration: 120 },
      { interactionId: 0, duration: 400 },
      { interactionId: 2, duration: 80 },
    ]);
    byType('layout-shift').emit([
      { startTime: 100, value: 0.05, hadRecentInput: false },
      { startTime: 300, value: 0.02, hadRecentInput: false },
      { startTime: 400, value: 0.5, hadRecentInput: true },
      { startTime: 4000, value: 0.01, hadRecentInput: false },
    ]);
    doc.visibilityState = 'hidden';
    docEvents.fire('visibilitychange');
    win.fire('pagehide');
    expect(track).toHaveBeenCalledTimes(1);
    const vitals = track.mock.calls[0]![0];
    expect(vitals).toMatchObject({
      lcpMs: 1800,
      inpMs: 120,
      page: 'landing',
      navigationType: 'navigate',
    });
    expect(vitals.cls).toBeCloseTo(0.07);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('does nothing on pages that do not report', () => {
    expect(
      startWebVitals('/privacy', {
        track: vi.fn(),
        Observer: FakeObserver as unknown as typeof PerformanceObserver,
      }),
    ).toBeNull();
  });
});
