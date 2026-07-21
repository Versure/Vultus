# sync-episodes (`@vultus/functions/sync-episodes`)

The pure, Firebase-free episode-upsert engine (spec 0047). Given a TMDB show id
it fetches every season's episodes, diffs them against the episodes already in a
user's `users/{uid}/watchlist/{titleId}/episodes` subcollection, and inserts
**only the missing ones**. It is the core logic behind two entry points wired in
`apps/functions`:

- **Entry point A — on-add trigger** (`syncWatchlistEpisodes`): a Firestore
  `onDocumentCreated` on `users/{uid}/watchlist/{titleId}` calls `syncOne` so a
  newly tracked show is backfilled immediately.
- **Entry point B — daily-sync extension** (`runSync` in `main.ts`): after the
  title-cache pass, `syncAll` walks every TV show on every watchlist and upserts
  new episodes, isolating per-show errors.

## Public surface (barrel)

- `createEpisodeSyncEngine(config)` → `EpisodeSyncEngine` with
  `syncOne(uid, titleId, tmdbId)` and `syncAll()`.
- `EpisodeSyncEngine`, `EpisodeSyncConfig`, `EpisodeUpsertResult` — contract
  types. `EpisodeSyncConfig` carries an optional `watchlistStatus` port (spec 0074) and an optional `nextWatchable` port (spec 0081); `EpisodeUpsertResult`
  carries an optional `statusRevertedToWatching` flag (spec 0074).
- `episodeId(season, episode)` / `newEpisodeDoc(ep)` — id + doc helpers.
- Ports: `TmdbEpisodeSource`, `EpisodeStore`, `WatchlistTvSource`,
  `WatchlistTvShow`, `WatchlistDocRef`, `WatchlistStatusStore`,
  `WatchlistNextWatchableStore`.

## Usage

```ts
import { createEpisodeSyncEngine } from '@vultus/functions/sync-episodes';

const engine = createEpisodeSyncEngine({ tmdb, episodes, watchlist });
const result = await engine.syncOne(uid, titleId, tmdbId); // entry point A
const results = await engine.syncAll(); // entry point B (needs `watchlist`)
```

`tmdb`, `episodes`, and `watchlist` are **ports** — the lib never imports the
Firebase SDK or the sync-titles `TmdbClient`. Their concrete adapters
(`createTmdbEpisodeSourceAdapter`, `createEpisodeUpsertStore`,
`createWatchlistTvSourceAdapter`) live in `apps/functions/src/sync-episodes.ts`,
the only place where the Admin SDK and `@vultus/functions/sync-titles` enter.

## Behavior contract

- **Episode id format `s${SS}e${EEE}`** — season padded to 2 digits, episode to
  3 (e.g. `s01e001`). Padding is a floor: larger numbers keep their full digits
  (`s10e100`). The id is the Firestore doc id, which makes both the merge diff
  and a re-sync idempotent.
- **Insert-only / never overwrite.** The engine reads existing episode ids and
  filters the fetched set down to ids not yet present, so `writeEpisodes` only
  ever receives new docs. A user's `watched` / `watchedAt` state is never
  disturbed by a sync.
- **TV-only.** Movies have no episodes; the on-add trigger no-ops on a
  `type: 'movie'` doc and the daily source only lists `type: 'tv'` shows. The
  engine itself is type-agnostic — TV filtering happens in the adapters/trigger.
- **`airDate` null-skip (Data-model option (b), spec 0047).** `Episode.airDate`
  is a required string; the upstream TMDB mapper drops any episode with a
  null/missing air date, so such episodes are never produced and therefore never
  inserted. The engine does not special-case them.
- **404 → skip, not error.** `getSeasonCount` returning `null` (show not in
  TMDB) yields `{ outcome: 'skipped' }`; a `null` from `getSeasonEpisodes`
  silently drops that one season but the rest of the show still upserts.
- **Per-show error isolation in `syncAll`.** A thrown error for one show is
  captured as `{ outcome: 'error', reason }`; `syncAll` never rejects.
- **Completed → Watching source-of-truth revert (spec 0074).** The optional
  `watchlistStatus` port (`WatchlistStatusStore`, backed by the Admin SDK in
  `apps/functions`) lets the engine fix a stale `'completed'` status at the
  source. In `syncOne`, **after** `writeEpisodes`, when **≥1 new episode was
  inserted this run** (`toWrite.length > 0`) **and** the port is present **and**
  the show's current status is `'completed'`, the engine calls
  `setStatus(uid, titleId, 'watching')` and sets
  `statusRevertedToWatching: true` on the `'synced'` result. This is a
  **separate watchlist-doc write** — episode docs are never touched, so the
  insert-only invariant above still holds. It fixes every surface (Watchlist
  tab, detail page, notifications) without the user re-opening the detail page.
  - **Entry point A (on-add trigger) omits the port by design.** A freshly-added
    show never needs a completed→watching revert, so the on-add trigger wires
    only `tmdb` + `episodes`; the engine no-ops the revert safely when
    `watchlistStatus` is absent (and `statusRevertedToWatching` is `false`).
    Only the daily pass (entry point B) wires `watchlistStatus`.
- **Next-unwatched-episode air date recompute (spec 0081).** The optional
  `nextWatchable` port (`WatchlistNextWatchableStore`, Admin-SDK-backed in
  `apps/functions`) keeps the denormalized `nextUnwatchedEpisodeAirDate` field on
  `users/{uid}/watchlist/{titleId}` correct. In `syncOne`, **after**
  `writeEpisodes`, when **≥1 new episode was inserted this run**
  (`toWrite.length > 0`) **and** the port is present, the engine calls
  `readEpisodeWatchState(uid, titleId)` — a **fresh full read AFTER the write**,
  so it sees pre-existing docs' real `watched` state PLUS the just-inserted
  (`watched: false`) docs (the existing `getExistingEpisodeIds` returns ids only,
  with no watched state, so it cannot supply this). It then computes the **min
  `airDate` over episodes with `watched === false`** (ISO **lexical** comparison,
  the `transitions.ts` idiom), or `null` when nothing is unwatched, and writes it
  via `setNextUnwatchedEpisodeAirDate`. This is a **separate watchlist-doc write**
  and is **independent of the `watchlistStatus` revert block** — both may fire in
  the same run; episode docs are never touched (insert-only invariant preserved).
  - **Wired into BOTH entry points — the deliberate deviation from the 0074
    `watchlistStatus` port** (which is entry-B-only). Unlike a completed→watching
    revert (structurally impossible for a brand-new title), a freshly-added TV
    show **does** need `nextUnwatchedEpisodeAirDate` set on its first sync (entry
    A) — otherwise it stays `null` until the next daily pass and the show looks
    like "nothing to watch" for up to 24h. So `apps/functions` wires
    `nextWatchable` into **both** the on-add trigger (entry A) and the daily pass
    (entry B). The engine still no-ops safely when the port is absent (optional
    backward compatibility).

## Sheriff boundaries

- Tags: `scope:functions`, `slice:sync-episodes` (resolved by the path glob
  `libs/functions/<slice>/src`; `project.json` keeps `"tags": []`).
- Imports `@vultus/shared/domain` only. **Must not** import
  `@vultus/functions/sync-titles` (`slice:sync-titles`), `@vultus/functions/*`
  siblings, `scope:mobile`, or any Firebase SDK — those wires live exclusively in
  `apps/functions`.
