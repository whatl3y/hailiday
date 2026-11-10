import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UploadStatus } from '@holiday/core';
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
  clientConfig: { uploadMaxBytes: 26214400, pollUploadMs: 2000 },
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
      "We couldn't get Holiday ready for you. Check your connection and try again.",
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
