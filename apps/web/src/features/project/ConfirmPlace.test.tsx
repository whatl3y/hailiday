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

/** The confirmation screen of a contributor-imagery place discovered in `sourceMode`. */
function showDiscovery(sourceMode: StreetViewSourceMode) {
  const candidates = [
    candidate({}),
    candidate({
      candidateId: 'c2',
      isPrimary: false,
      rank: 2,
      displayUrl: null,
      captureDate: null,
      captureGranularity: 'none',
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
