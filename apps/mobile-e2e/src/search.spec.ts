import { test, expect } from '@playwright/test';
import { clearAll, resolveAnonUid, routeTmdb, seedFor } from './support';

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
  test.beforeEach(async () => {
    // Clean slate between tests: clear the Auth + Firestore emulators.
    await clearAll();
  });

  test('F2 — search renders TMDB result cards', async ({ page }) => {
    // Intercept TMDB BEFORE navigation so the search never hits the network.
    await routeTmdb(page);

    await page.goto('/');
    await expect(page).toHaveURL(/\/tabs\/watchlist$/);

    // Resolve the live anon uid and seed the `empty` fixture under it (keeps the
    // app's session — `seedFor` does not clear Auth).
    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'empty');

    // Tab to Search and wait for the page transition to settle.
    await page.locator('ion-tab-button[tab="search"]').click();
    await expect(page).toHaveURL(/\/tabs\/search$/);

    // Prompt/empty state shows before any query is typed.
    await expect(
      page.locator('vultus-empty-state .vultus-empty-state__title'),
    ).toHaveText('Search for movies and TV shows');

    // Type a query into the searchbar's inner native input. The component reads
    // `(ionInput)` -> service debounces (~400ms) -> results render.
    await page.locator('ion-searchbar input').fill('matrix');

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
    await expect(page).toHaveURL(/\/tabs\/watchlist$/);

    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'empty');

    await page.locator('ion-tab-button[tab="search"]').click();
    await expect(page).toHaveURL(/\/tabs\/search$/);

    await page.locator('ion-searchbar input').fill('matrix');
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
});
