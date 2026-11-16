import { expect, test, type Page } from '@playwright/test';
import { expectResult, uploadSample } from './support';

/**
 * Share of pixels whose colour moved by more than `threshold` (0–255, any channel) between the
 * before and after images, measured in the page on images fetched through CORS.
 */
async function changedShare(
  page: Page,
  beforeUrl: string,
  afterUrl: string,
  threshold = 48,
): Promise<{ share: number; width: number; height: number; sameAspect: boolean }> {
  return page.evaluate(
    async ({ beforeUrl, afterUrl, threshold }) => {
      async function pixels(url: string) {
        const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) throw new Error(`image fetch failed: ${response.status}`);
        const bitmap = await createImageBitmap(await response.blob());
        return { width: bitmap.width, height: bitmap.height, bitmap };
      }
      const before = await pixels(beforeUrl);
      const after = await pixels(afterUrl);
      const width = after.width;
      const height = after.height;
      // Compare at the after image's size so a resized source still lines up.
      const draw = (bitmap: ImageBitmap) => {
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('no 2d context');
        context.drawImage(bitmap, 0, 0, width, height);
        return context.getImageData(0, 0, width, height).data;
      };
      const a = draw(before.bitmap);
      const b = draw(after.bitmap);
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        const delta = Math.max(
          Math.abs((a[i] ?? 0) - (b[i] ?? 0)),
          Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)),
          Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)),
        );
        if (delta > threshold) changed += 1;
      }
      const beforeAspect = before.width / before.height;
      const afterAspect = width / height;
      return {
        share: changed / (width * height),
        width,
        height,
        // The output is scaled to a whole-pixel size, so the aspect ratio may round slightly.
        sameAspect: Math.abs(beforeAspect - afterAspect) / afterAspect < 0.01,
      };
    },
    { beforeUrl, afterUrl, threshold },
  );
}

test('the sample dining room is uploaded and comes back decorated', async ({ page }) => {
  await uploadSample(page, 'sample-dining-room.jpg', 'e2e-decorated-dining-room.jpg');
  await expectResult(page);

  const card = page.locator('.variant');
  await expect(card.getByText('Your photo')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /Your place, ready for Christmas/,
  );

  // The generated image names what the plan decorated in this dining room.
  const after = card.locator('img.compare__after, .compare__after img').first();
  await expect(after).toHaveAttribute('alt', /decorated for Christmas: decorations on /);
  await expect
    .poll(() => after.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  // The decorated image keeps the room's framing and visibly adds decorations to it: a real
  // share of its pixels changes strongly, which a colour grade alone would not do.
  const before = card.locator('img.compare__before').first();
  const beforeUrl = await before.getAttribute('src');
  const afterUrl = await after.getAttribute('src');
  expect(beforeUrl).toBeTruthy();
  expect(afterUrl).toBeTruthy();
  expect(afterUrl).not.toBe(beforeUrl);
  const result = await changedShare(page, beforeUrl ?? '', afterUrl ?? '');
  expect(result.sameAspect).toBe(true);
  expect(result.width).toBeGreaterThanOrEqual(512);
  expect(result.share).toBeGreaterThan(0.01);
  expect(result.share).toBeLessThan(0.6);
});
