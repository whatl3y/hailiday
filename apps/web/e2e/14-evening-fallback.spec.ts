import { expect, test } from '@playwright/test';
import { expectResult, lookRow, nextRenderRequest, uploadSample } from './support';

test.describe('an evening look whose evening light cannot be made', () => {
  test('arrives in daylight with one line and one action; a reload starts nothing', async ({
    page,
  }) => {
    let renderRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/renders') {
        renderRequests += 1;
      }
    });
    const firstLook = nextRenderRequest(page);
    // "relight reject" in the file name: the decorations pass and every relight fails its checks.
    await uploadSample(page, 'sample-front-porch.jpg', 'e2e-relight-reject-front-porch.jpg');
    expect(await firstLook).toMatchObject({ style: 'abundant', lightingMode: 'evening' });

    // The decorated picture is the result, in the photo's own light, with one line and one action.
    await expectResult(page);
    const line = page.locator('.look-notice--light');
    await expect(line).toContainText(
      "The evening light didn't come out this time, so here is the look in daylight.",
    );
    await expect(line.getByRole('button', { name: 'Try the evening light again' })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(lookRow(page)).toContainText('Christmas · Abundant');
    await expect(lookRow(page)).not.toContainText('Evening');
    await expect(page.locator('main')).not.toContainText(/error|failed|didn.t work out/i);
    // A picture arrived, so the page does not ask again by itself.
    expect(renderRequests).toBe(1);

    // A reload shows the same look with its line and starts nothing.
    await page.reload();
    await expectResult(page);
    await expect(line).toBeVisible();
    await page.waitForTimeout(3_000);
    expect(renderRequests).toBe(1);

    // The action asks for the evening light again.
    const again = nextRenderRequest(page);
    await line.getByRole('button', { name: 'Try the evening light again' }).click();
    expect(await again).toMatchObject({ style: 'abundant', lightingMode: 'evening' });
  });
});
