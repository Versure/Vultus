import { test, expect } from '@playwright/test';

/**
 * No-emulator smoke test (spec 0010, decision 5).
 *
 * Runs under the existing `nx serve`-backed Playwright `webServer`, which has
 * NO Firebase backend. It asserts only that the tabs shell renders and that
 * Watchlist is the landing route. It deliberately does NOT assert anonymous
 * auth or any emulator-backed behavior — the full boot + anon-session + tab-nav
 * flow against the Firebase emulators is owned by the e2e-setup spec
 * (PLAN §6 item 20).
 *
 * This relies on the shell's graceful render-gating (app.config.ts): the
 * anon-auth `provideAppInitializer` swallows the sign-in failure that occurs
 * with no Auth backend, so bootstrap completes and the tabs render anyway.
 */
test('boots into the tabs shell and lands on Watchlist', async ({ page }) => {
  await page.goto('/');

  // Default route ('' -> redirect 'full' -> 'tabs/watchlist').
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // The tabs shell renders three tab buttons (Watchlist / Search / Settings).
  await expect(page.locator('ion-tab-button')).toHaveCount(3);
  await expect(page.locator('ion-tab-button[tab="watchlist"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="search"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="settings"]')).toBeVisible();
});
