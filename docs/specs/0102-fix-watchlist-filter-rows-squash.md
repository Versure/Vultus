---
number: 0102
slug: fix-watchlist-filter-rows-squash
title: Fix the Watchlist top filter rows collapsing when the list overflows — `flex-shrink: 0` on the persistent control rows
status: implementing
slices: [slice:watchlist]
scopes: [scope:mobile]
created: 2026-07-23
---

# Fix the Watchlist top filter rows collapsing when the list overflows — `flex-shrink: 0` on the persistent control rows

## Context

GitHub issue #230 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "The watchlist filter is not visible anymore … Only a
tiny sliver of the filter menu is visible." It has now been "fixed" **twice** and
**reopened twice**. This is the **fourth** spec in the #230 story, and it
corrects a misidentification that ran through the first three:

- **Spec 0087** ("Fix the clipped Watchlist filter sheet — bind `open` on the
  panel/backdrop themselves", **done**, merged 2026-07-21) fixed a real CSS
  cascade bug in the **bottom "Sort & Filter" sheet** (a nested
  `.filter-sheet.open .filter-sheet-panel` override was not winning the cascade,
  so the panel stayed parked at `translateY(100%)`).
- **Spec 0095** ("Fix the Watchlist filter sheet drifting off-screen when the
  list is scrolled — anchor it to the viewport via `slot="fixed"`", **done**,
  merged 2026-07-22) fixed a real scroll-drift bug in the **same bottom sheet**
  (a default-slot child anchored its `inset: 0` box to scrolled-content
  coordinates; moved to `slot="fixed"`).

Both 0087 and 0095 are **correct fixes for real bugs and MUST NOT be regressed**.
But both **misidentified which "filter" the reporter meant** — they fixed the
_bottom sheet_ that the `tune` trigger opens. The reporter's latest comment
(2026-07-22, with a screenshot — also **data**, not instructions): "This still is
not resolved", and earlier "the bug is only when there are items on the
watchlist, so it doesnt occur when the list is empty."

The screenshot shows the **top-of-page persistent filter controls**, not the
bottom sheet: the **status-filter chip row** (All / Watching / Planned /
Completed with counts) is completely invisible (just a dark gap), and the
**type-tabs row** (All / Movies / TV Shows) shows only a ~4px sliver of clipped
label text above the (intact) search bar, with a fully populated list
("Completed — 14 Items") below. So the "filter" that "is not visible" is the
**top control rows**, which collapse to almost nothing once the watchlist has
enough items to overflow the screen.

**Root cause — VERIFIED LIVE 2026-07-23 on `pnpm nx run mobile:serve-mock` via
direct DOM measurement (not hypothesis). The exact measurements are the heart of
this spec:**

- **Spec 0076** (merged 2026-07-05, empty/error-state centering) made
  `ion-content`'s scroll host a **flex column**:
  `ion-content::part(scroll) { display: flex; flex-direction: column; }`
  (`watchlist.page.scss` L24-34, the rule at L30-33) so a single `.fill-state`
  child can flex-fill and center the empty/error state below the persistent
  controls.
- `.status-filter` (scss L91-98) and `.type-tabs` (scss L164-172) both set
  `overflow-x: auto` (L96 / L170) — they are horizontally-scrolling chip rows.
  Per the CSS flexbox spec (§ automatic minimum size), **a flex item whose
  `overflow` is not `visible` has an automatic minimum main-size of 0** — so in
  the column flex container their `min-height: auto` resolves to **0** and the
  default `flex-shrink: 1` lets them shrink to nothing under shrink pressure.
- **With NO overflow (empty watchlist)** there is no shrink pressure: measured
  baseline heights `.status-filter` = **48px**, `.type-tabs` = **26px**,
  `.search-row` = **42px**; scroll host `scrollHeight === clientHeight`
  (699 === 699). Nothing collapses — matching the reporter's "doesn't occur when
  the list is empty".
- **With overflowing content** (injected an unshrinkable `flex: 0 0 2000px`
  filler — the same measurement technique spec 0095 documented; **real watchlist
  cards are likewise unshrinkable / min-content-protected**): `.status-filter`
  collapsed **48 → 16px** (only its 16px `padding-top` survives — rendering as
  the empty dark gap in the screenshot), `.type-tabs` collapsed **26 → 4px**
  (only its 4px `padding-bottom` — the "tiny sliver" of clipped label text),
  while `.search-row` stayed **42px** (its `overflow` is `visible`, so its
  content-based minimum size protects it — exactly why the search bar looks fine
  in the reporter's screenshot).
- **Fix verified live in the same session:** setting `flex-shrink: 0` on the two
  rows restored them to **48px / 26px** with the overflowing list still scrolling
  normally (`scrollHeight` 2188 > `clientHeight` 699).

### Why it surfaced now, and why 0087/0095 never caught it

- **Why reported 2026-07-20 though 0076 merged 2026-07-05:** the squash needs an
  **overflowing** list; the reporter's watchlist only recently grew past one
  screen (the Plex sync features, specs 0085-0098, mass-imported items — the
  screenshot shows a 14-item Completed group). Empty/short lists never reproduce,
  matching the "only when there are items" comment precisely.
- **Why 0087/0095 missed it:** both verified the **bottom sheet's** geometry
  (0087 on an empty list; 0095 with a scrolled list but only asserting the sheet
  panel), and **no automated test ever asserted the TOP control rows' geometry
  under a non-empty, overflowing list.**

Intended outcome (the reporter-visible acceptance criterion, stated plainly):
**with a populated, overflowing watchlist, the status-filter chips and the type
tabs are fully visible at the top of the page** — not collapsed to a dark gap and
a sliver — and the list below still scrolls normally.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Fix mechanism: `flex-shrink: 0` on the persistent control rows.**

- In `libs/mobile/watchlist/src/lib/watchlist.page.scss`: add `flex-shrink: 0;`
  to `.status-filter` (L91-98), `.type-tabs` (L164-172), **and** (defensively)
  `.search-row` (L216-219). Three one-line declarations; add a short comment (one
  shared comment or one per rule) explaining the flex-column scroll host (spec 0076) + `overflow-x: auto` → automatic-minimum-size-0 squash (issue #230, this
  is the third fix in the story).
- **Alternatives explicitly considered and REJECTED** in the interview (recorded
  so they are not re-litigated): **(a)** replacing 0076's flex-column centering
  wholesale (bigger regression surface, reopens the 0076/0082 story); **(b)**
  pinning the controls outside the scroll area (a visible design change needing
  Stitch verification). Do **NOT** substitute either.
- **MUST NOT touch:** the 0076 `ion-content::part(scroll)` flex-column rule
  (L30-33) and the `.fill-state` rules (L40-44); the 0087 `.open` bindings/rules
  (`.filter-sheet-backdrop.open` L337-339, `.filter-sheet-panel.open` L356-358);
  the 0095 `slot="fixed"` projection and its comment (L286-311, L296-297). **No
  `!important`.** **No template (HTML) change is expected at all.**
- **Empty-list behavior must be unchanged:** the fill-state centering still works
  (`flex-shrink: 0` on natural-height siblings does not affect the fill child's
  `flex: 1 1 auto`), and there is no shrink pressure on an empty list anyway.

**D2. e2e regression guard: a NEW dedicated Playwright file.**

- New file `apps/mobile-e2e/src/watchlist-filter-rows.spec.ts` (one-file-per-flow
  convention; the existing `watchlist-filter-sheet.spec.ts` covers the DIFFERENT
  bottom-sheet flow and stays **untouched**).
- Named flow: **"watchlist top filter rows stay full-height when the list
  overflows"** — bypass onboarding via `addInitScript`, `clearAll`, boot,
  `resolveAnonUid`, `seedFor(uid, 'seeded')`, then write **8 ad-hoc extra**
  `users/{uid}/watchlist/{tmdbId}` docs via the already-exported `writeDocument`
  - `encodeFields` helpers (the same technique spec 0095's D2 locked — do **NOT**
    modify the shared `seeded` fixture or the `FixtureName` union), reload, navigate
    to the Watchlist tab, assert several `.watchlist-card`s rendered (list
    overflows). **No scroll step is needed** — unlike 0095's sheet-drift scenario,
    the squash is overflow-shrink pressure and is already present at
    `scrollTop: 0`; do not add a scroll by analogy to the sheet spec. Then assert:
  * `.status-filter` bounding-box height **≥ ~40px** and all four status chip
    buttons visible within the viewport (use/extend the
    `expectVisibleWithinViewport`-style helper pattern from
    `watchlist-filter-sheet.spec.ts` — reuse the pattern, but if it is file-local
    do **not** import across spec files; **duplicate** the small helper into the
    new file);
  * `.type-tabs` height **≥ ~20px** and the "All" / "Movies" / "TV Shows" tab
    labels visible;
  * the searchbar visible.
  * A height assertion with a sane **floor** (≥ 40 / ≥ 20) is deliberate: the
    pre-fix broken state measures 16px / 4px, so the floor catches the squash
    without pinning fragile exact pixels.
- No fixed sleeps; gate on real locators/conditions per the repo's e2e
  convention. Un-skippable, green in CI against the emulator (e2e runs in CI, not
  in-session — CLAUDE.md emulator limitation). Do **NOT** `test.fixme`.
- Existing e2e files (`watchlist-filter-sheet.spec.ts`, `watchlist-refresh.spec.ts`,
  `mark-watched.spec.ts`) stay **unmodified** and must still pass.

**D3. Component test: none required.** jsdom has no layout engine — flex-squash
geometry is fundamentally **not** unit-testable (the same limitation specs
0076/0082/0087/0095 documented). Do **NOT** invent a fake layout assertion in
`watchlist.page.spec.ts`; the file should not need touching at all. Existing
component specs must stay green.

**D4. Per-slice fix only.** `slice:watchlist` scss + the new e2e file +
`libs/mobile/watchlist/README.md` update. No `scope:shared` change, no Stitch
fetch (no new visual element — this **RESTORES** the specified design; the
intended appearance is the existing "Advanced Watchlist" Stitch design, spec
0054), no data-model / Firestore / functions / `sheriff.config.ts` change. **F2**
shared-type ripple N/A; **F4** User-field/onboarding parity N/A (no `User` field);
**F3** rendered-text N/A (no copy change — but note the e2e asserts label
**visibility**, not new strings).

- **Sibling-slice audit (verified-no-change-needed, 2026-07-23):**
  `libs/mobile/search/src/lib/search.page.scss` and
  `libs/mobile/today/src/lib/today.page.scss` share the 0076 flex-column pattern
  (search `::part(scroll)` L9-12, today L25-28) but are **NOT** vulnerable:
  search's `.search-container` (L27) and today's `.today-main` (L42) have default
  `overflow: visible`, so their content-based minimum size protects them. **No
  defensive change there** (don't DRY across slices — PLAN §3).

**D5. Visual + scripted verification (REQUIRED, same rigor as 0087/0095).** Via
`pnpm nx run mobile:serve-mock`: reproduce with the unshrinkable-filler technique
(documented in spec 0095's "Verification method") BEFORE the fix if desired, and
AFTER the fix measure `.status-filter` **≥ 40px** (expect 48), `.type-tabs`
**≥ 20px** (expect 26), `.search-row` **42px** with the filler present; also
re-verify the empty list still centers its empty-state and
`scrollHeight === clientHeight` when closed/empty (0076/0082 stories not
regressed), and open the filter sheet once to confirm 0087/0095's bottom-sheet
behavior is intact. If serve-mock cannot be run, explicitly flag **UNVERIFIED for
a human eyeball** — never report done off a green build alone.

- **Escalation:** if after `flex-shrink: 0` the rows **still** squash on
  serve-mock or in the D2 e2e, **STOP and flag to the orchestrator as
  scope-changing new information**; do **NOT** patch with `!important` or
  `min-height` hacks.

## Scope

**In scope (`slice:watchlist` + its e2e counterpart):**

- **`libs/mobile/watchlist/src/lib/watchlist.page.scss`** — add `flex-shrink: 0;`
  to `.status-filter` (L91-98), `.type-tabs` (L164-172), and `.search-row`
  (L216-219), with an explanatory comment. No other scss change.
- **`libs/mobile/watchlist/README.md`** — extend the existing spec-0076 layout-note
  paragraph (L126-155) with one sentence: the persistent control rows carry
  `flex-shrink: 0` because the flex-column scroll host + their `overflow-x: auto`
  otherwise squashes them to their padding under overflow pressure (issue #230,
  third fix).
- **`apps/mobile-e2e/src/watchlist-filter-rows.spec.ts`** — a **new** dedicated
  e2e test for the top-filter-rows geometry under an overflowing list (D2).

**Out of scope (verify-and-record "no change needed"):**

- The **0076** centering mechanism — `ion-content::part(scroll)` flex-column
  (L30-33) and the `.fill-state` rules (L40-44) — unchanged (D1).
- The **0087** `.open` bindings and transform/opacity rules
  (`.filter-sheet-backdrop.open` L337-339, `.filter-sheet-panel.open` L356-358) —
  unchanged.
- The **0095** `slot="fixed"` projection and the `.filter-sheet` comment
  (L286-311) — unchanged.
- **`watchlist.page.html`** — no template change (D1).
- **`watchlist.page.spec.ts`** — no change; do not add a fake jsdom layout
  assertion (D3).
- The existing e2e files (`watchlist-filter-sheet.spec.ts`, `watchlist-refresh.spec.ts`,
  `mark-watched.spec.ts`) — unmodified (D2).
- The shared `seeded` fixture (`apps/mobile-e2e/emulator-data/seeded/docs.json`)
  and the `FixtureName` union (`apps/mobile-e2e/src/support/seed.ts`) — **not
  modified** (D2); the extra overflow docs are ad-hoc `writeDocument` calls in the
  new test only.
- `libs/mobile/search/**` and `libs/mobile/today/**` — audited, not vulnerable,
  **not changed** (D4).
- The shared `vultus-empty-state` / `vultus-error-state` component or scss.
- `slice:search`, `slice:notifications`, `slice:title-detail`, `slice:settings`.
- Any `scope:shared`, data-model, Firestore, or functions change.
- `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `apps/mobile-e2e/playwright.config.ts`, `firebase.json`.
- Any new Stitch screen fetch (no new visual element, spacing, or copy — D4).
- `!important`, `min-height` hacks, or any change to 0076/0082/0087/0095
  mechanisms (D1, D5 escalation).

## Affected slices & Sheriff tags

| Project          | Path                    | Sheriff tags                      | Change                                                                                                                                                       |
| ---------------- | ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mobile-watchlist | `libs/mobile/watchlist` | `scope:mobile`, `slice:watchlist` | `watchlist.page.scss`: three `flex-shrink: 0` declarations (`.status-filter` / `.type-tabs` / `.search-row`) + comment. `README.md`: 1-sentence layout note. |
| mobile-e2e       | `apps/mobile-e2e`       | (e2e app; not slice-tagged)       | New `src/watchlist-filter-rows.spec.ts`: top-filter-rows overflow-geometry Playwright test (D2).                                                             |

- **No cross-slice / cross-scope import.** A single existing `scope:mobile` slice
  owns its page scss/README; the e2e app is the project's standard e2e location
  and drives the app through the browser (no source import of the slice).
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing path
  glob already tags `libs/mobile/watchlist/src`. Record "no `sheriff.config.ts`
  change needed" in the PR.
- **No `shared/` extraction concern** — nothing shared or duplicated across
  slices; the fix is confined to one page (PLAN §3 vertical-slice). The sibling
  slices' identical-looking flex-column pattern is deliberately **not** extracted
  (D4 — search/today are not even vulnerable, and duplication inside slices is
  fine).

## Data model touchpoints

**None (in production).** This is a CSS-only fix. No Firestore collection or field
is read, written, or added by the app; no converter change. Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

The D2 e2e writes **ad-hoc extra `users/{uid}/watchlist/{tmdbId}` docs** into the
**emulator** via the existing `writeDocument` REST helper (Admin bypass token, no
rule change needed — see `apps/mobile-e2e/src/support/emulator.ts`) using the
**existing** `WatchlistItemWriteData` shape (no new field). This is test seeding,
not a production data-model change. Record "no `firestore.rules` /
`firestore.indexes.json` / rules-tests change needed" in the PR.

## Public types / APIs

**None.** No new or changed type, no `shared/domain` field, no function signature,
HTTP endpoint, or callable. No `scope:shared` change → **no F2 shared-type
ripple**. **No `User` domain field is added or changed → the F4 onboarding-parity
rule does not apply** (no persisted preference is introduced; this is a pure
presentation fix). The public barrel surface of `@vultus/mobile/watchlist`
(`WatchlistPage`, `WatchlistService`) is unchanged. The e2e test reuses the
already-exported `writeDocument` / `encodeFields` / `seedFor` / `resolveAnonUid` /
`clearAll` helpers from `apps/mobile-e2e/src/support` — no new export.

## UI / Stitch screen refs

**CSS-only fix RESTORING the already-specified design — no new Stitch screen and
no Stitch fetch required** (D4). No new visual element, text, icon, font, spacing,
radius, or color is introduced. The status-filter chip row and underline type-tab
row are the existing "Advanced Watchlist" Stitch design (spec 0054); their type
roles, spacing, radius, colors, and interactive states are **unchanged** —
`--vultus-*` token usage (authoritative set: `docs/design/vultus-design-system.md`
— not transcribed here) is untouched. The **only** change is adding
`flex-shrink: 0` so the rows keep the height they were **always** specified to
have, instead of collapsing to their padding under overflow pressure.

**Layout contract (checkable — the top of the Watchlist tab; verify all via D5 on
serve-mock with an overflowing list, and via the D2 e2e):**

- **`.status-filter` (status chip row):** height **≥ 40px** (baseline **48px**);
  all four chips (All / Watching / Planned / Completed, each with its count) fully
  visible within the viewport, horizontally scrollable, **not** collapsed to its
  16px `padding-top` gap.
- **`.type-tabs` (underline type tabs):** height **≥ 20px** (baseline **26px**);
  the "All" / "Movies" / "TV Shows" labels fully visible, **not** collapsed to a
  ~4px sliver.
- **`.search-row` (search bar + `tune` trigger):** height **42px**, unchanged
  (already protected by its `overflow: visible`; the added `flex-shrink: 0` is
  defensive and does not alter it).
- **Overflowing list below:** still scrolls normally
  (`scrollHeight > clientHeight`).
- **Empty list (regression check):** the three rows keep their baseline heights
  (no shrink pressure), the empty/error `.fill-state` still centers below them,
  and the closed sheet leaks no overflow (`scrollHeight === clientHeight`).

Record "no new UI element — CSS-only fix restoring the specified row heights; no
Stitch capture required" in the PR.

## Implementation task graph

Two tasks. **Task A** (the slice scss/README) and **Task B** (the new e2e file)
touch **disjoint** file manifests and are independent — both may run
`[parallel]`. Neither depends on a shared `shared/domain` / new-slice /
root-config change, so there is **no `[sequential]` prerequisite**.

### Manifest assertion (for the orchestrator)

- **Task A** writes only:
  - `libs/mobile/watchlist/src/lib/watchlist.page.scss`
  - `libs/mobile/watchlist/README.md`
- **Task B** writes only:
  - `apps/mobile-e2e/src/watchlist-filter-rows.spec.ts` — a **new**, dedicated
    e2e spec file (the existing `watchlist-filter-sheet.spec.ts` covers the
    different bottom-sheet flow and is untouched — one-file-per-flow convention).

The two manifests are **pairwise disjoint** (`libs/mobile/watchlist/**` vs
`apps/mobile-e2e/src/watchlist-filter-rows.spec.ts`). Neither touches
`watchlist.page.html`, `watchlist.page.spec.ts`, `apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts`,
`libs/shared/**`, `libs/mobile/search/**`, `libs/mobile/today/**`,
`apps/mobile-e2e/emulator-data/seeded/docs.json`, `apps/mobile-e2e/src/support/**`,
`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
`playwright.config.ts`, or `firebase.json`.

### Task A — watchlist slice scss + README (frontend-engineer) `[parallel]`

Manifest: the two files above. Owns D1, D5, and the verify-no-change records.

1. **`watchlist.page.scss`:** add `flex-shrink: 0;` to `.status-filter` (L91-98),
   `.type-tabs` (L164-172), and `.search-row` (L216-219). Add a short comment
   (shared or per-rule) explaining: these persistent control rows live in the
   spec-0076 flex-column `ion-content::part(scroll)`; `.status-filter` /
   `.type-tabs` set `overflow-x: auto`, which gives a flex item an automatic
   minimum main-size of 0, so without `flex-shrink: 0` an overflowing list
   squashes them to their padding (48→16 / 26→4) — issue #230, third fix.
   Do **NOT** touch the 0076 `::part(scroll)` (L30-33) / `.fill-state` (L40-44)
   rules, the 0087 `.open` rules (L337-339, L356-358), or the 0095 `slot="fixed"`
   comment (L286-311); no `!important`; no `min-height`.
2. **`README.md`:** extend the existing spec-0076 layout-note paragraph
   (L126-155) with one sentence: the persistent control rows
   (`.status-filter` / `.type-tabs` / `.search-row`) carry `flex-shrink: 0`
   because the flex-column scroll host + their `overflow-x: auto` otherwise
   squashes them to their padding under overflow pressure (issue #230, third fix).

**Visual + scripted verification (D5, REQUIRED):** via serve-mock — inject the
unshrinkable filler (measurement only), confirm AFTER the fix `.status-filter`
≥ 40px (expect 48), `.type-tabs` ≥ 20px (expect 26), `.search-row` 42px, and the
list still scrolls (`scrollHeight > clientHeight`); re-verify the empty list still
centers its empty-state and `scrollHeight === clientHeight`; open the sheet once
to confirm 0087/0095 intact — OR explicitly flag UNVERIFIED for a human. **If the
rows still squash after `flex-shrink: 0` → STOP and escalate (no `!important` /
`min-height` hack).**

### Task B — top-filter-rows e2e (qa-runner / frontend-engineer) `[parallel]`

Manifest: `apps/mobile-e2e/src/watchlist-filter-rows.spec.ts` (new). Implement the
D2 flow **"watchlist top filter rows stay full-height when the list overflows"**:

1. Reuse the watchlist-family e2e conventions from
   `watchlist-filter-sheet.spec.ts` (onboarding-flag `addInitScript` in
   `beforeEach` + `clearAll`; goto `/` → `resolveAnonUid` → `seedFor(uid,
'seeded')`); then **before reloading**, write **8 ad-hoc extra**
   `users/{uid}/watchlist/{tmdbId}` docs via `writeDocument(path,
encodeFields(data))` (both from `./support`), each using the existing
   `WatchlistItemWriteData` shape (`type` / `tmdbId` / `traktId` / `title` /
   `addedAt` `{ __timestamp }` / `status` / `posterPath` / `voteAverage` /
   `releaseDate` / `nextUnwatchedEpisodeAirDate` / `watchingViaPlex`), with
   distinct `tmdbId` ids in the `9001+` range (the `seeded` fixture contains a
   single watchlist doc, id `2` — use `9001+` exactly as the sheet spec does).
   Reload, navigate to the Watchlist tab (`ion-tab-button[tab="watchlist"]`).
2. Assert **several** `.watchlist-card`s rendered (list overflows — poll `>= 7`,
   mirroring the sheet spec; 8 ad-hoc docs + the seeded item keep headroom above
   that gate, robust to the fixture gaining/losing a default item). **No scroll
   step** — the squash is present at `scrollTop: 0` (see D2).
3. Assert `.status-filter` `boundingBox()` height **≥ ~40px** and all four status
   chip buttons visible within the viewport (duplicate the small
   `expectVisibleWithinViewport`-style helper into this file — do **not** import
   across spec files).
4. Assert `.type-tabs` height **≥ ~20px** and the "All" / "Movies" / "TV Shows"
   tab labels visible.
5. Assert the searchbar visible.

No fixed sleeps (gate on real locators/conditions). Un-skippable and green in CI
(emulator); **not** `test.fixme`. Do **NOT** modify the shared `seeded` fixture,
the `FixtureName` type, or the existing e2e files.

## Test plan

Per the PLAN §5 pyramid. e2e on **Playwright** against the emulator in CI;
component/unit on **Vitest + Analog**.

**Component — `watchlist.page.spec.ts` (Vitest + Analog) — D3, no new test:**

- **No new component assertion, and no edit to the file.** Flex-squash geometry is
  **not** unit-testable — jsdom has no layout engine (the same limitation
  0076/0082/0087/0095 documented). Do **NOT** add a fake `getBoundingClientRect` /
  `scrollHeight` layout assertion; the D5 serve-mock check and the D2 e2e cover the
  geometry.
- **Existing specs stay green:** a CSS-only change touching no template, binding,
  selector, or copy leaves every current component assertion unaffected. Confirm
  `nx test mobile-watchlist` stays green.

**Rendered-text (F3): not applicable** — no copy/text change (CSS-only). No new
exact-string assertion is added, and no existing one is weakened; do **NOT**
whitespace-normalize any existing rendered-text assertion. The D2 e2e asserts the
tab/chip labels' **visibility**, not new strings — but where it does reference the
tab labels ("All" / "Movies" / "TV Shows"), match them exactly, consistent with
the component-level copy.

**e2e (Playwright) — Task B — REQUIRED (D2).** Per the e2e decision rubric this is
a `scope:mobile` change to the visibility of a **primary user-facing control** (the
top filter rows, currently invisible on any populated watchlist) — an e2e flow is
required, not optional. Named flow: **"watchlist top filter rows stay full-height
when the list overflows"** —

1. bypass onboarding (`addInitScript` `onboarding_done`), `clearAll`, boot,
   `resolveAnonUid`, `seedFor(uid, 'seeded')`, write 8 ad-hoc overflow docs (via
   `writeDocument`/`encodeFields`, NOT by editing the shared fixture or
   `FixtureName`), reload, navigate to the Watchlist tab;
2. assert several `.watchlist-card`s rendered (list overflows);
3. assert `.status-filter` height **≥ ~40px** + all four status chips visible
   within the viewport; `.type-tabs` height **≥ ~20px** + the three tab labels
   visible; the searchbar visible. Height **floors** (not exact pixels)
   deliberately catch the pre-fix 16px / 4px squash without flaking on
   safe-area/rounding differences — the same rationale as the sheet spec's
   viewport-containment check.
4. No fixed sleeps — every wait gates on a real locator/condition.

Runs against the emulator **in CI**, not in-session (CLAUDE.md emulator
limitation) — written un-skippable and green in CI; **not** `test.fixme`. Confirm
the existing watchlist-family e2e specs (`watchlist-filter-sheet`,
`watchlist-refresh`, `mark-watched`) still pass **unchanged** (the CSS-only fix
changes no locator/copy they depend on).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to Task A or Task B.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-watchlist`, `mobile`, and `mobile-e2e`. (Task A, B)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; single existing `scope:mobile` slice; no
      `sheriff.config.ts` change. (Task A)
- [ ] **Three `flex-shrink: 0` declarations present** on `.status-filter`,
      `.type-tabs`, and `.search-row` in `watchlist.page.scss`, with an
      explanatory comment; **no other scss change**; the 0076 `::part(scroll)`
      (L30-33) / `.fill-state` (L40-44), the 0087 `.open` (L337-339, L356-358),
      and the 0095 `slot="fixed"` comment (L286-311) untouched; no `!important`,
      no `min-height`. (Task A)
- [ ] **D2 e2e flow** "watchlist top filter rows stay full-height when the list
      overflows" added as the **new** `apps/mobile-e2e/src/watchlist-filter-rows.spec.ts`:
      seeds `seeded` + 8 ad-hoc overflow docs (via `writeDocument`/`encodeFields`,
      NOT by editing the shared fixture or `FixtureName`), asserts several cards
      rendered, then `.status-filter` ≥ ~40px + four chips visible, `.type-tabs`
      ≥ ~20px + three tab labels visible, searchbar visible; no fixed sleeps;
      un-skippable (not `test.fixme`); green in CI against the emulator. (Task B)
- [ ] **No component change / no fake jsdom layout assertion** in
      `watchlist.page.spec.ts`; existing component specs green. (Task A — verify
      only)
- [ ] **Existing e2e unchanged & green:** `watchlist-filter-sheet.spec.ts`,
      `watchlist-refresh.spec.ts`, and `mark-watched.spec.ts` are unmodified and
      pass. (Task B)
- [ ] **D5 visual + scripted verification** on serve-mock: with an overflowing
      list, `.status-filter` ≥ 40px (expect 48), `.type-tabs` ≥ 20px (expect 26),
      `.search-row` 42px, list still scrolls; empty list still centers its
      empty-state with `scrollHeight === clientHeight`; the filter sheet still
      opens correctly (0087/0095 intact) — OR explicitly flagged UNVERIFIED for a
      human. If the rows still squash after the fix: STOP and escalate (no
      `!important` / `min-height`). (Task A)
- [ ] **`libs/mobile/watchlist/README.md` current** (CLAUDE.md lib-README rule):
      the spec-0076 layout paragraph extended with the one-sentence
      `flex-shrink: 0` note. (Task A)
- [ ] **Verify-and-record NO change:** `watchlist.page.html`,
      `watchlist.page.spec.ts`, the existing e2e files, the shared `seeded`
      fixture, the `FixtureName` type, `apps/mobile-e2e/src/support/**`,
      `libs/mobile/search/**` and `libs/mobile/today/**` (audited, not vulnerable),
      the shared `vultus-empty-state` / `vultus-error-state` components,
      `slice:notifications`, `slice:title-detail`, `slice:settings`, all
      `scope:shared` files, `firestore.rules`, `firestore.indexes.json`,
      `sheriff.config.ts`, `playwright.config.ts`, and `firebase.json` are **NOT**
      modified; the 0076/0082/0087/0095 mechanisms are intact. (Task A, B)
- [ ] **PR description records:** the root cause (spec-0076 flex-column scroll host + `.status-filter` / `.type-tabs` `overflow-x: auto` → CSS automatic minimum
      main-size of 0 → the rows shrink to their padding under overflow pressure;
      **measured 48→16 / 26→4 broken, restored 48/26 fixed**); why only non-empty,
      overflowing lists reproduce (no shrink pressure otherwise; the reporter's
      list only recently overflowed via the Plex-sync imports); why 0087/0095
      missed it (they fixed the **bottom sheet**; nothing ever asserted the **top
      rows'** geometry on an overflowing list); and references issue #230 + specs
      0076 / 0082 / 0087 / 0095. (Task A)

## Risks

- **The fix not taking.** It was already verified live pre-spec, but on the
  desktop browser engine (serve-mock / Chromium). A real-device Android WebView
  difference is theoretically possible, though the CSS automatic-minimum-size rule
  is engine-standard. **Mitigation:** D5 measures the row heights directly and the
  D2 e2e gates it in CI; **if the rows still squash after `flex-shrink: 0`, STOP
  and escalate to the orchestrator as scope-changing new information — do NOT
  patch with `!important` or a `min-height` hack** (D1, D5).
- **e2e seeding / overflow flakiness.** The test depends on enough seeded items to
  overflow the viewport. **Mitigation:** seed a generous **8** ad-hoc docs
  (well past a single 812px screen), assert several cards rendered before
  measuring, use height **floors** (≥ 40 / ≥ 20) rather than exact pixels, and use
  no fixed sleeps (gate on real conditions) — mirroring the sheet spec's
  conventions. Runs in CI against the emulator (not in-session — emulator
  limitation).
- **Regressing 0076's empty/error-state centering.** `flex-shrink: 0` on the
  control rows theoretically could affect the flex layout. **Mitigation:** it is
  applied **only** to natural-height siblings (the control rows), never to the
  `.fill-state` child (which keeps `flex: 1 1 auto; min-height: 0`); on an empty
  list there is no shrink pressure anyway; D5 re-checks empty-state centering and
  `scrollHeight === clientHeight` as a gate.
- **Process risk — the fourth spec on one issue.** #230 has been "fixed" and
  reopened three times because each prior fix targeted the **bottom sheet**, not
  the **top control rows** the reporter's screenshot shows. **Mitigation:** the
  reporter-visible acceptance criterion is stated plainly — with a populated,
  overflowing watchlist, the status chips and type tabs are **fully visible at the
  top of the page** — and the D2 e2e asserts exactly that geometry, closing the
  test gap that let the misidentification persist.
- **No PLAN conflict.** A CSS-only fix to one existing `scope:mobile` slice plus
  its e2e counterpart; no new field/collection/dependency, no `scope:shared`
  change, no cross-slice import, no `User` field (F4 N/A), no shared-type ripple
  (F2 N/A). The identical-looking sibling-slice flex-column pattern is deliberately
  **not** DRY'd out (D4). Fully consistent with PLAN §3 vertical-slice.
