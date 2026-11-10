import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '@holiday/server/config';

/** Default location of the built web app relative to `apps/api/{src,dist}`. */
export const DEFAULT_WEB_DIST_DIR = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/** The web app's HTML template, read once at startup, and the static directory. */
export interface WebShell {
  /** Directory with the built SPA (`index.html`, `assets/`), or null when no build exists. */
  distDir: string | null;
  template: string;
  /** False when the minimal built-in shell is used. */
  built: boolean;
}

/** A minimal shell used when the web build is missing: the server-rendered parts still work. */
export const FALLBACK_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="light" />
    <title>Holiday</title>
    <!--holiday:head-->
  </head>
  <body>
    <div id="ssr-hero" class="ssr-hero"><!--holiday:hero--></div>
    <div id="root"></div>
    <!--holiday:experience-->
  </body>
</html>
`;

/** Loads `index.html` from the web build once; falls back to the minimal shell. */
export function loadWebShell(distDir: string | null | undefined): WebShell {
  const dir = distDir === undefined ? DEFAULT_WEB_DIST_DIR : distDir;
  if (dir && existsSync(dir) && statSync(dir).isDirectory()) {
    const indexPath = path.join(dir, 'index.html');
    if (existsSync(indexPath)) {
      return { distDir: dir, template: readFileSync(indexPath, 'utf8'), built: true };
    }
    return { distDir: dir, template: FALLBACK_TEMPLATE, built: false };
  }
  return { distDir: null, template: FALLBACK_TEMPLATE, built: false };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and quoted attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Serializes JSON for an inline `<script type="application/json">` without breaking out of it. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface PageParts {
  title?: string;
  head?: string;
  /** Markup for the server-rendered region (`#ssr-hero`). */
  ssr?: string;
  /** Inline JSON scripts: element ID → value. */
  data?: Record<string, unknown>;
}

function inject(html: string, marker: string, content: string, fallback: (html: string) => string) {
  const token = `<!--holiday:${marker}-->`;
  return html.includes(token) ? html.replace(token, () => content) : fallback(html);
}

/** Renders a page from the template by filling the head, SSR region and inline data slots. */
export function renderPage(shell: WebShell, parts: PageParts): string {
  let html = shell.template;
  if (parts.title) {
    html = /<title>[\s\S]*?<\/title>/i.test(html)
      ? html.replace(
          /<title>[\s\S]*?<\/title>/i,
          () => `<title>${escapeHtml(parts.title ?? '')}</title>`,
        )
      : html.replace(/<\/head>/i, () => `<title>${escapeHtml(parts.title ?? '')}</title></head>`);
  }
  const head = parts.head ?? '';
  html = inject(html, 'head', head, (current) =>
    current.replace(/<\/head>/i, () => `${head}\n</head>`),
  );
  const ssr = parts.ssr ?? '';
  html = inject(html, 'hero', ssr, (current) =>
    ssr
      ? current.replace(
          /<body([^>]*)>/i,
          (match) => `${match}\n<div id="ssr-hero" class="ssr-hero">${ssr}</div>`,
        )
      : current,
  );
  const data = Object.entries(parts.data ?? {})
    .map(
      ([id, value]) =>
        `<script type="application/json" id="${escapeHtml(id)}">${inlineJson(value)}</script>`,
    )
    .join('\n');
  html = inject(html, 'experience', data, (current) =>
    current.replace(/<\/body>/i, () => `${data}\n</body>`),
  );
  return html;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The Content Security Policy for HTML documents. */
export function contentSecurityPolicy(config: AppConfig): string {
  const assetOrigins = [
    originOf(config.storage.publicAssetBaseUrl),
    originOf(config.storage.publicEndpoint),
  ].filter((origin): origin is string => origin !== null);
  const images = [
    "'self'",
    'data:',
    'blob:',
    ...new Set(assetOrigins),
    'https://maps.googleapis.com',
  ];
  const connect = ["'self'", ...new Set(assetOrigins), 'https://challenges.cloudflare.com'];
  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${images.join(' ')}`,
    `connect-src ${connect.join(' ')}`,
    'frame-src https://challenges.cloudflare.com',
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Security headers every HTML document carries. */
export function setHtmlSecurityHeaders(reply: FastifyReply, config: AppConfig): void {
  reply.header('Content-Security-Policy', contentSecurityPolicy(config));
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-Content-Type-Options', 'nosniff');
  if (!config.isLocal) {
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
