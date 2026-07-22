---
number: 0098
slug: fix-plex-episode-watch-sync
title: Fix Plex sync — create missing episode docs on-device so watched episodes mark immediately
status: implementing
slices: [slice:settings]
scopes: [scope:mobile]
created: 2026-07-22
---

# Fix Plex sync — create missing episode docs on-device so watched episodes mark immediately

## Context

GitHub issue #255: "When syncing with plex watch progress is not synced — all tv
shows and movies get synced, however watch progress for tv show episodes does not
get updated with the sync. Episodes watched in Plex are not directly marked as
watched in Vultus."

### Root cause (confirmed by code read)

Episode docs (`users/{uid}/watchlist/{tmdbId}/episodes/{episodeId}`) are created
**only by Cloud Functions**, server-side and asynchronously:

- the `onDocumentCreated` trigger `syncWatchlistEpisodes`
  (`apps/functions/src/sync-episodes.ts:214-237`), and
- the daily cron `syncTitles` (`apps/functions/src/main.ts:380-389`).

Both pull the episode list from TMDB and are **insert-only** (they skip existing
ids via `getExistingEpisodeIds`, `sync-episodes.ts:80-83`).

`libs/mobile/title-detail` and `libs/mobile/settings` only `updateDoc` **existing**
episode docs and never create them. In `PlexSyncService.mirrorEpisodes()`
(`libs/mobile/settings/src/lib/plex-sync.service.ts:326-358`), the guard
`if (!snap.exists()) continue;` (lines 345-347) means: when a freshly
Plex-imported show is mirrored in the **same** sync pass, its episode docs do not
exist yet, so **every watched-state write is skipped**. The code even acknowledges
this — the watch-implies-add branch comment says episodes "land on the next daily
sync once docs exist" (lines 216-217). The manual "Sync now" callable `triggerSync`
(`apps/functions/src/main.ts:501-527`) does **not** wire an episode engine (it
writes only `title-cache`), so pressing "Sync now" never creates episode docs
either.

Net effect: episodes watched in Plex only get marked in Vultus on a **later** Plex
sync, after the server has asynchronously created the docs — the two-sync latency
spec 0073 documented as an accepted tradeoff in its Risks
(§"Episode-doc dependency on the daily sync"). Issue #255 rejects that tradeoff.

**Scope of the bug (precise):** already-tracked shows **whose episode docs already
exist** DO mirror correctly today. The bug is specifically shows where episode docs
are **absent at mirror time** — newly Plex-added shows, and watch-implies-add
shows. Movies are unaffected (a movie's watched state is its own `viewCount`, not an
episode subcollection).

### Relationship to spec 0097 (fix-plex-sync-unmatched-shows, issue #256 — approved on `main`)

Spec **0097** (a separate Plex-sync bug fix, approved but **not yet
implemented**) modifies the **same function this spec touches**,
`PlexSyncService.processLibrary` (`plex-sync.service.ts`): it adds a **per-item
`try/catch`** so one throwing show no longer aborts the rest of the pass, records
**skipped/dropped** titles, and hardens pagination. This spec's on-device
episode-doc creation (`ensureEpisodeDocs`, called from within the same
per-item loop) is **complementary, not conflicting**, but the two will edit the
same loop. Coordination the implementer MUST honour:

- **Whichever merges second rebases onto the first** — do not re-derive the loop
  from the pre-0097 line numbers if 0097 landed first (its per-item `try/catch`
  will have shifted them). The `plex-sync.service.ts` line references in this spec
  are anchored to **pre-0097 `main`**; treat them as guidance, not literals, and
  re-locate against the working tree.
- This spec's `ensureEpisodeDocs` + TMDB fetch belongs **inside** 0097's per-item
  `try/catch` (if present), so a TMDB/episode-fetch failure for one show is
  isolated to that show — reinforcing this spec's own failure-isolation decision
  (§5) rather than duplicating it.
- Neither spec changes the other's contract: 0097 is about **which titles get
  imported / not silently dropped**; this spec is about **episode watch-state
  landing in one pass** for imported shows. No decision here overrides 0097.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **Approach: create the missing episode docs ON-DEVICE from TMDB, then mirror in
   the SAME sync pass.** This marks episodes watched **immediately** (the issue's
   word "directly"), stays within spec 0073's on-device / no-`scope:functions`
   boundary, and builds on spec 0086's precedent (the settings slice already
   fetches TMDB on-device via `tmdb-detail.client.ts`). Rejected alternatives:
   - **(a) "re-mirror after the server creates docs"** — keeps the invariant but is
     timing-dependent and never immediate on the first sync (the exact behavior
     #255 rejects);
   - **(b) "wire the episode engine into the `triggerSync` callable"** — a
     `scope:functions` change crossing the mobile→functions boundary 0073
     deliberately avoided, plus callable latency.

2. **This DELIBERATELY RELAXES the app-wide "episode docs are created only by Cloud
   Functions" invariant (specs 0034/0050/0053), for the Plex-sync path only.** This
   is the central architectural note of this spec. Safety argument:
   - the on-device creator uses the **same** TMDB source, the **same**
     `episodeToData` converter, and the **same** `s{SS}e{EEE}` id scheme as the
     functions, so the docs it writes are byte-for-byte what the functions would
     write;
   - it is **insert-only** — it skips ids that already have a local doc and never
     overwrites an existing doc's `watched`/`watchedAt`;
   - it is therefore **idempotent and race-safe** with the server's on-create
     trigger / daily cron (both insert-only, keyed by the same id — whichever
     creates a given id first, the other skips it). The mirror's `watched: true` is
     never clobbered because the functions store filters existing ids before
     writing.
     Whether `docs/PLAN.md` should carry a one-line note that the Plex-sync path may
     create episode docs on-device is called out in Risks as a possible follow-up doc
     touch — this spec does **not** edit PLAN.md.

3. **Faithful replication of the functions' episode-sync logic, on-device.** Sheriff
   forbids importing the `scope:functions` libs, so the behavior is **replicated**,
   not imported, from:
   - `libs/functions/sync-titles/src/lib/tmdb/tmdb-client.ts` — `getTvSeasonCount`
     (from `/tv/{id}` `number_of_seasons`, lines ~122-127) and `getSeasonEpisodes`
     (from `/tv/{id}/season/{n}`, lines ~140-150), both `404 → null`;
   - `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts:119-139` — episodes
     with a null/empty/missing `air_date` are **skipped** (`EpisodeDoc.airDate` is a
     non-null ISO string); `season_number` falls back to the season argument;
     `title` carries the TMDB episode `name` (null when absent);
   - `libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.ts` (loops
     seasons `1..count`; insert-only via `getExistingEpisodeIds`) and
     `episode-id.ts:10-30` (id `s{SS}e{EEE}`; the fresh doc carries
     `season`/`episode`/`title`/`airDate` and starts `watched: false`,
     `watchedAt: null`).
     There is **no `newEpisodeDoc` helper in `shared/domain`** (it lives in the
     `scope:functions` `episode-id.ts`); construct the `EpisodeDoc` literal **inline**
     and pass it through `episodeToData`. The `s{SS}e{EEE}` id is already replicated
     in this slice as `plexEpisodeId` (`plex-sync.service.ts:69-73`) — reuse it.

4. **Extend the settings-slice TMDB client**, keeping it slice-local (spec 0016
   decision 2 / spec 0086 — do NOT promote to `shared/domain`, do NOT import the
   search / title-detail slices). See §5.

5. **Wire into `PlexSyncService.processLibrary`** with a self-limiting gap-guard
   (only fetch TMDB when a watched Plex episode lacks a local doc). See §5 / §7.

6. **Failure isolation** (mirror spec 0086's `fetchDetailSafe` pattern): the TMDB
   season/episode fetch + doc creation is wrapped so a TMDB outage logs a **redacted**
   diagnostic (never the raw error — may echo the `api_key`, spec 0068) and returns
   without throwing out of the sync loop or failing the rest of the sync.

7. **Deterministic mock** for serve-mock (and, via Playwright route fixtures, e2e).
   See §7 T3/T4.

8. **Verification: extend e2e + unit** (no dependence on unmerged specs; no
   `test.fixme`). See §8.

Intended outcome: after a single Plex sync, a Plex-watched show's episodes are
created and marked watched immediately, and the show's status reaches
`watching`/`completed` — without waiting for a server-side daily sync.

## Scope

In:

- Extend the settings-slice-local TMDB client (`tmdb-detail.client.ts`) with
  `getTvSeasonCount(tmdbId)` and `getSeasonEpisodes(tmdbId, season)`, reusing its
  existing config/auth/fetch plumbing (`SETTINGS_TMDB_CONFIG`, `fetchImpl`
  override).
- In `PlexSyncService`, for a `tv` item, **before mirroring**: if any Plex-watched
  episode lacks a local doc, fetch the show's seasons/episodes from TMDB and create
  the **missing** episode docs (insert-only, the full set the functions would
  write, null-air_date episodes skipped), then run the existing `mirrorEpisodes`
  (now the docs exist → the watched writes apply), then the existing status
  derivation (`episodeCounts` + `deriveStatus`) reaches `watching`/`completed`.
- **Gap-guard:** the TMDB fetch runs **only** for a show with a real gap (a
  watched Plex episode with no local doc). Once created, later syncs find the docs
  and skip the fetch — no TMDB episode-list fetch for every show on every sync.
- **Failure isolation** around the TMDB fetch + creation (spec 0086 pattern).
- Preserve **sticky-`dropped`**: a dropped show still gets episode docs created +
  mirrored, but its status is never auto-changed.
- Extend `createMockFetch()` (`environment.mock.ts`) to serve `/tv/{id}` with
  `number_of_seasons` and `/tv/{id}/season/{n}` (episode lists) for the Plex
  mock-library show, so on-device episode creation is deterministic on serve-mock.
- Extend the e2e "sync outcome" flow to assert a Plex-watched show's episodes are
  created + marked watched and the show reaches `watching`.

Out of scope:

- **No `scope:functions` change** — no callable, no HTTP function, no episode
  engine wired into `triggerSync`. The server triggers/cron stay exactly as they
  are (they remain insert-only and race-safe with the new on-device creator).
- **No new route/page/UI** — reuses the existing watchlist card + title-detail
  episode UI and their watched indicators. No Stitch screen is touched.
- **No shared-type change** — reuses `EpisodeDoc`, `Episode`, `episodeToData`,
  `episodePath`/`episodesPath` (see §3/§5).
- **No `firestore.rules` / `firestore.indexes.json` change** (see §4).
- **No change to the movie path**, the additions cursor, GUID matching, the
  watch-implies-add status mapping, or the concurrent-sync guard (all spec 0073,
  unchanged).
- No PLAN.md edit in this spec (the invariant note is flagged in Risks as a
  possible follow-up).

## Affected slices & Sheriff tags

| Project           | Path                   | Sheriff tags                     | Change                                                                                                                              |
| ----------------- | ---------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| mobile-settings   | `libs/mobile/settings` | `scope:mobile`, `slice:settings` | Extend `tmdb-detail.client.ts` (2 methods); `PlexSyncService` on-device episode-doc creation + gap-guard + isolation; specs; README |
| mobile (mock env) | `apps/mobile`          | `scope:mobile`                   | Extend `createMockFetch()` in `environment.mock.ts` to serve `/tv/{id}` season count + `/tv/{id}/season/{n}` episode lists          |
| mobile-e2e        | `apps/mobile-e2e`      | untagged                         | Extend the existing `plex-sync.spec.ts` "sync outcome" flow + TV route fixtures                                                     |

- **Tagging is by path glob in `sheriff.config.ts`** — every touched project
  already carries its tag; **this spec does NOT edit `sheriff.config.ts`**.
  `libs/mobile/settings/src` is `scope:mobile` + `slice:settings`; `apps/mobile` is
  `scope:mobile`.
- **No cross-slice import is introduced.** Episode/watchlist writes go **by PATH**
  via `@vultus/shared/firestore-schema` converters (`episodePath`, `episodesPath`,
  `episodeToData`) and the `scope:shared` `Episode` / `EpisodeDoc` domain types —
  the settings slice never imports `slice:watchlist` / `slice:title-detail`, and it
  **replicates** the `scope:functions` episode-sync logic rather than importing the
  `sync-episodes` lib (the `plexEpisodeId` replication is already in the slice).
- **No `scope:mobile` ↔ `scope:functions` edge** anywhere in the path.
- The TMDB protocol stays **slice-local** (spec 0016 decision 2, reaffirmed by 0086) — the "extract at 3+ slices" rule is intentionally not applied; the settings
  slice must not import `@vultus/mobile/search` / `@vultus/mobile/title-detail`.

## Data model touchpoints

PLAN §4 paths. The feature reads/writes only the EXISTING
`users/{uid}/watchlist/{titleId}/episodes/{episodeId}` subcollection (and reads the
tracked watchlist doc). **No new collection, field, or converter.**

| PLAN §4 path                                      | Access                           | By                                                                       |
| ------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| `users/{uid}/watchlist/{titleId}/episodes`        | read (one-shot list)             | sync engine — existing-id set for the insert-only diff + status counts   |
| `users/{uid}/watchlist/{titleId}/episodes/{epId}` | **create** (insert-only), update | sync engine — create the missing docs, then mirror `watched`/`watchedAt` |
| `users/{uid}/watchlist/{titleId}`                 | read, update                     | sync engine — status derivation (unchanged from 0073/0086)               |

- **`EpisodeDoc` shape (unchanged, PLAN §4 / `documents.ts:92-99`):** `season`,
  `episode`, `title: string | null`, `airDate: string` (non-null ISO), `watched:
boolean`, `watchedAt: string | null`. The on-device creator constructs this literal
  inline (`{ …, watched: false, watchedAt: null }`) and writes via
  `setDoc(episodePath(uid, String(tmdbId), epId), episodeToData(doc))` — the same
  converter chain the functions use, so the persisted document is identical.
- **Insert-only:** before writing, read the existing episode-id set for the title
  (a one-shot `getDocs(episodesPath(...))`) and write **only** ids not already
  present. This never overwrites a doc's `watched`/`watchedAt` and is race-safe with
  the server's insert-only writers.
- **`firestore.rules`: NO change.** The recursive `match /users/{userId} { …
match /{document=**} { allow read, write: if isOwner(userId) } }` owner rule
  already authorizes `setDoc`/`updateDoc` on the episodes subcollection — a create
  is covered by the same `{document=**}` owner rule (specs 0004/0011/0073). Run
  `pnpm test:rules` to **confirm** the existing owner rule still covers the create;
  no rule is added or changed. **State this explicitly in the PR.**
- **`firestore.indexes.json`: NO change.** All reads/writes are by document id
  (`episodePath`) or a one-shot subcollection read (`episodesPath`); no new
  `where(...)`/`orderBy(...)` query is introduced, so no composite index. **State
  this explicitly.**

## Public types / APIs

All new surface is **settings-slice-local** — no `shared/domain` change, so **no
F2 shared-type ripple** and **no `.toEqual` write-payload ripple** (no shared
converted type gains a field; `episodeToData`/`dataToEpisode` are untouched). State
this in the PR.

**F4 (onboarding parity): N/A.** This spec adds/changes **no `User` domain field**.
`plexSync` / `hasPlex` already exist and are unchanged; no persisted user preference
is introduced. The reviewer's F4 probe is satisfied — there is no `User`-field change
to route through (or deliberately exclude from) first-launch onboarding.

### Settings-slice TMDB client (extend `libs/mobile/settings/src/lib/tmdb-detail.client.ts`)

Add two methods to the existing `TmdbDetailClient` interface (and its
`createTmdbDetailClient` factory), reusing the same `config`/`authParts`/`buildUrl`/
`doFetch` plumbing already in the file:

```ts
export interface TmdbDetailClient {
  getDetail(
    tmdbId: number,
    typeHint?: TitleType,
    signal?: AbortSignal,
  ): Promise<TmdbDetail>;
  /** GET /tv/{id} → `number_of_seasons`; `null` on TMDB 404 (spec 0098).
   *  Replicates functions `getTvSeasonCount` (tmdb-client.ts:122-127 /
   *  mapper `mapTvSeasonCount`). Non-404 non-2xx → throw `TmdbDetailError`. */
  getTvSeasonCount(
    tmdbId: number,
    signal?: AbortSignal,
  ): Promise<number | null>;
  /** GET /tv/{id}/season/{n} → the season's episodes with a NON-NULL air_date;
   *  `null` on TMDB 404 (spec 0098). Episodes with a null/empty/missing
   *  `air_date` are SKIPPED (EpisodeDoc.airDate is non-null). `season` falls back
   *  to the argument; `title` = TMDB `name ?? null`. Replicates functions
   *  `getSeasonEpisodes` + `mapSeasonEpisodes` (tmdb-mappers.ts:119-139).
   *  Non-404 non-2xx → throw `TmdbDetailError`. */
  getSeasonEpisodes(
    tmdbId: number,
    season: number,
    signal?: AbortSignal,
  ): Promise<Episode[] | null>;
}
```

- Return type reuses the **`scope:shared`** `Episode` type
  (`@vultus/shared/domain` — `{ season, episode, title: string | null, airDate:
string }`), the same domain shape the functions map to and the same shape
  `episodeToData` consumes. This is shared vocabulary (allowed), not a cross-slice
  import.
- **404 → null** (both methods), distinct from `getDetail` which throws on 404.
  Rationale: the ensure-step treats "show/season not found in TMDB" as "nothing to
  create" (matching the functions engine's `count === null → skipped` and
  `eps === null → continue`), while a genuine 5xx / network / abort throws and is
  caught by the isolation wrapper (below). Add a small raw season DTO interface
  (`RawTmdbSeason` with `episodes?: { air_date?; episode_number; season_number?;
name? }[]`) and a `mapSeasonEpisodes`-equivalent inside the factory that reuses
  the existing `parseYear`-style helpers; add a `normalizeAirDate` (a present
  `YYYY-MM-DD` → full ISO instant; null/empty/missing → null → skip) mirroring the
  functions' `normalizeDate`.
- `getSeasonEpisodes` uses `type: 'tv'` explicitly (no movie fallback). The
  auth/language query params are built exactly as `getDetail` does.

The client stays **slice-internal** (not barrel-exported) — only `PlexSyncService`
consumes it. No barrel (`index.ts`) change.

### `PlexSyncService` (extend `libs/mobile/settings/src/lib/plex-sync.service.ts`)

Restructure the `tv` branch of `processLibrary` so the Plex episode list is fetched
**once** and passed to both the ensure-step and the mirror (today `mirrorEpisodes`
calls `listEpisodes` internally — split it so we don't double-call the PMS):

- New private `listPlexEpisodes(server, item): Promise<PlexEpisodeItem[]>` (or fetch
  inline) — the single `client.listEpisodes(server, item.ratingKey)` call for a tv
  item.
- New private
  `ensureEpisodeDocs(uid, tmdbId, plexEpisodes): Promise<void>` — the on-device
  creator:
  1. **Gap-guard:** read the existing episode-id set
     (`getDocs(episodesPath(uid, String(tmdbId)))`). If **no** watched Plex episode
     (`viewCount > 0`) is missing from that set → **return immediately** (no TMDB
     fetch). This is the self-limiting guard (decision 5): a show whose watched
     episode docs already exist is never re-fetched.
  2. On a gap: `getTvSeasonCount(tmdbId)`; if `null` → return. For `season` in
     `1..count`: `getSeasonEpisodes(tmdbId, season)`; skip a `null` season; collect
     the episodes.
  3. Build the FULL `EpisodeDoc` set the functions would write; filter to ids
     **not** already in the existing set (insert-only); `setDoc(episodePath(uid,
String(tmdbId), plexEpisodeId(e.season, e.episode)), episodeToData({ season,
episode, title, airDate, watched: false, watchedAt: null }))`.
- New private `ensureEpisodeDocsSafe(uid, tmdbId, plexEpisodes): Promise<void>` —
  wraps `ensureEpisodeDocs` in try/catch (mirror `fetchDetailSafe`): on ANY failure
  (network / non-404 non-2xx / timeout / abort / Firestore) log
  `` `[plex-sync] ensure episodes ${tmdbId} failed: ${describeTmdbError(err)}` ``
  (a **redacted** diagnostic — never the raw error object, spec 0068) and return
  without throwing, so a TMDB outage never fails the rest of the sync.
- `mirrorEpisodes(...)` — change to accept the already-fetched
  `plexEpisodes: PlexEpisodeItem[]` (no internal `listEpisodes`); its
  create-nothing / `updateDoc`-existing-only body is otherwise unchanged.
- **Create→mirror read-back (do NOT "optimize" away the separation):**
  `ensureEpisodeDocs` inserts docs with `watched: false`, and then, in the **same
  sync pass**, the existing `mirrorEpisodes` re-reads each via `getDoc` and
  `updateDoc`s to `watched: true`. This relies on Firestore read-your-writes from the
  local mutation cache and is sound — it is the same insert-only-creation vs
  mirror-update separation the functions engine relies on across passes. The
  implementer must **not** collapse this by having `ensureEpisodeDocs` write the
  watched state directly: doing so would blur the insert-only-creation vs
  mirror-update boundary that the idempotency / race-safety argument (decision 2)
  rests on.
- `processLibrary` tv path ordering (both the untracked and already-tracked
  branches): `plexEpisodes = listPlexEpisodes(...)` →
  `await ensureEpisodeDocsSafe(uid, tmdbId, plexEpisodes)` →
  `mirrorEpisodes(uid, server, item, tmdbId, plexEpisodes)` → existing
  status logic. Creating episode docs under a not-yet-created watchlist parent is
  valid in Firestore (paths, not parent-existence). The existing poster backfill,
  sticky-`dropped` guard, `deriveStatus`, and summary counting are **unchanged**.

`plexEpisodeId`, `describeTmdbError`, `episodeCounts`, `deriveStatus`,
`fetchDetailSafe`, `addItem`, `currentTracked`, the `PlexSyncResult` contract, and
the movie path all stay as they are.

No callable, HTTP-endpoint, or `shared` shape changes.

## UI / Stitch screen refs

**Not applicable — no UI / template / styling change.** This spec adds no route,
page, or component; it reuses the existing watchlist card (`.watchlist-card`,
`.status-{watching|completed}`) and the title-detail episode UI already shipped
(`title-detail.page.html`): `[data-test="episodes-section"]`,
`[data-test="episode-row"]`, the watched toggle `[data-test="episode-watched-toggle"]`
(`title-detail.page.html:368`; class `.watched-toggle` / `[class.is-watched]` when
watched), and the per-season header `"{watchedCount}/{total} watched"`. The e2e (§8)
asserts against these EXISTING selectors — preferring the stable
`data-test="episode-watched-toggle"` hook over the class, consistent with the rest
of the suite — no Stitch screen is touched, so no screen capture is required. No `docs/design/vultus-design-system.md` token is consumed or changed.

## Implementation task graph

**T1 [sequential] — extend the settings TMDB client (shared dep; must finish
first).** T2 consumes the two new methods.

File manifest:

- `libs/mobile/settings/src/lib/tmdb-detail.client.ts` (MODIFIED) — add
  `getTvSeasonCount` + `getSeasonEpisodes` to the interface and factory; add the
  `RawTmdbSeason` DTO + the season-episode mapping (skip null-air_date) + air-date
  normalization; import the `scope:shared` `Episode` type. 404 → null; other
  non-2xx → `TmdbDetailError`.
- `libs/mobile/settings/src/lib/tmdb-detail.client.spec.ts` (MODIFIED) — see Test
  plan.

**T2 [parallel, after T1] — `PlexSyncService` on-device episode creation.**

File manifest:

- `libs/mobile/settings/src/lib/plex-sync.service.ts` (MODIFIED) —
  `listPlexEpisodes`, `ensureEpisodeDocs`, `ensureEpisodeDocsSafe`; the
  `mirrorEpisodes` signature change (accept the fetched episodes); the
  `processLibrary` tv-branch ordering (ensure → mirror). Imports: `Episode` from
  `@vultus/shared/domain`, `episodeToData` from `@vultus/shared/firestore-schema`.
- `libs/mobile/settings/src/lib/plex-sync.service.spec.ts` (MODIFIED) — see Test
  plan.
- `libs/mobile/settings/README.md` (MODIFIED) — under the `PlexSyncService`
  section, document the new client methods and the **on-device episode-doc creation
  behavior**: the relaxed "docs created only by Cloud Functions" invariant for the
  Plex path, insert-only + race-safe with the server, the gap-guard, the
  null-air_date skip, and the failure isolation.

**T3 [parallel, after T1] — deterministic mock TMDB season/episode fixtures.**

File manifest:

- `apps/mobile/src/environments/environment.mock.ts` (MODIFIED) — in
  `createMockFetch()`: (a) add `number_of_seasons` to the `/tv/{id}` detail stub for
  the Plex mock-library show (1396); (b) add a `/tv/{id}/season/{n}` branch (checked
  before the generic `/tv/{id}` match) returning a deterministic `episodes[]` for
  1396 season 1 whose `episode_number`/`season_number`/`air_date` line up with
  `MockPlexClient`'s S1E1 (watched) + S1E2 (unwatched). Do not disturb the existing
  search / detail / providers stubs.
- `libs/mobile/settings/src/lib/plex.client.mock.ts` (MODIFIED **only if needed**) —
  `MockPlexClient` already returns Breaking Bad (1396) with S1E1 `viewCount:1` +
  S1E2 `viewCount:0`; **verify** these numbers line up with the mock TMDB season
  list above. Expected: no change (confirm alignment only).

> T2 and T3 are file-disjoint (T2 writes `plex-sync.service.ts` + its spec + README;
> T3 writes `environment.mock.ts` + optionally `plex.client.mock.ts`) and may run in
> parallel after T1. `settings.providers.mock.ts` is **not** required — on
> serve-mock the connected card uses the page-scoped mock `PlexSyncService` mirror,
> so on-device episode creation is exercised by the ROOT real service under unit +
> e2e, not the serve-mock page mock; the `createMockFetch` extension makes an
> on-device (native) run against these ids deterministic and is the serve-mock
> eyeball aid.

**T4 [sequential, after T2 + T3] — extend the e2e "sync outcome" flow.**

File manifest:

- `apps/mobile-e2e/src/plex-sync.spec.ts` (MODIFIED) — extend the existing "sync
  outcome" flow (do NOT add a new flow). Route the TV endpoints for 1396 before
  boot (the `development` config e2e uses has no fetch mock): register
  `**/tv/1396/season/**` → the season fixture and `**/tv/1396**` → the detail
  fixture, with the season route registered **last** so it wins for season URLs
  (Playwright gives later routes priority). Then assert the show's episodes were
  created + marked (see §8).
- `apps/mobile-e2e/fixtures/tmdb-tv-detail-1396.json` (MODIFIED) — add
  `"number_of_seasons": 1`.
- `apps/mobile-e2e/fixtures/tmdb-tv-season-1396-s1.json` (NEW) — a season response
  with `episodes: [{ episode_number: 1, season_number: 1, name, air_date }, {
episode_number: 2, season_number: 1, name, air_date }]`, air_dates present so both
  episodes survive the null-air_date skip.

**Disjointness:** T1 is the only shared dep. T2 writes only
`libs/mobile/settings/{plex-sync.service.ts, plex-sync.service.spec.ts, README.md}`;
T3 writes only `apps/mobile/src/environments/environment.mock.ts` (+ optionally
`libs/mobile/settings/src/lib/plex.client.mock.ts`); T4 writes only
`apps/mobile-e2e/**`. T2/T3 are pairwise file-disjoint. T4 is sequential because it
exercises T2's runtime behavior and depends on T3's mock alignment (but edits no
file either writes).

## Test plan

Per the PLAN §5 pyramid. All Firebase + Plex + TMDB access in unit tests is mocked;
no emulator (project memory: the emulator cannot run under Claude Code tools; the
e2e gate runs in CI). **Rendered-text assertions use the EXACT string — no
whitespace-normalization** — and the component/unit assertion and the e2e assertion
stay **consistent on the same copy** (e.g. the per-season header `"1/2 watched"`).

**Unit (settings — `tmdb-detail.client.spec.ts`, MODIFIED, fake `fetch`):**

- `getTvSeasonCount` maps `number_of_seasons` from a `/tv/{id}` payload; returns
  `null` on a 404; **throws `TmdbDetailError` on a 500** (not null).
- `getSeasonEpisodes` maps a season payload → `Episode[]` with the correct
  `season`/`episode`/`title`/`airDate`; **skips episodes with null/empty/missing
  `air_date`**; `season_number` falls back to the argument; `name` absent → `title:
null`; returns `null` on a 404; throws `TmdbDetailError` on a 500.
- Auth wiring: `api_key` query param when `auth.kind: 'apiKey'`; bearer header when
  configured; the injected `fetchImpl` is used.

**Unit (settings — `plex-sync.service.spec.ts`, MODIFIED, mocked `PlexClient` +
`TmdbDetailClient` + Firestore):**

- **On-device creation writes correct id + fields:** a watched, untracked show
  whose episode docs are absent → `setDoc` on
  `episodePath(uid, tmdbId, 's01e001')` (and `s01e002`) with `episodeToData` output
  (`watched: false`, `watchedAt: null`, correct `season`/`episode`/`title`/
  `airDate`).
- **Insert-only — never overwrites an existing watched doc:** a show where
  `s01e001` already exists as `watched: true` → `getTvSeasonCount`/season fetch may
  run for the gap, but the existing `s01e001` id is **filtered out** of the create
  set (no `setDoc` on it); its `watched: true` survives; only genuinely-missing ids
  are `setDoc`.
- **Skips existing ids** in the create diff (assert the create set excludes any id
  already in `episodesPath`).
- **Null-air_date episodes skipped:** a season payload with one null-air_date
  episode → no doc created for it.
- **Gap-guard — no fetch when docs present:** a show whose watched Plex episodes all
  have local docs → `getTvSeasonCount`/`getSeasonEpisodes` are **not called** (assert
  the mock methods were not invoked) and no episode `setDoc` fires.
- **Gap-guard — fetch only when a watched episode's doc is missing:** a watched Plex
  episode with no local doc → the TMDB fetch runs and the doc is created.
- **Mirror-after-create marks watched:** after creation, `mirrorEpisodes`
  `updateDoc`s the created `s01e001` to `watched: true` (+ `watchedAt` from the
  Plex `lastViewedAt`).
- **Status reaches `watching` / `completed`:** a `planned` (or newly-added) show
  with ≥1 watched present episode → `watching`; a show with ALL present episodes
  watched → `completed`.
- **Sticky-`dropped` still creates + mirrors, no status change:** a tracked
  `dropped` show with a gap → episode docs created + mirrored (`watched: true`
  written), but **no status `updateDoc`** (status stays `dropped`).
- **TMDB-failure isolation:** `getTvSeasonCount` (or `getSeasonEpisodes`) rejects
  (network / 500 / timeout) → `sync()` still resolves (`ok`, not `error`), does not
  throw, and the rest of the loop completes; no episode docs created for that show.
- **All existing 0073 / 0086 invariants keep passing** (cursor filtering, GUID-less
  skip, watch-implies-add, poster backfill skip-when-present, dropped poster
  backfill, summary counts) — the `mirrorEpisodes` signature change and the new
  ordering must not regress them.

**Component:** none — no component with non-trivial state changes (no UI change).
The existing title-detail episode component tests are unaffected.

**e2e (rubric): REQUIRED — extend the existing critical flow.** `scope:mobile`,
substantially changes the outcome of the "sync outcome" flow (a critical
add-to-watchlist / status action). No brand-new flow; no `test.fixme` (no dependence
on an unmerged spec). In `apps/mobile-e2e/src/plex-sync.spec.ts`, extend the "sync
outcome" test after the existing movie assertions:

1. Route `/tv/1396` (detail incl. `number_of_seasons`) and `/tv/1396/season/1` (the
   season fixture) before boot, per T4.
2. After the mocked "Sync now" completes, assert on the emulator (deterministic):
   - `users/{uid}/watchlist/1396/episodes/s01e001` exists with `watched: true`;
   - `users/{uid}/watchlist/1396/episodes/s01e002` exists with `watched: false`
     (created insert-only, unwatched);
   - `users/{uid}/watchlist/1396` `status` is `watching`. Note the mock show 1396 is
     UNTRACKED before sync, so it reaches `watching` via the **watch-implies-add**
     mapping (`processLibrary` ~line 221: untracked + any watched episode → show added
     as `watching`), which does **not** consult episode counts — **not** via a
     count-driven `deriveStatus` "≥1 watched, not all" derivation.
3. Assert on the UI (EXACT strings, consistent with the component contract):
   - the Breaking Bad watchlist card is visible with `.status-watching`;
   - navigate to the title-detail page for 1396 and assert the episodes section
     renders, the per-season header shows `"1/2 watched"` (EXACT — no
     whitespace-normalization), and the S1E1 vs S1E2 watched state is asserted
     via the stable `[data-test="episode-watched-toggle"]` hook
     (`title-detail.page.html:368`) — consistent with the rest of the suite's
     `data-test` convention — rather than by the `.watched-toggle` /
     `[class.is-watched]` class (assert the S1E1 row's toggle is in the watched
     state and the S1E2 row's is not).

These become DoD gates enforced by `qa-runner` / `feature-reviewer`. Runs in CI /
the user's terminal against the emulator (not in-session).

## Definition of done

- [ ] Typecheck passes (`nx affected -t typecheck`) — the extended client + service
      compile; the reused `scope:shared` `Episode` / `episodeToData` are correctly
      imported.
- [ ] Lint + Sheriff pass — the client stays slice-local; **no** import of
      `@vultus/mobile/search` / `@vultus/mobile/title-detail` / any `scope:functions`
      lib; no `scope:mobile` ↔ `scope:functions` edge; no `sheriff.config.ts` change.
- [ ] Unit tests pass, and the changed slice has tests for its logic — the extended
      `tmdb-detail.client.spec.ts` and `plex-sync.service.spec.ts` cases above
      (`nx test settings`); all existing 0073/0086 invariants still green.
- [ ] Component tests — none required (no UI change; justified).
- [ ] e2e passes for the affected critical flow — the extended "sync outcome" flow
      asserts the show's `s01e001` episode doc is created + `watched: true`,
      `s01e002` created + unwatched, the show is `watching`, and the title-detail
      episodes render `"1/2 watched"` with the S1E1 vs S1E2 watched state asserted
      via `[data-test="episode-watched-toggle"]` (CI / emulator).
- [ ] Build passes for affected projects (`nx affected -t build --base=main`),
      including `apps/mobile` and the `mock` configuration (the extended
      `environment.mock.ts` season/episode stubs).
- [ ] `libs/mobile/settings/README.md` updated for the new client methods + the
      on-device episode-doc creation behavior (relaxed invariant, insert-only,
      gap-guard, null-air_date skip, failure isolation).
- [ ] **No `scope:functions` change** — server triggers/cron untouched; `triggerSync`
      unchanged. Stated in the PR.
- [ ] **No `firestore.rules` change** — `pnpm test:rules` confirms the existing
      `users/{userId}` owner rule still covers the episode-doc **create**; no rule
      added/changed. Stated in the PR. (`pnpm test:rules` uses
      `firebase emulators:exec`, so it runs in CI / the user's own terminal, **NOT
      in-session** — the Firestore emulator cannot run under Claude Code tools, same
      caveat as the e2e and on-device human-verification gates.)
- [ ] **No `firestore.indexes.json` change** — all access by document id / one-shot
      subcollection read; no new query. Stated in the PR.
- [ ] **No `shared/domain` / `shared/firestore-schema` change** — reuses
      `EpisodeDoc` / `Episode` / `episodeToData`; no F2 shared-type ripple, no
      `.toEqual` write-payload ripple. Stated in the PR.
- [ ] **F4 (onboarding parity): N/A** — no `User` field added/changed. Stated in
      the PR.
- [ ] PR references this spec (0098).
- [ ] **POST-MERGE on-device human verification (required — real PMS + TMDB path is
      only verifiable on device).** Via `pnpm nx run mobile:android-usb` against the
      user's real Plex server: watch an episode in Plex for a show not yet in Vultus
      (or freshly added), run a Plex sync, and confirm the episode is marked watched
      in Vultus **immediately** (single sync) and the show reaches
      `watching`/`completed`. The mock/e2e prove the logic; the real PMS+TMDB call
      chain cannot run in-session (project memory: emulator/on-device limitation).

## Risks

- **Unaired-but-watched episode.** An episode a user marked watched in Plex that
  TMDB has no `air_date` for is **skipped** (no doc created, `EpisodeDoc.airDate` is
  non-null) and therefore still can't be marked. This is rare (a genuinely-unaired
  episode watched in Plex) and matches the functions' own behavior exactly (spec
  0047 data-model option b) — the on-device docs stay identical to the server's, so
  the daily cron adds nothing to reconcile. Not fixed here; called out so it is not
  mistaken for a regression.
- **Relaxed invariant / PLAN note.** This spec is the first place episode docs are
  created outside Cloud Functions (for the Plex path only). `docs/PLAN.md` §4's
  narrative that episode docs are functions-created may warrant a one-line note.
  This spec does **not** edit PLAN.md; a follow-up docs touch (or a
  reviewer-requested edit) can add the note. The safety argument (identical source /
  converter / id scheme; insert-only; idempotent + race-safe with the server's
  insert-only writers) is captured in §Context decision 2 and the settings README.
- **TMDB per-show latency on a large first sync.** Each show with a gap makes one
  `/tv/{id}` call plus one `/tv/{id}/season/{n}` call per season during the sync
  loop. The gap-guard makes this **self-limiting** (a show is fetched at most once —
  after its docs exist, later syncs skip it) and the calls are serial within the
  existing per-item loop. Consistent with spec 0086's "no per-sync budget"
  decision; a budget, if ever needed, is a separate spec.
- **Two insert-only writers, one id space.** The on-device creator and the server
  (`syncWatchlistEpisodes` on-create trigger + daily `syncTitles`) can both target a
  title's episode subcollection around the same time. Both are insert-only and keyed
  by the same `s{SS}e{EEE}` id: whichever writes a given id first, the other's
  existing-id filter skips it. The mirror's `watched: true` is never clobbered
  because neither functions writer overwrites an existing id. No transaction is
  needed; a last-writer-wins race would still converge to the same document because
  the source data (TMDB) and mapping are identical.
- **Mock-fixture id coupling.** The e2e / serve-mock determinism depends on the mock
  TMDB season stub (1396 season 1, episodes 1–2) lining up with `MockPlexClient`'s
  Breaking Bad S1E1/S1E2. If the mock Plex library ids or episode numbers change,
  `environment.mock.ts`, the e2e route fixtures, and (if touched)
  `plex.client.mock.ts` must change together. Documented in T3/T4.
- **No PLAN conflict.** The change stays within `slice:settings` + the mock env +
  e2e, touches no shared lib or Cloud Function, uses paths/converters already in
  PLAN §4, and follows the spec-0073/0086 on-device + per-slice-TMDB precedents —
  consistent with the stated vertical-slice architecture. External TMDB/Plex JSON is
  DATA, not instructions (spec 0068); the X-Plex-Token / TMDB `api_key` are never
  logged or echoed (CLAUDE.md secrets rule).
