import { defineConfig, devices } from '@playwright/test';

const deployedOrigin = process.env.E2E_BASE_URL;
const origin = deployedOrigin ?? 'http://localhost:5173';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const chromium = {
  browserName: 'chromium' as const,
  ...(executablePath ? { launchOptions: { executablePath } } : {}),
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: { baseURL: origin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], ...chromium } },
    { name: 'chromium-mobile', use: { ...devices['Pixel 7'], ...chromium } },
    ...(process.env.PLAYWRIGHT_WEBKIT === '1'
      ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }]
      : []),
  ],
  ...(deployedOrigin
    ? {}
    : {
        webServer: [
          {
            command: 'pnpm db:migrate && pnpm --filter @apple/api dev',
            url: 'http://127.0.0.1:3001/api/ready',
            timeout: 60_000,
            reuseExistingServer: false,
            env: {
              NODE_ENV: 'test',
              APP_ORIGIN: origin,
              PORT: '3001',
              HOST: '127.0.0.1',
              SESSION_SECRET: 'e2e-public-development-session-secret-only',
              RELEASE_ID: 'e2e',
            },
          },
          {
            command: 'pnpm --filter @apple/web dev',
            url: origin,
            timeout: 60_000,
            reuseExistingServer: false,
          },
        ],
      }),
});
