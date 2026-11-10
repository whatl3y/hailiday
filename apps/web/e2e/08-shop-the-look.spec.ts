import { expect, test } from '@playwright/test';
import { COPY, resultFromUpload } from './support';

test('Shop the look shows its disclosure before any product link', async ({ page, context }) => {
  await resultFromUpload(page, 'e2e-shop-front-porch.jpg');

  const panel = page.getByRole('region', { name: COPY.shopHeading });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const cards = panel.getByRole('link').filter({ hasText: /at / });
  const cardCount = await cards.count();

  if (cardCount === 0) {
    await expect(panel.getByText(COPY.noOffers).or(panel.getByText(COPY.offSeason))).toBeVisible();
    return;
  }

  const paid = panel.getByText(COPY.disclosurePaid);
  const plain = panel.getByText(COPY.disclosurePlain);
  await expect(paid.or(plain)).toBeVisible();
  // The disclosure precedes the first card in reading order.
  const disclosureFirst = await panel.evaluate((root) => {
    const disclosure = root.querySelector('.shop__disclosure');
    const card = root.querySelector('.product');
    return Boolean(
      disclosure &&
      card &&
      disclosure.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(disclosureFirst).toBe(true);
  if ((await paid.count()) === 0) await expect(panel.locator('.product__ad')).toHaveCount(0);
  await expect(panel.getByText(/Check price at retailer|as of/).first()).toBeVisible();
  await expect(panel.getByText(/Sizes, quantities and fit aren't guaranteed/)).toBeVisible();

  const click = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/v1/clicks',
  );
  const popup = context.waitForEvent('page');
  await cards.first().click();
  await click;
  await (await popup).close();
});
