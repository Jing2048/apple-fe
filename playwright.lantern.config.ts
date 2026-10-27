import { defineConfig } from '@playwright/test';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests/lantern',
  outputDir: '.artifacts/lantern-test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 35_000,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  metadata: {
    acceptanceMode: process.env.OFFLINE_TEST_BASE_URL
      ? 'HTTP auxiliary; not file:// verification'
      : 'file:// offline',
    artifact: 'paper-lantern-new-year.html',
    startsServer: false,
    media: 'synthetic canvas stream only; no real devices',
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '.artifacts/lantern-playwright-report' }],
    ['json', { outputFile: '.artifacts/lantern-e2e-results.json' }],
  ],
  use: {
    browserName: 'chromium',
    launchOptions: executablePath ? { executablePath } : {},
    offline: true,
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'lantern-desktop',
      use: { viewport: { width: 1280, height: 960 }, isMobile: false, hasTouch: false },
    },
    {
      name: 'lantern-mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
