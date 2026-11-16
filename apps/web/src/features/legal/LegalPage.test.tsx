import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import legalCss from './legal.css?raw';
import { LegalPage, NotFoundPage } from './LegalPage';

vi.mock('../../api/endpoints', () => ({
  sendAnalytics: vi.fn(async () => undefined),
  hasSession: vi.fn(() => false),
  onSessionReady: vi.fn(() => () => undefined),
}));

const plain = legalCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const start = plain.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = plain.indexOf('{', start);
  return plain.slice(open + 1, plain.indexOf('}', open));
}

afterEach(() => {
  cleanup();
});

describe('a legal page', () => {
  it('reads as a document: kicker, title, the draft notice, then the summary in a framed note', () => {
    const { container } = render(
      <MemoryRouter>
        <LegalPage page="terms" />
      </MemoryRouter>,
    );
    const article = container.querySelector('article.legal');
    if (!article) throw new Error('legal article missing');
    const order = [...article.children].map((child) => child.className);
    expect(order).toEqual([
      'legal__kicker',
      'simple-page__title legal__title',
      'legal__notice',
      'prose legal__prose',
    ]);
    expect(article.querySelector('.legal__kicker')?.textContent).toBe('Draft');
    expect(article.querySelector('.legal__dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(article.querySelector('h1')?.textContent).toBe('Terms of use');
    expect(article.querySelector('.legal__lede')?.textContent).toMatch(/18 or older/);
    expect(article.querySelector('.badge')).toBeNull();
  });

  it('keeps the report anchor on the content policy', () => {
    const { container } = render(
      <MemoryRouter>
        <LegalPage page="contentPolicy" />
      </MemoryRouter>,
    );
    expect(container.querySelector('article.legal')?.id).toBe('report');
  });

  it("takes progy's legal type: tracked kicker, a measured column and a framed light lede", () => {
    expect(rule('.legal')).toMatch(/max-width: calc\(var\(--measure\) \+ 2 \* var\(--gutter\)\);/);
    expect(rule('.legal__kicker')).toMatch(/letter-spacing: var\(--tracking-eyebrow\);/);
    expect(rule('.legal__kicker')).toMatch(/color: var\(--ink-muted\);/);
    expect(rule('.legal__lede')).toMatch(/border: 1px solid var\(--line-strong\);/);
    expect(rule('.legal__lede')).toMatch(/font-weight: var\(--weight-light\);/);
    expect(rule('.legal__notice')).toMatch(/color: var\(--ink-muted\);/);
    expect(plain).not.toMatch(/font-display|italic|serif|--accent/);
  });
});

describe('the not-found page', () => {
  it("rests the message and the way home in the dock on the season's photograph", () => {
    const { container } = render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(container.querySelector('.site-header')?.classList.contains('site-header--photo')).toBe(
      true,
    );
    const dock = container.querySelector(
      '.hero-frame.not-found > .hero-frame__content > .hero-dock',
    );
    const heading = dock?.querySelector('h1.title-section');
    expect(heading?.textContent).toBe("We couldn't find that");
    expect(document.activeElement).toBe(heading);
    expect(dock?.querySelector('.lede')?.textContent).toBe(
      'It may have been removed, or the link is wrong.',
    );
    expect(dock?.querySelector('a.button--primary')?.getAttribute('href')).toBe('/');
    expect(container.querySelectorAll('.button--primary')).toHaveLength(1);
  });

  it('gives the way back its own width and a display title', () => {
    const { container } = render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(container.querySelector('.not-found .button--primary')?.textContent).toBe(
      'Back to the start',
    );
    expect(rule('.not-found .button')).toMatch(/align-self: flex-start;/);
    expect(rule('.not-found .title-section')).toMatch(/font-weight: var\(--weight-bold\);/);
  });

  it('sits at the lower left from 600px and rises in once', () => {
    expect(plain).toMatch(
      /@media \(min-width: 600px\) \{\s*\.not-found \.hero-frame__content \{[^}]*justify-content: flex-end;/,
    );
    expect(rule('.not-found__dock')).toMatch(/animation: rise-in /);
    // On phones a deeper band sits behind the header's white type over the photograph.
    expect(plain).toMatch(
      /@media \(max-width: 599px\) \{\s*\.not-found \{\s*--hero-scrim: linear-gradient\(/,
    );
  });
});
