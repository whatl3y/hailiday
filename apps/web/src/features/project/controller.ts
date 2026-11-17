import {
  NUDGE_FOV_STEPS,
  NUDGE_HEADING_MAX_DEGREES,
  NUDGE_HEADING_STEP_DEGREES,
  UuidSchema,
  isTerminalRenderJobState,
  type Candidate,
  type Discovery,
  type HolidayId,
  type LightingMode,
  type OfferedSet,
  type Project,
  type RenderStatus,
  type Variant,
} from '@hailiday/core';
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
import { isFramingStage } from '../../api/renderStatus';
import { isPermanentRenderError, subscribeToRender, type RenderSubscription } from '../../api/sse';
import { currentHolidayId, hasChosenHoliday, isOffSeason, useAppStore } from '../../state/appStore';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/persist';
import {
  INITIAL_PROJECT_FLOW,
  baseCandidateOf,
  lookOf,
  makingLook,
  noteLocked,
  patchProject,
  refuseWhileMakingLook,
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
import { setLightFallback, standsInFor, type RelitLighting } from './lookFallback';
import {
  asPhotographedStandIn,
  defaultLook,
  findCachedVariant,
  looksExhausted,
  newestFirst,
  normalizeLook,
  offeredForHoliday,
  sameLook,
  variantsOfSource,
  withVariant,
} from './looks';
import { isRelitLook, secondPassMayCure } from './plans';
import { advanceTrail } from './stageTrail';

let subscription: RenderSubscription | null = null;
let generation = 0;
let retryId = 0;
/** The job that replaced the pending look's job on the server; its first status re-keys the look. */
let successorJobId: string | null = null;
/** Jobs this page canceled. The server may still list one as running for a moment. */
const canceledJobs = new Set<string>();
/**
 * The first look whose project the page has read once its source picture was final: after the
 * framing step, or past the preparing step of the job.
 */
let sourceReadFor: string | null = null;
/**
 * The lighting the person last picked themselves during this visit (on the look controls or by
 * asking for a light again); null while every look uses the offered default lighting.
 */
let chosenLighting: LightingMode | null = null;
/**
 * Whether the look the person asked for last has had its one second pass, which the page asks
 * for by itself when the look ended with nothing to show.
 */
let secondPassTaken = false;
/**
 * Evening looks (by source, holiday and style) of the open project that could not be made and
 * were shown as photographed instead. They are kept per project for the browser tab's session,
 * so a reload still treats those looks as evening looks.
 */
const failedEvenings = new Set<string>();

function eveningKey(sourceAssetId: string, look: Look): string {
  return `${sourceAssetId}|${look.holidayId}|${look.style}`;
}

function failedEveningsStorageKey(projectId: string): string {
  return `${STORAGE_KEYS.failedEvenings}:${projectId}`;
}

/** Reads the project's failed evening looks kept for this tab. */
function restoreFailedEvenings(projectId: string): void {
  failedEvenings.clear();
  const raw = readStored('session', failedEveningsStorageKey(projectId));
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const key of parsed) if (typeof key === 'string') failedEvenings.add(key);
  } catch {
    // A damaged entry only loses the record.
  }
}

/** Records an evening look that could not be made, for this visit and later reloads. */
function rememberFailedEvening(projectId: string, key: string): void {
  failedEvenings.add(key);
  writeStored('session', failedEveningsStorageKey(projectId), JSON.stringify([...failedEvenings]));
}

function canceledFirstLookStorageKey(projectId: string): string {
  return `${STORAGE_KEYS.canceledFirstLook}:${projectId}`;
}

/**
 * Records, for the browser tab's session, that the project's first look was canceled, so the
 * page does not start it again by itself on a reload or a return; `false` ends the record.
 */
function rememberCanceledFirstLook(projectId: string, canceled: boolean): void {
  writeStored('session', canceledFirstLookStorageKey(projectId), canceled ? '1' : null);
}

/** Whether the project's first look was canceled in this tab and no look was started since. */
function firstLookCanceled(projectId: string): boolean {
  return readStored('session', canceledFirstLookStorageKey(projectId)) === '1';
}

function secondPassJobStorageKey(projectId: string): string {
  return `${STORAGE_KEYS.secondPassJob}:${projectId}`;
}

/**
 * Records, for the browser tab's session, the job of the page's own second pass at the project's
 * look, so a reload during it keeps its hint and never asks a third time; `null` ends the record.
 */
function rememberSecondPassJob(projectId: string, renderJobId: string | null): void {
  writeStored('session', secondPassJobStorageKey(projectId), renderJobId);
}

/** Whether a job is the page's own second pass at the project's look, asked for in this tab. */
function isSecondPassJob(projectId: string, renderJobId: string): boolean {
  return readStored('session', secondPassJobStorageKey(projectId)) === renderJobId;
}

/**
 * Whether a variant shown as photographed stands in for an evening look that could not be made:
 * its look is a recorded failed evening and no evening variant of that look exists.
 */
function standsInForFailedEvening(variant: Variant, variants: readonly Variant[]): boolean {
  if (variant.lightingMode !== 'source') return false;
  const look = lookOf(variant);
  if (!failedEvenings.has(eveningKey(variant.sourceAssetId, look))) return false;
  return !findCachedVariant(variants, { ...look, lightingMode: 'evening' }, variant.sourceAssetId);
}

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
  successorJobId = null;
  canceledJobs.clear();
  sourceReadFor = null;
  chosenLighting = null;
  secondPassTaken = false;
  failedEvenings.clear();
  stopFollowing();
  setLightFallback(null);
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

/**
 * Loads a project (from router state or the API) and routes to the right screen. The upload
 * step the route state asks for opens only while the project has no ready source and no running
 * job, so a page reloaded or reached again through history follows the look being made instead.
 */
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
  restoreFailedEvenings(projectId);
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
  if (
    routeState?.openUpload &&
    project.activeSource?.state !== 'ready' &&
    !project.activeRenderJobId
  ) {
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
  // A first look the person canceled, or one that ended in its notice, is not started again by
  // itself: the page opens the uploaded photo with "Decorate this photo" or the place's view to
  // confirm.
  const canceled = firstLookCanceled(project.id);
  if (project.kind === 'upload') {
    if (source && source.state === 'ready' && readyToRender() && !canceled) await requestRender();
    else showUpload('project');
    return;
  }
  if (source && source.state === 'ready') {
    if (source.kind === 'upload' || project.discovery?.sourceMode !== 'display_only') {
      if (canceled && source.kind === 'upload') {
        showUpload('project');
        return;
      }
      if (readyToRender() && !canceled) {
        await requestRender();
        return;
      }
    }
  }
  await discover(token, { confirmFirst: canceled });
}

/** Whether a render may start without asking for a holiday first. */
function readyToRender(): boolean {
  const app = useAppStore.getState();
  return !isOffSeason(app) || hasChosenHoliday(app);
}

export interface DiscoverOptions {
  /**
   * Show the confirm screen even when discovery would start a render on its own, so the person
   * sees the place before anything is decorated (a skip to upload still opens No Street View).
   */
  confirmFirst?: boolean;
}

/** Runs (or replays) source discovery and routes on its outcome. */
export async function discover(
  token: number = generation,
  options: DiscoverOptions = {},
): Promise<void> {
  const { project } = state();
  if (!project) return;
  patchProject({ phase: 'finding', inlineError: null, nosvCause: null });
  try {
    const result = await runSourceDiscovery(project.id, project.projectVersion);
    if (!isCurrent(token)) return;
    setProjectData(result.project);
    applyDiscovery(result.discovery);
    await routeDiscovery(result.discovery, options);
  } catch (error) {
    if (!isCurrent(token)) return;
    if (isApiError(error) && error.code === 'STALE_PROJECT_VERSION') {
      const fresh = await getProject(project.id).catch(() => null);
      if (!isCurrent(token)) return;
      if (fresh) {
        setProjectData(fresh);
        await discover(token, options);
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

async function routeDiscovery(
  discovery: Discovery,
  { confirmFirst = false }: DiscoverOptions = {},
): Promise<void> {
  if (discovery.matchClass === 'skip_to_upload') {
    patchProject({
      phase:
        discovery.sourceMode === 'display_only' && discovery.candidates.length > 0
          ? 'confirm'
          : 'nosv',
    });
    return;
  }
  if (!confirmFirst && discovery.nextAction === 'render' && readyToRender()) {
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
  successorJobId = null;
  stopFollowing();
  patchProject({
    phase: 'upload',
    uploadContext: context,
    uploadReturnPhase,
    inlineError: null,
    pending: null,
    pendingError: null,
    trail: null,
  });
}

/** "Replace photo" on a result: opens the upload step unless a look is being made. */
export function replacePhoto(): void {
  if (refuseWhileMakingLook()) return;
  showUpload('replace');
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
  successorJobId = null;
  stopFollowing();
  patchProject({
    phase: 'nosv',
    nosvCause: cause,
    uploadContext: 'nosv',
    inlineError: null,
    pending: null,
    pendingError: null,
    busy: false,
    trail: null,
  });
}

/** Called by the upload step once the photo is attached as the project's source. */
export async function onUploadAttached(project: Project): Promise<void> {
  const current = state();
  setProjectData(project);
  chosenLighting = null;
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
 * follows while the current preview stays on screen, for the current holiday in the new scene
 * type's default look. Earlier variants stay in the history. Refused while a look is being made.
 */
export async function changeSceneType(choice: SceneChoice, retried = false): Promise<void> {
  if (refuseWhileMakingLook()) return;
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
    chosenLighting = null;
    const holidayId = (look ?? (variant ? lookOf(variant) : null))?.holidayId;
    await requestRender(holidayId ? { look: defaultLook(holidayId, offeredFor(holidayId)) } : {});
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

/** The view already loaded for a base candidate turned by `offset` degrees, if any. */
function turnedViewOf(
  candidates: readonly Candidate[],
  baseCandidate: Candidate,
  offset: number,
): Candidate | undefined {
  return candidates.find(
    (item) =>
      item.derivedFromCandidateId === baseCandidate.candidateId &&
      Math.round(((item.heading - baseCandidate.heading + 540) % 360) - 180) === offset,
  );
}

/**
 * Selects one of the base candidates, loading its image on request when needed. A view that was
 * turned comes back as it was left, so the turn kept for it always matches the picture on screen.
 */
export async function selectView(candidateId: string): Promise<void> {
  const current = state();
  const candidate = current.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate || !current.project) return;
  if (candidate.displayUrl) {
    const offset = current.nudgeOffsets[candidateId] ?? 0;
    const turned = offset === 0 ? undefined : turnedViewOf(current.candidates, candidate, offset);
    patchProject({
      selectedCandidateId: turned?.candidateId ?? candidateId,
      nudgeOffsets: turned ? current.nudgeOffsets : { ...current.nudgeOffsets, [candidateId]: 0 },
      inlineError: null,
    });
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
  const cached = turnedViewOf(current.candidates, baseCandidate, offset);
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
  /** Overrides the project's lighting mode. */
  lightingMode?: LightingMode;
  /** The full look to render (controls under the result). */
  look?: Look;
  retried?: boolean;
  /**
   * The page's own second pass at a look that ended with nothing to show (this status), asked
   * for while its status card stays up. Any other request is the person's and allows one again.
   */
  secondPass?: RenderStatus;
}

/** Incremented whenever the person picks another look, so stale responses are ignored. */
let lookToken = 0;

/**
 * The look a render asks for when none was chosen on screen: before the project's first preview,
 * the default look offered for the holiday; afterwards the project's remembered look, kept
 * inside what the holiday offers.
 */
function renderSelection(project: Project, holidayId: HolidayId): Look {
  const offered = offeredFor(holidayId);
  if (project.variantCount === 0) return defaultLook(holidayId, offered);
  return normalizeLook(
    { holidayId, style: project.style, lightingMode: project.lightingMode },
    offered,
  );
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
  successorJobId = null;
  patchProject({
    pending: null,
    look: variant ? lookOf(variant) : null,
    trail: null,
    secondPass: false,
  });
}

/**
 * Requests a render for the project's current source. Without a preview on screen a queued
 * job opens the waiting screen; with one (a new look) the preview stays on screen while the new
 * look is made. A cached variant opens at once. Nothing is requested while a look is being made.
 */
export async function requestRender(options: RenderOptions = {}): Promise<void> {
  const current = state();
  const project = current.project;
  const holidayId =
    options.look?.holidayId ?? currentHolidayId(useAppStore.getState()) ?? project?.holidayId;
  if (!project || !holidayId) return;
  // One look at a time: nothing starts a second job from this page while one is being made. The
  // second pass belongs to the look being made.
  const secondPass = options.secondPass ?? null;
  if (!secondPass && refuseWhileMakingLook()) return;
  if (options.lightingMode) chosenLighting = options.lightingMode;
  const look: Look = options.look ?? {
    ...renderSelection(project, holidayId),
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
    if (secondPass) {
      showUnfinished(secondPass);
      return;
    }
    if (pendingMode) settleLook();
    else patchProject({ phase: returnPhase, inlineError: null });
    openAllowanceSheet();
    return;
  }
  const token = generation;
  const myLook = lookToken;
  // The person starts a look: it may have its own second pass.
  if (!secondPass) secondPassTaken = false;
  setLightFallback(null);
  if (pendingMode) {
    patchProject({
      phase: 'result',
      pending: { look, render: null },
      look,
      pendingError: null,
      inlineError: null,
      trail: null,
      secondPass: secondPass !== null,
    });
  } else {
    patchProject({
      phase: 'starting',
      inlineError: null,
      trail: null,
      secondPass: secondPass !== null,
    });
  }
  if (pendingMode && (await joinRunningLook(project, look, token, myLook))) return;
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
    if (myLook !== lookToken) {
      // The look was canceled, or the page left it, while this request was in flight.
      if (!response.cached) {
        canceledJobs.add(response.renderJobId);
        void cancelRenderRequest(response.renderJobId).catch(() => undefined);
      }
      return;
    }
    // A look the server took on: a first look canceled or left unfinished earlier no longer
    // holds the page back, and only the page's own second pass is remembered as one.
    rememberCanceledFirstLook(project.id, false);
    rememberSecondPassJob(project.id, secondPass && !response.cached ? response.renderJobId : null);
    if (response.cached) {
      showVariant(response.variant, 'cache');
    } else {
      applyStatus(response);
      follow(response.renderJobId);
    }
  } catch (error) {
    if (!isCurrent(token)) return;
    if (myLook !== lookToken) return;
    if (secondPass) {
      // The second pass could not start: the look ends as it would have without it.
      showUnfinished(secondPass);
      return;
    }
    if (pendingMode) settleLook();
    await handleRenderRequestError(error, returnPhase, options);
  }
}

/**
 * Before another look is requested: reads the project's looks and its running job, so a look
 * another tab or device is already making is joined instead of replaced, and a look made there
 * since this page loaded opens without a request. Returns true when no request is needed.
 */
async function joinRunningLook(
  project: Project,
  look: Look,
  token: number,
  myLook: number,
): Promise<boolean> {
  const list = await listVariants(project.id).catch(() => null);
  if (!isCurrent(token) || myLook !== lookToken) return true; // left the place, or canceled
  if (!list) return false;
  const items = newestFirst(list.items);
  patchProject({ variants: items, offered: list.offered ?? state().offered });
  const running = list.activeRender;
  if (
    running &&
    !isTerminalRenderJobState(running.state) &&
    !canceledJobs.has(running.renderJobId)
  ) {
    if (!sameLook(lookOf(running), look)) noteLocked();
    patchProject({
      pending: { look: lookOf(running), render: running },
      look: lookOf(running),
      trail: advanceTrail(null, running),
    });
    follow(running.renderJobId);
    return true;
  }
  const made = findCachedVariant(items, look, state().project?.activeSource?.sourceAssetId);
  if (made) {
    showVariant(made, 'cache');
    return true;
  }
  return false;
}

/**
 * A holiday chosen in the header chip: on a result it changes the look; elsewhere the choice is
 * kept for the next render request. While a look is being made the chip is locked.
 */
export function changeHoliday(holidayId: HolidayId): void {
  if (refuseWhileMakingLook()) return;
  if (state().phase === 'result') chooseLook({ holidayId });
}

/** Puts an accepted variant on screen and records it in the project's list. */
function showVariant(variant: Variant, source: 'render' | 'cache'): void {
  const current = state();
  const project = current.project;
  const firstOnScreen = current.variant === null && source === 'render';
  setLightFallback(null);
  patchProject({
    variant,
    variants: withVariant(current.variants, variant),
    look: lookOf(variant),
    pending: null,
    pendingError: null,
    trail: null,
    secondPass: false,
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
          // Back to the screen the request left, so the retry is not taken for a second look.
          patchProject({ phase: returnPhase });
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
          await showDisplayOnly(error, project, returnPhase);
          return;
        }
        if (reason === 'stale') {
          // The view behind this place changed: discovery decides the screen, and nothing is
          // decorated until the person confirms the current view.
          const token = generation;
          const fresh = await getProject(project.id).catch(() => null);
          if (!isCurrent(token)) return;
          if (fresh) setProjectData(fresh);
          await discover(token, { confirmFirst: true });
          if (!isCurrent(token)) return;
          if (state().phase === 'confirm') {
            patchProject({ confirmNotice: 'viewChanged', autoStarted: false });
          }
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

/**
 * A render refused because the bound street photo may only be displayed. A look asked for from
 * a result opens the upload step with the reason in line; Cancel returns to the result.
 * Otherwise the confirm screen shows the photo prompt; a page that does not hold the place's
 * display-only discovery runs discovery again first, and gives the reason in line when that
 * discovery offers a view to decorate.
 */
async function showDisplayOnly(
  error: unknown,
  project: Project,
  returnPhase: ProjectPhase,
): Promise<void> {
  const reason = presentError(error)?.message ?? null;
  const current = state();
  if (returnPhase === 'result' && current.variant) {
    showUpload('replace');
    patchProject({ inlineError: reason });
    return;
  }
  if (current.discovery?.sourceMode === 'display_only' && current.candidates.length > 0) {
    patchProject({ phase: 'confirm' });
    return;
  }
  const token = generation;
  const fresh = await getProject(project.id).catch(() => null);
  if (!isCurrent(token)) return;
  if (fresh) setProjectData(fresh);
  await discover(token, { confirmFirst: true });
  if (!isCurrent(token)) return;
  const after = state();
  if (after.phase === 'confirm' && after.discovery?.sourceMode !== 'display_only') {
    patchProject({ inlineError: reason });
  }
}

/** Whether a status belongs to the pending look. */
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
  if (leftFraming(current.render, status) || firstPastPreparing(current.render, status)) {
    void readFramedSource(status.renderJobId);
  }
  if (status.state === 'succeeded' && status.variant) {
    patchProject({ render: status });
    showVariant(status.variant, 'render');
    void loadVariants();
    return;
  }
  if (status.state === 'failed' || status.state === 'rejected' || status.state === 'expired') {
    endWithoutLook(status);
    return;
  }
  if (status.state === 'superseded') {
    if (status.supersededByRenderJobId) follow(status.supersededByRenderJobId);
    else void followProjectJob(status);
    return;
  }
  if (status.state === 'canceled') {
    // Canceled from another tab or device: the page leaves the waiting screen as Cancel does.
    stopFollowing();
    const { variant, project } = state();
    if (!variant && project) rememberCanceledFirstLook(project.id, true);
    patchProject({ render: status, trail: null, autoStarted: false });
    void leaveFirstLook(generation);
    void refreshLooks();
    return;
  }
  patchProject({ render: status, phase: 'waiting', trail: advanceTrail(state().trail, status) });
}

/**
 * Whether a first look's status follows its framing step: the previous status of the same job
 * reported the framing stage and this one reports another stage or ends the job.
 */
function leftFraming(previous: RenderStatus | null, status: RenderStatus): boolean {
  return (
    previous !== null &&
    previous.renderJobId === status.renderJobId &&
    isFramingStage(previous.stageLabelKey) &&
    !isFramingStage(status.stageLabelKey)
  );
}

/** Whether a status reports a running job past its preparing step (where the framing happens). */
function pastPreparing(status: RenderStatus): boolean {
  return (
    !isTerminalRenderJobState(status.state) &&
    status.state !== 'queued' &&
    status.state !== 'preparing'
  );
}

/**
 * Whether this is the first status of a first look's job past its preparing step. The framing
 * stage can pass unseen when two status changes arrive close together.
 */
function firstPastPreparing(previous: RenderStatus | null, status: RenderStatus): boolean {
  if (!pastPreparing(status)) return false;
  return !(
    previous !== null &&
    previous.renderJobId === status.renderJobId &&
    pastPreparing(previous)
  );
}

/**
 * After the framing step of a first look, or at its first state past preparing when the page has
 * not read the project for that look yet, reads the project once and shows the zoomed Street View
 * frame it now answers as the source picture. A failed read, a project that moved to another
 * source meanwhile, a place the person left, or an uploaded photo changes nothing.
 */
async function readFramedSource(renderJobId: string): Promise<void> {
  const before = state().project;
  if (!before || before.activeSource?.kind === 'upload') return;
  if (sourceReadFor === renderJobId) return;
  sourceReadFor = renderJobId;
  const token = generation;
  const fresh = await getProject(before.id).catch(() => null);
  if (!fresh || !isCurrent(token)) return;
  const project = state().project;
  const source = fresh.activeSource;
  if (!project || !source || project.activeSource?.sourceAssetId !== source.sourceAssetId) return;
  if (project.activeSource.displayUrl === source.displayUrl) return;
  patchProject({ project: { ...project, activeSource: source } });
}

/**
 * A first look whose job was replaced without a successor (its place's photo or view changed
 * elsewhere): reads the project again and follows the job it is running now, or, with none,
 * leaves the waiting screen as a cancel does. A page still loading when its job ended that way
 * does the same. Nothing happens when the person left the screen meanwhile.
 */
async function followProjectJob(status: RenderStatus): Promise<void> {
  stopFollowing();
  const token = generation;
  const project = state().project;
  const waiting = () => {
    const now = state();
    return (
      isCurrent(token) &&
      now.pending === null &&
      (now.phase === 'waiting' || now.phase === 'starting' || now.phase === 'loading') &&
      (now.render?.renderJobId ?? status.renderJobId) === status.renderJobId
    );
  };
  const fresh = project ? await getProject(project.id).catch(() => null) : null;
  if (!waiting()) return;
  if (fresh) setProjectData(fresh);
  const next = fresh?.activeRenderJobId ?? null;
  if (next && next !== status.renderJobId && !canceledJobs.has(next)) {
    patchProject({ trail: null });
    await resumeRender(next, token);
    return;
  }
  patchProject({ render: status, trail: null, autoStarted: false });
  await leaveFirstLook(token);
  void refreshLooks();
}

/** A status for a new look while the current preview stays on screen. */
function applyPendingStatus(status: RenderStatus): void {
  if (successorJobId === status.renderJobId) {
    // The job that replaced this look's job (started from another tab or device): the page
    // follows it.
    successorJobId = null;
    patchProject({
      pending: { look: lookOf(status), render: status },
      look: lookOf(status),
      trail: null,
    });
  }
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
      endWithoutLook(status);
      return;
    case 'canceled':
      settleLook();
      void refreshLooks();
      return;
    case 'superseded':
      if (status.supersededByRenderJobId) {
        successorJobId = status.supersededByRenderJobId;
        follow(status.supersededByRenderJobId);
      } else {
        settleLook();
        void refreshLooks();
      }
      return;
    default:
      patchProject({
        pending: { look: pending.look, render: status },
        trail: advanceTrail(state().trail, status),
      });
  }
}

/**
 * A look that ended `rejected`, `failed` or `expired` without its picture. Once a person has
 * waited they get a picture where one exists, so in order:
 * 1. the picture the job delivered all the same (its status carries a variant);
 * 2. for a relit look (evening, bright), the same look in the photo's own light from the project's
 *    looks (the job saves it before the light), shown as the result with a line saying so;
 * 3. once per look the person asked for, when a second try may cure the reason, a second pass the
 *    page asks for by itself while the status card stays up;
 * 4. the notice that the look could not be finished: under the current preview for another look,
 *    on the place's photo for a first look.
 * Nothing happens when the person moved on while the project's looks were read.
 */
function endWithoutLook(status: RenderStatus): void {
  stopFollowing();
  const delivers = status.state === 'rejected' || status.state === 'failed';
  if (delivers && status.variant) {
    deliverAllTheSame(status, status.variant, null);
    return;
  }
  const before = state();
  const project = before.project;
  if (!delivers || !isRelitLook(status) || !project) {
    tryOnceMore(status);
    return;
  }
  const token = generation;
  const myLook = lookToken;
  const unchanged = () => {
    const now = state();
    return (
      isCurrent(token) &&
      myLook === lookToken &&
      now.phase === before.phase &&
      (now.render?.renderJobId ?? null) === (before.render?.renderJobId ?? null) &&
      (now.pending?.render?.renderJobId ?? null) === (before.pending?.render?.renderJobId ?? null)
    );
  };
  void listVariants(project.id)
    .then((list) => ({ items: newestFirst(list.items), offered: list.offered }))
    .catch(() => ({ items: before.variants, offered: null }))
    .then(({ items, offered }) => {
      if (!unchanged()) return;
      const ownLight = findCachedVariant(
        items,
        { ...lookOf(status), lightingMode: 'source' },
        state().project?.activeSource?.sourceAssetId,
      );
      if (!ownLight) {
        tryOnceMore(status);
        return;
      }
      deliverAllTheSame(status, ownLight, { items, offered });
    });
}

/**
 * Shows a picture a look that did not fully arrive left all the same. When it is a relit look's
 * decorations in the photo's own light, the result says so with a line under the picture, and an
 * evening look is remembered as one that could not be made, so it keeps that line on a reload.
 */
function deliverAllTheSame(
  status: RenderStatus,
  delivered: Variant,
  list: { items: Variant[]; offered: OfferedSet | null } | null,
): void {
  const pendingMode = state().pending !== null;
  const project = state().project;
  patchProject({
    ...(list ? { variants: list.items, offered: list.offered ?? state().offered } : {}),
    ...(pendingMode ? {} : { render: status }),
  });
  const ownLight: RelitLighting | null =
    (status.lightingMode === 'evening' || status.lightingMode === 'bright') &&
    delivered.lightingMode !== status.lightingMode
      ? status.lightingMode
      : null;
  if (ownLight === 'evening' && project) {
    rememberFailedEvening(project.id, eveningKey(delivered.sourceAssetId, lookOf(status)));
  }
  showVariant(delivered, 'render');
  if (ownLight)
    setLightFallback({ renderAssetId: delivered.renderAssetId, lightingMode: ownLight });
  if (!list) void loadVariants();
}

/**
 * A look that ended with nothing to show: asked for again once by the page itself when a second
 * try may cure the reason and this look has not had its second pass; otherwise its notice. The
 * second pass's own job (remembered for the tab, so also after a reload) always ends in the notice.
 */
function tryOnceMore(status: RenderStatus): void {
  const projectId = state().project?.id ?? null;
  const ownSecondPass = projectId !== null && isSecondPassJob(projectId, status.renderJobId);
  if (secondPassTaken || ownSecondPass || !secondPassMayCure(status)) {
    showUnfinished(status);
    return;
  }
  secondPassTaken = true;
  // A first look resumed over a preview (after a reload) makes its second pass as another look.
  const { pending, variant, phase } = state();
  if (!pending && variant && phase !== 'result') patchProject({ phase: 'result' });
  void requestRender({ look: lookOf(status), secondPass: status });
}

/**
 * The notice for a look that could not be finished: under the preview on screen, which stays, and
 * whose place's looks are read again; or on the place's photo when the place has no look yet,
 * remembered for the tab as a canceled first look is, so a reload or a return to the place does
 * not start the look again by itself.
 */
function showUnfinished(status: RenderStatus): void {
  stopFollowing();
  const { variant, project } = state();
  if (variant) {
    settleLook();
    patchProject({ phase: 'result', pendingError: status });
    void refreshLooks();
    return;
  }
  if (project) rememberCanceledFirstLook(project.id, true);
  patchProject({ render: status, phase: 'render_error', trail: null, secondPass: false });
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
        const { projectId } = state();
        if (projectId) useAppStore.getState().forgetProject(projectId);
        patchProject({
          phase: 'not_found',
          pending: null,
          pendingError: null,
          busy: false,
          trail: null,
        });
      },
    },
    { pollMs, fetchStatus: (id, signal) => getRender(id, signal) },
  );
}

async function resumeRender(renderJobId: string, token: number): Promise<void> {
  try {
    const status = await getRender(renderJobId);
    if (!isCurrent(token)) return;
    const projectId = state().project?.id ?? null;
    // The page's own second pass, resumed after a reload, keeps saying so on its status card.
    const secondPass = projectId !== null && isSecondPassJob(projectId, renderJobId);
    if (state().variant && !isTerminalRenderJobState(status.state)) {
      patchProject({
        phase: 'result',
        pending: { look: lookOf(status), render: status },
        look: lookOf(status),
        trail: advanceTrail(null, status),
        secondPass,
      });
      follow(renderJobId);
      return;
    }
    // The project was read just before: past its preparing step, it names the final picture.
    if (pastPreparing(status)) sourceReadFor = renderJobId;
    if (!isTerminalRenderJobState(status.state)) patchProject({ secondPass });
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
 * The variant to open a project on: the selected holiday's look of the active source first (or,
 * when that look is relit and was not made, the same look as photographed), then the newest of
 * that source, and only then a variant of an earlier source.
 */
function initialVariant(items: readonly Variant[]): Variant | null {
  const { project } = state();
  const selected = currentHolidayId(useAppStore.getState());
  const sourceAssetId = project?.activeSource?.sourceAssetId ?? null;
  const own = variantsOfSource(items, sourceAssetId);
  const remembered: Look | null = project
    ? {
        holidayId: selected ?? project.holidayId,
        style: project.style,
        lightingMode: project.lightingMode,
      }
    : null;
  return (
    (remembered ? findCachedVariant(items, remembered, sourceAssetId) : null) ??
    (remembered && remembered.lightingMode !== 'source'
      ? findCachedVariant(items, { ...remembered, lightingMode: 'source' }, sourceAssetId)
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
    // A project opened on the stand-in of a relit look that could not be made says so again, and
    // the next look keeps the light it was meant to have.
    const standsIn = !current.variant && variant ? standInLight(variant, items) : null;
    if (variant && standsIn) {
      setLightFallback({ renderAssetId: variant.renderAssetId, lightingMode: standsIn });
    }
  } catch {
    // The preview on screen stays usable; switching looks falls back to new requests.
  }
}

/**
 * The light a variant a project opens on stands in for, when it shows a relit look in the photo's
 * own light: an evening look recorded in this tab as one that could not be made, or the project's
 * remembered look (evening or bright, offered for its holiday) when only its as-photographed
 * version exists, as when that look ended in another tab or before a reload. Null while the
 * project names a running job, and for any variant made in the light asked for.
 */
function standInLight(variant: Variant, items: readonly Variant[]): RelitLighting | null {
  const project = state().project;
  if (!project || project.activeRenderJobId || variant.lightingMode !== 'source') return null;
  if (standsInForFailedEvening(variant, items)) return 'evening';
  const remembered = project.lightingMode;
  if (remembered !== 'evening' && remembered !== 'bright') return null;
  if (variant.holidayId !== project.holidayId || variant.style !== project.style) return null;
  if (!offeredFor(variant.holidayId).lightingModes.includes(remembered)) return null;
  const relit = findCachedVariant(
    items,
    { ...lookOf(variant), lightingMode: remembered },
    variant.sourceAssetId,
  );
  return relit ? null : remembered;
}

/**
 * Reads the place's looks again after a look in the making ended without a new picture, so every
 * look the page holds, the one on screen included, carries the "Before" the server gives it now
 * (that look's job may have changed the picture earlier looks were made from). The picture on
 * screen stays as it is. Nothing happens without a look on screen or once the person left.
 */
async function refreshLooks(): Promise<void> {
  const { project, variant } = state();
  if (!project || !variant) return;
  const token = generation;
  const list = await listVariants(project.id).catch(() => null);
  if (!list || !isCurrent(token)) return;
  const items = newestFirst(list.items);
  const current = state();
  const shown = current.variant;
  const fresh = shown ? items.find((item) => item.renderAssetId === shown.renderAssetId) : null;
  patchProject({
    variants: shown && !fresh ? withVariant(items, shown) : items,
    offered: list.offered ?? current.offered,
    ...(shown && fresh && fresh.beforeImageUrl !== shown.beforeImageUrl
      ? { variant: { ...shown, beforeImageUrl: fresh.beforeImageUrl } }
      : {}),
  });
}

/**
 * A tap on the holiday, style or lighting control. A cached variant switches instantly; at
 * the allowance limit the sheet opens instead of a request; otherwise the look is requested at
 * once and the preview stays on screen while it is made. While a look is being made a choice is
 * refused (and noted, unless it repeats the look being made).
 */
export function chooseLook(partial: Partial<Look>): void {
  const current = state();
  if (!current.project || !current.variant) return;
  if (makingLook(current)) {
    // The choice already being made is not a second choice.
    const making = current.pending?.look;
    const repeats =
      making !== undefined &&
      (Object.keys(partial) as (keyof Look)[]).every((key) => partial[key] === making[key]);
    if (!repeats) noteLocked();
    return;
  }
  if (partial.lightingMode !== undefined) chosenLighting = partial.lightingMode;
  // A tap on a control already selected for the look on screen starts nothing, also while that
  // look stands in for a relit look; with a notice open it asks for that look again.
  const selected = current.look;
  const repeatsSelected =
    selected !== null &&
    (Object.keys(partial) as (keyof Look)[]).every((key) => partial[key] === selected[key]);
  if (repeatsSelected && !current.pendingError) return;
  const defaultLighting = partial.lightingMode === undefined && chosenLighting !== 'evening';
  // A preview that stands in for a relit look whose light did not arrive: the next look keeps
  // the light it was meant to have.
  const standsInForLight = standsInFor(current.variant.renderAssetId);
  const base: Look = standsInForLight
    ? { ...lookOf(current.variant), lightingMode: standsInForLight }
    : (current.look ?? lookOf(current.variant));
  const holidayId = partial.holidayId ?? base.holidayId;
  const offered = offeredFor(holidayId);
  const next = normalizeLook({ ...base, ...partial, holidayId }, offered);
  if (sameLook(next, current.look) && !current.pendingError) return;
  lookToken += 1;
  setLightFallback(null);
  const sourceAssetId = current.project.activeSource?.sourceAssetId;
  const exact = findCachedVariant(current.variants, next, sourceAssetId);
  const standIn =
    exact || !defaultLighting
      ? null
      : standInFor(current.variants, next, sourceAssetId, offered.lightingModes);
  const cached = exact ?? standIn?.variant ?? null;
  if (cached) {
    patchProject({
      variant: cached,
      look: lookOf(cached),
      pending: null,
      pendingError: null,
      inlineError: null,
      revealFor: null,
    });
    if (standIn?.eveningFailed) {
      setLightFallback({ renderAssetId: cached.renderAssetId, lightingMode: 'evening' });
    }
    return;
  }
  if (looksExhausted(useAppStore.getState().allowance)) {
    openAllowanceSheet();
    return;
  }
  void requestRender({ look: next });
}

/**
 * A variant that already shows a look whose lighting the person did not pick: a dusk or night
 * photo's evening variant for its as-photographed look (that evening was decorated in the photo's
 * own light), or the as-photographed variant of an evening look that could not be made in this
 * visit.
 */
function standInFor(
  variants: readonly Variant[],
  look: Look,
  sourceAssetId: string | null | undefined,
  lightingModes: readonly LightingMode[],
): { variant: Variant; eveningFailed: boolean } | null {
  const dusk = asPhotographedStandIn(variants, look, sourceAssetId, lightingModes);
  if (dusk) return { variant: dusk, eveningFailed: false };
  if (look.lightingMode !== 'evening' || !sourceAssetId) return null;
  if (!failedEvenings.has(eveningKey(sourceAssetId, look))) return null;
  const photographed = findCachedVariant(
    variants,
    { ...look, lightingMode: 'source' },
    sourceAssetId,
  );
  return photographed ? { variant: photographed, eveningFailed: true } : null;
}

/** Cancel while another look is being made: the current preview stays. */
export async function cancelPendingLook(): Promise<void> {
  const { pending } = state();
  if (!pending) return;
  lookToken += 1;
  stopFollowing();
  settleLook();
  void refreshLooks();
  const running = pending.render;
  if (running && !isTerminalRenderJobState(running.state)) {
    canceledJobs.add(running.renderJobId);
    await cancelRenderRequest(running.renderJobId).catch(() => undefined);
  }
}

/** Closes the notice of another look that could not be finished. */
export function dismissPendingError(): void {
  patchProject({ pendingError: null });
}

/**
 * "Try the evening light again" (or the brighter light) under a look shown in the photo's own
 * light: asks for the look on screen in the light that did not arrive.
 */
export function retryLight(): void {
  const { variant } = state();
  if (!variant) return;
  const lightingMode = standsInFor(variant.renderAssetId);
  if (!lightingMode || refuseWhileMakingLook()) return;
  chosenLighting = lightingMode;
  void requestRender({ look: { ...lookOf(variant), lightingMode } });
}

/**
 * "Try again" under the notice of another look that could not be finished: asks for that look
 * again while the current preview stays.
 */
export function retryPendingLook(failed: RenderStatus): void {
  if (refuseWhileMakingLook()) return;
  void requestRender({ look: lookOf(failed) });
}

/**
 * Cancels the running render and returns to the previous result, the upload step or the confirm
 * screen. A canceled first look is remembered for the tab's session, so a reload or a return to
 * the place does not start it again by itself. A request still on its way (the page's own second
 * pass) has its job canceled when it answers.
 */
export async function cancelRender(): Promise<void> {
  const { render, variant, project } = state();
  if (!render) return;
  lookToken += 1;
  stopFollowing();
  patchProject({ busy: true });
  canceledJobs.add(render.renderJobId);
  if (!variant && project) rememberCanceledFirstLook(project.id, true);
  try {
    const status = await cancelRenderRequest(render.renderJobId);
    patchProject({ render: status });
  } catch {
    // The job may already be terminal; the screen still returns to the previous step.
  } finally {
    patchProject({ busy: false, trail: null, secondPass: false });
  }
  await leaveFirstLook(generation);
  void refreshLooks();
}

/**
 * Leaves the waiting screen of a first look that ended without a result: back to the preview on
 * screen, to the upload step, or to the view to confirm. A page that holds no view to confirm
 * (it resumed the look, after a reload or a link) runs discovery again for the confirm screen,
 * and never starts a look by itself.
 */
async function leaveFirstLook(token: number): Promise<void> {
  const { variant, project, candidates } = state();
  if (variant) patchProject({ phase: 'result' });
  else if (project?.kind === 'upload' || project?.activeSource?.kind === 'upload')
    showUpload('project');
  else if (candidates.length > 0) patchProject({ phase: 'confirm', autoStarted: false });
  else await discover(token, { confirmFirst: true });
}

/** "Not your place?": cancels the auto-started render and opens the confirm screen. */
export async function notYourPlace(): Promise<void> {
  patchProject({ autoStarted: false });
  await cancelRender();
}

/**
 * "Try again" after a failed render: a new render job with the failed job's style and lighting,
 * for the holiday selected now.
 */
export function retryRender(): void {
  const { render } = state();
  if (!render) {
    void requestRender();
    return;
  }
  const holidayId = currentHolidayId(useAppStore.getState()) ?? render.holidayId;
  void requestRender({
    look: normalizeLook({ ...lookOf(render), holidayId }, offeredFor(holidayId)),
  });
}
