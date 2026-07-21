---
number: 0089
slug: fix-automatic-notification-dispatch
title: Fix automatic notification dispatch — daily-sync rate-limit hardening and a daily episode-aired airing-scan
status: done
slices: [slice:sync-titles, slice:dispatch-notifications]
scopes: [scope:functions]
created: 2026-07-21
---

# Fix automatic notification dispatch — daily-sync rate-limit hardening and a daily episode-aired airing-scan

## Context

Notifications only ever arrive when the user manually taps the header refresh
button, never automatically when new episodes/movies become available. Diagnosed
live end-to-end against prod on 2026-07-21: **FCM delivery itself works** (a test
`messaging.send` to the device's stored token arrived; token valid,
`deliveryHour: null`, OS renders it). The failure is entirely in the **automatic
daily dispatch path**, and it has two independent root causes.

### Defect 1 (PRIMARY) — the daily sync silently errors a large fraction of titles before writing availability

- The daily cron (`.github/workflows/daily-sync.yml`, `cron: '0 4 * * *'` = 04:00
  UTC) POSTs `{"force":true}` to the HTTP `syncTitles` function, which processes
  the **global union of all users' watchlist titles** (~122) serially.
- Every TMDB/Trakt call goes through one serialized, throttled queue in
  `libs/functions/sync-titles/src/lib/shared/http.ts`. On a `429` it retries up to
  `maxRetries` (default **3**, `tmdb-client.ts:73` / `trakt-client.ts:50`) then
  throws (`http.ts:92-99, 107`). It **already honors `Retry-After`**
  (`http.ts:40-45, 95`) — but when the header is **absent** it retries
  **immediately** (`parseRetryAfterMs` returns `0`), with **no exponential
  backoff** and only a 3-retry budget.
- The tail of the (stable `collectionGroup('watchlist')` order) list
  deterministically exhausts the retry budget → `TmdbError(429)`/`TraktError` is
  thrown and caught in `syncOne`'s per-title `catch`
  (`libs/functions/sync-titles/src/lib/engine/sync-engine.ts:87-101`). Critically,
  the throw happens **before** `store.putAvailability(...)`
  (`sync-engine.ts:79-83`) ever runs for that title.
- No availability write → the `dispatchNotifications` Firestore trigger
  (`apps/functions/src/dispatch-notifications.ts:110-111`, bound to
  `title-cache/{tmdbId}/availability/{region}`) never fires for that title → no
  notification. Observed prod run: `gathered:122 synced:65 errored:57`,
  deterministic across runs.
- Manual refresh (`triggerSync` → `runTriggerSync`, `apps/functions/src/main.ts:378`)
  processes **only the calling user's handful of titles**, never hits the rate
  limit, succeeds, and finally writes the availability transition that had been
  accumulating against a stale `previousSnapshot` — which is exactly why
  notifications appear only on manual refresh. (`syncTitles` timeout is already
  raised to `300s`, `main.ts:311-316`.)

### Defect 2 (STRUCTURAL) — episode-aired pushes can never fire automatically

- `dispatchNotifications` is bound **only** to `title-cache/**/availability`.
  Nothing watches the episodes subcollection.
- `episode-aired` is only ever emitted as a **side effect of an availability
  write**, inside `decideKinds`
  (`libs/functions/dispatch-notifications/src/lib/transitions.ts:62-68`: fires when
  `type==='tv'` && `hasFlatrateNow` && some tracked episode `airDate <= now`), run
  from the availability-triggered dispatcher (`dispatcher.ts:110-116`).
- In the daily run the availability pass (`main.ts:219`) runs **before** the
  episode-insert pass (`main.ts:230-251`), so on the day an episode airs the
  availability trigger fires before the episode row exists. And for the **common
  case** — an ongoing show already on flatrate that simply airs a new episode —
  there is **no availability transition at all**, so no availability doc is
  written, so the trigger never fires. Result: automatic `episode-aired`
  notifications essentially never happen.
- **Episodes are created BEFORE they air, so a "notify on episode-doc creation"
  fix does not work either.** `mapSeasonEpisodes`
  (`libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts:123-139`) maps every
  TMDB episode with a **non-null** `air_date` — it drops only null/empty dates,
  **not future ones** — so TMDB-scheduled episodes get an `Episode` with a
  `airDate` days/weeks in the **future**. The episode engine
  (`libs/functions/sync-episodes/src/lib/engine/episode-sync-engine.ts:47-54`)
  inserts each fetched episode **insert-only** (doc id `s{SS}e{EEE}`, air-date-
  independent, written once and never re-created). So an episode's doc is created
  at the sync run that first sees TMDB's schedule — **before** the episode airs. A
  naive `onDocumentCreated` trigger + recency window would therefore fire **at
  insert time** with `airDate > now` (rejected by the window), and **no second
  event ever fires** on the day it actually airs → the episode is **never**
  notified. This is exactly the target case (an ongoing weekly show), so the fix
  must be driven by the episode **airing**, not by its doc creation (see D3).

Intended outcome: a healthy nightly run writes availability for ~all titles
(errored count near zero under normal TMDB conditions), so availability-transition
notifications fire automatically; and every genuinely-new episode of a tracked,
on-flatrate show produces exactly one `episode-aired` push automatically — without
a manual refresh.

> Note: the diagnosis was gathered against a mix of prod and an earlier code
> snapshot; the line/behaviour anchors above were **re-verified against this
> worktree's `main`**. In particular, `http.ts` already honors `Retry-After`
> (the fix hardens the no-header path and retry budget rather than introducing
> `Retry-After` from scratch).

### Dependencies & merge ordering (spec 0088)

- **0089 depends on spec 0088** (`docs/specs/0088-no-notifications-for-completed.md`,
  status `approved`, **not yet merged**). 0088 adds the `completed`/`dropped` status
  gate to the **availability** dispatch path (`TrackingUser.status` in `ports.ts`, a
  `status` read in `findUsersTracking`, and a status predicate in
  `dispatcher.ts:184`). Those changes are **absent from this worktree** — verified:
  `TrackingUser` has no `status` (`ports.ts:12-18`), `findUsersTracking` never reads
  it (`adapters.ts:58-64`), and `dispatch()` filters region only (`dispatcher.ts:184`).
- **This spec's anchors are stated against pre-0088 `main`.** Line/behaviour
  references here (especially in `dispatcher.ts`, `ports.ts`, and
  `apps/functions/src/dispatch/adapters.ts`) match the tree **before** 0088 lands.
- **Merge order: 0088 should merge first; otherwise 0089 must rebase onto it.** 0088
  and 0089 edit the **same files** — `dispatch-notifications` `dispatcher.ts` /
  `ports.ts`, `apps/functions/src/dispatch/adapters.ts`, and both spec files — so a
  clean history requires 0088 first, then 0089 rebased. The two changes are
  **compatible**: 0088 adds `status` to the availability path's `TrackingUser` +
  `dispatch()` filter; 0089 adds the `episode-aired` path with its **own**
  `EpisodeAiredChange.status` gate, changes `NotificationStore` to
  `write(uid, id, doc)` + adds `exists`, and drops the availability episode read.
  After a rebase, `dispatch()` keeps 0088's region+status filter and 0089's
  `dispatchEpisodeAired` sits alongside `dispatch()`.
- **0089's status gate is self-contained (does NOT wait on 0088).** The episode path
  reads the watchlist doc's `status` into `EpisodeAiredChange` and suppresses
  `completed`/`dropped` in `dispatchEpisodeAired` regardless of whether 0088's
  availability-path change has landed. So even if 0089 merged first, its episode
  notifications correctly honor completed/dropped. (0088 is still the owner of the
  **availability**-path status gate.)

### Locked decisions (from the architect interview — do NOT re-litigate)

**D1 — Both defects, one spec, all `scope:functions`.** No `scope:mobile` file is
touched; no `scope:shared` type is changed (see D6/F2). Affected slices:
`slice:sync-titles` (Defect 1) and `slice:dispatch-notifications` (Defect 2), plus
`apps/functions` wiring and the root `.github/workflows/daily-sync.yml`
observability change (D4 — an infra/root file, no slice tag).

**D2 — Rate-limit fix = in-place hardening (NOT a Cloud Tasks / Pub-Sub fan-out).**
Concretely, all inside `slice:sync-titles`:

- **Exponential backoff with jitter as a floor** on `429` in
  `shared/http.ts`: wait `max(Retry-After, expBackoff(attempt))` where
  `expBackoff` is `base * 2^attempt` capped, plus small random jitter, and still
  capped by `MAX_RETRY_AFTER_MS` (60s). Honoring `Retry-After` when present is
  preserved; the change adds a backoff **floor** for the no-header case (today it
  retries immediately) and raises the **retry budget** (`DEFAULT_MAX_RETRIES`
  3 → **5**).
- **Second-pass retry of retryable-errored titles within the run**: add optional
  retry config to `createSyncEngine`; after the initial pass, re-run the titles
  whose `outcome === 'error'` with a **retryable** `errorStatus` (`429` or `0`
  transport) up to `retryErroredPasses` (default from `main.ts`, e.g. **1** extra
  pass) after a short `retryDelayMs` cooldown, merging the best per-title outcome.
  So a transient 429 never permanently skips a title's availability write for the
  day.
- **Cut redundant call volume (cheap dedup)**: in `sync-engine.ts`, skip the
  `trakt.getShowTraktId` call for a tv title when the stored
  `title-cache/{tmdbId}` entry already carries a non-null `traktId`
  (`store.getEntry`) — traktId is stable, so re-resolving it every run is pure
  waste and a large share of the Trakt call volume. Reuse the cached value.
- **Raise `timeoutSeconds`** on `syncTitles` from `300` → **540** (backoff +
  second pass can push total runtime past the current ceiling at ~122+ titles),
  and **coordinate the workflow's `curl --max-time` and job timeout** so the cron
  does not cut the function off mid-run (see D4 + Data-model/Task graph).
- Per-title failure stays **isolated but RE-ATTEMPTED**, not silently dropped.
  Acceptance: a healthy run writes availability for ~all titles (errored count
  near zero under normal TMDB conditions).

**D3 — Episode-aired fix = a daily AIRING-SCAN pass (NOT an `onDocumentCreated`
trigger, NOT merely reordering the daily passes).** A doc-creation trigger cannot
work: episodes are created **before** they air (Defect 2, last bullet), so `onCreate`
fires with `airDate > now` and no second event ever fires when the episode actually
airs. Reordering the passes is also insufficient because the common case has no
availability change at all. The fix must be driven by the episode **airing**.
Concretely:

- Add a **daily airing-scan pass** in `apps/functions` that runs **right after the
  daily episode-insert pass** inside `runSync` (so it is coupled to the same
  hardened daily run — see the D2 synergy below), **not** a Firestore
  `onDocumentCreated` trigger. The scan enumerates each tracked TV show and its
  already-inserted episodes and emits `episode-aired` for every episode whose
  `airDate` has **crossed into the recent window** and that has **not already been
  notified**. It reuses the per-user decision machinery in
  `libs/functions/dispatch-notifications` (prefs gate, delivery window
  `isWithinDeliveryWindow`, always-write-inbox-then-FCM-if-in-window, token prune)
  and does **not** import `slice:sync-episodes` (it reads episode docs via the Admin
  SDK, mirroring how `dispatch-notifications.ts` reads Firestore).
- **Recent-airing window + idempotency.** An episode is a candidate when its
  `airDate` is within **`EPISODE_RECENCY_WINDOW_DAYS = 3` days** of `now`
  (`now - 3d <= airDate <= now`, inclusive) — this is the pure helper
  `isEpisodeRecentlyAired`. To fire **exactly once** per episode across daily runs
  (the same episode stays in the 3-day window for up to 3 scans), the scan is
  **idempotent on the per-episode notification id**: before writing, it checks
  whether `users/{uid}/notifications/{id}` already exists (id =
  `${tmdbId}-${region}-episode-aired-${episodeId}`); if it exists the episode is
  treated as **already notified** and skipped (no re-write, no re-send). The
  notification doc **is** the per-episode notified marker — no field is added to the
  insert-only episode doc (spec 0047 invariant preserved).
- Rationale for **3 days**: the daily cron inserts/observes a newly-aired episode
  within ~24h, and a 3-day window tolerates one or two missed/delayed runs while
  excluding weeks-old back catalog. The window bounds catch-up.
- **Three cases this design must satisfy (walk-through):**
  1. **First-add back catalog → NO storm.** On a user's first add, the episode pass
     inserts the entire historical back catalog (dozens of episodes, all with
     `airDate` far in the past). The scan filters to `[now-3d, now]`, so **every**
     old episode is outside the window → **not notified**. Only an episode that
     genuinely aired within the last 3 days would notify (at most one or two —
     bounded, see Risks). No storm.
  2. **New weekly episode → notified exactly once.** The episode's doc was created
     earlier with a then-future `airDate`. On the day it airs, its `airDate` now
     falls inside `[now-3d, now]`; the scan sees `exists === false` → writes the
     inbox doc + sends FCM (if in the delivery window). On subsequent daily runs
     within the 3-day window `exists === true` → skipped. Notified **exactly once**
     on/after its air day, even though the doc predates airing.
  3. **Missed-day catch-up.** If the daily run errored for that title one day (its
     scan never ran / never reached this episode), the next day's run still sees the
     episode's `airDate` within `[now-3d, now]` and `exists === false` → notifies.
     The window width is what makes the pass self-healing against a missed run.
- **Per-episode notification id.** The current id `notificationId(tmdbId, region,
kind)` (`dispatcher.ts:78-86`, applied in the adapter at `adapters.ts:117`) has
  **no episode dimension**, so multiple episodes would collide onto one doc. The
  episode path uses a **per-episode id** `${tmdbId}-${region}-episode-aired-${episodeId}`
  (episodeId = the `s{SS}e{EEE}` path segment). To keep both the id derivation and
  the idempotency check in the pure, testable core rather than the adapter, the
  `NotificationStore` port changes to **`write(uid, id, doc)`** plus a new
  **`exists(uid, id): Promise<boolean>`** (the dispatcher computes the id, checks
  existence, then writes with the same id; the adapter uses the id verbatim). This
  is an in-slice + adapter change — **no `scope:shared` change** (F2 clear; see D6).
- **Single-owner `episode-aired` (supersedes spec 0012 decision 1B).** The
  availability-triggered path **stops emitting `episode-aired`**: `decideKinds`
  drops its episode branch (and the availability `dispatchForUser` drops the now-
  dead `episodes.getEpisodes` read). `episode-aired` is owned **exclusively** by the
  new airing-scan, with the per-episode id. This eliminates both the double-notify
  risk and the id collision, and removes the structural half-measure. **No coverage
  gap and no double-fire:** the scan covers every aired episode of every tracked
  on-flatrate show daily, and it is the only emitter — nothing else fires
  `episode-aired`. The availability path keeps `movie-available` /
  `show-came-to-platform` unchanged: a show newly on flatrate still fires
  `show-came-to-platform`, and future new episodes fire `episode-aired` via the
  scan.
- **Honor existing suppression rules — self-implemented on the episode path.** The
  scan MUST respect the spec 0088 `completed`/`dropped` suppression (no
  notifications once the user is done with a title) and the spec 0051 delivery-window
  gate. Because spec 0088 (which adds the status gate to the **availability** path)
  is not yet merged (see the Dependencies note below), the episode path does **not**
  rely on 0088's change — it **self-implements** the status gate by reading the
  watchlist doc's `status` into `EpisodeAiredChange.status` and suppressing
  `completed`/`dropped` in `dispatchEpisodeAired`, independent of the availability
  path. Note spec 0074 reverts a `completed` TV show back to `watching` when a new
  episode is inserted (`episode-sync-engine.ts:62-69`); because the scan runs as a
  **strictly later pass** than the episode-insert pass, that revert write has
  already committed before the scan reads status, so the scan **deterministically**
  sees `watching` — it reads the status fresh at emit time rather than assuming an
  ordering the same-pass code would not give (the blanket 0088 gate remains
  defense-in-depth). See NB2 in the Risks section.
- **D2 synergy.** Because the scan runs inside the same daily `runSync` as the
  availability + episode-insert passes, its reliability is exactly what Defect 1
  (D2) hardens: a nightly run that no longer errors a large fraction of titles is
  also the run whose airing-scan reaches every episode. The two fixes reinforce each
  other.

**D4 — Error-rate visibility (user opted in).** Surface per-title error detail from
`syncTitles` (today only aggregate counts are logged / returned) and make the daily
workflow **fail the job when the error rate exceeds a threshold**, so a half-failing
nightly run is never invisible again:

- `runSync` logs each errored title's `reason` (already credential-free) via
  `logger.error`, and the `SyncRunResponse` gains an **`errorSample: string[]`**.
  **Reuse the exact `errors` array already built at `main.ts:259-263`** (the
  per-title reasons, already `.filter`ed to non-empty and `.slice(0, 10)`-capped,
  and already written verbatim to the `sync-runs` doc) — set
  `errorSample = errors` so the 200 response and the `sync-runs` doc carry
  **identical** content and no new credential-exposure surface is introduced. Do
  **not** build a second, differently-shaped list from raw error objects.
- **Update the invariant comment at `main.ts:91-92`.** Today it reads "Never
  includes a secret, token, or **raw per-title reason** — aggregate counts only."
  With `errorSample` the response now carries the **same capped, credential-free
  per-title reasons the `sync-runs` doc already stores**; reword the comment to say
  the response never includes a secret/token and that `errorSample` is exactly the
  capped, credential-free reason list mirrored from the `sync-runs` doc — so the
  invariant (no credential leak) is preserved and the comment no longer contradicts
  the field.
- `daily-sync.yml` parses the 200 JSON body (jq is available on
  `ubuntu-latest`) and **fails the job (exit 1)** when
  `errored * 100 / gathered >= 20` (≥20% error rate) **or** `errored >= 20`
  absolute; emits `::warning::` when `errored > 0` but under threshold. Threshold
  rationale: a healthy run after D2 should have errored ≈ 0; 20% is well above
  normal noise but far below the observed ~47% failure, so a regression is loud
  without flapping on one transient error.

**D5 — Backfill is OUT OF SCOPE.** Do NOT replay missed transitions — that risks a
notification storm. The system self-heals going forward once D2 lands (the next
healthy nightly run writes the availability docs, and future new episodes fire via
the daily airing-scan). Stated in Non-goals + Risks.

**D6 — No `scope:shared` change; no `User` field change.** `NotificationKind`
already contains `episode-aired` (`enums.ts:48-53`); `NotificationPrefs`
(`documents.ts:15-23`) already has `episodeAired` + `deliveryHour`; `WatchStatus`
already exists. No new domain type or field. The per-episode id and second-pass
retry are internal (F2 clear). **No `User` domain field is added or changed, so the
F4 onboarding-parity probe does NOT apply** — stated explicitly (silence would be a
blocking finding).

**D7 — No `firestore.rules` / `firestore.indexes.json` change (verify-and-record).**
The airing-scan runs as the Admin SDK (bypasses rules) and reads/writes only paths
already covered by the recursive `users/{userId}/{document=**}` owner rule and the
`title-cache` read (`firestore.rules:33-52`). Its enumeration reuses the **existing
unindexed** `collectionGroup('watchlist').get()` scan pattern (the same one
`findUsersTracking` already uses, `adapters.ts:36`) with an in-memory `type==='tv'`
filter, then a **direct subcollection `.get()`** of each show's `episodes` (no
`where`/`orderBy`), and **direct doc gets** for the user doc, the
`title-cache/{tmdbId}/availability/{region}` doc, and the notification-existence
check — so it adds **no** new query shape and **no** composite/collection-group
index. `firestore.indexes.json` stays `{ "indexes": [], "fieldOverrides": [] }`.
Record "no change needed."

**D8 — Cloud Functions deploy gate applies.** Both `apps/functions` and two
`scope:functions` libs change, so the DoD includes `pnpm nx run
functions:deploy-preflight` (a CI gate), and shipping is the separate manual
`/deploy-functions` step — do NOT deploy from the spec/implement flow.

**D9 — No new UI / Stitch screen.** Backend-only.

## Scope

**In scope:**

- **`slice:sync-titles`** (Defect 1 / D2): exponential-backoff-with-jitter floor
  and a higher retry budget in `shared/http.ts`; a second-pass retry option in the
  sync engine; skip `getShowTraktId` when a cached `traktId` exists; raise the
  `syncTitles` `timeoutSeconds` to 540; unit tests; README.
- **`slice:dispatch-notifications`** (Defect 2 / D3): a new pure recency-window
  helper and per-episode-id logic; a new `dispatchEpisodeAired` path on the
  dispatcher factory that reuses the prefs/window/inbox/FCM/prune machinery, is
  **idempotent on the per-episode id** (via a new `NotificationStore.exists`), and
  self-implements the 0088 completed/dropped gate + honors 0051; drop
  `episode-aired` from `decideKinds` + the availability `dispatchForUser` episode
  read; change `NotificationStore.write` to `(uid, id, doc)` and add
  `exists(uid, id)`; unit tests; README.
- **`apps/functions`**: the new **daily airing-scan** (`runEpisodeAiredScan`) + its
  Admin-SDK reads (enumerate tracked TV shows via `collectionGroup('watchlist')`;
  per show read the `episodes` subcollection, the watchlist doc's
  tmdbId/type/status/title, the user doc → region/prefs/tokens, and the title-cache
  availability → hasFlatrate) and reuse of the FCM/notification/watchlist adapters;
  wire the scan **into `runSync` right after the episode-insert pass** (not a new
  deployed function); implement the new `NotificationStore.exists` + `(uid,id,doc)`
  write adapters; wire the engine's second-pass retry config; drop the now-dead
  `createFirestoreEpisodeStore` wiring from the availability path; add `errorSample`
  to `SyncRunResponse` (reusing the capped `errors` array) + per-title error logging
  in `runSync`; unit tests.
- **`.github/workflows/daily-sync.yml`** (D4): parse the response, fail the job on
  a high error rate, warn otherwise; align `curl --max-time` / job timeout with the
  new 540s function ceiling.

**Out of scope:**

- **Backfill / replay of missed transitions** (D5) — self-heals going forward.
- **A Cloud Tasks / Pub-Sub fan-out** (D2) — deliberately an in-place hardening.
- **Any `scope:shared` type/field change** (D6) — no new domain type or field; no
  `User`-field/onboarding change (F4 N/A).
- **Any `scope:mobile` change** (D1) — backend-only; the app-side rendering /
  deep-link handling is unchanged (specs 0041/0042).
- **`firestore.rules`, `firestore.indexes.json`, `sheriff.config.ts`** — no change
  (D7; no new lib, no new query, Admin-SDK reads) — verify-and-record.
- **New UI / Stitch screen** (D9).
- **A new e2e flow** — backend/Cloud-Function change with no new mobile page/route/
  action (see Test plan).

## Affected slices & Sheriff tags

| Project                          | Path                                    | Sheriff tags                                      | Change                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| functions-sync-titles            | `libs/functions/sync-titles`            | `scope:functions`, `slice:sync-titles`            | Backoff floor + retry budget in `http.ts`; second-pass retry option in the engine; cached-`traktId` dedup; tests; README                                                                |
| functions-dispatch-notifications | `libs/functions/dispatch-notifications` | `scope:functions`, `slice:dispatch-notifications` | Recency-window helper; per-episode id; `dispatchEpisodeAired` (idempotent via `exists`); drop `episode-aired` from `decideKinds`; `write(uid,id,doc)` + `exists(uid,id)`; tests; README |
| functions (app)                  | `apps/functions`                        | `scope:functions`                                 | New daily airing-scan (`runEpisodeAiredScan`) wired into `runSync` + Admin-SDK reads/`exists`/`write`; wire engine retry config; `errorSample` + per-title logging; tests               |
| root / infra                     | `.github/workflows/daily-sync.yml`      | (no slice)                                        | Parse response, fail on high error rate, align timeouts (D4)                                                                                                                            |

- **No cross-scope / cross-slice import.** `slice:sync-titles` continues to import
  only `@vultus/shared/*`. `slice:dispatch-notifications` continues to import only
  `@vultus/shared/*` (no new edge — recency logic + per-episode id are self-
  contained). The new airing-scan lives in `apps/functions` and imports
  `@vultus/functions/dispatch-notifications` + `@vultus/shared/*` + Firebase
  (Sheriff rule 3); it does **not** import `slice:sync-episodes` (it reads episode
  docs directly via the Admin SDK, mirroring how `dispatch-notifications.ts` reads
  the availability doc). No `scope:mobile ↔ scope:functions` edge.
- **No `shared/` extraction.** No logic is duplicated across 3+ slices. The
  episode-aired dispatch reuses the **existing** dispatch-notifications lib rather
  than being hoisted anywhere.
- **No new lib, no `sheriff.config.ts` change.** All three code projects already
  exist and are tagged by the existing path globs. Record "no `sheriff.config.ts`
  change needed."

## Data model touchpoints

PLAN §4 paths. **No new field, no new collection, no converter change, no
`scope:shared` change** (D6).

| PLAN §4 path                                                       | Access                                          | By                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title-cache/{tmdbId}`                                             | **read** (`traktId`, `type`, `metadata.title`)  | sync engine (`store.getEntry` — cached-traktId dedup, D2)                                                                                                                                                                                                                                                                                                                                                                                        |
| `title-cache/{tmdbId}/availability/{region}`                       | **read** + **write** (unchanged) + **new read** | engine `putAvailability` (Defect 1 fix restores the write); airing-scan **reads** it for `hasFlatrate` in the user's region                                                                                                                                                                                                                                                                                                                      |
| `users/{uid}/watchlist` (via `collectionGroup('watchlist').get()`) | **read** (enumeration)                          | airing-scan enumerates tracked shows — same existing unindexed collection-group scan as `findUsersTracking`                                                                                                                                                                                                                                                                                                                                      |
| `users/{uid}/watchlist/{titleId}`                                  | **read** (`tmdbId`, `type`, `status`, `title`)  | airing-scan — the title's tmdbId/type, the 0088 status gate, and `title` for the FCM body (NB4)                                                                                                                                                                                                                                                                                                                                                  |
| `users/{uid}/watchlist/{titleId}/episodes`                         | **read** (subcollection `.get()`)               | airing-scan reads each show's episode docs (`season`/`episode`/`airDate`; id = `s{SS}e{EEE}` doc id). **`airDate` is stored as a Firestore `Timestamp`** (`episodeToData`, `converters.ts:135` writes `new Date(...)`), so the scan **converts it to an ISO string via `dataToEpisode` (`converters.ts:145`, `.toDate().toISOString()`) before** the `isEpisodeRecentlyAired` comparison, then filters `airDate ∈ [now-3d, now]` in memory (NB5) |
| `users/{uid}`                                                      | **read** + **update** (prune only)              | region + `notificationPrefs` + `fcmTokens`; update only to delete a stale token (spec 0012 decision 4)                                                                                                                                                                                                                                                                                                                                           |
| `users/{uid}/notifications/{notificationId}`                       | **read (exists)** + **create/merge**            | airing-scan `exists`-checks the id then writes one doc per new episode, id `${tmdbId}-${region}-episode-aired-${episodeId}` (per-episode idempotency, D3)                                                                                                                                                                                                                                                                                        |
| `sync-runs/{runId}`                                                | **write** (unchanged shape)                     | best-effort observability record — unchanged (`errors` array already capped, credential-free)                                                                                                                                                                                                                                                                                                                                                    |

- **No `firestore.rules` change — VERIFY and RECORD (D7).** All reads/writes are
  Admin-SDK (rules-exempt); every path is already covered by the recursive
  `users/{userId}/{document=**}` owner rule and the `title-cache` read rule. The
  airing-scan writes only `users/{uid}/notifications/**` and prunes only
  `users/{uid}.fcmTokens`.
- **No `firestore.indexes.json` change — VERIFY and RECORD (D7).** The airing-scan
  reuses the **existing unindexed** `collectionGroup('watchlist').get()` scan (with
  an in-memory `type==='tv'` filter) plus **direct subcollection/doc gets** (episodes
  subcollection, watchlist doc, user doc, title-cache availability doc, notification
  existence check) — no `where`/`orderBy`, so no composite/collection-group index.
  `firestore.indexes.json` stays empty.

## Public types / APIs

No HTTP endpoint or callable is added. No `scope:shared` type change (D6).

### `slice:sync-titles` — engine retry config (additive, in-slice)

`libs/functions/sync-titles/src/lib/engine/types.ts` — add optional retry fields to
`SyncEngineConfig` (defaults preserve current behavior, so existing tests/callers
are unaffected):

```ts
export interface SyncEngineConfig {
  tmdb: TmdbClient;
  trakt: TraktClient;
  store: TitleCacheStore;
  now?: () => string;
  /** Extra passes re-running only titles whose outcome was 'error' with a
   *  retryable errorStatus (429 or 0 transport). Default 0 (current behavior). */
  retryErroredPasses?: number;
  /** Cooldown before each retry pass, ms. Default 0. Injectable for tests. */
  retryDelayMs?: number;
}
```

`sync()` runs the initial pass, then up to `retryErroredPasses` additional passes
over the retryable-errored subset, sleeping `retryDelayMs` between passes, and
returns one merged `SyncResult` per input title (a later pass's `synced`/`skipped`
supersedes an earlier `error`). Non-retryable errors (e.g. 401) are not re-tried.

`shared/http.ts` (internal, not barrel-exported) — `HttpCoreConfig` gains a
`backoffBaseMs?: number` (default e.g. 500) used to compute the exponential floor;
`maxRetries` default raised to 5 in `tmdb-client.ts` / `trakt-client.ts`.

### `slice:dispatch-notifications` — recency window, per-episode id, episode dispatch

`src/lib/transitions.ts` — add a pure helper (drop the `episode-aired` branch from
`decideKinds`, D3):

```ts
/** True when `airDate` is within [now - windowDays, now] (inclusive). ISO 8601
 *  lexical/temporal comparison; guards the back-catalog storm on first add. */
export function isEpisodeRecentlyAired(
  airDate: string,
  now: string,
  windowDays: number,
): boolean;
```

`src/lib/dispatcher.ts` — id derivation moves into the core; add the episode path:

```ts
export const EPISODE_RECENCY_WINDOW_DAYS = 3;

/** One newly-created episode to consider for an episode-aired notification. */
export interface EpisodeAiredChange {
  tmdbId: number;
  region: Region; // the owner user's region
  uid: string;
  titleId: string;
  status: WatchStatus; // for the 0088 completed/dropped gate
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  episodeId: string; // the s{SS}e{EEE} path segment (per-episode id dimension)
  airDate: string; // ISO 8601
  hasFlatrateNow: boolean; // from title-cache availability in `region`
}

export interface NotificationDispatcher {
  dispatch(change: AvailabilityChange): Promise<DispatchSummary>;
  /** Dispatch an episode-aired notification for one user/episode (spec 0089).
   *  No-op (returns notified:false) when: status is completed/dropped (self-
   *  implemented 0088 gate), prefs.episodeAired is false, not on flatrate, airDate
   *  is outside the recency window, OR the per-episode notification id already
   *  exists (already notified — the daily scan re-sees an episode for up to 3 days).
   *  When it DOES notify: the inbox doc is written and FCM is sent only within the
   *  delivery window (0051); stale tokens pruned. Idempotent on the per-episode id
   *  via `NotificationStore.exists`. */
  dispatchEpisodeAired(
    change: EpisodeAiredChange,
  ): Promise<{ notified: boolean; fcmSent: number; staleTokensPruned: number }>;
}
```

Gate order in `dispatchEpisodeAired`: status (completed/dropped → no-op) → prefs
(`episodeAired` off → no-op) → recency window (`isEpisodeRecentlyAired` false →
no-op) → flatrate (`hasFlatrateNow` false → no-op) → **idempotency
(`notifications.exists(uid, id)` true → no-op)** → write inbox with the per-episode
id → FCM within delivery window → prune stale tokens.

`src/lib/ports.ts` — `NotificationStore.write` gains an explicit `id` (so the
core, not the adapter, owns id derivation for both paths), plus an `exists` read for
per-episode idempotency:

```ts
export interface NotificationStore {
  /** Create/merge users/{uid}/notifications/{id}. */
  write(uid: string, id: string, doc: NotificationDoc): Promise<void>;
  /** True when users/{uid}/notifications/{id} already exists. Used by the
   *  episode-aired path so the daily airing-scan notifies each episode exactly
   *  once even though the episode stays in the recency window for several runs. */
  exists(uid: string, id: string): Promise<boolean>;
}
```

The availability path passes `${tmdbId}-${region}-${kind}` (unchanged value); the
episode path passes `${tmdbId}-${region}-episode-aired-${episodeId}`. The
`EpisodeStore` port + `createFirestoreEpisodeStore` become **dead** once the
availability path drops its episode read — remove them from the barrel/adapters (or
leave `EpisodeStore` unexported if an implementer prefers minimal churn; the binding
requirement is that the availability path no longer emits `episode-aired`). The
availability path does **not** need `exists` (its re-fire idempotency is the
existing merge-on-same-id behavior, unchanged); only `dispatchEpisodeAired` calls
`exists`.

### `apps/functions` — the airing-scan + response field

- `apps/functions/src/dispatch-episode-aired.ts` — an SDK-free
  `runEpisodeAiredScan(db, messaging, now?)` core (injected `db`/`messaging`,
  mirroring `dispatch-notifications.ts`) that:
  1. enumerates tracked TV shows via `db.collectionGroup('watchlist').get()` with an
     in-memory `type==='tv'` filter (uid/titleId/tmdbId/status/title per doc — the
     same scan `findUsersTracking` already uses);
  2. for each show reads its `episodes` subcollection, **converts each doc's
     stored `airDate` `Timestamp` → ISO string via `dataToEpisode`** (or
     `.toDate().toISOString()`) — **following the 0081 pattern in
     `createNextWatchableStoreAdapter`, `sync-episodes.ts:164-169`, and
     explicitly NOT the removed `createFirestoreEpisodeStore` raw `data.airDate`
     read (`adapters.ts:92-99`), which treated a `Timestamp` as a `string`** —
     then filters episodes to `airDate ∈ [now-3d, now]` (`isEpisodeRecentlyAired`,
     which takes an ISO `string`), so back catalog is dropped before any
     per-episode work;
  3. reads the user doc (region/prefs/tokens; **cached per uid** across shows) and
     the `title-cache/{tmdbId}/availability/{region}` doc (hasFlatrate; **cached per
     (tmdbId,region)**);
  4. builds an `EpisodeAiredChange` per candidate episode (including the watchlist
     doc's `title` for the FCM body, NB4) and calls `dispatchEpisodeAired`, which
     applies the status/prefs/recency/flatrate/idempotency gates.

  It reuses `createMessagingFcmSender(messaging, titleStr)` /
  `createFirestoreNotificationStore` (now with `write(uid,id,doc)` + `exists`) /
  `createFirestoreWatchlistStore` (for `removeFcmToken`) from
  `dispatch/adapters.ts`. **`createMessagingFcmSender` binds a SINGLE `titleStr` at
  construction (`adapters.ts:174-177`, consumed by `buildNotification` for the OS
  body `${titleStr} has a new episode on …`, `adapters.ts:152-156`), so the sender
  (and therefore the dispatcher that wraps it) MUST be constructed PER-TITLE** from
  the current watchlist doc's `title` (NB4) — reusing a single sender across the
  many titles the scan processes would render every episode's OS body except one
  with the wrong show name. (The FCM `data` record carries `titleId`/`tmdbId` but
  not the display name, so the wrong-body bug is invisible to any `data`-only
  assertion — see the Test plan.) The FCM `data` record for this path additionally carries
  `episodeId` (a plain string field; no shared-type change) for the app's deep-link.
  **Not a new deployed Cloud Function** — it is invoked from `runSync` (below), so
  there is **no new `onDocumentCreated`/export/registration** in `main.ts`.

- `apps/functions/src/main.ts` / `runSync` — **invoke `runEpisodeAiredScan` right
  after the episode-insert pass** (`main.ts:230-251`), guarded like the episode pass
  by an injected dep (e.g. `deps.runEpisodeAiredScan?`), best-effort (a scan failure
  is logged and never fails the run, mirroring the episode pass's try/catch); wire
  `retryErroredPasses` / `retryDelayMs` into the `createEngine` used by `syncTitles`
  (and leave `triggerSync`'s engine unchanged — manual path never rate-limits); raise
  `timeoutSeconds` 300 → 540; add `errorSample: string[]` to `SyncRunResponse` (set
  to the existing capped `errors` array, NB1) and `logger.error` per errored title.
  Because the scan runs strictly after the insert pass (including spec 0074's
  `completed→watching` revert write), it reads `status` after that write commits (NB2).

## UI / Stitch screen refs

**No new Stitch screen and no visual element** (D9). This is a backend-only Cloud
Functions change (rate-limit hardening + a new Firestore trigger + a workflow
observability change). No mobile page, route, component, or design token is touched;
the app-side FCM rendering/deep-link handling (specs 0041/0042) is unchanged. Record
"no new UI element — backend Cloud-Function change only; no Stitch capture required"
in the PR.

## Implementation task graph

Tasks 1 and 2 are **independent slices** with disjoint file manifests and run in
parallel; task 3 (`apps/functions`) depends on both (it imports the changed
dispatch-notifications surface and wires the engine's new retry config); task 4
(workflow) depends on task 3's response shape.

1. **[parallel] `slice:sync-titles` rate-limit hardening + retry (Defect 1 / D2).**
   backend-engineer.
   - `shared/http.ts`: add exponential-backoff-with-jitter floor on 429
     (`max(Retry-After, backoffBaseMs * 2^attempt + jitter)`, still capped by
     `MAX_RETRY_AFTER_MS`); add `backoffBaseMs` to `HttpCoreConfig`.
   - `tmdb-client.ts` / `trakt-client.ts`: raise `DEFAULT_MAX_RETRIES` 3 → 5; pass
     `backoffBaseMs`.
   - `engine/types.ts`: add `retryErroredPasses` / `retryDelayMs` to
     `SyncEngineConfig`.
   - `engine/sync-engine.ts`: implement the second-pass retry over retryable-errored
     titles (merge best per-title outcome); skip `trakt.getShowTraktId` when
     `store.getEntry(tmdbId)?.traktId` is non-null (cached-traktId dedup) and reuse
     the cached value.
   - Update `libs/functions/sync-titles/README.md` for the new engine config +
     backoff/retry behavior.
   - Tests: `http.spec.ts` (backoff floor when no `Retry-After`, honors
     `Retry-After` when present, budget = 5); `sync-engine.spec.ts` (second-pass
     retry succeeds a title that 429'd on pass 1; non-retryable error not re-tried;
     cached-traktId path skips the Trakt call).
   - **Manifest:** `libs/functions/sync-titles/**`

2. **[parallel] `slice:dispatch-notifications` episode-aired path (Defect 2 / D3).**
   backend-engineer.
   - `transitions.ts`: add `isEpisodeRecentlyAired`; **remove** the `episode-aired`
     branch from `decideKinds`.
   - `ports.ts`: change `NotificationStore.write` to `(uid, id, doc)`; **add
     `NotificationStore.exists(uid, id)`**; remove the now-dead
     `EpisodeStore`/`TrackedEpisode` (or leave unexported).
   - `dispatcher.ts`: move id derivation into the core (availability id unchanged
     value); drop the `episodes.getEpisodes` read + episode branch from
     `dispatchForUser` (and the `episodes: EpisodeStore` from `DispatcherConfig`);
     add `EPISODE_RECENCY_WINDOW_DAYS`, `EpisodeAiredChange`, and
     `dispatchEpisodeAired` (status → prefs → recency window → hasFlatrate →
     **exists idempotency** → inbox write with per-episode id → FCM within delivery
     window → prune).
   - `index.ts`: export the new surface; drop dead exports.
   - Update `libs/functions/dispatch-notifications/README.md` (single-owner
     episode-aired via the airing-scan path, recency window, per-episode id +
     `exists` idempotency, `write(uid,id,doc)`).
   - Tests: `transitions.spec.ts` (recency window in/out incl. the 3 B1 cases;
     `decideKinds` no longer returns `episode-aired`); `dispatcher.spec.ts`
     (`dispatchEpisodeAired`: completed/dropped suppressed, prefs off suppressed,
     outside recency suppressed, not-on-flatrate suppressed, **already-exists
     suppressed (idempotent)**, happy path writes inbox + sends FCM in-window,
     outside delivery window writes inbox but no FCM, stale-token prune, per-episode
     id, two episodes → two distinct ids).
   - **Manifest:** `libs/functions/dispatch-notifications/**`

3. **[sequential] `apps/functions` wiring (airing-scan + engine retry + D4
   response). Depends on tasks 1 & 2.** backend-engineer.
   - `apps/functions/src/dispatch-episode-aired.ts`: the `runEpisodeAiredScan(db,
messaging, now?)` core — enumerate tracked TV shows via
     `collectionGroup('watchlist')`, per show read the `episodes` subcollection,
     **convert each stored `airDate` `Timestamp` → ISO string via `dataToEpisode`
     (following `sync-episodes.ts:164-169`, NOT the removed raw
     `createFirestoreEpisodeStore` read)** and filter to `[now-3d, now]`, read
     (cached) user + title-cache availability docs, build `EpisodeAiredChange` (with
     the watchlist `title` for the FCM body), **construct the FCM sender/dispatcher
     PER-TITLE via `createMessagingFcmSender(messaging, <watchlist title>)`** (so
     each episode's OS body carries its own show name), call `dispatchEpisodeAired`,
     add `episodeId` to the FCM `data`. **No new deployed function / export.**
   - `apps/functions/src/dispatch/adapters.ts`: update
     `createFirestoreNotificationStore.write` to `(uid, id, doc)` and add its
     `exists(uid, id)` (a doc `.get()` returning `snap.exists`); remove the dead
     `createFirestoreEpisodeStore` if the port was removed.
   - `apps/functions/src/dispatch-notifications.ts`: drop the now-unused
     `createFirestoreEpisodeStore` wiring / `episodes` config field.
   - `apps/functions/src/main.ts`: **invoke `runEpisodeAiredScan` in `runSync` right
     after the episode-insert pass** (best-effort try/catch), injected via a
     `deps.runEpisodeAiredScan?` (wired for `syncTitles`, not `triggerSync`); wire
     `retryErroredPasses`/`retryDelayMs` into the `syncTitles` `createEngine`; raise
     `timeoutSeconds` 300 → 540; add `errorSample` to `SyncRunResponse` (set to the
     capped `errors` array, NB1) + `logger.error` per errored title + update the
     invariant comment at `main.ts:91-92`.
   - Tests: `dispatch-episode-aired.spec.ts` (fake `db`/`messaging`: happy path
     writes only `users/**/notifications/**` + token prune, no `title-cache`/
     `sync-runs`/`system` write; no-op on completed/out-of-window/out-of-recency/
     already-exists; first-add back catalog → nothing; per-episode id; FCM `data`
     carries `episodeId`); extend `main.spec.ts` for `errorSample` + the retry-config
     wiring + the scan being invoked after the episode pass; keep
     `dispatch-notifications.spec.ts` green with the `(uid,id,doc)` write.
   - **Manifest:** `apps/functions/**`

4. **[sequential] `daily-sync.yml` error-rate gate + timeout alignment (D4). Depends
   on task 3.** infrastructure-engineer.
   - Parse the 200 JSON body with `jq` (present on `ubuntu-latest`); fail the job
     (exit 1) when `errored*100/gathered >= 20` or `errored >= 20`; `::warning::`
     when `errored > 0` under threshold; print `errorSample`.
   - Raise `curl --max-time` 330 → 550 and the step/job timeouts to sit above the
     new 540s function ceiling.
   - **Manifest:** `.github/workflows/daily-sync.yml`

(All parallel manifests are pairwise disjoint: `libs/functions/sync-titles/**` vs
`libs/functions/dispatch-notifications/**`. `firebase-admin`/`firebase-functions`
are already root deps — no new runtime dependency.)

## Test plan

Per the PLAN §5 pyramid — backend logic, so the surface is **unit tests** with
fakes/mocks (Vitest). No live Firebase, no emulator, no live FCM, no network, no
secrets. Emulator-dependent verification of the actual triggers runs in CI, not
in-session (PLAN emulator note / project memory).

**`slice:sync-titles` (`http.spec.ts`, `sync-engine.spec.ts`):**

- 429 with **no** `Retry-After` → waits the exponential-backoff floor (assert the
  injected sleep is called with a growing value), then succeeds; budget is 5.
- 429 **with** `Retry-After` → still honors the header (max of header vs floor).
- Second-pass retry: a title that 429s on pass 1 but succeeds on the retry pass
  ends with `outcome: 'synced'` and its availability write happens; a non-retryable
  (401) error is **not** re-tried; `retryErroredPasses: 0` reproduces current
  behavior.
- Cached-traktId dedup: a tv title whose stored entry has `traktId != null` does
  **not** call `trakt.getShowTraktId` and reuses the cached value; a null cached
  traktId still calls it.

**`slice:dispatch-notifications` (`transitions.spec.ts`, `dispatcher.spec.ts`):**

- `isEpisodeRecentlyAired(airDate, now, 3)` — pin the exact inclusive `[now-3d, now]`
  semantics with concrete cases: an airDate **1 day before** `now` → **true**;
  **exactly at `now-3d`** (lower boundary) → **true**; **exactly at `now`** (upper
  boundary) → **true**; **5 days before** `now` (before the window) → **false**; a
  **future** airDate (`> now`, above the window) → **false**. (`mapSeasonEpisodes`
  drops null/empty air dates, so the helper never receives null in practice — no
  null case is asserted.)
- **Three B1 cases (airing-scan behavior, asserted via the helper + scan/dispatcher
  tests):** (a) **first-add back catalog** — a set of episodes all aired weeks ago
  are **all** outside `[now-3d, now]` → none notified (no storm); (b) **new weekly
  episode** — an episode aired today (doc created earlier) is inside the window and
  `exists === false` → notified once, and a second run with `exists === true` →
  **not** re-notified; (c) **missed-day catch-up** — an episode aired yesterday with
  `exists === false` → notified (window catches it up).
- `decideKinds` no longer returns `episode-aired` in any branch (regression); still
  returns `movie-available` / `show-came-to-platform` on `appeared`.
- `dispatchEpisodeAired`: **suppressed** for `status: 'completed'` and `'dropped'`
  (self-implemented 0088 gate), for `prefs.episodeAired: false`, for
  `hasFlatrateNow: false`, for an airDate outside the recency window, and for an id
  that **already exists** (`notifications.exists` true → idempotent no-op) — each →
  `notified: false`, no write, no send. **Happy path** (watching/planned, prefs on,
  on flatrate, recent, not-yet-notified) writes exactly one inbox doc with id
  `${tmdbId}-${region}-episode-aired-${episodeId}` and sends FCM to each token when
  within the delivery window; **outside the delivery window** (0051) writes the inbox
  doc but sends **no** FCM. Two distinct episodes → two distinct ids. A stale token
  reported unregistered is pruned exactly once.
- Availability path regression: `dispatch()` no longer reads episodes and no longer
  writes `episode-aired`; `movie-available` / `show-came-to-platform` still fire;
  the `write(uid, id, doc)` id equals `${tmdbId}-${region}-${kind}`.
- **Rendered-text (F3):** any test asserting on a notification `data`/body string
  asserts the **exact** string (no whitespace normalization) — e.g. the episode FCM
  `data.kind === 'episode-aired'` and `data.episodeId` exact.

**`apps/functions` (`dispatch-episode-aired.spec.ts`, `main.spec.ts`,
`dispatch-notifications.spec.ts`):**

- `runEpisodeAiredScan` with a fake `db`/`messaging`: enumerates tracked TV shows,
  reads episodes/user/availability docs, dispatches, and the only writes recorded are
  `users/**/notifications/**` creates + the `fcmTokens` prune — **no** `title-cache`/
  `sync-runs`/`system` write; a `tv` no-op when not on flatrate / completed / outside
  recency / already-notified (`exists` true); a **first-add back-catalog** show
  (episodes all aired weeks ago) writes **nothing**; the FCM `data` carries
  `episodeId`.
- **Timestamp → ISO conversion boundary (BLOCKING fix):** the fake episode docs
  return `airDate` as a **`Timestamp`-shaped object** (an object exposing
  `.toDate()` that returns a `Date`), **not** a bare ISO string, so the test
  actually exercises the `dataToEpisode` / `.toDate().toISOString()` conversion
  before `isEpisodeRecentlyAired`. A recent-airing episode whose `airDate` is a
  `Timestamp` in `[now-3d, now]` must be notified (proving the conversion happened);
  a bare-string fake is explicitly disallowed here because it would let a prod
  Timestamp-vs-string mismatch pass silently.
- **Per-title FCM body (NB4):** with **two different shows** both having a recent
  episode, assert the two resulting FCM `notification.body` strings are
  **different** and each contains its own show's `title` (exact-string match, no
  whitespace normalization) — this catches a single-`titleStr` sender reused across
  titles, which the `data`-only assertions cannot. (Requires a fake `messaging.send`
  that captures the `notification` block, not just `data`.)
- `main.spec.ts`: `SyncRunResponse` now includes `errorSample` (credential-free,
  capped — the same `errors` array, NB1); the `syncTitles` engine is built with
  `retryErroredPasses`/`retryDelayMs`; `runEpisodeAiredScan` is invoked after the
  episode-insert pass (and a scan failure is best-effort — does not fail the run);
  existing 0009 assertions still pass.
- `dispatch-notifications.spec.ts`: the availability handler still works with the
  `(uid, id, doc)` write and no episode read.

**Component tests:** none (no UI). Stated explicitly.

**e2e (Playwright): none required — backend/Cloud-Function change only.** Per the
e2e rubric this `scope:functions` change adds no new mobile page, route, or critical
UI action, and the availability trigger + the daily sync run (which now hosts the
airing-scan) are emulator-dependent (run in CI, not locally). Stated explicitly rather
than omitted. The existing e2e suite is unchanged and stays green.

## Definition of done

Tailored from the PLAN §5 checklist. Every checkbox maps to a task above. No
component/e2e (no UI).

- [ ] `pnpm nx affected -t lint typecheck test build --base=main` green — affected
      set is `functions-sync-titles`, `functions-dispatch-notifications`, `functions`
      and dependents. (Tasks 1–3)
- [ ] **Sheriff clean** in the lint above: `slice:sync-titles` and
      `slice:dispatch-notifications` import only `@vultus/shared/*`; the new
      airing-scan imports `@vultus/functions/dispatch-notifications` +
      `@vultus/shared/*` + Firebase and **not** `slice:sync-episodes` or any
      `scope:mobile`; both libs stay Firebase-free. (Tasks 1–3)
- [ ] `pnpm nx run functions:deploy-preflight` green (D8 — CI gate for the
      `apps/functions` + `scope:functions` lib changes). Deploy is the separate
      manual `/deploy-functions` step — NOT run from the implement flow. (Task 3)
- [ ] **Defect 1 unit coverage** (Task 1): backoff floor on 429 with no
      `Retry-After`, `Retry-After` still honored, retry budget = 5, second-pass
      retry recovers a transient-429 title, non-retryable not re-tried, cached-
      traktId skips the Trakt call.
- [ ] **Defect 2 unit coverage** (Tasks 2–3): recency-window helper (incl. boundaries + the 3 B1 cases: first-add back catalog / new weekly / missed-day catch-up);
      `decideKinds` no longer emits `episode-aired`; `dispatchEpisodeAired` suppression
      matrix (completed/dropped, prefs off, not-on-flatrate, out-of-recency,
      already-exists) + happy path + out-of-delivery-window inbox-only + per-episode id + stale-token prune; `runEpisodeAiredScan` enumerates + writes only
      `users/**/notifications/**` (+ token prune), no-op on back-catalog/already-
      notified, FCM `data` carries `episodeId`, **converts a `Timestamp`-shaped
      `airDate` → ISO before the recency comparison (test fake returns a `.toDate()`
      object, NB5)**, and **two different shows yield two distinct FCM
      `notification.body` strings** (per-title sender, NB4).
- [ ] **D4 (NB1):** `SyncRunResponse.errorSample` present, set to the **existing
      capped, credential-free `errors` array** (`main.ts:259-263`) so response and
      `sync-runs` doc are identical, with the `main.ts:91-92` invariant comment updated;
      per-title `logger.error`; `daily-sync.yml` fails the job on `errored*100/
gathered >= 20` or `errored >= 20`, warns otherwise, and its `curl --max-time`
      / timeouts sit above the new 540s function ceiling. (Tasks 3–4)
- [ ] `syncTitles` `timeoutSeconds` raised to 540; `triggerSync` engine wiring
      unchanged. (Task 3)
- [ ] **READMEs updated** (CLAUDE.md lib-README rule): `libs/functions/sync-titles/
README.md` (backoff/retry/engine config) and `libs/functions/dispatch-
notifications/README.md` (single-owner episode-aired via the airing-scan,
      recency window, per-episode id + `exists` idempotency, `write(uid,id,doc)`). No
      other lib README changes.
- [ ] **Verify-and-record NO change (D6/D7):** `firestore.rules`,
      `firestore.indexes.json`, `sheriff.config.ts`, all `scope:shared` files, and
      the `User` domain type are **NOT** modified — Admin-SDK reads (rules-exempt),
      no new query shape (no index), no new domain type/field. **F4 onboarding-parity
      does NOT apply** (no `User` field changed). **F2 shared-type ripple does NOT
      apply** (no `scope:shared` change; `NotificationStore.write` and the retry
      config are in-slice).
- [ ] **Guardrail verifications (review-checked):** (a) no secret read/written/logged
      — the new response field carries only credential-free per-title reasons; (b)
      the airing-scan writes only `users/{uid}/notifications/**` + prunes only
      `fcmTokens`; (c) `episode-aired` has exactly one owner (the airing-scan) — the
      availability path no longer emits it, with no coverage gap and no double-fire;
      (d) the recency window (3 days) + per-episode `exists` idempotency guard the
      back-catalog storm on first add and re-notification across daily runs; (e) the
      completed/dropped gate (self-implemented per 0088) and 0051 (delivery window)
      are both honored by the episode path; (f) the scan reads `status` after the
      0074 revert commits (deterministic, NB2); (g) no `scope:mobile` file touched.
- [ ] **PR description records:** both defects + fixes; the dependency on spec 0088 + merge order (0088 first or rebase); the `functions:deploy-preflight`
      requirement + that deploy is a separate manual step (D8); that `episode-aired`
      ownership moved to the daily airing-scan (supersedes spec 0012 decision 1B); the
      chosen recency window (3 days) + per-episode `exists` idempotency and error-rate
      threshold (≥20% / ≥20); and that backfill is deliberately out of scope (D5).

## Risks

- **`episode-aired` ownership moves (supersedes spec 0012 decision 1B).** After
  this spec the availability trigger no longer emits `episode-aired`; only the new
  daily airing-scan does, keyed on a per-episode id. Net signal is preserved
  (show-came-to-platform still fires; future episodes fire via the scan) and the
  double-notify + id-collision risks are eliminated. Flagged so a reviewer expects
  `decideKinds` to lose its episode branch and does not read it as a regression.
- **Recency window is a heuristic, not a per-episode availability signal.** A 3-day
  window plus daily-cron latency means a genuinely-new episode notifies, while
  weeks-old back catalog on first add does not. Edge cases: a first-add of a show
  whose latest episode aired ≤3 days ago may emit a couple of recent pushes
  (acceptable, bounded); a platform that delays streaming past airDate could produce
  a premature push (same v1 proxy limitation as spec 0012). A stricter guard
  (`airDate > watchlist.addedAt`) is a possible future refinement — noted, not
  required. Accepted for v1.
- **Why an airing-scan, not a doc-creation trigger.** Episodes are inserted with
  their TMDB-scheduled (often **future**) `airDate` and never re-created (insert-only,
  spec 0047; `mapSeasonEpisodes` drops only null dates). An `onDocumentCreated`
  trigger would therefore fire once, at insert time, with `airDate > now` — rejected
  by the recency window — and never fire again when the episode actually airs, so the
  target case (an ongoing weekly show) would **never** be notified. The daily scan is
  driven by the airing (the `airDate` crossing into `[now-3d, now]`), which is the
  correct signal. Flagged so a reviewer does not "simplify" the scan back into a
  creation trigger.
- **Daily-run re-scan idempotency (replaces the at-least-once concern).** The same
  episode stays inside the 3-day window for up to ~3 daily scans; the per-episode
  `exists` check (`users/{uid}/notifications/{id}`) makes the second+ scan a **no-op**
  — one inbox doc, one FCM attempt per episode. The FCM attempt is single-shot on the
  first in-window notify (matching the availability path's delivery-window semantics);
  a rare duplicate is still possible only via a genuine Firestore/FCM double-delivery,
  accepted and unchanged from spec 0012 decision 3. Because the cron runs at a fixed
  hour (04:00 UTC), a user whose `deliveryHour` is set to another hour receives the
  inbox doc but not the OS push — this is the **pre-existing** spec 0051 behavior for
  cron-time dispatch and is out of scope here.
- **NB2 — spec 0074 revert ordering is deterministic (not a race).** Spec 0074
  reverts a `completed` TV show to `watching` when a new episode is inserted, as a
  separate watchlist-doc write **after** `writeEpisodes` in the episode-insert pass
  (`episode-sync-engine.ts:54,62-69`). The airing-scan is a **strictly later pass**
  in `runSync` (invoked after the entire episode-insert pass returns), so that revert
  write has already committed before the scan reads `status`. The scan reads `status`
  **fresh at emit time**, so it deterministically observes the reverted `watching`
  value — there is no read-before-write race. (The blanket completed/dropped gate
  remains defense-in-depth for any show 0074 did not revert.)
- **NB5 — episode `airDate` is a Firestore `Timestamp`, not a string.** Episode
  docs persist `airDate` as a `Timestamp` (`episodeToData`, `converters.ts:135`
  writes `new Date(...)`; read back via `dataToEpisode`, `converters.ts:145`, as
  `.toDate().toISOString()`). The airing-scan therefore **converts the stored
  `airDate` to an ISO string** (reusing `dataToEpisode`, exactly as the 0081
  `createNextWatchableStoreAdapter` does at `sync-episodes.ts:164-169`) **before**
  feeding it to `isEpisodeRecentlyAired(airDate: string, …)` /
  `EpisodeAiredChange.airDate: string`. It must **not** copy the raw-read pattern of
  the being-removed `createFirestoreEpisodeStore` (`adapters.ts:92-99`), which read
  `data.airDate` raw — a latent `Timestamp`-typed-as-`string` lie. Because a
  string-typed test fake would pass while prod passes a `Timestamp`, the
  scan test fake returns a **`Timestamp`-shaped** `airDate` to exercise the
  conversion boundary (see Test plan). Flagged so a reviewer confirms the
  conversion is present and not shortcut back to a raw read.
- **NB3 — retry budget vs the 540s ceiling.** The acceptance target is a healthy run
  (errors ≈ 0), which is ~130s of serialized TMDB/Trakt calls plus the episode-insert
  - airing-scan passes — comfortably under 540s. The 429 backoff floor is small
    (`backoffBaseMs` ~500ms) so a typical rate-limit blip recovers sub-second; only a
    server-sent `Retry-After` reaches the 60s `MAX_RETRY_AFTER_MS` cap, and that is
    honored regardless. The theoretical worst case (every title 429ing 5× at the 60s
    cap, then a second pass) far exceeds 540s — but that is by definition an unhealthy,
    saturated run, and D4's error-rate gate then **fails the job loudly** rather than
    letting it silently 504. To keep the realistic run bounded, `retryErroredPasses`
    defaults to **1** (a single extra pass over only the retryable-errored subset) and
    `retryDelayMs` is a short cooldown, so the added time is one pass over a small
    subset, not a multiplicative blowup. The workflow `curl --max-time` (550) > function
    ceiling (540) > observed runtime keeps the cron from cutting a healthy run short.
- **Backfill deliberately out of scope (D5).** Availability docs and episodes that
  were missed during the weeks the daily sync was half-failing are **not** replayed
  — replaying `airDate <= now` back catalog would storm the user. The system
  self-heals: the next healthy nightly run (post-D2) writes availability, and future
  new episodes fire via the daily airing-scan. Users will simply not receive
  retroactive notifications for the outage window.
- **Timeout coordination.** Raising the function to 540s requires the cron's `curl
--max-time` and job timeout to move above it, or the cron would cut the function
  off mid-run and re-introduce a silent partial sync. Both are changed together
  (Tasks 3–4); a reviewer should confirm the workflow max-time (550) > function
  ceiling (540) > observed runtime.
- **Free-tier compute.** A higher retry budget + a second pass + a longer timeout
  increases per-run compute, but the daily run is once/day over ~122 titles at
  `maxInstances: 1` — well within Blaze free-tier headroom (PLAN §2/§9). No cost
  concern at this scale.
- **`NotificationStore` change is in-slice.** The `write(uid, id, doc)` change +
  the new `exists(uid, id)` touch only `dispatch-notifications` + its `apps/functions`
  adapter and their tests — **not** `scope:shared`, so no F2 ripple. Verified by grep:
  the port is consumed only by the dispatcher core and
  `createFirestoreNotificationStore`.
- **No PLAN conflict.** This restores PLAN §10's "push within 24h" promise by fixing
  the two paths that break it, using the existing dispatcher port/adapter pattern
  (spec 0012), the insert-only episode model (spec 0047), and the 0051/0074/0088
  rules — no new collection, no new dependency, no `scope:shared` change.
