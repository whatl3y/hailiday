import { expect, test } from '@playwright/test';
import { chooseAddress, expectResult, openLanding } from './support';

test('switching holiday decorates a new look, and going back is instant', async ({ page }) => {
  let renderRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/renders') {
      renderRequests += 1;
    }
  });

  await openLanding(page);
  await chooseAddress(page, '14 Lantern', 'Lantern Hill');
  await expectResult(page);

  const holidays = page.getByRole('group', { name: 'Holiday' });
  const original = holidays.getByRole('button', { pressed: true });
  const originalName = (await original.innerText()).trim();
  const other = holidays.getByRole('button', { pressed: false }).first();
  const otherName = (await other.innerText()).trim();

  await other.click();
  await expect(
    page.getByRole('status').filter({ hasText: `Decorating the ${otherName} look` }),
  ).toBeVisible();
  // The current preview stays on screen while the new look is decorated.
  await expect(page.locator('.variant-card .badge--ai')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: `Your place, ready for ${otherName}` }),
  ).toBeVisible({
    timeout: 90_000,
  });
  const afterNewLook = renderRequests;

  await holidays.getByRole('button', { name: originalName }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: `Your place, ready for ${originalName}` }),
  ).toBeVisible({
    timeout: 2_000,
  });
  await expect(page.getByText(/Decorating the .* look/)).toHaveCount(0);
  expect(renderRequests).toBe(afterNewLook);
});
