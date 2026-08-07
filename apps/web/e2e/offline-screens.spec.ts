import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Offline reads beyond the POS (ADR-013). The client's report was blunt: "even
 * the products don't work" offline. They didn't, and neither did the other
 * fourteen screens — only the POS had an offline path, so everything else
 * rendered an empty table with no explanation.
 *
 * Mocks the API for the same reason offline-pos.spec.ts does: the behaviour
 * under test is what happens when the server cannot be reached, which a running
 * server cannot reproduce.
 */

const API = 'http://localhost:3000/api/v1';
const HEALTH = 'http://localhost:3000/health';
const PASSWORD = 'ChangeMe123!';

const USER = {
  id: 'u-1',
  username: 'boateng',
  fullName: 'Kofi Boateng',
  role: 'MANAGER',
  activeBranch: { id: 'b-1', code: 'MAIN', name: 'Main Branch' },
  branches: [{ id: 'b-1', code: 'MAIN', name: 'Main Branch' }],
};

const PRODUCT = {
  id: 'p-1',
  name: 'Amoxicillin',
  genericName: 'amoxicillin',
  strength: '250mg',
  categoryName: 'Antibiotics',
  baseUnit: 'capsule',
  sellingPriceBase: '2.40',
  vatApplies: false,
  prescriptionOnly: true,
  qtyOnHand: 140,
  reorderLevel: 20,
  nearestExpiry: '2027-03-31',
  units: [],
  barcodes: [],
};

const CUSTOMER = { id: 'c-1', fullName: 'Adwoa Mensah', phone: '0244000000', balance: '0.00' };

/** A MANAGER lands on the dashboard after signing in, so it has to answer. */
const DASHBOARD = {
  today: { gross: '0.00', receipts: 0, byMethod: [] },
  actionNeeded: { lowStockCount: 0, expiringCount: 0, expiringValue: '0.00', expiredCount: 0 },
  trend14d: [],
  topSellers: [],
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

type World = {
  serverUp: boolean;
  customerPosts: { body: unknown; key: string | undefined }[];
  refuseCustomers?: boolean;
};

async function mockApi(page: Page, world: World) {
  await page.route(`${HEALTH}**`, (route) =>
    world.serverUp ? json(route, { status: 'ok', db: 'ok' }) : route.abort('connectionrefused'),
  );

  await page.route(`${API}/**`, async (route) => {
    if (!world.serverUp) return route.abort('connectionrefused');
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');

    if (path === '/auth/login') {
      return json(route, { accessToken: 'access-1', refreshToken: 'refresh-1', user: USER });
    }
    if (path === '/auth/me') return json(route, USER);
    if (path === '/catalog/snapshot') return json(route, { version: 'v1', products: [PRODUCT] });
    if (path === '/reports/dashboard') return json(route, DASHBOARD);
    if (path === '/products') return json(route, { data: [PRODUCT], meta: { total: 1 } });
    if (path === '/customers') {
      if (route.request().method() === 'POST') {
        if (world.refuseCustomers) {
          return json(
            route,
            { error: { code: 'DUPLICATE_CUSTOMER', message: 'A customer with that phone already exists' } },
            422,
          );
        }
        world.customerPosts.push({
          body: route.request().postDataJSON(),
          key: route.request().headers()['idempotency-key'],
        });
        return json(route, { id: 'c-2' }, 201);
      }
      return json(route, { data: [CUSTOMER], meta: { total: 1 } });
    }
    if (path === '/notifications') return json(route, { data: [], meta: { total: 0 } });
    return json(route, { data: [], meta: { total: 0 } });
  });
}

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#login-username').fill(USER.username);
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByText('● ONLINE')).toBeVisible({ timeout: 10_000 });
}

test('the products list still works after the server goes away', async ({ page }) => {
  const world: World = { serverUp: true, customerPosts: [] };
  await mockApi(page, world);
  await login(page);

  // Once, online — this is what fills the cache.
  await page.goto('/products');
  await expect(page.getByText('Amoxicillin').first()).toBeVisible();

  world.serverUp = false;
  await page.reload();
  await page.goto('/products');

  // The regression: this used to be an empty table with no explanation.
  await expect(page.getByText('Amoxicillin').first()).toBeVisible();
  await expect(page.getByText(/Showing saved data from/)).toBeVisible();
});

test('a screen never opened online says so instead of showing an empty table', async ({ page }) => {
  const world: World = { serverUp: true, customerPosts: [] };
  await mockApi(page, world);
  await login(page);

  world.serverUp = false;
  await page.goto('/customers');

  await expect(page.getByText('Not available offline.')).toBeVisible();
  await expect(page.getByText(/has not been opened while connected/)).toBeVisible();
});

test('cached screens survive a reload — the till can be restarted mid-outage', async ({ page }) => {
  const world: World = { serverUp: true, customerPosts: [] };
  await mockApi(page, world);
  await login(page);

  await page.goto('/products');
  await expect(page.getByText('Amoxicillin').first()).toBeVisible();

  // A till that is power-cycled during an outage keeps nothing in memory; the
  // cache has to be on disk to be worth anything.
  world.serverUp = false;
  await page.reload();

  await expect(page.getByText('Amoxicillin').first()).toBeVisible();
});

test('signing out clears cached screens — a shared till leaks nothing', async ({ page }) => {
  const world: World = { serverUp: true, customerPosts: [] };
  await mockApi(page, world);
  await login(page);

  await page.goto('/products');
  await expect(page.getByText('Amoxicillin').first()).toBeVisible();

  await page.getByRole('button', { name: /sign out/i }).first().click();
  await expect(page).toHaveURL(/\/login/);

  // Next cashier signs in with the link already down: the previous shift's
  // figures must not be sitting there waiting to be read.
  world.serverUp = false;
  await page.goto('/products');
  await expect(page.getByText('Amoxicillin')).toHaveCount(0);
});

test('a till reloaded during an outage keeps its session', async ({ page }) => {
  const world: World = { serverUp: true, customerPosts: [] };
  await mockApi(page, world);
  await login(page);

  // The shift session is cached with a 12 h TTL (ADR-006), but it used to be
  // adopted only by a 2.5 s "slow server" grace timer that `finally` cancelled.
  // A refused connection fails in milliseconds, so the timer never ran and the
  // cashier was thrown back to a login screen that could not be reached.
  world.serverUp = false;
  await page.reload();

  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByText(USER.fullName).first()).toBeVisible();
});

test('a write made offline is queued, then sent once when the link returns', async ({ page }) => {
  const world: World = { serverUp: true, customerPosts: [] };
  await mockApi(page, world);
  await login(page);

  // Cache the screen while the server is up, then lose it.
  await page.goto('/customers');
  await expect(page.getByText(CUSTOMER.fullName)).toBeVisible();
  world.serverUp = false;

  await page.getByRole('button', { name: /new customer/i }).click();
  // The form's labels are not tied to their inputs, so go by position —
  // scoped to the dialog, or this picks up the list's search box instead.
  await page.locator('form').getByRole('textbox').first().fill('Kojo Owusu');
  await page.getByRole('button', { name: /^save$/i }).click();

  // Nothing was lost and nothing was claimed: the till says it is holding it.
  await expect(page.getByText(/change\(s\) waiting/)).toBeVisible();
  expect(world.customerPosts).toHaveLength(0);

  await page.getByText(/change\(s\) waiting/).click();
  await expect(page.getByText('Customer added: Kojo Owusu')).toBeVisible();

  // Link returns: the queue drains, carrying its idempotency key.
  world.serverUp = true;
  await expect(page.getByText(/change\(s\) waiting/)).toHaveCount(0, { timeout: 30_000 });

  expect(world.customerPosts).toHaveLength(1);
  expect(world.customerPosts[0].key).toBeTruthy();
});

test('a queued write the server refuses is surfaced, not retried forever', async ({ page }) => {
  const world: World = { serverUp: true, customerPosts: [], refuseCustomers: true };
  await mockApi(page, world);
  await login(page);

  await page.goto('/customers');
  await expect(page.getByText(CUSTOMER.fullName)).toBeVisible();
  world.serverUp = false;

  await page.getByRole('button', { name: /new customer/i }).click();
  await page.locator('form').getByRole('textbox').first().fill('Yaa Asantewaa');
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.getByText(/change\(s\) waiting/)).toBeVisible();

  // The link returns and the server rejects it outright. Retrying cannot fix a
  // refusal, so it has to stop and say so — with the reason the server gave.
  world.serverUp = true;
  await expect(page.getByText(/action needed/)).toBeVisible({ timeout: 30_000 });

  await page.getByText(/action needed/).click();
  await expect(page.getByText(/A customer with that phone already exists/)).toBeVisible();
  await expect(page.getByText(/This was not applied/)).toBeVisible();
});
