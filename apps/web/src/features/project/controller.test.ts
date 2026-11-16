import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Discovery, OfferedSet, RenderStatus, StageLabelKey } from '@hailiday/core';
import * as endpoints from '../../api/endpoints';
import { sessionError } from '../../api/errors';
import { FRAMING_STAGE } from '../../api/renderStatus';
import type * as sse from '../../api/sse';
import type { RenderSubscriptionHandlers } from '../../api/sse';
import { t } from '../../copy';
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
  cancelPendingLook,
  cancelRender,
  cancelUpload,
  changeHoliday,
  changeSceneType,
  chooseLook,
  closeProject,
  notYourPlace,
  onUploadAttached,
  openProject,
  replacePhoto,
  requestRender,
  retryLight,
  retryPendingLook,
  retryRender,
  selectView,
  showUpload,
} from './controller';
import { ConfirmPlace } from './ConfirmPlace';
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

/** The variant the result marks as a relit look shown in the photo's own light. */
function lightFallbackId(): string | null {
  return useLightFallback.getState().fallback?.renderAssetId ?? null;
}

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
  window.sessionStorage.clear();
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
    await settle();
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

    await settle();
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

  it('refuses a second choice while a look is being made', async () => {
    startOnResult();
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'abundant' })));
    chooseLook({ style: 'abundant' });
    chooseLook({ style: 'subtle' });
    await settle();
    chooseLook({ lightingMode: 'evening' });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({ style: 'abundant' });
    const state = useProjectStore.getState();
    expect(state.pending?.look.style).toBe('abundant');
    expect(state.look?.style).toBe('abundant');
    expect(state.lockedNotice).toBe(2);
  });

  it('does not count the same choice twice', async () => {
    startOnResult();
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'abundant' })));
    chooseLook({ style: 'abundant' });
    chooseLook({ style: 'abundant' });
    await settle();
    chooseLook({ style: 'abundant' });
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().lockedNotice).toBe(0);
  });

  it('opens no cached look while another is being made, and leaves the running job alone', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ style: 'abundant' });
    await settle();
    chooseLook({ holidayId: 'halloween' });
    const state = useProjectStore.getState();
    expect(state.variant).toBe(current);
    expect(state.pending?.render?.renderJobId).toBe(job.renderJobId);
    expect(state.lockedNotice).toBe(1);
    expect(api.cancelRender).not.toHaveBeenCalled();
  });

  it('sends nothing from requestRender while a look is being made', async () => {
    startOnResult();
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'abundant' })));
    chooseLook({ style: 'abundant' });
    await settle();
    await requestRender({
      look: { holidayId: 'halloween', style: 'subtle', lightingMode: 'source' },
    });
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().lockedNotice).toBe(1);
  });

  it('refuses Replace photo and a scene type change while a look is being made', async () => {
    startOnResult();
    useProjectStore.setState({ project: project({ kind: 'upload', variantCount: 2 }) });
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'abundant' })));
    chooseLook({ style: 'abundant' });
    await settle();
    replacePhoto();
    expect(useProjectStore.getState().phase).toBe('result');
    await changeSceneType({ sceneType: 'balcony', roomType: null });
    expect(api.putProjectSource).not.toHaveBeenCalled();
    expect(useProjectStore.getState().lockedNotice).toBe(2);
    expect(useProjectStore.getState().pending?.look.style).toBe('abundant');
  });

  it('opens the upload step from Replace photo when no look is being made', () => {
    startOnResult();
    replacePhoto();
    expect(useProjectStore.getState().phase).toBe('upload');
    expect(useProjectStore.getState().uploadContext).toBe('replace');
    expect(useProjectStore.getState().lockedNotice).toBe(0);
  });

  it('keeps the trail of the stages the look reported, and drops it when the look arrives', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ style: 'abundant' });
    expect(useProjectStore.getState().trail).toBeNull();
    await settle();
    expect(useProjectStore.getState().trail).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing'],
      current: 'stage.preparing',
    });
    const status = (state: RenderStatus['state'], seq: number) => ({
      ...job,
      state,
      stageLabelKey: null,
      seq,
    });
    handlers[job.renderJobId]!.onStatus(status('planning', 2));
    handlers[job.renderJobId]!.onStatus(status('rendering', 3));
    handlers[job.renderJobId]!.onStatus(status('checking', 4));
    handlers[job.renderJobId]!.onStatus(status('planning', 5));
    expect(useProjectStore.getState().trail).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', 'stage.planning', 'stage.rendering', 'stage.checking'],
      current: 'stage.planning',
    });
    handlers[job.renderJobId]!.onStatus({
      ...status('succeeded', 6),
      variant: variant({ style: 'abundant', renderJobId: job.renderJobId }),
    });
    expect(useProjectStore.getState().trail).toBeNull();
  });

  it('drops the trail when the look is canceled or fails', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ style: 'abundant' });
    await settle();
    expect(useProjectStore.getState().trail).not.toBeNull();
    await cancelPendingLook();
    expect(useProjectStore.getState().trail).toBeNull();

    const next = renderStatus({ style: 'subtle' });
    const again = renderStatus({ style: 'subtle' });
    api.createRender.mockResolvedValueOnce(queued(next)).mockResolvedValueOnce(queued(again));
    chooseLook({ style: 'subtle' });
    await settle();
    expect(useProjectStore.getState().trail?.renderJobId).toBe(next.renderJobId);
    handlers[next.renderJobId]!.onStatus({
      ...next,
      state: 'rejected',
      seq: 2,
      rejectionReason: 'qa_critical',
    });
    expect(useProjectStore.getState().trail).toBeNull();
    await settle();
    expect(useProjectStore.getState().trail?.renderJobId).toBe(again.renderJobId);
    handlers[again.renderJobId]!.onStatus({
      ...again,
      state: 'rejected',
      seq: 2,
      rejectionReason: 'qa_critical',
    });
    expect(useProjectStore.getState().trail).toBeNull();
    expect(useProjectStore.getState().pendingError?.state).toBe('rejected');
  });

  it('keeps the current preview, takes one more pass, then shows the notice when the new look fails', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    const again = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValueOnce(queued(job)).mockResolvedValueOnce(queued(again));
    chooseLook({ style: 'abundant' });
    await settle();
    handlers[job.renderJobId]!.onStatus({
      ...job,
      state: 'rejected',
      seq: 2,
      rejectionReason: 'qa_critical',
    });
    let state = useProjectStore.getState();
    expect(state.variant).toBe(current);
    expect(state.pending?.look.style).toBe('abundant');
    expect(state.secondPass).toBe(true);
    expect(state.pendingError).toBeNull();
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({ style: 'abundant' });
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(again.renderJobId);

    handlers[again.renderJobId]!.onStatus({
      ...again,
      state: 'rejected',
      seq: 2,
      rejectionReason: 'qa_critical',
    });
    await settle();
    state = useProjectStore.getState();
    expect(state.variant).toBe(current);
    expect(state.pending).toBeNull();
    expect(state.secondPass).toBe(false);
    expect(state.pendingError?.state).toBe('rejected');
    expect(state.look).toEqual(lookOf(current));
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending look and returns the controls to the preview on screen', async () => {
    startOnResult();
    const job = renderStatus({ style: 'subtle' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ style: 'subtle' });
    await settle();
    await cancelPendingLook();
    expect(api.cancelRender).toHaveBeenCalledWith(job.renderJobId);
    expect(useProjectStore.getState().pending).toBeNull();
    expect(useProjectStore.getState().look).toEqual(lookOf(current));
  });
});

describe('the read before another look is requested', () => {
  it('joins a look another tab is already making instead of replacing it', async () => {
    startOnResult();
    const elsewhere = renderStatus({
      holidayId: 'halloween',
      style: 'subtle',
      state: 'rendering',
      stageLabelKey: 'stage.rendering',
    });
    api.listVariants.mockResolvedValue({
      items: [current, halloween],
      activeRender: elsewhere,
      offered: null,
    });
    chooseLook({ style: 'abundant' });
    await settle();
    expect(api.createRender).not.toHaveBeenCalled();
    const state = useProjectStore.getState();
    expect(state.pending).toEqual({ look: lookOf(elsewhere), render: elsewhere });
    expect(state.look).toEqual(lookOf(elsewhere));
    expect(state.variant).toBe(current);
    expect(state.lockedNotice).toBe(1);
    expect(state.trail).toEqual({
      renderJobId: elsewhere.renderJobId,
      keys: ['stage.preparing', 'stage.planning', 'stage.rendering'],
      current: 'stage.rendering',
    });
    expect(handlers[elsewhere.renderJobId]).toBeDefined();

    const made = variant({ holidayId: 'halloween', style: 'subtle' });
    handlers[elsewhere.renderJobId]!.onStatus({
      ...elsewhere,
      state: 'succeeded',
      seq: 2,
      variant: made,
    });
    expect(useProjectStore.getState().variant).toBe(made);
    expect(useProjectStore.getState().pending).toBeNull();
  });

  it('says nothing is locked when the look joined is the one chosen', async () => {
    startOnResult();
    const elsewhere = renderStatus({ style: 'abundant', state: 'planning' });
    api.listVariants.mockResolvedValue({
      items: [current, halloween],
      activeRender: elsewhere,
      offered: null,
    });
    chooseLook({ style: 'abundant' });
    await settle();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(elsewhere.renderJobId);
    expect(useProjectStore.getState().lockedNotice).toBe(0);
  });

  it('opens a look made elsewhere since the page loaded, without a request', async () => {
    startOnResult();
    const made = variant({ style: 'abundant', createdAt: '2026-11-09T11:00:00.000Z' });
    api.listVariants.mockResolvedValue({
      items: [made, current, halloween],
      activeRender: null,
      offered: null,
    });
    chooseLook({ style: 'abundant' });
    await settle();
    expect(api.createRender).not.toHaveBeenCalled();
    const state = useProjectStore.getState();
    expect(state.variant).toBe(made);
    expect(state.pending).toBeNull();
    expect(state.variants).toContain(made);
  });

  it('requests the look when the read fails', async () => {
    startOnResult();
    api.listVariants.mockRejectedValue(apiError('RATE_LIMITED'));
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'abundant' })));
    chooseLook({ style: 'abundant' });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().pending?.look.style).toBe('abundant');
  });

  it('sends no request when the look is canceled during the read', async () => {
    startOnResult();
    let answer: (value: Awaited<ReturnType<typeof endpoints.listVariants>>) => void = () =>
      undefined;
    api.listVariants.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as typeof answer)),
    );
    chooseLook({ style: 'abundant' });
    expect(useProjectStore.getState().pending?.look.style).toBe('abundant');
    await cancelPendingLook();
    answer({ items: [current, halloween], activeRender: null, offered: null });
    await settle();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(api.cancelRender).not.toHaveBeenCalled();
    expect(useProjectStore.getState().pending).toBeNull();
    expect(useProjectStore.getState().look).toEqual(lookOf(current));
  });

  it('does not join a job this page canceled that the list still shows running', async () => {
    startOnResult();
    const first = renderStatus({ style: 'subtle' });
    api.createRender.mockResolvedValueOnce(queued(first));
    chooseLook({ style: 'subtle' });
    await settle();
    await cancelPendingLook();
    expect(api.cancelRender).toHaveBeenCalledWith(first.renderJobId);

    api.listVariants.mockResolvedValue({
      items: [current, halloween],
      activeRender: { ...first, state: 'rendering' },
      offered: null,
    });
    const second = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValueOnce(queued(second));
    chooseLook({ style: 'abundant' });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(second.renderJobId);
  });
});

describe('a pending look whose job is replaced from elsewhere', () => {
  it('follows the newer job, takes its look and shows its result', async () => {
    startOnResult();
    const first = renderStatus({ style: 'subtle' });
    api.createRender.mockResolvedValue(queued(first));
    chooseLook({ style: 'subtle' });
    await settle();
    const successor = renderStatus({
      holidayId: 'halloween',
      style: 'abundant',
      state: 'planning',
      stageLabelKey: 'stage.planning',
    });
    handlers[first.renderJobId]!.onStatus({
      ...first,
      state: 'superseded',
      seq: 2,
      supersededByRenderJobId: successor.renderJobId,
    });
    expect(handlers[successor.renderJobId]).toBeDefined();
    handlers[successor.renderJobId]!.onStatus(successor);
    let state = useProjectStore.getState();
    expect(state.pending).toEqual({ look: lookOf(successor), render: successor });
    expect(state.look).toEqual(lookOf(successor));
    expect(state.trail).toEqual({
      renderJobId: successor.renderJobId,
      keys: ['stage.preparing', 'stage.planning'],
      current: 'stage.planning',
    });

    handlers[successor.renderJobId]!.onStatus({
      ...successor,
      state: 'rendering',
      stageLabelKey: 'stage.rendering',
      seq: 2,
    });
    expect(useProjectStore.getState().pending?.render?.state).toBe('rendering');

    const made = variant({ holidayId: 'halloween', style: 'abundant' });
    handlers[successor.renderJobId]!.onStatus({
      ...successor,
      state: 'succeeded',
      seq: 3,
      variant: made,
    });
    state = useProjectStore.getState();
    expect(state.variant).toBe(made);
    expect(state.pending).toBeNull();
    expect(state.trail).toBeNull();
  });

  it('settles on the look on screen when a superseded job names no successor', async () => {
    startOnResult();
    const first = renderStatus({ style: 'subtle' });
    api.createRender.mockResolvedValue(queued(first));
    chooseLook({ style: 'subtle' });
    await settle();
    handlers[first.renderJobId]!.onStatus({ ...first, state: 'superseded', seq: 2 });
    expect(useProjectStore.getState().pending).toBeNull();
    expect(useProjectStore.getState().look).toEqual(lookOf(current));
  });
});

describe('a reload in the middle of another look', () => {
  it('shows the look being made on the controls, with the stages its state implies', async () => {
    const running = renderStatus({
      holidayId: 'halloween',
      style: 'abundant',
      state: 'rendering',
      stageLabelKey: 'stage.rendering',
    });
    api.getProject.mockResolvedValue(
      project({ variantCount: 2, activeRenderJobId: running.renderJobId }),
    );
    api.getRender.mockResolvedValue(running);
    await openProject(project().id, null);
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).not.toBeNull();
    expect(state.pending).toEqual({ look: lookOf(running), render: running });
    expect(state.look).toEqual(lookOf(running));
    expect(state.trail).toEqual({
      renderJobId: running.renderJobId,
      keys: ['stage.preparing', 'stage.planning', 'stage.rendering'],
      current: 'stage.rendering',
    });
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

    expect(useProjectStore.getState().trail?.keys).toEqual(['stage.preparing']);

    handlers[job.renderJobId]!.onStatus({
      ...job,
      state: 'planning',
      stageLabelKey: 'stage.planning',
      seq: 2,
    });
    expect(useProjectStore.getState().render?.state).toBe('planning');
    expect(useProjectStore.getState().trail).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', 'stage.planning'],
      current: 'stage.planning',
    });

    const first = variant();
    handlers[job.renderJobId]!.onStatus({ ...job, state: 'succeeded', seq: 3, variant: first });
    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(first);
    expect(state.revealFor).toBe(first.renderAssetId);
    expect(state.look).toEqual(lookOf(first));
    expect(state.trail).toBeNull();
  });

  it('drops the trail when the first look is canceled', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    const job = renderStatus({ state: 'queued' });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    expect(useProjectStore.getState().trail).not.toBeNull();
    await cancelRender();
    expect(api.cancelRender).toHaveBeenCalledWith(job.renderJobId);
    expect(useProjectStore.getState().trail).toBeNull();
  });

  it('retries a first look refused for a stale project version', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    api.createRender
      .mockRejectedValueOnce(apiError('STALE_PROJECT_VERSION'))
      .mockResolvedValue(queued(renderStatus()));
    api.getProject.mockResolvedValue(project({ variantCount: 0, projectVersion: 4 }));
    await requestRender();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({ projectVersion: 4 });
    expect(useProjectStore.getState().phase).toBe('waiting');
    expect(useProjectStore.getState().lockedNotice).toBe(0);
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

describe('the look a render starts from', () => {
  function onConfirm(overrides: Parameters<typeof project>[0] = {}) {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0, style: 'classic', lightingMode: 'source', ...overrides }),
      phase: 'confirm',
    });
    api.createRender.mockResolvedValue(queued(renderStatus()));
  }

  it('decorates an exterior first in the offered default look, abundant in the evening', async () => {
    onConfirm();
    await requestRender();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      holidayId: 'christmas',
      style: 'abundant',
      lightingMode: 'evening',
    });
  });

  it('decorates an interior first abundant and as photographed, with no lighting choice', async () => {
    onConfirm({
      sceneType: 'interior',
      offered: {
        styles: ['subtle', 'classic', 'abundant'],
        defaultStyle: 'abundant',
        lightingModes: ['source'],
        defaultLightingMode: 'source',
      },
    });
    await requestRender();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      style: 'abundant',
      lightingMode: 'source',
    });
  });

  it("keeps the project's remembered look once it has previews", async () => {
    onConfirm({ variantCount: 1 });
    await requestRender();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      style: 'classic',
      lightingMode: 'source',
    });
  });

  it('"Show it as photographed" keeps the default style', async () => {
    onConfirm();
    await requestRender({ lightingMode: 'source' });
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      style: 'abundant',
      lightingMode: 'source',
    });
  });

  it('"Try again" repeats the look that failed, not the default', async () => {
    onConfirm();
    useProjectStore.setState({
      phase: 'render_error',
      render: renderStatus({ state: 'failed', style: 'abundant', lightingMode: 'source' }),
    });
    retryRender();
    await settle();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      holidayId: 'christmas',
      style: 'abundant',
      lightingMode: 'source',
    });
  });
});

describe('typing an address that is already a place', () => {
  it('opens the existing place on its result without discovery or a new render', async () => {
    const existing = project({ kind: 'address', variantCount: 2 });
    await openProject(existing.id, { project: existing, entry: 'autocomplete' });
    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(current);
    expect(api.runSourceDiscovery).not.toHaveBeenCalled();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(api.getProject).not.toHaveBeenCalled();
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
    api.listVariants.mockResolvedValue({
      items: [current, oldPhoto],
      activeRender: null,
      offered: null,
    });
    api.createRender.mockResolvedValue(queued(renderStatus({ holidayId: 'halloween' })));
    chooseLook({ holidayId: 'halloween' });
    expect(useProjectStore.getState().variant).toBe(current);
    expect(useProjectStore.getState().pending?.look.holidayId).toBe('halloween');
    await settle();
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

describe('a render refused because the view behind the place changed', () => {
  const streetViewSource = {
    ...project().activeSource!,
    kind: 'street_view' as const,
    sourceMode: 'persist' as const,
    isGoogleImagery: true,
    width: 640,
    height: 640,
  };

  function candidate(candidateId: string) {
    return {
      candidateId,
      isPrimary: candidateId === 'c-1',
      rank: 1,
      displayUrl: `https://cdn.test/${candidateId}.jpg`,
      heading: 90,
      headingMode: 'geometry' as const,
      pitch: 0,
      fov: 80,
      captureDate: null,
      captureGranularity: 'month' as const,
      copyright: '© 2026 Google',
      isGoogleImagery: true,
      distanceMeters: 12,
      estimatedFacadePx: null,
      flags: [],
      width: 640,
      height: 640,
    };
  }

  function discovery(matchClass: 'auto_start' | 'confirm' | 'skip_to_upload'): Discovery {
    const skip = matchClass === 'skip_to_upload';
    return {
      discoveryId: '018f0000-0000-7000-8000-dddddddddddd',
      projectVersion: 4,
      entryMethod: 'autocomplete',
      matchClass,
      reason: skip ? 'no_imagery' : null,
      retryable: false,
      sourceMode: skip ? 'unavailable' : 'persist',
      thresholdsVersion: 'test',
      sourceAssetId: skip ? null : SOURCE_ASSET_ID,
      remainingDisplayLoads: 3,
      candidates: skip ? [] : [candidate('c-1')],
      attribution: skip ? null : { logo: 'google_maps', required: true },
      nextAction: matchClass === 'auto_start' ? 'render' : skip ? 'upload_photo' : 'confirm_place',
    };
  }

  function startOnConfirm(matchClass: 'auto_start' | 'confirm' | 'skip_to_upload') {
    const fresh = project({
      kind: 'address',
      variantCount: 0,
      projectVersion: 4,
      activeSource: { ...streetViewSource, state: 'stale' },
    });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: fresh.id,
      project: project({ kind: 'address', variantCount: 0, activeSource: streetViewSource }),
      phase: 'confirm',
      candidates: [candidate('c-0')],
      baseCandidateIds: ['c-0'],
    });
    api.createRender
      .mockRejectedValueOnce(apiError('SOURCE_NOT_EDITABLE', { details: { reason: 'stale' } }))
      .mockResolvedValue(queued(renderStatus({ state: 'queued' })));
    api.getProject.mockResolvedValue(fresh);
    api.runSourceDiscovery.mockResolvedValue({ project: fresh, discovery: discovery(matchClass) });
  }

  it('opens No Street View when the panorama is gone and nothing newer exists', async () => {
    startOnConfirm('skip_to_upload');
    await requestRender();
    const state = useProjectStore.getState();
    expect(api.runSourceDiscovery).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('nosv');
    expect(state.candidates).toHaveLength(0);
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('asks about the new view of an auto-start place instead of decorating it unasked', async () => {
    startOnConfirm('auto_start');
    await requestRender();
    const state = useProjectStore.getState();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('confirm');
    expect(state.confirmNotice).toBe('viewChanged');
    expect(state.autoStarted).toBe(false);
    expect(state.render).toBeNull();
    expect(state.candidates.map((c) => c.candidateId)).toEqual(['c-1']);
  });

  it('shows the new view to confirm, with a line saying the view changed', async () => {
    startOnConfirm('confirm');
    await requestRender();
    const state = useProjectStore.getState();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('confirm');
    expect(state.confirmNotice).toBe('viewChanged');
    expect(state.candidates.map((c) => c.candidateId)).toEqual(['c-1']);
  });

  it('leaves the screen alone when the person left the place while discovery ran', async () => {
    startOnConfirm('confirm');
    let answer: (value: Awaited<ReturnType<typeof api.runSourceDiscovery>>) => void = () => {};
    api.runSourceDiscovery.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const run = requestRender();
    await settle();
    expect(useProjectStore.getState().phase).toBe('finding');
    closeProject();
    answer({ project: project(), discovery: discovery('confirm') });
    await run;
    const state = useProjectStore.getState();
    expect(state.phase).toBe(INITIAL_PROJECT_FLOW.phase);
    expect(state.confirmNotice).toBeNull();
  });

  describe('a render refused because the street photo may only be displayed', () => {
    const refused = () => apiError('SOURCE_NOT_EDITABLE', { details: { reason: 'display_only' } });

    /** A discovery of the place in `sourceMode`, offering its primary view and one more. */
    function discoveryIn(sourceMode: 'persist' | 'display_only'): Discovery {
      return {
        ...discovery('confirm'),
        sourceMode,
        candidates: [candidate('c-1'), candidate('c-2')],
      };
    }

    /** A place confirmed while its photo could be decorated: the project still says so. */
    function confirmedPlace(variantCount = 0) {
      return project({
        kind: 'address',
        variantCount,
        activeSource: streetViewSource,
        discovery: {
          matchClass: 'confirm',
          reason: null,
          sourceMode: 'persist',
          candidateCount: 2,
          remainingDisplayLoads: 3,
        },
      });
    }

    /** The confirm screen of the place, holding a discovery in `sourceMode` and its views. */
    function onConfirmWith(sourceMode: 'persist' | 'display_only', selectedCandidateId: string) {
      const place = confirmedPlace();
      const shown = discoveryIn(sourceMode);
      useProjectStore.setState({
        ...INITIAL_PROJECT_FLOW,
        projectId: place.id,
        project: place,
        phase: 'confirm',
        discovery: shown,
        candidates: shown.candidates,
        baseCandidateIds: shown.candidates.map((item) => item.candidateId),
        selectedCandidateId,
      });
      return place;
    }

    /** Opens the place with no look yet: its render is refused, discovery says display only. */
    async function reopenWithoutLook() {
      const place = confirmedPlace();
      api.getProject.mockResolvedValue(place);
      api.createRender.mockRejectedValue(refused());
      api.runSourceDiscovery.mockResolvedValue({
        project: place,
        discovery: discoveryIn('display_only'),
      });
      await openProject(place.id, null);
      await settle();
    }

    afterEach(() => {
      cleanup();
    });

    it('opens a place with no look yet on the views of a new discovery that is display only', async () => {
      await reopenWithoutLook();
      const state = useProjectStore.getState();
      expect(api.runSourceDiscovery).toHaveBeenCalledTimes(1);
      expect(api.createRender).toHaveBeenCalledTimes(1);
      expect(state.phase).toBe('confirm');
      expect(state.discovery?.sourceMode).toBe('display_only');
      expect(state.candidates.map((item) => item.candidateId)).toEqual(['c-1', 'c-2']);
      expect(state.inlineError).toBeNull();
    });

    it('shows that place the photo prompt, with no button to decorate it', async () => {
      await reopenWithoutLook();
      const { container } = render(createElement(MemoryRouter, null, createElement(ConfirmPlace)));
      expect(container.textContent).toContain(t('interim.explain'));
      expect(screen.queryByRole('button', { name: t('confirm.yes') })).toBeNull();
    });

    it('asks about the place again with the reason in line when the chosen view may only be displayed', async () => {
      const place = onConfirmWith('persist', 'c-2');
      api.createRender.mockRejectedValue(refused());
      api.getProject.mockResolvedValue(place);
      api.runSourceDiscovery.mockResolvedValue({
        project: place,
        discovery: discoveryIn('persist'),
      });
      await requestRender();
      const state = useProjectStore.getState();
      expect(api.createRender).toHaveBeenCalledTimes(1);
      expect(api.runSourceDiscovery).toHaveBeenCalledTimes(1);
      expect(state.phase).toBe('confirm');
      expect(state.inlineError).toBe(t('error.SOURCE_NOT_EDITABLE'));
      expect(state.autoStarted).toBe(false);
      expect(state.selectedCandidateId).toBe('c-1');
    });

    it('keeps the result on screen with the reason in line when another look is refused', async () => {
      const place = confirmedPlace(1);
      useProjectStore.setState({
        ...INITIAL_PROJECT_FLOW,
        projectId: place.id,
        project: place,
        phase: 'result',
        variant: current,
        variants: [current],
        look: lookOf(current),
      });
      api.listVariants.mockResolvedValue({ items: [current], activeRender: null, offered: null });
      api.createRender.mockRejectedValue(refused());
      await requestRender({
        look: { holidayId: 'christmas', style: 'abundant', lightingMode: 'source' },
      });
      await settle();
      const state = useProjectStore.getState();
      expect(api.createRender).toHaveBeenCalledTimes(1);
      expect(state.phase).toBe('result');
      expect(state.variant).toBe(current);
      expect(state.look).toEqual(lookOf(current));
      expect(state.inlineError).toBe(t('error.SOURCE_NOT_EDITABLE'));
      expect(state.pending).toBeNull();
      expect(api.runSourceDiscovery).not.toHaveBeenCalled();
      expect(api.getProject).not.toHaveBeenCalled();
    });

    it('keeps the photo prompt on screen without reading the place again', async () => {
      const place = onConfirmWith('display_only', 'c-1');
      api.createRender.mockRejectedValue(refused());
      api.getProject.mockResolvedValue(place);
      api.runSourceDiscovery.mockResolvedValue({
        project: place,
        discovery: discoveryIn('display_only'),
      });
      await requestRender();
      const state = useProjectStore.getState();
      expect(api.createRender).toHaveBeenCalledTimes(1);
      expect(state.phase).toBe('confirm');
      expect(state.inlineError).toBeNull();
      expect(api.runSourceDiscovery).not.toHaveBeenCalled();
      expect(api.getProject).not.toHaveBeenCalled();
    });

    it.each(['the read of the place', 'discovery'] as const)(
      'changes nothing once the person left the place during %s',
      async (moment) => {
        const place = onConfirmWith('persist', 'c-2');
        api.createRender.mockRejectedValue(refused());
        let answerPlace: (value: Awaited<ReturnType<typeof api.getProject>>) => void = () => {};
        let answerDiscovery: (
          value: Awaited<ReturnType<typeof api.runSourceDiscovery>>,
        ) => void = () => {};
        if (moment === 'discovery') {
          api.getProject.mockResolvedValue(place);
          api.runSourceDiscovery.mockReturnValue(
            new Promise((resolve) => (answerDiscovery = resolve)),
          );
        } else {
          api.getProject.mockReturnValue(new Promise((resolve) => (answerPlace = resolve)));
          api.runSourceDiscovery.mockResolvedValue({
            project: place,
            discovery: discoveryIn('persist'),
          });
        }
        const run = requestRender();
        await settle();
        const waitingOn = moment === 'discovery' ? api.runSourceDiscovery : api.getProject;
        expect(waitingOn).toHaveBeenCalledTimes(1);
        closeProject();
        const projectChanges = vi.fn();
        const appChanges = vi.fn();
        const stopProject = useProjectStore.subscribe(projectChanges);
        const stopApp = useAppStore.subscribe(appChanges);
        answerPlace(place);
        answerDiscovery({ project: place, discovery: discoveryIn('persist') });
        await run;
        await settle();
        stopProject();
        stopApp();
        expect(projectChanges).not.toHaveBeenCalled();
        expect(appChanges).not.toHaveBeenCalled();
        expect(useProjectStore.getState().phase).toBe(INITIAL_PROJECT_FLOW.phase);
      },
    );
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
  it('sends nothing while the first look is being made, and says why', async () => {
    const running = renderStatus({ holidayId: 'christmas', state: 'rendering' });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'waiting',
      render: running,
    });
    changeHoliday('halloween');
    await settle();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(useProjectStore.getState().render).toBe(running);
    expect(useProjectStore.getState().lockedNotice).toBe(1);
  });

  it('sends nothing while the first request is on its way', async () => {
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
    expect(useProjectStore.getState().lockedNotice).toBe(1);
    answer(queued(first));
    await pending;
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().render?.renderJobId).toBe(first.renderJobId);
  });

  it('keeps a holiday chosen on the confirm screen for the next request, unnoted', () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    changeHoliday('halloween');
    expect(api.createRender).not.toHaveBeenCalled();
    expect(useProjectStore.getState().lockedNotice).toBe(0);
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

  it("re-attaches the photo with the new type, then decorates the new type's default look", async () => {
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
    expect(current.style).toBe('classic');
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      projectVersion: 4,
      holidayId: 'christmas',
      style: 'abundant',
      lightingMode: 'evening',
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

describe('an evening look the job could not make', () => {
  const rejected = { state: 'rejected', seq: 2, rejectionReason: 'qa_critical' } as const;

  function beforeFirstLook() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
  }

  it('shows the default first look as photographed, with a line saying why', async () => {
    beforeFirstLook();
    const job = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({ lightingMode: 'evening' });

    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    api.listVariants.mockResolvedValue({ items: [daylight], activeRender: null, offered: null });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();

    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(daylight);
    expect(state.revealFor).toBe(daylight.renderAssetId);
    expect(state.pendingError).toBeNull();
    expect(lightFallbackId()).toBe(daylight.renderAssetId);
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('takes one more pass when the job saved no look as photographed, then shows the notice', async () => {
    beforeFirstLook();
    const job = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    const again = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    api.createRender.mockResolvedValueOnce(queued(job)).mockResolvedValueOnce(queued(again));
    await requestRender();
    api.listVariants.mockResolvedValue({ items: [], activeRender: null, offered: null });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    let state = useProjectStore.getState();
    expect(state.phase).toBe('waiting');
    expect(state.secondPass).toBe(true);
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({
      style: 'abundant',
      lightingMode: 'evening',
    });

    handlers[again.renderJobId]!.onStatus({ ...again, ...rejected });
    await settle();
    state = useProjectStore.getState();
    expect(state.phase).toBe('render_error');
    expect(state.render?.renderJobId).toBe(again.renderJobId);
    expect(state.render?.state).toBe('rejected');
    expect(state.secondPass).toBe(false);
    expect(lightFallbackId()).toBeNull();
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('shows the look in daylight with its line also when the person picked evening', async () => {
    startOnResult();
    const job = renderStatus({ lightingMode: 'evening' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ lightingMode: 'evening' });
    await settle();
    api.listVariants.mockClear();
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    const state = useProjectStore.getState();
    expect(state.variant).toBe(current);
    expect(state.pending).toBeNull();
    expect(state.pendingError).toBeNull();
    expect(api.listVariants).toHaveBeenCalled();
    expect(lightFallbackId()).toBe(current.renderAssetId);
    expect(useLightFallback.getState().fallback?.lightingMode).toBe('evening');
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('shows evening carried to another holiday as photographed, until the next choice', async () => {
    const christmasEvening = variant({ style: 'abundant', lightingMode: 'evening' });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 1 }),
      phase: 'result',
      variant: christmasEvening,
      variants: [christmasEvening],
      look: lookOf(christmasEvening),
    });
    api.listVariants.mockResolvedValue({
      items: [christmasEvening],
      activeRender: null,
      offered: null,
    });
    const job = renderStatus({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ holidayId: 'halloween' });
    await settle();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      holidayId: 'halloween',
      lightingMode: 'evening',
    });

    const halloweenDaylight = variant({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'source',
    });
    api.listVariants.mockResolvedValue({
      items: [halloweenDaylight, christmasEvening],
      activeRender: null,
      offered: null,
    });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    let state = useProjectStore.getState();
    expect(state.variant).toBe(halloweenDaylight);
    expect(state.pending).toBeNull();
    expect(state.pendingError).toBeNull();
    expect(lightFallbackId()).toBe(halloweenDaylight.renderAssetId);

    // Another holiday keeps the evening the look was meant to have.
    chooseLook({ holidayId: 'christmas' });
    state = useProjectStore.getState();
    expect(state.variant).toBe(christmasEvening);
    expect(lightFallbackId()).toBeNull();

    // Coming back opens the look as photographed again, with its line, and asks for nothing.
    chooseLook({ holidayId: 'halloween' });
    await settle();
    state = useProjectStore.getState();
    expect(state.variant).toBe(halloweenDaylight);
    expect(state.pending).toBeNull();
    expect(lightFallbackId()).toBe(halloweenDaylight.renderAssetId);
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('asks for evening again when the person picks it after it could not be made', async () => {
    const christmasEvening = variant({ style: 'abundant', lightingMode: 'evening' });
    const halloweenDaylight = variant({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'source',
    });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 1 }),
      phase: 'result',
      variant: christmasEvening,
      variants: [christmasEvening],
      look: lookOf(christmasEvening),
    });
    api.listVariants.mockResolvedValue({
      items: [christmasEvening],
      activeRender: null,
      offered: null,
    });
    const job = renderStatus({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ holidayId: 'halloween' });
    await settle();
    api.listVariants.mockResolvedValue({
      items: [halloweenDaylight, christmasEvening],
      activeRender: null,
      offered: null,
    });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    expect(useProjectStore.getState().look?.lightingMode).toBe('source');

    const again = renderStatus({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
    api.createRender.mockResolvedValue(queued(again));
    chooseLook({ lightingMode: 'evening' });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({
      holidayId: 'halloween',
      lightingMode: 'evening',
    });
    handlers[again.renderJobId]!.onStatus({ ...again, ...rejected });
    await settle();
    const state = useProjectStore.getState();
    expect(state.variant).toBe(halloweenDaylight);
    expect(state.pending).toBeNull();
    expect(state.pendingError).toBeNull();
    expect(lightFallbackId()).toBe(halloweenDaylight.renderAssetId);
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('refuses another choice while the as-photographed look is read, then opens it with its line', async () => {
    const christmasEvening = variant({ style: 'abundant', lightingMode: 'evening' });
    const christmasSubtle = variant({ style: 'subtle', lightingMode: 'evening' });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 2 }),
      phase: 'result',
      variant: christmasEvening,
      variants: [christmasEvening, christmasSubtle],
      look: lookOf(christmasEvening),
    });
    api.listVariants.mockResolvedValue({
      items: [christmasEvening, christmasSubtle],
      activeRender: null,
      offered: null,
    });
    const job = renderStatus({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ holidayId: 'halloween' });
    await settle();
    let answer: (value: Awaited<ReturnType<typeof endpoints.listVariants>>) => void = () =>
      undefined;
    api.listVariants.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as typeof answer)),
    );
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    chooseLook({ holidayId: 'christmas', style: 'subtle' });
    expect(useProjectStore.getState().lockedNotice).toBe(1);
    const halloweenDaylight = variant({ holidayId: 'halloween', style: 'abundant' });
    answer({
      items: [halloweenDaylight, christmasEvening, christmasSubtle],
      activeRender: null,
      offered: null,
    });
    await settle();
    const state = useProjectStore.getState();
    expect(state.variant).toBe(halloweenDaylight);
    expect(state.pending).toBeNull();
    expect(state.pendingError).toBeNull();
    expect(lightFallbackId()).toBe(halloweenDaylight.renderAssetId);
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });
});

describe('a dusk or night photo after its first look', () => {
  const asPhotographedOnly: OfferedSet = {
    styles: ['subtle', 'classic', 'abundant'],
    defaultStyle: 'abundant',
    lightingModes: ['source'],
    defaultLightingMode: 'source',
  };
  const duskEvening = variant({ style: 'abundant', lightingMode: 'evening' });
  const halloweenLook = variant({ holidayId: 'halloween', style: 'abundant' });

  function onHalloweenResult() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 2, offered: asPhotographedOnly }),
      offered: asPhotographedOnly,
      phase: 'result',
      variant: halloweenLook,
      variants: [halloweenLook, duskEvening],
      look: lookOf(halloweenLook),
    });
    api.listVariants.mockResolvedValue({
      items: [halloweenLook, duskEvening],
      activeRender: null,
      offered: null,
    });
  }

  it('goes back to its evening look, made as photographed, without a new render', async () => {
    onHalloweenResult();
    chooseLook({ holidayId: 'christmas' });
    await settle();
    const state = useProjectStore.getState();
    expect(state.variant).toBe(duskEvening);
    expect(state.look).toEqual(lookOf(duskEvening));
    expect(state.pending).toBeNull();
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('still decorates a style it does not have yet, as photographed', async () => {
    onHalloweenResult();
    api.createRender.mockResolvedValue(queued(renderStatus({ style: 'subtle' })));
    chooseLook({ holidayId: 'christmas', style: 'subtle' });
    await settle();
    expect(api.createRender.mock.calls[0]![0]).toMatchObject({
      holidayId: 'christmas',
      style: 'subtle',
      lightingMode: 'source',
    });
  });
});

describe('an evening look the job ended failed', () => {
  const failed = {
    state: 'failed',
    seq: 2,
    failureKind: 'provider_error',
  } as const;

  function beforeFirstLook() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
  }

  it('shows the daylight version the job saved, with a line saying why', async () => {
    beforeFirstLook();
    const job = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    api.listVariants.mockResolvedValue({ items: [daylight], activeRender: null, offered: null });
    handlers[job.renderJobId]!.onStatus({ ...job, ...failed });
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(daylight);
    expect(lightFallbackId()).toBe(daylight.renderAssetId);
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('takes one more pass when no daylight version was saved, then shows the notice', async () => {
    beforeFirstLook();
    const job = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    const again = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    api.createRender.mockResolvedValueOnce(queued(job)).mockResolvedValueOnce(queued(again));
    await requestRender();
    api.listVariants.mockResolvedValue({ items: [], activeRender: null, offered: null });
    handlers[job.renderJobId]!.onStatus({ ...job, ...failed });
    await settle();
    expect(useProjectStore.getState().phase).toBe('waiting');
    expect(api.createRender).toHaveBeenCalledTimes(2);
    handlers[again.renderJobId]!.onStatus({ ...again, ...failed });
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('render_error');
    expect(state.render?.state).toBe('failed');
    expect(lightFallbackId()).toBeNull();
  });

  it('shows the daylight version also for an evening the person picked', async () => {
    startOnResult();
    const job = renderStatus({ lightingMode: 'evening' });
    api.createRender.mockResolvedValue(queued(job));
    chooseLook({ lightingMode: 'evening' });
    await settle();
    handlers[job.renderJobId]!.onStatus({ ...job, ...failed });
    await settle();
    const state = useProjectStore.getState();
    expect(state.pendingError).toBeNull();
    expect(state.variant).toBe(current);
    expect(lightFallbackId()).toBe(current.renderAssetId);
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });
});

describe('an evening look that could not be made, after a reload', () => {
  const rejected = { state: 'rejected', seq: 2, rejectionReason: 'qa_critical' } as const;

  afterEach(() => {
    window.sessionStorage.clear();
  });

  it('still opens as photographed with its line and keeps evening for the next look', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
    const job = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    api.listVariants.mockResolvedValue({ items: [daylight], activeRender: null, offered: null });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    expect(lightFallbackId()).toBe(daylight.renderAssetId);

    // The page reloads: the module state is gone and the project is read again.
    closeProject();
    expect(lightFallbackId()).toBeNull();
    api.getProject.mockResolvedValue(
      project({ variantCount: 1, style: 'abundant', lightingMode: 'evening' }),
    );
    await openProject(project().id, null);
    await settle();
    let state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant?.renderAssetId).toBe(daylight.renderAssetId);
    expect(lightFallbackId()).toBe(daylight.renderAssetId);

    const next = renderStatus({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
    api.createRender.mockResolvedValue(queued(next));
    chooseLook({ holidayId: 'halloween' });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
    state = useProjectStore.getState();
    expect(state.pending?.look.lightingMode).toBe('evening');
  });

  it('shows no line once the evening version exists', async () => {
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    const evening = variant({
      style: 'abundant',
      lightingMode: 'evening',
      createdAt: '2026-11-08T12:00:00.000Z',
    });
    window.sessionStorage.setItem(
      `hailiday.failedEvenings:${project().id}`,
      JSON.stringify([`${SOURCE_ASSET_ID}|christmas|abundant`]),
    );
    api.getProject.mockResolvedValue(
      project({ variantCount: 2, style: 'abundant', lightingMode: 'source' }),
    );
    api.listVariants.mockResolvedValue({
      items: [daylight, evening],
      activeRender: null,
      offered: null,
    });
    await openProject(project().id, null);
    await settle();
    expect(useProjectStore.getState().variant?.renderAssetId).toBe(daylight.renderAssetId);
    expect(lightFallbackId()).toBeNull();
  });
});

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

function streetCandidate(candidateId: string) {
  return {
    candidateId,
    isPrimary: true,
    rank: 1,
    displayUrl: `https://cdn.test/${candidateId}.jpg`,
    heading: 90,
    headingMode: 'geometry' as const,
    pitch: 0,
    fov: 80,
    captureDate: null,
    captureGranularity: 'month' as const,
    copyright: '© 2026 Google',
    isGoogleImagery: true,
    distanceMeters: 12,
    estimatedFacadePx: null,
    flags: [],
    width: 640,
    height: 640,
  };
}

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
    candidates: [streetCandidate('c-1')],
    attribution: { logo: 'google_maps', required: true },
    nextAction: 'render',
  };
}

describe('a first look the page resumed', () => {
  const job = renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' });
  const place = project({
    kind: 'address',
    variantCount: 0,
    activeSource: streetSource,
    activeRenderJobId: job.renderJobId,
  });

  async function resume() {
    api.getProject.mockResolvedValue(place);
    api.getRender.mockResolvedValue(job);
    await openProject(place.id, null);
    await settle();
    expect(useProjectStore.getState().phase).toBe('waiting');
    expect(useProjectStore.getState().candidates).toHaveLength(0);
    const idle = { ...place, activeRenderJobId: null, projectVersion: 4 };
    api.runSourceDiscovery.mockResolvedValue({ project: idle, discovery: autoStartDiscovery() });
  }

  it('Cancel shows the view to confirm and starts no new look', async () => {
    await resume();
    await cancelRender();
    const state = useProjectStore.getState();
    expect(api.cancelRender).toHaveBeenCalledWith(job.renderJobId);
    expect(api.runSourceDiscovery).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('confirm');
    expect(state.autoStarted).toBe(false);
    expect(state.candidates.map((item) => item.candidateId)).toEqual(['c-1']);
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('"Not your place?" shows the view to confirm and starts no new look', async () => {
    await resume();
    useProjectStore.setState({ autoStarted: true });
    await notYourPlace();
    const state = useProjectStore.getState();
    expect(api.cancelRender).toHaveBeenCalledWith(job.renderJobId);
    expect(state.phase).toBe('confirm');
    expect(state.autoStarted).toBe(false);
    expect(api.createRender).not.toHaveBeenCalled();
  });
});

describe('a reload or a return through history in the middle of a first look', () => {
  const job = renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' });

  it('reads the project of an address entry again and follows the look, with no request', async () => {
    const running = project({
      kind: 'address',
      variantCount: 0,
      activeSource: streetSource,
      activeRenderJobId: job.renderJobId,
    });
    api.getProject.mockResolvedValue(running);
    api.getRender.mockResolvedValue(job);
    // The history entry keeps the address and the entry; the handed-over project was used once.
    await openProject(running.id, { displayAddress: '1735 Magnolia Ter', entry: 'autocomplete' });
    await settle();
    const state = useProjectStore.getState();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('waiting');
    expect(state.render?.renderJobId).toBe(job.renderJobId);
    expect(state.displayAddress).toBe('1735 Magnolia Ter');
    expect(api.runSourceDiscovery).not.toHaveBeenCalled();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(handlers[job.renderJobId]).toBeDefined();
  });

  it('follows the look of an upload entry instead of opening the upload step again', async () => {
    const uploaded = project({
      kind: 'upload',
      variantCount: 0,
      activeRenderJobId: job.renderJobId,
    });
    api.getProject.mockResolvedValue(uploaded);
    api.getRender.mockResolvedValue(job);
    await openProject(uploaded.id, { entry: 'upload', openUpload: true });
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('waiting');
    expect(state.render?.renderJobId).toBe(job.renderJobId);
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('shows the photo of an upload entry, not the upload step, once it is attached', async () => {
    const uploaded = project({ kind: 'upload', variantCount: 1, activeRenderJobId: null });
    api.getProject.mockResolvedValue(uploaded);
    await openProject(uploaded.id, { entry: 'upload', openUpload: true });
    await settle();
    expect(useProjectStore.getState().phase).toBe('result');
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('opens the upload step the upload entry asks for while the project has no photo', async () => {
    const fresh = project({ kind: 'upload', variantCount: 0, activeSource: null });
    await openProject(fresh.id, { project: fresh, entry: 'upload', openUpload: true });
    expect(useProjectStore.getState().phase).toBe('upload');
    expect(api.getProject).not.toHaveBeenCalled();
  });
});

describe('a first look whose job is replaced elsewhere without a successor', () => {
  const first = renderStatus({ state: 'queued' });

  async function waiting() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ kind: 'address', variantCount: 0, activeSource: streetSource }),
      phase: 'confirm',
      candidates: [streetCandidate('c-0')],
      baseCandidateIds: ['c-0'],
      selectedCandidateId: 'c-0',
    });
    api.createRender.mockResolvedValue(queued(first));
    await requestRender();
    expect(useProjectStore.getState().phase).toBe('waiting');
  }

  it('reads the project again and follows the job it runs now', async () => {
    await waiting();
    const next = renderStatus({ state: 'planning', stageLabelKey: 'stage.planning' });
    api.getProject.mockResolvedValue(
      project({
        kind: 'address',
        variantCount: 0,
        projectVersion: 5,
        activeSource: streetSource,
        activeRenderJobId: next.renderJobId,
      }),
    );
    api.getRender.mockResolvedValue(next);
    handlers[first.renderJobId]!.onStatus({ ...first, state: 'superseded', seq: 2 });
    await settle();
    const state = useProjectStore.getState();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('waiting');
    expect(state.render?.renderJobId).toBe(next.renderJobId);
    expect(state.trail?.renderJobId).toBe(next.renderJobId);
    expect(state.project?.projectVersion).toBe(5);
    expect(handlers[next.renderJobId]).toBeDefined();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('leaves the waiting screen for the view to confirm when nothing runs any more', async () => {
    await waiting();
    api.getProject.mockResolvedValue(
      project({ kind: 'address', variantCount: 0, activeSource: streetSource }),
    );
    handlers[first.renderJobId]!.onStatus({ ...first, state: 'superseded', seq: 2 });
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('confirm');
    expect(state.trail).toBeNull();
    expect(api.getRender).not.toHaveBeenCalled();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('leaves the waiting screen too when the project cannot be read', async () => {
    await waiting();
    api.getProject.mockRejectedValue(new Error('network'));
    handlers[first.renderJobId]!.onStatus({ ...first, state: 'superseded', seq: 2 });
    await settle();
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('leaves the screen the person chose alone when they cancel during the read', async () => {
    await waiting();
    const next = renderStatus({ state: 'planning', stageLabelKey: 'stage.planning' });
    let answer: (value: ReturnType<typeof project>) => void = () => undefined;
    api.getProject.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    handlers[first.renderJobId]!.onStatus({ ...first, state: 'superseded', seq: 2 });
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    await cancelRender();
    expect(useProjectStore.getState().phase).toBe('confirm');
    answer(
      project({
        kind: 'address',
        variantCount: 0,
        projectVersion: 5,
        activeSource: streetSource,
        activeRenderJobId: next.renderJobId,
      }),
    );
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('confirm');
    expect(state.project?.projectVersion).not.toBe(5);
    expect(api.getRender).not.toHaveBeenCalled();
    expect(handlers[next.renderJobId]).toBeUndefined();
  });

  it('does not follow a job this page canceled that the project still names', async () => {
    await waiting();
    await cancelRender();
    expect(useProjectStore.getState().phase).toBe('confirm');
    const second = renderStatus({ state: 'queued' });
    api.createRender.mockResolvedValue(queued(second));
    await requestRender();
    expect(useProjectStore.getState().phase).toBe('waiting');
    api.getProject.mockResolvedValue(
      project({
        kind: 'address',
        variantCount: 0,
        activeSource: streetSource,
        activeRenderJobId: first.renderJobId,
      }),
    );
    handlers[second.renderJobId]!.onStatus({ ...second, state: 'superseded', seq: 2 });
    await settle();
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(api.getRender).not.toHaveBeenCalled();
  });

  it('does not stay on loading when the job a page opens on ended this way', async () => {
    const place = project({
      kind: 'address',
      variantCount: 0,
      activeSource: streetSource,
      activeRenderJobId: first.renderJobId,
    });
    const idle = { ...place, activeRenderJobId: null, projectVersion: 4 };
    api.getProject.mockResolvedValueOnce(place).mockResolvedValueOnce(idle);
    api.getRender.mockResolvedValue({ ...first, state: 'superseded', seq: 2 });
    api.runSourceDiscovery.mockResolvedValue({ project: idle, discovery: autoStartDiscovery() });
    await openProject(place.id, null);
    await settle();
    const state = useProjectStore.getState();
    expect(api.getProject).toHaveBeenCalledTimes(2);
    expect(state.phase).toBe('confirm');
    expect(state.candidates.map((item) => item.candidateId)).toEqual(['c-1']);
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('follows the job the project runs now when the page opens on a job replaced this way', async () => {
    const next = renderStatus({ state: 'planning', stageLabelKey: 'stage.planning' });
    const place = project({
      kind: 'address',
      variantCount: 0,
      activeSource: streetSource,
      activeRenderJobId: first.renderJobId,
    });
    api.getProject
      .mockResolvedValueOnce(place)
      .mockResolvedValueOnce({ ...place, activeRenderJobId: next.renderJobId });
    api.getRender
      .mockResolvedValueOnce({ ...first, state: 'superseded', seq: 2 })
      .mockResolvedValueOnce(next);
    await openProject(place.id, null);
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('waiting');
    expect(state.render?.renderJobId).toBe(next.renderJobId);
    expect(handlers[next.renderJobId]).toBeDefined();
  });
});

describe('a first look canceled from another tab or device', () => {
  const job = renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' });

  it('leaves a resumed look for the view to confirm, as Cancel does', async () => {
    const place = project({
      kind: 'address',
      variantCount: 0,
      activeSource: streetSource,
      activeRenderJobId: job.renderJobId,
    });
    api.getProject.mockResolvedValue(place);
    api.getRender.mockResolvedValue(job);
    await openProject(place.id, null);
    await settle();
    expect(useProjectStore.getState().candidates).toHaveLength(0);
    const idle = { ...place, activeRenderJobId: null, projectVersion: 4 };
    api.runSourceDiscovery.mockResolvedValue({ project: idle, discovery: autoStartDiscovery() });
    useProjectStore.setState({ autoStarted: true });
    handlers[job.renderJobId]!.onStatus({ ...job, state: 'canceled', seq: 9 });
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('confirm');
    expect(state.autoStarted).toBe(false);
    expect(state.trail).toBeNull();
    expect(state.candidates.map((item) => item.candidateId)).toEqual(['c-1']);
    expect(api.createRender).not.toHaveBeenCalled();

    // A reload afterwards does not start the canceled look again.
    api.getProject.mockResolvedValue(idle);
    await openProject(place.id, null);
    await settle();
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(api.createRender).not.toHaveBeenCalled();
  });

  it('shows the uploaded photo with "Decorate this photo"', async () => {
    const uploaded = project({ kind: 'upload', variantCount: 0 });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: uploaded.id,
      project: uploaded,
      phase: 'upload',
    });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    expect(useProjectStore.getState().phase).toBe('waiting');
    handlers[job.renderJobId]!.onStatus({ ...job, state: 'canceled', seq: 9 });
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('upload');
    expect(undecoratedUpload(state)).not.toBeNull();
  });
});

describe('a place whose first look the person canceled', () => {
  const job = renderStatus({ state: 'queued' });
  const place = project({ kind: 'address', variantCount: 0, activeSource: streetSource });

  async function canceledAddress() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: place.id,
      project: place,
      phase: 'confirm',
      candidates: [streetCandidate('c-0')],
      baseCandidateIds: ['c-0'],
      selectedCandidateId: 'c-0',
    });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    await cancelRender();
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(api.createRender).toHaveBeenCalledTimes(1);
    api.getProject.mockResolvedValue(place);
    api.runSourceDiscovery.mockResolvedValue({
      project: { ...place, projectVersion: 4 },
      discovery: autoStartDiscovery(),
    });
  }

  it('opens again on the view to confirm, without starting the look', async () => {
    await canceledAddress();
    await openProject(place.id, null);
    await settle();
    const state = useProjectStore.getState();
    expect(api.runSourceDiscovery).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe('confirm');
    expect(state.autoStarted).toBe(false);
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('remembers a cancel made with "Not your place?" too', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: place.id,
      project: place,
      phase: 'confirm',
      candidates: [streetCandidate('c-0')],
      baseCandidateIds: ['c-0'],
      selectedCandidateId: 'c-0',
    });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    useProjectStore.setState({ autoStarted: true });
    await notYourPlace();
    api.getProject.mockResolvedValue(place);
    api.runSourceDiscovery.mockResolvedValue({ project: place, discovery: autoStartDiscovery() });
    await openProject(place.id, null);
    await settle();
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('opens an uploaded photo again on the upload step with "Decorate this photo"', async () => {
    const uploaded = project({ kind: 'upload', variantCount: 0 });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: uploaded.id,
      project: uploaded,
      phase: 'upload',
    });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    await cancelRender();
    expect(useProjectStore.getState().phase).toBe('upload');
    expect(undecoratedUpload(useProjectStore.getState())).not.toBeNull();
    api.getProject.mockResolvedValue(uploaded);
    await openProject(uploaded.id, null);
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('upload');
    expect(undecoratedUpload(state)).not.toBeNull();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('opens an address place with an uploaded photo on the upload step', async () => {
    const withPhoto = project({ kind: 'address', variantCount: 0 });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: withPhoto.id,
      project: withPhoto,
      phase: 'upload',
    });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    await cancelRender();
    api.getProject.mockResolvedValue(withPhoto);
    await openProject(withPhoto.id, null);
    await settle();
    expect(useProjectStore.getState().phase).toBe('upload');
    expect(api.runSourceDiscovery).not.toHaveBeenCalled();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('starts by itself again once the person has started a look for the place', async () => {
    await canceledAddress();
    const second = renderStatus({ state: 'queued' });
    api.createRender.mockResolvedValue(queued(second));
    await requestRender();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    closeProject();
    await openProject(place.id, null);
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(3);
    expect(api.runSourceDiscovery).not.toHaveBeenCalled();
  });

  it('keeps the memory to its own place', async () => {
    await canceledAddress();
    const other = { ...place, id: '018f0000-0000-7000-8000-cccccccccccc' };
    api.getProject.mockResolvedValue(other);
    await openProject(other.id, null);
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({ projectId: other.id });
  });
});

describe('the upload step an upload entry asks for', () => {
  it('is not shown over a running job, even before the photo is ready', async () => {
    const job = renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    const running = project({
      kind: 'upload',
      variantCount: 0,
      activeSource: null,
      activeRenderJobId: job.renderJobId,
    });
    api.getRender.mockResolvedValue(job);
    await openProject(running.id, { project: running, entry: 'upload', openUpload: true });
    await settle();
    const state = useProjectStore.getState();
    expect(api.getRender).toHaveBeenCalledWith(job.renderJobId);
    expect(state.phase).toBe('waiting');
    expect(state.render?.renderJobId).toBe(job.renderJobId);
  });
});

describe('the zoomed street photo after the framing step of a first look', () => {
  const framing = FRAMING_STAGE as StageLabelKey;
  const job = renderStatus({ state: 'queued' });
  const zoomed = { ...streetSource, displayUrl: 'https://cdn.test/zoomed.jpg' };

  async function waitingOn(
    source: typeof streetSource | ReturnType<typeof project>['activeSource'],
  ) {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ kind: 'address', variantCount: 0, activeSource: source }),
      phase: 'confirm',
    });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    expect(useProjectStore.getState().phase).toBe('waiting');
  }

  function report(state: RenderStatus['state'], stageLabelKey: StageLabelKey | null, seq: number) {
    handlers[job.renderJobId]!.onStatus({ ...job, state, stageLabelKey, seq });
  }

  it('reads the project once when the status leaves the framing stage, and shows the zoomed photo', async () => {
    await waitingOn(streetSource);
    api.getProject.mockResolvedValue(
      project({ kind: 'address', variantCount: 0, activeSource: zoomed }),
    );
    report('preparing', framing, 2);
    report('preparing', framing, 3);
    await settle();
    expect(api.getProject).not.toHaveBeenCalled();
    expect(useProjectStore.getState().project?.activeSource?.displayUrl).toBe(
      streetSource.displayUrl,
    );
    expect(useProjectStore.getState().trail?.keys).toEqual(['stage.preparing', framing]);

    report('analyzing', 'stage.planning', 4);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    const state = useProjectStore.getState();
    expect(state.project?.activeSource?.displayUrl).toBe(zoomed.displayUrl);
    expect(state.phase).toBe('waiting');
    expect(state.render?.state).toBe('analyzing');

    report('rendering', 'stage.rendering', 5);
    report('checking', 'stage.checking', 6);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
  });

  it('reads it once per look, even when a late status repeats the framing stage', async () => {
    await waitingOn(streetSource);
    api.getProject.mockResolvedValue(
      project({ kind: 'address', variantCount: 0, activeSource: zoomed }),
    );
    report('preparing', framing, 2);
    report('analyzing', 'stage.planning', 3);
    report('preparing', framing, 2);
    report('analyzing', 'stage.planning', 3);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
  });

  it('reads it when the job ends right after the framing stage', async () => {
    await waitingOn(streetSource);
    api.getProject.mockResolvedValue(
      project({ kind: 'address', variantCount: 0, activeSource: zoomed }),
    );
    api.listVariants.mockResolvedValue({ items: [], activeRender: null, offered: null });
    report('preparing', framing, 2);
    handlers[job.renderJobId]!.onStatus({ ...job, state: 'succeeded', seq: 3, variant: variant() });
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().project?.activeSource?.displayUrl).toBe(zoomed.displayUrl);
  });

  it('keeps the picture on screen when the read fails', async () => {
    await waitingOn(streetSource);
    api.getProject.mockRejectedValue(new Error('network'));
    report('preparing', framing, 2);
    report('analyzing', 'stage.planning', 3);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    const state = useProjectStore.getState();
    expect(state.project?.activeSource?.displayUrl).toBe(streetSource.displayUrl);
    expect(state.phase).toBe('waiting');
  });

  it('reads it once at the first state past preparing when the framing stage passed unseen', async () => {
    await waitingOn(streetSource);
    api.getProject.mockResolvedValue(
      project({ kind: 'address', variantCount: 0, activeSource: zoomed }),
    );
    report('preparing', 'stage.preparing', 2);
    await settle();
    expect(api.getProject).not.toHaveBeenCalled();
    report('analyzing', 'stage.planning', 3);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().project?.activeSource?.displayUrl).toBe(zoomed.displayUrl);
    report('rendering', 'stage.rendering', 4);
    report('checking', 'stage.checking', 5);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
  });

  it('reads it once when the job is already past preparing in its first answer', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ kind: 'address', variantCount: 0, activeSource: streetSource }),
      phase: 'confirm',
    });
    api.createRender.mockResolvedValue(
      queued({ ...job, state: 'analyzing', stageLabelKey: 'stage.planning' }),
    );
    api.getProject.mockResolvedValue(
      project({ kind: 'address', variantCount: 0, activeSource: zoomed }),
    );
    await requestRender();
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().project?.activeSource?.displayUrl).toBe(zoomed.displayUrl);
  });

  it('reads nothing more for a look the page resumed past its preparing step', async () => {
    const running = {
      ...job,
      state: 'rendering' as const,
      stageLabelKey: 'stage.rendering' as const,
    };
    api.getProject.mockResolvedValue(
      project({
        kind: 'address',
        variantCount: 0,
        activeSource: zoomed,
        activeRenderJobId: job.renderJobId,
      }),
    );
    api.getRender.mockResolvedValue(running);
    await openProject(project().id, null);
    await settle();
    expect(useProjectStore.getState().phase).toBe('waiting');
    report('checking', 'stage.checking', 5);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
  });

  it('reads it once for a look the page resumed while it was still preparing', async () => {
    api.getProject.mockResolvedValue(
      project({
        kind: 'address',
        variantCount: 0,
        activeSource: streetSource,
        activeRenderJobId: job.renderJobId,
      }),
    );
    api.getRender.mockResolvedValue({
      ...job,
      state: 'preparing',
      stageLabelKey: 'stage.preparing',
    });
    await openProject(project().id, null);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    api.getProject.mockResolvedValue(
      project({
        kind: 'address',
        variantCount: 0,
        activeSource: zoomed,
        activeRenderJobId: job.renderJobId,
      }),
    );
    report('analyzing', 'stage.planning', 3);
    report('rendering', 'stage.rendering', 4);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().project?.activeSource?.displayUrl).toBe(zoomed.displayUrl);
  });

  it('keeps the picture when the read answers another source', async () => {
    await waitingOn(streetSource);
    api.getProject.mockResolvedValue(
      project({
        kind: 'address',
        variantCount: 0,
        activeSource: { ...zoomed, sourceAssetId: '018f0000-0000-7000-8000-eeeeeeeeeeee' },
      }),
    );
    report('preparing', framing, 2);
    report('analyzing', 'stage.planning', 3);
    await settle();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    const source = useProjectStore.getState().project?.activeSource;
    expect(source?.sourceAssetId).toBe(streetSource.sourceAssetId);
    expect(source?.displayUrl).toBe(streetSource.displayUrl);
  });

  it('changes nothing when the person left the place during the read', async () => {
    await waitingOn(streetSource);
    let answer: (value: ReturnType<typeof project>) => void = () => undefined;
    api.getProject.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    report('preparing', framing, 2);
    report('analyzing', 'stage.planning', 3);
    expect(api.getProject).toHaveBeenCalledTimes(1);
    closeProject();
    // The next place opened shows the same street photo.
    const next = project({ kind: 'address', variantCount: 0, activeSource: streetSource });
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, projectId: next.id, project: next });
    answer(project({ kind: 'address', variantCount: 0, activeSource: zoomed }));
    await settle();
    expect(useProjectStore.getState().project?.activeSource?.displayUrl).toBe(
      streetSource.displayUrl,
    );
  });

  it('reads nothing for another look made from the result', async () => {
    startOnResult();
    useProjectStore.setState({
      project: project({ kind: 'address', variantCount: 2, activeSource: streetSource }),
    });
    const another = renderStatus({ state: 'queued', style: 'abundant' });
    api.createRender.mockResolvedValue(queued(another));
    chooseLook({ style: 'abundant' });
    await settle();
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(another.renderJobId);
    const send = (state: RenderStatus['state'], stageLabelKey: StageLabelKey | null, seq: number) =>
      handlers[another.renderJobId]!.onStatus({ ...another, state, stageLabelKey, seq });
    send('preparing', framing, 2);
    send('analyzing', 'stage.planning', 3);
    send('rendering', 'stage.rendering', 4);
    await settle();
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it('reads nothing for an uploaded photo', async () => {
    await waitingOn(project().activeSource);
    report('preparing', framing, 2);
    report('analyzing', 'stage.planning', 3);
    await settle();
    expect(api.getProject).not.toHaveBeenCalled();
  });
});

describe('a look that does not arrive in full', () => {
  const rejected = { state: 'rejected', seq: 2, rejectionReason: 'qa_critical' } as const;

  function beforeFirstLook() {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 0 }),
      phase: 'confirm',
    });
  }

  it('shows the daylight look a relit first look carries as its result, with the line', async () => {
    beforeFirstLook();
    const job = renderStatus({ style: 'abundant', lightingMode: 'evening' });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender();
    const daylight = variant({ style: 'abundant', lightingMode: 'source' });
    api.listVariants.mockResolvedValue({ items: [daylight], activeRender: null, offered: null });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected, variant: daylight });
    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(daylight);
    expect(state.revealFor).toBe(daylight.renderAssetId);
    expect(useLightFallback.getState().fallback).toEqual({
      renderAssetId: daylight.renderAssetId,
      lightingMode: 'evening',
    });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('shows the look as photographed when a bright look ends without its light', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant', lightingMode: 'bright' });
    api.createRender.mockResolvedValue(queued(job));
    await requestRender({
      look: { holidayId: 'christmas', style: 'abundant', lightingMode: 'bright' },
    });
    const asPhotographed = variant({ style: 'abundant', lightingMode: 'source' });
    handlers[job.renderJobId]!.onStatus({
      ...job,
      state: 'failed',
      seq: 2,
      failureKind: 'timeout',
      variant: asPhotographed,
    });
    await settle();
    const state = useProjectStore.getState();
    expect(state.variant).toBe(asPhotographed);
    expect(state.pending).toBeNull();
    expect(state.pendingError).toBeNull();
    expect(useLightFallback.getState().fallback).toEqual({
      renderAssetId: asPhotographed.renderAssetId,
      lightingMode: 'bright',
    });
    expect(api.createRender).toHaveBeenCalledTimes(1);
  });

  it('asks for the light again from the line, and the line goes when that look starts', async () => {
    startOnResult();
    const job = renderStatus({ lightingMode: 'evening' });
    const again = renderStatus({ lightingMode: 'evening' });
    api.createRender.mockResolvedValueOnce(queued(job)).mockResolvedValueOnce(queued(again));
    chooseLook({ lightingMode: 'evening' });
    await settle();
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    expect(lightFallbackId()).toBe(current.renderAssetId);

    retryLight();
    expect(lightFallbackId()).toBeNull();
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'evening',
    });
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(again.renderJobId);
  });

  it('keeps the light for the next look after the person dismisses the line', async () => {
    startOnResult();
    const job = renderStatus({ holidayId: 'halloween', lightingMode: 'evening' });
    const halloweenDaylight = variant({ holidayId: 'halloween', lightingMode: 'source' });
    api.createRender.mockResolvedValue(queued(job));
    useProjectStore.setState({ variants: [current] });
    chooseLook({ holidayId: 'halloween', lightingMode: 'evening' });
    await settle();
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected, variant: halloweenDaylight });
    await settle();
    dismissLightFallback();
    expect(useLightFallback.getState().dismissed).toBe(true);
    expect(lightFallbackId()).toBe(halloweenDaylight.renderAssetId);

    const next = renderStatus({
      holidayId: 'christmas',
      style: 'abundant',
      lightingMode: 'evening',
    });
    api.createRender.mockResolvedValue(queued(next));
    chooseLook({ style: 'abundant' });
    await settle();
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
  });

  it('takes one more pass at a first look that failed in the decorating service', async () => {
    beforeFirstLook();
    useProjectStore.setState({ project: project({ variantCount: 0, lightingMode: 'source' }) });
    const job = renderStatus({ style: 'abundant' });
    const again = renderStatus({ style: 'abundant' });
    const made = variant({ style: 'abundant', renderJobId: again.renderJobId });
    api.createRender.mockResolvedValueOnce(queued(job)).mockResolvedValueOnce(queued(again));
    await requestRender({
      look: { holidayId: 'christmas', style: 'abundant', lightingMode: 'source' },
    });
    handlers[job.renderJobId]!.onStatus({
      ...job,
      state: 'failed',
      seq: 2,
      failureKind: 'provider_error',
    });
    expect(useProjectStore.getState().phase).toBe('starting');
    expect(useProjectStore.getState().secondPass).toBe(true);
    await settle();
    expect(useProjectStore.getState().phase).toBe('waiting');
    expect(api.createRender.mock.calls[1]![0]).toMatchObject({
      style: 'abundant',
      lightingMode: 'source',
    });
    handlers[again.renderJobId]!.onStatus({ ...again, state: 'succeeded', seq: 3, variant: made });
    const state = useProjectStore.getState();
    expect(state.phase).toBe('result');
    expect(state.variant).toBe(made);
    expect(state.secondPass).toBe(false);
  });

  it('takes no second pass at a refused photo, a place without a usable photo or an expired look', async () => {
    const endings = [
      { state: 'failed', failureKind: 'source_rejected', failureDetail: 'no_usable_anchors' },
      { state: 'failed', failureKind: 'source_unavailable' },
      { state: 'failed', failureKind: 'moderation_blocked' },
      { state: 'failed', failureKind: 'policy_denied' },
      { state: 'expired' },
    ] as const;
    for (const ending of endings) {
      api.createRender.mockClear();
      beforeFirstLook();
      const job = renderStatus();
      api.createRender.mockResolvedValue(queued(job));
      await requestRender({
        look: { holidayId: 'christmas', style: 'classic', lightingMode: 'source' },
      });
      handlers[job.renderJobId]!.onStatus({ ...job, seq: 2, ...ending });
      await settle();
      const state = useProjectStore.getState();
      expect(state.phase, ending.state).toBe('render_error');
      expect(state.render?.state).toBe(ending.state);
      expect(api.createRender).toHaveBeenCalledTimes(1);
    }
  });

  it('gives the look the person asks for again its own second pass', async () => {
    beforeFirstLook();
    const jobs = [0, 1, 2, 3].map(() => renderStatus());
    for (const job of jobs) api.createRender.mockResolvedValueOnce(queued(job));
    const look = { holidayId: 'christmas', style: 'classic', lightingMode: 'source' } as const;
    await requestRender({ look });
    handlers[jobs[0]!.renderJobId]!.onStatus({ ...jobs[0]!, ...rejected });
    await settle();
    handlers[jobs[1]!.renderJobId]!.onStatus({ ...jobs[1]!, ...rejected });
    await settle();
    expect(useProjectStore.getState().phase).toBe('render_error');
    expect(api.createRender).toHaveBeenCalledTimes(2);

    retryRender();
    await settle();
    expect(useProjectStore.getState().secondPass).toBe(false);
    handlers[jobs[2]!.renderJobId]!.onStatus({ ...jobs[2]!, ...rejected });
    await settle();
    expect(api.createRender).toHaveBeenCalledTimes(4);
    expect(useProjectStore.getState().secondPass).toBe(true);
    handlers[jobs[3]!.renderJobId]!.onStatus({ ...jobs[3]!, ...rejected });
    await settle();
    expect(useProjectStore.getState().phase).toBe('render_error');
    expect(api.createRender).toHaveBeenCalledTimes(4);
  });

  it('asks for another look again from its notice, with its own second pass', async () => {
    startOnResult();
    const jobs = [0, 1, 2].map(() => renderStatus({ style: 'abundant' }));
    for (const job of jobs) api.createRender.mockResolvedValueOnce(queued(job));
    chooseLook({ style: 'abundant' });
    await settle();
    handlers[jobs[0]!.renderJobId]!.onStatus({ ...jobs[0]!, ...rejected });
    await settle();
    handlers[jobs[1]!.renderJobId]!.onStatus({ ...jobs[1]!, ...rejected });
    await settle();
    const failed = useProjectStore.getState().pendingError;
    expect(failed?.renderJobId).toBe(jobs[1]!.renderJobId);

    retryPendingLook(failed!);
    await settle();
    let state = useProjectStore.getState();
    expect(state.pendingError).toBeNull();
    expect(state.secondPass).toBe(false);
    expect(state.pending?.render?.renderJobId).toBe(jobs[2]!.renderJobId);
    expect(api.createRender.mock.calls[2]![0]).toMatchObject({ style: 'abundant' });
    handlers[jobs[2]!.renderJobId]!.onStatus({ ...jobs[2]!, ...rejected });
    state = useProjectStore.getState();
    expect(state.secondPass).toBe(true);
    expect(state.pendingError).toBeNull();
  });

  it('lets Cancel stop the second pass of another look', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    const again = renderStatus({ style: 'abundant' });
    api.createRender.mockResolvedValueOnce(queued(job)).mockResolvedValueOnce(queued(again));
    chooseLook({ style: 'abundant' });
    await settle();
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    expect(useProjectStore.getState().pending?.render?.renderJobId).toBe(again.renderJobId);
    await cancelPendingLook();
    const state = useProjectStore.getState();
    expect(state.pending).toBeNull();
    expect(state.secondPass).toBe(false);
    expect(state.pendingError).toBeNull();
    expect(state.variant).toBe(current);
    expect(api.cancelRender).toHaveBeenCalledWith(again.renderJobId);
  });

  it('lets Cancel stop the second pass of a first look', async () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      projectId: project().id,
      project: project({ variantCount: 0 }),
      phase: 'upload',
    });
    const job = renderStatus();
    const again = renderStatus();
    api.createRender.mockResolvedValueOnce(queued(job)).mockResolvedValueOnce(queued(again));
    await requestRender({
      look: { holidayId: 'christmas', style: 'classic', lightingMode: 'source' },
    });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    expect(useProjectStore.getState().render?.renderJobId).toBe(again.renderJobId);
    await cancelRender();
    const state = useProjectStore.getState();
    expect(api.cancelRender).toHaveBeenCalledWith(again.renderJobId);
    // The uploaded photo's first look leaves for the upload step, as Cancel always does.
    expect(state.phase).toBe('upload');
    expect(state.secondPass).toBe(false);
    expect(api.createRender).toHaveBeenCalledTimes(2);
  });

  it('shows the notice when the second pass cannot start', async () => {
    startOnResult();
    const job = renderStatus({ style: 'abundant' });
    api.createRender
      .mockResolvedValueOnce(queued(job))
      .mockRejectedValueOnce(apiError('RATE_LIMITED'));
    chooseLook({ style: 'abundant' });
    await settle();
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    const state = useProjectStore.getState();
    expect(api.createRender).toHaveBeenCalledTimes(2);
    expect(state.pending).toBeNull();
    expect(state.pendingError?.renderJobId).toBe(job.renderJobId);
    expect(state.inlineError).toBeNull();
    expect(state.secondPass).toBe(false);
  });

  it("shows the notice on the place's photo when a first look's second pass cannot start", async () => {
    beforeFirstLook();
    const job = renderStatus();
    api.createRender
      .mockResolvedValueOnce(queued(job))
      .mockRejectedValueOnce(apiError('BUDGET_PAUSED'));
    await requestRender({
      look: { holidayId: 'christmas', style: 'classic', lightingMode: 'source' },
    });
    handlers[job.renderJobId]!.onStatus({ ...job, ...rejected });
    await settle();
    const state = useProjectStore.getState();
    expect(state.phase).toBe('render_error');
    expect(state.render?.renderJobId).toBe(job.renderJobId);
    expect(state.inlineError).toBeNull();
  });
});
