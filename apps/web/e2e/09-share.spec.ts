import { expect, test } from '@playwright/test';
import { COPY, resultFromUpload } from './support';

test('a share link shows the preview publicly and can be stopped', async ({
  page,
  browser,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await resultFromUpload(page, 'e2e-share-front-porch.jpg');

  await page.getByRole('button', { name: 'Share' }).click();
  const sheet = page.getByRole('dialog', { name: COPY.shareHeading });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/It never includes your address/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Copy link' }).click();
  const linkField = sheet.getByLabel('Link to share');
  await expect(linkField).toHaveValue(/\/s\/[A-Za-z0-9_-]{16,}$/);
  const shareUrl = await linkField.inputValue();

  const visitor = await browser.newContext();
  const shared = await visitor.newPage();
  await shared.goto(shareUrl);
  await expect(shared.getByText(COPY.shareCaption)).toBeVisible();
  // The header is an ink band above the ink stage, and the browser chrome follows it.
  await expect(shared.locator('header.site-header--stage')).toBeVisible();
  await expect(shared.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0d0d0f');
  // The picture fills the stage under the header; its headline and the one way in stay in the
  // first viewport.
  await expect(shared.locator('.shared__stage .stage__picture img.shared__after')).toBeVisible();
  await expect(shared.getByRole('heading', { name: COPY.shareCaption })).toBeInViewport();
  await expect(shared.getByRole('link', { name: COPY.shareCta })).toBeInViewport();
  await expect(shared.locator('.badge--ai')).toBeVisible();
  await expect(shared.getByRole('link', { name: COPY.shareCta })).toHaveAttribute(
    'href',
    /\?holiday=/,
  );
  await expect(shared.getByRole('button', { name: 'Report this image' })).toBeVisible();
  await expect(shared.getByText(COPY.shopHeading)).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Stop sharing' }).click();
  const confirm = page.getByRole('dialog', { name: 'Stop sharing' });
  await confirm.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(page.getByText(/Sharing stopped/)).toBeVisible();

  await shared.reload();
  await expect(shared.getByText(COPY.shareRevoked)).toBeVisible();
  await expect(shared.locator('header.site-header--stage')).toHaveCount(0);
  await expect(shared.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#ffffff');
  await visitor.close();
});
