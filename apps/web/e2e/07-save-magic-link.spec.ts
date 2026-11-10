import { expect, test } from '@playwright/test';
import { COPY, magicLinkFrom, readLatestEmail, resultFromUpload } from './support';

test('saving sends a magic link that signs in and keeps the place', async ({ page }) => {
  await resultFromUpload(page, 'e2e-save-front-porch.jpg');
  const projectPath = new URL(page.url()).pathname;

  await page.getByRole('button', { name: 'Save' }).click();
  const sheet = page.getByRole('dialog', { name: COPY.saveHeading });
  await expect(sheet).toBeVisible();
  const email = `e2e+${Date.now()}@example.com`;
  await sheet.getByLabel('Email').fill(email);
  await sheet.getByRole('button', { name: 'Send link' }).click();
  await expect(sheet.getByText(COPY.saveSent)).toBeVisible();

  const link = magicLinkFrom(await readLatestEmail(email));
  expect(new URL(link).pathname).toBe('/auth/verify');
  await page.goto(link);

  await page.waitForURL((url) => url.pathname === projectPath, { timeout: 30_000 });
  await expect(page.getByText(COPY.saveDone)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Saved' })).toBeVisible();

  await page.goto('/places');
  await expect(page.getByRole('heading', { name: 'Your places' })).toBeVisible();
  await expect(page.locator('.place')).not.toHaveCount(0);
});
