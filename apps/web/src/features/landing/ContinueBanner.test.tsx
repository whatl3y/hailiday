import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Endpoints from '../../api/endpoints';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { LandingPage } from './LandingPage';

vi.mock('../../experience/load', () => ({ syncExperienceWithSelection: vi.fn() }));
vi.mock('../../api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof Endpoints>()),
  ensureSession: vi.fn(async () => undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

function experience(timeBasedDeletion: boolean): PublicExperience {
  return {
    holidays: [{ id: 'christmas', journeyEmphasis: 'exterior', inWindow: true }],
    hero: null,
    examples: [],
    clientConfig: {
      autocompleteMinChars: 3,
      autocompleteDebounceMs: 150,
      retention: { timeBasedDeletion },
    },
    fixtureCapabilities: [],
  } as unknown as PublicExperience;
}

function renderLanding(input: { timeBasedDeletion: boolean; lastOpenedAgoMs: number }) {
  useAppStore.setState({
    experience: experience(input.timeBasedDeletion),
    experienceStatus: 'ready',
    clientDefaultHolidayId: 'christmas',
    pickerHolidayIds: ['christmas'],
    explicitHolidayId: null,
    deepLinkHolidayId: null,
    lastProject: { id: 'project-1', at: Date.now() - input.lastOpenedAgoMs },
  });
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

function continueLink(): HTMLElement | null {
  return screen.queryByRole('link', { name: /continue/i });
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ lastProject: null });
  document.body.replaceChildren();
});

describe('the landing link back to the last project', () => {
  it('stays for a project opened days ago while nothing is deleted by age', () => {
    renderLanding({ timeBasedDeletion: false, lastOpenedAgoMs: 30 * DAY_MS });
    expect(continueLink()?.getAttribute('href')).toBe('/p/project-1');
  });

  it('goes after a day when time-based deletion is on', () => {
    renderLanding({ timeBasedDeletion: true, lastOpenedAgoMs: 2 * DAY_MS });
    expect(continueLink()).toBeNull();
  });

  it('shows within the day when time-based deletion is on', () => {
    renderLanding({ timeBasedDeletion: true, lastOpenedAgoMs: 60 * 60 * 1000 });
    expect(continueLink()?.getAttribute('href')).toBe('/p/project-1');
  });
});
