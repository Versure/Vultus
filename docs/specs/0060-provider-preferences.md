---
number: 0060
slug: provider-preferences
title: Let users pick their subscribed providers and flag "on your platform" availability
status: implementing
slices: [slice:settings, slice:watchlist, slice:title-detail, slice:sync-titles]
scopes: [scope:mobile, scope:functions, scope:shared]
created: 2026-07-01
---

# Let users pick their subscribed providers and flag "on your platform" availability

## Context

GitHub #139: "I want to be able to select my current providers, so I can say
I'm subscribed to Disney+, Netflix, etc. The watchlist should clearly state if
one of my providers gives access to my TV shows and movies or it does not. It
should also state what provider it is available on in my region when it is not
available through one of my current providers."

Today the app knows, per title and region, which providers stream/rent/buy it
(`title-cache/{tmdbId}/availability/{region}` — the `RegionAvailability.providers`
array, kept fresh by the daily sync, spec 0011/0012). The watchlist card
(`libs/mobile/watchlist`) shows the first provider name as a flat badge; the
title-detail "Where to Watch" card (`libs/mobile/title-detail`) lists providers
grouped by flatrate / rent / buy. Neither surface knows **which** providers the
user actually subscribes to, so "is this covered by a subscription I already
pay for?" is invisible.

This spec adds that missing dimension:

1. A **provider catalog** per region, fetched from TMDB
   (`GET /watch/providers/{movie,tv}?watch_region=…`), cached globally in a new
   `provider-catalog/{region}` Firestore doc, exposed to the app through a new
   `getWatchProviders` callable Cloud Function.
2. A **"My Providers" multi-select** in Settings, persisting the user's chosen
   TMDB provider ids to a new `myProviderIds: number[]` field on `users/{uid}`.
3. **Availability framing** on the watchlist card and the title-detail
   "Where to Watch" card. On the **compact watchlist card** this partitions a
   title's **flatrate** providers into "on a provider you have" (highlighted) vs
   "available elsewhere" (muted). On the **roomier title-detail card** it splits
   **all** providers (flatrate + rent + buy) into "On Your Providers" (the user's
   selected flatrate providers) vs "Also Available On" (everything else) — see
   the corrected decision 4 and the supersession note below.

> **Supersession note (2026-07-01, title-detail two-group split).** The
> title-detail section of this spec was originally drafted with the section's
> tokens **extrapolated** from a sibling screen because three `edit_screens`
> pushes to the then-current "Movie Detail - Vultus" screen timed out and never
> rendered. That gap is now **closed**: the Stitch project was cleaned up (four
> duplicate/divergent detail pages consolidated) into one canonical screen,
> **"Movie Detail - Personal Tracking - Vultus"** (`562019f29ce2412d90c757a7e45a98bf`,
> same project `projects/13590348714018893783`), which **renders the "Where to
> Watch" card in full context**, including the two-group split. Its real markup
> revealed the layout is richer than the extrapolation and, crucially, that "Also
> Available On" spans rent/buy too (not flatrate-only). This spec's title-detail
> UI contract, decision 4, the title-detail service/data-model section, T8, the
> test plan, and the DoD are **revised to match that verified render**, which
> **supersedes** the earlier extrapolated decision — a real in-context render is
> stronger evidence than an extrapolation from a sibling screen. The old screen
> `208cb8d7a679490b8d13672c6943d6d3` ("Movie Detail - Vultus") and the intermediate
> `dfc2c7b98a9f46d2bff9b7722fd192b7` ("Movie Detail - Watch Providers - Vultus")
> are **superseded/stale — do NOT pull them.**

This is the **first of two related specs.** Spec 0061 (GitHub #140, not yet
drafted) will add Plex as a manual, non-detectable "provider" layered on the
`myProviderIds` field this spec introduces. To avoid painting 0061 into a
corner, `myProviderIds` is a plain `number[]` of TMDB provider ids — **not** a
closed enum — so a later sentinel / manual entry can be layered in without a
migration (decision 1).

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **`myProviderIds` is an open `number[]` of TMDB provider ids**, defaulting
   `[]`, so 0061 can layer Plex on without a migration. No enum, no closed union.
2. **Provider catalog is fetched from TMDB per region**, cached server-side in
   `provider-catalog/{region}` (global, not per-user — mirrors `title-cache`),
   refreshed on read when missing or older than 7 days, and exposed through a new
   `getWatchProviders` callable (input `{ region }`, output
   `{ providerId, name, logoPath }[]`).
3. **`myProviderIds` lives on `users/{uid}`** alongside `region` /
   `notificationPrefs` / `fcmTokens`. Legacy docs read `?? []`. On a **region
   change**, provider ids not present in the new region's catalog are dropped —
   see Data model for the chosen UX.
4. **Availability framing** differs by surface:
   - **Compact watchlist card = inline highlighted pill**, computed from
     **flatrate providers only** (subscription-coverage per-item framing does not
     apply to pay-per-title on the compact card — a title is "on a provider you
     have" only via a flatrate subscription). Unchanged by the title-detail
     correction below.
   - **Roomier title-detail card = explicit two-group split** ("On Your
     Providers" / "Also Available On") spanning **all** provider types. Per the
     verified canonical screen `562019f29ce2412d90c757a7e45a98bf` (supersession
     note above), **"On Your Providers" = the user's selected FLATRATE providers**
     (only flatrate can be "yours" — subscription is a flatrate concept), and
     **"Also Available On" = every OTHER provider regardless of type** (non-mine
     flatrate + all rent + all buy), each row showing its own type caption
     ("Subscription" / "Rent/Buy" etc.). This is simpler than three separate
     groups and matches the render exactly. **This corrected structure supersedes
     the earlier "rent/buy are unaffected, separate untouched groups" wording**,
     which was an extrapolation before the screen rendered.
5. **Settings "My Providers"** is a new Stitch-designed card (screen
   `cebdfd02c7d44023b0e0019dd4907d48`) between the Region and Notification cards.
6. **One e2e flow** covering the "on your provider" and "also on" pills, seeded
   against the emulator + TMDB fixtures.
7. **Out of scope:** Plex (spec 0061); any change to the spec-0054 watchlist
   "Provider" filter chips; rent/buy provider-**ownership** framing (rent/buy
   providers can never be "yours" — they appear only under title-detail's "Also
   Available On" with their own type caption, never under "On Your Providers").

## Scope

In scope:

- **`myProviderIds: number[]`** added to the `User` document
  (`@vultus/shared/domain`), defaulting `[]`; converter coalesce (`?? []`);
  `_user` type-assertion literal updated; READMEs updated.
- **New `provider-catalog/{region}` collection** + a `CatalogProvider` domain
  type + a `ProviderCatalogDoc` document shape + read/write converter +
  path builder in `@vultus/shared/firestore-schema`.
- **TMDB client method** (`libs/functions/sync-titles` `TmdbClient`):
  `getRegionWatchProviders(region)` fetching + merging (dedupe by provider id)
  the movie + tv provider catalogs for a region.
- **New `getWatchProviders` callable** (`apps/functions/src/main.ts`, gen2
  `onCall`): validates `{ region }`, reads-or-refreshes `provider-catalog/{region}`
  (7-day staleness), returns `CatalogProvider[]`. Mirrors the `triggerSync`
  callable wiring.
- **`GET_WATCH_PROVIDERS` shared token** + shell provider (`apps/mobile`),
  mirroring the `TRIGGER_SYNC` thunk pattern, so `slice:settings` calls the
  callable without importing `@angular/fire/functions` or the shell.
- **Settings "My Providers" section** (`libs/mobile/settings`): a multi-select
  provider-chip control persisting `myProviderIds`, plus the region-change prune.
- **Watchlist card availability pill** (`libs/mobile/watchlist`): partition
  flatrate providers into mine / elsewhere; highlighted "On {provider}" vs muted
  "Also on {provider}" vs the existing no-chip treatment.
- **Title-detail "Where to Watch" two-group split**
  (`libs/mobile/title-detail`): "On Your Providers" (selected flatrate providers)
  vs "Also Available On" (every other provider — non-mine flatrate + all rent +
  all buy — each with its own type caption).
- One new e2e flow (`apps/mobile-e2e`) + unit + component tests per Test plan.

Out of scope (explicitly):

- **Plex / any manual non-TMDB provider** — spec 0061 (GitHub #140). This spec
  only keeps the door open (open `number[]`).
- **The spec-0054 watchlist "Provider" filter chips** — they already filter by
  provider name from availability; "my providers" prioritization/sorting of that
  list is a future nice-to-have, not required here.
- **Rent/buy provider-ownership framing** — only flatrate providers can be
  "yours" (a subscription concept). Rent/buy providers are shown in title-detail's
  "Also Available On" group with their type caption, but are never flagged as
  owned/covered. The compact watchlist pill is flatrate-only.
- **Onboarding / prompting the user to pick providers** — the section is passive
  in Settings; no first-launch nudge.
- **`title-cache` / sync-engine changes** — availability data is consumed as-is;
  the new catalog fetch is a separate, on-demand read path, NOT part of the daily
  sync pass.

## Affected slices & Sheriff tags

| Project                        | Path                           | Sheriff tags                           | Change                                                                                                                                                                   |
| ------------------------------ | ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| shared-domain (edit)           | `libs/shared/domain`           | `scope:shared`                         | **add** `myProviderIds` to `User`; **add** `CatalogProvider` entity + `ProviderCatalogDoc` document; **add** `GET_WATCH_PROVIDERS` token; update `_user` literal; README |
| shared-firestore-schema (edit) | `libs/shared/firestore-schema` | `scope:shared`                         | `dataToUser` / `userToData` carry `myProviderIds` (read `?? []`); new `ProviderCatalog` converter + read/write data types; new `providerCatalogDocPath`; tests; README   |
| functions-sync-titles (edit)   | `libs/functions/sync-titles`   | `scope:functions`, `slice:sync-titles` | `TmdbClient.getRegionWatchProviders(region)` + DTOs/mapper for the two catalog endpoints; tests; README                                                                  |
| functions (app, edit)          | `apps/functions`               | `scope:functions`                      | new `getWatchProviders` callable + `runGetWatchProviders` core (injected deps); the `provider-catalog` read/refresh store; specs; README                                 |
| mobile-settings (edit)         | `libs/mobile/settings`         | `scope:mobile`, `slice:settings`       | "My Providers" multi-select: service signals/setters + catalog load via `GET_WATCH_PROVIDERS`; region-change prune; page + template; mock mirror; README; specs          |
| mobile-watchlist (edit)        | `libs/mobile/watchlist`        | `scope:mobile`, `slice:watchlist`      | read `myProviderIds`; partition flatrate providers; mine / elsewhere pill; specs; README                                                                                 |
| mobile-title-detail (edit)     | `libs/mobile/title-detail`     | `scope:mobile`, `slice:title-detail`   | read `myProviderIds`; two-group split ("On Your Providers" = selected flatrate / "Also Available On" = all other providers) in "Where to Watch"; specs; README           |
| mobile (shell, edit)           | `apps/mobile`                  | `scope:mobile`                         | provide `GET_WATCH_PROVIDERS` thunk (httpsCallable) at app root                                                                                                          |
| mobile-e2e (edit)              | `apps/mobile-e2e`              | untagged                               | new provider-preferences flow spec; seed `provider-catalog/{region}` + `myProviderIds`                                                                                   |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (specs 0010/0012/0051). All
  projects resolve tags from their paths. **This spec does NOT edit
  `sheriff.config.ts`** — every touched lib already has its tag.
- **No cross-slice imports.** `slice:watchlist`, `slice:title-detail`, and
  `slice:settings` each read `myProviderIds` and availability independently
  through `@vultus/shared/*` — they do **not** import each other. The provider-
  partition logic is **duplicated per slice** (watchlist card vs title-detail
  card have genuinely different presentations — an inline pill vs a two-group
  split — and different reasons to change), which is **correct vertical slice**,
  not a DRY violation. Availability framing appears in **2** slices; the 3+-slice
  extract rule (PLAN §3 / CLAUDE.md) is **not** met, so **do NOT** extract a
  shared partition helper.
- **No `scope:mobile` ↔ `scope:functions` edge.** Settings reaches the callable
  through the `GET_WATCH_PROVIDERS` `scope:shared` token provided by the shell
  (mirroring `TRIGGER_SYNC`, spec 0025) — it never imports `@angular/fire/functions`
  or `apps/functions`. The callable and the mobile slices communicate only through
  the persisted `provider-catalog` / `users/{uid}` docs and the shared token/type.
- **`shared/` additions are type/vocabulary + token only** (`CatalogProvider`,
  `ProviderCatalogDoc`, `GET_WATCH_PROVIDERS`, `myProviderIds`, the converter +
  path). This is the persisted-contract pattern (like `WatchProvider` /
  `RegionAvailability` already in `shared/domain`), not a logic extraction.

## Data model touchpoints

PLAN §4 paths. Two changes: an additive field on `users/{uid}`, and a **new
global collection** `provider-catalog/{region}` (read-only from the client,
written by the callable via the Admin SDK — same trust model as `title-cache`).

| PLAN §4 path                                 | Access                           | By                                                                                                                               |
| -------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `users/{uid}.myProviderIds`                  | **read**, **create**, **update** | settings slice (read on load; default `[]` on eager create; write on toggle / region-change prune)                               |
| `users/{uid}.myProviderIds`                  | **read**                         | watchlist (partition flatrate providers only) + title-detail (partition ALL providers; only the `mine` bucket is flatrate-gated) |
| `provider-catalog/{region}`                  | **read**                         | mobile via the `getWatchProviders` callable output (NOT read directly by the client)                                             |
| `provider-catalog/{region}`                  | **read + create/update**         | `getWatchProviders` callable (Admin SDK — cache-read; refetch + rewrite when missing/stale)                                      |
| `title-cache/{tmdbId}/availability/{region}` | **read** (unchanged shape)       | watchlist + title-detail slices (the `RegionAvailability.providers` array being partitioned)                                     |

### `users/{uid}.myProviderIds` (additive)

- **Shape:** `myProviderIds: number[]` — TMDB provider ids the user subscribes
  to. **Required** on the domain `User` (mirrors the other three required fields);
  value always present (`[]` default) on new docs.
- **Default `[]`, and legacy coalesce.** `dataToUser` reads
  `data.myProviderIds ?? []` (a legacy doc pre-0060 lacks the field → `[]`),
  exactly the migration-safe pattern `deliveryHour ?? null` uses. `userToData`
  passes `myProviderIds` through.
- **Eager-create default** (settings `load()`): extend the create literal to
  include `myProviderIds: []`.
- **Region-change prune (decision 3).** When the user changes region via the
  existing Region picker, ids not present in the **new** region's catalog become
  dead (they'll never match anything). Chosen UX: **on region change, load the
  new region's catalog and drop any `myProviderIds` not in it, then persist the
  pruned array**, surfacing a **toast** only when ≥1 id was dropped (e.g. "2
  providers aren't available in {region} and were removed"). Rationale: silently
  keeping stale ids leaves the footer count ("N of M selected") lying; silently
  dropping with no feedback is confusing when a chip vanishes. This is a bounded,
  rare edge; the toast is the minimum honest feedback. **If** the new catalog
  fails to load (offline), **do not** prune (never destroy data on a failed read)
  — leave `myProviderIds` untouched and let the next successful load reconcile.
  **Ordering note:** this is two sequential writes to `users/{uid}` per region
  change — first the region itself (existing `setRegion` write), then the pruned
  `myProviderIds` once the new catalog loads. Do not try to batch these into one
  write; keeping them sequential is what lets the "skip prune on load failure"
  guard leave a valid, already-persisted region with an untouched provider list.
- **No `firestore.rules` change for `users/{uid}`** — owner read/write already
  covers the additive field (spec 0004/0011).

### `provider-catalog/{region}` (new global collection)

- **Path:** `provider-catalog/{region}` — document id is the domain `Region`
  code (`NL`, `DE`, …), mirroring `title-cache/{tmdbId}` as a shared,
  function-written cache (PLAN §4). New `COLLECTIONS.providerCatalog =
'provider-catalog'` + `providerCatalogPath()` / `providerCatalogDocPath(region)`
  in `paths.ts`.
- **Stored shape (`ProviderCatalogDoc`):**
  `{ providers: CatalogProvider[]; lastSyncedAt: string /* ISO */ }`. The
  converter maps `lastSyncedAt` ISO ↔ `Date`/Timestamp (like every other doc);
  `providers` passes through.
- **`CatalogProvider`** (new `shared/domain` entity):
  `{ providerId: number; name: string; logoPath: string | null }`. **A narrower
  type than `WatchProvider`** — deliberately **no `type` field**: a region-wide
  catalog is not per-title flatrate/rent/buy, so `WatchProvider.type` doesn't
  apply (decision 2). `logoPath` is the TMDB `logo_path` (nullable), which
  `WatchProvider` also lacks. Keep `WatchProvider` unchanged.
- **`firestore.rules` — add a read+deny-write rule for `provider-catalog`.**
  The client never writes it (only the Admin-SDK callable does, which bypasses
  rules). Add: authenticated `read` allowed, client `write` denied, matching the
  existing `title-cache` rule (verify the current `title-cache` rule and mirror
  it for `provider-catalog/{region}`). No new composite index (single-doc reads
  by id only) → **no `firestore.indexes.json` change.**
- **Staleness:** the callable treats a doc older than **7 days**
  (`now - lastSyncedAt > 7*24*60*60*1000`) or **absent** as stale → refetch from
  TMDB + rewrite; otherwise return the cached providers. The refetch is on the
  callable path only — the daily sync does **not** touch this collection.

## Public types / APIs

### Shared domain (additive)

`libs/shared/domain/src/lib/entities.ts` — new entity:

```ts
/** One provider in a region's TMDB watch-provider catalog (spec 0060). Narrower
 *  than WatchProvider: a region catalog has no per-title flatrate/rent/buy type,
 *  and carries the TMDB logo path. */
export interface CatalogProvider {
  providerId: number; // TMDB provider id
  name: string; // TMDB provider_name
  logoPath: string | null; // TMDB logo_path, e.g. '/abc.jpg'; null when unknown
}
```

`libs/shared/domain/src/lib/documents.ts` — new document + `User` field:

```ts
export interface User {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  /** TMDB provider ids the user subscribes to (spec 0060). Open number[] so a
   *  later manual "provider" (Plex, spec 0061) can be layered in without a
   *  migration. Default []; legacy docs missing it → [] via the converter. */
  myProviderIds: number[];
}

// provider-catalog/{region} — global, function-written cache (PLAN §4).
export interface ProviderCatalogDoc {
  providers: CatalogProvider[];
  lastSyncedAt: string; // ISO 8601
}
```

Barrel-export both from `@vultus/shared/domain`.

**Required companion edit:** the `_user` literal in `type-assertions.ts` sets
`User` without `myProviderIds`; because the field is **required**, that literal
fails `typecheck` unless `myProviderIds: []` (or any `number[]`) is added.

`libs/shared/domain/src/lib/tokens.ts` — new cross-scope token:

```ts
/** A thunk that fetches the region's TMDB watch-provider catalog via the
 *  `getWatchProviders` callable. Provided by the shell (apps/mobile) so the
 *  settings slice can call it WITHOUT importing @angular/fire/functions or
 *  apps/mobile — mirrors TRIGGER_SYNC (spec 0025 / 0060). */
export const GET_WATCH_PROVIDERS = new InjectionToken<
  (region: Region) => Promise<CatalogProvider[]>
>('GET_WATCH_PROVIDERS');
```

(Add the `Region` / `CatalogProvider` type imports to `tokens.ts`.)

### firestore-schema (additive)

- `data-types.ts`: add `myProviderIds` to `UserReadData` (optional on read:
  `myProviderIds?: number[]`) and `UserWriteData` (`myProviderIds: number[]`).
  Add `ProviderCatalogReadData` (`lastSyncedAt: FirestoreTimestampLike`, `providers:
CatalogProvider[]`) and `ProviderCatalogWriteData` (`lastSyncedAt: Date`).
- `converters.ts`:
  - `userToData`: add `myProviderIds: user.myProviderIds`.
  - `dataToUser`: add `myProviderIds: data.myProviderIds ?? []`.
  - Add `providerCatalogToData` / `dataToProviderCatalog` mirroring
    `titleCacheToData` / `dataToTitleCache` (ISO↔Timestamp on `lastSyncedAt`,
    `providers` pass-through).
- `paths.ts`: `COLLECTIONS.providerCatalog = 'provider-catalog'`;
  `providerCatalogPath()` (collection) + `providerCatalogDocPath(region: Region)`
  (doc, id = region code).
- Barrel-export the new converters + path builders + data types.

### TMDB client (`libs/functions/sync-titles`)

Read `tmdb-client.ts` first — follow its `createHttpCore` auth/retry/404
conventions. Add to `TmdbClient`:

```ts
/** Fetches the region's flatrate/rent/buy provider CATALOG (movie + tv merged,
 *  deduped by providerId) from GET /watch/providers/{movie,tv}?watch_region=…
 *  (spec 0060). Returns [] when TMDB returns an empty catalog; null on a TMDB
 *  404 (consistent with the other methods). */
getRegionWatchProviders(region: Region): Promise<CatalogProvider[] | null>;
```

- Two `core.request` calls (`/watch/providers/movie?watch_region={region}` and
  `/watch/providers/tv?watch_region={region}`), each returning a TMDB list
  response `{ results: { provider_id, provider_name, logo_path, display_priority }[] }`.
- Add the DTO to `tmdb-dtos.ts` (`TmdbWatchProviderListEntry` /
  `TmdbWatchProviderListResponse`) — model only `provider_id`, `provider_name`,
  `logo_path` (leave `display_priority` unmodeled, consistent with the file's
  note about unmodeled fields).
- Add a pure mapper to `tmdb-mappers.ts`
  (`mergeCatalogProviders(movie, tv): CatalogProvider[]`): concat both lists, map
  each entry to `CatalogProvider` (`logoPath: entry.logo_path ?? null`), dedupe by
  `providerId` (first wins), and sort by `name` (stable, case-insensitive) for a
  deterministic order the UI can rely on. This mapper is the **priority unit-test
  surface** (pure, no I/O). If either endpoint 404s, treat that side as `[]`
  (merge the other); only return `null` if **both** 404 (unlikely, but keeps the
  404→null contract).
- `region` maps directly to the `watch_region` query param (TMDB uses the same
  ISO-3166-1 alpha-2 codes as `REGIONS`).

### `getWatchProviders` callable (`apps/functions/src/main.ts`)

Mirror the `triggerSync` / `runTriggerSync` split (SDK-agnostic core +
injected-deps + `onCall` wiring):

```ts
export interface GetWatchProvidersRequest {
  region: Region;
}
export interface GetWatchProvidersResponse {
  providers: CatalogProvider[];
}

export interface RunGetWatchProvidersDeps {
  db: Firestore;
  /** Builds the credentialed TMDB client (injected so tests use a fake). */
  createTmdb: () => TmdbClient;
  now?: () => number; // injected clock for deterministic staleness tests
  stalenessMs?: number; // defaults to 7 days
}

export async function runGetWatchProviders(
  deps: RunGetWatchProvidersDeps,
  uid: string | undefined,
  input: unknown,
): Promise<GetWatchProvidersResponse> { … }
```

Core behaviour:

- `if (!uid) throw new HttpsError('unauthenticated', …)` — same as `runTriggerSync`.
- Validate `input`: `region` must be a member of `REGIONS` (use a runtime guard
  against the `REGIONS` const array) — else
  `throw new HttpsError('invalid-argument', 'Unknown region')`. Never trust the
  client-supplied region blindly.
- Read `provider-catalog/{region}` via the schema path + converter. If present
  **and** `now - lastSyncedAt <= stalenessMs` → return its `providers`.
- Else fetch `deps.createTmdb().getRegionWatchProviders(region)`; on `null`
  (both TMDB endpoints 404 / unexpected) throw `HttpsError('unavailable', …)`
  **without** overwriting a usable stale cache (if a stale doc exists, prefer
  returning it over throwing — a stale catalog beats none); write the fresh
  `{ providers, lastSyncedAt: now-ISO }` to `provider-catalog/{region}`; return it.
- Best-effort semantics for the cache **write** only (a write failure logs and
  still returns the freshly-fetched providers) — but a **fetch** failure with no
  cache is a real error the client should see.

`onCall` wiring: bind `TMDB_READ_TOKEN` (`secrets: [TMDB_READ_TOKEN]`), reuse the
same `cors` array as `triggerSync`, `createTmdb: () => createTmdbClient({
readAccessToken: TMDB_READ_TOKEN.value() })`, pass `request.auth?.uid` and
`request.data`. Export `getWatchProviders` from the deployable barrel.

> **Config / secrets:** the callable reads only `TMDB_READ_TOKEN` via
> `.value()` inside the handler (never at module load, never logged) — exactly
> like `syncTitles` / `triggerSync`. No new secret is introduced; no `.env.local`
> access. The mobile side reads **no** secret (it calls the callable).

### Shell provider (`apps/mobile/src/app/app.config.ts`)

Add a `GET_WATCH_PROVIDERS` provider mirroring the existing `TRIGGER_SYNC` one:

```ts
{
  provide: GET_WATCH_PROVIDERS,
  useFactory: () => {
    const fns = inject(Functions);
    const callable = httpsCallable<
      { region: Region },
      { providers: CatalogProvider[] }
    >(fns, 'getWatchProviders');
    return (region: Region) => callable({ region }).then((r) => r.data.providers);
  },
},
```

In **mock** mode the mock providers seed the catalog directly (no callable) — see
the settings mock below; the shell provider is the production/emulator path.

> The callable's request/response are typed inline here (structurally) rather
> than importing `GetWatchProvidersRequest`/`GetWatchProvidersResponse` from
> `apps/functions` — the shell (`scope:mobile`) cannot import a `scope:functions`
> project. This is intentional, not a DRY gap to close; don't add that import.

### Settings slice surface (`libs/mobile/settings`)

`SettingsService` gains:

```ts
/** The current region's provider catalog (loaded lazily on first open). */
readonly providerCatalog: Signal<CatalogProvider[]>;
/** The user's selected provider ids (persisted; default []). */
readonly myProviderIds: Signal<number[]>;
/** True while the catalog is being fetched (drives a skeleton/spinner). */
readonly catalogLoading: Signal<boolean>;

/** Loads the current region's catalog via GET_WATCH_PROVIDERS (once per
 *  session unless region changed); no-op if already loaded for this region. */
loadProviderCatalog(): Promise<void>;
/** Toggles one provider id in myProviderIds and persists the whole array. */
toggleProvider(providerId: number): Promise<void>;
```

- Inject `GET_WATCH_PROVIDERS` (the `scope:shared` token). `load()` reads
  `user.myProviderIds` into `_myProviderIds` and adds `myProviderIds: []` to the
  eager-create literal.
- `toggleProvider` computes the next `number[]` (add if absent, remove if
  present) and persists via `updateDoc(..., { myProviderIds })` (a scalar-array
  field write, like `setRegion`'s `{ region }`). Null-uid guarded.
- **Region change** (`setRegion`) must, after persisting the region: call the
  catalog thunk for the **new** region, prune `myProviderIds` to ids present in
  it, persist the pruned array, and (if any were dropped) surface a toast. Guard:
  on a catalog-load failure, **skip the prune** (don't destroy data). Keep this
  logic in the service; the page owns only the toast presentation (pass a dropped-
  count back, or expose a signal the page reacts to).
- **Mock (`settings.providers.mock.ts` `MockSettingsServiceImpl`)** mirrors the
  new surface: a seeded `providerCatalog` (e.g. Netflix, Disney Plus, Max, Prime
  Video with plausible `logoPath`s), a seeded `myProviderIds` (e.g. `[8]` = Netflix
  so `mobile:serve-mock` shows a selected + unselected mix), `catalogLoading`
  false, and `loadProviderCatalog` / `toggleProvider` operating on the in-memory
  signals (no callable). Update the mock's doc comment to list the new surface.

`SettingsPage` (`settings.page.ts`): add `onProviderToggle(providerId)` calling
`service.toggleProvider`, register any new icon (e.g. `checkmarkCircle` for the
selected badge) via `addIcons`, and trigger `loadProviderCatalog()` in `ngOnInit`
(or lazily; the catalog is small — eager on load is fine). Present the region-
change toast via `ToastController`.

### Watchlist slice surface (`libs/mobile/watchlist`)

- `WatchlistService`: add `myProviderIds$(uid): Observable<number[]>` reading
  `users/{uid}.myProviderIds` (via `dataToUser`, default `[]`) — same
  `docData` + `dataToUser` path `userRegion$` already uses (read it; you can
  widen `userRegion$` into a single user stream or add a sibling — implementer's
  call, but avoid opening a second Firestore listener on the same doc: prefer one
  `users/{uid}` `docData` stream mapped to both `region` and `myProviderIds`).
- Replace the flat `getProviderName$` badge logic (page lines ~165–181, both the
  `planned` and non-planned branches) with a **partitioned** view model. Add to
  the page a memoized (same `providerCache` pattern — one shared Observable per
  `tmdbId|region` key, `shareReplay`) stream that reads the **full**
  `RegionAvailability` (not just names), filters to **flatrate** providers, and
  combined with `myProviderIds$` yields:
  - `{ kind: 'mine'; name }` when ≥1 flatrate provider's `providerId ∈
myProviderIds` (use the FIRST such provider's name);
  - else `{ kind: 'elsewhere'; name }` when ≥1 flatrate provider exists (first
    provider's name);
  - else `null` (no flatrate availability → keep the existing no-chip / muted
    treatment).
- The template renders one pill per the `kind` (see UI section for exact classes).
  **This replaces the current two `getProviderName$` blocks** — it is not a third
  parallel path. Keep the memoization (do not return a fresh Observable per CD
  cycle — the existing comment at `providerCache` explains why).

### Title-detail slice surface (`libs/mobile/title-detail`)

- `TitleDetailService`: add a `myProviderIds$()` stream (read
  `users/{uid}.myProviderIds`, default `[]`) alongside the existing `region$()`.
- `TitleDetailPage`: fold `myProviderIds` into `vm$` (a third combined source, or
  extend the existing `providers$`/`tracked$` `combineLatest`). Add a pure helper
  `partitionProviders(providers, myProviderIds): { mine: WatchProvider[]; elsewhere: WatchProvider[] }`
  that partitions **all** providers (flatrate + rent + buy) into:
  - `mine` — **flatrate** providers whose `providerId ∈ myProviderIds` (only
    flatrate can be "yours"; a rent/buy provider is never `mine` even if its id is
    in `myProviderIds`);
  - `elsewhere` — **every other** provider (non-mine flatrate + all rent + all
    buy).
    Each `WatchProvider` carries its `type` (`flatrate`/`rent`/`buy`), which the
    template renders as the per-row type caption (e.g. "Subscription" for flatrate,
    "Rent/Buy" for rent/buy — see the UI section for the caption mapping). The
    template renders the two labeled subgroups (see UI section). **The verified
    canonical screen (`562019f29ce2412d90c757a7e45a98bf`) shows this consolidated
    two-group layout replacing the old separate flatrate/rent/buy blocks** — the
    detail card is now one "Where to Watch" card with the two subgroups (plus the
    spec-0061 Personal Tracking / Plex subgroup below them, out of scope here). Do
    **not** keep three separate flatrate/rent/buy sections.

## UI / Stitch screen refs

**Authoritative tokens** live in `docs/design/vultus-design-system.md`, consumed
via the wired `--vultus-*` / `--ion-*` vars in
`libs/shared/ui-kit/src/lib/theme.scss`. **Never hand-transcribe a hex** — primary
is `#4edea3` (`--ion-color-primary` / `--vultus-primary`), **not** `#10B981`
(that's `primary-container`). `surface-container #171f33`, `surface-container-high
#222a3d` (= `surface-variant`), `on-surface #dae2fd`, `on-surface-variant
#bbcabf`, `outline-variant #3c4a42`.

> The Tailwind-flavoured class names quoted below (`bg-primary/10`,
> `text-on-surface-variant`, etc.) are the tokens **as they appear in the fetched
> Stitch markup**; in-repo the implementer wires the equivalent `--vultus-*` /
> `--ion-*` vars through the slice's SCSS (the app is Ionic/Angular SCSS, not
> Tailwind). The **token intent** is what's pinned, not the literal Tailwind
> class. No hard-coded hex.

### Fetch recipe (all three screens — CLAUDE.md contract)

For each screen: `list_screens` in `projects/13590348714018893783` → confirm the
id → `get_screen` (metadata + URLs) → fetch `htmlCode.downloadUrl` via a plain
`Invoke-WebRequest` (**NOT** WebFetch, which strips CSS) for the markup, and
`screenshot.downloadUrl` for the visual compare. A failed MCP call is a **retry**,
not a fallback to token-only (project memory `stitch-mcp-reachable.md`).

The three canonical screens are: (A) Settings "My Providers"
`cebdfd02c7d44023b0e0019dd4907d48`; (B) Advanced Watchlist
`19f0eae3d6d24eaa90b3aa73ff44a59b`; (C) **"Movie Detail - Personal Tracking -
Vultus" `562019f29ce2412d90c757a7e45a98bf`** for the title-detail "Where to
Watch" card. **Superseded/stale — do NOT pull:** the old title-detail screens
`208cb8d7a679490b8d13672c6943d6d3` ("Movie Detail - Vultus") and
`dfc2c7b98a9f46d2bff9b7722fd192b7` ("Movie Detail - Watch Providers - Vultus"),
which the Stitch project cleanup consolidated into (C).

### (A) Settings — "My Providers" card (Stitch "Settings - My Providers - Vultus", screen id `cebdfd02c7d44023b0e0019dd4907d48`)

A NEW screen was generated — a fork of the original "Settings - Vultus"
(`81945ff3381e453dafcc4e5ce896fcfa`) with a new card inserted **between** the
Region card and the Notification Preferences card; everything else is identical.
**Pull the NEW screen** (`cebdfd02c7d44023b0e0019dd4907d48`), not the old one.

**Checkable contract (tick each vs the fetched markup + screenshot):**

| Element               | Spec                                                                                                                                                                                                                                                                                             | Token / var                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Card**              | A `.settings-card` matching the Region / Notifications siblings: `surface-container` fill, `--vultus-radius-md`, 1px `outline-variant` hairline (20% alpha), 16px padding, 8px gap from the card above. Side inset + inter-card gap **must agree** with all sibling settings cards (same stack). | `--vultus-surface-container`, `--vultus-outline-variant`, `--vultus-space-md`, `--vultus-space-sm` |
| **Header row**        | Icon tile (`.settings-row__icon`, 40×40, `--vultus-radius`, primary-coloured glyph, ~22px — suggested `tv-outline` or `albums-outline`) + title "My Providers" (`body-lg`/600) + subtitle "Subscriptions used to check availability" (`body-md` `on-surface-variant`).                           | `--ion-color-primary`, `--vultus-on-surface`, `--vultus-on-surface-variant`                        |
| **Provider chip**     | ~**96px wide** tappable chip: provider logo (TMDB `logoPath`, rounded) above the provider name (`label-sm`, centered, `on-surface`). Chips wrap in a flex row, consistent gap (pin from markup, e.g. 8px). All chips the **same width/height** — no drift.                                       | `--vultus-on-surface`                                                                              |
| **Chip — selected**   | `border-2` in `--ion-color-primary`; a `check_circle` (`checkmark-circle`) badge overlapping the top-right of the logo, primary-coloured; full opacity.                                                                                                                                          | `--ion-color-primary`                                                                              |
| **Chip — unselected** | `border` (1px) in `outline-variant` (~20% alpha); `opacity: 0.6`; no badge.                                                                                                                                                                                                                      | `--vultus-outline-variant`                                                                         |
| **Footer line**       | "N of M selected · Region: {region}" — `label-sm` / `on-surface-variant`, left-aligned to the chip grid.                                                                                                                                                                                         | `--vultus-on-surface-variant`                                                                      |

**Structure note:** this is a **wrapping row of plain tappable chips**, NOT an
`ion-segment` or `ion-select` — build it as a `@for` over `service.providerCatalog()`
of `<button>`-role chips (a11y: `aria-pressed`), each `(click)="onProviderToggle(p.providerId)"`.

**Interactive-state contract (tick each):**

| Element       | default                                                                                                 | focus                 | active/press                                                                   | selected result                                                                                          | loading                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Provider chip | unselected (border, 60% opacity) OR selected (primary border + badge, full opacity) per `myProviderIds` | `:focus-visible` ring | subtle press feedback (opacity/scale) consistent with other tappables; no lift | toggling calls `toggleProvider`, chip flips selected/unselected with the border+badge+opacity transition | while `catalogLoading()` → skeleton chips (or the section's spinner), NOT an empty card |

- **Font loading:** Inter is loaded app-wide (spec 0010) — confirm the chips
  render in Inter.
- **Placement:** the card goes in the `.settings-cards` stack **between** the
  Region card and the notification cards (matching the Stitch fork).
- **Region change → prune:** when the Region picker changes, the footer count and
  chip selection update to the pruned set; a toast appears iff ≥1 chip was dropped.

### (B) Watchlist card — availability pill (Stitch "Advanced Watchlist - Vultus", screen id `19f0eae3d6d24eaa90b3aa73ff44a59b`)

This screen was **updated live** to demonstrate exactly this pair of states: 3
items show the primary/check-icon "mine" pill (+ a ring on the provider logo
badge), 1 item ("The Bear") shows the muted "Also on Hulu" pill with no ring.
**Pull this screen fresh** (raw HTML per the recipe) to read the exact current
classes before touching `watchlist.page.html`.

**Checkable contract (tick each vs the fetched markup):**

| State         | Condition                                              | Pill spec                                                                                                                                                                              | Token intent                                                                   |
| ------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Mine**      | ≥1 flatrate provider with `providerId ∈ myProviderIds` | `bg-primary/10 text-primary` pill + a leading `check_circle` (`checkmark-circle`) icon; text **"On {providerName}"**. If the provider logo badge is shown, it gets a primary **ring**. | `--ion-color-primary` at ~10% alpha fill, primary text/icon                    |
| **Elsewhere** | no mine, ≥1 flatrate provider                          | `bg-surface-variant/40 text-on-surface-variant` pill; **no** icon; text **"Also on {providerName}"**; no ring on the logo badge.                                                       | `--vultus-surface-variant` ~40% alpha fill, `--vultus-on-surface-variant` text |
| **None**      | no flatrate provider                                   | keep the **existing** no-chip / muted "not available" treatment already in the page (do NOT add a new element).                                                                        | (existing)                                                                     |

- Type roles: pill text = `label-sm` (matching the card's existing meta scale);
  provider name is data-driven.
- The pill replaces the current `.availability-badge` (planned branch) and
  `.provider-badge` (non-planned branch) — a **single** partitioned pill per card,
  not one added on top of the old ones.
- **Interactive states:** the card itself is the tappable target (unchanged); the
  pill is non-interactive (presentational). No new hover/focus states beyond the
  card's existing ones.

### (C) Title-detail "Where to Watch" — two-group split (Stitch "Movie Detail - Personal Tracking - Vultus", screen id `562019f29ce2412d90c757a7e45a98bf`)

**VERIFIED via a real in-context render.** This canonical screen renders the "Where
to Watch" card in full context, including the two-group split. **Pull this screen
fresh** (raw HTML per the recipe — `htmlCode.downloadUrl` via `Invoke-WebRequest`,
plus `screenshot.downloadUrl`) before touching `title-detail.page.html`. **Do NOT
pull** the superseded `208cb8d7a679490b8d13672c6943d6d3` or
`dfc2c7b98a9f46d2bff9b7722fd192b7` (see fetch recipe).

Target: the "Where to Watch" block in `title-detail.page.html` (the old separate
flatrate/rent/buy provider blocks, ~lines 164–173). Replace it with a single card
containing two labeled subgroups. Semantics (from the verified markup): **"On Your
Providers" = the user's selected FLATRATE providers**; **"Also Available On" =
every other provider** (non-mine flatrate + all rent + all buy), each row showing
its own type caption. (The spec-0061 "Personal Tracking" / Plex subgroup renders
**below** these two, separated by the same divider — it exists in the canonical
screen but is **owned by spec 0061**; do not build or duplicate its contract here,
just leave room for it after the two groups so divider/ordering are understood.)

**Card + subgroup structure (checkable contract vs the fetched markup):**

| Element                       | Spec                                                                                                                                                                                                                                                                    | Token intent                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Card**                      | `glass-panel` surface, `--vultus-radius-xl`, `--vultus-space-lg` padding. Header row: a `stream` (Ionic equivalent) glyph + title "Where to Watch" in **`headline-sm`, `text-primary`**, `flex items-center gap-2`, with bottom margin below it before the groups.      | `--ion-color-primary`                                                                                  |
| **Subgroup spacing**          | Groups stacked with `space-y-6` (`--vultus-space-lg`); within a group, label + rows stacked `space-y-3` (`--vultus-space-sm`). A `border-t border-outline-variant/10` hairline with `mt-md pt-md` separates each group from the next (incl. from the 0061 group below). | `--vultus-outline-variant` (~10% alpha), `--vultus-space-lg`, `--vultus-space-sm`, `--vultus-space-md` |
| **"On Your Providers" label** | Uppercase, `label-sm`, `tracking-wider`, **`text-primary`**, with a leading **filled** `check_circle` glyph at 16px (`font-variation-settings: 'FILL' 1`). `flex items-center gap-1.5`.                                                                                 | `--ion-color-primary`                                                                                  |
| **"Also Available On" label** | Uppercase, `label-sm`, `tracking-wider`, **`text-on-surface-variant`**, **no icon**.                                                                                                                                                                                    | `--vultus-on-surface-variant`                                                                          |

**Provider row (both subgroups — checkable contract):** each provider is a row,
NOT a bare name. From the verified markup each row is a
`flex items-center justify-between p-3 rounded-lg` on a `bg-surface-container`
fill:

| Row part              | "On Your Providers" row                                                                                                                                              | "Also Available On" row                                                                                                                                   | Token intent                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Logo tile**         | 40×40 (`w-10 h-10`), `--vultus-radius-md`, provider logo (TMDB `logoPath`), `flex-shrink-0`.                                                                         | same 40×40 logo tile.                                                                                                                                     | —                                                                                  |
| **Primary line**      | provider name in **`text-on-surface` bold** (`body-md`) + a small **"Yours"** tag next to it (`rounded-full px-2 py-0.5`, ~10px bold, `bg-primary/10 text-primary`). | provider name in **muted `text-on-surface-variant`** (`body-md`, NOT bold); **no** "Yours" tag.                                                           | `--vultus-on-surface`, `--ion-color-primary` (tag) / `--vultus-on-surface-variant` |
| **Secondary caption** | **type caption "Subscription"** below the name (`label-sm`, `text-on-surface-variant`). All "mine" rows are flatrate → "Subscription".                               | **type caption for the provider's actual type** below the name (`label-sm`, `text-on-surface-variant`): flatrate → "Subscription", rent/buy → "Rent/Buy". | `--vultus-on-surface-variant`                                                      |
| **Trailing icon**     | an `open_in_new` glyph, `text-on-surface-variant`.                                                                                                                   | same `open_in_new` glyph.                                                                                                                                 | `--vultus-on-surface-variant`                                                      |

> **`open_in_new` is a DECORATIVE hover affordance in the mock, NOT a functional
> requirement.** This app's model has **no per-provider external deep-link URL**,
> and the issue never asked for external navigation. **Do NOT add external
> navigation, an `href`, or any click handler that opens a provider** — reproduce
> the visual (the trailing glyph + its hover color shift) only if it's trivially
> faithful, or omit the glyph entirely; either is acceptable, but **do not scope-
> creep a real deep-link feature.** The row is presentational.

**Interactive-state contract (tick each vs the fetched markup + screenshot):**

| Element      | default                     | hover                                                                                                                                                  | focus                                                                                                                                 | active/press                                       | disabled |
| ------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------- |
| Provider row | `bg-surface-container` fill | `bg-surface-container-high` fill (subtle raise); trailing `open_in_new` glyph shifts to `text-primary` (`group-hover`). **Transition-colors** on both. | (row is presentational — no functional focus target since there's no action; if rendered as a non-interactive element, no focus ring) | none (no press action — the row does not navigate) | n/a      |

The hover state is the mock's `hover:bg-surface-container-high` +
`group-hover:text-primary` on the trailing icon; wire it via
`--vultus-surface-container` (default) → `--vultus-surface-container-high` (hover,
= `--vultus-surface-variant #222a3d`) with a color transition. Because there's no
real action, the hover is a light affordance only — do not make the row a button.

**Empty-subgroup rule:** if a subgroup has no providers (all mine, or none mine),
render only the non-empty one (no empty header/divider). Order is **On Your
Providers first**, then **Also Available On** (then the 0061 group). If **both**
provider subgroups are empty (no providers at all), keep the existing
empty/"not available" copy the page already shows.

- Type roles: header title = `headline-sm`; group labels = `label-sm` (uppercase);
  provider name = `body-md`; type caption + "Yours" tag = `label-sm` / ~10px.
- **Font loading:** Inter is loaded app-wide (spec 0010) — confirm rows render in
  Inter; no new web-font.

### Visual verification (CLAUDE.md)

Serve `pnpm nx run mobile:serve-mock` and screenshot-compare all three against
their canonical Stitch screens: (1) the Settings "My Providers" card (selected +
unselected chips, footer count) against `cebdfd02c7d44023b0e0019dd4907d48`; (2) a
watchlist with a "mine" and an "elsewhere" item against
`19f0eae3d6d24eaa90b3aa73ff44a59b`; (3) a title-detail "Where to Watch" card
showing both subgroups (with a "Yours" tag on a mine row, a "Subscription"/
"Rent/Buy" caption per row, and the hover raise) against
`562019f29ce2412d90c757a7e45a98bf`. All three now have a rendered Stitch reference
— (3) is **no longer a known gap**; it gets the same standard screenshot-compare
treatment as (1) and (2). A green build does NOT prove fidelity; if
`mobile:serve-mock` can't run under tooling, flag the affected screen(s) unverified
for a human eyeball (the standard CLAUDE.md fallback), not a title-detail-specific
exception.

## Implementation task graph

T1 (shared domain) and T2 (schema) are shared-root edits every consumer compiles
against — sequential, first. The TMDB client (T3) and the callable (T4) are the
backend path; the shell provider (T5) and the three mobile slices (T6 settings,
T7 watchlist, T8 title-detail) are the frontend path. T4 depends on T3 (imports
the client) and T2 (the catalog converter/path). T5–T8 depend on T1/T2 (the token

- `myProviderIds`); T6 additionally depends on T5 wiring being present at runtime
  for the emulator/prod path (but not for its unit tests, which mock the token).
  The e2e (T9) depends on the whole chain and seeds against it.

**T1 — Shared domain: `myProviderIds` + `CatalogProvider` + `ProviderCatalogDoc` + token [sequential]** (backend-engineer / domain)

- `entities.ts`: add `CatalogProvider`. `documents.ts`: add `myProviderIds` to
  `User`, add `ProviderCatalogDoc`. `tokens.ts`: add `GET_WATCH_PROVIDERS`.
- `type-assertions.ts`: add `myProviderIds: []` to the `_user` literal (required
  field → typecheck gate).
- Barrel-export the new entity/doc from `@vultus/shared/domain`.
- Update `libs/shared/domain/README.md` (new entity, doc, `User` field, token).
- Files: `libs/shared/domain/src/lib/entities.ts`,
  `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/src/lib/tokens.ts`,
  `libs/shared/domain/src/lib/type-assertions.ts`,
  `libs/shared/domain/src/index.ts` (or the barrel that re-exports these),
  `libs/shared/domain/README.md`.

**T2 — firestore-schema: `myProviderIds` coalesce + `ProviderCatalog` converter + path + tests [sequential, after T1]** (backend-engineer)

- `data-types.ts`: `myProviderIds` on `UserReadData` (optional) / `UserWriteData`
  (required); add `ProviderCatalogReadData` / `ProviderCatalogWriteData`.
- `converters.ts`: `userToData` + `dataToUser` (`?? []`); add
  `providerCatalogToData` / `dataToProviderCatalog`.
- `paths.ts`: `COLLECTIONS.providerCatalog`, `providerCatalogPath()`,
  `providerCatalogDocPath(region)`.
- Barrel-export the new converters/paths/types.
- Extend `firestore-schema.spec.ts`: user round-trip includes `myProviderIds`
  (populated + empty + a legacy doc missing it → `[]`); provider-catalog
  round-trip (ISO↔Timestamp on `lastSyncedAt`, providers pass-through); path
  builders return the expected strings.
- Update `libs/shared/firestore-schema/README.md`.
- Files: `libs/shared/firestore-schema/src/lib/data-types.ts`,
  `libs/shared/firestore-schema/src/lib/converters.ts`,
  `libs/shared/firestore-schema/src/lib/paths.ts`,
  `libs/shared/firestore-schema/src/index.ts` (barrel),
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md`.

**T3 — TMDB client: `getRegionWatchProviders` + DTO + mapper + tests [parallel, after T1]** (backend-engineer)

- `tmdb-dtos.ts`: `TmdbWatchProviderListEntry` / `TmdbWatchProviderListResponse`.
- `tmdb-mappers.ts`: `mergeCatalogProviders(movie, tv)` (dedupe by `providerId`,
  `logoPath: logo_path ?? null`, sorted by name) — pure, the priority test surface.
- `tmdb-client.ts`: `getRegionWatchProviders(region)` (two `core.request` calls,
  `watch_region` query, 404→[] per-side / null only if both 404).
- Barrel-export `getRegionWatchProviders` on the client interface (already
  exported via `TmdbClient`).
- Extend the mapper + client specs: merge/dedupe/sort; movie-only, tv-only, both,
  neither (both-404 → null); a duplicate provider in both lists appears once.
- Update `libs/functions/sync-titles/README.md` (new client method).
- Files: `libs/functions/sync-titles/src/lib/tmdb/tmdb-dtos.ts`,
  `libs/functions/sync-titles/src/lib/tmdb/tmdb-mappers.ts`,
  `libs/functions/sync-titles/src/lib/tmdb/tmdb-client.ts`,
  `libs/functions/sync-titles/src/lib/tmdb/*.spec.ts` (the mapper + client specs),
  `libs/functions/sync-titles/README.md`.

**T4 — apps/functions: `getWatchProviders` callable + cache-refresh core + tests [sequential, after T2 + T3]** (backend-engineer)

- Add `runGetWatchProviders` (SDK-agnostic core: validate uid + region, cache
  read w/ 7-day staleness, refetch + rewrite, stale-cache-preferred-over-throw).
- Add the `getWatchProviders` `onCall` wiring (`secrets: [TMDB_READ_TOKEN]`, same
  `cors`, `createTmdb` factory) and export it from the deployable barrel.
- Extend `apps/functions` specs (fake `db` + fake TMDB client + injected `now`):
  fresh cache → returns cached, no fetch; stale/absent → fetches + writes +
  returns; unknown region → `invalid-argument`; missing uid →
  `unauthenticated`; TMDB `null` with no cache → `unavailable`; TMDB `null` with
  a stale cache → returns the stale providers; cache-write failure → still returns
  the fetched providers.
- Update `apps/functions/README.md` (new callable) only if it enumerates functions.
- Run `pnpm nx run functions:deploy-preflight` (a new exported function is a
  deploy-surface change — verify gen2 discovery still loads `main.js`).
- Files: `apps/functions/src/main.ts`,
  `apps/functions/src/*.spec.ts` (the callable spec — new or extend main spec),
  `apps/functions/README.md` (only if it lists functions).

**T5 — Shell: provide `GET_WATCH_PROVIDERS` [parallel, after T1]** (frontend-engineer)

- `app.config.ts`: add the `GET_WATCH_PROVIDERS` provider (httpsCallable
  `getWatchProviders`, europe-west1 `Functions` already provided).
- No test file for the config wiring itself (consistent with the existing
  `TRIGGER_SYNC` provider — it's exercised by the e2e / manual serve).
- Files: `apps/mobile/src/app/app.config.ts`.

**T6 — Settings: "My Providers" multi-select + region prune + mock + tests [parallel, after T1/T2; runtime needs T5 for emulator]** (frontend-engineer)

- `settings.service.ts`: inject `GET_WATCH_PROVIDERS`; add `providerCatalog` /
  `myProviderIds` / `catalogLoading` signals; `loadProviderCatalog()`;
  `toggleProvider()`; read `myProviderIds` in `load()`; add `myProviderIds: []` to
  the eager-create `User` literal (required field — verify it compiles). Extend
  `setRegion` with the prune + dropped-count feedback.
- `settings.providers.mock.ts`: mirror the new surface (seeded catalog +
  `myProviderIds`), update the doc comment.
- `settings.page.ts`: `onProviderToggle`, `ngOnInit` catalog load, region-change
  toast via `ToastController`, register new icons.
- `settings.page.html`: the "My Providers" card (chip grid + footer) per the UI
  contract, placed between Region and the notification cards.
- `settings.page.scss`: chip grid styling using `--vultus-*` / `--ion-*` vars only.
- Update `libs/mobile/settings/README.md`.
- Extend `settings.service.spec.ts` (toggle add/remove persists the array;
  load reads `myProviderIds`; eager-create default `[]`; region change prunes +
  reports dropped count; catalog-load failure skips the prune; null-uid guards)
  and `settings.page.spec.ts` (chips render from catalog, tap calls toggle,
  selected chip reflects `myProviderIds`).
- Files: `libs/mobile/settings/src/lib/settings.service.ts`,
  `libs/mobile/settings/src/lib/settings.service.spec.ts`,
  `libs/mobile/settings/src/lib/settings.providers.mock.ts`,
  `libs/mobile/settings/src/lib/settings.page.ts`,
  `libs/mobile/settings/src/lib/settings.page.html`,
  `libs/mobile/settings/src/lib/settings.page.scss`,
  `libs/mobile/settings/src/lib/settings.page.spec.ts`,
  `libs/mobile/settings/README.md`.

**T7 — Watchlist: partitioned availability pill + tests [parallel, after T1/T2]** (frontend-engineer)

- `watchlist.service.ts`: add `myProviderIds$(uid)` (reuse/extend the `users/{uid}`
  `docData` stream; avoid a duplicate listener).
- `watchlist.page.ts`: add the memoized partitioned-pill stream (mine / elsewhere
  / null) keyed by `tmdbId|region`, combining `RegionAvailability.providers`
  (flatrate only) with `myProviderIds$`; expose the accessor the template binds.
- `watchlist.page.html`: replace the two `getProviderName$` badge blocks (planned +
  non-planned) with the single partitioned pill.
- `watchlist.page.scss`: the two pill variants (mine / elsewhere) using tokens only.
- Update `libs/mobile/watchlist/README.md` (the availability-framing behaviour).
- Extend `watchlist.page.spec.ts` / a pure-partition unit test: a flatrate
  provider in `myProviderIds` → "mine" pill + "On X"; only non-mine flatrate →
  "elsewhere" + "Also on X"; no flatrate → no pill; rent/buy-only → treated as no
  flatrate → no pill.
- Files: `libs/mobile/watchlist/src/lib/watchlist.service.ts`,
  `libs/mobile/watchlist/src/lib/watchlist.page.ts`,
  `libs/mobile/watchlist/src/lib/watchlist.page.html`,
  `libs/mobile/watchlist/src/lib/watchlist.page.scss`,
  `libs/mobile/watchlist/src/lib/watchlist.page.spec.ts`,
  `libs/mobile/watchlist/README.md`.

**T8 — Title-detail: two-group split (all providers) + tests [parallel, after T1/T2]** (frontend-engineer)

- `title-detail.service.ts`: add `myProviderIds$()` (read `users/{uid}.myProviderIds`).
- `title-detail.page.ts`: fold `myProviderIds` into `vm$`; add the pure
  `partitionProviders(providers, myProviderIds): { mine; elsewhere }` helper —
  `mine` = **flatrate** providers whose `providerId ∈ myProviderIds`; `elsewhere`
  = every other provider (non-mine flatrate + all rent + all buy). Each provider
  keeps its `type` for the per-row caption.
- `title-detail.page.html`: replace the old separate flatrate/rent/buy blocks with
  the single "Where to Watch" card containing the two subgroups ("On Your
  Providers" / "Also Available On"), each row rendering logo + name (+ "Yours" tag
  on mine rows) + type caption ("Subscription" / "Rent/Buy") + the decorative
  `open_in_new`-equivalent trailing glyph. Leave room below for the spec-0061
  Personal Tracking group (do NOT build it). **No external navigation on the row.**
- `title-detail.page.scss`: the card, subgroup labels, "Yours" tag, per-row
  layout, and the `surface-container` → `surface-container-high` hover raise using
  `--vultus-*` / `--ion-*` vars only.
- Update `libs/mobile/title-detail/README.md`.
- Extend `title-detail.page.spec.ts` / partition unit test: flatrate-mine present
  → "On Your Providers" subgroup lists it with a "Yours" tag + "Subscription"
  caption; non-mine flatrate + rent + buy → all under "Also Available On" with
  correct type captions; a rent/buy provider whose id happens to be in
  `myProviderIds` still lands under "Also Available On" (never `mine`); mine-only →
  only "On Your Providers"; none-mine → only "Also Available On"; no providers at
  all → neither subgroup (existing empty copy unchanged); order is mine-group first.
- **Visual-verify against Stitch `562019f29ce2412d90c757a7e45a98bf`** (fetch raw
  HTML + screenshot-compare via `mobile:serve-mock`); flag unverified for a human
  only if `mobile:serve-mock` can't run (standard fallback — this screen is
  verified in Stitch, no title-detail-specific gap).
- Files: `libs/mobile/title-detail/src/lib/title-detail.service.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.page.ts`,
  `libs/mobile/title-detail/src/lib/title-detail.page.html`,
  `libs/mobile/title-detail/src/lib/title-detail.page.scss`,
  `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`,
  `libs/mobile/title-detail/README.md`.

**T9 — e2e: provider-preferences flow + seed [sequential, after T6/T7]** (frontend-engineer / qa)

- Extend the seeded fixture (`apps/mobile-e2e/emulator-data/seeded/docs.json`):
  add `myProviderIds` to `users/{uid}`, add a `provider-catalog/NL` doc, and
  ensure the seeded watchlist has a title whose `availability/NL` flatrate
  includes a selected provider AND a title whose flatrate includes only a
  non-selected provider (add availability docs as needed — mirror how 0046/0054
  seed availability).
- Add `apps/mobile-e2e/src/provider-preferences.spec.ts` covering the two named
  assertions (see Test plan). Route TMDB via the existing `routeTmdb` fixtures if
  the catalog callable is exercised; if the flow only reads seeded Firestore +
  the pre-seeded catalog, no TMDB route is needed for the availability assertions.
- Files: `apps/mobile-e2e/src/provider-preferences.spec.ts`,
  `apps/mobile-e2e/emulator-data/seeded/docs.json` (+ availability fixtures under
  `emulator-data/seeded/` if separate).

**Disjointness (for the parallel fan-out):** after T1/T2, the parallel-eligible
tasks write disjoint manifests — T3 `libs/functions/sync-titles/**`, T5
`apps/mobile/src/app/app.config.ts`, T6 `libs/mobile/settings/**`, T7
`libs/mobile/watchlist/**`, T8 `libs/mobile/title-detail/**`. T4 (`apps/functions/**`)
is sequential after T3+T2. T9 (`apps/mobile-e2e/**`) is sequential after T6+T7.
T5's single-file manifest is disjoint from all others.

## Test plan

Per the PLAN §5 pyramid — unit (domain/converter/mapper/callable core), component
(settings, watchlist, title-detail pages), e2e (one named flow). All Firebase
access in unit/component tests is mocked; no emulator (project memory: the
emulator cannot run under Claude Code tools here — the e2e gate runs in CI).

**Unit (shared/domain + firestore-schema):**

- `CatalogProvider` / `ProviderCatalogDoc` / `myProviderIds` compile; the `_user`
  literal (with `myProviderIds`) is a compile-time gate.
- Converter round-trip (`firestore-schema.spec.ts`): a `User` with a populated
  `myProviderIds` round-trips; with `[]` round-trips; a **legacy doc omitting it →
  `[]`** via `dataToUser`. A `ProviderCatalogDoc` round-trips (`lastSyncedAt`
  ISO↔Timestamp, providers unchanged). `providerCatalogDocPath('NL')` ===
  `'provider-catalog/NL'`.

**Unit (functions/sync-titles):**

- `mergeCatalogProviders`: movie+tv merge; **dedupe by `providerId`** (a provider
  in both lists appears once); `logoPath` maps `logo_path ?? null`; sorted by
  name; movie-only, tv-only, and empty inputs.
- `getRegionWatchProviders`: both endpoints resolve → merged; one 404 → the other
  side only; both 404 → `null`; token stays in the header (never in url/logs).

**Unit (apps/functions — `getWatchProviders` core, fake `db` + fake TMDB + injected `now`):**

- Fresh cache (age ≤ 7d) → returns cached providers, **TMDB not called**.
- Absent cache → fetches, **writes** `provider-catalog/{region}`, returns fetched.
- Stale cache (age > 7d) → refetches + rewrites + returns fresh.
- Unknown region → `HttpsError('invalid-argument')`; missing uid →
  `HttpsError('unauthenticated')`.
- TMDB returns `null` **and no cache** → `HttpsError('unavailable')`.
- TMDB returns `null` **with a stale cache** → returns the stale providers (no throw).
- Cache-write failure → still returns the fetched providers (best-effort write).

**Component (settings — `settings.page.spec.ts`, mocked service):**

- The "My Providers" chips render from `service.providerCatalog()`; a selected chip
  (id ∈ `myProviderIds`) shows the selected styling/badge, an unselected one the
  muted styling; tapping a chip calls `onProviderToggle` → `toggleProvider`.
- The footer count reflects `myProviderIds.length` / catalog length.
- Existing settings assertions (region, notifications, delivery-hour, render-gate,
  error state) stay green.

**Unit (settings — `settings.service.spec.ts`, mocked `GET_WATCH_PROVIDERS` + Firestore):**

- `toggleProvider` adds an absent id / removes a present id and persists the whole
  `myProviderIds` array; `load()` reads it (default `[]`); eager-create writes `[]`.
- `setRegion` prunes `myProviderIds` to the new catalog and reports the dropped
  count; a catalog-load failure **skips** the prune (data preserved).
- `loadProviderCatalog` calls the thunk once per region and populates the signal;
  null-uid guards on the write paths.

**Component (watchlist — `watchlist.page.spec.ts`, mocked service):**

- A flatrate provider ∈ `myProviderIds` → the "mine" pill ("On X", check icon,
  primary styling); only non-mine flatrate → the "elsewhere" pill ("Also on X",
  muted); no flatrate (incl. rent/buy-only) → no pill. Existing card assertions
  (poster, title, status chip, delete) stay green.

**Component (title-detail — `title-detail.page.spec.ts`, mocked service):**

- A flatrate provider ∈ `myProviderIds` → the "On Your Providers" subgroup lists
  it (bold name + "Yours" tag + "Subscription" caption); non-mine flatrate + rent
  - buy providers → all under "Also Available On" with correct type captions
    (flatrate → "Subscription", rent/buy → "Rent/Buy"); mine-only → only "On Your
    Providers"; none-mine → only "Also Available On"; mixed → both, mine first; no
    providers → neither subgroup (existing empty copy unchanged). The decorative
    trailing glyph triggers **no navigation** (no click handler / href).
- Pure `partitionProviders` unit tests: flatrate-mine → `mine`; non-mine flatrate,
  rent, buy → `elsewhere`; a rent/buy provider whose id is in `myProviderIds`
  stays in `elsewhere` (only flatrate can be `mine`); empty input → both empty.

**e2e (rubric): REQUIRED — one new flow.** This is a `scope:mobile` feature
introducing a new primary user-facing control (the Settings "My Providers"
multi-select is a new interactive settings sub-feature that persists state) and a
new critical availability signal on the watchlist. Per the rubric, name the flow:

- **`provider-preferences.spec.ts` — "shows on-your-provider vs also-on framing"**:
  seed `users/{uid}` with `myProviderIds` (≥1 provider) + a `provider-catalog/NL`
  doc + two watchlist titles with `availability/NL` (one flatrate on a selected
  provider, one flatrate on a non-selected provider). (a) On the watchlist, the
  title covered by a selected provider shows the highlighted **"On {provider}"**
  pill; (b) the title on a non-selected provider shows the muted **"Also on
  {provider}"** pill. (Optionally, if practical against the seeded catalog: open
  Settings, toggle a provider chip, and assert the watchlist pill flips — but the
  two assertions above are the required gate; the toggle round-trip can be
  `test.fixme` with a comment naming the concrete blocker: toggling a chip calls
  `getWatchProviders`, which requires the callable itself to be deployed into the
  emulator's Functions runtime (not just Firestore-seeded), which the other e2e
  specs in this suite don't currently exercise — if that's not already wired up
  for `apps/mobile-e2e`, `test.fixme` it rather than adding new emulator-functions
  plumbing as a side quest of this spec.)

Extend the seed per T9; reuse the `apps/mobile-e2e` emulator + TMDB-fixture
conventions (specs 0046/0054). This flow is a DoD gate enforced by `qa-runner` /
`feature-reviewer`. The Firestore emulator runs in CI (project memory
`ci-runs-e2e-emulator.md`), not under Claude Code tools locally.

## Definition of done

Tailored from PLAN §5. Affected: `shared-domain`, `shared-firestore-schema`,
`functions-sync-titles`, `functions`, `mobile-settings`, `mobile-watchlist`,
`mobile-title-detail`, `mobile` (shell), `mobile-e2e`.

- [ ] `pnpm nx typecheck` passes for all affected projects — `myProviderIds`,
      `CatalogProvider`, `ProviderCatalogDoc`, the `GET_WATCH_PROVIDERS` token,
      the converter, the client method, the callable, and the three slice UIs
      compile; the `_user` literal gate holds.
- [ ] `pnpm nx lint <affected>` passes **with Sheriff active**: no slice imports
      another slice; the partition logic stays duplicated per slice (2 slices, not
      extracted); settings reaches the callable only via `GET_WATCH_PROVIDERS`; no
      `scope:mobile` ↔ `scope:functions` edge; the TMDB client stays Firebase-free.
- [ ] `pnpm nx test shared-firestore-schema` — `myProviderIds` (populated/empty/
      missing→[]) + provider-catalog round-trip + path builders.
- [ ] `pnpm nx test functions-sync-titles` — `mergeCatalogProviders` +
      `getRegionWatchProviders` (merge/dedupe/sort/404 cases).
- [ ] `pnpm nx test functions` — `getWatchProviders` core (cache-hit/miss/stale,
      region + auth validation, TMDB-null-with/without-cache, write-failure).
- [ ] `pnpm nx test mobile-settings` — provider chips + toggle + region-prune +
      catalog-load service tests; existing settings tests stay green.
- [ ] `pnpm nx test mobile-watchlist` — mine/elsewhere/none partition pill.
- [ ] `pnpm nx test mobile-title-detail` — two-group split (all providers) +
      `partitionProviders` (flatrate-mine → mine; non-mine flatrate/rent/buy →
      elsewhere; rent/buy id-in-`myProviderIds` stays elsewhere).
- [ ] `pnpm nx build mobile` and `pnpm nx build functions` pass, and
      `pnpm nx run functions:deploy-preflight` passes (a **new exported callable**
      is a deploy-surface change — verify gen2 discovery loads `main.js`).
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green.
- [ ] **e2e:** `provider-preferences.spec.ts` passes in CI against the emulator
      (the required "on-your-provider vs also-on" flow); the fixture seeds
      `myProviderIds` + `provider-catalog/NL` + the two availability docs. (Runs in
      CI, not under Claude Code tools locally — project memory.)
- [ ] **`firestore.rules`:** a `provider-catalog/{region}` rule (authenticated
      read, client write denied) is added, mirroring `title-cache`. No
      `firestore.indexes.json` change (single-doc reads).
- [ ] **Stitch screens re-fetched + recorded in the PR (all three verified):**
      Settings `cebdfd02c7d44023b0e0019dd4907d48` (the NEW fork), Advanced
      Watchlist `19f0eae3d6d24eaa90b3aa73ff44a59b`, and title-detail
      **`562019f29ce2412d90c757a7e45a98bf`** ("Movie Detail - Personal Tracking -
      Vultus", the canonical consolidated screen) — all fetched raw +
      screenshot-compared. Do **not** pull the superseded `208cb8d7a679490b8d13672c6943d6d3`
      or `dfc2c7b98a9f46d2bff9b7722fd192b7`. A failed MCP call is a retry, not
      token-only.
- [ ] **UI fidelity verified** (`mobile:serve-mock` / screenshots) for the Settings
      card, the watchlist pills, **and** the title-detail two-group split, **or
      explicitly flagged unverified for a human** if `mobile:serve-mock` can't run
      — a green build does not prove fidelity (CLAUDE.md). All three screens have a
      rendered Stitch reference; the title-detail split gets the **standard**
      screenshot-compare treatment (no title-detail-specific unverified exception).
- [ ] No hard-coded hex in any new template/SCSS — only `--vultus-*` / `--ion-*`
      vars.
- [ ] READMEs updated: `shared/domain`, `shared/firestore-schema`,
      `functions/sync-titles`, `mobile/settings`, `mobile/watchlist`,
      `mobile/title-detail` (and `apps/functions` if it lists functions).
- [ ] **Boundary verifications (review-checked):** (a) `myProviderIds` is an open
      `number[]` (no enum) — 0061-ready; (b) legacy `users/{uid}` docs missing
      `myProviderIds` read as `[]`; (c) the callable never overwrites a usable
      stale cache on a TMDB failure; (d) the region-prune never destroys data on a
      failed catalog load; (e) no secret read/written on the mobile side; the
      callable reads only `TMDB_READ_TOKEN` via `.value()`; (f) the partition logic
      is duplicated per slice, not extracted (2-slice rule).
- [ ] PR description records: verification commands, the three canonical screen
      ids (`cebdfd02…`, `19f0eae3…`, `562019f2…`) + their visual-verification
      results, the boundary confirmations, and that the e2e flow is included.

## Risks

- **Title-detail "Where to Watch" split — previously unverified, now RESOLVED.**
  Earlier drafts flagged this section unverified because three `edit_screens`
  pushes to the old "Movie Detail - Vultus" screen (`208cb8d7a679490b8d13672c6943d6d3`)
  timed out and never rendered, leaving the tokens extrapolated from a sibling
  screen. The Stitch project has since been cleaned up (four duplicate/divergent
  detail pages consolidated) into the canonical **"Movie Detail - Personal
  Tracking - Vultus"** (`562019f29ce2412d90c757a7e45a98bf`), which **renders the
  card in full context**. The section is now pinned from that real render (it
  revealed the richer per-row structure and that "Also Available On" spans rent/buy
  — see the supersession note in Context). **No residual verification gap** — the
  title-detail screen gets the same standard screenshot-compare as the others. The
  old `208cb8d…` and intermediate `dfc2c7b9…` screens are superseded/stale and
  must not be pulled.
- **`open_in_new` in the mock is decorative, not a feature.** The canonical
  screen's provider rows show a trailing `open_in_new` glyph and a hover raise.
  There is **no per-provider deep-link URL in this app's model** and the issue
  never requested external navigation, so the glyph is a presentational affordance
  only. Risk: an implementer scope-creeps a "open provider" link. Mitigation: the
  UI section (C) explicitly forbids adding navigation/`href`/click handlers; the
  component test asserts no navigation is triggered.
- **TMDB watch-provider accuracy (PLAN §9).** The whole feature rests on TMDB's
  JustWatch-powered availability, which has known accuracy gaps for licensed
  content — a title wrongly reported (or not reported) on a provider will
  mis-frame the "On your provider" pill. This is the same data-source risk the app
  already carries for the existing provider badge; the framing inherits it. No new
  mitigation; accepted for v1 (Watchmode remains the layered fallback per PLAN §9).
- **Provider catalog vs per-title provider-id mismatch.** The `myProviderIds`
  match is by TMDB `providerId`, which is consistent across the catalog endpoint
  and the per-title `watch/providers` endpoint (both JustWatch/TMDB provider ids),
  so the equality check is sound. If TMDB ever diverged these id spaces the match
  would silently fail (no crash, just no "mine" pills) — flagged so a reviewer
  knows the join key. The dedupe-by-id in `mergeCatalogProviders` assumes the same.
- **Region-change prune is destructive-adjacent.** Pruning `myProviderIds` on a
  region change permanently drops ids not in the new catalog; switching back later
  won't restore them (the user re-selects). This is the accepted UX (decision 3) —
  keeping stale ids makes the footer count lie and the ids match nothing. The
  guard (skip prune on a failed catalog load) prevents the worst case (wiping
  selections because the catalog momentarily failed to load). Flagged as a
  deliberate, bounded data loss with a toast.
- **7-day cache staleness is a coarse choice.** A provider added to a region
  mid-week won't appear in the picker until the cache refreshes (≤7 days) or a
  region change forces a refetch. Acceptable: the region catalog changes rarely,
  and the callable is the only refresh path (no daily-sync coupling by design). If
  it proves too stale in practice, shorten the window (a one-line change).
- **New Cloud Function = deploy-surface change.** `getWatchProviders` must survive
  gen2 discovery (`functions:deploy-preflight`) and needs the same public-invoker
  / CORS treatment as `triggerSync` when deployed (project memory
  `syncTitles-public-invoker.md` / `functions-deploy-pnpm-recipe.md`). Callables
  are invoked with a Firebase Auth token, so the `unauthenticated` guard is the
  gate; the CORS array must include the Capacitor `http://localhost` origin (reuse
  `triggerSync`'s list verbatim) or the native app's call is blocked.
- **No PLAN conflict.** `provider-catalog/{region}` is a new global,
  function-written cache in the exact mold of `title-cache` (PLAN §4);
  `myProviderIds` is an additive `users/{uid}` field; `CatalogProvider` extends the
  `shared/domain` vocabulary additively. The callable mirrors `triggerSync`. The
  availability framing consumes existing `RegionAvailability` data unchanged. All
  within PLAN §1's "show which platform a title is on for the user's region" scope,
  refined to "and whether it's a platform you pay for."
