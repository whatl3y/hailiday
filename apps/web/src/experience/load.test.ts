import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as analyticsModule from '../analytics';
import * as endpoints from '../api/endpoints';
import { allowance } from '../test/fixtures';

vi.mock('../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

const listeners: Array<() => void> = [];
let sessionExists = false;
vi.mock('../api/endpoints', () => ({
  getExperience: vi.fn(),
  hasSession: vi.fn(() => sessionExists),
  onSessionReady: vi.fn((listener: () => void) => {
    listeners.push(listener);
    return () => listeners.splice(listeners.indexOf(listener), 1);
  }),
}));

const api = vi.mocked(endpoints);
const track = vi.mocked(analyticsModule.analytics.track);

const experience = {
  defaultHolidayId: 'christmas',
  requestedHolidayId: null,
  editorialTimezone: 'America/New_York',
  offSeason: false,
  holidays: ['christmas', 'halloween'].map((id) => ({
    id,
    nameKey: `holiday.${id}`,
    isDefault: id === 'christmas',
    journeyEmphasis: 'exterior',
    inWindow: id === 'christmas',
    windowStart: '2026-11-01',
    windowEnd: '2026-12-31',
    packVersion: '1.0.0',
    sceneTypes: {},
  })),
  calendar: [
    {
      occurrenceKey: 'christmas.US.2026',
      holidayId: 'christmas',
      promotionStart: '2026-11-01',
      promotionEnd: '2026-12-31',
    },
  ],
  hero: null,
  examples: [],
  capabilities: {
    addressLookup: true,
    streetViewAi: false,
    uploads: true,
    sharing: true,
    commerce: false,
  },
  allowance: allowance(6),
  clientConfig: {
    autocompleteMinChars: 3,
    autocompleteDebounceMs: 250,
    uploadMaxBytes: 26214400,
    uploadAcceptedTypes: ['image/jpeg'],
    pollRenderMs: 3000,
    pollUploadMs: 2000,
    retention: { timeBasedDeletion: false },
  },
  legal: {
    termsVersion: '2026-11',
    ageLineKey: 'landing.ageLine',
    termsUrl: '/terms',
    privacyUrl: '/privacy',
  },
};

/** A fresh loader and app store (the loader keeps once-per-page state). */
async function freshLoader(state: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useAppStore } = await import('../state/appStore');
  useAppStore.setState({ explicitHolidayId: null, deepLinkHolidayId: null, ...state });
  const load = await import('./load');
  return { ...load, useAppStore };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-12-01T15:00:00.000Z'));
  listeners.length = 0;
  sessionExists = false;
  document.body.innerHTML = `<script type="application/json" id="experience">${JSON.stringify(experience)}</script>`;
  api.getExperience.mockResolvedValue({
    experience: experience as never,
    allowance: allowance(2),
    fixtureCapabilities: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('bootstrapping the experience', () => {
  it('ignores the shell allowance and fetches the real one once the session exists', async () => {
    const { bootstrapExperience, useAppStore } = await freshLoader();
    bootstrapExperience('');
    expect(useAppStore.getState().experience).not.toBeNull();
    expect(useAppStore.getState().allowance).toBeNull();
    expect(api.getExperience).not.toHaveBeenCalled();
    sessionExists = true;
    listeners[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getExperience).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().allowance?.variants.remaining).toBe(2);
  });

  it('records a deep link that chooses the holiday', async () => {
    const { bootstrapExperience } = await freshLoader();
    bootstrapExperience('?holiday=halloween');
    expect(track).toHaveBeenCalledWith(
      'holiday_changed',
      { fromHolidayId: 'christmas', toHolidayId: 'halloween', surface: 'deep_link' },
      { holidayId: 'halloween' },
    );
  });

  it('records nothing when an explicit choice outranks the deep link', async () => {
    const { bootstrapExperience } = await freshLoader({ explicitHolidayId: 'christmas' });
    bootstrapExperience('?holiday=halloween');
    expect(track).not.toHaveBeenCalled();
  });
});

describe('keeping the experience in step with the holiday choice', () => {
  const christmasHero = {
    holidayId: 'christmas',
    assetId: 'hero-christmas',
    url: 'https://cdn.test/hero.jpg',
    alt: 'A porch at dusk',
    width: 1600,
    height: 1000,
  };

  it('sends no request when a holiday other than the hero is chosen', async () => {
    const { syncExperienceWithSelection, useAppStore } = await freshLoader();
    sessionExists = true;
    useAppStore.setState({
      experience: { ...experience, hero: christmasHero } as never,
      allowance: allowance(3),
      explicitHolidayId: 'halloween',
    });
    syncExperienceWithSelection();
    expect(api.getExperience).not.toHaveBeenCalled();
  });

  it('never starts a session for a choice', async () => {
    const { syncExperienceWithSelection, useAppStore } = await freshLoader();
    useAppStore.setState({
      experience: { ...experience, hero: christmasHero } as never,
      allowance: null,
      explicitHolidayId: 'halloween',
    });
    syncExperienceWithSelection();
    expect(api.getExperience).not.toHaveBeenCalled();
  });

  it('fetches the allowance once a session exists and it is not known', async () => {
    const { syncExperienceWithSelection, useAppStore } = await freshLoader();
    sessionExists = true;
    useAppStore.setState({ experience: experience as never, allowance: null });
    syncExperienceWithSelection();
    expect(api.getExperience).toHaveBeenCalledTimes(1);
  });
});
