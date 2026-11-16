import { describe, expect, it } from 'vitest';
import accountCss from '../features/account/account.css?raw';
import galleryCss from '../features/gallery/gallery.css?raw';
import shareCss from '../features/share/share.css?raw';
import globalCss from '../styles/global.css?raw';
import { aiBadgeCorner, cornerClassName, isStreetViewVariant, thumbClassName } from './badgeCorner';

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('AI preview badge corner', () => {
  it('is the upper left on Street View frames and the lower right otherwise', () => {
    expect(aiBadgeCorner(true)).toBe('upper-left');
    expect(aiBadgeCorner(false)).toBe('lower-right');
    expect(cornerClassName('image-card__corner', 'upper-left')).toBe(
      'image-card__corner image-card__corner--upper-left',
    );
  });

  it('treats attributed, Street View and fixture Street View variants as Street View frames', () => {
    const source = { sourceAssetId: 'source-1', kind: 'upload' as const };
    const own = { sourceAssetId: 'source-1', attribution: null };
    expect(isStreetViewVariant(own, source)).toBe(false);
    expect(isStreetViewVariant(own, { ...source, kind: 'street_view' })).toBe(true);
    expect(isStreetViewVariant(own, { ...source, kind: 'fixture' })).toBe(true);
    expect(
      isStreetViewVariant(
        { ...own, attribution: { required: true, text: '© 2026 Google', logo: 'google_maps' } },
        source,
      ),
    ).toBe(true);
    // The active source describes only the variants made from it.
    expect(
      isStreetViewVariant(
        { ...own, sourceAssetId: 'source-2' },
        { ...source, kind: 'street_view' },
      ),
    ).toBe(false);
  });

  it.each([
    ['result, share page and examples', globalCss, '.image-card__corner'],
    ['gallery tiles', galleryCss, '.gallery__badge'],
    ['Your places thumbnails', accountCss, '.place__badge'],
    ['share card preview', shareCss, '.share-card__badge'],
  ])(
    'anchors the upper-left modifier of the %s badge to the top and left edges',
    (_, css, base) => {
      const upperLeft = rule(css, `${base}--upper-left`);
      expect(upperLeft).toMatch(/\btop:\s*(?!auto)[^;]+;/);
      expect(upperLeft).toMatch(/\bleft:\s*(?!auto)[^;]+;/);
      // The base rule's lower-right anchors are released, so the badge does not stretch.
      expect(upperLeft).toMatch(/\bbottom:\s*auto;/);
      expect(css).not.toMatch(new RegExp(`${base.replace('.', '\\.')}--lower-left`));
    },
  );
});

describe('Street View thumbnail crop', () => {
  it('adds the Street View modifier only to Street View-origin thumbnails', () => {
    expect(thumbClassName('gallery__thumb', true)).toBe(
      'gallery__thumb gallery__thumb--street-view',
    );
    expect(thumbClassName('place__thumb', false)).toBe('place__thumb');
  });

  it.each([
    ['gallery tiles', galleryCss, '.gallery__thumb--street-view img'],
    ['Your places thumbnails', accountCss, '.place__thumb--street-view img'],
  ])('keeps the bottom edge of the frame in the %s crop', (_, css, selector) => {
    expect(rule(css, selector)).toMatch(/object-position:\s*50% 100%;/);
  });
});
