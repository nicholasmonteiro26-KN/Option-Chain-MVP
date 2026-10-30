import { defineConfig, devices } from '@playwright/test';

// The mock feed (?feed=mock) only works in dev builds and the `perf` build configuration (production optimisation
// plus `environment.allowMockFeed`). Functional tests run against the dev server; the perf test runs against an
// optimised `perf` build on its own port, so its numbers reflect what ships.
const DEV_URL = 'http://localhost:4300';
const PERF_URL = 'http://localhost:4301';
/** The wall-clock perf test (and the optimised server it needs) runs only with PERF=1; otherwise it is skipped. */
const PERF = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['PERF'] === '1';

export default defineConfig({
  testDir: 'e2e',
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      testIgnore: /perf\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DEV_URL },
    },
    {
      name: 'perf',
      testMatch: /perf\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: PERF_URL },
    },
  ],
  webServer: [
    {
      command: 'npx ng serve --port 4300',
      url: `${DEV_URL}/option-chain?feed=mock`,
      reuseExistingServer: true,
      timeout: 180000,
    },
    ...(PERF
      ? [{
        command: 'npx ng serve --configuration perf --port 4301',
        url: `${PERF_URL}/option-chain?feed=mock`,
        reuseExistingServer: true,
        timeout: 180000,
      }]
      : []),
  ],
});
