import { expect, test } from '@playwright/test';
import { COPY } from './support';

test.describe('landing', () => {
  test('the server shell carries the hero photograph and the inline experience', async ({
    request,
  }) => {
    const response = await request.get('/');
    expect(response.ok()).toBe(true);
    const html = await response.text();
    expect(html).toContain('id="experience"');
    expect(html).toMatch(/<div id="ssr-hero" class="ssr-hero">\s*<(img|picture)/);
  });

  test('renders the hero, one address field and the holiday chip', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: COPY.headline })).toBeVisible();

    const hero = page.locator('.hero img').first();
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
    await expect(page.getByRole('button', { name: 'Upload a photo instead' })).toBeVisible();
  });

  test('suggestions paint above the rest of the panel after a client-side arrival', async ({
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

    const ageCovered = await page.evaluate(() => {
      const age = document.querySelector('.landing__age')!.getBoundingClientRect();
      const hit = document.elementFromPoint(age.left + 24, age.top + age.height / 2);
      return Boolean(hit?.closest('[role="listbox"], .combo__popup'));
    });
    expect(ageCovered).toBe(true);
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

  test('the inline upload link shows only on expanded layouts', async ({ page }) => {
    for (const [width, shown] of [
      [390, false],
      [768, false],
      [1023, false],
      [1024, true],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Upload a photo instead' })).toBeVisible();
      const inline = page.locator('.landing__upload-inline');
      await expect(inline).toHaveCount(1);
      if (shown) await expect(inline).toBeVisible();
      else await expect(inline).toBeHidden();
    }
  });

  test('a deep link preselects the holiday', async ({ page }) => {
    await page.goto('/?holiday=christmas');
    await expect(page.getByRole('button', { name: /^Holiday: / })).toHaveText(/Christmas/);
  });
});
