import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProductCard, ProductsPanel, Project } from '@hailiday/core';
import * as endpoints from '../../api/endpoints';
import { useAppStore } from '../../state/appStore';
import { t } from '../../copy';
import { INITIAL_PROJECT_FLOW, lookOf, useProjectStore } from '../../state/projectStore';
import {
  allowance,
  mockReducedMotion,
  plainSpaces,
  project,
  renderStatus,
  variant,
} from '../../test/fixtures';
import { CLIENT_DEFAULTS, DISPLAY_VALUES } from '../../config/values';
import type { PublicExperience } from '../../experience/payload';
import type * as Controller from './controller';
import { retryLight, retryPendingLook } from './controller';
import { setLightFallback, useLightFallback } from './lookFallback';
import { LOCK_HINT_ID } from './LookProgress';
import { Result } from './Result';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  createClick: vi.fn(async () => undefined),
  createFeedback: vi.fn(async () => undefined),
  deleteProject: vi.fn(async () => undefined),
  getProducts: vi.fn(() => new Promise(() => undefined)),
  listVariants: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock('./controller', async (importOriginal) => ({
  ...(await importOriginal<typeof Controller>()),
  changeSceneType: vi.fn(async () => undefined),
  retryLight: vi.fn(),
  retryPendingLook: vi.fn(),
}));

const api = vi.mocked(endpoints);

function renderFirstResult() {
  const first = variant();
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    phase: 'result',
    project: project(),
    variant: first,
    revealFor: first.renderAssetId,
  });
  return render(
    <MemoryRouter>
      <Result />
    </MemoryRouter>,
  );
}

function renderResult(overrides: Partial<Project> = {}) {
  const shown = variant({ style: 'abundant', lightingMode: 'source' });
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    phase: 'result',
    project: project(overrides),
    variant: shown,
    variants: [shown],
  });
  render(
    <MemoryRouter>
      <Result />
    </MemoryRouter>,
  );
  return shown;
}

function card(n: number): ProductCard {
  return {
    clickToken: `click-${n}`,
    title: `Wreath ${n}`,
    merchantName: 'Shop',
    relationship: 'similar',
    relationshipLabelKey: 'commerce.relationship.similar',
    anchorCategory: 'front_door',
    price: { policy: 'check_at_retailer' },
    linkMode: 'plain',
    sponsored: false,
    href: `https://shop.test/${n}`,
    rankPosition: n,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  setLightFallback(null);
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('the first-result reveal', () => {
  it('holds the rest of the screen back for the reveal', () => {
    mockReducedMotion(false);
    const { container } = renderFirstResult();
    expect(container.querySelector('.result')?.hasAttribute('data-revealing')).toBe(true);
  });

  it('does not hold the screen back once the reveal is over', () => {
    mockReducedMotion(false);
    const { container } = renderFirstResult();
    act(() => useProjectStore.setState({ revealFor: null }));
    expect(container.querySelector('.result')?.hasAttribute('data-revealing')).toBe(false);
  });

  it('shows everything at once under reduced motion', () => {
    mockReducedMotion(true);
    const { container } = renderFirstResult();
    expect(container.querySelector('.result')?.hasAttribute('data-revealing')).toBe(false);
  });

  it('stages the options under the line beneath the picture, which holds the actions', () => {
    mockReducedMotion(false);
    const { container } = renderFirstResult();
    const rail = container.querySelector('.result__rail')!;
    expect(rail.querySelectorAll(':scope > .disclosure')).toHaveLength(4);
    expect(rail.querySelector('.result-actions')).toBeNull();
    expect(rail.querySelector('#result-heading')).toBeNull();
    const head = container.querySelector('.variant__head')!;
    expect(head.querySelector('#result-heading')).not.toBeNull();
    expect(head.querySelector('.result-actions')).not.toBeNull();
  });
});

describe('a minimal result', () => {
  it('fills the first viewport with the picture: the switch on it, the title and actions under it', () => {
    mockReducedMotion(true);
    const { container } = renderFirstResult();
    const stage = container.querySelector<HTMLElement>('.stage.stage--viewport')!;
    expect(stage).not.toBeNull();
    const overlay = stage.querySelector('.stage__overlay')!;
    expect(within(overlay as HTMLElement).getByRole('group', { name: 'Compare before and after' }));
    const head = container.querySelector<HTMLElement>('.picture-head')!;
    expect(within(head).getByRole('heading', { level: 1 })).toBeTruthy();
    expect(within(head).getByRole('group', { name: 'Keep this preview' })).toBeTruthy();
    // The caption line sits between the picture and the title line.
    const caption = container.querySelector('.picture-caption')!;
    expect(stage.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(caption.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the rendering behind the picture as the ambient layer', () => {
    mockReducedMotion(true);
    const { container } = renderFirstResult();
    const ambient = container.querySelector<HTMLImageElement>('.stage__ambient img');
    expect(ambient?.getAttribute('src')).toBe(useProjectStore.getState().variant?.imageUrl);
    expect(ambient?.getAttribute('alt')).toBe('');
    expect(container.querySelector('.stage__ambient')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('opens with every option row collapsed and only the action row showing', () => {
    mockReducedMotion(true);
    renderResult();
    for (const name of [/^Try another look/, /^Shop the look/, 'How does it look?', 'More']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.queryByRole('group', { name: 'Holiday' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Style' })).toBeNull();
    expect(screen.queryByText('Was this preview good?')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace photo' })).toBeNull();
    const actions = screen.getByRole('group', { name: 'Keep this preview' });
    const save = within(actions).getByRole('button', { name: 'Save' });
    expect(save.classList.contains('button--primary')).toBe(true);
    expect(within(actions).getByRole('button', { name: 'Share' }).className).toBe('link-button');
    expect(within(actions).getByRole('link', { name: 'Download' }).className).toBe('link-button');
    expect(within(actions).getByRole('link', { name: 'Gallery' }).getAttribute('href')).toBe(
      '/gallery',
    );
    expect(document.querySelectorAll('.button--primary')).toHaveLength(1);
  });

  it('opens "Try another look" on the controls and the allowance counter', () => {
    mockReducedMotion(true);
    useAppStore.setState({ allowance: allowance(5) });
    renderResult();
    fireEvent.click(screen.getByRole('button', { name: /^Try another look/ }));
    const panel = screen.getByRole('region', { name: 'Try another look' });
    expect(within(panel).getByRole('group', { name: 'Style' })).toBeTruthy();
    expect(within(panel).getByRole('group', { name: 'Lighting' })).toBeTruthy();
    expect(within(panel).getByText('5 more looks today')).toBeTruthy();
  });

  it('summarizes the look on screen, without lighting where only one mode is offered', () => {
    mockReducedMotion(true);
    renderResult({
      sceneType: 'interior',
      offered: {
        styles: ['subtle', 'classic', 'abundant'],
        defaultStyle: 'abundant',
        lightingModes: ['source'],
        defaultLightingMode: 'source',
      },
    });
    const toggle = screen.getByRole('button', { name: /^Try another look/ });
    expect(plainSpaces(toggle.textContent)).toContain('Christmas · Abundant');
    expect(toggle.textContent).not.toContain('As photographed');
    fireEvent.click(toggle);
    expect(screen.queryByRole('group', { name: 'Lighting' })).toBeNull();
  });

  it('keeps feedback, report and the place actions behind their rows', () => {
    mockReducedMotion(true);
    renderResult();
    fireEvent.click(screen.getByRole('button', { name: 'How does it look?' }));
    expect(screen.getByText('Was this preview good?')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Report this image' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const more = screen.getByRole('region', { name: 'More' });
    expect(within(more).getByRole('button', { name: 'Replace photo' })).toBeTruthy();
    expect(within(more).getByRole('button', { name: 'Delete' })).toBeTruthy();
    // Opening one row leaves the other open.
    expect(screen.getByText('Was this preview good?')).toBeTruthy();
  });

  it('asks for Shop the look products only once the row is opened, then counts them', async () => {
    mockReducedMotion(true);
    const panel: ProductsPanel = {
      panelState: 'active',
      linkMode: 'plain',
      disclosure: { copyKeys: ['commerce.disclosure.plain'], programs: [] },
      items: [card(1), card(2)],
    };
    api.getProducts.mockResolvedValue(panel);
    const shown = renderResult();
    expect(api.getProducts).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Shop the look/ }));
    });
    expect(api.getProducts).toHaveBeenCalledWith(shown.renderJobId);
    const region = screen.getByRole('region', { name: 'Shop the look' });
    expect(within(region).getAllByRole('link', { name: /Wreath/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^Shop the look/ }).textContent).toContain('2 items');
  });

  it('keeps an opened Shop the look row with one line when the server hides the panel', async () => {
    mockReducedMotion(true);
    api.getProducts.mockResolvedValue({
      panelState: 'hidden',
      linkMode: null,
      disclosure: { copyKeys: [], programs: [] },
      items: [],
    });
    renderResult();
    const toggle = screen.getByRole('button', { name: /^Shop the look/ });
    toggle.focus();
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByRole('button', { name: /^Shop the look/ })).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    const region = screen.getByRole('region', { name: 'Shop the look' });
    expect(region.textContent).toBe("Matching decorations aren't available for this look yet.");
    expect(within(region).queryByRole('link')).toBeNull();
  });
});

describe('lighting on the result', () => {
  it('summarizes a bright interior look without lighting and offers no lighting choice', () => {
    mockReducedMotion(true);
    const shown = variant({ style: 'abundant', lightingMode: 'bright' });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'result',
      project: project({
        sceneType: 'interior',
        offered: {
          styles: ['subtle', 'classic', 'abundant'],
          defaultStyle: 'abundant',
          lightingModes: ['bright'],
          defaultLightingMode: 'bright',
        },
      }),
      variant: shown,
      variants: [shown],
    });
    render(
      <MemoryRouter>
        <Result />
      </MemoryRouter>,
    );
    const toggle = screen.getByRole('button', { name: /^Try another look/ });
    expect(plainSpaces(toggle.textContent)).toContain('Christmas · Abundant');
    expect(toggle.textContent).not.toContain('Bright');
    fireEvent.click(toggle);
    expect(screen.queryByRole('group', { name: 'Lighting' })).toBeNull();
  });

  it('says why an evening look is shown in daylight, only on that preview, with the light again', () => {
    mockReducedMotion(true);
    const shown = renderResult();
    expect(screen.queryByText(/evening light didn't come out/)).toBeNull();
    act(() => setLightFallback({ renderAssetId: shown.renderAssetId, lightingMode: 'evening' }));
    expect(
      screen.getByText(
        "The evening light didn't come out this time, so here is the look in daylight.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try the evening light again' }));
    expect(vi.mocked(retryLight)).toHaveBeenCalledTimes(1);
    act(() =>
      setLightFallback({
        renderAssetId: '018f0000-0000-7000-8000-eeeeeeeeeeee',
        lightingMode: 'evening',
      }),
    );
    expect(screen.queryByText(/evening light didn't come out/)).toBeNull();
  });

  it('says why a bright look is shown as photographed, and closes the line on Dismiss', () => {
    mockReducedMotion(true);
    const shown = renderResult();
    act(() => setLightFallback({ renderAssetId: shown.renderAssetId, lightingMode: 'bright' }));
    expect(
      screen.getByText(
        "The brighter light didn't come out this time, so here is the look as photographed.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try the brighter light again' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/brighter light didn't come out/)).toBeNull();
    expect(useLightFallback.getState().fallback?.renderAssetId).toBe(shown.renderAssetId);
  });

  it('says calmly under the preview that another look could not be finished, with no sheet', () => {
    mockReducedMotion(true);
    renderResult();
    const failed = renderStatus({ state: 'rejected', rejectionReason: 'qa_critical' });
    act(() => useProjectStore.setState({ pendingError: failed }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByText(
        "We couldn't finish this look. Nothing was counted against your looks today.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/error|didn't work out|happy with/i)).toBeNull();
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    expect(tryAgain.className).toContain('button--primary');
    expect(screen.getByRole('button', { name: 'Use another photo' })).toBeTruthy();
    fireEvent.click(tryAgain);
    expect(vi.mocked(retryPendingLook)).toHaveBeenCalledWith(failed);
  });
});

describe('while another look is being made', () => {
  function renderPending(overrides: Partial<Project> = {}) {
    mockReducedMotion(true);
    useAppStore.setState({ allowance: allowance(5) });
    const shown = variant({ style: 'abundant', lightingMode: 'source' });
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'result',
      project: project(overrides),
      variant: shown,
      variants: [shown],
      pending: {
        look: { holidayId: 'halloween', style: 'classic', lightingMode: 'source' },
        render: null,
      },
    });
    return render(
      <MemoryRouter>
        <Result />
      </MemoryRouter>,
    );
  }

  it('marks the screen as making a look and shows the status card over the title', () => {
    const { container } = renderPending();
    expect(container.querySelector('.result')?.hasAttribute('data-pending')).toBe(true);
    expect(container.querySelector('.picture-head__title > .look-card--band')).not.toBeNull();
    expect(container.querySelector('.stage .light-string')?.getAttribute('data-holiday')).toBe(
      'halloween',
    );
  });

  it('locks every holiday, style and lighting choice and says so in place of the counter', () => {
    renderPending();
    fireEvent.click(screen.getByRole('button', { name: /^Try another look/ }));
    const panel = screen.getByRole('region', { name: 'Try another look' });
    const choices = within(panel)
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('aria-pressed'));
    expect(choices.length).toBeGreaterThan(4);
    for (const choice of choices) {
      expect(choice.getAttribute('aria-disabled'), choice.textContent ?? '').toBe('true');
      expect(choice.getAttribute('aria-describedby')).toBe(LOCK_HINT_ID);
    }
    expect(within(panel).getByText(t('controls.locked'))).toBeTruthy();
    expect(within(panel).queryByText('5 more looks today')).toBeNull();
    const pending = useProjectStore.getState().pending;
    fireEvent.click(within(panel).getByRole('button', { name: 'Subtle' }));
    expect(useProjectStore.getState().pending).toBe(pending);
    expect(useProjectStore.getState().lockedNotice).toBe(1);
    expect(api.listVariants).not.toHaveBeenCalled();
  });

  it('locks Replace photo, Delete and the scene chip, and leaves Save, Share and Gallery', () => {
    renderPending();
    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    for (const name of [t('result.replacePhoto'), t('result.delete'), /^Looks like a/]) {
      const control = screen.getByRole('button', { name });
      expect(control.getAttribute('aria-disabled'), String(name)).toBe('true');
      expect(control.getAttribute('aria-describedby')).toBe(LOCK_HINT_ID);
    }
    fireEvent.click(screen.getByRole('button', { name: /^Looks like a/ }));
    expect(screen.queryByRole('group', { name: /scene/i })).toBeNull();
    expect(useProjectStore.getState().lockedNotice).toBe(1);
    for (const name of [t('result.save'), t('result.share'), t('gallery.title')]) {
      for (const control of screen.queryAllByRole('button', { name })) {
        expect(control.hasAttribute('aria-disabled'), name).toBe(false);
      }
    }
  });

  it('closes an open scene chooser when a look starts', () => {
    mockReducedMotion(true);
    const shown = variant();
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'result',
      project: project(),
      variant: shown,
      variants: [shown],
    });
    render(
      <MemoryRouter>
        <Result />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^More/ }));
    const chip = screen.getByRole('button', { name: /^Looks like a/ });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    act(() =>
      useProjectStore.setState({
        pending: { look: lookOf(shown), render: null },
      }),
    );
    expect(chip.getAttribute('aria-expanded')).toBe('false');
  });

  describe('started from the rows below the picture', () => {
    const page = document.documentElement;
    const scrollIntoView = vi.fn();

    function renderScrolled(top: number, reducedMotion: boolean) {
      mockReducedMotion(reducedMotion);
      const shown = variant();
      useProjectStore.setState({
        ...INITIAL_PROJECT_FLOW,
        phase: 'result',
        project: project(),
        variant: shown,
        variants: [shown],
      });
      const { container } = render(
        <MemoryRouter>
          <Result />
        </MemoryRouter>,
      );
      const root = container.querySelector('.result') as HTMLElement;
      root.getBoundingClientRect = () => ({ top }) as DOMRect;
      page.scrollIntoView = scrollIntoView;
      return shown;
    }

    afterEach(() => {
      scrollIntoView.mockClear();
      Reflect.deleteProperty(page, 'scrollIntoView');
    });

    it('brings the picture back into view when the look starts', () => {
      const shown = renderScrolled(-480, false);
      expect(scrollIntoView).not.toHaveBeenCalled();
      act(() => useProjectStore.setState({ pending: { look: lookOf(shown), render: null } }));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    });

    it('jumps instead of gliding when motion is reduced', () => {
      const shown = renderScrolled(-480, true);
      act(() => useProjectStore.setState({ pending: { look: lookOf(shown), render: null } }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
    });

    it('leaves the page where it is when the top of the picture is in view', () => {
      const shown = renderScrolled(0, false);
      act(() => useProjectStore.setState({ pending: { look: lookOf(shown), render: null } }));
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('does not move the page when the look ends or its status changes', () => {
      const shown = renderScrolled(-480, false);
      act(() => useProjectStore.setState({ pending: { look: lookOf(shown), render: null } }));
      act(() => useProjectStore.setState({ pending: { look: lookOf(shown), render: null } }));
      act(() => useProjectStore.setState({ pending: null }));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });
  });
});

describe('another look that takes longer than usual', () => {
  const LONG_WAIT = /This is taking longer than usual/;

  function makingAnother(saved: boolean) {
    const shown = variant();
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'result',
      project: project({ saved }),
      variant: shown,
      variants: [shown],
      pending: {
        look: { holidayId: 'halloween', style: 'classic', lightingMode: 'source' },
        render: renderStatus({
          holidayId: 'halloween',
          state: 'rendering',
          stageLabelKey: 'stage.rendering',
          timestamps: {
            ...renderStatus().timestamps,
            requestedAt: new Date(Date.now()).toISOString(),
          },
        }),
      },
    });
    render(
      <MemoryRouter>
        <Result />
      </MemoryRouter>,
    );
  }

  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ experience: null });
  });

  it('says so in the status card, and adds nothing under the picture', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    makingAnother(false);
    const rail = document.querySelector('.result__rail')!;
    const railBefore = rail.innerHTML;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLIENT_DEFAULTS.longWaitMs - 1_000);
    });
    expect(screen.queryByText(LONG_WAIT)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const line = screen.getByText(LONG_WAIT);
    expect(line.textContent).toBe(t('wait.longWaitKept'));
    expect(line.closest('.look-card')).not.toBeNull();
    expect(rail.textContent).not.toMatch(LONG_WAIT);
    expect(rail.innerHTML).toBe(railBefore);
  });

  it('names the anonymous retention only for a place not saved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    useAppStore.setState({
      experience: {
        holidays: [],
        examples: [],
        capabilities: { sharing: true },
        clientConfig: { retention: { timeBasedDeletion: true } },
      } as unknown as PublicExperience,
    });
    makingAnother(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLIENT_DEFAULTS.longWaitMs);
    });
    expect(screen.getByText(LONG_WAIT).textContent).toBe(
      t('wait.longWait', { anonymousRetention: DISPLAY_VALUES.anonymousRetention }),
    );
    cleanup();
    makingAnother(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLIENT_DEFAULTS.longWaitMs);
    });
    expect(screen.getByText(LONG_WAIT).textContent).toBe(t('wait.longWaitKept'));
  });
});
