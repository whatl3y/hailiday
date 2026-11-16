import { cleanup, render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@hailiday/core';
import { INITIAL_PROJECT_FLOW, lookOf, useProjectStore } from '../../state/projectStore';
import { SOURCE_ASSET_ID, project, renderStatus, variant } from '../../test/fixtures';
import projectSource from './ProjectPage.tsx?raw';
import projectCss from './project.css?raw';
import resultCss from './result.css?raw';
import stageCss from '../../ui/stage.css?raw';
import { projectTone, type ProjectToneInput } from './pageTone';
import { ProjectSourceStage, StreetViewStage } from './SourceImage';
import { STREET_VIEW_WORKING_SIZE, streetViewLayoutSize } from './stageLayout';
import { CancelLook, LookCard } from './LookProgress';
import { VariantCard } from './VariantCard';
import { Waiting } from './Waiting';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  cancelRender: vi.fn(async () => undefined),
  listVariants: vi.fn(() => new Promise(() => undefined)),
}));

const plain = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const source = plain(css);
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = source.indexOf('{', start);
  return source.slice(open + 1, source.indexOf('}', open)).replace(/\s+/g, ' ');
}

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

function streetViewProject(): Project {
  return project({
    activeSource: {
      ...project().activeSource!,
      kind: 'street_view',
      sourceMode: 'persist',
      isGoogleImagery: true,
      displayUrl: 'https://cdn.test/frame.jpg',
      copyright: '© 2026 Google',
      captureDate: '2026-08',
      width: 640,
      height: 640,
    },
  });
}

const candidate = {
  candidateId: 'c1',
  isPrimary: true,
  rank: 1,
  displayUrl: 'https://cdn.test/sv.jpg',
  heading: 0,
  headingMode: 'geometry' as const,
  pitch: 0,
  fov: 80,
  captureDate: null,
  captureGranularity: 'none' as const,
  copyright: '© Google',
  isGoogleImagery: true,
  distanceMeters: 10,
  estimatedFacadePx: null,
  flags: [],
  width: 640,
  height: 640,
};

beforeEach(() => {
  viewport(1440);
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('a Street View frame is laid out at the size its look will have', () => {
  it('uses the working grid when no look of the source exists yet', () => {
    expect(STREET_VIEW_WORKING_SIZE).toEqual({ width: 1024, height: 1024 });
    expect(streetViewLayoutSize([], SOURCE_ASSET_ID)).toEqual({ width: 1024, height: 1024 });
    expect(streetViewLayoutSize([], null)).toEqual({ width: 1024, height: 1024 });
  });

  it("uses the newest look of the same source, and ignores another source's looks", () => {
    const older = variant({ width: 640, height: 640, createdAt: '2026-11-01T00:00:00.000Z' });
    const newer = variant({ width: 1024, height: 1024, createdAt: '2026-11-02T00:00:00.000Z' });
    const other = variant({
      sourceAssetId: '018f0000-0000-7000-8000-cccccccccccc',
      width: 2000,
      height: 1000,
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    expect(streetViewLayoutSize([older, newer, other], SOURCE_ASSET_ID)).toEqual({
      width: 1024,
      height: 1024,
    });
    expect(streetViewLayoutSize([older, other], SOURCE_ASSET_ID)).toEqual({
      width: 640,
      height: 640,
    });
  });

  it('reserves the waiting stage at the working size, not the 640px frame', () => {
    const { container } = render(<ProjectSourceStage project={streetViewProject()} pending />);
    for (const element of [
      container.querySelector<HTMLElement>('.stage')!,
      container.querySelector<HTMLElement>('.picture-screen')!,
    ]) {
      expect(element.style.getPropertyValue('--stage-w')).toBe('1024');
      expect(element.style.getPropertyValue('--stage-h')).toBe('1024');
    }
    // The frame itself is untouched: contained, no ambient layer, its credit under the stage.
    expect(container.querySelector('.stage__ambient')).toBeNull();
    expect(container.querySelector('.stage__image')?.getAttribute('src')).toBe(
      'https://cdn.test/frame.jpg',
    );
    expect(container.querySelector('.picture-caption .attribution')).not.toBeNull();
  });

  it('matches the result stage of the look that replaces it', () => {
    const svProject = streetViewProject();
    const look = variant({ width: 1024, height: 1024 });
    const waiting = render(<ProjectSourceStage project={svProject} pending />);
    const waitingStage = waiting.container.querySelector<HTMLElement>('.stage')!;
    const before = [
      waitingStage.style.getPropertyValue('--stage-w'),
      waitingStage.style.getPropertyValue('--stage-h'),
    ];
    waiting.unmount();
    const result = render(<VariantCard variant={look} project={svProject} />);
    const resultStage = result.container.querySelector<HTMLElement>('.stage')!;
    expect([
      resultStage.style.getPropertyValue('--stage-w'),
      resultStage.style.getPropertyValue('--stage-h'),
    ]).toEqual(before);
  });

  it('follows a look already made from the source while the next one is decorated', () => {
    useProjectStore.setState({ variants: [variant({ width: 640, height: 640 })] });
    const { container } = render(<ProjectSourceStage project={streetViewProject()} pending />);
    expect(
      container.querySelector<HTMLElement>('.stage')!.style.getPropertyValue('--stage-w'),
    ).toBe('640');
  });

  it('lays out the frame to confirm at the working size', () => {
    const { container } = render(<StreetViewStage candidate={candidate} logo="google_maps" />);
    const stage = container.querySelector<HTMLElement>('.stage')!;
    expect(stage.style.getPropertyValue('--stage-w')).toBe('1024');
    expect(container.querySelector('.stage__ambient')).toBeNull();
  });

  it('keeps an upload at its own size', () => {
    const { container } = render(<ProjectSourceStage project={project()} pending />);
    expect(
      container.querySelector<HTMLElement>('.stage')!.style.getPropertyValue('--stage-w'),
    ).toBe('1600');
  });
});

describe('the Before / AI preview switch', () => {
  const look = variant({ beforeImageUrl: 'https://cdn.test/before.jpg' });

  it('rests in the stage’s upper right corner from 600px wide', () => {
    viewport(600);
    const { container } = render(<VariantCard variant={look} project={project()} />);
    const overlay = container.querySelector('.stage .stage__overlay')!;
    expect(within(overlay as HTMLElement).getByRole('button', { name: 'Before' })).toBeTruthy();
    expect(container.querySelector('.stage-controls')).toBeNull();
    expect(container.querySelector('.picture-screen--controls-below')).toBeNull();
  });

  it('sits on the paper directly under the picture on phones, nothing of it on the picture', () => {
    viewport(390);
    const { container, getAllByRole } = render(<VariantCard variant={look} project={project()} />);
    const stage = container.querySelector('.stage')!;
    expect(stage.classList.contains('stage--overlay')).toBe(false);
    expect(stage.querySelector('.stage__overlay')).toBeNull();
    expect(stage.querySelector('.segmented')).toBeNull();
    const controls = container.querySelector('.stage-controls')!;
    // First thing under the picture, before the caption line.
    expect(controls.previousElementSibling).toBe(stage);
    expect(controls.nextElementSibling?.classList.contains('picture-caption')).toBe(true);
    expect(getAllByRole('button', { name: 'Before' })).toHaveLength(1);
    expect(
      within(controls as HTMLElement).getByRole('button', { name: 'AI preview' }),
    ).toBeTruthy();
    expect(container.querySelector('.picture-screen--controls-below')).not.toBeNull();
  });

  it('holds the switch alone in that row on phones, and the look in the caption line from 600px', () => {
    viewport(390);
    const phone = render(<VariantCard variant={look} project={project()} />);
    const row = phone.container.querySelector('.stage-controls')!;
    // The title names the holiday and "Try another look" names the look, so the row needs no label.
    expect(row.children).toHaveLength(1);
    expect(row.firstElementChild?.classList.contains('segmented')).toBe(true);
    expect(phone.container.querySelector('.variant__label')).toBeNull();
    phone.unmount();

    viewport(1024);
    const wide = render(<VariantCard variant={look} project={project()} />);
    expect(wide.container.querySelector('.picture-caption .variant__label')).not.toBeNull();
    expect(wide.container.querySelector('.stage-controls')).toBeNull();
  });

  it('keeps the row on phones for a look without a before picture, so nothing moves', () => {
    viewport(390);
    const { container } = render(
      <VariantCard
        variant={variant({ beforeImageUrl: null })}
        project={project({ activeSource: null })}
      />,
    );
    expect(container.querySelector('.stage-controls')).not.toBeNull();
    expect(container.querySelector('.segmented')).toBeNull();
  });

  it('holds Cancel on the waiting screen on phones, where the switch will be', () => {
    useProjectStore.setState({
      phase: 'waiting',
      project: project(),
      render: renderStatus({ state: 'rendering' }),
    });
    viewport(390);
    const phone = render(
      <MemoryRouter>
        <Waiting />
      </MemoryRouter>,
    );
    const row = phone.container.querySelector('.stage-controls')!;
    expect(within(row as HTMLElement).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    // Cancel alone: the status card under it says what is happening.
    expect(row.children).toHaveLength(1);
    expect(phone.container.querySelector('.picture-caption__end')).toBeNull();
    expect(phone.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
    expect(phone.container.querySelector('.picture-screen--controls-below')).not.toBeNull();
    phone.unmount();

    viewport(1440);
    const wide = render(
      <MemoryRouter>
        <Waiting />
      </MemoryRouter>,
    );
    expect(wide.container.querySelector('.stage-controls')).toBeNull();
    const card = wide.container.querySelector('.stage .look-card')!;
    expect(within(card as HTMLElement).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(wide.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1);
  });

  it('puts Cancel at the start of the switch row on phones while another look is made', () => {
    const shown = variant();
    useProjectStore.setState({
      phase: 'result',
      project: project(),
      variant: shown,
      pending: { look: { ...lookOf(shown), holidayId: 'halloween' }, render: null },
    });
    viewport(390);
    const phone = render(
      <VariantCard
        variant={shown}
        project={project()}
        pending
        controlsStart={<CancelLook />}
        bar={<LookCard placement="band" cancel={false} />}
      />,
    );
    const row = phone.container.querySelector('.stage-controls')!;
    expect(row.children).toHaveLength(2);
    expect(row.firstElementChild?.className).toBe('stage-controls__start');
    expect(
      within(row.firstElementChild as HTMLElement).getByRole('button', { name: 'Cancel' }),
    ).toBeTruthy();
    expect(row.lastElementChild?.classList.contains('segmented')).toBe(true);
    expect(rule(stageCss, '.stage-controls > .stage-controls__start')).toContain(
      'margin-inline: 0 auto;',
    );
    phone.unmount();

    viewport(1440);
    const wide = render(
      <VariantCard
        variant={shown}
        project={project()}
        pending
        stageCard={<LookCard placement="stage" />}
      />,
    );
    expect(wide.container.querySelector('.stage-controls')).toBeNull();
    expect(wide.container.querySelector('.stage .stage__top .look-card--stage')).not.toBeNull();
    expect(wide.container.querySelector('.stage .stage__overlay .segmented')).not.toBeNull();
  });

  it('keeps the row as tall as the switch, whatever it holds', () => {
    expect(rule(stageCss, '.stage-controls')).toContain(
      'min-block-size: calc(var(--space-2) + var(--target-comfort) + 8px);',
    );
    expect(rule(stageCss, '.stage-controls')).toContain('justify-content: flex-end;');
    expect(stageCss).not.toContain('.stage-controls__label');
  });

  it('keeps room on phones for the switch under a tall picture', () => {
    expect(plain(projectCss)).toMatch(
      /\.project \.picture-screen--controls-below \{\s*--stage-peek: 220px;\s*\}/,
    );
  });
});

describe('the header over the project screens', () => {
  const base: ProjectToneInput = {
    phase: 'result',
    uploadSurface: 'photo',
    hasVariant: true,
    hasSourcePicture: true,
    hasCandidate: false,
  };

  it('is the ink band over every screen whose picture sits on a stage', () => {
    expect(projectTone(base)).toBe('stage');
    expect(projectTone({ ...base, phase: 'render_error' })).toBe('stage');
    expect(projectTone({ ...base, phase: 'render_error', hasVariant: false })).toBe('stage');
    expect(projectTone({ ...base, phase: 'waiting', hasVariant: false })).toBe('stage');
    expect(projectTone({ ...base, phase: 'starting', hasVariant: false })).toBe('stage');
    expect(projectTone({ ...base, phase: 'confirm', hasCandidate: true })).toBe('stage');
    expect(projectTone({ ...base, phase: 'upload', uploadSurface: 'stage' })).toBe('stage');
  });

  it('lies over the holiday photograph, and is paper where no picture is shown', () => {
    expect(projectTone({ ...base, phase: 'nosv' })).toBe('photo');
    expect(projectTone({ ...base, phase: 'upload' })).toBe('photo');
    expect(projectTone({ ...base, phase: 'confirm', hasCandidate: false })).toBe('paper');
    expect(
      projectTone({ ...base, phase: 'waiting', hasVariant: false, hasSourcePicture: false }),
    ).toBe('paper');
    for (const phase of ['loading', 'finding', 'not_found', 'error'] as const) {
      expect(projectTone({ ...base, phase })).toBe('paper');
    }
  });

  it('is what the project page passes to the page shell', () => {
    expect(projectSource).toContain(
      'tone={projectTone({ phase, uploadSurface, hasVariant, hasSourcePicture, hasCandidate })}',
    );
  });
});

describe('targets under the picture', () => {
  it('keeps every quiet action at least 44px wide and tall (Share, Delete)', () => {
    const links = rule(
      resultCss,
      '.result-actions__row .link-button,\n.result-more__links .link-button,\n.result__feedback .disclosure__panel .link-button',
    );
    expect(links).toContain('min-width: var(--target-comfort);');
    expect(links).toContain('min-height: var(--target-comfort);');
  });
});
