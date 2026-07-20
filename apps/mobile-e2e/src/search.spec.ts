import { test, expect } from '@playwright/test';
import {
  clearAll,
  resolveAnonUid,
  routeTmdb,
  routeTmdbDiscriminated,
  routeTmdbTV,
  seedFor,
} from './support';

/**
 * Flows F2–F3 (spec 0019, Test plan) — emulator-backed, TMDB intercepted.
 *
 * F2 — search → result cards render from the committed TMDB fixture.
 * F3 — search → add → the card swaps to its added state, and the title persists
 *      to the Firestore emulator under the Planned section of the watchlist.
 *
 * Determinism guards (spec 0019):
 *  - `clearAll()` in `beforeEach` (clear Auth + Firestore between tests).
 *  - `routeTmdb(page)` registered BEFORE navigating to Search (no live TMDB call,
 *    no `TMDB_API_KEY`).
 *  - seed under the uid the app resolves AFTER boot (R3) — `seedFor` keeps the
 *    live anon session, seeding the `empty` fixture so the watchlist starts clean.
 *  - await concrete UI signals (URL, locator visibility) instead of fixed sleeps.
 *    The searchbar debounces (~400ms), so we wait for the result cards to appear
 *    rather than asserting immediately.
 *
 * Fixture (`fixtures/tmdb-search-multi.json`): one movie ("The Matrix", id 603)
 * and one tv show ("Breaking Bad", id 1396). These are the titles asserted below.
 */

/** Titles in `tmdb-search-multi.json` — the values the result cards render. */
const MOVIE_TITLE = 'The Matrix';
const TV_TITLE = 'Breaking Bad';

test.describe('search (F2–F3)', () => {
  test.beforeEach(async ({ page }) => {
    // Pre-set the onboarding completion flag so the guard (spec 0022) passes
    // through to the tabs shell instead of redirecting to /onboarding.
    await page.addInitScript(() => {
      localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
    });
    // Clean slate between tests: clear the Auth + Firestore emulators.
    await clearAll();
  });

  test('F2 — search renders TMDB result cards', async ({ page }) => {
    // Intercept TMDB BEFORE navigation so the search never hits the network.
    await routeTmdb(page);

    await page.goto('/');
    await expect(page).toHaveURL(/\/tabs\/today$/);

    // Resolve the live anon uid and seed the `empty` fixture under it (keeps the
    // app's session — `seedFor` does not clear Auth).
    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'empty');

    // Tab to Search and wait for the page transition to settle.
    await page.locator('ion-tab-button[tab="search"]').click();
    await expect(page).toHaveURL(/\/tabs\/search$/);

    // Prompt/empty state shows before any query is typed.
    // Scoped to lib-search to avoid matching the watchlist tab's empty state
    // (Ionic keeps inactive tabs in the DOM).
    await expect(
      page.locator('lib-search vultus-empty-state .vultus-empty-state__title'),
    ).toHaveText('Search for movies and TV shows');

    // Type a query into the searchbar's inner native input. The component reads
    // `(ionInput)` -> service debounces (~400ms) -> results render.
    // Scoped to lib-search: the watchlist tab also has an IonSearchbar and Ionic
    // keeps inactive tabs in the DOM, so an unscoped locator resolves to 2 elements.
    await page.locator('lib-search ion-searchbar input').fill('matrix');

    // Wait for the debounced results rather than asserting immediately.
    await expect(page.locator('.result-card')).toHaveCount(2);

    // Both fixture titles render as result cards.
    await expect(
      page.locator('.result-card .title', { hasText: MOVIE_TITLE }),
    ).toBeVisible();
    await expect(
      page.locator('.result-card .title', { hasText: TV_TITLE }),
    ).toBeVisible();
  });

  test('F3 — add a result → swaps to added state → persists as Planned', async ({
    page,
  }) => {
    await routeTmdb(page);

    await page.goto('/');
    await expect(page).toHaveURL(/\/tabs\/today$/);

    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'empty');

    await page.locator('ion-tab-button[tab="search"]').click();
    await expect(page).toHaveURL(/\/tabs\/search$/);

    await page.locator('lib-search ion-searchbar input').fill('matrix');
    await expect(page.locator('.result-card')).toHaveCount(2);

    // Scope to the movie card so the assertions target one specific result.
    const movieCard = page
      .locator('.result-card')
      .filter({ has: page.locator('.title', { hasText: MOVIE_TITLE }) });

    // Default state: the add button is present, the added marker is not.
    await expect(movieCard.locator('.add-btn')).toBeVisible();
    await expect(movieCard.locator('.added-btn')).toHaveCount(0);

    // Add the title. The template swaps the `@if (result.added)` branch — this is
    // a SEPARATE element swap, not an in-place mutation.
    await movieCard.locator('.add-btn').click();

    // The disabled `.added-btn` (with the checkmark icon) APPEARS …
    const addedBtn = movieCard.locator('.added-btn');
    await expect(addedBtn).toBeVisible();
    // ion-button reflects disabled via the `disabled` HTML attribute; Playwright's
    // toBeDisabled() misreads Ionic custom elements via the accessibility tree, so
    // we assert the attribute directly (same semantic, unambiguous).
    await expect(addedBtn).toHaveAttribute('disabled', '');
    await expect(
      addedBtn.locator('ion-icon[name="checkmark-circle"]'),
    ).toBeVisible();
    // … and the `.add-btn` for that card DISAPPEARS.
    await expect(movieCard.locator('.add-btn')).toHaveCount(0);

    // Navigate to the Watchlist; the added title should now be persisted in the
    // Firestore emulator and render under the Planned section (PLAN §4 default
    // `status: "planned"`).
    await page.locator('ion-tab-button[tab="watchlist"]').click();
    await expect(page).toHaveURL(/\/tabs\/watchlist$/);

    // The Planned section header renders (proves a planned group exists).
    await expect(
      page.locator('.section-header[data-status="planned"]'),
    ).toBeVisible();

    // The added title renders in a watchlist card — surviving navigation proves
    // it was written to (and re-read from) the emulator, not just held in memory.
    await expect(
      page.locator('.watchlist-card .card-title', { hasText: MOVIE_TITLE }),
    ).toBeVisible();
  });

  // spec 0037 — search → detail shows the TAPPED title (not a wrong id fallback).
  test('search-to-detail-correct-title: tapping a result opens the correct title (spec 0037)', async ({
    page,
  }) => {
    // Register path-discriminating routes BEFORE navigation:
    //   **/search/multi** → tmdb-search-multi.json  (search results)
    //   **/movie/**       → tmdb-movie-detail-603.json  (detail for The Matrix, id 603)
    // This exercises the live getDetail path (no cache seeded) which is exactly
    // where the wrong-title bug bit — without it the detail call gets the search
    // shape and the hero renders empty.
    await routeTmdbDiscriminated(page, 'tmdb-movie-detail-603.json');

    await page.goto('/');
    await expect(page).toHaveURL(/\/tabs\/today$/);

    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'empty');

    await page.locator('ion-tab-button[tab="search"]').click();
    await expect(page).toHaveURL(/\/tabs\/search$/);

    await page.locator('lib-search ion-searchbar input').fill('matrix');
    await expect(page.locator('.result-card')).toHaveCount(2);

    // Tap the movie result card body (The Matrix, id 603 in tmdb-search-multi.json).
    const movieCard = page
      .locator('.result-card')
      .filter({ has: page.locator('.title', { hasText: MOVIE_TITLE }) });
    await movieCard.click();

    // URL navigates to the title-detail route for id 603, with ?type=movie.
    await expect(page).toHaveURL(/\/tabs\/title-detail\/603\?type=movie/);

    // The detail hero shows "The Matrix" — the tapped title, served by the
    // /movie/603 fixture, NOT a wrong fall-through title.
    await expect(page.locator('[data-test="hero"] .hero-title')).toHaveText(
      MOVIE_TITLE,
    );
  });

  // spec 0043 — the ?type=tv hint forces /tv/{id} directly, preventing the
  // movie-first fall-through that rendered the wrong title for id 84773.
  test('search-to-detail-correct-title: tapping a tv result opens the correct tv title (spec 0043)', async ({
    page,
  }) => {
    // Register search/multi route first (lower priority), then the tv-detail
    // route (higher priority — Playwright applies the most-recently-registered
    // matching route first). No /movie/1396 interception: if the hint fails and
    // the client calls /movie/1396, the tv-detail handler still matches it (both
    // contain "1396"), but the URL assertion below (/?type=tv) would then be
    // missing, proving the fix. The absence of a distinct /movie/** fixture is
    // intentional — it keeps the test honest.
    await routeTmdb(page);
    await routeTmdbTV(page, 1396, 'tmdb-tv-detail-1396.json');

    await page.goto('/');
    await expect(page).toHaveURL(/\/tabs\/today$/);

    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'empty');

    await page.locator('ion-tab-button[tab="search"]').click();
    await expect(page).toHaveURL(/\/tabs\/search$/);

    await page.locator('lib-search ion-searchbar input').fill('breaking');
    await expect(page.locator('.result-card')).toHaveCount(2);

    // Tap the TV result card (Breaking Bad, id 1396 in tmdb-search-multi.json).
    const tvCard = page
      .locator('.result-card')
      .filter({ has: page.locator('.title', { hasText: TV_TITLE }) });
    await tvCard.click();

    // URL must include ?type=tv — proves openDetail passed the type hint.
    await expect(page).toHaveURL(/\/tabs\/title-detail\/1396\?type=tv/);

    // The detail hero shows "Breaking Bad" — the tapped tv title, served by
    // /tv/1396 (not a movie fall-through). This is a cache miss, so it
    // exercises the live getDetail path where the collision bites.
    await expect(page.locator('[data-test="hero"] .hero-title')).toHaveText(
      TV_TITLE,
    );
  });
});
