import { expect, test } from '@playwright/test';
import {
  COPY,
  chooseAddress,
  expectFixtureStreetCredit,
  expectResult,
  lookCard,
  lookRow,
  nextRenderRequest,
  openLanding,
  openResultRow,
} from './support';

test('a clean address starts decorating at once and reveals the result', async ({ page }) => {
  await openLanding(page);
  const firstLook = nextRenderRequest(page);
  // The slow fixture place keeps the waiting screen up long enough to read it.
  await chooseAddress(page, '1735 Magnolia', 'Magnolia');
  // An exterior's first look is abundant in the evening.
  expect(await firstLook).toMatchObject({
    holidayId: 'christmas',
    style: 'abundant',
    lightingMode: 'evening',
  });

  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toHaveCount(0);
  const card = lookCard(page);
  await expect(card).toContainText(COPY.stageLabels, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: COPY.notYourPlace })).toBeVisible();
  // The light string hangs along the stage's top edge, and the trail names the stages so far.
  await expect(page.locator('.stage .light-string')).toBeVisible();
  await expect(card.getByRole('list', { name: 'Steps so far' })).toContainText('Photo');
  await expect(page.getByRole('group', { name: 'While you wait' })).toBeVisible();
  // Nothing can start a second look: the header's holiday picker is locked and opens nothing.
  const chip = page.getByRole('button', { name: /^Holiday: / });
  await expect(chip).toHaveAttribute('aria-disabled', 'true');
  // A locked control stays focusable and clickable for the person; Playwright would wait for it
  // to be enabled, so the click is forced.
  await chip.click({ force: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectFixtureStreetCredit(page);
  // The stage screens wear the ink header, and the browser's chrome follows it.
  await expect(page.locator('.site-header--stage')).toBeVisible();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0d0d0f');
  // The Street View frame waits at the size its look will have, so nothing moves on arrival.
  const box = () =>
    page.evaluate(() =>
      ['.stage', '.stage__picture'].map((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return [rect.left, rect.top, rect.width, rect.height].map(Math.round);
      }),
    );
  const waiting = await box();

  await expectResult(page);
  await expect.poll(box).toEqual(waiting);
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await expectFixtureStreetCredit(page);
  // The picture fills the first viewport edge to edge under the header, and the title line with
  // its actions stays on the first screen.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const header = document.querySelector('.site-header')!.getBoundingClientRect();
        const stage = document.querySelector('.stage')!.getBoundingClientRect();
        const actions = document
          .querySelector('.picture-head .result-actions__row')!
          .getBoundingClientRect();
        return {
          underHeader: Math.round(stage.top - header.bottom) === 0,
          edgeToEdge: Math.round(stage.left) === 0 && Math.round(stage.width) === innerWidth,
          actionsOnScreen: actions.bottom <= innerHeight,
        };
      }),
    )
    .toEqual({ underHeader: true, edgeToEdge: true, actionsOnScreen: true });
  // The options under the picture start collapsed; the allowance counter is inside them.
  await expect(page.getByText(/^\d+ more looks? today$/)).toBeHidden();
  await expect(lookRow(page)).toContainText('Christmas · Abundant · Evening');
  await openResultRow(page, 'Try another look');
  await expect(page.getByText(/^\d+ more looks? today$/)).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Lighting' }).getByRole('button', { pressed: true }),
  ).toHaveText('Evening');

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

test('a reload keeps following the look, and Cancel stops it and returns to the place', async ({
  page,
}) => {
  let renderRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/renders') {
      renderRequests += 1;
    }
  });
  await openLanding(page);
  // The look exists once its request is answered: a reload before that starts it again.
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/renders',
  );
  // The slow fixture place keeps the look in the making long enough to cancel it.
  await chooseAddress(page, '1735 Magnolia', 'Magnolia');
  const card = lookCard(page);
  await expect(card).toContainText(COPY.stageLabels, { timeout: 30_000 });
  await created;
  // A reload in the middle of the look follows the same look: no confirm step, no new request,
  // and the header's holiday picker still locked.
  await page.reload();
  await expect(card).toContainText(COPY.stageLabels, { timeout: 15_000 });
  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Holiday: / })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  expect(renderRequests).toBe(1);
  // Cancel on the look the page resumed stops it and shows the place to confirm.
  const cancel = card.getByRole('button', { name: 'Cancel' });
  await expect(cancel).not.toHaveAttribute('aria-disabled', 'true');
  await cancel.click();
  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toBeVisible({
    timeout: 15_000,
  });
  await expect(card).toHaveCount(0);
  await expect(page.locator('.light-string')).toHaveCount(0);
  // No result follows the canceled look.
  await page.waitForTimeout(5_000);
  await expect(page.getByRole('heading', { level: 1, name: COPY.resultHeading })).toHaveCount(0);
  expect(renderRequests).toBe(1);
  // A reload after Cancel opens the place to confirm again and does not start the look again.
  await page.reload();
  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('heading', { name: COPY.confirmHeading })).toBeVisible();
  await expect(card).toHaveCount(0);
  expect(renderRequests).toBe(1);
});
