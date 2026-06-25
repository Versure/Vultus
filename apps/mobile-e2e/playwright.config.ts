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
  // Seed-reset runs in the Node process before the suite (clears the emulators).
  // Per-test seeding happens in each spec's beforeEach under the resolved anon
  // uid (R3, spec 0019).
  globalSetup: require.resolve('./global-setup'),
  // CI flakes (Ionic transitions / emulator timing) get up to 2 retries; locally
  // a failure is a failure. Trace is captured only when a retry kicks in.
  retries: process.env.CI ? 2 : 0,
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  /* Run the dev server before the tests. The dev config sets useEmulators:true,
   * so the browser app connects to the HARDCODED localhost:9099/8080 emulator
   * endpoints (Emulator-port invariant — the app cannot read env). The run must
   * stay on the default ports; emulators are started by `emulators:exec`. */
  webServer: {
    command: 'npx nx run mobile:serve',
    url: 'http://localhost:4200',
    reuseExistingServer: true,
    cwd: workspaceRoot,
  },
  // chromium-only: the only ship target is Android WebView (Capacitor), so
  // chromium is the closest single proxy; firefox/webkit triple CI time for no
  // fidelity gain (spec 0019 R6). Adding more browsers later is a config one-liner.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
