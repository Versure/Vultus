import { test, expect, type Page } from '@playwright/test';
import { clearAll, resolveAnonUid, seedFor } from './support';

/**
 * Flow 7 — settings → change region → persists across navigation (spec 0019).
 *
 * Emulator-backed, `seeded` fixture. The `seeded` fixture writes a `users/{uid}`
 * doc with a region (the spec pins it to 'NL') plus a TV watchlist entry. This
 * flow drives the Settings region `ion-select`, changes it to a DIFFERENT region,
 * navigates away and back, and asserts the new region persisted.
 *
 * Determinism guards (spec 0019 Test plan): `clearAll()` in `beforeEach`, no TMDB
 * route needed (settings issues no TMDB call), Ionic transitions awaited via
 * concrete element/URL waits rather than fixed sleeps, and the single live anon uid resolved from the
 * running app (R3) so the seeded `users/{uid}` doc lines up with the session.
 *
 * Persistence is asserted via a UI round-trip that FORCES a fresh read: after the
 * region change we `page.reload()` and re-enter Settings so `SettingsService.load()`
 * re-reads `users/{uid}` from the emulator with `getDoc` (it is a one-shot read on
 * `ngOnInit`, not a live stream). The new value only survives that reload if it was
 * written to Firestore — so this round-trip is a genuine persistence assertion.
 *
 * NOTE: a DIRECT emulator read-back of `users/{uid}.region` would strengthen this
 * (assert the stored field, not just the rendered value). The `src/support/`
 * layer currently exposes only write/clear primitives (`writeDocument`,
 * `clearFirestore`, `clearAuth`) — there is NO Firestore READ helper — so the
 * reload-and-re-read round-trip above is the strongest available assertion without
 * inventing a helper. If support later gains a `readDocument`, add a direct
 * `users/{uid}.region === <new region>` check here.
 */

/** Region codes offered by the Settings picker (libs shared REGIONS / spec 0019). */
const REGIONS = ['NL', 'DE', 'GB', 'US', 'FR', 'BE', 'ES', 'IT', 'CA', 'AU'];

/**
 * Region code → display name (endonym), a SMALL LOCAL mirror of
 * `REGION_DISPLAY_NAMES` in `@vultus/shared/domain` (spec 0079). Intentionally
 * NOT imported from the shared barrel: keeping it local avoids taking on
 * Playwright/tsconfig path-alias resolution for `mobile-e2e`, and a stale local
 * entry fails LOUDLY here — `pickRegion` never finds the popover row and the
 * test errors clearly — rather than silently matching the wrong text.
 */
const REGION_DISPLAY_NAMES: Record<string, string> = {
  NL: 'Nederland',
  DE: 'Deutschland',
  GB: 'United Kingdom',
  US: 'United States',
  FR: 'France',
  BE: 'België',
  ES: 'España',
  IT: 'Italia',
  CA: 'Canada',
  AU: 'Australia',
};

/**
 * Navigate to the Settings tab and wait for its content to render.
 *
 * The Settings page is render-gated on `service.loaded()` (a one-shot
 * `users/{uid}` read), so we wait for the region `ion-select` to be visible — that
 * only appears once `load()` resolves against the emulator.
 */
async function gotoSettings(page: Page): Promise<void> {
  await page.locator('ion-tab-button[tab="settings"]').click();
  await page.waitForURL(/\/tabs\/settings$/);
  await expect(
    page.locator('ion-select.settings-row__select[label="Region"]'),
  ).toBeVisible();
}

/**
 * Read the region `ion-select`'s currently displayed value.
 *
 * `ion-select` reflects its selected option as the `value` property; we read that
 * (rather than the rendered text) because it is the stable, label-independent
 * source of truth for the selection.
 */
async function selectedRegion(page: Page): Promise<string> {
  return page
    .locator('ion-select.settings-row__select[label="Region"]')
    .evaluate((el) => (el as unknown as { value: string }).value);
}

/**
 * Open the region select's overlay and choose `region`.
 *
 * The template sets `interface="popover"` on the `ion-select`, so opening it
 * renders an `ion-popover` containing one clickable `ion-radio`/option row per
 * region (NO confirm button — selecting an option commits and dismisses the
 * popover, firing `(ionChange)` → `onRegionChange` → `setRegion`). We therefore:
 *   1. click the `ion-select` to open the popover,
 *   2. click the option whose VISIBLE TEXT matches the region's DISPLAY NAME
 *      (spec 0079: the option label now renders `regionDisplayName(region)`, an
 *      endonym like `Nederland`, while `[value]` stays the raw code `NL`), and
 *   3. wait for the popover to dismiss (selection committed).
 */
async function pickRegion(page: Page, region: string): Promise<void> {
  await page.locator('ion-select.settings-row__select[label="Region"]').click();

  // The popover renders `ion-select-popover` with one option row per region;
  // its label is the display name (endonym), NOT the raw code (spec 0079).
  const displayName = REGION_DISPLAY_NAMES[region];
  const option = page
    .locator('ion-popover ion-radio, ion-popover ion-item')
    .filter({ hasText: new RegExp(`^\\s*${displayName}\\s*$`) })
    .first();
  await expect(option).toBeVisible();
  await option.click();

  // Popover dismisses once the choice commits (popover interface = no OK button).
  await expect(page.locator('ion-popover')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  // Pre-set the onboarding completion flag so the guard (spec 0022) passes
  // through to the tabs shell instead of redirecting to /onboarding.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Deterministic reset: clear Auth + Firestore before each test (spec 0019).
  await clearAll();
});

test('F7: settings region change persists across navigation', async ({
  page,
}) => {
  // Boot the app; it signs in anonymously against the Auth emulator.
  await page.goto('/');

  // Resolve the live anon uid, then seed `users/{uid}` (region) + a TV entry
  // under THAT uid so the seeded docs line up with the app's session (R3).
  const uid = await resolveAnonUid(page);
  await seedFor(uid, 'seeded');

  // Re-enter the app so `SettingsService.load()` reads the freshly-seeded user
  // doc (load() is a one-shot read; the seed landed after the initial boot).
  await page.reload();

  // Tab to Settings and read the seeded region (spec pins it to 'NL', but we read
  // it rather than assume, so this stays correct if the fixture's region changes).
  await gotoSettings(page);
  const seededRegion = await selectedRegion(page);
  expect(REGIONS).toContain(seededRegion);

  // Pick a DIFFERENT region from the offered set (e.g. seeded 'NL' → 'US').
  // REGIONS has 10 entries, so a region other than the seeded one always exists
  // (the `as string` narrows the `find` result, which the assertion proves).
  const newRegion = REGIONS.find((r) => r !== seededRegion);
  // REGIONS has 10 entries; guard narrows the type to string and catches fixture regressions.
  if (!newRegion)
    throw new Error('REGIONS has no entry other than the seeded region');
  expect(newRegion).not.toBe(seededRegion);

  await pickRegion(page, newRegion);

  // The select immediately reflects the new value (signal updated by setRegion).
  await expect.poll(() => selectedRegion(page)).toBe(newRegion);

  // Navigate AWAY to Watchlist, then back to Settings — the in-tab cached page
  // would keep its in-memory signal, so this alone is a weak check.
  await page.locator('ion-tab-button[tab="watchlist"]').click();
  await page.waitForURL(/\/tabs\/watchlist$/);

  await gotoSettings(page);
  await expect.poll(() => selectedRegion(page)).toBe(newRegion);

  // Stronger persistence check: a full reload re-runs `SettingsService.load()`,
  // which re-reads `users/{uid}` from the Firestore emulator with `getDoc`. The
  // new region only survives this if it was actually written to Firestore (the
  // genuine persistence assertion; see file NOTE re: a direct emulator read-back).
  await page.reload();

  await gotoSettings(page);
  await expect.poll(() => selectedRegion(page)).toBe(newRegion);
});
