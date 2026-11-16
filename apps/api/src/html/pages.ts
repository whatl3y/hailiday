import {
  catalogEntry,
  type Experience,
  type HolidayId,
  type Rendition,
  type ShareView,
} from '@hailiday/core';
import type { HeroAsset } from '@hailiday/server/db';
import type { ApiDeps } from '../deps.js';
import type { PublicExperience } from '../domain/experience.js';
import { escapeHtml, renderPage, THEME_COLORS } from './shell.js';

/** Viewport split between the portrait and landscape hero crops: taller than wide, or not. */
const PORTRAIT_MEDIA = '(orientation: portrait)';
const LANDSCAPE_MEDIA = '(orientation: landscape)';

/**
 * The photograph's display width: the landing's hero fills the viewport edge to edge. The app's
 * hero uses the same value, so the preloaded rendition is the one it paints.
 */
export const HERO_SIZES = '100vw';

/** The roofline glyph inside the brand mark, the same path the app draws. */
export const BRAND_GLYPH_PATH = 'M3.5 9.5 10 4l6.5 5.5M5.5 8v7.5h9V8M8.5 15.5v-4h3v4';

/** Site-level copy used by the server-rendered documents (from the experience copy deck). */
export const SITE_COPY = {
  name: 'Hailiday',
  description: 'See your own home decorated for the holidays.',
  eyebrow: 'Your place · Your photo · AI preview',
  headline: 'Imagine your place for the holidays.',
  subhead: 'Find your address or upload a photo to see a festive new look.',
  addressLabel: 'Enter a US address',
  addressPlaceholder: 'Street address, city, state',
  manualEntry: "Can't find it? Enter the address manually",
  uploadInline: 'Or upload a photo',
  ageLine: "By continuing you confirm you're 18 or older and agree to the Terms.",
  terms: 'Terms',
  thanksgivingInvite:
    'Hosting this year? Upload a photo of your dining room or table to see it set for Thanksgiving.',
  uploadInstead: 'Upload a photo instead',
  seeExample: 'See an example',
  pickerLabel: 'Holiday',
  chooseHoliday: 'Choose a holiday',
  navLabel: 'Site',
  gallery: 'Gallery',
  aiPreview: 'AI preview',
  before: 'Before',
  shareTitle: 'A holiday preview',
  shareCaption: 'A holiday preview made with Hailiday',
  shareCta: 'See your place for the holidays',
  shareReport: 'Report this image',
  shareRevoked: 'This preview is no longer shared.',
  notFound: "We couldn't find that. It may have expired or been removed.",
  home: 'Hailiday home',
  compareLabel: 'Compare before and after',
  yourPhoto: 'Your photo',
  googleMaps: 'Google Maps',
  styles: { subtle: 'Subtle', classic: 'Classic', abundant: 'Abundant' },
} as const;

function srcset(renditions: readonly Rendition[]): string {
  return renditions.map((rendition) => `${rendition.url} ${rendition.width}w`).join(', ');
}

/** The generic site image for Open Graph: the neutral hero's landscape JPEG nearest 1200 px. */
export function siteImageUrl(
  deps: Pick<ApiDeps, 'storage'>,
  heroes: readonly HeroAsset[],
): string | null {
  const hero = heroes.find((row) => row.holidayId === null) ?? heroes[0];
  const renditions = hero?.renditions.landscape?.renditions ?? [];
  const jpegs = renditions.filter(
    (rendition) => rendition.format === 'jpeg' || rendition.format === 'jpg',
  );
  const pick =
    jpegs.find((rendition) => rendition.width === 1200) ??
    [...jpegs].sort((a, b) => Math.abs(a.width - 1200) - Math.abs(b.width - 1200))[0];
  return pick ? deps.storage.publicUrl(pick.cdnPath) : null;
}

function socialTags(input: {
  title: string;
  description: string;
  url: string;
  image: string | null;
}): string {
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${SITE_COPY.name}" />`,
    `<meta property="og:title" content="${escapeHtml(input.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(input.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(input.url)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(input.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(input.description)}" />`,
  ];
  if (input.image) {
    tags.push(`<meta property="og:image" content="${escapeHtml(input.image)}" />`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(input.image)}" />`);
  }
  return tags.join('\n    ');
}

/** The description meta, unless the web template already carries one. */
function descriptionMeta(deps: Pick<ApiDeps, 'web'>): string {
  return deps.web.template.includes('name="description"')
    ? ''
    : `<meta name="description" content="${escapeHtml(SITE_COPY.description)}" />`;
}

/** Client configuration the SPA needs before any API call (never secrets). */
function clientMeta(deps: Pick<ApiDeps, 'config'>): string {
  return [
    `<meta name="hailiday:turnstile-mode" content="${deps.config.turnstile.mode}" />`,
    `<meta name="hailiday:turnstile-site-key" content="${escapeHtml(deps.config.turnstile.siteKey)}" />`,
    `<meta name="hailiday:app-env" content="${deps.config.appEnv}" />`,
  ].join('\n    ');
}

function heroMarkup(
  hero: NonNullable<Experience['hero']>,
  alt: string,
): {
  head: string;
  body: string;
} {
  const landscape = hero.renditions.landscape;
  const portrait = hero.renditions.portrait;
  const fallback =
    [...landscape].sort((a, b) => Math.abs(a.width - 1200) - Math.abs(b.width - 1200))[0] ??
    landscape[0];
  if (!fallback) return { head: '', body: '' };
  const largest = landscape[0] ?? fallback;
  const head: string[] = [];
  if (portrait.length > 0) {
    head.push(
      `<link rel="preload" as="image" imagesrcset="${escapeHtml(srcset(portrait))}" imagesizes="${HERO_SIZES}" media="${PORTRAIT_MEDIA}" fetchpriority="high" />`,
    );
  }
  head.push(
    `<link rel="preload" as="image" imagesrcset="${escapeHtml(srcset(landscape))}" imagesizes="${HERO_SIZES}"${portrait.length > 0 ? ` media="${LANDSCAPE_MEDIA}"` : ''} fetchpriority="high" />`,
  );
  const portraitLargest = portrait[0];
  const source =
    portrait.length > 0 && portraitLargest
      ? `<source media="${PORTRAIT_MEDIA}" srcset="${escapeHtml(srcset(portrait))}" sizes="${HERO_SIZES}" width="${portraitLargest.width}" height="${portraitLargest.height}" />`
      : '';
  const body = `<picture class="ssr-hero__picture">${source}<img class="ssr-hero__image" src="${escapeHtml(fallback.url)}" srcset="${escapeHtml(srcset(landscape))}" sizes="${HERO_SIZES}" width="${largest.width}" height="${largest.height}" fetchpriority="high" decoding="async" alt="${escapeHtml(alt)}" /></picture>`;
  return { head: head.join('\n    '), body };
}

/**
 * The landing shell: the header, the headline panel with the address field, its links and the
 * age line, then the resolved hero in its final layout box (`img` with `srcset`, `sizes`,
 * `width`, `height`, `fetchpriority="high"`) and matching preload links, site-level Open Graph
 * and Twitter tags, and the public experience as inline JSON.
 */
export function renderLanding(
  deps: ApiDeps,
  input: { experience: Experience; publicPart: PublicExperience; siteImage: string | null },
): string {
  const { experience, publicPart } = input;
  const heroContent = publicPart.heroAsset
    ? deps.content.heroes.find((hero) => hero.heroAssetId === publicPart.heroAsset?.assetKey)
    : undefined;
  const alt = heroContent?.altText ?? '';
  const hero = experience.hero ? heroMarkup(experience.hero, alt) : { head: '', body: '' };
  const focus = hero.body && heroContent ? heroFocusStyle(heroContent.crops) : '';
  const head = [
    descriptionMeta(deps),
    `<link rel="canonical" href="${escapeHtml(`${deps.config.publicBaseUrl}/`)}" />`,
    hero.head,
    socialTags({
      title: SITE_COPY.name,
      description: SITE_COPY.description,
      url: `${deps.config.publicBaseUrl}/`,
      image: input.siteImage,
    }),
    clientMeta(deps),
  ]
    .filter(Boolean)
    .join('\n    ');
  const ssr = landingShellMarkup({
    picture: hero.body,
    focus,
    holiday: shellHoliday(experience),
    invite: showsInvite(experience),
    examples: experience.examples.length > 0,
  });
  return renderPage(deps.web, { head, ssr, themeColor: THEME_COLORS.ink, data: { experience } });
}

/** A crop's focal point as a percentage for `object-position`. */
function focusPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/**
 * The hero frame's custom properties that place the photograph's focal point in each crop, the
 * same values the app sets, so the photograph covers the frame around its subject.
 */
export function heroFocusStyle(
  crops: Partial<Record<string, { focalPoint: { x: number; y: number } }>>,
): string {
  const parts: string[] = [];
  const landscape = crops.landscape?.focalPoint;
  const portrait = crops.portrait?.focalPoint ?? landscape;
  if (landscape) {
    parts.push(`--hero-x:${focusPercent(landscape.x)}`, `--hero-y:${focusPercent(landscape.y)}`);
  }
  if (portrait) {
    parts.push(
      `--hero-portrait-x:${focusPercent(portrait.x)}`,
      `--hero-portrait-y:${focusPercent(portrait.y)}`,
    );
  }
  return parts.join(';');
}

/**
 * The holiday the landing opens on: a deep link, else the default; none off-season. The app
 * may refine it from the visitor's time zone or an earlier choice after it starts.
 */
function shellHoliday(experience: Experience): HolidayId | null {
  return (
    experience.requestedHolidayId ?? (experience.offSeason ? null : experience.defaultHolidayId)
  );
}

/** Whether the landing holiday invites an interior photo (the Thanksgiving invitation). */
function showsInvite(experience: Experience): boolean {
  const id = shellHoliday(experience);
  const holiday = experience.holidays.find((item) => item.id === id);
  return holiday?.journeyEmphasis === 'interior' && holiday.inWindow;
}

/** A line icon as the app draws it (24 by 24, stroked). */
function lineIcon(className: string, path: string): string {
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}" /></svg>`;
}

/** The address field's search glyph, the same line icon the app draws in the field. */
const SEARCH_ICON = lineIcon(
  'icon combo__icon',
  'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1.5L20 20',
);
const CHEVRON_ICON = lineIcon('icon', 'm6 9 6 6 6-6');

/** The brand: the tilted mark with its roofline glyph and the name, linking home. */
function wordmarkMarkup(): string {
  return `<a class="wordmark" href="/" aria-label="${SITE_COPY.home}"><span class="wordmark__mark" aria-hidden="true"><svg viewBox="0 0 20 20" focusable="false"><path d="${BRAND_GLYPH_PATH}" /></svg></span><span class="wordmark__name">${SITE_COPY.name}</span></a>`;
}

/** The header navigation the app renders after the holiday picker. */
const HEADER_NAV = `<nav class="site-header__nav" aria-label="${SITE_COPY.navLabel}"><a class="site-header__link" href="/gallery">${SITE_COPY.gallery}</a></nav>`;

/**
 * The landing header, laid over the photograph in white: the brand, the holiday picker label
 * and the navigation the app renders.
 */
export function landingHeaderMarkup(holidayId: HolidayId | null): string {
  const dot = holidayId ? '<span class="holiday-chip__dot" aria-hidden="true"></span>' : '';
  const name = holidayId ? holidayName(holidayId) : SITE_COPY.chooseHoliday;
  const holiday = holidayId ? ` data-holiday="${holidayId}"` : '';
  const chip = `<button type="button" class="holiday-chip"${holiday} aria-haspopup="dialog" aria-expanded="false">${dot}<span class="sr-only">${SITE_COPY.pickerLabel}: </span>${escapeHtml(name)}${CHEVRON_ICON}</button>`;
  return `<header class="site-header site-header--photo ssr-hero__header">${wordmarkMarkup()}<div class="site-header__end">${chip}${HEADER_NAV}</div></header>`;
}

/** The eyebrow line with quiet separators, as the app renders it. */
function eyebrowMarkup(): string {
  const parts = SITE_COPY.eyebrow
    .split(' · ')
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join('<span class="sep" aria-hidden="true">·</span>');
  return `<p class="eyebrow landing__eyebrow">${parts}</p>`;
}

/** The age line with its link to the Terms. */
function ageLineMarkup(): string {
  const at = SITE_COPY.ageLine.lastIndexOf(SITE_COPY.terms);
  const before = escapeHtml(SITE_COPY.ageLine.slice(0, at));
  const after = escapeHtml(SITE_COPY.ageLine.slice(at + SITE_COPY.terms.length));
  return `<p class="landing__age">${before}<a href="/terms">${SITE_COPY.terms}</a>${after}</p>`;
}

export interface LandingPanelOptions {
  /** The Thanksgiving invitation shows in the dock after the age line. */
  invite?: boolean;
  /** The experience carries examples, so the "See an example" route shows. */
  examples?: boolean;
}

/**
 * The content block painted before the script runs. It carries the app's own landing and
 * address-field classes (whose styles ship in the page's stylesheet) and the same blocks in
 * the same order (the eyebrow pill and the headline on the photograph, then the white dock with
 * the subhead, the address field, its row of routes and the age line), so it is laid out
 * exactly like the app's. The app replaces it with its own.
 */
export function landingPanelMarkup(options: LandingPanelOptions = {}): string {
  return [
    '<section class="landing__panel ssr-hero__panel" aria-labelledby="ssr-headline">',
    eyebrowMarkup(),
    `<h1 id="ssr-headline" class="landing__headline ssr-hero__headline">${escapeHtml(SITE_COPY.headline)}</h1>`,
    '<div class="hero-dock landing__dock">',
    `<p class="landing__subhead ssr-hero__subhead">${escapeHtml(SITE_COPY.subhead)}</p>`,
    '<form class="landing__address ssr-hero__address" role="search" action="/" method="get">',
    '<div class="combo" data-placement="above">',
    `<label class="combo__label" for="ssr-address">${escapeHtml(SITE_COPY.addressLabel)}</label>`,
    `<div class="combo__anchor"><div class="combo__field">${SEARCH_ICON}<input id="ssr-address" class="combo__input" type="text" autocomplete="off" inputmode="text" placeholder="${escapeHtml(SITE_COPY.addressPlaceholder)}" /></div></div>`,
    '</div>',
    '<div class="landing__routes">',
    `<button type="button" class="link-button landing__manual">${escapeHtml(SITE_COPY.manualEntry)}</button>`,
    `<a class="link-button landing__upload" href="/upload">${escapeHtml(SITE_COPY.uploadInline)}</a>`,
    options.examples
      ? `<button type="button" class="link-button landing__example">${escapeHtml(SITE_COPY.seeExample)}</button>`
      : '',
    '</div>',
    '</form>',
    ageLineMarkup(),
    options.invite
      ? `<p class="landing__invite">${escapeHtml(SITE_COPY.thanksgivingInvite)}</p>`
      : '',
    '</div>',
    '</section>',
  ].join('');
}

/**
 * The landing painted before the script runs, in the app's own markup: the header laid over a
 * hero frame that fills the first viewport, the photograph covering it around its focal point
 * (`focus`, the frame's custom properties) and the content block resting on it.
 */
export function landingShellMarkup(input: {
  picture: string;
  focus?: string;
  holiday: HolidayId | null;
  invite: boolean;
  examples: boolean;
}): string {
  const photo = input.picture ? ' data-photo=""' : '';
  const style = input.picture && input.focus ? ` style="${escapeHtml(input.focus)}"` : '';
  return [
    landingHeaderMarkup(input.holiday),
    '<div class="landing ssr-hero__landing">',
    `<div class="hero-frame landing__frame"${photo}${style}>`,
    `<div class="hero-frame__photo">${input.picture}</div>`,
    '<div class="hero-frame__scrim" aria-hidden="true"></div>',
    '<div class="hero-frame__content">',
    landingPanelMarkup({ invite: input.invite, examples: input.examples }),
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

/**
 * A client route of the SPA: the shell with the experience JSON and no hero. `themeColor` is the
 * browser chrome colour of the screen the route opens on (paper unless named), so the bar
 * matches before the script runs.
 */
export function renderClientRoute(
  deps: ApiDeps,
  experience: Experience,
  themeColor: string = THEME_COLORS.paper,
): string {
  return renderPage(deps.web, {
    themeColor,
    head: [
      descriptionMeta(deps),
      `<meta name="robots" content="noindex" />`,
      clientMeta(deps),
    ].join('\n    '),
    data: { experience },
  });
}

/**
 * The corner of the share page's "AI preview" badge: lower-right, unless the image derives from
 * Street View, whose burned-in logo and copyright hold both lower corners; then upper-left.
 */
export function aiBadgeCorner(view: Pick<ShareView, 'attribution'>): 'lower-right' | 'upper-left' {
  return view.attribution ? 'upper-left' : 'lower-right';
}

/** The holiday's display name for server-rendered pages. */
function holidayName(holidayId: HolidayId): string {
  return catalogEntry(holidayId).displayName;
}

/**
 * The surface of a share page: `stage` above the shared picture (an ink header band on the
 * stage's ground), `paper` for a link that no longer works.
 */
type ShareTone = 'stage' | 'paper';

/** The wordmark and header of the app's share page. */
function shareHeader(tone: ShareTone): string {
  const toneClass = tone === 'stage' ? ' site-header--stage' : '';
  return `<header class="site-header${toneClass} share-page-app__header share-page__header">${wordmarkMarkup()}</header>`;
}

/**
 * The page frame of the app's share page around `content`. The server paints the same markup
 * and classes the app renders (their styles ship in the page's stylesheet), so the page is laid
 * out before the script runs and does not move when the app replaces it.
 */
function sharePageFrame(content: string, tone: ShareTone, modifier = ''): string {
  const toneClass = tone === 'stage' ? ' page--stage' : '';
  return `<div class="page${toneClass} share-page-app share-page${modifier}">${shareHeader(tone)}<main class="page__main share-page-app__main">${content}</main></div>`;
}

/**
 * The credit printed after the Google Maps logo: empty when it only repeats the logo name, and
 * without a leading "Google Maps ·" so the name appears once.
 */
export function creditAfterLogo(text: string): string {
  if (text === SITE_COPY.googleMaps) return '';
  if (!text.startsWith(SITE_COPY.googleMaps)) return text;
  const match = /^\s*·\s*/.exec(text.slice(SITE_COPY.googleMaps.length));
  return match ? text.slice(SITE_COPY.googleMaps.length + match[0].length).trim() : text;
}

/** The credit under a Street View-derived image: the logo when required, then the credit. */
function attributionMarkup(attribution: NonNullable<ShareView['attribution']>): string {
  const text = attribution.text.trim();
  const fixture = text.startsWith('Fixture photo:');
  const showLogo = attribution.logo === 'google_maps' && !fixture;
  const credit = fixture && /google/i.test(text) ? '' : showLogo ? creditAfterLogo(text) : text;
  const parts = [
    showLogo ? `<span class="attribution__logo">${SITE_COPY.googleMaps}</span>` : '',
    credit ? `<span>${escapeHtml(credit)}</span>` : '',
  ].filter(Boolean);
  return `<span class="attribution share-page__attribution" data-logo="${escapeHtml(attribution.logo)}">${parts.join('<span class="attribution__sep" aria-hidden="true">·</span>')}</span>`;
}

/**
 * The share page: wordmark on an ink header band (and an ink `theme-color`); the after image on
 * a stage (full width, ink ground, its blurred ambient copy behind it) with the "AI preview"
 * badge, the before image only when the share includes it; on the paper beneath it the holiday
 * label and the attribution for Street View-derived images, the headline and a call to action to
 * the landing page with the holiday preselected; then a report link. No address, owner or
 * product links. It uses the app's share page markup.
 */
export function renderSharePage(
  deps: ApiDeps,
  input: { token: string; view: ShareView; cardUrl: string | null; siteImage: string | null },
): string {
  const { view, token } = input;
  const name = holidayName(view.holidayId);
  const size = `width="${view.width}" height="${view.height}"`;
  const stageVars = `--stage-w: ${view.width}; --stage-h: ${view.height}`;
  const before = view.beforeImageUrl
    ? `<img class="share-page__before" src="${escapeHtml(view.beforeImageUrl)}" ${size} alt="${SITE_COPY.yourPhoto}" decoding="async" aria-hidden="true" draggable="false" />`
    : '';
  // The switch rests in the stage's corner from 600px and on the paper under the picture on
  // phones; the stylesheet shows one of the two.
  const switchMarkup = view.beforeImageUrl
    ? `<div class="segmented segmented--on-stage share-page__toggle" role="group" aria-label="${SITE_COPY.compareLabel}"><button type="button" aria-pressed="false" data-show="before">${SITE_COPY.before}</button><button type="button" aria-pressed="true" data-show="after">${SITE_COPY.aiPreview}</button></div>`
    : '';
  const toggle = switchMarkup ? `<div class="stage__overlay">${switchMarkup}</div>` : '';
  const controls = switchMarkup
    ? `<div class="stage-controls shared__controls">${switchMarkup}</div>`
    : '';
  const corner = aiBadgeCorner(view);
  const badge = `<div class="image-card__corner image-card__corner--${corner} share-page__badge share-page__badge--${corner}" data-corner="${corner}"><span class="badge badge--ai">${SITE_COPY.aiPreview}</span></div>`;
  const label = `${name} · ${SITE_COPY.styles[view.style]}`;
  const ambient = `<div class="stage__ambient" aria-hidden="true"><img src="${escapeHtml(view.imageUrl)}" alt="" decoding="async" fetchpriority="low" draggable="false" /></div>`;
  const after = `<img class="shared__after share-page__after" src="${escapeHtml(view.imageUrl)}" ${size} alt="${escapeHtml(`${SITE_COPY.aiPreview}: ${name}`)}" fetchpriority="high" decoding="async" draggable="false" />`;
  const stage = `<div class="stage stage--viewport${toggle ? ' stage--overlay' : ''} shared__stage share-page__stage" style="${stageVars}" data-fill="viewport">${ambient}<div class="stage__picture">${before}${after}${badge}</div>${toggle}</div>`;
  const credit = `<p class="share-page-app__credit"><span class="share-page-app__label share-page__holiday">${escapeHtml(label)}</span>${view.attribution ? attributionMarkup(view.attribution) : ''}</p>`;
  const text = `<div class="share-page-app__text"><h1 class="share-page-app__caption share-page__caption">${SITE_COPY.shareCaption}</h1><a class="button button--primary share-page-app__cta share-page__cta" href="/?holiday=${encodeURIComponent(view.holidayId)}">${SITE_COPY.shareCta}</a></div>`;
  const report = `<p class="share-page-app__more"><a class="link-button share-page__report" href="/s/${encodeURIComponent(token)}?report=share" data-report-target="share">${SITE_COPY.shareReport}</a></p>`;
  const ssr = sharePageFrame(
    `<article class="share-page-app__article"><div class="shared stage-scope" style="${stageVars}">${stage}<div class="share-page-app__below">${controls}${credit}${text}</div></div>${report}</article>`,
    'stage',
  );
  const head = [
    `<meta name="robots" content="noindex" />`,
    socialTags({
      title: `${SITE_COPY.shareTitle} · ${name}`,
      description: SITE_COPY.shareCta,
      url: `${deps.config.publicBaseUrl}/s/${token}`,
      image: input.cardUrl ?? input.siteImage,
    }),
    clientMeta(deps),
  ].join('\n    ');
  return renderPage(deps.web, {
    title: `${SITE_COPY.shareTitle} · ${SITE_COPY.name}`,
    head,
    ssr,
    themeColor: THEME_COLORS.ink,
    data: { share: { status: 'active', token, view } },
  });
}

/** The neutral page for a revoked, expired or unknown share link (410 or 404). */
export function renderShareGone(
  deps: ApiDeps,
  input: { reason: 'revoked' | 'expired' | 'deleted' | 'not_found'; siteImage: string | null },
): string {
  const message = input.reason === 'not_found' ? SITE_COPY.notFound : SITE_COPY.shareRevoked;
  const ssr = sharePageFrame(
    `<section class="share-page-app__gone stack"><h1 class="title-section share-page__message">${escapeHtml(message)}</h1><a class="button button--primary share-page__cta" href="/">${SITE_COPY.shareCta}</a></section>`,
    'paper',
    ' share-page--gone',
  );
  return renderPage(deps.web, {
    title: SITE_COPY.name,
    themeColor: THEME_COLORS.paper,
    head: [
      `<meta name="robots" content="noindex" />`,
      socialTags({
        title: SITE_COPY.name,
        description: SITE_COPY.description,
        url: `${deps.config.publicBaseUrl}/`,
        image: input.siteImage,
      }),
      clientMeta(deps),
    ].join('\n    '),
    ssr,
    data: {
      share: { status: input.reason === 'not_found' ? 'not_found' : 'gone', reason: input.reason },
    },
  });
}
