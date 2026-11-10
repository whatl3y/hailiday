import { expect, test } from '@playwright/test';
import { COPY, chooseAddress, openLanding } from './support';

test('an address without a usable street photo goes to the upload path', async ({ page }) => {
  await openLanding(page);
  await chooseAddress(page, '4120 Bitterroot', 'Bitterroot');

  await expect(page.getByRole('heading', { name: COPY.nosvHeading })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("Street View doesn't have a usable photo here.")).toBeVisible();
  // No image is shown as this address's photo.
  await expect(page.locator('.image-card img')).toHaveCount(0);
});

test('a multi-unit building asks for a photo of your own space', async ({ page }) => {
  await openLanding(page);
  await chooseAddress(page, '2150 Wicker', 'Wicker');
  await expect(page.getByRole('heading', { name: COPY.nosvHeading })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/This looks like a building with several homes/)).toBeVisible();
});
