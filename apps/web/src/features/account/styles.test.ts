import { describe, expect, it } from 'vitest';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import accountPage from './AccountPage.tsx?raw';
import accountCss from './account.css?raw';
import placesPage from './PlacesPage.tsx?raw';
import saveSheet from './SaveSheet.tsx?raw';
import verifyPage from './VerifyPage.tsx?raw';

const plain = accountCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = plain.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = plain.indexOf('{', start);
  return plain.slice(open + 1, plain.indexOf('}', open));
}

describe('Your places', () => {
  it('lays the places out as a wall of picture cards reaching the viewport edges', () => {
    const wall = rule('.places');
    expect(wall).toMatch(/display: grid;/);
    expect(wall).toMatch(/gap: 4px;/);
    expect(wall).toMatch(/grid-template-columns: minmax\(0, 1fr\);/);
    expect(wall).not.toMatch(/border|border-radius|box-shadow/);
    expect(plain).toMatch(
      /@media \(min-width: 600px\) \{\s*\.places \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(plain).toMatch(
      /@media \(min-width: 1200px\) \{\s*\.places \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
    );
    expect(placesPage).toContain('<section className="places-page">');
    expect(placesPage).not.toContain('container--narrow');
  });

  it('keeps the title block compact on phones and short screens, as the gallery does', () => {
    expect(plain).toMatch(
      /@media \(max-width: 599px\), \(max-height: 479px\) \{\s*\.places__head \{\s*padding-block: var\(--space-4\) var\(--space-2\);/,
    );
  });

  it('shows the newest look large, with no card chrome, and keeps the Street View crop', () => {
    const thumb = rule('.place__thumb');
    expect(thumb).toMatch(/width: 100%;/);
    expect(thumb).toMatch(/aspect-ratio: 4 \/ 3;/);
    expect(thumb).not.toMatch(/border|border-radius|box-shadow/);
    expect(rule('.place')).not.toMatch(/border|border-radius|box-shadow/);
    expect(rule('.place__thumb--street-view img')).toMatch(/object-position: 50% 100%;/);
  });

  it('makes the whole card one link to the place, with nothing laid over the picture', () => {
    expect(placesPage).toMatch(
      /<Link\s+to=\{`\/p\/\$\{project\.id\}`\}\s+className="place__link"\s+aria-labelledby=\{titleId\}/,
    );
    expect(placesPage).not.toContain('place__picture');
    expect(placesPage).not.toMatch(/<Link[^>]*className="place__title"/);
    // The picture sits inside the link: no transparent layer covers it (and so Google's marks on
    // a Street View frame).
    expect(plain).not.toMatch(/\.place__title::after|\.place::after|\.place__thumb::after/);
    expect(plain).not.toMatch(/\.place__link::(after|before)/);
    const ring = rule('.place__link:focus-visible');
    expect(ring).toMatch(/outline: 2px solid var\(--ink\);/);
    expect(ring).toMatch(/outline-offset: 1px;/);
    expect(
      rule('.place__link:hover .place__title,\n.place__link:focus-visible .place__title'),
    ).toMatch(/text-decoration-color: currentColor;/);
  });

  it('shows the source of a place without a look: a photo filled, a Street View frame whole on ink', () => {
    expect(rule('.place__thumb--source-frame')).toMatch(/background-color: var\(--stage\);/);
    expect(rule('.place__thumb--source-frame')).toMatch(
      /radial-gradient\(120% 90% at 50% 40%, #1b1b1e 0%, var\(--stage\) 70%\)/,
    );
    expect(rule('.place__thumb--source-frame img')).toMatch(/object-fit: contain;/);
    // The uploaded photo keeps the default cover.
    expect(rule('.place__thumb img')).toMatch(/object-fit: cover;/);
    expect(plain).not.toMatch(/\.place__thumb--source-frame img \{[^}]*object-position/);
  });

  it('lays the card link out as one column holding the picture and its caption', () => {
    const style = document.createElement('style');
    style.textContent = [tokensCss, globalCss.replace(/^@import [^;]+;$/gm, ''), accountCss].join(
      '\n',
    );
    document.head.append(style);
    try {
      document.body.innerHTML =
        '<ul class="places"><li class="place"><a class="place__link" href="/p/1"><span class="place__thumb"></span><span class="place__text"><span class="place__title">A</span></span></a></li></ul>';
      const link = getComputedStyle(document.querySelector('.place__link')!);
      expect(link.display).toBe('flex');
      expect(link.flexDirection).toBe('column');
    } finally {
      style.remove();
      document.body.innerHTML = '';
    }
  });

  it('titles each place as an item, not in a display face', () => {
    expect(rule('.place__title')).toMatch(/font-weight: var\(--weight-semibold\);/);
    expect(rule('.place__title')).toMatch(/font-size: var\(--text-l\);/);
    expect(plain).not.toMatch(/font-display|italic|serif/);
  });

  it('marks photographs with the dark badge and an empty place with its holiday dot', () => {
    expect(rule('.place__badge')).toMatch(/background: var\(--glass-dark\);/);
    expect(rule('.place__badge')).toMatch(/color: var\(--on-photo\);/);
    expect(rule('.place__swatch,\n.place__dot')).toMatch(/background: var\(--holiday-dot\);/);
    expect(rule('.place__swatch,\n.place__dot')).not.toMatch(/box-shadow/);
    expect(plain).not.toMatch(/rgb\(|--accent/);
  });

  it('spaces the links in the page head and sets the card actions as text', () => {
    expect(rule('.places__links')).toMatch(/gap:/);
    expect(placesPage).toContain('className="button button--small button--quiet">');
    expect(placesPage).toContain('className="button button--small button--quiet place__delete"');
  });
});

describe('Your account and saving', () => {
  it('labels the email as a small label and keeps the card in its own rhythm', () => {
    expect(accountPage).toContain(`<p className="eyebrow">{t('account.emailLabel')}</p>`);
    expect(accountPage).toContain('className="card stack account__card"');
    expect(rule('.account__card')).toMatch(/--stack-gap: var\(--space-3\);/);
    expect(rule('.account__email')).toMatch(/font-weight: var\(--weight-semibold\);/);
  });

  it('keeps the card at 12px between its lines, after the base stack rule in the cascade', () => {
    const style = document.createElement('style');
    style.textContent = [tokensCss, globalCss.replace(/^@import [^;]+;$/gm, ''), accountCss].join(
      '\n',
    );
    document.head.append(style);
    try {
      document.body.innerHTML =
        '<section class="stack stack--loose"><div class="card stack account__card"></div></section>';
      expect(getComputedStyle(document.querySelector('.account__card')!).rowGap).toBe('12px');
    } finally {
      style.remove();
      document.body.innerHTML = '';
    }
  });

  it('styles the email a link was sent to', () => {
    expect(saveSheet).toContain("import './account.css';");
    expect(rule('.save__email')).toMatch(/font-weight: var\(--weight-semibold\);/);
  });

  it('draws secondary actions as text, never as outlined buttons', () => {
    for (const source of [accountPage, placesPage, verifyPage, saveSheet]) {
      expect(source).not.toMatch(/className="button( button--small)?"/);
    }
  });
});

describe('the text links of Your places', () => {
  it('keep the comfortable touch height', () => {
    expect(rule('.places__links .link-button')).toMatch(/min-height: var\(--target-comfort\);/);
  });
});
