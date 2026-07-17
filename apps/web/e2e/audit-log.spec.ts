import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 15 (Audit log, Admin/Manager — audit.controller.ts @Roles('ADMIN',
 * 'MANAGER')). Previously zero coverage. Every login already writes an
 * 'auth.login' audit entry (auth.service.ts) — used here as a known,
 * always-present fixture instead of depending on whatever else happens to
 * be in a shared dev database.
 */

const PASSWORD = 'ChangeMe123!';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel(/username/i).or(page.locator('input').first()).fill(username);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText('● ONLINE').or(page.getByText(/OFFLINE/))).toBeVisible({ timeout: 10_000 });
}

test('manager: sees their own login in the audit trail, filtered by entity, and can expand the diff', async ({
  page,
}) => {
  await login(page, 'boateng'); // writes an auth.login / entity=user audit row
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(page.getByText(/\d+ entries/)).toBeVisible();

  await page.locator('select').selectOption('user');
  const loginRow = page.getByRole('button', { name: /auth\.login/ }).first();
  await expect(loginRow).toBeVisible();

  await loginRow.click();
  await expect(page.getByText('Before')).toBeVisible();
  await expect(page.getByText('After')).toBeVisible();
});

test('pharmacist: cannot reach the audit log — Manager+ only', async ({ page }) => {
  await login(page, 'adjoa');
  await page.goto('/audit');
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('link', { name: 'Audit' })).not.toBeVisible();
});
