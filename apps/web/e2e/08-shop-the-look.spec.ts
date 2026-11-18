import { expect, test } from '@playwright/test';
import { COPY, openResultRow, resultFromUpload } from './support';

test('Shop the look shows its disclosure before any retailer link', async ({ page, context }) => {
  await resultFromUpload(page, 'e2e-shop-front-porch.jpg');

  // Shop the look starts collapsed; its products are requested when it opens.
  const products = page.waitForResponse((response) =>
    /\/v1\/renders\/[^/]+\/products$/.test(new URL(response.url()).pathname),
  );
  await openResultRow(page, COPY.shopHeading);
  await products;
  const panel = page.getByRole('region', { name: COPY.shopHeading });
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.locator('.indeterminate')).toHaveCount(0);
  await expect(panel).not.toHaveAttribute('aria-busy', 'true');
  // Every option, search link and separate link opens the retailer in a new tab.
  const retailerLinks = panel.locator('a[target="_blank"]');
  const linkCount = await retailerLinks.count();

  if (linkCount === 0) {
    // A panel with nothing to show, or one the server hides, keeps its row with one line.
    await expect(panel.getByText(COPY.noOffers).or(panel.getByText(COPY.offSeason))).toBeVisible();
    await expect(
      page.locator('.disclosure__toggle').filter({ hasText: /^Shop the look/ }),
    ).toHaveCount(1);
    return;
  }

  // An active panel titles each decoration with a heading under the panel's.
  await expect(panel.getByRole('heading', { level: 3 }).first()).toBeVisible();

  const paid = panel.getByText(COPY.disclosurePaid);
  const plain = panel.getByText(COPY.disclosurePlain);
  await expect(paid.or(plain)).toBeVisible();
  // The disclosure precedes the first retailer link in reading order.
  const disclosureFirst = await panel.evaluate((root) => {
    const disclosure = root.querySelector('.shop__disclosure');
    const link = root.querySelector('a[target="_blank"]');
    return Boolean(
      disclosure &&
      link &&
      disclosure.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
  expect(disclosureFirst).toBe(true);
  if ((await paid.count()) === 0) await expect(panel.locator('.product__ad')).toHaveCount(0);

  // Each decoration shows its options or a line of links to retailers' own search results.
  const findLines = panel.getByText(COPY.shopFindLabel, { exact: true });
  const options = panel.locator('.product');
  await expect(findLines.first().or(options.first()).first()).toBeVisible();
  if ((await options.count()) > 0) {
    await expect(panel.getByText(/Check price at retailer|as of/).first()).toBeVisible();
  }
  await expect(panel.getByText(COPY.shopFitNote)).toBeVisible();

  // A retailer link records the click and opens the retailer (example.com in fixture mode).
  const searchLinks = panel.locator('.shop-link');
  const first = (await searchLinks.count()) > 0 ? searchLinks.first() : retailerLinks.first();
  await expect(first).toHaveAccessibleName(/opens the retailer in a new tab/);
  // The suite never opens a real retailer: in fixture mode every link goes to example.com.
  const href = (await first.getAttribute('href')) ?? '';
  const host = URL.canParse(href) ? new URL(href).hostname : '';
  expect(
    host,
    `retailer link host is "${host}", not example.com: run this suite against the browser-test stack, where commerce is in fixture mode`,
  ).toBe('example.com');
  const click = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/v1/clicks',
  );
  const popup = context.waitForEvent('page');
  await first.click();
  await click;
  await (await popup).close();
});
