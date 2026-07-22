---
number: 0093
slug: fix-detail-action-button-sizing
title: Equalize the untracked title-detail action buttons — reset the `ion-button` host box-model so both flex siblings render the same width
status: done
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-07-22
---

# Equalize the untracked title-detail action buttons — reset the `ion-button` host box-model so both flex siblings render the same width

## Context

GitHub issue #251 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "On the detail page of a tv show or movie theres a add to
watchlist and mark as watched button, the add to watchlist button is larger than
the mark as watched button. They should be equal in size and remain
side-by-side."

On the title-detail page (`slice:title-detail`), in the **untracked** state
(`vm.tracked === null`), the action area renders two side-by-side buttons that
are **meant to be equal-width halves of one flex row** — but they render at
**different widths**. This is a layout-parity regression/oversight, not a new
design ask: the existing SCSS comment above `.mark-watched-cta` already documents
the intent ("Same 56px height as the sibling `.add-cta` so the two align in the
`.action-area` flex row").

**Current markup** (`libs/mobile/title-detail/src/lib/title-detail.page.html`,
L87-107, inside the `@if (vm.tracked === null)` branch of `.action-area`):

```html
<div class="action-area" data-test="action-area">
  @if (vm.tracked === null) {
  <ion-button
    expand="block"
    color="primary"
    class="add-cta"
    data-test="add-btn"
    (click)="addToWatchlist(detail)"
  >
    <ion-icon name="add-circle-outline" slot="start"></ion-icon>
    Add to Watchlist
  </ion-button>
  <button
    type="button"
    class="mark-watched-cta"
    data-test="mark-watched-btn"
    (click)="markAsWatched(detail)"
  >
    <ion-icon name="checkmark-circle"></ion-icon>
    Mark as Watched
  </button>
  } @else { ... }
</div>
```

**Current CSS** (`libs/mobile/title-detail/src/lib/title-detail.page.scss`):

```scss
.action-area {
  display: flex;
  flex-direction: row;
  gap: var(--vultus-space-md);
}

// L288-294
.add-cta {
  flex: 1;
  height: 56px;
  --border-radius: var(--vultus-radius-md);
  font-weight: 700;
  --color: var(--ion-color-primary-contrast);
}

// L301-303 — "Mark as Watched", the untracked action-area's second,
// outlined-primary affordance. "Same 56px height as the sibling .add-cta so the
// two align in the .action-area flex row."
.mark-watched-cta {
  @extend %outlined-primary-cta; // -> flex:1 (from %outlined-primary-cta itself); height:56px (from %outlined-primary-control)
}
```

Both siblings declare `flex: 1; height: 56px` inside the same
`.action-area { display: flex; flex-direction: row; }` row, so they _should_
share the row equally.

**Root cause (static-analysis hypothesis; NOT yet confirmed via live DevTools
measurement).** During spec authoring a live DOM measurement was not possible —
the repo's Firestore-emulator / browser-automation limitation in this
environment (CLAUDE.md), plus a port conflict with another concurrent session's
dev server, prevented a live measurement. The evidence-supported hypothesis:

- `.add-cta` is an `ion-button` — a **web-component host** — while
  `.mark-watched-cta` is a plain `<button>`. Both are `flex: 1` siblings in the
  same flex row.
- Ionic's core CSS applies a **non-zero default host `margin`** (`margin-inline`)
  to `ion-button`. This margin is **not** reset anywhere in
  `title-detail.page.scss` **nor** in the shared `libs/shared/ui-kit/src/lib/theme.scss`
  (both were checked — no global `ion-button` margin reset exists).
- A plain `<button>` has no such margin (only what `%outlined-primary-control`
  sets, which is none horizontally).
- Two flex siblings with identical `flex: 1` but different `margin` end up with
  **different rendered box widths**: the browser subtracts each item's own margin
  from the space it is allotted before growing/shrinking. Ionic's default
  `margin-inline` on the `ion-button` host therefore shrinks `.add-cta`'s
  effective box relative to `.mark-watched-cta`, making `.add-cta` render
  **narrower** — **not wider** as the issue text says (see Risks: the issue's
  "larger/smaller" labeling may be inverted from the actual rendering, or there
  may be an additional factor; the fix makes both equal regardless of which one
  is currently bigger).
- `expand="block"` only forces the ion-button's internal shadow-DOM
  `.button-native` part to fill 100% width **of the host** — it does **not**
  remove or offset the host's own default margin.

No shared button atom exists in `libs/shared/ui-kit` (checked: only
`empty-state`, `error-state`, `skeleton-card`, `skeleton-hero`, `theme.scss`,
`sync-state.service.ts` — no button component). Both buttons are bespoke,
slice-local markup fully contained in `libs/mobile/title-detail`.

**Intended outcome:** in the untracked state, "Add to Watchlist" and "Mark as
Watched" render as **equal-width** halves of the `.action-area` row, both 56px
tall, side-by-side — matching the already-documented design intent.

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1. Fix mechanism: reset the `ion-button` host box-model on `.add-cta`; keep it
an `ion-button`.** Do **not** convert `.add-cta` to a plain `<button>` — preserve
Ionic's built-in ripple / accessibility. Fix by resetting the `ion-button` host's
default box-model contributor(s) directly on the existing `.add-cta` rule in
`title-detail.page.scss`, **starting with `margin: 0`** (Ionic's default non-zero
host margin is the identified culprit), so `.add-cta`'s outer flex-item box
computes **identically** to `.mark-watched-cta`'s under the shared `flex: 1` in
`.action-area`. This is a minimal, **CSS-only, single-slice, single-file** diff —
no template/markup change, no new component, no `shared/ui-kit` change.

- **If a live DOM/DevTools measurement during implementation reveals `margin: 0`
  alone does not fully equalize the widths** (e.g. a residual host
  `padding` / `min-width` / `box-sizing` difference), the implementer should
  **widen the reset only as far as needed** — e.g. add `box-sizing: border-box`
  or `padding: 0` on the host — **still scoped to the `.add-cta` rule**, **never
  `!important`**, and **never touching** `.mark-watched-cta`'s or
  `%outlined-primary-cta`'s / `%outlined-primary-control`'s existing declarations.

**D2. No new automated test (component or e2e).** jsdom has **no layout engine**,
so a component test cannot assert real rendered widths (documented precedent:
specs 0082, 0087). This is a **cosmetic layout-parity** bug, not a functional
break (both buttons already work); per the project's e2e rubric a
critical-user-facing-action bar does **not** apply here, so **no new Playwright
e2e** is required, and the existing `test.fixme`-gated
`apps/mobile-e2e/src/mark-watched.spec.ts` must **NOT** be unblocked or modified
(different, unrelated blocker — out of scope). Instead the Definition of Done
requires a **live serve-mock verification** (D-below):

- Via `pnpm nx run mobile:serve-mock`, navigate to a title-detail page in the
  **untracked** state (`vm.tracked === null`), and take a real DOM measurement
  (`getBoundingClientRect()`) of **both** `.add-cta` and `.mark-watched-cta`,
  confirming their rendered **widths match** (and heights still both 56px).
  Record the **before/after** measurements in the PR body.
- **If serve-mock cannot be run** in the implementer's environment, explicitly
  flag **"UNVERIFIED for a human eyeball"** per CLAUDE.md's UI-fidelity rule — do
  **not** report done off a green build alone.

**D3. Scope: `slice:title-detail` only.** No `scope:shared` / `libs/shared/ui-kit`
change (no shared button atom exists to touch). No cross-slice import. No
Firestore / data-model change, no `firestore.rules` / `firestore.indexes.json`
change, no `sheriff.config.ts` change (the existing path glob already tags
`libs/mobile/title-detail/src` as `scope:mobile`, `slice:title-detail`). **No
`User` domain field is added or changed → the F4 onboarding-parity rule does not
apply** (this is a pure presentation fix; no persisted preference).

**D4. No new Stitch screen fetch required.** This restores an
already-specified/intended visual parity (the existing SCSS comment above
`.mark-watched-cta` documents the original intent that the two buttons align in
the flex row) — it is **not** introducing a new visual element, spacing, color,
or copy. No new hex; the existing `--vultus-*` / `--ion-*` token usage in
`%outlined-primary-control` / `.add-cta` is untouched (only the host box-model
reset is added).

## Scope

**In scope (`slice:title-detail`, one file):**

- **`libs/mobile/title-detail/src/lib/title-detail.page.scss`** — add the
  `ion-button` **host box-model reset** to the existing `.add-cta` rule (L288-294),
  starting with `margin: 0` and widening only as far as needed (D1) so `.add-cta`'s
  flex-item box matches `.mark-watched-cta`'s. Add a short comment explaining why
  (Ionic's default `ion-button` host `margin-inline` breaks equal-width flex
  siblings — issue #251). Do **not** alter `.mark-watched-cta`,
  `%outlined-primary-cta`, `%outlined-primary-control`, `.action-area`, or any
  other rule. No `!important`.

**Out of scope (verify-and-record "no change needed"):**

- `title-detail.page.html` — **no template/markup change** (the buttons keep
  their tags, classes, `data-test` hooks, and `expand="block"`).
- `title-detail.page.ts` and `title-detail.page.spec.ts` — **no change** (no new
  automated test — D2).
- The **tracked** branch of `.action-area` (`.status-control`, `.remove-control`)
  and the `.movie-watched-control` toggle — unchanged.
- `%outlined-primary-cta` / `%outlined-primary-control` / `%inline-center` /
  `%font` placeholders and `.mark-watched-cta` — unchanged (the fix touches only
  `.add-cta`).
- `libs/shared/ui-kit/**` (`theme.scss`, `empty-state`, `error-state`, skeletons)
  — unchanged; **no shared button atom is created** (none exists; D3).
- `apps/mobile-e2e/src/mark-watched.spec.ts` — **NOT** unblocked or modified
  (unrelated `test.fixme` blocker — D2). `apps/mobile-e2e/src/title-detail.spec.ts`
  references neither button — unchanged.
- Any `scope:shared`, data-model, Firestore, or functions change.
- `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
  `apps/mobile-e2e/playwright.config.ts`, `firebase.json`.
- Any new Stitch screen fetch (no new visual element, spacing, color, or copy —
  D4).
- `!important`; converting `.add-cta` from `ion-button` to a plain `<button>`
  (D1 keeps it an `ion-button`).

## Affected slices & Sheriff tags

| Project             | Path                       | Sheriff tags                         | Change                                                                                                                                                       |
| ------------------- | -------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mobile-title-detail | `libs/mobile/title-detail` | `scope:mobile`, `slice:title-detail` | `title-detail.page.scss`: add `ion-button` host box-model reset (`margin: 0`, widen only if measurement requires) to the `.add-cta` rule. Only file changed. |

- **No cross-slice / cross-scope import.** A single existing `scope:mobile` slice
  owns its page scss; nothing is imported from another slice.
- **No `sheriff.config.ts` change.** No new lib, no new tag; the existing path
  glob already tags `libs/mobile/title-detail/src`. Record "no `sheriff.config.ts`
  change needed" in the PR.
- **No `shared/` extraction concern** — nothing shared or duplicated across
  slices; no shared button atom exists (and the "extract only at 3+ slices" rule
  does not trigger here). The fix is confined to one page's scss (PLAN §3
  vertical-slice).
- **Affected Nx build graph:** `nx affected -t <target> --base=main` will include
  `mobile-title-detail`, `mobile`, and (via the build graph) possibly `mobile-e2e`
  — even though no e2e file changes.

## Data model touchpoints

**None.** This is a CSS-only presentation fix. No Firestore collection or field
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
`@vultus/mobile/title-detail` is unchanged.

## UI / Stitch screen refs

**CSS-only fix restoring already-specified equal-width parity — no new Stitch
screen and no Stitch fetch required** (D4). The title-detail page is the existing
Stitch "Movie Detail - Vultus" screen (**208cb8d7a679490b8d13672c6943d6d3**, per
the `title-detail.page.scss` header comment and spec 0016) with the untracked
single-filled-primary-CTA + outlined-secondary treatment (spec 0016 FIX-1, spec
0056). No new visual element, text, icon, font, spacing, radius, or color is
introduced. No new hex; the authoritative token set lives at
`docs/design/vultus-design-system.md` (primary Emerald `#4edea3`, wired via
`theme.scss`) and is **not** transcribed here — the existing `--vultus-*` /
`--ion-*` usage on `.add-cta` / `%outlined-primary-control` is untouched.

**Interactive-state contract (checkable — the untracked `.action-area` on the
title-detail page; verify all via the D2 serve-mock measurement):**

- **Layout (the fix):** in the untracked state (`vm.tracked === null`),
  `.add-cta` and `.mark-watched-cta` are **equal-width** halves of the
  `.action-area` flex row (each `flex: 1`, matching rendered
  `getBoundingClientRect().width`), **both 56px tall**, side-by-side with the
  `var(--vultus-space-md)` gap between them. Neither wraps to a second line.
- **`.add-cta` (filled, `ion-button color="primary"`):** default = filled Emerald
  with `--color: var(--ion-color-primary-contrast)`, `--border-radius:
var(--vultus-radius-md)`, weight 700, leading `add-circle-outline` icon,
  "Add to Watchlist"; Ionic-native ripple + focus/active states preserved
  (unchanged — the fix only zeroes the host margin). Height 56px.
- **`.mark-watched-cta` (outlined, plain `<button>` via `%outlined-primary-cta`):**
  default = transparent bg, `2px solid var(--ion-color-primary)` border,
  `var(--ion-color-primary)` text, weight 700, `checkmark-circle` icon,
  "Mark as Watched"; **hover** = `background: color-mix(in srgb,
var(--ion-color-primary) 10%, transparent)`; **active** = `transform:
scale(0.98)`; `transition: background 120ms ease, transform 80ms ease`. Height
  56px. All unchanged by this fix.

Record "no new UI element — host-box-model reset restoring existing equal-width
intent; no Stitch capture required" in the PR.

## Implementation task graph

**One task, one file.** Only `title-detail.page.scss` changes, so there is no
`[parallel]` / `[sequential]` split — a single frontend-engineer task. No
`shared/domain` / new-slice / root-config prerequisite exists.

### Task — title-detail action-button width parity (frontend-engineer)

Manifest — writes **only**:

- `libs/mobile/title-detail/src/lib/title-detail.page.scss`

Steps:

1. In `title-detail.page.scss`, add the `ion-button` **host box-model reset** to
   the existing `.add-cta` rule (L288-294): start with **`margin: 0;`**. Add a
   short comment: the reset zeroes Ionic's default non-zero `ion-button` host
   `margin-inline`, which otherwise shrinks this flex item relative to the plain
   `<button>` sibling `.mark-watched-cta` and breaks their equal-width `flex: 1`
   share (issue #251). Do **not** touch `.mark-watched-cta`,
   `%outlined-primary-cta`, `%outlined-primary-control`, or `.action-area`.
2. **Live-measure on serve-mock** (D2): navigate to an untracked title-detail
   page and read `getBoundingClientRect()` on both `.add-cta` and
   `.mark-watched-cta`. If widths now match and both are 56px tall — done.
3. **If `margin: 0` alone does not equalize the widths** (residual host
   `padding` / `min-width` / `box-sizing` difference — see Risks): widen the reset
   **only as far as needed**, still scoped to the `.add-cta` rule (e.g. add
   `box-sizing: border-box` and/or `padding: 0` on the host). **Never** `!important`,
   **never** modify `.mark-watched-cta` / the placeholders. This is the spec-0087
   escalation pattern: broaden the box-model reset, do **not** escalate for a full
   rethink — the host-box-model mechanism is the correct lever even if the exact
   culprit property needs adjusting.
4. Record the **before/after** `getBoundingClientRect()` widths in the PR body —
   or explicitly flag **UNVERIFIED for a human eyeball** if serve-mock cannot run
   (D2).

## Test plan

Per the PLAN §5 pyramid.

**Unit / component (Vitest + Analog):** **No new test, and no test change** (D2).
jsdom has **no layout engine**, so a component test cannot assert the rendered
widths this fix changes (documented precedent: specs 0082, 0087). Do **not**
invent a fake layout assertion. The existing `title-detail.page.spec.ts`
presence + click-behavior tests for `[data-test="add-btn"]` and
`[data-test="mark-watched-btn"]` remain valid and untouched — confirm they stay
green (the CSS-only diff changes no markup, class, `data-test` hook, or copy they
depend on).

**Rendered-text (F3):** **not applicable** — no copy/text change (CSS-only). No
new exact-string assertion is added and no existing one is weakened; do **not**
whitespace-normalize any existing rendered-text assertion.

**e2e (Playwright):** **Not required — cosmetic layout-parity fix, not a
new/changed navigation route or critical action** (both buttons already function;
per the e2e decision rubric a critical-user-facing-action bar does not apply to a
pure width-parity fix). **No new e2e flow is added.** The existing
`test.fixme`-gated `apps/mobile-e2e/src/mark-watched.spec.ts` is **NOT** unblocked
or modified (unrelated blocker — D2, out of scope);
`apps/mobile-e2e/src/title-detail.spec.ts` references neither button and is
unchanged. Confirm the affected-e2e set still builds/passes unchanged in CI.

**Manual (D2, REQUIRED gate):** live serve-mock DOM measurement of both buttons'
`getBoundingClientRect()` in the untracked state — widths equal, both 56px tall —
before/after recorded in the PR body, or flagged UNVERIFIED for a human.

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to the single Task.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green —
      affected set is `mobile-title-detail`, `mobile`, and (build graph)
      `mobile-e2e`. (Task)
- [ ] **Sheriff clean** (in the lint above): no new import, no cross-slice /
      cross-scope edge; single existing `scope:mobile` slice; no
      `sheriff.config.ts` change. (Task)
- [ ] **`ion-button` host box-model reset applied** to the `.add-cta` rule in
      `title-detail.page.scss` (starting with `margin: 0`, widened only as far as
      a live measurement requires — D1), with an explanatory comment referencing
      issue #251; **no `!important`**; `.add-cta` stays an `ion-button` (not
      converted to a plain `<button>`). (Task)
- [ ] **No change** to `.mark-watched-cta`, `%outlined-primary-cta`,
      `%outlined-primary-control`, `.action-area`, or any other scss rule; **no
      template change** to `title-detail.page.html`; **no** `title-detail.page.ts`
      / `title-detail.page.spec.ts` change. (Task)
- [ ] **Existing component specs green** — the presence + click tests for
      `[data-test="add-btn"]` / `[data-test="mark-watched-btn"]` still pass
      unchanged; no fake jsdom layout assertion added. (Task)
- [ ] **D2 serve-mock measurement** recorded: untracked title-detail page,
      `getBoundingClientRect()` of `.add-cta` and `.mark-watched-cta` show **equal
      widths** and **both 56px tall**, before/after in the PR body — OR explicitly
      flagged **UNVERIFIED for a human eyeball**. (Task)
- [ ] **Verify-and-record NO change:** `libs/shared/ui-kit/**` (no shared button
      atom created), the tracked-branch controls (`.status-control`,
      `.remove-control`, `.movie-watched-control`), all other slices,
      `firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`,
      `apps/mobile-e2e/**` (incl. the `test.fixme`-gated `mark-watched.spec.ts`,
      **not** unblocked), `playwright.config.ts`, and `firebase.json` are **NOT**
      modified. (Task)
- [ ] **PR description records:** the root cause (Ionic's default `ion-button`
      host `margin-inline`, unreset in this file and `theme.scss`, shrinks
      `.add-cta`'s `flex: 1` box relative to the plain-`<button>`
      `.mark-watched-cta`); the D1 fix (host box-model reset on `.add-cta`); the
      final property set used if `margin: 0` alone was insufficient; and the D2
      before/after width measurements. References this spec (0093) / issue #251.

## Risks

- **"Larger vs smaller" labeling discrepancy in the issue.** Issue #251 says
  "Add to Watchlist" is _larger_ than "Mark as Watched"; the host-margin
  hypothesis predicts `.add-cta` renders **narrower** (Ionic subtracts the host
  `margin-inline` from the flex item's box), i.e. the **opposite** direction.
  **Mitigation:** the fix target is **equal width for both buttons**, which
  resolves the issue **regardless** of which one is currently larger. The
  implementer's live measurement (D2) is the ground truth and must be recorded
  **even if it contradicts the issue's stated direction** — if it does, note the
  discrepancy in the PR rather than "correcting" the fix.
- **Root cause is a static-analysis hypothesis, not yet DevTools-confirmed.** The
  Ionic-default-`ion-button`-host-margin explanation is well-supported (uncontested
  by any override in `title-detail.page.scss` or the shared `theme.scss`, both
  checked) but was **not** confirmed by live DevTools inspection during spec
  authoring (environment limitation — emulator/browser-automation blocked, plus a
  dev-server port conflict). **Mitigation (same escalation pattern as spec 0087):**
  if the implementer's live serve-mock measurement (D2) shows `margin: 0` does
  **not** equalize the widths, **broaden the box-model reset** (`box-sizing`
  and/or `padding: 0`, still scoped to `.add-cta`, still no `!important`) rather
  than escalating for a full rethink — the host-box-model reset is very likely the
  correct mechanism even if the exact culprit property needs adjusting. Only if a
  broadened host reset **still** cannot equalize the two boxes should the
  implementer STOP and flag it to the orchestrator as scope-changing new
  information.
- **No PLAN conflict.** A CSS-only fix to one existing `scope:mobile` slice; no
  new field/collection/dependency, no `scope:shared` change, no cross-slice
  import, no `User` field (F4 N/A). Fully consistent with PLAN §3 vertical-slice
  and the "no shared extraction below 3 slices" rule (no shared button atom is
  introduced).
  </content>

</invoke>
