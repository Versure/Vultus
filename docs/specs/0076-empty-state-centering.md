---
number: 0076
slug: empty-state-centering
title: Center the empty/error state and stop the stray scroll on the Watchlist and Search pages
status: implementing
slices: [slice:watchlist, slice:search]
scopes: [scope:mobile]
created: 2026-07-05
---

# Center the empty/error state and stop the stray scroll on the Watchlist and Search pages

## Context

GitHub issue #159 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "When the watchlist is empty you can scroll." The empty
state ("Your watchlist is empty") is not vertically centered, and the page
scrolls even though the content fits in the viewport. The same happens on the
Search page.

**Root cause (verified against `main`).** The shared component
`libs/shared/ui-kit/src/lib/empty-state/vultus-empty-state.component.scss` sets
`:host { display:flex; flex-direction:column; align-items:center;
justify-content:center; min-height: 100%; … }` (lines 1–11). `min-height: 100%`
only produces correct centering + no-scroll when the empty-state is the **sole**
child of `ion-content`. But on both pages it renders **below** persistent
siblings that occupy real layout height:

- **Watchlist** (`libs/mobile/watchlist/src/lib/watchlist.page.html`): the
  `.status-filter` chips (line 54), `.type-tabs` (line 69), and `.search-row`
  (line 98) are all **outside** the `@if` and always rendered. The
  `<vultus-empty-state>` (line 123) renders in the empty branch
  (`vm.groups.length === 0`, line 122) below them.
- **Search** (`libs/mobile/search/src/lib/search.page.html`): the
  `.search-container` searchbar (line 18) always renders; the empty-states (line
  27 prompt, line 40 no-results) render below it.

The empty-state's own `min-height: 100%` **plus** the siblings' height exceeds
the viewport → vertical overflow (the stray scroll) and the box is pushed below
true center.

The shared `vultus-error-state` component
(`libs/shared/ui-kit/src/lib/error-state/vultus-error-state.component.scss`) has
the **identical** `:host { min-height: 100% }` (lines 1–11) and renders in the
same conditional slot on both pages (watchlist line 116, search line 48), so it
shares the defect. `vultus-skeleton-card` is `display:block` (natural height) and
is correct as-is — it is **not** touched.

Intended outcome: on both pages the empty/error state centers in the space
**below** the persistent controls and the page does not scroll when content fits,
while a long (non-empty) list still scrolls normally.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Per-slice fix ONLY.** Fix `slice:watchlist` and `slice:search` at the
**page** level. Do **NOT** modify the shared `vultus-empty-state` /
`vultus-error-state` components or their scss — that would force a flex-column
fill contract onto all consumers and risk the states that work today
(notifications, title-detail). Do **NOT** touch `slice:notifications` or
`slice:title-detail` (title-detail's not-found has a latent variant, explicitly
out of scope for this issue).

**D2. Keep persistent controls visible.** On the Watchlist the empty branch
(`vm.groups.length === 0`) also fires when a filter/search returns no matches, so
the status chips, type tabs, and search row **stay visible**; the empty-state
centers in the remaining space **below** them. No new logic to distinguish a
truly-empty watchlist from a filtered-empty one. On Search, the searchbar always
stays. **No template restructuring to hide controls.**

**D3. Mechanism — page-scoped flex-fill (locked approach; implementer pins exact
selectors).** In each page's scss:

- Make the `ion-content` scroll container a flex column so children lay out
  top-to-bottom and a single child can absorb the remaining space:
  `ion-content::part(scroll) { display: flex; flex-direction: column; }`. Verify
  `::part(scroll)` is the correct Ionic shadow part for `ion-content`'s
  scrollable element; if the implementer finds it unavailable/ineffective, the
  fallback is wrapping the content region in a flex-column `<div>` — but **prefer
  the part** (no template restructure).
- Give the empty-state **and** error-state usages `flex: 1 1 auto; min-height:
0;` so they fill the space below the persistent siblings and center via the
  components' **own** existing `justify-content/align-items: center`.
- To override the shared component's `:host { min-height: 100% }`
  (emulated-encapsulation specificity `[_nghost-…]` = 0,1,0) **WITHOUT
  `!important`**: add a marker **class** to the `<vultus-empty-state>` and
  `<vultus-error-state>` elements in the page HTML (e.g. `class="fill-state"`),
  and target `vultus-empty-state.fill-state, vultus-error-state.fill-state {
flex:1 1 auto; min-height:0; }` (element+class = 0,1,1 > 0,1,0). The
  marker-class rule overrides **only** `min-height` (to `0`) — the shared
  `:host`'s other box properties (`max-width: 320px; margin: 0 auto; padding: 0
32px`) are deliberately **left untouched** and continue to apply (they keep the
  centered box constrained + padded). Do **NOT** "simplify" by overriding more
  than `min-height` (plus `flex`) — only `min-height:100%` breaks the fill; the
  rest is correct as-is. Keep the
  marker-class name consistent across the two slices' own scss, but note it is
  **per-slice** (each page owns its class + scss; it is **NOT** a shared class).
  Do **NOT** reach for `!important`.
- **Primary regression risk:** the flex-column layout must **NOT** break the
  non-empty scrolling case — a long watchlist (many status sections/cards) and a
  long search results list must still scroll normally. This **MUST** be visually
  verified (see Test plan / DoD). Also confirm the loading **skeleton** state
  still renders at the top (skeleton-card is `display:block`; do **NOT** add the
  `fill-state` class to it).

**D4. No shared/data/functions change.** Pure CSS + minimal template (a class
attribute) change in two `scope:mobile` slices. No `scope:shared` change → no F2
shared-type ripple. No data-model touchpoint, no Firestore, no functions, no new
dependency. No new UI element, text, icon, or font — the empty/error copy is
unchanged, so **no new Stitch screen and no Stitch fetch required** (layout-only
fix to existing components). No new hex is introduced (there are none — layout
only).

**D5. Verify-and-record NO change.** `libs/shared/ui-kit` (both empty-state +
error-state components and their scss), `slice:notifications`,
`slice:title-detail`, `slice:settings`, all `scope:shared` files,
`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
`.github/workflows/ci.yml`, `apps/mobile-e2e/playwright.config.ts`,
`firebase.json` — **NONE** modified. Record each as "no change needed" in the PR.
`slice:settings` is the shared components' 5th consumer
(`libs/mobile/settings/src/lib/settings.page.html:32` renders
`<vultus-error-state>`), but its error-state is the **sole `ion-content` child**
in its branch (wrapped in `.settings-loading`, with no persistent sibling above
it), so it **already centers correctly** and is intentionally left untouched.

## Scope

**In scope:**

- **`slice:watchlist`:** add the `fill-state` marker class to the
  `<vultus-error-state>` (line 116) and `<vultus-empty-state>` (line 123) in
  `watchlist.page.html`; add the `ion-content::part(scroll)` flex-column rule and
  the `.fill-state` rule to `watchlist.page.scss`; component-test the marker
  class; README (minimal, only if warranted).
- **`slice:search`:** add the `fill-state` marker class to **both**
  `<vultus-empty-state>` usages (prompt line 27, no-results line 40) and the
  `<vultus-error-state>` (line 48) in `search.page.html`; extend the existing
  `ion-content` block with the `::part(scroll)` flex-column rule and add the
  `.fill-state` rule to `search.page.scss`; component-test the marker class;
  README (minimal, only if warranted).

**Out of scope:**

- **Shared `vultus-empty-state` / `vultus-error-state` component or scss change**
  (D1) — the fix is page-scoped so the working consumers are untouched.
- **`slice:notifications`, `slice:title-detail`** (D1) — including title-detail's
  latent not-found variant.
- **`slice:settings`** (D5) — the shared components' 5th consumer
  (`settings.page.html:32` uses `<vultus-error-state>`), but its error-state is
  the **sole `ion-content` child** in its branch (no persistent sibling above it),
  so it already centers correctly and needs no fix.
- **Any template restructuring / hiding of the persistent controls** (D2) — the
  chips/tabs/search row and the searchbar stay rendered.
- **`!important`** (D3) — overridden via the element+class specificity instead.
- **Any `scope:shared`, data-model, Firestore, functions, or dependency change**
  (D4).
- **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `.github/workflows/ci.yml`, `apps/mobile-e2e/playwright.config.ts`,
  `firebase.json`** — no change (D5; verify-and-record).
- **New e2e** — a pure CSS centering fix adds no critical user flow (see Test
  plan).

## Affected slices & Sheriff tags

| Project          | Path                    | Sheriff tags                      | Change                                                                                                                                                                                                                 |
| ---------------- | ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-watchlist | `libs/mobile/watchlist` | `scope:mobile`, `slice:watchlist` | `watchlist.page.html`: `fill-state` class on error-state (L116) + empty-state (L123). `watchlist.page.scss`: `ion-content::part(scroll)` flex-col + `.fill-state`. Component test. README (minimal).                   |
| mobile-search    | `libs/mobile/search`    | `scope:mobile`, `slice:search`    | `search.page.html`: `fill-state` class on both empty-states (L27, L40) + error-state (L48). `search.page.scss`: extend `ion-content` with `::part(scroll)` flex-col + `.fill-state`. Component test. README (minimal). |

- **No cross-slice / cross-scope import.** Both are existing `scope:mobile`
  slices; each owns its own page HTML + scss + spec. The `fill-state` marker
  class is **duplicated per slice** (each page's scss defines its own) — this is
  correct vertical-slice behavior, **not** a `shared/` extraction candidate
  (only 2 slices, and CSS class names are not importable logic; do NOT extract to
  `shared/ui-kit`).
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing path
  globs already tag `libs/mobile/watchlist/src` and `libs/mobile/search/src`.
  Record "no `sheriff.config.ts` change needed" in the PR.

## Data model touchpoints

**None.** This is a layout-only CSS/template change. No Firestore collection or
field is read, written, or added; no converter change. Consequently:

- **`firestore.rules` — no change** (D5). No new read/write path.
- **`firestore.indexes.json` — no change** (D5). No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**None.** No new or changed type, no `shared/domain` field, no function
signature, no HTTP endpoint, no callable. No `scope:shared` change → **no F2
shared-type ripple** (D4). The only surface change is a page-local CSS class
attribute in each page template.

## UI / Stitch screen refs

**Layout-only fix — no new Stitch screen and no Stitch fetch required** (D4). No
new visual element, text, icon, or font is introduced: the empty/error copy
("Your watchlist is empty" / "Search for movies and TV shows" / "No results for
…" / the error message) is **unchanged**, and the components' visuals
(icon/type/color) are untouched — only their **box centering + scroll behavior**
on these two pages changes. **No new hex** is introduced; the existing
components' `--vultus-*` token usage (see `docs/design/vultus-design-system.md`
for the authoritative token set — do not transcribe hexes here) is unchanged.

**Layout contract (checkable):**

- Empty Watchlist: "Your watchlist is empty" is vertically centered in the space
  **below** the status chips / type tabs / search row; the page does **not**
  scroll.
- Empty Search (prompt) and Search no-results: the empty-state is vertically
  centered in the space **below** the searchbar; the page does **not** scroll.
- Error state on each page centers likewise, in the same slot.
- **Non-empty regression:** a long watchlist (many status sections/cards) and a
  long search results list **still scroll normally**.
- Loading **skeleton** renders at the **top** (natural block height; no
  `fill-state` class).

Record "no new UI element — layout-only centering fix to existing components; no
Stitch capture required" in the PR.

## Implementation task graph

Two independent `scope:mobile` slice tasks. Each writes only within its own
slice; the file manifests are **pairwise disjoint**, so both tasks run
**[parallel]**. No shared dep, no new-slice generation, no root/config wiring →
**no [sequential] prerequisite**.

### Manifest disjointness assertion (for the orchestrator)

- **Task A** writes only: `libs/mobile/watchlist/src/lib/watchlist.page.html`,
  `libs/mobile/watchlist/src/lib/watchlist.page.scss`,
  `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
  `libs/mobile/watchlist/README.md`.
- **Task B** writes only: `libs/mobile/search/src/lib/search.page.html`,
  `libs/mobile/search/src/lib/search.page.scss`,
  `libs/mobile/search/src/lib/search.page.spec.ts`,
  `libs/mobile/search/README.md`.

The two manifests are **pairwise disjoint** — no file appears in both. No
`libs/shared/**`, `firestore.rules`, `firestore.indexes.json`,
`sheriff.config.ts`, `ci.yml`, `playwright.config.ts`, or `firebase.json` is
touched.

- **Task A — watchlist slice [parallel]** (frontend-engineer).
  Manifest: the four files above.
  1. `watchlist.page.html`: add `class="fill-state"` to `<vultus-error-state>`
     (line 116) and `<vultus-empty-state>` (line 123). Do **NOT** add it to
     `<vultus-skeleton-card>` (line 121) or restructure the template (D2/D3).
  2. `watchlist.page.scss`: add `ion-content::part(scroll) { display: flex;
flex-direction: column; }` and `vultus-empty-state.fill-state,
vultus-error-state.fill-state { flex: 1 1 auto; min-height: 0; }`. Extend
     (do not duplicate) the existing `ion-content { --background: … }` block at
     line 59. Verify `::part(scroll)` is effective; if not, use the flex-column
     wrapper-div fallback (prefer the part).
  3. Component test: assert `<vultus-empty-state.fill-state>` present in the empty
     branch and `<vultus-error-state.fill-state>` present in the error branch
     (see Test plan).
  4. README: add a one-line note on the empty/error fill-state centering **only
     if** the README documents page layout; keep minimal — do not invent content.
  - **Visual verification** (see Test plan / DoD): empty + non-empty-regression +
    error, via `serve-mock`, or flag UNVERIFIED for a human.

- **Task B — search slice [parallel]** (frontend-engineer).
  Manifest: the four files above.
  1. `search.page.html`: add `class="fill-state"` to **both**
     `<vultus-empty-state>` usages (prompt line 27, no-results line 40) and the
     `<vultus-error-state>` (line 48). Do **NOT** add it to
     `<vultus-skeleton-card>` (line 34) or restructure the template (D2/D3).
  2. `search.page.scss`: extend the existing `ion-content { --background: … }`
     block (line 35) with `ion-content::part(scroll) { display: flex;
flex-direction: column; }`; add `vultus-empty-state.fill-state,
vultus-error-state.fill-state { flex: 1 1 auto; min-height: 0; }`. Same
     `::part(scroll)` verify + wrapper-div fallback as Task A.
  3. Component test: assert `<vultus-empty-state.fill-state>` present in the
     prompt and no-results branches and `<vultus-error-state.fill-state>` present
     in the error branch (see Test plan).
  4. README: same minimal-only-if-warranted note as Task A.
  - **Visual verification** as Task A: empty (prompt + no-results) +
    non-empty-regression + error, via `serve-mock`, or flag UNVERIFIED.

## Test plan

Per the PLAN §5 pyramid. All component/unit tests run on **Vitest + Analog**; no
live Firebase, no emulator, no network, no secrets.

**Component — `watchlist.page.spec.ts` (Vitest + Analog):**

- Empty branch (vm with `groups.length === 0`): assert
  `fixture.nativeElement.querySelector('vultus-empty-state.fill-state')` is
  **not null**.
- Error branch (vm with `error`): assert
  `querySelector('vultus-error-state.fill-state')` is **not null**.
- (Optional guard) skeleton branch (`groups === null`): assert the
  `<vultus-skeleton-card>` does **not** carry `fill-state`.

**Component — `search.page.spec.ts` (Vitest + Analog):**

- `viewState() === 'prompt'`: assert
  `querySelector('vultus-empty-state.fill-state')` is not null.
- `viewState() === 'no-results'`: assert
  `querySelector('vultus-empty-state.fill-state')` is not null.
- `viewState() === 'error'`: assert
  `querySelector('vultus-error-state.fill-state')` is not null.
- (Optional guard) `viewState() === 'loading'`: skeleton does not carry
  `fill-state`.

**Layout note (explicit):** CSS-computed **centering and no-scroll behavior is
NOT reliably assertable in jsdom/Vitest** (no real layout engine). The component
tests above assert only the **marker-class presence** (a DOM-presence check), the
lever the CSS hangs off. The actual centering + no-scroll (and the non-empty
scroll regression) is verified **visually** (below), **not** in a unit test —
stated here rather than pretending a unit test covers layout.

**Rendered-text (F3):** no rendered-copy change here; the existing empty/error
strings are untouched. **No new exact-string assertion is added, and no existing
one is weakened** (do not whitespace-normalize any existing rendered-text
assertion).

**Visual verification (REQUIRED — per CLAUDE.md UI-fidelity rule; a green build
does NOT prove the layout).** Via `pnpm nx run mobile:serve-mock` (or a component
render):

- (a) empty Watchlist → "Your watchlist is empty" vertically centered in the
  space **below** the chips/tabs/search row, and the page does **NOT** scroll;
- (b) empty Search **prompt** and **no-results** states centered, no scroll;
- (c) **non-empty regression:** a long watchlist and a long results list **still
  scroll normally**;
- (d) **error** state on each page centers likewise.

If the implementer cannot run `serve-mock`, the UI **must** be explicitly flagged
**UNVERIFIED for a human eyeball** — do **NOT** report it done off a green build.

**e2e (Playwright):** **No new e2e flow required — layout-only CSS fix, no new
route or critical action** (per the e2e decision rubric: a pure CSS centering fix
adds no critical user flow). **Do NOT add a `test.fixme` stub.** Confirm the
existing watchlist/search e2e specs are **unaffected** (no locator/copy change).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to a task above.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-watchlist`, `mobile-search`, and `mobile`.
      (Tasks A, B)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; both existing `scope:mobile` slices. (Tasks A, B)
- [ ] **Component tests** as in the Test plan: the `fill-state` marker class is
      present on the empty-state in the empty/prompt/no-results branches and on
      the error-state in the error branch, on both pages; existing specs still
      green; skeleton does not carry the class. (Tasks A, B)
- [ ] **Visual verification** of centering + no-scroll on empty Watchlist and
      Search (prompt + no-results), **the non-empty scroll regression**, and the
      **error** states — via `serve-mock`, **OR** explicitly flagged UNVERIFIED
      for a human. (Tasks A, B)
- [ ] **`::part(scroll)` verified effective** (or the flex-column wrapper-div
      fallback used and noted); **skeleton state renders at the top** with no
      `fill-state` class. (Tasks A, B)
- [ ] **Verify-and-record NO change (D5):** `libs/shared/ui-kit` (both
      empty-state + error-state components and their scss), `slice:notifications`,
      `slice:title-detail`, all `scope:shared` files, `firestore.rules`,
      `firestore.indexes.json`, `sheriff.config.ts`, `.github/workflows/ci.yml`,
      `apps/mobile-e2e/playwright.config.ts`, and `firebase.json` are **NOT**
      modified.
- [ ] **No `!important`** used — override achieved via the element+class
      specificity (`vultus-empty-state.fill-state` = 0,1,1 > `:host` 0,1,0).
      (Tasks A, B)
- [ ] **Both changed lib READMEs current** (CLAUDE.md lib-README rule) —
      `libs/mobile/watchlist/README.md` and `libs/mobile/search/README.md`;
      minimal, only if the README documents layout. (Tasks A, B)
- [ ] **PR description records:** the per-slice (not shared-component) fix by
      decision (D1); the flex-fill + marker-class mechanism and **why**
      (`min-height:100%` only centers when the state is the sole child of
      `ion-content`); controls stay visible when empty (D2); error-state fixed
      alongside empty-state for consistency; and **no new Stitch screen**
      (layout-only, D4).

## Risks

- **Flex-column on `ion-content::part(scroll)` could regress normal scrolling.**
  The main risk: making the scroll container a flex column must not break the
  non-empty case (a long watchlist or results list must still scroll).
  **Mitigation:** `flex: 1 1 auto; min-height: 0` on the fill-state only (leaving
  natural-height siblings alone), plus the **explicit non-empty visual
  verification** in the Test plan / DoD.
- **`::part(scroll)` availability.** If the Ionic shadow part is unavailable or
  ineffective, the fallback is a flex-column wrapper `<div>` around the content
  region (prefer the part; the wrapper is a template change and should be a last
  resort). Noted so a reviewer expects one of the two mechanisms.
- **Marker-class specificity must beat `:host { min-height:100% }` without
  `!important`.** The element+class selector
  (`vultus-empty-state.fill-state` = 0,1,1) beats the emulated-encapsulation
  `:host` (`[_nghost-…]` = 0,1,0). Called out so a reviewer expects the class and
  does not "simplify" it to a bare element selector (which would tie 0,1,0 and
  lose on source order unpredictably).
- **No PLAN conflict.** Layout-only change to two existing `scope:mobile` slices;
  no new field/collection/dependency, no `scope:shared` change, no cross-slice
  import. Fully consistent with PLAN §3 vertical-slice (the marker-class
  duplication across two slices is expected, not a `shared/` extraction).
