import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  resolveAnonUid,
  seedFor,
  clearAll,
  writeDocument,
  encodeFields,
} from './support';

/**
 * Spec 0087 (D2) — the Watchlist "Sort & Filter" bottom sheet opens fully
 * visible and closes. Follow-up to spec 0082 / GitHub issue #230.
 *
 * REGRESSION GUARD: issue #230 reported the sheet rendering "almost entirely
 * off-screen" — a nested `.filter-sheet.open .filter-sheet-panel` override did
 * not win the cascade in-browser, so the panel stayed parked at its closed
 * `translateY(100%)` offset and was clipped by 0082's `.filter-sheet
 * { overflow: hidden; }`. Crucially the clipped panel was still DOM-present and
 * `visibility: visible` (inherited from the open sheet), so a Playwright
 * `toBeVisible()`-ONLY assertion would NOT have caught it — Playwright's
 * "visible" does not require the element to lie inside the viewport. Hence the
 * mandatory `boundingBox()` viewport-containment check below: it fails when the
 * panel is pushed off-screen by a stuck transform. This is the exact defect the
 * D1 fix (bind `open` on the panel/backdrop themselves) restores.
 *
 * Determinism (spec 0019 guards): `clearAll()` in beforeEach; per test
 * goto('/') → resolveAnonUid → seedFor(uid,'seeded') → reload so a NON-EMPTY
 * watchlist renders (the sheet's Sort By / Provider content needs real data),
 * then tab to Watchlist via `ion-tab-button[tab="watchlist"]`. No fixed sleeps —
 * every wait is on a real locator/condition (Playwright auto-waits).
 *
 * Runs against the Firestore emulator IN CI (not in-session — the emulator
 * cannot run under Claude Code tools here; project memory "Emulator tooling
 * limitation"). It is deliberately NOT `test.fixme`'d / skipped.
 *
 * Selectors grounded in `libs/mobile/watchlist/src/lib/watchlist.page.html`:
 *   - trigger:  `.filter-trigger[aria-label="Sort and filter"]` (L105-112) —
 *     located by role+name, NOT by icon name / CSS class (watchlist.page.spec
 *     L257-266 convention).
 *   - panel:    `.filter-sheet-panel` (L243-249, role="dialog").
 *   - headings: `.filter-section-heading` — "Sort By" (L265) and "Provider"
 *     (L314).
 *   - sort chip: first `.filter-chip` in the Sort By section ("Date Added").
 *   - Done:     `.filter-sheet-done` (L253-259).
 */

/** Title of the single seeded TV watchlist entry (emulator-data/seeded). */
const SEEDED_TITLE = 'Breaking Bad';

/**
 * Tolerance (px) for the viewport-containment check. Guards sub-pixel layout
 * rounding / safe-area insets while staying FAR tighter than the ~276px
 * off-screen offset the #230 regression produced — so the check still fails
 * hard on a clipped/off-screen panel (Risk: "too-tight pixel assertion could
 * flake"; "too-loose would not catch the regression" — this threads both).
 */
const VIEWPORT_TOLERANCE = 2;

test.beforeEach(async ({ page }) => {
  // Pre-set the onboarding completion flag so the guard (spec 0022) passes
  // through to the tabs shell instead of redirecting to /onboarding.
  await page.addInitScript(() => {
    localStorage.setItem('CapacitorStorage.onboarding_done', 'true');
  });
  // Clean slate between tests (clear Auth + Firestore via emulator REST).
  await clearAll();
});

/**
 * Boot the app, resolve the live anon uid, seed the `seeded` fixture under THAT
 * uid (R3 — avoids the owner-mismatch empty-list trap), reload so the watchlist
 * renders the seeded card, then navigate to the Watchlist tab.
 */
async function bootSeededWatchlist(page: Page): Promise<void> {
  await page.goto('/');
  // Anon sign-in must settle so we seed under the uid the app actually uses.
  const uid = await resolveAnonUid(page);
  await seedFor(uid, 'seeded');
  // Reload so the freshly-seeded docs are picked up by the watchlist stream.
  await page.reload();

  // Land on the default Today tab (spec 0083), switch to the Watchlist tab, and
  // confirm the seeded card rendered before opening the sheet.
  await expect(page).toHaveURL(/\/tabs\/today$/);
  await page.locator('ion-tab-button[tab="watchlist"]').click();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);
  await expect(page.locator('.watchlist-card')).toHaveCount(1);
  await expect(page.locator('.watchlist-card')).toContainText(SEEDED_TITLE);
}

/**
 * Assert `locator` is visible AND its bounding box lies within the page
 * viewport — the check that catches #230, where the panel was `visible` per
 * Playwright (DOM-present, not `visibility: hidden`) yet positioned off-screen
 * by a stuck `translateY`. A clipped/off-screen box has `y` (or `x`) pushed past
 * the viewport edge and fails here.
 */
async function expectVisibleWithinViewport(
  page: Page,
  locator: Locator,
  label: string,
): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible();

  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${label}: no bounding box (element not rendered/visible)`);
  }
  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error('viewport size unavailable — cannot assert containment');
  }

  const t = VIEWPORT_TOLERANCE;
  expect(box.x, `${label} left edge within viewport`).toBeGreaterThanOrEqual(
    -t,
  );
  expect(box.y, `${label} top edge within viewport`).toBeGreaterThanOrEqual(-t);
  expect(
    box.x + box.width,
    `${label} right edge within viewport`,
  ).toBeLessThanOrEqual(viewport.width + t);
  expect(
    box.y + box.height,
    `${label} bottom edge within viewport (would fail for a panel stuck off-screen below)`,
  ).toBeLessThanOrEqual(viewport.height + t);
}

test('watchlist filter sheet opens visible and closes', async ({ page }) => {
  await bootSeededWatchlist(page);

  const panel = page.locator('.filter-sheet-panel');
  const backdrop = page.locator('.filter-sheet-backdrop');
  // Closed by default: the panel is off-screen / non-interactive (the sheet is
  // `visibility: hidden`), so Playwright treats it as hidden.
  await expect(panel).toBeHidden();

  // Open via the trigger button, located by its accessible name (aria-label
  // "Sort and filter") — NOT by icon name or CSS class (watchlist.page.spec.ts
  // L257-266 convention).
  await page.getByRole('button', { name: 'Sort and filter' }).click();

  // Wait for the OPEN transition to actually settle before measuring geometry.
  // The panel slides from `translateY(100%)` → `translateY(0)` and the backdrop
  // fades `opacity: 0` → `1` over a 300ms CSS transition. Crucially, the sheet's
  // `visibility` flips synchronously with the `open` class (NO transition on
  // `visibility`), so `toBeVisible()` / `boundingBox()` resolve instantly —
  // potentially BEFORE the transform transition has meaningfully progressed,
  // snapshotting the panel still near its closed off-screen position (the
  // deterministic CI `957`px failure). `toHaveCSS` auto-retries the COMPUTED
  // style until it matches the transition's end state, so these two assertions
  // gate the subsequent bounding-box checks on the animation being finished —
  // no fixed sleep (spec 0087 D2: every wait on a real, observable condition).
  await expect(panel).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(backdrop).toHaveCSS('opacity', '1');

  // The panel is visible AND fully within the viewport. `toBeVisible()` alone is
  // NOT enough (see file header): the #230 regression left the panel visible but
  // off-screen, which only the bounding-box containment catches.
  await expectVisibleWithinViewport(page, panel, 'filter-sheet panel');

  // Sort By section: heading + at least one chip, visible and within viewport.
  const sortSection = page
    .locator('.filter-section')
    .filter({ hasText: 'Sort By' });
  await expectVisibleWithinViewport(
    page,
    sortSection.locator('.filter-section-heading'),
    'Sort By heading',
  );
  await expectVisibleWithinViewport(
    page,
    sortSection.locator('.filter-chip').first(),
    'Sort By chip',
  );

  // Provider section: its heading always renders (chips depend on availability);
  // asserting it visible + within viewport proves the lower part of the panel is
  // on-screen too (the #230 clip hid it below the fold).
  await expectVisibleWithinViewport(
    page,
    page
      .locator('.filter-section')
      .filter({ hasText: 'Provider' })
      .locator('.filter-section-heading'),
    'Provider heading',
  );

  // Close via the Done button; the panel returns off-screen / hidden (the sheet
  // flips back to `visibility: hidden`, so it is no longer visible).
  await panel.locator('.filter-sheet-done').click();
  await expect(panel).toBeHidden();

  // Symmetric settle-wait for the REVERSE (close) transition. `toBeHidden()`
  // above gates only on `visibility: hidden` (which, like the open case, flips
  // instantly and is NOT gated on the 300ms transform/opacity reverse); this
  // extra assertion waits for the backdrop to finish fading back to `opacity: 0`
  // so the closed end-state is genuinely reached, not merely visibility-hidden
  // mid-animation. `toHaveCSS` polls the computed style — no fixed sleep.
  await expect(backdrop).toHaveCSS('opacity', '0');
});

/**
 * Spec 0095 (D2) — the SCROLLED-open scenario. This is the exact CI gap that let
 * the #230 reopen ship: 0087's test above only ever opened the sheet at
 * `scrollTop: 0` (right after boot), so it never exercised a scrolled list.
 *
 * Root cause (fixed in the slice by the `slot="fixed"` move): `.filter-sheet`
 * was a default-slot child of `<ion-content>`, rendering INSIDE Ionic's shadow
 * `[part="scroll"]` container. Its `inset: 0` therefore anchored it to the
 * scroll host's SCROLLED-CONTENT coordinate space, so the whole sheet+panel box
 * slid up by `scrollTop` (measured 1:1 in the investigation), leaving only a
 * sliver on-screen — even though 0087's `translateY(0)` panel transform stayed
 * correct. Projecting the wrapper into `slot="fixed"` renders it OUTSIDE
 * `[part="scroll"]`, anchored to the visual viewport regardless of scroll.
 *
 * The check that catches this is the SAME `expectVisibleWithinViewport` used
 * above: a drifted panel is still DOM-present and `visibility: visible`, so a
 * plain `toBeVisible()` would pass — only the bounding-box viewport-containment
 * assertion fails when the panel is shifted off-screen by the scroll offset.
 *
 * The shared `seeded` fixture (one item) is NOT modified — it is consumed by
 * other specs whose card-count assertions would break. Instead this test writes
 * ad-hoc extra `users/{uid}/watchlist/{tmdbId}` docs (via `writeDocument` +
 * `encodeFields`) to force real overflow on the 375×812 e2e viewport.
 */

/**
 * Ad-hoc overflow watchlist items, written directly to the emulator for THIS
 * test only. Each matches the `WatchlistItemWriteData` shape from
 * `libs/shared/firestore-schema/src/lib/converters.ts` (`watchlistItemToData`):
 * type / tmdbId / traktId / title / addedAt ({ __timestamp } marker) / status /
 * posterPath / voteAverage / releaseDate / nextUnwatchedEpisodeAirDate /
 * watchingViaPlex. The `tmdbId`s (9001+) are chosen to NOT collide with the
 * seeded fixture ids (2 = Breaking Bad, 3 = The Bear).
 */
const OVERFLOW_ITEMS = Array.from({ length: 8 }, (_, i) => ({
  tmdbId: 9001 + i,
  title: `Overflow Title ${i + 1}`,
}));

test('watchlist filter sheet opens visible after the list is scrolled', async ({
  page,
}) => {
  // Boot + seed the shared `seeded` fixture under the LIVE anon uid (R3), then —
  // BEFORE reloading — write the ad-hoc overflow docs so the reloaded watchlist
  // stream renders enough cards to overflow the viewport.
  await page.goto('/');
  const uid = await resolveAnonUid(page);
  await seedFor(uid, 'seeded');

  for (const item of OVERFLOW_ITEMS) {
    await writeDocument(
      `users/${uid}/watchlist/${item.tmdbId}`,
      encodeFields({
        type: 'movie',
        tmdbId: item.tmdbId,
        traktId: null,
        title: item.title,
        // addedAt IS a Firestore Timestamp on the wire — use the __timestamp
        // marker (matching the seeded watchlist items and plex-sync.spec.ts).
        addedAt: { __timestamp: '2026-06-24T10:00:00.000Z' },
        status: 'planned',
        posterPath: null,
        voteAverage: null,
        releaseDate: null,
        nextUnwatchedEpisodeAirDate: null,
        watchingViaPlex: false,
      }),
    );
  }

  // Reload so the freshly-seeded + ad-hoc docs are picked up by the stream, then
  // navigate to the Watchlist tab.
  await page.reload();
  await expect(page).toHaveURL(/\/tabs\/today$/);
  await page.locator('ion-tab-button[tab="watchlist"]').click();
  await expect(page).toHaveURL(/\/tabs\/watchlist$/);

  // Assert enough cards rendered to overflow the 812px-tall viewport. Threshold
  // (>= 7) is well below the 9 expected (1 seeded + 8 ad-hoc) but far above what
  // a single screen fits — no exact count, so the test is robust to the fixture
  // gaining/losing a default item.
  await expect
    .poll(async () => page.locator('.watchlist-card').count())
    .toBeGreaterThanOrEqual(7);

  // Scroll the ACTUAL scrollable host — Ionic's shadow `[part="scroll"]` inside
  // `ion-content` (Playwright's CSS engine pierces the open shadow root). This is
  // the container whose `scrollTop` shifted the pre-fix sheet off-screen.
  const scrollHost = page
    .locator('lib-watchlist ion-content')
    .locator('css=[part="scroll"]');
  const TARGET_SCROLL = 400;
  await scrollHost.evaluate((el, top) => {
    (el as HTMLElement).scrollTop = top;
  }, TARGET_SCROLL);

  // Gate on the scroll actually landing (no fixed sleep) — the host's scrollTop
  // must reach the target before we open the sheet, so we genuinely exercise the
  // scrolled-content coordinate space that produced the #230 drift.
  await expect
    .poll(async () =>
      scrollHost.evaluate((el) => (el as HTMLElement).scrollTop),
    )
    .toBeGreaterThanOrEqual(TARGET_SCROLL - 1);

  const panel = page.locator('.filter-sheet-panel');
  const backdrop = page.locator('.filter-sheet-backdrop');
  await expect(panel).toBeHidden();

  // Open the sheet via the trigger's accessible name (NOT icon/CSS class).
  await page.getByRole('button', { name: 'Sort and filter' }).click();

  // Wait for the OPEN transition to settle before measuring geometry — exactly
  // as the unscrolled test does: `toHaveCSS` polls the computed style until the
  // panel reaches `translateY(0)` and the backdrop `opacity: 1`. No fixed sleep.
  await expect(panel).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await expect(backdrop).toHaveCSS('opacity', '1');

  // THE assertion that catches the pre-fix regression: with the list scrolled to
  // a non-zero offset, the panel must still be visible AND within the viewport.
  // Pre-fix the whole sheet box was shifted up by `scrollTop` (~400px here), so
  // its bounding box fell off-screen while remaining `visibility: visible` — a
  // plain `toBeVisible()` would NOT have caught it, but the bounding-box
  // containment check does.
  await expectVisibleWithinViewport(page, panel, 'filter-sheet panel');

  // Sort By section: heading + first chip, visible and within the viewport.
  const sortSection = page
    .locator('.filter-section')
    .filter({ hasText: 'Sort By' });
  await expectVisibleWithinViewport(
    page,
    sortSection.locator('.filter-section-heading'),
    'Sort By heading',
  );
  await expectVisibleWithinViewport(
    page,
    sortSection.locator('.filter-chip').first(),
    'Sort By chip',
  );

  // Provider heading: proves the lower part of the panel is on-screen too.
  await expectVisibleWithinViewport(
    page,
    page
      .locator('.filter-section')
      .filter({ hasText: 'Provider' })
      .locator('.filter-section-heading'),
    'Provider heading',
  );

  // Close via Done; the panel returns hidden (sheet flips to visibility: hidden).
  await panel.locator('.filter-sheet-done').click();
  await expect(panel).toBeHidden();
});
