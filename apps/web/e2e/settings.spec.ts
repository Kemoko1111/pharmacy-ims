import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 14 (Settings, Admin-only). Beyond the demo arc's single
 * render-and-save check: role gating, a real value round-trip, and the
 * validation-error path (settings drive money math, so a rejected write
 * must be visible, not silent).
 */

const PASSWORD = 'ChangeMe123!';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel(/username/i).or(page.locator('input').first()).fill(username);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText('● ONLINE').or(page.getByText(/OFFLINE/))).toBeVisible({ timeout: 10_000 });
}

test('admin: VAT rate change persists across a reload', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible();

  const vatRate = page.getByLabel('VAT rate (0–1)');
  await vatRate.fill('0.15');
  await page.getByRole('button', { name: /save settings/i }).click();
  await expect(page.getByText('Saved ✓')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('VAT rate (0–1)')).toHaveValue('0.15');
});

test('admin: the browser blocks an out-of-range VAT rate before it is sent', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/settings');

  const vat = page.getByLabel('VAT rate (0–1)');
  await vat.fill('1.5'); // the input carries max="1"
  await page.getByRole('button', { name: /save settings/i }).click();

  // `max` fails constraint validation, so the form never submits — no request
  // leaves the page and neither outcome banner appears.
  expect(await vat.evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(false);
  await expect(page.getByText('Saved ✓')).not.toBeVisible();
});

test('admin: the server still refuses a bad VAT rate when the input constraint is bypassed', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/settings');

  // Anyone with DevTools can drop an HTML attribute, so the client constraint
  // is a convenience, not a control. Removing it here is the point of the test:
  // settings drive money math, and the server's refusal must reach the user
  // rather than failing silently.
  await page.getByLabel('VAT rate (0–1)').evaluate((el) => el.removeAttribute('max'));
  await page.getByLabel('VAT rate (0–1)').fill('1.5'); // valid range is 0–1 (settings.service.ts KNOWN_KEYS)
  await page.getByRole('button', { name: /save settings/i }).click();

  await expect(page.getByText('Invalid value for "vat_rate"')).toBeVisible();
  await expect(page.getByText('Saved ✓')).not.toBeVisible();
});

test('cashier: cannot reach Settings — redirected to their own workspace', async ({ page }) => {
  await login(page, 'akosua');
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/pos/);
  await expect(page.getByRole('link', { name: 'Settings' })).not.toBeVisible();
});
