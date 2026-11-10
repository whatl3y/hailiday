import { describe, expect, it } from 'vitest';
import landingCss from '../features/landing/landing.css?raw';
import resultCss from '../features/project/result.css?raw';
import mainSource from '../main.tsx?raw';
import globalCss from './global.css?raw';

const stylesheets = import.meta.glob<string>('../**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const components = import.meta.glob<string>('../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('stylesheet order', () => {
  it('puts the tokens and the global rules ahead of every feature stylesheet', () => {
    const imports = [...mainSource.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?'([^']+)';/gm)].map(
      (match) => match[1],
    );
    // Everything the entry imports (the routes, and through them every feature stylesheet)
    // comes after the base stylesheet, so feature rules win ties of equal specificity.
    expect(imports[0]).toBe('./styles/global.css');
    expect(imports.filter((path) => path === './styles/global.css')).toHaveLength(1);
    expect(globalCss.trimStart().startsWith("@import './tokens.css';")).toBe(true);
  });
});

describe('buttons', () => {
  it('keep the control height: no feature rule lowers the min-height of a button', () => {
    // Classes that share an element with `button` in the markup.
    const partners = new Set<string>();
    for (const source of Object.values(components)) {
      for (const match of source.matchAll(/className="([^"]+)"/g)) {
        const classes = match[1]!.split(/\s+/);
        if (!classes.includes('button')) continue;
        for (const name of classes) if (!name.startsWith('button')) partners.add(name);
      }
    }
    expect(partners.has('landing__upload')).toBe(true);
    for (const [file, css] of Object.entries(stylesheets)) {
      if (file.includes('/styles/')) continue;
      const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of match[1]!.split(',').map((part) => part.trim())) {
          const single = /^\.([\w-]+)$/.exec(selector);
          if (!single || !partners.has(single[1]!)) continue;
          expect(`${file} ${selector}: ${match[2]}`).not.toMatch(
            /min-height:\s*var\(--target-(comfort|min)\)/,
          );
        }
      }
    }
  });
});

describe('entrance animations', () => {
  it('leave nothing behind once played, so no element stays a stacking context', () => {
    expect(Object.keys(stylesheets).length).toBeGreaterThan(5);
    for (const [file, css] of Object.entries(stylesheets)) {
      for (const match of css.matchAll(/animation:\s*rise-in[^;]*;/g)) {
        expect(`${file}: ${match[0]}`).not.toMatch(/\b(both|forwards)\b/);
      }
    }
  });
});

describe('the share link field', () => {
  it('keeps the 16px field text, so focusing it never zooms on iOS', () => {
    const shareCss = stylesheets['../features/share/share.css']!;
    expect(rule(shareCss, '.share__link')).not.toMatch(/font-size/);
  });
});

describe('address suggestions', () => {
  it('paint above the landing panel blocks that follow the address field', () => {
    const address = rule(landingCss, '.landing__address');
    expect(address).toMatch(/position:\s*relative;/);
    expect(address).toMatch(/z-index:\s*[1-9]\d*;/);
  });
});

describe('the result card badge', () => {
  it('never follows the comparison divider', () => {
    for (const match of resultCss.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!match[1]!.includes('image-card__corner')) continue;
      expect(match[2]).not.toMatch(/--before/);
    }
  });
});
