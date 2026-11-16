import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import mainSource from '../main.tsx?raw';
import { Stage } from './Stage';
import stageCss from './stage.css?raw';
import lookProgressCss from '../features/project/look-progress.css?raw';

const plain = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const source = plain(css);
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = source.indexOf('{', start);
  return source.slice(open + 1, source.indexOf('}', open)).replace(/\s+/g, ' ');
}

/** The body of the first `@media` block with this exact condition. */
function media(css: string, condition: string): string {
  const source = plain(css);
  const start = source.indexOf(`@media ${condition} {`);
  if (start < 0) throw new Error(`no @media ${condition}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0)
      return source.slice(source.indexOf('{', start) + 1, index).replace(/\s+/g, ' ');
  }
  throw new Error('unclosed @media');
}

afterEach(cleanup);

describe('Stage', () => {
  it('reserves the picture box from its natural size and fills the first viewport by default', () => {
    const { container } = render(
      <Stage width={1536} height={1024}>
        <img alt="Your photo" src="/a.jpg" />
      </Stage>,
    );
    const stage = container.querySelector<HTMLElement>('.stage')!;
    expect(stage.className).toBe('stage stage--viewport');
    expect(stage.dataset.fill).toBe('viewport');
    expect(stage.style.getPropertyValue('--stage-w')).toBe('1536');
    expect(stage.style.getPropertyValue('--stage-h')).toBe('1024');
    expect(stage.querySelector('.stage__picture > img')).not.toBeNull();
    expect(stage.querySelector('.stage__ambient')).toBeNull();
    expect(stage.querySelector('.stage__overlay')).toBeNull();
  });

  it('can be exactly as tall as the picture', () => {
    const { container } = render(
      <Stage width={640} height={640} fill="picture" className="extra">
        <span />
      </Stage>,
    );
    expect(container.querySelector('.stage')?.className).toBe('stage stage--picture extra');
  });

  it('draws the ambient layer as decoration that never takes focus or a name', () => {
    const { container } = render(
      <Stage width={640} height={640} ambientSrc="/render.jpg">
        <span />
      </Stage>,
    );
    const ambient = container.querySelector('.stage__ambient')!;
    expect(ambient.getAttribute('aria-hidden')).toBe('true');
    const img = ambient.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/render.jpg');
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('fetchpriority')).toBe('low');
    // It comes before the picture, so the picture paints over it.
    expect(ambient.nextElementSibling?.classList.contains('stage__picture')).toBe(true);
  });

  it('puts the overlay after the picture, in its own corner box', () => {
    const { container } = render(
      <Stage width={640} height={640} overlay={<button type="button">Before</button>}>
        <span />
      </Stage>,
    );
    const stage = container.querySelector('.stage')!;
    expect(stage.classList.contains('stage--overlay')).toBe(true);
    expect(stage.lastElementChild?.className).toBe('stage__overlay');
  });

  it('hangs what the top edge holds between the picture and the overlay, above the picture', () => {
    const { container } = render(
      <Stage
        width={640}
        height={640}
        top={<span className="hung" />}
        overlay={<button type="button">Before</button>}
      >
        <span />
      </Stage>,
    );
    const top = container.querySelector('.stage__top')!;
    expect(top.querySelector('.hung')).not.toBeNull();
    expect(top.previousElementSibling?.className).toBe('stage__picture');
    expect(top.nextElementSibling?.className).toBe('stage__overlay');
    const css = rule(stageCss, '.stage__top');
    expect(css).toContain('z-index: 3;');
    expect(css).toContain('pointer-events: none;');
    expect(css).toContain('inset: 0 0 auto 0;');
    // Above the picture (1) and below the controls (4).
    expect(rule(stageCss, '.stage__overlay')).toContain('z-index: 4;');
  });

  it('holds nothing at the top edge unless asked', () => {
    const { container } = render(
      <Stage width={640} height={640}>
        <span />
      </Stage>,
    );
    expect(container.querySelector('.stage__top')).toBeNull();
  });

  it('never divides by a zero size', () => {
    const { container } = render(
      <Stage width={0} height={0}>
        <span />
      </Stage>,
    );
    const stage = container.querySelector<HTMLElement>('.stage')!;
    expect(stage.style.getPropertyValue('--stage-w')).toBe('1');
    expect(stage.style.getPropertyValue('--stage-h')).toBe('1');
  });
});

describe('the stage stylesheet', () => {
  it('is imported once, globally, after the base stylesheet', () => {
    const imports = [...mainSource.matchAll(/^import '([^']+\.css)';$/gm)].map((m) => m[1]);
    expect(imports.filter((path) => path === './ui/stage.css')).toHaveLength(1);
    expect(imports.indexOf('./ui/stage.css')).toBe(imports.indexOf('./styles/global.css') + 1);
  });

  it('reaches both viewport edges from inside any column, on the ink ground', () => {
    const stage = rule(stageCss, '.stage');
    expect(stage).toContain('inline-size: 100vw;');
    expect(stage).toContain('margin-inline: calc(50% - 50vw);');
    expect(stage).toContain('background-color: var(--stage);');
    // The picture box plus the matte under it (none on phones).
    expect(stage).toContain('block-size: calc(var(--stage-block) + var(--stage-matte));');
    expect(stage).toContain('padding-block-end: var(--stage-matte);');
    expect(stage).not.toMatch(/(^|[ ;])border(-radius)?:|box-shadow:/);
    expect(rule(stageCss, '.page__main:has(.stage)')).toContain('overflow-x: clip;');
  });

  it('fills the first viewport under the header, leaving the peek, never above natural size', () => {
    const sizes = rule(stageCss, '.stage,\n.stage-scope');
    expect(sizes).toContain(
      '--stage-avail: calc(100vh - var(--header-height) - var(--stage-peek));',
    );
    expect(sizes).toContain('--stage-natural-h: calc(var(--stage-h, 1) * 1px);');
    expect(sizes).toContain('--stage-full-h: calc(100vw * var(--stage-h, 1) / var(--stage-w, 1));');
    // Phones: as tall as the picture at full width, capped at the first viewport.
    expect(sizes).toContain(
      '--stage-block: min(var(--stage-full-h), var(--stage-avail), var(--stage-natural-h));',
    );
    expect(plain(stageCss)).toContain(
      '--stage-avail: calc(100svh - var(--header-height) - var(--stage-peek));',
    );
    // From 600px: at least 320px (or the room there is), at most the natural height, and the
    // matte comes out of the room so the peek stays where it was.
    const wide = media(stageCss, '(min-width: 600px)');
    expect(wide).toContain('--stage-room: calc(var(--stage-avail) - var(--stage-matte));');
    expect(wide).toContain(
      '--stage-block: clamp( min(320px, var(--stage-room)), min(var(--stage-room), var(--stage-full-h)), var(--stage-natural-h) );',
    );
    expect(rule(stageCss, '.stage--picture')).toContain(
      '--stage-block: min(var(--stage-full-h), var(--stage-natural-h));',
    );
  });

  it('keeps 20px of ink under the picture from 600px, and none on phones', () => {
    expect(rule(stageCss, '.stage,\n.stage-scope')).toContain('--stage-matte: 0px;');
    expect(media(stageCss, '(min-width: 600px)')).toMatch(
      /\.stage, \.stage-scope \{ --stage-matte: 20px; \}/,
    );
  });

  it('keeps the peek on screen when the viewport is short (a landscape phone)', () => {
    // The floor is the smaller of 320px and the room under the header less the peek and matte:
    // at 844x390 that room is 390 - 72 - 104 - 20 = 194px, so the picture box is 194px tall
    // and the stage ends 104px above the bottom of the screen.
    const wide = media(stageCss, '(min-width: 600px)');
    expect(wide).toContain('min(320px, var(--stage-room))');
    const room = 390 - 72 - 104 - 20;
    const block = Math.min(Math.max(Math.min(320, room), room), 1024);
    expect(390 - (72 + block + 20)).toBe(104);
  });

  it('grounds the picture on a quiet vignette rather than a flat slab', () => {
    const stage = rule(stageCss, '.stage');
    expect(stage).toContain('--stage-glow: #1b1b1e;');
    expect(stage).toContain(
      'background-image: radial-gradient(120% 90% at 50% 40%, var(--stage-glow) 0%, var(--stage) 70%);',
    );
  });

  it('scales a frame laid out above its pixel size with smooth filtering', () => {
    const image = rule(stageCss, '.stage__picture > img,\n.stage__image');
    expect(image).toContain('image-rendering: smooth;');
    expect(image).not.toMatch(/pixelated|crisp-edges/);
  });

  it('puts the controls under the stage on paper as the paper switch, 44px targets', () => {
    expect(rule(stageCss, '.stage-controls')).toContain('justify-content: flex-end;');
    const paper = rule(stageCss, '.stage-controls .segmented--on-stage');
    expect(paper).toContain('background: var(--paper-raised);');
    expect(paper).toContain('backdrop-filter: none;');
    expect(rule(stageCss, '.stage-controls .segmented--on-stage button')).toContain(
      'min-inline-size: var(--target-comfort);',
    );
  });

  it('contains the picture: its own ratio, never wider than the stage or its natural width', () => {
    const picture = rule(stageCss, '.stage__picture');
    expect(picture).toContain('aspect-ratio: var(--stage-w, 1) / var(--stage-h, 1);');
    expect(picture).toContain('inline-size: min(100%, var(--stage-picture-inline));');
    expect(picture).toContain('max-inline-size: min(100%, var(--stage-natural-w));');
    expect(picture).toContain('max-block-size: 100%;');
    expect(rule(stageCss, '.stage__picture > img,\n.stage__image')).toContain(
      'object-fit: contain;',
    );
  });

  it('blurs and darkens the ambient layer, and shows it only from 900px', () => {
    expect(rule(stageCss, '.stage__ambient')).toContain('display: none;');
    const wide = media(stageCss, '(min-width: 900px)');
    expect(wide).toContain('filter: blur(48px) saturate(1.15) brightness(0.5);');
    expect(wide).toContain('transform: scale(1.15);');
    expect(wide).toContain('pointer-events: none;');
  });

  it('keeps the sheen short of the lower edge and draws no progress hairline', () => {
    // The sheen stops short of the picture's lower edge, where Street View marks sit.
    expect(rule(stageCss, '.stage__sheen')).toMatch(/mask-image: linear-gradient\(to bottom/);
    expect(plain(stageCss)).not.toContain('.stage__progress');
  });

  it('turns every motion off under reduced motion', () => {
    const reduced = media(stageCss, '(prefers-reduced-motion: reduce)');
    expect(reduced).toMatch(/\.stage__ambient img \{ animation: none; \}/);
    expect(reduced).toMatch(/\.stage__sheen \{ display: none; \}/);
  });

  it('draws focus on a picture surface as a white ring with an ink edge', () => {
    expect(rule(stageCss, '.stage :focus-visible')).toContain('box-shadow: var(--ring);');
  });

  it('keeps white type on the stage switch at 4.5:1 even over a white picture', () => {
    const glass = rule(stageCss, '.segmented--on-stage');
    const alpha = Number(/background: rgb\(var\(--scrim-rgb\) \/ ([0-9.]+)\)/.exec(glass)?.[1]);
    expect(alpha).toBeGreaterThan(0);
    expect(rule(stageCss, '.segmented--on-stage button')).toContain('color: var(--on-stage);');
    // The glass over pure white, then white type over that.
    const channel = alpha * 13 + (1 - alpha) * 255;
    const linear = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const ratio = 1.05 / (linear(channel) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the status card's white and muted white type at 4.5:1 over a white picture", () => {
    const card = rule(lookProgressCss, '.look-card--stage');
    expect(card).not.toMatch(/backdrop-filter/);
    const alpha = Number(/background: rgb\(var\(--scrim-rgb\) \/ ([0-9.]+)\)/.exec(card)?.[1]);
    expect(alpha).toBe(0.78);
    const linear = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    // The glass over pure white.
    const glass = alpha * 13 + (1 - alpha) * 255;
    const contrast = (text: number) => {
      const [hi, lo] = [linear(text), linear(glass)].sort((a, b) => b - a) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    // White, and white at 0.72 (--on-stage-muted) over that glass.
    const muted = 0.72 * 255 + (1 - 0.72) * glass;
    expect(contrast(255)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted)).toBeGreaterThanOrEqual(4.5);
    expect(rule(lookProgressCss, '.look-card--stage .look-card__hint')).toContain(
      'color: var(--on-stage-muted);',
    );
  });
});
