import { expect, test } from '@playwright/test';
import { chooseAddress, expectResult, lookCard, openLanding, openResultRow } from './support';

/** The fixture place's stored display address, which labels its group in the gallery. */
const LANTERN_HILL = '14 Lantern Hill Rd, Maplebrook, VT 05341, USA';

test('every look of a place is kept in the gallery, and the address leads back to it', async ({
  page,
}) => {
  await openLanding(page);
  await chooseAddress(page, '14 Lantern', 'Lantern Hill');
  await expectResult(page);
  const placeUrl = page.url();

  // A second look of the same place.
  await openResultRow(page, 'Try another look');
  const styles = page.getByRole('group', { name: 'Style' });
  const firstStyle = (await styles.getByRole('button', { pressed: true }).innerText()).trim();
  const other = styles.getByRole('button', { pressed: false }).first();
  const otherStyle = (await other.innerText()).trim();
  await other.click();
  await expect(lookCard(page)).toBeVisible({ timeout: 15_000 });
  await expect(lookCard(page)).toHaveCount(0, { timeout: 90_000 });
  await expect(styles.getByRole('button', { name: otherStyle, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Both looks appear in the gallery under the address.
  await page
    .getByRole('group', { name: 'Keep this preview' })
    .getByRole('link', {
      name: 'Gallery',
    })
    .click();
  await page.waitForURL(/\/gallery$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible();
  const group = page.locator('.gallery__group').filter({
    has: page.getByRole('heading', { level: 2, name: LANTERN_HILL }),
  });
  await expect(group).toHaveCount(1);
  const tiles = group.locator('.gallery__tile');
  expect(await tiles.count()).toBeGreaterThanOrEqual(2);
  // Look labels join their parts with non-breaking spaces, which a regular expression sees as
  // they are: `\s` matches both kinds of space.
  await expect(group.getByText(new RegExp(`·\\s${firstStyle}(\\s·|$)`)).first()).toBeVisible();
  await expect(group.getByText(new RegExp(`·\\s${otherStyle}(\\s·|$)`)).first()).toBeVisible();
  await expect(group.locator('.gallery__badge').first()).toHaveText('AI preview');
  // Fixture stand-in frames never carry Google's name, on a tile or under it.
  await expect(group).not.toContainText(/Google/);
  // The header marks the gallery as the current page and shows no holiday picker here.
  await expect(page.locator('.site-header__nav .site-header__link')).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('.site-header .holiday-chip')).toHaveCount(0);

  // The viewer opens on a rendering and leads back to its place.
  await tiles.first().click();
  const viewer = page.getByRole('dialog');
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.badge--ai')).toBeVisible();
  // The viewer steps through the gallery with the arrow keys and shows the position.
  await expect(viewer.getByText(/^1 of \d+$/)).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(viewer.getByText(/^2 of \d+$/)).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(viewer.getByText(/^1 of \d+$/)).toBeVisible();
  await expect(viewer.getByRole('link', { name: 'Open this place' })).toHaveAttribute(
    'href',
    new URL(placeUrl).pathname,
  );
  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toHaveCount(0);

  // Typing the same address again returns to the same place, straight to its result.
  await openLanding(page);
  await chooseAddress(page, '14 Lantern', 'Lantern Hill');
  expect(page.url()).toBe(placeUrl);
  await expectResult(page, 30_000);
  await expect(page.getByRole('heading', { name: 'Is this the right place?' })).toHaveCount(0);
});
