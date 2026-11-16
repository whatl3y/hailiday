import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadStatus } from '@hailiday/core';
import * as endpoints from '../../api/endpoints';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import { sessionError } from '../../api/errors';
import { allowance, apiError, project } from '../../test/fixtures';
import * as transfer from './transfer';
import { UploadPanel } from './UploadPanel';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

vi.mock('../../api/endpoints', () => ({
  createUpload: vi.fn(),
  completeUpload: vi.fn(),
  getUploadStatus: vi.fn(),
  getProject: vi.fn(),
  putProjectSource: vi.fn(),
}));

vi.mock('./prepare', () => ({
  ACCEPT_ATTRIBUTE: 'image/jpeg',
  browserPrepareDeps: {},
  prepareImage: vi.fn(async () => ({
    ok: true,
    blob: new Blob(['x'], { type: 'image/jpeg' }),
    contentType: 'image/jpeg',
    width: 1600,
    height: 1200,
    clientPrepared: true,
  })),
}));

const READY: UploadStatus = {
  sourceAssetId: '018f0000-0000-7000-8000-bbbbbbbbbbbb',
  state: 'ready',
  holdForReview: false,
  sceneType: 'interior',
  sceneTypeConfidence: 0.95,
  roomType: 'dining_room',
  buildingForm: null,
  multiUnitFacade: false,
  people: { detected: false, boxes: [], suggestedCropBox: null },
  guidance: [],
  detectedFormat: 'jpeg',
  attestationVersion: '2026-11',
  declineCode: null,
  declineReasonClass: null,
  declineReason: null,
  width: 1600,
  height: 1200,
};

vi.mock('./transfer', () => ({
  postToStorage: vi.fn(async () => undefined),
  pollUploadStatus: vi.fn(async () => READY),
}));

const api = vi.mocked(endpoints);

const offSeasonExperience = {
  holidays: [{ id: 'christmas' }, { id: 'halloween' }],
  clientConfig: {
    uploadMaxBytes: 26214400,
    pollUploadMs: 2000,
    retention: { timeBasedDeletion: false },
  },
} as unknown as PublicExperience;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  useAppStore.setState({
    experience: offSeasonExperience,
    clientDefaultHolidayId: null,
    explicitHolidayId: null,
    deepLinkHolidayId: null,
    pickerHolidayIds: ['christmas', 'halloween'],
    attested: true,
  });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  api.createUpload.mockResolvedValue({
    sourceAssetId: READY.sourceAssetId,
    state: 'pending_upload',
    upload: { url: 'http://storage.test', fields: {} } as never,
  });
  api.completeUpload.mockResolvedValue({
    sourceAssetId: READY.sourceAssetId,
    state: 'screening',
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ allowance: null });
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('UploadPanel off-season', () => {
  it('continues on its own once a holiday is chosen for a ready photo', async () => {
    const attached = project({ kind: 'upload', holidayId: 'christmas' });
    api.putProjectSource.mockResolvedValue(attached);
    const onAttached = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <UploadPanel project={project({ kind: 'upload' })} onAttached={onAttached} />
      </MemoryRouter>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'e2e-dining-room.jpg', { type: 'image/jpeg' })] },
    });
    await flush();
    expect(screen.getByText('Choose a holiday above to continue.')).toBeTruthy();
    expect(api.putProjectSource).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Christmas/ }));
    await flush();
    expect(api.putProjectSource).toHaveBeenCalledTimes(1);
    expect(onAttached).toHaveBeenCalledWith(attached);
  });

  it('also continues when the holiday is chosen elsewhere, such as the header chip', async () => {
    api.putProjectSource.mockResolvedValue(project({ kind: 'upload' }));
    const onAttached = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <UploadPanel project={project({ kind: 'upload' })} onAttached={onAttached} />
      </MemoryRouter>,
    );
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] },
    });
    await flush();
    act(() => useAppStore.getState().chooseHoliday('halloween'));
    await flush();
    expect(onAttached).toHaveBeenCalledTimes(1);
  });
});

describe('UploadPanel announcements', () => {
  it('announces the uploading stage once, not every percent', async () => {
    let report: (percent: number) => void = () => undefined;
    vi.mocked(transfer).postToStorage.mockImplementationOnce((_post, _blob, _name, onProgress) => {
      report = onProgress;
      return new Promise(() => undefined);
    });
    const { container } = render(
      <MemoryRouter>
        <UploadPanel project={project({ kind: 'upload' })} onAttached={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] },
    });
    await flush();
    const live = container.querySelector('.upload__status [aria-live="polite"]')!;
    act(() => report(12));
    const first = live.textContent;
    expect(first).toBe('Uploading your photo…');
    act(() => report(13));
    act(() => report(57));
    expect(live.textContent).toBe(first);
    expect(screen.getByText('Uploading… 57%').closest('[aria-hidden="true"]')).not.toBeNull();
  });
});

describe('UploadPanel when the session cannot start', () => {
  function choosePhoto(container: HTMLElement) {
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'photo.jpg', { type: 'image/jpeg' })] },
    });
  }

  it('says the refused start with its wait and retries the same photo after it', async () => {
    vi.useFakeTimers();
    try {
      api.createUpload.mockRejectedValueOnce(
        sessionError(apiError('RATE_LIMITED', { retryAfter: '3' })),
      );
      const { container } = render(
        <MemoryRouter>
          <UploadPanel project={project({ kind: 'upload' })} onAttached={vi.fn()} />
        </MemoryRouter>,
      );
      choosePhoto(container);
      await flush();
      expect(screen.getByRole('alert').textContent).toBe(
        'We need a short breather: lots of visits came from your connection just now. ' +
          'Try again in about 3 seconds.',
      );
      const retry = screen.getByRole('button', { name: 'Try again' });
      expect(retry.getAttribute('aria-disabled')).toBe('true');
      for (let second = 0; second < 3; second += 1) {
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await flush();
      expect(api.createUpload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers "Try again" at once after any other failure to start', async () => {
    api.createUpload.mockRejectedValueOnce(sessionError(new TypeError('Failed to fetch')));
    const { container } = render(
      <MemoryRouter>
        <UploadPanel project={project({ kind: 'upload' })} onAttached={vi.fn()} />
      </MemoryRouter>,
    );
    choosePhoto(container);
    await flush();
    expect(screen.getByRole('alert').textContent).toBe(
      "We couldn't get Hailiday ready for you. Check your connection and try again.",
    );
    expect(
      screen.getByRole('button', { name: 'Try again' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });
});

describe('UploadPanel attestation', () => {
  it('names the Terms inside the checkbox statement, not as a stray word beneath it', () => {
    useAppStore.setState({ attested: false });
    const { container } = render(
      <MemoryRouter>
        <UploadPanel project={project({ kind: 'upload' })} onAttached={vi.fn()} />
      </MemoryRouter>,
    );
    const checkbox = screen.getByRole('checkbox', { name: /18 or older/ });
    const label = checkbox.closest('label')!;
    const terms = screen.getByRole('link', { name: 'Terms' });
    expect(label.contains(terms)).toBe(true);
    expect(terms.getAttribute('href')).toBe('/terms');
    expect(label.textContent).toBe(
      "I'm 18 or older, I have the right to use this photo of this space, and I agree to the Terms.",
    );
    expect(container.querySelector('.attest__links')).toBeNull();
  });
});

describe('UploadPanel with a photo attached but not decorated yet', () => {
  const attachedProject = project({ kind: 'upload', variantCount: 0 });

  function showAttachedProject() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: attachedProject,
      phase: 'upload',
    });
  }

  it('keeps the photo on screen with "Decorate this photo" and says the looks are used up', () => {
    showAttachedProject();
    useAppStore.setState({ allowance: allowance(0), explicitHolidayId: 'christmas' });
    const onAttached = vi.fn();
    render(
      <MemoryRouter>
        <UploadPanel project={attachedProject} onAttached={onAttached} />
      </MemoryRouter>,
    );
    const photo = screen.getByRole<HTMLImageElement>('img', { name: /Your photo/ });
    expect(photo.getAttribute('src')).toBe(attachedProject.activeSource!.displayUrl);
    expect(screen.getByText(/Your place stays here, ready to decorate then\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decorate this photo' }));
    expect(onAttached).toHaveBeenCalledWith(attachedProject);
  });

  it('returns to it after attaching, so a render that cannot start leaves the photo shown', async () => {
    useAppStore.setState({ explicitHolidayId: 'christmas' });
    api.putProjectSource.mockResolvedValue(attachedProject);
    const onAttached = vi.fn(() => {
      useAppStore.setState({ allowance: allowance(0) });
      showAttachedProject();
    });
    const { container } = render(
      <MemoryRouter>
        <UploadPanel
          project={project({ kind: 'upload', activeSource: null })}
          onAttached={onAttached}
        />
      </MemoryRouter>,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'e2e-dining-room.jpg', { type: 'image/jpeg' })] },
    });
    await flush();
    expect(onAttached).toHaveBeenCalledWith(attachedProject);
    expect(screen.queryByText('Checking your photo…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Decorate this photo' })).toBeTruthy();
  });

  it('is not offered while the person replaces the photo', () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: attachedProject,
      phase: 'upload',
      uploadContext: 'replace',
    });
    render(
      <MemoryRouter>
        <UploadPanel project={attachedProject} onAttached={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Decorate this photo' })).toBeNull();
  });
});

describe('UploadPanel at the allowance limit', () => {
  it('says before any upload that a new photo cannot be decorated today', () => {
    useAppStore.setState({ allowance: allowance(0) });
    render(
      <MemoryRouter>
        <UploadPanel
          project={project({ kind: 'upload', activeSource: null })}
          onAttached={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/You've used today's free looks, so a new photo can't be decorated until/),
    ).toBeTruthy();
  });
});

describe('UploadPanel pickers and tips', () => {
  function renderPanel() {
    return render(
      <MemoryRouter>
        <UploadPanel
          project={project({ kind: 'upload', activeSource: null })}
          onAttached={vi.fn()}
        />
      </MemoryRouter>,
    );
  }

  it('draws the library picker beside the solid camera picker as a text link on phones', () => {
    window.matchMedia = ((query: string) => ({
      matches: query === '(pointer: coarse)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    const touch = Object.getOwnPropertyDescriptor(Navigator.prototype, 'maxTouchPoints');
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => 5 });
    try {
      renderPanel();
      const camera = screen.getByText('Take a photo').closest('label')!;
      const library = screen.getByText('Choose from library').closest('label')!;
      expect(camera.className).toContain('button--primary');
      expect(library.className).toContain('button--quiet');
      expect(library.className).not.toContain('button--primary');
    } finally {
      delete (navigator as { maxTouchPoints?: number }).maxTouchPoints;
      if (touch) Object.defineProperty(Navigator.prototype, 'maxTouchPoints', touch);
    }
  });

  it('opens the photo tips with the same chevron as the result rows', () => {
    const { container } = renderPanel();
    const summary = container.querySelector('details.tips > summary')!;
    expect(summary.textContent).toBe('Tips for a great photo');
    expect(summary.querySelector('svg.icon.tips__chevron')).not.toBeNull();
  });
});

describe('UploadPanel as its own screen', () => {
  const freshProject = () => project({ kind: 'upload', activeSource: null });

  function renderScreen(props: Partial<Parameters<typeof UploadPanel>[0]> = {}) {
    return render(
      <MemoryRouter>
        <UploadPanel project={freshProject()} onAttached={vi.fn()} layout="screen" {...props} />
      </MemoryRouter>,
    );
  }

  it('rests the step in a dock on the photograph: heading, picker, collapsed tips, the checkbox', () => {
    const onSurfaceChange = vi.fn();
    const { container } = renderScreen({
      onSurfaceChange,
      lead: <p>lead line</p>,
      trail: <button type="button">Cancel</button>,
    });
    const dock = container.querySelector('.hero-frame.upload-hero .hero-dock.upload--dock')!;
    expect(dock).not.toBeNull();
    expect(dock.querySelector('h1')?.textContent).toBe('Upload a photo of your place');
    expect(dock.querySelector('input[type="file"]')).not.toBeNull();
    expect(dock.querySelector<HTMLDetailsElement>('details.tips')?.open).toBe(false);
    expect(dock.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(dock.firstElementChild?.textContent).toBe('lead line');
    expect(dock.lastElementChild?.textContent).toBe('Cancel');
    expect(container.querySelector('.stage')).toBeNull();
    expect(onSurfaceChange).toHaveBeenLastCalledWith('photo');
  });

  it('shows a chosen photo on a stage edge to edge, its words under it, and says so to the page', async () => {
    vi.mocked(transfer.pollUploadStatus).mockImplementationOnce(() => new Promise(() => undefined));
    const onSurfaceChange = vi.fn();
    const { container } = renderScreen({ onSurfaceChange });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['x'], 'room.jpg', { type: 'image/jpeg' })] },
    });
    await flush();
    expect(container.querySelector('.hero-frame')).toBeNull();
    const staged = container.querySelector<HTMLElement>('.upload--staged.stage-scope')!;
    expect(staged.style.getPropertyValue('--stage-w')).toBe('1600');
    const stage = staged.querySelector<HTMLElement>('.stage.stage--viewport.upload__stage')!;
    const photo = stage.querySelector<HTMLImageElement>('.stage__picture > img.upload__photo')!;
    expect(photo.getAttribute('src')).toBe('blob:preview');
    expect(photo.getAttribute('width')).toBe('1600');
    expect(photo.getAttribute('height')).toBe('1200');
    // An upload may carry its own blurred copy behind it.
    expect(stage.querySelector('.stage__ambient img')?.getAttribute('src')).toBe('blob:preview');
    expect(stage.querySelector('.stage__sheen')).not.toBeNull();
    expect(staged.querySelector('.upload__rail')?.getAttribute('data-state')).toBe('working');
    expect(staged.querySelector('.upload__under .upload__status-text')?.textContent).toBe(
      'Checking your photo…',
    );
    expect(onSurfaceChange).toHaveBeenLastCalledWith('stage');
    // The page keeps one heading, and focus lands on it instead of falling back to the page.
    const heading = staged.querySelector('h1.sr-only');
    expect(heading?.textContent).toBe('Upload a photo of your place');
    expect(document.activeElement).toBe(heading);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'Checking your photo…',
    );
  });

  it('keeps a photo waiting to be decorated on the stage with "Decorate this photo"', () => {
    const attachedProject = project({ kind: 'upload', variantCount: 0 });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: attachedProject,
      phase: 'upload',
    });
    useAppStore.setState({ explicitHolidayId: 'christmas' });
    const onAttached = vi.fn();
    const { container } = renderScreen({ project: attachedProject, onAttached });
    const photo = container.querySelector<HTMLImageElement>('.stage img.upload__photo')!;
    expect(photo.getAttribute('src')).toBe(attachedProject.activeSource!.displayUrl);
    // Another photo can still replace it: the pickers follow, as secondary actions.
    const under = container.querySelector('.upload__under')!;
    const picker = under.querySelector('input[type="file"]')!.closest('label')!;
    expect(picker.className).not.toContain('button--primary');
    expect(under.querySelector('input[type="checkbox"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decorate this photo' }));
    expect(onAttached).toHaveBeenCalledWith(attachedProject);
  });

  it('takes a photo dropped anywhere on the screen', async () => {
    const { container } = renderScreen();
    const target = container.querySelector<HTMLElement>('.upload-screen')!;
    fireEvent.dragOver(target);
    expect(target.hasAttribute('data-dragging')).toBe(true);
    const file = new File(['x'], 'dropped.jpg', { type: 'image/jpeg' });
    fireEvent.drop(target, { dataTransfer: { files: [file] } });
    expect(target.hasAttribute('data-dragging')).toBe(false);
    await flush();
    expect(api.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: freshProject().id }),
      'dropped.jpg',
    );
  });

  it('stays in the column of the screen around it by default', () => {
    const { container } = render(
      <MemoryRouter>
        <UploadPanel project={freshProject()} onAttached={vi.fn()} />
      </MemoryRouter>,
    );
    expect(container.querySelector('.hero-frame, .stage, .upload-step')).toBeNull();
    expect(container.querySelector('.upload.stack .dropzone')).not.toBeNull();
  });
});
