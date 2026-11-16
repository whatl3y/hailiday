import { expect, test } from '@playwright/test';
import { COPY, lookCard, uploadSample } from './support';

test.describe('a look that cannot be finished', () => {
  test('is tried once more by the page, then ends in a calm notice; a reload starts nothing', async ({
    page,
  }) => {
    let renderRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/renders') {
        renderRequests += 1;
      }
    });
    // A file name with "reject" makes the fixture judge refuse every attempt of the look.
    await uploadSample(page, 'sample-dining-room.jpg', 'e2e-reject-dining-room.jpg');

    // The page asks once more by itself and says so on the status card.
    await expect(lookCard(page)).toContainText('Taking one more pass to get this right.', {
      timeout: 60_000,
    });
    // Then it says so calmly, inline, with something to do.
    const notice = page.locator('.look-notice');
    await expect(notice).toContainText(
      "We couldn't finish this look. Nothing was counted against your looks today.",
      { timeout: 60_000 },
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(notice.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Use another photo' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/error|failed|didn.t work out/i);
    // The look the person asked for and the one second try: no more.
    expect(renderRequests).toBe(2);

    // A reload opens the photo to decorate again and starts nothing by itself.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Decorate this photo' })).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(4_000);
    await expect(page.getByRole('heading', { level: 1, name: COPY.resultHeading })).toHaveCount(0);
    expect(renderRequests).toBe(2);
  });
});
