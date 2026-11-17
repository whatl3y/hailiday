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

test('an address on the road shows both sides of the road and says what to do', async ({
  page,
}) => {
  await openLanding(page);
  await chooseAddress(page, '560 Millpond', 'Millpond Rd');

  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toBeVisible({
    timeout: 30_000,
  });
  await expectFixtureStreetCredit(page);
  await expect(page.getByText(COPY.confirmRoadGuide)).toBeVisible();
  const views = page.getByRole('button', { name: /^View \d/ });
  await expect(views).toHaveCount(3);
  // Both sides of the road arrive with their picture; the view along it loads on request.
  for (const index of [0, 1]) {
    const thumb = views.nth(index).locator('img');
    await expect(thumb).toHaveCount(1);
    await expect
      .poll(() =>
        thumb.evaluate((image) => {
          const img = image as HTMLImageElement;
          return img.complete && img.naturalWidth > 0;
        }),
      )
      .toBe(true);
  }
  await expect(views.nth(2).locator('img')).toHaveCount(0);
  // The line, the views and the look buttons show under the picture without scrolling.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByText(COPY.confirmRoadGuide)).toBeInViewport({ ratio: 1 });
  await expect(views.nth(2)).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: /Look left/ })).toBeInViewport({ ratio: 1 });
  const frame = page.locator('.stage__image').first();
  await expect(frame).toHaveAttribute('src', /.+/);
  const first = (await frame.getAttribute('src')) ?? '';
  const viewRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'PUT' && path.endsWith('/viewpoint')) viewRequests.push(path);
  });
  // The other side of the road is one tap away and needs no request.
  await views.nth(1).click();
  await expect(frame).not.toHaveAttribute('src', first);
  await views.nth(0).click();
  await expect(frame).toHaveAttribute('src', first);
  expect(viewRequests).toHaveLength(0);
  // View 1 shows the home left of the middle: one turn to the left centres it.
  await page.getByRole('button', { name: /Look left/ }).click();
  await expect(frame).not.toHaveAttribute('src', first);
  expect(viewRequests).toHaveLength(1);
  await expect(page.getByText(COPY.confirmRoadGuide)).toBeVisible();
  await page.getByRole('button', { name: COPY.confirmYes }).click();
  await expectResult(page);
});
