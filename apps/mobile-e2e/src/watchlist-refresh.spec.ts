import { test, expect } from '@playwright/test';
import { resolveAnonUid, seedFor, clearAll } from './support';

/**
 * Flow 8 — watchlist → pull-to-refresh (spec 0019), REFRAMED per Risk R2.
 *
 * R2 (read this before touching the assertions): the IMPLEMENTED
 * `WatchlistPage.onRefresh($event)` does NOT call an HTTP/callable sync
 * function. It re-subscribes the Firestore realtime stream
 * (`this.typeFilter$.next(this.selectedType)`) and then completes the refresher
 * (`event.detail.complete()`). There is no network sync call to assert.
 *
 * So this file is split into two clearly-labelled parts:
 *   1. RUNNABLE  — assert the ACTUAL behavior: triggering the `ion-refresher`
 *      completes the refresher (returns to idle, not stuck refreshing) and the
 *      list re-renders the seeded `.watchlist-card` from the emulator stream,
 *      with no error surfaced.
 *   2. test.fixme — the decision-record's "sync HTTP function call is triggered
 *      and returns success" assertion. The app makes no such call yet, so this
 *      stays fixme with the sync-endpoint `page.route` stub WIRED AND READY for
 *      when the manual rate-limited sync callable lands (PLAN §6 items 11–12).
 *      The Functions emulator is NOT started (consistent with R2).
 *
 * Determinism (spec 0019 guards): `clearAll()` in beforeEach; per test
 * goto('/') → resolveAnonUid → seedFor(uid,'seeded') → reload so the seeded card
 * renders from the live anon session's uid (R3); await transitions, no fixed
 * sleeps.
 *
 * Selectors grounded in `libs/mobile/watchlist/src/lib/watchlist.page.html`:
 *   - refresher: `ion-refresher` with `(ionRefresh)="onRefresh($event)"`.
 *   - seeded card: `.watchlist-card` (the seeded TV entry "Breaking Bad",
 *     tmdbId 2, status `planned` → class `watchlist-card status-planned`).
 */

/** Title text of the single seeded TV watchlist entry (emulator-data/seeded). */
const SEEDED_TITLE = 'Breaking Bad';

/**
 * Future manual-sync endpoint glob. The callable does NOT exist yet (PLAN §6
 * items 11–12); this is the stub target the `test.fixme` below wires so it is
 * ready the moment the callable is wired into pull-to-refresh. Kept broad to
 * match a Cloud Functions callable / HTTPS endpoint URL once it lands.
 */
const SYNC_ENDPOINT_GLOB = '**/*syncWatchlist*';

test.beforeEach(async ({ page }) => {
  // Pre-set the onboarding completion flag so the guard (spec 0022) passes
  // through to the tabs shell instead of redirecting to /onboarding.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Clean slate between tests (clear Auth + Firestore via emulator REST).
  await clearAll();
});

/**
 * Boot the app, resolve the live anon uid, seed the `seeded` fixture under THAT
 * uid (R3 — avoids the owner-mismatch empty-list trap), then reload so the
 * Watchlist renders the seeded card from the emulator stream. Returns the uid.
 */
async function bootSeededWatchlist(page: import('@playwright/test').Page) {
  await page.goto('/');
  // Anon sign-in must settle so we seed under the uid the app actually uses.
  const uid = await resolveAnonUid(page);
  await seedFor(uid, 'seeded');
  // Reload so the freshly-seeded docs are picked up by the watchlist stream.
  await page.reload();

  // Land on Watchlist and confirm the seeded card rendered before refreshing.
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);
  await expect(page.locator('.watchlist-card')).toHaveCount(1);
  await expect(page.locator('.watchlist-card')).toContainText(SEEDED_TITLE);
  return uid;
}

/**
 * Trigger the Ionic `ion-refresher`'s `ionRefresh` so the component's
 * `onRefresh($event)` runs. We dispatch the `ionRefresh` CustomEvent directly on
 * the `<ion-refresher>` element (the deterministic, gesture-free approach):
 * `onRefresh` reads `event.detail.complete` and calls it, so we supply a
 * `complete` function in `detail`. The returned promise resolves once the
 * component has invoked `complete()` — i.e. the refresher finished — which lets
 * us assert it returned to idle without relying on a flaky pull gesture.
 */
async function triggerRefresh(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const refresher = document.querySelector('ion-refresher');
    if (!refresher) {
      throw new Error('ion-refresher not found on the Watchlist page');
    }
    return new Promise<void>((resolve) => {
      // The handler calls event.detail.complete(); resolving there proves the
      // refresher completed (onRefresh ran to the end and returned to idle).
      const detail = { complete: () => resolve() };
      refresher.dispatchEvent(new CustomEvent('ionRefresh', { detail }));
    });
  });
}

// ---------------------------------------------------------------------------
// PART 1 — RUNNABLE: the ACTUAL implemented behavior (R2).
// Refresher completes (returns to idle) + list re-renders from the emulator
// stream (seeded card still present), no error surfaced.
// ---------------------------------------------------------------------------
test('F8 (runnable): pull-to-refresh completes and re-renders the seeded list from the emulator stream', async ({
  page,
}) => {
  await bootSeededWatchlist(page);

  // Fail the test if the app surfaces a console/page error during the refresh.
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Trigger ion-refresher -> onRefresh($event); resolves once complete() runs.
  await triggerRefresh(page);

  // The refresher returned to idle (NOT stuck refreshing). Ionic toggles the
  // `refresher-active` / `refresher-refreshing` state classes on the host while
  // pulling/refreshing and removes them once `complete()` runs.
  await expect(page.locator('ion-refresher')).not.toHaveClass(
    /refresher-(active|refreshing)/,
  );

  // The list re-rendered from the Firestore emulator stream: the seeded card is
  // still present (re-subscribe yielded the same single seeded entry).
  await expect(page.locator('.watchlist-card')).toHaveCount(1);
  await expect(page.locator('.watchlist-card')).toContainText(SEEDED_TITLE);

  // No empty-state flicker-to-stuck and no surfaced error.
  await expect(page.locator('.empty-state')).toHaveCount(0);
  expect(pageErrors, 'no page error during pull-to-refresh').toEqual([]);
});

// ---------------------------------------------------------------------------
// PART 2 — test.fixme: the decision-record's HTTP-sync assertion.
// The app makes NO sync HTTP/callable call on refresh today (R2). This stays
// fixme with the sync-endpoint page.route STUB wired and ready, so it un-skips
// the moment the manual rate-limited sync callable is wired into onRefresh.
// TODO(PLAN §6 items 11–12: manual rate-limited sync callable wired into pull-to-refresh)
// ---------------------------------------------------------------------------
test.fixme('F8 (fixme): pull-to-refresh triggers the manual sync callable and it returns success', async ({
  page,
}) => {
  // STUB the future sync endpoint (callable/HTTPS) — wired and ready. When the
  // callable lands and onRefresh invokes it, this fulfill returns success and
  // `syncCalled` flips true. We do NOT assert an HTTP call the app never makes:
  // until the callable is wired, this test is fixme (not executed).
  let syncCalled = false;
  await page.route(SYNC_ENDPOINT_GLOB, async (route) => {
    syncCalled = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Shape is illustrative; align with the callable's real result envelope
      // when PLAN §6 items 11–12 land.
      body: JSON.stringify({ result: { status: 'success', synced: 1 } }),
    });
  });

  await bootSeededWatchlist(page);

  // Trigger the refresher; once the callable is wired, onRefresh will fire the
  // request the route above intercepts.
  await triggerRefresh(page);

  // The future assertion: the sync endpoint was called and returned success.
  expect(
    syncCalled,
    'manual sync callable was invoked by pull-to-refresh',
  ).toBe(true);

  // And the list still re-renders from the emulator stream after a sync.
  await expect(page.locator('.watchlist-card')).toContainText(SEEDED_TITLE);
});
