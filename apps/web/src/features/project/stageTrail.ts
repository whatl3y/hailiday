import {
  NON_TERMINAL_RENDER_JOB_STATES,
  stageLabelKeyFor,
  type RenderJobState,
  type RenderStatus,
  type StageLabelKey,
} from '@hailiday/core';
import { isFramingStage } from '../../api/renderStatus';
import type { StageTrail } from '../../state/projectStore';

/** The stage a look shows while its request is on its way. */
export const FIRST_STAGE: StageLabelKey = 'stage.preparing';

/** The label key a status shows: the server's own key, else the key of its state. */
export function stageKeyOf(
  status: Pick<RenderStatus, 'state' | 'stageLabelKey'>,
): StageLabelKey | null {
  return status.stageLabelKey ?? stageLabelKeyFor(status.state);
}

/**
 * The stage keys of the states before `state` in the pipeline. The job has passed them: the
 * state machine is a line up to `checking`.
 */
export function passedStageKeys(state: RenderJobState): StageLabelKey[] {
  const index = (NON_TERMINAL_RENDER_JOB_STATES as readonly string[]).indexOf(state);
  if (index <= 0) return [];
  const own = stageLabelKeyFor(state);
  const keys: StageLabelKey[] = [];
  for (const earlier of NON_TERMINAL_RENDER_JOB_STATES.slice(0, index)) {
    const key = stageLabelKeyFor(earlier);
    if (key && key !== own && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The stages a status implies the job has passed before its current one: the stages of the
 * states before its own, and the photo before the framing step (which zooms in on the home in
 * the photo the job fetched, inside `preparing`). The framing step itself is never implied: it
 * runs only on the first look of a Street View photo.
 */
function impliedStageKeys(state: RenderJobState, current: StageLabelKey): StageLabelKey[] {
  const keys = passedStageKeys(state);
  if (isFramingStage(current) && !keys.includes(FIRST_STAGE)) keys.push(FIRST_STAGE);
  return keys;
}

/**
 * The trail after a status, in the order the stages were seen (a first Street View look that
 * reports each of them: Photo, Zoom, Plan, Sharpen, Decorate, Check, Evening light). A status
 * of another job starts a new trail; a terminal status changes nothing; a stage seen
 * before becomes current again and adds no entry; a stage the page did not see is listed only
 * when the job's state implies it.
 */
export function advanceTrail(previous: StageTrail | null, status: RenderStatus): StageTrail | null {
  const same = previous !== null && previous.renderJobId === status.renderJobId;
  const current = stageKeyOf(status);
  if (!current) return same ? previous : null;
  const keys = same ? [...previous.keys] : [];
  for (const key of [...impliedStageKeys(status.state, current), current]) {
    if (!keys.includes(key)) keys.push(key);
  }
  if (same && previous.current === current && keys.length === previous.keys.length) {
    return previous;
  }
  return { renderJobId: status.renderJobId, keys, current };
}

/**
 * The trail the card shows: the stored one when it belongs to the job being followed, else what
 * the job's status alone implies, else the first stage while the request is on its way.
 */
export function trailFor(stored: StageTrail | null, status: RenderStatus | null): StageTrail {
  if (status && stored && stored.renderJobId === status.renderJobId) return stored;
  return (
    (status ? advanceTrail(null, status) : null) ?? {
      renderJobId: '',
      keys: [FIRST_STAGE],
      current: FIRST_STAGE,
    }
  );
}

/** The copy key of a stage's short trail word (`stage.planning` becomes `trail.planning`). */
export function trailWordKey(key: string): string {
  return key.replace(/^stage\./, 'trail.');
}
