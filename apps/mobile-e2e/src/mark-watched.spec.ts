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
 * Spec 0056 — one-step "Mark as Watched" from an UNTRACKED title-detail page.
 *
 * Two named flows (Test plan §"e2e — TWO named flows"):
 *  - "movie: mark as watched from search"
 *  - "tv: mark as watched from search"
 *
 * Each: search a title → tap the result to open its (untracked) title-detail
 * page → tap "Mark as Watched" (`data-test="mark-watched-btn"` — the new sibling
 * of the existing "Add to Watchlist" `add-btn` in the untracked `.action-area`,
 * `title-detail.page.html` lines 99–107) → the realtime `tracked$` stream flips
 * the page to its tracked layout → navigate to the Watchlist tab → the title
 * renders under the Completed section as a `status-completed` card.
 *
 * ---------------------------------------------------------------------------
 * BLOCKER — gated `test.fixme` (PENDING, NOT FAILING):
 *   These flows assert against the LIVE Firestore emulator (the "Mark as
 *   Watched" tap writes `users/{uid}/watchlist/{tmdbId}` with
 *   `status: 'completed'`, which the watchlist page re-reads via its realtime
 *   subscription). The Firestore emulator CANNOT run under Claude Code tools —
 *   the loopback interface is blocked in this environment (project memory:
 *   "Emulator tooling limitation"). CI runs the emulator-backed e2e gate and the
 *   user can run it in their own terminal, so these are real PR checks; un-skip
 *   (drop `.fixme`) once the emulator is available there.
 *
 *   No seed-data change is required to un-skip: the flows use the `empty`
 *   fixture (clean watchlist under the resolved anon uid) and the committed TMDB
 *   fixtures — movie id 603 ("The Matrix", `tmdb-movie-detail-603.json`) and tv
 *   id 1396 ("Breaking Bad", `tmdb-tv-detail-1396.json`). Neither has episode
 *   docs, which matches the spec: episode docs are NOT required for the Completed
 *   assertion (they only exist after sync).
 * ---------------------------------------------------------------------------
 *
 * Determinism guards (spec 0019, mirrored from search.spec.ts):
 *  - `clearAll()` in `beforeEach` (clear Auth + Firestore between tests).
 *  - TMDB interception registered BEFORE navigating to Search (no live TMDB
 *    call, no `TMDB_API_KEY`).
 *  - seed the `empty` fixture under the uid the app resolves AFTER boot (R3) —
 *    `seedFor` keeps the live anon session and starts the watchlist clean.
 *  - await concrete UI signals (URL, locator visibility) instead of fixed sleeps;
 *    the searchbar debounces (~400ms), so wait for the result cards to appear.
 */

/** Titles in `tmdb-search-multi.json` — the values the result cards render. */
const MOVIE_TITLE = 'The Matrix';
const TV_TITLE = 'Breaking Bad';

test.describe('mark as watched from search (spec 0056)', () => {
  test.beforeEach(async ({ page }) => {
    // Pre-set the onboarding completion flag so the guard (spec 0022) passes
    // through to the tabs shell instead of redirecting to /onboarding.
    await page.addInitScript(() => {
      localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
    });
    // Clean slate between tests: clear the Auth + Firestore emulators.
    await clearAll();
  });

  // Flow 1 — MOVIE. BLOCKED on the Firestore emulator (see file header): the
  // "Mark as Watched" tap writes to the live emulator and the watchlist re-reads
  // it. Un-skip (drop `.fixme`) once the emulator runs in CI / the user's
  // terminal. No seed change needed.
  test.fixme('movie: mark as watched from search', async ({ page }) => {
    // Register path-discriminating routes BEFORE navigation:
    //   **/search/multi** → tmdb-search-multi.json      (search results)
    //   **/movie/**       → tmdb-movie-detail-603.json  (detail for The Matrix)
    // Exercises the live getDetail path (no cache seeded), matching the
    // spec-0037 search-to-detail flow.
    await routeTmdbDiscriminated(page, 'tmdb-movie-detail-603.json');

    await page.goto('/');
    await expect(page).toHaveURL(/\/tabs\/today$/);

    // Seed the `empty` fixture under the resolved anon uid (keeps the app's
    // session; the watchlist starts clean so the added title is unambiguous).
    const uid = await resolveAnonUid(page);
    await seedFor(uid, 'empty');

    // Tab to Search and run the query.
    await page.locator('ion-tab-button[tab="search"]').click();
    await expect(page).toHaveURL(/\/tabs\/search$/);

    await page.locator('lib-search ion-searchbar input').fill('matrix');
    await expect(page.locator('.result-card')).toHaveCount(2);

    // Tap the movie result card (The Matrix, id 603) to open its title-detail
    // page. It is UNTRACKED (not in the seeded watchlist), so the action-area
    // renders the untracked branch (`add-btn` + the new `mark-watched-btn`).
    const movieCard = page
      .locator('.result-card')
      .filter({ has: page.locator('.title', { hasText: MOVIE_TITLE }) });
    await movieCard.click();

    await expect(page).toHaveURL(/\/tabs\/title-detail\/603\?type=movie/);
    await expect(page.locator('[data-test="hero"] .hero-title')).toHaveText(
      MOVIE_TITLE,
    );

    // Confirm the untracked entry point: BOTH the existing "Add to Watchlist"
    // and the new "Mark as Watched" buttons are present.
    const markWatchedBtn = page.locator('[data-test="mark-watched-btn"]');
    await expect(page.locator('[data-test="add-btn"]')).toBeVisible();
    await expect(markWatchedBtn).toBeVisible();

    // Tap "Mark as Watched": `markAsWatched(detail)` → `service.add(detail,
    // 'completed')` writes `users/{uid}/watchlist/603` with status 'completed'.
    await markWatchedBtn.click();

    // The realtime `tracked$` stream re-emits the now-tracked item and the
    // action-area swaps to the tracked layout (status-control shows Completed);
    // the untracked buttons disappear — proving the write landed, no reload.
    await expect(markWatchedBtn).toHaveCount(0);
    await expect(page.locator('[data-test="status-control"]')).toContainText(
      'Completed',
    );

    // Navigate to the Watchlist tab; surviving navigation proves the doc was
    // written to (and re-read from) the emulator, not just held in memory.
    await page.locator('ion-tab-button[tab="watchlist"]').click();
    await expect(page).toHaveURL(/\/tabs\/watchlist$/);

    // The Completed section header renders and the movie card sits under it as
    // a `status-completed` card.
    await expect(
      page.locator('.section-header[data-status="completed"]'),
    ).toBeVisible();
    await expect(
      page
        .locator('.watchlist-card.status-completed')
        .filter({ hasText: MOVIE_TITLE }),
    ).toBeVisible();
  });

  // Flow 2 — TV. BLOCKED on the Firestore emulator (see file header). Episode
  // docs are NOT required for the Completed assertion — id 1396 has none seeded,
  // matching the spec (they only exist after sync). Un-skip once the emulator is
  // available.
  test.fixme('tv: mark as watched from search', async ({ page }) => {
    // Register search/multi (lower priority) then the tv-detail route for id
    // 1396 (higher priority — Playwright applies the most-recently-registered
    // matching route first), mirroring the spec-0043 tv search-to-detail flow.
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

    // Tap the TV result card (Breaking Bad, id 1396) to open its UNTRACKED
    // title-detail page. The ?type=tv hint forces /tv/1396 directly.
    const tvCard = page
      .locator('.result-card')
      .filter({ has: page.locator('.title', { hasText: TV_TITLE }) });
    await tvCard.click();

    await expect(page).toHaveURL(/\/tabs\/title-detail\/1396\?type=tv/);
    await expect(page.locator('[data-test="hero"] .hero-title')).toHaveText(
      TV_TITLE,
    );

    // Untracked entry point: both buttons present.
    const markWatchedBtn = page.locator('[data-test="mark-watched-btn"]');
    await expect(page.locator('[data-test="add-btn"]')).toBeVisible();
    await expect(markWatchedBtn).toBeVisible();

    // Tap "Mark as Watched": writes `users/{uid}/watchlist/1396` with status
    // 'completed'. There are NO episode docs for 1396 (none seeded — they only
    // exist after sync), so the TV bulk episode-mark is a no-op and the
    // Completed status is asserted directly (spec: episode docs not required).
    await markWatchedBtn.click();

    // Realtime flip to the tracked layout; untracked buttons gone.
    await expect(markWatchedBtn).toHaveCount(0);
    await expect(page.locator('[data-test="status-control"]')).toContainText(
      'Completed',
    );

    // Navigate to the Watchlist tab; the title persists and renders Completed.
    await page.locator('ion-tab-button[tab="watchlist"]').click();
    await expect(page).toHaveURL(/\/tabs\/watchlist$/);

    await expect(
      page.locator('.section-header[data-status="completed"]'),
    ).toBeVisible();
    await expect(
      page
        .locator('.watchlist-card.status-completed')
        .filter({ hasText: TV_TITLE }),
    ).toBeVisible();
  });
});
