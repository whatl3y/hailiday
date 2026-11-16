import { expect, test, type Page } from '@playwright/test';
import {
  COPY,
  expectResult,
  lookCard,
  lookRow,
  nextRenderRequest,
  openResultRow,
  uploadSample,
} from './support';

/** Median luma (0 to 1) of the before and after images of the result, at the after's size. */
async function resultLuma(page: Page): Promise<{ before: number; after: number }> {
  const card = page.locator('.variant');
  const beforeUrl = await card.locator('img.compare__before').first().getAttribute('src');
  const afterUrl = await card
    .locator('img.compare__after, .compare__after img')
    .first()
    .getAttribute('src');
  expect(beforeUrl).toBeTruthy();
  expect(afterUrl).toBeTruthy();
  return page.evaluate(
    async ({ beforeUrl, afterUrl }) => {
      async function bitmap(url: string) {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
        return createImageBitmap(await response.blob());
      }
      const after = await bitmap(afterUrl);
      const before = await bitmap(beforeUrl);
      const median = (image: ImageBitmap) => {
        const canvas = new OffscreenCanvas(after.width, after.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d context');
        context.drawImage(image, 0, 0, after.width, after.height);
        const data = context.getImageData(0, 0, after.width, after.height).data;
        const histogram = new Array<number>(256).fill(0);
        for (let i = 0; i < data.length; i += 4) {
          const luma =
            0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
          histogram[Math.min(255, Math.round(luma))]! += 1;
        }
        const half = data.length / 8;
        let seen = 0;
        for (let level = 0; level < 256; level += 1) {
          seen += histogram[level]!;
          if (seen >= half) return level / 255;
        }
        return 1;
      };
      return { before: median(before), after: median(after) };
    },
    { beforeUrl: beforeUrl ?? '', afterUrl: afterUrl ?? '' },
  );
}

test.describe('upload', () => {
  test("the upload screen rests on the season's photograph until a photo is chosen", async ({
    page,
  }) => {
    await page.goto('/upload?holiday=christmas');
    await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    await expect(page.locator('.site-header--photo')).toBeVisible();
    await expect(page.locator('.hero-frame__photo img').first()).toBeVisible();
    const dock = page.locator('.hero-frame .hero-dock');
    await expect(
      dock.getByRole('heading', { name: 'Upload a photo of your place' }),
    ).toBeInViewport();
    await expect(dock.getByRole('checkbox', { name: /18 or older/ })).toBeInViewport();
    await expect(dock.locator('details.tips')).not.toHaveAttribute('open', '');
    // The whole age-and-rights label is a comfortable target.
    const label = await dock.locator('.attest .check').boundingBox();
    expect(label?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('a chosen photo is shown on the ink stage under the ink header band', async ({ page }) => {
    await uploadSample(page, 'sample-dining-room.jpg', 'e2e-stage-dining-room.jpg');
    await expect(page.locator('.upload__stage .upload__photo')).toBeVisible();
    await expect(page.locator('.site-header--stage')).toBeVisible();
    await expect(page.locator('.site-header--photo')).toHaveCount(0);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0d0d0f');
  });

  test('an uploaded photo is decorated', async ({ page }) => {
    const firstLook = nextRenderRequest(page);
    await uploadSample(page, 'sample-dining-room.jpg', 'e2e-dining-room.jpg');
    // An interior's first look is abundant and bright, with no lighting to choose.
    expect(await firstLook).toMatchObject({ style: 'abundant', lightingMode: 'bright' });
    await expectResult(page);
    await expect(page.locator('.variant').getByText('Your photo')).toBeVisible();
    await expect(lookRow(page)).toContainText('Christmas · Abundant');
    await expect(lookRow(page)).not.toContainText(/Bright|As\sphotographed|Evening/);
    await openResultRow(page, 'Try another look');
    await expect(page.getByRole('group', { name: 'Lighting' })).toHaveCount(0);
    await openResultRow(page, 'More');
    await expect(page.getByRole('button', { name: 'Replace photo' })).toBeVisible();

    // Straight from this place to a new upload place and Back: the page shows this place again.
    const resultUrl = page.url();
    // The same move inside the app as the invitation link to `/upload` on a result.
    await page.evaluate(() => {
      window.history.pushState(null, '', '/upload');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForURL(
      (url) => /^\/p\/[0-9a-f-]{36}$/.test(url.pathname) && url.href !== resultUrl,
    );
    await expect(page.getByRole('heading', { name: 'Upload a photo of your place' })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(resultUrl);
    await expectResult(page);
    await expect(page.getByRole('heading', { name: 'Upload a photo of your place' })).toHaveCount(
      0,
    );
    await expect(lookRow(page)).toContainText('Christmas · Abundant');
  });

  test('a reload while an uploaded photo is decorated follows the look, not the upload step', async ({
    page,
  }) => {
    let renderRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/renders') {
        renderRequests += 1;
      }
    });
    // The look exists once its request is answered: a reload before that starts it again.
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/renders',
    );
    // A slow render keeps the look in the making through the reload.
    await uploadSample(page, 'sample-dining-room.jpg', 'e2e-reload-dining-slow.jpg');
    await created;
    await expect(lookCard(page)).toBeVisible({ timeout: 30_000 });
    await page.reload();
    const result = page.getByRole('heading', { level: 1, name: COPY.resultHeading });
    await expect(lookCard(page).or(result)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Upload a photo of your place' })).toHaveCount(
      0,
    );
    await expectResult(page);
    expect(renderRequests).toBe(1);
  });

  test('a dim apartment hallway comes back decorated and brighter', async ({ page }) => {
    const firstLook = nextRenderRequest(page);
    await uploadSample(page, 'sample-apartment-hallway.jpg', 'e2e-apartment-hallway.jpg');
    expect(await firstLook).toMatchObject({ style: 'abundant', lightingMode: 'bright' });
    await expectResult(page);
    await expect(lookRow(page)).toContainText('Christmas · Abundant');
    await expect(lookRow(page)).not.toContainText(/Bright|As\sphotographed|Evening/);
    const luma = await resultLuma(page);
    expect(luma.after).toBeGreaterThan(luma.before);
  });

  test('a photo that is not a living space is declined with guidance', async ({ page }) => {
    await uploadSample(page, 'sample-kitchen.jpg', 'decline-kitchen.jpg');
    await expect(
      page.getByText(/This doesn't look like a home, room, balcony or entryway/),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Try another photo' })).toBeVisible();
  });

  test('people in the photo: keeping them makes the preview private', async ({ page }) => {
    await uploadSample(page, 'sample-living-room-mantel.jpg', 'people-living-room.jpg');
    const sheet = page.getByRole('dialog', { name: COPY.peopleHeading });
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    await sheet.getByRole('button', { name: 'Keep as is' }).click();
    await expectResult(page);
    await expect(page.getByText(COPY.privateOnly)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Download' })).toHaveCount(0);
  });
});
