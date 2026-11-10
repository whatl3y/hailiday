import { afterEach, describe, expect, it } from 'vitest';
import globalCss from '../../styles/global.css?raw';
import mainSource from '../../main.tsx?raw';
import landingCss from './landing.css?raw';
import { adoptServerHero, serverPanelShown } from './serverHero';

interface CssRule {
  selectors: string[];
  body: string;
}

/** Every style rule (inside media queries too) with its selector list and declarations. */
function cssRules(css: string): CssRule[] {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.split(',').map((selector) => selector.trim()),
    body: match[2]!,
  }));
}

afterEach(() => {
  document.body.replaceChildren();
});

function serverShell(): HTMLElement {
  const container = document.createElement('div');
  container.id = 'ssr-hero';
  container.innerHTML =
    '<picture class="ssr-hero__picture"><source media="(max-width: 599px)" srcset="p.jpg 720w" />' +
    '<img class="ssr-hero__image" src="l.jpg" alt="A porch" /></picture>' +
    '<div class="ssr-hero__panel"><h1 class="ssr-hero__headline">Imagine your place</h1>' +
    '<form role="search"><label for="ssr-address">Enter a US address</label>' +
    '<input id="ssr-address" /></form></div>';
  document.body.appendChild(container);
  return container;
}

describe('adoptServerHero', () => {
  it('moves only the photograph and drops the server headline and address field', () => {
    const container = serverShell();
    const slot = document.createElement('div');
    document.body.appendChild(slot);

    adoptServerHero(container, slot);

    expect(slot.querySelector('picture img')?.getAttribute('src')).toBe('l.jpg');
    expect(slot.querySelector('source')).not.toBeNull();
    expect(slot.querySelector('h1')).toBeNull();
    expect(slot.querySelector('input')).toBeNull();
    expect(container.childNodes).toHaveLength(0);
    expect(container.hidden).toBe(true);
    expect(document.querySelectorAll('h1')).toHaveLength(0);
    expect(document.getElementById('ssr-address')).toBeNull();
  });

  it('adopts a bare image without a picture element', () => {
    const container = document.createElement('div');
    container.innerHTML = '<img src="hero.jpg" alt="" /><h1>Headline</h1>';
    const slot = document.createElement('div');

    adoptServerHero(container, slot);

    expect(slot.children).toHaveLength(1);
    expect(slot.firstElementChild?.tagName).toBe('IMG');
    expect(container.childNodes).toHaveLength(0);
  });
});

describe('serverPanelShown', () => {
  it('is true while the server panel is on screen and false once the region is retired', () => {
    const container = serverShell();
    expect(serverPanelShown()).toBe(true);
    adoptServerHero(container, document.createElement('div'));
    expect(serverPanelShown()).toBe(false);
  });

  it('is false without a server region', () => {
    expect(serverPanelShown()).toBe(false);
  });
});

describe('the server hero region before the script runs', () => {
  const rules = cssRules(globalCss);

  it('never clips the server panel: the region itself has no fixed height or hidden overflow', () => {
    const region = rules.filter((rule) => rule.selectors.includes('.ssr-hero'));
    expect(region.length).toBeGreaterThan(0);
    for (const rule of region) {
      expect(rule.body).not.toMatch(/(^|[\s;])(min-|max-)?height\s*:/);
      expect(rule.body).not.toMatch(/overflow\s*:\s*hidden/);
    }
  });

  it('boxes the server photograph exactly like the app hero at every breakpoint', () => {
    const heroBoxes = rules.filter(
      (rule) => rule.selectors.includes('.hero') && /(^|[\s;])height\s*:/.test(rule.body),
    );
    expect(heroBoxes.length).toBe(3);
    for (const rule of heroBoxes) {
      expect(rule.selectors).toContain('.ssr-hero > .ssr-hero__picture');
    }
  });

  it('ships the landing panel styles the server panel uses in the entry stylesheet', () => {
    expect(mainSource).toContain("import './features/landing/landing.css';");
    const panel = cssRules(landingCss).find((rule) => rule.selectors.includes('.landing__panel'));
    expect(panel?.body).toMatch(/margin:\s*calc\(-1 \* var\(--space-6\)\) auto 0/);
  });
});
