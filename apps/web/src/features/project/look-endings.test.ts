import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Discovery, RenderStatus, Variant } from '@hailiday/core';
import * as endpoints from '../../api/endpoints';
import type * as sse from '../../api/sse';
import type { RenderSubscriptionHandlers } from '../../api/sse';
import { useAppStore } from '../../state/appStore';
import { INITIAL_PROJECT_FLOW, lookOf, useProjectStore } from '../../state/projectStore';
import {
  SOURCE_ASSET_ID,
  allowance,
  apiError,
  project,
  renderStatus,
  variant,
} from '../../test/fixtures';
import {
  cancelPendingLook,
  cancelRender,
  changeHoliday,
  chooseLook,
  closeProject,
  notYourPlace,
  openProject,
  requestRender,
  retryLight,
  retryRender,
} from './controller';
import { dismissLightFallback, useLightFallback } from './lookFallback';

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

function emit(status: RenderStatus) {
  const handler = handlers[status.renderJobId];
  if (!handler) throw new Error(`the page does not follow ${status.renderJobId}`);
  handler.onStatus(status);
}

function lightFallbackId(): string | null {
  return useLightFallback.getState().fallback?.renderAssetId ?? null;
}

const rejected = { state: 'rejected', seq: 9, rejectionReason: 'qa_critical' } as const;

/** A Street View source of an address place, as the API answers it. */
const streetSource = {
  ...project().activeSource!,
  kind: 'street_view' as const,
  sourceMode: 'persist' as const,
  isGoogleImagery: true,
  displayUrl: 'https://cdn.test/wide.jpg',
  width: 640,
  height: 640,
};

/** An address place with its street photo ready and no look yet. */
const place = project({
  kind: 'address',
  variantCount: 0,
  activeSource: streetSource,
  activeRenderJobId: null,
  lightingMode: 'source',
});

/** An auto-start discovery with its source bound: on its own it would start a look. */
function autoStartDiscovery(): Discovery {
  return {
    discoveryId: '018f0000-0000-7000-8000-dddddddddddd',
    projectVersion: 4,
    entryMethod: 'autocomplete',
    matchClass: 'auto_start',
    reason: null,
    retryable: false,
    sourceMode: 'persist',
    thresholdsVersion: 'test',
    sourceAssetId: SOURCE_ASSET_ID,
    remainingDisplayLoads: 3,
    candidates: [
      {
        candidateId: 'c-1',
        isPrimary: true,
        rank: 1,
        displayUrl: 'https://cdn.test/c-1.jpg',
        heading: 90,
        headingMode: 'geometry',
        pitch: 0,
        fov: 80,
        captureDate: null,
        captureGranularity: 'month',
        copyright: '© 2026 Google',
        isGoogleImagery: true,
        distanceMeters: 12,
        estimatedFacadePx: null,
        flags: [],
        width: 640,
        height: 640,
      },
    ],
    attribution: { logo: 'google_maps', required: true },
    nextAction: 'render',
  };
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

/** The place on the confirm screen, before its first look. */
function onConfirm(target = place) {
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    projectId: target.id,
    project: target,
    phase: 'confirm',
  });
}

/** A reload: the module state is gone and the project is read again from the API. */
async function reload(answer = place) {
  closeProject();
  api.getProject.mockResolvedValue(answer);
  await openProject(answer.id, null);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
  for (const key of Object.keys(handlers)) delete handlers[key];
  for (const mock of [
    api.createRender,
    api.cancelRender,
    api.getRender,
    api.getProject,
    api.listVariants,
    api.runSourceDiscovery,
  ]) {
    mock.mockReset();
  }
  useAppStore.setState({ allowance: allowance(3), sheet: null, experience: null });
  api.listVariants.mockResolvedValue({
    items: [current, halloween],
    activeRender: null,
    offered: null,
  });
  api.getProject.mockResolvedValue(place);
  api.runSourceDiscovery.mockResolvedValue({
    project: { ...place, projectVersion: 4 },
    discovery: autoStartDiscovery(),
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

describe('a first look that ends in its notice', () => {
  /** The person asks once; the look and the page's own second pass end without a picture. */
  async function endsUnfinished(target = place) {
    onConfirm(target);
    const jobs = [renderStatus(), renderStatus()];
    for (const job of jobs) api.createRender.mockResolvedValueOnce(queued(job));
    api.listVariants.mockResolvedValue({ items: [], activeRender: null, offered: null });
    await requestRender();
    emit({ ...jobs[0]!, ...rejected });
    await settle();
    emit({ ...jobs[1]!, ...rejected });
    await settle();
    expect(useProjectStore.getState().phase).toBe('render_error');
    expect(api.createRender).toHaveBeenCalledTimes(2);
  }

  it('starts nothing on a reload, however many: the view to confirm opens instead', async () => {
    await endsUnfinished();
    for (let count = 0; count < 3; count += 1) {
      await reload();
      const state = useProjectStore.getState();
      expect(state.phase).toBe('confirm');
      expect(state.autoStarted).toBe(false);
    }
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('opens an uploaded photo again on the upload step, starting nothing', async () => {
    const uploaded = project({ kind: 'upload', variantCount: 0 });
    await endsUnfinished(uploaded);
    await reload(uploaded);
    await reload(uploaded);
    expect(useProjectStore.getState().phase).toBe('upload');
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('starts nothing on a reload after "Try again" was refused', async () => {
    await endsUnfinished();
    api.createRender.mockRejectedValueOnce(apiError('RATE_LIMITED', { retryAfter: '30' }));
    retryRender();
    await settle();
    expect(useProjectStore.getState().phase).toBe('render_error');
    expect(api.createRender).toHaveBeenCalledTimes(3);
    await reload();
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(api.createRender).toHaveBeenCalledTimes(3);
  });

  it('starts by itself again once the person asked for a look the server took on', async () => {
    await endsUnfinished();
    const again = renderStatus();
    api.createRender.mockResolvedValue(queued(again));
    retryRender();
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(3);
    await reload();
    expect(api.createRender).toHaveBeenCalledTimes(4);
  });
});

describe("the page's own second pass after a reload", () => {
  it('keeps its hint on a first look and ends in the notice, never a third request', async () => {
    onConfirm();
    const jobs = [renderStatus(), renderStatus()];
    for (const job of jobs) api.createRender.mockResolvedValueOnce(queued(job));
    await requestRender();
    emit({ ...jobs[0]!, ...rejected });
    await settle();
    expect(useProjectStore.getState().secondPass).toBe(true);
    expect(api.createRender).toHaveBeenCalledTimes(2);

    const second = { ...jobs[1]!, state: 'rendering' as const, seq: 4 };
    api.getRender.mockResolvedValue(second);
    await reload({ ...place, activeRenderJobId: second.renderJobId });
    let state = useProjectStore.getState();
    expect(state.phase).toBe('waiting');
    expect(state.secondPass).toBe(true);

    emit({ ...second, ...rejected });
    await settle();
    state = useProjectStore.getState();
    expect(state.phase).toBe('render_error');
    expect(state.render?.renderJobId).toBe(second.renderJobId);
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('keeps its hint on another look and ends in the notice under the preview', async () => {
    const withLook = project({ variantCount: 1, activeSource: streetSource });
    api.listVariants.mockResolvedValue({ items: [current], activeRender: null, offered: null });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: withLook.id,
      project: withLook,
      phase: 'result',
      variant: current,
      variants: [current],
      look: lookOf(current),
    });
    const jobs = [renderStatus({ style: 'abundant' }), renderStatus({ style: 'abundant' })];
    for (const job of jobs) api.createRender.mockResolvedValueOnce(queued(job));
    chooseLook({ style: 'abundant' });
    await settle();
    emit({ ...jobs[0]!, ...rejected });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);

    const second = { ...jobs[1]!, state: 'rendering' as const, seq: 4 };
    api.getRender.mockResolvedValue(second);
    await reload({ ...withLook, activeRenderJobId: second.renderJobId });
    let state = useProjectStore.getState();
    expect(state.pending?.render?.renderJobId).toBe(second.renderJobId);
    expect(state.secondPass).toBe(true);

    emit({ ...second, ...rejected });
    await settle();
    state = useProjectStore.getState();
    expect(state.pendingError?.renderJobId).toBe(second.renderJobId);
    expect(state.secondPass).toBe(false);
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('is not taken for a look the page resumed that the person asked for', async () => {
    onConfirm();
    const job = renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    const again = renderStatus();
    api.createRender.mockResolvedValue(queued(again));
    api.getRender.mockResolvedValue(job);
    await reload({ ...place, activeRenderJobId: job.renderJobId });
    expect(useProjectStore.getState().secondPass).toBe(false);
    emit({ ...job, ...rejected });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().secondPass).toBe(true);
  });
});

describe('the looks read again when a look in the making ends without a new picture', () => {
  const WIDE = 'https://cdn.test/before-wide.jpg';

  /** The place's looks as the server answers them once a job changed the stored frame. */
  function wideBefores() {
    api.listVariants.mockResolvedValue({
      items: [
        { ...current, beforeImageUrl: WIDE },
        { ...halloween, beforeImageUrl: WIDE },
      ],
      activeRender: null,
      offered: null,
    });
  }

  function expectWideBefores() {
    const state = useProjectStore.getState();
    expect(state.variant?.renderAssetId).toBe(current.renderAssetId);
    expect(state.variant?.beforeImageUrl).toBe(WIDE);
    expect(state.variant?.imageUrl).toBe(current.imageUrl);
    chooseLook({ holidayId: 'halloween' });
    expect(useProjectStore.getState().variant?.renderAssetId).toBe(halloween.renderAssetId);
    expect(useProjectStore.getState().variant?.beforeImageUrl).toBe(WIDE);
  }

  async function anotherLookRunning() {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValueOnce(queued(job));
    chooseLook({ style: 'abundant' });
    await settle();
    emit({ ...job, state: 'preparing', seq: 2, stageLabelKey: 'stage.framing' });
    emit({ ...job, state: 'analyzing', seq: 3, stageLabelKey: 'stage.planning' });
    wideBefores();
    return job;
  }

  it('after Cancel', async () => {
    await anotherLookRunning();
    await cancelPendingLook();
    await settle();
    expectWideBefores();
  });

  it('after a cancel from another tab or device', async () => {
    const job = await anotherLookRunning();
    emit({ ...job, state: 'canceled', seq: 4 });
    await settle();
    expect(useProjectStore.getState().pending).toBeNull();
    expectWideBefores();
  });

  it('after the job was replaced with no successor', async () => {
    const job = await anotherLookRunning();
    emit({ ...job, state: 'superseded', seq: 4, supersededByRenderJobId: null });
    await settle();
    expect(useProjectStore.getState().pending).toBeNull();
    expectWideBefores();
  });

  it('after the look ends in its notice', async () => {
    const job = await anotherLookRunning();
    const again = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValueOnce(queued(again));
    api.listVariants.mockResolvedValue({
      items: [current, halloween],
      activeRender: null,
      offered: null,
    });
    emit({ ...job, ...rejected });
    await settle();
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(again.renderJobId);
    wideBefores();
    emit({ ...again, ...rejected });
    await settle();
    expect(useProjectStore.getState().pendingError?.renderJobId).toBe(again.renderJobId);
    expectWideBefores();
  });

  it("after the look arrives in the photo's own light", async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    api.createRender.mockResolvedValueOnce(queued(job));
    chooseLook({ style: 'abundant', lightingMode: 'evening' });
    await settle();
    api.listVariants.mockResolvedValue({
      items: [daylight, { ...current }, { ...halloween, beforeImageUrl: WIDE }],
      activeRender: null,
      offered: null,
    });
    emit({ ...job, ...rejected, variant: daylight });
    await settle();
    expect(useProjectStore.getState().variant).toBe(daylight);
    chooseLook({ holidayId: 'halloween', style: 'classic', lightingMode: 'source' });
    expect(useProjectStore.getState().variant?.renderAssetId).toBe(halloween.renderAssetId);
    expect(useProjectStore.getState().variant?.beforeImageUrl).toBe(WIDE);
  });

  it('reads nothing for a first look with no picture on screen', async () => {
    onConfirm();
    const job = renderStatus();
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    api.listVariants.mockClear();
    await cancelRender();
    await settle();
    expect(api.listVariants).not.toHaveBeenCalled();
    expect(useProjectStore.getState().variant).toBeNull();
  });
});

describe('the read after a relit look ended without its light', () => {
  it('starts nothing when the person cancels a first look during it', async () => {
    onConfirm();
    const job = renderStatus({ lightingMode: 'evening' });
    api.createRender
      .mockResolvedValueOnce(queued(job))
      .mockResolvedValueOnce(queued(renderStatus()));
    let answer: (value: Awaited<ReturnType<typeof endpoints.listVariants>>) => void = () =>
      undefined;
    await requestRender({
      look: { holidayId: 'christmas', style: 'classic', lightingMode: 'evening' },
    });
    emit({ ...job, state: 'rendering', seq: 3 });
    api.listVariants.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    emit({ ...job, ...rejected });
    api.runSourceDiscovery.mockRejectedValue(new Error('offline'));
    await cancelRender();
    const left = useProjectStore.getState().phase;
    answer({ items: [], activeRender: null, offered: null });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().phase).toBe(left);
    expect(useProjectStore.getState().secondPass).toBe(false);
  });

  it('shows no picture and no line when the person cancels another look during it', async () => {
    startOnResult();
    const job = renderStatus({ lightingMode: 'evening' });
    api.createRender.mockResolvedValueOnce(queued(job));
    chooseLook({ lightingMode: 'evening' });
    await settle();
    let answer: (value: Awaited<ReturnType<typeof endpoints.listVariants>>) => void = () =>
      undefined;
    api.listVariants.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    emit({ ...job, ...rejected });
    await cancelPendingLook();
    answer({ items: [current, halloween], activeRender: null, offered: null });
    await settle();
    const state = useProjectStore.getState();
    expect(state.variant?.renderAssetId).toBe(current.renderAssetId);
    expect(state.pending).toBeNull();
    expect(state.pendingError).toBeNull();
    expect(lightFallbackId()).toBeNull();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });
});

describe('the second pass and its limits', () => {
  it('shows the notice, not the allowance sheet, when the looks ran out meanwhile', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValueOnce(queued(job));
    chooseLook({ style: 'abundant' });
    await settle();
    emit({ ...job, ...rejected, allowance: allowance(0) });
    await settle();
    const state = useProjectStore.getState();
    expect(state.pendingError?.renderJobId).toBe(job.renderJobId);
    expect(state.pending).toBeNull();
    expect(useAppStore.getState().sheet).toBeNull();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('makes the second pass of a first look that ended while the page loaded over a preview as another look', async () => {
    const job = renderStatus({ style: 'abundant' });
    const again = renderStatus({ style: 'abundant' });
    api.listVariants.mockResolvedValue({ items: [current], activeRender: null, offered: null });
    api.getRender.mockResolvedValue({ ...job, ...rejected });
    api.createRender.mockResolvedValueOnce(queued(again));
    await reload(project({ variantCount: 1, activeRenderJobId: job.renderJobId }));
    const state = useProjectStore.getState();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({ style: 'abundant' });
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(current);
    expect(state.pending?.render?.renderJobId).toBe(again.renderJobId);
    expect(state.secondPass).toBe(true);
  });
});

describe('a cancel remembered for the tab', () => {
  const memory = () => window.sessionStorage.getItem(`hailiday.canceledFirstLook:${project().id}`);

  function firstLookOverPreview(job: RenderStatus) {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 1 }),
      phase: 'waiting',
      variant: current,
      variants: [current],
      render: job,
    });
  }

  it('is not kept when Cancel leaves for a preview on screen', async () => {
    firstLookOverPreview(renderStatus({ state: 'rendering' }));
    await cancelRender();
    expect(useProjectStore.getState().phase).toBe('result');
    expect(memory()).toBeNull();
  });

  it('is not kept when a cancel from elsewhere leaves for a preview on screen', async () => {
    const job = renderStatus({ state: 'rendering' });
    api.getRender.mockResolvedValue({ ...job, state: 'canceled' });
    await reload(project({ variantCount: 1, activeRenderJobId: job.renderJobId }));
    expect(useProjectStore.getState().phase).toBe('result');
    expect(memory()).toBeNull();
  });

  it('is kept when Cancel leaves a first look with nothing on screen', async () => {
    onConfirm(project({ variantCount: 0 }));
    api.createRender.mockResolvedValue(queued(renderStatus()));
    await requestRender();
    await cancelRender();
    expect(memory()).toBe('1');
  });
});

describe('"Not your place?" while the second pass is being asked for', () => {
  it('stays on the view to confirm and cancels the job the request made', async () => {
    const job = renderStatus();
    const again = renderStatus();
    let answer: (value: ReturnType<typeof queued>) => void = () => undefined;
    api.createRender
      .mockResolvedValueOnce(queued(job))
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: place.id,
      project: place,
      phase: 'finding',
      autoStarted: true,
    });
    await requestRender();
    emit({ ...job, state: 'rendering', seq: 3 });
    emit({ ...job, ...rejected });
    expect(useProjectStore.getState().phase).toBe('starting');
    expect(useProjectStore.getState().secondPass).toBe(true);

    await notYourPlace();
    await settle();
    expect(useProjectStore.getState().phase).toBe('confirm');
    answer(queued(again));
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('confirm');
    expect(state.autoStarted).toBe(false);
    expect(handlers[again.renderJobId]).toBeUndefined();
    expect(api.cancelRender).toHaveBeenCalledWith(again.renderJobId);
    expect(api.createRender).toHaveBeenCalledTimes(2);

    await reload();
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('shows no notice when that request is refused after the person left', async () => {
    const job = renderStatus();
    let refuse: (error: unknown) => void = () => undefined;
    api.createRender
      .mockResolvedValueOnce(queued(job))
      .mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)));
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: place.id,
      project: place,
      phase: 'finding',
      autoStarted: true,
    });
    await requestRender();
    emit({ ...job, ...rejected });
    await notYourPlace();
    await settle();
    refuse(apiError('RATE_LIMITED'));
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('confirm');
    expect(state.inlineError).toBeNull();
  });
});

describe('a tap on a control already selected', () => {
  it('starts nothing on a plain result', async () => {
    startOnResult();
    chooseLook({ style: current.style });
    chooseLook({ lightingMode: current.lightingMode });
    changeHoliday(current.holidayId);
    await settle();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(useProjectStore.getState().variant).toBe(current);
  });

  it('starts nothing while the daylight look stands in for the evening look, line or not', async () => {
    startOnResult();
    const evening = renderStatus({ lightingMode: 'evening' });
    api.createRender.mockResolvedValueOnce(queued(evening));
    chooseLook({ lightingMode: 'evening' });
    await settle();
    emit({ ...evening, ...rejected, variant: current });
    await settle();
    expect(lightFallbackId()).toBe(current.renderAssetId);
    expect(api.createRender).toHaveBeenCalledTimes(1);

    chooseLook({ style: current.style });
    changeHoliday(current.holidayId);
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(lightFallbackId()).toBe(current.renderAssetId);

    dismissLightFallback();
    chooseLook({ style: current.style });
    changeHoliday(current.holidayId);
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('still asks for the evening light from the lighting control', async () => {
    startOnResult();
    const evening = renderStatus({ lightingMode: 'evening' });
    const again = renderStatus({ lightingMode: 'evening' });
    api.createRender.mockResolvedValueOnce(queued(evening)).mockResolvedValueOnce(queued(again));
    chooseLook({ lightingMode: 'evening' });
    await settle();
    emit({ ...evening, ...rejected, variant: current });
    await settle();
    chooseLook({ lightingMode: 'evening' });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({ lightingMode: 'evening' });
  });
});

describe('a place opened in a tab that did not see its relit look end', () => {
  function opened(overrides: Parameters<typeof project>[0], items: Variant[]) {
    api.listVariants.mockResolvedValue({ items, activeRender: null, offered: null });
    return reload(project(overrides));
  }

  it('opens the daylight look with the line and the evening light again as its action', async () => {
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    const other = variant({ style: 'subtle', createdAt: '2026-11-10T10:00:00.000Z' });
    await opened({ variantCount: 2, style: 'abundant', lightingMode: 'evening' }, [
      other,
      daylight,
    ]);
    expect(useProjectStore.getState().phase).toBe('result');
    expect(useProjectStore.getState().variant?.renderAssetId).toBe(daylight.renderAssetId);
    expect(useLightFallback.getState().fallback).toEqual({
      renderAssetId: daylight.renderAssetId,
      lightingMode: 'evening',
    });
    expect(api.createRender).not.toHaveBeenCalled();

    const again = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    api.createRender.mockResolvedValue(queued(again));
    retryLight();
    await settle();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      style: 'abundant',
      lightingMode: 'evening',
    });
  });

  it('lets the person dismiss the line, and the next look keeps the evening', async () => {
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    await opened({ variantCount: 1, style: 'abundant', lightingMode: 'evening' }, [daylight]);
    dismissLightFallback();
    expect(useLightFallback.getState().dismissed).toBe(true);
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'subtle' })));
    chooseLook({ style: 'subtle' });
    await settle();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      style: 'subtle',
      lightingMode: 'evening',
    });
  });

  it('says the same for a bright look shown as photographed', async () => {
    const asPhotographed = variant({ style: 'classic', lightingMode: 'source' });
    await opened(
      {
        variantCount: 1,
        sceneType: 'interior',
        roomType: 'living_room',
        style: 'classic',
        lightingMode: 'bright',
        offered: {
          styles: ['subtle', 'classic', 'abundant'],
          defaultStyle: 'classic',
          lightingModes: ['source', 'bright'],
          defaultLightingMode: 'bright',
        },
      },
      [asPhotographed],
    );
    expect(useLightFallback.getState().fallback).toEqual({
      renderAssetId: asPhotographed.renderAssetId,
      lightingMode: 'bright',
    });
  });

  it('gives no line when the light is not offered for the photo any more', async () => {
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    await opened(
      {
        variantCount: 1,
        style: 'abundant',
        lightingMode: 'evening',
        offered: {
          styles: ['subtle', 'classic', 'abundant'],
          defaultStyle: 'abundant',
          lightingModes: ['source'],
          defaultLightingMode: 'source',
        },
      },
      [daylight],
    );
    expect(useProjectStore.getState().variant?.renderAssetId).toBe(daylight.renderAssetId);
    expect(lightFallbackId()).toBeNull();
  });

  it('gives the evening look itself no line', async () => {
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    const evening = variant({
      style: 'abundant',
      lightingMode: 'evening',
      createdAt: '2026-11-08T10:00:00.000Z',
    });
    await opened({ variantCount: 2, style: 'abundant', lightingMode: 'evening' }, [
      daylight,
      evening,
    ]);
    expect(useProjectStore.getState().variant?.renderAssetId).toBe(evening.renderAssetId);
    expect(lightFallbackId()).toBeNull();
  });

  it('gives no line to another style, nor while the place is making a look', async () => {
    const subtle = variant({ style: 'subtle', lightingMode: 'source' });
    await opened({ variantCount: 1, style: 'abundant', lightingMode: 'evening' }, [subtle]);
    expect(useProjectStore.getState().variant?.renderAssetId).toBe(subtle.renderAssetId);
    expect(lightFallbackId()).toBeNull();

    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    const running = renderStatus({
      style: 'abundant',
      lightingMode: 'evening',
      state: 'rendering',
    });
    api.getRender.mockResolvedValue(running);
    await opened(
      {
        variantCount: 1,
        style: 'abundant',
        lightingMode: 'evening',
        activeRenderJobId: running.renderJobId,
      },
      [daylight],
    );
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(running.renderJobId);
    expect(lightFallbackId()).toBeNull();
  });
});
