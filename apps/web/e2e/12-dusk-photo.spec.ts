import { expect, test } from '@playwright/test';
import {
  chooseAddress,
  expectResult,
  lookCard,
  nextRenderRequest,
  openLanding,
  openResultRow,
} from './support';

test('a photo taken at dusk keeps its first look and offers no evening after it', async ({
  page,
}) => {
  let renderRequests = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/renders') {
      renderRequests += 1;
    }
  });

  await openLanding(page);
  const firstLook = nextRenderRequest(page);
  // The fixture street photo of Orchard Bluff was taken at dusk.
  await chooseAddress(page, '2401 Orchard', 'Orchard Bluff');
  expect(await firstLook).toMatchObject({ style: 'abundant', lightingMode: 'evening' });
  await expectResult(page);

  // The first look was decorated in the photo's own light; evening is no longer offered.
  await openResultRow(page, 'Try another look');
  await expect(page.getByRole('group', { name: 'Lighting' })).toHaveCount(0);
  const holidays = page.getByRole('group', { name: 'Holiday' });
  const originalName = (await holidays.getByRole('button', { pressed: true }).innerText()).trim();
  const other = holidays.getByRole('button', { pressed: false }).first();
  const otherName = (await other.innerText()).trim();

  await other.click();
  await expect(
    page.getByRole('heading', { level: 1, name: `Your place, ready for ${otherName}` }),
  ).toBeVisible({ timeout: 90_000 });
  const afterNewLook = renderRequests;

  // Going back opens the first look again instead of decorating the photo once more.
  await holidays.getByRole('button', { name: originalName }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: `Your place, ready for ${originalName}` }),
  ).toBeVisible({ timeout: 2_000 });
  await expect(lookCard(page)).toHaveCount(0);
  expect(renderRequests).toBe(afterNewLook);
});
