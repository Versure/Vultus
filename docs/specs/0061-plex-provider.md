---
number: 0061
slug: plex-provider
title: Add Plex as a manual, per-title "I'm watching this via Plex" provider
status: approved
slices: [slice:settings, slice:title-detail, slice:watchlist]
scopes: [scope:mobile, scope:shared]
created: 2026-07-01
---

# Add Plex as a manual, per-title "I'm watching this via Plex" provider

## Context

GitHub #140: "I want plex as one of the providers and users should be able to
set tv shows and movies manually to Plex as a provider when they aren't watching
the show or movie through a provider but through plex instead. Vultus cannot
track availability in Plex, but should keep stating availability on the other
providers for these shows and movies as well whilst making clear that the user
is watching it through Plex."

The issue's own example: "I haven't got a Prime Video subscription but have The
Boys in my watchlist. I should be able to set Plex as my current provider for The
Boys, so I know I'm watching The Boys not via Prime Video but via Plex instead."

The key constraint (issue): **Vultus cannot track availability in Plex.** Plex
here is the user's own self-hosted media server, which TMDB/JustWatch has no data
about and Vultus cannot query. This is therefore a **manual, presentation-only**
flag — explicitly NOT a sync/availability-detection feature.

This spec is the **second of two related specs.** Spec 0060 (GitHub #139,
`spec/0060-provider-preferences`, PR #146 — drafted, not yet merged) introduced
`myProviderIds: number[]` on `users/{uid}` (an **open** array of real TMDB
provider ids matched against per-title `RegionAvailability.providers` to render
"On {provider}" vs "Also on {provider}" pills on the watchlist card and a
two-group split on title-detail's "Where to Watch" card). 0060 deliberately kept
`myProviderIds` an open `number[]` "so 0061 can layer Plex on without a
migration" (0060 Context / decision 1).

This spec (0061) **composes with 0060, it does not duplicate or conflict with
it.** Because 0060 is not yet merged, every file reference below is to the
**current `main`** state, EXCEPT the `myProviderIds` field and the availability
pill / two-group split logic, which are described as **"introduced by spec
0060"** and built on top of. Where a 0061 change lands in the same region of a
file 0060 also edits (title-detail's "Where to Watch" card, the Settings "My
Providers" section, the watchlist card corner), this spec pins the placement
**relative to 0060's structure** so the implementer composes the two additively.

What 0061 adds:

1. A **settings-level boolean** `hasPlex: boolean` on `users/{uid}` (default
   `false`), toggled from a **7th chip** in the same Settings "My Providers"
   section 0060 built — visually alongside the TMDB provider chips, but persisted
   **independently** (its own boolean, NOT merged into `myProviderIds`).
2. A **per-title manual override** `watchingViaPlex: boolean` on
   `users/{uid}/watchlist/{titleId}` (default `false`/absent), toggled from a new
   "Personal Tracking" subsection on **title-detail**. This is the actual "I'm
   watching THIS title via Plex" flag from the issue's The-Boys example.
3. **Additive** Plex indicators: on title-detail a "Watching via Plex" row and on
   the watchlist card a small read-only Plex badge — both rendered **alongside,
   never replacing**, 0060's TMDB-availability framing (the issue's requirement to
   "keep stating availability on the other providers … whilst making clear the
   user is watching it through Plex").

### Locked decisions (from the architect interview + design work — do NOT re-litigate)

1. **Plex is NOT a TMDB provider — do NOT put it in `myProviderIds`.** Real TMDB
   provider ids in `myProviderIds` are join-matched against
   `RegionAvailability.providers`. Plex has no TMDB id; a synthetic sentinel would
   risk colliding with a real provider id or corrupting 0060's "mine vs
   elsewhere" join key (exactly the fragility 0060's Risks flags — "if TMDB ever
   diverged these id spaces the match would silently fail"). Plex is modelled as a
   **separate boolean**, never a member of the id array.
2. **`hasPlex: boolean` on `users/{uid}`** (default `false`; legacy docs coalesce
   `?? false`) — mirrors exactly how 0060 added `myProviderIds` to the same
   document (same converter file, same eager-create literal, same `_user`
   type-assertion literal). Toggled from the Settings "My Providers" section via
   its OWN handler (`toggleHasPlex`), NOT 0060's `toggleProvider(providerId)` —
   Plex is not a catalog entry.
3. **`watchingViaPlex: boolean` on `users/{uid}/watchlist/{titleId}`** (default
   `false`/absent; legacy docs coalesce `?? false`) — the per-title flag. Toggled
   from title-detail. **The READ of this flag is NOT gated behind `hasPlex`** (a
   title tagged before the user unchecks "I use Plex" in Settings must still
   display correctly). But the **toggle control's visibility IS gated** behind
   `hasPlex` (declutter title-detail for users who don't use Plex) — mirroring
   0060's pattern of gating UI on a settings-level flag while reading the data
   unconditionally.
4. **Availability messaging is ADDITIVE, not replaced.** When `watchingViaPlex` is
   true, 0060's "On {provider}" / "Also on {provider}" watchlist pill and the "On
   Your Providers" / "Also Available On" title-detail split render **exactly as
   they would without Plex** — Plex adds a **separate, additional** badge/row, it
   never suppresses or overrides the TMDB framing. (The Boys example: the Prime
   badge/row still shows — correctly, since Prime IS where it's licensed — AND a
   distinct Plex indicator shows alongside it.)
5. **Toggle lives in title-detail only** (architect chose "Title-detail card" over
   "watchlist swipe action" or "both"). The **watchlist card is read-only** for
   this flag.
6. **`scope:mobile` + `scope:shared` only.** No new Firestore collection, no new
   Cloud Function, no TMDB involvement. `scope:functions` (sync-titles,
   dispatch-notifications) is **untouched** — `watchingViaPlex` is
   presentation-only, not a sync/notification input. If implementation reveals a
   functions touchpoint is needed, that is a **Risk to raise**, not a silent
   addition (see Risks).
7. **Out of scope:** any real Plex API/OAuth integration (manual only, per the
   issue); Plex in the spec-0054 watchlist "Provider" filter chips; notifications
   about Plex-tagged titles.

## Scope

In scope:

- **`hasPlex: boolean`** added to the `User` document (`@vultus/shared/domain`),
  default `false`; converter coalesce (`?? false`); `_user` type-assertion literal
  updated; READMEs updated.
- **`watchingViaPlex: boolean`** added to the `WatchlistItem` document
  (`@vultus/shared/domain`), default `false`/absent; converter coalesce
  (`?? false`); `_watchlistItem` type-assertion literal updated; READMEs updated.
- **Settings "My Providers" — Plex chip** (`libs/mobile/settings`): a 7th chip
  bound to `hasPlex` (its own `toggleHasPlex` handler + `hasPlex` signal), styled
  per the Stitch edit (bundled Plex logo image in a neutral logo tile, "Manual"
  secondary label); mock mirror; specs; README.
- **Title-detail "Personal Tracking" subsection** (`libs/mobile/title-detail`):
  read `watchingViaPlex` (unconditional) + `hasPlex` (gates the control's
  visibility); active/empty states per the canonical Stitch screen "Movie Detail -
  Personal Tracking - Vultus" (`562019f29ce2412d90c757a7e45a98bf`);
  `toggleWatchingViaPlex` persistence to the watchlist doc; specs; README.
- **Watchlist card — read-only Plex badge** (`libs/mobile/watchlist`): when the
  item's `watchingViaPlex` is true, render a compact Plex tag alongside (not
  replacing) 0060's availability pill; specs; README.
- One new e2e flow (`apps/mobile-e2e`) + unit + component tests per Test plan.

Out of scope (explicitly):

- **Any real Plex API / OAuth / server discovery.** Manual flag only (issue:
  "Vultus cannot track availability in Plex"). No Plex network call anywhere.
- **Plex in the spec-0054 watchlist "Provider" filter chips.** Those filter by
  TMDB provider name from availability; Plex is not availability data. Same
  exclusion reasoning 0060 used for the same filter chips.
- **Notifications about Plex-tagged titles.** `dispatch-notifications` is
  untouched — `watchingViaPlex` is not a notification input.
- **Suppressing / overriding 0060's TMDB availability framing.** Plex is strictly
  additive (decision 4).
- **`scope:functions` changes of any kind** (decision 6).
- **A shared "Plex badge" component across slices** — the two renderers differ (a
  corner tag on watchlist vs a full row on title-detail) and it touches only 2
  slices; the 3+-slice extract rule is not met (see Sheriff section).

## Affected slices & Sheriff tags

| Project                        | Path                          | Sheriff tags                          | Change                                                                                                                                    |
| ------------------------------ | ----------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| shared-domain (edit)           | `libs/shared/domain`          | `scope:shared`                        | **add** `hasPlex` to `User`; **add** `watchingViaPlex` to `WatchlistItem`; update the `_user` **and** `_watchlistItem` literals; README   |
| shared-firestore-schema (edit) | `libs/shared/firestore-schema`| `scope:shared`                        | `userToData` / `dataToUser` carry `hasPlex` (read `?? false`); `watchlistItemToData` / `dataToWatchlistItem` carry `watchingViaPlex` (read `?? false`); data-types updated; tests; README |
| mobile-settings (edit)         | `libs/mobile/settings`        | `scope:mobile`, `slice:settings`      | `hasPlex` signal + `toggleHasPlex`; read `hasPlex` in `load()`; `hasPlex: false` in the eager-create literal; the Plex chip in the "My Providers" section; mock mirror; page + template + scss; README; specs |
| mobile-title-detail (edit)     | `libs/mobile/title-detail`    | `scope:mobile`, `slice:title-detail`  | read `watchingViaPlex` (from `tracked$`) + `hasPlex$()`; `toggleWatchingViaPlex` write; "Personal Tracking" subsection; page + template + scss; README; specs |
| mobile-watchlist (edit)        | `libs/mobile/watchlist`       | `scope:mobile`, `slice:watchlist`     | read `watchingViaPlex` off the streamed item; read-only Plex badge in the card corner; template + scss; README; specs                     |
| mobile-e2e (edit)              | `apps/mobile-e2e`             | untagged                              | new plex-provider flow spec; seed `hasPlex` + a watchlist item with `watchingViaPlex`                                                     |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (specs 0010/0012/0051). Every
  touched lib already has its tag; **this spec does NOT edit `sheriff.config.ts`**.
- **No cross-slice imports.** `slice:settings` owns `hasPlex` (toggle +
  persistence); `slice:title-detail` owns `watchingViaPlex` (toggle + persistence +
  the "Personal Tracking" subsection); `slice:watchlist` only **reads**
  `watchingViaPlex` (read-only badge, no toggle). Each slice reads what it needs via
  `@vultus/shared/domain` types + its own Firestore stream — they do **not** import
  each other. Same pattern 0060 used for `myProviderIds`.
- **No `scope:functions` edge** (decision 6). No callable, no shell token, no
  `@angular/fire/functions` — this feature is a pure client read/write of two
  additive Firestore fields. (Contrast 0060, which needed a `getWatchProviders`
  callable + `GET_WATCH_PROVIDERS` token; 0061 needs neither.)
- **Do NOT extract a shared "Plex badge" component.** The indicator appears in **2**
  slices (watchlist corner tag vs title-detail full row) with genuinely different
  presentations and reasons to change — this is correct vertical-slice duplication,
  not a DRY violation. The 3+-slice extract rule (PLAN §3 / CLAUDE.md) is **not**
  met — same 2-slice/no-extraction reasoning 0060 documented for its
  availability-partition logic.
- **`shared/` additions are additive vocabulary only** (`hasPlex`,
  `watchingViaPlex`, their converter coalesce) — the persisted-contract pattern
  (like `myProviderIds` in 0060, `deliveryHour` in 0051), not a logic extraction.

## Data model touchpoints

PLAN §4 paths. Two changes, **both additive booleans**: one on `users/{uid}`, one
on `users/{uid}/watchlist/{titleId}`. **No new collection, no new index, no
`firestore.rules` change** (see below).

| PLAN §4 path                                | Access                            | By                                                                             |
| ------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `users/{uid}.hasPlex`                        | **read**, **create**, **update**  | settings slice (read on load; default `false` on eager create; write on chip toggle) |
| `users/{uid}.hasPlex`                        | **read**                          | title-detail slice (gates the toggle control's visibility)                     |
| `users/{uid}/watchlist/{titleId}.watchingViaPlex` | **read**, **update**         | title-detail slice (read for active/empty state; write on toggle)              |
| `users/{uid}/watchlist/{titleId}.watchingViaPlex` | **read**                     | watchlist slice (read-only card badge, off the already-streamed item)          |

### `users/{uid}.hasPlex` (additive)

- **Shape:** `hasPlex: boolean` — whether the user uses a Plex server at all.
  **Required** on the domain `User` (mirrors the other required fields); value
  always present (`false` default) on new docs.
- **Default `false`, legacy coalesce.** `dataToUser` reads `data.hasPlex ?? false`
  (a legacy doc pre-0061 lacks the field → `false`), exactly the migration-safe
  pattern `deliveryHour ?? null` (0051) and `myProviderIds ?? []` (0060) use.
  `userToData` passes `hasPlex` through.
- **Eager-create default** (settings `load()`): extend the create literal to
  include `hasPlex: false`.
- **No `firestore.rules` change.** The `users/{userId}` owner rule already covers
  every additive field (spec 0004/0011); confirmed against the current
  `firestore.rules` (the `match /users/{userId} { allow read, write: if
  isOwner(userId) }` block).

### `users/{uid}/watchlist/{titleId}.watchingViaPlex` (additive)

- **Shape:** `watchingViaPlex: boolean` — the per-title manual "I watch THIS via
  Plex" flag. Modelled **required** on the domain `WatchlistItem`, matching how the
  other always-present fields are typed; but the **read data type is optional**
  (`watchingViaPlex?: boolean`) since legacy docs lack it, and `dataToWatchlistItem`
  coalesces `?? false` — the same pattern `posterPath?` / `voteAverage?` /
  `releaseDate?` already use on `WatchlistItemReadData`. (Decision: make it required
  on the domain type + optional on read data + `?? false` on read, so consumers
  never handle `undefined`; the `_watchlistItem` literal must set it.)
- **Legacy coalesce.** `dataToWatchlistItem` reads `data.watchingViaPlex ?? false`;
  `watchlistItemToData` writes `item.watchingViaPlex ?? false`.
- **Write path:** title-detail's `toggleWatchingViaPlex` does a scalar
  `updateDoc(watchlistItemPath(uid, id), { watchingViaPlex })` — a single-field
  write like `updateStatus`'s `{ status }`. It NEVER rewrites the whole item and
  NEVER touches `myProviderIds` / `hasPlex`.
- **No `firestore.rules` change** — the recursive `users/{userId}/{document=**}`
  owner rule already covers the watchlist subcollection.
- **No new `firestore.indexes.json` entry** — the flag is read off docs already
  streamed by `watchlist$` / `tracked$`; there is no `where('watchingViaPlex', …)`
  query.

## Public types / APIs

### Shared domain (additive)

`libs/shared/domain/src/lib/documents.ts` — add one field to each of `User` and
`WatchlistItem`:

```ts
export interface User {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  // (myProviderIds: number[] is added by spec 0060 — keep it; do not remove.)
  /** Whether the user uses a self-hosted Plex server (spec 0061). Gates the
   *  per-title "watching via Plex" toggle in title-detail. A separate boolean —
   *  NOT a member of myProviderIds (Plex has no TMDB id). Default false; legacy
   *  docs missing it → false via the converter. */
  hasPlex: boolean;
}

export interface WatchlistItem {
  type: TitleType;
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: string; // ISO 8601
  status: WatchStatus;
  posterPath?: string | null;
  voteAverage?: number | null;
  releaseDate?: string | null;
  /** Manual per-title override: the user watches THIS title via their Plex
   *  server, regardless of TMDB availability (spec 0061, GitHub #140). Additive
   *  to — never a replacement for — the TMDB availability framing (spec 0060).
   *  Default false; legacy docs missing it → false via the converter. */
  watchingViaPlex: boolean;
}
```

> **Coordination with 0060:** 0060 adds `myProviderIds: number[]` to `User` in the
> same file. When both land, `User` carries both fields. This spec's T1 must NOT
> remove `myProviderIds` if it is already present on the branch; on current `main`
> it is absent (0060 not merged) and only `hasPlex` is added here — the fields are
> orthogonal and additive.

**Required companion edits (type-assertion gates):** in
`libs/shared/domain/src/lib/type-assertions.ts`, both `hasPlex` and
`watchingViaPlex` are **required** fields, so the representative literals fail
`typecheck` unless updated:

- `_user` literal (lines ~102–113): add `hasPlex: false` (and, when composing with
  0060, `myProviderIds: []` — but that is 0060's edit, not this spec's on `main`).
- `_watchlistItem` literal (lines ~115–122): add `watchingViaPlex: false`.

No new entity, no new document, no new token — the domain barrel (`index.ts`)
needs no change (both fields live on already-exported interfaces).

### firestore-schema (additive)

- `data-types.ts`:
  - `UserReadData`: add `hasPlex?: boolean` (optional on read — legacy docs lack
    it). `UserWriteData`: add `hasPlex: boolean` (required on write).
  - `WatchlistItemReadData`: add `watchingViaPlex?: boolean` (optional on read).
    `WatchlistItemWriteData`: add `watchingViaPlex: boolean` (required on write, for
    symmetry with `UserWriteData.hasPlex` — the converter always supplies it via
    `?? false`, so a required write type is always satisfiable).
- `converters.ts`:
  - `userToData`: add `hasPlex: user.hasPlex`.
  - `dataToUser`: add `hasPlex: data.hasPlex ?? false`.
  - `watchlistItemToData`: add `watchingViaPlex: item.watchingViaPlex ?? false`.
  - `dataToWatchlistItem`: add `watchingViaPlex: data.watchingViaPlex ?? false`.
- **No `paths.ts` change** (no new collection). **No new converter functions** (no
  new document shape).

### Settings slice surface (`libs/mobile/settings`)

`SettingsService` gains:

```ts
/** Whether the user uses a Plex server (persisted on users/{uid}; default false). */
readonly hasPlex: Signal<boolean>;

/** Toggles hasPlex and persists it via updateDoc({ hasPlex }). Null-uid guarded.
 *  Separate from 0060's toggleProvider — Plex is not a catalog entry. */
toggleHasPlex(): Promise<void>;
```

- Add `_hasPlex = signal<boolean>(false)` backing `hasPlex`.
- `load()`: read `user.hasPlex` into `_hasPlex`; add `hasPlex: false` to the
  eager-create `User` literal (required field — verify it compiles). When composing
  with 0060, that literal also carries `myProviderIds: []` — both are additive.
- `toggleHasPlex` computes `!this._hasPlex()`, persists via
  `updateDoc(doc(firestore, userPath(uid)), { hasPlex: next })` (a scalar write,
  like `setRegion`'s `{ region }`), then sets `_hasPlex`. Null-uid guarded.
- **Mock (`settings.providers.mock.ts` `MockSettingsServiceImpl`)** mirrors the new
  surface: a seeded `_hasPlex = signal(true)` (so `mobile:serve-mock` shows the Plex
  chip selected) + `toggleHasPlex` flipping the in-memory signal (no Firestore).
  Update the mock's doc comment to list `hasPlex` / `toggleHasPlex`.

`SettingsPage` (`settings.page.ts`): add `onPlexToggle()` calling
`service.toggleHasPlex()`; register any needed icon; render the Plex chip in the
"My Providers" chip grid (see UI section). The chip's selected/unselected visual
state maps to `hasPlex()`, using the SAME border/badge/opacity treatment 0060
pinned for its catalog chips — just a different backing boolean.

> **Coordination with 0060:** the Plex chip sits in the SAME "My Providers" card
> 0060 builds. On current `main` that card does not exist yet (0060 unmerged). This
> spec pins the Plex chip **relative to** 0060's chip grid: it is the last chip in
> the same `@for`-rendered flex row, but rendered from a **separate template block**
> (not a member of `service.providerCatalog()`), with `(click)="onPlexToggle()"` and
> `[class.selected]="service.hasPlex()"`. If 0061 is implemented before 0060 merges,
> the implementer builds the "My Providers" card shell as 0060 specifies it (a
> wrapping chip row) and adds the Plex chip into it — flag the 0060 dependency in
> the PR (see Risks).

### Title-detail slice surface (`libs/mobile/title-detail`)

`TitleDetailService` gains:

```ts
/** Whether the user uses Plex (users/{uid}.hasPlex); null uid / missing doc →
 *  false. Gates the "Personal Tracking" toggle control's visibility. */
hasPlex$(): Observable<boolean>;

/** Persists the per-title watchingViaPlex override via
 *  updateDoc(watchlistItemPath(uid, id), { watchingViaPlex }). No-op on null uid. */
toggleWatchingViaPlex(tmdbId: number, watchingViaPlex: boolean): Promise<void>;
```

- `hasPlex$()`: read `users/{uid}` via `docData` + `dataToUser`, map to `.hasPlex`
  (default `false`). Mirror the existing `region$()` shape (same `docData` +
  `dataToUser` path); prefer folding it into the same user stream if `region$` is
  refactored, but a sibling read of the same doc is acceptable (the doc is already
  small). Null uid → `of(false)`.
- `toggleWatchingViaPlex`: `updateDoc(doc(firestore, watchlistItemPath(uid,
  String(tmdbId))), { watchingViaPlex })` — a single-field write. No-op on null uid.
- The **current** `watchingViaPlex` value is read off the existing `tracked$`
  stream (which already returns the full `WatchlistItem` via
  `dataToWatchlistItem`, now carrying `watchingViaPlex`) — **no new stream** needed
  for the read. Fold `hasPlex$()` into `vm$` as an additional combined source (a
  new `combineLatest` member alongside `tracked$`, `providers$`, `region$`).
- Extend the page `DetailVm` interface with `hasPlex: boolean`. The active/empty
  Plex state derives from `vm.tracked?.watchingViaPlex` (read unconditionally); the
  whole "Personal Tracking" subsection is omitted when `vm.hasPlex === false`.

`TitleDetailPage` (`title-detail.page.ts`): add `togglePlex(tracked: WatchlistItem)`
calling `service.toggleWatchingViaPlex(tracked.tmdbId, !tracked.watchingViaPlex)`;
register any needed icon.

### Watchlist slice surface (`libs/mobile/watchlist`)

- **No service change.** `watchingViaPlex` arrives on each `WatchlistItem` via the
  existing `watchlist$` stream (`dataToWatchlistItem` now carries it). The card
  reads `item.watchingViaPlex` directly — **no new Firestore listener, no new
  method** (contrast 0060, which needed a `myProviderIds$` stream because that field
  lives on `users/{uid}`, not on the item; here the flag lives ON the item, so it is
  already in hand).
- `watchlist.page.html`: in the card's existing corner slot, render a small
  read-only Plex tag when `item.watchingViaPlex` is true, **alongside** 0060's
  availability pill (never replacing it — decision 4).

## UI / Stitch screen refs

**Authoritative tokens** live in `docs/design/vultus-design-system.md`, consumed
via the wired `--vultus-*` / `--ion-*` vars in
`libs/shared/ui-kit/src/lib/theme.scss`. **Never hand-transcribe a hex** — primary
is `#4edea3` (`--ion-color-primary` / `--vultus-primary`), **not** `#10B981`
(that's `primary-container`). `surface-container #171f33`, `on-surface #dae2fd`,
`on-surface-variant #bbcabf`, `outline-variant #3c4a42`.

> **The Plex logo is a bundled static image asset — NOT a hand-built brand-hex
> tile.** The verified canonical render (`562019f29ce2412d90c757a7e45a98bf`)
> displays the Plex logo as an `<img>` inside a **neutral `surface-container-highest`
> theme-token tile** (the same tile treatment used by other icon slots in the "Where
> to Watch" card), NOT a charcoal-plus-orange tile composed from hard-coded Plex
> brand hex. **There is no hard-coded Plex brand hex anywhere in this feature.** The
> implementer bundles a static Plex logo image under `apps/mobile/public/assets/`
> (the mobile app serves `apps/mobile/public/**` at the web root — see
> `apps/mobile/project.json` `assets` glob; e.g. `apps/mobile/public/assets/plex-logo.png`
> referenced as `/assets/plex-logo.png`; follow whatever precedent the repo adopts
> for its first bundled image if none exists yet) and renders it in a tile styled
> **entirely with `--vultus-*` / `--ion-*` vars**. All three Plex renderers (Settings
> chip, title-detail row, watchlist badge) use this same bundled asset — brand colour
> lives in the image, not in SCSS. **No hard-coded hex of any kind** in the new
> templates/SCSS. (See Risks for the asset-sourcing caveat.)

> The Tailwind-flavoured class names quoted below (`bg-primary/10`, etc.) are the
> tokens **as they appear in the fetched Stitch markup**; in-repo the implementer
> wires the equivalent `--vultus-*` / `--ion-*` vars through the slice's SCSS (the
> app is Ionic/Angular SCSS, not Tailwind). The **token intent** is what's pinned.

### Fetch recipe (all screens — CLAUDE.md contract)

For each screen: `list_screens` in `projects/13590348714018893783` → confirm the
id → `get_screen` (metadata + URLs) → fetch `htmlCode.downloadUrl` via a plain
`Invoke-WebRequest` (**NOT** WebFetch, which strips CSS) for the concrete markup,
and `screenshot.downloadUrl` for the visual compare. A failed MCP call is a
**retry**, not a fallback to token-only (project memory `stitch-mcp-reachable.md`:
the MCP is reachable from the orchestrator).

### (A) Settings — Plex chip in "My Providers" (Stitch "Settings - My Providers - Vultus", screen id `cebdfd02c7d44023b0e0019dd4907d48`)

This is the **SAME screen 0060 references** — it has been edited **twice**: once by
0060 to add the "My Providers" card + its 6 TMDB chips, once more to add a **7th
chip: Plex**. **Pull the current live state fresh** (raw HTML per the recipe) — it
has all 7 chips. Read the Plex chip's real markup before touching
`settings.page.html`.

**Checkable contract for the Plex chip (tick each vs the fetched markup + screenshot):**

| Element                    | Spec                                                                                                                                                                                                 | Token / var                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Chip footprint**         | Same width/height as the sibling TMDB chips (0060 pins ~96px wide; the Plex chip **must not drift** from that). Same wrap-row gap.                                                                    | (matches 0060 chip metrics)                    |
| **Logo tile**              | A neutral logo tile (theme-token background, same radius as the sibling chip logos) containing the **bundled Plex logo image** (`<img>` from `apps/mobile/public/assets/`, `object-cover` filling the tile). NO hard-coded brand hex — the tile background uses a `--vultus-*` surface token and the brand colour lives in the image.             | `--vultus-*` surface token + bundled logo asset |
| **Name label**             | "Plex" — `label-sm`, centered, `on-surface` (same type role as sibling chip names).                                                                                                                  | `--vultus-on-surface`                          |
| **Secondary label**        | A small caption **"Manual"** under the chip name, `label-sm`/muted, distinguishing Plex from real subscriptions (no automatic availability). Sibling TMDB chips have **no** secondary label.          | `--vultus-on-surface-variant`                  |
| **Selected (`hasPlex` true)** | `border-2` in `--ion-color-primary`; a `check_circle` (`checkmark-circle`) badge overlapping the top-right of the logo, primary-coloured; full opacity — **identical treatment to 0060's selected TMDB chips**, just backed by `hasPlex` instead of `myProviderIds` membership. | `--ion-color-primary`                          |
| **Unselected (`hasPlex` false)** | `border` (1px) in `outline-variant` (~20% alpha); `opacity: 0.6`; no badge — identical to 0060's unselected chip.                                                                             | `--vultus-outline-variant`                     |

**Structure note:** the Plex chip is a **`<button>`-role chip in the same wrapping
row** as 0060's catalog chips, but rendered from its **own template block** (NOT a
member of the `@for` over `service.providerCatalog()`), with `aria-pressed` bound to
`hasPlex()` and `(click)="onPlexToggle()"`. It is NOT an `ion-segment`/`ion-select`
member.

**Interactive-state contract (tick each):**

| Element    | default                                          | focus                 | active/press                                        | selected result                                                              |
| ---------- | ------------------------------------------------ | --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Plex chip  | unselected (border, 60% opacity) OR selected (primary border + badge, full opacity) per `hasPlex()` | `:focus-visible` ring | subtle press feedback (opacity/scale) consistent with the sibling chips; no lift | tapping calls `toggleHasPlex`; the chip flips selected/unselected with the same border+badge+opacity transition 0060 pinned |

- **Font loading:** Inter is loaded app-wide (spec 0010) — confirm the chip renders
  in Inter (a named token only renders if the font is actually loaded).
- **Placement:** the Plex chip is the last chip in the "My Providers" chip grid
  (per the Stitch edit).

### (B) Title-detail — "Personal Tracking" subsection (Stitch "Movie Detail - Personal Tracking - Vultus", screen id `562019f29ce2412d90c757a7e45a98bf`)

This is the **canonical, in-context render.** The user consolidated four
duplicate/divergent detail-page versions into this single screen (height 4510, same
project `projects/13590348714018893783`); it renders the "Personal Tracking"
subgroup in full, correct context — at the bottom of the "Where to Watch" card,
after 0060's "On Your Providers" / "Also Available On" groups, separated by the same
divider convention. **Pull `562019f2…` fresh** (raw HTML per the recipe) + its
screenshot for the concrete values and the visual compare.

> **Superseded screens — do NOT cite as current.** The old standalone fragment
> "Title Detail - Plex Override" (`9e622d7b8aec40ec8319a4e30b62f2a9`) and the
> old/intermediate detail screens "Movie Detail - Vultus"
> (`208cb8d7a679490b8d13672c6943d6d3`) and "Movie Detail - Watch Providers - Vultus"
> (`dfc2c7b98a9f46d2bff9b7722fd192b7`) are **stale/superseded** by the consolidated
> `562019f2…`. Do not pull or reference them for this section.

Placement: a new **"Personal Tracking"** subsection at the **bottom** of the "Where
to Watch" card (`title-detail.page.html`), **below** 0060's flatrate "On Your
Providers" / "Also Available On" groups (and below any rent/buy groups), separated
by the same `border-t border-outline-variant/10 mt-md pt-md` divider convention the
card uses between its groups. (0060's internal two-group partition logic is 0060's
concern; from this spec's view they are simply the two groups sitting above this
one, positioned by the same divider convention.) The whole subsection is rendered
**only when `vm.hasPlex === true`** (decision 3) — when `hasPlex` is false, omit it
entirely (not even the empty-state row).

**Verified subgroup markup** (from `562019f2…`, immediately after the divider that
follows 0060's two groups):

```html
<div class="space-y-3">
  <div class="text-on-surface-variant font-label-sm text-label-sm uppercase tracking-wider">Personal Tracking</div>
  <!-- ACTIVE row (watchingViaPlex true) -->
  <div class="flex items-center justify-between p-3 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer group">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-lg bg-surface-container-highest flex items-center justify-center text-primary flex-shrink-0">
        <img src="[bundled Plex logo asset]" alt="Plex Logo" class="w-full h-full object-cover rounded-lg">
      </div>
      <div>
        <p class="text-on-surface font-bold text-body-md">Watching via Plex</p>
        <p class="text-on-surface-variant text-label-sm">Local Server</p>
      </div>
    </div>
    <button class="text-primary font-label-md text-label-md hover:underline">Change</button>
  </div>
  <!-- EMPTY/UNSET row (watchingViaPlex false) — only one of the two renders at runtime -->
  <div class="flex items-center justify-between p-3 rounded-lg border border-dashed border-outline-variant/30 hover:border-primary/50 transition-colors cursor-pointer group">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-lg flex items-center justify-center text-on-surface-variant/50 flex-shrink-0">
        <span class="material-symbols-outlined">add</span>
      </div>
      <p class="text-on-surface-variant/70 text-body-md">Mark as watching via Plex</p>
    </div>
  </div>
</div>
```

(The mock stacks both states for illustration; at runtime exactly one renders per
`watchingViaPlex`.)

**Checkable contract (tick each vs the fetched `562019f2…` markup + screenshot):**

| State                     | Structure                                                                                                                                                                                                                            | Token intent                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Subsection header**     | A subgroup label **"Personal Tracking"** — `label-sm`, `uppercase`, letter-spaced (`tracking-wider`), `on-surface-variant`; same type role / treatment as the sibling group labels in the card.                                        | `--vultus-on-surface-variant`, `label-sm`                                 |
| **Active (`watchingViaPlex` true)** | A row (`p-3`, `rounded-lg`, `surface-container` background): a **`w-10 h-10` (40×40) `rounded-lg` `surface-container-highest` logo tile** holding the **bundled Plex logo `<img>`** (`w-full h-full object-cover rounded-lg`), `gap-3` to the text · **bold "Watching via Plex"** (`text-on-surface`, `body-md`, `font-bold`) · muted caption **"Local Server"** (`text-on-surface-variant`, `label-sm`) · a **text-only "Change" button** at the row end (`text-primary`, `label-md`, `hover:underline`) to unset it. | `--vultus-surface-container` / `--vultus-surface-container-highest` (tiles) · `--vultus-on-surface` · `--vultus-on-surface-variant` · `--ion-color-primary` (Change button + text) · bundled logo asset |
| **Empty/unset (`watchingViaPlex` false)** | A row (`p-3`, `rounded-lg`) with a **dashed 1px border** (`outline-variant` ~30% alpha), a **`w-10 h-10` tile holding a muted `material-symbols-outlined` "add" glyph** (`on-surface-variant` ~50% alpha), and text **"Mark as watching via Plex"** (`text-on-surface-variant` ~70% alpha, `body-md`) — the tappable affordance that sets the flag. | `--vultus-outline-variant` (dashed) · `--vultus-on-surface-variant` · `--ion-color-primary` (hover border) |

- **The row is the tappable target** (`cursor-pointer` on both rows). Empty-state
  tap → `togglePlex(tracked)` sets `watchingViaPlex` true. Active-state "Change"
  button → `togglePlex(tracked)` sets it false. Both call the same handler (it flips
  the current value).
- **Dimensions:** logo/icon tile is **40×40 (`w-10 h-10`)**, `rounded-lg`; row inset
  `p-3`; text-to-tile gap `gap-3`. Both rows share the same inset/height so they
  swap in place.
- **Type roles:** header = `label-sm` uppercase; "Watching via Plex" = `body-md`
  bold (`on-surface`); caption "Local Server" = `label-sm` (`on-surface-variant`);
  "Change" button = `label-md` (`primary`); empty-row text = `body-md`
  (`on-surface-variant`, muted).
- **Interactive states (tick each vs the markup):**
  - **Active row** — default (`surface-container` bg) / **hover** (`surface-container-high` bg, `transition-colors`) / focus (`:focus-visible` ring) / press (subtle feedback consistent with the card). No disabled state.
  - **"Change" button** — default (`primary` text) / **hover** (`hover:underline`) / focus / press / → on tap, transitions the subsection back to the dashed empty row.
  - **Empty row** — default (dashed `outline-variant/30` border, muted icon+text) / **hover** (`border-primary/50`, `transition-colors`) / focus (`:focus-visible` ring) / press / → on tap, transitions to the active row.
- **Additivity check (decision 4):** this subsection renders **in addition to**
  0060's provider groups — asserting the provider rows above it are unchanged
  whether `watchingViaPlex` is true or false is part of the DoD.
- **Font loading:** Inter is loaded app-wide (spec 0010); confirm the rows render in
  Inter (a named token only renders if the font is actually loaded). The `add` glyph
  requires the Material Symbols font to be loaded — confirm it renders (not the raw
  ligature text).
- **Visual verification (CLAUDE.md):** this section is now Stitch-cited and rendered
  in context, so standard visual-verification treatment applies (screenshot compare
  via `mobile:serve-mock` against `562019f2…`), same as any other Stitch-cited
  screen — no special "unverified for a human" carve-out.

### (C) Watchlist card — read-only Plex badge (Stitch "Advanced Watchlist - Vultus", screen id `19f0eae3d6d24eaa90b3aa73ff44a59b`) — **layout precedent only, NOT a literal Plex-badge citation**

**No Stitch edit was made to this screen for Plex.** Pull it fresh **only** for the
**corner-badge slot layout/spacing precedent** — the card's `flex flex-col
items-end gap-sm` corner slot (where 0060's availability pill sits). The Plex badge
is **positioned by that same convention**, but its concrete Plex-badge markup is
**NOT Stitch-cited** — do not overclaim fidelity here.

**Checkable contract (tick each):**

| Element             | Spec                                                                                                                                                                                                       | Token intent                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Plex badge**      | A **compact** tag using the **bundled Plex logo image** (the same asset the other two renderers use) and/or a short "Plex" label, on a neutral theme-token background, small enough to fit the card's `items-end gap-sm` corner slot beside 0060's availability pill. `label-sm`/tiny scale, matching the card's meta scale. No hard-coded brand hex — brand colour lives in the logo image; the badge chrome uses `--vultus-*` / `--ion-*` vars. | bundled logo asset · `--vultus-*` chrome · card meta type role |
| **Placement**       | In the SAME corner slot as 0060's availability pill, **stacked with `gap-sm`** below/beside it — **additive**, never replacing the pill (decision 4). When `watchingViaPlex` is false, the badge is absent and the pill renders exactly as 0060 defines it. | (0060 corner-slot convention)            |
| **Interactivity**   | **Read-only** — non-interactive/presentational. The card itself remains the tappable target (unchanged). No hover/focus/active on the badge. Toggling happens only in title-detail (decision 5).            | (existing card interactivity)            |

- **Composition with 0060:** the badge is a small extra element inside the existing
  `flex flex-col items-end gap-sm` corner container, gated by `@if
  (item.watchingViaPlex)`. It does NOT alter the availability-pill markup 0060 adds.

> **Watchlist card unchanged by the new screen.** The consolidated
> `562019f2…` covers title-detail only, not the watchlist card. This section stays
> **layout-precedent-only** (no literal Plex-badge Stitch citation) exactly as
> before — the new screen does not verify a watchlist Plex badge.

### Visual verification (CLAUDE.md)

Serve `pnpm nx run mobile:serve-mock` and screenshot: (1) the Settings "My
Providers" card showing the **selected Plex chip** (mock seeds `hasPlex: true`)
against screen `cebdfd02c7d44023b0e0019dd4907d48`; (2) a title-detail "Where to
Watch" card showing the **active "Watching via Plex" row** ("Local Server" caption)
below the provider groups — compared against the canonical in-context screen
`562019f29ce2412d90c757a7e45a98bf` (standard screenshot compare, same as any
Stitch-cited screen); (3) a watchlist card showing the read-only Plex badge
alongside the availability pill — noting the badge is layout-precedent-only, not
Stitch-cited. A green build does NOT prove fidelity; if `mobile:serve-mock` can't
run under tooling, flag the relevant screens unverified for a human.

## Implementation task graph

T1 (shared domain) and T2 (schema) are shared-root edits every consumer compiles
against — sequential, first. The three mobile slices (T3 settings, T4 title-detail,
T5 watchlist) are independent and parallel after T1/T2. The e2e (T6) depends on the
chain and seeds against it. There is **no backend path** (no callable, no shell
token, no TMDB) — 0061 is `scope:mobile` + `scope:shared` only.

**T1 — Shared domain: `hasPlex` + `watchingViaPlex` + assertion literals [sequential]** (backend-engineer / domain)

- `documents.ts`: add `hasPlex: boolean` to `User`; add `watchingViaPlex: boolean`
  to `WatchlistItem`.
- `type-assertions.ts`: add `hasPlex: false` to the `_user` literal; add
  `watchingViaPlex: false` to the `_watchlistItem` literal (both required → typecheck
  gates). Do NOT disturb any 0060 fields if present on the branch.
- No barrel change (both interfaces already exported).
- Update `libs/shared/domain/README.md` (the two new `User` / `WatchlistItem` fields).
- Files: `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/src/lib/type-assertions.ts`,
  `libs/shared/domain/README.md`.

**T2 — firestore-schema: `hasPlex` + `watchingViaPlex` coalesce + tests [sequential, after T1]** (backend-engineer)

- `data-types.ts`: `hasPlex?: boolean` on `UserReadData`, `hasPlex: boolean` on
  `UserWriteData`; `watchingViaPlex?: boolean` on `WatchlistItemReadData` (and on
  `WatchlistItemWriteData`).
- `converters.ts`: `userToData` (`hasPlex: user.hasPlex`) + `dataToUser`
  (`hasPlex: data.hasPlex ?? false`); `watchlistItemToData`
  (`watchingViaPlex: item.watchingViaPlex ?? false`) + `dataToWatchlistItem`
  (`watchingViaPlex: data.watchingViaPlex ?? false`).
- No `paths.ts` change; no new converter.
- Extend `firestore-schema.spec.ts`: user round-trip includes `hasPlex`
  (true/false + a legacy doc missing it → `false`); watchlist-item round-trip
  includes `watchingViaPlex` (true/false + a legacy doc missing it → `false`).
- Update `libs/shared/firestore-schema/README.md`.
- Files: `libs/shared/firestore-schema/src/lib/data-types.ts`,
  `libs/shared/firestore-schema/src/lib/converters.ts`,
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md`.

**T2b — Bundle the Plex logo image asset [sequential, after T1; before T3/T4/T5]** (frontend-engineer)

- Source a static Plex logo image and add it under the mobile app's bundled assets:
  `apps/mobile/public/assets/plex-logo.png` (or `.svg`/`.webp`), served at
  `/assets/plex-logo.png` via `apps/mobile/project.json`'s existing
  `{ glob: "**/*", input: "apps/mobile/public" }` assets entry. If the repo has no
  `apps/mobile/public/assets/` dir yet, create it (this is the first bundled image;
  follow the `favicon.ico`-in-`public/` precedent).
- **This is a shared, single file** consumed by all three slice renderers (Settings
  chip, title-detail row, watchlist badge) **by URL path** (`/assets/plex-logo.png`)
  — NOT a lib import, so it does not create a cross-slice Sheriff edge. It is
  sequenced **before** the parallel fan-out so T3/T4/T5 don't each try to add it
  (keeps their manifests disjoint).
- See Risks for the asset-sourcing/licensing caveat and the no-asset fallback.
- Files: `apps/mobile/public/assets/plex-logo.<ext>` (and, only if the assets glob
  needs a new entry — it should not, the `**/*` glob already covers it,
  `apps/mobile/project.json`).

**T3 — Settings: Plex chip + `hasPlex` toggle + mock + tests [parallel, after T1/T2/T2b]** (frontend-engineer)

- `settings.service.ts`: add `_hasPlex` signal + `hasPlex` readonly; `toggleHasPlex()`
  (scalar `updateDoc({ hasPlex })`, null-uid guarded); read `hasPlex` in `load()`;
  add `hasPlex: false` to the eager-create `User` literal (required field — verify
  it compiles).
- `settings.providers.mock.ts`: add `_hasPlex = signal(true)` + `hasPlex` +
  `toggleHasPlex`; update the doc comment.
- `settings.page.ts`: `onPlexToggle()`; register any new icon.
- `settings.page.html`: the Plex chip in the "My Providers" chip grid per the UI
  contract (its own template block, selected state bound to `hasPlex()`).
- `settings.page.scss`: the Plex chip styling — a neutral logo tile holding the
  bundled Plex logo image; **all** colours via `--vultus-*` / `--ion-*` (no
  hard-coded hex; brand colour lives in the image asset).
- Update `libs/mobile/settings/README.md`.
- Extend `settings.service.spec.ts` (`toggleHasPlex` flips + persists `hasPlex`;
  `load` reads it; eager-create default `false`; null-uid guard) and
  `settings.page.spec.ts` (the Plex chip renders, tap calls `onPlexToggle`, selected
  state reflects `hasPlex`).
- Files: `libs/mobile/settings/src/lib/settings.service.ts`,
  `libs/mobile/settings/src/lib/settings.service.spec.ts`,
  `libs/mobile/settings/src/lib/settings.providers.mock.ts`,
  `libs/mobile/settings/src/lib/settings.page.ts`,
  `libs/mobile/settings/src/lib/settings.page.html`,
  `libs/mobile/settings/src/lib/settings.page.scss`,
  `libs/mobile/settings/src/lib/settings.page.spec.ts`,
  `libs/mobile/settings/README.md`.

> **0060 composition note (T3):** if 0060's "My Providers" card is not yet present
> on the branch, T3 builds the Plex chip into a "My Providers" card shell matching
> 0060's spec (wrapping chip row); if 0060 IS present, T3 adds only the Plex chip
> template block into the existing card. Either way T3 writes only
> `libs/mobile/settings/**` (disjoint from all other 0061 tasks) — see Risks for the
> 0060 ordering caveat.

**T4 — Title-detail: "Personal Tracking" subsection + `watchingViaPlex` toggle + tests [parallel, after T1/T2/T2b]** (frontend-engineer)

- `title-detail.service.ts`: add `hasPlex$()` (read `users/{uid}.hasPlex`, default
  `false`); add `toggleWatchingViaPlex(tmdbId, watchingViaPlex)` (scalar
  `updateDoc({ watchingViaPlex })`, null-uid guarded). The current `watchingViaPlex`
  is read off `tracked$` (already carries it) — no new read stream.
- `title-detail.page.ts`: extend `DetailVm` with `hasPlex: boolean`; fold `hasPlex$()`
  into `vm$`'s `combineLatest`; add `togglePlex(tracked)`; register any new icon.
- `title-detail.page.html`: the "Personal Tracking" subsection at the bottom of the
  "Where to Watch" card (below 0060's flatrate split + rent/buy), gated by
  `vm.hasPlex`, with active/empty states per the UI contract.
- `title-detail.page.scss`: the subsection + row styling — a neutral
  `surface-container-highest` logo tile holding the bundled Plex logo image; **all**
  colours via `--vultus-*` / `--ion-*` (no hard-coded hex).
- Update `libs/mobile/title-detail/README.md`.
- Extend `title-detail.page.spec.ts`: `hasPlex` false → subsection absent;
  `hasPlex` true + `watchingViaPlex` false → empty affordance renders, tap calls
  `togglePlex` → `toggleWatchingViaPlex(id, true)`; `hasPlex` true +
  `watchingViaPlex` true → active row ("Local Server" caption) + "Change" button,
  tap → `toggleWatchingViaPlex(id, false)`; and (additivity) the provider groups
  render unchanged regardless of `watchingViaPlex`. `title-detail.service.spec.ts`:
  `hasPlex$` maps the doc / null uid → false; `toggleWatchingViaPlex` writes the
  scalar / null-uid no-op.
- **Visually verify against the canonical Stitch screen** "Movie Detail - Personal
  Tracking - Vultus" (`562019f29ce2412d90c757a7e45a98bf`) — this section is now
  Stitch-cited and rendered in context, so standard screenshot-compare treatment
  applies (no "unverified for a human" carve-out). Do NOT cite the superseded
  fragment `9e622d7b…` or the old screens `208cb8d7…` / `dfc2c7b9…`.
- Files: `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.service.spec.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.page.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.page.html`,
  `libs/mobile/title-detail/src/lib/title-detail.page.scss`,
  `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`,
  `libs/mobile/title-detail/README.md`.

**T5 — Watchlist: read-only Plex badge + tests [parallel, after T1/T2/T2b]** (frontend-engineer)

- **No service change** — `watchingViaPlex` arrives on the streamed `WatchlistItem`.
- `watchlist.page.html`: in the card's `items-end gap-sm` corner slot, render the
  read-only Plex badge `@if (item.watchingViaPlex)`, alongside 0060's availability
  pill (never replacing it).
- `watchlist.page.scss`: the compact Plex badge — the bundled Plex logo image on a
  neutral theme-token background; all badge chrome via `--vultus-*` / `--ion-*` (no
  hard-coded hex).
- Update `libs/mobile/watchlist/README.md` (the read-only Plex indicator).
- Extend `watchlist.page.spec.ts`: an item with `watchingViaPlex: true` renders the
  Plex badge; an item with it false/absent does not; the availability pill/badge is
  present in both cases (additivity — badge does not replace the pill).
- Files: `libs/mobile/watchlist/src/lib/watchlist.page.html`,
  `libs/mobile/watchlist/src/lib/watchlist.page.scss`,
  `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
  `libs/mobile/watchlist/README.md`.

> **0060 composition note (T5):** the `items-end gap-sm` corner slot does not exist
> on current `main` — it is introduced by 0060's watchlist UI change (screen
> `19f0eae3…`). Today's card renders `availability-badge` / `provider-badge` inline
> in `.card-meta` (`watchlist.page.html` ~lines 164–168). If 0060 is already on the
> branch when T5 runs, use its corner slot as specified above. If it is NOT yet
> present, place the Plex badge inline next to the existing `availability-badge` /
> `provider-badge` instead (same additive rule — never replacing it), and state
> which placement was used in the PR, exactly as T3 already does for the Settings
> card shell.

**T6 — e2e: plex-provider flow + seed [sequential, after T3/T4/T5]** (frontend-engineer / qa)

- Extend the seeded fixture (`apps/mobile-e2e/emulator-data/seeded/docs.json`): set
  `hasPlex: true` on `users/{uid}`, and add `watchingViaPlex: true` to one seeded
  watchlist item that ALSO has `availability/{region}` flatrate providers (so the
  additivity assertion — Plex badge AND provider pill both present — is checkable).
  Reuse the same emulator/TMDB-fixture conventions the existing suite (0046/0054,
  and 0060's T9) uses; extend rather than duplicate where practical, but 0061 seeds
  its own doc fields independently (separate spec/PR).
- Add `apps/mobile-e2e/src/plex-provider.spec.ts` covering the two named assertions
  (see Test plan). No TMDB route is needed if the flow reads only seeded Firestore
  (availability is pre-seeded); route TMDB via the existing `routeTmdb` fixtures
  only if a live-detail path is exercised.
- Files: `apps/mobile-e2e/src/plex-provider.spec.ts`,
  `apps/mobile-e2e/emulator-data/seeded/docs.json` (+ availability fixtures under
  `emulator-data/seeded/` if separate).

**Disjointness (for the parallel fan-out):** T1/T2/T2b are sequential and run
first — in particular **T2b writes the single shared Plex logo asset**
(`apps/mobile/public/assets/plex-logo.<ext>`) that all three slices consume by URL,
so no parallel task writes it. After T1/T2/T2b, the parallel-eligible tasks write
disjoint manifests — T3 `libs/mobile/settings/**`, T4 `libs/mobile/title-detail/**`,
T5 `libs/mobile/watchlist/**`. T6 (`apps/mobile-e2e/**`) is sequential after
T3+T4+T5. No task writes a file another parallel task writes.

## Test plan

Per the PLAN §5 pyramid — unit (domain/converter), component (settings,
title-detail, watchlist pages), e2e (one named flow). All Firebase access in
unit/component tests is mocked; no emulator (project memory: the emulator cannot
run under Claude Code tools here — the e2e gate runs in CI).

**Unit (shared/domain + firestore-schema):**

- `hasPlex` / `watchingViaPlex` compile; the `_user` literal (with `hasPlex`) and
  `_watchlistItem` literal (with `watchingViaPlex`) are compile-time gates.
- Converter round-trip (`firestore-schema.spec.ts`): a `User` with `hasPlex: true`
  and `hasPlex: false` round-trips; a **legacy doc omitting `hasPlex` → `false`** via
  `dataToUser`. A `WatchlistItem` with `watchingViaPlex: true`/`false` round-trips;
  a **legacy item omitting it → `false`** via `dataToWatchlistItem`.

**Component (settings — `settings.page.spec.ts`, mocked service):**

- The Plex chip renders in the "My Providers" grid; when `hasPlex()` is true it
  shows the selected styling/badge, when false the muted styling; tapping the Plex
  chip calls `onPlexToggle` → `toggleHasPlex`. The "Manual" secondary label is
  present. Existing settings assertions (region, notifications, delivery-hour,
  render-gate, error state — and 0060's TMDB chips if composed) stay green.

**Unit (settings — `settings.service.spec.ts`, mocked Firestore):**

- `toggleHasPlex` flips and persists `hasPlex` (`updateDoc({ hasPlex })`); `load()`
  reads it (default `false`); eager-create writes `hasPlex: false`; null-uid guards
  the write.

**Component (title-detail — `title-detail.page.spec.ts`, mocked service):**

- `hasPlex` false → the "Personal Tracking" subsection is absent.
- `hasPlex` true + `watchingViaPlex` false → the empty "Mark as watching via Plex"
  affordance renders; tapping it calls `togglePlex` → `toggleWatchingViaPlex(id, true)`.
- `hasPlex` true + `watchingViaPlex` true → the active "Watching via Plex" row +
  "Change" button render; tapping "Change" → `toggleWatchingViaPlex(id, false)`.
- **Additivity:** the flatrate/rent/buy provider groups (and 0060's split when
  composed) render unchanged whether `watchingViaPlex` is true or false.

**Unit (title-detail — `title-detail.service.spec.ts`, mocked Firestore):**

- `hasPlex$()` maps `users/{uid}.hasPlex` (default `false`); null uid → `false`.
- `toggleWatchingViaPlex` writes the scalar `{ watchingViaPlex }` to the item path;
  null-uid → no-op.

**Component (watchlist — `watchlist.page.spec.ts`, mocked service):**

- An item with `watchingViaPlex: true` renders the read-only Plex badge; an item
  with it false/absent does not. In BOTH cases the availability pill/badge (0060, or
  the existing provider badge on `main`) is present — the Plex badge is additive,
  not a replacement. Existing card assertions (poster, title, status chip, delete)
  stay green.

**e2e (rubric): REQUIRED — one new flow.** This is a `scope:mobile` feature that
introduces a new primary user-facing control (the title-detail "Personal Tracking"
toggle that persists per-title state) and a new watchlist availability signal. Per
the rubric, name the flow:

- **`plex-provider.spec.ts` — "manual Plex tagging shows alongside provider
  availability"**: seed `users/{uid}.hasPlex = true` and a watchlist title with
  `watchingViaPlex: true` AND an `availability/{region}` with ≥1 flatrate provider.
  (a) Open that title in title-detail: the "Personal Tracking" subsection shows the
  active **"Watching via Plex"** row AND the existing provider availability (the
  flatrate group / 0060's split) still renders unchanged below/above it. (b) On the
  watchlist list, that same title shows the **read-only Plex badge alongside** its
  availability pill. (Optionally, if practical: from title-detail tap "Change" /
  "Mark as watching via Plex" and assert the flag round-trips to the watchlist badge
  — but the two seeded assertions above are the required gate; the toggle
  round-trip can be `test.fixme` with a comment if the emulator write-then-observe
  timing isn't already exercised by the suite.)

Extend the seed per T6; reuse the `apps/mobile-e2e` emulator + TMDB-fixture
conventions (specs 0046/0054, 0060 T9). This flow is a DoD gate enforced by
`qa-runner` / `feature-reviewer`. The Firestore emulator runs in CI (project memory
`ci-runs-e2e-emulator.md`), not under Claude Code tools locally.

## Definition of done

Tailored from PLAN §5. Affected: `shared-domain`, `shared-firestore-schema`,
`mobile-settings`, `mobile-title-detail`, `mobile-watchlist`, `mobile-e2e`.

- [ ] `pnpm nx typecheck` passes for all affected projects — `hasPlex`,
      `watchingViaPlex`, the converter changes, and the three slice UIs compile; the
      `_user` and `_watchlistItem` literal gates hold.
- [ ] `pnpm nx lint <affected>` passes **with Sheriff active**: no slice imports
      another slice; no `scope:mobile` ↔ `scope:functions` edge (none introduced);
      the Plex indicator stays duplicated per slice (2 slices, not extracted); no
      `@angular/fire/functions` / callable / shell token added.
- [ ] `pnpm nx test shared-firestore-schema` — `hasPlex` (true/false/missing→false)
      + `watchingViaPlex` (true/false/missing→false) round-trips.
- [ ] `pnpm nx test mobile-settings` — Plex chip render + `toggleHasPlex` + load +
      eager-create default; existing settings tests stay green.
- [ ] `pnpm nx test mobile-title-detail` — subsection gate on `hasPlex`, active/empty
      states, `toggleWatchingViaPlex`, `hasPlex$`, and the additivity assertion.
- [ ] `pnpm nx test mobile-watchlist` — read-only Plex badge present iff
      `watchingViaPlex`, alongside (not replacing) the availability pill.
- [ ] `pnpm nx build mobile` passes. (No functions change → no
      `functions:deploy-preflight` needed; state this explicitly in the PR.)
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green.
- [ ] **e2e:** `plex-provider.spec.ts` passes in CI against the emulator (the
      required "manual Plex tagging shows alongside provider availability" flow); the
      fixture seeds `hasPlex` + a `watchingViaPlex` item with flatrate availability.
      (Runs in CI, not under Claude Code tools locally — project memory.)
- [ ] **`firestore.rules`:** NO change (the `users/{userId}` recursive owner rule
      already covers both additive fields) — state this explicitly. No
      `firestore.indexes.json` change (no new query).
- [ ] **Stitch screens re-fetched + recorded in the PR:** Settings
      `cebdfd02c7d44023b0e0019dd4907d48` (the twice-edited screen, all 7 chips —
      fetched raw + screenshot-compared); the **canonical in-context title-detail
      screen** "Movie Detail - Personal Tracking - Vultus"
      `562019f29ce2412d90c757a7e45a98bf` (fetched raw + screenshot-compared for the
      "Personal Tracking" subgroup — "Local Server" caption, bundled logo tile,
      active/empty rows); and the watchlist layout-precedent screen
      `19f0eae3d6d24eaa90b3aa73ff44a59b`. Do NOT cite the superseded fragment
      `9e622d7b8aec40ec8319a4e30b62f2a9` or old screens `208cb8d7…` / `dfc2c7b9…`. A
      failed MCP call is a retry, not token-only.
- [ ] **UI fidelity verified** (`mobile:serve-mock` / screenshots) for the Settings
      Plex chip, the title-detail "Personal Tracking" subsection (against
      `562019f2…` — standard screenshot compare, no special carve-out), and the
      watchlist badge, **or explicitly flagged unverified for a human** — a green
      build does not prove fidelity (CLAUDE.md).
- [ ] **No hard-coded hex** in any new template/SCSS — every colour uses
      `--vultus-*` / `--ion-*` vars. The Plex brand colour lives in the **bundled
      Plex logo image asset** (`apps/mobile/public/assets/plex-logo.<ext>`), not in
      any SCSS constant. (The old "one Plex-brand-hex exception" is REMOVED — the
      verified render uses an image on a neutral theme-token tile.)
- [ ] **Bundled Plex logo asset** added under `apps/mobile/public/assets/`
      (`plex-logo.<ext>`), served via the existing `apps/mobile/project.json` assets
      glob and referenced by URL (`/assets/plex-logo.<ext>`) from all three
      renderers — sourcing/licensing recorded in the PR (see Risks); a fallback used
      if no suitable asset is available.
- [ ] READMEs updated: `shared/domain`, `shared/firestore-schema`, `mobile/settings`,
      `mobile/title-detail`, `mobile/watchlist`.
- [ ] **Boundary verifications (review-checked):** (a) Plex is a **separate boolean**,
      NOT in `myProviderIds` — no synthetic sentinel id anywhere; (b) legacy docs
      missing `hasPlex` / `watchingViaPlex` read as `false`; (c) the `watchingViaPlex`
      **read** is NOT gated behind `hasPlex` (a pre-tagged title still displays);
      (d) the title-detail toggle **control** IS gated behind `hasPlex`; (e) Plex is
      **additive** — it never suppresses 0060's TMDB availability framing (asserted in
      component + e2e tests); (f) **no `scope:functions` change**; (g) the Plex
      indicator is duplicated per slice, not extracted (2-slice rule).
- [ ] PR description records: verification commands, the three current screen ids
      (`cebdfd02…` Settings, `562019f2…` title-detail, `19f0eae3…` watchlist
      layout-precedent) + visual results, the bundled Plex logo asset + its
      source/licence, the boundary confirmations, the explicit "no functions / no
      rules / no index change" statements, and that the e2e flow is included. **Also
      note the 0060 dependency** (see Risks) — how it was composed (0060 merged
      first, or the "My Providers" card shell built by this PR).

## Risks

- **Depends on spec 0060 (`myProviderIds` + the "My Providers" Settings card),
  which is not yet merged.** 0061's Settings Plex chip lives in the SAME "My
  Providers" card 0060 introduces, and 0061 composes additively on top of 0060's
  watchlist pill / title-detail split (the Plex indicators sit alongside them).
  **Mitigation / ordering:** merge 0060 (PR #146) **before** implementing 0061 so
  the card + framing exist to compose with. If 0061 is implemented first, T3 builds
  the "My Providers" card shell to 0060's spec (a wrapping chip row) so the Plex chip
  has a home, and the two specs reconcile when 0060 merges — the fields are
  orthogonal (`hasPlex` boolean vs `myProviderIds` array; both additive to `User`),
  so there is no data conflict, only a UI-placement coordination. The implementer
  **must state in the PR** which path was taken. This is a real sequencing risk, not
  a data-model conflict.
- **Title-detail "Personal Tracking" subsection is now VERIFIED in-context.** The
  earlier gap (only a standalone fragment `9e622d7b…` existed because the live
  "Movie Detail - Vultus" screen `208cb8d7…` could not be edited) is **resolved**:
  the user consolidated the four duplicate/divergent detail-page versions into one
  canonical screen, "Movie Detail - Personal Tracking - Vultus"
  (`562019f29ce2412d90c757a7e45a98bf`), which renders the "Personal Tracking"
  subgroup in full context at the bottom of the "Where to Watch" card. Standard
  screenshot-compare verification now applies (no human-eyeball carve-out).
  `9e622d7b…`, `208cb8d7…`, and `dfc2c7b98a9f46d2bff9b7722fd192b7` are
  **superseded/stale** — do not cite them.
- **Watchlist Plex badge is layout-precedent-only (not Stitch-cited).** No Stitch
  edit was made to the Advanced Watchlist screen for a Plex badge; only the
  corner-slot layout/spacing convention is cited. (The consolidated title-detail
  screen `562019f2…` did not change this — it covers title-detail only.) Mitigation:
  the badge reuses the documented `items-end gap-sm` corner slot and the bundled
  Plex logo asset; the implementer must NOT overclaim Stitch fidelity for the badge
  specifically, and
  should get a human eyeball on the corner-slot composition (pill + badge together).
- **A static Plex logo image asset must be sourced and added to the app bundle.**
  The verified render uses a Plex logo `<img>` on a neutral theme-token tile (NOT a
  hard-coded brand-hex composition — there is no Plex-brand hex anywhere now). The
  implementer must source a suitable Plex logo image and add it under
  `apps/mobile/public/assets/` (T2b). Caveats: (1) **licensing/attribution** — use
  an official Plex brand/press asset under its brand guidelines, or an appropriately
  licensed mark; record the source in the PR. (2) This is the app's **first bundled
  image**, so `apps/mobile/public/assets/` may not exist yet — create it following
  the `favicon.ico`-in-`public/` precedent. (3) **Fallback if no suitable asset is
  available:** render a generic `material-symbols-outlined` icon (e.g. `dns` /
  `play_circle`) in the same neutral tile instead, and flag in the PR that the logo
  image is pending — still no brand hex. This is a smaller, contained risk than the
  former brand-hex hardcode.
- **`watchingViaPlex` is presentation-only — confirm no `scope:functions` need.**
  The architect framed this as explicitly NOT a sync/detection feature ("Vultus
  cannot track availability in Plex"). If, during implementation, a functions
  touchpoint appears necessary (e.g. dispatch-notifications wanting to suppress a
  "came to platform" notification for a Plex-tagged title), that is a **new decision
  to raise as a Risk / follow-up spec**, NOT a silent `apps/functions` edit in this
  PR. As specified, `dispatch-notifications` and `sync-titles` remain untouched.
- **No PLAN conflict.** Both additions are additive booleans on existing `users/{uid}`
  / `users/{uid}/watchlist/{titleId}` documents (PLAN §4), following the same
  migration-safe coalesce pattern as `deliveryHour` (0051) and `myProviderIds`
  (0060). No new collection, no rules change, no index, no function. Fully within
  PLAN §1's watch-tracking scope, refined to "and record when you watch a title via
  your own Plex server instead of a tracked provider."
