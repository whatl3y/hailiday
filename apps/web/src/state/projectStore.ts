import { create } from 'zustand';
import type {
  ActiveSource,
  Candidate,
  Discovery,
  HolidayId,
  LightingMode,
  OfferedSet,
  Project,
  RenderStatus,
  Style,
  Variant,
} from '@holiday/core';

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
  /** A new look being decorated under the "Decorating the … look" band. */
  pending: PendingLook | null;
  /** A pending look that failed or was rejected: the error sheet over the current preview. */
  pendingError: RenderStatus | null;
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
  revealFor: null,
  autoStarted: false,
  confirmNotice: null,
  uploadContext: 'project',
  uploadReturnPhase: null,
  nosvCause: null,
  busy: false,
  inlineError: null,
  inlineRetry: null,
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
