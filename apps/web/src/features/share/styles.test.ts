import { describe, expect, it } from 'vitest';
import shareCss from './share.css?raw';
import shareSheet from './ShareSheet.tsx?raw';

const plain = shareCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = plain.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = plain.indexOf('{', start);
  return plain.slice(open + 1, plain.indexOf('}', open));
}

describe('the public share page', () => {
  it('keeps the brand at the top left, as every other page does', () => {
    expect(plain).not.toMatch(/\.share-page-app__header\s*\{/);
  });

  it('starts the stage right under the header, with no column or gutter around it', () => {
    expect(rule('.share-page-app__main')).toMatch(/padding: 0 0 var\(--space-8\);/);
    expect(rule('.share-page-app__main')).not.toMatch(/max-width/);
    expect(plain).not.toMatch(/\.shared__card|box-shadow: var\(--shadow-panel\)/);
  });

  it('keeps room under the stage on phones for the headline and the button', () => {
    expect(plain).toMatch(
      /@media \(max-width: 599px\) \{\s*\.share-page-app \{\s*--stage-peek: 184px;\s*\}\s*\}/,
    );
  });

  it('lines the paper under the stage up with the picture, never narrower than a text column', () => {
    const below = rule('.share-page-app__below');
    expect(below).toMatch(/--share-below: max\(var\(--stage-picture-inline, 100vw\), 54rem\);/);
    expect(below).toMatch(/inline-size: min\(100%, var\(--share-below\)\);/);
  });

  it('sets the headline as a title in the one sans face, on one row with the call to action', () => {
    const caption = rule('.share-page-app__caption');
    expect(caption).toMatch(/font-weight: var\(--weight-semibold\);/);
    expect(caption).toMatch(/letter-spacing: var\(--tracking-title\);/);
    expect(plain).not.toMatch(/font-display|italic|serif/);
    const row = rule('.share-page-app__text');
    expect(row).toMatch(/display: flex;/);
    expect(row).toMatch(/justify-content: space-between;/);
    expect(plain).toMatch(
      /@media \(max-width: 599px\) \{\s*\.share-page-app__text \{\s*flex-direction: column;/,
    );
  });

  it('plays the arrival once, and not again when the app takes over the painted page', () => {
    expect(rule('.shared__stage .stage__picture')).toMatch(/animation: share-reveal /);
    expect(rule('.shared--continues .shared__stage .stage__picture')).toMatch(
      /animation-delay: calc\(-1 \* var\(--share-elapsed, 1200ms\)\);/,
    );
  });

  it('centers the page for a link that no longer works', () => {
    const gone = rule('.share-page-app__gone');
    expect(gone).toMatch(/align-items: center;/);
    expect(gone).toMatch(/text-align: center;/);
  });
});

describe('the share sheet', () => {
  it('frames the card preview with a hairline instead of a shadow', () => {
    expect(rule('.share-card__frame')).toMatch(/border: 1px solid var\(--line\);/);
    expect(rule('.share-card__frame')).not.toMatch(/box-shadow/);
  });

  it('keeps one solid action: the other choices are text', () => {
    expect(shareSheet).not.toMatch(/className="button"/);
    expect(shareSheet.match(/className="button button--quiet"/g)).toHaveLength(2);
    expect(plain).not.toMatch(/--accent|--danger/);
  });
});

describe('text links on the share screens', () => {
  it('line up the word "Stop sharing" with the text above it', () => {
    expect(rule('.share__stop')).toMatch(/margin-left: calc\(-1 \* var\(--space-2\)\);/);
    expect(rule('.share__stop')).toMatch(/align-self: flex-start;/);
  });

  it('keep the comfortable touch height on the public share page', () => {
    expect(rule('.share-page-app__more .link-button')).toMatch(
      /min-height: var\(--target-comfort\);/,
    );
  });
});
