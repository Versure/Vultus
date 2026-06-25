---
number: 0024
slug: empty-loading-states
title: Align empty, loading, and error states across all mobile slices to the Stitch design
status: approved
slices: [slice:watchlist, slice:search, slice:title-detail, slice:settings]
scopes: [scope:mobile, scope:shared]
created: 2026-06-25
---

# Align empty, loading, and error states across all mobile slices to the Stitch design

## 1. Context

The four mobile slices each grew their own loading / empty / error treatment as
they were built (specs 0013 search, 0014 watchlist, 0016 title-detail, 0018
settings). The result is inconsistent and, in places, incomplete:

- **Watchlist** has inline `ion-skeleton-text` skeletons and a bespoke empty
  state, but **no error state** — a Firestore stream error renders nothing.
- **Search** uses a plain `ion-spinner` for loading (layout jumps when results
  arrive), and has prompt / no-results / error states drawn locally.
- **Title-detail** has an inline hero skeleton and a "not-found" state, but
  **TMDB/Firestore fetch errors fall through to "not-found"** (misleading: a
  network blip looks like a deleted title), and there is **no error/retry**.
  Worse, the **cache path** (`getDoc` in `title-detail.service.ts` lines
  126–128) has its own `try/catch` that **swallows Firestore errors silently** —
  so a Firestore-down condition never reaches *any* error branch at all (it
  falls through to the live path or to `not-found`). Both the live-path errors
  **and** the cache/Firestore `getDoc` errors must be surfaced.
- **Settings** shows a bare `ion-spinner` until `load()` resolves and has **no
  skeleton and no error state**; because `SettingsService.load()` has no
  try/catch, a Firestore read failure throws and `loaded()` never flips — **the
  spinner hangs forever** with no recovery.

This is PLAN §6 item 23 ("Empty states + loading states — across all slices").
The goal is a **single, polished, on-brand set of state atoms** in
`shared/ui-kit` so every slice's loading / empty / error UI looks the same and
matches the Vultus design system: content-shaped skeletons (less layout shift),
a configurable empty state, and an error state with retry.

This spec is **design-alignment only**. It adds zero new functional behaviour —
no new Firestore reads, routes, or sync logic. It surfaces error branches that
**already exist or already throw** through a consistent UI, and replaces ad-hoc
state markup with shared atoms.

Intended outcome: a user who opens any tab on a slow/failing network sees a
polished skeleton while loading, a clear branded empty state when there's
nothing to show, and a recoverable error state (with a retry button) when a
fetch/stream fails — identical in look across all four slices.

## 2. Scope

In scope:

- Four new presentational atoms in `shared/ui-kit` (their first TS components):
  `VultusSkeletonCard`, `VultusSkeletonHero`, `VultusEmptyState`,
  `VultusErrorState` — all consuming `--vultus-*` / `--ion-*` tokens, no
  hardcoded hex.
- **Watchlist:** replace inline skeletons with `VultusSkeletonCard`, replace the
  inline empty state with `VultusEmptyState`, **add** a `VultusErrorState` +
  retry for the Firestore stream error path (a new view-model branch — error
  rendering, not a new read).
- **Search:** replace the loading `ion-spinner` with `VultusSkeletonCard`,
  re-render the existing `no-results` and `prompt` states through
  `VultusEmptyState`, and the existing `error` view-state through
  `VultusErrorState` (wired to the existing `retrySearch()`).
- **Title-detail:** replace the inline hero skeleton with `VultusSkeletonHero`,
  re-render the existing `not-found` state through `VultusEmptyState`, and **add**
  an `error` branch to `DetailViewState` so genuine fetch/stream errors surface
  as `VultusErrorState` + retry **instead of** masquerading as `not-found`.
- **Settings:** replace the bare spinner with a **form-shaped inline skeleton**
  (two card-shaped placeholders matching the region + notifications rows — a
  card skeleton would not match this screen), and **add** a load-failure error
  state (`VultusErrorState` + retry) by wrapping `SettingsService.load()` in a
  try/catch that sets an error flag instead of leaving the spinner hung.

Out of scope (explicitly):

- **Any new functional behaviour** — no new Firestore reads, no new routes, no
  new sync/refresh logic, no changes to what data each slice fetches. The
  title-detail and settings error branches expose failures that the existing
  code already produces (currently swallowed); they do not add fetches.
- The **onboarding slice** (spec 0022, in-flight) — not touched.
- **Watch-progress / episodes tab** (v1.1) — not touched.
- **Push-notification UI** — not touched.
- Reworking the slices' **loaded-content** layouts (cards, hero, provider
  groups, settings rows) — only the loading/empty/error branches change.
- Extracting any **logic** (services, view-state machines) to `shared/` — the
  atoms are presentational only; each slice keeps its own state machine.

## 3. Affected slices & Sheriff tags

| Lib / app | Sheriff tags | Change |
| --- | --- | --- |
| `libs/shared/ui-kit/src` | `scope:shared` | Add 4 standalone components + barrel exports; README update. First TS components in this lib (previously theme-only). |
| `libs/mobile/watchlist/src` | `scope:mobile`, `slice:watchlist` | Consume the 3 atoms; add error VM branch. |
| `libs/mobile/search/src` | `scope:mobile`, `slice:search` | Consume `VultusSkeletonCard`, `VultusEmptyState`, `VultusErrorState`. |
| `libs/mobile/title-detail/src` | `scope:mobile`, `slice:title-detail` | Consume `VultusSkeletonHero`, `VultusEmptyState`, `VultusErrorState`; add `error` to `DetailViewState`. |
| `libs/mobile/settings/src` | `scope:mobile`, `slice:settings` | Consume `VultusErrorState`; add inline form skeleton + error flag. |

**No cross-slice imports.** Each slice imports only from
`@vultus/shared/ui-kit` (`scope:shared` — importable by anyone, PLAN §3 rule 4)
and its own files. No slice imports another slice.

**Extract-to-shared justification (PLAN §3, "3+ slices" rule):**

- `VultusSkeletonCard` — used by **watchlist + search** (2 slices). It is below
  the 3-slice bar on its own, but it ships **together with** `VultusEmptyState`
  (4 slices) and `VultusErrorState` (4 slices) as one cohesive "state atoms"
  family with the **same reason to change** (the shared design-system contract
  for state UI). The family clears the bar; splitting the card out into a slice
  would force a near-identical second copy in the other slice. Recorded here so
  the spec-reviewer does not flag it.
- `VultusSkeletonHero` — used by **title-detail only** today. Same rationale:
  it is part of the one state-atom family (same reason to change as the others)
  and lives with them rather than as a one-off in the slice. If a future slice
  needs a hero skeleton it reuses this. (If the reviewer prefers, this single
  atom **may** stay in the title-detail slice — see Risks; the chosen default is
  to keep the family together in ui-kit.)

## 4. Data model touchpoints

**None.** No Firestore collection, field, converter, or security rule is added
or changed (PLAN §4 untouched). This spec only changes which UI renders for
loading / empty / error branches of data the slices **already** read. The
settings change wraps the **existing** `users/{uid}` read in a try/catch; it
reads nothing new.

## 5. Public types / APIs

New public surface of `@vultus/shared/ui-kit` (added to the barrel
`libs/shared/ui-kit/src/index.ts`). All are **standalone** Angular components,
`changeDetection: ChangeDetectionStrategy.OnPush`, selector-prefixed `vultus-`,
purely presentational (no injected services, no Firestore).

```typescript
// VultusSkeletonCard — content-shaped skeleton mimicking a watchlist/search
// result row (poster thumbnail + title line + meta line + badge placeholder).
// Renders `count` identical rows. Each row's internal skeletons use
// ion-skeleton-text [animated]="true" (Ionic's built-in shimmer).
@Component({ selector: 'vultus-skeleton-card', standalone: true, ... })
export class VultusSkeletonCard {
  @Input() count = 1; // number of skeleton rows to render
}

// VultusSkeletonHero — hero-shaped skeleton mimicking the title-detail hero
// (large 2:3-ish image block + title line + meta line) plus a few body lines.
// No inputs.
@Component({ selector: 'vultus-skeleton-hero', standalone: true, ... })
export class VultusSkeletonHero {}

// VultusEmptyState — configurable centred empty state.
@Component({ selector: 'vultus-empty-state', standalone: true, ... })
export class VultusEmptyState {
  @Input({ required: true }) icon!: string;  // Ionicons name (e.g. 'film-outline')
  @Input({ required: true }) title!: string;
  @Input() subtitle = '';
}

// VultusErrorState — error message + retry button; emits `retry`.
@Component({ selector: 'vultus-error-state', standalone: true, ... })
export class VultusErrorState {
  @Input() message = 'Something went wrong';
  @Output() retry = new EventEmitter<void>();
}
```

Barrel (`libs/shared/ui-kit/src/index.ts`) additionally exports the four classes
alongside the existing `SHARED_UI_KIT_THEME_PATH` constant. The icon for an
`vultus-empty-state` must be registered by the **consuming slice** via
`addIcons({...})` (Ionicons standalone pattern, as the slices already do) —
the atom does not register icons, so each consumer keeps its own icon set. The
atom registers the icons **it** owns (the retry/refresh icon for
`VultusErrorState`, e.g. `refreshOutline`) in its own constructor.

Slice-internal type change (not a public API — internal to title-detail):

```typescript
// libs/mobile/title-detail/src/lib/title-detail.service.ts
export type DetailViewState =
  | { kind: 'loading' }
  | { kind: 'loaded'; source: 'cache' | 'live'; detail: TitleDetail }
  | { kind: 'not-found' }     // genuine cache-miss AND live TMDB 404
  | { kind: 'error' };        // NEW: network/Firestore fetch failure (≠ 404)
```

`resolveDetail()` must distinguish a real **404 / not-found** (→ `not-found`)
from a **thrown network/Firestore error** (→ `error`); today both collapse to
`not-found`. This is the only logic change in the spec and it adds **no new
fetch** — it only branches on the error already thrown by the existing call.

The implementer must surface **both** error origins to the `error` kind:

- **Live path:** the `TmdbDetailError` thrown by the live fetch — discriminate
  its `status` (404 → `not-found`; any other / network → `error`).
- **Cache path:** the `getDoc` call (lines 126–128) currently wraps Firestore
  errors in a `try/catch` that **swallows** them; that swallow must be removed
  (or the caught error re-surfaced) so a Firestore-down read on the cache path
  maps to `error` instead of vanishing.

Slice-internal type change (not a public API — internal to watchlist): the
view-model gains an explicit error member. Pin the exact shape so the component
test assertion is unambiguous:

```typescript
// libs/mobile/watchlist — watchlist VM
{ groups: StatusGroup[] | null; error: boolean }
// groups === null → loading; groups === [] → empty; error === true → error state
```

Settings adds an internal error signal (not public): `loadFailed = signal(false)`
exposed read-only as `loadFailed`, set in a `catch` around the existing `load()`
body, and a `retryLoad()` that resets it and re-runs `load()`.

## 6. UI / Stitch screen refs

> **Stitch capture status (spec-author, 2026-06-25).** The state branches this
> spec governs — skeleton, empty, and error — are **not depicted as standalone
> screens** in the Stitch project: the Stitch screens render *loaded* content.
> The known relevant screen IDs (from prior specs / in-repo refs) are:
> **Watchlist** — not captured in any prior spec (ID unknown);
> **Search** — not captured in any prior spec (ID unknown);
> **Movie Detail - Vultus** — `projects/13590348714018893783/screens/208cb8d7a679490b8d13672c6943d6d3`
> (pinned in spec 0016);
> **Settings - Vultus** — `projects/13590348714018893783/screens/81945ff3381e453dafcc4e5ce896fcfa`
> (referenced in `settings.page.html`).
> The **visual contract for the *skeletons*** is *shape-match the slice's real
> content* (read from the live markup below), so the skeleton dimensions are
> pinned to the existing loaded-content cards, not to a separate Stitch screen.
> The implementer **must still `get_screen`** the Watchlist, Search, Movie
> Detail (id above), and Settings (id above) screens (the Stitch MCP **is**
> reachable from the orchestrator — **retry on a sub-agent "unreachable"**, do
> not skip), fetch each `htmlCode.downloadUrl` **raw** (plain GET, not WebFetch)
> + `screenshot.downloadUrl`, and **visually verify** the skeleton silhouette
> matches the real card/hero/row and that empty/error states sit on the correct
> surface ramp. **Record the four screen IDs used in the PR.** This is a *verify*
> step (the spec's pinned values are the contract); it is **not blocking** for
> these state branches because the screens don't depict them.

All tokens below are CSS custom properties exposed by
`libs/shared/ui-kit/src/lib/theme.scss` (the `--vultus-*` / `--ion-*` vars). **Do
not hardcode any hex value** — cite `docs/design/vultus-design-system.md`.
Inter must already be loaded as a web-font (it is, per spec 0010); the atoms
inherit the family stack and must not name a font.

### Shared tokens (apply to all four atoms)

- Page surface behind every state: `--vultus-surface` (`#0b1326`).
- Skeleton placeholder blocks: `ion-skeleton-text` with `[animated]="true"`
  (Ionic's built-in shimmer — **the only** loading animation; no custom
  keyframes). Skeleton blocks render at Ionic's default skeleton tint (a tonal
  step over the surface); do **not** override their fill with a custom color.
- Card/skeleton-card background sits on `--vultus-surface-container` (`#171f33`,
  the Level-1 card surface) to match real cards.
- Radius: cards/blocks `--vultus-radius-md` (0.75rem) for the card container,
  `--vultus-radius` (0.5rem, DEFAULT) for the poster block, `--vultus-radius-sm`
  (0.25rem) for text-line placeholders, `--vultus-radius-pill` (9999px) for the
  badge-shaped placeholder. All radius vars (`--vultus-radius`, `-sm`, `-md`,
  `-lg`, `-xl`, `-pill`) already exist in `theme.scss` — consume them directly;
  do not inline the rem value.
- 8px grid: gaps are `8px` (`spacing.sm`) inside a card, `16px` (`spacing.md`)
  between cards, `16px` side margins (`margin-mobile`).

### `VultusSkeletonCard` (mimics the watchlist/search result row)

Match the **real** watchlist card silhouette (`libs/mobile/watchlist` `.watchlist-card`)
and the search result card so there is no layout shift when content arrives.

- Container: full-width, `--vultus-surface-container` bg, `--vultus-radius-md`,
  `12px` internal padding, `16px` bottom margin between rows. Flex row.
- **Poster block:** left, fixed **2:3** aspect, **width 56px → height 84px**
  (matches the list-thumb size), `--vultus-radius`. `ion-skeleton-text` animated.
- **Body** (flex column, `8px` gap, flex-1):
  - **Title line:** height `16px` (≈ `body-lg` cap), width `70%`,
    `--vultus-radius-sm`.
  - **Meta line:** height `12px` (≈ `label-md`), width `40%`, `--vultus-radius-sm`.
  - **Badge placeholder:** height `20px`, width `64px`, `--vultus-radius-pill`
    (mimics the status/availability pill).
- Renders `count` rows (default 1); rows are spaced `16px` apart and aligned to
  the same `16px` page inset as real list items (insets **must agree** with the
  loaded list so the skeleton→content swap doesn't shift).

### `VultusSkeletonHero` (mimics the title-detail hero)

Match the title-detail hero (`libs/mobile/title-detail` `.hero` + body).

- **Hero block:** full-bleed, **height 320px** (≈ the loaded hero), no radius
  (full-width hero), `ion-skeleton-text` animated.
- Below the hero, a body column with `16px` side margin, `8px` gaps:
  - **Title line:** height `28px` (≈ `display-lg-mobile`), width `60%`,
    `--vultus-radius-sm`.
  - **Meta line:** height `14px` (≈ `body-md`), width `40%`, `--vultus-radius-sm`.
  - **3 body lines:** height `14px`, widths `100% / 100% / 80%`,
    `--vultus-radius-sm`, `8px` apart.
  - **Card placeholder:** height `96px`, full-width, `--vultus-radius-md`
    (mimics the synopsis / where-to-watch glass panel).

### `VultusEmptyState` (all slices)

Centred vertical stack, fills the available content height, centred both axes.

- **Icon:** `<ion-icon [name]="icon">`, size **48px**, color
  `--vultus-on-surface-variant` (`#bbcabf`), `16px` bottom margin.
- **Title:** `<p>`, type role **`body-lg`** (16/400/24), color
  `--vultus-on-surface` (`#dae2fd`), centred.
- **Subtitle:** `<p>`, type role **`body-md`** (14/400/20), color
  `--vultus-on-surface-variant`, centred, `4px` top margin; **rendered only when
  `subtitle` is non-empty** (`@if (subtitle)`).
- Horizontal padding `32px` so long copy wraps cleanly; max-width ~`320px`.
- No interactive elements (it is purely informational).

### `VultusErrorState` (watchlist, search, title-detail, settings)

Same centred layout as the empty state, plus a retry button.

- **Icon:** `alert-circle-outline`, size **48px**, color `--vultus-error`
  (`#ffb4ab`), `16px` bottom margin.
- **Message:** `<p>` bound to `message`, type role **`body-lg`**, color
  `--vultus-on-surface`, centred, `16px` bottom margin.
- **Retry button:** an `ion-button` labelled **"Try again"** with a leading
  `refresh-outline` icon (`slot="start"`), `(click)` → `retry.emit()`. Concrete
  states (per-state acceptance contract — feature-reviewer/human tick these):

  | State | Appearance |
  | --- | --- |
  | **default** | `fill="outline"`, border + text `--vultus-primary` (`#4edea3`), transparent fill, `--vultus-radius` corners, height **40px**, `label-md` (12/600) text. |
  | **focus** | Visible focus ring (Ionic default focus highlight on `--vultus-primary`); ring must be visible against `--vultus-surface`. |
  | **hover** | Subtle primary-tinted overlay (Ionic outline hover, ~8% primary) — pointer environments only. |
  | **active / pressed** | Primary-tinted overlay (~12% primary), no physical "lift" (flat aesthetic per design system). |
  | **disabled** | Not used in this spec — the button is always enabled (retry is always a valid action). Do not render a disabled state. |
  | **transition** | Ionic's default button state transition (≈150ms ease) for hover/active overlays; the shimmer-to-content swap is the skeleton's `[animated]` shimmer, not a custom fade. |

  All colors via CSS vars (`--ion-color-primary` is already mapped to
  `--vultus-primary` in `theme.scss`); set `color="primary"` rather than
  hardcoding.

## 7. Implementation task graph

**Task 1 — `shared/ui-kit` state atoms [sequential]**

Other tasks import these atoms, so this lands first. Generate the four
standalone components, wire tokens, export from the barrel, update the README.

**Icon registration:** `VultusErrorState` **must register the icons it owns** via
`addIcons({ refreshOutline, alertCircleOutline })` in its **own constructor** —
consumers only register their own (empty-state) icon sets, so the atom cannot
depend on a consumer having pre-registered `refreshOutline`/`alertCircleOutline`.
(`VultusEmptyState` registers no icons — its icon name is supplied and registered
by the consuming slice.)

Files (writes):

- `libs/shared/ui-kit/src/lib/skeleton-card/vultus-skeleton-card.component.ts`
- `libs/shared/ui-kit/src/lib/skeleton-card/vultus-skeleton-card.component.scss`
- `libs/shared/ui-kit/src/lib/skeleton-hero/vultus-skeleton-hero.component.ts`
- `libs/shared/ui-kit/src/lib/skeleton-hero/vultus-skeleton-hero.component.scss`
- `libs/shared/ui-kit/src/lib/empty-state/vultus-empty-state.component.ts`
- `libs/shared/ui-kit/src/lib/empty-state/vultus-empty-state.component.scss`
- `libs/shared/ui-kit/src/lib/error-state/vultus-error-state.component.ts`
- `libs/shared/ui-kit/src/lib/error-state/vultus-error-state.component.scss`
- `libs/shared/ui-kit/src/index.ts` (add four exports)
- `libs/shared/ui-kit/README.md` (document the new public surface)
- Co-located `*.spec.ts` for each component (see Test plan).

(No `theme.scss` change is needed — all radius vars `--vultus-radius`, `-sm`,
`-md`, `-lg`, `-xl`, `-pill` already exist; consume them directly.)

(Templates may be inline or co-located `.html`; if `.html` is used, add the
matching files under the same component folder — they are inside this task's
folder manifest `libs/shared/ui-kit/src/**`.)

**Tasks 2–5 run in parallel after Task 1** (disjoint slice file manifests).

**Task 2 — Watchlist slice [parallel]**

- Replace the inline `skeleton-list` block with `<vultus-skeleton-card [count]="5">`.
- Replace the `.empty-state` block with
  `<vultus-empty-state icon="film-outline" title="Your watchlist is empty"
  subtitle="Search for a title to get started">`.
- Add an **error VM branch**: extend `vm$` to the exact shape
  `{ groups: StatusGroup[] | null; error: boolean }` so a stream error maps to an
  error state (`catchError` on the `watchlist$` pipe emits
  `{ groups: null, error: true }` — no new read), render
  `<vultus-error-state (retry)="onRetry()">` where `onRetry()` re-pushes the
  current `typeFilter$` value (reuse the existing `onRefresh` re-subscribe path).
  (`groups === null` → loading skeleton; `groups === []` → empty state;
  `error === true` → error state.)
- Update `imports:` (drop `IonSkeletonText`; add the three atoms).

Files (writes):

- `libs/mobile/watchlist/src/lib/watchlist.page.html`
- `libs/mobile/watchlist/src/lib/watchlist.page.ts`
- `libs/mobile/watchlist/src/lib/watchlist.page.scss`
- `libs/mobile/watchlist/src/lib/watchlist.service.ts` (only if the error branch
  needs a stream tweak; keep it read-equivalent)
- `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts` (or existing spec file)
- `libs/mobile/watchlist/README.md` (if public surface/behaviour note changes)

**Task 3 — Search slice [parallel]**

- Replace the `loading` `ion-spinner` block with
  `<vultus-skeleton-card [count]="6">`.
- Re-render `prompt` and `no-results` via `<vultus-empty-state>` (prompt:
  `film-outline` / "Search for movies and TV shows"; no-results: `search` /
  `No results for '{{ service.lastQuery() }}'`).
- Re-render the `error` view-state via
  `<vultus-error-state (retry)="retry()">` (wired to the existing
  `service.retrySearch()`).
- Update `imports:` (drop `IonSpinner`; add the three atoms).

Files (writes):

- `libs/mobile/search/src/lib/search.page.html`
- `libs/mobile/search/src/lib/search.page.ts`
- `libs/mobile/search/src/lib/search.page.scss`
- `libs/mobile/search/src/lib/search.page.spec.ts` (or existing spec file)
- `libs/mobile/search/README.md` (if a behaviour note changes)

**Task 4 — Title-detail slice [parallel]**

- Replace the inline loading skeleton block with `<vultus-skeleton-hero>`.
- Re-render the `not-found` state via `<vultus-empty-state icon="film-outline"
  title="Title not found" subtitle="...">` (keep the "Go back" link, or move it
  into the page beneath the atom).
- Add the `error` kind to `DetailViewState` and branch `resolveDetail()` so a
  thrown network/Firestore error → `error` (not `not-found`); render
  `<vultus-error-state (retry)="onRetry()">` where `onRetry()` re-subscribes
  `detail$` for the current `tmdbId` (no new fetch logic — re-run the existing
  resolve). Surface **both** error origins to `error`: the **live-path**
  `TmdbDetailError` (404 → `not-found`, else → `error`, via its `status`) **and**
  the **cache-path** `getDoc` Firestore error (remove / re-surface the silent
  `try/catch` at lines 126–128 so a Firestore-down read maps to `error`, not a
  swallowed no-op).
- Update `imports:` (drop `IonSkeletonText`; add `VultusSkeletonHero`,
  `VultusEmptyState`, `VultusErrorState`).

Files (writes):

- `libs/mobile/title-detail/src/lib/title-detail.page.html`
- `libs/mobile/title-detail/src/lib/title-detail.page.ts`
- `libs/mobile/title-detail/src/lib/title-detail.page.scss`
- `libs/mobile/title-detail/src/lib/title-detail.service.ts` (add `error` kind +
  error/404 discrimination)
- `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts` and/or
  `title-detail.service.spec.ts`
- `libs/mobile/title-detail/README.md` (if public surface/behaviour note changes)

**Task 5 — Settings slice [parallel]**

- Replace the `.settings-loading` spinner with a **form-shaped inline skeleton**:
  two `ion-skeleton-text [animated]` card-shaped blocks (≈ the region card +
  notifications card silhouettes) on `--vultus-surface-container`, `16px` apart,
  `16px` side margin — **not** a `VultusSkeletonCard` (this screen is a form,
  not a list). The skeleton lives in the settings template/scss (slice-local);
  it does not need a shared atom.
- Wrap `SettingsService.load()` body in try/catch: on throw, set
  `loadFailed = signal(true)` (leave `loaded()` false), add `retryLoad()` that
  clears the flag and re-runs `load()`.
- Add an error branch to the template:
  `@if (service.loadFailed()) { <vultus-error-state (retry)="retry()"> }`
  `@else if (service.loaded()) { ...content... } @else { ...skeleton... }`.
- Update `imports:` (drop `IonSpinner`; add `VultusErrorState`).

Files (writes):

- `libs/mobile/settings/src/lib/settings.page.html`
- `libs/mobile/settings/src/lib/settings.page.ts`
- `libs/mobile/settings/src/lib/settings.page.scss`
- `libs/mobile/settings/src/lib/settings.service.ts` (try/catch + `loadFailed` +
  `retryLoad`)
- `libs/mobile/settings/src/lib/settings.page.spec.ts` and/or
  `settings.service.spec.ts`
- `libs/mobile/settings/README.md` (note the new error/skeleton states)

**Manifest disjointness:** Tasks 2–5 each write only under their own slice
directory (`libs/mobile/<slice>/src/**` + that slice's README); none touch
`shared/ui-kit` or another slice. Pairwise disjoint — safe to fan out.

## 8. Test plan

Per PLAN §5 pyramid (Vitest + Analog; Angular Testing Library for components).

**Unit / component — `shared/ui-kit` atoms (Task 1):**

- `VultusSkeletonCard`: renders `count` rows (default 1; assert N
  `ion-skeleton-text`/row containers for a given `count`); each row contains the
  poster + title + meta + badge placeholders.
- `VultusSkeletonHero`: renders the hero block + title/meta/body/card
  placeholders (snapshot-light structural assertions).
- `VultusEmptyState`: binds `icon`/`title`; renders `subtitle` **only** when
  non-empty (assert hidden for default `''`); icon name passed to `ion-icon`.
- `VultusErrorState`: renders default message; overrides with `message` input;
  clicking the retry button **emits `retry`** exactly once.

**Component — per slice (Tasks 2–5):** each slice asserts the correct atom
renders per branch (drive the existing service/VM into each state):

- Watchlist: `null` groups → `vultus-skeleton-card`; empty groups →
  `vultus-empty-state`; stream error → `vultus-error-state` and `(retry)`
  re-subscribes (assert the service stream is re-read).
- Search: `loading` → `vultus-skeleton-card`; `prompt` & `no-results` →
  `vultus-empty-state` (correct copy); `error` → `vultus-error-state` and
  `(retry)` calls `retrySearch()`.
- Title-detail: `loading` → `vultus-skeleton-hero`; `not-found` →
  `vultus-empty-state`; **`error` → `vultus-error-state`** (new branch) and a
  thrown fetch error resolves to `error` **not** `not-found` (service-level test).
- Settings: pre-load → form skeleton; load success → content; **load throw →
  `loadFailed()` true + `vultus-error-state`**, and `retry()` re-runs `load()`
  and recovers (assert `loaded()` flips on the retried success).

**e2e:** none added. These visual state branches are hard to trigger reliably in
Playwright (require forcing network/Firestore failures) and add little over the
component tests; the existing critical-flow e2e are unaffected. (Recorded here so
the qa-runner does not expect a new flow.)

**Visual verification (manual, recorded in PR):** serve with
`--configuration=mock` (or render/screenshot), drive each slice into
loading/empty/error, and compare against the Stitch screens (Movie Detail id
`208cb8d7...`, Settings id `81945ff3...`, plus the pulled Watchlist & Search
screens) — confirm skeleton silhouettes match the real cards/hero and that the
empty/error states sit on the correct surface ramp with primary-emerald retry.

## 9. Definition of done

- [ ] `pnpm nx affected -t typecheck --base=main` passes.
- [ ] `pnpm nx affected -t lint --base=main` passes, including **Sheriff**
      (slices import only `@vultus/shared/ui-kit`; no cross-slice import).
- [ ] `pnpm nx affected -t test --base=main` passes; the four atoms have
      component tests and each touched slice has a test per state branch (above).
- [ ] `pnpm nx affected -t build --base=main` passes for all affected projects.
- [ ] `pnpm nx affected -t e2e --base=main` (affected critical flows) green —
      no new flows; existing ones unaffected.
- [ ] `libs/shared/ui-kit/README.md` and any touched slice README updated to
      reflect the new public surface / state behaviour (CLAUDE.md lib-README rule).
- [ ] No hardcoded hex in any new `.scss`/template — all colors via `--vultus-*` /
      `--ion-*` vars (grep the diff for `#` hex literals).
- [ ] **UI visually verified** (mock serve / screenshot) against the Stitch
      screens, **or** explicitly flagged unverified for a human eyeball; the four
      Stitch screen IDs used recorded in the PR (a green build does not prove the
      UI is right — CLAUDE.md).
- [ ] PR description records: the screen IDs pulled, the visual-verification
      result, and confirmation that no new Firestore reads/routes/sync were added.

## 10. Risks

- **Stitch screens don't depict these states.** Skeleton/empty/error are not
  standalone Stitch screens, so the contract for skeletons is *shape-match the
  real content* (pinned above from the live markup), and empty/error use the
  design-system tokens. If the pulled Watchlist/Search screens *do* show an
  empty/error treatment that differs from the pinned values, the implementer
  reconciles toward the screen and notes the deviation in the PR. **Watchlist and
  Search screen IDs were never captured in prior specs** — the implementer must
  `list_screens` to find them (retry the MCP; it is reachable from the
  orchestrator).
- **Title-detail error/404 discrimination.** Distinguishing a genuine TMDB 404
  from a transient network error depends on the error shape thrown by
  `tmdb-detail.client` / Firestore. **No client change needed** —
  `TmdbDetailError.status` (in `tmdb-detail.client.ts`) already distinguishes a
  404 from a network error, so the implementer branches on `status` directly.
  The remaining work is purely in the slice's `resolveDetail()` (branch live
  errors on `status`, and stop swallowing the cache-path `getDoc` error). This
  stays **within** the slice and adds **no new fetch** — for any genuinely
  ambiguous failure, default to `error` (recoverable) rather than `not-found`,
  and note it in the PR.
- **`VultusSkeletonHero` is single-slice today** (title-detail only). It is
  shipped in ui-kit as part of the one state-atom family (same reason to change),
  which is the chosen reading of the 3+ rule. The spec-reviewer may instead
  prefer it live in the title-detail slice until a 2nd consumer appears; either
  is defensible — flagged so it's a conscious call, not an accidental
  over-extraction.
- **Settings skeleton is slice-local, not a shared atom.** The form-shaped
  skeleton is intentionally *not* `VultusSkeletonCard` (a form ≠ a list); it
  duplicates a little skeleton markup in the settings slice. That is acceptable
  per the no-premature-DRY rule (one consumer, different shape).
- **No data-source caveats** (TMDB/Trakt accuracy) apply — this spec touches no
  data fetching, only presentation of branches that already exist.
- **No PLAN conflicts.** This is PLAN §6 item 23; vertical-slice and the
  extract-at-3+ rule are respected (see §3 justification).
