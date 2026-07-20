import { test, expect } from '@playwright/test';
import { clearAll, resolveAnonUid, seedFor } from './support';

/**
 * Watch Today tab e2e flows (spec 0083 — the new default landing tab that shows
 * only titles watchable RIGHT NOW). The Today page (`lib-today`) partitions the
 * watching/planned watchlist into a Movies section (gated on `releaseDate`) and a
 * TV Shows section (gated on spec 0081's `nextUnwatchedEpisodeAirDate`), rendering
 * a card per watchable title with a provider pill, a "Ready to watch" tag, and —
 * for TV — an "S{season}E{episode} available" label.
 *
 * WHY THESE ARE test.fixme (PENDING, NOT FAILING)
 * -----------------------------------------------
 * The DATA-BEARING Today flows (a populated Today tab, the "nothing watchable"
 * empty state, and a watchable card tapping through to title-detail) all require
 * emulator seed data that DOES NOT EXIST yet: a watchlist item whose watchable
 * gate resolves deterministically needs spec 0081's `nextUnwatchedEpisodeAirDate`
 * field (TV) plus a populated `users/{uid}/watchlist/{titleId}/episodes`
 * subcollection so the S/E enrichment label resolves. The current committed
 * fixtures (`emulator-data/{empty,seeded}/docs.json`) provide neither the 0081
 * field nor watchable-dated episodes, so there is no way to seed a title that the
 * Today gate would surface. These are authored FULLY but gated with `test.fixme`
 * so the suite stays GREEN (pending, not failing) — mirroring the precedent in
 * `title-detail.spec.ts` (specs 0034/0047). Un-skip (drop `.fixme`) once a
 * "watchable" fixture lands with the 0081 field + synced episode docs.
 *
 * NOTE — the NON-fixme half of spec 0083's e2e is already covered elsewhere:
 * the default landing route now being `/tabs/today`, the four-tab bar, and Today
 * being the selected tab are asserted for REAL (no 0081 data dependency) in
 * `app.boot.spec.ts` / `app.smoke.spec.ts`, and the post-onboarding / reverse-
 * guard landing on `/tabs/today` in `onboarding.spec.ts`. Those are the CI gates;
 * this file only defers the data-bearing content flows.
 *
 * Emulator-port invariant (spec 0019): Auth 9099 / Firestore 8080. The Firestore
 * emulator cannot run under Claude Code tools (project memory) — these run in CI
 * or the user's own terminal.
 */

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
 * (a) Boots into the Today tab by default with a POPULATED Today page.
 *
 * Blocker: the basic default-route / four-tab / Today-selected assertions run for
 * real in app.boot/app.smoke, but asserting the Today page's POPULATED content
 * (Movies/TV sections + at least one watchable card) needs a seeded watchable
 * title (spec 0081's `nextUnwatchedEpisodeAirDate` + episode docs) that the
 * current fixtures do not provide. Un-skip when a "watchable" fixture lands.
 */
test.fixme('boots into /tabs/today with the Today tab active and watchable cards rendered', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // Today is the leftmost + selected tab (Ionic marks it `tab-selected`).
  await expect(page.locator('ion-tab-button')).toHaveCount(4);
  await expect(page.locator('ion-tab-button[tab="today"]')).toHaveClass(
    /tab-selected/,
  );

  // Seed a watchable fixture under the live uid, then reload so the Today page
  // subscribes to it. (FUTURE: this fixture must carry a TV item with a PAST
  // `nextUnwatchedEpisodeAirDate` + episode docs, and/or a movie with a past
  // `releaseDate`, so the Today gate surfaces it.)
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();
  await seedFor(uid, 'seeded');
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // The Today page renders at least one watchable card with its "Ready to watch"
  // tag once a watchable fixture exists.
  const card = page.locator('lib-today .today-card').first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Ready to watch');
});

/**
 * (b) Empty state renders when nothing on the watchlist is watchable today.
 *
 * Blocker: to prove the Today-specific empty state ("Nothing to watch today")
 * distinctly from watchlist's empty state, the fixture must contain watching/
 * planned titles that are deterministically NOT watchable (future/absent dates)
 * — which again requires control over the 0081 `nextUnwatchedEpisodeAirDate`
 * field the current fixtures lack. Un-skip when a non-watchable fixture lands.
 */
test.fixme('renders the Today empty state when nothing on the watchlist is watchable', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // FUTURE: seed a fixture with watching/planned titles whose watchable gate is
  // false (future `nextUnwatchedEpisodeAirDate` / future `releaseDate`), so the
  // watchlist is non-empty but the Today page has nothing to surface.
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();
  await seedFor(uid, 'seeded');
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // The Today-specific empty state (authored copy, not Stitch-sourced) shows.
  const emptyState = page.locator('lib-today vultus-empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('Nothing to watch today');
});

/**
 * (c) Tapping a watchable card navigates through to title-detail.
 *
 * Blocker: needs a watchable seeded title (spec 0081 field + episode docs) so a
 * card actually renders on the Today page to tap. The card navigates by string
 * segments `['tabs','title-detail', titleId]` with `{ queryParams: { type } }`
 * (mirrors watchlist's `navigateToDetail`). Un-skip when a watchable fixture
 * lands.
 */
test.fixme('tapping a watchable Today card navigates to title-detail', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/today$/);

  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();
  await seedFor(uid, 'seeded');
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // Tap the first watchable card → title-detail opens for that title. (tmdbId 2
  // is the seeded TV entry; the concrete id/type depend on the future watchable
  // fixture.)
  const card = page.locator('lib-today .today-card').first();
  await expect(card).toBeVisible();
  await card.click();

  await expect(page).toHaveURL(/\/tabs\/title-detail\/\d+(\?type=(movie|tv))?/);
});
