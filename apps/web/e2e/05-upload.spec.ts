import { expect, test } from '@playwright/test';
import { COPY, expectResult, uploadSample } from './support';

test.describe('upload', () => {
  test('an uploaded photo is decorated', async ({ page }) => {
    await uploadSample(page, 'sample-dining-room.jpg', 'e2e-dining-room.jpg');
    await expectResult(page);
    await expect(page.locator('.variant-card').getByText('Your photo')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Replace photo' })).toBeVisible();
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
