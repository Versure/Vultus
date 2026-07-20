# mobile-today

The **Watch Today** tab slice — a `scope:mobile` vertical slice owning the Watch
Today tab's UI, state, data, and slice-local types (spec 0083). It surfaces, at a
glance, everything on the user's watchlist that is actually watchable **right
now**: watching/planned **movies** whose `releaseDate` has passed, and
watching/planned **TV shows** with a `nextUnwatchedEpisodeAirDate` (spec 0081)
that has aired. `dropped`/`completed` items are never shown, and a title that is
not watchable today is simply absent (no "waiting" marker — D2). This lib is the
**UI half** of a two-spec split; spec 0081 is the data layer that adds the cheap
denormalized `nextUnwatchedEpisodeAirDate` gate field.

## Public surface (barrel `@vultus/mobile/today`)

- **`TodayPage`** — the standalone Ionic tab page (selector `lib-today`),
  lazy-loaded via this barrel from `apps/mobile`'s `today` tab route. Composes a
  `vm$` from `TodayService.watchlist$` + a fixed `now` (computed ONCE per
  subscription — D5) via `partitionWatchableToday`, rendering a **Movies** and a
  **TV Shows** section (each only when non-empty), a dynamic
  `watchableSubtitle(count)` hero subtitle, per-card availability pill (D3),
  "Ready to watch" tag, TV episode label (D4), and the shared loading / error /
  empty states (`vultus-skeleton-card` / `vultus-error-state` /
  `vultus-empty-state`). Card tap navigates to title-detail by **string
  segments** (`['tabs','title-detail', titleId]` with `?type=`), never importing
  `@vultus/mobile/title-detail`. Availability pills memoize `availability$` per
  `tmdbId|region`; episode labels memoize a one-shot `readEpisodes` stream per
  `titleId`, built ONLY for gated-in TV items (D4 bounded enrichment). The empty
  state's copy ("Nothing to watch today" / "Nothing on your watchlist has a new
  episode or release available yet.") is **authored** to match the app's
  empty-state voice — the primary Stitch screen has no empty state.
- **`TodayService`** — `providedIn: 'root'` data-access service. READS ONLY (adds
  no field, collection, rule, or index). Obtains the uid via the `scope:shared`
  `AUTH_UID` token; all reads are keyed on the resolved uid, and a null uid is a
  no-op / empty stream.
  - `watchlist$(uid)` — realtime `users/{uid}/watchlist`, mapped to domain
    `WatchlistItem`s (incl. `releaseDate` + `nextUnwatchedEpisodeAirDate`). Null
    uid → `of([])`.
  - `userRegion$(uid)` — the user's persisted region from `users/{uid}`, from a
    **memoized** single `docData` listener. Null uid / missing doc → `null`.
  - `myProviderIds$(uid)` — the user's subscribed TMDB provider ids
    (`users/{uid}.myProviderIds`, spec 0060) for the availability pill's `mine`
    partition (D3). Reads the **same** memoized `users/{uid}` listener as
    `userRegion$` (no second Firestore listener). Null uid / missing doc → `[]`.
  - `availability$(tmdbId, region)` — provider availability from
    `title-cache/{tmdbId}/availability/{region}` for the pill, **memoized per
    `tmdbId|region`** (`shareReplay({ bufferSize: 1, refCount: false })`). Null
    region / missing doc → `null`.
  - `readEpisodes(uid, titleId)` — a **one-shot** `getDocs` read of the whole
    `users/{uid}/watchlist/{titleId}/episodes` subcollection, mapped via
    `dataToEpisode` → `EpisodeDoc[]`. This is the D4 bounded enrichment: it is
    called by the page ONLY for TV items that already pass the watchable-today
    gate, so the read count stays bounded (preserving spec 0081's cheap-gate
    purpose). Null uid → `[]`.
- **Slice-local pure logic** (`today.logic.ts`) — deterministic; "now" is always
  injected, never read inside the functions (so tests need no clock mocking):
  - `isMovieWatchableToday(item, todayDateOnly)` — watching/planned + present
    `releaseDate` + `releaseDate <= todayDateOnly` (date-only compare).
  - `isTvWatchableToday(item, nowISO)` — watching/planned + non-null
    `nextUnwatchedEpisodeAirDate` + `<= nowISO` (full-datetime compare).
  - `partitionWatchableToday(items, nowISO, todayDateOnly)` → `{ movies, tvShows }`.
  - `watchableSubtitle(count)` → EXACT `"1 thing ready to watch"` /
    `"N things ready to watch"` (0 → `"0 things ready to watch"`).
  - `nextEpisodeLabel(episodes)` → `"S{season}E{episode} available"` (UNPADDED)
    from the earliest currently-unwatched episode (min `airDate`, tie-broken by
    `(season, episode)` ascending); `null` when none.
  - `partitionAvailabilityPill(availability, myProviderIds)` + the
    `AvailabilityPill` type — `mine` / `elsewhere` / `null`.

## D5 — date-comparison mechanics (a correctness trap)

Two DIFFERENT string formats are compared against "now" and must **not** be
conflated:

- `WatchlistItem.releaseDate` (movies) is a **date-only** string (`'2024-03-15'`)
  → compared against `todayDateOnly` (`YYYY-MM-DD`).
- `WatchlistItem.nextUnwatchedEpisodeAirDate` and `EpisodeDoc.airDate` (TV) are
  **full ISO 8601 datetime** strings (`'2026-01-02T00:00:00.000Z'`) → compared
  against the full `nowISO`.

The caller (`TodayPage`) computes both `nowISO = new Date().toISOString()` and
`todayDateOnly = nowISO.slice(0, 10)` once per subscription and passes them in;
the pure functions never slice one format to match the other. Comparison is
lexical string `<=` (ISO strings sort correctly as strings — the precedented
idiom at `libs/functions/dispatch-notifications/src/lib/transitions.ts`). Using
UTC (`toISOString()`) is the deliberate, precedented choice (matches
`dispatch-notifications`); a few hours' skew near local midnight is an accepted
tradeoff, not a bug.

## Deliberate duplication of watchlist (D3)

`partitionAvailabilityPill` (+ the `AvailabilityPill` type) and the memoized
`availability$` pattern are a **deliberate copy** of `libs/mobile/watchlist`'s
equivalent logic. Sheriff forbids a cross-slice import
(`slice:today` must not import `@vultus/mobile/watchlist`), and per PLAN §3 shared
extraction happens only at **3+ slices** with the same reason to change. This is
the **2nd** slice doing it (watchlist is the 1st) — **below** the threshold. Do
**not** extract a shared helper; a reviewer should **not** flag this duplication
as a mistake.

## Boundaries (Sheriff)

- Tags: **`scope:mobile`**, **`slice:today`** (applied by the path glob in
  `sheriff.config.ts` — no config edit needed).
- May import **`scope:shared`** (`@vultus/shared/domain`,
  `@vultus/shared/domain/tokens`, `@vultus/shared/firestore-schema`,
  `@vultus/shared/ui-kit`) and its **own slice** only — never another slice
  (including `@vultus/mobile/watchlist`) and never `scope:functions`. Third-party
  imports (`@ionic/*`, `@angular/fire`, `ionicons`) are not policed by Sheriff.
- **Key constraint:** the current user's uid is obtained **only** via the
  `scope:shared` `AUTH_UID` injection token (provided by the shell), never by
  importing from `apps/mobile`.

## Running unit tests

Run `nx test mobile-today` to execute the unit tests via [Vitest](https://vitest.dev).
