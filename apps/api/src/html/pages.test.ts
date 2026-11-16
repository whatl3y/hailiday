import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ShareView } from '@hailiday/core';
import type { ApiDeps } from '../deps.js';
import type { Experience } from '@hailiday/core';
import type { PublicExperience } from '../domain/experience.js';
import {
  BRAND_GLYPH_PATH,
  HERO_SIZES,
  aiBadgeCorner,
  creditAfterLogo,
  landingHeaderMarkup,
  landingPanelMarkup,
  landingShellMarkup,
  renderLanding,
  renderShareGone,
  renderSharePage,
} from './pages.js';
import { FALLBACK_TEMPLATE, THEME_COLORS, renderPage } from './shell.js';

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

const webRoot = fileURLToPath(new URL('../../../web/src/', import.meta.url));

/** A source file of the web app. */
function webSource(relative: string): string {
  return readFileSync(path.join(webRoot, relative), 'utf8');
}

/** Every stylesheet of the web app, concatenated. */
function webStylesheets(): string {
  const root = webRoot;
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
    expect(badge).not.toContain('upper-left');
  });

  it('sits in the upper-left corner of a Street View image, off the logo and copyright', () => {
    const view = shareView({
      attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
    });
    expect(aiBadgeCorner(view)).toBe('upper-left');
    const badge = badgeOf(sharePage(view));
    expect(badge).toContain('image-card__corner--upper-left');
    expect(badge).toContain('share-page__badge--upper-left');
    expect(badge).toContain('data-corner="upper-left"');
    expect(badge).not.toMatch(/lower-(left|right)/);
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
    expect(html).toContain('<div class="page page--stage share-page-app share-page">');
    expect(html).toContain('<header class="site-header site-header--stage share-page-app__header');
    expect(html).toContain('<span class="wordmark__mark" aria-hidden="true">');
    expect(html).not.toContain('wordmark__dot');
    expect(html).toContain(
      '<div class="shared stage-scope" style="--stage-w: 1600; --stage-h: 1200">',
    );
    expect(html).toContain(
      '<div class="stage stage--viewport stage--overlay shared__stage share-page__stage" style="--stage-w: 1600; --stage-h: 1200" data-fill="viewport">',
    );
    expect(html).toContain('<p class="share-page-app__credit">');
    expect(html).toContain('Christmas · Classic');
    expect(html).toContain('<span class="attribution__logo">Google Maps</span>');
    expect(html).toContain(
      '<a class="button button--primary share-page-app__cta share-page__cta" href="/?holiday=christmas">',
    );
    // The page's tone class is a hook the app's `PageShell` writes too; it may carry no rule.
    const layout = classesOf(html).filter(
      (name) => !name.startsWith('share-page') && name !== 'page--stage',
    );
    expect(layout.length).toBeGreaterThan(15);
    expect(layout.filter((name) => !styled(name))).toEqual([]);
  });

  it('wears the ink header band and an ink theme-color above the shared picture', () => {
    const html = sharePage(shareView());
    expect(html).toMatch(/<header class="site-header site-header--stage [^"]*"/);
    expect(html).toContain('<meta name="theme-color" content="#0d0d0f" />');
    expect(html.match(/<meta name="theme-color"/g)).toHaveLength(1);
    expect(THEME_COLORS.ink).toBe('#0d0d0f');
    // The same classes as the app's share page and the stage tone of its header.
    const app = webSource('features/share/SharePage.tsx');
    expect(app).toContain("'page page--stage share-page-app'");
    expect(app).toContain("'site-header site-header--stage share-page-app__header'");
    expect(app).toContain('useThemeColor(tone)');
    expect(webSource('ui/themeColor.ts')).toContain(`ink: '${THEME_COLORS.ink}'`);
    expect(styled('site-header--stage')).toBe(true);
  });

  it('keeps the gone page on paper with a white theme-color', () => {
    const html = renderShareGone(deps, { reason: 'expired', siteImage: null });
    expect(html).toContain('<div class="page share-page-app share-page share-page--gone">');
    expect(html).not.toContain('site-header--stage');
    expect(html).toContain('<meta name="theme-color" content="#ffffff" />');
    expect(html.match(/<meta name="theme-color"/g)).toHaveLength(1);
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

  it('carries the app panel, dock and address-field classes so it is laid out like the app', () => {
    expect(panel).toMatch(/^<section class="landing__panel ssr-hero__panel"/);
    expect(panel).toContain('class="landing__headline ssr-hero__headline"');
    expect(panel).toContain('class="landing__subhead ssr-hero__subhead"');
    // Only the eyebrow and the headline rest on the photograph; the dock opens with the subhead.
    expect(panel).toContain(
      '</h1><div class="hero-dock landing__dock"><p class="landing__subhead ssr-hero__subhead">',
    );
    expect(panel).toMatch(
      /landing__subhead ssr-hero__subhead">[^<]*<\/p><form class="landing__address/,
    );
    expect(panel).toContain(
      '<div class="combo" data-placement="above"><label class="combo__label" for="ssr-address">',
    );
    expect(panel).toContain(
      '<div class="combo__anchor"><div class="combo__field"><svg class="icon combo__icon"',
    );
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

  it('paints every block of the app panel in its order, so nothing moves when the app starts', () => {
    const blocks = [
      '<p class="eyebrow landing__eyebrow"><span>Your place</span><span class="sep" aria-hidden="true">·</span><span>Your photo</span>',
      'class="landing__headline',
      '<div class="hero-dock landing__dock">',
      'class="landing__subhead',
      '<form class="landing__address',
      '<div class="landing__routes"><button type="button" class="link-button landing__manual">Can&#39;t find it? Enter the address manually</button><a class="link-button landing__upload" href="/upload">Or upload a photo</a></div></form>',
      '<p class="landing__age">By continuing you confirm you&#39;re 18 or older and agree to the <a href="/terms">Terms</a>.</p></div></section>',
    ];
    let at = -1;
    for (const block of blocks) {
      const next = panel.indexOf(block);
      expect(next, block).toBeGreaterThan(at);
      at = next;
    }
    expect(panel).not.toContain('landing__invite');
    expect(panel).not.toContain('See an example');
    expect(panel).not.toContain('landing__secondary');
  });

  it('adds the invitation and the examples route when the experience asks for them', () => {
    const full = landingPanelMarkup({ invite: true, examples: true });
    expect(full.indexOf('class="landing__invite"')).toBeGreaterThan(full.indexOf('landing__age'));
    expect(full).toMatch(/class="landing__invite">[^<]*<\/p><\/div><\/section>$/);
    expect(full).toContain(
      'Or upload a photo</a><button type="button" class="link-button landing__example">See an example</button></div>',
    );
  });

  it('keeps the routes in the order the app renders them', () => {
    const landing = webSource('features/landing/LandingPage.tsx');
    const order = ['landing__manual', 'landing__upload', 'landing__example'].map((name) =>
      landing.indexOf(`className="link-button ${name}"`),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('landing shell before the script runs', () => {
  const css = webStylesheets();
  const styled = (name: string) => new RegExp(`\\.${name}(?![\\w-])`).test(css);
  const picture = '<picture class="ssr-hero__picture"><img src="h.jpg" alt="" /></picture>';
  const shell = landingShellMarkup({
    picture,
    focus: '--hero-x:62%;--hero-y:50%;--hero-portrait-x:50%;--hero-portrait-y:50%',
    holiday: 'christmas',
    invite: false,
    examples: true,
  });

  it('lays the header over a full-viewport hero frame with the panel resting on the photograph', () => {
    expect(shell.indexOf('<header class="site-header site-header--photo ssr-hero__header">')).toBe(
      0,
    );
    expect(shell).toContain(
      '<div class="landing ssr-hero__landing"><div class="hero-frame landing__frame" data-photo="" style="--hero-x:62%;--hero-y:50%;--hero-portrait-x:50%;--hero-portrait-y:50%">' +
        `<div class="hero-frame__photo">${picture}</div>` +
        '<div class="hero-frame__scrim" aria-hidden="true"></div>' +
        '<div class="hero-frame__content"><section class="landing__panel',
    );
    expect(shell).toMatch(/<\/section><\/div><\/div><\/div>$/);
  });

  it('paints the ink frame without a photograph when there is no hero', () => {
    const bare = landingShellMarkup({ picture: '', holiday: null, invite: false, examples: false });
    expect(bare).toContain(
      '<div class="hero-frame landing__frame"><div class="hero-frame__photo"></div>',
    );
  });

  it('matches the markup of the app hero frame', () => {
    const frame = webSource('ui/HeroFrame.tsx');
    for (const name of ['hero-frame__photo', 'hero-frame__scrim', 'hero-frame__content']) {
      expect(frame).toContain(`className="${name}"`);
    }
    expect(frame).toContain("className ? `hero-frame ${className}` : 'hero-frame'");
    expect(frame).toContain("className ? `hero-dock ${className}` : 'hero-dock'");
    expect(webSource('features/landing/LandingHero.tsx')).toContain('className="landing__frame"');
  });

  it("uses only classes the app's stylesheets style (apart from its own hooks)", () => {
    const layout = classesOf(shell).filter((name) => !name.startsWith('ssr-hero'));
    expect(layout.length).toBeGreaterThan(20);
    expect(layout.filter((name) => !styled(name))).toEqual([]);
  });

  it("draws the app's brand and the holiday picker label with its dot", () => {
    const header = landingHeaderMarkup('christmas');
    expect(header).toContain(
      `<span class="wordmark__mark" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="${BRAND_GLYPH_PATH}" /></svg></span><span class="wordmark__name">Hailiday</span>`,
    );
    expect(header).toContain(
      '<button type="button" class="holiday-chip" data-holiday="christmas" aria-haspopup="dialog" aria-expanded="false"><span class="holiday-chip__dot" aria-hidden="true"></span><span class="sr-only">Holiday: </span>Christmas',
    );
    expect(webSource('ui/Layout.tsx')).toContain(`BRAND_GLYPH_PATH = '${BRAND_GLYPH_PATH}'`);
    const offSeason = landingHeaderMarkup(null);
    expect(offSeason).toContain('Choose a holiday');
    expect(offSeason).not.toContain('holiday-chip__dot');
    expect(offSeason).not.toContain('data-holiday');
  });

  it('paints the Gallery navigation after the holiday picker, as the app does, so it never pops in', () => {
    const nav =
      '<nav class="site-header__nav" aria-label="Site"><a class="site-header__link" href="/gallery">Gallery</a></nav>';
    for (const header of [landingHeaderMarkup('christmas'), landingHeaderMarkup(null)]) {
      expect(header).toContain(`</button>${nav}</div></header>`);
    }
    const layout = webSource('ui/Layout.tsx');
    expect(layout).toMatch(
      /\{end\}\s*<nav className="site-header__nav" aria-label=\{t\('app\.navLabel'\)\}>/,
    );
    expect(layout).toContain(`<NavLink to="/gallery" end className={() => 'site-header__link'}>`);
    // The app names the header's tone class the way the server does: site-header--<tone>.
    expect(layout).toContain(
      "tone === 'paper' ? 'site-header' : `site-header site-header--${tone}`",
    );
    expect(layout).toMatch(/export type HeaderTone = SurfaceTone;/);
    expect(webSource('ui/themeColor.ts')).toContain(
      "export type SurfaceTone = 'paper' | 'photo' | 'stage';",
    );
    const deck = webSource('copy/deck.ts');
    expect(deck).toContain("'app.navLabel': 'Site',");
    expect(deck).toContain("'gallery.title': 'Gallery',");
  });

  const experience = {
    requestedHolidayId: null,
    defaultHolidayId: 'christmas',
    offSeason: false,
    holidays: [{ id: 'christmas', journeyEmphasis: 'exterior', inWindow: true }],
    examples: [],
    hero: {
      holidayId: 'christmas',
      sceneType: 'house_exterior',
      renditions: {
        landscape: [
          { url: 'https://cdn.test/l-2400.jpg', width: 2400, height: 1600 },
          { url: 'https://cdn.test/l-1200.jpg', width: 1200, height: 800 },
        ],
        portrait: [{ url: 'https://cdn.test/p-720.jpg', width: 720, height: 1080 }],
      },
      altKey: 'hero.christmas.alt',
    },
  } as unknown as Experience;

  it('sizes and preloads the photograph for the full viewport width, as the app does', () => {
    const html = renderLanding({ ...deps, content: { heroes: [] } } as unknown as ApiDeps, {
      experience,
      publicPart: { heroAsset: null } as unknown as PublicExperience,
      siteImage: null,
    });
    expect(HERO_SIZES).toBe('100vw');
    const preloads = [...html.matchAll(/<link rel="preload" as="image"[^>]*>/g)].map((m) => m[0]);
    expect(preloads).toHaveLength(2);
    for (const preload of preloads) {
      expect(preload).toContain(`imagesizes="${HERO_SIZES}"`);
      expect(preload).toContain('fetchpriority="high"');
    }
    expect(preloads[0]).toContain('media="(orientation: portrait)"');
    expect(preloads[1]).toContain('media="(orientation: landscape)"');
    expect(html).toContain(
      `<source media="(orientation: portrait)" srcset="https://cdn.test/p-720.jpg 720w" sizes="${HERO_SIZES}"`,
    );
    const image = /<img class="ssr-hero__image"[^>]*>/.exec(html)![0];
    expect(image).toContain(`sizes="${HERO_SIZES}"`);
    expect(image).toContain('fetchpriority="high"');
    expect(image).toContain('width="2400" height="1600"');
    const web = webSource('ui/heroFocus.ts');
    expect(web).toContain(`HERO_SIZES = '${HERO_SIZES}'`);
    expect(web).toContain("PORTRAIT_MEDIA = '(orientation: portrait)'");
    expect(webSource('ui/HeroFrame.tsx')).toContain('fetchPriority="high"');
    // The photograph is painted in the frame the app adopts it from, under the panel.
    expect(html.indexOf('ssr-hero__picture')).toBeLessThan(html.indexOf('landing__panel'));
  });

  it("places each crop's focal point from the hero content, as the app's table does", () => {
    const heroes = [
      {
        heroAssetId: 'hero.christmas.exterior.v1',
        holidayId: 'christmas',
        altText: 'A tree',
        crops: {
          landscape: { focalPoint: { x: 0.62, y: 0.5 } },
          portrait: { focalPoint: { x: 0.5, y: 0.5 } },
        },
      },
    ];
    const html = renderLanding({ ...deps, content: { heroes } } as unknown as ApiDeps, {
      experience,
      publicPart: { heroAsset: { assetKey: 'hero.christmas.exterior.v1' } } as PublicExperience,
      siteImage: null,
    });
    expect(html).toContain(
      'style="--hero-x:62%;--hero-y:50%;--hero-portrait-x:50%;--hero-portrait-y:50%"',
    );
    const table = webSource('ui/heroFocus.ts');
    expect(table).toContain('christmas: { landscape: [0.62, 0.5], portrait: [0.5, 0.5] },');
  });
});

describe('document head the server sends', () => {
  const webDir = path.join(webRoot, '..');
  const template = readFileSync(path.join(webDir, 'index.html'), 'utf8');
  const experience = {
    requestedHolidayId: null,
    defaultHolidayId: 'christmas',
    offSeason: false,
    holidays: [{ id: 'christmas', journeyEmphasis: 'exterior', inWindow: true }],
    examples: [],
    hero: null,
  } as unknown as Experience;
  const html = renderLanding(
    {
      ...deps,
      web: { distDir: null, template, built: true },
      content: { heroes: [] },
    } as unknown as ApiDeps,
    { experience, publicPart: { heroAsset: null } as unknown as PublicExperience, siteImage: null },
  );
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));

  it('preloads the latin Outfit face the stylesheet uses, so the headline never swaps faces', () => {
    const preload =
      /<link\s+rel="preload"\s+href="([^"]+)"\s+as="font"\s+type="font\/woff2"\s+crossorigin\s*\/>/.exec(
        head,
      );
    expect(preload).not.toBeNull();
    const href = preload![1]!;
    expect(href).toMatch(/\/@fontsource-variable\/outfit\/files\/outfit-latin-wght-normal\.woff2$/);
    expect(statSync(path.join(webDir, href)).isFile()).toBe(true);
    const faces = readFileSync(
      path.join(webDir, 'node_modules/@fontsource-variable/outfit/wght.css'),
      'utf8',
    );
    expect(faces).toContain('url(./files/outfit-latin-wght-normal.woff2)');
    expect(webSource('styles/global.css')).toContain(
      "@import '@fontsource-variable/outfit/wght.css';",
    );
  });

  it('opens on ink: the theme color is the stage ground, written once over the template', () => {
    expect(THEME_COLORS.ink).toBe('#0d0d0f');
    expect(template).toContain(`<meta name="theme-color" content="${THEME_COLORS.paper}" />`);
    expect(head.match(/name="theme-color"/g)).toHaveLength(1);
    expect(head).toContain(`<meta name="theme-color" content="${THEME_COLORS.ink}" />`);
    expect(webSource('ui/themeColor.ts')).toContain(`ink: '${THEME_COLORS.ink}',`);
    expect(webSource('styles/tokens.css')).toContain(`--stage: ${THEME_COLORS.ink};`);
  });

  it('keeps the template theme color on a page that names none, and adds one when it is missing', () => {
    const shell = { distDir: null, template, built: true };
    expect(renderPage(shell, {})).toContain(
      `<meta name="theme-color" content="${THEME_COLORS.paper}" />`,
    );
    const bare = {
      distDir: null,
      template: '<html><head></head><body></body></html>',
      built: true,
    };
    const added = renderPage(bare, { themeColor: THEME_COLORS.ink });
    const addedHead = added.slice(added.indexOf('<head>'), added.indexOf('</head>'));
    expect(addedHead).toContain(`<meta name="theme-color" content="${THEME_COLORS.ink}" />`);
  });

  it('links the brand mark as the tab icon, served from the app origin', () => {
    expect(head).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    // Files in the web app's public folder are copied to the root of the build the server serves.
    const icon = readFileSync(path.join(webDir, 'public/favicon.svg'), 'utf8');
    expect(icon).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 32 32">/);
    expect(icon).toContain(`d="${BRAND_GLYPH_PATH}"`);
    expect(icon).toContain('rotate(-2 16 16)');
  });
});

describe('share page picture on a stage', () => {
  /** The opening tags of the elements carrying `name`, in document order. */
  function tagsWith(html: string, name: string): string[] {
    return [...html.matchAll(/<[a-z0-9]+\b[^>]*class="([^"]*)"[^>]*>/g)]
      .filter((match) => match[1]!.split(/\s+/).includes(name))
      .map((match) => match[0]);
  }

  it('shows the picture edge to edge on the stage, its ambient copy decorative and quiet', () => {
    const html = sharePage(shareView());
    const ambient = /<div class="stage__ambient" aria-hidden="true"><img ([^>]*)\/><\/div>/.exec(
      html,
    );
    expect(ambient?.[1]).toContain('src="https://cdn.test/after.jpg"');
    expect(ambient?.[1]).toContain('alt=""');
    expect(ambient?.[1]).toContain('fetchpriority="low"');
    const after = tagsWith(html, 'shared__after')[0] ?? '';
    expect(after).toContain('fetchpriority="high"');
    expect(after).toContain('width="1600" height="1200"');
    // The picture and the badge sit in the picture box; no frame, border or card around them.
    expect(html).toMatch(
      /<div class="stage__picture"><img class="shared__after[^>]*\/><div class="image-card__corner/,
    );
    expect(html).not.toMatch(/image-card shared__card|image-card__frame|--frame-ratio/);
  });

  it('places the toggle in the stage corner only when the share includes the before photo', () => {
    const without = sharePage(shareView());
    expect(without).not.toContain('stage__overlay');
    expect(without).not.toContain('stage--overlay');
    const withBefore = sharePage(shareView({ beforeImageUrl: 'https://cdn.test/before.jpg' }));
    expect(withBefore).toMatch(
      /<div class="stage__overlay"><div class="segmented segmented--on-stage[^"]*" role="group"/,
    );
  });

  it('repeats the switch on the paper under the picture for phones, as the app does', () => {
    const without = sharePage(shareView());
    expect(without).not.toContain('shared__controls');
    const html = sharePage(shareView({ beforeImageUrl: 'https://cdn.test/before.jpg' }));
    const overlay = /<div class="stage__overlay">(.*?)<\/div><\/div>/.exec(html)?.[1] ?? '';
    // The paper copy opens the paper under the picture, alone in its row, before the credit line.
    expect(html).toMatch(
      /<div class="share-page-app__below"><div class="stage-controls shared__controls"><div class="segmented segmented--on-stage share-page__toggle" role="group"[^>]*>.*?<\/div><\/div><p class="share-page-app__credit">/,
    );
    const below = /<div class="stage-controls shared__controls">(.*?<\/div>)<\/div>/.exec(
      html,
    )?.[1];
    expect(below).toBe(`${overlay}</div>`);
    // The stylesheet shows one copy per width.
    const css = webStylesheets();
    expect(css).toMatch(/\.shared__controls \{\s*display: none;/);
    expect(css).toMatch(
      /@media \(max-width: 599px\) \{[^@]*\.shared \.stage__overlay \{\s*display: none;/,
    );
    const app = webSource('features/share/SharePage.tsx');
    expect(app).toContain('<div className="stage-controls shared__controls">{toggle()}</div>');
  });

  it('follows the stage with the credit, the headline and the one call to action, then the report link', () => {
    const html = sharePage(
      shareView({ attribution: { required: true, text: '© 2026 Google', logo: 'google_maps' } }),
    );
    const order = [
      'class="stage stage--viewport',
      'class="share-page-app__below"',
      'class="share-page-app__credit"',
      'class="attribution share-page__attribution"',
      '<h1 class="share-page-app__caption share-page__caption">A holiday preview made with Hailiday</h1>',
      'class="button button--primary share-page-app__cta',
      'class="share-page-app__more"',
      'class="link-button share-page__report"',
    ].map((needle) => html.indexOf(needle));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/button--primary/g)).toHaveLength(1);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
  });

  it("uses the stage markup the app's stage component renders", () => {
    const stage = webSource('ui/Stage.tsx');
    for (const name of ['stage__ambient', 'stage__picture', 'stage__overlay', 'stage--overlay']) {
      expect(stage).toContain(name);
    }
    expect(stage).toContain("import { stageStyle } from './stageStyle';");
    expect(webSource('ui/stageStyle.ts')).toContain(
      "'--stage-w': String(w), '--stage-h': String(h)",
    );
    const page = webSource('features/share/SharePage.tsx');
    for (const name of [
      'shared stage-scope',
      'shared__stage',
      'shared__after',
      'segmented segmented--on-stage',
      'share-page-app__below',
      'share-page-app__credit',
      'share-page-app__label',
      'share-page-app__text',
      'share-page-app__caption',
      'button button--primary share-page-app__cta',
      'share-page-app__more',
    ]) {
      expect(page, name).toContain(name);
    }
  });
});

describe('share page Street View attribution', () => {
  const stripOf = (html: string) =>
    /<span class="attribution share-page__attribution"[^]*?<\/p>/.exec(html)?.[0] ?? '';

  it('prints Google Maps once when the credit already starts with it', () => {
    const strip = stripOf(
      sharePage(
        shareView({
          attribution: { required: true, text: 'Google Maps · © 2026 Google', logo: 'google_maps' },
        }),
      ),
    );
    expect(strip.match(/Google Maps/g)).toHaveLength(1);
    expect(strip).toContain('<span class="attribution__logo">Google Maps</span>');
    expect(strip).toContain('<span>© 2026 Google</span>');
  });

  it('drops an exact repeat of the logo and a leading logo name, nothing else', () => {
    expect(creditAfterLogo('Google Maps')).toBe('');
    expect(creditAfterLogo('Google Maps · © 2026 Google')).toBe('© 2026 Google');
    expect(creditAfterLogo('Google Maps Imagery')).toBe('Google Maps Imagery');
    expect(creditAfterLogo('© 2026 Google')).toBe('© 2026 Google');
  });
});
