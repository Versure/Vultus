---
number: 0082
slug: fix-watchlist-scroll-overflow
title: Stop the empty Watchlist page scrolling — clip the off-screen filter sheet
status: implementing
slices: [slice:watchlist]
scopes: [scope:mobile]
created: 2026-07-20
---

# Stop the empty Watchlist page scrolling — clip the off-screen filter sheet

## Context

GitHub issue #159 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reported: "When the watchlist is empty you can scroll." Spec 0076
(merged, status **done**) fixed this on **both** the Watchlist and Search pages
by making `ion-content`'s scroll part a flex column and flex-filling the
empty/error state. The reporter has now confirmed (comment dated 2026-07-20):
"This has been fixed for the search page, but not for the empty watchlist."

This spec is a **follow-up completing** 0076, **not** a rewrite of it. 0076 stays
`done` as the historical record of the centering mechanism; this is a new spec
number continuing the same underlying bug. 0076's centering mechanism is correct
and must **not** be touched or regressed — the remaining defect is orthogonal to
it.

**Confirmed via live investigation on `pnpm nx run mobile:serve-mock`
(2026-07-20), reading real DOM/CSS — not guessed:**

- **Search page (`libs/mobile/search`) — genuinely fully fixed by 0076.** The
  `ion-content` inner scroll element measured `scrollHeight === clientHeight`
  (no overflow); the empty-state centers below the searchbar. **No change needed
  on search — this spec does not touch `slice:search`.**
- **Watchlist page (`libs/mobile/watchlist`) — STILL BROKEN.** Measured
  `scrollHeight: 884` vs `clientHeight: 607` — exactly **277px** of real,
  draggable scrollable overflow. `scrollEl.scrollTop = 9999` actually lands at
  `277`, and dragging moves the empty-state box out of view — confirming the
  overflow is **exploitable**, not just a computed-style artifact. The
  empty-state box **itself is correctly centered at rest** (0076's mechanism
  works); the bug is purely that the page can still be scrolled.

**Root cause (verified, not hypothesized).** `watchlist.page.html` renders a
"Sort & Filter" bottom-sheet overlay block (added by specs 0046/0054) —
`<div class="filter-sheet">` wrapping `.filter-sheet-backdrop` and
`.filter-sheet-panel` — as an **unconditional light-DOM sibling** inside
`<ion-content>`, alongside the `ion-action-sheet` and `ion-alert` elements. Since
0076 made `ion-content`'s shadow scroll part
(`&::part(scroll) { display: flex; flex-direction: column; }`,
`watchlist.page.scss:65-68`) a flex column, **all** light-DOM children of
`ion-content` are now flex items in that scroll container — including this sheet.

The sheet's closed geometry (`watchlist.page.scss:321-364`):

- `.filter-sheet { position: absolute; inset: 0; z-index: 60; visibility: hidden;
pointer-events: none; }` — no `overflow` rule.
- `.filter-sheet-panel { position: absolute; left: 0; right: 0; bottom: 0; …;
transform: translateY(100%); }` — when closed, translated fully **below** its
  own box by its own height (**measured 277px** — exactly matching the observed
  `scrollHeight` delta). `.filter-sheet.open .filter-sheet-panel` sets
  `translateY(0)` (open position).

Even though `.filter-sheet` is `visibility:hidden; pointer-events:none` (nothing
painted or clickable when closed), the browser's **scrollable-overflow**
computation for the ancestor flex-column scroll container still includes the
post-transform bounding box of this positioned descendant. **`visibility:hidden`
does NOT exclude an element from contributing scrollable overflow** — only
`overflow:hidden`/clipping on an ancestor does. `.filter-sheet` has no `overflow`
rule, so nothing clips the off-screen-translated panel, and it leaks 277px of
extra scrollable area into `ion-content`'s scroll container.

Spec 0076's root-cause section enumerated only `.status-filter`, `.type-tabs`,
`.search-row` as the "persistent siblings" — it never considered the
filter-sheet / action-sheet / alert overlay elements as light-DOM `ion-content`
children that can contribute **scrollable overflow** while remaining fully
invisible. That is exactly why 0076's purely-visual "does it look centered" DoD
passed: the sheet is invisible, so nothing **looked** wrong. Only measuring
`scrollHeight` vs `clientHeight`, or actually dragging the scroll, reveals the
defect — which is the process fix this spec bakes into the DoD (D3).

Intended outcome: the empty Watchlist page does **not** scroll (its scroll
container's `scrollHeight === clientHeight`), the empty-state stays centered
exactly as 0076 already renders it, and a non-empty watchlist still scrolls
normally.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Fix mechanism: add `overflow: hidden` to `.filter-sheet`** in
`watchlist.page.scss` (the existing rule block at lines 321-340). Rationale:
`.filter-sheet` is `position: absolute; inset: 0` — it already exactly matches
the content-area box. `overflow: hidden` clips the off-screen-translated
`.filter-sheet-panel` **within the sheet's own bounds** instead of letting it
leak into the ancestor scroll container's scrollable-overflow region. This is a
single-property, page-scoped, purely-defensive CSS addition:

- **Zero visible-behavior change.** Closed, the sheet is already
  `visibility:hidden` (nothing painted). Open (`.filter-sheet.open`), the panel's
  `transform: translateY(0)` keeps it fully within the sheet's own `inset:0` box
  (bottom-anchored, height less than the full sheet) — so `overflow:hidden`
  **never** clips anything that should be visible, open or closed.
- **Must NOT touch/regress the 0076 centering mechanism.**
  `ion-content::part(scroll) { display: flex; flex-direction: column; }`
  (lines 65-68) and the `vultus-empty-state.fill-state` /
  `vultus-error-state.fill-state { flex: 1 1 auto; min-height: 0; }` rules
  (lines 75-79) stay **exactly** as-is. Do **NOT** modify the shared
  `vultus-empty-state` / `vultus-error-state` component code or scss (out of
  scope, same as 0076's D1).
- **No `!important`, no template restructuring.** Do NOT move the filter-sheet
  out of `ion-content`, add wrapper divs, or touch `watchlist.page.html` — this
  is the minimal, surgical, **scss-only** fix.

**D2. `ion-action-sheet` and `ion-alert`: verify-and-record only, no
speculative fix.** These are also unconditional `ion-content` children on the
watchlist page. Live investigation found **no** current evidence they contribute
scrollable overflow (open or closed) — unlike `.filter-sheet`, they don't use an
absolute + transform-off-screen pattern in this page's own CSS (Ionic's own
shadow-DOM overlay internals were not found to leak into the light-DOM scroll
container in this investigation). Per the project's "don't fix what isn't broken"
bias, do **NOT** add speculative CSS/overflow guards to these two elements.
Instead, the implementer must explicitly verify (during the D3 visual step) that
`ion-action-sheet` and `ion-alert`, in **both** their closed and briefly-opened
states, do not add to `scrollHeight` on the empty watchlist, and **record the
confirmation (with actual numbers) in the PR**. If — and only if — the
implementer finds they DO contribute, that is new information changing scope:
**flag it** to the orchestrator rather than silently patching around it.

**D3. Test-plan rigor upgrade — the key process fix, not just the code fix.**
Spec 0076's DoD required only a visual/eyeball check ("does it look centered"),
and that is exactly what let this regression ship merged-and-reported-done — the
invisible off-screen sheet caused zero visual difference. This spec's DoD / Test
plan MUST require, **in addition** to the existing eyeball centering check:

- An explicit **scripted numeric check** during `pnpm nx run mobile:serve-mock`:
  get the `ion-content` inner scroll element (the shadow-DOM `.inner-scroll`
  exposed via the documented `::part(scroll)`, per `@ionic/core` — the same
  element 0076 targeted) and assert **`scrollHeight === clientHeight`** (or a
  documented, tiny, justified sub-pixel-rounding tolerance if truly required) on
  the **EMPTY** watchlist state — via a real script run against the live rendered
  page (e.g. a console/`javascript_tool` eval during manual serve-mock
  verification), **NOT** a jsdom/Vitest assertion (CSS layout is genuinely not
  assertable there — the same limitation 0076 documented; do NOT contradict that
  by forcing a jsdom layout test).
- **Re-verify, with the same scripted check, that a NON-empty watchlist** (many
  status sections/cards) still scrolls normally — `scrollHeight > clientHeight`
  is **EXPECTED and correct** there. This is the regression risk of
  `overflow:hidden`: confirm it does **not** clip real scrollable list content,
  only the off-screen sheet.
- **Re-verify the error state and skeleton-loading state are unaffected** (the
  same states 0076's DoD covered), now **with** the numeric check.
- If serve-mock genuinely cannot run in this environment, the UI/numeric check
  MUST be explicitly flagged **UNVERIFIED for a human eyeball** — do not report
  done off a green build alone (CLAUDE.md UI-fidelity rule, same as 0076's DoD
  language).

**D4. Per-slice fix only (inherited from 0076 — do not re-litigate).**
`slice:watchlist` only. No shared `vultus-empty-state` / `vultus-error-state`
component change, no `!important`, no template restructuring (none is needed —
this is scss-only), no `scope:shared` / data-model / Firestore / functions
change, no new Stitch screen (pure layout/overflow fix — no new visual element
or copy). `slice:search`, `slice:notifications`, `slice:title-detail`,
`slice:settings` are explicitly **OUT of scope** and recorded "no change needed":
search is already fully fixed; the others were never affected by 0076 or this
bug.

**D5. No new e2e (same rubric as 0076).** A CSS overflow/clipping fix is not a
new critical user flow. Confirm the existing watchlist e2e specs are unaffected
(no locator/copy change — this spec touches no HTML, only one scss rule). Do
**NOT** add a `test.fixme` stub.

## Scope

**In scope:**

- **`slice:watchlist`:** add `overflow: hidden;` to the existing `.filter-sheet`
  rule block in `libs/mobile/watchlist/src/lib/watchlist.page.scss` (lines
  321-340). That is the only required code change.
- **README:** a minimal one-line note in `libs/mobile/watchlist/README.md` — the
  README already documents the 0076 fill-state/overflow layout contract (lines
  121-129), so extend that paragraph to note the filter-sheet is clipped so it
  cannot leak scrollable overflow. Keep it to one sentence; do not restructure
  the README.
- **Component spec:** record in `watchlist.page.spec.ts` (as a comment, not a
  fake assertion) that no new component-test assertion is meaningfully possible
  (jsdom has no layout engine — same 0076 limitation); the fix is covered by the
  D3 scripted visual verification only.

**Out of scope (verify-and-record "no change needed" per the 0076 pattern):**

- **The 0076 centering mechanism** (D1) — `ion-content::part(scroll)` flex-column
  (lines 65-68) and the `.fill-state` rules (lines 75-79) are **unchanged**.
- **Shared `vultus-empty-state` / `vultus-error-state` component or scss** (D1/D4).
- **`ion-action-sheet` / `ion-alert` overflow guards** (D2) — verify-and-record
  only; add nothing unless investigation proves they leak (then flag, don't patch).
- **`watchlist.page.html`** — no template change; scss-only fix (D1).
- **`slice:search`** — already fully fixed by 0076; not touched (D4).
- **`slice:notifications`, `slice:title-detail`, `slice:settings`** — never
  affected by this bug (D4).
- **`!important`, template restructuring, moving the sheet out of `ion-content`,
  wrapper divs** (D1).
- **Any `scope:shared`, data-model, Firestore, functions, or dependency change**
  (D4).
- **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `.github/workflows/ci.yml`, `apps/mobile-e2e/playwright.config.ts`,
  `firebase.json`** — no change (D4/D5; verify-and-record).
- **New e2e** — a CSS overflow fix adds no critical flow (D5; see Test plan).

## Affected slices & Sheriff tags

| Project          | Path                    | Sheriff tags                      | Change                                                                                                                                                                                                                                      |
| ---------------- | ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mobile-watchlist | `libs/mobile/watchlist` | `scope:mobile`, `slice:watchlist` | `watchlist.page.scss`: add `overflow: hidden;` to the existing `.filter-sheet` block (L321-340). `watchlist.page.spec.ts`: comment recording no jsdom layout test. `README.md`: one-line note (extends the existing 0076 layout paragraph). |

- **No cross-slice / cross-scope import.** Single existing `scope:mobile` slice;
  it owns its own page scss + spec + README. No new import of any kind (this is a
  one-property CSS change).
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing path
  glob already tags `libs/mobile/watchlist/src`. Record "no `sheriff.config.ts`
  change needed" in the PR.
- **No `shared/` extraction concern** — nothing shared, nothing duplicated across
  slices; the fix is confined to one page's scss (PLAN §3 vertical-slice).

## Data model touchpoints

**None.** This is a layout-only CSS change. No Firestore collection or field is
read, written, or added; no converter change. Consequently:

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**None.** No new or changed type, no `shared/domain` field, no function
signature, no HTTP endpoint, no callable. No `scope:shared` change → **no F2
shared-type ripple** (D4). The only change is a single CSS declaration added to
an existing page-local rule block.

## UI / Stitch screen refs

**Layout/overflow-only fix — no new Stitch screen and no Stitch fetch required**
(D4). No new visual element, text, icon, or font is introduced: the empty/error
copy and the "Sort & Filter" sheet's structure, spacing, type roles, radius, and
open/close animation (Stitch `#filter-sheet`, spec 0054 — the
`translateY(100%) → translateY(0)` 300ms slide) are all **unchanged**. **No new
hex** is introduced; existing `--vultus-*` token usage (authoritative set:
`docs/design/vultus-design-system.md` — do not transcribe hexes here) is
untouched. The only change is that the closed sheet's off-screen panel is now
**clipped by its own container** instead of contributing scrollable overflow.

**Layout contract (checkable — all states on the Watchlist page):**

- **Empty watchlist:** the empty-state ("Your watchlist is empty") stays
  vertically centered below the status chips / type tabs / search row **exactly
  as 0076 renders it**, AND the page does **not** scroll —
  `ion-content` inner-scroll `scrollHeight === clientHeight` (measured; was
  `884` vs `607`, must become equal).
- **Filter sheet open (`.filter-sheet.open`):** slides up and is fully visible —
  the drag handle, header (title + Done), Sort By chips, and Provider chips are
  **not** clipped (the panel sits within the sheet's `inset:0` box when open).
- **Filter sheet closed:** nothing painted (already `visibility:hidden`); the
  off-screen panel contributes **no** scrollable overflow.
- **Non-empty watchlist (regression guard):** a long, many-section/card list
  **still scrolls normally** — `scrollHeight > clientHeight` is expected and
  correct; `overflow:hidden` on `.filter-sheet` must NOT clip real list content.
- **Error state** and **skeleton-loading state:** unaffected — render as before,
  no new overflow.
- **`ion-action-sheet` / `ion-alert` (D2 verify):** in closed and
  briefly-opened states, do not add to `scrollHeight` on the empty watchlist
  (record actual numbers).

Record "no new UI element — overflow-clip fix to an existing overlay; no Stitch
capture required" in the PR.

## Implementation task graph

A **single** `scope:mobile` `slice:watchlist` task writing three files within
the slice. There is only one task and one manifest, so there is no
[parallel]/[sequential] split and **no orphan-requirement risk** (every DoD item
maps to this one task).

### Manifest assertion (for the orchestrator)

- **Task A** writes only:
  `libs/mobile/watchlist/src/lib/watchlist.page.scss`,
  `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
  `libs/mobile/watchlist/README.md`.

No `libs/mobile/watchlist/src/lib/watchlist.page.html`, `libs/mobile/search/**`,
`libs/shared/**`, `firestore.rules`, `firestore.indexes.json`,
`sheriff.config.ts`, `ci.yml`, `playwright.config.ts`, or `firebase.json` is
touched.

- **Task A — watchlist slice** (frontend-engineer). Manifest: the three files
  above.
  1. `watchlist.page.scss`: add `overflow: hidden;` inside the existing
     `.filter-sheet { position: absolute; inset: 0; z-index: 60;
visibility: hidden; pointer-events: none; … }` rule block (lines 321-340).
     Do **NOT** touch the `ion-content::part(scroll)` flex-column rule (L65-68),
     the `.fill-state` rules (L75-79), `.filter-sheet-panel` (L351-364), or any
     other rule. Do **NOT** add `!important`. Do **NOT** touch
     `watchlist.page.html`. Add a short comment noting the clip stops the
     off-screen closed panel (`translateY(100%)`, ~277px) from leaking
     scrollable overflow into `ion-content`'s flex-column scroll part (issue #159
     follow-up to spec 0076).
  2. `watchlist.page.spec.ts`: add a one-line comment recording that no new
     component-test assertion is meaningfully possible (jsdom has no layout
     engine — same 0076 limitation), and that the fix is covered by the D3
     scripted visual verification. Do **NOT** invent a fake/weak assertion.
     Existing specs stay green.
  3. `README.md`: extend the existing 0076 layout paragraph (lines 121-129) with
     one sentence noting the closed filter-sheet is clipped (`overflow:hidden`)
     so its off-screen panel cannot add scrollable overflow to `ion-content`.
  - **Visual + scripted numeric verification (D3, REQUIRED):** via
    `serve-mock` — empty (`scrollHeight === clientHeight`), non-empty
    regression (`scrollHeight > clientHeight`), error, skeleton; plus the D2
    action-sheet/alert closed+open `scrollHeight` check — OR explicitly flag
    UNVERIFIED for a human.

## Test plan

Per the PLAN §5 pyramid. Component/unit tests run on **Vitest + Analog**; no live
Firebase, no emulator, no network, no secrets.

**Component — `watchlist.page.spec.ts` (Vitest + Analog):**

- **No new component-test assertion.** CSS-computed scroll-overflow behavior is
  **NOT** assertable in jsdom/Vitest (no real layout engine — the same limitation
  0076 documented; do not contradict it by forcing a jsdom layout test). Record
  this as a comment in the spec file; do **not** add a fake/weak assertion. The
  existing watchlist component specs (including 0076's `fill-state` marker-class
  presence checks) must stay green — this scss-only change touches no DOM.

**Rendered-text (F3):** **not applicable** — no copy/text change at all (CSS-only).
No new exact-string assertion is added, and no existing one is weakened (do not
whitespace-normalize any existing rendered-text assertion).

**Visual + scripted numeric verification (REQUIRED — D3; a green build does NOT
prove the layout).** Via `pnpm nx run mobile:serve-mock`, get the `ion-content`
inner scroll element (`::part(scroll)` → `.inner-scroll`, `@ionic/core`) and run
a real scripted check on the live page:

- (a) **Empty watchlist** → empty-state centered below the chips/tabs/search row
  **and** `scrollHeight === clientHeight` (was `884` vs `607`; must be equal — a
  tiny, documented sub-pixel tolerance only if rounding truly requires it), and a
  `scrollEl.scrollTop = 9999` no-op (lands at `0`, not `277`).
- (b) **Filter sheet:** open it → the panel + all its contents are fully visible,
  **not** clipped; close it → no scrollable overflow returns.
- (c) **Non-empty regression:** a long watchlist (many status sections/cards)
  **still scrolls normally** — `scrollHeight > clientHeight` (expected/correct);
  `overflow:hidden` must not clip real list content.
- (d) **Error** state and **skeleton-loading** state → unaffected, no overflow.
- (e) **D2 verify-and-record:** `ion-action-sheet` and `ion-alert`, in closed and
  briefly-opened states, do **not** add to `scrollHeight` on the empty
  watchlist; **record the actual numbers** in the PR. If they DO contribute,
  **flag it** (new scope) rather than patching.

If the implementer cannot run `serve-mock`, the UI/numeric check **must** be
explicitly flagged **UNVERIFIED for a human eyeball** — do **NOT** report it done
off a green build (D3).

**e2e (Playwright):** **No new e2e flow required — CSS overflow/clipping fix, no
new route or critical action** (D5; e2e decision rubric: a clipping fix adds no
critical user flow). **Do NOT add a `test.fixme` stub.** Confirm the existing
watchlist e2e specs are **unaffected** — this spec changes no HTML, no locator,
no copy (scss-only), so no e2e locator/assertion can break. Note the e2e gate
runs in CI / the user's terminal, not in-session (emulator limitation).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to Task A above.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-watchlist` (and `mobile`). (Task A)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; single existing `scope:mobile` slice; no
      `sheriff.config.ts` change. (Task A)
- [ ] **`overflow: hidden` added to the `.filter-sheet` block** in
      `watchlist.page.scss` (L321-340) — and nothing else in scss changed;
      **the 0076 mechanism is untouched** (`ion-content::part(scroll)` flex-col
      L65-68 and the `.fill-state` rules L75-79 are verbatim). No `!important`;
      `watchlist.page.html` unchanged. (Task A)
- [ ] **Scripted numeric verification (D3)** on the **empty** watchlist:
      `scrollHeight === clientHeight` (was `884` vs `607`) via serve-mock — **OR**
      explicitly flagged UNVERIFIED for a human. (Task A)
- [ ] **Non-empty regression verified (D3):** a long watchlist still scrolls
      (`scrollHeight > clientHeight`); `overflow:hidden` did not clip real list
      content. Error + skeleton states re-verified unaffected. (Task A)
- [ ] **Filter sheet still opens fully** (open → panel + contents not clipped;
      closed → no overflow). (Task A)
- [ ] **D2 verify-and-record:** `ion-action-sheet` and `ion-alert` do not add to
      `scrollHeight` (closed + briefly-opened), with the **actual numbers**
      recorded in the PR; if they DO, flagged as new scope — not patched. (Task A)
- [ ] **No new/weak component test** — recorded as a comment that jsdom cannot
      assert layout (0076 limitation); no fake assertion; existing specs green.
      (Task A)
- [ ] **No new e2e; no `test.fixme`** — existing watchlist e2e unaffected (no
      HTML/locator/copy change). (D5)
- [ ] **Verify-and-record NO change:** the shared `vultus-empty-state` /
      `vultus-error-state` components + scss, `libs/mobile/search/**`,
      `slice:notifications`, `slice:title-detail`, `slice:settings`, all
      `scope:shared` files, `firestore.rules`, `firestore.indexes.json`,
      `sheriff.config.ts`, `.github/workflows/ci.yml`,
      `apps/mobile-e2e/playwright.config.ts`, and `firebase.json` are **NOT**
      modified. (Task A)
- [ ] **`libs/mobile/watchlist/README.md` current** (CLAUDE.md lib-README rule) —
      the existing 0076 layout paragraph extended with the one-line
      filter-sheet-clip note. (Task A)
- [ ] **PR description records:** the root cause (closed `.filter-sheet-panel`
      `translateY(100%)` off-screen ~277px leaking scrollable overflow into
      0076's flex-column `::part(scroll)`, because `visibility:hidden` does not
      exclude scrollable overflow); the single-property `overflow:hidden` fix
      (D1); the D3 numeric-check process upgrade over 0076's eyeball-only DoD; the
      D2 action-sheet/alert verify result with numbers; and references this spec
      (0082) as the follow-up to 0076 / issue #159.

## Risks

- **`overflow: hidden` could clip something that should show.** The main risk is
  clipping either real scrollable list content or the **open** sheet.
  **Mitigation:** `.filter-sheet` is `position:absolute; inset:0` (exactly the
  content box) and holds only the sheet; the open panel sits within that box
  (`translateY(0)`, bottom-anchored, height < full sheet), and the scrollable
  **list** lives in sibling `.status-section` nodes, not inside `.filter-sheet` —
  so the clip cannot reach list content. Confirmed by the D3 **non-empty
  regression** check (`scrollHeight > clientHeight` must still hold) and the
  **sheet-open** visual check.
- **Other invisible `ion-content` children could also leak overflow.** `ion-action-sheet`
  and `ion-alert` are the other unconditional siblings. **Mitigation:** D2 requires
  explicitly measuring their `scrollHeight` contribution (closed + open) and
  recording it; investigation found no leak, but the measurement — not an
  assumption — is the gate. If one leaks, it is flagged as new scope, not silently
  patched.
- **Regression could reappear if 0076's mechanism is later changed.** The clip is
  defensive against the flex-column `::part(scroll)`; a future refactor of that
  part should re-run the D3 numeric check. Noted for the reviewer; the README note
  documents the coupling.
- **No PLAN conflict.** A one-property, page-scoped CSS change to one existing
  `scope:mobile` slice; no new field/collection/dependency, no `scope:shared`
  change, no cross-slice import. Fully consistent with PLAN §3 vertical-slice.
