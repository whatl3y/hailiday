import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THEME_COLORS } from '../html/shell.js';
import { createHarness, type Harness } from '../test/harness.js';
import { CLIENT_ROUTES, INK_CLIENT_ROUTES } from './pages.js';

/** The app's template carries the paper colour, as `apps/web/index.html` does. */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="theme-color" content="#ffffff" /><title>Hailiday</title><!--hailiday:head--></head>
  <body><div id="root"></div><!--hailiday:experience--></body>
</html>
`;

let harness: Harness;
let distDir: string;

beforeAll(async () => {
  distDir = mkdtempSync(path.join(tmpdir(), 'hailiday-pages-'));
  writeFileSync(path.join(distDir, 'index.html'), TEMPLATE);
  mkdirSync(path.join(distDir, 'assets'));
  harness = await createHarness({ webDistDir: distDir });
});

afterAll(async () => {
  await harness?.close();
  rmSync(distDir, { recursive: true, force: true });
});

/** Every `theme-color` the document carries, in order. */
function themeColors(html: string): string[] {
  return [...html.matchAll(/<meta name="theme-color" content="([^"]*)"/g)].map(
    (match) => match[1]!,
  );
}

describe('the browser bar colour of a directly loaded client route', () => {
  it('is ink on the screens that open on a photograph or a picture stage', async () => {
    for (const url of ['/p/018f0000-0000-7000-8000-aaaaaaaaaaa1', '/upload']) {
      const page = await harness.client().get(url);
      expect(page.statusCode, url).toBe(200);
      expect(page.headers['content-type'], url).toContain('text/html');
      expect(themeColors(page.body), url).toEqual([THEME_COLORS.ink]);
    }
  });

  it('is ink on the not-found screen, which shows the holiday photograph', async () => {
    const page = await harness.client().get('/no-such-page');
    expect(page.statusCode).toBe(404);
    expect(page.headers['content-type']).toContain('text/html');
    expect(themeColors(page.body)).toEqual([THEME_COLORS.ink]);
  });

  it('stays paper on the paper screens', async () => {
    for (const url of [
      '/gallery',
      '/places',
      '/account',
      '/terms',
      '/privacy',
      '/accessibility',
      '/dont-decorate-my-home',
    ]) {
      const page = await harness.client().get(url);
      expect(page.statusCode, url).toBe(200);
      expect(themeColors(page.body), url).toEqual([THEME_COLORS.paper]);
    }
  });

  it('names only the project and upload routes as ink routes', () => {
    expect([...INK_CLIENT_ROUTES].sort()).toEqual(['/p/:projectId', '/upload']);
    for (const route of INK_CLIENT_ROUTES) expect(CLIENT_ROUTES).toContain(route);
  });
});
