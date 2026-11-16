import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import peopleSheetSource from './PeopleSheet.tsx?raw';
import uploadEntrySource from './UploadEntryPage.tsx?raw';
import uploadPanelSource from './UploadPanel.tsx?raw';
import uploadCss from './upload.css?raw';

const plain = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const source = plain(uploadCss);
  const start = source.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = source.indexOf('{', start);
  return source.slice(open + 1, source.indexOf('}', open));
}

/** The relative luminance of a #rrggbb color (WCAG 2). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function token(name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, 'i').exec(tokensCss);
  if (!match) throw new Error(`no token ${name}`);
  return match[1]!;
}

/*
 * The base and upload stylesheets in the document, so computed styles follow the real cascade
 * (specificity, order and custom properties).
 */
const style = document.createElement('style');

beforeAll(() => {
  style.textContent = [tokensCss, globalCss.replace(/^@import [^;]+;$/gm, ''), uploadCss].join(
    '\n',
  );
  document.head.append(style);
});

afterAll(() => style.remove());
afterEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

const px = (value: string) => Number.parseFloat(value);

describe('the crop handles', () => {
  it('keep each 20px dot inside its corner of the frame, where the photo edge cannot clip it', () => {
    const body = mount(
      ['topLeft', 'topRight', 'bottomLeft', 'bottomRight']
        .map((corner) => `<button class="crop__handle crop__handle--${corner}"></button>`)
        .join(''),
    );
    const inset = px(/inset: (\d+)px;/.exec(rule('.crop__handle::after'))![1]!);
    const line = px(/border: (\d+)px solid/.exec(rule('.crop__shade'))![1]!);
    expect(line).toBe(2);
    for (const handle of body.querySelectorAll<HTMLElement>('.crop__handle')) {
      const computed = getComputedStyle(handle);
      const size = px(computed.width);
      expect(size).toBe(44);
      expect(size - 2 * inset).toBe(20);
      const [horizontal, vertical] = handle.className.includes('Left')
        ? [computed.left, computed.top === 'auto' ? computed.bottom : computed.top]
        : [computed.right, computed.top === 'auto' ? computed.bottom : computed.top];
      // The dot starts just inside the frame's line, where the photo's edge cannot clip it.
      expect(px(horizontal) + inset, handle.className).toBe(line);
      expect(px(vertical) + inset, handle.className).toBe(line);
      // The 44px target reaches past the corner.
      expect(px(horizontal), handle.className).toBeLessThan(0);
      expect(px(vertical), handle.className).toBeLessThan(0);
    }
  });
});

describe('the people prompt', () => {
  it('outlines each detected person in white with a dark edge, visible on any photo', () => {
    const glow = rule('.people-preview__glow');
    expect(glow).toMatch(/outline: 2px solid var\(--on-photo\);/);
    expect(glow).toMatch(/box-shadow: 0 0 0 1px rgb\(17 17 19 \/ 0\.55\);/);
    expect(glow).toMatch(/border-radius: var\(--radius-m\);/);
    expect(glow).not.toMatch(/radial-gradient|background:/);
  });

  it('lines up a wrapped text-link choice with the text above it', () => {
    expect([...peopleSheetSource.matchAll(/className="row people__actions"/g)]).toHaveLength(2);
    const body = mount(
      '<div class="row people__actions"><button class="button button--primary">Crop</button><button class="button button--quiet">Keep</button></div>',
    );
    expect(getComputedStyle(body.querySelector('.button--primary')!).marginLeft).toBe('0px');
    expect(getComputedStyle(body.querySelector('.button--quiet')!).marginLeft).toBe('-8px');
    // The negative margin is the quiet button's own inline padding.
    expect(getComputedStyle(body.querySelector('.button--quiet')!).paddingLeft).toBe('8px');
  });
});

describe('the straighten control', () => {
  it('draws its track at least 3:1 against the page, as a control boundary', () => {
    expect(rule('.straighten__track::before')).toMatch(/background: var\(--control-border\);/);
    const ratio =
      (luminance(token('--paper')) + 0.05) / (luminance(token('--control-border')) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it('keeps its thumb and its track 44px tall', () => {
    const body = mount(
      '<div class="straighten"><div class="straighten__track"><div class="straighten__thumb" role="slider"></div></div></div>',
    );
    const track = getComputedStyle(body.querySelector('.straighten__track')!);
    const thumb = getComputedStyle(body.querySelector('.straighten__thumb')!);
    expect(track.height).toBe('44px');
    expect(thumb.height).toBe('44px');
    expect(thumb.width).toBe('44px');
  });
});

describe('the age-and-rights checkbox', () => {
  it('makes its whole label a target at least 44px tall', () => {
    expect(uploadPanelSource).toContain('<div className="attest">');
    expect(rule('.attest .check')).toMatch(/min-height: var\(--target-comfort\);/);
    const body = mount(
      '<div class="attest"><label class="check"><input type="checkbox"><span class="check__text">I am 18</span></label></div>',
    );
    const label = getComputedStyle(body.querySelector('.check')!);
    expect(label.minHeight).toBe('44px');
    expect(label.alignContent).toBe('center');
  });
});

describe('the photo tips', () => {
  it('turn the chevron over when open, instead of a plus and minus sign', () => {
    expect(plain(uploadCss)).not.toMatch(/\.tips[^{]*summary::after/);
    const body = mount(
      '<details class="tips"><summary>Tips<svg class="icon tips__chevron"></svg></summary></details>',
    );
    const chevron = body.querySelector('.tips__chevron')!;
    expect(getComputedStyle(chevron).transform).toBe('none');
    expect(getComputedStyle(chevron).marginLeft).toBe('auto');
    body.querySelector('details')!.open = true;
    expect(getComputedStyle(chevron).transform).toBe('rotate(180deg)');
  });
});

describe('the upload screen', () => {
  it('starts its photograph or its stage right under the header, with no padding above', () => {
    expect(rule('.project:has(.upload-step)')).toMatch(/padding-block: 0;/);
  });

  it('gives the dock title the same weight and tracking on /upload and on the step itself', () => {
    expect(uploadEntrySource).toContain('className="upload upload--dock upload--entry stack"');
    expect(uploadEntrySource).toContain('<h1 className="title-section">');
    expect(uploadPanelSource).toContain('upload upload--dock stack');
    const body = mount(
      [
        '<div class="hero-dock upload upload--dock"><header class="upload__header">',
        '<h1 class="title-section" id="dock">Upload a photo</h1></header></div>',
        '<section><header class="upload__header"><h2 class="title-section" id="step">Upload</h2>',
        '</header></section>',
      ].join(''),
    );
    const dock = getComputedStyle(body.querySelector('#dock')!);
    const step = getComputedStyle(body.querySelector('#step')!);
    expect(dock.fontWeight).toBe('700');
    expect(Number.parseFloat(dock.letterSpacing)).toBeLessThan(0);
    expect(dock.letterSpacing).not.toBe(step.letterSpacing);
    // Inside another screen's column it stays a section title.
    expect(step.fontWeight).toBe('600');
  });

  it('sits at the lower left from 600px and at the top under the header on phones', () => {
    const wide =
      /@media \(min-width: 600px\) \{\s*\.upload-hero \.hero-frame__content \{([^}]*)\}/.exec(
        plain(uploadCss),
      )?.[1];
    expect(wide).toMatch(/justify-content: flex-end;/);
    expect(wide).toMatch(
      /padding-inline-start: max\(clamp\(24px, 5vw, 96px\), var\(--safe-left\)\);/,
    );
    expect(wide).toMatch(/padding-block-end: clamp\(32px, 7svh, 88px\);/);
    // Under 600px the frame's own content block (top, under the header) is kept.
    expect(plain(uploadCss).match(/\.upload-hero \.hero-frame__content \{/g)).toHaveLength(1);
  });

  it('deepens the band behind the header on phones, fading out well above the dock', () => {
    const phone = /@media \(max-width: 599px\) \{\s*\.upload-hero \{([^}]*)\}/.exec(
      plain(uploadCss),
    )?.[1];
    expect(phone).toMatch(/--hero-scrim: linear-gradient\(/);
    expect(phone).toMatch(/rgb\(var\(--scrim-rgb\) \/ 0\.24\) 0/);
    expect(phone).toMatch(
      /rgb\(var\(--scrim-rgb\) \/ 0\) calc\(var\(--header-height\) \+ var\(--safe-top\) \+ 32px\)/,
    );
  });

  it('rises in once, and stays put when it continues the dock of /upload', () => {
    expect(rule('.upload--dock')).toMatch(/animation: rise-in var\(--dur-rise\) var\(--ease-out\)/);
    expect(rule('.upload--continues')).toMatch(/animation: none;/);
  });

  it('dims the photograph under a dashed frame while a photo is dragged over it', () => {
    const frame = rule('.upload-screen .hero-frame::after');
    expect(frame).toMatch(/border: 2px dashed var\(--on-stage\);/);
    expect(frame).toMatch(/opacity: 0;/);
    expect(frame).toMatch(/pointer-events: none;/);
    expect(rule('.upload-screen[data-dragging] .hero-frame::after')).toMatch(/opacity: 1;/);
  });

  it('lines the paper under the stage up with the picture and stops the sweep under reduced motion', () => {
    expect(rule('.upload__under')).toMatch(
      /inline-size: min\(100% - 2 \* var\(--gutter\), max\(var\(--stage-picture-inline, 100vw\), 40rem\)\);/,
    );
    expect(plain(uploadCss)).toMatch(
      /prefers-reduced-motion: reduce\) \{\s*\.upload__rail\[data-state='working'\]::after \{[^}]*animation: none;/,
    );
  });
});
