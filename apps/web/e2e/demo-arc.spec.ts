import { expect, test, type Page } from '@playwright/test';

/**
 * The 90-second pitch arc (wireframes §Primary user flow) driven end-to-end:
 * login → POS sale with cash change → receipt → offline sale → reconnect
 * sync → owner dashboard. Plus render checks on every screen.
 */

const PASSWORD = 'ChangeMe123!';
const SHOTS = process.env.SHOT_DIR ?? 'test-results/shots';

async function login(page: Page, username: string) {
  await page.goto('/login');
  await page.getByLabel(/username/i).or(page.locator('input').first()).fill(username);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText('● ONLINE').or(page.getByText(/OFFLINE/))).toBeVisible({ timeout: 10_000 });
}

test.beforeEach(async ({ page }) => {
  // window.print blocks in some headless builds — the arc only needs the route
  await page.addInitScript(() => {
    window.print = () => {};
  });
});

test('cashier: search → add → F4 → cash change → server receipt', async ({ page }) => {
  await login(page, 'akosua');
  await expect(page).toHaveURL(/\/pos/);
  await page.screenshot({ path: `${SHOTS}/01-pos-empty.png` });

  const search = page.getByPlaceholder(/scan barcode or type/i);
  await search.fill('paracetamol 500');
  await expect(page.getByText(/Stock: \d+/).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/02-search-results.png` });

  // add 2 strips via the unit chip
  const stripChip = page.getByRole('button', { name: /strip GHS/ }).first();
  await stripChip.click();
  await stripChip.click();
  await expect(page.getByText('TOTAL', { exact: true })).toBeVisible();
  await expect(page.getByText('GHS 10.00').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-cart.png` });

  await page.keyboard.press('F4');
  await expect(page.getByText('Amount due')).toBeVisible();
  // the tender input carries the amount-due as its placeholder
  await page.getByPlaceholder(/^\d+\.\d{2}$/).fill('20');
  await expect(page.getByText('Change', { exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/04-payment.png` });

  await page.getByRole('button', { name: /confirm & print/i }).click();
  await expect(page).toHaveURL(/\/receipt/);
  await expect(page.locator('#receipt')).toContainText(/RCP-\d{4}-\d{6}/);
  await expect(page.locator('#receipt')).toContainText('Tendered / Change');
  await page.screenshot({ path: `${SHOTS}/05-receipt.png` });
});

test('offline: sale queues locally, badge shows, reconnect drains to 0', async ({ page, context }) => {
  // the offline catalogue comes from the snapshot — wait for it to be cached
  const snapshotCached = page.waitForResponse(
    (r) => r.url().includes('/catalog/snapshot') && r.ok(),
    { timeout: 20_000 },
  );
  await login(page, 'akosua');
  await expect(page).toHaveURL(/\/pos/);
  await snapshotCached;
  await page.waitForTimeout(500); // Dexie transaction commit

  await context.setOffline(true);
  await expect(page.getByText(/OFFLINE — sales are saved locally/)).toBeVisible();

  const search = page.getByPlaceholder(/scan barcode or type/i);
  await search.fill('paracetamol 500');
  await page.getByRole('button', { name: /strip GHS/ }).first().click();
  await page.keyboard.press('F4');
  await page.getByRole('button', { name: /confirm & print/i }).click();

  await expect(page).toHaveURL(/\/receipt/);
  await expect(page.locator('#receipt')).toContainText('OFFLINE — PENDING SYNC');
  await page.screenshot({ path: `${SHOTS}/06-offline-receipt.png` });

  await page.getByRole('link', { name: /POS/ }).click();
  await expect(page.getByText(/1 unsynced/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/07-unsynced-badge.png` });

  await context.setOffline(false);
  await expect(page.getByText('● ONLINE')).toBeVisible();
  await expect(page.getByText(/unsynced/)).toBeHidden({ timeout: 10_000 });
});

test('F9 hold/recall: park the sale, badge shows, recall restores the cart', async ({ page }) => {
  await login(page, 'akosua');
  await expect(page).toHaveURL(/\/pos/);

  const search = page.getByPlaceholder(/scan barcode or type/i);
  await search.fill('paracetamol 500');
  await page.getByRole('button', { name: /strip GHS/ }).first().click();
  await expect(page.getByText('TOTAL', { exact: true })).toBeVisible();

  await page.keyboard.press('F9');
  await page.getByRole('button', { name: /hold current sale/i }).click();
  await page.keyboard.press('Escape');

  await expect(page.getByText(/1 on hold/)).toBeVisible();
  await expect(page.getByText('Scan an item or search to begin')).toBeVisible();

  await page.keyboard.press('F9');
  await page.getByRole('button', { name: /^Recall$/ }).click();
  await expect(page.getByText('GHS 5.00').first()).toBeVisible();
  await expect(page.getByText(/on hold/)).toBeHidden();
});

test('owner: dashboard cards, action-needed, every screen renders', async ({ page }) => {
  await login(page, 'boateng');
  await expect(page).toHaveURL(/\/dashboard/);
  // Exact, or the card label collides with the "Sales" nav link and the
  // "Sales, last 14 days" heading — getByText matches substrings, case-insensitively.
  await expect(page.getByText('SALES', { exact: true })).toBeVisible();
  await expect(page.getByText('RECEIPTS', { exact: true })).toBeVisible();
  await expect(page.getByText(/Action needed/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/08-dashboard.png` });

  const screens: [string, RegExp][] = [
    ['/products', /Products/],
    ['/batches', /Batches & expiry/],
    ['/purchasing', /Purchasing/],
    ['/adjustments', /Stock adjustments/],
    ['/sales', /Sales/],
    ['/reports', /Reports/],
  ];
  for (const [path, heading] of screens) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
  }
  await page.goto('/batches');
  await page.screenshot({ path: `${SHOTS}/09-batches.png` });
});

test('admin: users & settings screens render and save', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/users');
  await expect(page.getByRole('heading', { name: /Users & roles/ })).toBeVisible();
  await expect(page.getByText('@akosua')).toBeVisible();

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /Settings/ })).toBeVisible();
  await page.getByRole('button', { name: /save settings/i }).click();
  await expect(page.getByText('Saved ✓')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-settings.png` });
});
