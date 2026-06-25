import { test, expect } from '@playwright/test';
import { resolveAnonUid, seedFor, clearAll } from './support';

/**
 * Flow — manual sync trigger (spec 0025).
 *
 * Tests the toolbar "Refresh watchlist" button that calls the `triggerSync`
 * Firebase callable. Requires the Functions emulator to be running so the
 * callable resolves against a real function instance.
 *
 * BLOCKER: the Functions emulator is not started in the CI e2e harness.
 * `firebase.json` `emulators.functions` (port 5001) was added by spec 0025
 * Task 2, but the CI/e2e start command (and the local `firebase emulators:start`
 * invocation) must also be updated to include the `--only` flag or simply start
 * all configured emulators so that Functions are available. Until then this flow
 * is `test.fixme`-gated; un-skip it once the Functions emulator is part of the
 * e2e harness run.
 *
 * Per project memory (emulator-tooling-limitation.md) the Firestore/Functions
 * emulator cannot run via Claude Code tools here (loopback blocked); verify this
 * flow locally in the user's own terminal where the emulator CAN run.
 */
test.describe('manual-sync-trigger', () => {
  test.beforeEach(async () => {
    await clearAll();
  });

  // test.fixme: Functions emulator not started in CI e2e harness —
  // see firebase.json `emulators.functions` (port 5001, spec 0025 Task 2).
  // Un-skip once the CI e2e harness starts the Functions emulator.
  test.fixme('toolbar refresh button triggers the triggerSync callable and shows success toast', async ({
    page,
  }) => {
    // 1. Boot the app logged-in, seed a watchlist title for the test uid, land
    //    on the Watchlist tab.
    await page.goto('/');
    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'seeded');
    await page.reload();

    await expect(page).toHaveURL(/\/tabs\/watchlist$/);
    // Confirm the seeded card rendered before we test the refresh button.
    await expect(page.locator('.watchlist-card')).toHaveCount(1);

    // 2. Assert the toolbar refresh button is visible and enabled.
    const refreshBtn = page.locator(
      'ion-header ion-buttons[slot="end"] ion-button[aria-label="Refresh watchlist"]',
    );
    await expect(refreshBtn).toBeVisible();
    await expect(refreshBtn).toBeEnabled();

    // 3. Tap the refresh button and assert it enters the loading/spinner state
    //    (disabled, spinner shown, aria-label "Syncing…").
    await refreshBtn.click();

    // After the click the button should be in the syncing state.
    const syncingBtn = page.locator(
      'ion-header ion-buttons[slot="end"] ion-button[aria-label="Syncing…"]',
    );
    await expect(syncingBtn).toBeDisabled();
    await expect(
      syncingBtn.locator('ion-spinner[name="crescent"]'),
    ).toBeVisible();

    // 4. Wait for the `triggerSync` callable to resolve against the Functions
    //    emulator (timeout covers a cold-start Functions emulator).
    // 5. Assert the success toast ("Watchlist synced") is shown.
    const successToast = page.locator('ion-toast').filter({
      hasText: 'Watchlist synced',
    });
    await expect(successToast).toBeVisible({ timeout: 30_000 });

    // 6. After the sync, the button should show the cooldown state
    //    (refresh complete → 5-min cooldown begins).
    const cooldownBtn = page.locator(
      'ion-header ion-buttons[slot="end"] ion-button[aria-label="Synced just now"]',
    );
    await expect(cooldownBtn).toBeDisabled();
    await expect(
      cooldownBtn.locator('ion-icon[name="refresh-outline"]'),
    ).toBeVisible();
  });
});
