---
number: 0014
slug: watchlist-slice
title: Flesh out the watchlist slice — grouped status list, type filter, status action sheet, remove, and provider badges
status: done
slices: [slice:watchlist]
scopes: [scope:mobile, scope:shared]
created: 2026-06-22
---

# Flesh out the watchlist slice — grouped status list, type filter, status action sheet, remove, and provider badges

## Context

PLAN §6 item 18 — **`slice:watchlist`** — is the mobile slice that renders the
user's tracked titles. The shell (spec 0010, PLAN §6 item 15) generated
`libs/mobile/watchlist` as a **minimal stub** (`WatchlistPage` with one
`IonHeader`/`IonToolbar`/`IonTitle`/`IonContent`, a barrel, a real README, and a
render test, Sheriff-tagged `scope:mobile` + `slice:watchlist`, lazy-routed at
`tabs/watchlist` as the default landing tab). This spec **fleshes out** that lib;
it does **not** regenerate it, re-tag it, or touch the shell's routing.

The watchlist is populated by the **search slice** (spec 0013, in-flight): search
writes `users/{uid}/watchlist/{titleId}` directly via `@vultus/shared/firestore-schema`
(`watchlistItemPath`, `watchlistItemToData`). **This slice owns the read + the
display + status/remove mutations** of that collection — it does **not** own a
write helper that search imports (each slice writes Firestore independently; see
the locked decisions). It also reads `title-cache/{tmdbId}/availability/{region}`
(populated by the functions sync engine) to show a streaming-provider badge per
card, resolving the user's region from `users/{uid}.region` (written by the
settings slice, spec 0011).

Intended outcome: with the Firebase emulators running and at least one title
added (via search), opening the **Watchlist** tab shows the tracked titles as
poster cards grouped under status section headings (Watching / Planned /
Completed / Dropped) with per-group counts, a type segment (All / Movies / TV
Shows) at the top, each card showing poster + title + type badge + vote-average
percentage + provider name chip/badge (text only) + a delete overlay; long-pressing a card
opens an action sheet to change its status; the delete button confirms then
removes; pull-to-refresh re-subscribes; an empty watchlist shows a centred empty
state; and a loading skeleton shows before the stream first emits.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Card content — poster + title + status, with poster, vote-average %, and
   streaming provider.** Each card shows: a poster thumbnail (TMDB `w185`), the
   title, a **type badge** (Movie / TV Series), the **vote average as a
   percentage** (e.g. `88%`), a **provider name chip/badge (text only)** —
   rendering `provider.name` from the availability subcollection for the user's
   region (the `WatchProvider` shape has **no** logo/image field; there is no
   logo URL to resolve) — and a **delete overlay**
   icon button. `posterPath` and `voteAverage` are **denormalized into the
   watchlist doc at write time** (decision 4) so a card needs only the watchlist
   read + one availability read — not a `title-cache` metadata read per card.

2. **Status UX — long-press → `IonActionSheet`.** Long-pressing a card opens an
   `IonActionSheet` with the four watch statuses in `STATUS_DISPLAY_ORDER`
   (Watching / Planned / Completed / Dropped — the slice-local display-order
   array, **not** an iteration of `WATCH_STATUSES`; see Public types / APIs);
   selecting one writes the new `status` to the watchlist doc. (No swipe-to-change; the delete is its own overlay button — decision 3.)

3. **Filtering / grouping — follow the Stitch "Watchlist - Vultus" screen.** A
   **type segment** at the top (All / Movies / TV Shows) filters **client-side**
   over the already-loaded stream (no re-query). Cards are **grouped by status**
   into section headings in the fixed order **Watching → Planned → Completed →
   Dropped**, each heading showing the group's item count (e.g. "Watching — 3
   items"); **empty groups are omitted**. Delete is a per-card overlay icon button
   → `IonAlert` confirm → remove.

4. **Write path — search writes Firestore directly; this slice only reads +
   mutates its own UI's docs.** The **search slice** (spec 0013) owns adding a
   title (`watchlistItemPath` + `watchlistItemToData`). This slice does **NOT**
   export an add helper and search does **NOT** import this slice (a cross-slice
   import is forbidden by Sheriff — PLAN §3). This slice exposes only `watchlist$`
   (read), `updateStatus` (decision 2), and `removeTitle` (decision 3), plus the
   region + availability reads it needs to render. The two **denormalized fields**
   (`posterPath`, `voteAverage`) are written by whichever slice adds the title
   (today: search); see the Data-model coordination note in Risks.

5. **Region + availability reads are acceptable per-card for a personal
   watchlist.** The user's region comes from `users/{uid}.region`; for each
   displayed card the slice reads `title-cache/{tmdbId}/availability/{region}`.
   For a personal watchlist of **< 200 items** this read fan-out is acceptable
   (locked); no batching/denormalization of providers is built here. A
   not-yet-synced or missing availability doc renders **no provider badge** (not
   an error).

6. **e2e is descoped from this PR's gate** (consistent with specs 0010/0011/0013
   and PLAN §6 item 20). The green gate is **unit + component + build** (what
   `ci.yml` runs: `lint test build`), all Firebase access **mocked** (no live
   Firebase / no emulator — project memory: the emulator can't run under Claude
   Code tools here). The full emulator-backed watchlist flow is owned by the
   e2e-setup spec (PLAN §6 item 20). No `ci.yml` / `playwright.config.ts` change.

## Goals

1. As a user, opening the **Watchlist** tab shows my tracked titles as poster
   cards grouped under status headings (Watching → Planned → Completed →
   Dropped), each heading showing its count; empty groups are hidden.
2. Each card shows poster (`w185`), title, a type badge (Movie / TV Series), the
   vote-average percentage, a provider name chip/badge (text only — `provider.name`)
   for my region, and a delete overlay button.
3. A type segment (All / Movies / TV Shows) at the top filters the visible cards
   client-side without re-querying.
4. Long-pressing a card lets me change its status (Watching / Planned /
   Completed / Dropped) via an action sheet; the change persists immediately.
5. Tapping the delete overlay asks me to confirm, then removes the title from my
   watchlist.
6. Pull-to-refresh re-subscribes the stream; an empty watchlist shows a clear
   empty state; a loading skeleton shows before the first emission.
7. Tapping a card navigates toward the title-detail route
   (`tabs/title-detail/:titleId`), degrading gracefully if that route does not
   yet exist (PLAN §6 item 19, a later slice).

## Out of scope

- **Mark-watched per episode** — the title-detail slice (PLAN §6 item 19; spec
  0015).
- **Add-to-watchlist from the watchlist screen** — owned by the search slice
  (decision 4; spec 0013).
- **The manual "refresh now" HTTP sync call** — PLAN §1/§6 item 18 mentions a
  pull-to-refresh that calls the HTTP sync function; **here pull-to-refresh only
  re-subscribes the Firestore stream** (Risks). Wiring the rate-limited sync
  callable is deferred (no functions endpoint is consumed in this PR).
- **Push notification badge / unread count** on the tab.
- **Offline mode beyond Firestore's built-in cache** (PLAN §1).
- **`title-detail` slice / route creation** — this slice only _navigates toward_
  it and degrades gracefully if absent (PLAN §6 item 19).
- **Rich empty/loading polish across slices** — PLAN §6 item 23; a focused empty
  state + skeleton for this screen is in scope, app-wide polish is not.
- **Emulator-backed e2e** — PLAN §6 item 20 (decision 6).

## Data model changes

PLAN §4 `users/{uid}/watchlist/{titleId}` gains **two new denormalized fields**
(decision 1/4). `title-cache/{tmdbId}/availability/{region}` and
`users/{uid}.region` are **read-only** here (already converter-backed).

| PLAN §4 path                                 | Access by this slice   | Fields                                                      |
| -------------------------------------------- | ---------------------- | ----------------------------------------------------------- |
| `users/{uid}/watchlist` (collection)         | **read** (realtime)    | the full watchlist stream, optionally filtered by `type`    |
| `users/{uid}/watchlist/{titleId}`            | **update**, **delete** | `status` (update); whole doc (delete). **NOT** created here |
| `users/{uid}` (doc)                          | **read**               | `region: Region` (settings slice owns the write)            |
| `title-cache/{tmdbId}/availability/{region}` | **read**               | `providers: WatchProvider[]` — for the provider badge       |

### New `WatchlistItem` fields (shared/domain + shared/firestore-schema)

The shared `WatchlistItem` (`libs/shared/domain/src/lib/documents.ts`) and its
read/write data shapes + converters (`libs/shared/firestore-schema/src/lib/{data-types,converters}.ts`)
gain **two optional, nullable** fields. **Binding: they MUST be optional
(`?`) and nullable** so that documents written before this spec lands — and
search-slice writes (spec 0013) that have not yet been updated to set them —
remain valid `WatchlistItem`s (see Risks: cross-spec coordination).

```ts
// libs/shared/domain/src/lib/documents.ts — add to WatchlistItem
export interface WatchlistItem {
  type: TitleType;
  tmdbId: number;
  traktId: number | null;
  title: string;
  addedAt: string; // ISO 8601
  status: WatchStatus;
  posterPath?: string | null; // NEW — TMDB poster path, e.g. '/abc123.jpg'; null when unknown
  voteAverage?: number | null; // NEW — TMDB vote average 0–10, stored as-is; null when unknown
}
```

- **`posterPath`** — the TMDB poster path (e.g. `/abc123.jpg`), written by the
  slice that adds the title. The watchlist UI builds the full URL as
  **`https://image.tmdb.org/t/p/w185${posterPath}`**. When `posterPath` is
  `null`/absent, render a poster placeholder (no broken image).
- **`voteAverage`** — the TMDB vote average on the **0–10** scale, stored as-is.
  The UI displays **`Math.round(voteAverage * 10)`** as a percentage (e.g.
  `8.8 → 88%`). When `null`/absent, the vote badge is hidden.

Companion edits in `shared/firestore-schema`:

- `WatchlistItemReadData` / `WatchlistItemWriteData` (`data-types.ts`) gain the
  same two optional, nullable fields (non-timestamp → pass through; no Date
  coercion).
- `watchlistItemToData` / `dataToWatchlistItem` (`converters.ts`) map the two
  new fields straight through (e.g. `posterPath: item.posterPath ?? null`,
  `voteAverage: item.voteAverage ?? null` on write; pass through on read).
  Keep them **optional-safe** — never write `undefined` to Firestore (coerce to
  `null`).
- `firestore-schema.spec.ts` round-trip assertions extend to cover the two new
  fields (present and absent/null cases).

This is an **additive shared-domain change** (`scope:shared`) — the only shared
surface this spec touches. It is the sequential prerequisite the slice depends on.

## Firestore rules

**No change.** The existing `firestore.rules` already grant:

- owner-only read/write on `users/{userId}` and every subcollection
  (`users/{userId}/{document=**}`) — covers the watchlist read/update/delete and
  the `users/{uid}` region read (lines 25–31).
- **authenticated read** (incl. anonymous) on `title-cache/{tmdbId}` **and** its
  `availability/{region}` subcollection, with client writes denied
  (`write: if false`) — covers the per-card availability read (lines 46–54).

The implementer must **verify** these two blocks are present (they are in the
merged rules) and **record "no `firestore.rules` change needed"** in the PR. Do
**NOT** edit `firestore.rules` or `firestore.indexes.json` — this slice issues no
compound query (the watchlist stream is a single-collection subscription; the
type filter and status grouping are client-side per decision 3).

## Public types / APIs

- **No new shared domain type beyond the two `WatchlistItem` field additions**
  (above). `WatchStatus`, `WATCH_STATUSES`, `TitleType`, `Region`,
  `WatchProvider`, `RegionAvailability`, `AUTH_UID` already exist in
  `@vultus/shared/domain` (note: both `RegionAvailability` and `WatchProvider`
  come from `@vultus/shared/domain` — the service's `availability$` return type
  and the provider name chip both rely on them);
  `watchlistPath`, `watchlistItemPath`, `userPath`, `availabilityDocPath`,
  `dataToWatchlistItem`, `dataToUser`, `dataToAvailability` already exist in
  `@vultus/shared/firestore-schema`. **Reuse them — do not duplicate.**

- **uid via the `AUTH_UID` token.** This slice keys every Firestore read/write on
  the current uid. It **MUST** obtain the uid by injecting `AUTH_UID` (a
  `Signal<string | null>` from `@vultus/shared/domain`, provided at root by the
  shell — see `libs/shared/domain/src/lib/tokens.ts`). It **MUST NOT** import
  `ShellAuthService` from `apps/mobile` (that creates a forbidden
  `slice:watchlist → scope:mobile` Sheriff edge). This mirrors specs 0011/0013.

- **Watchlist slice surface** (`libs/mobile/watchlist/src/index.ts`):
  - `WatchlistPage` — the standalone Ionic page (already barrel-exported by spec
    0010; replace the stub body, keep the export).
  - `WatchlistService` — the data-access service. **Binding:** export it from the
    barrel (the task brief calls for it to be usable by `apps/mobile` and a future
    `title-detail` slice). Document both exports in the README.

- **Recommended (not binding) `WatchlistService` shape** — Angular injectable,
  `scope:mobile`, `slice:watchlist`, injecting AngularFire `Firestore` and the
  `AUTH_UID` signal:

  ```ts
  @Injectable({ providedIn: 'root' })
  export class WatchlistService {
    /** Realtime watchlist for {uid}, optionally filtered to a single type.
        Emits [] when uid is null (not-ready) rather than throwing. */
    watchlist$(
      uid: string | null,
      type?: TitleType,
    ): Observable<WatchlistItem[]>;

    /** Update one item's status. No-op when uid is null. */
    updateStatus(
      uid: string | null,
      titleId: string,
      status: WatchStatus,
    ): Promise<void>;

    /** Remove one item. No-op when uid is null. */
    removeTitle(uid: string | null, titleId: string): Promise<void>;

    /** The user's region from users/{uid}.region (null until resolved / uid null). */
    userRegion$(uid: string | null): Observable<Region | null>;

    /** Availability doc for a title in a region; emits null when absent/unsynced. */
    availability$(
      tmdbId: number,
      region: Region | null,
    ): Observable<RegionAvailability | null>;
  }
  ```

  Method/signal names are a **recommendation**; what is **binding**: realtime
  read of `users/{uid}/watchlist` (via `watchlistPath` + `dataToWatchlistItem`),
  `updateStatus`/`removeTitle` targeting `watchlistItemPath(uid, titleId)`, region
  read from `users/{uid}` (via `userPath` + `dataToUser`), availability read from
  `title-cache/{tmdbId}/availability/{region}` (via `availabilityDocPath` +
  `dataToAvailability`); a **null-uid guard** before any Firestore call (emit
  `[]`/`null`, never throw on an undefined path); **never write `title-cache`**,
  **never create** a watchlist doc (only update/delete), **never write
  `users/{uid}`**.

- **Pure helpers (unit-tested, slice-local):** `groupByStatus(items)` →
  ordered, non-empty status groups (Watching → Planned → Completed → Dropped,
  each with its count); `filterByType(items, type)` → the type filter. These are
  pure functions over `WatchlistItem[]` — keep them **inside the slice** (one
  consumer, far short of the 3+-slice rule; PLAN §3 / CLAUDE.md).

  - **Display order (binding):** `groupByStatus` MUST derive its order from a
    **slice-local display-order array**
    `const STATUS_DISPLAY_ORDER: WatchStatus[] = ['watching', 'planned', 'completed', 'dropped']`
    — **NOT** from `WATCH_STATUSES`. `WATCH_STATUSES`
    (`@vultus/shared/domain`) is ordered
    `['watching', 'completed', 'dropped', 'planned']`, which is **not** the
    required display order (Watching → Planned → Completed → Dropped). **Do not
    iterate `WATCH_STATUSES` to produce the display order** — that would render
    the groups in the wrong order. Use `STATUS_DISPLAY_ORDER` everywhere a
    status order is needed for display.
  - The **action sheet** in the component (decision 2) MAY use either order, but
    for consistency it MUST use the **same `STATUS_DISPLAY_ORDER`** array — not a
    re-derivation from `WATCH_STATUSES`.

## UI / Stitch screen refs

This is a mobile slice — the implementer **must pull the Watchlist screen** via
the `stitch` MCP from project **`projects/13590348714018893783`** ("Vultus
Android App Design"): run `list_screens`, find the **"Watchlist - Vultus"**
screen, then `get_screen` on it; **reference its screen ID in the PR** and align
layout (header, type toggle, status section grouping + counts, card composition,
delete overlay, empty state) to it.

> **Graceful degradation:** if the `stitch` MCP is **unavailable in-session**,
> apply the PLAN §2 design tokens below (seeded into `shared/ui-kit` by spec 0010) and **note in the PR that the MCP was unreachable** — a Stitch outage
> must not block an otherwise-correct PR.

Layout (Ionic, consuming the spec-0010 `shared/ui-kit` theme tokens):

- `IonHeader` / `IonToolbar` with the **"Vultus"** title and an **account icon
  placeholder** (`IonButtons slot="end"` with an `ion-icon` — non-functional
  placeholder; settings/account nav is not wired here).
- An `IonContent` containing, top to bottom:
  - An **`ion-refresher`** (`pull-to-refresh`) that re-subscribes the stream.
  - An **`IonSegment`** with three `IonSegmentButton`s: **All / Movies / TV
    Shows** (client-side filter; default **All**).
  - The **grouped list**: for each non-empty status group in order Watching →
    Planned → Completed → Dropped, a **section header** (`ion-item-divider` or a
    styled header) showing the status label + count (e.g. "Watching — 3 items"),
    followed by the group's cards.
  - **Card** per item: poster thumbnail (`https://image.tmdb.org/t/p/w185${posterPath}`,
    placeholder when null), title, **type badge** (`Movie` / `TV Series`, mapped
    from `type`), **vote% badge** (`Math.round(voteAverage*10)%`, hidden when
    null), **provider name chip/badge (text only)** (renders `provider.name`
    from `availability$` — the `WatchProvider` shape has no logo/image field,
    so this is a text chip, never an image; hidden when absent), and a
    **delete overlay** icon button (`trash`/`close` icon).
  - **Empty state** (stream emits `[]`): centred illustration area + **"Your
    watchlist is empty"** + **"Search for a title to get started"**.
  - **Loading skeleton** (before first emission): `ion-skeleton-text` placeholder
    cards.
- **Status colors** (PLAN §2, seeded in `shared/ui-kit`): Watching `#3B82F6`,
  Completed `#10B981`, Dropped `#EF4444`, Planned `#94A3B8` — apply to the status
  section headers / status indicator. Primary Emerald `#10B981`, navy-slate
  surfaces (`#0F172A`/`#1E293B`), Inter, 8px grid, 0.5rem radius — consume the
  `shared/ui-kit` tokens, do not redefine.
- **Interactions:** long-press a card → `IonActionSheet` with the four statuses →
  `updateStatus`. Delete overlay → `IonAlert` confirm → `removeTitle`. Tap a card
  (not the delete button) → `router.navigate(['tabs','title-detail', titleId])`,
  guarded so a missing route does not crash (decision/Goal 7; Risks).

## Implementation plan

Ordered, grouped by area. Task 1 (the shared field additions) is a **shared dep**
the slice imports, so it lands **first**. Tasks 2–5 all write within
`libs/mobile/watchlist` and therefore are **sequential** (they share the lib's
files / the page composition), not parallelisable.

### Data layer (shared) — prerequisite

1. **[sequential] Add `posterPath` + `voteAverage` to the shared `WatchlistItem`
   and its converters.** (shared dep — the slice imports the widened type; must
   land first.) frontend-engineer / domain.
   - `libs/shared/domain/src/lib/documents.ts`: add `posterPath?: string | null`
     and `voteAverage?: number | null` to `WatchlistItem` (optional + nullable —
     binding, see Data model changes / Risks).
   - `libs/shared/firestore-schema/src/lib/data-types.ts`: add the same two
     optional, nullable fields to `WatchlistItemReadData` and
     `WatchlistItemWriteData` (pass-through, no Date coercion).
   - `libs/shared/firestore-schema/src/lib/converters.ts`: map the two fields in
     `watchlistItemToData` (coerce `undefined → null`) and `dataToWatchlistItem`
     (pass through). Never emit `undefined`.
   - `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`: extend the
     `WatchlistItem` round-trip test to cover the two new fields (set + null/absent).
   - Update `libs/shared/domain/README.md` / `libs/shared/firestore-schema/README.md`
     **only if** they enumerate `WatchlistItem`'s fields.
   - Files: `libs/shared/domain/src/lib/documents.ts`,
     `libs/shared/firestore-schema/src/lib/data-types.ts`,
     `libs/shared/firestore-schema/src/lib/converters.ts`,
     `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
     (READMEs only if they list fields).

### Service — depends on task 1

2. **[sequential] `WatchlistService` (`slice:watchlist`). Depends on task 1.**
   frontend-engineer.
   - Add `WatchlistService` in the slice: inject AngularFire `Firestore` and the
     `AUTH_UID` signal (`inject(AUTH_UID)`). Implement `watchlist$` (realtime
     collection read via `watchlistPath` + `dataToWatchlistItem`, optional `type`
     filter), `updateStatus` (update `status` at `watchlistItemPath`),
     `removeTitle` (delete at `watchlistItemPath`), `userRegion$` (read
     `users/{uid}.region` via `userPath` + `dataToUser`), and `availability$`
     (read `title-cache/{tmdbId}/availability/{region}` via `availabilityDocPath`
     - `dataToAvailability`, emit `null` when the doc is absent). **Guard a null
       uid** before any Firestore call (emit `[]`/`null`; no throw). Implement the
       pure `groupByStatus` and `filterByType` helpers (slice-local).
   - Files: `libs/mobile/watchlist/src/lib/watchlist.service.ts`,
     and a slice-local helpers file if the implementer separates the pure
     functions (e.g. `libs/mobile/watchlist/src/lib/watchlist.helpers.ts`) —
     optional; they may live in the service file.

### Component — depends on task 2

3. **[sequential] Real `WatchlistPage` (template + styles). Depends on task 2.**
   frontend-engineer.
   - Replace the spec-0010 stub `WatchlistPage` body with the real page (UI
     section above): header + account placeholder, `ion-refresher`,
     `IonSegment` type toggle, grouped status sections with counts, the poster
     cards (poster/title/type badge/vote%/provider badge/delete overlay),
     long-press → `IonActionSheet`, delete → `IonAlert` → remove, empty state,
     loading skeleton, and tap → guarded navigation to
     `tabs/title-detail/:titleId`. Wire to `WatchlistService`; resolve the uid
     from the injected `AUTH_UID` signal; resolve region via `userRegion$` and
     each card's provider via `availability$`. Apply the `shared/ui-kit` status
     colors + tokens. Render-gate the skeleton until the first stream emission.
     **Keep the existing selector `lib-watchlist` — do not change it.**
     The long-press action-sheet trigger MUST be exposed as a
     `public openStatusSheet(item: WatchlistItem): void` method (bound from the
     template), **not** an inline anonymous handler, so the component test can
     invoke it deterministically without simulating pointer events.
   - Files: `libs/mobile/watchlist/src/lib/watchlist.page.ts`,
     `libs/mobile/watchlist/src/lib/watchlist.page.html`,
     `libs/mobile/watchlist/src/lib/watchlist.page.scss`.

### Tests — depend on tasks 2–3

4. **[sequential] Service unit tests + page component test. Depends on tasks 2–3.**
   frontend-engineer / qa-runner.
   - `watchlist.service.spec.ts` (new) and `watchlist.page.spec.ts` (replace the
     spec-0010 stub render test) — see Test plan. All Firebase access mocked.
   - Files: `libs/mobile/watchlist/src/lib/watchlist.service.spec.ts`,
     `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`.

### Barrel + README — depends on tasks 2–3

5. **[sequential] Update barrel + README. Depends on tasks 2–3.**
   frontend-engineer.
   - `src/index.ts`: export `WatchlistPage` (keep) and `WatchlistService` (add).
   - Rewrite `libs/mobile/watchlist/README.md` to the real public surface (what
     the lib is, the two exports, that it reads `users/{uid}/watchlist` +
     `users/{uid}.region` + `title-cache/*/availability/*` via the shared
     converters and mutates only its own watchlist docs, Sheriff tags
     `scope:mobile` + `slice:watchlist`). **No leftover stub text.**
   - Files: `libs/mobile/watchlist/src/index.ts`,
     `libs/mobile/watchlist/README.md`.

(All slice work lives under `libs/mobile/watchlist/**`; task 1 is the only file
outside it, in `libs/shared/{domain,firestore-schema}/**`. No `apps/mobile`,
`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`, or
`scope:functions` file is touched. Tasks are sequential — no parallel fan-out.)

## Test plan

Per the PLAN §5 pyramid — a focused set of **unit** tests (service + pure
helpers) and a **component** test (the page's non-trivial state). **No
emulator-backed e2e in this PR** (decision 6). All Firebase access is **mocked**
(no live Firebase, no network, no secrets).

**Unit (`watchlist.service.spec.ts`, Vitest, mocked AngularFire `Firestore` +
mocked `AUTH_UID` signal):**

- **`groupByStatus`** groups a mixed list into the four status groups in the
  fixed order Watching → Planned → Completed → Dropped (the slice-local
  `STATUS_DISPLAY_ORDER`, **not** `WATCH_STATUSES`' order), with correct counts,
  and **omits empty groups**. Assert the emitted order is exactly Watching →
  Planned → Completed → Dropped (a regression guard that the helper did not
  fall back to iterating `WATCH_STATUSES`).
- **`filterByType`** returns only `movie` items for `'movie'`, only `tv` for
  `'tv'`, and the full list for `undefined`/All.
- **`updateStatus(uid, titleId, status)`** calls the Firestore `updateDoc` (or
  equivalent) against `watchlistItemPath(uid, titleId)` with `{ status }`
  (assert the mocked write target + payload).
- **`removeTitle(uid, titleId)`** calls the Firestore delete against
  `watchlistItemPath(uid, titleId)`.
- **`watchlist$`** maps the mocked snapshot docs through `dataToWatchlistItem`;
  with a `type` arg it filters to that type.
- **Null-uid guard:** when the `AUTH_UID` signal is `null`, `watchlist$` /
  `userRegion$` emit `[]`/`null`, and `updateStatus`/`removeTitle` are no-ops —
  **no Firestore read/write occurs**, nothing throws on an undefined path.
- **`availability$`** emits the mapped `RegionAvailability` when the doc exists
  and **`null`** when it is absent (no throw — supports decision 5's "no badge").
- **No write outside the watchlist doc:** assert every mocked write targets
  `watchlistItemPath(uid, …)` — never `title-cache`, never `users/{uid}`, never
  another slice's data; and the service **never creates** a watchlist doc.

**Component (`watchlist.page.spec.ts`, Angular TestBed + Ionic test setup,
mirroring the spec-0010 stub render test; `WatchlistService` mocked):**

- **Type segment switching:** with a mixed `movie`/`tv` stream, selecting
  Movies shows only movie cards, TV Shows only tv cards, All shows both
  (client-side filter, no re-query).
- **Empty state:** when the stream emits `[]`, the empty-state copy ("Your
  watchlist is empty" / "Search for a title to get started") renders and no cards
  are shown.
- **Loading skeleton:** before the stream first emits, `ion-skeleton-text`
  placeholders render and the empty state is **not** shown.
- **Status action sheet:** invoking the public `openStatusSheet(item)` method
  directly (the deterministic trigger — the test does **not** simulate
  `pointerdown`/hold) opens the `IonActionSheet`; selecting a status calls the
  mocked `updateStatus` with the chosen `WatchStatus`.
- **Delete confirm:** tapping the delete overlay opens the `IonAlert`; confirming
  calls the mocked `removeTitle`.
- (Optional, if cheap) **grouping render:** a stream with items across statuses
  renders the section headers in order with counts and hides empty groups.

**e2e:** **descoped to PLAN §6 item 20** (decision 6). No new Playwright spec; no
change to `apps/mobile-e2e`, `playwright.config.ts`, or `ci.yml`. The full
emulator-backed open-watchlist / group / change-status / remove flow is owned by
the e2e-setup spec.

## Acceptance criteria

This spec's green gate is **unit + component + build** (what `ci.yml` runs:
`lint test build`); emulator-backed e2e is descoped to PLAN §6 item 20
(decision 6). Verified Nx targets: `mobile-watchlist`, `shared-domain`, and
`shared-firestore-schema` have `lint`/`test`/`typecheck` (no `build` — non-app
libs); `mobile` has `lint`/`test`/`build`/`typecheck`.

- [ ] `pnpm nx run-many -t lint test -p mobile-watchlist shared-domain
  shared-firestore-schema` passes **with Sheriff active** (lint includes
      Sheriff): the watchlist slice imports `@vultus/shared/domain`,
      `@vultus/shared/firestore-schema`, AngularFire/Ionic (third-party), and the
      uid **only** via the `AUTH_UID` token — **no other slice import, no
      `apps/mobile` deep import (no `ShellAuthService` import), no
      `scope:functions` import**. Service unit tests + the page component test are
      green (no emulator, no network, no secrets; AngularFire mocked).
- [ ] `pnpm nx typecheck mobile-watchlist shared-domain shared-firestore-schema`
      passes — the widened `WatchlistItem`, the service, and the page compile.
- [ ] `pnpm nx build mobile` passes (production configuration) — the fleshed-out
      slice lazy-loads cleanly into the shell and the bundle stays within existing
      budgets.
- [ ] `pnpm nx affected -t lint test build --base=main` is green — mirrors CI.
      The affected set is `mobile-watchlist`, `shared-domain`,
      `shared-firestore-schema`, and `mobile` (which depends on them).
- [ ] **Component test** asserts type-segment filtering, empty state, loading
      skeleton, the status action sheet, and delete-confirm (PLAN §5: component
      tests for non-trivial UI).
- [ ] The two new `WatchlistItem` fields are **optional + nullable**; the
      `firestore-schema` round-trip test covers set and null/absent cases; the
      converters never emit `undefined`.
- [ ] `libs/mobile/watchlist/README.md` is rewritten to the real public surface
      (`WatchlistPage` + `WatchlistService`) — **no leftover stub/Nx scaffold
      text** (CLAUDE.md lib-README rule). `shared/domain` /
      `shared/firestore-schema` READMEs updated **only if** they enumerate
      `WatchlistItem`'s fields.
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json` are NOT
      modified** (the existing tags + owner-only/`title-cache`-read rules already
      cover this slice — verified, recorded in the PR).
- [ ] **Guardrail verifications (review-checked):** (a) every Firestore **write**
      targets `users/{uid}/watchlist/{titleId}` (update `status`, or delete) —
      no `title-cache` write, no `users/{uid}` write, no watchlist-doc **create**,
      no other slice's data; (b) the uid is obtained **only** via `AUTH_UID` — no
      `apps/mobile`/`ShellAuthService` import; (c) **no cross-slice import** (no
      `slice:search`/`slice:settings`/`slice:title-detail`) and **no
      `scope:functions` file touched**; (d) a **null uid** is guarded everywhere
      (emit `[]`/`null`, no throw); (e) a missing/unsynced availability doc and a
      null `posterPath`/`voteAverage` render gracefully (no badge / placeholder,
      no error); (f) **no secret read/written** — the slice uses the shell's
      already-initialised AngularFire.
- [ ] PR description records: the **Stitch Watchlist screen ID** used (or that the
      MCP was unreachable and PLAN §2 tokens were applied), the exact verification
      commands, the writes-only-to-`users/{uid}/watchlist` / no-`title-cache`-write
      / uid-via-`AUTH_UID` / no-cross-slice / no-`scope:functions` boundary
      confirmations, the **no-`firestore.rules`-change** verification, the
      cross-spec coordination note for the search slice's denormalized-field writes
      (Risks), and that **emulator-backed e2e is descoped to PLAN §6 item 20**
      (decision 6).

## Risks

- **Cross-spec coordination with the search slice (spec 0013) on the denormalized
  fields.** Spec 0013 (in-flight) writes a `WatchlistItem` of
  `{ type, tmdbId, traktId, title, addedAt, status }` via `watchlistItemToData`
  and does **not** set `posterPath`/`voteAverage`. This spec adds those two fields
  as **optional + nullable** precisely so 0013's existing writes stay valid and
  type-check — a search-added title simply renders with a poster placeholder and a
  hidden vote badge until search is updated to populate them. **Resolution
  (binding):** keep the fields optional/nullable here; **flag to the reviewer**
  that a **follow-up (or a 0013 revision) must update the search add path to set
  `posterPath` + `voteAverage`** from the TMDB result so search-added cards render
  full poster + vote. Do **not** make the fields required (that would break 0013's
  merged/in-flight writes) and do **not** reach into the search slice from here (a
  forbidden cross-slice import). Whichever of 0013/0014 merges second resolves the
  `WatchlistItem` field-addition in `shared/` — the change is additive, so the
  merge is mechanical, not a logic conflict.

- **Per-card availability read fan-out.** Reading
  `title-cache/{tmdbId}/availability/{region}` once per displayed card is an N+1
  pattern. **Locked acceptable for < 200 personal items (decision 5);** the reads
  are realtime subscriptions Firestore caches. If a future watchlist grows large,
  batching/denormalizing the provider onto the watchlist doc is the upgrade path —
  out of scope here. A missing/unsynced availability doc → **no provider badge**
  (handled, not an error).

- **`title-detail` route does not exist yet (PLAN §6 item 19).** Tapping a card
  navigates toward `tabs/title-detail/:titleId`, which is **not** created by this
  spec. **Mitigation:** the navigation must degrade gracefully — either the route
  is guarded/optional (no crash if unmatched) or the tap is a no-op placeholder
  until 0015 lands. The implementer reconciles against the shell's route config;
  **do NOT add the `title-detail` route or slice here** (that is item 19's job).

- **Pull-to-refresh is stream re-subscribe only, not an HTTP sync call.** PLAN §6
  item 18 describes pull-to-refresh as "calls HTTP sync function." That HTTP sync
  callable (PLAN §6 items 11–12) and its rate-limit are **not** consumed here —
  this slice's refresher only re-subscribes the Firestore stream (the realtime
  stream already reflects function-driven updates). **Flagged as a deliberate
  narrowing**; wiring the manual rate-limited sync callable is a later spec. If the
  reviewer requires the HTTP call now, that is a scope expansion needing re-approval
  (a new spec), not a silent addition.

- **`AUTH_UID` can be null briefly / cross-boundary DI.** The uid signal is `null`
  before the anon session resolves (spec 0010) and, in the no-emulator dev/test
  context, may never resolve. **Mitigations:** the service guards a null uid
  everywhere (emit `[]`/`null`, tested); the page shows the loading skeleton until
  the first emission. The slice obtains the uid via the `scope:shared` `AUTH_UID`
  token (allowed by Sheriff rule 4), **never** by importing `ShellAuthService` from
  `apps/mobile` (a forbidden `slice:watchlist → scope:mobile` edge) — mirrors
  specs 0011/0013.

- **Long-press testing.** Reliably simulating a long-press (`pointerdown` + hold)
  in a Vitest/TestBed component test can be flaky. **Mitigation:** expose a
  small test-friendly handler (e.g. a method the template's gesture binds to) so
  the test can invoke "long-press detected" deterministically rather than racing a
  real timer; the gesture wiring itself (Ionic gesture / `(press)`) is exercised
  at the integration/e2e layer later (item 20).

- **Injecting AngularFire `Firestore` is third-party, not a Sheriff violation.**
  Sheriff governs only `scope:`/`slice:` edges between workspace projects;
  `@angular/fire`, `firebase`, `@ionic/*`, `rxjs` are external. The slice uses the
  shell's already-initialised Firebase (DI of `Firestore`) and **never** calls
  `initializeApp` / `signInAnonymously`.

- **Emulator-backed e2e descoped (decision 6).** Consistent with specs
  0010/0011/0013 and project memory (the emulator can't run under Claude Code
  tools here). This PR's gate is unit + component + build; the full watchlist flow
  against the emulators is PLAN §6 item 20. No `ci.yml` / `playwright.config.ts`
  change.

- **Depends on specs 0010 + 0011 + 0013 contracts being present.** This slice
  relies on the spec-0010 shell (the `watchlist` lazy route, the AngularFire
  `Firestore` providers, the `AUTH_UID` root provider), reads the
  `users/{uid}.region` written by spec 0011's settings slice, and reads the
  watchlist docs written by spec 0013's search slice. The implementer works in a
  worktree branched after 0010/0011 have landed (0013 may be concurrent — see the
  coordination Risk); if the `watchlist` route / `AUTH_UID` provider / AngularFire
  providers / shared converters are absent, **stop and flag the missing dependency**
  rather than recreating shell scaffolding here.

- **No PLAN conflict.** This implements PLAN §6 item 18 (the watchlist list with
  status, remove, and pull-to-refresh) using the PLAN §4 `users/{uid}/watchlist`
  - `title-cache/*/availability/*` shapes and the spec-0010 AngularFire DI
    contract. The two additive `WatchlistItem` fields (`posterPath`, `voteAverage`)
    extend the PLAN §4 watchlist doc to support the denormalized card render
    (decision 1/4) without forking the model. The pull-to-refresh narrowing (stream
    re-subscribe vs HTTP sync) and the per-card availability read are noted above as
    deliberate, in-scope decisions — not silent departures from PLAN.
