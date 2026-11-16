import { act, cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../copy';
import { CLIENT_DEFAULTS, DISPLAY_VALUES } from '../../config/values';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import { project, renderStatus } from '../../test/fixtures';
import { Waiting } from './Waiting';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  cancelRender: vi.fn(async () => undefined),
  listVariants: vi.fn(() => new Promise(() => undefined)),
}));

/** A viewport `width` px wide, as `matchMedia` answers width queries (and no reduced motion). */
function viewport(width: number): void {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    const min = /min-width:\s*([\d.]+)px/.exec(query);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

function renderWaiting() {
  return render(
    <MemoryRouter>
      <Waiting />
    </MemoryRouter>,
  );
}

beforeEach(() => viewport(1440));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

const LONG_WAIT = /This is taking longer than usual/;

describe('the long-wait line', () => {
  it('waits 190 seconds, past the slowest ordinary first look with a sharpened street photo', async () => {
    expect(CLIENT_DEFAULTS.longWaitMs).toBe(190_000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'waiting',
      project: project(),
      render: renderStatus({
        state: 'rendering',
        timestamps: {
          ...renderStatus().timestamps,
          requestedAt: new Date(Date.now()).toISOString(),
        },
      }),
    });
    render(
      <MemoryRouter>
        <Waiting />
      </MemoryRouter>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(189_000);
    });
    expect(screen.queryByText(LONG_WAIT)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByText(LONG_WAIT)).toBeTruthy();
  });

  it('names the anonymous retention only for a place not saved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    useAppStore.setState({
      experience: {
        holidays: [],
        examples: [],
        clientConfig: { retention: { timeBasedDeletion: true } },
      } as unknown as PublicExperience,
    });
    const start = (saved: boolean) => {
      useProjectStore.setState({
        ...INITIAL_PROJECT_FLOW,
        phase: 'waiting',
        project: project({ saved }),
        render: renderStatus({
          state: 'rendering',
          timestamps: {
            ...renderStatus().timestamps,
            requestedAt: new Date(Date.now()).toISOString(),
          },
        }),
      });
      renderWaiting();
    };
    try {
      start(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLIENT_DEFAULTS.longWaitMs);
      });
      expect(screen.getByText(LONG_WAIT).textContent).toBe(
        t('wait.longWait', { anonymousRetention: DISPLAY_VALUES.anonymousRetention }),
      );
      cleanup();
      start(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLIENT_DEFAULTS.longWaitMs);
      });
      expect(screen.getByText(LONG_WAIT).textContent).toBe(t('wait.longWaitKept'));
    } finally {
      useAppStore.setState({ experience: null });
    }
  });

  it('is not shown at once after "Try again", whose old job asked long ago', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'starting',
      project: project(),
      render: renderStatus({
        state: 'failed',
        stageLabelKey: null,
        timestamps: { ...renderStatus().timestamps, requestedAt: '2026-01-01T00:00:00.000Z' },
      }),
    });
    renderWaiting();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByText(LONG_WAIT)).toBeNull();
  });
});

describe('the waiting screen', () => {
  function waiting(overrides: Parameters<typeof project>[0] = {}) {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'waiting',
      project: project(overrides),
      render: renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' }),
    });
  }

  it('keeps its heading for assistive technology only: the card states the stage', () => {
    waiting();
    const { container } = renderWaiting();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe(t('wait.heading'));
    expect(heading.className).toContain('sr-only');
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(container.querySelector('section.waiting')?.getAttribute('aria-labelledby')).toBe(
      heading.id,
    );
    expect(container.querySelector('.picture-caption__end')).toBeNull();
  });

  it('hangs the card on the stage from 600px, with the notes on the title line', () => {
    waiting();
    const { container } = renderWaiting();
    const card = container.querySelector('.look-card')!;
    expect(card.closest('.stage .stage__top')).not.toBeNull();
    expect(card.classList.contains('look-card--stage')).toBe(true);
    expect(container.querySelector('.stage__top .light-string')).not.toBeNull();
    expect(container.querySelector('.picture-head > .look-notes')).not.toBeNull();
    expect(container.querySelector('.stage-controls')).toBeNull();
    expect(
      within(card as HTMLElement).getByRole('button', { name: t('wait.cancel') }),
    ).toBeTruthy();
  });

  it('puts the card on paper under the caption on phones, Cancel alone under the picture', () => {
    viewport(390);
    waiting();
    const { container } = renderWaiting();
    const card = container.querySelector('.look-card')!;
    expect(card.classList.contains('look-card--paper')).toBe(true);
    expect(card.closest('.stage')).toBeNull();
    expect(card.closest('.picture-head__title')).not.toBeNull();
    const caption = container.querySelector('.picture-caption')!;
    expect(caption.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = container.querySelector('.stage-controls')!;
    expect(row.children).toHaveLength(1);
    expect(row.querySelector('.look-card__cancel')).not.toBeNull();
    expect(
      within(card as HTMLElement).queryByRole('button', { name: t('wait.cancel') }),
    ).toBeNull();
    // The notes follow the card, on their own row.
    expect(card.closest('.picture-head')?.querySelector('.look-notes')).not.toBeNull();
    // The string still hangs on the stage.
    expect(container.querySelector('.stage .light-string')).not.toBeNull();
  });

  it('puts the card on paper, with Cancel, when the place has no picture', () => {
    waiting({ activeSource: null });
    const { container } = renderWaiting();
    expect(container.querySelector('.stage')).toBeNull();
    const card = container.querySelector('.look-card')!;
    expect(card.classList.contains('look-card--paper')).toBe(true);
    expect(
      within(card as HTMLElement).getByRole('button', { name: t('wait.cancel') }),
    ).toBeTruthy();
  });

  it("colours the string with the job's holiday", () => {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'waiting',
      project: project(),
      render: renderStatus({ state: 'rendering', holidayId: 'new_years_eve' }),
    });
    const { container } = renderWaiting();
    expect(container.querySelector('.light-string')?.getAttribute('data-holiday')).toBe(
      'new_years_eve',
    );
  });
});
