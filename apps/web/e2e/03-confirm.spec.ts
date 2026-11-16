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
  // The frame sits on the ink stage under the ink header, laid out at the size its look will
  // have (the 1024px working grid), with no ambient layer.
  await expect(page.locator('.site-header--stage')).toBeVisible();
  await expect(page.locator('.stage')).toHaveAttribute('style', /--stage-w: ?1024;/);
  await expect(page.locator('.stage__ambient')).toHaveCount(0);
  const views = page.getByRole('button', { name: /^View \d/ });
  expect(await views.count()).toBeGreaterThan(1);

  await page.getByRole('button', { name: COPY.confirmYes }).click();
  await expectResult(page);
});

test('a place whose street photo is credited to a contributor is confirmed, then decorated', async ({
  page,
}) => {
  await openLanding(page);
  await chooseAddress(page, '31 Pinon', 'Piñon Mesa');

  // Contributor imagery never auto-starts: the ordinary confirmation screen comes first.
  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toBeVisible({
    timeout: 30_000,
  });
  await expectFixtureStreetCredit(page);
  await expect(page.locator('.attribution').first()).toContainText(COPY.contributorCredit);
  await expect(page.getByText(COPY.confirmOnly)).toHaveCount(0);
  const views = page.getByRole('button', { name: /^View \d/ });
  expect(await views.count()).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: /Look left/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Look right/ })).toBeVisible();

  await page.getByRole('button', { name: COPY.confirmYes }).click();
  await expectResult(page);
  // The result credits the contributor's photo, never Google.
  await expectFixtureStreetCredit(page);
  await expect(page.locator('.attribution').first()).toContainText(COPY.contributorCredit);
});
