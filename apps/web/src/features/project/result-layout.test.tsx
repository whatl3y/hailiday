import { cleanup, render } from '@testing-library/react';
import { HOLIDAY_IDS } from '@hailiday/core';
import { holidayName } from '../../copy';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import { mockReducedMotion, project, variant } from '../../test/fixtures';
import disclosureCss from '../../ui/disclosure.css?raw';
import { SelectedLookLabel } from './LookControls';
import { splitLeadingHoliday } from './lookSummary';
import lookProgressCss from './look-progress.css?raw';
import lookProgressSource from './LookProgress.tsx?raw';
import { LookCard } from './LookProgress';
import projectCss from './project.css?raw';
import resultCss from './result.css?raw';
import { VariantCard } from './VariantCard';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

const plain = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first `@media` block with this exact condition. */
function media(css: string, condition: string): string {
  const source = plain(css);
  const start = source.indexOf(`@media ${condition} {`);
  if (start < 0) throw new Error(`no @media ${condition}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(source.indexOf('{', start) + 1, index);
  }
  throw new Error('unclosed @media');
}

/** The bodies of every `@media` block with this exact condition, in order. */
function mediaBlocks(css: string, condition: string): string[] {
  const source = plain(css);
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(`@media ${condition} {`, from);
    if (start < 0) return blocks;
    const open = source.indexOf('{', start);
    let depth = 0;
    let index = open;
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) break;
    }
    blocks.push(source.slice(open + 1, index));
    from = index;
  }
}

/** The rules of a stylesheet's `(max-width: …)` blocks that apply at a viewport `width` px wide. */
function narrowRules(css: string, width: number): string {
  const limits = new Set(
    [...plain(css).matchAll(/@media \(max-width: (\d+)px\) \{/g)].map((match) => Number(match[1])),
  );
  return [...limits]
    .filter((limit) => width <= limit)
    .sort((a, b) => b - a)
    .flatMap((limit) => mediaBlocks(css, `(max-width: ${limit}px)`))
    .join('\n');
}

/** A token's number from the token file (`--name: 1.6;`, `0.8125rem` or `12px`), in px for lengths. */
function token(name: string): number {
  const match = new RegExp(`${name}: ([\\d.]+)(rem|px)?;`).exec(tokensCss)!;
  return Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
}

/*
 * The base, disclosure and result stylesheets in the document, so computed styles follow the
 * real cascade (specificity, order and custom properties) as a browser resolves them.
 */
const style = document.createElement('style');

beforeAll(() => {
  style.textContent = [
    tokensCss,
    globalCss.replace(/^@import [^;]+;$/gm, ''),
    disclosureCss,
    projectCss,
    resultCss,
    lookProgressCss,
  ].join('\n');
  document.head.append(style);
});

afterAll(() => style.remove());

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('the result rail', () => {
  it('shares the column under the picture with the caption and the title line', () => {
    const shared = [
      ...plain(projectCss).matchAll(
        /\n\.picture-caption,\n\.picture-head,\n\.picture-screen > \.result__rail \{([^}]*)\}/g,
      ),
    ];
    expect(shared).toHaveLength(1);
    expect(shared[0]![1]!.replace(/\s+/g, ' ')).toContain(
      'width: min(100% - 2 * var(--below-gutter), var(--below-column));',
    );
  });

  it('keeps running text at the readable measure inside that wider rail', () => {
    const body = mount(
      '<div class="result__rail"><p>Text</p><div class="feedback"></div><div class="invite"></div></div>',
    );
    for (const selector of ['p', '.feedback', '.invite']) {
      expect(getComputedStyle(body.querySelector(selector)!).maxWidth, selector).toBe('760px');
    }
  });

  it('stacks the option rows under shared hairlines, without the rail gap between them', () => {
    const body = mount(
      '<div class="result__rail"><div class="disclosure" id="a"></div><div class="disclosure" id="b"></div></div>',
    );
    expect(getComputedStyle(body.querySelector('#a')!).marginTop).toBe('0px');
    expect(getComputedStyle(body.querySelector('#b')!).marginTop).toBe('-16px');
  });

  it('pads an open panel 16px above and 24px below', () => {
    const body = mount('<div class="disclosure__panel"></div>');
    const panel = getComputedStyle(body.querySelector('.disclosure__panel')!);
    expect(panel.paddingTop).toBe('16px');
    expect(panel.paddingBottom).toBe('24px');
  });
});

describe('the quiet actions under the picture', () => {
  it.each([
    [
      'the action row',
      '<div class="result-actions__row"><button class="link-button">Share</button></div>',
    ],
    [
      'the More row',
      '<div class="result-more__links"><button class="link-button">Delete</button></div>',
    ],
    [
      'the feedback panel',
      '<div class="result__feedback"><div class="disclosure__panel"><button class="link-button">Report this image</button></div></div>',
    ],
  ])('keep a 44px touch target in %s', (_where, html) => {
    const body = mount(html);
    expect(getComputedStyle(body.querySelector('.link-button')!).minHeight).toBe('44px');
  });
});

describe('the look summary on narrow screens', () => {
  it('splits the holiday from the rest of the label', () => {
    expect(splitLeadingHoliday('Christmas · Abundant · Evening', 'Christmas')).toEqual({
      lead: 'Christmas · ',
      rest: 'Abundant · Evening',
    });
    // The label keeps a holiday of several words unbroken.
    expect(splitLeadingHoliday("New Year's Eve · Classic", "New Year's Eve")).toEqual({
      lead: "New Year's Eve · ",
      rest: 'Classic',
    });
    expect(splitLeadingHoliday('Halloween · Classic', 'Christmas')).toBeNull();
    expect(splitLeadingHoliday('Christmas', 'Christmas')).toBeNull();
  });

  it('puts the holiday in a span of its own, so the label still reads in full', () => {
    const shown = variant({ holidayId: 'new_years_eve', style: 'classic', lightingMode: 'source' });
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: project(), variant: shown });
    const { container } = render(<SelectedLookLabel />);
    const holiday = container.querySelector('.look-summary__holiday');
    expect(holiday?.textContent?.replace(/\s/g, ' ')).toBe("New Year's Eve · ");
    expect(container.textContent?.replace(/\s/g, ' ')).toMatch(/^New Year's Eve · Classic/);
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
  });

  it('hides that span and tightens the row below 420px, where the title names the holiday', () => {
    expect(media(resultCss, '(max-width: 419px)')).toMatch(
      /\.look-summary__holiday \{\s*display: none;\s*\}/,
    );
    // While another look is made the band covers the title, so the summary keeps the holiday.
    expect(media(resultCss, '(max-width: 419px)')).toMatch(
      /\.result\[data-pending\] \.look-summary__holiday \{\s*display: inline;\s*\}/,
    );
    const narrow = media(disclosureCss, '(max-width: 419px)');
    expect(narrow).toMatch(/\.disclosure__toggle \{\s*gap: var\(--space-2\);\s*\}/);
    // A summary still too long for the line wraps after a separator instead of being cut.
    expect(narrow).toMatch(/\.disclosure__summary \{\s*white-space: normal;\s*\}/);
  });
});

describe('the lock line in "Try another look"', () => {
  it('keeps the rows under the panel where they are when it replaces the counter', () => {
    const body = mount(
      '<div class="look-controls"><p class="allowance-counter" id="counter"><span class="allowance-counter__dot"></span>5 more looks today</p><p class="look-controls__locked" id="locked">You can pick another look when this one is ready.</p></div>',
    );
    const counter = getComputedStyle(body.querySelector('#counter')!);
    const locked = getComputedStyle(body.querySelector('#locked')!);
    expect(locked.lineHeight).toBe(counter.lineHeight);
    expect(locked.fontSize).toBe(counter.fontSize);
    expect(locked.display).toBe(counter.display);
    expect(getComputedStyle(body.querySelector('#locked')!, '::before').width).toBe('7px');
  });
});

describe('the status card over the title', () => {
  beforeEach(() => mockReducedMotion(false));

  function renderPending() {
    const shown = variant();
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      phase: 'result',
      project: project(),
      variant: shown,
      pending: {
        look: { holidayId: 'halloween', style: 'classic', lightingMode: 'source' },
        render: null,
      },
    });
    const view = render(
      <VariantCard
        variant={shown}
        project={project()}
        pending
        heading={<h1 className="result__heading">Christmas</h1>}
        bar={<LookCard placement="band" />}
        actions={<div className="actions">Save</div>}
      />,
    );
    return view.container;
  }

  afterEach(() => useProjectStore.setState({ ...INITIAL_PROJECT_FLOW }));

  it('lies over the title under the picture, so the picture and the actions never move', () => {
    const container = renderPending();
    const title = container.querySelector<HTMLElement>('.picture-head__title')!;
    const band = title.querySelector<HTMLElement>(':scope > .pending-band')!;
    expect(band).not.toBeNull();
    expect(getComputedStyle(title).position).toBe('relative');
    expect(getComputedStyle(title).minHeight).toBe('44px');
    const placed = getComputedStyle(band);
    expect(placed.position).toBe('absolute');
    expect(placed.top).toBe('0px');
    expect(placed.left).toBe('0px');
    expect(placed.right).toBe('0px');
    expect(placed.bottom).toBe('0px');
    expect(placed.backgroundColor).toBe('rgb(255, 255, 255)');
    // The actions stay where they are, outside the band.
    expect(container.querySelector('.picture-head > .actions')).not.toBeNull();
  });

  it('hides the title it covers but keeps it in the outline', () => {
    const container = renderPending();
    const title = container.querySelector<HTMLElement>('.picture-head__title > h1')!;
    expect(getComputedStyle(title).visibility).toBe('visible');
    expect(getComputedStyle(title).opacity).toBe('0');
    expect(getComputedStyle(container.querySelector('.pending-band')!).visibility).toBe('visible');
  });

  it('leaves the progress to the stage: a sheen on the picture and the light string', () => {
    const container = renderPending();
    expect(container.querySelector('.pending-band .indeterminate')).toBeNull();
    expect(container.querySelector('.stage__sheen')).not.toBeNull();
    expect(container.querySelector('.stage .light-string')).not.toBeNull();
    expect(container.querySelector('.stage__progress')).toBeNull();
  });

  it('draws Cancel as a text link at the end of the band, across both lines', () => {
    const container = renderPending();
    const cancel = container.querySelector<HTMLElement>('.pending-band .button')!;
    expect(cancel.className).toBe('button button--small button--quiet look-card__cancel');
    expect(getComputedStyle(cancel).minHeight).toBe('44px');
    expect(getComputedStyle(cancel).gridRow).toBe('1 / span 2');
    const band = getComputedStyle(container.querySelector('.pending-band')!);
    expect(band.display).toBe('grid');
  });
});

describe('the waiting screen', () => {
  it("draws Cancel as a text link whose word lines up with the column's end", () => {
    expect(lookProgressSource).toContain(
      'className="button button--small button--quiet look-card__cancel"',
    );
    const body = mount(
      '<button class="button button--small button--quiet look-card__cancel">Cancel</button>',
    );
    const cancel = getComputedStyle(body.querySelector('.look-card__cancel')!);
    expect(cancel.minHeight).toBe('44px');
    expect(cancel.paddingRight).toBe('16px');
    expect(cancel.marginRight).toBe('-16px');
  });

  it('keeps room on phones for a trail on two lines, so a trail that wraps moves nothing', () => {
    const trail = plain(lookProgressCss).match(/\n\.stage-trail \{([^}]*)\}/)![1]!;
    const lineHeight = Number(trail.match(/line-height: ([\d.]+);/)![1]);
    const rowGap = trail.match(/gap: (\d+px) /)![1];
    const phone = media(lookProgressCss, '(max-width: 599px)');
    const paper = phone.match(/\.look-card--paper \.stage-trail \{([^}]*)\}/)![1]!;
    expect(paper).toContain(`min-block-size: calc(${2 * lineHeight}em + ${rowGap});`);
  });

  it('keeps room for the notes line from 600px and under it, so a longer note moves nothing', () => {
    const notes = plain(lookProgressCss).match(/\n\.look-notes__text \{([^}]*)\}/)![1]!;
    const leading = notes.match(/line-height: var\((--[a-z-]+)\);/)![1]!;
    const lines = token(leading);
    expect(lines).toBe(1.35);
    expect(notes).toContain(`min-block-size: calc(2 * ${lines}em);`);
    const phone = mediaBlocks(lookProgressCss, '(max-width: 599px)').join('\n');
    expect(phone).toMatch(
      new RegExp(`\\.look-notes__text \\{\\s*min-block-size: calc\\(3 \\* ${lines}em\\);\\s*\\}`),
    );
    const body = mount('<div class="look-notes"><p class="look-notes__text">A note</p></div>');
    const text = getComputedStyle(body.querySelector('.look-notes__text')!);
    expect(text.minBlockSize).toBe(`${2 * lines * token('--text-m')}px`);
  });

  it('gives "Not your place?" a 44px target', () => {
    const body = mount('<button class="link-button waiting__escape">Not your place?</button>');
    expect(getComputedStyle(body.querySelector('.waiting__escape')!).minHeight).toBe('44px');
  });
});

describe('the rows under the picture on phones up to 375px wide', () => {
  const longest = HOLIDAY_IDS.map((id) => holidayName(id)).sort((a, b) => b.length - a.length)[0]!;
  /** A summary line of two lines of small type, with the row's padding above and below. */
  const twoLines = 2 * token('--leading-body') * token('--text-s');
  const narrow = document.createElement('style');

  afterEach(() => narrow.remove());

  function atWidth(width: number) {
    narrow.textContent = [narrowRules(disclosureCss, width), narrowRules(resultCss, width)].join(
      '\n',
    );
    document.head.append(narrow);
  }

  function looksRow(pending: boolean): HTMLElement {
    return mount(
      `<div class="result"${pending ? ' data-pending' : ''}><div class="disclosure result__looks">` +
        '<h2 class="disclosure__heading"><button class="disclosure__toggle">' +
        '<span class="disclosure__label">Try another look</span>' +
        `<span class="disclosure__summary"><span class="look-summary__holiday">${longest} · </span>Abundant · As photographed</span>` +
        '</button></h2></div></div>',
    );
  }

  it('names the longest holiday in the test', () => {
    expect(longest).toBe("New Year's Eve");
  });

  it.each([320, 360, 375])(
    'at %ipx keeps the "Try another look" row as tall when a look starts and arrives',
    (width) => {
      atWidth(width);
      const rows = [false, true].map((pending) => {
        const body = looksRow(pending);
        const toggle = getComputedStyle(body.querySelector('.disclosure__toggle')!);
        const summary = getComputedStyle(body.querySelector('.disclosure__summary')!);
        const holiday = getComputedStyle(body.querySelector('.look-summary__holiday')!);
        return {
          minHeight: toggle.minHeight,
          display: summary.display,
          clamp: summary.getPropertyValue('line-clamp'),
          overflow: summary.overflow,
          holiday: holiday.display,
        };
      });
      const [resting, making] = rows;
      // The holiday shows only while the band covers the title.
      expect(resting!.holiday).toBe('none');
      expect(making!.holiday).toBe('inline');
      for (const row of rows) {
        // Two lines at most, and room for two lines always: the row's height never changes.
        expect(row.minHeight).toBe(`${twoLines + 2 * token('--space-3')}px`);
        expect(row.display).toBe('-webkit-box');
        expect(row.clamp).toBe('2');
        expect(row.overflow).toBe('hidden');
      }
      expect(narrow.textContent).toMatch(/-webkit-line-clamp: 2;/);
      expect(narrow.textContent).toMatch(/-webkit-box-orient: vertical;/);
    },
  );

  it.each([
    [320, true],
    [359, true],
    [360, false],
    [375, false],
  ])(
    'at %ipx gives the counter and the lock line the same slot (two lines: %s)',
    (width, reserved) => {
      atWidth(width);
      const body = mount(
        '<div class="look-controls"><p class="allowance-counter" id="counter"><span class="allowance-counter__dot"></span>5 more looks today</p><p class="look-controls__locked" id="locked">You can pick another look when this one is ready.</p></div>',
      );
      const counter = getComputedStyle(body.querySelector('#counter')!);
      const locked = getComputedStyle(body.querySelector('#locked')!);
      expect(locked.minBlockSize).toBe(counter.minBlockSize);
      if (reserved) expect(locked.minBlockSize).toBe(`${twoLines}px`);
      else expect(['', 'auto', '0px']).toContain(locked.minBlockSize);
    },
  );
});
