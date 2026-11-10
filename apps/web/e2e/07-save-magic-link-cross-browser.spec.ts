import { expect, test } from '@playwright/test';
import { COPY, magicLinkFrom, readLatestEmail, resultFromUpload } from './support';

/** The masked email the confirmation shows: the first character, bullets, the full domain. */
function emailHintPattern(email: string): RegExp {
  const [local = '', domain = ''] = email.split('@');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^Sign in as ${escape(local.charAt(0))}•+@${escape(domain)}\\?$`);
}

test('a magic link opened in another browser asks first and signs in only that browser', async ({
  page,
  browser,
}) => {
  await resultFromUpload(page, 'e2e-cross-browser-front-porch.jpg');
  const projectPath = new URL(page.url()).pathname;
  const projectId = projectPath.split('/').pop() ?? '';

  await page.getByRole('button', { name: 'Save' }).click();
  const sheet = page.getByRole('dialog', { name: COPY.saveHeading });
  await expect(sheet).toBeVisible();
  const email = `e2e-cross+${Date.now()}@example.com`;
  await sheet.getByLabel('Email').fill(email);
  await sheet.getByRole('button', { name: 'Send link' }).click();
  await expect(sheet.getByText(COPY.saveSent)).toBeVisible();
  const link = magicLinkFrom(await readLatestEmail(email));

  // A second browser (its own cookies, so its own session) opens the emailed link.
  const other = await browser.newContext();
  try {
    const verifier = await other.newPage();
    await verifier.goto(link);
    const confirm = verifier.getByRole('dialog', { name: emailHintPattern(email) });
    await expect(confirm).toBeVisible({ timeout: 30_000 });
    await expect(confirm.getByText("We'll save your places to this account.")).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Not me' })).toBeVisible();

    // Continue signs in this browser only. The asking browser's place is not moved into the
    // account, so the saved project is not this account's and the page returns to Your places.
    await confirm.getByRole('button', { name: 'Continue' }).click();
    await verifier.waitForURL((url) => url.pathname === '/places', { timeout: 30_000 });
    await expect(verifier.getByRole('heading', { name: 'Your places' })).toBeVisible();
    await expect(verifier.getByText(COPY.placesEmpty)).toBeVisible();
    await expect(verifier.locator('.place')).toHaveCount(0);

    const me = await verifier.request.get('/v1/me');
    expect(me.ok()).toBe(true);
    expect(await me.json()).toMatchObject({ user: { email }, savedProjects: 0 });
    const foreign = await verifier.request.get(`/v1/projects/${projectId}`);
    expect(foreign.status()).toBe(404);

    // The browser that asked for the link stays signed out and keeps its own place: its
    // session never becomes the account, and nothing of it is moved into the account.
    const asker = await page.request.get('/v1/me');
    expect(asker.ok()).toBe(true);
    expect(await asker.json()).toMatchObject({ user: null, savedProjects: 0 });
    const own = await page.request.get(`/v1/projects/${projectId}`);
    expect(own.ok()).toBe(true);
    await page.goto('/account');
    await expect(page.getByText(email)).toHaveCount(0);
  } finally {
    await other.close();
  }
});
