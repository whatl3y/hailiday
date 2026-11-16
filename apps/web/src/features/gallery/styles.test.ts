import { afterEach, describe, expect, it } from 'vitest';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import stageCss from '../../ui/stage.css?raw';
import galleryCss from './gallery.css?raw';
import galleryPage from './GalleryPage.tsx?raw';
import galleryViewer from './GalleryViewer.tsx?raw';

const plain = galleryCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string, css = plain): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

/** The body of the `@media (min-width: <width>px)` block that holds a rule for `selector`. */
function mediaRule(width: number, selector: string): string {
  const pattern = new RegExp(
    `@media \\(min-width: ${width}px\\) \\{\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`,
  );
  const match = pattern.exec(plain);
  if (!match) throw new Error(`no ${width}px rule for ${selector}`);
  return match[1]!;
}

describe('the gallery wall', () => {
  it('reaches the viewport edges: the page is not a centered column', () => {
    expect(galleryPage).toContain('<section className="gallery" aria-busy=');
    expect(galleryPage).not.toMatch(/className="container gallery/);
    expect(rule('.gallery')).not.toMatch(/max-width|padding-inline/);
    // The text on paper keeps the page gutter.
    expect(rule('.gallery__head,\n.gallery__note,\n.gallery__more-row')).toMatch(
      /padding-inline: max\(var\(--gutter\), var\(--safe-left\)\) max\(var\(--gutter\), var\(--safe-right\)\);/,
    );
  });

  it('sets the pictures 4px apart in one column, two from 600px, three from 1024px, four from 1600px', () => {
    const wall = rule('.gallery__wall');
    expect(wall).toMatch(/gap: 4px;/);
    expect(wall).toMatch(/grid-template-columns: minmax\(0, 1fr\);/);
    expect(wall).not.toMatch(/border|border-radius|box-shadow/);
    expect(mediaRule(600, '.gallery__wall')).toMatch(/repeat\(2, minmax\(0, 1fr\)\)/);
    expect(mediaRule(1024, '.gallery__wall')).toMatch(/repeat\(3, minmax\(0, 1fr\)\)/);
    expect(mediaRule(1600, '.gallery__wall')).toMatch(/repeat\(4, minmax\(0, 1fr\)\)/);
  });

  it('has no card chrome and no framed-grid hairlines', () => {
    // The base stylesheet draws hairlines on `.gallery__grid > .gallery__item`; the wall is a
    // different list, so none reach it.
    expect(galleryPage).not.toContain('gallery__grid');
    expect(rule('.gallery__tile')).not.toMatch(/border-radius|box-shadow|border: 1px/);
    expect(rule('.gallery__thumb')).not.toMatch(/border|border-radius|box-shadow/);
  });

  it('shows each picture whole at its own proportions in one column and crops to 4:3 from 600px', () => {
    expect(rule('.gallery__thumb')).toMatch(/aspect-ratio: var\(--tile-ratio, 4 \/ 3\);/);
    expect(mediaRule(600, '.gallery__thumb')).toMatch(/aspect-ratio: 4 \/ 3;/);
    expect(galleryPage).toContain(
      "<span className={thumbClassName('gallery__thumb', streetView)} style={thumbStyle}>",
    );
    expect(galleryPage).toContain("'--tile-ratio':");
    expect(galleryPage).not.toMatch(/aspectRatio/);
  });

  it('keeps the bottom of a Street View frame in the crop', () => {
    expect(rule('.gallery__thumb--street-view img')).toMatch(/object-position: 50% 100%;/);
  });

  it('draws the focus ring in the gap around the tile, never over the picture', () => {
    const ring = rule('.gallery__tile:focus-visible');
    expect(ring).toMatch(/outline: 2px solid var\(--ink\);/);
    expect(ring).toMatch(/outline-offset: 1px;/);
    // The ring and its offset stay inside the 4px gap.
    expect(plain).not.toMatch(/\.gallery__tile:focus-visible::after/);
    expect(
      rule('.gallery__tile:hover .gallery__look,\n.gallery__tile:focus-visible .gallery__look'),
    ).toMatch(/text-decoration-color: currentColor;/);
  });

  it('draws Load more as a text link', () => {
    expect(galleryPage).toContain('className="button button--quiet gallery__more"');
  });

  it('sets the dates in the monospace face and the look as an item title', () => {
    expect(rule('.gallery__date')).toMatch(/font-family: var\(--font-mono\);/);
    expect(rule('.gallery__date')).toMatch(/color: var\(--ink-muted\);/);
    expect(rule('.gallery__look')).toMatch(/font-weight: var\(--weight-semibold\);/);
    expect(plain).not.toMatch(/font-display|italic|serif|rgb\(/);
  });

  it('opens each place with a hairline between the gutters and a section title', () => {
    const heading = rule('.gallery__heading');
    expect(heading).toMatch(/border-top: 1px solid var\(--line\);/);
    expect(heading).toMatch(/margin-inline: max\(var\(--gutter\)/);
    expect(heading).toMatch(/font-size: var\(--text-2xl\);/);
  });

  it('keeps the title block compact on phones and short screens, with the place name at --text-l', () => {
    const phones =
      /@media \(max-width: 599px\), \(max-height: 479px\) \{([\s\S]*?)\n\}/.exec(plain)?.[1] ?? '';
    expect(phones).toMatch(
      /\.gallery__head \{\s*padding-block: var\(--space-4\) var\(--space-2\);/,
    );
    expect(phones).toMatch(/\.gallery__group \{\s*margin-top: var\(--space-2\);/);
    expect(phones).toMatch(
      /\.gallery__heading \{\s*padding-block: var\(--space-4\) var\(--space-3\);\s*font-size: var\(--text-l\);/,
    );
  });

  it('puts the date on its own line under the look at every size', () => {
    const line = rule('.gallery__line');
    expect(line).toMatch(/flex-direction: column;/);
    expect(line).toMatch(/align-items: flex-start;/);
    expect(line).not.toMatch(/flex-wrap|space-between/);
    expect(plain).not.toMatch(/@media[^{]*\{\s*\.gallery__line/);
  });

  it('gives the empty state link its own width and a comfortable touch target', () => {
    const link = rule('.gallery__note .link-button');
    expect(link).toMatch(/align-self: flex-start;/);
    expect(link).toMatch(/min-height: var\(--target-comfort\);/);
  });
});

describe('the gallery viewer', () => {
  it('is a full-screen ink lightbox with white type', () => {
    const box = rule('.lightbox');
    expect(box).toMatch(/position: fixed;/);
    expect(box).toMatch(/inset: 0;/);
    expect(box).toMatch(/background: var\(--stage\);/);
    expect(box).toMatch(/color: var\(--on-stage\);/);
    expect(box).toMatch(/grid-template-rows: auto minmax\(0, 1fr\) auto;/);
    expect(galleryViewer).not.toContain('<Sheet');
  });

  it('fades in and out', () => {
    expect(rule('.lightbox')).toMatch(/animation: fade-in var\(--dur-med\)/);
    expect(rule('.lightbox--closing')).toMatch(/opacity: 0;/);
  });

  it('sizes the picture to the largest box that fits, never above its natural size', () => {
    expect(rule('.lightbox__stage')).toMatch(/container-type: size;/);
    const picture = rule('.lightbox__picture');
    expect(picture).toMatch(/aspect-ratio: var\(--picture-w, 1\) \/ var\(--picture-h, 1\);/);
    expect(picture).toMatch(/var\(--lightbox-avail-w\),/);
    expect(picture).toMatch(/calc\(var\(--picture-w, 1\) \* 1px\),/);
    expect(picture).toMatch(/calc\(100cqh \* var\(--picture-w, 1\) \/ var\(--picture-h, 1\)\)/);
    expect(rule('.lightbox__picture .gallery-viewer__image')).toMatch(/object-fit: contain;/);
  });

  it('colors the ground from the rendering only, faded out under the bars', () => {
    expect(galleryViewer).toMatch(
      /className="stage__ambient lightbox__ambient"[^>]*>\s*<img src=\{item\.imageUrl\}/,
    );
    expect(rule('.lightbox__ambient')).toMatch(
      /mask-image: linear-gradient\(to bottom, transparent 0/,
    );
    // The ambient layer shows from 900px only (the stage's own rule).
    expect(stageCss).toMatch(/\.stage__ambient \{\s*display: none;/);
  });

  it('draws focus as a white ring on the ink and inverts the one solid action', () => {
    expect(rule('.lightbox :focus-visible')).toMatch(/outline: 2px solid var\(--on-stage\);/);
    const open = rule('.lightbox__open,\n.lightbox__open:hover');
    expect(open).toMatch(/--button-bg: var\(--on-stage\);/);
    expect(open).toMatch(/--button-fg: var\(--stage\);/);
  });

  it('keeps its text links at the comfortable touch height', () => {
    expect(rule('.gallery__head .link-button,\n.lightbox__link')).toMatch(
      /min-height: var\(--target-comfort\);/,
    );
    expect(rule('.lightbox__icon-button')).toMatch(/width: var\(--target-comfort\);/);
    expect(rule('.lightbox__icon-button')).toMatch(/height: var\(--target-comfort\);/);
  });

  it('sets the date in the monospace face', () => {
    expect(galleryViewer).toContain('className="gallery-viewer__date"');
    expect(rule('.gallery-viewer__date')).toMatch(/font-family: var\(--font-mono\);/);
  });
});

describe('the gallery in the cascade', () => {
  const style = document.createElement('style');

  afterEach(() => {
    style.remove();
    document.body.innerHTML = '';
  });

  it('lays the wall out from the real stylesheets', () => {
    style.textContent = [
      tokensCss,
      globalCss.replace(/^@import [^;]+;$/gm, ''),
      stageCss,
      galleryCss,
    ].join('\n');
    document.head.append(style);
    document.body.innerHTML = [
      '<section class="gallery"><div class="gallery__head"></div>',
      '<div class="stack gallery__note" id="empty"><p class="lede">Nothing yet</p>',
      '<a class="link-button" id="home" href="/">Back</a></div>',
      '<ul class="gallery__wall"><li class="gallery__item"><button class="gallery__tile">',
      '<span class="gallery__thumb gallery__thumb--street-view" style="--tile-ratio: 1 / 1"><img></span>',
      '</button></li></ul></section>',
    ].join('');
    const wall = getComputedStyle(document.querySelector('.gallery__wall')!);
    const item = getComputedStyle(document.querySelector('.gallery__item')!);
    const empty = getComputedStyle(document.querySelector('#empty')!);
    const head = getComputedStyle(document.querySelector('.gallery__head')!);
    expect(wall.display).toBe('grid');
    expect(wall.rowGap).toBe('4px');
    expect(wall.paddingLeft).toBe('0px');
    expect(item.minWidth).toBe('0px');
    expect(empty.rowGap).toBe('16px');
    expect(head.paddingTop).toBe('32px');
    const home = getComputedStyle(document.querySelector('#home')!);
    expect(home.minHeight).toBe('44px');
    expect(home.alignSelf).toBe('flex-start');
  });

  it('lays the lightbox over the whole screen on the stage ground', () => {
    style.textContent = [tokensCss, globalCss.replace(/^@import [^;]+;$/gm, ''), galleryCss].join(
      '\n',
    );
    document.head.append(style);
    document.body.innerHTML = '<div class="lightbox"><div class="lightbox__stage"></div></div>';
    const box = getComputedStyle(document.querySelector('.lightbox')!);
    expect(box.position).toBe('fixed');
    expect(box.zIndex).toBe('60');
    expect(box.backgroundColor).toBe('rgb(13, 13, 15)');
    expect(box.color).toBe('rgb(255, 255, 255)');
  });
});
