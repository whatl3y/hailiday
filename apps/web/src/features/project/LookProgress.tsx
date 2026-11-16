import { useEffect, useMemo, useState, type FocusEvent, type ReactNode } from 'react';
import { isTerminalRenderJobState, type LightingMode, type RenderStatus } from '@hailiday/core';
import { holidayName, isCopyKey, t, tDynamic } from '../../copy';
import { retentionText, useTimeBasedDeletion } from '../../copy/retention';
import { CLIENT_DEFAULTS, DISPLAY_VALUES } from '../../config/values';
import {
  activeLookStatus,
  makingLook,
  useProjectStore,
  type ProjectFlowState,
  type StageTrail,
} from '../../state/projectStore';
import { Icon } from '../../ui/Icon';
import { useReducedMotion } from '../../ui/motion';
import { cancelPendingLook, cancelRender, offeredFor } from './controller';
import { useLightFallback } from './lookFallback';
import { lookLabel } from './looks';
import { renderErrorPlan } from './plans';
import { trailFor, trailWordKey } from './stageTrail';
import './look-progress.css';

/** The hidden line locked controls point at with `aria-describedby`. */
export const LOCK_HINT_ID = 'look-lock-hint';
/** How long the lock line shows after a locked control is used. */
export const LOCK_NOTICE_MS = 4000;
/** How long a note shows before the next one, while the notes rotate by themselves. */
export const NOTE_INTERVAL_MS = 7000;
/** The fade between two notes, out and then in. */
export const NOTE_FADE_MS = 200;
/** How long the title of another look that has just arrived stays in the announcer. */
const ARRIVED_MS = 4000;

/** What every part of the wait reads: the look being made, its job and its trail. */
function useLookProgress() {
  const pending = useProjectStore((state) => state.pending);
  const status = useProjectStore(activeLookStatus);
  const stored = useProjectStore((state) => state.trail);
  const busy = useProjectStore((state) => state.busy);
  const phase = useProjectStore((state) => state.phase);
  const trail = useMemo(() => trailFor(stored, status), [stored, status]);
  const firstLook = pending === null;
  const label =
    firstLook && busy ? t('wait.canceling') : tDynamic(trail.current, 'stage.preparing');
  const queue = status?.queuePosition ?? 0;
  const reviewing = status?.state === 'needs_review';
  const secondPass = useProjectStore((state) => state.secondPass);
  return { pending, status, trail, busy, phase, firstLook, label, queue, reviewing, secondPass };
}

/**
 * True for a few seconds after a locked control was used, while a look is being made, so the
 * screen can say why nothing happened. Uses before this screen opened are not shown again.
 */
export function useLockedNotice(): boolean {
  const count = useProjectStore((state) => state.lockedNotice);
  const locked = useProjectStore(makingLook);
  const [seen, setSeen] = useState({ count, visible: false });
  if (count !== seen.count) setSeen({ count, visible: true });
  useEffect(() => {
    if (!seen.visible) return;
    const timer = window.setTimeout(
      () => setSeen((current) => (current === seen ? { ...current, visible: false } : current)),
      LOCK_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [seen]);
  return locked && seen.visible;
}

/**
 * Whether the job has been running longer than a look usually takes. False for no job or a
 * finished one; a new job starts again from false (a retry never inherits the old job's wait).
 */
export function useLongWait(status: RenderStatus | null): boolean {
  const running = status !== null && !isTerminalRenderJobState(status.state);
  const jobId = running ? status.renderJobId : null;
  const requestedAt = running ? status.timestamps.requestedAt : null;
  const [longFor, setLongFor] = useState<string | null>(null);
  useEffect(() => {
    if (!jobId || !requestedAt) return;
    const elapsed = Date.now() - Date.parse(requestedAt);
    const timer = window.setTimeout(
      () => setLongFor(jobId),
      Math.max(0, CLIENT_DEFAULTS.longWaitMs - (Number.isFinite(elapsed) ? elapsed : 0)),
    );
    return () => window.clearTimeout(timer);
  }, [jobId, requestedAt]);
  return jobId !== null && longFor === jobId;
}

/**
 * For another look that runs longer than a look usually takes, the long-wait line (null
 * otherwise). A saved place is kept on the saved schedule, so its line names no anonymous period.
 * A first look says it on the waiting screen instead.
 */
function useAnotherLookLongWait(firstLook: boolean, status: RenderStatus | null): string | null {
  const longWait = useLongWait(firstLook ? null : status);
  const saved = useProjectStore((state) => state.project?.saved ?? false);
  const timeBasedDeletion = useTimeBasedDeletion();
  return longWait ? retentionText('longWait', timeBasedDeletion && !saved) : null;
}

/**
 * Cancel for the look being made. On a first look it waits until the job exists and is not
 * already being canceled; for another look it stops the pending look and keeps the one on screen.
 */
export function CancelLook() {
  const pending = useProjectStore((state) => state.pending);
  const busy = useProjectStore((state) => state.busy);
  const phase = useProjectStore((state) => state.phase);
  const firstLook = pending === null;
  const unavailable = firstLook && (busy || phase === 'starting');
  return (
    <button
      type="button"
      className="button button--small button--quiet look-card__cancel"
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (unavailable) return;
        void (firstLook ? cancelRender() : cancelPendingLook());
      }}
    >
      {t('wait.cancel')}
    </button>
  );
}

/**
 * The stages the job has reported, each once and in order, by their short words: a check for
 * each stage passed and a pulsing dot for the current one. `max` keeps only the last entries.
 */
export function StageTrailList({ trail, max }: { trail: StageTrail; max?: number }) {
  const entries = trail.keys.flatMap((key) => {
    const wordKey = trailWordKey(key);
    return isCopyKey(wordKey) ? [{ key, word: t(wordKey) }] : [];
  });
  const cut = max !== undefined && entries.length > max;
  const shown = cut ? entries.slice(-max) : entries;
  return (
    <ol className="stage-trail" aria-label={t('trail.label')}>
      {cut ? (
        <li className="stage-trail__more">
          <span aria-hidden="true">…</span>
          <span className="sr-only">{t('trail.earlier')}</span>
        </li>
      ) : null}
      {shown.map(({ key, word }) => {
        const current = key === trail.current;
        return (
          <li key={key} aria-current={current ? 'step' : undefined}>
            {current ? (
              <span className="stage-trail__dot" aria-hidden="true" />
            ) : (
              <Icon name="check" />
            )}
            {word}
            <span className="sr-only">{current ? t('trail.current') : t('trail.done')}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Three dots that pulse after the stage label (still under reduced motion). */
function Pulse() {
  return (
    <span className="look-pulse" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export interface LookCardProps {
  placement: 'stage' | 'paper' | 'band';
  /** Cancel inside the card; false where the row under the picture holds it. Default true. */
  cancel?: boolean;
  /** "Not your place?", at the end of the paper card's hint line. */
  escape?: ReactNode;
}

/**
 * The status card of the look being made: the stage the job reports with a pulse, the trail of
 * the stages it has reported, a one-line hint (the usual time, the queue position or the review
 * note) and Cancel. Another look that runs past the long-wait threshold says so in place of the
 * usual time (on the band, in place of the trail), so nothing under the picture moves. The page's
 * own second pass at a look that ended with nothing to show says so in the hint's place. `stage`
 * hangs from the light string on dark glass and names another look above the label; `paper`
 * stands where the title will be on a first look; `band` lies over the title of the look on
 * screen while another look is made, in the title's own box.
 */
export function LookCard({ placement, cancel = true, escape }: LookCardProps) {
  const { pending, status, trail, firstLook, label, queue, reviewing, secondPass } =
    useLookProgress();
  const notice = useLockedNotice();
  const longWaitLine = useAnotherLookLongWait(firstLook, status);
  const holidayId = pending?.look.holidayId ?? null;
  const name =
    firstLook || !holidayId
      ? t('wait.heading')
      : t('result.decoratingLook', { holiday: holidayName(holidayId) });
  const hint = secondPass
    ? t('wait.secondPass')
    : queue > 0
      ? t('wait.queuePosition', { n: queue })
      : reviewing
        ? t('wait.reviewNote')
        : (longWaitLine ?? t('wait.usuallyAbout'));
  const labelLine = (
    <p className="look-card__label">
      {label}
      <Pulse />
    </p>
  );
  const classes = `look-card look-card--${placement}${placement === 'band' ? ' pending-band' : ''}`;

  if (placement === 'band') {
    return (
      <div className={classes} role="group" aria-label={name}>
        {labelLine}
        {notice ? (
          <p className="look-card__line">{t('controls.locked')}</p>
        ) : secondPass ? (
          <p className="look-card__line">{t('wait.secondPass')}</p>
        ) : queue > 0 ? (
          <p className="look-card__line">{t('wait.queuePosition', { n: queue })}</p>
        ) : longWaitLine ? (
          <p className="look-card__line">{longWaitLine}</p>
        ) : (
          <StageTrailList trail={trail} max={3} />
        )}
        {cancel ? <CancelLook /> : null}
      </div>
    );
  }

  if (placement === 'paper') {
    return (
      <div className={classes} role="group" aria-label={name}>
        <div className="look-card__head">
          {labelLine}
          {cancel ? <CancelLook /> : null}
        </div>
        <StageTrailList trail={trail} />
        <div className="look-card__foot">
          <p className="look-card__hint">{notice ? t('controls.locked') : hint}</p>
          {escape}
        </div>
      </div>
    );
  }

  const eyebrow =
    !firstLook && pending
      ? lookLabel(pending.look, offeredFor(pending.look.holidayId).lightingModes)
      : null;
  return (
    <div className={classes} role="group" aria-label={name}>
      {eyebrow ? <p className="look-card__eyebrow">{eyebrow}</p> : null}
      {labelLine}
      <StageTrailList trail={trail} />
      <div className="look-card__foot">
        <p className="look-card__hint">{hint}</p>
        {cancel ? <CancelLook /> : null}
      </div>
      {notice ? <p className="look-card__notice">{t('controls.locked')}</p> : null}
    </div>
  );
}

export interface WaitingNotesInput {
  lightingMode: LightingMode | null;
  /** Stage keys this look has reported. */
  stageKeys: readonly string[];
  timeBasedDeletion: boolean;
  saved: boolean;
}

/** The stages in which the job sets a look's light (evening or bright). */
const LIGHT_STAGES: readonly string[] = ['stage.eveningLight', 'stage.brightLight'];

/**
 * The notes shown while a first look is made, in order: each one true for this look (the light
 * named as new only once the job has reported a light stage, so a dusk photo decorated in its
 * own light never claims it; the sharpen note only once the job has reported that stage; the
 * leave note naming the anonymous retention period only for a place not saved while time-based
 * deletion is on; the save note only for a place not yet saved).
 */
export function waitingNotes(input: WaitingNotesInput): string[] {
  const relit = input.stageKeys.some((key) => LIGHT_STAGES.includes(key));
  const notes = [t(relit ? 'wait.note.keptRelit' : 'wait.note.kept'), t('wait.note.checked')];
  if (input.stageKeys.includes('stage.enhancing')) notes.push(t('wait.note.sharpen'));
  if (input.lightingMode === 'evening') notes.push(t('wait.note.evening'));
  if (input.lightingMode === 'bright') notes.push(t('wait.note.bright'));
  notes.push(
    input.timeBasedDeletion && !input.saved
      ? t('wait.note.leaveFor', { anonymousRetention: DISPLAY_VALUES.anonymousRetention })
      : t('wait.note.leave'),
  );
  notes.push(t('wait.note.compare'), t('wait.note.gallery'));
  if (!input.saved) notes.push(t('wait.note.save'));
  return notes;
}

/**
 * One quiet line of notes while a first look is made. It changes every few seconds with a short
 * fade, pauses while hovered or focused, and stops changing by itself for good once the person
 * uses Next; under reduced motion it changes only on Next. A change is announced only when the
 * person asked for it.
 */
export function LookNotes(props: WaitingNotesInput) {
  const { lightingMode, stageKeys, timeBasedDeletion, saved } = props;
  const notes = useMemo(
    () => waitingNotes({ lightingMode, stageKeys, timeBasedDeletion, saved }),
    [lightingMode, stageKeys, timeBasedDeletion, saved],
  );
  const reducedMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [taken, setTaken] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const rotating = !reducedMotion && !taken && !hovered && !focused;
  const manual = taken || reducedMotion;

  useEffect(() => {
    if (!rotating || leaving) return;
    const timer = window.setTimeout(() => setLeaving(true), NOTE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [rotating, leaving, index]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => {
      setIndex((current) => current + 1);
      setLeaving(false);
    }, NOTE_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  function next() {
    setTaken(true);
    setLeaving(false);
    setIndex((current) => current + 1);
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  }

  return (
    <div
      className="look-notes"
      role="group"
      aria-label={t('wait.notesLabel')}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={onBlur}
    >
      <p
        className="look-notes__text"
        data-leaving={leaving || undefined}
        aria-live={manual ? 'polite' : 'off'}
        aria-atomic="true"
      >
        {notes[index % notes.length]}
      </p>
      <button
        type="button"
        className="look-notes__next"
        aria-label={t('wait.nextNote')}
        onClick={next}
      >
        <Icon name="chevronRight" />
      </button>
    </div>
  );
}

/** The status of a look that ended in its notice, under a preview or on the place's photo. */
function unfinishedLook(state: ProjectFlowState): RenderStatus | null {
  return state.pendingError ?? (state.phase === 'render_error' ? state.render : null);
}

/**
 * The page's one polite status for a look, mounted for every phase so it exists before a look
 * starts. It says the start, each stage label once when it changes, the page's own second pass,
 * the lock line when a locked control is used and, for another look, the new title when it
 * arrives (a first look moves focus to the result's heading instead). A look that ends without
 * the picture asked for says its outcome once: the notice of a look that could not be finished,
 * or the line under a look shown in the photo's own light.
 */
export function LookAnnouncer() {
  const { pending, firstLook, label, secondPass } = useLookProgress();
  const making = useProjectStore(makingLook);
  const count = useProjectStore((state) => state.lockedNotice);
  const notice = useLockedNotice();
  const variantId = useProjectStore((state) => state.variant?.renderAssetId ?? null);
  const variantHoliday = useProjectStore((state) => state.variant?.holidayId ?? null);
  const unfinished = useProjectStore(unfinishedLook);
  const streetView = useProjectStore((state) => {
    const kind = state.project?.activeSource?.kind;
    return kind === 'street_view' || kind === 'fixture';
  });
  const ownLight = useLightFallback((state) =>
    state.dismissed || !state.fallback
      ? null
      : `${state.fallback.renderAssetId}|${state.fallback.lightingMode}`,
  );
  const [previous, setPrevious] = useState({ pending: pending !== null, variantId });
  const [arrived, setArrived] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ said: string; text: string } | null>(null);
  const [said, setSaid] = useState<{ unfinished: string | null; ownLight: string | null }>({
    unfinished: null,
    ownLight: null,
  });

  if (previous.pending !== (pending !== null) || previous.variantId !== variantId) {
    if (
      previous.pending &&
      pending === null &&
      variantId !== null &&
      variantId !== previous.variantId &&
      variantHoliday
    ) {
      setArrived(t('result.heading', { holiday: holidayName(variantHoliday) }));
    }
    setPrevious({ pending: pending !== null, variantId });
  }

  const unfinishedId = unfinished?.renderJobId ?? null;
  if (unfinished && unfinishedId !== said.unfinished) {
    setSaid({ ...said, unfinished: unfinishedId });
    setOutcome({
      said: `unfinished-${unfinishedId}`,
      text: t(renderErrorPlan(unfinished, streetView).messageKey),
    });
  } else if (ownLight && ownLight !== said.ownLight) {
    setSaid({ ...said, ownLight });
    setOutcome({
      said: `light-${ownLight}`,
      text: t(
        ownLight.endsWith('|bright') ? 'result.brightUnavailable' : 'result.eveningUnavailable',
      ),
    });
  } else if (!ownLight && said.ownLight !== null) {
    setSaid({ ...said, ownLight: null });
  }

  useEffect(() => {
    if (!arrived) return;
    const timer = window.setTimeout(() => setArrived(null), ARRIVED_MS);
    return () => window.clearTimeout(timer);
  }, [arrived]);

  useEffect(() => {
    if (!outcome) return;
    const timer = window.setTimeout(() => setOutcome(null), ARRIVED_MS);
    return () => window.clearTimeout(timer);
  }, [outcome]);

  const intro = !making
    ? ''
    : firstLook || !pending
      ? t('wait.heading')
      : t('result.decoratingLook', { holiday: holidayName(pending.look.holidayId) });
  const stage = making ? label : '';

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="false">
      {intro ? <span key="intro">{intro} </span> : null}
      {stage ? <span key={stage}>{stage} </span> : null}
      {making && secondPass ? <span key="second-pass">{t('wait.secondPass')} </span> : null}
      {notice ? <span key={`locked-${count}`}>{t('controls.locked')} </span> : null}
      {arrived ? <span key={arrived}>{arrived}</span> : null}
      {outcome ? (
        <span key={outcome.said}>
          {arrived ? ' ' : ''}
          {outcome.text}
        </span>
      ) : null}
    </div>
  );
}
