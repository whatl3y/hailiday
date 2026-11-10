import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderStatus } from '@holiday/core';
import * as endpoints from '../../api/endpoints';
import { sessionError } from '../../api/errors';
import type * as sse from '../../api/sse';
import type { RenderSubscriptionHandlers } from '../../api/sse';
import { useAppStore } from '../../state/appStore';
import {
  INITIAL_PROJECT_FLOW,
  lookOf,
  undecoratedUpload,
  useProjectStore,
} from '../../state/projectStore';
import {
  SOURCE_ASSET_ID,
  allowance,
  apiError,
  project,
  renderStatus,
  variant,
} from '../../test/fixtures';
import {
  LOOK_DEBOUNCE_MS,
  cancelPendingLook,
  cancelUpload,
  changeHoliday,
  changeSceneType,
  chooseLook,
  closeProject,
  onUploadAttached,
  openProject,
  requestRender,
  selectView,
  showUpload,
} from './controller';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

vi.mock('../../api/endpoints', () => ({
  createRender: vi.fn(),
  cancelRender: vi.fn(),
  getRender: vi.fn(),
  getProject: vi.fn(),
  listVariants: vi.fn(),
  putProjectSource: vi.fn(),
  putViewpoint: vi.fn(),
  runSourceDiscovery: vi.fn(),
}));

const handlers: Record<string, RenderSubscriptionHandlers> = {};
vi.mock('../../api/sse', async (importOriginal) => ({
  isPermanentRenderError: (await importOriginal<typeof sse>()).isPermanentRenderError,
  subscribeToRender: vi.fn((id: string, h: RenderSubscriptionHandlers) => {
    handlers[id] = h;
    return { close: vi.fn(), mode: 'stream' };
  }),
}));

const api = vi.mocked(endpoints);

function queued(status: RenderStatus) {
  return { ...status, cached: false as const, supersededRenderJobId: null };
}

async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

const current = variant({ createdAt: '2026-11-09T10:00:00.000Z' });
const halloween = variant({ holidayId: 'halloween', createdAt: '2026-11-09T09:00:00.000Z' });

function startOnResult() {
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    projectId: project().id,
    project: project({ variantCount: 2 }),
    phase: 'result',
    variant: current,
    variants: [current, halloween],
    look: lookOf(current),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const key of Object.keys(handlers)) delete handlers[key];
  useAppStore.setState({ allowance: allowance(3), sheet: null, experience: null });
  api.listVariants.mockResolvedValue({
    items: [current, halloween],
    activeRender: null,
    offered: null,
  });
  api.cancelRender.mockImplementation(async (id: string) =>
    renderStatus({ renderJobId: id, state: 'canceled' }),
  );
});

afterEach(() => {
  closeProject();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('changing the look on a result', () => {
  it('switches to a cached variant instantly without a request', () => {
    startOnResult();
    chooseLook({ holidayId: 'halloween' });
    const state = useProjectStore.getState();
    expect(state.variant).toBe(halloween);
    expect(state.pending).toBeNull();
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('plays the first reveal once: returning to the first look does not replay it', () => {
    startOnResult();
    useProjectStore.setState({ revealFor: current.renderAssetId });
    chooseLook({ holidayId: 'halloween' });
    expect(useProjectStore.getState().variant).toBe(halloween);
    expect(useProjectStore.getState().revealFor).toBeNull();
    chooseLook({ holidayId: 'christmas' });
    expect(useProjectStore.getState().variant).toBe(current);
    expect(useProjectStore.getState().revealFor).toBeNull();
  });

  it('opens the allowance sheet instead of a request when no looks remain', async () => {
    startOnResult();
    useAppStore.setState({ allowance: allowance(0) });
    chooseLook({ style: 'abundant' });
    await settle(LOOK_DEBOUNCE_MS * 2);
    expect(useAppStore.getState().sheet).toMatchObject({ kind: 'allowance', scope: 'variants' });
    expect(useProjectStore.getState().pending).toBeNull();
    expect(useProjectStore.getState().variant).toBe(current);
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('keeps the preview under the pending band, then replaces it on success', async () => {
    startOnResult();
    const job = renderStatus({ lightingMode: 'evening', state: 'queued' });
    api.createRender.mockResolvedValue(queued(job));

    chooseLook({ lightingMode: 'evening' });
    expect(useProjectStore.getState().pending?.look.lightingMode).toBe('evening');
    expect(useProjectStore.getState().variant).toBe(current);
    expect(api.createRender).not.toHaveBeenCalled();

    await settle(LOOK_DEBOUNCE_MS);
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'evening',
    });
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(job.renderJobId);
    expect(useProjectStore.getState().phase).toBe('result');

    handlers[job.renderJobId]!.onStatus({ ...job, state: 'rendering', seq: 2 });
    expect(useProjectStore.getState().pending?.render?.state).toBe('rendering');

    const evening = variant({ lightingMode: 'evening', renderJobId: job.renderJobId });
    handlers[job.renderJobId]!.onStatus({
      ...job,
      state: 'succeeded',
      seq: 3,
      variant: evening,
      allowance: allowance(2),
    });
    const state = useProjectStore.getState();
    expect(state.variant).toBe(evening);
    expect(state.pending).toBeNull();
    expect(state.variants.map((item) => item.renderAssetId)).toContain(evening.renderAssetId);
    expect(state.revealFor).toBeNull();
    expect(useAppStore.getState().allowance?.variants.remaining).toBe(2);
  });

  it('coalesces rapid taps into one request for the latest look', async () => {
    startOnResult();
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'subtle' })));
    chooseLook({ style: 'abundant' });
    await settle(LOOK_DEBOUNCE_MS / 2);
    chooseLook({ style: 'subtle' });
    await settle(LOOK_DEBOUNCE_MS);
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({ style: 'subtle' });
  });

  it('keeps the current preview and opens the error sheet when the new look fails', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ style: 'abundant' });
    await settle(LOOK_DEBOUNCE_MS);
    handlers[job.renderJobId]!.onStatus({
      ...job,
      state: 'rejected',
      seq: 2,
      rejectionReason: 'qa_critical',
    });
    const state = useProjectStore.getState();
    expect(state.variant).toBe(current);
    expect(state.pending).toBeNull();
    expect(state.pendingError?.state).toBe('rejected');
    expect(state.look).toEqual(lookOf(current));
  });

  it('cancels a pending look and returns the controls to the preview on screen', async () => {
    startOnResult();
    const job = renderStatus({ style: 'subtle' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ style: 'subtle' });
    await settle(LOOK_DEBOUNCE_MS);
    await cancelPendingLook();
    expect(api.cancelRender).toHaveBeenCalledWith(job.renderJobId);
    expect(useProjectStore.getState().pending).toBeNull();
    expect(useProjectStore.getState().look).toEqual(lookOf(current));
  });
});

describe('the first render of a project', () => {
  function onUploadStep() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ kind: 'upload', variantCount: 0 }),
      phase: 'upload',
    });
  }

  it('keeps an uploaded photo on screen when the allowance is used up, without a request', async () => {
    onUploadStep();
    useAppStore.setState({ allowance: allowance(0) });
    await requestRender();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(useAppStore.getState().sheet).toMatchObject({ kind: 'allowance', scope: 'variants' });
    const state = useProjectStore.getState();
    expect(state.phase).toBe('upload');
    expect(undecoratedUpload(state)?.sourceAssetId).toBe(SOURCE_ASSET_ID);
  });

  it('keeps an uploaded photo on screen when the server refuses its first look', async () => {
    onUploadStep();
    api.createRender.mockRejectedValue(
      apiError('ALLOWANCE_EXHAUSTED', {
        details: { scope: 'variants', resetsAt: null, permittedActions: ['wait_for_reset'] },
      }),
    );
    await requestRender();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().sheet).toMatchObject({ kind: 'allowance', scope: 'variants' });
    const state = useProjectStore.getState();
    expect(state.phase).toBe('upload');
    expect(state.inlineError).toBeNull();
    expect(undecoratedUpload(state)?.sourceAssetId).toBe(SOURCE_ASSET_ID);
  });

  it('waits on the waiting screen, then reveals the first preview', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    const job = renderStatus({ state: 'queued' });
    api.createRender.mockResolvedValue(queued(job));
    api.listVariants.mockResolvedValue({ items: [], activeRender: null, offered: null });

    await requestRender({
      look: { holidayId: 'christmas', style: 'classic', lightingMode: 'source' },
    });
    expect(useProjectStore.getState().phase).toBe('waiting');
    expect(api.createRender.mock.calls[0]![1]).toMatch(/^[0-9a-f-]{36}$/);

    handlers[job.renderJobId]!.onStatus({
      ...job,
      state: 'planning',
      stageLabelKey: 'stage.planning',
      seq: 2,
    });
    expect(useProjectStore.getState().render?.state).toBe('planning');

    const first = variant();
    handlers[job.renderJobId]!.onStatus({ ...job, state: 'succeeded', seq: 3, variant: first });
    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(first);
    expect(state.revealFor).toBe(first.renderAssetId);
    expect(state.look).toEqual(lookOf(first));
  });

  it('shows a cached variant at once from a 200 response', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    const cached = variant();
    api.createRender.mockResolvedValue({ cached: true, variant: cached, allowance: allowance(5) });
    await requestRender();
    expect(useProjectStore.getState().phase).toBe('result');
    expect(useProjectStore.getState().variant).toBe(cached);
  });
});

describe('variants of another source', () => {
  it('never switches to a look made from a replaced photo', async () => {
    const oldPhoto = variant({
      holidayId: 'halloween',
      sourceAssetId: '018f0000-0000-7000-8000-cccccccccccc',
    });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 2 }),
      phase: 'result',
      variant: current,
      variants: [current, oldPhoto],
      look: lookOf(current),
    });
    api.createRender.mockResolvedValue(queued(renderStatus({ holidayId: 'halloween' })));
    chooseLook({ holidayId: 'halloween' });
    expect(useProjectStore.getState().variant).toBe(current);
    expect(useProjectStore.getState().pending?.look.holidayId).toBe('halloween');
    await settle(LOOK_DEBOUNCE_MS);
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(current.sourceAssetId).toBe(SOURCE_ASSET_ID);
  });
});

describe('opening a project link', () => {
  it('shows the not-found screen for an id that is not a UUID, without a request', async () => {
    await openProject('abc123', null);
    expect(useProjectStore.getState().phase).toBe('not_found');
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it('shows the not-found screen when the API rejects the id as invalid', async () => {
    api.getProject.mockRejectedValue(apiError('VALIDATION_FAILED'));
    await openProject(project().id, null);
    expect(useProjectStore.getState().phase).toBe('not_found');
  });

  it('says a refused session start with a "Try again" that waits out Retry-After', async () => {
    api.getProject.mockRejectedValueOnce(
      sessionError(apiError('RATE_LIMITED', { retryAfter: '45' })),
    );
    await openProject(project().id, null);
    const state = useProjectStore.getState();
    expect(state.phase).toBe('error');
    expect(state.inlineError).toBe(
      'We need a short breather: lots of visits came from your connection just now. ' +
        'Try again in about 45 seconds.',
    );
    expect(state.inlineRetry?.retryAfterSeconds).toBe(45);

    api.getProject.mockResolvedValueOnce(project({ variantCount: 0 }));
    state.inlineRetry?.retry();
    await vi.waitFor(() => expect(api.getProject).toHaveBeenCalledTimes(2));
  });
});

describe('the upload step inside a project', () => {
  it('Cancel returns to the result it replaced, with the preview intact', () => {
    startOnResult();
    showUpload('replace');
    expect(useProjectStore.getState().phase).toBe('upload');
    expect(useProjectStore.getState().uploadReturnPhase).toBe('result');
    cancelUpload();
    expect(useProjectStore.getState().phase).toBe('result');
    expect(useProjectStore.getState().variant).toBe(current);
  });

  it('keeps a replacement photo on screen at the allowance limit, and Cancel shows the newest preview', async () => {
    startOnResult();
    showUpload('replace');
    useAppStore.setState({ allowance: allowance(0) });
    const replacement = project({
      variantCount: 2,
      allowance: allowance(0),
      activeSource: {
        ...project().activeSource!,
        sourceAssetId: '018f0000-0000-7000-8000-cccccccccccc',
        displayUrl: 'https://cdn.test/replacement.jpg',
      },
    });
    await onUploadAttached(replacement);

    expect(api.createRender).not.toHaveBeenCalled();
    expect(useAppStore.getState().sheet).toMatchObject({ kind: 'allowance', scope: 'variants' });
    const attached = useProjectStore.getState();
    expect(attached.phase).toBe('upload');
    expect(attached.uploadContext).toBe('project');
    expect(undecoratedUpload(attached)?.displayUrl).toBe('https://cdn.test/replacement.jpg');
    expect(attached.uploadReturnPhase).toBe('result');

    cancelUpload();
    const back = useProjectStore.getState();
    expect(back.phase).toBe('result');
    expect(back.variant).toBe(current);
    expect(back.look).toEqual(lookOf(current));
    expect(back.revealFor).toBeNull();
    expect(back.uploadReturnPhase).toBeNull();
  });

  it('keeps a replacement photo on screen when the server refuses its first look', async () => {
    startOnResult();
    showUpload('replace');
    api.createRender.mockRejectedValue(
      apiError('ALLOWANCE_EXHAUSTED', {
        details: { scope: 'variants', resetsAt: null, permittedActions: ['wait_for_reset'] },
      }),
    );
    const replacement = project({
      variantCount: 2,
      activeSource: {
        ...project().activeSource!,
        sourceAssetId: '018f0000-0000-7000-8000-cccccccccccc',
        displayUrl: 'https://cdn.test/replacement.jpg',
      },
    });
    await onUploadAttached(replacement);

    expect(api.createRender).toHaveBeenCalledTimes(1);
    const attached = useProjectStore.getState();
    expect(attached.phase).toBe('upload');
    expect(undecoratedUpload(attached)?.displayUrl).toBe('https://cdn.test/replacement.jpg');
    cancelUpload();
    expect(useProjectStore.getState().phase).toBe('result');
    expect(useProjectStore.getState().variant).toBe(current);
  });

  it('offers no Cancel when nothing was on screen before', () => {
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: project(), phase: 'waiting' });
    showUpload('replace');
    expect(useProjectStore.getState().uploadReturnPhase).toBeNull();
  });
});

describe('No Street View after discovery', () => {
  it('opens the No Street View screen when a view load finds the panorama gone', async () => {
    const candidate = {
      candidateId: 'c-2',
      isPrimary: false,
      displayUrl: null,
    } as unknown as ReturnType<typeof useProjectStore.getState>['candidates'][number];
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ kind: 'address' }),
      phase: 'confirm',
      candidates: [candidate],
      baseCandidateIds: ['c-2'],
      remainingDisplayLoads: 3,
    });
    api.putViewpoint.mockRejectedValue(apiError('NO_STREET_VIEW'));
    await selectView('c-2');
    expect(useProjectStore.getState().phase).toBe('nosv');
    expect(useProjectStore.getState().nosvCause).toBe('NO_STREET_VIEW');
  });

  it('opens the No Street View screen with its line when a render needs a photo', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ kind: 'address', variantCount: 0 }),
      phase: 'confirm',
    });
    api.createRender.mockRejectedValue(apiError('NEEDS_PHOTO'));
    await requestRender();
    expect(useProjectStore.getState().phase).toBe('nosv');
    expect(useProjectStore.getState().nosvCause).toBe('NEEDS_PHOTO');
  });
});

describe('a render the bot check still refuses', () => {
  it('shows the verification line on the confirm screen and asks no further', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ kind: 'address', variantCount: 0 }),
      phase: 'confirm',
    });
    api.createRender.mockRejectedValue(apiError('VERIFICATION_REQUIRED'));
    await requestRender();
    await settle(10_000);
    expect(api.createRender).toHaveBeenCalledTimes(1);
    const { inlineError, phase } = useProjectStore.getState();
    expect(phase).toBe('confirm');
    expect(inlineError).toBe("Quick check: confirm you're a person to continue.");
  });
});

describe('rate limits', () => {
  it('offers Try again after the wait when a render request is rate limited', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ kind: 'address', variantCount: 0 }),
      phase: 'confirm',
    });
    api.createRender.mockRejectedValueOnce(apiError('RATE_LIMITED', { retryAfter: '12' }));
    await requestRender();
    const { inlineError, inlineRetry, phase } = useProjectStore.getState();
    expect(phase).toBe('confirm');
    expect(inlineError).toContain('moving fast');
    expect(inlineRetry?.retryAfterSeconds).toBe(12);
    api.createRender.mockResolvedValue(queued(renderStatus()));
    inlineRetry!.retry();
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });
});

describe('changing the holiday while the first render runs', () => {
  it('requests the new holiday so the result matches the chip', async () => {
    const running = renderStatus({ holidayId: 'christmas', state: 'rendering' });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'waiting',
      render: running,
    });
    const next = renderStatus({ holidayId: 'halloween', state: 'queued' });
    api.createRender.mockResolvedValue(queued(next));
    api.listVariants.mockResolvedValue({ items: [], activeRender: null, offered: null });
    changeHoliday('halloween');
    await settle();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({ holidayId: 'halloween' });
    const decorated = variant({ holidayId: 'halloween', renderJobId: next.renderJobId });
    handlers[next.renderJobId]!.onStatus({
      ...next,
      state: 'succeeded',
      seq: 2,
      variant: decorated,
    });
    expect(useProjectStore.getState().variant).toBe(decorated);
  });

  it('waits for an in-flight first request, then requests the new holiday', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    const first = renderStatus({ holidayId: 'christmas' });
    let answer: (value: ReturnType<typeof queued>) => void = () => undefined;
    api.createRender.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as typeof answer)),
    );
    const pending = requestRender();
    expect(useProjectStore.getState().phase).toBe('starting');
    changeHoliday('halloween');
    expect(api.createRender).toHaveBeenCalledTimes(1);
    api.createRender.mockResolvedValue(queued(renderStatus({ holidayId: 'halloween' })));
    answer(queued(first));
    await pending;
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({ holidayId: 'halloween' });
  });
});

describe('correcting the scene type after a result', () => {
  function uploadResult() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ kind: 'upload', sceneType: 'house_exterior', variantCount: 1 }),
      phase: 'result',
      variant: current,
      variants: [current],
      look: lookOf(current),
    });
  }

  it('re-attaches the photo with the new type, then decorates the current look again', async () => {
    uploadResult();
    const child = project({
      kind: 'upload',
      sceneType: 'balcony',
      projectVersion: 4,
      activeSource: {
        ...project().activeSource!,
        sourceAssetId: '018f0000-0000-7000-8000-dddddddddddd',
      },
    });
    api.putProjectSource.mockResolvedValue(child);
    api.createRender.mockResolvedValue(queued(renderStatus()));
    await changeSceneType({ sceneType: 'balcony', roomType: null });
    expect(api.putProjectSource).toHaveBeenCalledWith(project().id, {
      projectVersion: 3,
      sourceAssetId: SOURCE_ASSET_ID,
      sceneType: 'balcony',
      roomType: null,
    });
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      projectVersion: 4,
      holidayId: 'christmas',
    });
    expect(useProjectStore.getState().variant).toBe(current);
  });

  it('refreshes once and retries when the project changed elsewhere', async () => {
    uploadResult();
    api.putProjectSource
      .mockRejectedValueOnce(apiError('STALE_PROJECT_VERSION'))
      .mockResolvedValueOnce(project({ kind: 'upload', sceneType: 'balcony', projectVersion: 6 }));
    api.getProject.mockResolvedValue(project({ kind: 'upload', projectVersion: 5 }));
    api.createRender.mockResolvedValue(queued(renderStatus()));
    await changeSceneType({ sceneType: 'balcony', roomType: null });
    expect(api.putProjectSource).toHaveBeenCalledTimes(2);
    expect(api.putProjectSource.mock.calls[1]![1]).toMatchObject({ projectVersion: 5 });
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });
});

describe('a render that disappears', () => {
  it('leaves the waiting screen for not-found when the job is gone', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    const job = renderStatus();
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    expect(useProjectStore.getState().phase).toBe('waiting');
    handlers[job.renderJobId]!.onError!(apiError('NOT_FOUND'));
    expect(useProjectStore.getState().phase).toBe('not_found');
  });

  it('keeps waiting through a failure that is not a lost job', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    const job = renderStatus();
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    handlers[job.renderJobId]!.onError!(apiError('VERIFICATION_REQUIRED'));
    expect(useProjectStore.getState().phase).toBe('waiting');
  });
});
