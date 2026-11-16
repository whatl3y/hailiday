import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against a running stack (`docker compose up --build`). They never start the
 * stack themselves. Override the targets with HAILIDAY_E2E_BASE_URL and HAILIDAY_E2E_MAILPIT_URL.
 */
const baseURL = process.env.HAILIDAY_E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // One worker: the specs share one stack and its per-day limits, and run in file-name order.
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
