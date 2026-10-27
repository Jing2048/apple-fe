import { defineConfig } from '@playwright/test';
import { offlineAuxiliaryBase, offlineReportPrefix, offlineTheme } from './tests/offline/theme.js';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const launchOptions = executablePath ? { executablePath } : {};
const httpAuxiliary = Boolean(offlineAuxiliaryBase);
const reportPrefix = offlineReportPrefix;

export default defineConfig({
  testDir: './tests/offline',
  outputDir: `.artifacts/${reportPrefix}-test-results`,
  metadata: {
    acceptanceMode: httpAuxiliary ? 'HTTP auxiliary; not file:// validation' : 'file:// offline',
    startsServer: false,
    theme: offlineTheme.id,
    artifact: offlineTheme.filename,
  },
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `.artifacts/${reportPrefix}-playwright-report` }],
    ['json', { outputFile: `.artifacts/${reportPrefix}-e2e-results.json` }],
  ],
  use: {
    browserName: 'chromium',
    launchOptions,
    offline: true,
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: `${reportPrefix}-desktop`,
      use: { viewport: { width: 1280, height: 960 }, isMobile: false, hasTouch: false },
    },
    {
      name: `${reportPrefix}-mobile`,
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
