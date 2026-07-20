import { test, expect } from '@playwright/test';
import { clearAll, resolveAnonUid, seedFor } from './support';

/**
 * Spec 0042 — in-app notifications inbox e2e (two named flows, §8).
 *
 * These are REAL passing flows (independent of live FCM): they read seeded
 * `users/{uid}/notifications` docs from the Firestore emulator, not a push, so
 * unlike 0041's push flow they are NOT `test.fixme`-gated.
 *
 * MEMORY CAVEAT (recorded, not skipped): the Firestore emulator / Playwright e2e
 * gate CANNOT run under Claude Code tools here (loopback blocked — project
 * memory). These specs are AUTHORED for the user to run in their own terminal:
 *   firebase emulators:start   (Auth 9099 + Firestore 8080)
 *   pnpm nx e2e mobile-e2e
 *
 * Selectors grounded in the implemented DOM:
 *   - watchlist bell:   `.bell-button` (aria-label="Notifications"),
 *     libs/mobile/watchlist/src/lib/watchlist.page.html → openNotifications()
 *     → router.navigate(['tabs','notifications']).
 *   - inbox rows:       `.notification-card` (one per notification), the unread
 *     ones carry `.notification-card--unread` + a `.notification-dot`; the page
 *     is libs/mobile/notifications/src/lib/notifications.page.html.
 *   - empty state:      `vultus-empty-state` ("No notifications yet").
 *
 * Determinism (spec 0019 guards): `clearAll()` in beforeEach; per-test boot →
 * resolveAnonUid → seedFor(uid, fixture) → reload so docs render under the live
 * session uid (R3); await concrete URL/locator transitions, no fixed sleeps.
 */

/** Seeded notification facts (emulator-data/seeded/docs.json, spec 0042 docs). */
const SEEDED_NOTIF_COUNT = 2;
const FIRST_NOTIF_TITLE = 'Breaking Bad'; // newest (unread) row, sentAt 2026-06-29

test.beforeEach(async ({ page }) => {
  // Pre-set the onboarding completion flag so the guard (spec 0022) passes
  // through to the tabs shell instead of redirecting to /onboarding.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Clean emulator state before the app boots and creates its anon session.
  await clearAll();
});

/**
 * Boot the app, resolve the live anon uid, seed the named fixture under it, and
 * reload so the app subscribes to the seeded state on the Watchlist tab. Returns
 * the resolved uid.
 */
async function bootAndSeed(
  page: import('@playwright/test').Page,
  fixture: 'seeded' | 'empty',
): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/today$/);

  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  await seedFor(uid, fixture);
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);

  return uid;
}

/** Tap the watchlist header bell → push the notifications inbox. */
async function openInbox(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.bell-button').click();
  await expect(page).toHaveURL(/\/tabs\/notifications$/);
}

test('notifications inbox lists seeded notifications and deep-links a tap', async ({
  page,
}) => {
  await bootAndSeed(page, 'seeded');

  // Open the inbox from the watchlist bell.
  await openInbox(page);

  // The inbox lists the seeded notifications, newest-first.
  const rows = page.locator('.notification-card');
  await expect(rows).toHaveCount(SEEDED_NOTIF_COUNT);

  // First (newest, unread) row shows its title + the unread dot.
  const firstRow = rows.first();
  await expect(firstRow).toContainText(FIRST_NOTIF_TITLE);
  await expect(firstRow.locator('.notification-dot')).toBeVisible();

  // Tapping the row deep-links to title-detail for that title (tmdbId 2 —
  // seeded title-cache/2 resolves cache-first, no TMDB network call).
  await firstRow.click();
  await expect(page).toHaveURL(/\/tabs\/title-detail\/2$/);
});

test('notifications empty state', async ({ page }) => {
  // The `empty` fixture seeds only the users/{uid} profile — no notifications.
  await bootAndSeed(page, 'empty');

  await openInbox(page);

  // No rows; the inbox renders the empty state. Scope to the notifications page
  // host (`lib-notifications`) — with the `empty` fixture the Watchlist tab also
  // renders its own `vultus-empty-state`, and Ionic keeps the previous page in
  // the router-outlet DOM, so a bare `vultus-empty-state` locator matches both.
  await expect(page.locator('.notification-card')).toHaveCount(0);
  const emptyState = page.locator('lib-notifications vultus-empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('No notifications yet');
});
