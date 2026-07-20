import { test, expect } from '@playwright/test';
import {
  clearAll,
  encodeFields,
  readDocument,
  resolveAnonUid,
  seedFor,
  writeDocument,
} from './support';

/**
 * Spec 0073 (One-way Plex → Vultus sync) — REQUIRED e2e flows, T5.
 *
 * Two DoD-gate flows (spec §"Test plan" → "e2e (rubric)"), both driven by the
 * MOCK PlexClient. e2e runs in a non-native browser, so the shell's `PLEX_CLIENT`
 * factory (app.config.ts, T4) selects `MockPlexClient` — no real PMS / plex.tv
 * call ever fires. All Firebase state is the emulator; all Plex fixture data is
 * `libs/mobile/settings/src/lib/plex.client.mock.ts`.
 *
 * MOCK FIXTURE (verified against plex.client.mock.ts):
 *   - requestPin() → code "H7X2", authToken null.
 *   - checkPin() → auto-authorizes, authToken "mock-plex-token" (no human wait).
 *   - discoverServer() → { name: "Vultus Media Server",
 *                          baseUrl: "http://192.168.1.20:32400" }.
 *   - listLibrary() → Fight Club (tmdbId 550, movie, viewCount 1 = WATCHED),
 *                     Blade Runner 2049 (tmdbId 335984, movie, viewCount 0 =
 *                     UNWATCHED), Breaking Bad (tmdbId 1396, tv, ratingKey
 *                     "show-1", 1 watched episode), and a GUID-less item
 *                     (tmdbId null → SKIPPED). Fixture `addedAt`s are minutes ago.
 *
 * Spec 0019 conventions: `beforeEach` sets `CapacitorStorage.onboarding_done`
 * via `page.addInitScript` (before boot) + `clearAll()`; each test boots
 * `page.goto('/')`, resolves the LIVE anon uid via `resolveAnonUid`, seeds under
 * THAT uid, and reloads so the app reads the seeded state (R3).
 *
 * The shared `emulator-data/seeded/docs.json` is INTENTIONALLY NOT modified — it
 * is consumed by 4 other specs whose card-count assertions would break if a new
 * watchlist item were added. The sync-outcome pre-linked state is written with
 * per-test `writeDocument` calls (the pattern provider-preferences.spec.ts uses).
 *
 * Selectors are grounded in the committed templates:
 *   - Settings Plex card (settings.page.html): `.plex-connect-row` (disconnected)
 *     / `.plex-connected` block (connected) with `.plex-connected__name`,
 *     `.plex-connected__status-label` ("Connected"), `.plex-text-button--primary`
 *     ("Sync now"). The card is gated on the ROOT `plexLink.linked()` signal.
 *   - Connect page (plex-connect.page.html): `[data-test="stage-connected"]`,
 *     `[data-test="server-row"]`.
 *   - Watchlist card (watchlist.page.html): `.watchlist-card` (+ `.status-{s}`),
 *     `.plex-badge` (with `img[alt="Plex"]`).
 */

test.beforeEach(async ({ page }) => {
  // Pass the onboarding guard (spec 0022) so we land on the tabs shell.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Deterministic reset before the app boots its anon session (spec 0019).
  await clearAll();
});

// ---------------------------------------------------------------------------
// Flow 1 — "connect flow"
//
// From Settings, the disconnected Plex card → tap → Connect page → the mocked
// PIN auto-authorizes → the connected stage → "Done" → back on Settings the card
// shows the connected block (server name + "Connected"); `users/{uid}.hasPlex`
// is set true by the link flow. No `plex_token` is pre-seeded: the link flow
// itself persists it (and sets the in-memory `linked()` signal).
// ---------------------------------------------------------------------------
test('connect flow', async ({ page }) => {
  // Boot; the app signs in anonymously against the Auth emulator.
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // Resolve the LIVE anon uid so the seeded docs line up with the session (R3).
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // The link flow writes via `updateDoc` (hasPlex + plexSync), which requires an
  // EXISTING `users/{uid}` doc — seed the `seeded` fixture so the doc exists,
  // then reload so the app reads it.
  await seedFor(uid, 'seeded');
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // Go to the Settings tab. The page is render-gated on `service.loaded()` (a
  // one-shot users/{uid} read), so wait for the region select before asserting.
  await page.locator('ion-tab-button[tab="settings"]').click();
  await page.waitForURL(/\/tabs\/settings$/);
  await expect(
    page.locator('ion-select.settings-row__select[label="Region"]'),
  ).toBeVisible();

  // The disconnected Plex row renders the EXACT copy (no token → not linked).
  const connectRow = page.locator('.plex-connect-row');
  await expect(connectRow).toBeVisible();
  await expect(connectRow.locator('.plex-connect-row__title')).toHaveText(
    'Connect Plex Server',
  );
  await expect(connectRow.locator('.plex-connect-row__caption')).toHaveText(
    'Sync library additions and watch history',
  );

  // Tap the connect row → the Connect Plex sub-page.
  await connectRow.click();
  await expect(page).toHaveURL(/\/tabs\/settings\/plex$/);

  // The mock PIN auto-authorizes on the first poll: the page reaches the
  // connected stage with the discovered server name.
  const connectedStage = page.locator('[data-test="stage-connected"]');
  await expect(connectedStage).toBeVisible();
  const serverRow = connectedStage.locator('[data-test="server-row"]');
  await expect(serverRow).toBeVisible();
  await expect(serverRow.locator('.server-row__name')).toHaveText(
    'Vultus Media Server',
  );

  // "Done" → pop back to Settings; the card now shows the connected block
  // (driven reactively by the ROOT `plexLink.linked()` signal set on link).
  await connectedStage.locator('button.solid-button').click();
  await expect(page).toHaveURL(/\/tabs\/settings$/);

  const connectedBlock = page.locator('.plex-connected');
  await expect(connectedBlock).toBeVisible();
  await expect(connectedBlock.locator('.plex-connected__name')).toHaveText(
    'Vultus Media Server',
  );
  await expect(
    connectedBlock.locator('.plex-connected__status-label'),
  ).toHaveText('Connected');

  // The connect flow wrote `users/{uid}.hasPlex = true` — assert it directly on
  // the emulator (robust against UI timing).
  const userDoc = await readDocument(`users/${uid}`);
  expect(userDoc).not.toBeNull();
  expect(userDoc?.hasPlex).toEqual({ booleanValue: true });
});

// ---------------------------------------------------------------------------
// Flow 2 — "sync outcome"
//
// After a mocked link + sync, a mock-library title appears on the watchlist as
// `planned` with the 0061 Plex badge (Blade Runner 2049, 335984 — an unwatched
// library addition), AND a watched mock movie already on the watchlist flips to
// `completed` (Fight Club, 550 — pre-seeded `planned`, mock viewCount 1).
//
// PRE-LINKED SEED (per-test writeDocument, NOT the shared fixture):
//   - `plex_token` in on-device storage (localStorage `CapacitorStorage.*`) so
//     `isLinked()` → true (connected block renders) AND `sync()` runs (it no-ops
//     without a token).
//   - `users/{uid}` a complete user doc (seeded-fixture shape) + `hasPlex: true`
//     + `plexSync` with an OLD `linkedAt` (2020) and `lastSyncAt: null`.
//   - `users/{uid}/watchlist/550` a pre-existing Fight Club `planned` movie.
//
// WHY the old `linkedAt`: the additions cursor = `plexSync.lastSyncAt ??
// linkedAt`. With `lastSyncAt` null the cursor is `linkedAt` (2020) — OLDER than
// the fixture's minutes-ago `addedAt`s, so Blade Runner (unwatched) is admitted
// as a `planned` library addition. A fresh/now cursor would SKIP it. This is the
// crux of the flow. `plexSync` fields are plain ISO STRINGS on the wire (the
// converter passes the nested object through — NOT Firestore Timestamps).
// ---------------------------------------------------------------------------
test('sync outcome', async ({ page }) => {
  // Seed the on-device Plex token BEFORE boot so `isLinked()` sees it (the
  // connected block renders) and `sync()` runs. @capacitor/preferences persists
  // web values under the `CapacitorStorage.` localStorage prefix.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.plex_token', 'mock-plex-token');
  });

  // Boot; the app signs in anonymously against the Auth emulator.
  await page.goto('/');
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // Resolve the LIVE anon uid so the seeded docs line up with the session (R3).
  const uid = await resolveAnonUid(page);
  expect(uid).toBeTruthy();

  // Seed the pre-linked user doc: the `seeded` fixture's user shape + hasPlex
  // true + a `plexSync` with an OLD linkedAt cursor (see WHY above). The plexSync
  // object is a plain nested map of ISO strings (no __timestamp marker — the
  // converter does NOT map these to Firestore Timestamps).
  await writeDocument(
    `users/${uid}`,
    encodeFields({
      region: 'NL',
      notificationPrefs: {
        episodeAired: true,
        movieAvailable: true,
        cameToPlatform: true,
      },
      fcmTokens: [],
      myProviderIds: [8],
      hasPlex: true,
      plexSync: {
        linkedAt: '2020-01-01T00:00:00.000Z',
        lastSyncAt: null,
        serverName: 'Vultus Media Server',
      },
    }),
  );

  // Seed the pre-existing Fight Club (550) watchlist item as `planned`. `addedAt`
  // IS a Firestore Timestamp on the wire (use the __timestamp marker, matching
  // the seeded watchlist items).
  await writeDocument(
    `users/${uid}/watchlist/550`,
    encodeFields({
      type: 'movie',
      tmdbId: 550,
      traktId: null,
      title: 'Fight Club',
      addedAt: { __timestamp: '2026-06-24T10:00:00.000Z' },
      status: 'planned',
      posterPath: null,
      voteAverage: null,
      watchingViaPlex: false,
    }),
  );

  // Reload so the app reads the seeded pre-linked state.
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);

  // Go to Settings; the connected block renders (token present). Wait for the
  // page to load (region select) then for the connected block.
  await page.locator('ion-tab-button[tab="settings"]').click();
  await page.waitForURL(/\/tabs\/settings$/);
  await expect(
    page.locator('ion-select.settings-row__select[label="Region"]'),
  ).toBeVisible();

  const connectedBlock = page.locator('.plex-connected');
  await expect(connectedBlock).toBeVisible();

  // "Sync now" — the button disables while `running()` then re-enables when the
  // sync completes.
  const syncButton = connectedBlock.locator('.plex-text-button--primary');
  await expect(syncButton).toBeEnabled();
  await syncButton.click();
  // The sync finished when the button re-enables (running() back to false).
  await expect(syncButton).toBeEnabled({ timeout: 30_000 });

  // ---- Assert the sync outcomes ----

  // (a) Flipped to `completed`: the pre-existing Fight Club (550) now has
  //     `status: 'completed'`. Assert this DIRECTLY on the emulator (robust
  //     against watchlist status-grouping/filtering).
  await expect
    .poll(
      async () => {
        const doc = await readDocument(`users/${uid}/watchlist/550`);
        return (doc?.status as { stringValue?: string } | undefined)
          ?.stringValue;
      },
      { timeout: 30_000 },
    )
    .toBe('completed');

  // (b) Added `planned`: Blade Runner 2049 (335984) was added by the sync as a
  //     `planned` library addition with `watchingViaPlex: true`. Confirm the
  //     write on the emulator first (deterministic), then the watchlist UI.
  await expect
    .poll(
      async () => {
        const doc = await readDocument(`users/${uid}/watchlist/335984`);
        return (doc?.status as { stringValue?: string } | undefined)
          ?.stringValue;
      },
      { timeout: 30_000 },
    )
    .toBe('planned');

  // Navigate to the Watchlist tab and assert the Blade Runner card + Plex badge.
  await page.locator('ion-tab-button[tab="watchlist"]').click();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // The default status filter is `null` (= All), so every group renders — no
  // filter click is needed to see the `planned` Blade Runner card.
  const bladeRunnerCard = page.locator('.watchlist-card', {
    hasText: 'Blade Runner 2049',
  });
  await expect(bladeRunnerCard).toBeVisible();
  await expect(bladeRunnerCard).toHaveClass(/\bstatus-planned\b/);

  // The added card carries the 0061 read-only Plex badge (watchingViaPlex true).
  const badge = bladeRunnerCard.locator('.plex-badge');
  await expect(badge).toBeVisible();
  await expect(badge.locator('img[alt="Plex"]')).toBeVisible();

  // New-add poster path (spec 0086): the sync fetched TMDB detail for Blade Runner
  // 2049 (335984) and denormalized a real `posterPath`, so the card renders a real
  // poster <img> (src → the TMDB image CDN) and NOT the `.poster-fallback`.
  await expect(bladeRunnerCard.locator('.poster img')).toBeVisible();
  await expect(bladeRunnerCard.locator('.poster img')).toHaveAttribute(
    'src',
    /image\.tmdb\.org\/.+\/\S+/,
  );
  await expect(bladeRunnerCard.locator('.poster-fallback')).toHaveCount(0);

  // And the flipped Fight Club renders as a `completed` card (UI mirror of the
  // read-back above).
  const fightClubCard = page.locator('.watchlist-card', {
    hasText: 'Fight Club',
  });
  await expect(fightClubCard).toBeVisible();
  await expect(fightClubCard).toHaveClass(/\bstatus-completed\b/);

  // Backfill poster path (spec 0086, the bulk of issue #229): Fight Club (550) was
  // pre-seeded as a tracked item with `posterPath: null` (the real-world bug). The
  // sync's self-heal backfill fetched TMDB detail and updated `posterPath`, so the
  // card now renders a real poster <img> and NOT the `.poster-fallback`.
  await expect(fightClubCard.locator('.poster img')).toBeVisible();
  await expect(fightClubCard.locator('.poster img')).toHaveAttribute(
    'src',
    /image\.tmdb\.org\/.+\/\S+/,
  );
  await expect(fightClubCard.locator('.poster-fallback')).toHaveCount(0);
});
