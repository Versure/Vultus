import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  clearAll,
  encodeFields,
  readDocument,
  resolveAnonUid,
  routeTmdbMovie,
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
// itself persists it (and sets the in-memory `linked()` signal). It also asserts
// the spec-0085 background-sync controls render in the connected block with their
// DEFAULT values ("Sync in background" toggle ON, "Sync frequency" = "Every hour")
// — control-render only; the native background service is a no-op off-device.
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

  // Background-sync controls (spec 0085) also render inside the connected block.
  // On e2e (non-native) `PlexBackgroundService` is a native-guarded no-op, but
  // the UI + DEFAULT signal values still render: `init()` returns before loading
  // Preferences off-native, so `enabled()` stays ON and `intervalMinutes()` stays
  // 60. Scope to `.plex-connected__background` so these don't collide with the
  // sibling Notifications toggle / delivery-hour select elsewhere on the page.
  const backgroundControls = connectedBlock.locator(
    '.plex-connected__background',
  );
  await expect(backgroundControls).toBeVisible();

  // (A) The "Sync in background" toggle renders with the EXACT label (reflects
  //     the default `enabled()` = ON on serve-mock/e2e).
  await expect(backgroundControls.locator('.settings-row__toggle')).toHaveText(
    'Sync in background',
  );

  // (B) The "Sync frequency" interval select renders showing the default
  //     "Every hour" (interval 60) — Ionic renders the selected display value
  //     into the scoped `.select-text` element.
  const intervalSelect = backgroundControls.locator(
    'ion-select.settings-row__select[label="Sync frequency"]',
  );
  await expect(intervalSelect).toBeVisible();
  await expect(intervalSelect.locator('.select-text')).toHaveText('Every hour');

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
// Spec 0098 extension — on-device episode-doc creation: the UNTRACKED mock tv
// show (Breaking Bad, 1396, with a watched S1E1 and unwatched S1E2 in the mock
// Plex library) has NO episode docs before the sync. In the SAME sync pass
// PlexSyncService fetches TMDB (routed below: /tv/1396 season count +
// /tv/1396/season/1 episode list), creates the missing docs insert-only, then
// mirrors the Plex watch state — so `s01e001` lands `watched: true`, `s01e002`
// `watched: false`, and the show reaches `watching` (watch-implies-add) on the
// FIRST sync, with the title-detail episodes rendering "1/2 watched".
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

  // TMDB interception (spec 0086): the sync now fetches movie detail to populate
  // posterPath/voteAverage, so intercept both movie ids to their fixtures BEFORE
  // the app boots — the plain `development` config used by e2e has no fetch mock,
  // so unrouted calls would hit the real network and fail (poster stays null).
  await routeTmdbMovie(page, 550, 'tmdb-movie-detail-550.json');
  await routeTmdbMovie(page, 335984, 'tmdb-movie-detail-335984.json');

  // TV route fixtures for Breaking Bad (1396) — spec 0098. The on-device episode
  // creation (PlexSyncService.ensureEpisodeDocs) now fetches TMDB during the sync:
  //   - GET /tv/1396          → number_of_seasons (season count)
  //   - GET /tv/1396/season/1 → the season's episode list
  // The `development` config e2e uses has NO fetch mock, so both must be routed
  // BEFORE boot or the calls hit the real network and no episode docs are created.
  // Register the DETAIL route first and the SEASON route LAST: Playwright gives
  // later-registered routes priority, and the broad `**/tv/1396**` detail glob
  // also matches the season URL — registering season last makes it win for
  // `/tv/1396/season/**` while detail still serves `/tv/1396` (+ watch/providers).
  const tvDetailFixture = JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'tmdb-tv-detail-1396.json'),
      'utf-8',
    ),
  ) as Record<string, unknown>;
  const tvSeasonFixture = JSON.parse(
    readFileSync(
      join(__dirname, '..', 'fixtures', 'tmdb-tv-season-1396-s1.json'),
      'utf-8',
    ),
  ) as Record<string, unknown>;
  await page.route('**/tv/1396**', (route) =>
    route.fulfill({ json: tvDetailFixture }),
  );
  await page.route('**/tv/1396/season/**', (route) =>
    route.fulfill({ json: tvSeasonFixture }),
  );

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

  // ---- Assert the TV episode outcomes (spec 0098) ----
  //
  // Breaking Bad (1396) is UNTRACKED before the sync and its watched Plex episode
  // (S1E1) has no local episode doc. So PlexSyncService fetches TMDB on-device
  // (/tv/1396 → number_of_seasons; /tv/1396/season/1 → the episode list, both
  // routed above), creates the MISSING docs insert-only (`watched: false`), then
  // the existing mirror flips S1E1 to `watched: true` in the SAME pass. The show
  // reaches `watching` via the watch-implies-add mapping (untracked + a watched
  // episode → added as `watching`), NOT a count-driven `deriveStatus`.

  // (c) s01e001 created on-device AND mirrored to `watched: true`. Assert on the
  //     emulator (deterministic). Episode doc id is `s{SS}e{EEE}` (2-digit
  //     season, 3-digit episode) — the id scheme replicated from the functions.
  await expect
    .poll(
      async () => {
        const doc = await readDocument(
          `users/${uid}/watchlist/1396/episodes/s01e001`,
        );
        if (doc === null) return 'missing';
        return (doc.watched as { booleanValue?: boolean } | undefined)
          ?.booleanValue;
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // (d) s01e002 created insert-only and left UNWATCHED (the Plex S1E2 has
  //     viewCount 0). It must EXIST (created) with `watched: false` — not merely
  //     be absent — so distinguish "missing" from "created unwatched".
  await expect
    .poll(
      async () => {
        const doc = await readDocument(
          `users/${uid}/watchlist/1396/episodes/s01e002`,
        );
        if (doc === null) return 'missing';
        return (doc.watched as { booleanValue?: boolean } | undefined)
          ?.booleanValue;
      },
      { timeout: 30_000 },
    )
    .toBe(false);

  // (e) The show reached `watching` (watch-implies-add, not count-driven).
  await expect
    .poll(
      async () => {
        const doc = await readDocument(`users/${uid}/watchlist/1396`);
        return (doc?.status as { stringValue?: string } | undefined)
          ?.stringValue;
      },
      { timeout: 30_000 },
    )
    .toBe('watching');

  // The Breaking Bad watchlist card renders as a `watching` card (we are still on
  // the Watchlist tab from the movie assertions; the default All filter shows it).
  const breakingBadCard = page.locator('.watchlist-card', {
    hasText: 'Breaking Bad',
  });
  await expect(breakingBadCard).toBeVisible();
  await expect(breakingBadCard).toHaveClass(/\bstatus-watching\b/);

  // Navigate to the title-detail page for 1396 (the card click routes there).
  await breakingBadCard.click();
  await expect(page).toHaveURL(/\/tabs\/title-detail\/1396/);

  // The episodes section renders (tv detail loaded via the routed /tv/1396
  // fixture; the episodes$ stream reads the two on-device-created docs).
  await expect(page.locator('[data-test="episodes-section"]')).toBeVisible();

  // The Season 1 header shows the EXACT per-season count string (NO
  // whitespace-normalization): 1 of 2 episodes watched. Same copy the component
  // contract asserts, keeping unit + e2e consistent on the string.
  await expect(page.locator('[data-test="season-count"]')).toHaveText(
    '1/2 watched',
  );

  // Per-episode watched state via the STABLE `[data-test="episode-watched-toggle"]`
  // hook (consistent with the suite's data-test convention), NOT the
  // `.watched-toggle` / `[class.is-watched]` class. The toggle's `aria-label`
  // encodes the current watched state: a WATCHED episode's toggle offers the
  // "unwatched" action ("Mark episode N unwatched"), an UNWATCHED one offers
  // "watched" ("Mark episode N watched"). So S1E1 (watched) → "…1 unwatched" and
  // S1E2 (unwatched) → "…2 watched".
  await expect(
    page.locator('[data-test="episode-watched-toggle"]'),
  ).toHaveCount(2);
  await expect(
    page.locator(
      '[data-test="episode-watched-toggle"][aria-label="Mark episode 1 unwatched"]',
    ),
  ).toBeVisible();
  await expect(
    page.locator(
      '[data-test="episode-watched-toggle"][aria-label="Mark episode 2 watched"]',
    ),
  ).toBeVisible();
});
