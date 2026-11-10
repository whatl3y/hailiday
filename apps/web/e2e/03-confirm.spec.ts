import { expect, test } from '@playwright/test';
import {
  COPY,
  chooseAddress,
  expectFixtureStreetCredit,
  expectResult,
  openLanding,
} from './support';

test('an ambiguous match asks "Is this the right place?" before decorating', async ({ page }) => {
  await openLanding(page);
  await chooseAddress(page, '4 Driftwood', 'Driftwood Cove');

  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toBeVisible({
    timeout: 30_000,
  });
  await expectFixtureStreetCredit(page);
  await expect(page.getByText(/Street View image (from|, date unknown)/).first()).toBeVisible();
  const views = page.getByRole('button', { name: /^View \d/ });
  expect(await views.count()).toBeGreaterThan(1);

  await page.getByRole('button', { name: COPY.confirmYes }).click();
  await expectResult(page);
});
