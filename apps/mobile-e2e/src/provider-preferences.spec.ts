import { test, expect } from '@playwright/test';
import {
  clearAll,
  encodeFields,
  resolveAnonUid,
  seedFor,
  writeDocument,
} from './support';

/**
 * Spec 0060 (provider preferences) — REQUIRED e2e flow, T9.
 *
 * "shows on-your-provider vs also-on framing": on the Watchlist, a title whose
 * FLATRATE availability includes a provider the user subscribes to
 * (`users/{uid}.myProviderIds`) shows the highlighted **"On {provider}"** pill;
 * a title whose flatrate availability is only on a NON-selected provider shows
 * the muted **"Also on {provider}"** pill (spec 0060 UI section B; the pill
 * markup lives in `libs/mobile/watchlist/src/lib/watchlist.page.html`).
 *
 * Emulator-backed, `seeded` fixture (spec 0019 conventions — `clearAll()` in
 * `beforeEach`, boot → `resolveAnonUid` → `seedFor` under the LIVE anon uid (R3)
 * → reload so the watchlist stream re-reads the seeded state). No TMDB route is
 * needed: the watchlist availability pill reads purely from seeded Firestore —
 * `users/{uid}.myProviderIds` + each title's `title-cache/{tmdbId}/availability/NL`
 * doc — and never calls TMDB or the `getWatchProviders` callable for these two
 * assertions (the catalog callable is a Settings-only read path).
 *
 * SEED SHAPE (see `emulator-data/seeded/docs.json`, spec 0060 additions):
 *   - `users/{uid}.myProviderIds = [8]` (Netflix selected).
 *   - `title-cache/2/availability/NL` — FLATRATE Netflix (id 8, SELECTED) →
 *     Breaking Bad (the fixture's default watchlist card) shows "On Netflix".
 *   - `title-cache/3/availability/NL` — FLATRATE Hulu (id 15, NOT selected) →
 *     "Also on Hulu" once The Bear is a card.
 *   - `provider-catalog/NL` — the region catalog (Netflix/Hulu/Disney+/Prime).
 *
 * The shared fixture deliberately does NOT seed a `users/{uid}/watchlist/3`
 * entry (that would make The Bear a second card and break the count-1 /
 * remove-to-empty assertions in `watchlist-refresh.spec.ts` and
 * `title-detail.spec.ts`, which run against the SAME `seeded` fixture). Instead
 * this flow writes that watchlist entry itself, under the resolved uid, AFTER
 * seeding — so the second ("elsewhere") card exists only for this test.
 *
 * Selectors grounded in `libs/mobile/watchlist/src/lib/watchlist.page.html`:
 *   - card:  `.watchlist-card` (contains `.card-title`).
 *   - pill:  `.availability-pill` (the `mine` variant adds `.is-mine`).
 */

const MINE_TITLE = 'Breaking Bad'; // tmdbId 2, flatrate Netflix (id 8, selected)
const ELSEWHERE_TITLE = 'The Bear'; // tmdbId 3, flatrate Hulu (id 15, not selected)

test.beforeEach(async ({ page }) => {
  // Pass the onboarding guard (spec 0022) so we land on the tabs shell.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Deterministic reset before the app boots its anon session (spec 0019).
  await clearAll();
});

test('shows on-your-provider vs also-on framing', async ({ page }) => {
  // Boot; the app signs in anonymously against the Auth emulator.
  await page.goto('/');

  // Resolve the LIVE anon uid so the seeded docs line up with the session (R3).
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // Seed the shared fixture (myProviderIds [8], availability for tmdbId 2 & 3,
  // the provider-catalog) under that uid.
  await seedFor(uid, 'seeded');

  // Add the "elsewhere" watchlist card (The Bear, tmdbId 3) for THIS test only,
  // so it doesn't leak into the sibling specs that share the `seeded` fixture.
  // Its availability doc (flatrate Hulu, id 15) is already seeded above.
  await writeDocument(
    `users/${uid}/watchlist/3`,
    encodeFields({
      type: 'tv',
      tmdbId: 3,
      traktId: null,
      title: ELSEWHERE_TITLE,
      addedAt: { __timestamp: '2026-06-24T10:05:00.000Z' },
      status: 'planned',
      posterPath: '/the-bear-poster.jpg',
      voteAverage: 8.6,
    }),
  );

  // Reload so the watchlist stream picks up the freshly-seeded docs.
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // Both seeded cards render (guards the R3 owner-mismatch empty-list trap).
  const mineCard = page.locator('.watchlist-card', { hasText: MINE_TITLE });
  const elsewhereCard = page.locator('.watchlist-card', {
    hasText: ELSEWHERE_TITLE,
  });
  await expect(mineCard).toBeVisible();
  await expect(elsewhereCard).toBeVisible();

  // (a) The title covered by a SELECTED provider (Netflix, id 8 ∈ myProviderIds)
  //     shows the highlighted "On {provider}" pill: `.availability-pill.is-mine`
  //     with the exact copy "On Netflix".
  const minePill = mineCard.locator('.availability-pill');
  await expect(minePill).toBeVisible();
  await expect(minePill).toHaveClass(/\bis-mine\b/);
  await expect(minePill).toHaveText(/^On Netflix$/);
  // The mine pill carries the primary checkmark icon (spec 0060 UI section B).
  await expect(
    minePill.locator('ion-icon[name="checkmark-circle"]'),
  ).toBeVisible();

  // (b) The title on a NON-selected provider (Hulu, id 15 ∉ myProviderIds) shows
  //     the muted "Also on {provider}" pill: `.availability-pill` WITHOUT
  //     `.is-mine`, copy "Also on Hulu", and NO checkmark icon.
  const elsewherePill = elsewhereCard.locator('.availability-pill');
  await expect(elsewherePill).toBeVisible();
  await expect(elsewherePill).not.toHaveClass(/\bis-mine\b/);
  await expect(elsewherePill).toHaveText(/^Also on Hulu$/);
  await expect(
    elsewherePill.locator('ion-icon[name="checkmark-circle"]'),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// DEFERRED (test.fixme — PENDING, NOT FAILING): the Settings toggle round-trip.
//
// The optional "toggle a provider chip in Settings and watch the watchlist pill
// flip" assertion is gated fixme: toggling a chip calls getWatchProviders, which
// requires the callable itself to be deployed into the emulator's Functions
// runtime, which the other e2e specs in this suite don't currently exercise.
// (`manual-sync-trigger.spec.ts` documents the same Functions-emulator gap for
// the `triggerSync` callable.) The two watchlist-pill assertions above are the
// REQUIRED gate and run without the Functions runtime; this round-trip stays
// fixme rather than adding new emulator-functions plumbing as a side quest of
// spec 0060. Un-skip once the Functions emulator (with getWatchProviders
// deployed) is part of the e2e harness run.
// ---------------------------------------------------------------------------
test.fixme('toggling a provider chip in Settings flips the watchlist pill', async ({
  page,
}) => {
  // Blocker: toggling a chip calls getWatchProviders, which requires the
  // callable itself to be deployed into the emulator's Functions runtime, which
  // the other e2e specs in this suite don't currently exercise.
  await page.goto('/');
  const uid = await resolveAnonUid(page);
  await seedFor(uid, 'seeded');
  await page.reload();

  // Go to Settings, open "My Providers", and DESELECT Netflix (id 8). Once the
  // toggle's getWatchProviders round-trip resolves against a real Functions
  // emulator, the persisted myProviderIds drops 8, and the Breaking Bad pill
  // flips from the "On Netflix" (mine) variant to the muted "Also on Netflix"
  // (elsewhere) variant. This is authored fully but fixme-gated per the blocker.
  await page.locator('ion-tab-button[tab="settings"]').click();
  await page.waitForURL(/\/tabs\/settings$/);

  // #166: the "My Providers" grid is collapsed by default — expand it before the chip is in the DOM.
  await page.locator('button.settings-row--header').click();

  const netflixChip = page
    .locator('.provider-chip')
    .filter({ hasText: 'Netflix' });
  await expect(netflixChip).toBeVisible();
  await netflixChip.click();

  await page.locator('ion-tab-button[tab="watchlist"]').click();
  await page.waitForURL(/\/tabs\/watchlist$/);

  const mineCard = page.locator('.watchlist-card', { hasText: MINE_TITLE });
  const pill = mineCard.locator('.availability-pill');
  await expect(pill).not.toHaveClass(/\bis-mine\b/);
  await expect(pill).toHaveText(/^Also on Netflix$/);
});
