---
number: 0073
slug: plex-sync
title: One-way Plex → Vultus sync (library additions + watch status)
status: approved
slices: [slice:settings]
scopes: [scope:mobile, scope:shared]
created: 2026-07-03
---

# One-way Plex → Vultus sync (library additions + watch status)

## Context

GitHub #171: "when a movie or tv show gets added in plex it also gets added in
vultus and when a movie or tv show episode has been watched the status in vultus
also gets updated."

Today Plex is a **manual, presentation-only** flag (spec 0061): the user
hand-tags a title as "watching via Plex" from title-detail and lights up a badge;
nothing is read from the user's actual Plex Media Server (PMS). #171 asks for the
inverse — an **automatic, one-way import** from the user's self-hosted PMS into
Vultus: new PMS library items become watchlist entries, and PMS watch state
drives Vultus's `status` + episode-watched machinery.

This composes with 0061 rather than replacing it. 0061 introduced two persisted
booleans — `users/{uid}.hasPlex` (the settings-level "I use Plex" flag) and
`users/{uid}/watchlist/{titleId}.watchingViaPlex` (the per-title Plex tag). This
spec **reuses both**: linking a server sets `hasPlex: true`, and every title this
sync engine adds/touches carries `watchingViaPlex: true`, so 0061's badges and
"Watching via Plex" row light up for synced titles with **zero new
presentation** work.

The whole feature is **on-device, LAN, `scope:mobile` + `scope:shared` only** —
the mobile app talks directly to the user's PMS over the local network. **No
Cloud Function changes**, no `scope:functions` edits, no server-side polling.

### Locked decisions (from the architect interview — do NOT re-litigate)

1. **On-device LAN sync.** The mobile app talks directly to the PMS; there is no
   backend involvement. Pure `scope:mobile` + additive `scope:shared` vocabulary.
2. **Auth: plex.tv PIN-link flow.** App requests a PIN (`POST
https://plex.tv/api/v2/pins`), shows the 4-char code, the user enters it at
   `plex.tv/link`, the app polls `GET https://plex.tv/api/v2/pins/{id}` until an
   `authToken` appears. The resulting **X-Plex-Token is stored ON-DEVICE ONLY via
   `@capacitor/preferences`** (installed, v8.0.1) — **NEVER in Firestore** (see
   Risks re: Preferences vs Keystore — accepted tradeoff for a personal
   single-user app). Server discovery via `GET
https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=0`, preferring a
   local-network connection URI (`connections[].local === true`).
3. **All Plex HTTP via `CapacitorHttp`** (`@capacitor/core` 8.4.0, installed) —
   the PMS sends no CORS headers, so webview `fetch` fails; native HTTP bypasses
   CORS. **Consequence:** the real client works only on-device; web builds /
   unit / component / e2e run against a **mock client** (see Test plan).
4. **Sync triggers:** app open (boot) + foreground resume (`@capacitor/app`
   8.1.0, installed). No background sync, no push.
5. **Sync cursor + link metadata live on `users/{uid}` in Firestore** (a
   multi-device-safe cursor; the token itself is per-device in Preferences). The
   field is `plexSync` — modelled **OPTIONAL/nullable** on the domain type with a
   `?? null` converter coalesce (the `deliveryHour` 0051 pattern) to MINIMIZE the
   shared-type ripple (§5, F2). Do NOT add a required top-level field to `User`.
6. **Additions are cursor-based ("events only").** Items in ALL movie + TV
   library sections with Plex `addedAt` > cursor, matched via `tmdb://` GUID →
   create a watchlist doc `status: "planned"`, `watchingViaPlex: true`,
   `traktId: null`. GUID-less items (legacy Plex agents) are **skipped** (counted,
   never fuzzy-matched). At link time the cursor initializes to link time — **no
   library backfill**.
7. **Watched-state is a full mirror for matched titles** (NOT cursor-gated):
   movies with `viewCount > 0` → `status: "completed"`; shows → per-episode
   `viewCount` mirrored to episode docs (`watched: true`, `watchedAt` = Plex
   `lastViewedAt`); only Plex's own watched flag counts (no `viewOffset` /
   in-progress handling). Episode/status interplay follows the EXISTING
   0034/0050/0053 machinery (§5) — the mirror writes episodes and lets the
   existing derivation flip status; it does not reinvent it.
8. **Watch-implies-add:** a watched Plex item with a TMDB GUID NOT on the
   watchlist is added — movie → `completed`, show → `watching` (+ episode
   mirror), both `watchingViaPlex: true`, `traktId: null`.
9. **Conflict rules — one-way, Plex wins for watched state, EXCEPT `dropped` is
   sticky:** a `dropped` title still receives episode watched/`watchedAt` mirror
   data, but its `status` is **never** auto-changed. Stated as an explicit
   invariant with a unit test (§8).
10. **Unlink/disconnect** clears the device token (Preferences) + the Firestore
    `plexSync` metadata, KEEPS all synced watchlist/episode data, does NOT touch
    `hasPlex`. **Linking sets `hasPlex: true`** (0061's flag).
11. **Perf guardrails:** paged library queries (`X-Plex-Container-Start/Size`), a
    per-sync item budget, episode-level queries only for shows needing the
    mirror, and a concurrent-sync guard (a resume during an active sync is a
    no-op).
12. **The ENTIRE feature lives in `slice:settings` (`libs/mobile/settings`)** +
    additive `scope:shared` vocabulary (see §3 for the reasoning). The Connect
    Plex page is a settings-owned subroute (`/tabs/settings/plex`); the Plex
    client + sync engine are settings-slice services; the app shell wires the
    boot/resume trigger by consuming a `scope:shared` token the shell provides
    (the shell is the composition root — same pattern as `AUTH_UID` /
    `TRIGGER_SYNC` / `GET_WATCH_PROVIDERS` and the `NotificationHandlerService`
    boot hook).
13. **Reuse the bundled Plex logo** `apps/mobile/public/assets/plex-logo.svg`
    (added by 0061) by URL path — no new asset, no hard-coded brand hex anywhere.

## Scope

In scope:

- **`plexSync` metadata** on `users/{uid}` (`@vultus/shared/domain`), OPTIONAL /
  nullable, carrying the sync cursor + link info; converter coalesce `?? null`;
  READMEs. (No `_user` assertion-literal change needed — see §5.)
- A **`PlexClient` abstraction** (settings slice) with a `scope:shared`
  injection token `PLEX_CLIENT` provided by the shell: the real impl uses
  `CapacitorHttp`; a deterministic **mock** impl is selected on non-native
  platforms (web / dev-server / e2e / serve-mock). PIN-link, resources discovery,
  paged library + episode reads.
- A **`PlexLinkService`** (settings slice) owning the PIN-link state machine,
  token persistence (Preferences), server discovery, unlink, and the
  `hasPlex` + `plexSync` writes.
- A **`PlexSyncService`** (settings slice) owning the additions cursor logic,
  GUID matching, the watched-state mirror, watch-implies-add, the sticky-`dropped`
  invariant, the concurrent-sync guard, and the direct watchlist/episode Firestore
  writes via `@vultus/shared/firestore-schema` converters.
- The **Plex Server card** in the Settings page (`libs/mobile/settings`) between
  "My Providers" and "Notification Preferences": disconnected row (→ connect
  page), connected block ("Sync now" / "Disconnect").
- The **Connect Plex page** — a settings-owned pushed subroute
  (`/tabs/settings/plex`) with the three-stage state machine.
- **App-shell boot/resume trigger** (`apps/mobile`) importing the `scope:shared`
  `PLEX_SYNC_TRIGGER` token the shell wires over the settings slice's sync
  service.
- Mock providers mirrored (`settings.providers.mock.ts` extends to seed a
  linked/mock-synced state); unit + component + e2e tests; READMEs.

Out of scope (explicitly):

- **Vultus → Plex writes** (strictly one-way; Vultus never marks anything in
  Plex).
- **Plex webhooks / cloud polling / background sync** (triggers are boot +
  resume only).
- **Library backfill at link** (the cursor starts at link time; only future
  additions flow in).
- **Plex availability data** (Vultus keeps using TMDB availability; Plex is not
  an availability source — same constraint 0061 documented).
- **Multi-server selection UI** — use the first **owned** server from
  `resources` (pin: filter `owned === true`, prefer a local connection; if none
  owned, the first server with a local connection). No picker.
- **In-progress / partial-watch handling** (`viewOffset`) — only Plex's own
  watched threshold (`viewCount > 0` / episode `viewCount`) counts.
- **Notifications about Plex events**, **any `scope:functions` change**, and
  **Keystore-backed secure token storage** (Preferences is the accepted store —
  see Risks).

## Affected slices & Sheriff tags

| Project                        | Path                           | Sheriff tags                     | Change                                                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared-domain (edit)           | `libs/shared/domain`           | `scope:shared`                   | **add** `plexSync?: PlexSyncMeta \| null` to `User`; **add** the `PlexSyncMeta` interface; **add** the `PLEX_CLIENT` + `PLEX_SYNC_TRIGGER` DI tokens to the `tokens` entrypoint; README                                                                                                         |
| shared-firestore-schema (edit) | `libs/shared/firestore-schema` | `scope:shared`                   | `userToData` / `dataToUser` carry `plexSync` (write pass-through; read `?? null`); `UserReadData` / `UserWriteData` gain `plexSync?`; tests; README                                                                                                                                             |
| mobile-settings (edit)         | `libs/mobile/settings`         | `scope:mobile`, `slice:settings` | `PlexClient` (real CapacitorHttp + mock), `PlexLinkService`, `PlexSyncService` (all `providedIn: 'root'`); the Plex Server card in `settings.page`; the new `PlexConnectPage`; barrel exports; mock mirror; specs; README                                                                       |
| mobile (edit)                  | `apps/mobile`                  | `scope:mobile`                   | register the `/tabs/settings/plex` child route; provide `PLEX_CLIENT` (native→real, else mock — the ONLY selection mechanism, no `project.json` `fileReplacements`) + `PLEX_SYNC_TRIGGER` factories in `app.config.ts`; call the trigger on boot + `@capacitor/app` resume in the shell (`App`) |
| mobile-e2e (edit)              | `apps/mobile-e2e`              | untagged                         | new `plex-sync.spec.ts` (connect flow + sync-outcome flow); the two flows drive the mock client + seeded Firestore                                                                                                                                                                              |

**Reasoning for the single-slice placement (locked decision 12).** The Stitch
settings design (`0e2bb1f198f04186b39e4a2604413417`) puts the interactive Plex
Server card (Connect row / connected state / "Sync now" / "Disconnect") **inside
the settings page**, and Sheriff forbids cross-slice imports. A separate
`slice:plex` would force either a shared communication lib (unjustified — the
3+-slice extract rule is not met) or moving the card's actions out of settings
(violating the UI contract). Plex linking is semantically a settings capability
(like notification prefs / providers, and it already owns `hasPlex`). So the Plex
client + sync engine are settings-slice services, and the sync engine writes
watchlist/episode docs **directly via `@vultus/shared/firestore-schema`
converters** — data-level cross-slice communication, exactly as 0061's
title-detail writes to the watchlist doc and the sync engine's episode writes
already do (they do not import `slice:watchlist` / `slice:title-detail`).

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (specs 0010/0012/0051).
  Every touched project already carries its tag; **this spec does NOT edit
  `sheriff.config.ts`**. `libs/mobile/settings/src` is `scope:mobile` +
  `slice:settings`; `apps/mobile` is `scope:mobile`; `libs/shared/*/src` is
  `scope:shared`.
- **No cross-slice imports.** The settings slice obtains the uid via the
  `scope:shared` `AUTH_UID` token, the Plex client via the new `scope:shared`
  `PLEX_CLIENT` token, and writes watchlist/episode docs by PATH via the shared
  `firestore-schema` converters — it never imports `slice:watchlist` /
  `slice:title-detail`. The shell provides the tokens (composition root), same as
  0025/0060.
- **No `scope:functions` edge.** No callable, no HTTP function, no shell secret,
  no `@angular/fire/functions` in the sync path. `sync-titles`,
  `dispatch-notifications`, `sync-episodes`, and `apps/functions` are untouched
  (verified: no functions source constructs a full `User` write literal — the
  only full-`User` constructions are the settings eager-create, onboarding, mock,
  and the domain/schema test literals; see §5 F2).
- **`shared/` additions are additive vocabulary only** (`PlexSyncMeta`, the
  `plexSync` coalesce, two DI tokens) — the persisted-contract + shell-token
  pattern (like `myProviderIds`/`hasPlex` in 0060/0061, `deliveryHour` in 0051,
  `AUTH_UID`/`GET_WATCH_PROVIDERS`), not a logic extraction. The Plex protocol
  logic lives entirely in the settings slice.

## Data model touchpoints

PLAN §4 paths. New surface is **only** the `plexSync` object on `users/{uid}`,
plus writes to the EXISTING `users/{uid}/watchlist/{titleId}` docs and their
`episodes/{episodeId}` subcollection. **No new collection.**

| PLAN §4 path                                      | Access                     | By                                                                         |
| ------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `users/{uid}.plexSync`                            | read, update, delete-field | link service (init on link, `lastSyncAt` on each sync, cleared on unlink)  |
| `users/{uid}.hasPlex`                             | update (→ true on link)    | link service (reuses 0061's field; unlink does NOT clear it — decision 10) |
| `users/{uid}/watchlist/{titleId}`                 | read, create, update       | sync engine (create on add; update `status` / `watchingViaPlex`)           |
| `users/{uid}/watchlist/{titleId}/episodes/{epId}` | read, update               | sync engine (mirror `watched` / `watchedAt`; NEVER creates episode docs)   |

### `users/{uid}.plexSync` (additive, OPTIONAL/nullable)

- **Shape** (pin):

  ```ts
  export interface PlexSyncMeta {
    /** ISO 8601 — when the current device linked this server. */
    linkedAt: string;
    /** ISO 8601 — completion time of the last successful sync; null until the
     *  first sync completes after linking. THE ADDITIONS CURSOR: items with Plex
     *  `addedAt` newer than this are "new". Initialized to `linkedAt` at link
     *  time (no backfill). */
    lastSyncAt: string | null;
    /** Human-readable PMS name for the connected-state UI; null if unknown. */
    serverName: string | null;
  }
  ```

  On `User`: `plexSync?: PlexSyncMeta | null` — **optional and nullable**. Absent
  / `null` = never linked (or unlinked). This is deliberately NOT a required
  field: a required field would force every `User` write-literal in the repo to
  add it (the F2 ripple below), and there is no meaningful default for a cursor.

- **Cursor semantics.** The **additions** pass uses `plexSync.lastSyncAt` (falling
  back to `linkedAt`) as the lower bound on Plex `addedAt`. The **watched-mirror**
  pass is NOT cursor-gated (full mirror for matched titles). On successful sync
  completion the engine writes `plexSync.lastSyncAt = <now ISO>` (a nested
  field-path update `updateDoc(userPath(uid), { 'plexSync.lastSyncAt': iso })`,
  leaving `linkedAt` / `serverName` intact).
- **Converter coalesce.** `dataToUser` reads `data.plexSync ?? null`; `userToData`
  passes `user.plexSync ?? null` through unchanged (it is a plain nested object of
  ISO strings — no Timestamp mapping; mirrors how `notificationPrefs` passes
  through). A legacy doc lacking the field → `null` (the `deliveryHour ?? null`
  pattern, 0051).
- **Unlink** clears the field: `updateDoc(userPath(uid), { plexSync:
deleteField() })` (or `{ plexSync: null }` — pin `deleteField()` to keep the
  wire clean; either round-trips to `null` via the coalesce). Unlink does NOT
  touch `hasPlex` or any watchlist/episode doc (decision 10).

### Watchlist + episode writes (existing docs)

- **Add** (`status: 'planned'` for library additions; `'completed'` / `'watching'`
  for watch-implies-add): a `setDoc(watchlistItemPath(uid, tmdbId),
watchlistItemToData(item))` with `watchingViaPlex: true`, `traktId: null`,
  `type`, `tmdbId`, `title`, `addedAt: now`. This is the SAME shape/converter
  `TitleDetailService.add` uses today.
- **Status update** for an already-tracked matched title: reuse the existing
  status-derivation contract — a movie watched → `updateStatus(tmdbId,
'completed', 'movie')`; a show's episode mirror writes the episode docs and the
  status follows the existing 0050/0053 derivation (see §5). **Never** overwrite a
  `dropped` status (decision 9 — the engine reads the current status and skips the
  status write for `dropped`, exactly like `setMovieWatched`'s `if (status ===
'dropped') return`, but STILL writes episode mirror data).
- **Episode mirror:** `updateDoc(episodePath(uid, tmdbId, epId), { watched,
watchedAt })` on EXISTING episode docs only (the sync engine keyed by the same
  `s{NN}e{NN}` id `sync-titles`/`sync-episodes` writes). It **never creates**
  episode docs — a Plex-watched episode with no local doc yet is a no-op until the
  daily title/episode sync writes the doc (same "never create episode docs"
  invariant as `setEpisodeWatched` and `markAllEpisodesWatched`). Pin the matching
  key derivation from Plex `parentIndex` (season) + `index` (episode) → the
  `s{NN}e{NN}` id convention; skip episodes whose local doc is absent.

### Rules & indexes — NO change needed (verified)

- **`firestore.rules`: NO change.** Verified against the current
  `firestore.rules`: the `match /users/{userId} { allow read, write: if
isOwner(userId); match /{document=**} { allow read, write: if isOwner(userId) }
}` block already covers the `plexSync` field on the user doc AND every
  watchlist/episode subcollection write (spec 0004/0011). The Plex token is NOT
  in Firestore, so no rule guards it. **State this explicitly in the PR.**
- **`firestore.indexes.json`: NO change.** The engine reads/writes by document
  id (`userPath`, `watchlistItemPath`, `episodePath`) and reads the whole
  episodes subcollection one-shot — there is no `where(...)`/`orderBy(...)` query
  introduced, so no composite index. **State this explicitly.** (There IS a
  rules-test to run — see §8/§9 — but it asserts the EXISTING owner rule still
  covers the new field, not a new rule.)

## Public types / APIs

### Shared domain (additive)

`libs/shared/domain/src/lib/documents.ts` — add `PlexSyncMeta` and one OPTIONAL
field to `User`:

```ts
/** Per-user Plex sync cursor + link metadata (spec 0073). The X-Plex-Token is
 *  NOT stored here — it lives on-device in @capacitor/preferences. This holds
 *  only the multi-device-safe additions cursor + display info. Absent/null =
 *  never linked (or unlinked). */
export interface PlexSyncMeta {
  linkedAt: string; // ISO 8601
  lastSyncAt: string | null; // ISO 8601 — additions cursor; null until first sync
  serverName: string | null;
}

export interface User {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmToken[];
  myProviderIds: number[]; // spec 0060
  hasPlex: boolean; // spec 0061 — set true on Plex link (spec 0073)
  /** Plex sync cursor + link metadata (spec 0073). OPTIONAL/nullable so legacy
   *  docs and never-linked users need no migration; coalesced `?? null`. */
  plexSync?: PlexSyncMeta | null;
}
```

Barrel: export `PlexSyncMeta` from the domain `index.ts` (new named type). The
`_user` assertion literal in `type-assertions.ts` needs **no change** — an
optional field may be omitted and the literal still `satisfies User`. (Optionally
add a second `_userWithPlexSync` literal to prove the shape compiles; not
required for the gate.)

**DI tokens** (`libs/shared/domain/src/lib/tokens.ts`, the `@vultus/shared/domain/tokens`
entrypoint — where `AUTH_UID` / `TRIGGER_SYNC` / `GET_WATCH_PROVIDERS` live):

```ts
/** The Plex client, provided by the shell (real CapacitorHttp on native; a
 *  deterministic mock on web/dev/e2e). scope:shared so the settings slice
 *  injects it without importing apps/mobile. (spec 0073) */
export const PLEX_CLIENT = new InjectionToken<PlexClient>('PLEX_CLIENT');

/** A thunk the shell calls on boot + resume to run one Plex sync (no-op when
 *  not linked / not native / already running). scope:shared so the shell wires
 *  it over the settings slice's PlexSyncService without importing the slice
 *  the wrong way. (spec 0073) */
export const PLEX_SYNC_TRIGGER = new InjectionToken<() => Promise<void>>(
  'PLEX_SYNC_TRIGGER',
);
```

`PlexClient` is a `scope:shared` **interface** describing the PMS/plex.tv surface
(so both the real and mock impls, and the token, are typed without importing the
slice). Pin its shape in `libs/shared/domain` (structural, protocol-agnostic —
no CapacitorHttp import in shared):

```ts
export interface PlexPin {
  id: number;
  code: string; // the 4-char link code
  authToken: string | null; // null until authorized
}
export interface PlexServer {
  name: string;
  baseUrl: string; // resolved local-network connection URI
  accessToken: string; // server access token from resources
}
/** One library item as Vultus needs it: TMDB id parsed from the plex `tmdb://`
 *  GUID (null when GUID-less → skipped), plus addedAt + watch state. */
export interface PlexLibraryItem {
  type: 'movie' | 'tv';
  tmdbId: number | null; // null = GUID-less legacy agent → skip
  title: string;
  addedAt: string; // ISO 8601 (from Plex epoch seconds)
  viewCount: number; // movie/show-level; >0 = watched (movie)
  lastViewedAt: string | null; // ISO 8601 or null
  ratingKey: string; // Plex item id, for episode fetch
}
export interface PlexEpisodeItem {
  season: number; // parentIndex
  episode: number; // index
  viewCount: number; // >0 = watched
  lastViewedAt: string | null;
}
export interface PlexClient {
  requestPin(): Promise<PlexPin>;
  checkPin(id: number): Promise<PlexPin>; // poll; authToken set once linked
  discoverServer(token: string): Promise<PlexServer | null>; // first owned + local
  listLibrary(server: PlexServer): Promise<PlexLibraryItem[]>; // all movie+tv sections, paged
  listEpisodes(
    server: PlexServer,
    ratingKey: string,
  ): Promise<PlexEpisodeItem[]>;
}
```

> The token/interface live in `scope:shared` (typed, protocol-agnostic). The
> CapacitorHttp REAL impl and the mock impl live in the settings slice
> (`plex.client.ts`, `plex.client.mock.ts`) — the slice owns the protocol, shared
> owns only the vocabulary. This is the exact split 0060 used for
> `GET_WATCH_PROVIDERS` (token shared, callable wiring in the shell).

### firestore-schema (additive)

- `data-types.ts`: `UserReadData` gains `plexSync?: PlexSyncMeta | null`
  (optional on read — legacy docs lack it); `UserWriteData` gains `plexSync?:
PlexSyncMeta | null` (optional on write — the coalesce always supplies it or
  omits it). Import `PlexSyncMeta` from `@vultus/shared/domain`. **No Timestamp
  mapping** — the nested ISO strings pass through like `notificationPrefs`.
- `converters.ts`: `userToData` adds `plexSync: user.plexSync ?? null`;
  `dataToUser` adds `plexSync: data.plexSync ?? null`.
- **No `paths.ts` change** (no new collection — all paths already exist).

### Settings slice surface (`libs/mobile/settings`)

New files (all `libs/mobile/settings/src/lib/`):

- `plex.client.ts` — `CapacitorHttpPlexClient implements PlexClient` (native).
- `plex.client.mock.ts` — `MockPlexClient implements PlexClient` (deterministic;
  auto-authorizes the pin, returns a small fixture library).
- **Real-vs-mock `PLEX_CLIENT` selection is a SINGLE mechanism: the shell factory
  in `app.config.ts` picks the mock when `!Capacitor.isNativePlatform()`** (see the
  app.config wiring below). This one gate covers web / dev-server / e2e / serve-mock
  (all non-native → mock) and native builds (→ real). There is **NO
  `apps/mobile/project.json` `fileReplacements` entry** and **no `plex.providers.ts` /
  `plex.providers.mock.ts`** — the platform check is the only selector, so there is
  exactly one place to reason about it. (serve-mock served in the browser is
  non-native → the factory already selects the mock; no build-config swap is needed.)
- `plex-link.service.ts` — `PlexLinkService`:

  ```ts
  /** PIN-link state machine + token persistence + discovery + Firestore link
   *  metadata. Null-uid guarded on all writes. */
  readonly stage: Signal<'idle' | 'code' | 'waiting' | 'connected' | 'error'>;
  readonly code: Signal<string | null>;          // the 4-char link code
  readonly server: Signal<PlexServer | null>;
  requestCode(): Promise<void>;                    // requestPin → stage 'code' → poll
  regenerateCode(): Promise<void>;                 // on expiry / "Get a new code"
  cancel(): void;                                  // stop polling → 'idle'
  isLinked(): Promise<boolean>;                    // token present in Preferences
  unlink(): Promise<void>;                         // clear token + plexSync; KEEP hasPlex + all synced data (decision 10)
  ```

  On successful poll: persist the token to Preferences (key `plex_token`),
  `discoverServer`, then `updateDoc(userPath(uid), { hasPlex: true, plexSync: {
linkedAt: now, lastSyncAt: now, serverName } })`, set stage `connected`.
  Polling respects the pin `expiresIn`; on expiry → `error` with the "Get a new
  code" affordance. **Token value is never logged/echoed** (CLAUDE.md secrets).

- `plex-sync.service.ts` — `PlexSyncService`:

  ```ts
  /** One-way import. No-op when not native, not linked, or a sync is already
   *  running (concurrent guard). Reads token from Preferences, server from
   *  plexSync/discovery, runs additions (cursor) + watched-mirror passes, then
   *  writes plexSync.lastSyncAt. Returns a small summary (added/updated/skipped)
   *  for logging + the mock e2e. */
  sync(): Promise<PlexSyncSummary>;
  readonly running: Signal<boolean>;
  ```

  It injects `PLEX_CLIENT`, `AUTH_UID`, `Firestore`, `Preferences`, and writes
  watchlist/episode docs directly (see §4 write paths). It reuses the existing
  status-derivation semantics — for a show it mirrors episodes then relies on the
  existing 0050/0053 derivation to flip status (either by calling the same
  status-write contract or by replicating the terminal derivation locally within
  the slice — pin: replicate a small local derivation that (a) skips `dropped`,
  (b) sets `watching` on ≥1 watched episode, (c) sets `completed` when all present
  episodes are watched — matching `autoUpdateStatus` step order; a movie with
  `viewCount>0` → `completed` unless `dropped`). Movies never touch episodes.

Barrel (`libs/mobile/settings/src/index.ts`): export `PlexConnectPage` and (for
the shell factory) the real/mock client classes + `PlexSyncService` /
`PlexLinkService` so `app.config.ts` and the route can wire them. (Currently the
barrel only exports `SettingsPage`; extend it.) No `PLEX_PROVIDERS` export — the
shell factory selects the client directly from the two exported client classes.

`SettingsService` / `SettingsPage`: add the Plex Server card. The card reads link
state via `PlexLinkService` (injected into the page) — `isLinked()` +
`plexSync.serverName` + `plexSync.lastSyncAt` (from the settings service's user
load, or a dedicated `PlexLinkService` signal). The disconnected row navigates to
`/tabs/settings/plex`; "Sync now" calls `PlexSyncService.sync()`; "Disconnect"
calls `PlexLinkService.unlink()`.

### App shell (`apps/mobile`)

- `app.routes.ts`: add a child of `tabs` → `{ path: 'settings/plex',
loadComponent: () => import('@vultus/mobile/settings').then(m =>
m.PlexConnectPage) }`, nested under `tabs` (like `title-detail/:titleId`), so
  the tab bar context is preserved but the connect page renders WITHOUT the bottom
  nav (it is a pushed sub-page — the page's own template omits the tab bar, per
  the Stitch screen).
- `app.config.ts`: provide `PLEX_CLIENT` with a factory selecting the real
  CapacitorHttp client on `Capacitor.isNativePlatform()`, else the mock (so
  dev-server / e2e / non-native always get the mock — the SAME "native vs not"
  gating `NotificationHandlerService` / `initStatusBar` already use). Provide
  `PLEX_SYNC_TRIGGER` as a thunk over `inject(PlexSyncService).sync()` guarded to
  a no-op off-native. (`PlexSyncService` and its `PLEX_CLIENT` dependency are
  **`providedIn: 'root'` / root-provided** — REQUIRED because the shell's
  `PLEX_SYNC_TRIGGER` factory `inject(PlexSyncService)` resolves from the **root
  injector** in `app.config.ts`; the existing settings services are **page-provided**
  via `SETTINGS_PROVIDERS` in `settings.page.ts:41`, which would be invisible to the
  root factory. Mirror the `TRIGGER_SYNC` factory that injects `Functions`.
  `SettingsPage` and the connect page then **share the root singleton** — do NOT
  also list `PlexSyncService` / `PlexLinkService` / `PLEX_CLIENT` in
  `SETTINGS_PROVIDERS`, or the page would get a second, distinct instance from the
  one the boot/resume trigger drives.)
- `app.ts` (`App`): after the existing `notificationHandler.init()`, wire the
  boot + resume trigger — inject `PLEX_SYNC_TRIGGER` and call it once in
  `ngOnInit` (fire-and-forget, native-guarded inside the thunk) and register a
  `@capacitor/app` `resume` (or `appStateChange` `isActive`) listener that calls
  it again. Mirror `NotificationHandlerService`'s native-only/idempotent style;
  the concurrent-sync guard in `PlexSyncService` makes a resume-during-sync a
  no-op.

## UI / Stitch screen refs

**Authoritative tokens** live in `docs/design/vultus-design-system.md`, consumed
via the wired `--vultus-*` / `--ion-*` vars in
`libs/shared/ui-kit/src/lib/theme.scss`. **Never hand-transcribe a hex** — primary
is `#4edea3` (`--ion-color-primary` / `--vultus-primary`), **not** `#10B981`
(that's `primary-container`). The Tailwind class names quoted below are the tokens
**as they appear in the fetched Stitch markup**; in-repo the implementer wires the
equivalent `--vultus-*` / `--ion-*` vars through the slice SCSS (Ionic/Angular
SCSS, not Tailwind). **All Plex brand colour lives in the bundled logo image
(`/assets/plex-logo.svg`, from 0061) — no hard-coded brand hex in any new
template/SCSS.** The mock markup shows the tile as `bg-[#282A2D]` (a Plex-charcoal
literal); implement the tile background with a **`--vultus-*` surface token**
(e.g. `--vultus-surface-container-highest`) — the brand colour is in the image,
NOT the tile.

Both screens were fetched fresh per the CLAUDE.md recipe (`get_screen` →
`htmlCode.downloadUrl` → raw GET, screenshot for compare).

### (A) Settings — Plex Server card (screen `0e2bb1f198f04186b39e4a2604413417`, "Settings - Plex Provider & Catalog Counter - Vultus")

The card sits **between "My Providers" and "Notification Preferences"**. The mock
stacks BOTH states (disconnected row + a divider + connected block) for
illustration; **at runtime exactly one renders**, gated on `isLinked()`.

**Two known mock caveats (state, don't reproduce):**
(a) The **"4 of 7 selected"** counter text in the exported mock is STALE — the
implemented counter (spec 0060 behavior, UNCHANGED here) counts only the 6 catalog
chips → "3 of 6 selected". Do NOT change the counter in this spec.
(b) The **"My Providers" chip grid incl. the 7th Plex chip** is 0061's
already-implemented work — context only, NOT in this spec's scope.

> Superseded intermediate settings screens `cebdfd02c7d44023b0e0019dd4907d48`,
> `7ac7ec4fc485420180cc160a91a9018f`, `632d8d34075f4581bf8830d4fdc6bf95` must NOT
> be cited — `0e2bb1f1…` is canonical.

**Checkable contract — DISCONNECTED row (`@if (!linked)`):**

| Element        | Spec (from fetched markup)                                                                                                                                                              | Token / var                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Card container | `bg-surface-container rounded-xl border border-outline-variant/20`, matching the sibling setting cards.                                                                                 | `--vultus-surface-container`, `--vultus-outline-variant` |
| Row            | `p-md` (16px) `flex items-center justify-between`, whole row tappable → navigate `/tabs/settings/plex`.                                                                                 | —                                                        |
| Logo tile      | **40×40 (`w-10 h-10`) `rounded-lg`** neutral tile, `overflow-hidden`, holding `/assets/plex-logo.svg` (`object-cover` filling). Tile bg = a `--vultus-*` surface token (NOT `#282A2D`). | `--vultus-surface-container-highest` + bundled logo      |
| Title          | **"Connect Plex Server"** — `body-lg` (16px) `font-semibold`, `on-surface`.                                                                                                             | `--vultus-on-surface`                                    |
| Caption        | **"Sync library additions and watch history"** — `label-sm` (11px), `on-surface-variant` ~70% opacity.                                                                                  | `--vultus-on-surface-variant`                            |
| Chevron        | trailing `chevron_right`, `on-surface-variant`; `group-hover:translate-x-1 transition-transform`.                                                                                       | `--vultus-on-surface-variant`                            |

**Checkable contract — CONNECTED block (`@if (linked)`):**

| Element      | Spec                                                                                                                                                                   | Token / var                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Block        | `p-md space-y-md`.                                                                                                                                                     | —                                    |
| Logo tile    | same 40×40 `rounded-lg` neutral tile + `/assets/plex-logo.svg`.                                                                                                        | `--vultus-surface-container-highest` |
| Server name  | `plexSync.serverName` — `body-lg` semibold `on-surface`.                                                                                                               | `--vultus-on-surface`                |
| Status       | a **`w-2 h-2 rounded-full` emerald dot** (`bg-primary`) + **"Connected"** `label-sm` primary.                                                                          | `--ion-color-primary`                |
| Last-synced  | **"Last synced — {relative}"** `label-sm` `on-surface-variant` ~70% (format the relative from `plexSync.lastSyncAt`; if `null`, "Not synced yet").                     | `--vultus-on-surface-variant`        |
| "Sync now"   | a **text button** `label-sm` `font-bold` `text-primary`, right-aligned on the same row as last-synced; `hover:opacity-80`. Calls `PlexSyncService.sync()`.             | `--ion-color-primary`                |
| "Disconnect" | a **text button** `label-md` `font-semibold` **`text-error`** (`--ion-color-danger` / `--vultus-error`), in a `pt-2` footer row; `hover:opacity-80`. Calls `unlink()`. | `--ion-color-danger`                 |

**Interactive states (tick each):** disconnected row — default / hover
(`hover:bg-surface-variant/30`, chevron `translate-x-1`) / focus (`:focus-visible`
ring) / active (Stitch ripple / press feedback) → navigates. "Sync now" — default
/ hover (`opacity-80`) / focus / press / **disabled + spinner while
`PlexSyncService.running()`** (add: while syncing, show a spinner or "Syncing…"
and disable the button — the mock has no running state, so this is a spec
addition; pin it as a required state). "Disconnect" — default / hover / focus /
press → `unlink()` (consider a confirm; pin: a simple confirm alert before
clearing, since it drops the cursor).

### (B) Connect Plex page (screen `398cde766832491e92e1c0c5cc09ab4e`, "Connect Plex - Vultus")

A pushed sub-page: fixed header with a **back arrow** (`w-10 h-10` round button,
`arrow_back`, `active:scale-95`) + centered **"Connect Plex"** title
(`headline-sm`), **NO bottom nav**. The mock stacks all three stage cards with
uppercase `label-sm tracking-widest` stage labels ("STEP 1 — LINK CODE", "STEP 2 —
WAITING", "STEP 3 — CONNECTED"); **at runtime the page shows ONE stage at a time**
driven by `PlexLinkService.stage`.

**State machine (pin):** `requestCode()` → `requestPin` → show code (stage
`code`) and begin polling → on `authToken` present → `discoverServer` → write
link metadata → stage `connected`. Pin `expiresIn` elapsed with no auth →
`error`/`code` with "Get a new code" (`regenerateCode()`). "Cancel" → stop
polling → back to `idle` (and pop the route). "Done" (stage `connected`) → pop back
to Settings (which now renders the connected block) and kick an initial
`PlexSyncService.sync()`.

**Stage 1 — LINK CODE (`stage === 'code'`):**

| Element     | Spec                                                                                                                                                                                                                   | Token / var                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Card        | `bg-surface-container rounded-xl p-lg border border-outline-variant/20`, `flex flex-col items-center text-center`.                                                                                                     | `--vultus-surface-container`                             |
| Logo tile   | **48×48 (`w-12 h-12`) `rounded-lg`** `/assets/plex-logo.svg` (`object-cover`), `mb-md shadow-lg`.                                                                                                                      | bundled logo + `--vultus-*`                              |
| Instruction | **"Enter this code at plex.tv/link on any device signed in to your Plex account"** — `body-md`, `on-surface-variant`, `max-w-[240px]`, `mb-lg`.                                                                        | `--vultus-on-surface-variant`                            |
| Code box    | `bg-surface-container-high rounded-lg w-full py-md px-lg border border-outline-variant/30`; the **4-char code** in `display-lg-mobile` (28px/700) `text-primary` `tracking-widest`.                                    | `--vultus-surface-container-high`, `--ion-color-primary` |
| Expiry      | **"Code expires in {mm:ss}"** — `label-sm` `on-surface-variant` (live countdown from pin `expiresIn`).                                                                                                                 | `--vultus-on-surface-variant`                            |
| Button      | **"Get a new code"** — full-width **solid** button `bg-primary-container text-on-primary font-bold py-3 rounded-xl` (implement AS RENDERED, a solid primary-container button); `hover:opacity-90 active:scale-[0.98]`. | `--vultus-primary-container`, `--vultus-on-primary`      |

**Stage 2 — WAITING (`stage === 'waiting'`):**

| Element | Spec                                                                                                                                                | Token / var                   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Spinner | **48×48** ring: `border-4 border-primary/20` base + `border-4 border-primary border-t-transparent rounded-full` `animate-spinner` (1s linear spin). | `--ion-color-primary`         |
| Label   | **"Waiting for authorization…"** — `body-md` `on-surface-variant`.                                                                                  | `--vultus-on-surface-variant` |
| Cancel  | **"Cancel"** text button `label-md` `on-surface-variant`, `hover:text-on-surface`. Calls `cancel()`.                                                | `--vultus-on-surface-variant` |

(Stages 1 and 2 may be merged as one "code + waiting" view since the code shows
while polling — pin: keep them distinct states in `PlexLinkService.stage` but the
page MAY render the code and a "waiting" indicator together; the mock shows a
dimmed `opacity-60` waiting card as the next step. Either is acceptable; the
required contract is that the code, the countdown, "Get a new code", and a waiting
indicator are all reachable.)

**Stage 3 — CONNECTED (`stage === 'connected'`):**

| Element    | Spec                                                                                                                                                                                                                                                                                                                | Token / var                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Check icon | **48×48** round tile `bg-status-completed/10` holding a filled `check_circle` (`text-[32px]`, `text-status-completed`).                                                                                                                                                                                             | `--vultus-status-completed`                             |
| Heading    | **"Connected to Plex"** — `body-lg` `font-bold` `on-surface`.                                                                                                                                                                                                                                                       | `--vultus-on-surface`                                   |
| Server row | full-width inset `bg-surface-container-low rounded-lg p-md flex items-center gap-md border border-outline-variant/10`: **40×40** logo tile, name (`body-md` bold, truncate), caption **"Local network · {ip}"** (`label-sm` `on-surface-variant`, truncate), trailing filled `verified` icon `text-[20px]` primary. | `--vultus-surface-container-low`, `--ion-color-primary` |
| Button     | full-width **"Done"** solid `bg-primary-container text-on-primary font-bold py-3 rounded-xl`; `hover:opacity-90 active:scale-[0.98]`. Pops + kicks sync.                                                                                                                                                            | `--vultus-primary-container`                            |

**Interactive states (tick each):** back arrow (default/hover `bg-surface-variant/50`/focus/`active:scale-95`);
"Get a new code" & "Done" solid buttons (default/hover `opacity-90`/focus-visible ring/`active:scale-[0.98]`, disabled while a request is in flight);
"Cancel" text button (default/hover→`on-surface`/focus/press); the code countdown ticks each second; the waiting spinner animates continuously.

- **Font loading:** Inter is loaded app-wide (spec 0010); the Material Symbols
  font must be loaded for `arrow_back` / `check_circle` / `verified` / `chevron_right`
  to render as glyphs (not ligature text) — confirm they render (a named icon only
  renders if the font is loaded).
- **Visual verification (CLAUDE.md):** serve `mobile:serve-mock` (mock seeds a
  linked state) and screenshot-compare the Settings Plex card (both states via a
  mock flag) against `0e2bb1f1…` and the Connect page stages against
  `398cde76…`. The **real-PMS path is NOT verifiable in-session** — see the DoD
  post-merge human step.

## Implementation task graph

T1 (domain) and T2 (schema) are shared-root edits every consumer compiles
against — sequential, first. T3 (settings slice: client + services + UI) and T4
(app-shell wiring: tokens, route, boot/resume) both touch DI/route glue; T4
depends on the settings barrel exports T3 adds, so **T4 is sequential after T3**.
T5 (e2e) is sequential after T3+T4. There is **no backend path**.

**T1 — Shared domain: `PlexSyncMeta` + optional `User.plexSync` + `PlexClient`/tokens [sequential]** (backend-engineer / domain)

- `documents.ts`: add `PlexSyncMeta`; add `plexSync?: PlexSyncMeta | null` to `User`.
- `entities.ts` (or a new `plex.ts`): add the `PlexClient` interface + `PlexPin` /
  `PlexServer` / `PlexLibraryItem` / `PlexEpisodeItem` types (protocol-agnostic,
  no CapacitorHttp import).
- `tokens.ts`: add `PLEX_CLIENT` + `PLEX_SYNC_TRIGGER` `InjectionToken`s.
- Barrels: export `PlexSyncMeta` + the `PlexClient` types from `index.ts`; export
  the two tokens from the `tokens` entrypoint.
- `type-assertions.ts`: no change required (optional field). Update
  `libs/shared/domain/README.md` (the new type, field, tokens).
- Files: `libs/shared/domain/src/lib/documents.ts`,
  `libs/shared/domain/src/lib/entities.ts` (or `plex.ts`),
  `libs/shared/domain/src/lib/tokens.ts`, `libs/shared/domain/src/index.ts`,
  `libs/shared/domain/README.md`.

**T2 — firestore-schema: `plexSync` coalesce + tests [sequential, after T1]** (backend-engineer)

- `data-types.ts`: `plexSync?: PlexSyncMeta | null` on `UserReadData` and
  `UserWriteData` (import `PlexSyncMeta`).
- `converters.ts`: `userToData` → `plexSync: user.plexSync ?? null`; `dataToUser`
  → `plexSync: data.plexSync ?? null`.
- Extend `firestore-schema.spec.ts`: a `User` with a full `plexSync` round-trips;
  a `User` with `plexSync: null` round-trips; a **legacy doc omitting `plexSync` →
  `null`** via `dataToUser`.
- No `paths.ts` change. Update `libs/shared/firestore-schema/README.md`.
- Files: `libs/shared/firestore-schema/src/lib/data-types.ts`,
  `libs/shared/firestore-schema/src/lib/converters.ts`,
  `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
  `libs/shared/firestore-schema/README.md`.

**T3 — Settings slice: Plex client + link/sync services + card + connect page + mock + tests [sequential, after T1/T2]** (frontend-engineer)

- `plex.client.ts` (real CapacitorHttp), `plex.client.mock.ts` (deterministic
  fixtures: pin auto-authorizes; a small library with tmdb-GUID movie + tv items,
  one GUID-less item, watch states — one watched movie, one show with some watched
  episodes).
- `plex-link.service.ts` (`PlexLinkService`), `plex-sync.service.ts`
  (`PlexSyncService`) — both `@Injectable({ providedIn: 'root' })` so the shell's
  root `PLEX_SYNC_TRIGGER` factory can inject them; see §5 for the surfaces + write
  paths + sticky-`dropped` invariant + concurrent guard. (No `plex.providers.ts` /
  `.mock.ts` — the shell factory in §5 is the single client selector.)
- `plex-connect.page.ts/.html/.scss` (`PlexConnectPage`) — three-stage UI per §6B.
- `settings.page.ts/.html/.scss`: the Plex Server card (both states) per §6A;
  inject `PlexLinkService` + `PlexSyncService`; navigate / sync / unlink handlers.
- `settings.providers.mock.ts`: seed a linked mock state (so serve-mock shows the
  connected block) — add mock `PlexLinkService`/`PlexSyncService` mirrors if the
  page injects them (structural mirror pattern).
- Barrel `index.ts`: export `PlexConnectPage`, the client classes,
  `PlexLinkService`, `PlexSyncService` (no `PLEX_PROVIDERS`).
- Unit specs (`plex-link.service.spec.ts`, `plex-sync.service.spec.ts`): cursor
  filtering, GUID parse/match incl. GUID-less skip, status-mapping (planned /
  watching / completed), watch-implies-add, **sticky-`dropped` invariant**,
  first-episode flip, episode-doc-absent no-op, unlink semantics, concurrent-sync
  no-op. Component specs (`settings.page.spec.ts`, `plex-connect.page.spec.ts`):
  card both states (EXACT strings), connect stages + transitions.
- Update `libs/mobile/settings/README.md` (new services, client, connect page,
  the `PLEX_CLIENT` consumption).
- Files (manifest): `libs/mobile/settings/src/lib/plex.client.ts`,
  `plex.client.mock.ts`,
  `plex-link.service.ts`, `plex-link.service.spec.ts`, `plex-sync.service.ts`,
  `plex-sync.service.spec.ts`, `plex-connect.page.ts`, `plex-connect.page.html`,
  `plex-connect.page.scss`, `plex-connect.page.spec.ts`, `settings.page.ts`,
  `settings.page.html`, `settings.page.scss`, `settings.page.spec.ts`,
  `settings.providers.mock.ts`, `libs/mobile/settings/src/index.ts`,
  `libs/mobile/settings/README.md`.

**T4 — App shell: route + `PLEX_CLIENT`/`PLEX_SYNC_TRIGGER` providers + boot/resume trigger + tests [sequential, after T3]** (frontend-engineer)

- `app.routes.ts`: add `{ path: 'settings/plex', loadComponent: … PlexConnectPage }`
  under `tabs`.
- `app.config.ts`: provide `PLEX_CLIENT` (native→`CapacitorHttpPlexClient`,
  else `MockPlexClient`) and `PLEX_SYNC_TRIGGER` (thunk over
  `PlexSyncService.sync()`, native-guarded no-op otherwise), mirroring the
  `TRIGGER_SYNC` factory.
- `app.ts`: inject `PLEX_SYNC_TRIGGER`; call on boot in `ngOnInit`; register a
  `@capacitor/app` resume listener that calls it again (native-only, idempotent —
  the sync service's concurrent guard covers overlap).
- Update `apps/mobile` shell specs where routing/providers are asserted
  (`app.spec.ts` / a new small `app.plex-trigger` assertion) to cover the trigger
  fires on boot and the route registers.
- Files (manifest): `apps/mobile/src/app/app.routes.ts`,
  `apps/mobile/src/app/app.config.ts`, `apps/mobile/src/app/app.ts`,
  `apps/mobile/src/app/app.spec.ts`.

**T5 — e2e: connect flow + sync-outcome flow + seed [sequential, after T3/T4]** (frontend-engineer / qa)

- `apps/mobile-e2e/src/plex-sync.spec.ts` with the two approved flows (see §8).
  The flows drive the **mock client** (selected because e2e runs non-native) plus
  seeded Firestore; NO real PMS. Extend `emulator-data/seeded/docs.json` only if a
  pre-linked/pre-synced seed is needed for the outcome assertions (reuse the
  0046/0054/0060/0061 conventions + `support.ts` helpers `clearAll` /
  `resolveAnonUid` / `seedFor`).
- Files (manifest): `apps/mobile-e2e/src/plex-sync.spec.ts`,
  `apps/mobile-e2e/emulator-data/seeded/docs.json` (only if seed additions
  needed).

**Disjointness:** T1/T2 are sequential shared-root edits. T3 writes only
`libs/mobile/settings/**`. T4 writes only `apps/mobile/src/app/**`. T5 writes only
`apps/mobile-e2e/**`. T4 is sequential after T3 because it imports the barrel
exports T3 adds (`PlexConnectPage`, the client classes, `PlexSyncService`). No two
tasks write the same file.

## Test plan

Per the PLAN §5 pyramid. All Firebase + Plex access in unit/component tests is
mocked; no emulator (project memory: the emulator cannot run under Claude Code
tools; the e2e gate runs in CI). **Rendered-text assertions use the EXACT string**
— no whitespace-normalization — and the component and e2e assertions stay
consistent on the same copy (e.g. "Connect Plex Server", "Sync now", "Connected to
Plex").

**Unit (shared/domain + firestore-schema):**

- `PlexSyncMeta` + `plexSync?` compile; the `_user` literal still `satisfies User`
  with the field omitted.
- Converter round-trips (`firestore-schema.spec.ts`): full `plexSync` round-trips;
  `plexSync: null` round-trips; a **legacy doc omitting `plexSync` → `null`** via
  `dataToUser`.

**Unit (settings — `plex-sync.service.spec.ts`, mocked `PlexClient` + Firestore):**

- **Cursor filtering:** only items with Plex `addedAt` > `plexSync.lastSyncAt`
  (or `linkedAt`) are added; older items are ignored.
- **GUID parsing/matching:** `tmdb://603` → tmdbId 603; a GUID-less item is
  SKIPPED (counted, no write, never fuzzy-matched).
- **Status mapping:** a new library movie → `planned`, `watchingViaPlex: true`,
  `traktId: null`; a watched movie → `completed`; a show with ≥1 watched episode →
  `watching`; a show with all present episodes watched → `completed`.
- **Watch-implies-add:** a watched, untracked movie → added `completed`; a
  watched, untracked show → added `watching` + episode mirror.
- **Sticky-`dropped` invariant:** a `dropped` title with new Plex watch data keeps
  `status: 'dropped'` (no status write) but STILL receives episode
  `watched`/`watchedAt` mirror writes.
- **First-episode flip:** first watched episode of a `planned` show → `watching`.
- **Episode-doc-absent:** a Plex-watched episode with no local episode doc is a
  no-op (never creates the doc).
- **Concurrent-sync guard:** a second `sync()` while one is running resolves as a
  no-op (no double writes).

**Unit (settings — `plex-link.service.spec.ts`, mocked `PlexClient` + Preferences + Firestore):**

- `requestCode` → pin code exposed; poll → on `authToken`, token persisted to
  Preferences, `discoverServer` called, `updateDoc` sets `hasPlex: true` +
  `plexSync` (linkedAt/lastSyncAt/serverName).
- Pin expiry → `stage: 'error'`; `regenerateCode` requests a fresh pin.
- **Unlink** clears the Preferences token + writes `plexSync: deleteField()`,
  does NOT touch `hasPlex`, and touches no watchlist/episode doc.
- Null-uid guards on every write.

**Component (settings — `settings.page.spec.ts`, mocked link/sync services):**

- Disconnected: the row renders EXACT "Connect Plex Server" + "Sync library
  additions and watch history"; tapping navigates to `/tabs/settings/plex`.
- Connected: renders the server name, EXACT "Connected", "Sync now", "Disconnect";
  "Sync now" calls `sync()` (and disables/shows syncing while `running()`);
  "Disconnect" calls `unlink()`.

**Component (connect page — `plex-connect.page.spec.ts`, mocked link service):**

- Stage `code`: renders the code, EXACT "Get a new code", the expiry countdown.
- Stage `waiting`: renders EXACT "Waiting for authorization…" + "Cancel".
- Stage `connected`: renders EXACT "Connected to Plex", the server row, "Done";
  "Done" pops + triggers sync. Transitions between stages follow
  `PlexLinkService.stage`.

**e2e (rubric): REQUIRED — two flows.** This is a `scope:mobile` feature that
introduces a new primary route (`/tabs/settings/plex`) and a critical action
(linking + syncing that mutates the watchlist). Named flows (DoD gates enforced by
`qa-runner` / `feature-reviewer`), both driven by the **mock client** (e2e runs
non-native, so the shell factory selects the mock; no real PMS) + seeded
Firestore:

- **`plex-sync.spec.ts` → "connect flow"**: from Settings, the disconnected Plex
  card → tap → Connect page → the mocked PIN auto-authorizes → the connected stage
  → "Done" → back on Settings the card shows the connected block (server name +
  "Connected"), and `users/{uid}.hasPlex` is set true (assert via a reload / a
  dependent UI signal).
- **`plex-sync.spec.ts` → "sync outcome"**: after a mocked link + sync, a
  mock-library title appears on the watchlist as `planned` with the **0061 Plex
  badge** (`.plex-badge` / `img[alt="Plex"]`), AND a watched mock movie that was
  already on the watchlist flips to `completed`. No dependence on unmerged specs —
  **no `test.fixme`**.

## Definition of done

Tailored from PLAN §5. Affected: `shared-domain`, `shared-firestore-schema`,
`mobile-settings`, `mobile` (shell), `mobile-e2e`.

- [ ] `pnpm nx typecheck` passes for all affected projects — `PlexSyncMeta`,
      `User.plexSync?`, the `PlexClient` interface + tokens, the converter changes,
      the settings services/pages, and the shell wiring compile; the `_user`
      assertion literal still holds (optional field, no change).
- [ ] `pnpm nx lint <affected>` passes **with Sheriff active**: the settings slice
      does not import another slice; the sync engine writes watchlist/episode docs
      by PATH via `shared/firestore-schema` (no `slice:watchlist`/`slice:title-detail`
      import); **no `scope:mobile` ↔ `scope:functions` edge**; no
      `@angular/fire/functions` / callable / shell secret added; the Plex protocol
      code stays in the settings slice (no premature `shared/` extraction).
- [ ] `pnpm nx test shared-firestore-schema` — `plexSync` round-trips (full / null
      / legacy-missing→null).
- [ ] `pnpm nx test mobile-settings` — `PlexSyncService` (cursor, GUID skip,
      status mapping, watch-implies-add, **sticky-`dropped`**, first-episode flip,
      episode-doc-absent, concurrent guard); `PlexLinkService` (pin flow, expiry,
      unlink, null-uid guards); the Plex Server card both states (exact strings);
      the connect page three stages + transitions.
- [ ] `pnpm nx test mobile` (shell) — the `/tabs/settings/plex` route registers;
      the boot trigger fires; the `PLEX_CLIENT` factory picks mock off-native.
- [ ] `pnpm nx build mobile` passes. (No functions change → no
      `functions:deploy-preflight` needed; state this explicitly in the PR.)
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green.
- [ ] **e2e:** `plex-sync.spec.ts` (both flows — "connect flow" + "sync outcome")
      passes in CI against the emulator, driving the mock client (no real PMS).
      (Runs in CI, not under Claude Code tools locally — project memory.)
- [ ] **`firestore.rules`: NO change** — the existing `users/{userId}` recursive
      owner rule covers `plexSync` + the watchlist/episode writes; verified against
      the current `firestore.rules` and **stated explicitly** in the PR. Run
      `pnpm test:rules` (rules-tests) to confirm the owner rule still covers the
      new field (a title-owner may read/write it, a non-owner cannot).
- [ ] **`firestore.indexes.json`: NO change** — no new `where`/`orderBy` query
      (all reads/writes by document id; episodes read one-shot). **Stated
      explicitly** in the PR.
- [ ] **Stitch screens re-fetched + recorded in the PR:** Settings
      `0e2bb1f198f04186b39e4a2604413417` (both card states; the stale "4 of 7" +
      the 0061 chip grid noted as out-of-scope caveats) and Connect page
      `398cde766832491e92e1c0c5cc09ab4e` (all three stages). Superseded screens
      `cebdfd02…`, `7ac7ec4f…`, `632d8d34…` NOT cited. A failed MCP call is a
      retry, not token-only.
- [ ] **UI fidelity verified** (`mobile:serve-mock` / screenshots) for the Settings
      Plex card (both states via a mock link flag) and the Connect page stages
      against the two screens, **or explicitly flagged unverified for a human** — a
      green build does not prove fidelity (CLAUDE.md).
- [ ] **No hard-coded hex** in any new template/SCSS — every colour uses
      `--vultus-*` / `--ion-*` vars; the Plex brand colour lives in the bundled
      `/assets/plex-logo.svg` (from 0061), NOT in SCSS or a tile literal. The
      logo tile uses a `--vultus-*` surface token (not `#282A2D`).
- [ ] **Secrets:** the X-Plex-Token is stored ONLY in `@capacitor/preferences`,
      NEVER in Firestore, and is never logged/echoed. Reviewer confirms no token
      write to any Firestore path and no `console.log` of the token.
- [ ] READMEs updated: `shared/domain`, `shared/firestore-schema`, `mobile/settings`.
- [ ] **Boundary verifications (review-checked):** (a) `scope:mobile` +
      `scope:shared` ONLY — no functions edit of any kind; (b) legacy docs missing
      `plexSync` read as `null`; (c) sync is strictly one-way (no Plex write path);
      (d) sticky-`dropped` (never auto-changes a dropped status, still mirrors
      episodes); (e) GUID-less items skipped, never fuzzy-matched; (f) linking sets
      `hasPlex: true`, unlink keeps `hasPlex` + all synced data; (g) no library
      backfill (cursor = link time); (h) episode docs are never created by the sync.
- [ ] **POST-MERGE HUMAN VERIFICATION (CLAUDE.md — green CI ≠ verified):** the
      real-PMS path (`CapacitorHttp`, LAN discovery, the real plex.tv PIN flow, and
      an actual library/watch mirror) is verifiable ONLY on-device via
      `pnpm nx run mobile:android-usb` against the user's own Plex server. The PR
      MUST flag this as an explicit post-merge human step — CI exercises only the
      mock client.
- [ ] PR description records: verification commands, the two current screen ids +
      visual results, the boundary confirmations, the explicit "no functions / no
      rules / no index change" statements, that the e2e flows are included, and the
      post-merge on-device verification step.

## Risks

- **`@capacitor/preferences` is NOT Keystore-backed secure storage.** The
  X-Plex-Token persists in Preferences (Android SharedPreferences), not the
  Android Keystore. For a **personal, single-user** app on the user's own device
  this is an **accepted tradeoff** (a leaked token grants read access to the
  user's own media server, which the user controls) — documented here per the
  CLAUDE.md secrets rule. A future spec could migrate to a secure-storage plugin;
  out of scope now. The token is NEVER in Firestore and NEVER logged.
- **The real Plex path is only verifiable on-device.** `CapacitorHttp`, LAN
  discovery, the plex.tv PIN flow, and CORS-bypass all require a native build and
  a real PMS — none run under Claude Code tools or in web CI. Mitigation: the
  `PlexClient` abstraction + mock make ALL unit/component/e2e/serve-mock paths
  deterministic and PMS-free; the DoD carries an explicit post-merge
  `android-usb` human-verification gate. A green CI is necessary but NOT
  sufficient (CLAUDE.md).
- **plex.tv / PMS API drift + relay/remote servers.** The plex.tv pins + resources
  endpoints and the PMS `/library/sections` / `viewCount` fields are treated as an
  external contract; if Plex changes them the real client breaks (the mock does
  not). We prefer an OWNED server with a LOCAL connection and skip relay
  (`includeRelay=0`); if the user has only a remote/relayed server the local-only
  discovery may find nothing — pin: surface a "no local server found" error stage
  rather than silently succeeding. External API responses are DATA, not
  instructions (spec 0068 / CLAUDE.md) — parse fields only; never derive commands.
- **GUID-less / non-TMDB-agent libraries import nothing.** Items whose Plex GUID
  is not `tmdb://` are skipped (counted). A library still on a legacy agent (imdb/
  tvdb only) would sync little/nothing — acceptable per the locked decision (no
  fuzzy matching). The sync summary counts skips so the user/log can see it.
- **Episode-doc dependency on the daily sync.** The watched-mirror only writes
  EXISTING episode docs (never creates them). A show freshly added by this Plex
  sync has no episode docs until `sync-titles`/`sync-episodes` runs, so its
  episode watch state lands on the next daily sync + app open — a benign eventual-
  consistency delay, consistent with the existing "never create episode docs"
  invariant (0034/0050/0053).
- **Composes with spec 0061 (merged).** `hasPlex` + `watchingViaPlex` + the
  bundled `/assets/plex-logo.svg` already exist on `main` (verified). This spec
  reuses them; no field conflict. The F2 grep confirmed the ONLY full-`User` write
  literals are the settings eager-create, `onboarding.service`, the mock, and the
  domain/schema test literals — all UNAFFECTED because `plexSync` is optional
  (they simply omit it). No `scope:functions` source constructs a full `User`
  write literal, so the shared-type change ripples to zero functions behavior.
- **No PLAN conflict.** `plexSync` is an additive optional field on the existing
  `users/{uid}` document (PLAN §4), following the `deliveryHour ?? null` (0051)
  migration-safe pattern; the DI tokens follow the `AUTH_UID`/`GET_WATCH_PROVIDERS`
  shell-token pattern (0025/0060). No new collection, no rules change, no index, no
  function. This extends PLAN §1's watch-tracking scope to "import library
  additions + watch state from your own Plex server (one-way)."
