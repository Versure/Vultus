import { test, expect } from '@playwright/test';
import { clearAll, resolveAnonUid, seedFor } from './support';

/**
 * Spec 0061 (Plex provider) — REQUIRED e2e flow, T6.
 *
 * "manual Plex tagging shows alongside provider availability": Plex is a manual,
 * presentation-only per-title flag (`users/{uid}/watchlist/{titleId}.watchingViaPlex`)
 * that renders ADDITIVELY to — never replacing — spec 0060's TMDB availability
 * framing (spec 0061 decision 4). This flow asserts BOTH indicators render
 * together in the two places 0061 surfaces them:
 *
 *   (a) title-detail "Where to Watch" card: the "Personal Tracking" subsection's
 *       active "Watching via Plex" row (with the "Local Server" caption) renders
 *       AND 0060's provider group ("On Your Providers", the flatrate Netflix match)
 *       still renders above it — additivity, not replacement.
 *   (b) watchlist card: the read-only Plex badge (`.plex-badge`, the bundled Plex
 *       logo `img[alt="Plex"]`) renders alongside 0060's availability pill
 *       (`.availability-pill.is-mine`, "On Netflix") — again both present.
 *
 * Emulator-backed, `seeded` fixture (spec 0019 conventions — `clearAll()` in
 * `beforeEach`, boot → `resolveAnonUid` → `seedFor` under the LIVE anon uid (R3)
 * → reload so the streams re-read the seeded state). NO TMDB route is needed: the
 * flow reads purely from seeded Firestore — `users/{uid}.hasPlex`,
 * `users/{uid}/watchlist/2.watchingViaPlex`, `users/{uid}.myProviderIds`, and the
 * pre-seeded `title-cache/2` (metadata, cache-first detail resolution) +
 * `title-cache/2/availability/NL` (flatrate Netflix). No TMDB or callable is hit.
 *
 * SEED SHAPE (see `emulator-data/seeded/docs.json`, spec 0061 additions):
 *   - `users/{uid}.hasPlex = true` → title-detail renders the "Personal Tracking"
 *     toggle control (decision 3 gates the control's VISIBILITY on hasPlex).
 *   - `users/{uid}/watchlist/2.watchingViaPlex = true` → the active Plex row on
 *     title-detail and the read-only badge on the watchlist card.
 *   - `users/{uid}.myProviderIds = [8]` (Netflix) + `title-cache/2/availability/NL`
 *     FLATRATE Netflix (id 8, SELECTED) → the "On Your Providers" group / "On
 *     Netflix" pill — the 0060 framing this flow asserts is UNCHANGED alongside
 *     the Plex indicators.
 *
 * The seeded Breaking Bad (tmdbId 2) IS the fixture's default watchlist card, so
 * no per-test `writeDocument` is needed (contrast provider-preferences.spec.ts,
 * which adds a SECOND card). Sibling specs sharing this fixture
 * (watchlist-refresh.spec.ts, title-detail.spec.ts, provider-preferences.spec.ts)
 * are unaffected: 0061 only ADDS two boolean fields to docs they already read;
 * the card count, the "On Netflix" pill, and the count-1/remove-to-empty
 * assertions are untouched.
 *
 * Selectors grounded in the committed templates:
 *   - watchlist card: `.watchlist-card` (spec 0019), `.availability-pill.is-mine`
 *     (spec 0060), `.plex-badge` + its `img[alt="Plex"]` (spec 0061,
 *     libs/mobile/watchlist/src/lib/watchlist.page.html).
 *   - title-detail: `[data-test="providers"]` card, `[data-test="group-mine"]`
 *     (spec 0060), `[data-test="personal-tracking"]` +
 *     `[data-test="plex-active-row"]` + `[data-test="plex-change"]` (spec 0061,
 *     libs/mobile/title-detail/src/lib/title-detail.page.html).
 */

const SEEDED_TITLE = 'Breaking Bad'; // tmdbId 2, flatrate Netflix (id 8, selected), watchingViaPlex true

test.beforeEach(async ({ page }) => {
  // Pass the onboarding guard (spec 0022) so we land on the tabs shell.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Deterministic reset before the app boots its anon session (spec 0019).
  await clearAll();
});

test('manual Plex tagging shows alongside provider availability', async ({
  page,
}) => {
  // Boot; the app signs in anonymously against the Auth emulator.
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // Resolve the LIVE anon uid so the seeded docs line up with the session (R3).
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // Seed the shared fixture (hasPlex true, watchlist/2.watchingViaPlex true,
  // myProviderIds [8], availability for tmdbId 2) under that uid.
  await seedFor(uid, 'seeded');

  // Reload so the watchlist stream picks up the freshly-seeded docs.
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // The seeded card renders (guards the R3 owner-mismatch empty-list trap).
  const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
  await expect(card).toBeVisible();

  // -------------------------------------------------------------------------
  // (b) WATCHLIST CARD: the read-only Plex badge renders ALONGSIDE 0060's
  //     availability pill — both present, additive (decision 4).
  // -------------------------------------------------------------------------

  // 0060's availability pill still renders: the highlighted "On Netflix" (mine)
  // variant (Netflix id 8 ∈ myProviderIds).
  const pill = card.locator('.availability-pill');
  await expect(pill).toBeVisible();
  await expect(pill).toHaveClass(/\bis-mine\b/);
  await expect(pill).toHaveText(/^On Netflix$/);

  // 0061's read-only Plex badge renders in the SAME card, alongside the pill.
  const badge = card.locator('.plex-badge');
  await expect(badge).toBeVisible();
  await expect(badge.locator('img[alt="Plex"]')).toBeVisible();

  // Both indicators coexist on the one card (the additivity assertion).
  await expect(card.locator('.availability-pill')).toHaveCount(1);
  await expect(card.locator('.plex-badge')).toHaveCount(1);

  // -------------------------------------------------------------------------
  // (a) TITLE-DETAIL: open the seeded title. The "Personal Tracking" active
  //     "Watching via Plex" row renders AND 0060's provider group still renders
  //     in the same "Where to Watch" card — both present, additive.
  // -------------------------------------------------------------------------

  // Tap the card: navigateToDetail → /tabs/title-detail/2?type=tv (cache-first
  // resolution from the seeded title-cache/2 doc — no TMDB network call).
  await card.click();
  await expect(page).toHaveURL(/\/tabs\/title-detail\/2\?type=tv/);

  // The hero shows the seeded title (detail loaded).
  await expect(page.locator('[data-test="hero"] .hero-title')).toHaveText(
    SEEDED_TITLE,
  );

  // The "Where to Watch" card is present.
  const whereToWatch = page.locator('[data-test="providers"]');
  await expect(whereToWatch).toBeVisible();

  // 0060's provider framing is UNCHANGED: the "On Your Providers" group renders
  // (flatrate Netflix id 8 ∈ myProviderIds).
  const mineGroup = whereToWatch.locator('[data-test="group-mine"]');
  await expect(mineGroup).toBeVisible();
  await expect(mineGroup).toContainText('On Your Providers');
  await expect(
    mineGroup.locator('[data-test="provider-row-mine"]'),
  ).toContainText('Netflix');

  // 0061's "Personal Tracking" subsection renders the ACTIVE "Watching via Plex"
  // row (watchingViaPlex true): the bold title, the "Local Server" caption, and
  // the "Change" affordance.
  const personalTracking = whereToWatch.locator(
    '[data-test="personal-tracking"]',
  );
  await expect(personalTracking).toBeVisible();
  await expect(personalTracking).toContainText('Personal Tracking');

  const activeRow = personalTracking.locator('[data-test="plex-active-row"]');
  await expect(activeRow).toBeVisible();
  await expect(activeRow).toContainText('Watching via Plex');
  await expect(activeRow).toContainText('Local Server');
  await expect(activeRow.locator('img[alt="Plex"]')).toBeVisible();
  await expect(activeRow.locator('[data-test="plex-change"]')).toContainText(
    'Change',
  );

  // The empty affordance is NOT rendered when watchingViaPlex is true (exactly
  // one of the two rows renders at runtime).
  await expect(
    personalTracking.locator('[data-test="plex-empty-row"]'),
  ).toHaveCount(0);

  // ADDITIVITY (decision 4): the provider group and the Plex row coexist in the
  // one "Where to Watch" card — the Plex row never suppresses 0060's framing.
  await expect(whereToWatch.locator('[data-test="group-mine"]')).toHaveCount(1);
  await expect(
    whereToWatch.locator('[data-test="plex-active-row"]'),
  ).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// DEFERRED (test.fixme — PENDING, NOT FAILING): the title-detail toggle
// round-trip.
//
// The OPTIONAL "tap the Personal Tracking row on title-detail and observe the
// watchlist badge appear/disappear" round-trip is gated fixme. The two seeded
// assertions above ARE the required gate (spec 0061 Test plan e2e rubric —
// "the two seeded assertions above are the required gate; the toggle round-trip
// can be test.fixme"). The write-then-observe timing across a route change
// (togglePlex → updateDoc({ watchingViaPlex }) on title-detail, then observing
// the realtime watchlist stream re-render the badge on the OTHER page) is not a
// pattern the current suite exercises deterministically; rather than add new
// cross-page write-observe plumbing as a 0061 side quest, this stays fixme.
// Un-skip once the suite has an established write-then-observe-across-navigation
// helper.
// ---------------------------------------------------------------------------
test.fixme('toggling Plex on title-detail flips the watchlist badge', async ({
  page,
}) => {
  await page.goto('/');
  const uid = await resolveAnonUid(page);
  await seedFor(uid, 'seeded');
  await page.reload();

  // Open the seeded title's detail page.
  const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
  await card.click();
  await expect(page).toHaveURL(/\/tabs\/title-detail\/2\?type=tv/);

  // The seed starts watchingViaPlex true → the active row shows "Change".
  // Tapping it calls togglePlex → toggleWatchingViaPlex(2, false), clearing the
  // flag; the watchlist badge should then disappear.
  const changeBtn = page.locator('[data-test="plex-change"]');
  await expect(changeBtn).toBeVisible();
  await changeBtn.click();

  // Back on the watchlist, the badge is gone (pill unchanged — additivity).
  await page.locator('ion-tab-button[tab="watchlist"]').click();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);
  const back = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
  await expect(back.locator('.plex-badge')).toHaveCount(0);
  await expect(back.locator('.availability-pill')).toBeVisible();
});
