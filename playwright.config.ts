import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Software WebGL rendering competes heavily for CPU once real models are loaded.
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    headless: true,
    // Locally, drive the installed (auto-updating) Chrome with its sandbox on:
    // Playwright's bundled Chromium lags Chrome stable on security fixes, and
    // Playwright launches Chromium without the sandbox by default.
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
      chromiumSandbox: !process.env.CI,
    },
  },
  webServer: {
    command: 'pnpm --filter @clans/client dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
