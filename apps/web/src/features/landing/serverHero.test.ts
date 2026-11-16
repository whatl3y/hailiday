import { afterEach, describe, expect, it } from 'vitest';
import globalCss from '../../styles/global.css?raw';
import mainSource from '../../main.tsx?raw';
import landingCss from './landing.css?raw';
import {
  DRIFT_SETTLED_MS,
  RISE_SETTLED_MS,
  adoptServerHero,
  serverDriftElapsed,
  serverHeroPresent,
  serverPanelShown,
  serverRiseElapsed,
} from './serverHero';

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
    '<picture class="ssr-hero__picture"><source media="(orientation: portrait)" srcset="p.jpg 720w" />' +
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

describe('serverHeroPresent', () => {
  it('is true for a server region with a photograph and false once it is retired', () => {
    const container = serverShell();
    expect(serverHeroPresent()).toBe(true);
    adoptServerHero(container, document.createElement('div'));
    expect(serverHeroPresent()).toBe(false);
  });
});

describe('serverRiseElapsed', () => {
  function withAnimations(times: Array<number | null>, state = 'running'): HTMLElement {
    const container = document.createElement('div');
    container.id = 'ssr-hero';
    container.innerHTML =
      '<div class="ssr-hero__panel"><p>Eyebrow</p><h1>Headline</h1><div>Dock</div></div>';
    document.body.appendChild(container);
    const blocks = container.querySelectorAll<HTMLElement>('.ssr-hero__panel > *');
    blocks.forEach((block, index) => {
      const time = times[index];
      block.getAnimations = () =>
        time === undefined
          ? []
          : ([{ currentTime: time, playState: state }] as unknown as Animation[]);
    });
    return container;
  }

  it('reads the progress of the first block whose entrance is still playing', () => {
    withAnimations([null, 640.4]);
    expect(serverRiseElapsed()).toBe(640);
  });

  it('counts a landed entrance, or one the browser cannot report, as settled', () => {
    withAnimations([]);
    expect(serverRiseElapsed()).toBe(RISE_SETTLED_MS);
    document.body.replaceChildren();
    withAnimations([300, 300, 300], 'finished');
    expect(serverRiseElapsed()).toBe(RISE_SETTLED_MS);
    document.body.replaceChildren();
    expect(serverRiseElapsed()).toBe(RISE_SETTLED_MS);
  });
});

describe('serverDriftElapsed', () => {
  function withDrift(animation: { currentTime: number | null; playState: string } | null) {
    const container = document.createElement('div');
    container.id = 'ssr-hero';
    container.innerHTML = '<div class="hero-frame"><div class="hero-frame__photo"></div></div>';
    document.body.appendChild(container);
    const photo = container.querySelector<HTMLElement>('.hero-frame__photo')!;
    photo.getAnimations = () => (animation ? [animation as unknown as Animation] : []);
  }

  it('reads how far the server photograph has drifted, so the app continues it', () => {
    withDrift({ currentTime: 1834.6, playState: 'running' });
    expect(serverDriftElapsed()).toBe(1835);
  });

  it('rests a finished drift at its end and starts afresh without one', () => {
    withDrift({ currentTime: 24000, playState: 'finished' });
    expect(serverDriftElapsed()).toBe(DRIFT_SETTLED_MS);
    document.body.replaceChildren();
    withDrift(null);
    expect(serverDriftElapsed()).toBe(0);
    document.body.replaceChildren();
    expect(serverDriftElapsed()).toBe(0);
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

  it('covers the frame with the server photograph exactly as with the adopted one', () => {
    // The server's <picture> sits straight in .hero-frame__photo; once adopted it sits in the
    // server layer. Both are absolutely placed over the whole frame and the image covers it.
    const placed = rules.find((rule) =>
      ['.hero-frame__photo > picture', '.hero__layer > picture'].every((selector) =>
        rule.selectors.includes(selector),
      ),
    );
    expect(placed?.body).toMatch(/position:\s*absolute/);
    expect(placed?.body).toMatch(/inset:\s*0/);
    const image = rules.find((rule) => rule.selectors.join() === '.hero-frame__photo img');
    expect(image?.body).toMatch(/object-fit:\s*cover/);
    expect(image?.body).toMatch(/object-position:\s*var\(--hero-x, 50%\) var\(--hero-y, 55%\)/);
    for (const rule of rules) {
      for (const selector of rule.selectors) expect(selector).not.toContain('ssr-hero__picture');
    }
  });

  it('ships the landing panel styles the server panel uses in the entry stylesheet', () => {
    expect(mainSource).toContain("import './features/landing/landing.css';");
    const panel = cssRules(landingCss).find((rule) => rule.selectors.includes('.landing__panel'));
    expect(panel?.body).toMatch(/flex-direction:\s*column/);
  });

  it('carries the server entrance and drift progress into the app', () => {
    const entrance = cssRules(landingCss).find((rule) =>
      rule.selectors.includes('.landing__panel > *'),
    );
    expect(entrance?.body).toMatch(/animation:\s*rise-in [^;]*backwards/);
    expect(entrance?.body).toMatch(/- var\(--rise-elapsed, 0ms\)/);
    const drift = rules.find((rule) => rule.selectors.join() === '.hero-frame__photo');
    expect(drift?.body).toMatch(/animation:\s*hero-drift var\(--dur-drift\)[^;]*forwards/);
    expect(drift?.body).toMatch(/animation-delay:\s*calc\(-1 \* var\(--drift-elapsed, 0ms\)\)/);
  });
});
