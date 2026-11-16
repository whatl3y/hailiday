import { expect, test } from '@playwright/test';
import { COPY, chooseAddress, expectResult, lookCard, openLanding, openResultRow } from './support';

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

  // The look controls start collapsed under "Try another look".
  const holidays = page.getByRole('group', { name: 'Holiday' });
  await expect(holidays).toBeHidden();
  await openResultRow(page, 'Try another look');
  const original = holidays.getByRole('button', { pressed: true });
  const originalName = (await original.innerText()).trim();
  const other = holidays.getByRole('button', { pressed: false }).first();
  const otherName = (await other.innerText()).trim();

  const requestsBefore = renderRequests;
  await other.click();
  await expect(
    page.getByRole('group', { name: `Decorating the ${otherName} look…` }),
  ).toBeVisible();
  // The current preview stays on screen, still marked, while the new look is decorated.
  const mark = page.locator('.variant .badge--ai');
  await expect(mark).toBeVisible();
  // The status card hangs below the mark: once the page is back at the picture with the mark in
  // view and the mark has moved below the light string, nothing of the card lies over any part of
  // it.
  await expect
    .poll(() =>
      mark.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const picture = element.closest('.stage__picture')!.getBoundingClientRect();
        const pictureScreen = element.closest<HTMLElement>('.picture-screen')!;
        const clear = parseFloat(pictureScreen.style.getPropertyValue('--string-clear'));
        const points = [
          [box.left + 2, box.top + 2],
          [box.right - 2, box.top + 2],
          [box.left + box.width / 2, box.top + box.height / 2],
          [box.left + 2, box.bottom - 2],
          [box.right - 2, box.bottom - 2],
        ];
        return {
          inView: box.top >= 0 && box.bottom <= innerHeight && scrollY === 0,
          belowString: box.top - picture.top >= clear - 1,
          underCard: points.some(
            ([x, y]) => document.elementFromPoint(x!, y!)?.closest('.look-card') != null,
          ),
        };
      }),
    )
    .toEqual({ inView: true, belowString: true, underCard: false });
  // One look at a time: the original holiday is locked, says why, and asks for nothing.
  const locked = holidays.getByRole('button', { name: originalName });
  await expect(locked).toHaveAttribute('aria-disabled', 'true');
  // The page reads the project's looks before it asks for the new one: the count is read once
  // that request has left.
  await expect.poll(() => renderRequests).toBe(requestsBefore + 1);
  const requestsWhileMaking = renderRequests;
  await locked.click({ force: true });
  // The card says why, for a few seconds (the panel says it for as long as the lock lasts).
  await expect(lookCard(page).getByText(COPY.locked)).toBeVisible();
  expect(renderRequests).toBe(requestsWhileMaking);
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
  await expect(lookCard(page)).toHaveCount(0);
  expect(renderRequests).toBe(afterNewLook);
});
