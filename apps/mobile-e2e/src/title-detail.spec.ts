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
  const emptyState = page.locator('.empty-state');
  await expect(emptyState).toBeVisible();
  await expect(emptyState).toContainText('Your watchlist is empty');
});

// ---------------------------------------------------------------------------
// DEFERRED (test.fixme — PENDING, NOT FAILING) — title-detail-ORIGINATED flows.
//
// TODO(spec 0016 / PLAN §6 item 19): un-skip when the title-detail slice +
// tabs/title-detail/:titleId route land.
//
// R1: `libs/mobile/title-detail/` is empty, there is no `tabs/title-detail/:titleId`
// route, and the watchlist card's `navigateToDetail` catches + no-ops without it.
// These flows are authored fully against the EXPECTED title-detail DOM/behavior;
// `test.fixme` keeps the suite green until the slice lands. Do NOT fake a route or
// stub a detail page to make them pass — that would hide the missing slice.
// ---------------------------------------------------------------------------

test.describe
  .fixme('title-detail-originated flows (pending spec 0016 / PLAN §6 item 19 — R1)', () => {
  // F4 — watchlist -> tap title -> title-detail opens showing the seeded metadata.
  test('F4: tapping the watchlist card opens the title-detail page', async ({
    page,
  }) => {
    await bootAndSeed(page);

    // Tap the seeded card: `navigateToDetail` -> router.navigate(['tabs',
    // 'title-detail', titleId]) where titleId === String(tmdbId) === '2'.
    const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
    await card.click();

    // The title-detail route opens for the seeded entry (tmdbId 2).
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2$/);

    // The detail page shows the seeded entry's metadata (title at minimum).
    await expect(page.locator('ion-content')).toContainText(SEEDED_TITLE);
  });

  // F5 — title-detail -> change status (planned -> watching) -> return to
  // Watchlist -> the card now sits under the Watching section.
  test('F5: changing status on title-detail reflects on the watchlist', async ({
    page,
  }) => {
    await bootAndSeed(page);

    const card = page.locator('.watchlist-card', { hasText: SEEDED_TITLE });
    await card.click();
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2$/);

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
    await expect(page).toHaveURL(/\/tabs\/title-detail\/2$/);

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
});
