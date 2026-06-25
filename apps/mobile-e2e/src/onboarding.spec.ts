import { test, expect } from '@playwright/test';
import { clearAll, resolveAnonUid, readDocument } from './support';

/**
 * Onboarding e2e flows F-onboard-1 / F-onboard-2 / F-onboard-3 (spec 0022).
 *
 * `@capacitor/preferences` falls back to `localStorage` on web; Capacitor
 * prefixes keys as `CapacitorStorage.<key>`. So `onboarding_done = 'true'` is
 * stored at `localStorage['CapacitorStorage.onboarding_done']`, readable via
 * `page.evaluate()`.
 *
 * These tests deliberately leave the flag UNSET before F-onboard-1/2 so the
 * first-launch redirect fires. F-onboard-3 pre-sets the flag to verify the
 * guard passes through directly.
 *
 * Native FCM (permission dialog + token write) is device-only and is NOT
 * exercised here (browser has no native runtime). Only navigation + region
 * write + completion-flag behaviour are asserted.
 *
 * Emulator-port invariant (spec 0019): Auth 9099 / Firestore 8080.
 */

const STORAGE_KEY = 'CapacitorStorage.onboarding_done';

test.beforeEach(async () => {
  // Clean emulator state before each test so there is no pre-existing user doc
  // and no leftover anon session that would confuse the uid resolution.
  await clearAll();
});

/**
 * F-onboard-1 — first launch (no flag): boot → redirect to /onboarding;
 * the welcome header, region select, and "Get started" button render.
 */
test('F-onboard-1: first launch redirects to /onboarding and renders the onboarding page', async ({
  page,
}) => {
  await page.goto('/');

  // Guard sees no flag → redirect to /onboarding.
  await expect(page).toHaveURL(/\/onboarding$/);

  // Onboarding page elements render.
  await expect(page.locator('lib-onboarding')).toBeVisible();
  await expect(page.locator('ion-select')).toBeVisible();
  await expect(page.locator('ion-button')).toBeVisible();

  // No tabs shell (user hasn't completed onboarding).
  await expect(page.locator('ion-tab-button')).toHaveCount(0);

  // Flag is NOT set (this is a first-launch test).
  const flag = await page.evaluate(
    (key) => localStorage.getItem(key),
    STORAGE_KEY,
  );
  expect(flag).not.toBe('true');
});

/**
 * F-onboard-2 — pick region DE and complete: → /tabs/watchlist;
 * Firestore users/{uid} has region:'DE'; localStorage flag is 'true'.
 *
 * The native FCM path (permission dialog + token write) is NOT asserted here
 * — browser mode has no native runtime.
 */
test('F-onboard-2: pick region DE, complete → /tabs/watchlist; user doc created; flag set', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);

  // Resolve anon uid so we can check the Firestore doc.
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // Open the region select popover and pick 'DE'.
  await page.locator('ion-select').click();
  const option = page
    .locator('ion-popover ion-radio, ion-popover ion-item')
    .filter({ hasText: /^\s*DE\s*$/ })
    .first();
  await expect(option).toBeVisible();
  await option.click();
  // Popover dismisses on selection (interface="popover").
  await expect(page.locator('ion-popover')).toHaveCount(0);

  // Tap "Get started" and wait for navigation.
  await page.locator('ion-button').click();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/, { timeout: 10000 });

  // Completion flag is now set in localStorage.
  const flag = await page.evaluate(
    (key) => localStorage.getItem(key),
    STORAGE_KEY,
  );
  expect(flag).toBe('true');

  // users/{uid} exists in Firestore emulator with region:'DE'.
  const doc = await readDocument(`users/${uid}`);
  expect(doc).not.toBeNull();
  expect(
    (doc as Record<string, { stringValue: string }>).region?.stringValue,
  ).toBe('DE');
});

/**
 * F-onboard-3 — flag pre-set: boot → /tabs/watchlist directly; no onboarding redirect.
 */
test('F-onboard-3: flag pre-set → boot lands on /tabs/watchlist without redirect', async ({
  page,
}) => {
  // Set the completion flag BEFORE navigation so the guard sees it on first load.
  await page.addInitScript((key) => {
    localStorage.setItem(key, 'true');
  }, STORAGE_KEY);

  await page.goto('/');

  // Guard sees flag → passes through to tabs.
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // Tab bar renders (we're in the tabs shell, not onboarding).
  await expect(page.locator('ion-tab-button')).toHaveCount(3);
});
