import { test, expect } from '@playwright/test';
import { clearAll, resolveAnonUid, seedFor } from './support';

/**
 * Flow F1 (spec 0019) — boot -> anonymous auth -> empty watchlist.
 *
 * Emulator-backed superset of the no-backend `app.smoke.spec.ts` (which is kept
 * as a fast guard). Where the smoke spec only proves the tabs shell renders with
 * NO Firebase backend, this flow runs under `firebase emulators:exec` (Auth 9099
 * / Firestore 8080, the hardcoded ports the browser app uses — Emulator-port
 * invariant) and additionally asserts that anonymous sign-in actually resolved
 * against the Auth emulator and that the watchlist renders its EMPTY state for
 * the signed-in user.
 *
 * Determinism (spec 0019 Determinism guards): `clearAll()` in `beforeEach` gives
 * each test a clean emulator; the `empty` fixture is seeded under the LIVE anon
 * uid AFTER boot (R3 — `seedFor`, not `resetAndSeed`, so the running session is
 * preserved); Ionic transitions / network are awaited rather than slept on.
 */
test.beforeEach(async ({ page }) => {
  // Pre-set the onboarding completion flag so the guard passes through to tabs.
  // Without this, the guard (spec 0022) redirects first-launch boots to /onboarding.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Clean emulator state before the app boots and creates its anon session.
  await clearAll();
});

test('boots into anon auth and shows the empty watchlist', async ({ page }) => {
  // 1. Boot the app; it signs in anonymously against the Auth emulator and
  //    lands on the default route ('' -> redirect 'full' -> 'tabs/today').
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // 2. Anon auth resolved: read the uid the SDK persisted to IndexedDB. A
  //    non-empty uid proves sign-in settled against the emulator (not a no-op).
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();
  expect(uid.length).toBeGreaterThan(0);

  // 3. Seed the `empty` fixture under the LIVE uid (preserves the anon session),
  //    then reload so the watchlist subscribes to the now-seeded (empty) state.
  await seedFor(uid, 'empty');
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // The four tab buttons render (Today / Watchlist / Search / Settings), with
  // Today the new leftmost tab AND the default landing tab (spec 0083).
  await expect(page.locator('ion-tab-button')).toHaveCount(4);
  await expect(page.locator('ion-tab-button[tab="today"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="watchlist"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="search"]')).toBeVisible();
  await expect(page.locator('ion-tab-button[tab="settings"]')).toBeVisible();

  // Today is the selected tab on the default landing route (Ionic marks the
  // active tab button with the `tab-selected` class).
  await expect(page.locator('ion-tab-button[tab="today"]')).toHaveClass(
    /tab-selected/,
  );

  // 4. The empty state shows once loading completes and there are zero groups
  //    (watchlist.page.html: <vultus-empty-state> shared atom).
  const emptyState = page.locator('vultus-empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('Your watchlist is empty');
  await expect(emptyState).toContainText('Search for a title to get started');
});
