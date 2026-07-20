import { test, expect, type Page } from '@playwright/test';
import { clearAll, resolveAnonUid, readDocument } from './support';

/**
 * Onboarding e2e flows F-onboard-1..5 (spec 0078 — the 5-step wizard that
 * reworks the spec-0022 region-only page). ONE Angular route (`/onboarding`)
 * renders one of five ordered steps from an internal step signal:
 *
 *   1. Region → 2. My Providers → 3. Notifications → 4. Plex link → 5. Finish
 *
 * Selectors are grounded in the rendered wizard markup
 * (`libs/mobile/onboarding/src/lib/onboarding.page.html`):
 *   - progress label:   `.wizard-progress__label`  ("Step {n} of 5")
 *   - primary CTA:      `.wizard-cta`   (Continue / Get started)
 *   - Back control:     `.wizard-back`  (steps 2-5)
 *   - Skip (step 4):    `.wizard-skip`  ("Skip for now")
 *   - step-1 region:    `ion-select` (the only select on step 1)
 *   - step-3 controls:  `ion-toggle.wizard-toggle` + `ion-select.wizard-select`
 *
 * `@capacitor/preferences` falls back to `localStorage` on web; Capacitor
 * prefixes keys as `CapacitorStorage.<key>`. So `onboarding_done = 'true'` is
 * stored at `localStorage['CapacitorStorage.onboarding_done']`, readable via
 * `page.evaluate()`. These tests deliberately leave the flag UNSET before
 * F-onboard-1/2/4/5 so the first-launch redirect fires; F-onboard-3 pre-sets it.
 *
 * DEVICE-ONLY (NOT asserted here — no native runtime in the browser harness):
 *   - the native FCM permission dialog + token write (step 5), as in spec 0022;
 *   - the REAL Plex PIN generation + LAN server discovery (step 4). Only
 *     navigating INTO step 4 and using "Skip for now" is exercised (F-onboard-5).
 *
 * The step-2 LIVE catalog round-trip (real provider chips from the
 * `GET_WATCH_PROVIDERS` callable + toggling one persisting to `myProviderIds`)
 * is `test.fixme` at the bottom — the Playwright harness has no Functions
 * emulator runtime for that callable (same gap as provider-preferences.spec.ts).
 * Navigation THROUGH step 2 (empty selection advances) is NOT gated by it and IS
 * covered for real (F-onboard-2).
 *
 * Emulator-port invariant (spec 0019): Auth 9099 / Firestore 8080.
 */

const STORAGE_KEY = 'CapacitorStorage.onboarding_done';

/** Minimal Firestore REST typed-value shape for the fields we read. */
interface FsValue {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  nullValue?: null;
  arrayValue?: { values?: FsValue[] };
  mapValue?: { fields?: Record<string, FsValue> };
}

/**
 * Assert the wizard is showing the given step via its progress indicator.
 * Exact-text match (whitespace-normalized) on the same "Step {n} of 5" copy the
 * component test asserts with `.toBe('Step {n} of 5')` — kept strict, not a
 * loose `toContainText`, so e2e and component stay consistent on the exact copy.
 */
async function expectStep(page: Page, step: number): Promise<void> {
  await expect(page.locator('.wizard-progress__label')).toHaveText(
    `Step ${step} of 5`,
  );
}

/**
 * Step 1: open the region `ion-select` popover and pick the given region, then
 * wait for the popover to dismiss (interface="popover" closes on selection).
 * Mirrors the spec-0022 region-select interaction.
 */
async function pickRegion(page: Page, region: string): Promise<void> {
  await page.locator('ion-select').click();
  const option = page
    .locator('ion-popover ion-radio, ion-popover ion-item')
    .filter({ hasText: new RegExp(`^\\s*${region}\\s*$`) })
    .first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.locator('ion-popover')).toHaveCount(0);
}

test.beforeEach(async () => {
  // Clean emulator state before each test so there is no pre-existing user doc
  // and no leftover anon session that would confuse the uid resolution.
  await clearAll();
});

/**
 * F-onboard-1 — first launch (no flag): boot → redirect to /onboarding; step 1
 * (region select) + the "Step 1 of 5" progress indicator render first; no tabs.
 */
test('F-onboard-1: first launch redirects to /onboarding and renders step 1 (region) with the progress indicator', async ({
  page,
}) => {
  await page.goto('/');

  // Guard sees no flag → redirect to /onboarding.
  await expect(page).toHaveURL(/\/onboarding$/);

  // Wizard renders, on step 1 (region), with the progress indicator.
  await expect(page.locator('lib-onboarding')).toBeVisible();
  await expectStep(page, 1);
  await expect(page.locator('ion-select')).toBeVisible();
  await expect(page.locator('.wizard-cta')).toBeVisible();
  // Step 1 has no Back control (Back exists only on steps 2-5).
  await expect(page.locator('.wizard-back')).toHaveCount(0);

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
 * F-onboard-2 — walk all 5 steps and complete: region DE → step 2 (advance with
 * an EMPTY provider selection — navigation only, NOT gated by the step-2 fixme)
 * → step 3 (toggle notifications OFF) → step 4 (Skip for now) → step 5
 * (Get started) → /tabs/watchlist. Assert users/{uid} reflects the mid-wizard
 * choices (region:'DE', myProviderIds:[], notificationPrefs all false) and the
 * completion flag is set.
 *
 * The native FCM path (permission dialog + token write) is device-only and NOT
 * asserted — the browser harness has no native runtime.
 */
test('F-onboard-2: walk all 5 steps (region DE, empty providers, notifications off, skip Plex) → /tabs/watchlist; user doc reflects choices; flag set', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);

  // Resolve anon uid so we can check the Firestore doc.
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // --- Step 1: pick region DE, Continue (creates users/{uid} with defaults). --
  await expectStep(page, 1);
  await pickRegion(page, 'DE');
  await page.locator('.wizard-cta').click();

  // --- Step 2: advance with NO provider selection (empty is a valid choice;
  //     the live catalog fetch is fixme-gated, but navigation is not). ----------
  await expectStep(page, 2);
  await page.locator('.wizard-cta').click();

  // --- Step 3: toggle notifications OFF. The delivery-hour select becoming
  //     disabled (`select-disabled` host class) confirms the projection flipped,
  //     i.e. the notificationPrefs write has landed before we move on. -----------
  await expectStep(page, 3);
  await page.locator('ion-toggle.wizard-toggle').click();
  await expect(page.locator('ion-select.wizard-select')).toHaveClass(
    /select-disabled/,
  );
  await page.locator('.wizard-cta').click();

  // --- Step 4: skip the Plex link (advances to step 5, no hasPlex/plexSync). ---
  await expectStep(page, 4);
  await page.locator('.wizard-skip').click();

  // --- Step 5: Get started → complete + navigate to the app. -------------------
  await expectStep(page, 5);
  await page.locator('.wizard-cta').click();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/, { timeout: 10000 });

  // Completion flag is now set in localStorage (the LAST write of the wizard).
  const flag = await page.evaluate(
    (key) => localStorage.getItem(key),
    STORAGE_KEY,
  );
  expect(flag).toBe('true');

  // users/{uid} reflects the mid-wizard choices.
  const doc = await readDocument(`users/${uid}`);
  expect(doc).not.toBeNull();
  const fields = doc as Record<string, FsValue>;

  // region — chosen on step 1.
  expect(fields.region?.stringValue).toBe('DE');

  // myProviderIds — empty selection on step 2 (emulator omits `values` for []).
  const providerIds = fields.myProviderIds?.arrayValue?.values ?? [];
  expect(providerIds).toHaveLength(0);

  // notificationPrefs — all three per-type booleans false (toggled off on step 3).
  const prefs = fields.notificationPrefs?.mapValue?.fields;
  expect(prefs?.episodeAired?.booleanValue).toBe(false);
  expect(prefs?.movieAvailable?.booleanValue).toBe(false);
  expect(prefs?.cameToPlatform?.booleanValue).toBe(false);
});

/**
 * F-onboard-3 — flag pre-set: boot → /tabs/watchlist directly; no onboarding
 * redirect; the tab bar renders. (Unchanged from spec 0022; verifies the guard
 * still passes through with the reworked page in place.)
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

/**
 * F-onboard-4 (new) — back navigation preserves the persisted region
 * (decision 3): pick DE on step 1 → step 2 → "Back" → step 1 with DE still
 * shown/selected. Because the region was persisted write-as-you-go on step 1,
 * going back loses no data — assert both the UI (select shows DE) and the
 * already-persisted users/{uid}.region.
 */
test('F-onboard-4: back navigation from step 2 returns to step 1 with the picked region still shown', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);

  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // Step 1: pick DE and advance.
  await expectStep(page, 1);
  await pickRegion(page, 'DE');
  await page.locator('.wizard-cta').click();

  // Step 2: go Back.
  await expectStep(page, 2);
  await page.locator('.wizard-back').click();

  // Back on step 1 with DE still selected (persisted-state check, decision 3).
  await expectStep(page, 1);
  await expect(page.locator('ion-select')).toContainText('DE');

  // The region was already persisted write-as-you-go before the Back nav.
  const doc = await readDocument(`users/${uid}`);
  expect(doc).not.toBeNull();
  const fields = doc as Record<string, FsValue>;
  expect(fields.region?.stringValue).toBe('DE');
});

/**
 * F-onboard-5 (new) — Plex skip performs NO Plex write: reach step 4, tap
 * "Skip for now" → step 5 → complete → /tabs/watchlist. The skip path calls the
 * link service's cancel() and advances WITHOUT any hasPlex:true / plexSync write.
 * The create-with-defaults (step 1) sets hasPlex:false, so assert it is NOT true
 * and that plexSync was never written.
 *
 * The real PIN generation + LAN discovery on step 4 are device/network-dependent
 * and out of e2e scope (device-only) — only the "Skip for now" affordance runs.
 */
test('F-onboard-5: skipping the Plex step writes no hasPlex:true / plexSync and completes onboarding', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);

  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // Step 1: default region (NL) is fine here — no popover interaction needed.
  await expectStep(page, 1);
  await page.locator('.wizard-cta').click();

  // Step 2: advance with an empty selection.
  await expectStep(page, 2);
  await page.locator('.wizard-cta').click();

  // Step 3: advance leaving the notification defaults.
  await expectStep(page, 3);
  await page.locator('.wizard-cta').click();

  // Step 4: "Skip for now" — no Plex link is attempted/persisted.
  await expectStep(page, 4);
  await page.locator('.wizard-skip').click();

  // Step 5: complete → land on the app.
  await expectStep(page, 5);
  await page.locator('.wizard-cta').click();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/, { timeout: 10000 });

  // users/{uid} has NO Plex link written by the skip path: hasPlex is not true
  // (it stays at its create-with-defaults `false`) and no plexSync OBJECT was
  // written. NB: the step-1 create-with-defaults write persists `plexSync: null`
  // explicitly (userToData coalesces `plexSync ?? null`), which Firestore's REST
  // API returns as `{ nullValue: null }` — NOT a missing key. The real intent of
  // F-onboard-5 is "the skip path performs no Plex sync write", i.e. no mapValue.
  const doc = await readDocument(`users/${uid}`);
  expect(doc).not.toBeNull();
  const fields = doc as Record<string, FsValue>;
  expect(fields.hasPlex?.booleanValue).not.toBe(true);
  expect(fields.plexSync?.mapValue).toBeUndefined();
});

// ---------------------------------------------------------------------------
// DEFERRED (test.fixme — PENDING, NOT FAILING): the step-2 LIVE catalog
// round-trip.
//
// Loading real provider chips on step 2 calls the `getWatchProviders` callable
// (via the `GET_WATCH_PROVIDERS` token), which requires that callable to be
// deployed into the emulator's Functions runtime — which the e2e specs in this
// suite don't currently exercise. This is the SAME pre-existing Functions-
// emulator gap documented in `provider-preferences.spec.ts` (getWatchProviders)
// and `manual-sync-trigger.spec.ts` (triggerSync). Navigating THROUGH step 2
// with an empty selection (F-onboard-2) is the REQUIRED gate and runs WITHOUT a
// Functions runtime; this live-catalog interaction stays fixme rather than
// adding new emulator-functions plumbing as a side quest of spec 0078. Un-skip
// once the Functions emulator (with getWatchProviders deployed) is part of the
// e2e harness run.
// ---------------------------------------------------------------------------
test.fixme('toggling a provider chip on step 2 persists it to myProviderIds', async ({
  page,
}) => {
  // Blocker: rendering the provider chips requires the getWatchProviders
  // callable to be deployed into the emulator's Functions runtime, which the
  // other e2e specs in this suite don't currently exercise.
  await page.goto('/');
  await expect(page).toHaveURL(/\/onboarding$/);
  const uid = await resolveAnonUid(page);

  // Step 1: pick a region so the catalog loads, then advance to step 2.
  await pickRegion(page, 'DE');
  await page.locator('.wizard-cta').click();
  await expectStep(page, 2);

  // Once a real Functions emulator serves getWatchProviders, the region catalog
  // loads real chips; toggling the first one persists it to myProviderIds. This
  // is authored fully but fixme-gated per the blocker above.
  const firstChip = page.locator('.provider-chip').first();
  await expect(firstChip).toBeVisible();
  await firstChip.click();

  const doc = await readDocument(`users/${uid}`);
  const fields = doc as Record<string, FsValue>;
  const providerIds = fields.myProviderIds?.arrayValue?.values ?? [];
  expect(providerIds.length).toBeGreaterThan(0);
});
