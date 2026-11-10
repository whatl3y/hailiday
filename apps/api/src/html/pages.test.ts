import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ShareView } from '@holiday/core';
import type { ApiDeps } from '../deps.js';
import { aiBadgeCorner, landingPanelMarkup, renderShareGone, renderSharePage } from './pages.js';
import { FALLBACK_TEMPLATE } from './shell.js';

function shareView(overrides: Partial<ShareView> = {}): ShareView {
  return {
    holidayId: 'christmas',
    style: 'classic',
    imageUrl: 'https://cdn.test/after.jpg',
    beforeImageUrl: null,
    width: 1600,
    height: 1200,
    labelKey: 'result.aiPreview',
    attribution: null,
    createdAt: '2026-11-09T12:00:00.000Z',
    expiresAt: '2026-12-09T12:00:00.000Z',
    report: { targetKind: 'share' },
    ...overrides,
  };
}

const deps = {
  web: { distDir: null, template: FALLBACK_TEMPLATE, built: false },
  config: {
    publicBaseUrl: 'http://localhost:8080',
    appEnv: 'test',
    turnstile: { mode: 'fixture', siteKey: '' },
  },
} as unknown as ApiDeps;

function sharePage(view: ShareView): string {
  return renderSharePage(deps, { token: 'tok', view, cardUrl: null, siteImage: null });
}

function badgeOf(html: string): string {
  const match =
    /<div class="image-card__corner [^"]*share-page__badge[^"]*"[^>]*><span class="badge badge--ai">AI preview<\/span><\/div>/.exec(
      html,
    );
  if (!match) throw new Error('share page badge missing');
  return match[0];
}

/** Every stylesheet of the web app, concatenated. */
function webStylesheets(): string {
  const root = fileURLToPath(new URL('../../../web/src/', import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.css')) files.push(readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files.join('\n');
}

/** The class names used in a piece of markup. */
function classesOf(html: string): string[] {
  return [
    ...new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1]!.split(/\s+/))),
  ];
}

describe('share page AI preview badge', () => {
  it('sits in the lower-right corner of an upload-origin image', () => {
    const badge = badgeOf(sharePage(shareView()));
    expect(badge).toContain('image-card__corner--lower-right');
    expect(badge).toContain('share-page__badge--lower-right');
    expect(badge).toContain('data-corner="lower-right"');
  });

  it('sits in the lower-left corner of a Street View image, off its burned-in credit', () => {
    const view = shareView({
      attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
    });
    expect(aiBadgeCorner(view)).toBe('lower-left');
    const badge = badgeOf(sharePage(view));
    expect(badge).toContain('image-card__corner--lower-left');
    expect(badge).toContain('share-page__badge--lower-left');
    expect(badge).not.toContain('lower-right');
  });
});

describe('share page before the script runs', () => {
  const css = webStylesheets();
  const styled = (name: string) => new RegExp(`\\.${name}(?![\\w-])`).test(css);

  it("uses the markup of the app's share page, styled by the page's stylesheet", () => {
    const html = sharePage(
      shareView({
        beforeImageUrl: 'https://cdn.test/before.jpg',
        attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
      }),
    );
    expect(html).toContain('<div class="page share-page-app share-page">');
    expect(html).toContain('<header class="site-header share-page-app__header');
    expect(html).toContain('<figure class="image-card shared__card');
    expect(html).toContain('style="--frame-ratio: 1.3333333333333333"');
    expect(html).toContain('<figcaption class="image-card__strip">');
    expect(html).toContain('Christmas · Classic');
    expect(html).toContain('<span class="attribution__logo">Google Maps</span>');
    expect(html).toContain(
      '<a class="button button--primary share-page__cta" href="/?holiday=christmas">',
    );
    const layout = classesOf(html).filter((name) => !name.startsWith('share-page'));
    expect(layout.length).toBeGreaterThan(15);
    expect(layout.filter((name) => !styled(name))).toEqual([]);
  });

  it("paints the gone page with the app's markup too", () => {
    const html = renderShareGone(deps, { reason: 'revoked', siteImage: null });
    expect(html).toContain('<section class="share-page-app__gone stack">');
    expect(html).toContain('This preview is no longer shared.');
    const layout = classesOf(html).filter((name) => !name.startsWith('share-page'));
    expect(layout.filter((name) => !styled(name))).toEqual([]);
  });
});

describe('landing panel before the script runs', () => {
  const panel = landingPanelMarkup();

  it('carries the app panel and address-field classes so it is laid out like the app', () => {
    expect(panel).toMatch(/^<div class="landing ssr-hero__landing">/);
    expect(panel).toContain('<section class="landing__panel ssr-hero__panel"');
    expect(panel).toContain('class="landing__headline ssr-hero__headline"');
    expect(panel).toContain('class="landing__subhead ssr-hero__subhead"');
    expect(panel).toContain('<div class="combo"><label class="combo__label" for="ssr-address">');
    expect(panel).toContain('<div class="combo__field"><svg class="icon combo__icon"');
    expect(panel).toMatch(/<input id="ssr-address" class="combo__input"[^>]*placeholder="/);
  });

  it('labels the panel with its headline and keeps the copy of the app', () => {
    expect(panel).toContain('aria-labelledby="ssr-headline"');
    expect(panel).toContain('id="ssr-headline"');
    expect(panel).toContain('Imagine your place for the holidays.');
    expect(panel).toContain('Find your address or upload a photo to see a festive new look.');
    expect(panel).toContain('Enter a US address');
    expect(panel).toContain('placeholder="Street address, city, state"');
  });
});
