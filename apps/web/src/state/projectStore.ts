import { create } from 'zustand';
import {
  isTerminalRenderJobState,
  type ActiveSource,
  type Candidate,
  type Discovery,
  type HolidayId,
  type LightingMode,
  type OfferedSet,
  type Project,
  type RenderStatus,
  type StageLabelKey,
  type Style,
  type Variant,
} from '@hailiday/core';

export type ProjectPhase =
  | 'loading'
  | 'not_found'
  | 'error'
  | 'finding'
  | 'confirm'
  | 'nosv'
  | 'upload'
  | 'starting'
  | 'waiting'
  | 'result'
  | 'render_error';

/** Why the upload step is showing inside a project. */
export type UploadContext = 'project' | 'interim' | 'nosv' | 'none_of_these' | 'replace';

/** Screens the upload step can return to with Cancel. */
export type UploadReturnPhase = 'result' | 'confirm' | 'render_error';

/** An error code that opened the No Street View screen after discovery had succeeded. */
export type NoStreetViewCause = 'NO_STREET_VIEW' | 'NEEDS_PHOTO';

/** "Try again" for a rate-limited action, enabled once the wait has passed. */
export interface InlineRetry {
  /** Distinguishes one failure from the next, so each restarts its own wait. */
  id: number;
  retryAfterSeconds: number | null;
  retry: () => void;
}

/** One combination of holiday, style and lighting. */
export interface Look {
  holidayId: HolidayId;
  style: Style;
  lightingMode: LightingMode;
}

/** The stages the look being made has reached (the status card's trail). */
export interface StageTrail {
  renderJobId: string;
  /** Stage label keys in the order the job reached them, each once. */
  keys: StageLabelKey[];
  /** The stage the job is in now; always one of `keys`. */
  current: StageLabelKey;
}

/** A new look being decorated while the current preview stays on screen. */
export interface PendingLook {
  look: Look;
  /** Null until `POST /v1/renders` answers with the queued job. */
  render: RenderStatus | null;
}

export interface ProjectFlowState {
  projectId: string | null;
  project: Project | null;
  /** The display address from resolve, kept in memory only (never in a URL or storage). */
  displayAddress: string | null;
  entry: 'autocomplete' | 'manual' | 'upload' | null;
  phase: ProjectPhase;
  discovery: Discovery | null;
  /** Discovered, alternate and nudged candidates by ID. */
  candidates: Candidate[];
  /** The base candidates (primary and alternates) in discovery order. */
  baseCandidateIds: string[];
  selectedCandidateId: string | null;
  remainingDisplayLoads: number;
  /** Nudge offset (degrees) per base candidate. */
  nudgeOffsets: Record<string, number>;
  render: RenderStatus | null;
  /** The accepted variant on screen. */
  variant: Variant | null;
  /** Every accepted variant of the project (`GET /v1/projects/:id/variants`), newest first. */
  variants: Variant[];
  /** Styles and lighting modes offered for the project's scene type, from the variants list. */
  offered: OfferedSet | null;
  /** The look the controls show as selected (may be ahead of the variant while pending). */
  look: Look | null;
  /** A new look being decorated while the current preview stays on screen. */
  pending: PendingLook | null;
  /**
   * Another look that ended with nothing to show: the current preview stays, and the notice under
   * it says so with what the person can do next.
   */
  pendingError: RenderStatus | null;
  /**
   * The look being made is the page's own second pass at a look that ended with nothing to show,
   * so its status card says so.
   */
  secondPass: boolean;
  /** The variant that arrives as the project's first reveal. */
  revealFor: string | null;
  /** Whether the current render started without a confirmation tap (auto-start). */
  autoStarted: boolean;
  confirmNotice: 'viewChanged' | null;
  uploadContext: UploadContext;
  /** The screen Cancel on the upload step returns to; null when there is none. */
  uploadReturnPhase: UploadReturnPhase | null;
  /** Set when the No Street View screen was opened by an error code rather than discovery. */
  nosvCause: NoStreetViewCause | null;
  busy: boolean;
  /** A message shown next to the primary action of the current phase. */
  inlineError: string | null;
  /** The wait-then-retry control beside a rate-limited `inlineError`. */
  inlineRetry: InlineRetry | null;
  /** The stages the look being made has reached; null when no status has been seen. */
  trail: StageTrail | null;
  /** Counts uses of a locked control, so the screen can say why nothing happened. */
  lockedNotice: number;
}

export const INITIAL_PROJECT_FLOW: ProjectFlowState = {
  projectId: null,
  project: null,
  displayAddress: null,
  entry: null,
  phase: 'loading',
  discovery: null,
  candidates: [],
  baseCandidateIds: [],
  selectedCandidateId: null,
  remainingDisplayLoads: 0,
  nudgeOffsets: {},
  render: null,
  variant: null,
  variants: [],
  offered: null,
  look: null,
  pending: null,
  pendingError: null,
  secondPass: false,
  revealFor: null,
  autoStarted: false,
  confirmNotice: null,
  uploadContext: 'project',
  uploadReturnPhase: null,
  nosvCause: null,
  busy: false,
  inlineError: null,
  inlineRetry: null,
  trail: null,
  lockedNotice: 0,
};

export const useProjectStore = create<ProjectFlowState>()(() => ({ ...INITIAL_PROJECT_FLOW }));

/**
 * The project's uploaded photo when it is attached and ready but nothing has been decorated
 * from it yet (for example when the first render was refused), so the upload step can keep it
 * on screen. Null while the person is replacing the photo.
 */
export function undecoratedUpload(state: ProjectFlowState): ActiveSource | null {
  const source = state.project?.activeSource ?? null;
  if (!source || source.kind !== 'upload' || source.state !== 'ready' || !source.displayUrl) {
    return null;
  }
  if (state.uploadContext === 'replace') return null;
  if (state.variants.some((item) => item.sourceAssetId === source.sourceAssetId)) return null;
  if (state.variant?.sourceAssetId === source.sourceAssetId) return null;
  return source;
}

/** Applies a patch; a new `inlineError` without its own `inlineRetry` clears the retry. */
export function patchProject(patch: Partial<ProjectFlowState>): void {
  if ('inlineError' in patch && !('inlineRetry' in patch)) {
    useProjectStore.setState({ ...patch, inlineRetry: null });
    return;
  }
  useProjectStore.setState(patch);
}

export function selectedCandidate(state: ProjectFlowState): Candidate | null {
  return (
    state.candidates.find((candidate) => candidate.candidateId === state.selectedCandidateId) ??
    null
  );
}

/** The base candidate a (possibly nudged) candidate derives from. */
export function baseCandidateOf(
  state: ProjectFlowState,
  candidateId: string | null,
): string | null {
  if (!candidateId) return null;
  if (state.baseCandidateIds.includes(candidateId)) return candidateId;
  const candidate = state.candidates.find((item) => item.candidateId === candidateId);
  return candidate?.derivedFromCandidateId ?? null;
}

/** The look a variant shows. */
export function lookOf(variant: Pick<Variant, 'holidayId' | 'style' | 'lightingMode'>): Look {
  return { holidayId: variant.holidayId, style: variant.style, lightingMode: variant.lightingMode };
}

/**
 * Whether a look is being made for the open project: its first look, or another look while the
 * current one stays on screen.
 */
export function makingLook(state: Pick<ProjectFlowState, 'phase' | 'pending'>): boolean {
  return state.phase === 'starting' || state.phase === 'waiting' || state.pending !== null;
}

/** The job status behind the look being made; null until the server has answered. */
export function activeLookStatus(state: ProjectFlowState): RenderStatus | null {
  if (state.pending) return state.pending.render;
  if (state.phase !== 'starting' && state.phase !== 'waiting') return null;
  return state.render && !isTerminalRenderJobState(state.render.state) ? state.render : null;
}

/**
 * The look being made: the pending look, or the look of the first look's job. May return a new
 * object, so components call it inside `useMemo` rather than as a store selector.
 */
export function lookBeingMade(state: ProjectFlowState): Look | null {
  if (state.pending) return state.pending.look;
  const status = activeLookStatus(state);
  return status ? lookOf(status) : null;
}

/** Records that a locked control was used. */
export function noteLocked(): void {
  useProjectStore.setState((state) => ({ lockedNotice: state.lockedNotice + 1 }));
}

/** True, after noting it, when a look is being made: the caller leaves the look alone. */
export function refuseWhileMakingLook(): boolean {
  if (!makingLook(useProjectStore.getState())) return false;
  noteLocked();
  return true;
}
