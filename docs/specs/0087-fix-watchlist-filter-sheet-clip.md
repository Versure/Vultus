---
number: 0087
slug: fix-watchlist-filter-sheet-clip
title: Fix the clipped Watchlist filter sheet — bind `open` on the panel/backdrop themselves
status: approved
slices: [slice:watchlist]
scopes: [scope:mobile]
created: 2026-07-21
---

# Fix the clipped Watchlist filter sheet — bind `open` on the panel/backdrop themselves

## Context

GitHub issue #230 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "The watchlist filter is not visible anymore … Only a
tiny sliver of the filter menu is visible." Opening the combined "Sort & Filter"
bottom sheet on the Watchlist tab leaves the panel almost entirely off-screen —
the control is effectively **unusable**.

This is a **regression follow-on** from spec 0082 ("Stop the empty Watchlist page
scrolling — clip the off-screen filter sheet", merged, status **done**), which
added `overflow: hidden` to `.filter-sheet` in
`libs/mobile/watchlist/src/lib/watchlist.page.scss` to stop the closed,
off-screen panel from leaking scrollable overflow into `ion-content` (issue
#159). 0082's analysis assumed the **open** panel would never be clipped, because
once `.filter-sheet.open .filter-sheet-panel { transform: translateY(0); }`
applies, the panel should sit fully within `.filter-sheet`'s `inset:0` box. That
assumption is now proven wrong: the open-state override does **not** win in the
browser, so the panel stays parked at its closed `translateY(100%)` offset and is
clipped by 0082's own `overflow: hidden`. 0082 stays `done` as the historical
record of the scroll-leak fix; this is a new spec number continuing the same
overlay's story. **0082's clip must not be removed** — it is still required to
kill the empty-watchlist scroll regression (see D1).

**Root cause — verified via live investigation on
`pnpm nx run mobile:serve-mock` (2026-07-21), reading real DOM/CSS, not
hypothesized:**

Current structure (`watchlist.page.html` ~L236-258):

```html
<div class="filter-sheet" [class.open]="filterSheetOpen">
  <div
    class="filter-sheet-backdrop"
    aria-hidden="true"
    (click)="closeFilterSheet()"
  ></div>
  <div
    class="filter-sheet-panel"
    role="dialog"
    aria-modal="true"
    aria-label="Sort and filter"
  >
    …
  </div>
</div>
```

Current CSS (`watchlist.page.scss` ~L321-372):

```scss
.filter-sheet {
  position: absolute; inset: 0; z-index: 60; visibility: hidden;
  pointer-events: none; overflow: hidden; // <- 0082 clip
  &.open {
    visibility: visible; pointer-events: auto;
    .filter-sheet-backdrop { opacity: 1; }
    .filter-sheet-panel { transform: translateY(0); }
  }
}
.filter-sheet-backdrop { position: absolute; inset: 0; …; opacity: 0; transition: opacity 300ms ease; }
.filter-sheet-panel { position: absolute; left: 0; right: 0; bottom: 0; …; transform: translateY(100%); transition: transform 300ms cubic-bezier(0.4, 0, 0.2, 1); }
```

**Confirmed via direct DOM measurement (mobile viewport 375×812, empty-watchlist
state, serve-mock):**

- Clicking `.filter-trigger` correctly toggles `filterSheetOpen` and adds the
  `open` class to `.filter-sheet`; the sheet's **own** `visibility` and
  `pointer-events` flip correctly (hidden→visible, none→auto).
- BUT `.filter-sheet-panel`'s `transform` stays stuck at its closed offset —
  measured `matrix(1,0,0,1,0,276)` i.e. `translateY(276px)`, matching the panel's
  own rendered height (still functionally `translateY(100%)`) — instead of moving
  to `translateY(0)`. Same for `.filter-sheet-backdrop`'s `opacity`, which stays
  `0` instead of `1`.
- **Not a transition-timing artifact:** re-measured 500ms+ after toggling (well
  past the 300ms transition) — still stuck.
- **Not an Angular-reactivity artifact:** toggling `.open` via raw
  `element.classList.add('open')` with zero Angular involvement reproduces the
  identical stuck result.
- The compiled stylesheet **does** contain the expected override
  (`.filter-sheet.open[_ngcontent-X] .filter-sheet-panel[_ngcontent-X] {
transform: translateY(0px); }`) with correct higher CSS specificity (5 vs the
  base rule's 2), `panelEl.matches('.filter-sheet.open .filter-sheet-panel')`
  returns `true`, and no competing third rule exists anywhere (grepped — only
  `watchlist.page.scss` defines any `.filter-sheet*` rule). Despite all of this,
  the override does not visually win in the browser tested.
- **Net effect:** the panel stays parked at its closed off-screen position, and
  because 0082's `.filter-sheet { overflow: hidden; }` clips it within the sheet
  box, the panel is fully clipped — reproducing #230's "tiny sliver visible" (the
  exact sliver-vs-fully-invisible pixel amount depends on rounding / safe-area
  differences between the harness and a real device, but the panel is
  overwhelmingly clipped either way).
- The **exact** browser-engine mechanism was **not** traced via a live DevTools
  "computed style" step (that tooling was not available in the automated
  investigation), but the measured evidence above points to one coherent
  explanation — see **Root cause hypothesis** below. The chosen fix (D1) holds
  **regardless** of the precise engine mechanism. The implementer should still do a
  final DevTools spot-check during implementation and record what they find, in
  case it warrants a follow-up note.

### Root cause hypothesis (working explanation, consistent with all evidence above)

The nested override `.filter-sheet.open .filter-sheet-panel` is **not** failing
for a specificity reason — and, notably, the D1 replacement selector
`.filter-sheet-panel.open` is actually **lower** specificity (`0,2,0`) than the
currently-failing nested selector (`.filter-sheet.open .filter-sheet-panel` =
`0,3,0`). So the fix does **not** work by "winning on specificity"; it wins for a
different reason.

The one open-state rule that **does** apply correctly is the ancestor's **own**
`&.open { visibility; pointer-events }` — a **same-element** rule that matches on
the very element whose class toggled. The rules that **do not** apply are the two
**descendant** rules (`.filter-sheet.open .filter-sheet-backdrop` /
`.filter-sheet.open .filter-sheet-panel`) whose match depends on the **ancestor's**
class — and they stay stuck even when `open` is toggled via raw `classList.add()`
directly on the ancestor (Angular reactivity ruled out). The coherent explanation
that fits every measurement is a **dynamic descendant-combinator
style-invalidation gap**: in the browser/engine tested, **toggling a class on an
ancestor does not reliably trigger a style recalculation on descendants whose
selector match depends on that ancestor's class.**

D1 fixes this by moving the state mutation **onto the exact element being
restyled**: binding `open` on `.filter-sheet-panel`/`.filter-sheet-backdrop`
themselves makes each open-state rule a **same-element class toggle** (the class
changes on the same node the rule restyles), not an
ancestor-triggers-descendant-restyle dependency — sidestepping the invalidation
gap entirely, despite the lower specificity. The fix's rationale is therefore
**"same-element toggle instead of ancestor-triggered descendant restyle," not
"higher specificity."**

Intended outcome: opening the filter sheet slides the panel fully into view
(`translateY(0)`, panel bounding box within `.filter-sheet`'s box), the backdrop
dims (`opacity: 1`), the Done button / Sort By / Provider chips are usable, and
closing it returns the panel off-screen — **without** reintroducing 0082's
empty-watchlist scroll leak.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Fix mechanism: move the `open` state binding from the ancestor
`.filter-sheet` onto the panel and backdrop THEMSELVES**, replacing the nested
ancestor-descendant selector with simple single-compound selectors on each
element.

- **Template (`watchlist.page.html`):** add `[class.open]="filterSheetOpen"`
  directly to `.filter-sheet-backdrop` **and** to `.filter-sheet-panel`. The
  ancestor `.filter-sheet` **keeps** its own `[class.open]="filterSheetOpen"`
  binding too — still needed for the sheet's own `visibility`/`pointer-events`
  toggle. Do **not** remove it.
- **SCSS (`watchlist.page.scss`):** replace the nested
  `&.open { .filter-sheet-backdrop { opacity: 1; } .filter-sheet-panel {
transform: translateY(0); } }` sub-block with two flat, standalone rules —
  `.filter-sheet-backdrop.open { opacity: 1; }` and
  `.filter-sheet-panel.open { transform: translateY(0); }`. The `.filter-sheet`
  element's own `&.open { visibility: visible; pointer-events: auto; }` rule
  **stays nested exactly as-is** (it toggles the sheet's own state, not a
  descendant's — unaffected by this change).
- **Must NOT touch/regress the 0082 fix:** `.filter-sheet { overflow: hidden; }`
  (added by 0082) stays **exactly** as-is — still required to clip the CLOSED
  panel's off-screen leak and prevent the empty-watchlist scroll regression. Do
  not remove or alter it.
- **Must NOT touch** the `ion-content::part(scroll)` flex-column rule (0076,
  L65-68) or the `.fill-state` rules (0076, L75-79) — out of scope, same as 0082.
- **No `!important` anywhere.**

**D2. New e2e test REQUIRED (upgrade over 0082's precedent).** Unlike 0082 (a
purely-invisible scroll-leak fix where "no new e2e" was correct), this bug makes
the filter/sort control completely **unusable** when open — a critical
user-facing interaction, not a cosmetic issue. Add a Playwright e2e test in
`apps/mobile-e2e` that:

1. boots the app and navigates to the Watchlist tab,
2. opens the filter sheet via the trigger button,
3. asserts the filter sheet panel **and** its Sort By / Provider chip contents
   are **actually visible and positioned within the viewport** — not merely
   present in the DOM. Use Playwright `toBeVisible()` **plus** a real
   bounding-box / viewport-intersection check strong enough to have caught **this
   exact regression** (a clipped panel is `display`-truthy but its box sits
   outside the viewport / outside its clipping container), matching the rigor of
   a real click-and-see check rather than a DOM-attribute-only assertion,
4. closes the sheet via the **Done** button and asserts it is no longer visible.

Add this as a **new** dedicated file
`apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts` (matching the existing
one-file-per-flow watchlist-family convention — `watchlist-refresh.spec.ts`,
`mark-watched.spec.ts`), following its conventions (`page.addInitScript`
onboarding-flag bypass, `resolveAnonUid` → `seedFor` → reload, tab-button
navigation, no fixed sleeps). This e2e runs against the **emulator in CI**, not
in-session (CLAUDE.md emulator limitation) — write it to be un-skippable and
green in CI, do **not** `test.fixme` it.

**D3. Component test coverage.** In `watchlist.page.spec.ts`, add a
component-level (Vitest + Analog) test asserting that toggling `filterSheetOpen`
results in the `open` class being present on **all three** elements'
`classList`: `.filter-sheet` (ancestor), `.filter-sheet-backdrop`, and
`.filter-sheet-panel`. This is a legitimate jsdom-testable DOM-class assertion
(the binding wiring), **unlike** the CSS layout/paint behavior itself, which
remains **not** meaningfully assertable in jsdom (no layout engine — the same
limitation 0076/0082 documented). Do **not** invent a fake layout assertion, and
keep all existing component specs green (the existing open/close tests that key
off `.filter-sheet .…` descendant selectors must still pass — the ancestor keeps
its `open` class, so those selectors are unaffected).

**D4. Per-slice fix only.** `slice:watchlist` only (plus its e2e counterpart in
`apps/mobile-e2e`, the standard e2e location for this project — not a separate
slice concern). No `scope:shared` change, no new Stitch screen (pure structural
CSS/template fix restoring existing intended behavior — no new visual element,
spacing, or copy), no data-model / Firestore / functions change, no
`sheriff.config.ts` change.

**D5. Visual + scripted verification (REQUIRED, same rigor as 0082's D3).** Via
`pnpm nx run mobile:serve-mock`: open the filter sheet and confirm via a **real
DOM measurement** (bounding rect / computed transform) that the panel now sits
**within** the viewport (not clipped) — the same kind of check this investigation
used, but now expecting `translateY(0)` / the panel's bounding box inside
`.filter-sheet`'s box, and the backdrop `opacity: 1`. **Also re-verify the CLOSED
state still does not leak scrollable overflow** — re-run 0082's original check on
the empty watchlist (`ion-content` inner-scroll `scrollHeight === clientHeight`);
this fix must NOT reintroduce that regression. If serve-mock cannot be run,
explicitly flag **UNVERIFIED for a human eyeball** (CLAUDE.md UI-fidelity rule) —
do **not** report done off a green build alone.

- **Escalation if the fix does not take.** If serve-mock (or the D2 e2e) **can**
  run and the panel is **still clipped / stuck at its closed transform** after
  applying the D1 change, **STOP and flag it to the orchestrator as new
  information changing scope** — the root-cause hypothesis above did not hold and
  the fix needs rethinking. Do **NOT** reach for `!important` or any other
  specificity-based patch as a fallback (both already forbidden by D1's "no
  `!important`" rule — this makes the "instead, do X" explicit: escalate, do not
  patch around it).

## Scope

**In scope (`slice:watchlist` + its e2e counterpart):**

- **`libs/mobile/watchlist/src/lib/watchlist.page.html`** — add
  `[class.open]="filterSheetOpen"` to `.filter-sheet-backdrop` (L237-241) and to
  `.filter-sheet-panel` (L242-247). Keep the existing binding on the
  `.filter-sheet` wrapper (L236).
- **`libs/mobile/watchlist/src/lib/watchlist.page.scss`** — replace the nested
  `.open { .filter-sheet-backdrop {…} .filter-sheet-panel {…} }` sub-block (inside
  `.filter-sheet`, L336-347) with two flat rules `.filter-sheet-backdrop.open {
opacity: 1; }` and `.filter-sheet-panel.open { transform: translateY(0); }`.
  Keep `.filter-sheet { … overflow: hidden; &.open { visibility: visible;
pointer-events: auto; } }` (L321-348, minus the two moved descendant rules)
  untouched — including 0082's `overflow: hidden`.
- **`libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`** — add the D3
  three-element `open`-class binding assertion; existing specs stay green.
- **`apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts`** — a **new** dedicated
  e2e test for the filter-sheet open/visible/close flow (D2).
- **`libs/mobile/watchlist/README.md`** — a one-line follow-up sentence on the
  existing 0082 layout-note paragraph (L136-139) noting the open-state binding now
  lives on the panel/backdrop directly (so the panel reliably reaches
  `translateY(0)` and is not clipped by the 0082 overflow), **only if** the
  paragraph would otherwise read as stale.

**Out of scope (verify-and-record "no change needed"):**

- The **0082** `overflow: hidden` clip on `.filter-sheet` — kept verbatim (D1).
- The **0076** centering mechanism — `ion-content::part(scroll)` flex-column
  (L65-68) and the `.fill-state` rules (L75-79) — unchanged (D1).
- The shared `vultus-empty-state` / `vultus-error-state` component or scss.
- `slice:search`, `slice:notifications`, `slice:title-detail`, `slice:settings`.
- Any `scope:shared`, data-model, Firestore, or functions change.
- `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `apps/mobile-e2e/playwright.config.ts`, `firebase.json`.
- Any new Stitch screen fetch (no new visual element, spacing, or copy — D4).
- `!important`; removing the `.filter-sheet` wrapper's own `open` binding;
  restructuring the sheet DOM beyond adding the two `[class.open]` bindings.

## Affected slices & Sheriff tags

| Project          | Path                    | Sheriff tags                      | Change                                                                                                                                                                                                         |
| ---------------- | ----------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-watchlist | `libs/mobile/watchlist` | `scope:mobile`, `slice:watchlist` | `watchlist.page.html`: 2 `[class.open]` bindings. `watchlist.page.scss`: nested `.open` descendants → 2 flat rules (0082 `overflow:hidden` kept). `watchlist.page.spec.ts`: D3 test. `README.md`: 1-line note. |
| mobile-e2e       | `apps/mobile-e2e`       | (e2e app; not slice-tagged)       | New `src/watchlist-filter-sheet.spec.ts`: filter-sheet open→visible→close Playwright test (D2).                                                                                                                |

- **No cross-slice / cross-scope import.** A single existing `scope:mobile` slice
  owns its page html/scss/spec/README; the e2e app is the project's standard e2e
  location and drives the app through the browser (no source import of the slice).
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing path
  glob already tags `libs/mobile/watchlist/src`. Record "no `sheriff.config.ts`
  change needed" in the PR.
- **No `shared/` extraction concern** — nothing shared or duplicated across
  slices; the fix is confined to one page (PLAN §3 vertical-slice).

## Data model touchpoints

**None.** This is a structural CSS/template fix. No Firestore collection or field
is read, written, or added; no converter change. Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**None.** No new or changed type, no `shared/domain` field, no function
signature, HTTP endpoint, or callable. No `scope:shared` change → **no F2
shared-type ripple**. **No `User` domain field is added or changed → the F4
onboarding-parity rule does not apply** (no persisted preference is introduced;
this is a pure presentation fix). The public barrel surface of
`@vultus/mobile/watchlist` (`WatchlistPage`, `WatchlistService`) is unchanged.

## UI / Stitch screen refs

**Structural CSS/template fix restoring the already-specified behavior — no new
Stitch screen and no Stitch fetch required** (D4). No new visual element, text,
icon, font, spacing, radius, or color is introduced. The "Sort & Filter" sheet's
structure, type roles, spacing, radius, and open/close animation are the existing
Stitch `#filter-sheet` (spec 0054) design — the
`translateY(100%) → translateY(0)` 300ms `cubic-bezier(0.4, 0, 0.2, 1)` slide and
the backdrop `opacity 0 → 1` 300ms fade — **unchanged**. No new hex; existing
`--vultus-*` token usage (authoritative set:
`docs/design/vultus-design-system.md` — not transcribed here) is untouched. The
**only** change is _which selector_ carries the open-state declarations so they
reliably win the cascade.

**Interactive-state contract (checkable — the "Sort & Filter" sheet on the
Watchlist tab; verify all via D5 on serve-mock):**

- **Closed (default):** `.filter-sheet` `visibility: hidden`,
  `pointer-events: none`; `.filter-sheet-panel` at `transform: translateY(100%)`
  (fully off-screen below its box); `.filter-sheet-backdrop` `opacity: 0`. Nothing
  painted or clickable. The off-screen panel contributes **no** scrollable
  overflow (clipped by `.filter-sheet { overflow: hidden; }` — 0082). Empty
  watchlist: `ion-content` inner-scroll `scrollHeight === clientHeight`.
- **Opening → open (`.open` on all three):** `.filter-sheet` becomes
  `visibility: visible`, `pointer-events: auto`; `.filter-sheet-panel` animates to
  `transform: translateY(0)` over 300ms `cubic-bezier(0.4, 0, 0.2, 1)`;
  `.filter-sheet-backdrop` fades to `opacity: 1` over 300ms `ease`. The panel's
  bounding box sits **fully within** `.filter-sheet`'s `inset:0` box (bottom-
  anchored, height < full sheet) — **not clipped**; the drag handle, header
  (title + Done), Sort By chips, and Provider chips are all visible and within the
  viewport.
- **Interactive controls inside the open sheet** (unchanged behavior, verify not
  regressed): the **Done** button closes the sheet; a **backdrop tap** closes it;
  the **Android hardware back** button closes it (priority-150 `ionBackButton`
  handler); Sort By chips tap-to-toggle direction; Provider chips multi-select.
- **Closing:** `.open` removed from all three → panel animates back to
  `translateY(100%)`, backdrop back to `opacity: 0`, sheet back to
  `visibility: hidden` — off-screen and non-scrollable again.

Record "no new UI element — selector-scope fix to an existing overlay's open
state; no Stitch capture required" in the PR.

## Implementation task graph

Two tasks. **Task A** (the slice html/scss/spec/README) and **Task B** (the e2e
test) touch **disjoint** file manifests and are independent — both may run
`[parallel]`. Neither depends on a shared `shared/domain` / new-slice /
root-config change, so there is no `[sequential]` prerequisite.

### Manifest assertion (for the orchestrator)

- **Task A** writes only:
  - `libs/mobile/watchlist/src/lib/watchlist.page.html`
  - `libs/mobile/watchlist/src/lib/watchlist.page.scss`
  - `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`
  - `libs/mobile/watchlist/README.md`
- **Task B** writes only:
  - `apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts` — a **new**, dedicated
    e2e spec file. This matches the existing convention: the watchlist-family e2e
    flows already live in **separate** files (`watchlist-refresh.spec.ts`,
    `mark-watched.spec.ts`), so a new dedicated file fits the pattern and avoids
    perturbing those two existing files.

The two manifests are **pairwise disjoint** (`libs/mobile/watchlist/**` vs
`apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts`). No `libs/shared/**`, `libs/mobile/search/**`,
`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
`playwright.config.ts`, or `firebase.json` is touched by either task.

### Task A — watchlist slice (frontend-engineer) `[parallel]`

Manifest: the four files above.

1. **`watchlist.page.html`:** add `[class.open]="filterSheetOpen"` to the
   `.filter-sheet-backdrop` div (L237-241) and to the `.filter-sheet-panel` div
   (L242-247). Leave the `.filter-sheet` wrapper's existing
   `[class.open]="filterSheetOpen"` (L236) in place. No other template change.
2. **`watchlist.page.scss`:** inside the `.filter-sheet` rule (L321-348), remove
   the two descendant declarations from the nested `&.open` block — i.e. delete
   the `.filter-sheet-backdrop { opacity: 1; }` and `.filter-sheet-panel {
transform: translateY(0); }` sub-rules (L340-346) — leaving
   `&.open { visibility: visible; pointer-events: auto; }` intact. Add two flat,
   standalone rules (adjacent to the base `.filter-sheet-backdrop` /
   `.filter-sheet-panel` rules): `.filter-sheet-backdrop.open { opacity: 1; }` and
   `.filter-sheet-panel.open { transform: translateY(0); }`. Keep 0082's
   `overflow: hidden` on `.filter-sheet` verbatim. Do **NOT** touch
   `ion-content::part(scroll)` (L65-68), the `.fill-state` rules (L75-79), or add
   `!important`. Add a short comment noting why the open-state declarations moved
   onto the elements themselves (the nested ancestor-descendant override failed to
   win the cascade in the browser — issue #230, follow-up to spec 0082).
3. **`watchlist.page.spec.ts`:** add the D3 test — toggle `filterSheetOpen` (via
   the existing `openSheet(fixture)` / `filterTrigger(...).click()` helper for the
   open path, then `closeFilterSheet()`/Done for removal) and assert the `open`
   class is present on `.filter-sheet`, `.filter-sheet-backdrop`, and
   `.filter-sheet-panel` `classList` when open, and absent when closed. Do **not**
   assert layout (jsdom has no layout engine). Existing specs stay green; update
   the 0082 comment block (L432-440) only if it would otherwise read as stale.
4. **`README.md`:** extend the existing 0082 layout paragraph (L136-139) with one
   sentence: the sheet's open-state (`opacity: 1` / `translateY(0)`) is bound on
   `.filter-sheet-backdrop`/`.filter-sheet-panel` directly (not via a nested
   `.filter-sheet.open` descendant selector), so the panel reliably reaches
   `translateY(0)` and is not clipped by the 0082 `overflow: hidden`.

**Visual + scripted verification (D5, REQUIRED):** via serve-mock — open the
sheet and measure the panel's computed transform (`translateY(0)`) + bounding box
within `.filter-sheet`'s box + backdrop `opacity: 1`; re-verify the CLOSED empty
watchlist still has `scrollHeight === clientHeight` (0082 not regressed) — OR
explicitly flag UNVERIFIED for a human.

### Task B — filter-sheet e2e (qa-runner / frontend-engineer) `[parallel]`

Manifest: `apps/mobile-e2e/src/watchlist-filter-sheet.spec.ts` (new). Implement
the D2 flow: boot → Watchlist tab → open sheet via the trigger button located by
its **`aria-label="Sort and filter"`** (the convention used in
`watchlist.page.spec.ts:260`; e.g. `getByRole('button', { name: 'Sort and
filter' })` — **not** an icon-name selector) → assert panel + Sort By / Provider
chips are `toBeVisible()` **and** their bounding box intersects the viewport (a
check strong enough to catch a clipped/off-screen panel) → Done closes it →
assert no longer visible. Follow the existing watchlist-family e2e conventions
(onboarding-flag `addInitScript`, `resolveAnonUid`/`seedFor`/`clearAll`,
`ion-tab-button[tab="watchlist"]` navigation, no fixed sleeps). Un-skippable and
green in CI (emulator); not `test.fixme`.

## Test plan

Per the PLAN §5 pyramid. Component/unit on **Vitest + Analog** (no live Firebase,
no emulator, no network, no secrets); e2e on **Playwright** against the emulator
in CI.

**Component — `watchlist.page.spec.ts` (Vitest + Analog) — Task A:**

- **New (D3):** with a seeded watchlist, `filterSheetOpen` starts `false` and none
  of `.filter-sheet`, `.filter-sheet-backdrop`, `.filter-sheet-panel` carry
  `open`. After opening (via `openSheet(fixture)` — the Angular-driven click that
  commits the binding cleanly), assert **all three** elements'
  `classList.contains('open')` is `true`. After closing (Done /
  `closeFilterSheet()`), assert all three no longer carry `open`. This asserts the
  binding wiring the fix depends on — the exact defect a missing `[class.open]`
  would cause.
- **No layout assertion.** CSS transform/clip/paint behavior is **not** assertable
  in jsdom (no layout engine — the same limitation 0076/0082 documented). Do not
  add a fake `scrollHeight`/`getBoundingClientRect` layout assertion in the
  component spec — that is what the D5 serve-mock check and the D2 e2e cover.
- **Existing specs stay green:** the current open/close, backdrop-tap, Sort By,
  and Provider tests key off `.filter-sheet .…` descendant selectors; since the
  `.filter-sheet` wrapper keeps its `open` class and the descendants are unchanged
  structurally, those selectors and assertions are unaffected.

**Rendered-text (F3):** **not applicable** — no copy/text change (structural
CSS/template only). No new exact-string assertion is added, and no existing one is
weakened; do **not** whitespace-normalize any existing rendered-text assertion
(e.g. the `.filter-section-heading` / Sort By chip `toEqual([...])` checks stay
byte-exact).

**e2e (Playwright) — Task B — REQUIRED (D2).** Per the e2e decision rubric this
is a `scope:mobile` change to a **critical user-facing action** (the filter/sort
control) that is currently unusable — an e2e flow is required, not optional. Named
flow: **"watchlist filter sheet opens visible and closes"** —

1. bypass onboarding (`addInitScript` `onboarding_done`), `clearAll`, boot,
   `resolveAnonUid`, `seedFor(uid,'seeded')`, reload, navigate to the Watchlist
   tab (`ion-tab-button[tab="watchlist"]`);
2. click the filter trigger button, located by its **`aria-label="Sort and
filter"`** (matching the `watchlist.page.spec.ts:260` convention; e.g.
   `getByRole('button', { name: 'Sort and filter' })` — **not** an icon-name
   selector);
3. assert `.filter-sheet-panel` is `toBeVisible()` **and** its
   `boundingBox()` lies within the viewport (a clipped/off-screen panel fails
   this — the assertion is deliberately stronger than a DOM-presence /
   `display`-truthy check, matching the rigor of a real click-and-see); assert the
   Sort By heading and at least one Sort By chip and one Provider-section element
   are likewise visible within the viewport;
4. click **Done** and assert `.filter-sheet-panel` is no longer visible.

Runs against the emulator **in CI**, not in-session (CLAUDE.md emulator
limitation) — write it un-skippable and green in CI; do **not** `test.fixme` it.
Confirm the other existing watchlist-family e2e specs (`watchlist-refresh`,
`mark-watched`) still pass unchanged (the two added `[class.open]` bindings change
no locator/copy they depend on).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to Task A or Task B.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-watchlist`, `mobile`, and `mobile-e2e`. (Task A, B)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; single existing `scope:mobile` slice; no
      `sheriff.config.ts` change. (Task A)
- [ ] **Two `[class.open]="filterSheetOpen"` bindings added** to
      `.filter-sheet-backdrop` and `.filter-sheet-panel` in `watchlist.page.html`;
      the `.filter-sheet` wrapper's binding kept; no other template change.
      (Task A)
- [ ] **SCSS refactor applied:** the nested `.open` descendant declarations
      replaced by flat `.filter-sheet-backdrop.open { opacity: 1; }` and
      `.filter-sheet-panel.open { transform: translateY(0); }`; the
      `.filter-sheet` `&.open { visibility/pointer-events }` rule and **0082's
      `overflow: hidden` kept verbatim**; the 0076 `::part(scroll)` flex-col
      (L65-68) and `.fill-state` (L75-79) rules untouched; no `!important`.
      (Task A)
- [ ] **D3 component test** asserts the `open` class toggles on all three
      elements (`.filter-sheet`, `.filter-sheet-backdrop`, `.filter-sheet-panel`);
      no fake jsdom layout assertion; all existing component specs green. (Task A)
- [ ] **D2 e2e flow** "watchlist filter sheet opens visible and closes" added:
      opens the sheet, asserts the panel + Sort By / Provider contents are visible
      **and within the viewport** (bounding-box check, not DOM-presence only), and
      Done closes it; un-skippable (not `test.fixme`); green in CI against the
      emulator. Existing watchlist-family e2e specs still pass. (Task B)
- [ ] **D5 visual + scripted verification** on serve-mock: open sheet → panel at
      `translateY(0)` with bounding box within `.filter-sheet`'s box + backdrop
      `opacity: 1`; **closed empty watchlist still `scrollHeight === clientHeight`
      (0082 not regressed)** — OR explicitly flagged UNVERIFIED for a human.
      (Task A)
- [ ] **`libs/mobile/watchlist/README.md` current** (CLAUDE.md lib-README rule) —
      the 0082 layout paragraph extended with the one-line open-state-binding note
      (or verified already accurate). (Task A)
- [ ] **Verify-and-record NO change:** the shared `vultus-empty-state` /
      `vultus-error-state` components + scss, `libs/mobile/search/**`,
      `slice:notifications`, `slice:title-detail`, `slice:settings`, all
      `scope:shared` files, `firestore.rules`, `firestore.indexes.json`,
      `sheriff.config.ts`, `apps/mobile-e2e/playwright.config.ts`, and
      `firebase.json` are **NOT** modified; 0082's `overflow: hidden` and 0076's
      mechanism are intact. (Task A)
- [ ] **PR description records:** the root cause (the nested
      `.filter-sheet.open .filter-sheet-panel` override failed to win the cascade
      in-browser despite higher specificity, leaving the panel stuck at
      `translateY(100%)` and clipped by 0082's `overflow: hidden`); the D1 fix
      (bind `open` on the panel/backdrop directly, flat selectors); confirmation
      0082/0076 were not regressed (with the closed-state `scrollHeight` number);
      the D5 open-panel measurement; and any DevTools spot-check finding on the
      original cascade failure. References this spec (0087) as the follow-up to
      spec 0082 / issue #230.

## Risks

- **The cascade-failure mechanism was not conclusively identified.** The
  investigation could not pin down _why_ the higher-specificity nested rule failed
  to win in the tested browser. **Mitigation:** the D1 fix does not depend on
  understanding it — a single-compound `.filter-sheet-panel.open` selector applies
  the transform directly on the element, sidestepping the ancestor-descendant
  match entirely (see **Root cause hypothesis** in Context). The implementer's
  DevTools spot-check (recorded in the PR) may surface a definitive root cause
  worth a follow-up note, but the fix is robust regardless. **If the fix does not
  take** — panel still clipped/stuck after D1 on serve-mock or in the D2 e2e —
  the hypothesis was wrong: **STOP and escalate to the orchestrator as
  scope-changing new information; do NOT fall back to `!important` or any other
  specificity-based patch** (D5, D1).
- **Regressing 0082's scroll-leak fix.** The chief risk is that changing the
  open-state selectors accidentally alters the closed panel's clipping.
  **Mitigation:** `.filter-sheet { overflow: hidden; }` is kept verbatim, the
  closed panel still sits at `translateY(100%)`, and D5 re-runs 0082's exact
  `scrollHeight === clientHeight` empty-watchlist check as a gate.
- **e2e viewport/visibility assertion flakiness.** A too-loose check (DOM presence
  / `display`) would not have caught this regression; a too-tight pixel assertion
  could flake on safe-area/rounding differences. **Mitigation:** assert
  `toBeVisible()` plus a viewport-intersection / bounding-box-within-container
  check (the panel's box overlaps the viewport, not exact pixels) — strong enough
  to catch a fully-clipped panel without pinning fragile coordinates. This runs in
  CI against the emulator (not in-session — emulator limitation).
- **No PLAN conflict.** A structural CSS/template fix to one existing
  `scope:mobile` slice plus its e2e counterpart; no new field/collection/
  dependency, no `scope:shared` change, no cross-slice import, no `User` field
  (F4 N/A). Fully consistent with PLAN §3 vertical-slice.
  </content>
  </invoke>
