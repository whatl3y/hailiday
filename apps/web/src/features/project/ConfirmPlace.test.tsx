import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate, Discovery, StreetViewSourceMode } from '@hailiday/core';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import { project } from '../../test/fixtures';
import * as controller from './controller';
import { ConfirmPlace } from './ConfirmPlace';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({}));
vi.mock('./controller', () => ({
  confirmPlace: vi.fn(async () => undefined),
  nudge: vi.fn(async () => undefined),
  selectView: vi.fn(async () => undefined),
  showUpload: vi.fn(),
  onUploadAttached: vi.fn(async () => undefined),
}));

const control = vi.mocked(controller);

const experience = {
  holidays: [{ id: 'christmas', sceneTypes: { house_exterior: {} } }],
  examples: [],
  clientConfig: {},
} as unknown as PublicExperience;

/** A street photo credited to a contributor, not to Google. */
const CONTRIBUTOR_CREDIT = '© GIS1 Street Imagery';

function candidate(overrides: Partial<Candidate>): Candidate {
  return {
    candidateId: 'c1',
    derivedFromCandidateId: null,
    isPrimary: true,
    rank: 1,
    displayUrl: 'https://maps.googleapis.com/maps/api/streetview?pano=p1',
    heading: 180,
    headingMode: 'geometry',
    pitch: 2,
    fov: 70,
    captureDate: '2024-05',
    captureGranularity: 'month',
    copyright: CONTRIBUTOR_CREDIT,
    isGoogleImagery: false,
    distanceMeters: 18,
    estimatedFacadePx: null,
    flags: ['contributorImagery'],
    width: 640,
    height: 640,
    ...overrides,
  };
}

/**
 * The confirmation screen of a contributor-imagery place discovered in `sourceMode`, its views
 * aimed in `headingMode`.
 */
function showDiscovery(
  sourceMode: StreetViewSourceMode,
  headingMode: Candidate['headingMode'] = 'geometry',
) {
  const candidates = [
    candidate({ headingMode }),
    candidate({
      candidateId: 'c2',
      isPrimary: false,
      rank: 2,
      displayUrl: null,
      captureDate: null,
      captureGranularity: 'none',
      headingMode,
    }),
  ];
  const discovery: Discovery = {
    discoveryId: '018f0000-0000-7000-8000-dddddddddddd',
    projectVersion: 0,
    entryMethod: 'autocomplete',
    matchClass: 'confirm',
    reason: null,
    retryable: false,
    sourceMode,
    thresholdsVersion: '1',
    sourceAssetId: null,
    remainingDisplayLoads: 5,
    candidates,
    attribution: { logo: 'google_maps', required: true },
    nextAction: 'confirm_place',
  };
  useProjectStore.setState({
    projectId: project().id,
    project: project({ activeSource: null, variantCount: 0 }),
    displayAddress: '31 Piñon Mesa Rd, Turquoise Flats, NM 87520, USA',
    phase: 'confirm',
    discovery,
    candidates,
    baseCandidateIds: ['c1', 'c2'],
    selectedCandidateId: 'c1',
    remainingDisplayLoads: 5,
  });
  return render(
    <MemoryRouter>
      <ConfirmPlace />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAppStore.setState({
    experience,
    pickerHolidayIds: ['christmas'],
    explicitHolidayId: null,
    deepLinkHolidayId: null,
    clientDefaultHolidayId: 'christmas',
    fixtureCapabilities: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('confirming a place whose street photo is credited to a contributor', () => {
  it('is the ordinary confirmation screen when the place may be decorated', () => {
    const { container } = showDiscovery('persist');
    expect(screen.getByRole('heading', { name: 'Is this the right place?' })).toBeTruthy();
    const yes = screen.getByRole('button', { name: 'Yes, decorate this place' });
    expect(screen.getByRole('group', { name: 'Other views' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^View \d/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Look left/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Look right/ })).toBeTruthy();
    expect(container.textContent).not.toContain("we can't decorate it");
    // The credit names the contributor, after the Google Maps logo the frame carries.
    const strip = container.querySelector('.attribution');
    expect(strip?.textContent).toContain(CONTRIBUTOR_CREDIT);
    expect(strip?.textContent).not.toMatch(/©[^·]*Google/);

    fireEvent.click(yes);
    expect(control.confirmPlace).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'View 2' }));
    expect(control.selectView).toHaveBeenCalledWith('c2');
    fireEvent.click(screen.getByRole('button', { name: /Look right/ }));
    expect(control.nudge).toHaveBeenCalledWith(1);
  });

  it('is the confirmation-only photo prompt when the place is display-only', () => {
    const { container } = showDiscovery('display_only');
    expect(screen.getByRole('heading', { name: 'Is this the right place?' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Yes, decorate this place' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Other views' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Look left/ })).toBeNull();
    expect(container.textContent).toContain(
      "We can show this street photo so you can check the place, but we can't decorate it.",
    );
    expect(screen.getByRole('button', { name: 'Try another address' })).toBeTruthy();
    expect(container.querySelector('.attribution')?.textContent).toContain(CONTRIBUTOR_CREDIT);
  });
});

/** The line a view of the road carries (the experience copy deck). */
const ROAD_GUIDE =
  "Choose the view that shows your home, then look left or right until it's in the middle.";

/** A view of a place whose address lies on the road, credited to Google. */
function roadView(overrides: Partial<Candidate>): Candidate {
  return candidate({
    headingMode: 'road',
    heading: 171.3,
    pitch: 3.4,
    fov: 90,
    copyright: '© 2025 Google',
    isGoogleImagery: true,
    flags: [],
    distanceMeters: 5,
    ...overrides,
  });
}

/**
 * The confirmation screen of a place on the road discovered in `sourceMode`: both sides of the
 * road arrive with their pictures, the view along it without one. `extra` views (turned ones)
 * join the candidates, and `selected` is the view on the stage.
 */
function showRoad(
  sourceMode: StreetViewSourceMode,
  { extra = [], selected = 'c1' }: { extra?: Candidate[]; selected?: string } = {},
) {
  const views = [
    roadView({ displayUrl: 'https://maps.googleapis.com/maps/api/streetview?pano=r1&h=171.3' }),
    roadView({
      candidateId: 'c2',
      isPrimary: false,
      rank: 2,
      heading: 27.6,
      pitch: 3.9,
      displayUrl: 'https://maps.googleapis.com/maps/api/streetview?pano=r1&h=27.6',
    }),
    roadView({
      candidateId: 'c3',
      isPrimary: false,
      rank: 3,
      heading: 109.9,
      pitch: 3.8,
      displayUrl: null,
    }),
  ];
  const discovery: Discovery = {
    discoveryId: '018f0000-0000-7000-8000-eeeeeeeeeeee',
    projectVersion: 0,
    entryMethod: 'autocomplete',
    matchClass: 'confirm',
    reason: null,
    retryable: false,
    sourceMode,
    thresholdsVersion: '1',
    sourceAssetId: null,
    remainingDisplayLoads: 4,
    candidates: views,
    attribution: { logo: 'google_maps', required: true },
    nextAction: 'confirm_place',
  };
  useProjectStore.setState({
    projectId: project().id,
    project: project({ activeSource: null, variantCount: 0 }),
    displayAddress: '560 Millpond Rd, Kettle Fork, GA 30077, USA',
    phase: 'confirm',
    discovery,
    candidates: [...views, ...extra],
    baseCandidateIds: ['c1', 'c2', 'c3'],
    selectedCandidateId: selected,
    remainingDisplayLoads: 4,
  });
  return render(
    <MemoryRouter>
      <ConfirmPlace />
    </MemoryRouter>,
  );
}

describe('confirming a place whose address lies on the road', () => {
  it('says to choose the view that shows the home and turn it', () => {
    showRoad('persist');
    const line = screen.getByText(ROAD_GUIDE);
    // The line sits under the question and the address, in the heading's block.
    const block = line.closest('.picture-head__title');
    expect(block).not.toBeNull();
    expect(block?.querySelector('h1')?.textContent).toBe('Is this the right place?');
    expect(block?.textContent).toContain('560 Millpond Rd, Kettle Fork, GA 30077, USA');
    // The views are described by it.
    const group = screen.getByRole('group', { name: 'Other views', description: ROAD_GUIDE });
    expect(group.getAttribute('aria-describedby')).toBe(line.id);
    const chips = screen.getAllByRole('button', { name: /^View \d/ });
    expect(chips.map((chip) => chip.textContent)).toEqual(['View 1', 'View 2', 'View 3']);
    expect(screen.getByRole('button', { name: /Look left/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Look right/ })).toBeTruthy();
    // Both sides of the road carry their picture; the view along it loads on request.
    expect(chips.map((chip) => chip.querySelectorAll('img').length)).toEqual([1, 1, 0]);
    expect(screen.getByRole('button', { name: 'Yes, decorate this place' })).toBeTruthy();
    // The screen keeps a smaller stage, so the views show without scrolling.
    expect(line.closest('section')?.className).toBe('confirm confirm--road');
  });

  it('keeps the line on a turned view', () => {
    const turned = roadView({
      candidateId: 'c1-left',
      derivedFromCandidateId: 'c1',
      isPrimary: false,
      heading: 156.3,
      displayUrl: 'https://maps.googleapis.com/maps/api/streetview?pano=r1&h=156.3',
    });
    const { container } = showRoad('persist', { extra: [turned], selected: 'c1-left' });
    expect(container.querySelector('.stage__image')?.getAttribute('src')).toBe(turned.displayUrl);
    expect(screen.getByText(ROAD_GUIDE)).toBeTruthy();
    expect(
      screen.getByRole('group', { name: 'Other views', description: ROAD_GUIDE }),
    ).toBeTruthy();
    // The turned view stands for view 1.
    expect(screen.getByRole('button', { name: 'View 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it.each(['geometry', 'point'] as const)(
    'says nothing of the kind for a view aimed in mode %s',
    (headingMode) => {
      const { container } = showDiscovery('persist', headingMode);
      expect(screen.getByRole('heading', { name: 'Is this the right place?' })).toBeTruthy();
      expect(container.textContent).not.toContain(ROAD_GUIDE);
      expect(container.querySelector('.confirm__guide')).toBeNull();
      expect(container.querySelector('section')?.className).toBe('confirm');
      expect(
        screen.getByRole('group', { name: 'Other views' }).getAttribute('aria-describedby'),
      ).toBeNull();
    },
  );

  it('leaves it out of the photo prompt', () => {
    const { container } = showRoad('display_only');
    expect(container.textContent).toContain(
      "We can show this street photo so you can check the place, but we can't decorate it.",
    );
    expect(container.textContent).not.toContain(ROAD_GUIDE);
    expect(container.querySelector('.confirm__guide')).toBeNull();
    expect(container.querySelector('section')?.className).toBe('confirm');
  });
});
