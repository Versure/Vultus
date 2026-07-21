import { test, expect } from '@playwright/test';

// Pre-set the onboarding completion flag so the guard (spec 0022) passes
// through to the tabs shell instead of redirecting to /onboarding.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
});

/**
 * No-emulator smoke test (spec 0010, decision 5).
 *
 * Runs under the existing `nx serve`-backed Playwright `webServer`, which has
 * NO Firebase backend. It asserts only that the tabs shell renders and that
 * Watch Today is the landing route. It deliberately does NOT assert anonymous
 * auth or any emulator-backed behavior — the full boot + anon-session + tab-nav
 * flow against the Firebase emulators is owned by the e2e-setup spec
 * (PLAN §6 item 20).
 *
 * This relies on the shell's graceful render-gating (app.config.ts): the
 * anon-auth `provideAppInitializer` swallows the sign-in failure that occurs
 * with no Auth backend, so bootstrap completes and the tabs render anyway.
 */
test('boots into the tabs shell and lands on Watch Today', async ({ page }) => {
  await page.goto('/');

  // Default route ('' -> redirect 'full' -> 'tabs/today') (spec 0083).
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // The tabs shell renders four tab buttons (Today / Watchlist / Search /
  // Settings), with Today the new leftmost + default tab (spec 0083).
  await expect(page.locator('ion-tab-button')).toHaveCount(4);
  await expect(page.locator('ion-tab-button[tab="today"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="watchlist"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="search"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="settings"]')).toBeVisible();
});
