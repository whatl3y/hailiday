import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, request, type Page } from '@playwright/test';

/** Sample photos shipped with the content library (fictional, rights-cleared test images). */
export const SAMPLES_DIR = fileURLToPath(
  new URL('../../../packages/server/content/photos/samples/', import.meta.url),
);

export const MAILPIT_API = process.env.HOLIDAY_E2E_MAILPIT_URL ?? 'http://localhost:8025/api/v1';

/** Copy the tests look for (from the experience copy deck). */
export const COPY = {
  addressLabel: 'Enter a US address',
  headline: 'Imagine your place for the holidays.',
  confirmHeading: 'Is this the right place?',
  confirmYes: 'Yes, decorate this place',
  nosvHeading: "We can't use a street photo for this address",
  resultHeading: /Your place, ready for/,
  notYourPlace: 'Not your place?',
  /** Fixture stand-in street photos credit their photographer, never Google. */
  fixturePhotoCredit: /Fixture photo: \S.* \/ \S/,
  stageLabels:
    /Getting your photo ready|Planning the decorations|Decorating|Checking the details|A person is checking your preview/,
  allowanceHeading: "That's all the looks for today",
  shopHeading: 'Shop the look',
  shareHeading: 'Share this preview',
  shareCaption: 'A holiday preview made with Holiday',
  shareCta: 'See your place for the holidays',
  shareRevoked: 'This preview is no longer shared.',
  saveHeading: 'Save this place',
  saveSent: /Check your email for a link from Holiday/,
  saveDone: 'Saved. Find it any time under Your places.',
  placesEmpty: 'Nothing saved yet. Decorate a place and tap Save.',
  peopleHeading: 'This photo seems to include people',
  privateOnly:
    "This preview is private. It can't be shared or downloaded because people are in the photo.",
  disclosurePaid: 'Ad · Paid links. We earn a commission if you buy through these links.',
  disclosurePlain: "These links go to the retailer. We don't earn anything from them.",
  noOffers: "Matching decorations aren't available for this look yet.",
  offSeason: /Plan ahead: decorations for .* appear here closer to the season\./,
} as const;

/**
 * Opens the landing page with Christmas preselected by deep link, so a render can start even
 * when the run happens off-season.
 */
export async function openLanding(page: Page, holiday = 'christmas'): Promise<void> {
  await page.goto(`/?holiday=${holiday}`);
  await expect(page.getByRole('heading', { level: 1, name: COPY.headline })).toBeVisible();
}

/** Types into the address combobox and picks the suggestion containing `match`. */
export async function chooseAddress(page: Page, typed: string, match: string): Promise<void> {
  const field = page.getByRole('combobox', { name: COPY.addressLabel });
  await field.click();
  await field.pressSequentially(typed, { delay: 40 });
  const option = page.getByRole('option').filter({ hasText: match }).first();
  await expect(option).toBeVisible();
  await option.click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
}

/**
 * The attribution strip of a fixture Street View frame credits the photographer and never
 * names Google (the Google Maps logo belongs to real Street View imagery only).
 */
export async function expectFixtureStreetCredit(page: Page): Promise<void> {
  const strip = page.locator('.attribution').first();
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(COPY.fixturePhotoCredit);
  await expect(strip).not.toContainText(/Google/);
}

/** Waits for the result screen of a finished render. */
export async function expectResult(page: Page, timeout = 90_000): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: COPY.resultHeading })).toBeVisible({
    timeout,
  });
  await expect(page.locator('.variant-card .badge--ai')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Compare before and after' })).toBeVisible();
}

/**
 * Starts an upload-first project and uploads one of the sample photos under `fileName`, which
 * drives the fixture screening and render scenarios (see packages/server/fixtures/README.md).
 */
export async function uploadSample(
  page: Page,
  sample: string,
  fileName: string,
  holiday = 'christmas',
): Promise<void> {
  await page.goto(`/upload?holiday=${holiday}`);
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Upload a photo of your place' })).toBeVisible();
  await page.getByRole('checkbox', { name: /18 or older/ }).check();
  const buffer = await readFile(`${SAMPLES_DIR}${sample}`);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({ name: fileName, mimeType: 'image/jpeg', buffer });
}

/** Renders a decorated result from an uploaded sample photo. */
export async function resultFromUpload(page: Page, fileName = 'e2e-front-porch.jpg') {
  await uploadSample(page, 'sample-front-porch.jpg', fileName);
  await expectResult(page);
}

interface MailpitSummary {
  ID: string;
  To: Array<{ Address: string }>;
}

/** Polls Mailpit for the newest message to `email` and returns its text body. */
export async function readLatestEmail(email: string, timeoutMs = 30_000): Promise<string> {
  const api = await request.newContext({ baseURL: `${MAILPIT_API.replace(/\/$/, '')}/` });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const search = await api.get('search', { params: { query: `to:"${email}"`, limit: 5 } });
      if (search.ok()) {
        const body = (await search.json()) as { messages?: MailpitSummary[] };
        const latest = body.messages?.[0];
        if (latest) {
          const message = await api.get(`message/${latest.ID}`);
          const detail = (await message.json()) as { Text?: string; HTML?: string };
          return detail.Text ?? detail.HTML ?? '';
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`No email to ${email} arrived in Mailpit within ${timeoutMs} ms`);
  } finally {
    await api.dispose();
  }
}

/** The magic link (`…/auth/verify?token=…`) inside an email body. */
export function magicLinkFrom(text: string): string {
  const match = /https?:\/\/\S+\/auth\/verify\?token=[^\s"'<>]+/.exec(text);
  if (!match) throw new Error('The email has no sign-in link');
  return match[0].replace(/&amp;/g, '&');
}
