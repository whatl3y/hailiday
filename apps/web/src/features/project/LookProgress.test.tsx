import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderStatus, StageLabelKey } from '@hailiday/core';
import { t } from '../../copy';
import { CLIENT_DEFAULTS, DISPLAY_VALUES } from '../../config/values';
import {
  INITIAL_PROJECT_FLOW,
  noteLocked,
  useProjectStore,
  type ProjectFlowState,
} from '../../state/projectStore';
import { mockReducedMotion, project, renderStatus, variant } from '../../test/fixtures';
import { cancelPendingLook, cancelRender } from './controller';
import { setLightFallback } from './lookFallback';
import {
  LOCK_NOTICE_MS,
  LookAnnouncer,
  LookCard,
  LookNotes,
  NOTE_FADE_MS,
  NOTE_INTERVAL_MS,
  StageTrailList,
  useLongWait,
  waitingNotes,
} from './LookProgress';

vi.mock('./controller', () => ({
  cancelRender: vi.fn(async () => undefined),
  cancelPendingLook: vi.fn(async () => undefined),
  offeredFor: vi.fn(() => ({
    styles: ['subtle', 'classic', 'abundant'],
    lightingModes: ['source', 'evening'],
    defaultLightingMode: 'source',
  })),
}));

const JOB = '018f0000-0000-7000-8000-000000000101';

function firstLook(status: Partial<RenderStatus> = {}, extra: Partial<ProjectFlowState> = {}) {
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    phase: 'waiting',
    project: project(),
    render: renderStatus({ renderJobId: JOB, ...status }),
    ...extra,
  });
}

function anotherLook(status: Partial<RenderStatus> = {}) {
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    phase: 'result',
    project: project(),
    variant: variant(),
    pending: {
      look: { holidayId: 'halloween', style: 'abundant', lightingMode: 'evening' },
      render: renderStatus({ renderJobId: JOB, holidayId: 'halloween', ...status }),
    },
  });
}

function label(container: HTMLElement): string {
  return container.querySelector('.look-card__label')?.textContent ?? '';
}

beforeEach(() => {
  mockReducedMotion(false);
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
  setLightFallback(null);
});

describe('LookCard', () => {
  it("shows the stage the server names, else the label of the job's state", () => {
    firstLook({ state: 'planning', stageLabelKey: 'stage.planning' });
    const { container } = render(<LookCard placement="stage" />);
    expect(label(container)).toBe(t('stage.planning'));
    act(() => {
      useProjectStore.setState({
        render: renderStatus({ renderJobId: JOB, state: 'checking', stageLabelKey: null }),
      });
    });
    expect(label(container)).toBe(t('stage.checking'));
    // The pulse follows the label inside its line.
    expect(
      container.querySelector('.look-card__label .look-pulse')?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  it('says the first stage while the request is on its way', () => {
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, phase: 'starting', project: project() });
    const { container } = render(<LookCard placement="paper" />);
    expect(label(container)).toBe(t('stage.preparing'));
  });

  it('says "Canceling…" while a first look is being canceled', () => {
    firstLook({ state: 'rendering', stageLabelKey: 'stage.rendering' }, { busy: true });
    const { container } = render(<LookCard placement="stage" />);
    expect(label(container)).toBe(t('wait.canceling'));
  });

  it('hints the usual time, the queue position when queued, the review note in review', () => {
    firstLook({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    const { container } = render(<LookCard placement="stage" />);
    const hint = () => container.querySelector('.look-card__hint')?.textContent;
    expect(hint()).toBe(t('wait.usuallyAbout'));
    act(() => {
      useProjectStore.setState({
        render: renderStatus({ renderJobId: JOB, state: 'queued', queuePosition: 3 }),
      });
    });
    expect(hint()).toBe(t('wait.queuePosition', { n: 3 }));
    act(() => {
      useProjectStore.setState({
        render: renderStatus({ renderJobId: JOB, state: 'needs_review', stageLabelKey: null }),
      });
    });
    expect(hint()).toBe(t('wait.reviewNote'));
  });

  it('names a first look, and names another look and shows it above the label on the stage', () => {
    firstLook({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    const { container, unmount } = render(<LookCard placement="stage" />);
    expect(screen.getByRole('group', { name: t('wait.heading') })).toBeTruthy();
    expect(container.querySelector('.look-card__eyebrow')).toBeNull();
    unmount();

    anotherLook({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    const next = render(<LookCard placement="stage" />);
    expect(
      screen.getByRole('group', { name: t('result.decoratingLook', { holiday: 'Halloween' }) }),
    ).toBeTruthy();
    expect(next.container.querySelector('.look-card__eyebrow')?.textContent).toBe(
      'Halloween · Abundant · Evening',
    );
  });

  it('keeps the band to the label and the last three entries, with no hint', () => {
    anotherLook({ state: 'checking', stageLabelKey: 'stage.checking' });
    const { container } = render(<LookCard placement="band" cancel />);
    const band = container.querySelector('.look-card')!;
    expect(band.classList.contains('look-card--band')).toBe(true);
    expect(band.classList.contains('pending-band')).toBe(true);
    const entries = [...band.querySelectorAll('.stage-trail li')];
    // "…" then Plan, Decorate, Check (Photo is cut).
    expect(entries).toHaveLength(4);
    expect(entries[0]!.classList.contains('stage-trail__more')).toBe(true);
    expect(entries[0]!.textContent).toContain(t('trail.earlier'));
    expect(entries.slice(1).map((entry) => entry.textContent)).toEqual([
      `${t('trail.planning')}${t('trail.done')}`,
      `${t('trail.rendering')}${t('trail.done')}`,
      `${t('trail.checking')}${t('trail.current')}`,
    ]);
    expect(band.querySelector('.look-card__hint')).toBeNull();
    expect(band.textContent).not.toContain(t('wait.usuallyAbout'));
  });

  describe('for a look that takes longer than usual', () => {
    const LONG_WAIT = t('wait.longWaitKept');

    function started(): Partial<RenderStatus> {
      return {
        state: 'rendering',
        stageLabelKey: 'stage.rendering',
        timestamps: { ...renderStatus().timestamps, requestedAt: new Date().toISOString() },
      };
    }

    async function pastLongWait() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLIENT_DEFAULTS.longWaitMs);
      });
    }

    it('says so in the hint of another look, in place of the usual time', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      anotherLook(started());
      const { container } = render(<LookCard placement="stage" />);
      const hint = () => container.querySelector('.look-card__hint')?.textContent;
      expect(hint()).toBe(t('wait.usuallyAbout'));
      await pastLongWait();
      expect(hint()).toBe(LONG_WAIT);
      expect(container.querySelectorAll('.look-card__hint')).toHaveLength(1);
    });

    it('says so on the band in place of the trail', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      anotherLook(started());
      const { container } = render(<LookCard placement="band" />);
      expect(container.querySelector('.stage-trail')).not.toBeNull();
      await pastLongWait();
      expect(container.querySelector('.stage-trail')).toBeNull();
      expect(container.querySelector('.look-card__line')?.textContent).toBe(LONG_WAIT);
    });

    it('keeps the queue position ahead of it, on the stage and on the band', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      anotherLook({ ...started(), state: 'queued', queuePosition: 2 });
      const stage = render(<LookCard placement="stage" />);
      const band = render(<LookCard placement="band" />);
      await pastLongWait();
      const queued = t('wait.queuePosition', { n: 2 });
      expect(stage.container.querySelector('.look-card__hint')?.textContent).toBe(queued);
      expect(band.container.querySelector('.look-card__line')?.textContent).toBe(queued);
      expect(stage.container.textContent).not.toContain(LONG_WAIT);
      expect(band.container.textContent).not.toContain(LONG_WAIT);
    });

    it('keeps the usual time on the card of a first look, whose screen says it elsewhere', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      firstLook(started());
      const { container } = render(<LookCard placement="stage" />);
      await pastLongWait();
      expect(container.querySelector('.look-card__hint')?.textContent).toBe(t('wait.usuallyAbout'));
      expect(container.textContent).not.toContain(LONG_WAIT);
    });
  });

  it("says the page's own second pass in the hint of every card, queued or not", () => {
    firstLook({ state: 'queued', queuePosition: 2 }, { secondPass: true });
    const { container, unmount } = render(<LookCard placement="stage" />);
    expect(container.querySelector('.look-card__hint')?.textContent).toBe(
      'Taking one more pass to get this right.',
    );
    unmount();
    const paper = render(<LookCard placement="paper" />);
    expect(paper.container.querySelector('.look-card__hint')?.textContent).toBe(
      t('wait.secondPass'),
    );
    paper.unmount();
    anotherLook({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    act(() => useProjectStore.setState({ secondPass: true }));
    const band = render(<LookCard placement="band" />);
    expect(band.container.querySelector('.stage-trail')).toBeNull();
    expect(band.container.querySelector('.look-card__line')?.textContent).toBe(
      t('wait.secondPass'),
    );
  });

  it('puts the queue position on the band in place of the trail', () => {
    anotherLook({ state: 'queued', queuePosition: 2 });
    const { container } = render(<LookCard placement="band" />);
    expect(container.querySelector('.stage-trail')).toBeNull();
    expect(container.querySelector('.look-card__line')?.textContent).toBe(
      t('wait.queuePosition', { n: 2 }),
    );
  });

  it('cancels a first look once the job exists, and another look at any time', () => {
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, phase: 'starting', project: project() });
    const { unmount } = render(<LookCard placement="paper" />);
    const early = screen.getByRole('button', { name: t('wait.cancel') });
    expect(early.getAttribute('aria-disabled')).toBe('true');
    expect(early.className).toBe('button button--small button--quiet look-card__cancel');
    fireEvent.click(early);
    expect(cancelRender).not.toHaveBeenCalled();
    act(() => firstLook({ state: 'rendering' }));
    const ready = screen.getByRole('button', { name: t('wait.cancel') });
    expect(ready.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(ready);
    expect(cancelRender).toHaveBeenCalledTimes(1);
    unmount();

    anotherLook({ state: 'rendering' });
    render(<LookCard placement="stage" />);
    fireEvent.click(screen.getByRole('button', { name: t('wait.cancel') }));
    expect(cancelPendingLook).toHaveBeenCalledTimes(1);
  });

  it('leaves Cancel out where the row under the picture holds it', () => {
    anotherLook({ state: 'rendering' });
    render(<LookCard placement="band" cancel={false} />);
    expect(screen.queryByRole('button', { name: t('wait.cancel') })).toBeNull();
  });

  it('shows the lock line for a few seconds after a locked control is used', () => {
    vi.useFakeTimers();
    anotherLook({ state: 'rendering' });
    const { container } = render(<LookCard placement="stage" />);
    expect(container.querySelector('.look-card__notice')).toBeNull();
    act(() => noteLocked());
    expect(container.querySelector('.look-card__notice')?.textContent).toBe(t('controls.locked'));
    act(() => {
      vi.advanceTimersByTime(LOCK_NOTICE_MS);
    });
    expect(container.querySelector('.look-card__notice')).toBeNull();
  });

  it('puts the lock line in the hint line on paper and in line 2 of the band', () => {
    firstLook({ state: 'rendering' });
    const paper = render(
      <LookCard placement="paper" escape={<button type="button">Esc</button>} />,
    );
    act(() => noteLocked());
    expect(paper.container.querySelector('.look-card__hint')?.textContent).toBe(
      t('controls.locked'),
    );
    paper.unmount();

    anotherLook({ state: 'rendering' });
    const band = render(<LookCard placement="band" />);
    act(() => noteLocked());
    expect(band.container.querySelector('.look-card__line')?.textContent).toBe(
      t('controls.locked'),
    );
    expect(band.container.querySelector('.stage-trail')).toBeNull();
  });
});

describe('StageTrailList', () => {
  it('checks the passed stages, marks the current one and says which is which', () => {
    const { container } = render(
      <StageTrailList
        trail={{
          renderJobId: JOB,
          keys: ['stage.preparing', 'stage.planning', 'stage.rendering'],
          current: 'stage.planning',
        }}
      />,
    );
    const list = screen.getByRole('list', { name: t('trail.label') });
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(entries[0]!.querySelector('svg.icon')).not.toBeNull();
    expect(entries[0]!.getAttribute('aria-current')).toBeNull();
    expect(entries[0]!.querySelector('.sr-only')?.textContent).toBe(t('trail.done'));
    expect(entries[1]!.getAttribute('aria-current')).toBe('step');
    expect(entries[1]!.querySelector('.stage-trail__dot')).not.toBeNull();
    expect(entries[1]!.querySelector('.sr-only')?.textContent).toBe(t('trail.current'));
    expect(container.querySelector('.stage-trail__more')).toBeNull();
  });

  it('leaves out a stage that has no trail word', () => {
    render(
      <StageTrailList
        trail={{
          renderJobId: JOB,
          keys: ['stage.preparing', 'stage.somethingNew' as StageLabelKey, 'stage.rendering'],
          current: 'stage.rendering',
        }}
      />,
    );
    const entries = screen.getAllByRole('listitem');
    expect(entries.map((entry) => entry.firstChild?.nextSibling?.textContent)).toEqual([
      t('trail.preparing'),
      t('trail.rendering'),
    ]);
  });
});

describe('waitingNotes', () => {
  const base = { lightingMode: null, stageKeys: [], timeBasedDeletion: false, saved: false };

  it('says only what is true of a look as photographed', () => {
    expect(waitingNotes({ ...base, lightingMode: 'source' })).toEqual([
      t('wait.note.kept'),
      t('wait.note.checked'),
      t('wait.note.leave'),
      t('wait.note.compare'),
      t('wait.note.gallery'),
      t('wait.note.save'),
    ]);
  });

  it('names the light as new for an evening or a bright look once the job reports its light', () => {
    const evening = waitingNotes({
      ...base,
      lightingMode: 'evening',
      stageKeys: ['stage.preparing', 'stage.rendering', 'stage.eveningLight'],
    });
    expect(evening[0]).toBe(t('wait.note.keptRelit'));
    expect(evening).toContain(t('wait.note.evening'));
    expect(evening).not.toContain(t('wait.note.bright'));
    const bright = waitingNotes({
      ...base,
      lightingMode: 'bright',
      stageKeys: ['stage.preparing', 'stage.brightLight'],
    });
    expect(bright[0]).toBe(t('wait.note.keptRelit'));
    expect(bright).toContain(t('wait.note.bright'));
    expect(bright).not.toContain(t('wait.note.evening'));
  });

  it('claims no new light before the job reports a light stage, as for a dusk photo', () => {
    const dusk = waitingNotes({
      ...base,
      lightingMode: 'evening',
      stageKeys: ['stage.preparing', 'stage.planning', 'stage.rendering', 'stage.checking'],
    });
    expect(dusk[0]).toBe(t('wait.note.kept'));
    expect(dusk).not.toContain(t('wait.note.keptRelit'));
    expect(waitingNotes({ ...base, lightingMode: 'bright' })[0]).toBe(t('wait.note.kept'));
  });

  it('mentions sharpening only once the job has reported that stage', () => {
    expect(waitingNotes(base)).not.toContain(t('wait.note.sharpen'));
    expect(waitingNotes({ ...base, stageKeys: ['stage.preparing', 'stage.enhancing'] })[2]).toBe(
      t('wait.note.sharpen'),
    );
  });

  it('names the retention period of a place not saved while time-based deletion is on', () => {
    const notes = waitingNotes({ ...base, timeBasedDeletion: true, saved: false });
    expect(notes).toContain(
      t('wait.note.leaveFor', { anonymousRetention: DISPLAY_VALUES.anonymousRetention }),
    );
    expect(notes).not.toContain(t('wait.note.leave'));
    expect(notes).toContain(t('wait.note.save'));
  });

  it('names no anonymous retention period for a saved place, and drops Save once saved', () => {
    const notes = waitingNotes({ ...base, timeBasedDeletion: true, saved: true });
    expect(notes).toContain(t('wait.note.leave'));
    expect(notes).not.toContain(
      t('wait.note.leaveFor', { anonymousRetention: DISPLAY_VALUES.anonymousRetention }),
    );
    expect(notes).not.toContain(t('wait.note.save'));
  });
});

describe('LookNotes', () => {
  const props = {
    lightingMode: 'source' as const,
    stageKeys: [],
    timeBasedDeletion: false,
    saved: false,
  };
  const notes = waitingNotes(props);
  const text = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.look-notes__text')!;

  it('changes the note every few seconds with a short fade, unannounced', () => {
    vi.useFakeTimers();
    const { container } = render(<LookNotes {...props} />);
    expect(screen.getByRole('group', { name: t('wait.notesLabel') })).toBeTruthy();
    expect(text(container).textContent).toBe(notes[0]);
    expect(text(container).getAttribute('aria-live')).toBe('off');
    act(() => {
      vi.advanceTimersByTime(NOTE_INTERVAL_MS);
    });
    expect(text(container).hasAttribute('data-leaving')).toBe(true);
    act(() => {
      vi.advanceTimersByTime(NOTE_FADE_MS);
    });
    expect(text(container).hasAttribute('data-leaving')).toBe(false);
    expect(text(container).textContent).toBe(notes[1]);
  });

  it('holds still while hovered or focused', () => {
    vi.useFakeTimers();
    const { container } = render(<LookNotes {...props} />);
    const group = container.querySelector('.look-notes')!;
    fireEvent.pointerEnter(group);
    act(() => {
      vi.advanceTimersByTime(NOTE_INTERVAL_MS * 3);
    });
    expect(text(container).textContent).toBe(notes[0]);
    fireEvent.pointerLeave(group);
    fireEvent.focus(screen.getByRole('button', { name: t('wait.nextNote') }));
    act(() => {
      vi.advanceTimersByTime(NOTE_INTERVAL_MS * 3);
    });
    expect(text(container).textContent).toBe(notes[0]);
  });

  it('shows the next note at once on Next, announces it and stops changing by itself', () => {
    vi.useFakeTimers();
    const { container } = render(<LookNotes {...props} />);
    const next = screen.getByRole('button', { name: t('wait.nextNote') });
    fireEvent.click(next);
    expect(text(container).textContent).toBe(notes[1]);
    expect(text(container).getAttribute('aria-live')).toBe('polite');
    fireEvent.blur(next);
    act(() => {
      vi.advanceTimersByTime(NOTE_INTERVAL_MS * 3);
    });
    expect(text(container).textContent).toBe(notes[1]);
  });

  it('never changes by itself under reduced motion', () => {
    vi.useFakeTimers();
    mockReducedMotion(true);
    const { container } = render(<LookNotes {...props} />);
    expect(text(container).getAttribute('aria-live')).toBe('polite');
    // The rotation takes two steps (the interval, then the fade), each in its own act, as above.
    act(() => {
      vi.advanceTimersByTime(NOTE_INTERVAL_MS);
    });
    expect(text(container).hasAttribute('data-leaving')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(NOTE_FADE_MS);
    });
    expect(text(container).textContent).toBe(notes[0]);
    act(() => {
      vi.advanceTimersByTime(NOTE_INTERVAL_MS);
    });
    act(() => {
      vi.advanceTimersByTime(NOTE_FADE_MS);
    });
    expect(text(container).textContent).toBe(notes[0]);
  });
});

describe('LookAnnouncer', () => {
  const region = () => screen.getByRole('status');

  it('says nothing while no look is being made', () => {
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, phase: 'result', project: project() });
    render(<LookAnnouncer />);
    expect(region().textContent).toBe('');
    expect(region().getAttribute('aria-live')).toBe('polite');
  });

  it('says the start and the stage of a first look, and each new stage once', () => {
    firstLook({ state: 'planning', stageLabelKey: 'stage.planning' });
    render(<LookAnnouncer />);
    expect(region().textContent).toBe(`${t('wait.heading')} ${t('stage.planning')} `);
    const before = region().querySelectorAll('span')[1];
    act(() => {
      useProjectStore.setState({
        render: renderStatus({
          renderJobId: JOB,
          state: 'planning',
          stageLabelKey: 'stage.planning',
          seq: 2,
        }),
      });
    });
    // The same stage reported again is the same node.
    expect(region().querySelectorAll('span')[1]).toBe(before);
    act(() => {
      useProjectStore.setState({
        render: renderStatus({
          renderJobId: JOB,
          state: 'rendering',
          stageLabelKey: 'stage.rendering',
        }),
      });
    });
    expect(region().querySelectorAll('span')[1]).not.toBe(before);
    expect(region().textContent).toContain(t('stage.rendering'));
  });

  it('says the start and the stage of another look', () => {
    anotherLook({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    render(<LookAnnouncer />);
    expect(region().textContent).toBe(
      `${t('result.decoratingLook', { holiday: 'Halloween' })} ${t('stage.rendering')} `,
    );
  });

  it('says the lock line after a locked control is used, for a few seconds', () => {
    vi.useFakeTimers();
    anotherLook({ state: 'rendering' });
    render(<LookAnnouncer />);
    expect(region().textContent).not.toContain(t('controls.locked'));
    act(() => noteLocked());
    expect(region().textContent).toContain(t('controls.locked'));
    act(() => {
      vi.advanceTimersByTime(LOCK_NOTICE_MS);
    });
    expect(region().textContent).not.toContain(t('controls.locked'));
  });

  it('says the new title when another look arrives, and nothing when a first look arrives', () => {
    vi.useFakeTimers();
    anotherLook({ state: 'rendering' });
    render(<LookAnnouncer />);
    const arrived = variant({
      renderAssetId: '018f0000-0000-7000-8000-000000000999',
      holidayId: 'halloween',
    });
    act(() => {
      useProjectStore.setState({ pending: null, variant: arrived });
    });
    expect(region().textContent).toBe(t('result.heading', { holiday: 'Halloween' }));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(region().textContent).toBe('');
    cleanup();

    firstLook({ state: 'rendering' });
    render(<LookAnnouncer />);
    act(() => {
      useProjectStore.setState({ phase: 'result', render: null, variant: arrived });
    });
    expect(region().textContent).toBe('');
  });

  it("says the page's own second pass, for a first look and for another look", () => {
    firstLook({ state: 'queued' }, { secondPass: true });
    render(<LookAnnouncer />);
    expect(region().textContent).toContain(t('wait.secondPass'));
    cleanup();
    anotherLook({ state: 'rendering' });
    render(<LookAnnouncer />);
    expect(region().textContent).not.toContain(t('wait.secondPass'));
    act(() => useProjectStore.setState({ secondPass: true }));
    expect(region().textContent).toContain(t('wait.secondPass'));
  });

  it('says the notice once when another look ends with nothing to show', () => {
    vi.useFakeTimers();
    anotherLook({ state: 'rendering' });
    render(<LookAnnouncer />);
    const ended = renderStatus({
      renderJobId: JOB,
      state: 'rejected',
      rejectionReason: 'qa_critical',
    });
    act(() => useProjectStore.setState({ pending: null, pendingError: ended }));
    expect(region().textContent).toBe(t('result.lookUnfinished'));
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(region().textContent).toBe('');
    act(() => useProjectStore.setState({ pendingError: { ...ended } }));
    expect(region().textContent).toBe('');
  });

  it('says the notice when a first look ends with nothing to show, in its own words', () => {
    firstLook({ state: 'rendering' });
    useProjectStore.setState({
      project: project({
        activeSource: { ...project().activeSource!, kind: 'street_view' },
      }),
    });
    render(<LookAnnouncer />);
    act(() =>
      useProjectStore.setState({
        phase: 'render_error',
        render: renderStatus({
          renderJobId: JOB,
          state: 'failed',
          failureKind: 'source_rejected',
          failureDetail: 'facade_not_in_frame',
        }),
      }),
    );
    expect(region().textContent).toBe(t('wait.noClearView'));
  });

  it("says the line when a look arrives in the photo's own light, the same picture or not", () => {
    anotherLook({ state: 'rendering', lightingMode: 'evening' });
    const onScreen = useProjectStore.getState().variant!;
    render(<LookAnnouncer />);
    act(() => {
      useProjectStore.setState({ pending: null });
      setLightFallback({ renderAssetId: onScreen.renderAssetId, lightingMode: 'evening' });
    });
    expect(region().textContent).toBe(t('result.eveningUnavailable'));
    cleanup();
    setLightFallback(null);

    anotherLook({ state: 'rendering', lightingMode: 'bright' });
    render(<LookAnnouncer />);
    const daylight = variant({
      renderAssetId: '018f0000-0000-7000-8000-000000000998',
      holidayId: 'halloween',
    });
    act(() => {
      useProjectStore.setState({ pending: null, variant: daylight });
      setLightFallback({ renderAssetId: daylight.renderAssetId, lightingMode: 'bright' });
    });
    expect(region().textContent).toBe(
      `${t('result.heading', { holiday: 'Halloween' })} ${t('result.brightUnavailable')}`,
    );
  });

  it('says nothing new when another look is canceled', () => {
    anotherLook({ state: 'rendering' });
    render(<LookAnnouncer />);
    act(() => {
      useProjectStore.setState({ pending: null });
    });
    expect(region().textContent).toBe('');
  });
});

describe('useLongWait', () => {
  it('turns true past the long wait, never for a finished job, and starts again for a new job', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const now = new Date(Date.now()).toISOString();
    const running = renderStatus({
      renderJobId: JOB,
      state: 'rendering',
      timestamps: { ...renderStatus().timestamps, requestedAt: now },
    });
    const { result, rerender } = renderHook(({ status }) => useLongWait(status), {
      initialProps: { status: running as RenderStatus | null },
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(CLIENT_DEFAULTS.longWaitMs - 1);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);

    rerender({ status: { ...running, state: 'succeeded' } });
    expect(result.current).toBe(false);
    rerender({ status: null });
    expect(result.current).toBe(false);

    // A new job (a retry) starts from its own request time, not from the old job's answer.
    rerender({
      status: {
        ...running,
        renderJobId: '018f0000-0000-7000-8000-000000000102',
        timestamps: { ...running.timestamps, requestedAt: new Date(Date.now()).toISOString() },
      },
    });
    expect(result.current).toBe(false);
  });

  it('is false for a terminal status however old', () => {
    const old = renderStatus({ state: 'failed', stageLabelKey: null });
    const { result } = renderHook(() => useLongWait(old));
    expect(result.current).toBe(false);
  });
});
