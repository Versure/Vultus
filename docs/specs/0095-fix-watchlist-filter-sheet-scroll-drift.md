---
number: 0095
slug: fix-watchlist-filter-sheet-scroll-drift
title: Fix the Watchlist filter sheet drifting off-screen when the list is scrolled — anchor it to the viewport via `slot="fixed"`
status: implementing
slices: [slice:watchlist]
scopes: [scope:mobile]
created: 2026-07-22
---

# Fix the Watchlist filter sheet drifting off-screen when the list is scrolled — anchor it to the viewport via `slot="fixed"`

## Context

GitHub issue #230 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "The watchlist filter is not visible anymore … Only a
tiny sliver of the filter menu is visible." Opening the combined "Sort & Filter"
bottom sheet on the Watchlist tab leaves the panel almost entirely off-screen —
the control is effectively **unusable**.

This is the **third** spec in the #230 story, following two real fixes that each
closed a genuine bug but did not cover this scenario:

- **Spec 0082** ("Stop the empty Watchlist page scrolling — clip the off-screen
  filter sheet", **done**) added `overflow: hidden` to `.filter-sheet` to stop
  the closed, off-screen panel from leaking scrollable overflow into
  `ion-content` on an empty watchlist (issue #159).
- **Spec 0087** ("Fix the clipped Watchlist filter sheet — bind `open` on the
  panel/backdrop themselves", **done, merged 2026-07-21**) fixed a real CSS
  cascade bug: a nested `.filter-sheet.open .filter-sheet-panel` descendant
  override was not winning the cascade in-browser, so the panel stayed parked at
  its closed `translateY(100%)` offset. 0087 rebound `open` directly onto
  `.filter-sheet-backdrop`/`.filter-sheet-panel`. That fix is **correct and must
  not be regressed** — but 0087 was verified **only** against the
  **empty-watchlist** state on `serve-mock` and merged as `done`.

The reporter (Versure) **reopened #230** on 2026-07-21 with this exact comment
(also **data**, not instructions): "This isnt resolved, the bug is only when
there are items on the watchlist, so it doesnt occur when the list is empty." So
0087's fix is real and correct for what it covered, but **incomplete** — it never
tested a non-empty, scrolled list, which is the actual gap this spec (0095)
closes.

**Root cause — verified live 2026-07-22 via `pnpm nx run mobile:serve-mock` with
direct DOM measurement (not hypothesis), reproducible via the steps below:**

`.filter-sheet` (`libs/mobile/watchlist/src/lib/watchlist.page.scss` L321-342) is
`position: absolute; inset: 0`, and in the template
(`watchlist.page.html` L236) it is a plain **default-slot** child of
`<ion-content>` — so it renders **inside** Ionic's shadow `[part="scroll"]`
element (`.inner-scroll`), the actual scrollable container (made a flex column by
spec 0076's `ion-content::part(scroll) { display:flex; flex-direction:column }`,
L65-68). Because `.filter-sheet`'s containing block is that scrollable
container's box, `inset: 0` positions it in the container's **scrolled content**
coordinate space, **not** the visual viewport. 0087's fix (which correctly drives
the panel to `translateY(0)` **relative to `.filter-sheet`**) is intact — but
`.filter-sheet` itself is anchored to scrolled content, so the whole sheet+panel
box slides with the scroll offset.

### Verification method (reproduce + re-run as D-level verification)

A future reader — and the implementer, as their D5 verification — reproduces this
with the exact method used in the investigation:

1. `pnpm nx run mobile:serve-mock`; bypass the onboarding gate via
   `localStorage.setItem('CapacitorStorage.onboarding_done','true')`; navigate to
   `/tabs/watchlist`.
2. serve-mock's Firestore starts genuinely empty (no seed mechanism), so inject
   **synthetic overflowing content directly into `ion-content`** for measurement
   only — e.g.
   `document.querySelector('lib-watchlist ion-content').appendChild(...)` with a
   tall filler div using `flex: 0 0 2000px` (so it is not flex-shrunk) to force
   real scrollable overflow. **This is a measurement technique, NOT part of the
   shipped fix.**
3. Baseline (`scrollTop: 0`, empty-equivalent): open the filter sheet, measure
   `.filter-sheet-panel.getBoundingClientRect()` → `top: 479.3, bottom: 755.3`
   (within the 812px-tall viewport) and `getComputedStyle(panel).transform` →
   `matrix(1,0,0,1,0,0)` (translateY(0), correctly open). This matches 0087's own
   empty-state verification — confirming 0087's cascade fix is **not** broken.
4. Scroll the container's `[part="scroll"]` shadow element to `scrollTop: 500`,
   then open the sheet fresh: the `.filter-sheet` box `top` moved from `56` (at
   scrollTop 0) to `-444` (at scrollTop 500) — a delta of exactly `-500px`,
   matching the scroll offset **1:1**. The panel's transform was **still**
   correctly `matrix(1,0,0,1,0,0)` (0087's class-binding fix keeps working), but
   the whole sheet+panel box is geometrically shifted off-screen by the scroll
   offset, so only the sliver that still overlaps the viewport (`bottom: 255.3` in
   this run) is visible — reproducing #230's "tiny sliver visible" exactly.
5. Why only non-empty reproduces: an empty watchlist has zero scrollable
   overflow, so `scrollTop` is always 0 and the sheet coincidentally aligns with
   the viewport (0087's verification, at scrollTop 0, looked completely correct).
   A non-empty list that overflows a single screen height (as few as 4-5 items on
   a 375×812 viewport) lets the user scroll the list before tapping the filter
   trigger — completely ordinary usage — at which point the sheet renders shifted
   by however much they scrolled.
6. Confirmed unrelated / must-not-regress: 0082's
   `.filter-sheet { overflow: hidden; }` clip (stops the CLOSED panel's off-screen
   `translateY(100%)` box from leaking scrollable overflow into `ion-content` on
   an empty watchlist) is a **separate concern** from this scroll-coordinate-space
   bug and must not be removed without proof it is still unneeded (or kept-but-
   justified if still needed) — see D1.

Intended outcome: opening the filter sheet — **regardless of how far the list is
scrolled** — renders the panel and backdrop anchored to the visual viewport
(panel bottom-aligned within the 812px-tall viewport, backdrop covering it), not
shifted by the scroll offset, with the drag handle / header / Done / Sort By /
Provider chips all visible and usable, and the open/close animation unchanged.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Fix mechanism: move `.filter-sheet` into `<ion-content slot="fixed">`.**
This is Ionic's documented mechanism (`@ionic/core` `ion-content`) for
viewport-anchored overlay content: elements with `slot="fixed"` render **outside**
`.inner-scroll` / `[part="scroll"]` entirely (Ionic's shadow template projects
`slot="fixed"` content into a **sibling** of the scroll host, not inside it), so
they are structurally immune to the scroll host's `scrollTop` and coordinate
space. This does not just patch this one instance — it fixes the underlying
pattern for any future overlay built the same way. **`position: fixed` and a
"scroll-reset-before-open" approach were considered and rejected/deferred during
the architect interview — do NOT substitute either.** Implementation:

- **Template (`watchlist.page.html`, `.filter-sheet` wrapper ~L236):** add the
  `slot="fixed"` attribute to the `.filter-sheet` wrapper div. **No other
  template restructuring** — the `.filter-sheet-backdrop`/`.filter-sheet-panel`
  children and their `[class.open]="filterSheetOpen"` bindings (from spec 0087)
  stay **exactly** as-is. The wrapper keeps its own
  `[class.open]="filterSheetOpen"` binding too.
- **0082's `overflow: hidden` on `.filter-sheet` must NOT be assumed unnecessary
  and silently dropped.** Once moved to `slot="fixed"`, it is likely no longer
  needed (fixed-slotted content is not part of the scrollable flow that could leak
  overflow into `ion-content`'s `scrollHeight`), but the implementer MUST verify
  this empirically:
  1. Re-run 0082's original empty-watchlist regression check (`ion-content`
     inner-scroll `scrollHeight === clientHeight` with the sheet **closed**) after
     the `slot="fixed"` move, **with `overflow: hidden` still present**.
  2. THEN (if time/scope allows) test **removing** `overflow: hidden` and re-verify
     the **same** check still passes, before actually removing it from the
     stylesheet.
  - If the implementer **cannot conclusively verify** removal is safe, **err on
    the side of KEEPING** `overflow: hidden` (harmless defense-in-depth) and record
    **"kept, not proven redundant"** rather than removing it on a hunch. **Either**
    outcome — kept-with-note OR removed-with-proof — is acceptable; **silently
    dropping it without any verification is NOT.**
- **No `!important`.** No other CSS/template change beyond the `slot="fixed"`
  attribute (and, conditionally, the `overflow: hidden` removal only if proven
  safe).
- Verify the sheet's `z-index: 60`, backdrop-tap-to-close, Done button, Android
  hardware back-button handler, and Sort By / Provider chip interactions all still
  work identically once moved to `slot="fixed"`. Moving to a named slot should not
  change event delegation or Angular's change detection — the elements are still
  light-DOM Angular-templated children of the same component, just projected to a
  different named slot.

**D2. e2e coverage — REQUIRED, closes the exact CI gap that let this regression
ship.** 0087's existing e2e (`apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts`)
only ever opened the sheet at `scrollTop: 0` (right after boot, before any
scrolling) — passing in CI while the real-world regression (scroll down, then
open) shipped undetected. **Extend the SAME existing file** (do NOT create a new
file — this is the same flow, not a new one) with an additional scenario: seed the
watchlist with enough items to overflow the viewport, **scroll the list down**,
THEN open the filter sheet, and assert the panel/backdrop/Sort-By/Provider content
are visible AND within the viewport (**reuse** the existing
`expectVisibleWithinViewport` helper already in that file).

- **Do NOT modify the shared `seeded` fixture file
  (`apps/mobile-e2e/emulator-data/seeded/docs.json`) or the `FixtureName` union
  type in `apps/mobile-e2e/src/support/seed.ts`.** That fixture/type is shared
  across many other e2e specs; widening its scope is out of proportion to this fix
  and risks breaking assertions elsewhere that key off the current single-item
  count (e.g. `watchlist-filter-sheet.spec.ts` L81's own `toHaveCount(1)`). The
  fixture seeds exactly ONE watchlist item ("Breaking Bad") — not enough to
  overflow a 375×812 viewport.
- **Instead, within the NEW test case only:** call `seedFor(uid, 'seeded')` as
  usual, then write several additional **ad-hoc** watchlist docs directly via the
  already-exported `writeDocument` + `encodeFields` helpers (both re-exported from
  `./support` — see `apps/mobile-e2e/src/support.ts` exports). Add enough items
  (e.g. 6-8) — each following the same `WatchlistItemWriteData` shape as
  `watchlistItemToData` in `libs/shared/firestore-schema/src/lib/converters.ts`:
  `type` / `tmdbId` / `traktId` / `title` / `addedAt` (a `{ __timestamp }` marker) /
  `status` / `posterPath` / `voteAverage` / `releaseDate` /
  `nextUnwatchedEpisodeAirDate` / `watchingViaPlex` — to guarantee real overflow on
  the standard e2e viewport. Use distinct `tmdbId` doc ids that do not collide with
  the seeded `2`/`3`.
- **Scroll** via Playwright `page.mouse.wheel` or a `locator.evaluate(el =>
el.scrollBy(...))`-equivalent on the **actual scrollable host** — the
  `ion-content`'s shadow `[part="scroll"]` element (reachable in Playwright via
  `page.locator('ion-content').locator('css=[part="scroll"]')` or by evaluating
  into the shadow root). Pick whichever is idiomatic for this codebase's existing
  Playwright usage (check how other specs in `apps/mobile-e2e/src` scroll content
  if there is a precedent; else implement directly). **No fixed sleeps** — gate on
  real conditions/locators per this repo's e2e convention (see the existing file's
  own comments on this).
- **Confirm the EXISTING test in that file** (`'watchlist filter sheet opens
visible and closes'`, the unscrolled / single-item case) still passes
  **unmodified**.

**D3. Component test coverage.** No new component-level assertion is strictly
required beyond what 0087 already added (the `open`-class-on-three-elements
binding, still correct and unaffected by moving to `slot="fixed"` — jsdom cannot
exercise slot-projection layout or scroll-coordinate geometry, so this bug is
fundamentally **not unit-testable**; e2e is the only meaningful automated guard,
per D2). If touching `watchlist.page.spec.ts` at all, **only verify the existing
0087 assertions still pass** (they should be untouched by adding a `slot="fixed"`
attribute) — do **not** invent a fake jsdom layout assertion.

**D4. Per-slice fix only.** `slice:watchlist` (the `.html` change, and
conditionally the `.scss` `overflow: hidden` removal) plus its e2e counterpart in
`apps/mobile-e2e` (extending the existing file). No `scope:shared` change, no new
Stitch screen (pure structural fix restoring already-specified behavior — same
visual design, same animation, just correctly anchored to the viewport), no
data-model / Firestore / functions change, no `sheriff.config.ts` change. No
`User` domain field touched (**F4 N/A**). No shared-type ripple (**F2 N/A** —
confined to `slice:watchlist` + its e2e file).

**D5. Visual + scripted verification (REQUIRED, same rigor as 0087's D5).** Via
`pnpm nx run mobile:serve-mock`, using the injected-filler technique described
above (or, if by then a real way to populate serve-mock's watchlist exists, real
data): confirm that with the list scrolled to a **non-zero** offset, opening the
filter sheet renders the panel/backdrop **within the viewport** (bounding-box
check, same method as the investigation) — not shifted by the scroll offset. Also
re-confirm 0082's empty-watchlist scroll-leak guard still holds
(`scrollHeight === clientHeight` on the closed sheet, empty list). If serve-mock
cannot be run in the implementer's environment, explicitly flag **UNVERIFIED for a
human eyeball** per CLAUDE.md's UI-fidelity rule — do **not** report done off a
green build alone.

- **Escalation if the fix does not take.** If, after the `slot="fixed"` move, the
  sheet is STILL geometrically offset when scrolled (on serve-mock or in the D2
  e2e), **STOP and flag it to the orchestrator as new information changing scope**
  — do **NOT** reach for `position: fixed`, `!important`, or a scroll-reset hack as
  an ad-hoc fallback (those were explicitly considered and rejected/deferred during
  the architect interview; a failure of D1 needs re-planning, not a silent
  substitution).

## Scope

**In scope (`slice:watchlist` + its e2e counterpart):**

- **`libs/mobile/watchlist/src/lib/watchlist.page.html`** — add the `slot="fixed"`
  attribute to the `.filter-sheet` wrapper div (~L236). No other template change;
  the backdrop/panel children and their `[class.open]` bindings (0087) stay
  verbatim.
- **`libs/mobile/watchlist/src/lib/watchlist.page.scss`** — **conditionally**:
  remove 0082's `overflow: hidden` from `.filter-sheet` (L327-334) **only if**
  proven safe per D1's empirical check; otherwise keep it verbatim with a
  "kept, not proven redundant" note in the PR. Update the L327-333 comment to
  reflect the `slot="fixed"` anchoring either way. No other CSS change; no
  `!important`; do NOT touch `ion-content::part(scroll)` (L65-68), the
  `.fill-state` rules (L75-79), or the panel/backdrop `.open` transform/opacity
  rules (L361-382, from 0087).
- **`libs/mobile/watchlist/README.md`** — extend the existing filter-sheet
  layout paragraph (L134-145) with one sentence: the sheet is now projected into
  `<ion-content slot="fixed">` so it is anchored to the viewport and immune to the
  scroll host's `scrollTop` (issue #230 reopen, follow-up to spec 0087). If the
  `overflow: hidden` was removed, note that too (and why it is no longer needed);
  if kept, note it as harmless defense-in-depth.
- **`apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts`** — **extend** the
  existing file with the D2 scrolled-open scenario (ad-hoc extra watchlist docs →
  scroll the `[part="scroll"]` host → open sheet → assert panel/backdrop/Sort-By/
  Provider within viewport via the existing `expectVisibleWithinViewport`). The
  existing test stays unmodified.

**Out of scope (verify-and-record "no change needed"):**

- `watchlist.page.spec.ts` — no new assertion required (D3); only re-verify the
  existing 0087 specs stay green if touched at all. Do not add a fake jsdom layout
  assertion.
- The shared `seeded` fixture (`apps/mobile-e2e/emulator-data/seeded/docs.json`)
  and the `FixtureName` union (`apps/mobile-e2e/src/support/seed.ts`) — **not
  modified** (D2); the extra overflow docs are ad-hoc `writeDocument` calls in the
  new test case only.
- The 0087 panel/backdrop `.open` bindings and transform/opacity rules — unchanged.
- The 0076 centering mechanism — `ion-content::part(scroll)` flex-column (L65-68)
  and the `.fill-state` rules (L75-79) — unchanged.
- The shared `vultus-empty-state` / `vultus-error-state` component or scss.
- `slice:search`, `slice:notifications`, `slice:title-detail`, `slice:settings`.
- Any `scope:shared`, data-model, Firestore, or functions change.
- `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `apps/mobile-e2e/playwright.config.ts`, `firebase.json`.
- Any new Stitch screen fetch (no new visual element, spacing, or copy — D4).
- `position: fixed`, `!important`, a scroll-reset-before-open hack, or any DOM
  restructuring beyond adding `slot="fixed"` (D1, D5 escalation).

## Affected slices & Sheriff tags

| Project          | Path                    | Sheriff tags                      | Change                                                                                                                                                                                           |
| ---------------- | ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mobile-watchlist | `libs/mobile/watchlist` | `scope:mobile`, `slice:watchlist` | `watchlist.page.html`: add `slot="fixed"` to `.filter-sheet` wrapper. `watchlist.page.scss`: comment update + conditional `overflow: hidden` removal (if proven safe). `README.md`: 1-line note. |
| mobile-e2e       | `apps/mobile-e2e`       | (e2e app; not slice-tagged)       | Extend existing `src/watchlist-filter-sheet.spec.ts` with the scrolled-open scenario (ad-hoc overflow docs via `writeDocument`/`encodeFields`) (D2).                                             |

- **No cross-slice / cross-scope import.** A single existing `scope:mobile` slice
  owns its page html/scss/README; the e2e app is the project's standard e2e
  location and drives the app through the browser (no source import of the slice).
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing path
  glob already tags `libs/mobile/watchlist/src`. Record "no `sheriff.config.ts`
  change needed" in the PR.
- **No `shared/` extraction concern** — nothing shared or duplicated across
  slices; the fix is confined to one page (PLAN §3 vertical-slice).

## Data model touchpoints

**None (in production).** This is a structural template/CSS fix. No Firestore
collection or field is read, written, or added by the app; no converter change.
Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

The D2 e2e writes **ad-hoc extra `users/{uid}/watchlist/{tmdbId}` docs** into the
**emulator** via the existing `writeDocument` REST helper (Admin bypass token,
no rule change needed — see `apps/mobile-e2e/src/support/emulator.ts`) using the
**existing** `WatchlistItemWriteData` shape (no new field). This is test seeding,
not a production data-model change. Record "no `firestore.rules` /
`firestore.indexes.json` change needed" in the PR.

## Public types / APIs

**None.** No new or changed type, no `shared/domain` field, no function
signature, HTTP endpoint, or callable. No `scope:shared` change → **no F2
shared-type ripple**. **No `User` domain field is added or changed → the F4
onboarding-parity rule does not apply** (no persisted preference is introduced;
this is a pure presentation/structure fix). The public barrel surface of
`@vultus/mobile/watchlist` (`WatchlistPage`, `WatchlistService`) is unchanged. The
e2e test reuses the already-exported `writeDocument` / `encodeFields` /
`seedFor` / `resolveAnonUid` / `clearAll` helpers from `apps/mobile-e2e/src/support`
— no new export.

## UI / Stitch screen refs

**Structural template fix restoring the already-specified behavior — no new Stitch
screen and no Stitch fetch required** (D4). No new visual element, text, icon,
font, spacing, radius, or color is introduced. The "Sort & Filter" sheet's
structure, type roles, spacing, radius, and open/close animation are the existing
Stitch `#filter-sheet` (spec 0054) design — the
`translateY(100%) → translateY(0)` 300ms `cubic-bezier(0.4, 0, 0.2, 1)` slide and
the backdrop `opacity 0 → 1` 300ms fade — **unchanged**. No new hex; the existing
`--vultus-*` token usage (authoritative set: `docs/design/vultus-design-system.md`
— not transcribed here) is untouched. The **only** change is _where in the DOM_
the sheet is projected (`slot="fixed"` vs the default scroll slot), so its
positioning context becomes the viewport instead of scrolled content.

**Interactive-state contract (checkable — the "Sort & Filter" sheet on the
Watchlist tab; verify all via D5 on serve-mock, at a NON-ZERO scroll offset):**

- **Closed (default):** `.filter-sheet` `visibility: hidden`,
  `pointer-events: none`; `.filter-sheet-panel` at `transform: translateY(100%)`;
  `.filter-sheet-backdrop` `opacity: 0`. Nothing painted or clickable. Empty
  watchlist: `ion-content` inner-scroll `scrollHeight === clientHeight` (no leaked
  overflow) — this must still hold whether `overflow: hidden` is kept or removed
  (D1).
- **Opening → open (`.open` on all three, sheet slotted `fixed`):**
  `.filter-sheet` becomes `visibility: visible`, `pointer-events: auto`;
  `.filter-sheet-panel` animates to `transform: translateY(0)` over 300ms
  `cubic-bezier(0.4, 0, 0.2, 1)`; `.filter-sheet-backdrop` fades to `opacity: 1`
  over 300ms `ease`. **Regardless of the current `scrollTop`**, the sheet's box is
  anchored to the visual viewport (not scrolled content): the panel's bounding box
  is bottom-anchored **within the viewport** (`bottom ≤ viewport.height`), the
  backdrop covers the viewport, and the drag handle, header (title + Done), Sort
  By chips, and Provider chips are all visible and within the viewport. This is the
  exact assertion the D2 scrolled-open e2e adds.
- **Interactive controls inside the open sheet** (unchanged behavior, verify not
  regressed after the slot move): the **Done** button closes the sheet; a
  **backdrop tap** closes it; the **Android hardware back** button closes it
  (priority-150 `ionBackButton` handler); Sort By chips tap-to-toggle direction;
  Provider chips multi-select.
- **Closing:** `.open` removed from all three → panel animates back to
  `translateY(100%)`, backdrop back to `opacity: 0`, sheet back to
  `visibility: hidden`.

Record "no new UI element — DOM-slot fix to anchor an existing overlay to the
viewport; no Stitch capture required" in the PR.

## Implementation task graph

Two tasks. **Task A** (the slice html/scss/README) and **Task B** (extending the
e2e file) touch **disjoint** file manifests and are independent — both may run
`[parallel]`. Neither depends on a shared `shared/domain` / new-slice /
root-config change, so there is **no `[sequential]` prerequisite**.

### Manifest assertion (for the orchestrator)

- **Task A** writes only:
  - `libs/mobile/watchlist/src/lib/watchlist.page.html`
  - `libs/mobile/watchlist/src/lib/watchlist.page.scss`
  - `libs/mobile/watchlist/README.md`
- **Task B** writes only:
  - `apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts` (extend the **existing**
    file — do NOT create a new one; the scrolled-open case is the **same** flow).

The two manifests are **pairwise disjoint** (`libs/mobile/watchlist/**` vs
`apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts`). Neither touches
`libs/shared/**`, `apps/mobile-e2e/emulator-data/seeded/docs.json`,
`apps/mobile-e2e/src/support/**`, `firestore.rules`, `firestore.indexes.json`,
`sheriff.config.ts`, `playwright.config.ts`, or `firebase.json`.

> **Note on `watchlist.page.spec.ts`:** per D3 no edit is required. It is
> deliberately **not** in either manifest. If the implementer discovers a spec
> genuinely broke (it should not — `slot="fixed"` is an attribute add), that is
> scope-changing new information to surface, not a silent add.

### Task A — watchlist slice (frontend-engineer) `[parallel]`

Manifest: the three files above.

1. **`watchlist.page.html`:** add the `slot="fixed"` attribute to the
   `.filter-sheet` wrapper div (~L236). Leave the wrapper's existing
   `[class.open]="filterSheetOpen"` binding and both children (backdrop + panel,
   with their own `[class.open]` bindings from 0087) exactly as-is. No other
   template change.
2. **`watchlist.page.scss`:** update the `.filter-sheet` comment (L327-333) to
   explain the sheet is now `slot="fixed"`-anchored to the viewport (issue #230
   reopen, follow-up to 0087). Then run D1's empirical `overflow: hidden` check:
   with `slot="fixed"` applied and the sheet closed on an **empty** watchlist,
   confirm `ion-content` inner-scroll `scrollHeight === clientHeight` **with
   `overflow: hidden` present**; if time allows, remove it and re-verify the same
   check still passes, then delete the declaration; otherwise **keep it verbatim**
   and record "kept, not proven redundant". Do NOT touch
   `ion-content::part(scroll)` (L65-68), the `.fill-state` rules (L75-79), the
   0087 `.open` transform/opacity rules (L361-382), or add `!important`.
3. **`README.md`:** extend the filter-sheet layout paragraph (L134-145) with one
   sentence on the `slot="fixed"` viewport-anchoring and the `overflow: hidden`
   outcome (kept-as-defense-in-depth OR removed-with-proof).

**Visual + scripted verification (D5, REQUIRED):** via serve-mock, inject the
tall filler (measurement only), scroll to a non-zero offset, open the sheet, and
measure the panel's bounding box is **within the viewport** (not shifted by the
scroll offset) + backdrop covering the viewport; re-verify the CLOSED empty
watchlist still has `scrollHeight === clientHeight` — OR explicitly flag
UNVERIFIED for a human. **If still offset after the slot move → STOP and escalate
(D5); do NOT patch with `position: fixed` / `!important` / scroll-reset.**

### Task B — filter-sheet e2e scrolled-open scenario (qa-runner / frontend-engineer) `[parallel]`

Manifest: `apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts` (extend). Add a
**second** `test(...)` to the existing file — **"watchlist filter sheet opens
visible after the list is scrolled"** — implementing the D2 flow:

1. Reuse the existing `beforeEach` (onboarding-flag `addInitScript` + `clearAll`)
   and the `bootSeededWatchlist`-style boot (goto `/` → `resolveAnonUid` →
   `seedFor(uid, 'seeded')`); then **before reloading**, write **6-8 ad-hoc extra
   `users/{uid}/watchlist/{tmdbId}` docs** via `writeDocument(path,
encodeFields(data))` (both from `./support`), each using the existing
   `WatchlistItemWriteData` shape (`type`/`tmdbId`/`traktId`/`title`/`addedAt`
   `{ __timestamp }`/`status`/`posterPath`/`voteAverage`/`releaseDate`/
   `nextUnwatchedEpisodeAirDate`/`watchingViaPlex`), with distinct `tmdbId` ids not
   colliding with `2`/`3`. Reload and navigate to the Watchlist tab
   (`ion-tab-button[tab="watchlist"]`); assert several `.watchlist-card`s rendered
   (enough to overflow).
2. **Scroll** the `ion-content`'s shadow `[part="scroll"]` host down (via
   `page.mouse.wheel` or `locator.evaluate(el => el.scrollBy(...))` on
   `page.locator('ion-content').locator('css=[part="scroll"]')`, whichever is
   idiomatic here) far enough to reproduce the pre-fix drift; gate on a real
   condition (e.g. the host's `scrollTop` reaching a target), **no fixed sleep**.
3. Open the sheet via `getByRole('button', { name: 'Sort and filter' })`; wait for
   the open transition to settle (`await expect(panel).toHaveCSS('transform',
'matrix(1, 0, 0, 1, 0, 0)')` and backdrop `opacity: 1`, exactly as the existing
   test does — no sleep); then assert via the **existing**
   `expectVisibleWithinViewport` helper that the panel, the Sort By heading + first
   chip, and the Provider heading are all visible **and within the viewport**.
4. Close via **Done** and assert the panel is hidden.

Also **confirm the existing test** (`'watchlist filter sheet opens visible and
closes'`) is **unmodified and still passes**. Un-skippable and green in CI
(emulator); **not** `test.fixme`. Do NOT modify the shared `seeded` fixture or the
`FixtureName` type.

## Test plan

Per the PLAN §5 pyramid. e2e on **Playwright** against the emulator in CI;
component/unit on **Vitest + Analog**.

**Component — `watchlist.page.spec.ts` (Vitest + Analog) — D3, no new test:**

- **No new component assertion required.** The 0087 three-element `open`-class
  binding test remains valid and is unaffected by adding `slot="fixed"` (an
  attribute add does not change the `classList` toggle wiring). This bug is
  **not unit-testable** — jsdom has no layout engine and cannot exercise
  slot-projection layout or scroll-coordinate geometry (the same limitation
  0076/0082/0087 documented). **Do not add a fake `scrollHeight` /
  `getBoundingClientRect` layout assertion** — the D5 serve-mock check and the D2
  e2e cover the geometry.
- **Existing specs stay green:** all current open/close, backdrop-tap, Sort By,
  and Provider component tests key off `.filter-sheet .…` selectors and the
  three-element `open` binding, none of which changes.

**Rendered-text (F3): not applicable** — no copy/text change (structural
template/CSS only). No new exact-string assertion is added, and no existing one is
weakened; do **not** whitespace-normalize any existing rendered-text assertion.

**e2e (Playwright) — Task B — REQUIRED (D2).** Per the e2e decision rubric this
is a `scope:mobile` change to a **critical user-facing action** (the filter/sort
control) that is unusable when the list is scrolled — an e2e flow is required.

- **Existing named flow (unchanged, must still pass):** `'watchlist filter sheet
opens visible and closes'` — boots at `scrollTop: 0`, opens, asserts within
  viewport, Done closes.
- **New named flow (this spec):** `'watchlist filter sheet opens visible after the
list is scrolled'` — seed `seeded` + 6-8 ad-hoc overflow docs → scroll the
  `[part="scroll"]` host down → open the sheet → assert `.filter-sheet-panel` +
  Sort By heading/chip + Provider heading are visible **and within the viewport**
  (via the existing `expectVisibleWithinViewport`, a check strong enough to catch
  the pre-fix off-screen drift — `toBeVisible()` alone would not, as the drifted
  panel is still DOM-present/`visibility: visible`) → Done closes it. **No fixed
  sleeps** — every wait gates on a real locator/condition/computed style, matching
  the existing file's convention.

Runs against the emulator **in CI**, not in-session (CLAUDE.md emulator
limitation) — written un-skippable and green in CI; **not** `test.fixme`. Confirm
the other watchlist-family e2e specs (`watchlist-refresh`, `mark-watched`) still
pass unchanged (the `slot="fixed"` attribute changes no locator/copy they depend
on).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to Task A or Task B.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-watchlist`, `mobile`, and `mobile-e2e`. (Task A, B)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; single existing `scope:mobile` slice; no
      `sheriff.config.ts` change. (Task A)
- [ ] **`slot="fixed"` added** to the `.filter-sheet` wrapper div in
      `watchlist.page.html`; the wrapper's `[class.open]` binding and both children
      (backdrop/panel + their 0087 `[class.open]` bindings) kept verbatim; no other
      template change. (Task A)
- [ ] **0082 `overflow: hidden` resolved explicitly** in `watchlist.page.scss`:
      either **removed with proof** (empty-watchlist closed-sheet
      `scrollHeight === clientHeight` still holds without it) **or kept verbatim
      with a "kept, not proven redundant" note** — never silently dropped; the
      `.filter-sheet` comment updated to reflect `slot="fixed"` anchoring; the 0076
      `::part(scroll)` (L65-68), `.fill-state` (L75-79), and 0087 `.open`
      transform/opacity rules untouched; no `!important`. (Task A)
- [ ] **D2 e2e scrolled-open flow** "watchlist filter sheet opens visible after
      the list is scrolled" added to the **existing**
      `watchlist-filter-sheet.spec.ts`: seeds `seeded` + 6-8 ad-hoc overflow docs
      (via `writeDocument`/`encodeFields`, NOT by editing the shared fixture or
      `FixtureName`), scrolls the `[part="scroll"]` host, opens the sheet, asserts
      panel + Sort By/Provider within the viewport (existing
      `expectVisibleWithinViewport`), Done closes it; no fixed sleeps;
      un-skippable (not `test.fixme`); green in CI against the emulator. (Task B)
- [ ] **Existing e2e unchanged & green:** the original `'watchlist filter sheet
opens visible and closes'` test is unmodified and passes; `watchlist-refresh`
      and `mark-watched` still pass. (Task B)
- [ ] **D3: no fake jsdom layout assertion** added to `watchlist.page.spec.ts`;
      the existing 0087 component specs still pass. (Task A — verify only)
- [ ] **D5 visual + scripted verification** on serve-mock: with the list scrolled
      to a non-zero offset, opening the sheet renders the panel/backdrop **within
      the viewport** (bounding-box check) — not shifted by the scroll offset; the
      closed empty watchlist still has `scrollHeight === clientHeight` — OR
      explicitly flagged UNVERIFIED for a human. If still offset after the slot
      move: STOP and escalate (no `position: fixed`/`!important`/scroll-reset).
      (Task A)
- [ ] **`libs/mobile/watchlist/README.md` current** (CLAUDE.md lib-README rule):
      the filter-sheet layout paragraph extended with the `slot="fixed"`
      viewport-anchoring note and the `overflow: hidden` outcome. (Task A)
- [ ] **Verify-and-record NO change:** `watchlist.page.spec.ts` (beyond
      re-verify), the shared `seeded` fixture, the `FixtureName` type,
      `apps/mobile-e2e/src/support/**`, the shared `vultus-empty-state` /
      `vultus-error-state` components, `libs/mobile/search/**`,
      `slice:notifications`, `slice:title-detail`, `slice:settings`, all
      `scope:shared` files, `firestore.rules`, `firestore.indexes.json`,
      `sheriff.config.ts`, `playwright.config.ts`, and `firebase.json` are **NOT**
      modified; 0076's mechanism and 0087's `.open` bindings are intact. (Task A, B)
- [ ] **PR description records:** the root cause (`.filter-sheet` was a default-slot
      child of `ion-content`, so `inset: 0` anchored it to the scroll host's
      **scrolled-content** coordinate space, shifting the whole sheet by `scrollTop`
      — 1:1 measured `-500px` at `scrollTop 500` — while 0087's `translateY(0)`
      stayed correct); the D1 fix (`slot="fixed"` → projected outside
      `[part="scroll"]`, anchored to the viewport); the `overflow: hidden` outcome
      (kept-with-note or removed-with-proof, incl. the closed-state `scrollHeight`
      number); the D5 scrolled-open measurement; and why only a non-empty/scrolled
      list reproduced (0087 verified only at `scrollTop 0`). References this spec
      (0095) as the follow-up to spec 0087 / the #230 reopen.

## Risks

- **The `slot="fixed"` projection could subtly change event delegation or CD.**
  Moving the sheet to a named slot theoretically could affect click/back-button
  handling. **Mitigation:** the elements remain light-DOM Angular-templated
  children of the same component (Angular bindings and `(click)`/`ionBackButton`
  handlers are unchanged); D5 explicitly re-verifies Done, backdrop-tap, Android
  back, and Sort By/Provider chip interactions, and the D2 e2e exercises open →
  assert → Done-close end-to-end. If any interaction regresses, that is
  scope-changing new information to surface.
- **The fix might not take** — the sheet could still be offset after `slot="fixed"`
  (e.g. if the Ionic version's shadow template projects `slot="fixed"` differently
  than documented). **Mitigation:** D5 measures the scrolled-open geometry
  directly; **if still offset, STOP and escalate to the orchestrator as
  scope-changing new information — do NOT fall back to `position: fixed`,
  `!important`, or a scroll-reset hack** (D1/D5, all explicitly rejected/deferred).
- **Regressing 0082's empty-watchlist scroll-leak fix.** Removing `overflow:
hidden` without proof could reintroduce the empty-page scroll leak.
  **Mitigation:** D1 requires the empirical `scrollHeight === clientHeight` check
  before any removal, and defaults to **keeping** `overflow: hidden` (harmless
  defense-in-depth) if removal can't be conclusively verified; D5 re-runs the same
  check as a gate.
- **e2e overflow/scroll flakiness.** The new test depends on enough seeded items to
  overflow and on scrolling the correct shadow host. **Mitigation:** seed a
  generous 6-8 ad-hoc docs (well past a single 812px screen), assert several cards
  rendered before scrolling, target the `ion-content` `[part="scroll"]` host
  explicitly, and gate every wait on a real condition (no fixed sleeps) — reusing
  the existing file's `expectVisibleWithinViewport` and `toHaveCSS` settle-wait
  patterns. Runs in CI against the emulator (not in-session — emulator limitation).
- **No PLAN conflict.** A structural template/CSS fix to one existing
  `scope:mobile` slice plus its e2e counterpart; no new field/collection/
  dependency, no `scope:shared` change, no cross-slice import, no `User` field
  (F4 N/A), no shared-type ripple (F2 N/A). Fully consistent with PLAN §3
  vertical-slice.
