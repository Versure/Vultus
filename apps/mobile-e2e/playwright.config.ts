import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

// For CI, you may want to set BASE_URL to the deployed application.
const baseURL = process.env.BASE_URL ?? 'http://localhost:4200';

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * NOTE: this config is intentionally a CommonJS `.ts` file, NOT `.mts`. On
 * Windows, loading an ESM Playwright config forces Node's native ESM loader,
 * which fails to load Nx's native addon (`@nx/devkit` -> `nx/native`) through
 * the CJS-in-ESM bridge (`Module._load` patch). A `.ts` config is loaded via
 * Playwright's own transpiler (the workspace is not `type: "module"`), so the
 * `@nx/devkit`/`nxE2EPreset` requires resolve normally. We pass `__filename`
 * to `nxE2EPreset` per its CJS guidance.
 */
export default defineConfig({
  ...nxE2EPreset(__filename, { testDir: './src' }),
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  /* Run your local dev server before starting the tests */
  webServer: {
    command: 'npx nx run mobile:serve',
    url: 'http://localhost:4200',
    reuseExistingServer: true,
    cwd: workspaceRoot,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
