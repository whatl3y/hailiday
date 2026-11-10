import {
  DEFAULT_LIGHTING_MODE,
  DEFAULT_STYLE,
  NUDGE_FOV_STEPS,
  NUDGE_HEADING_MAX_DEGREES,
  NUDGE_HEADING_STEP_DEGREES,
  UuidSchema,
  isTerminalRenderJobState,
  type Candidate,
  type Discovery,
  type HolidayId,
  type LightingMode,
  type Project,
  type RenderStatus,
  type Variant,
} from '@holiday/core';
import {
  cancelRender as cancelRenderRequest,
  createRender,
  getProject,
  getRender,
  listVariants,
  putProjectSource,
  putViewpoint,
  runSourceDiscovery,
} from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { presentError } from '../../api/present';
import { isPermanentRenderError, subscribeToRender, type RenderSubscription } from '../../api/sse';
import { currentHolidayId, hasChosenHoliday, isOffSeason, useAppStore } from '../../state/appStore';
import {
  INITIAL_PROJECT_FLOW,
  baseCandidateOf,
  lookOf,
  patchProject,
  useProjectStore,
  type InlineRetry,
  type Look,
  type NoStreetViewCause,
  type ProjectFlowState,
  type ProjectPhase,
  type UploadContext,
  type UploadReturnPhase,
} from '../../state/projectStore';
import type { ProjectRouteState } from '../address/useResolveAddress';
import type { SceneChoice } from '../upload/SceneChooser';
import {
  findCachedVariant,
  looksExhausted,
  newestFirst,
  normalizeLook,
  offeredForHoliday,
  sameLook,
  variantsOfSource,
  withVariant,
} from './looks';

let subscription: RenderSubscription | null = null;
let generation = 0;
let retryId = 0;
/** A look chosen while the first render request is in flight, requested once it answers. */
let queuedStartLook: Look | null = null;

function state() {
  return useProjectStore.getState();
}

function isCurrent(token: number): boolean {
  return token === generation;
}

function setProjectData(project: Project): void {
  patchProject({ project, projectId: project.id });
  useAppStore.getState().setAllowance(project.allowance);
  useAppStore.getState().rememberProject(project.id);
}

function stopFollowing(): void {
  subscription?.close();
  subscription = null;
}

/** Leaves the project screen: stops live updates without canceling anything. */
export function closeProject(): void {
  generation += 1;
  lookToken += 1;
  queuedStartLook = null;
  clearLookTimer();
  stopFollowing();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
}

/**
 * The inline message for a failed action, plus a "Try again" when the action was rate limited
 * (enabled after the wait) or its session could not start (enabled after any session wait).
 */
function inlineFailure(
  error: unknown,
  retry: () => void,
): Pick<ProjectFlowState, 'inlineError' | 'inlineRetry'> {
  const inline = presentError(error, retry);
  const rateLimited = isApiError(error) && error.code === 'RATE_LIMITED';
  const sessionFailed = isApiError(error) && error.session;
  const inlineRetry: InlineRetry | null =
    inline && (rateLimited || sessionFailed)
      ? {
          id: ++retryId,
          retryAfterSeconds: rateLimited ? (inline.error?.retryAfterSeconds ?? null) : 0,
          retry,
        }
      : null;
  return { inlineError: inline?.message ?? null, inlineRetry };
}

/** Errors after which the project or its render job no longer exists for this session. */
function isGone(error: unknown): boolean {
  return isApiError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN');
}

/** Loads a project (from router state or the API) and routes to the right screen. */
export async function openProject(
  projectId: string,
  routeState: ProjectRouteState | null,
): Promise<void> {
  closeProject();
  const token = generation;
  if (!UuidSchema.safeParse(projectId).success) {
    // Project identifiers are UUIDs; anything else is a mistyped or truncated link.
    useAppStore.getState().forgetProject(projectId);
    patchProject({ projectId, phase: 'not_found' });
    return;
  }
  patchProject({
    projectId,
    phase: 'loading',
    displayAddress: routeState?.displayAddress ?? null,
    entry: routeState?.entry ?? null,
  });
  let project = routeState?.project?.id === projectId ? routeState.project : null;
  if (!project) {
    try {
      project = await getProject(projectId);
    } catch (error) {
      if (!isCurrent(token)) return;
      const notFound = isGone(error) || (isApiError(error) && error.code === 'VALIDATION_FAILED');
      if (notFound) {
        useAppStore.getState().forgetProject(projectId);
        patchProject({ phase: 'not_found' });
        return;
      }
      patchProject({
        phase: 'error',
        ...inlineFailure(error, () => void openProject(projectId, routeState)),
      });
      return;
    }
  }
  if (!isCurrent(token)) return;
  setProjectData(project);
  if (project.holidayId && project.variantCount > 0 && !useAppStore.getState().explicitHolidayId) {
    // A saved project carries its explicit holiday.
    useAppStore.getState().chooseHoliday(project.holidayId);
  }
  if (routeState?.openUpload) {
    showUpload('project');
    return;
  }
  await routeProject(token);
}

async function routeProject(token: number): Promise<void> {
  const { project } = state();
  if (!project) return;
  if (project.variantCount > 0) {
    await loadVariants(token);
    if (!isCurrent(token)) return;
  }
  if (project.activeRenderJobId) {
    await resumeRender(project.activeRenderJobId, token);
    return;
  }
  if (project.variantCount > 0 && state().variant) {
    patchProject({ phase: 'result' });
    return;
  }
  const source = project.activeSource;
  if (project.kind === 'upload') {
    if (source && source.state === 'ready' && readyToRender()) await requestRender();
    else showUpload('project');
    return;
  }
  if (source && source.state === 'ready') {
    if (source.kind === 'upload' || project.discovery?.sourceMode !== 'display_only') {
      if (readyToRender()) {
        await requestRender();
        return;
      }
    }
  }
  await discover(token);
}

/** Whether a render may start without asking for a holiday first. */
function readyToRender(): boolean {
  const app = useAppStore.getState();
  return !isOffSeason(app) || hasChosenHoliday(app);
}

/** Runs (or replays) source discovery and routes on its outcome. */
export async function discover(token: number = generation): Promise<void> {
  const { project } = state();
  if (!project) return;
  patchProject({ phase: 'finding', inlineError: null, nosvCause: null });
  try {
    const result = await runSourceDiscovery(project.id, project.projectVersion);
    if (!isCurrent(token)) return;
    setProjectData(result.project);
    applyDiscovery(result.discovery);
    await routeDiscovery(result.discovery);
  } catch (error) {
    if (!isCurrent(token)) return;
    if (isApiError(error) && error.code === 'STALE_PROJECT_VERSION') {
      const fresh = await getProject(project.id).catch(() => null);
      if (fresh && isCurrent(token)) {
        setProjectData(fresh);
        await discover(token);
        return;
      }
    }
    const inline = presentError(error);
    patchProject({ phase: 'nosv', inlineError: inline?.message ?? null, discovery: null });
  }
}

function applyDiscovery(discovery: Discovery): void {
  const primary =
    discovery.candidates.find((candidate) => candidate.isPrimary) ?? discovery.candidates[0];
  patchProject({
    discovery,
    candidates: discovery.candidates,
    baseCandidateIds: discovery.candidates.map((candidate) => candidate.candidateId),
    selectedCandidateId: primary?.candidateId ?? null,
    remainingDisplayLoads: discovery.remainingDisplayLoads,
    nudgeOffsets: {},
  });
}

async function routeDiscovery(discovery: Discovery): Promise<void> {
  if (discovery.matchClass === 'skip_to_upload') {
    patchProject({
      phase:
        discovery.sourceMode === 'display_only' && discovery.candidates.length > 0
          ? 'confirm'
          : 'nosv',
    });
    return;
  }
  if (discovery.nextAction === 'render' && readyToRender()) {
    patchProject({ autoStarted: true });
    await requestRender();
    return;
  }
  patchProject({ phase: 'confirm', autoStarted: false });
}

/** The screen the upload step returns to with Cancel, when one is on screen now. */
function uploadReturnPhaseFor(current: ProjectFlowState): UploadReturnPhase | null {
  if (current.phase === 'result' && current.variant) return 'result';
  if (current.phase === 'confirm' && current.candidates.length > 0) return 'confirm';
  if (current.phase === 'render_error' && current.render) return 'render_error';
  return null;
}

/** Shows the upload step inside the project. */
export function showUpload(context: UploadContext): void {
  const uploadReturnPhase = uploadReturnPhaseFor(state());
  lookToken += 1;
  clearLookTimer();
  stopFollowing();
  patchProject({
    phase: 'upload',
    uploadContext: context,
    uploadReturnPhase,
    inlineError: null,
    pending: null,
    pendingError: null,
  });
}

/**
 * Cancel on the upload step: back to the result, confirm screen or render error it replaced.
 * When a new photo was attached in the meantime (so no preview is on screen any more), the
 * result shows the project's newest preview.
 */
export function cancelUpload(): void {
  const current = state();
  const back = current.uploadReturnPhase;
  if (!back) return;
  if (back === 'result' && !current.variant) {
    const newest = current.variants[0];
    if (!newest) return;
    showVariant(newest, 'cache');
    patchProject({ uploadReturnPhase: null, inlineError: null });
    return;
  }
  if (uploadReturnPhaseFor({ ...current, phase: back }) !== back) return;
  patchProject({ phase: back, uploadReturnPhase: null, inlineError: null });
}

/**
 * Opens the No Street View screen for an error code (the panorama is gone, or the project has
 * no usable source) after discovery had found one.
 */
function openNoStreetView(cause: NoStreetViewCause): void {
  lookToken += 1;
  queuedStartLook = null;
  clearLookTimer();
  stopFollowing();
  patchProject({
    phase: 'nosv',
    nosvCause: cause,
    uploadContext: 'nosv',
    inlineError: null,
    pending: null,
    pendingError: null,
    busy: false,
  });
}

/** Called by the upload step once the photo is attached as the project's source. */
export async function onUploadAttached(project: Project): Promise<void> {
  const current = state();
  setProjectData(project);
  // A new photo opens on the waiting screen and arrives as its own reveal; earlier previews
  // stay in the project's list, and Cancel can still go back to the newest of them while the
  // upload step shows. The attached photo is no longer a replacement in progress, so the upload
  // step keeps it on screen if its first look cannot start.
  patchProject({
    autoStarted: false,
    variant: null,
    look: null,
    offered: null,
    uploadContext: 'project',
    uploadReturnPhase: current.variants.length > 0 ? 'result' : null,
    nosvCause: null,
  });
  await requestRender();
}

/**
 * Corrects the scene type of an uploaded photo after a result: the source is re-attached with
 * the new type (the server makes it a new source asset once a render exists) and a new render
 * of the current look follows under the pending band. Earlier variants stay in the history.
 */
export async function changeSceneType(choice: SceneChoice, retried = false): Promise<void> {
  const { project, look, variant } = state();
  const source = project?.activeSource;
  if (!project || !source || source.kind !== 'upload') return;
  const roomType = choice.sceneType === 'interior' ? choice.roomType : null;
  if (project.sceneType === choice.sceneType && (project.roomType ?? null) === roomType) return;
  patchProject({ busy: true, inlineError: null });
  try {
    const updated = await putProjectSource(project.id, {
      projectVersion: project.projectVersion,
      sourceAssetId: source.sourceAssetId,
      sceneType: choice.sceneType,
      roomType,
    });
    setProjectData(updated);
    patchProject({ busy: false, offered: updated.offered });
    const base = look ?? (variant ? lookOf(variant) : null);
    await requestRender(
      base ? { look: normalizeLook(base, offeredFor(base.holidayId)) } : undefined,
    );
  } catch (error) {
    patchProject({ busy: false });
    if (isApiError(error) && error.code === 'STALE_PROJECT_VERSION' && !retried) {
      const fresh = await getProject(project.id).catch(() => null);
      if (fresh) {
        setProjectData(fresh);
        await changeSceneType(choice, true);
        return;
      }
    }
    patchProject(inlineFailure(error, () => void changeSceneType(choice)));
  }
}

/** Selects one of the base candidates, loading its image on request when needed. */
export async function selectView(candidateId: string): Promise<void> {
  const current = state();
  const candidate = current.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate || !current.project) return;
  if (candidate.displayUrl) {
    patchProject({ selectedCandidateId: candidateId, inlineError: null });
    return;
  }
  if (current.remainingDisplayLoads <= 0) return;
  patchProject({ busy: true, inlineError: null });
  try {
    const response = await putViewpoint(current.project.id, {
      projectVersion: current.project.projectVersion,
      candidateId,
    });
    replaceCandidate(candidateId, response.candidate);
    patchProject({
      selectedCandidateId: response.candidate.candidateId,
      remainingDisplayLoads: response.remainingDisplayLoads,
    });
  } catch (error) {
    handleViewpointError(error, () => void selectView(candidateId));
  } finally {
    patchProject({ busy: false });
  }
}

function replaceCandidate(candidateId: string, next: Candidate): void {
  const { candidates, baseCandidateIds } = state();
  const exists = candidates.some((item) => item.candidateId === candidateId);
  patchProject({
    candidates: exists
      ? candidates.map((item) => (item.candidateId === candidateId ? next : item))
      : [...candidates, next],
    baseCandidateIds: baseCandidateIds.map((id) => (id === candidateId ? next.candidateId : id)),
  });
}

function handleViewpointError(error: unknown, retry: () => void): void {
  if (isApiError(error) && error.code === 'RATE_LIMITED' && error.retryAfterSeconds === null) {
    patchProject({ remainingDisplayLoads: 0 });
    return;
  }
  if (isApiError(error) && error.code === 'NO_STREET_VIEW') {
    openNoStreetView('NO_STREET_VIEW');
    return;
  }
  patchProject(inlineFailure(error, retry));
}

/** The nearest allowed field of view for a nudge. */
function nudgeFov(fov: number): number {
  return [...NUDGE_FOV_STEPS].sort((a, b) => Math.abs(a - fov) - Math.abs(b - fov))[0] ?? 75;
}

/** Whether a nudge in a direction stays inside the heading bounds. */
export function canNudge(direction: -1 | 1): boolean {
  const current = state();
  const base = baseCandidateOf(current, current.selectedCandidateId);
  if (!base) return false;
  const offset = (current.nudgeOffsets[base] ?? 0) + direction * NUDGE_HEADING_STEP_DEGREES;
  return Math.abs(offset) <= NUDGE_HEADING_MAX_DEGREES && current.remainingDisplayLoads > 0;
}

/** Turns the view left (-1) or right (+1) by one heading step. */
export async function nudge(direction: -1 | 1): Promise<void> {
  const current = state();
  const base = baseCandidateOf(current, current.selectedCandidateId);
  const baseCandidate = current.candidates.find((item) => item.candidateId === base);
  if (!base || !baseCandidate || !current.project || !canNudge(direction)) return;
  const offset = (current.nudgeOffsets[base] ?? 0) + direction * NUDGE_HEADING_STEP_DEGREES;
  if (offset === 0) {
    patchProject({
      selectedCandidateId: base,
      nudgeOffsets: { ...current.nudgeOffsets, [base]: 0 },
    });
    return;
  }
  const cached = current.candidates.find(
    (item) =>
      item.derivedFromCandidateId === base &&
      Math.round(((item.heading - baseCandidate.heading + 540) % 360) - 180) === offset,
  );
  if (cached) {
    patchProject({
      selectedCandidateId: cached.candidateId,
      nudgeOffsets: { ...current.nudgeOffsets, [base]: offset },
    });
    return;
  }
  patchProject({ busy: true, inlineError: null });
  try {
    const response = await putViewpoint(current.project.id, {
      projectVersion: current.project.projectVersion,
      candidateId: base,
      nudge: { headingDelta: offset, fov: nudgeFov(baseCandidate.fov) },
    });
    const derived = {
      ...response.candidate,
      derivedFromCandidateId: response.candidate.derivedFromCandidateId ?? base,
    };
    patchProject({
      candidates: [...state().candidates, derived],
      selectedCandidateId: derived.candidateId,
      remainingDisplayLoads: response.remainingDisplayLoads,
      nudgeOffsets: { ...state().nudgeOffsets, [base]: offset },
    });
  } catch (error) {
    handleViewpointError(error, () => void nudge(direction));
  } finally {
    patchProject({ busy: false });
  }
}

/** "Yes, decorate this place": binds the chosen view and starts the render. */
export async function confirmPlace(): Promise<void> {
  const current = state();
  if (!current.project || !current.selectedCandidateId) return;
  if (!readyToRender()) {
    patchProject({ inlineError: null });
    return;
  }
  patchProject({ busy: true, inlineError: null, confirmNotice: null });
  try {
    const project = await putProjectSource(current.project.id, {
      projectVersion: current.project.projectVersion,
      candidateId: current.selectedCandidateId,
    });
    setProjectData(project);
    patchProject({ busy: false, autoStarted: false });
    await requestRender();
  } catch (error) {
    patchProject({ busy: false });
    if (isApiError(error) && error.code === 'STALE_PROJECT_VERSION') {
      const fresh = await getProject(current.project.id).catch(() => null);
      if (fresh) {
        setProjectData(fresh);
        patchProject({ inlineError: null });
        await confirmPlace();
        return;
      }
    }
    if (isApiError(error) && error.code === 'NO_STREET_VIEW') {
      openNoStreetView('NO_STREET_VIEW');
      return;
    }
    patchProject(inlineFailure(error, () => void confirmPlace()));
  }
}

export interface RenderOptions {
  /** Overrides the project's lighting mode ("Show it as photographed"). */
  lightingMode?: LightingMode;
  /** The full look to render (controls under the result). */
  look?: Look;
  retried?: boolean;
}

/** Rapid taps on the look controls are coalesced; only the latest look is requested. */
export const LOOK_DEBOUNCE_MS = 400;

let lookTimer: ReturnType<typeof setTimeout> | null = null;
/** Incremented whenever the person picks another look, so stale responses are ignored. */
let lookToken = 0;

function clearLookTimer(): void {
  if (lookTimer) clearTimeout(lookTimer);
  lookTimer = null;
}

function renderSelection(project: Project) {
  const offered = project.offered;
  const style = !offered || offered.styles.includes(project.style) ? project.style : DEFAULT_STYLE;
  const lightingMode =
    !offered || offered.lightingModes.includes(project.lightingMode)
      ? project.lightingMode
      : DEFAULT_LIGHTING_MODE;
  return { style, lightingMode };
}

/** The offered styles and lighting for a holiday on the current project. */
export function offeredFor(holidayId: HolidayId) {
  const { project, offered } = state();
  return offeredForHoliday({
    holidayId,
    projectHolidayId: project?.holidayId ?? null,
    projectOffered: offered ?? project?.offered ?? null,
    sceneType: project?.sceneType ?? null,
    holidays: useAppStore.getState().experience?.holidays ?? [],
  });
}

/** Whether a render request should keep the current preview on screen (a new look). */
function isPendingMode(): boolean {
  const { variant, phase } = state();
  return variant !== null && (phase === 'result' || phase === 'render_error');
}

function openAllowanceSheet(): void {
  const app = useAppStore.getState();
  app.openSheet({
    kind: 'allowance',
    scope: 'variants',
    resetsAt: app.allowance?.variants.resetsAt ?? null,
  });
}

/** Reverts the controls to the look on screen. */
function settleLook(): void {
  const { variant } = state();
  patchProject({ pending: null, look: variant ? lookOf(variant) : null });
}

/**
 * Requests a render for the project's current source. Without a preview on screen a queued
 * job opens the waiting screen; with one (a new look) the preview stays under the pending band.
 * A cached variant opens at once.
 */
export async function requestRender(options: RenderOptions = {}): Promise<void> {
  const current = state();
  const project = current.project;
  const holidayId =
    options.look?.holidayId ?? currentHolidayId(useAppStore.getState()) ?? project?.holidayId;
  if (!project || !holidayId) return;
  const look: Look = options.look ?? {
    holidayId,
    ...renderSelection(project),
    ...(options.lightingMode ? { lightingMode: options.lightingMode } : {}),
  };
  const pendingMode = isPendingMode();
  const returnPhase: ProjectPhase = pendingMode
    ? 'result'
    : current.phase === 'starting' || current.phase === 'loading' || current.phase === 'finding'
      ? project.variantCount > 0
        ? 'result'
        : project.kind === 'upload' || project.activeSource?.kind === 'upload'
          ? 'upload'
          : 'confirm'
      : current.phase;
  // At the allowance limit the sheet opens without a request when the server could not answer
  // with a cached variant: a new look (the project's list was checked first) or the first look
  // of an uploaded photo. The uploaded photo stays attached and on screen.
  const uploadFirstLook =
    current.variant === null &&
    project.activeSource?.kind === 'upload' &&
    project.activeSource.state === 'ready';
  if ((pendingMode || uploadFirstLook) && looksExhausted(useAppStore.getState().allowance)) {
    if (pendingMode) settleLook();
    else patchProject({ phase: returnPhase, inlineError: null });
    openAllowanceSheet();
    return;
  }
  const token = generation;
  const myLook = lookToken;
  if (pendingMode) {
    patchProject({
      phase: 'result',
      pending: { look, render: null },
      look,
      pendingError: null,
      inlineError: null,
    });
  } else {
    patchProject({ phase: 'starting', inlineError: null });
  }
  try {
    const response = await createRender(
      {
        projectId: project.id,
        projectVersion: state().project?.projectVersion ?? project.projectVersion,
        ...look,
      },
      crypto.randomUUID(),
    );
    if (!isCurrent(token)) return;
    useAppStore.getState().setAllowance(response.allowance);
    if (pendingMode && myLook !== lookToken) {
      // The person picked another look while this request was in flight.
      if (!response.cached) void cancelRenderRequest(response.renderJobId).catch(() => undefined);
      return;
    }
    if (response.cached) {
      showVariant(response.variant, 'cache');
    } else {
      applyStatus(response);
      follow(response.renderJobId);
    }
    if (!pendingMode) requestQueuedStartLook();
  } catch (error) {
    if (!isCurrent(token)) return;
    if (!pendingMode) queuedStartLook = null;
    if (pendingMode && myLook !== lookToken) return;
    if (pendingMode) settleLook();
    await handleRenderRequestError(error, returnPhase, options);
  }
}

/** Requests the look chosen while the first render request was in flight. */
function requestQueuedStartLook(): void {
  const look = queuedStartLook;
  queuedStartLook = null;
  if (!look) return;
  const current = state();
  if (current.phase === 'result') {
    chooseLook(look);
    return;
  }
  if (current.render && sameLook(lookOf(current.render), look)) return;
  void requestRender({ look });
}

/**
 * A holiday chosen in the header chip. On a result it changes the look; while the first
 * render is starting or waiting it requests the new holiday's render (the server supersedes the
 * earlier job), so the result always matches the chip. Elsewhere the choice is kept for the
 * next render request.
 */
export function changeHoliday(holidayId: HolidayId): void {
  const current = state();
  if (current.phase === 'result') {
    chooseLook({ holidayId });
    return;
  }
  if (!current.project || (current.phase !== 'starting' && current.phase !== 'waiting')) return;
  const base: Look = current.render
    ? lookOf(current.render)
    : { holidayId, ...renderSelection(current.project) };
  const look = normalizeLook({ ...base, holidayId }, offeredFor(holidayId));
  if (current.phase === 'starting') {
    queuedStartLook = look;
    return;
  }
  if (current.render && sameLook(lookOf(current.render), look)) return;
  void requestRender({ look });
}

/** Puts an accepted variant on screen and records it in the project's list. */
function showVariant(variant: Variant, source: 'render' | 'cache'): void {
  const current = state();
  const project = current.project;
  const firstOnScreen = current.variant === null && source === 'render';
  patchProject({
    variant,
    variants: withVariant(current.variants, variant),
    look: lookOf(variant),
    pending: null,
    pendingError: null,
    phase: 'result',
    // The reveal plays once: another variant on screen ends it for good.
    revealFor: firstOnScreen
      ? variant.renderAssetId
      : current.revealFor === variant.renderAssetId
        ? current.revealFor
        : null,
    project: project
      ? {
          ...project,
          activeRenderJobId: null,
          variantCount: Math.max(
            project.variantCount,
            withVariant(current.variants, variant).length,
          ),
          holidayId: variant.holidayId,
          style: variant.style,
          lightingMode: variant.lightingMode,
        }
      : project,
  });
}

async function handleRenderRequestError(
  error: unknown,
  returnPhase: ProjectPhase,
  options: RenderOptions,
) {
  const { project } = state();
  if (isApiError(error) && project) {
    switch (error.code) {
      case 'STALE_PROJECT_VERSION': {
        const fresh = await getProject(project.id).catch(() => null);
        if (fresh && !options.retried) {
          setProjectData(fresh);
          if (returnPhase === 'result') patchProject({ phase: 'result' });
          await requestRender({ ...options, retried: true });
          return;
        }
        break;
      }
      case 'NEEDS_CONFIRMATION':
        if (state().candidates.length > 0) patchProject({ phase: 'confirm' });
        else await discover();
        return;
      case 'NO_STREET_VIEW':
        openNoStreetView('NO_STREET_VIEW');
        return;
      case 'NEEDS_PHOTO':
        if (project.kind === 'upload') {
          showUpload('project');
          patchProject({ inlineError: presentError(error)?.message ?? null });
        } else {
          openNoStreetView('NEEDS_PHOTO');
        }
        return;
      case 'SOURCE_NOT_EDITABLE': {
        const reason = error.typedDetails('SOURCE_NOT_EDITABLE')?.reason;
        if (reason === 'display_only') {
          patchProject({ phase: 'confirm' });
          return;
        }
        if (reason === 'stale') {
          const fresh = await getProject(project.id).catch(() => null);
          if (fresh) setProjectData(fresh);
          patchProject({ confirmNotice: 'viewChanged' });
          await discover();
          patchProject({ confirmNotice: 'viewChanged', phase: 'confirm', autoStarted: false });
          return;
        }
        showUpload('replace');
        patchProject({ inlineError: presentError(error)?.message ?? null });
        return;
      }
      default:
        break;
    }
  }
  patchProject({
    phase: returnPhase,
    ...inlineFailure(error, () => void requestRender({ ...options, retried: false })),
  });
}

/** Whether a status belongs to the look the pending band shows. */
function matchesPending(status: RenderStatus): boolean {
  const { pending } = state();
  if (!pending) return false;
  if (pending.render) return pending.render.renderJobId === status.renderJobId;
  return sameLook(pending.look, lookOf(status));
}

function applyStatus(status: RenderStatus): void {
  useAppStore.getState().setAllowance(status.allowance);
  const current = state();
  if (current.project && status.projectVersion > current.project.projectVersion) {
    patchProject({ project: { ...current.project, projectVersion: status.projectVersion } });
  }
  if (current.pending) {
    applyPendingStatus(status);
    return;
  }
  if (status.state === 'succeeded' && status.variant) {
    patchProject({ render: status });
    showVariant(status.variant, 'render');
    void loadVariants();
    return;
  }
  if (status.state === 'failed' || status.state === 'rejected' || status.state === 'expired') {
    patchProject({ render: status, phase: 'render_error' });
    return;
  }
  if (status.state === 'superseded') {
    if (status.supersededByRenderJobId) follow(status.supersededByRenderJobId);
    return;
  }
  if (status.state === 'canceled') {
    const { variant, project } = state();
    const uploadSource = project?.kind === 'upload' || project?.activeSource?.kind === 'upload';
    patchProject({
      render: status,
      phase: variant ? 'result' : uploadSource ? 'upload' : 'confirm',
    });
    return;
  }
  patchProject({ render: status, phase: 'waiting' });
}

/** A status for a new look while the current preview stays on screen. */
function applyPendingStatus(status: RenderStatus): void {
  const { pending, variants } = state();
  if (!pending) return;
  if (!matchesPending(status)) {
    // An earlier look finished after the person moved on: keep it for instant switching.
    if (status.state === 'succeeded' && status.variant) {
      patchProject({ variants: withVariant(variants, status.variant) });
    }
    if (status.state === 'superseded' && status.supersededByRenderJobId) {
      follow(status.supersededByRenderJobId);
    }
    return;
  }
  switch (status.state) {
    case 'succeeded':
      if (status.variant) {
        showVariant(status.variant, 'render');
        void loadVariants();
      }
      return;
    case 'failed':
    case 'rejected':
    case 'expired':
      stopFollowing();
      settleLook();
      patchProject({ pendingError: status });
      return;
    case 'canceled':
      settleLook();
      return;
    case 'superseded':
      if (status.supersededByRenderJobId) follow(status.supersededByRenderJobId);
      return;
    default:
      patchProject({ pending: { look: pending.look, render: status } });
  }
}

function follow(renderJobId: string): void {
  stopFollowing();
  const pollMs = useAppStore.getState().experience?.clientConfig.pollRenderMs;
  subscription = subscribeToRender(
    renderJobId,
    {
      onStatus: (status) => {
        if (status.renderJobId !== renderJobId) return;
        applyStatus(status);
      },
      onError: (error) => {
        if (!isPermanentRenderError(error)) return;
        // The job (and so the project) no longer exists for this session.
        stopFollowing();
        lookToken += 1;
        clearLookTimer();
        const { projectId } = state();
        if (projectId) useAppStore.getState().forgetProject(projectId);
        patchProject({ phase: 'not_found', pending: null, pendingError: null, busy: false });
      },
    },
    { pollMs, fetchStatus: (id, signal) => getRender(id, signal) },
  );
}

async function resumeRender(renderJobId: string, token: number): Promise<void> {
  try {
    const status = await getRender(renderJobId);
    if (!isCurrent(token)) return;
    if (state().variant && !isTerminalRenderJobState(status.state)) {
      patchProject({ phase: 'result', pending: { look: lookOf(status), render: status } });
      follow(renderJobId);
      return;
    }
    applyStatus(status);
    if (!isTerminalRenderJobState(status.state)) follow(renderJobId);
  } catch (error) {
    if (!isCurrent(token)) return;
    if (state().variant) {
      patchProject({ phase: 'result' });
      return;
    }
    patchProject({ phase: 'error', inlineError: presentError(error)?.message ?? null });
  }
}

/**
 * The variant to open a project on: the selected holiday's look of the active source first,
 * then the newest of that source, and only then a variant of an earlier source.
 */
function initialVariant(items: readonly Variant[]): Variant | null {
  const { project } = state();
  const selected = currentHolidayId(useAppStore.getState());
  const sourceAssetId = project?.activeSource?.sourceAssetId ?? null;
  const own = variantsOfSource(items, sourceAssetId);
  return (
    (project
      ? findCachedVariant(
          items,
          {
            holidayId: selected ?? project.holidayId,
            style: project.style,
            lightingMode: project.lightingMode,
          },
          sourceAssetId,
        )
      : null) ??
    own.find((item) => item.holidayId === selected) ??
    own[0] ??
    items.find((item) => item.holidayId === selected) ??
    items[0] ??
    null
  );
}

/**
 * Reads the project's accepted variants and offered sets. The variant on screen is kept as
 * it is (its signed URLs stay stable); a project without one opens on the best match.
 */
export async function loadVariants(token: number = generation): Promise<void> {
  const project = state().project;
  if (!project) return;
  try {
    const list = await listVariants(project.id);
    if (!isCurrent(token)) return;
    const items = newestFirst(list.items);
    const current = state();
    const variant = current.variant ?? initialVariant(items);
    patchProject({
      variants: items,
      offered: list.offered ?? current.offered ?? project.offered,
      variant,
      look: current.look ?? (variant ? lookOf(variant) : null),
    });
  } catch {
    // The preview on screen stays usable; switching looks falls back to new requests.
  }
}

/**
 * A tap on the holiday, style or lighting control. A cached variant switches instantly; at
 * the allowance limit the sheet opens instead of a request; otherwise the newest choice is
 * requested after a short pause, and the preview stays under the pending band.
 */
export function chooseLook(partial: Partial<Look>): void {
  const current = state();
  if (!current.project || !current.variant) return;
  const base = current.look ?? lookOf(current.variant);
  const holidayId = partial.holidayId ?? base.holidayId;
  const next = normalizeLook({ ...base, ...partial, holidayId }, offeredFor(holidayId));
  if (sameLook(next, current.look) && !current.pendingError) return;
  lookToken += 1;
  clearLookTimer();
  const cached = findCachedVariant(
    current.variants,
    next,
    current.project.activeSource?.sourceAssetId,
  );
  if (cached) {
    const running = current.pending?.render;
    if (current.pending) stopFollowing();
    if (running && !isTerminalRenderJobState(running.state)) {
      void cancelRenderRequest(running.renderJobId).catch(() => undefined);
    }
    patchProject({
      variant: cached,
      look: next,
      pending: null,
      pendingError: null,
      inlineError: null,
      revealFor: null,
    });
    return;
  }
  if (looksExhausted(useAppStore.getState().allowance)) {
    openAllowanceSheet();
    return;
  }
  patchProject({ look: next, pending: { look: next, render: null }, pendingError: null });
  lookTimer = setTimeout(() => {
    lookTimer = null;
    void requestRender({ look: next });
  }, LOOK_DEBOUNCE_MS);
}

/** Cancel on the pending band: the current preview stays. */
export async function cancelPendingLook(): Promise<void> {
  const { pending } = state();
  if (!pending) return;
  lookToken += 1;
  clearLookTimer();
  stopFollowing();
  settleLook();
  const running = pending.render;
  if (running && !isTerminalRenderJobState(running.state)) {
    await cancelRenderRequest(running.renderJobId).catch(() => undefined);
  }
}

/** Closes the error sheet of a failed new look. */
export function dismissPendingError(): void {
  patchProject({ pendingError: null });
}

/** Cancels the running render and returns to the previous result or the confirm screen. */
export async function cancelRender(): Promise<void> {
  const { render } = state();
  if (!render) return;
  stopFollowing();
  patchProject({ busy: true });
  try {
    const status = await cancelRenderRequest(render.renderJobId);
    patchProject({ render: status });
  } catch {
    // The job may already be terminal; the screen still returns to the previous step.
  } finally {
    patchProject({ busy: false });
  }
  const { variant, project, candidates } = state();
  if (variant) patchProject({ phase: 'result' });
  else if (project?.kind === 'upload' || project?.activeSource?.kind === 'upload')
    showUpload('replace');
  else if (candidates.length > 0) patchProject({ phase: 'confirm', autoStarted: false });
  else await discover();
}

/** "Not your place?": cancels the auto-started render and opens the confirm screen. */
export async function notYourPlace(): Promise<void> {
  patchProject({ autoStarted: false });
  await cancelRender();
}

/** "Try again" after a failed render: a new render job with the same selection. */
export function retryRender(): void {
  void requestRender();
}
