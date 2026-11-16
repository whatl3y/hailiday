import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  createMemoryRouter,
  useLocation,
  type Location,
} from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import { project, renderStatus } from '../../test/fixtures';
import * as controller from './controller';
import { NotFoundContent, ProjectPage, ProjectRoute } from './ProjectPage';
import { ResultSceneChip } from './Result';
import { routeStateAfterOpen } from './routeState';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({}));
vi.mock('./controller', () => ({
  openProject: vi.fn(async () => undefined),
  closeProject: vi.fn(),
  changeHoliday: vi.fn(),
  cancelUpload: vi.fn(),
  onUploadAttached: vi.fn(),
  changeSceneType: vi.fn(async () => undefined),
  cancelRender: vi.fn(async () => undefined),
  cancelPendingLook: vi.fn(async () => undefined),
  notYourPlace: vi.fn(async () => undefined),
  offeredFor: vi.fn(() => ({
    styles: ['subtle', 'classic', 'abundant'],
    defaultStyle: 'abundant',
    lightingModes: ['source', 'evening'],
    defaultLightingMode: 'evening',
  })),
}));

const control = vi.mocked(controller);

/** Christmas has a balcony section; Halloween does not. */
const experience = {
  holidays: [
    { id: 'christmas', sceneTypes: { house_exterior: {}, balcony: {} } },
    { id: 'halloween', sceneTypes: { house_exterior: {} } },
  ],
  examples: [],
  clientConfig: {},
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

function renderPage(projectId: string) {
  return render(
    <MemoryRouter initialEntries={[`/p/${projectId}`]}>
      <Routes>
        <Route path="/p/:projectId" element={<ProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the project header chip', () => {
  it('offers only the holidays with a section for the project scene type', () => {
    const balcony = project({ kind: 'upload', sceneType: 'balcony' });
    // The loading phase keeps the screen itself out of the way of the header under test.
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: balcony, phase: 'loading' });
    renderPage(balcony.id);
    fireEvent.click(screen.getByRole('button', { name: /Holiday:/ }));
    const sheet = screen.getByRole('dialog', { name: 'Choose a holiday' });
    expect(within(sheet).getByRole('button', { name: /Christmas/ })).toBeTruthy();
    expect(within(sheet).queryByRole('button', { name: /Halloween/ })).toBeNull();
  });

  it('is locked while the first look is being made: it opens nothing and says why', () => {
    const place = project({ variantCount: 0 });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: place,
      phase: 'waiting',
      render: renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' }),
    });
    const { container } = renderPage(place.id);
    const chip = screen.getByRole('button', { name: /Holiday:/ });
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect(chip.getAttribute('aria-describedby')).toBe('look-lock-hint');
    const hint = container.querySelector('#look-lock-hint');
    expect(hint?.textContent).toBe('You can pick another look when this one is ready.');
    expect(hint?.hasAttribute('hidden')).toBe(true);
    fireEvent.click(chip);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useProjectStore.getState().lockedNotice).toBe(1);
    expect(control.changeHoliday).not.toHaveBeenCalled();
    expect(useAppStore.getState().explicitHolidayId).toBeNull();
  });

  it('closes an open picker when a look starts', () => {
    const place = project({ variantCount: 0 });
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: place, phase: 'loading' });
    renderPage(place.id);
    fireEvent.click(screen.getByRole('button', { name: /Holiday:/ }));
    expect(screen.getByRole('dialog', { name: 'Choose a holiday' })).toBeTruthy();
    act(() => {
      useProjectStore.setState({ phase: 'starting' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /Holiday:/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('stays closed when a look that started while it was open ends', () => {
    const place = project({ variantCount: 0 });
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: place, phase: 'loading' });
    renderPage(place.id);
    fireEvent.click(screen.getByRole('button', { name: /Holiday:/ }));
    expect(screen.getByRole('dialog', { name: 'Choose a holiday' })).toBeTruthy();
    act(() => {
      useProjectStore.setState({ phase: 'waiting' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      useProjectStore.setState({ phase: 'confirm' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /Holiday:/ }).hasAttribute('aria-disabled')).toBe(
      false,
    );
  });

  it('is unlocked, with no lock hint, when no look is being made', () => {
    const place = project({ variantCount: 0 });
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: place, phase: 'loading' });
    const { container } = renderPage(place.id);
    const chip = screen.getByRole('button', { name: /Holiday:/ });
    expect(chip.hasAttribute('aria-disabled')).toBe(false);
    expect(chip.hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelector('#look-lock-hint')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');
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

describe('the not-found screen', () => {
  it('says once that the page is missing and does not claim it expired', () => {
    const { container } = render(
      <MemoryRouter>
        <NotFoundContent />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("We couldn't find that");
    const body = container.querySelector('.lede')?.textContent ?? '';
    expect(body).toBe('It may have been removed, or the link is wrong.');
    expect(container.textContent?.match(/couldn't find that/g)).toHaveLength(1);
    expect(container.textContent).not.toMatch(/expired/i);
  });

  it('keeps the access line for a forbidden project', () => {
    const { container } = render(
      <MemoryRouter>
        <NotFoundContent forbidden />
      </MemoryRouter>,
    );
    expect(container.querySelector('.lede')?.textContent).toBe("You don't have access to this.");
  });
});

describe('the history entry of a project page', () => {
  const seen: { location: Location | null } = { location: null };
  function Probe() {
    seen.location = useLocation();
    return null;
  }

  function renderEntry(state: unknown) {
    const place = project({ variantCount: 0 });
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: place, phase: 'loading' });
    return render(
      <MemoryRouter initialEntries={[{ pathname: `/p/${place.id}`, search: '?a=1', state }]}>
        <Routes>
          <Route
            path="/p/:projectId"
            element={
              <>
                <ProjectPage />
                <Probe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('hands the project over once and keeps only the address and the entry for a reload', () => {
    const place = project({ variantCount: 0 });
    const handed = { project: place, displayAddress: '1735 Magnolia Ter', entry: 'autocomplete' };
    renderEntry(handed);
    expect(control.openProject).toHaveBeenCalledTimes(1);
    expect(control.openProject).toHaveBeenCalledWith(place.id, handed);
    expect(seen.location?.pathname).toBe(`/p/${place.id}`);
    expect(seen.location?.search).toBe('?a=1');
    expect(seen.location?.state).toEqual({
      displayAddress: '1735 Magnolia Ter',
      entry: 'autocomplete',
    });
    cleanup();

    // A reload opens the page again from what the history entry kept: no stale project.
    renderEntry(seen.location?.state);
    expect(control.openProject).toHaveBeenLastCalledWith(place.id, {
      displayAddress: '1735 Magnolia Ter',
      entry: 'autocomplete',
    });
  });

  it('asks for the upload step once', () => {
    const place = project({ kind: 'upload', variantCount: 0, activeSource: null });
    renderEntry({ project: place, entry: 'upload', openUpload: true });
    expect(seen.location?.state).toEqual({ entry: 'upload' });
  });

  it('leaves an entry without a handed-over project as it is', () => {
    const saved = { saved: true };
    renderEntry(saved);
    expect(seen.location?.state).toBe(saved);
  });
});

describe('going from one place straight to another', () => {
  it('opens each place from its own history entry, and Back opens the first place again', async () => {
    const first = project({ variantCount: 0 });
    const second = project({
      id: '018f0000-0000-7000-8000-cccccccccccc',
      kind: 'upload',
      variantCount: 0,
      activeSource: null,
    });
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: first, phase: 'loading' });
    const handed = { project: first, displayAddress: '1735 Magnolia Ter', entry: 'autocomplete' };
    const router = createMemoryRouter([{ path: '/p/:projectId', element: <ProjectRoute /> }], {
      initialEntries: [{ pathname: `/p/${first.id}`, state: handed }],
    });
    render(<RouterProvider router={router} />);
    expect(control.openProject).toHaveBeenLastCalledWith(first.id, handed);

    // The upload entry hands the new place over and asks for its upload step.
    const upload = { project: second, entry: 'upload', openUpload: true };
    await act(() => router.navigate(`/p/${second.id}`, { state: upload }));
    expect(control.closeProject).toHaveBeenCalledTimes(1);
    expect(control.openProject).toHaveBeenLastCalledWith(second.id, upload);
    expect(router.state.location.pathname).toBe(`/p/${second.id}`);
    expect(router.state.location.state).toEqual({ entry: 'upload' });

    await act(() => router.navigate(-1));
    expect(control.closeProject).toHaveBeenCalledTimes(2);
    expect(router.state.location.pathname).toBe(`/p/${first.id}`);
    expect(control.openProject).toHaveBeenLastCalledWith(first.id, {
      displayAddress: '1735 Magnolia Ter',
      entry: 'autocomplete',
    });
    expect(control.openProject).toHaveBeenCalledTimes(3);
  });
});

describe('routeStateAfterOpen', () => {
  it('drops the project and the upload request, keeps the rest, and changes nothing else', () => {
    expect(
      routeStateAfterOpen({ project: project(), displayAddress: 'A', entry: 'manual' }),
    ).toEqual({ displayAddress: 'A', entry: 'manual' });
    expect(routeStateAfterOpen({ project: project(), openUpload: true })).toBeNull();
    expect(routeStateAfterOpen({ displayAddress: 'A' })).toBeUndefined();
    expect(routeStateAfterOpen({ saved: true })).toBeUndefined();
    expect(routeStateAfterOpen(null)).toBeUndefined();
    expect(routeStateAfterOpen(undefined)).toBeUndefined();
  });
});
