import { catalogEntry, type Experience, type Rendition, type ShareView } from '@holiday/core';
import type { HeroAsset } from '@holiday/server/db';
import type { ApiDeps } from '../deps.js';
import type { PublicExperience } from '../domain/experience.js';
import { escapeHtml, renderPage } from './shell.js';

/** Viewport split between the portrait and landscape hero crops. */
const PORTRAIT_MEDIA = '(max-width: 699px)';
const LANDSCAPE_MEDIA = '(min-width: 700px)';

/** Site-level copy used by the server-rendered documents (from the experience copy deck). */
export const SITE_COPY = {
  name: 'Holiday',
  description: 'See your own home decorated for the holidays.',
  headline: 'Imagine your place for the holidays.',
  subhead: 'Find your address or upload a photo to see a festive new look.',
  addressLabel: 'Enter a US address',
  addressPlaceholder: 'Street address, city, state',
  aiPreview: 'AI preview',
  before: 'Before',
  shareTitle: 'A holiday preview',
  shareCaption: 'A holiday preview made with Holiday',
  shareCta: 'See your place for the holidays',
  shareReport: 'Report this image',
  shareRevoked: 'This preview is no longer shared.',
  notFound: "We couldn't find that. It may have expired or been removed.",
  home: 'Holiday home',
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
    `<meta name="holiday:turnstile-mode" content="${deps.config.turnstile.mode}" />`,
    `<meta name="holiday:turnstile-site-key" content="${escapeHtml(deps.config.turnstile.siteKey)}" />`,
    `<meta name="holiday:app-env" content="${deps.config.appEnv}" />`,
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
      `<link rel="preload" as="image" imagesrcset="${escapeHtml(srcset(portrait))}" imagesizes="100vw" media="${PORTRAIT_MEDIA}" fetchpriority="high" />`,
    );
  }
  head.push(
    `<link rel="preload" as="image" imagesrcset="${escapeHtml(srcset(landscape))}" imagesizes="100vw"${portrait.length > 0 ? ` media="${LANDSCAPE_MEDIA}"` : ''} fetchpriority="high" />`,
  );
  const portraitLargest = portrait[0];
  const source =
    portrait.length > 0 && portraitLargest
      ? `<source media="${PORTRAIT_MEDIA}" srcset="${escapeHtml(srcset(portrait))}" sizes="100vw" width="${portraitLargest.width}" height="${portraitLargest.height}" />`
      : '';
  const body = `<picture class="ssr-hero__picture">${source}<img class="ssr-hero__image" src="${escapeHtml(fallback.url)}" srcset="${escapeHtml(srcset(landscape))}" sizes="100vw" width="${largest.width}" height="${largest.height}" fetchpriority="high" decoding="async" alt="${escapeHtml(alt)}" /></picture>`;
  return { head: head.join('\n    '), body };
}

/**
 * The landing shell: the resolved hero in its final layout box (`img` with `srcset`, `sizes`,
 * `width`, `height`, `fetchpriority="high"`) and matching preload links, the headline and address
 * input markup, site-level Open Graph and Twitter tags, and the public experience as inline JSON.
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
  const ssr = `${hero.body}${landingPanelMarkup()}`;
  return renderPage(deps.web, { head, ssr, data: { experience } });
}

/** The address field's search glyph, the same line icon the app draws in the field. */
const SEARCH_ICON =
  '<svg class="icon combo__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1.5L20 20" /></svg>';

/**
 * The headline panel painted before the script runs. It carries the app's own landing and
 * address-field classes (whose styles ship in the page's stylesheet), so it is laid out like
 * the app's panel: below the photograph on phones and as a translucent panel over its lower
 * part on wide viewports. The app replaces it with its own panel and adopts only the photograph.
 */
export function landingPanelMarkup(): string {
  return [
    '<div class="landing ssr-hero__landing">',
    '<section class="landing__panel ssr-hero__panel" aria-labelledby="ssr-headline">',
    `<h1 id="ssr-headline" class="landing__headline ssr-hero__headline">${escapeHtml(SITE_COPY.headline)}</h1>`,
    `<p class="landing__subhead ssr-hero__subhead">${escapeHtml(SITE_COPY.subhead)}</p>`,
    '<form class="landing__address ssr-hero__address" role="search" action="/" method="get">',
    '<div class="combo">',
    `<label class="combo__label" for="ssr-address">${escapeHtml(SITE_COPY.addressLabel)}</label>`,
    `<div class="combo__field">${SEARCH_ICON}<input id="ssr-address" class="combo__input" type="text" autocomplete="off" inputmode="text" placeholder="${escapeHtml(SITE_COPY.addressPlaceholder)}" /></div>`,
    '</div>',
    '</form>',
    '</section>',
    '</div>',
  ].join('');
}

/** A client route of the SPA: the shell with the experience JSON and no hero. */
export function renderClientRoute(deps: ApiDeps, experience: Experience): string {
  return renderPage(deps.web, {
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
 * Street View, whose burned-in photo credit holds the lower-right corner; then lower-left.
 */
export function aiBadgeCorner(view: Pick<ShareView, 'attribution'>): 'lower-right' | 'lower-left' {
  return view.attribution ? 'lower-left' : 'lower-right';
}

/** The holiday's display name for server-rendered pages. */
function holidayName(holidayId: ShareView['holidayId']): string {
  return catalogEntry(holidayId).displayName;
}

/** The wordmark and header of the app's share page. */
function shareHeader(): string {
  return `<header class="site-header share-page-app__header share-page__header"><a class="wordmark" href="/" aria-label="${SITE_COPY.home}">${SITE_COPY.name}<span class="wordmark__dot" aria-hidden="true"></span></a></header>`;
}

/**
 * The page frame of the app's share page around `content`. The server paints the same markup
 * and classes the app renders (their styles ship in the page's stylesheet), so the page is laid
 * out before the script runs and does not move when the app replaces it.
 */
function sharePageFrame(content: string, modifier = ''): string {
  return `<div class="page share-page-app share-page${modifier}">${shareHeader()}<main class="page__main share-page-app__main">${content}</main></div>`;
}

/** The strip under a Street View-derived image: the logo when required, then the credit. */
function attributionMarkup(attribution: NonNullable<ShareView['attribution']>): string {
  const text = attribution.text.trim();
  const fixture = text.startsWith('Fixture photo:');
  const showLogo = attribution.logo === 'google_maps' && !fixture;
  const credit =
    (showLogo && text === SITE_COPY.googleMaps) || (fixture && /google/i.test(text)) ? '' : text;
  const parts = [
    showLogo ? `<span class="attribution__logo">${SITE_COPY.googleMaps}</span>` : '',
    credit ? `<span>${escapeHtml(credit)}</span>` : '',
  ].filter(Boolean);
  return `<span class="attribution share-page__attribution" data-logo="${escapeHtml(attribution.logo)}">${parts.join('<span class="attribution__sep" aria-hidden="true">·</span>')}</span>`;
}

/**
 * The share page: wordmark, the after image with the "AI preview" badge, the before image only
 * when the share includes it, the holiday label, attribution for Street View-derived images, the
 * caption, a call to action to the landing page with the holiday preselected and a report link.
 * No address, owner or product links. It uses the app's share page markup.
 */
export function renderSharePage(
  deps: ApiDeps,
  input: { token: string; view: ShareView; cardUrl: string | null; siteImage: string | null },
): string {
  const { view, token } = input;
  const name = holidayName(view.holidayId);
  const size = `width="${view.width}" height="${view.height}"`;
  const before = view.beforeImageUrl
    ? `<img class="share-page__before" src="${escapeHtml(view.beforeImageUrl)}" ${size} alt="${SITE_COPY.yourPhoto}" decoding="async" aria-hidden="true" />`
    : '';
  const toggle = view.beforeImageUrl
    ? `<div class="segmented share-page__toggle" role="group" aria-label="${SITE_COPY.compareLabel}"><button type="button" aria-pressed="false" data-show="before">${SITE_COPY.before}</button><button type="button" aria-pressed="true" data-show="after">${SITE_COPY.aiPreview}</button></div>`
    : '';
  const strip = view.attribution ? attributionMarkup(view.attribution) : '<span></span>';
  const corner = aiBadgeCorner(view);
  const badge = `<div class="image-card__corner image-card__corner--${corner} share-page__badge share-page__badge--${corner}" data-corner="${corner}"><span class="badge badge--ai">${SITE_COPY.aiPreview}</span></div>`;
  const label = `${name} · ${SITE_COPY.styles[view.style]}`;
  const figure = `<figure class="image-card shared__card share-page__figure"><div class="image-card__frame shared__frame" style="--frame-ratio: ${view.width / view.height}">${before}<img class="shared__after share-page__after" src="${escapeHtml(view.imageUrl)}" ${size} alt="${escapeHtml(`${SITE_COPY.aiPreview}: ${name}`)}" fetchpriority="high" decoding="async" />${badge}</div><figcaption class="image-card__strip">${strip}<span class="variant__label share-page__holiday">${escapeHtml(label)}</span></figcaption></figure>`;
  const text = `<div class="share-page-app__text"><p class="share-page-app__caption share-page__caption">${SITE_COPY.shareCaption}</p><a class="button button--primary share-page__cta" href="/?holiday=${encodeURIComponent(view.holidayId)}">${SITE_COPY.shareCta}</a><a class="link-button share-page__report" href="/s/${encodeURIComponent(token)}?report=share" data-report-target="share">${SITE_COPY.shareReport}</a></div>`;
  const ssr = sharePageFrame(
    `<article class="share-page-app__article"><div class="shared">${toggle}${figure}</div>${text}</article>`,
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
    ' share-page--gone',
  );
  return renderPage(deps.web, {
    title: SITE_COPY.name,
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
