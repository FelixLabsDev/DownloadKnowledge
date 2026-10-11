import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the production build of the web app, served by
// the real server with a throwaway data directory, so they exercise the real
// bundle, the service worker, offline behaviour and sync. With no
// DK_PASSWORD_HASH set, the server's password is "dev".
//
// To test something already running (the production image, say), set
// DK_E2E_URL and DK_E2E_PASSWORD; nothing is built or started then.
const external = process.env.DK_E2E_URL;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  // A container on Docker Desktop commits to disk far more slowly than the host does.
  timeout: external ? 120_000 : 30_000,
  expect: { timeout: external ? 20_000 : 5_000 },
  use: {
    baseURL: external ?? 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /phone\.spec\.ts/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone\.spec\.ts/ },
  ],
  webServer: external ? undefined : {
    command: 'pnpm build && pnpm --filter @dk/server exec tsx src/main.ts',
    url: 'http://localhost:4173/api/health',
    env: { PORT: '4173', DATA_DIR: path.join(tmpdir(), `dk-e2e-${Date.now()}`) },
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
