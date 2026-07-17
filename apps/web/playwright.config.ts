import { defineConfig } from '@playwright/test';

/**
 * UI smoke tests against the local dev stack. Expects the API (3000),
 * the web dev server (5173) and the database to be running — see README.
 * Kept out of CI for now (browser download cost); run: pnpm test:ui
 *
 * Known limitation: /auth/login is throttled to 5/min/IP (auth.controller.ts,
 * OWASP A07). Every spec here does a fresh UI login per test rather than
 * sharing a session, and a full serial run adds up to more than 5 logins
 * within that window — some tests will 429 partway through a full-suite
 * run even though nothing is actually broken. Each spec file passes cleanly
 * run on its own (`pnpm test:ui -- some-file.spec.ts`), or wait ~60s between
 * full runs. A real fix would share a logged-in session across tests
 * (Playwright storageState) rather than re-authenticating every time.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  workers: 1,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'pnpm dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
    },
  ],
});
