import { expect, test, type Page } from '@playwright/test';

/**
 * Screen 13 (Users & roles, Admin-only). Beyond the demo arc's render-only
 * check: the full create → edit role → disable lifecycle, and that a
 * non-admin can't reach the screen at all (API already enforces this —
 * users.controller.ts @Roles('ADMIN') — this proves the frontend route
 * matches).
 */

const PASSWORD = 'ChangeMe123!';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel(/username/i).or(page.locator('input').first()).fill(username);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText('● ONLINE').or(page.getByText(/OFFLINE/))).toBeVisible({ timeout: 10_000 });
}

// UserForm pairs <label> with its <input>/<select> as plain DOM siblings,
// with no htmlFor/id — getByLabel() can't resolve them.
const fieldByLabel = (page: Page, labelText: string) => page.locator(`label:has-text("${labelText}") + input`);
const selectByLabel = (page: Page, labelText: string) => page.locator(`label:has-text("${labelText}") + select`);

test('admin: create a user, change their role, then disable them', async ({ page }) => {
  const stamp = Date.now();
  const username = `pw-test-${stamp}`;
  const fullName = `PW Test User ${stamp}`;

  await login(page, 'admin');
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: /Users & roles/ })).toBeVisible();

  // ── create ──────────────────────────────────────────────────────────────
  await page.getByRole('button', { name: /new user/i }).click();
  await expect(page.getByRole('heading', { name: 'New user' })).toBeVisible();
  await fieldByLabel(page, 'Username').fill(username);
  await fieldByLabel(page, 'Full name').fill(fullName);
  await fieldByLabel(page, 'Password').fill('TestPass123');
  await page.getByRole('button', { name: /^Save$/ }).click();

  await expect(page.getByRole('heading', { name: 'New user' })).not.toBeVisible();
  const row = () => page.locator('tr', { hasText: fullName });
  await expect(row()).toBeVisible();
  await expect(row()).toContainText(`@${username}`);
  await expect(row()).toContainText('CASHIER'); // form default (UserForm initial state)
  await expect(row()).toContainText('active');

  // ── edit role ───────────────────────────────────────────────────────────
  await row().getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('heading', { name: `Edit @${username}` })).toBeVisible();
  await selectByLabel(page, 'Role').selectOption('MANAGER');
  await page.getByRole('button', { name: /^Save$/ }).click();

  await expect(page.getByRole('heading', { name: `Edit @${username}` })).not.toBeVisible();
  await expect(row()).toContainText('MANAGER');

  // ── disable ─────────────────────────────────────────────────────────────
  await row().getByRole('button', { name: 'Disable' }).click();
  await expect(row()).toContainText('disabled');
  await expect(row().getByRole('button', { name: 'Enable' })).toBeVisible();
});

test('manager: cannot reach Users — redirected away, even though they can list via the API', async ({ page }) => {
  await login(page, 'boateng');
  await page.goto('/users');
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole('link', { name: 'Users' })).not.toBeVisible();
});
