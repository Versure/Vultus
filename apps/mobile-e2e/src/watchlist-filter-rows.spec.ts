import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  resolveAnonUid,
  seedFor,
  clearAll,
  writeDocument,
  encodeFields,
} from './support';

/**
 * Spec 0102 (D2) — the Watchlist TOP filter rows stay full-height once the list
 * overflows. Fourth fix in GitHub issue #230; sibling to the DIFFERENT
 * bottom-sheet flow guarded by `watchlist-filter-sheet.spec.ts` (untouched —
 * one-file-per-flow).
 *
 * REGRESSION GUARD: spec 0076 made `ion-content`'s scroll host a flex column
 * (`ion-content::part(scroll) { display: flex; flex-direction: column; }`) so an
 * empty/error `.fill-state` child can flex-fill and center. The persistent
 * control rows `.status-filter` and `.type-tabs` set `overflow-x: auto`; per the
 * CSS flexbox spec a flex item whose overflow is not `visible` has an automatic
 * minimum main-size of 0, so with the default `flex-shrink: 1` an OVERFLOWING
 * list squashed them to their padding (measured 48→16px and 26→4px — the dark
 * gap + label sliver in the reporter's screenshot). The fix adds `flex-shrink: 0`
 * to the rows. Because the squash is overflow-SHRINK pressure it is present at
 * `scrollTop: 0` — there is deliberately NO scroll step here (unlike the sheet
 * spec's scroll-drift scenario).
 *
 * Why a plain `toBeVisible()` is not enough: a chip clipped inside a 16px-tall
 * `overflow: auto` row is still DOM-present, `visibility: visible`, and keeps its
 * own ~32px layout box, so Playwright's "visible" passes even while the row is
 * squashed. Hence the real guard below is the ROW's own `boundingBox().height`
 * floor (≥ 40 / ≥ 20) — the pre-fix broken state measures 16px / 4px, so the
 * floor catches the squash without pinning fragile exact pixels.
 *
 * Determinism (spec 0019 guards): `clearAll()` in beforeEach; per test goto('/')
 * → resolveAnonUid → seedFor(uid,'seeded') → write ad-hoc overflow docs → reload
 * so a NON-EMPTY, overflowing watchlist renders, then tab to Watchlist via
 * `ion-tab-button[tab="watchlist"]`. No fixed sleeps — every wait is on a real
 * locator/condition (Playwright auto-waits / `expect.poll`).
 *
 * Runs against the Firestore emulator IN CI (not in-session — the emulator
 * cannot run under Claude Code tools here; project memory "Emulator tooling
 * limitation"). It is deliberately NOT `test.fixme`'d / skipped.
 *
 * Selectors grounded in `libs/mobile/watchlist/src/lib/watchlist.page.html`:
 *   - status row:  `.status-filter` (L44) with `.status-chip-btn` children
 *     (L46-54); the four labels "All" / "Watching" / "Planned" / "Completed"
 *     come from `statusChips$` (watchlist.page.ts: `label: 'All'` + STATUS_LABELS).
 *   - type tabs:   `.type-tabs` (L59) with `.type-tab` children (L60-83) whose
 *     literal labels are "All" / "Movies" / "TV Shows".
 *   - searchbar:   `ion-searchbar.watchlist-search` (L88-94).
 */

/** Tolerance (px) for the viewport-containment checks — guards sub-pixel layout
 * rounding / safe-area insets while staying far tighter than the row-collapse
 * this test exists to catch. */
const VIEWPORT_TOLERANCE = 2;

/**
 * Ad-hoc overflow watchlist items, written directly to the emulator for THIS
 * test only (mirrors `watchlist-filter-sheet.spec.ts`). Each matches the
 * `WatchlistItemWriteData` shape from
 * `libs/shared/firestore-schema/src/lib/converters.ts` (`watchlistItemToData`):
 * type / tmdbId / traktId / title / addedAt ({ __timestamp } marker) / status /
 * posterPath / voteAverage / releaseDate / nextUnwatchedEpisodeAirDate /
 * watchingViaPlex. The `tmdbId`s (9001+) do NOT collide with the shared `seeded`
 * fixture's watchlist docs (2 = Breaking Bad, 3 = The Bear). Eight docs push well
 * past a single 812px-tall e2e screen so the list overflows and applies shrink
 * pressure.
 */
const OVERFLOW_ITEMS = Array.from({ length: 8 }, (_, i) => ({
  tmdbId: 9001 + i,
  title: `Overflow Title ${i + 1}`,
}));

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
 * Assert `locator` is visible AND its bounding box lies fully within the page
 * viewport — the `expectVisibleWithinViewport` helper duplicated from
 * `watchlist-filter-sheet.spec.ts` (NOT imported across spec files, per D2). Used
 * here for the full-width control-ROW containers + searchbar, which must never
 * bleed past the viewport edges.
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
    `${label} bottom edge within viewport`,
  ).toBeLessThanOrEqual(viewport.height + t);
}

/**
 * A VERTICAL-only variant of `expectVisibleWithinViewport` (the D2 "use/extend
 * the helper pattern" latitude) for chips/tab labels that live inside the
 * horizontally-SCROLLABLE control rows (`.status-filter` / `.type-tabs` set
 * `overflow-x: auto`, chips are `flex: 0 0 auto`). At 12px `label-md` the four
 * status chips can legitimately exceed the 375px e2e viewport width and scroll
 * horizontally by design, so asserting the RIGHT edge would flake without adding
 * squash-detection value. The squash is a VERTICAL collapse, so this asserts the
 * child is visible and its top/bottom lie within the viewport; the row-height
 * floors below remain the primary squash guard.
 */
async function expectVisibleVerticallyWithinViewport(
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
  expect(box.y, `${label} top edge within viewport`).toBeGreaterThanOrEqual(-t);
  expect(
    box.y + box.height,
    `${label} bottom edge within viewport (would fail for a row squashed to its padding)`,
  ).toBeLessThanOrEqual(viewport.height + t);
}

test('watchlist top filter rows stay full-height when the list overflows', async ({
  page,
}) => {
  // Boot + seed the shared `seeded` fixture under the LIVE anon uid (R3), then —
  // BEFORE reloading — write the ad-hoc overflow docs so the reloaded watchlist
  // stream renders enough cards to overflow the viewport and apply shrink
  // pressure to the persistent control rows.
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
        // marker (matching the seeded watchlist items and the sheet spec).
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
  // gaining/losing a default item. NO scroll step: the squash is shrink pressure,
  // already present at scrollTop 0 (D2).
  await expect
    .poll(async () => page.locator('.watchlist-card').count())
    .toBeGreaterThanOrEqual(7);

  // --- 1. Status filter chip row (`.status-filter`) ---------------------------
  const statusFilter = page.locator('.status-filter');
  await expectVisibleWithinViewport(page, statusFilter, 'status-filter row');

  // THE squash guard: the row keeps (near) its 48px baseline, not the 16px
  // padding-only collapse. Floor ≥ 40 (D2) catches the pre-fix 16px.
  const statusBox = await statusFilter.boundingBox();
  expect(statusBox, 'status-filter has a bounding box').not.toBeNull();
  expect(
    statusBox?.height,
    'status-filter row height ≥ 40 (pre-fix squash collapses it to its 16px padding)',
  ).toBeGreaterThanOrEqual(40);

  // All four fixed status chips render and are (vertically) on-screen. Chip text
  // is "<label> <count>" (e.g. "All 9"), so match by label substring within the
  // row. "All" is unique to the All chip among the four labels.
  const statusChips = statusFilter.locator('.status-chip-btn');
  for (const label of ['All', 'Watching', 'Planned', 'Completed']) {
    await expectVisibleVerticallyWithinViewport(
      page,
      statusChips.filter({ hasText: label }),
      `status chip "${label}"`,
    );
  }

  // --- 2. Type tab row (`.type-tabs`) -----------------------------------------
  const typeTabs = page.locator('.type-tabs');
  await expectVisibleWithinViewport(page, typeTabs, 'type-tabs row');

  const typeBox = await typeTabs.boundingBox();
  expect(typeBox, 'type-tabs has a bounding box').not.toBeNull();
  expect(
    typeBox?.height,
    'type-tabs row height ≥ 20 (pre-fix squash collapses it to its 4px padding)',
  ).toBeGreaterThanOrEqual(20);

  // The three literal type-tab labels are visible and vertically on-screen.
  const typeTabButtons = typeTabs.locator('.type-tab');
  for (const label of ['All', 'Movies', 'TV Shows']) {
    await expectVisibleVerticallyWithinViewport(
      page,
      typeTabButtons.filter({ hasText: label }),
      `type tab "${label}"`,
    );
  }

  // --- 3. Search bar ----------------------------------------------------------
  // Already protected by its `overflow: visible`; asserted here to prove the
  // whole top control stack renders on the overflowing list.
  await expectVisibleWithinViewport(
    page,
    page.locator('ion-searchbar.watchlist-search'),
    'watchlist searchbar',
  );
});
