import { defineConfig } from '@playwright/test';

/**
 * UI smoke tests against the local dev stack. Expects the API (3000),
 * the web dev server (5173) and the database to be running — see README.
 * Kept out of CI for now (browser download cost); run: pnpm test:ui
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
