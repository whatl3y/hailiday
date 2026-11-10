import { expect, test } from '@playwright/test';
import {
  COPY,
  chooseAddress,
  expectFixtureStreetCredit,
  expectResult,
  openLanding,
} from './support';

test('a clean address starts decorating at once and reveals the result', async ({ page }) => {
  await openLanding(page);
  // The slow fixture place keeps the waiting screen up long enough to read it.
  await chooseAddress(page, '1735 Magnolia', 'Magnolia');

  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toHaveCount(0);
  const status = page.getByRole('status').filter({ hasText: COPY.stageLabels });
  await expect(status.first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: COPY.notYourPlace })).toBeVisible();
  await expectFixtureStreetCredit(page);

  await expectResult(page);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expectFixtureStreetCredit(page);
  await expect(page.getByText(/^\d+ more looks? today$/)).toBeVisible();

  const slider = page.getByRole('slider', { name: 'Compare before and after' });
  await slider.focus();
  await page.keyboard.press('End');
  await expect(slider).toHaveAttribute('aria-valuetext', '100% before photo');
  await expect(page.getByRole('button', { name: 'Before' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'AI preview' }).click();
  await expect(slider).toHaveAttribute('aria-valuenow', '0');
});
