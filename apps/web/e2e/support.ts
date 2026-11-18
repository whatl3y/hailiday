import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, request, type Locator, type Page } from '@playwright/test';

/** Sample photos shipped with the content library (fictional, rights-cleared test images). */
export const SAMPLES_DIR = fileURLToPath(
  new URL('../../../packages/server/content/photos/samples/', import.meta.url),
);

export const MAILPIT_API = process.env.HAILIDAY_E2E_MAILPIT_URL ?? 'http://localhost:8025/api/v1';

/** Copy the tests look for (from the experience copy deck). */
export const COPY = {
  addressLabel: 'Enter a US address',
  headline: 'Imagine your place for the holidays.',
  confirmHeading: 'Is this the right place?',
  confirmYes: 'Yes, decorate this place',
  /** The line under the address when the views look across or along the road. */
  confirmRoadGuide:
    "Choose the view that shows your home, then look left or right until it's in the middle.",
  /** The empty state when address lookup runs on the fixture provider (no Google keys). */
  sampleModeNotice:
    'No matches. This setup has no Google Maps keys, so address search only knows the sample places. Try one below, or upload a photo to decorate your own place.',
  nosvHeading: "We can't use a street photo for this address",
  resultHeading: /Your place, ready for/,
  notYourPlace: 'Not your place?',
  /** Fixture stand-in street photos credit their photographer, never Google. */
  fixturePhotoCredit: /Fixture photo: \S.* \/ \S/,
  /** The fixture stand-in for a street photo credited to a contributor (not Google). */
  contributorCredit: '(contributor imagery stand-in)',
  /** The confirmation-only screen's explanation (a place whose photo may not be decorated). */
  confirmOnly:
    "We can show this street photo so you can check the place, but we can't decorate it.",
  stageLabels:
    /Getting your photo ready|Zooming in on your home|Sharpening your street photo|Planning the decorations|Decorating|Checking the details|Setting the evening light|Brightening the room|A person is checking your preview/,
  /** The lock line: a control that would start another look while one is being made. */
  locked: 'You can pick another look when this one is ready.',
  allowanceHeading: "That's all the looks for today",
  shopHeading: 'Shop the look',
  shareHeading: 'Share this preview',
  shareCaption: 'A holiday preview made with Hailiday',
  shareCta: 'See your place for the holidays',
  shareRevoked: 'This preview is no longer shared.',
  saveHeading: 'Save this place',
  saveSent: /Check your email for a link from Hailiday/,
  saveDone: 'Saved. Find it any time under Your places.',
  placesEmpty: 'Nothing saved yet. Decorate a place and tap Save.',
  peopleHeading: 'This photo seems to include people',
  privateOnly:
    "This preview is private. It can't be shared or downloaded because people are in the photo.",
  disclosurePaid: 'Ad · Paid links. We earn a commission if you buy through these links.',
  disclosurePlain: "These links go to the retailer. We don't earn anything from them.",
  noOffers: "Matching decorations aren't available for this look yet.",
  offSeason: /Plan ahead: decorations for .* appear here closer to the season\./,
  /** The label before a decoration's links to retailers' own search results. */
  shopFindLabel: 'Find similar at',
  shopFitNote: /Sizes, quantities and fit aren't guaranteed/,
} as const;

/**
 * The status card of the look being made (on the stage, on paper, or over the title): a group
 * named "Decorating your place" on a first look, "Decorating the {holiday} look…" for another.
 */
export function lookCard(page: Page): Locator {
  return page.getByRole('group', { name: /^Decorating (your place|the .* look…)$/ });
}

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
  await expect(page.locator('.variant .badge--ai')).toBeVisible();
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

/**
 * Opens one of the collapsed rows under the result ("Try another look", "Shop the look",
 * "How does it look?", "More"); a row that is already open stays open.
 */
export async function openResultRow(page: Page, label: string): Promise<void> {
  const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const toggle = page.locator('.disclosure__toggle').filter({ hasText: pattern });
  await expect(toggle).toHaveCount(1);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** The look a `POST /v1/renders` request asks for. */
export interface RequestedLook {
  holidayId: string;
  style: string;
  lightingMode: string;
}

/**
 * Resolves with the look of the next render request the page sends. Call it before the action
 * that starts the render.
 */
export function nextRenderRequest(page: Page): Promise<RequestedLook> {
  return page
    .waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/v1/renders',
      { timeout: 90_000 },
    )
    .then((request) => request.postDataJSON() as RequestedLook);
}

/** The "Try another look" row toggle, whose summary names the look on screen. */
export function lookRow(page: Page): Locator {
  return page.getByRole('button', { name: /^Try another look/ });
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
