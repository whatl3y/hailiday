import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import { mockReducedMotion, project, variant } from '../../test/fixtures';
import disclosureCss from '../../ui/disclosure.css?raw';
import lightStringCss from '../../ui/light-string.css?raw';
import shopCss from '../shop/shop.css?raw';
import peopleSheetSource from '../upload/PeopleSheet.tsx?raw';
import uploadCss from '../upload/upload.css?raw';
import { DeleteSheet } from './DeleteSheet';
import lookProgressCss from './look-progress.css?raw';
import projectCss from './project.css?raw';
import resultCss from './result.css?raw';
import { ProjectSourceStage, StreetViewStage } from './SourceImage';
import { VariantCard } from './VariantCard';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

const STYLESHEETS = {
  'project.css': projectCss,
  'result.css': resultCss,
  'upload.css': uploadCss,
  'shop.css': shopCss,
  'disclosure.css': disclosureCss,
  'look-progress.css': lookProgressCss,
  'light-string.css': lightStringCss,
};

const plain = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

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

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const source = plain(css);
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = source.indexOf('{', start);
  return source.slice(open + 1, source.indexOf('}', open));
}

describe('the project, upload and shop stylesheets', () => {
  it.each(Object.entries(STYLESHEETS))('%s sets no serif face and no italics', (_name, css) => {
    expect(plain(css)).not.toMatch(/var\(--font-display\)/);
    expect(plain(css)).not.toMatch(/font-style:\s*italic/);
    expect(plain(css)).not.toMatch(/(?<!sans-)serif/);
  });

  it.each(Object.entries(STYLESHEETS))(
    '%s writes weights and type sizes with the tokens',
    (_name, css) => {
      expect(plain(css)).not.toMatch(/font-weight:\s*\d/);
    },
  );

  it.each(Object.entries(STYLESHEETS))(
    '%s uses no tinted fill, no light glass and no warm color: photos carry the color',
    (_name, css) => {
      const source = plain(css);
      expect(source).not.toMatch(/var\(--accent-soft\)|var\(--accent-glow\)|var\(--glass\)/);
      for (const [, r, g, b] of source.matchAll(/rgb\((\d+) (\d+) (\d+)/g)) {
        const channels = [Number(r), Number(g), Number(b)];
        expect(Math.max(...channels) - Math.min(...channels), `rgb(${r} ${g} ${b})`).toBeLessThan(
          3,
        );
      }
      expect(source).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    },
  );

  it('keeps no sticky side rail on the project screens', () => {
    for (const css of Object.values(STYLESHEETS)) {
      expect(plain(css)).not.toMatch(/position:\s*sticky/);
    }
  });

  it('lines the paper under a stage up with the picture, never narrower than its title line', () => {
    const screen = rule(projectCss, '.picture-screen');
    expect(screen).toMatch(/--below-column: max\(55rem, var\(--stage-picture-inline\)\)/);
    const column = rule(
      projectCss,
      '.picture-caption,\n.picture-head,\n.picture-screen > .result__rail',
    );
    expect(column).toMatch(
      /width: min\(100% - 2 \* var\(--below-gutter\), var\(--below-column\)\)/,
    );
    expect(column).toMatch(/margin-inline: auto/);
  });

  it('keeps room on phones under a tall picture for the caption, the title and the actions', () => {
    const source = plain(projectCss);
    const start = source.indexOf('@media (max-width: 599px) {');
    expect(source.slice(start, source.indexOf('}', start))).toMatch(
      /\.project \.picture-screen \{\s*--stage-peek: 144px;/,
    );
  });

  it('draws the result options as hairline rows with a quiet summary and a padded panel', () => {
    expect(rule(disclosureCss, '.disclosure')).toMatch(/border-top: 1px solid var\(--line\)/);
    const label = rule(disclosureCss, '.disclosure__label');
    expect(label).toMatch(/font-size: var\(--text-m\)/);
    expect(label).toMatch(/font-weight: var\(--weight-semibold\)/);
    expect(label).toMatch(/letter-spacing: var\(--tracking-item\)/);
    const summary = rule(disclosureCss, '.disclosure__summary');
    expect(summary).toMatch(/font-size: var\(--text-s\)/);
    expect(summary).toMatch(/color: var\(--ink-muted\)/);
    expect(rule(disclosureCss, '.disclosure__panel')).toMatch(
      /padding: var\(--space-4\) 0 var\(--space-5\)/,
    );
    expect(rule(resultCss, '.result__rail > .disclosure + .disclosure')).toMatch(
      /margin-top: calc\(-1 \* var\(--space-4\)\)/,
    );
    expect(rule(resultCss, '.result__more')).toMatch(/border-bottom: 1px solid var\(--line\)/);
  });

  it('sets the shop cards in one framed grid with hairlines between them', () => {
    const grid = rule(shopCss, '.shop__cards');
    expect(grid).toMatch(/border: 1px solid var\(--line\)/);
    expect(grid).toMatch(/border-radius: var\(--radius-l\)/);
    expect(rule(shopCss, '.product')).not.toMatch(/box-shadow/);
    expect(rule(shopCss, '.product__link')).not.toMatch(/border:|box-shadow|transform/);
  });

  it('draws the shop card hairlines with the base stylesheet alone', () => {
    const style = document.createElement('style');
    style.textContent = [tokensCss, globalCss.replace(/^@import [^;]+;$/gm, ''), shopCss].join(
      '\n',
    );
    document.head.append(style);
    try {
      document.body.innerHTML =
        '<ul class="shop__cards"><li class="product"><a class="product__link">Wreath</a></li></ul>';
      const card = getComputedStyle(document.querySelector('.product')!);
      expect(card.boxShadow).toBe('none');
      expect(card.position).toBe('relative');
      expect(card.display).toBe('flex');
    } finally {
      style.remove();
      document.body.innerHTML = '';
    }
  });

  it('shows the allowance as a status dot, green while looks remain', () => {
    expect(rule(resultCss, '.allowance-counter__dot')).toMatch(/background: var\(--dot-success\)/);
    expect(rule(resultCss, '.allowance-counter')).toMatch(/color: var\(--ink-muted\)/);
  });

  it('draws the choices beside the one solid action as text links', () => {
    const link = rule(projectCss, '.project__actions .button:not(.button--primary)');
    expect(link).toMatch(/--button-border: transparent/);
    expect(link).toMatch(/text-decoration: underline/);
  });
});

describe('the stage under each project picture', () => {
  beforeEach(() => mockReducedMotion(false));
  afterEach(cleanup);

  function stageOf(container: HTMLElement): HTMLElement {
    const stage = container.querySelector<HTMLElement>('.stage');
    if (!stage) throw new Error('stage missing');
    return stage;
  }

  it("is reserved from the result picture's natural size, as is the column under it", () => {
    const { container } = render(
      <VariantCard variant={variant({ width: 1200, height: 1600 })} project={project()} />,
    );
    const stage = stageOf(container);
    expect(stage.classList.contains('stage--viewport')).toBe(true);
    expect(stage.style.getPropertyValue('--stage-w')).toBe('1200');
    expect(stage.style.getPropertyValue('--stage-h')).toBe('1600');
    const scope = container.querySelector<HTMLElement>('.picture-screen.stage-scope')!;
    expect(scope.style.getPropertyValue('--stage-w')).toBe('1200');
    expect(scope.style.getPropertyValue('--stage-h')).toBe('1600');
  });

  it('shows an uploaded photo over its own blurred ambient layer', () => {
    const { container } = render(<ProjectSourceStage project={project()} />);
    const stage = stageOf(container);
    expect(stage.style.getPropertyValue('--stage-w')).toBe('1600');
    expect(stage.style.getPropertyValue('--stage-h')).toBe('1200');
    expect(container.querySelector('.stage__ambient img')?.getAttribute('src')).toBe(
      project().activeSource?.displayUrl,
    );
    expect(container.querySelector('.picture-caption')?.textContent).toBe('Your photo');
  });

  it('shows a raw Street View frame as it is: no ambient layer, attribution beneath it', () => {
    const svProject = project({
      activeSource: {
        ...project().activeSource!,
        kind: 'street_view',
        width: 640,
        height: 640,
        copyright: '© 2026 Google',
        captureDate: '2026-08',
      },
    });
    const { container, rerender } = render(<ProjectSourceStage project={svProject} />);
    expect(container.querySelector('.stage__ambient')).toBeNull();
    expect(container.querySelector('.stage .attribution')).toBeNull();
    expect(container.querySelector('.picture-caption .attribution')).not.toBeNull();

    rerender(
      <StreetViewStage
        candidate={{
          candidateId: 'c1',
          isPrimary: true,
          rank: 1,
          displayUrl: 'https://cdn.test/sv.jpg',
          heading: 0,
          headingMode: 'geometry',
          pitch: 0,
          fov: 80,
          captureDate: null,
          captureGranularity: 'none',
          copyright: '© Google',
          isGoogleImagery: true,
          distanceMeters: 10,
          estimatedFacadePx: null,
          flags: [],
          width: 640,
          height: 640,
        }}
        logo="google_maps"
        loading
      />,
    );
    // The 640px frame is laid out at the size of the look it will become (the working grid).
    const stage = stageOf(container);
    expect(stage.style.getPropertyValue('--stage-w')).toBe('1024');
    expect(stage.style.getPropertyValue('--stage-h')).toBe('1024');
    expect(container.querySelector('.stage__ambient')).toBeNull();
    // A loading view is named at the frame's top edge, clear of the burned-in marks.
    expect(rule(projectCss, '.stage-loading')).toMatch(/inset-block-start: var\(--space-3\)/);
    expect(rule(projectCss, '.stage-loading')).not.toMatch(/bottom|inset-block-end/);
  });

  it('marks a picture being decorated with a sheen and the light string along its top edge', () => {
    const { container } = render(<ProjectSourceStage project={project()} pending />);
    expect(container.querySelector('.stage__picture > .stage__sheen')).not.toBeNull();
    expect(container.querySelector('.stage .stage__top .light-string')).not.toBeNull();
    expect(container.querySelector('.stage__progress')).toBeNull();
  });

  it('hangs the marks at the top edge below the string while a look is being made', () => {
    const plainResult = plain(resultCss);
    expect(plainResult).toMatch(
      /\.picture-screen\[data-pending\] \.image-card__corner--upper-left \{\s*top: var\(--string-clear\);\s*\}/,
    );
    expect(plain(projectCss)).toMatch(
      /\.picture-screen\[data-pending\] \.stage:not\(\.stage--overlay\) \.stage__picture \.image-card__badges \{\s*inset-block-start: var\(--string-clear\);\s*\}/,
    );
    expect(rule(resultCss, '.compare__after .image-card__corner--upper-left')).toMatch(
      /top var\(--dur-med\) var\(--ease-out\)/,
    );
  });

  it.each([
    // width, clear, card top, with the switch on the stage
    [390, 36, 40, false],
    [1440, 44, 50, false],
    [768, 40, 44, false],
    [768, 40, 84, true],
    [1440, 44, 50, true],
  ])(
    'at %ipx sets the string clear band (%ipx) and the card top (%ipx) on a pending screen',
    (width, clear, cardTop, withSwitch) => {
      viewport(width);
      const { container } = render(
        withSwitch ? (
          <VariantCard variant={variant()} project={project()} pending />
        ) : (
          <ProjectSourceStage project={project()} pending />
        ),
      );
      const screen = container.querySelector<HTMLElement>('.picture-screen')!;
      expect(screen.hasAttribute('data-pending')).toBe(true);
      expect(screen.style.getPropertyValue('--string-clear')).toBe(`${clear}px`);
      expect(screen.style.getPropertyValue('--card-top')).toBe(`${cardTop}px`);
    },
  );

  /** The lower edge of the AI preview mark hung below a string `clear` px deep, from the styles. */
  function aiMarkLowerEdge(clear: number): number {
    expect(
      rule(resultCss, '.picture-screen[data-pending] .image-card__corner--upper-left'),
    ).toMatch(/top: var\(--string-clear\);/);
    const badge = rule(globalCss, '.badge');
    const [, padBlock] = /padding: (\d+)px \d+px;/.exec(badge)!;
    const [, lineHeight] = /line-height: ([\d.]+);/.exec(badge)!;
    const [, labelRem] = /--text-label: ([\d.]+)rem;/.exec(tokensCss)!;
    return clear + 2 * Number(padBlock) + Number(labelRem) * 16 * Number(lineHeight);
  }

  it.each([
    // width, height, clear
    [1440, 900, 44],
    [1280, 720, 44],
    [1024, 768, 44],
    [768, 1024, 40],
    [600, 560, 40],
  ])(
    'at %ix%i hangs the card below the AI preview mark of a Street View look',
    (width, _height, clear) => {
      viewport(width);
      const streetView = variant({
        attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
      });
      const { container } = render(
        <VariantCard
          variant={streetView}
          project={project()}
          pending
          stageCard={<div className="look-card look-card--stage" />}
        />,
      );
      const screen = container.querySelector<HTMLElement>('.picture-screen')!;
      expect(screen.style.getPropertyValue('--string-clear')).toBe(`${clear}px`);
      const cardTop = parseFloat(screen.style.getPropertyValue('--card-top'));
      expect(cardTop).toBe(84);
      expect(cardTop).toBeGreaterThan(aiMarkLowerEdge(clear) + 8);
    },
  );

  it('keeps the card at the string on phones, where it never hangs on the stage', () => {
    viewport(390);
    const streetView = variant({
      attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
    });
    const { container } = render(<VariantCard variant={streetView} project={project()} pending />);
    const screen = container.querySelector<HTMLElement>('.picture-screen')!;
    expect(screen.style.getPropertyValue('--card-top')).toBe('40px');
  });

  it('sets no string values on a screen that is not making a look', () => {
    viewport(1440);
    const { container } = render(<ProjectSourceStage project={project()} />);
    const screen = container.querySelector<HTMLElement>('.picture-screen')!;
    expect(screen.hasAttribute('data-pending')).toBe(false);
    expect(screen.style.getPropertyValue('--string-clear')).toBe('');
    expect(screen.style.getPropertyValue('--card-top')).toBe('');
    expect(container.querySelector('.light-string')).toBeNull();
  });
});

describe('secondary actions in sheets', () => {
  afterEach(cleanup);

  it('draws Cancel beside Delete as a text link', () => {
    const { getByRole } = render(
      <MemoryRouter>
        <DeleteSheet projectId="018f0000-0000-7000-8000-aaaaaaaaaaaa" onClose={() => undefined} />
      </MemoryRouter>,
    );
    expect(getByRole('button', { name: 'Cancel' }).className).toBe('button button--quiet');
  });

  it('draws every people-prompt choice but the solid one as a text link', () => {
    const buttons = [...peopleSheetSource.matchAll(/className="(button[^"]*)"/g)].map(
      (match) => match[1],
    );
    expect(buttons.length).toBeGreaterThan(3);
    for (const name of buttons) expect(name).toMatch(/button--(primary|quiet)/);
  });
});

describe('the examples sheet', () => {
  it('stacks every card caption over its comparison toggle, however long the caption', () => {
    const strip = rule(globalCss, '.example-card .image-card__strip');
    expect(strip).toMatch(/flex-direction: column;/);
    expect(strip).toMatch(/align-items: flex-start;/);
    expect(strip).toMatch(/gap: var\(--space-2\);/);
  });
});
