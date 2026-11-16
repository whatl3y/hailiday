import { describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import landingCss from '../features/landing/landing.css?raw';
import globalCss from './global.css?raw';
import tokensCss from './tokens.css?raw';
import { THEME_COLORS } from '../ui/themeColor';

/** Every `--name: value;` declaration in a block of CSS, last one winning. */
function declarations(css: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) {
    found[match[1]!] = match[2]!.replace(/\s+/g, ' ').trim();
  }
  return found;
}

const root = declarations(tokensCss.slice(tokensCss.indexOf(':root {'), tokensCss.indexOf('}')));
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the monochrome palette', () => {
  it('is a white page with near-black ink and an ink accent', () => {
    expect(root['--paper']).toBe('#ffffff');
    expect(root['--paper-raised']).toBe('#ffffff');
    expect(root['--ink']).toBe('#1d1d1f');
    expect(root['--accent']).toBe(root['--ink']);
    expect(root['--accent-ink']).toBe('#ffffff');
  });

  it('lets each holiday set only its dot and its three bulb colours, so nothing else changes between seasons', () => {
    const scopes = [...tokensCss.matchAll(/\[data-holiday='([a-z_]+)'\] \{([^}]*)\}/g)];
    expect(scopes).toHaveLength(4);
    for (const [, id, body] of scopes) {
      expect(Object.keys(declarations(body!)), id).toEqual([
        '--holiday-dot',
        '--bulb-1',
        '--bulb-2',
        '--bulb-3',
      ]);
    }
  });

  it('gives the light string warm white bulbs when no holiday is chosen', () => {
    expect(root['--bulb-1']).toBe('#ffd9a0');
    expect(root['--bulb-2']).toBe('#fff4dc');
    expect(root['--bulb-3']).toBe('#ffc46b');
  });

  it('draws depth only with the panel shadow and the solid action shadows', () => {
    const shadows = Object.entries(root).filter(([name]) => name.startsWith('--shadow-'));
    const allowed = new Set([
      '0 1px 0 rgb(29 29 31 / 0.02), 0 12px 40px -16px rgb(29 29 31 / 0.12)',
      '0 1px 2px rgb(0 0 0 / 0.12), 0 8px 24px rgb(0 0 0 / 0.14)',
      '0 2px 4px rgb(0 0 0 / 0.16), 0 14px 34px rgb(0 0 0 / 0.2)',
      'var(--shadow-panel)',
    ]);
    expect(shadows.length).toBeGreaterThan(3);
    for (const [name, value] of shadows) expect(allowed.has(value), name).toBe(true);
  });

  it('rounds cards, fields, panels and frames at 10px, and pills fully', () => {
    for (const name of ['--radius-s', '--radius-m', '--radius-l', '--radius-xl']) {
      expect(root[name], name).toBe('10px');
    }
    expect(root['--radius-pill']).toBe('999px');
  });
});

describe('typography', () => {
  it('sets everything in Outfit and small technical text in JetBrains Mono', () => {
    expect(root['--font-ui']).toMatch(/^'Outfit Variable', Outfit, -apple-system/);
    expect(root['--font-ui']).toMatch(/sans-serif$/);
    expect(root['--font-display']).toBe('var(--font-ui)');
    expect(root['--font-mono']).toMatch(
      /^'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace/,
    );
  });

  it('self-hosts both families from the bundle, right after the tokens', () => {
    const imports = [...globalCss.matchAll(/^@import '([^']+)';$/gm)].map((match) => match[1]);
    expect(imports).toEqual([
      './tokens.css',
      '@fontsource-variable/outfit/wght.css',
      '@fontsource-variable/jetbrains-mono/wght.css',
    ]);
    expect(indexHtml).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it('uses no serif face and no italics in the base and landing styles', () => {
    for (const css of [tokensCss, globalCss, landingCss].map(withoutComments)) {
      expect(css).not.toMatch(/(?<!sans-)serif/);
      expect(css).not.toMatch(/font-style:\s*italic/);
    }
  });

  it('gives the display title its weight, tracking and leading', () => {
    expect(root['--text-display']).toBe('clamp(2.25rem, 5.4vw, 4.25rem)');
    expect(root['--tracking-display']).toBe('-0.035em');
    expect(root['--leading-tight']).toBe('1.04');
  });
});

describe('the framed grids', () => {
  const cells = [
    '.example-gallery > .example-card',
    '.shop__cards > .product',
    '.gallery__grid > .gallery__item',
  ];
  const plain = withoutComments(globalCss);
  /** The declarations of the rule whose selector list is exactly `selectors`. */
  const ruleFor = (selectors: string[]) => {
    const match = new RegExp(
      `(?:^|\\})\\s*${selectors.map(escape).join(',\\s*')}\\s*\\{([^}]*)\\}`,
    ).exec(plain);
    return match?.[1] ?? null;
  };
  function escape(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  it('draw each cell hairline on a layer above the cells, never as a shadow under the next cell', () => {
    const cell = ruleFor(cells);
    expect(cell).not.toBeNull();
    expect(cell).toMatch(/position: relative;/);
    expect(cell).toMatch(/box-shadow: none;/);
    const line = ruleFor(cells.map((selector) => `${selector}::after`));
    expect(line).not.toBeNull();
    expect(line).toMatch(/content: '';/);
    expect(line).toMatch(/position: absolute;/);
    expect(line).toMatch(/z-index: [1-9]/);
    expect(line).toMatch(/inset: 0 -1px -1px 0;/);
    expect(line).toMatch(/border: solid var\(--line\);/);
    expect(line).toMatch(/border-width: 0 1px 1px 0;/);
    expect(line).toMatch(/pointer-events: none;/);
  });

  it('win over a single-class rule in a feature stylesheet', () => {
    // Each selector is `.grid > .cell`: two classes outrank a feature rule on `.cell` alone.
    for (const selector of cells) expect(selector).toMatch(/^\.[\w-]+ > \.[\w-]+$/);
  });
});

/** The bodies of every `@media <query>` block, braces balanced, in order. */
function mediaBlock(css: string, query: string): string {
  const bodies: string[] = [];
  let start = css.indexOf(`@media ${query} {`);
  while (start >= 0) {
    const open = css.indexOf('{', start);
    let depth = 0;
    let index = open;
    for (; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}') depth -= 1;
      if (depth === 0) break;
    }
    bodies.push(css.slice(open + 1, index));
    start = css.indexOf(`@media ${query} {`, index);
  }
  return bodies.join('\n');
}

/** The declarations of every rule whose selector list is exactly `selector`, in order. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/,\s*/g, ',\\s*');
  const rules = new RegExp(`(?<=^|[}{])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g');
  return [...withoutComments(css).matchAll(rules)].map((match) => match[1]).join('\n');
}

/** The alpha of every `rgb(var(--scrim-rgb) / a)` color in `css`, in order. */
function scrimAlphas(css: string): number[] {
  return [...css.matchAll(/rgb\(var\(--scrim-rgb\) \/ ([\d.]+)\)/g)].map((match) =>
    Number(match[1]),
  );
}

/**
 * An eased fall to nothing: at least six stops, never rising, never more than 0.08 apart, and
 * the last stop exactly 0.
 */
function expectEased(alphas: number[]): void {
  expect(alphas.length).toBeGreaterThanOrEqual(6);
  expect(alphas.at(-1)).toBe(0);
  for (let index = 1; index < alphas.length; index += 1) {
    expect(alphas[index]).toBeLessThanOrEqual(alphas[index - 1]);
    expect(alphas[index - 1] - alphas[index]).toBeLessThanOrEqual(0.08);
  }
}

describe('the header on narrow phones', () => {
  it('never wraps the holiday name', () => {
    expect(ruleBody(globalCss, '.holiday-chip')).toMatch(/white-space: nowrap;/);
  });

  it('below 380px tightens the gap and the tracking and drops the chevron, so nothing scrolls', () => {
    const narrow = mediaBlock(globalCss, '(max-width: 379px)');
    expect(ruleBody(narrow, '.site-header__end')).toMatch(/gap: var\(--space-3\);/);
    expect(ruleBody(narrow, '.holiday-chip, .site-header__link')).toMatch(
      /letter-spacing: 0\.08em;/,
    );
    expect(ruleBody(narrow, '.holiday-chip .icon')).toMatch(/display: none;/);
  });
});

describe('stacks', () => {
  const plain = withoutComments(globalCss);

  it('set their own gap, so a stack nested in a loose one keeps the default rhythm', () => {
    const stack = ruleBody(globalCss, '.stack');
    expect(stack).toMatch(/--stack-gap: var\(--space-4\);/);
    expect(stack).toMatch(/gap: var\(--stack-gap\);/);
  });

  it('declare the tight and loose gaps after the default, so a modifier wins on the same box', () => {
    const at = (selector: string) => plain.search(new RegExp(`(^|\\})\\s*\\${selector} \\{`));
    expect(at('.stack')).toBeGreaterThanOrEqual(0);
    expect(at('.stack--tight')).toBeGreaterThan(at('.stack'));
    expect(at('.stack--loose')).toBeGreaterThan(at('.stack'));
    expect(ruleBody(globalCss, '.stack--tight')).toMatch(/--stack-gap: var\(--space-2\);/);
    expect(ruleBody(globalCss, '.stack--loose')).toMatch(/--stack-gap: var\(--space-6\);/);
  });
});

describe('form labels', () => {
  /** The declarations of a rule as a sorted list, for comparing two rules. */
  const declared = (body: string) =>
    body
      .split(';')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .sort();

  it('come in one style: every field label is set as the address field label is', () => {
    const address = declared(ruleBody(landingCss, '.combo__label'));
    expect(address).toEqual(
      expect.arrayContaining([
        'font-size: var(--text-label)',
        'letter-spacing: var(--tracking-caps)',
        'text-transform: uppercase',
        'color: var(--ink-muted)',
      ]),
    );
    expect(declared(ruleBody(globalCss, '.field__label'))).toEqual(address);
  });
});

describe('the footer', () => {
  it('spans the page between the gutters as the header does, so it starts under the brand', () => {
    expect(ruleBody(globalCss, '.site-footer__inner')).toMatch(/max-width: none;/);
  });

  it('sets the line at 10px on laptop widths and 11px from 1440px, so it stays one line', () => {
    const band = mediaBlock(globalCss, '(min-width: 1280px) and (max-width: 1439px)');
    expect(ruleBody(band, '.site-footer__inner')).toMatch(/font-size: 0\.625rem;/);
    expect(ruleBody(mediaBlock(globalCss, '(min-width: 600px)'), '.site-footer__inner')).toMatch(
      /font-size: var\(--text-label\);/,
    );
  });
});

describe('picture surfaces', () => {
  it('add the stage, scrim, header, peek, dock and drift tokens', () => {
    expect(root['--stage']).toBe('#0d0d0f');
    expect(root['--on-stage']).toBe('#ffffff');
    expect(root['--on-stage-muted']).toBe('rgb(255 255 255 / 0.72)');
    expect(root['--stage-line']).toBe('rgb(255 255 255 / 0.14)');
    expect(root['--scrim-rgb']).toBe('13 13 15');
    expect(root['--header-height']).toBe('72px');
    expect(root['--stage-peek']).toBe('104px');
    expect(root['--dock-radius']).toBe('20px');
    expect(root['--dock-shadow']).toBe('0 24px 64px -24px rgb(13 13 15 / 0.5)');
    expect(root['--dur-drift']).toBe('24s');
    const phone = declarations(mediaBlock(tokensCss, '(max-width: 599px)'));
    expect(phone['--header-height']).toBe('56px');
    expect(phone['--stage-peek']).toBe('88px');
  });

  it('keep the header at the header height on every page', () => {
    expect(ruleBody(globalCss, '.site-header')).toMatch(
      /min-block-size: calc\(var\(--header-height\) \+ var\(--safe-top\)\);/,
    );
    expect(ruleBody(globalCss, '.site-header')).not.toMatch(/padding-block/);
  });

  it('lay the photo-tone header over the first element, in white, the picker on dark glass', () => {
    const photo = ruleBody(globalCss, '.site-header--photo');
    expect(photo).toMatch(/position: absolute;/);
    expect(photo).toMatch(/inset: 0 0 auto;/);
    expect(photo).toMatch(/color: var\(--on-photo\);/);
    expect(ruleBody(globalCss, '.site-header--photo .holiday-chip::before')).toMatch(
      /background: var\(--glass-dark\);/,
    );
  });

  it('give the stage-tone header its own band on the ink ground, in white, the picker outlined', () => {
    const stage = ruleBody(globalCss, '.site-header--stage');
    expect(stage).toMatch(/background: var\(--stage\);/);
    expect(stage).toMatch(/color: var\(--on-stage\);/);
    // It stays in the flow at the header height, unlike the photo tone.
    expect(stage).not.toMatch(/position|inset/);
    expect(ruleBody(globalCss, '.site-header--stage .site-header__link')).toMatch(
      /color: var\(--on-stage-muted\);/,
    );
    expect(globalCss).toMatch(
      /\.site-header--stage \.wordmark,[^{]*\.site-header--stage \.holiday-chip,[^{]*\{\s*color: var\(--on-stage\);/,
    );
    const chip = ruleBody(globalCss, '.site-header--stage .holiday-chip::before');
    expect(chip).toMatch(/border: 1px solid var\(--stage-line\);/);
    expect(chip).not.toMatch(/background/);
    const ring = ruleBody(globalCss, '.site-header--stage :focus-visible');
    expect(ring).toMatch(/outline: 2px solid var\(--on-stage\);/);
    expect(ring).toMatch(/box-shadow: 0 0 0 4px var\(--ink\);/);
  });

  it('fill the first viewport with the hero frame, never under 560px, on the ink ground', () => {
    const frame = ruleBody(globalCss, '.hero-frame');
    expect(frame).toMatch(
      /min-block-size: max\(560px, 100vh\);\s*min-block-size: max\(560px, 100svh\);/,
    );
    expect(frame).toMatch(/overflow: clip;/);
    expect(frame).toMatch(/background: var\(--stage\);/);
    expect(frame).not.toMatch(/border|radius|box-shadow/);
  });

  it('cover the frame with the photograph around its focal point, the portrait pair when tall', () => {
    expect(ruleBody(globalCss, '.hero-frame__photo img')).toMatch(/object-fit: cover;/);
    const tall = mediaBlock(globalCss, '(orientation: portrait)');
    expect(ruleBody(tall, '.hero-frame__photo img')).toMatch(
      /object-position: var\(--hero-portrait-x, 50%\) var\(--hero-portrait-y, 55%\);/,
    );
  });

  it('drift the photograph once from scale 1 to 1.06, and hold it still under reduced motion', () => {
    expect(globalCss).toMatch(
      /@keyframes hero-drift \{\s*from \{\s*transform: scale\(1\);\s*\}\s*to \{\s*transform: scale\(1\.06\);/,
    );
    expect(ruleBody(globalCss, '.hero-frame__photo')).toMatch(/var\(--dur-drift\)[^;]*forwards;/);
    const reduced = mediaBlock(globalCss, '(prefers-reduced-motion: reduce)');
    expect(ruleBody(reduced, '.hero-frame__photo')).toMatch(/animation: none;/);
  });

  it('mix every scrim on a photograph from the scrim color alone', () => {
    const scrims = [
      ruleBody(globalCss, '.hero-frame__scrim'),
      // The headline's band (phones and wide) and its shadow.
      ruleBody(landingCss, '.landing__headline::before'),
      ruleBody(landingCss, '.landing__headline'),
    ];
    expect(scrims.length).toBeGreaterThanOrEqual(3);
    for (const scrim of scrims) {
      // A mask's colors only shape the scrim; they are never painted.
      const painted = scrim.replace(/mask-image:[^;]+;/g, '');
      const colors = painted.match(/\b(rgba?|hsla?|color)\(|#[0-9a-f]{3,8}\b/gi) ?? [];
      const scrimColors = painted.match(/rgb\(var\(--scrim-rgb\) \/ [\d.]+\)/g) ?? [];
      expect(colors.length).toBeGreaterThan(0);
      expect(scrimColors).toHaveLength(colors.length);
    }
  });

  it('ease the header band out to nothing at twice the header height, with no visible step', () => {
    const band = ruleBody(globalCss, '.hero-frame__scrim');
    const gradient =
      /linear-gradient\(\s*to bottom,([^;]+?)\),\s*var\(--hero-scrim, none\)/.exec(band)?.[1] ?? '';
    const alphas = scrimAlphas(gradient);
    expectEased(alphas);
    // Dark enough behind the header's own type, and gone at 2 x --header-height.
    expect(alphas[0]).toBeGreaterThanOrEqual(0.6);
    expect(gradient).toMatch(
      /rgb\(var\(--scrim-rgb\) \/ 0\) calc\(var\(--header-height\) \* 2 \+ var\(--safe-top\)\)\s*$/,
    );
  });

  it('rest a white dock on the photograph with the dock radius and shadow', () => {
    const dock = ruleBody(globalCss, '.hero-dock');
    expect(dock).toMatch(/background: var\(--paper\);/);
    expect(dock).toMatch(/color: var\(--ink\);/);
    expect(dock).toMatch(/border-radius: var\(--dock-radius\);/);
    expect(dock).toMatch(/box-shadow: var\(--dock-shadow\);/);
  });

  it('draw a white ring with an ink edge for focus on a photograph', () => {
    const ring = ruleBody(
      globalCss,
      '.hero-frame :focus-visible, .site-header--photo :focus-visible',
    );
    expect(ring).toMatch(/outline: 2px solid var\(--on-photo\);/);
    expect(ring).toMatch(/box-shadow: 0 0 0 4px var\(--ink\);/);
  });
});

describe('the landing on the photograph', () => {
  const wide = mediaBlock(landingCss, '(min-width: 600px)');

  it('sets the headline in white at display size, two balanced lines on wide screens', () => {
    const headline = ruleBody(landingCss, '.landing__headline');
    expect(headline).toMatch(/color: var\(--on-photo\);/);
    expect(headline).toMatch(/font-weight: var\(--weight-bold\);/);
    expect(headline).toMatch(/letter-spacing: -0\.04em;/);
    expect(headline).toMatch(/line-height: 1;/);
    expect(headline).toMatch(/text-wrap: balance;/);
    expect(headline).toMatch(/font-size: clamp\(2\.25rem, 10vw, 3rem\);/);
    expect(ruleBody(wide, '.landing__frame')).toMatch(
      /--landing-type-size: clamp\(2\.75rem, 6\.4vw, 6rem\);/,
    );
    // 12em holds "Imagine your place" (about 8em) on one line, and balance sets the rest as one
    // more line: "Imagine your place / for the holidays."
    expect(ruleBody(wide, '.landing__headline')).toMatch(/max-width: 12em;/);
    expect(ruleBody(wide, '.landing__headline')).toMatch(/font-size: var\(--landing-type-size\);/);
  });

  it('leaves the photograph as shot outside the headline: no frame-wide scrim on the landing', () => {
    expect(landingCss).not.toMatch(/--hero-scrim(-pool|-mask)?:/);
  });

  it('gives the headline its own scrim with a soft ink shadow: a band on phones', () => {
    const band = ruleBody(landingCss, '.landing__headline::before');
    expect(band).toMatch(/position: absolute;/);
    expect(band).toMatch(/z-index: -1;/);
    expect(band).toMatch(/mask-image: linear-gradient\(\s*to bottom,\s*transparent,/);
    expect(ruleBody(landingCss, '.landing__headline')).toMatch(
      /text-shadow:[^;]*rgb\(var\(--scrim-rgb\) \/ 0\.42\)/,
    );
  });

  it("from 600px gives the headline one soft ellipse, eased out to nothing, in the type's own em", () => {
    const ellipse = ruleBody(wide, '.landing__headline::before');
    // Sized and placed in em, so the ellipse scales with the headline at every width.
    for (const side of ['top', 'left', 'width', 'height']) {
      expect(ellipse).toMatch(new RegExp(`(^|\\s)${side}: -?[\\d.]+em;`));
    }
    expect(ellipse).toMatch(/inset: auto;/);
    expect(ellipse).toMatch(/(^|\s)mask-image: none;/);
    const gradient =
      /background: radial-gradient\(\s*closest-side,([^;]+)\);/.exec(ellipse)?.[1] ?? '';
    const alphas = scrimAlphas(gradient);
    expectEased(alphas);
    // The darkest point stays at about 0.6.
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.6);
    expect(gradient).toMatch(/rgb\(var\(--scrim-rgb\) \/ 0\) 100%\s*$/);
    // The shadow is the scrim color only, in em so it grows with the type.
    const shadow = /text-shadow:([^;]+);/.exec(ruleBody(wide, '.landing__headline'))?.[1] ?? '';
    expect(scrimAlphas(shadow).length).toBeGreaterThanOrEqual(3);
    expect(shadow).toMatch(/0 0\.22em 0\.6em rgb\(var\(--scrim-rgb\) \/ 0\.4\)/);
  });

  it('leaves room under the headline for the ellipse to fade before the dock', () => {
    expect(ruleBody(wide, '.landing__dock')).toMatch(
      /margin-top: calc\(var\(--space-6\) \+ var\(--space-2\)\);/,
    );
    const short = mediaBlock(landingCss, '(min-width: 600px) and (max-height: 760px)');
    expect(ruleBody(short, '.landing__dock')).toMatch(/margin-top: var\(--space-6\);/);
  });

  it('sets the eyebrow on a dark glass pill, so it needs no scrim', () => {
    const eyebrow = ruleBody(landingCss, '.landing__eyebrow');
    expect(eyebrow).toMatch(/background: var\(--glass-dark\);/);
    expect(eyebrow).toMatch(/border-radius: var\(--radius-pill\);/);
    expect(eyebrow).toMatch(/color: var\(--on-photo\);/);
  });

  it('keeps the phone dock compact: 16px padding, routes 44px tall and 4px apart, a plain invitation', () => {
    expect(ruleBody(landingCss, '.landing__dock')).toMatch(/padding: var\(--space-4\);/);
    expect(ruleBody(landingCss, '.landing__routes')).toMatch(/gap: 4px var\(--space-4\);/);
    expect(ruleBody(landingCss, '.landing__routes .link-button')).toMatch(
      /min-height: var\(--target-comfort\);/,
    );
    const invite = ruleBody(landingCss, '.landing__invite');
    expect(invite).not.toMatch(/border|background|padding/);
  });

  it('rests the content block at the lower left on wide screens, inside the gutters', () => {
    const content = ruleBody(wide, '.landing__frame > .hero-frame__content');
    expect(content).toMatch(/justify-content: flex-end;/);
    expect(content).toMatch(/clamp\(24px, 5vw, 96px\)/);
    expect(content).toMatch(/clamp\(32px, 7svh, 88px\)/);
    expect(ruleBody(wide, '.landing__dock')).toMatch(/max-inline-size: 40rem;/);
  });

  it('opens the dock with the subhead in ink at the body size, a step larger on wide screens', () => {
    const sizes = [...ruleBody(landingCss, '.landing__subhead').matchAll(/font-size:\s*([^;]+);/g)];
    // The base rule, then the wide one.
    expect(sizes.map((match) => match[1])).toEqual(['var(--text-m)', 'var(--text-l)']);
    expect(ruleBody(landingCss, '.landing__subhead')).toMatch(/color: var\(--ink\);/);
    expect(ruleBody(wide, '.landing__subhead')).toMatch(/font-size: var\(--text-l\);/);
  });

  it('opens the suggestions upward from the field on wide screens, capped inside the viewport', () => {
    const up = ruleBody(wide, ".combo[data-placement='above'] .combo__popup");
    expect(up).toMatch(/top: auto;/);
    expect(up).toMatch(/bottom: 100%;/);
    expect(up).toMatch(/max-block-size: min\(20rem, 45svh\);/);
    expect(ruleBody(landingCss, '.combo__anchor')).toMatch(/position: relative;/);
    expect(ruleBody(landingCss, '.combo__listbox')).toMatch(/overflow-y: auto;/);
  });

  it('places the link back to the last place where it moves nothing the server painted', () => {
    expect(ruleBody(landingCss, '.landing__continue')).toMatch(/background: var\(--glass-dark\);/);
    expect(ruleBody(wide, '.landing__continue')).toMatch(/order: -1;/);
  });
});

describe('the document', () => {
  it('declares the white page as its default theme color; ink pages replace it', () => {
    expect(indexHtml).toContain('<meta name="theme-color" content="#ffffff" />');
    expect(THEME_COLORS).toEqual({ paper: root['--paper'], ink: root['--stage'] });
  });

  it('links the brand mark from the public folder as the tab icon', () => {
    expect(indexHtml).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
  });
});

describe('the small segmented switch on example cards', () => {
  it('gives each button a comfortable 44px target and draws the 32px pill inside it', () => {
    const button = ruleBody(globalCss, '.segmented--small button');
    expect(button).toMatch(/min-height: var\(--target-comfort\);/);
    expect(button).toMatch(/min-width: var\(--target-comfort\);/);
    expect(ruleBody(globalCss, '.segmented--small::before')).toMatch(/inset: 6px 0;/);
    expect(ruleBody(globalCss, '.segmented--small button::before')).toMatch(/inset: 9px 0;/);
    expect(ruleBody(globalCss, ".segmented--small button[aria-pressed='true']::before")).toMatch(
      /background: var\(--ink\);/,
    );
    // The frame is the pseudo-element, so the group adds no height around its targets.
    const group = ruleBody(globalCss, '.segmented--small');
    expect(group).toMatch(/padding: 0 2px;/);
    expect(group).toMatch(/border: 0;/);
  });
});

describe('controls locked while a look is being made', () => {
  it('dim to 0.45 except the choice being made, which keeps its fill', () => {
    const style = document.createElement('style');
    style.textContent = [tokensCss, globalCss.replace(/^@import [^;]+;$/gm, '')].join('\n');
    document.head.append(style);
    document.body.innerHTML = [
      '<div class="segmented"><button id="seg-pressed" aria-pressed="true" aria-disabled="true">Classic</button>',
      '<button id="seg" aria-pressed="false" aria-disabled="true">Subtle</button></div>',
      '<button class="chip" id="chip-pressed" aria-pressed="true" aria-disabled="true">Christmas</button>',
      '<button class="chip" id="chip" aria-pressed="false" aria-disabled="true">Halloween</button>',
      '<button class="link-button" id="link" aria-disabled="true">Replace photo</button>',
      '<button class="holiday-chip" id="holiday" aria-disabled="true">Holiday</button>',
      '<button class="scene-chip" id="scene" aria-disabled="true">Scene</button>',
      '<div class="segmented"><button id="seg-free" aria-pressed="false">Evening</button></div>',
    ].join('');
    const opacity = (id: string) => getComputedStyle(document.getElementById(id)!).opacity;
    try {
      for (const id of ['seg', 'chip', 'link', 'holiday', 'scene']) {
        expect(opacity(id), id).toBe('0.45');
      }
      for (const id of ['seg-pressed', 'chip-pressed', 'seg-free']) {
        expect(opacity(id), id).toBe('1');
      }
    } finally {
      style.remove();
      document.body.innerHTML = '';
    }
  });
});
