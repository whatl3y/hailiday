import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import { project } from '../../test/fixtures';
import * as controller from './controller';
import { ProjectPage } from './ProjectPage';
import { ResultSceneChip } from './Result';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({}));
vi.mock('./controller', () => ({
  openProject: vi.fn(async () => undefined),
  closeProject: vi.fn(),
  changeHoliday: vi.fn(),
  cancelUpload: vi.fn(),
  onUploadAttached: vi.fn(),
  changeSceneType: vi.fn(async () => undefined),
}));

const control = vi.mocked(controller);

/** Christmas has a balcony section; Halloween does not. */
const experience = {
  holidays: [
    { id: 'christmas', sceneTypes: { house_exterior: {}, balcony: {} } },
    { id: 'halloween', sceneTypes: { house_exterior: {} } },
  ],
} as unknown as PublicExperience;

beforeEach(() => {
  useAppStore.setState({
    experience,
    pickerHolidayIds: ['christmas', 'halloween'],
    explicitHolidayId: null,
    deepLinkHolidayId: null,
    clientDefaultHolidayId: 'christmas',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('the project header chip', () => {
  it('offers only the holidays with a section for the project scene type', () => {
    const balcony = project({ kind: 'upload', sceneType: 'balcony' });
    // The loading phase keeps the screen itself out of the way of the header under test.
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: balcony, phase: 'loading' });
    render(
      <MemoryRouter initialEntries={[`/p/${balcony.id}`]}>
        <Routes>
          <Route path="/p/:projectId" element={<ProjectPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Holiday:/ }));
    const sheet = screen.getByRole('dialog', { name: 'Choose a holiday' });
    expect(within(sheet).getByRole('button', { name: /Christmas/ })).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: /Halloween/ })).toBeNull();
  });
});

describe('the result scene chip', () => {
  it('names the scene of an uploaded photo and changes it', () => {
    render(<ResultSceneChip project={project({ sceneType: 'house_exterior' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Looks like a house exterior · Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Balcony or patio' }));
    expect(control.changeSceneType).toHaveBeenCalledWith({ sceneType: 'balcony', roomType: null });
  });

  it('is absent for a Street View source', () => {
    const base = project();
    const { container } = render(
      <ResultSceneChip
        project={{ ...base, activeSource: { ...base.activeSource!, kind: 'street_view' } }}
      />,
    );
    expect(container.textContent).toBe('');
  });
});
