import { test, expect } from '@playwright/test';
import { clearAll, resolveAnonUid, seedFor } from './support';

/**
 * Flows F4–F6 (spec 0019) — title-detail open / change status / remove.
 *
 * Two distinct halves live in this file (the split is deliberate and load-bearing):
 *
 *  1. RUNNABLE (green now) — the status-change and remove behaviors the WATCHLIST
 *     page ALREADY owns: the per-card status action-sheet
 *     (`.status-chip` -> `ion-action-sheet[header="Set status"]` -> `onStatusSelected`
 *     -> `WatchlistService.updateStatus`) and the per-card delete-confirm alert
 *     (`.delete-btn` -> `ion-alert.vultus-alert` "Remove title" -> `onDeleteItem`
 *     -> `WatchlistService.removeTitle`). These are the non-fixme parts of F5/F6
 *     (Test plan F5/F6 NOTE + Risk R1) and assert against the live Firestore
 *     emulator stream.
 *
 *  2. DEFERRED (`test.fixme`, pending) — the title-detail-ORIGINATED flows F4/F5/F6.
 *     The `title-detail` slice is NOT implemented in this base (Risk R1):
 *     `libs/mobile/title-detail/` is empty, there is no `tabs/title-detail/:titleId`
 *     route, and the watchlist card's `navigateToDetail` deliberately catches +
 *     no-ops when that route is absent. These tests are authored FULLY but gated
 *     with `test.fixme(...)` so the suite stays GREEN (pending, not failing). They
 *     do NOT fake a route or stub a detail page — that would hide the missing slice.
 *
 * Fixture: `seeded` (spec 0019) — ONE TV watchlist entry ("Breaking Bad", tmdbId 2,
 * status `planned`) + the `users/{uid}` profile (region NL). Seeded under the LIVE
 * anon uid AFTER boot (R3 — `seedFor`, not `resetAndSeed`, preserves the running
 * session).
 *
 * Determinism (spec 0019 Determinism guards): `clearAll()` in `beforeEach`;
 * per-test boot -> resolve uid -> seed -> reload -> await the seeded card; Ionic
 * transitions awaited via concrete URL/locator waits rather than slept on.
 */

/** The seeded entry's stable facts (emulator-data/seeded/docs.json). */
const SEEDED_TITLE = 'Breaking Bad';

/**
 * Boot the app, resolve the live anon uid, seed the `seeded` fixture under it,
 * reload so the watchlist subscribes to the seeded state, and wait for the
 * seeded card to render. Returns the resolved uid.
 *
 * Centralised so every test in this file shares identical, deterministic setup
 * and the seeded entry is verified to actually render (R3 — a uid mismatch would
 * silently show an empty watchlist).
 */
async function bootAndSeed(
  page: import('@playwright/test').Page,
): Promise<string> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  await seedFor(uid, 'seeded');
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // Verify the seeded entry rendered for THIS uid (guards the R3 owner-mismatch
  // failure mode — an empty list here means the seed uid != the session uid).
  const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
  await expect(card).toBeVisible();

  return uid;
}

test.beforeEach(async ({ page }) => {
  // Pre-set the onboarding completion flag so the guard (spec 0022) passes
  // through to the tabs shell instead of redirecting to /onboarding.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Clean emulator state before the app boots and creates its anon session.
  await clearAll();
});

// ---------------------------------------------------------------------------
// RUNNABLE (GREEN NOW) — watchlist-owned status change + remove.
// These are the non-fixme parts of F5 / F6 (Test plan NOTE + R1): the watchlist
// page owns this behavior today, so it is asserted directly here, no title-detail
// slice required.
// ---------------------------------------------------------------------------

test('watchlist action-sheet status change: planned -> watching (F5 runnable part)', async ({
  page,
}) => {
  await bootAndSeed(page);

  // The seeded entry is `planned`, so its card starts under the Planned section
  // (`.section-header[data-status="planned"]`); no Watching section exists yet.
  await expect(
    page.locator('.section-header[data-status="planned"]'),
  ).toBeVisible();
  await expect(
    page.locator('.section-header[data-status="watching"]'),
  ).toHaveCount(0);

  // Open the per-card status action sheet via the status chip
  // (watchlist.page.html: `.status-chip` -> openStatusSheet -> the
  // `ion-action-sheet[header="Set status"]`). For a non-`planned` card the chip
  // is rendered; the seeded card is `planned` so the chip is NOT shown — instead
  // the status sheet is reached via keyup.space / contextmenu on the card. Use
  // the contextmenu binding (`openStatusSheet`) which is available for every card.
  const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
  await card.dispatchEvent('contextmenu');

  const sheet = page.locator('ion-action-sheet[header="Set status"]');
  await expect(sheet).toBeVisible();

  // Pick "Watching" (STATUS_LABELS.watching). Action-sheet buttons render their
  // text inside `.action-sheet-button`; click the one labelled Watching.
  await sheet.locator('button', { hasText: 'Watching' }).first().click();

  // onStatusSelected -> updateStatus writes status:'watching' to the emulator;
  // the realtime stream re-groups the card under the Watching section.
  await expect(
    page.locator('.section-header[data-status="watching"]'),
  ).toBeVisible();
  const watchingCard = page
    .locator('.watchlist-card.status-watching')
    .filter({ hasText: SEEDED_TITLE });
  await expect(watchingCard).toBeVisible();
});

test('watchlist alert remove: card -> empty state (F6 runnable part)', async ({
  page,
}) => {
  await bootAndSeed(page);

  const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
  await expect(card).toBeVisible();

  // Trigger the per-card delete-confirm (watchlist.page.html: `.delete-btn`
  // -> onDeleteConfirm -> the `ion-alert.vultus-alert` "Remove title" alert).
  await card.locator('.delete-btn').click();

  const alert = page.locator('ion-alert.vultus-alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('Remove title');

  // Confirm via the destructive "Remove" button (alertButtons -> onDeleteItem
  // -> removeTitle deletes the doc from the emulator).
  await alert.locator('button', { hasText: 'Remove' }).first().click();

  // The realtime stream emits an empty list -> the watchlist empty state shows.
  const emptyState = page.locator('vultus-empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('Your watchlist is empty');
});

// ---------------------------------------------------------------------------
// RUNNABLE (GREEN) — watchlist-to-detail-correct-title (spec 0037 F4, un-skipped).
//
// The title-detail slice exists (spec 0016) and a title-cache/2 doc is seeded so
// detail resolves cache-first — no TMDB_API_KEY required, no live network call.
// ---------------------------------------------------------------------------

test.describe('title-detail F4 — watchlist-to-detail-correct-title (spec 0037)', () => {
  // F4 — watchlist -> tap title -> title-detail opens showing the seeded metadata.
  test('watchlist-to-detail-correct-title: tapping card opens the correct title', async ({
    page,
  }) => {
    await bootAndSeed(page);

    // Tap the seeded card: `navigateToDetail` -> router.navigate(['tabs',
    // 'title-detail', titleId]) where titleId === String(tmdbId) === '2'.
    const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
    await card.click();

    // The title-detail route opens for the seeded entry (tmdbId 2).
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2\?type=tv/);

    // The detail hero shows the seeded title (cache-first, no TMDB network call).
    await expect(page.locator('[data-test="hero"] .hero-title')).toHaveText(
      SEEDED_TITLE,
    );
  });

  // -------------------------------------------------------------------------
  // Spec 0053 — manually completing a TV show marks every episode watched.
  // Un-skip blocker: the Firestore emulator cannot run under Claude Code tools
  // (project memory) — this flow asserts against the live emulator stream, so it
  // must run in the user's own terminal or the CI emulator gate. Seed data is
  // already sufficient: the spec-0034 seed provides three unwatched S1 episodes
  // for tmdbId 2 (apps/mobile-e2e/emulator-data/seeded/docs.json, all
  // "watched": false); no docs.json change is required to un-skip.
  // -------------------------------------------------------------------------
  test.fixme('completed-marks-episodes-watched: setting a TV show Completed marks every episode watched', async ({
    page,
  }) => {
    await bootAndSeed(page);

    // Open the seeded TV title (tmdbId 2, Breaking Bad) detail page.
    await page.goto('/tabs/title-detail/2');
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2\?type=tv/);

    // Set the status to "Completed" via the title-detail status action sheet
    // (actionSheetButtons -> TitleDetailService.updateStatus(2, 'completed',
    // 'tv')). The completed + tv branch batch-marks every unwatched episode
    // { watched: true, watchedAt } in the emulator.
    const statusControl = page.locator('[data-test="status-control"]');
    await statusControl.click();

    const sheet = page.locator('ion-action-sheet[header="Set status"]');
    await expect(sheet).toBeVisible();
    await sheet.locator('button', { hasText: 'Completed' }).first().click();

    // The episodes$ realtime stream re-renders: every episode row shows the
    // watched state and each season count shows N/N.
    const episodesSection = page.locator('[data-test="episodes-section"]');
    await expect(episodesSection).toBeVisible();

    const toggles = episodesSection.locator(
      '[data-test="episode-watched-toggle"]',
    );
    const toggleCount = await toggles.count();
    for (let i = 0; i < toggleCount; i++) {
      await expect(toggles.nth(i)).toHaveClass(/is-watched/);
    }

    // Each season count shows N/N (all watched — e.g. "3/3").
    const seasonCounts = episodesSection.locator('[data-test="season-count"]');
    const seasonCountTotal = await seasonCounts.count();
    for (let i = 0; i < seasonCountTotal; i++) {
      await expect(seasonCounts.nth(i)).toHaveText(/^(\d+)\/\1$/);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFERRED (test.fixme — PENDING, NOT FAILING) — F5/F6 title-detail status/remove.
//
// These flows require deeper title-detail DOM knowledge for the status + remove
// controls on the detail page itself. Kept fixme until those flows are tightened.
// ---------------------------------------------------------------------------

test.describe
  .fixme('title-detail F5/F6 — status change and remove (deferred)', () => {
  // F5 — title-detail -> change status (planned -> watching) -> return to
  // Watchlist -> the card now sits under the Watching section.
  test('F5: changing status on title-detail reflects on the watchlist', async ({
    page,
  }) => {
    await bootAndSeed(page);

    const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
    await card.click();
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2\?type=tv/);

    // Change the status to "Watching" on the detail page. The exact control
    // selector depends on the (unimplemented) title-detail slice; this targets
    // its expected status control by label and will be tightened when the slice
    // lands and its DOM is known.
    const detailContent = page.locator('ion-content');
    await detailContent
      .getByRole('button', { name: /watching/i })
      .first()
      .click();

    // Return to the Watchlist tab.
    await page.locator('ion-tab-button[tab="watchlist"]').click();
    await expect(page).toHaveURL(/\/tabs\/watchlist$/);

    // The card now sits under the Watching section.
    await expect(
      page.locator('.section-header[data-status="watching"]'),
    ).toBeVisible();
    await expect(
      page
        .locator('.watchlist-card.status-watching')
        .filter({ hasText: SEEDED_TITLE }),
    ).toBeVisible();
  });

  // F6 — title-detail -> remove -> Watchlist shows the empty state.
  test('F6: removing from title-detail empties the watchlist', async ({
    page,
  }) => {
    await bootAndSeed(page);

    const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
    await card.click();
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2\?type=tv/);

    // Remove the title from the detail page. Selector targets the expected
    // remove control by label; tighten when the title-detail slice DOM lands.
    const detailContent = page.locator('ion-content');
    await detailContent
      .getByRole('button', { name: /remove/i })
      .first()
      .click();

    // Confirm the removal if the detail page raises a confirm dialog (mirrors
    // the watchlist's `ion-alert.vultus-alert` "Remove title" pattern). The
    // detail slice does not exist yet (R1); whether it confirms via a dialog is
    // unknown until it lands, so this branch is intentionally conditional and
    // will be tightened when the test is un-skipped.
    const confirmAlert = page.locator('ion-alert');
    if (await confirmAlert.isVisible()) {
      await confirmAlert
        .locator('button', { hasText: 'Remove' })
        .first()
        .click();
    }

    // Back on the Watchlist tab, the empty state shows.
    await page.locator('ion-tab-button[tab="watchlist"]').click();
    await expect(page).toHaveURL(/\/tabs\/watchlist$/);

    const emptyState = page.locator('.empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('Your watchlist is empty');
  });

  // -------------------------------------------------------------------------
  // Spec 0034 — episode watch-progress flows (test.fixme).
  // Un-skip blockers: (a) Firestore emulator must run in the user's own
  // terminal (cannot run under Claude Code tools — project memory), (b) episode
  // seed docs for Breaking Bad S1 are seeded in
  // apps/mobile-e2e/emulator-data/seeded/docs.json; a MOVIE watchlist entry
  // still needs adding for the movie flow below.
  // -------------------------------------------------------------------------
  test.fixme('episode: mark episode watched → row shows watched + season count updates', async ({
    page,
  }) => {
    await bootAndSeed(page);
    // Navigate to the TV title detail page (tmdbId 2, Breaking Bad).
    await page.goto('/tabs/title-detail/2');
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2\?type=tv/);
    // Find the Episodes section.
    const episodesSection = page.locator('[data-test="episodes-section"]');
    await expect(episodesSection).toBeVisible();
    // Mark the first episode watched.
    const firstToggle = episodesSection
      .locator('[data-test="episode-watched-toggle"]')
      .first();
    await firstToggle.click();
    // The toggle now shows the watched state and the season count updates.
    await expect(firstToggle).toHaveClass(/is-watched/);
    const seasonCount = episodesSection
      .locator('[data-test="season-count"]')
      .first();
    await expect(seasonCount).toContainText('/');
  });

  test.fixme('episode: season progress display after marking multiple episodes', async ({
    page,
  }) => {
    await bootAndSeed(page);
    await page.goto('/tabs/title-detail/2');
    const episodesSection = page.locator('[data-test="episodes-section"]');
    await expect(episodesSection).toBeVisible();
    // Mark the first two episodes watched.
    const toggles = episodesSection.locator(
      '[data-test="episode-watched-toggle"]',
    );
    await toggles.nth(0).click();
    await toggles.nth(1).click();
    // Season count should show 2/N watched.
    const seasonCount = episodesSection
      .locator('[data-test="season-count"]')
      .first();
    await expect(seasonCount).toContainText('2/');
  });

  test.fixme('movie: mark as watched → status changes to completed', async ({
    page,
  }) => {
    // Requires a MOVIE watchlist entry in the seeded fixture (a tmdbId to be
    // added to docs.json — the current fixture only has the TV entry tmdbId 2).
    await bootAndSeed(page);
    const movieWatchedBtn = page.locator('[data-test="movie-watched-btn"]');
    await expect(movieWatchedBtn).toBeVisible();
    await movieWatchedBtn.click();
    // Status should now be completed (the status control shows Completed).
    const statusControl = page.locator('[data-test="status-control"]');
    await expect(statusControl).toContainText('Completed');
  });
});
