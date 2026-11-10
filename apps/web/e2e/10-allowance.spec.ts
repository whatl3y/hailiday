import { expect, test } from '@playwright/test';
import { COPY, chooseAddress, expectResult, openLanding } from './support';

test.setTimeout(15 * 60_000);

test('at the daily limit the allowance sheet explains when more looks are available', async ({
  page,
}) => {
  await openLanding(page);
  await chooseAddress(page, '14 Lantern', 'Lantern Hill');
  await expectResult(page);

  const sheet = page.getByRole('dialog', { name: COPY.allowanceHeading });
  const band = page.getByText(/Decorating the .* look/);
  const holidayGroup = page.getByRole('group', { name: 'Holiday' });
  const styleGroup = page.getByRole('group', { name: 'Style' });

  // One control per step, so every step asks for exactly one look the project does not have
  // yet. Chips are found by name because the selected holiday moves to the front of its row.
  // Each new look shows the pending band (after the request debounce) until it is decorated;
  // once the allowance is spent, the sheet opens instead and makes the page behind it inert.
  const pressed = async (group: typeof styleGroup) =>
    (await group.getByRole('button', { pressed: true }).innerText()).trim();
  const looksMade = new Set([`${await pressed(holidayGroup)}|${await pressed(styleGroup)}`]);
  const steps = [
    ...(await styleGroup.getByRole('button').allInnerTexts()).map((name) => ({
      group: styleGroup,
      name: name.trim(),
    })),
    ...(await holidayGroup.getByRole('button').allInnerTexts()).map((name) => ({
      group: holidayGroup,
      name: name.trim(),
    })),
  ];
  for (const { group, name } of steps) {
    const holiday = group === holidayGroup ? name : await pressed(holidayGroup);
    const style = group === styleGroup ? name : await pressed(styleGroup);
    // A look the project already has switches instantly and spends nothing.
    if (looksMade.has(`${holiday}|${style}`)) continue;
    looksMade.add(`${holiday}|${style}`);
    await group.getByRole('button', { name, exact: true }).click();
    await expect(band.or(sheet).first()).toBeVisible({ timeout: 15_000 });
    if (await sheet.isVisible()) break;
    await expect(band).toHaveCount(0, { timeout: 90_000 });
    if (await sheet.isVisible()) break;
  }

  await expect(sheet).toBeVisible();
  await expect(sheet.getByText(/More looks tomorrow at/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Got it' }).click();
  await expect(sheet).toHaveCount(0);
  // Everything behind the sheet stays usable.
  await expect(page.getByText(/^No more looks today · more at /)).toBeVisible();
  await expect(page.locator('.variant-card .badge--ai')).toBeVisible();
  await page.getByRole('button', { name: 'Before' }).click();
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuenow', '100');
});
