import { expect, test } from '@playwright/test';
import { COPY, lookCard, openLanding } from './support';

test.describe('landing', () => {
  test('the server shell carries the hero photograph and the inline experience', async ({
    request,
  }) => {
    const response = await request.get('/');
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('id="experience"');
    // The header is laid over the hero frame; the photograph is painted first in the frame and
    // the panel rests on it.
    expect(html).toMatch(
      /<div id="ssr-hero" class="ssr-hero">\s*<header class="site-header site-header--photo/,
    );
    const photo = html.indexOf(
      '<div class="hero-frame__photo"><picture class="ssr-hero__picture">',
    );
    const panel = html.indexOf('<section class="landing__panel ssr-hero__panel"');
    expect(photo).toBeGreaterThan(html.indexOf('<div class="hero-frame landing__frame"'));
    expect(panel).toBeGreaterThan(photo);
    expect(html).toMatch(/<link rel="preload" as="image"[^>]*imagesizes="100vw"/);
    expect(html).toMatch(
      /<img class="ssr-hero__image"[^>]* sizes="100vw"[^>]* fetchpriority="high"/,
    );
  });

  for (const returning of [false, true]) {
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      const who = returning ? ' for a returning visitor' : '';
      test(`the app takes over the server landing without moving it at ${width} by ${height}${who}`, async ({
        browser,
      }) => {
        const boxes = async (javaScriptEnabled: boolean) => {
          const context = await browser.newContext({
            javaScriptEnabled,
            viewport: { width, height },
          });
          // The app remembers the last project on this device; the server cannot know it.
          if (returning) {
            await context.addInitScript(() =>
              window.localStorage.setItem(
                'hailiday.lastProject',
                JSON.stringify({ id: '018f0000-0000-7000-8000-aaaaaaaaaaa1', at: Date.now() }),
              ),
            );
          }
          const page = await context.newPage();
          await page.goto('/?holiday=christmas');
          if (javaScriptEnabled) {
            await expect(page.locator('#ssr-hero')).toBeHidden();
            await expect(page.locator('.hero__layer--server img')).toHaveCount(1);
            if (returning) {
              await expect(
                page.getByRole('link', { name: 'Continue with your last place' }),
              ).toBeVisible();
            }
          }
          await page.evaluate(() => document.fonts.ready);
          // Let every entrance finish, so the boxes are the settled layout.
          await page.waitForTimeout(2500);
          const measured = await page.evaluate(() => {
            const top = (selector: string) => {
              const element = document.querySelector(selector);
              if (!element || getComputedStyle(element).display === 'none') return null;
              const box = element.getBoundingClientRect();
              return [Math.round(box.left), Math.round(box.top + window.scrollY)];
            };
            return {
              headline: top('.landing__headline'),
              field: top('.combo__field'),
              age: top('.landing__age'),
              upload: top('.landing__upload'),
              frame: top('.hero-frame'),
            };
          });
          await context.close();
          return measured;
        };
        const server = await boxes(false);
        const app = await boxes(true);
        for (const value of Object.values(server)) expect(value).not.toBeNull();
        // The link back to the last place joins where it moves nothing: above the
        // bottom-anchored block on wide screens, after the dock on phones.
        expect(app).toEqual(server);
      });
    }
  }

  test('fills the first viewport with the photograph, the header and the dock resting on it', async ({
    page,
  }) => {
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1280, 720],
      [390, 844],
      [360, 640],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('700 40px "Outfit Variable"'))).toBe(
        true,
      );
      const family = await page
        .getByRole('heading', { level: 1 })
        .evaluate((heading) => getComputedStyle(heading).fontFamily);
      expect(family).toMatch(/^"Outfit Variable"/);
      const measured = await page.evaluate(() => {
        const box = (selector: string) => {
          const rect = document.querySelector(selector)!.getBoundingClientRect();
          return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
        };
        const image = document.querySelector<HTMLImageElement>('.hero-frame__photo img')!;
        return {
          frame: box('.hero-frame'),
          header: box('.site-header'),
          field: box('.combo__field'),
          scrollWidth: document.documentElement.scrollWidth,
          fit: getComputedStyle(image).objectFit,
          sizes: image.getAttribute('sizes'),
          priority: image.getAttribute('fetchpriority'),
          headerColor: getComputedStyle(document.querySelector('.wordmark')!).color,
        };
      });
      const where = `${width}x${height}`;
      expect(measured.frame, where).toEqual([0, 0, width, height]);
      expect(measured.header[1], where).toBe(0);
      expect(measured.field[1] + measured.field[3], where).toBeLessThanOrEqual(height);
      expect(measured.scrollWidth, where).toBeLessThanOrEqual(width);
      expect(measured.fit).toBe('cover');
      expect(measured.sizes).toBe('100vw');
      expect(measured.priority).toBe('high');
      expect(measured.headerColor).toBe('rgb(255, 255, 255)');
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        'rgb(255, 255, 255)',
      );
    }
  });

  test('keeps the photograph as shot: only the headline carries a scrim, the subhead is in the dock', async ({
    page,
  }) => {
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/?holiday=christmas');
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0d0d0f');
      // Let the entrance finish, so the boxes are the settled layout.
      await page.waitForTimeout(2500);
      const measured = await page.evaluate(() => {
        const frame = document.querySelector('.landing__frame')!;
        const headline = document.querySelector('.landing__headline')!;
        const scrim = getComputedStyle(headline, '::before');
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(headline);
        const lines = [...range.getClientRects()].filter((rect) => rect.width > 1);
        return {
          frameScrim: getComputedStyle(frame).getPropertyValue('--hero-scrim').trim(),
          scrimImage: scrim.backgroundImage,
          scrimRight:
            box('.landing__headline').left + parseFloat(scrim.left) + parseFloat(scrim.width),
          headlineLines: new Set(lines.map((rect) => Math.round(rect.top))).size,
          headlineRight: Math.max(...lines.map((rect) => rect.right)),
          eyebrowBackground: getComputedStyle(document.querySelector('.landing__eyebrow')!)
            .backgroundColor,
          subheadInDock: Boolean(document.querySelector('.landing__dock .landing__subhead')),
          dockBottom: box('.landing__dock').bottom,
        };
      });
      const where = `${width}x${height}`;
      expect(measured.frameScrim, where).toBe('');
      expect(measured.subheadInDock, where).toBe(true);
      expect(measured.eyebrowBackground, where).not.toBe('rgba(0, 0, 0, 0)');
      expect(measured.headlineLines, where).toBe(2);
      if (width >= 600) {
        // One soft ellipse around the two lines. Its alpha is under 0.05 over its outer 7%, so
        // a box that ends before 75% of the width leaves the right 30% of the photograph as shot.
        expect(measured.scrimImage, where).toMatch(/^radial-gradient\(/);
        expect(measured.scrimRight, where).toBeLessThan(width * 0.75);
        expect(measured.headlineRight, where).toBeLessThan(width * 0.6);
      } else {
        // The lower 46% of a tall phone is the photograph alone.
        expect(measured.dockBottom / height, where).toBeLessThanOrEqual(0.54);
      }
    }
  });

  test('renders the hero, one address field and the holiday chip', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: COPY.headline })).toBeVisible();

    const hero = page.locator('.hero-frame__photo img').first();
    await expect(hero).toBeVisible();
    await expect
      .poll(() => hero.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    await expect(page.getByRole('combobox', { name: COPY.addressLabel })).toBeVisible();
    const chip = page.getByRole('button', { name: /^Holiday: / });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(
      /Halloween|Thanksgiving|Christmas|New Year's Eve|Choose a holiday/,
    );
    // One upload route, in the dock's row of routes beside the manual-entry link.
    await expect(
      page
        .getByRole('button', { name: /^(Or upload a photo|Upload a photo instead)$/ })
        .filter({ visible: true }),
    ).toHaveCount(1);
  });

  test('suggestions open upward over the photograph on wide screens after a client-side arrival', async ({
    page,
  }) => {
    // Tall enough that every suggestion row is on screen for hit testing.
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.goto('/privacy');
    await page.locator('a.wordmark').first().click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.locator('.landing__panel')).not.toHaveAttribute('data-continues', /.*/);

    const field = page.getByRole('combobox', { name: COPY.addressLabel });
    await field.click();
    await field.pressSequentially('USA', { delay: 40 });
    const options = page.getByRole('option');
    await expect(options).toHaveCount(5);
    // Let the panel's entrance and the popup's own animation finish.
    await page.waitForTimeout(1200);

    const hits = await page.evaluate(() =>
      [...document.querySelectorAll('[role="option"]')].map((option) => {
        const box = option.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return Boolean(hit && option.contains(hit));
      }),
    );
    expect(hits).toEqual([true, true, true, true, true]);

    const placed = await page.evaluate(() => {
      const popup = document.querySelector('.combo__popup')!.getBoundingClientRect();
      const field = document.querySelector('.combo__field')!.getBoundingClientRect();
      const header = document.querySelector('.site-header')!.getBoundingClientRect();
      return {
        above: popup.bottom <= field.top,
        belowHeader: popup.top >= header.bottom,
        inViewport: popup.top >= 0 && popup.bottom <= window.innerHeight,
      };
    });
    expect(placed).toEqual({ above: true, belowHeader: true, inViewport: true });
  });

  test('on phones the suggestions open below the field, lifted clear of the keyboard', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto('/');
    const field = page.getByRole('combobox', { name: COPY.addressLabel });
    await field.click();
    await field.pressSequentially('USA', { delay: 40 });
    await expect(page.getByRole('option')).toHaveCount(5);
    await page.waitForTimeout(800);
    const placed = await page.evaluate(() => {
      const popup = document.querySelector('.combo__popup')!.getBoundingClientRect();
      const field = document.querySelector('.combo__field')!.getBoundingClientRect();
      const first = document.querySelector('[role="option"]')!.getBoundingClientRect();
      return { below: popup.top >= field.bottom, fieldTop: field.top, firstBottom: first.bottom };
    });
    expect(placed.below).toBe(true);
    // A phone keyboard takes about the lower half of the screen.
    expect(placed.fieldTop).toBeLessThan(120);
    expect(placed.firstBottom).toBeLessThanOrEqual(320);
  });

  for (const [width, height] of [
    [1366, 768],
    [1440, 900],
    [1280, 800],
  ] as const) {
    test(`the upload route is on screen on load at ${width} by ${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      for (const path of ['/', '/?holiday=christmas']) {
        await page.goto(path);
        const upload = page.getByRole('button', { name: 'Or upload a photo' });
        await expect(upload).toBeVisible();
        const box = await upload.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      }
    });
  }

  test('the upload route is one link in the dock at every width', async ({ page }) => {
    for (const width of [390, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const inline = page.getByRole('button', { name: 'Or upload a photo' });
      await expect(inline).toHaveCount(1);
      await expect(inline).toBeVisible();
      await expect(page.locator('.landing__dock .landing__routes')).toContainText(
        'Or upload a photo',
      );
    }
  });

  test('manual entry on a wide screen keeps an upload route', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: "Can't find it? Enter the address manually" }).click();
    await expect(page.getByRole('button', { name: 'Or upload a photo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Upload a photo instead' })).toBeVisible();
  });

  test('without Google keys, the empty state holds still and offers the sample places', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Each suggestions answer is held back, so every request in flight lasts many frames.
    await page.route('**/v1/addresses/suggestions*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await openLanding(page);
    const field = page.getByRole('combobox', { name: COPY.addressLabel });
    await field.click();
    await field.pressSequentially('1600 Pennsylvania Ave', { delay: 40 });

    const notice = page.getByText(COPY.sampleModeNotice);
    await expect(notice).toBeVisible();
    await expect(field).not.toHaveAttribute('aria-busy', /.*/);
    await expect(field).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText(/Check the street number and ZIP/)).toHaveCount(0);

    // Record where "Or upload a photo" sits on every frame across two more empty answers.
    const upload = page.getByRole('button', { name: 'Or upload a photo' });
    await expect(upload).toBeVisible();
    await page.evaluate(() => {
      const link = document.querySelector('.landing__upload')!;
      const tops: number[] = [];
      const record = () => {
        tops.push(Math.round(link.getBoundingClientRect().top));
        (window as unknown as { tops: number[] }).tops = tops;
        requestAnimationFrame(record);
      };
      record();
    });
    for (const next of [' N', 'W']) {
      const answered = page.waitForResponse((response) =>
        response.url().includes('/v1/addresses/suggestions?'),
      );
      await field.pressSequentially(next, { delay: 40 });
      await answered;
      await expect(field).not.toHaveAttribute('aria-busy', /.*/);
    }
    const tops = await page.evaluate(() => (window as unknown as { tops: number[] }).tops);
    expect(tops.length).toBeGreaterThan(20);
    expect(new Set(tops).size).toBe(1);
    await expect(notice).toBeVisible();

    // A sample place searches at once and opens the list, credited to no one.
    await page
      .getByRole('group', { name: 'Sample places' })
      .getByRole('button', {
        name: '14 Lantern Hill',
      })
      .click();
    await expect(field).toHaveValue('14 Lantern Hill');
    await expect(field).toBeFocused();
    const option = page.getByRole('option').filter({ hasText: '14 Lantern Hill Rd' });
    await expect(option).toBeVisible();
    await expect(field).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.combo__popup')).not.toContainText('Google');

    // Choosing it proceeds as a typed search does: the clean place starts decorating at once.
    await option.click();
    await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toHaveCount(0);
    await expect(lookCard(page)).toContainText(COPY.stageLabels, { timeout: 30_000 });
  });

  test('a deep link preselects the holiday', async ({ page }) => {
    await page.goto('/?holiday=christmas');
    await expect(page.getByRole('button', { name: /^Holiday: / })).toHaveText(/Christmas/);
  });

  test('the tab shows the brand mark, served from the app origin', async ({ page, request }) => {
    await page.goto('/');
    const href = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(href).toBe('/favicon.svg');
    const icon = await request.get(href!);
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toMatch(/^image\/svg\+xml/);
    expect(await icon.text()).toContain('<svg');
  });

  test('the footer starts under the brand and keeps to one line on desktop', async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [1366, 768],
      [1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(page.locator('.site-footer__mark')).toBeAttached();
      await page.evaluate(() => document.fonts.ready);
      const measured = await page.evaluate(() => {
        const brand = document.querySelector('.site-header .wordmark')!.getBoundingClientRect();
        const mark = document.querySelector('.site-footer__mark')!.getBoundingClientRect();
        const links = [...document.querySelectorAll('.site-footer__links a')];
        const tops = new Set(
          [mark, ...links.map((link) => link.getBoundingClientRect())].map((box) =>
            Math.round(box.top),
          ),
        );
        return {
          brandLeft: Math.round(brand.left),
          footerLeft: Math.round(mark.left),
          lines: tops.size,
        };
      });
      expect(measured.footerLeft, `${width}px`).toBe(measured.brandLeft);
      expect(measured.lines, `${width}px`).toBe(1);
    }
  });

  test('the header fits on one line on narrow phones without sideways scrolling', async ({
    page,
  }) => {
    for (const width of [320, 344, 360]) {
      await page.setViewportSize({ width, height: 700 });
      for (const holiday of ['thanksgiving_us', 'new_years_eve', 'halloween', 'christmas']) {
        await page.goto(`/?holiday=${holiday}`);
        await expect(page.getByRole('button', { name: /^Holiday: / })).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.evaluate(() => {
          // The lines the holiday name takes: its text node, not the dot, label or icon.
          const chip = document.querySelector('.site-header .holiday-chip')!;
          const range = document.createRange();
          const lines = new Set<number>();
          for (const node of chip.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) lines.add(Math.round(rect.top));
          }
          const links = [...document.querySelectorAll('.site-header__link')];
          return {
            scrollWidth: document.documentElement.scrollWidth,
            chipLines: lines.size,
            linksRight: Math.max(...links.map((link) => link.getBoundingClientRect().right)),
          };
        });
        const where = `${holiday} at ${width}px`;
        expect(measured.scrollWidth, where).toBeLessThanOrEqual(width);
        expect(measured.chipLines, where).toBe(1);
        expect(measured.linksRight, where).toBeLessThanOrEqual(width);
      }
    }
  });
});
