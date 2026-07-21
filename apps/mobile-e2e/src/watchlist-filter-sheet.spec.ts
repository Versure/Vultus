import { test, expect, type Locator, type Page } from '@playwright/test';
import { resolveAnonUid, seedFor, clearAll } from './support';

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
  // Closed by default: the panel is off-screen / non-interactive (the sheet is
  // `visibility: hidden`), so Playwright treats it as hidden.
  await expect(panel).toBeHidden();

  // Open via the trigger button, located by its accessible name (aria-label
  // "Sort and filter") — NOT by icon name or CSS class (watchlist.page.spec.ts
  // L257-266 convention).
  await page.getByRole('button', { name: 'Sort and filter' }).click();

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
});
