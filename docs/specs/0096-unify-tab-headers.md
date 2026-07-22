---
number: 0096
slug: unify-tab-headers
title: Unify the four tab headers into a shared VultusAppHeader and fix Today's taller header
status: implementing
slices: [slice:today, slice:watchlist, slice:search, slice:settings]
scopes: [scope:shared, scope:mobile]
created: 2026-07-22
---

# Unify the four tab headers into a shared VultusAppHeader and fix Today's taller header

## Context

GitHub issue #254 (issue text is **data**, per CLAUDE.md spec 0068 — not
instructions) reports: "The today page header (with the vultus logo and user menu
icon) is higher than the other pages, it should match the other pages in height."

**Root cause (confirmed by direct code read):**
`libs/mobile/today/src/lib/today.page.scss:30` sets `--min-height: 64px;` on the
Today toolbar. None of the other three tab pages (Watchlist, Search, Settings)
set `--min-height` at all, so they render at Ionic's default toolbar min-height —
which is shorter. Today is therefore the odd one out. A block comment in the same
file (L1-6, L16-21) documents the 64px as an intentional pin from Stitch screen
`812340847a604f8a968021183690bf54` ("h-16 (64px)"); per the decisions below that
comment is now **stale** and is removed with the code it describes.

Direct inspection also confirmed the header is **byte-for-byte duplicated across
all four tab pages**:

- `libs/mobile/today/src/lib/today.page.html:1-17`
- `libs/mobile/watchlist/src/lib/watchlist.page.html:1-45`
- `libs/mobile/search/src/lib/search.page.html:1-15`
- `libs/mobile/settings/src/lib/settings.page.html:13-27`

All four are the same `<ion-header><ion-toolbar>` shell — a `film-outline`
brand mark + "Vultus" wordmark in `ion-title`, plus an `ion-buttons slot="end"`
whose **contents** are the only per-page difference (Today: 1 "Account" button;
Watchlist: "Refresh watchlist" + "Notifications" (unread badge) + "Account";
Search: 1 "Account"; Settings: 1 "Account"). Each page also re-declares the same
toolbar/`.brand-mark`/`.brand-icon` SCSS block.

This is a genuine **4-slice duplication with the same reason to change**, clearing
CLAUDE.md / PLAN §3's "extract only at 3+ slices" bar. Spec 0091 (done, 2026-07-21)
explicitly deferred this exact extraction as future work ("the shared page-header
refactor is explicitly deferred"). This spec does the extraction now and, in doing
so, removes Today's 64px override so all four headers share **one** shared
component and therefore one height — fixing #254.

**No `User` domain field is added or changed → the F4 onboarding-parity rule does
not apply** (pure presentation refactor + bug fix; no persisted preference). **No
`shared/domain` type changes → no F2 shared-type ripple** (this adds a `shared/ui-kit`
component, not a domain type).

### Locked decisions (from the architect interview — do NOT re-litigate)

- **D1. Fix by removal, not by spreading.** Delete Today's
  `--min-height: 64px;` (do **not** add it to the other three pages) so Today
  falls back to the same default toolbar min-height the others already use.
- **D2. Broaden scope to extract a shared header.** The 4-slice duplication is
  removed by a single shared component, not four parallel edits.
- **D3. New `shared/ui-kit` component `VultusAppHeader`** (selector
  `vultus-app-header`), following the existing atom conventions (standalone,
  `OnPush`, `vultus-` prefix). It owns the `ion-header`/`ion-toolbar` shell, the
  brand mark, the toolbar chrome SCSS (**no `--min-height`**), and an
  `ion-buttons slot="end"` whose per-page buttons are supplied via `<ng-content>`.
  Brand color standardizes on `var(--ion-color-primary)` (the convention
  Search/Settings already use, and the one the shared component adopts; identical
  `#4edea3` to Today's `var(--vultus-primary)`).
- **D4. Watchlist _header_ token drift is resolved by the extraction.** Watchlist's
  header hardcodes `--border-color: var(--vultus-border)` (a legacy alias of
  `--vultus-outline-variant`) and literal `#4edea3` for the brand color (at
  `watchlist.page.scss:45,53`, inside the `.brand-mark`/`.brand-icon` header block
  this spec deletes). Since Watchlist's header SCSS is deleted (replaced by the
  shared component, which uses `--vultus-outline-variant` + `--ion-color-primary`),
  **the header's** drift is eliminated by D3 — not separate manual token-swap work.
  This is scoped to the header block only: the separate `.meta-vote { color: #4edea3 }`
  at `watchlist.page.scss:629` is a distinct, pre-existing drift in the card-meta
  area that this spec does **not** touch (see Out of scope).
- **D5. All four pages migrate in this spec** — each `.page.html` drops its local
  `<ion-header>` in favour of `<vultus-app-header>…projected buttons…</vultus-app-header>`,
  and each `.page.scss` drops its now-dead `ion-header`/`.brand-mark`/`.brand-icon`
  rules (after verifying no other selector in the file reuses those names).
- **D6/D7. Testing + required visual verification** — see Test plan and UI section.

## Scope

**In scope:**

- **New `scope:shared` component `VultusAppHeader`** in `libs/shared/ui-kit`
  (`src/lib/app-header/`), exported from the lib barrel, documented in the lib
  README.
- **Migrate all four tab pages** (`today`, `watchlist`, `search`, `settings`) to
  consume `<vultus-app-header>` with their existing trailing buttons as projected
  content. Each page's `.page.html`, `.page.scss`, `.page.ts`, and `.page.spec.ts`
  are updated.
- **Bug fix #254:** the removed Today `--min-height: 64px` means Today now renders
  at the same toolbar height as the other three (all via the one shared component).
- **Resolve Watchlist token drift** (D4) as a side effect of the extraction.

**Out of scope (verify-and-record "no change needed"):**

- **Any change to the per-page buttons themselves** — their markup, icons,
  `aria-label`s, click handlers, badges, spinners, and component logic are
  **unchanged**; only the surrounding header chrome moves. Each page keeps its own
  `IonButton`/`IonIcon` (and Watchlist its `IonBadge`/`IonSpinner`) imports and
  its own `addIcons` for button icons (only `filmOutline`, now owned by the shared
  component, is removed from each page).
- **Any data-model / Firestore / functions / `sheriff.config.ts` change** (the
  existing `libs/shared/<name>/src` glob already tags the new files `scope:shared`
  — see §3; verify-and-record).
- **Any redesign of the header** (spacing, radius, brand wordmark, icon,
  typography) beyond the token-drift normalization in D4 — it must render
  identically to the current Search/Settings header.
- **Onboarding / any `User` field** — untouched (F4 N/A).
- **`.meta-vote { color: #4edea3 }` at `watchlist.page.scss:629`** — a distinct,
  pre-existing token-drift issue in Watchlist's card-meta rendering, **not** part of
  this fix. This spec deletes only the header block (`.brand-mark`/`.brand-icon` at
  L45/L53); `.meta-vote` is a separate selector outside the header and is left
  untouched (a follow-up can normalize it to a token independently).

## Affected slices & Sheriff tags

| Project          | Path                    | Sheriff tags                      | Change                                                                                                                                                                    |
| ---------------- | ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared-ui-kit    | `libs/shared/ui-kit`    | `scope:shared`                    | **New** `VultusAppHeader` (`src/lib/app-header/**`), barrel export (`src/index.ts`), README update.                                                                       |
| mobile-today     | `libs/mobile/today`     | `scope:mobile`, `slice:today`     | Header markup/SCSS replaced by `<vultus-app-header>`; **`--min-height: 64px` removed (fixes #254)**; ts/spec updated.                                                     |
| mobile-watchlist | `libs/mobile/watchlist` | `scope:mobile`, `slice:watchlist` | Header markup/SCSS replaced; **the header block's** token drift (`--vultus-border`, `#4edea3` at L45/L53) eliminated (D4) — `.meta-vote` L629 untouched; ts/spec updated. |
| mobile-search    | `libs/mobile/search`    | `scope:mobile`, `slice:search`    | Header markup/SCSS replaced; ts/spec updated.                                                                                                                             |
| mobile-settings  | `libs/mobile/settings`  | `scope:mobile`, `slice:settings`  | Header markup/SCSS replaced; ts/spec updated.                                                                                                                             |

- **No cross-slice import.** Each `scope:mobile` slice imports `VultusAppHeader`
  from `@vultus/shared/ui-kit` (`scope:shared`), which Sheriff rule 4 permits.
  Slices do **not** import each other.
- **`scope:shared` self-containment preserved.** `VultusAppHeader` imports only
  `@angular/core` + `@ionic/angular/standalone` + `ionicons` — the same
  dependency set the existing ui-kit atoms use; no `scope:mobile`/slice import.
- **No `sheriff.config.ts` change.** The `libs/shared/<name>/src` → `scope:shared`
  glob (`sheriff.config.ts:53`) already tags the new
  `libs/shared/ui-kit/src/lib/app-header/**` files, and the memory note on
  barrel-`src` tagging is satisfied (the files live under `.../src`). Record "no
  `sheriff.config.ts` change needed" in the PR.
- **`shared/` extraction is justified:** 4 slices, byte-identical markup, one
  reason to change (the app-wide header chrome). This is exactly the 3+-slice bar,
  and the extraction was pre-flagged by spec 0091.

## Data model touchpoints

**None.** Pure presentation change — no Firestore collection/field is read,
written, or added; no converter change.

- **`firestore.rules` — no change.** No new read/write path.
- **`firestore.indexes.json` — no change.** No new query.

Record both as "no change needed" in the PR.

## Public types / APIs

**New component (the only public-surface change):**

```ts
// libs/shared/ui-kit/src/lib/app-header/vultus-app-header.component.ts
@Component({
  selector: 'vultus-app-header',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>
          <span class="brand-mark">
            <ion-icon name="film-outline" class="brand-icon"></ion-icon>
            Vultus
          </span>
        </ion-title>
        <ion-buttons slot="end">
          <ng-content></ng-content>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
  `,
  styleUrl: './vultus-app-header.component.scss',
})
export class VultusAppHeader {}
```

**Contract:**

- **No `@Input`s.** The brand mark (`film-outline` + "Vultus") is fixed for all
  four pages (D3); the only per-page variation is the trailing buttons, supplied
  by content projection.
- **Content-projection contract:** a single default `<ng-content>` is rendered
  **inside** the component's `ion-buttons slot="end"`. Consumers project the bare
  `<ion-button>` elements they want in the trailing slot (Ionic moves the
  projected nodes so they render as children of `ion-buttons`, preserving Ionic's
  toolbar-button styling). Consumers keep their own `IonButton`/`IonIcon` (and
  page-specific `IonBadge`/`IonSpinner`) imports and `addIcons` for button icons.
- **Icon registration:** the component registers **only** `filmOutline` (via
  `addIcons({ filmOutline })` in its constructor) — it owns the brand icon. It
  does **not** register button icons; consumers keep registering those.
- **Barrel export:** `export { VultusAppHeader } from './lib/app-header/vultus-app-header.component';`
  added to `libs/shared/ui-kit/src/index.ts`. Adding a class to the barrel is a
  **public-API change**, so the lib README is updated in the same change (CLAUDE.md
  lib-README rule).

No `shared/domain` type, function signature, HTTP endpoint, or callable changes.
**No `User` domain field is added or changed → F4 onboarding-parity does not apply**
(no persisted preference). **No F2 shared-type ripple** (a new component export, not
a change to an existing widely-constructed type).

## UI / Stitch screen refs

**Deliberate deviation from the Stitch screen for cross-page consistency — same
posture spec 0091 took.** The header appears on the tab screens of Stitch project
`13590348714018893783`; the Watch Today screen
**`812340847a604f8a968021183690bf54`** specced the header at `h-16` (64px), which
is exactly the "taller than the others" state #254 reports. The user's locked
decision (D1) is to **intentionally not match** that 64px and instead unify Today
**down** to the height the other three tabs already render (Ionic's default
toolbar min-height, i.e. **no `--min-height` override**). The authoritative target
is therefore the **already-shipped Search/Settings header** in-repo, not a fresh
screen fetch: the shared component reproduces that header exactly. Tokens
reference `docs/design/vultus-design-system.md` / `theme.scss` (not re-transcribed
hex).

**Header chrome contract (checkable — the shared `VultusAppHeader`; verify via
serve-mock):**

| Property               | Value (token)                                                                                                              | Notes                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Toolbar `--background` | `var(--vultus-surface)`                                                                                                    | Same on all four today.                                                                                                  |
| Toolbar border         | `--border-width: 0 0 1px 0`, `--border-color: var(--vultus-outline-variant)`, `--border-style: solid`                      | 1px bottom hairline. **`--vultus-outline-variant`**, not the legacy `--vultus-border` alias (fixes Watchlist drift, D4). |
| Toolbar `--box-shadow` | `none`                                                                                                                     |                                                                                                                          |
| Toolbar `--min-height` | **unset (no override)**                                                                                                    | **This is the #254 fix** — removed from Today; never added to others.                                                    |
| `ion-title` inset      | `padding-inline: 16px`                                                                                                     | Matches all four.                                                                                                        |
| Brand text             | exactly `Vultus`                                                                                                           | Byte-identical (F3).                                                                                                     |
| Brand wordmark         | `font-family: var(--vultus-font-family)`, `font-weight: 700`, `font-size: 1.125rem`, `color: var(--ion-color-primary)`     | `--ion-color-primary` = `#4edea3` (theme.scss:35).                                                                       |
| Brand mark layout      | `display: inline-flex`, `align-items: center`, `gap: 8px`                                                                  | (`gap: var(--vultus-space-sm)` acceptable — 8px.)                                                                        |
| Brand icon             | `film-outline`, `font-size: 1.25rem`, `color: var(--ion-color-primary)`, `flex-shrink: 0`, `position: relative; top: -1px` | Optical baseline nudge, as today.                                                                                        |
| Host layout            | `:host { display: block; }`                                                                                                | So the wrapping `<vultus-app-header>` element flows like `ion-header`.                                                   |

- **Interactive states:** the header chrome itself is **non-interactive** (static
  brand mark + hairline). All interactivity lives in the **projected buttons**,
  which are unchanged from today (their default/hover/active/focus/disabled states
  — e.g. Watchlist's sync button `[disabled]` state and spinner swap — are owned
  by each page and must render identically). No new state is introduced.
- **Token wiring:** the Inter web-font is already loaded app-wide
  (`apps/mobile/src/index.html`); the component only references the family stack.
  All `--vultus-*` / `--ion-*` vars consumed here are already defined in
  `theme.scss` (verified: `--vultus-surface`, `--vultus-outline-variant`,
  `--ion-color-primary`, `--vultus-font-family`, `--vultus-space-sm`).
- **Integration risk to eyeball (D7):** the header markup now lives one element
  deeper (`<lib-*><vultus-app-header><ion-header>…`). `:host { display: block }`
  keeps it in normal flow; these pages use **non-fullscreen** `ion-content`, so
  the header lays out above content as before. The status-bar safe-area top inset
  is applied by `ion-header` itself and is preserved. **Verify visually** (below).
- **Required visual verification (D7):** run `pnpm nx run mobile:serve-mock` and
  confirm: (a) **Today's header is the same height** as Watchlist/Search/Settings;
  (b) all four pages' brand mark + trailing buttons render identically to before
  (no regression from projection); (c) button interactions still work
  (Watchlist's refresh/bell/account, others' account). If serve-mock cannot be run
  in the implementation session, explicitly flag UI fidelity **UNVERIFIED for a
  human eyeball** (CLAUDE.md UI-fidelity rule) — do **not** report done off a green
  build alone.

## Implementation task graph

Sequential gate first (the shared component + barrel export must exist before any
page can import it), then the four page migrations run in parallel.

### Task A — `VultusAppHeader` shared component `[sequential]` (frontend-engineer)

Must complete (and land in the worktree) before Tasks B–E — they import from the
lib barrel.

Manifest (writes only):

- `libs/shared/ui-kit/src/lib/app-header/vultus-app-header.component.ts`
- `libs/shared/ui-kit/src/lib/app-header/vultus-app-header.component.scss`
- `libs/shared/ui-kit/src/lib/app-header/vultus-app-header.component.spec.ts`
- `libs/shared/ui-kit/src/index.ts`
- `libs/shared/ui-kit/README.md`

Steps:

1. Create the component per §5's contract (standalone, `OnPush`, selector
   `vultus-app-header`, single default `<ng-content>` inside `ion-buttons slot="end"`,
   `addIcons({ filmOutline })` in the constructor).
2. Create the SCSS: the toolbar chrome from the header-chrome contract table
   (`--background`, 1px `--vultus-outline-variant` bottom border, `--box-shadow: none`,
   **no `--min-height`**, `ion-title { padding-inline: 16px }`), `.brand-mark`,
   `.brand-icon`, and `:host { display: block; }`. Use `--ion-color-primary` for
   the brand color. No hardcoded hex.
3. Add the barrel export to `src/index.ts` (alongside the existing atom exports,
   with a short doc comment).
4. Update `README.md`: add `VultusAppHeader` to the Public surface / Components
   sections — what it is (the shared tab-page header: brand mark + projected
   trailing buttons), its content-projection contract, that it registers
   `filmOutline` itself, and that it consumes `--ion-color-primary` /
   `--vultus-outline-variant` (no `--min-height`).
5. Add the component spec (see Test plan).

### Task B — Migrate Today `[parallel]` (frontend-engineer)

Manifest (writes only):

- `libs/mobile/today/src/lib/today.page.html`
- `libs/mobile/today/src/lib/today.page.scss`
- `libs/mobile/today/src/lib/today.page.ts`
- `libs/mobile/today/src/lib/today.page.spec.ts`

Steps:

1. **`today.page.html`** L1-17: replace the `<ion-header>…</ion-header>` block
   with `<vultus-app-header>` wrapping only the existing trailing `<ion-button
aria-label="Account">…</ion-button>` (the comment on L10-11 and the button move
   as-is). `ion-content` and below unchanged.
2. **`today.page.scss`** L16-54: delete the `ion-header { ion-toolbar {…} }`,
   `.brand-mark`, and `.brand-icon` blocks (**this removes the `--min-height: 64px`
   at L30 — the #254 fix**) and the stale header comment L1-6/L16-21. First verify
   no other selector in the file references `.brand-mark`/`.brand-icon`/`ion-header`
   (grep confirmed header-only today). Keep `%vultus-focus-ring`, `ion-content`,
   `.today-main`, `.hero*`, card/section styles untouched.
3. **`today.page.ts`**: drop `IonHeader`, `IonToolbar`, `IonTitle`, `IonButtons`
   from `imports` (keep `IonButton`, `IonIcon`, `IonContent`); add `VultusAppHeader`
   to `imports` (already imports from `@vultus/shared/ui-kit`); remove `filmOutline`
   from the `addIcons` call and its import (keep `personCircleOutline` etc.).
4. **`today.page.spec.ts`**: keep all existing specs green against the new template
   (see Test plan); update any locator that assumed the inline `<ion-header>`.

### Task C — Migrate Watchlist `[parallel]` (frontend-engineer)

Manifest (writes only):

- `libs/mobile/watchlist/src/lib/watchlist.page.html`
- `libs/mobile/watchlist/src/lib/watchlist.page.scss`
- `libs/mobile/watchlist/src/lib/watchlist.page.ts`
- `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`

Steps:

1. **`watchlist.page.html`** L1-45: replace the `<ion-header>…</ion-header>` block
   with `<vultus-app-header>` wrapping the existing three trailing buttons (Refresh
   `(click)="onSync()"` incl. spinner/disabled logic, `.bell-button` Notifications
   incl. `bell-badge`, Account) — moved verbatim. `ion-content` and below unchanged.
2. **`watchlist.page.scss`** L24-57: delete the `ion-header { ion-toolbar {…} }`,
   `.brand-mark`, `.brand-icon` blocks (**this eliminates the header block's
   `--vultus-border` and literal `#4edea3` drift at L45/L53, D4**). Verify
   `.bell-button`/`.bell-badge` and any other selectors don't live inside those
   deleted blocks (they're separate — keep them). Keep `%vultus-focus-ring`,
   `%compact-pill`, `ion-content`, and all list/filter styles. **Leave
   `.meta-vote { color: #4edea3 }` (L629) untouched** — it is a distinct
   pre-existing drift outside the header, explicitly out of scope. After deleting,
   grep the file for `#4edea3` and `--vultus-border` and confirm the **only**
   remaining `#4edea3` is `.meta-vote` (L629) and no `--vultus-border` remains — i.e.
   only the header-block instances were removed.
3. **`watchlist.page.ts`**: drop `IonHeader`/`IonToolbar`/`IonTitle`/`IonButtons`
   from `imports`; keep `IonButton`, `IonIcon`, `IonBadge`, `IonSpinner`, `IonContent`,
   etc.; add `VultusAppHeader`; remove `filmOutline` from `addIcons` + import.
4. **`watchlist.page.spec.ts`**: keep existing specs green (the refresh/bell/account
   buttons keep the same roles/`aria-label`s/handlers, so locators still resolve);
   update any locator that assumed the inline `<ion-header>`.

### Task D — Migrate Search `[parallel]` (frontend-engineer)

Manifest (writes only):

- `libs/mobile/search/src/lib/search.page.html`
- `libs/mobile/search/src/lib/search.page.scss`
- `libs/mobile/search/src/lib/search.page.ts`
- `libs/mobile/search/src/lib/search.page.spec.ts`

Steps:

1. **`search.page.html`** L1-15: replace the `<ion-header>…</ion-header>` block
   with `<vultus-app-header>` wrapping the existing Account button.
2. **`search.page.scss`** L3-33: delete the `ion-header`/`ion-toolbar`,
   `.brand-mark`, `.brand-icon` blocks (verify none reused elsewhere); keep
   `ion-content` and search-result styles.
3. **`search.page.ts`**: drop `IonHeader`/`IonToolbar`/`IonTitle`/`IonButtons`;
   keep `IonButton`/`IonIcon`; add `VultusAppHeader`; remove `filmOutline` from
   `addIcons` + import (keep `personCircleOutline`).
4. **`search.page.spec.ts`**: keep specs green; fix any inline-header locator.

### Task E — Migrate Settings `[parallel]` (frontend-engineer)

Manifest (writes only):

- `libs/mobile/settings/src/lib/settings.page.html`
- `libs/mobile/settings/src/lib/settings.page.scss`
- `libs/mobile/settings/src/lib/settings.page.ts`
- `libs/mobile/settings/src/lib/settings.page.spec.ts`

Steps:

1. **`settings.page.html`** L13-27: replace the `<ion-header>…</ion-header>` block
   with `<vultus-app-header>` wrapping the existing Account button (keep the L1-12
   descriptive comment above it).
2. **`settings.page.scss`** L14-44: delete the `ion-header`/`ion-toolbar`,
   `.brand-mark`, `.brand-icon` blocks (verify none reused; `.settings-title`
   etc. stay).
3. **`settings.page.ts`**: drop `IonHeader`/`IonToolbar`/`IonTitle`/`IonButtons`;
   keep `IonButton`/`IonIcon`; add `VultusAppHeader`; remove `filmOutline` from
   `addIcons` + import.
4. **`settings.page.spec.ts`**: keep specs green; fix any inline-header locator.

**Parallel-safety:** the manifests of A–E are pairwise disjoint (A only under
`libs/shared/ui-kit`; B–E each only under their own slice lib). B–E all _read_ the
new `@vultus/shared/ui-kit` barrel but none writes it (Task A owns it), so the
sequential gate on A is sufficient.

**Visual verification (required, cross-cutting):** after B–E land, run serve-mock
and perform the D7 checks, or flag UNVERIFIED for a human.

## Test plan

Per the PLAN §5 pyramid. Component/unit tests on **Vitest + Analog** (no live
Firebase, no emulator, no network, no secrets). No CSS computed-height assertion
in jsdom (no layout engine — same limitation spec 0091 documented); the height fix
is verified via the serve-mock visual check.

**Component — `vultus-app-header.component.spec.ts` (Task A):**

- **Brand mark renders.** With the component rendered (through a tiny test host or
  directly), assert `el.querySelector('.brand-mark')` is non-null, contains an
  `ion-icon[name="film-outline"].brand-icon`, and that the brand's visible text is
  **exactly `Vultus`** — assert on the brand-mark's own text node (the token after
  the icon), NOT a whole-subtree `.replace(/\s+/g,' ')` normalization (F3: a global
  normalize would mask a stray-space defect; only the source-indentation around the
  standalone `Vultus` token may be stripped).
- **Content projects into the end slot.** Render a test host,
  `@Component({ imports: [VultusAppHeader, IonButton], template:
'<vultus-app-header><ion-button aria-label="Account"></ion-button></vultus-app-header>' })`,
  and assert `el.querySelector('ion-buttons[slot="end"] ion-button[aria-label="Account"]')`
  is non-null — i.e. the projected button lands inside the toolbar's trailing slot.
- **No `--min-height` regression guard (source-level).** Optionally assert the
  component template has no `min-height` binding; the true guard is the serve-mock
  visual check.

**Component — the four `*.page.spec.ts` (Tasks B–E):**

- Each page's existing specs must stay **green** against the new template. Because
  the trailing buttons keep the same DOM shape, roles, and `aria-label`s (now
  projected into the shared header), locators such as button-by-`aria-label` or
  `ion-buttons` still resolve within the page's rendered DOM (the page is standalone
  and imports `VultusAppHeader`, so rendering the page renders the header + projected
  buttons). Update only locators that assumed the literal inline `<ion-header>`
  element on the page.
- **Rendered-text (F3):** the brand text (`Vultus`) and every button label/`aria-label`
  that pages assert on (`Account`, and Watchlist's `Notifications`, the dynamic
  `Refresh watchlist` / `Syncing…` / `Synced just now` aria-labels, and the
  `bell-badge` count text) must render **byte-identical** to today. Assert exact
  strings; do **not** whitespace-normalize before asserting. Keep any existing
  exact-string assertions unchanged and green.

**e2e (Playwright): none required.** Per the e2e decision rubric this is a
presentation refactor + CSS bug fix to **existing** pages — no new route/page and
no changed user-facing action, navigation, or persisted state. **Not required.**
Confirm existing e2e specs that touch these tabs (e.g. `watchlist-refresh`,
`settings`, `search`, `notifications`, `app.smoke`) still pass unchanged: the
refresh/bell/account buttons keep the same `aria-label`s/roles, so their locators
are unaffected. If any existing e2e locator targets the header via the old inline
`<ion-header>` DOM path, update the locator (do **not** skip the flow).

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to at least one task.

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected
      set is `shared-ui-kit`, `mobile-today`, `mobile-watchlist`, `mobile-search`,
      `mobile-settings`, `mobile`. (Tasks A–E)
- [ ] **Sheriff clean:** slices import `VultusAppHeader` only via
      `@vultus/shared/ui-kit`; no cross-slice/cross-scope edge; `scope:shared` stays
      self-contained; **no `sheriff.config.ts` change** (existing `src` glob covers
      the new files). (Tasks A–E)
- [ ] **`VultusAppHeader` created** (standalone, `OnPush`, `vultus-app-header`):
      owns the `ion-header`/`ion-toolbar` shell + brand mark, chrome SCSS with **no
      `--min-height`**, brand color `--ion-color-primary`, border
      `--vultus-outline-variant`, and a default `<ng-content>` inside
      `ion-buttons slot="end"`; registers only `filmOutline`. (Task A)
- [ ] **Barrel export** added to `libs/shared/ui-kit/src/index.ts`. (Task A)
- [ ] **ui-kit `README.md` updated** to document `VultusAppHeader` (public surface,
      projection contract, self-registered icon). (Task A)
- [ ] **Component spec** asserts the brand mark renders (`film-outline` +
      byte-exact `Vultus`) and that projected content lands in
      `ion-buttons[slot="end"]`. (Task A)
- [ ] **Today migrated:** `.html` uses `<vultus-app-header>`; `.scss` header/brand
      blocks deleted **including `--min-height: 64px` (the #254 fix)** and the stale
      comment; `.ts` imports/`addIcons` updated; `.spec.ts` green. (Task B)
- [ ] **Watchlist migrated:** header replaced; `.scss` header/brand blocks deleted
      **eliminating the header block's `--vultus-border` + literal `#4edea3` drift
      (D4) — the `.brand-mark`/`.brand-icon` instances at L45/L53 only; the
      unrelated `.meta-vote { color: #4edea3 }` at L629 is left untouched**;
      `.ts`/`.spec.ts` updated & green; sync/bell/account buttons unchanged. (Task C)
- [ ] **Search migrated:** header replaced; dead SCSS removed; `.ts`/`.spec.ts`
      green. (Task D)
- [ ] **Settings migrated:** header replaced (L1-12 comment kept); dead SCSS
      removed; `.ts`/`.spec.ts` green. (Task E)
- [ ] **Dead-selector check:** for each page confirmed no non-header selector
      referenced the deleted `.brand-mark`/`.brand-icon`/`ion-header` rules before
      deletion. (Tasks B–E)
- [ ] **Rendered text byte-identical (F3):** brand `Vultus` + all button
      labels/`aria-label`s unchanged; no whitespace-normalized assertions. (Tasks A–E)
- [ ] **Visual verification** on serve-mock: Today's header height now matches the
      other three; all four brand marks + buttons render identically; button
      interactions work — OR explicitly flagged **UNVERIFIED for a human**. (Tasks B–E)
- [ ] **Verify-and-record NO change:** `firestore.rules`, `firestore.indexes.json`,
      `sheriff.config.ts`, any `shared/domain` type, `User` field, and onboarding
      code **NOT** modified. (Tasks A–E)
- [ ] **e2e:** no new flows; existing tab e2e specs still pass (locators updated if
      any targeted the old inline header). (Tasks B–E)
- [ ] PR references this spec (0096) and issue #254.

## Risks

- **Ionic header nesting inside a custom element.** Wrapping `ion-header` in
  `<vultus-app-header>` puts the header one element deeper in the DOM.
  **Mitigation:** `:host { display: block }` keeps it in normal flow; these pages
  use non-fullscreen `ion-content` so the header is a static block above content;
  `ion-header` still applies the status-bar safe-area top inset. The D7 serve-mock
  check explicitly verifies header rendering + safe-area on all four pages. If a
  layout/inset regression appears on-device, it is caught by the visual check
  before "done".
- **Content-projection of `ion-button` into `ion-buttons`.** Ionic styles
  toolbar buttons via `ion-buttons > ion-button`; projected nodes must render as
  children of `ion-buttons`. **Mitigation:** the default `<ng-content>` sits
  directly inside `ion-buttons slot="end"`, so Angular projects the buttons as its
  children (verified by the Task A projection test + the serve-mock button-interaction
  check). Watchlist's disabled/spinner and badge states are page-owned and unchanged.
- **Deliberate departure from the Stitch `h-16` header.** Screen
  `812340847a604f8a968021183690bf54` specced 64px; this spec unifies to the other
  tabs' shorter default per the user's locked D1. **Mitigation:** documented as an
  intentional deviation here and in the PR; if a taller header is wanted later it is
  a new design decision affecting all four via the one shared component (a feature
  of the extraction, not a regression).
- **Full-object write-payload assertion ripple — N/A.** This spec adds no
  `shared/domain` field, so the optional-field `.toEqual` ripple noted in memory
  does not apply.
- **No PLAN conflict.** A `scope:shared` component consumed by four `scope:mobile`
  slices via the permitted `scope:shared` edge; consistent with PLAN §3
  vertical-slice and the "extract at 3+ slices with the same reason to change" rule
  (4 slices, identical markup, one reason to change) — the exact extraction spec
  0091 deferred.
  </content>
  </invoke>
