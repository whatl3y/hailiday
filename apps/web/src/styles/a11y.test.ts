import globalCss from './global.css?raw';
import tokensCss from './tokens.css?raw';
import landingCss from '../features/landing/landing.css?raw';
import resultCss from '../features/project/result.css?raw';
import uploadCss from '../features/upload/upload.css?raw';
import { describe, expect, it } from 'vitest';

type Rgba = [number, number, number, number];

/** Parses `#rrggbb` or `rgb(r g b / a)` as written in the token file. */
function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(value.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
  throw new Error(`unparsed color ${value}`);
}

/** Every `--name: value;` declaration in a block of CSS, last one winning. */
function declarations(css: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) found[match[1]!] = match[2]!;
  return found;
}

function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

const rootTokens = declarations(block(tokensCss, ':root'));

function token(name: string, scope: Record<string, string> = rootTokens): Rgba {
  const value = scope[name] ?? rootTokens[name];
  if (!value) throw new Error(`no token ${name}`);
  return parseColor(value);
}

/** The color seen when a translucent color lies over an opaque one. */
function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.2 contrast ratio. */
function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE: Rgba = [255, 255, 255, 1];

const holidayScopes = [...tokensCss.matchAll(/\[data-holiday='([a-z_]+)'\] \{([^}]*)\}/g)].map(
  (match) => ({ id: match[1]!, tokens: declarations(match[2]!) }),
);

describe('non-text contrast of form controls', () => {
  const border = token('--control-border');
  const surfaces: Array<[string, Rgba]> = [
    ['--paper', token('--paper')],
    ['--paper-raised', token('--paper-raised')],
    ['--paper-sunk', token('--paper-sunk')],
    ['--accent-soft (neutral)', token('--accent-soft')],
    ...holidayScopes.map(
      ({ id, tokens }) =>
        [`--accent-soft (${id})`, token('--accent-soft', tokens)] as [string, Rgba],
    ),
  ];

  it('reads the four holiday scopes', () => {
    expect(holidayScopes.map((scope) => scope.id)).toEqual([
      'halloween',
      'thanksgiving_us',
      'christmas',
      'new_years_eve',
    ]);
  });

  it.each(surfaces)('keeps the control border at 3:1 or better against %s', (_name, surface) => {
    expect(contrast(border, surface)).toBeGreaterThanOrEqual(3);
  });

  it('draws text fields, the address field and the drop target with the control border', () => {
    expect(block(globalCss, '.input')).toMatch(/border: 1px solid var\(--control-border\)/);
    expect(block(landingCss, '.combo__field')).toMatch(
      /border: 1\.5px solid var\(--control-border\)/,
    );
    expect(block(uploadCss, '.dropzone')).toMatch(/border: 1\.5px dashed var\(--control-border\)/);
  });
});

describe('text over photographs', () => {
  const onPhoto = token('--on-photo');

  it('keeps the glass chip text at 4.5:1 even over a white backdrop', () => {
    expect(block(globalCss, '.chip--glass')).toMatch(/background: var\(--glass-dark\)/);
    expect(contrast(onPhoto, over(token('--glass-dark'), WHITE))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the large wordmark at 3:1 on the header scrim even over a white backdrop', () => {
    const header = block(globalCss, '.site-header--overlay');
    expect(header).toMatch(/var\(--photo-scrim-top\)/);
    expect(header).toMatch(/var\(--photo-scrim-band\) calc\(var\(--safe-top\) \+ 64px\)/);
    expect(contrast(onPhoto, over(token('--photo-scrim-top'), WHITE))).toBeGreaterThanOrEqual(3);
    expect(contrast(onPhoto, over(token('--photo-scrim-band'), WHITE))).toBeGreaterThanOrEqual(3);
  });
});

describe('reduced motion', () => {
  const reduced = globalCss.slice(globalCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  const universal = reduced.slice(0, reduced.indexOf('}'));

  it('removes every animation and transition delay, not only the durations', () => {
    expect(universal).toMatch(/animation-duration: 0\.001ms !important/);
    expect(universal).toMatch(/animation-delay: 0s !important/);
    expect(universal).toMatch(/transition-duration: 0\.001ms !important/);
    expect(universal).toMatch(/transition-delay: 0s !important/);
  });

  it('turns off the staged result entrance', () => {
    const resultReduced = resultCss.slice(
      resultCss.indexOf('@media (prefers-reduced-motion: reduce)'),
    );
    expect(resultReduced).toMatch(
      /\.result\[data-revealing\] \.result__rail > \*,\s*\.result\[data-revealing\] \.result__shop \{\s*animation: none;/,
    );
  });
});
