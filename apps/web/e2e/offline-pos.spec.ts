import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Offline-path regressions (ADR-012). Unlike the other specs in here, this one
 * mocks the API rather than talking to the dev stack: the behaviour under test
 * *is* what the till does when the server is unreachable, which a running
 * server cannot reproduce. It also means these run with no database.
 *
 * Covers:
 *  - Enter confirms a payment (it was being eaten by the barcode wedge)
 *  - a payment does not hang when the link is up but the server is not
 *  - a queue left over from a previous session drains at startup, with no
 *    offline→online transition to trigger it
 *  - a cold sign-in works during an outage, against the cached verifier
 */

const API = 'http://localhost:3000/api/v1';
const HEALTH = 'http://localhost:3000/health';
const PASSWORD = 'ChangeMe123!';

const USER = {
  id: 'u-1',
  username: 'kwame',
  fullName: 'Kwame Mensah',
  role: 'CASHIER',
  activeBranch: { id: 'b-1', code: 'MAIN', name: 'Main Branch' },
  branches: [{ id: 'b-1', code: 'MAIN', name: 'Main Branch' }],
};

const PRODUCT = {
  id: 'p-1',
  name: 'Paracetamol',
  genericName: 'paracetamol',
  strength: '500mg',
  categoryName: 'Analgesics',
  baseUnit: 'tablet',
  sellingPriceBase: '1.50',
  vatApplies: false,
  prescriptionOnly: false,
  qtyOnHand: 200,
  nearestExpiry: '2027-01-31',
  units: [],
  barcodes: [{ barcode: '5012345678900', productUnitId: null }],
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Flipped mid-test to simulate the uplink dying without the OS noticing. */
type World = { serverUp: boolean; synced: string[]; salesPosted: number };

async function mockApi(page: Page, world: World) {
  await page.route(`${HEALTH}**`, (route) =>
    world.serverUp ? json(route, { status: 'ok', db: 'ok' }) : route.abort('connectionrefused'),
  );

  await page.route(`${API}/**`, async (route) => {
    if (!world.serverUp) return route.abort('connectionrefused');
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');

    if (path === '/auth/login') {
      return json(route, { accessToken: 'access-1', refreshToken: 'refresh-1', user: USER });
    }
    if (path === '/auth/me') return json(route, USER);
    if (path === '/catalog/snapshot') return json(route, { version: 'v1', products: [PRODUCT] });
    if (path === '/products') return json(route, { data: [PRODUCT] });
    if (path === '/sales') {
      world.salesPosted++;
      return json(route, { id: 'sale-1' }, 201);
    }
    if (path === '/sync/sales') {
      const body = route.request().postDataJSON() as { sales: { clientSaleId: string }[] };
      world.synced.push(...body.sales.map((s) => s.clientSaleId));
      return json(route, {
        results: body.sales.map((s) => ({ clientSaleId: s.clientSaleId, status: 'created' })),
      });
    }
    if (path === '/notifications') return json(route, { data: [], unread: 0 });
    return json(route, {});
  });
}

async function login(page: Page) {
  await page.goto('/login');
  await page.locator('#login-username').fill(USER.username);
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
}

/** Put one line in the cart via the search box. */
async function addLine(page: Page) {
  await page.locator('input[placeholder*="Scan barcode"]').fill('Paracetamol');
  await page.getByText('Paracetamol', { exact: true }).first().click();
  await expect(page.getByText('TOTAL', { exact: true })).toBeVisible();
}

test('Enter confirms the payment and completes the sale', async ({ page }) => {
  const world: World = { serverUp: true, synced: [], salesPosted: 0 };
  await mockApi(page, world);

  await login(page);
  await page.waitForURL('**/pos');
  await addLine(page);

  await page.getByRole('button', { name: /PAYMENT/ }).click();
  await expect(page.getByText('Amount due')).toBeVisible();

  // The regression: the barcode wedge consumed this Enter in the capture phase
  // whenever ≥5 characters had been typed quickly, and the sale never posted.
  await page.locator('input[type="number"]').first().fill('20');
  await page.keyboard.press('Enter');

  await page.waitForURL('**/receipt', { timeout: 5_000 });
  expect(world.salesPosted).toBe(1);
});

test('Enter still confirms after a fast keypad burst (the wedge must stand down)', async ({ page }) => {
  const world: World = { serverUp: true, synced: [], salesPosted: 0 };
  await mockApi(page, world);

  await login(page);
  await page.waitForURL('**/pos');
  await addLine(page);
  await page.getByRole('button', { name: /PAYMENT/ }).click();

  // >= 5 characters with no delay is exactly what the wedge mistook for a scan.
  await page.locator('input[type="number"]').first().pressSequentially('100.00', { delay: 0 });
  await page.keyboard.press('Enter');

  await page.waitForURL('**/receipt', { timeout: 5_000 });
  expect(world.salesPosted).toBe(1);
});

test('a dead server does not hang the payment — the sale queues and prints locally', async ({ page }) => {
  const world: World = { serverUp: true, synced: [], salesPosted: 0 };
  await mockApi(page, world);

  await login(page);
  await page.waitForURL('**/pos');
  await addLine(page);

  world.serverUp = false; // uplink dies with the cart already rung up
  await page.getByRole('button', { name: /PAYMENT/ }).click();
  await page.keyboard.press('Enter');

  await page.waitForURL('**/receipt', { timeout: 10_000 });
  await expect(page.getByText(/OFFLINE-/)).toBeVisible();
  expect(world.salesPosted).toBe(0);
});

test('a queue left from a previous session drains at startup, with no online event', async ({ page }) => {
  const world: World = { serverUp: true, synced: [], salesPosted: 0 };
  await mockApi(page, world);

  await login(page);
  await page.waitForURL('**/pos');
  await addLine(page);

  world.serverUp = false;
  await page.getByRole('button', { name: /PAYMENT/ }).click();
  await page.keyboard.press('Enter');
  await page.waitForURL('**/receipt');
  await expect(page.getByText(/OFFLINE-/)).toBeVisible();

  // Reload while already reachable. The old code only drained on an
  // offline→online transition, so this queue would sit here forever.
  world.serverUp = true;
  await page.goto('/pos');

  await expect.poll(() => world.synced.length, { timeout: 20_000 }).toBe(1);
  await expect(page.getByText(/unsynced/)).toBeHidden({ timeout: 10_000 });
});

test('cold sign-in works during an outage, using the cached verifier', async ({ page }) => {
  const world: World = { serverUp: true, synced: [], salesPosted: 0 };
  await mockApi(page, world);

  // One online sign-in is what leaves the verifier on the till.
  await login(page);
  await page.waitForURL('**/pos');
  await page.getByRole('button', { name: /sign out/i }).first().click();
  await page.waitForURL('**/login');

  world.serverUp = false;
  await page.reload();
  await expect(page.getByText(/OFFLINE/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/password saved on this till/)).toBeVisible();

  await page.locator('#login-username').fill(USER.username);
  await page.locator('#login-password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL('**/pos', { timeout: 15_000 });
  await expect(page.getByText('Signed in offline.')).toBeVisible();
});

test('the wrong password is refused offline', async ({ page }) => {
  const world: World = { serverUp: true, synced: [], salesPosted: 0 };
  await mockApi(page, world);

  await login(page);
  await page.waitForURL('**/pos');
  await page.getByRole('button', { name: /sign out/i }).first().click();
  await page.waitForURL('**/login');

  world.serverUp = false;
  await page.reload();
  await page.locator('#login-username').fill(USER.username);
  await page.locator('#login-password').fill('not-the-password');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page.getByText('Wrong username or password')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/login/);
});
