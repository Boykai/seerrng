import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:5055';

export default defineConfig({
  testDir: './playwright',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm cypress:start',
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      CONFIG_DIRECTORY: `${process.cwd()}/cypress/runtime-config`,
      PORT: '5055',
    },
  },
});
