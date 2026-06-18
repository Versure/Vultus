---
number: 0005
slug: firestore-schema
title: Add collection paths and Timestamp converters in shared/firestore-schema
status: approved
slices: []
scopes: [scope:shared]
created: 2026-06-18
---

# Add collection paths and Timestamp converters in shared/firestore-schema

## Context

The domain vocabulary exists (spec 0003 — `@vultus/shared/domain` exports the
settled `User`, `WatchlistItem`, `EpisodeDoc`, `NotificationDoc`,
`TitleCacheEntry`, `RegionAvailability`, and supporting value/enum types, with
**all timestamps as ISO 8601 strings**), and the Firestore access-control rules +
emulator are committed (spec 0004 — `firestore.rules` locks down the same PLAN §4
collection paths). But `libs/shared/firestore-schema` is still an empty barrel —
`src/index.ts` exports only `SHARED_FIRESTORE_SCHEMA_PLACEHOLDER`. **Nothing can
read or write Firestore yet**: there is no single place that knows the PLAN §4
collection/document paths, and no boundary layer that maps the persistence world's
Firestore `Timestamp` to the domain's ISO-string timestamps.

This spec implements **PLAN §6 foundation item 6** ("Firestore schema lib —
Collection paths, converters … Tests for converters"). It is the contract spec
0003 explicitly hands off to (see 0003 "Explicit contract for spec 0004
(firestore-schema)" — the numbering there predates 0004's renumbering; the
contract is **this** firestore-schema spec): firestore-schema **adds collection
PATHS and pure-function CONVERTERS that reference the domain types**, maps
`Timestamp` ↔ ISO `string` at the boundary, and **must not redefine any domain
shape** — any new persisted field is added to `shared/domain`, never re-declared
here.

The intended outcome: an agent implementing any mobile or functions slice can
`import { watchlistItemPath, userDataToUser, userToUserData } from
'@vultus/shared/firestore-schema'`, feed the returned string path into its **own**
SDK's `doc()`/`collection()`, and round-trip a domain object through Firestore
without ever touching a `Timestamp` by hand. This unblocks every slice that reads
or writes Firestore (PLAN §6 items 9–19).

### The load-bearing constraint: SDK-agnostic, Firebase-free

`shared/firestore-schema` is `scope:shared` and is imported by **both**
`scope:mobile` (Firebase **client** SDK / `@angular/fire`) and `scope:functions`
(Firebase **Admin** SDK / `@google-cloud/firestore`). Those two SDKs ship
**different, incompatible** `Timestamp` and `FirestoreDataConverter` types. So,
exactly like `shared/domain` (spec 0003), this lib **must not import** `firebase`,
`firebase-admin`, `@angular/fire`, or `@google-cloud/firestore`. The converters
are therefore **pure mapping functions**, not SDK `FirestoreDataConverter`
objects, and the path helpers return **plain strings**, not SDK
`DocumentReference`/`CollectionReference`. Each slice wires the lib's output into
its own SDK.

The Firebase-free property is a **spec-mandated implementation constraint
verified by code review**, not a toolchain-enforced one. Be precise about this:
the workspace root `package.json` **already declares** `firebase-admin` and
`firebase-functions` (the functions app uses them), so a stray
`firebase-admin` / `@google-cloud/firestore` import from this lib **would
resolve and typecheck would pass**. Sheriff only governs `scope:`/`slice:`
boundaries between **workspace projects** — it does not police third-party npm
imports, and no `@nx/dependency-checks` rule is configured. So **neither
`typecheck` nor `lint`/Sheriff blocks** a stray firebase import. The constraint
is upheld by two things instead: (1) the **feature-reviewer checks the diff**
imports none of `firebase` / `firebase-admin` / `@angular/fire` /
`@google-cloud/firestore`, and (2) the **round-trip unit tests independently
prove the SDK is genuinely unnecessary** — they pass with only a fake
`{ toDate }` and plain `Date`, no SDK present. (Adding an
`@nx/dependency-checks` or an import-restriction lint rule is a possible future
hardening, but is out of scope here.) This mirrors spec 0003's Firebase-free
boundary, with the enforcement mechanism stated honestly.

## Scope

In scope:

- Replace the placeholder in `libs/shared/firestore-schema/src/index.ts` with two
  capabilities, re-exported through the single barrel:
  1. **Path builders** — SDK-agnostic, typed functions returning Firestore
     **string** paths/segments for every PLAN §4 collection and document (full
     set in Public types / APIs), plus the collection-id segment constants.
  2. **Document converters** — pure `…ToData` (write) / `…To<Domain>` (read)
     functions for every document whose stored shape differs from its domain
     shape — i.e. every document carrying a `Timestamp` field: `User`,
     `WatchlistItem`, `EpisodeDoc`, `NotificationDoc`, `TitleCacheEntry`,
     `RegionAvailability`. Each pair maps ISO `string` ↔ a JS `Date`/structural
     Timestamp at the persistence boundary (mechanism below).
- **Per-document "data" (wire) types** describing the Firestore-stored shape: the
  read shape (timestamps typed as a minimal structural `FirestoreTimestampLike`)
  and the write shape (timestamps typed as JS `Date`). See Public types / APIs for
  the chosen representation (explicit hand-written read/write data interfaces, not
  clever generics).
- **The Timestamp ↔ ISO mapping idiom**, stated concretely:
  - **READ side** (`…To<Domain>` / `dataToX`): incoming Firestore timestamp
    fields are typed with a minimal **structural** interface this spec defines,
    `interface FirestoreTimestampLike { toDate(): Date }`. **Both** the client and
    Admin `Timestamp` classes structurally satisfy this. Convert to the domain ISO
    string via `value.toDate().toISOString()`. Nullable timestamps (`watchedAt`,
    `readAt`) map `null → null`.
  - **WRITE side** (`xToData` / `…ToData`): emit a JS **`Date`** for each
    timestamp field, constructed from the domain ISO string via `new Date(iso)`.
    **Firestore (both SDKs) persists a `Date` as a `Timestamp` automatically**, so
    the lib **never constructs an SDK `Timestamp`** — this is the precise reason no
    SDK import is needed on the write path. Nullable timestamps map `null → null`.
- **Pure unit tests** (Vitest) proving, per converter, the round-trip identity
  `domain → writeData → (simulate stored) → readData → domain` for every field
  (including null timestamps and the nested `fcmTokens` / `providers` /
  `previousSnapshot` structures), and path-builder output equality for every
  PLAN §4 path. These are **real runtime tests** (converters have runtime
  behavior) — no emulator, no Firebase.

Out of scope (deferred, with reasons):

- **Type-safe query helpers** (the "query helpers" half of PLAN §6 item 6). This
  spec ships **only** path builders + converters + tests. A query/filter/`orderBy`
  layer is **intentionally deferred to the consuming slices**, because slice
  queries — and the **composite indexes** they need — are unknown and were
  explicitly deferred per-slice in spec 0004 (`firestore.indexes.json` ships
  empty; "per-slice index additions belong to each slice's own spec"). Building a
  speculative query API now would either guess wrong or freeze indexes that don't
  exist. Each slice builds its own queries against its own SDK using the path
  builders here, and adds its own composite index in its own spec.
- **Runtime validation / schema enforcement.** Converters **map and trust** their
  input: we control every write, and spec 0004's rules gate access. **No
  validation library** (no zod/yup), no throw-on-malformed, no ISO-format guard.
  Correctness is guarded by the round-trip unit tests. A defensive guard can be
  added later **in this lib** if a real need appears — noted in Risks. (This
  matches spec 0004's deliberate "field/schema validation deferred to the
  converters" handoff, narrowed further to "trust types, no runtime checks".)
- **Redefining any domain shape.** Per the spec-0003 contract, every persisted
  field's source of truth is `@vultus/shared/domain`. This lib **imports** those
  types and adds only the path/converter layer.
- **Any `firebase` / `firebase-admin` / `@angular/fire` /
  `@google-cloud/firestore` import**, any SDK `FirestoreDataConverter` object, any
  SDK reference type. SDK wiring lives in each slice.
- **`shared/ui-kit`, slice-owned code, security rules** (spec 0004), and **the
  manual Firebase/emulator setup** (spec 0004 / PLAN §7).

## Affected slices & Sheriff tags

No slice is built (`slices: []`). Work is confined to the single `scope:shared`
lib `libs/shared/firestore-schema`, which **imports** the other `scope:shared` lib
`libs/shared/domain`.

| Project                 | Path                           | Sheriff tags   |
| ----------------------- | ------------------------------ | -------------- |
| shared firestore-schema | `libs/shared/firestore-schema` | `scope:shared` |
| shared domain (import)  | `libs/shared/domain`           | `scope:shared` |

The `scope:shared` tag is **already** assigned to `firestore-schema` by
`sheriff.config.ts` via the `libs/shared/<name>` path-glob (spec 0001); this spec
does **not** edit `sheriff.config.ts` (verified: `project.json` has `tags: []`;
the tag comes from the path glob). The Sheriff rule
`'scope:shared': 'scope:shared'` **permits** `scope:shared → scope:shared`, so
`firestore-schema` importing `@vultus/shared/domain` is allowed and is the
intended design. No cross-slice or cross-scope import is introduced, and no
firebase import is added (the only new dependency is the existing in-workspace
`@vultus/shared/domain`).

This is **not** a premature `shared/` extraction: PLAN §3 names `firestore-schema`
as one of the three fixed `scope:shared` libs, and PLAN §6 item 6 mandates the
paths/converters live here precisely so every slice shares one persistence
boundary. Defining them up front in the designated lib is the intended design, not
a violation of the "extract only at 3+ slices" rule (which governs slice-owned
code).

## Data model touchpoints

This spec creates **no Firestore collections, indexes, or security rules** (those
are spec 0004; Firestore is schemaless). It **codifies the PLAN §4 path structure
in one tested place** and defines the serialization boundary. The mapping to
PLAN §4, with **every timestamp field** called out (these are the fields each
converter must translate; all other fields pass straight through):

| PLAN §4 path                                              | Domain type          | Timestamp field(s) the converter maps                  |
| --------------------------------------------------------- | -------------------- | ------------------------------------------------------ |
| `users/{userId}`                                          | `User`               | **nested:** `fcmTokens[].createdAt` (array of objects) |
| `users/{userId}/watchlist/{titleId}`                      | `WatchlistItem`      | `addedAt`                                              |
| `users/{userId}/watchlist/{titleId}/episodes/{episodeId}` | `EpisodeDoc`         | `airDate`, `watchedAt` (**nullable**)                  |
| `users/{userId}/notifications/{notificationId}`           | `NotificationDoc`    | `sentAt`, `readAt` (**nullable**)                      |
| `title-cache/{tmdbId}`                                    | `TitleCacheEntry`    | `lastSyncedAt`                                         |
| `title-cache/{tmdbId}/availability/{region}`              | `RegionAvailability` | `lastSyncedAt`                                         |

Non-timestamp nested structures that **pass straight through** (no per-element
mapping — `WatchProvider` has **no** timestamp): `RegionAvailability.providers:
WatchProvider[]` and `RegionAvailability.previousSnapshot: WatchProvider[]` are
copied as-is; `NotificationDoc.payload`, `TitleCacheEntry.metadata`, and
`User.notificationPrefs` are copied as-is. Only `User.fcmTokens` requires
per-element mapping (because each `FcmToken` has a nested `createdAt` timestamp).

The PLAN §4 `users/**` and `title-cache/**` paths here are the **same** paths spec
0004's `firestore.rules` lock down — this lib is the typed producer of those exact
strings, and `availabilityDocPath(tmdbId, region)`'s `{region}` segment is a
`Region` from `@vultus/shared/domain`.

## Public types / APIs

Everything is exported through the single barrel
`libs/shared/firestore-schema/src/index.ts` (alias `@vultus/shared/firestore-schema`
→ `libs/shared/firestore-schema/src/index.ts`, confirmed in `tsconfig.base.json`).
The implementer **MAY** split definitions into `src/lib/{paths,converters,data-types}.ts`
re-exported from the barrel; the **public contract is the barrel** and the
**exported names below** (slices depend on them). The existing
`SHARED_FIRESTORE_SCHEMA_PLACEHOLDER` export is removed once real code lands.

All converters and types `import type { … } from '@vultus/shared/domain'`. **No**
firebase/SDK import anywhere in the lib.

### Path builders (SDK-agnostic string paths) — full set

Return plain `string` Firestore paths. Document paths have an even number of
segments; collection paths an odd number. Names are the contract.

```ts
import type { Region } from '@vultus/shared/domain';

// Collection-id segment constants (exposed; cheap and single-source).
export const COLLECTIONS = {
  users: 'users',
  watchlist: 'watchlist',
  episodes: 'episodes',
  notifications: 'notifications',
  titleCache: 'title-cache',
  availability: 'availability',
} as const;

// users/{userId}
export function userPath(userId: string): string;

// users/{userId}/watchlist           (collection)
export function watchlistPath(userId: string): string;
// users/{userId}/watchlist/{titleId}
export function watchlistItemPath(userId: string, titleId: string): string;

// users/{userId}/watchlist/{titleId}/episodes            (collection)
export function episodesPath(userId: string, titleId: string): string;
// users/{userId}/watchlist/{titleId}/episodes/{episodeId}
export function episodePath(
  userId: string,
  titleId: string,
  episodeId: string,
): string;

// users/{userId}/notifications                 (collection)
export function notificationsPath(userId: string): string;
// users/{userId}/notifications/{notificationId}
export function notificationPath(
  userId: string,
  notificationId: string,
): string;

// title-cache              (collection)
export function titleCachePath(): string;
// title-cache/{tmdbId}
export function titleCacheDocPath(tmdbId: number): string;

// title-cache/{tmdbId}/availability            (collection)
export function availabilityPath(tmdbId: number): string;
// title-cache/{tmdbId}/availability/{region}   — region is a domain Region
export function availabilityDocPath(tmdbId: number, region: Region): string;
```

Notes for the implementer:

- `tmdbId: number` is interpolated into the path as `String(tmdbId)` — the
  `title-cache` document id is the tmdb id (PLAN §4). Keep this consistent between
  `titleCacheDocPath` and `availabilityPath`/`availabilityDocPath`.
- Build paths from `COLLECTIONS` constants (not bare string literals scattered
  through the file) so the path structure has one source. A tiny private
  `join(...segments)` helper is fine; do not over-engineer.
- No leading/trailing slash; segments joined by `/` (e.g.
  `userPath('u1') === 'users/u1'`).

### Structural Timestamp boundary type

```ts
// Minimal structural shape that BOTH the client SDK Timestamp and the Admin SDK
// Timestamp satisfy. The lib never imports either SDK; the read converters accept
// anything with toDate(). Slices pass the SDK's own Timestamp instance straight
// in — do NOT pre-convert before calling the read converter.
export interface FirestoreTimestampLike {
  toDate(): Date;
}
```

### Per-document data (wire) types — explicit read/write shapes

Use **explicit, hand-written** per-document data interfaces (chosen over a clever
mapped/generic `WriteData<T>`/`ReadData<T>` — explicit is more readable and
reviewable here, and the set is small and stable). For each document there is a
**read** shape (timestamps as `FirestoreTimestampLike`) and a **write** shape
(timestamps as `Date`); non-timestamp fields reuse the domain types directly.
Suggested naming: `XReadData` / `XWriteData`. Example for the two trickiest
documents (the rest follow the same pattern; the full set is `User`,
`WatchlistItem`, `EpisodeDoc`, `NotificationDoc`, `TitleCacheEntry`,
`RegionAvailability`):

```ts
import type {
  FcmToken,
  NotificationPrefs,
  WatchProvider,
  TitleType,
  WatchStatus,
  Region,
  NotificationKind,
  NotificationPayload,
  TitleMetadata /* …domain types */,
} from '@vultus/shared/domain';

// --- User: nested timestamp inside fcmTokens[] ---
export interface FcmTokenReadData {
  token: string;
  deviceId: string;
  createdAt: FirestoreTimestampLike;
}
export interface FcmTokenWriteData {
  token: string;
  deviceId: string;
  createdAt: Date;
}
export interface UserReadData {
  region: Region;
  notificationPrefs: NotificationPrefs; // passes through
  fcmTokens: FcmTokenReadData[]; // per-element mapped
}
export interface UserWriteData {
  region: Region;
  notificationPrefs: NotificationPrefs;
  fcmTokens: FcmTokenWriteData[];
}

// --- EpisodeDoc: nullable timestamp ---
export interface EpisodeReadData {
  season: number;
  episode: number;
  airDate: FirestoreTimestampLike;
  watched: boolean;
  watchedAt: FirestoreTimestampLike | null; // null → null
}
export interface EpisodeWriteData {
  season: number;
  episode: number;
  airDate: Date;
  watched: boolean;
  watchedAt: Date | null;
}
```

`WatchlistItemReadData`/`…WriteData` (only `addedAt` differs),
`NotificationReadData`/`…WriteData` (`sentAt`; `readAt: … | null`; `payload`
passes through), `TitleCacheReadData`/`…WriteData` (`lastSyncedAt`; `metadata`
passes through), and `RegionAvailabilityReadData`/`…WriteData` (`lastSyncedAt`;
`providers` and `previousSnapshot` are `WatchProvider[]` passing straight through)
follow identically.

### Converter functions — read/write pairs

Pure functions; names are the contract. Pattern: `xToData` (domain → write data)
and `dataToX` / `…To<Domain>` (read data → domain). Pick **one** consistent naming
convention across all six and apply it uniformly (suggested: `userToData` /
`dataToUser`).

```ts
import type {
  User,
  WatchlistItem,
  EpisodeDoc,
  NotificationDoc,
  TitleCacheEntry,
  RegionAvailability,
} from '@vultus/shared/domain';

export function userToData(user: User): UserWriteData;
export function dataToUser(data: UserReadData): User;

export function watchlistItemToData(
  item: WatchlistItem,
): WatchlistItemWriteData;
export function dataToWatchlistItem(data: WatchlistItemReadData): WatchlistItem;

export function episodeToData(ep: EpisodeDoc): EpisodeWriteData;
export function dataToEpisode(data: EpisodeReadData): EpisodeDoc;

export function notificationToData(n: NotificationDoc): NotificationWriteData;
export function dataToNotification(data: NotificationReadData): NotificationDoc;

export function titleCacheToData(t: TitleCacheEntry): TitleCacheWriteData;
export function dataToTitleCache(data: TitleCacheReadData): TitleCacheEntry;

export function availabilityToData(
  a: RegionAvailability,
): RegionAvailabilityWriteData;
export function dataToAvailability(
  data: RegionAvailabilityReadData,
): RegionAvailability;
```

Implementation rules:

- **Write:** each timestamp domain field `iso: string` → `new Date(iso)`; nullable
  `iso: string | null` → `iso === null ? null : new Date(iso)`. Non-timestamp
  fields copied through. `fcmTokens` mapped element-wise; `providers` /
  `previousSnapshot` / `metadata` / `payload` / `notificationPrefs` copied as-is.
- **Read:** each timestamp field `ts: FirestoreTimestampLike` →
  `ts.toDate().toISOString()`; nullable → `ts === null ? null :
ts.toDate().toISOString()`. Non-timestamp fields copied through; `fcmTokens`
  mapped element-wise.
- **Do not** import or construct any SDK `Timestamp`. **Do not** validate. **Do
  not** redefine any domain field.

### Optional compile-time alignment assertion (allowed, not required)

The implementer **may** add a `src/lib/type-assertions.ts` lib-source file (like
spec 0003's) asserting the read/write data types stay structurally aligned with
the domain types — e.g. that stripping the timestamp fields from `UserWriteData`
and from `User` leaves identical non-timestamp shapes. This is a nicety; the
**primary gate is the runtime round-trip tests + `typecheck` + `lint`**. If added,
it is a `.ts` source file (compiled by `typecheck`), not a `.spec.ts`, and is not
re-exported from the barrel.

## UI / Stitch screen refs

Not applicable. No mobile UI is built; this is a pure-TypeScript `scope:shared`
boundary lib with no screens, components, or design tokens.

## Implementation task graph

This is a **single-lib, single-scope** spec implemented by **one engineer** (the
feature-implementer — no UI, no Firebase, no SDK). It is small and the three
units (data-types, paths, converters) share the barrel and a co-located test
surface, so they do **not** form parallelizable units. **All tasks are
[sequential]** — there is no parallel fan-out and therefore no per-task file
manifest is needed (the whole change is confined to
`libs/shared/firestore-schema/src/**`). Do not over-fragment.

1. **[sequential] Define the structural Timestamp type + per-document data
   shapes.**
   - Add `FirestoreTimestampLike` and the explicit `…ReadData`/`…WriteData`
     interfaces for all six documents (incl. `FcmTokenReadData`/`FcmTokenWriteData`),
     importing the non-timestamp field types from `@vultus/shared/domain`.
   - Files: `libs/shared/firestore-schema/src/lib/data-types.ts` (or inline in
     `index.ts`).

2. **[sequential] Add the path builders + `COLLECTIONS` constants.**
   - Implement the full path-builder set from Public types / APIs, building from
     `COLLECTIONS`; `region: Region` typed from the domain.
   - Files: `libs/shared/firestore-schema/src/lib/paths.ts` (or inline).

3. **[sequential] Add the converter pairs.**
   - Implement the six `…ToData` / `dataTo…` pairs per the read/write idiom
     (`new Date(iso)` on write, `.toDate().toISOString()` on read; null-safe;
     `fcmTokens` element-wise; providers/snapshots/payload/metadata/prefs through).
   - Add **no** firebase/SDK import; construct **no** SDK `Timestamp`.
   - Files: `libs/shared/firestore-schema/src/lib/converters.ts` (or inline).

4. **[sequential] Wire the barrel and remove the placeholder.**
   - `libs/shared/firestore-schema/src/index.ts` re-exports paths, converters, and
     data types; remove `SHARED_FIRESTORE_SCHEMA_PLACEHOLDER`.
   - Files: `libs/shared/firestore-schema/src/index.ts`.

5. **[sequential] Write the round-trip + path unit tests.**
   - The converter round-trip and path-equality tests from Test plan, using the
     fake-Timestamp helper for the read side.
   - Files: `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts` (the
     lib's `vite.config.mts` `include` matches `src/**/*.spec.ts`).

6. **[sequential] (Optional) Add the compile-time alignment assertion.**
   - Only if pursued: `libs/shared/firestore-schema/src/lib/type-assertions.ts`
     (lib source, compiled by `typecheck`, not re-exported).
   - Files: `libs/shared/firestore-schema/src/lib/type-assertions.ts`.

7. **[sequential] Verify the definition-of-done gates locally.**
   - `pnpm nx lint shared-firestore-schema`, `pnpm nx typecheck
shared-firestore-schema`, `pnpm nx test shared-firestore-schema` (or
     `pnpm nx affected -t lint typecheck test --base=main`). All green. Record the
     commands in the PR description.

## Test plan

Per the PLAN §5 pyramid, tailored. Unlike spec 0003 (type-only), the converters
have **real runtime behavior**, so the centerpiece is **runtime unit tests**
(Vitest) — **no emulator, no Firebase, no SDK** required. All tests live in
`libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`.

- **Converter round-trip identity (the centerpiece)** — for **each** of the six
  documents, build a fully-populated domain object (every field set, realistic ISO
  timestamps) and assert:

  `dataToX(simulateStored(xToData(domain)))` deep-equals `domain`.

  Where `simulateStored` models what Firestore does to a write payload: a JS
  `Date` becomes a stored Timestamp that, on read back, is an object with
  `toDate()`. Use a **tiny fake Timestamp** for the read side — no SDK needed:

  ```ts
  const fakeTs = (d: Date): FirestoreTimestampLike => ({ toDate: () => d });
  ```

  `simulateStored` walks the write-data object and replaces each `Date` with
  `fakeTs(date)` (including nested `fcmTokens[].createdAt`), leaving non-timestamp
  fields untouched. Assert with `toEqual`. Cover specifically:
  - `User` — including a **multi-element `fcmTokens` array** so the nested
    `createdAt` mapping is exercised per element, and `notificationPrefs` passing
    through unchanged.
  - `WatchlistItem` — `addedAt` round-trips; `traktId: null` survives.
  - `EpisodeDoc` — **two cases:** `watchedAt` set (ISO ↔ Date) **and**
    `watchedAt: null` (null ↔ null), with `watched` true/false respectively.
  - `NotificationDoc` — `sentAt` set; **two cases** for `readAt` (set and `null`);
    `payload` (incl. optional `providerName`) passing through unchanged.
  - `TitleCacheEntry` — `lastSyncedAt` round-trips; `metadata` (incl.
    `posterPath: null`, `releaseDate: null`) passing through.
  - `RegionAvailability` — `lastSyncedAt` round-trips; `providers` **and**
    `previousSnapshot` (`WatchProvider[]`, no timestamps) pass straight through,
    including an **empty `previousSnapshot: []`** case.

- **Directional spot-checks** (cheap, catch a swapped direction): assert
  `xToData(domain).<tsField> instanceof Date` (write emits `Date`, not string) and
  `dataToX(readData).<tsField> === '<expected ISO>'` (read emits ISO string) for at
  least one field, so a converter that forgot to convert (passed the value through)
  fails.
- **Path-builder equality** — assert the exact string for **every** builder:
  - `userPath('u1') === 'users/u1'`
  - `watchlistPath('u1') === 'users/u1/watchlist'`
  - `watchlistItemPath('u1','t9') === 'users/u1/watchlist/t9'`
  - `episodesPath('u1','t9') === 'users/u1/watchlist/t9/episodes'`
  - `episodePath('u1','t9','e3') === 'users/u1/watchlist/t9/episodes/e3'`
  - `notificationsPath('u1') === 'users/u1/notifications'`
  - `notificationPath('u1','n2') === 'users/u1/notifications/n2'`
  - `titleCachePath() === 'title-cache'`
  - `titleCacheDocPath(603) === 'title-cache/603'`
  - `availabilityPath(603) === 'title-cache/603/availability'`
  - `availabilityDocPath(603, 'NL') === 'title-cache/603/availability/NL'`
  - Plus: every document path has an **even** segment count and every collection
    path an **odd** count (a single helper assertion guards the
    collection-vs-document invariant).
- **Compile-time:** `typecheck` (`tsc --noEmit -p tsconfig.lib.json`) compiles the
  data types + converters (and the optional `type-assertions.ts` if added),
  catching any drift from the domain types. (It does **not** catch an accidental
  SDK import — `firebase-admin`/`firebase-functions` are root deps and resolve;
  the no-firebase rule is enforced by code review + the SDK-free tests, not by
  `typecheck`.) The lib's `tsconfig.lib.json` **excludes** `*.spec.ts`, so the
  spec is gated by `test`, not `typecheck` — the runtime tests are the real
  converter gate, exactly as intended for runtime behavior.
- **Component tests:** none — no UI.
- **e2e / emulator tests:** none — no flow, and crucially **no emulator is needed**
  because the converters are pure and the SDK is faked structurally via
  `FirestoreTimestampLike`. (Emulator-backed verification of the rules is spec
  0004's concern.)

## Definition of done

Tailored from the PLAN §5 checklist (no component/e2e/emulator — no UI, no flow,
pure functions). Verified target set for `shared-firestore-schema` (via `nx show
project shared-firestore-schema`): `lint`, `typecheck`, `build-deps`,
`watch-deps`, `test` — there is **no `build` target**. Only `lint` / `typecheck`
/ `test` are run; `build-deps` / `watch-deps` are internal TS project-reference
helpers, not a build. So `build` is **not** part of the DoD and must not be
invoked.

- [ ] `pnpm nx typecheck shared-firestore-schema` passes — `tsc --noEmit -p
    tsconfig.lib.json` compiles the data types + converters + path builders
      (+ optional `type-assertions.ts`), proving structural alignment with
      `@vultus/shared/domain`. (Note: `typecheck` does **not** enforce the
      no-firebase rule — `firebase-admin`/`firebase-functions` are root deps, so
      an SDK import would resolve. The no-firebase constraint is verified by code
      review + the SDK-free round-trip tests; see below.)
- [ ] `pnpm nx lint shared-firestore-schema` passes with Sheriff active — the lib
      imports only `scope:shared` (`@vultus/shared/domain`) and no cross-scope
      **workspace** module. (Sheriff governs only `scope:`/`slice:` boundaries
      between workspace projects; it does **not** police the third-party firebase
      import — that is checked separately, below.)
- [ ] `pnpm nx test shared-firestore-schema` passes — every converter round-trip
      (incl. null timestamps and nested `fcmTokens`/`providers`/`previousSnapshot`)
      and every path-builder equality assertion is green.
- [ ] All names in Public types / APIs (path builders, `COLLECTIONS`,
      `FirestoreTimestampLike`, the `…ReadData`/`…WriteData` types, the six
      converter pairs) are exported through `@vultus/shared/firestore-schema` (the
      single barrel); `SHARED_FIRESTORE_SCHEMA_PLACEHOLDER` is removed.
- [ ] **No** `firebase` / `firebase-admin` / `@angular/fire` /
      `@google-cloud/firestore` import is added; **no** SDK `Timestamp` is
      constructed; **no** SDK `FirestoreDataConverter` object is produced;
      converters perform **no** runtime validation. This is **verified by code
      review of the diff** (the feature-reviewer greps the changed files for those
      module specifiers) — _not_ by the toolchain, since those packages are root
      deps and would resolve. The SDK-free round-trip tests (which pass with only
      a fake `{ toDate }` and plain `Date`) independently demonstrate no SDK is
      needed. No domain shape is redefined — all persisted field types come from
      `@vultus/shared/domain`.
- [ ] `pnpm nx affected -t lint typecheck test --base=main` is green (the affected
      set for a `libs/shared/firestore-schema` change is this lib plus any
      dependents already on `main`, currently none).
- [ ] No secret is read or written (none is needed).
- [ ] PR description records the exact verification commands run.

## Risks

- **The `Date`-on-write / `toDate()`-on-read trick is the load-bearing
  assumption.** It relies on two facts true for **both** Firebase SDKs: (1)
  Firestore coerces a JS `Date` to a stored `Timestamp` on write, so the lib never
  builds a `Timestamp`; (2) the value read back is an SDK `Timestamp` exposing
  `toDate()`, which `FirestoreTimestampLike` captures structurally. **Consuming
  slices must pass the SDK's own `Timestamp` instance straight into the read
  converter** — not a value they pre-converted, and not a raw Firestore JSON map.
  If a slice reads via a path that yields plain objects (e.g. REST/`getDoc().data()`
  with custom serialization), it must still hand the converter something with
  `toDate()`. Mitigation: documented here and in code comments; the round-trip test
  proves the contract with a structural fake (the same shape any SDK Timestamp
  satisfies). This is the same boundary spec 0003 deliberately pushed here.
- **Provisional domain shapes flow through untouched.** `notificationPrefs`,
  `TitleMetadata` (`metadata`), and `NotificationPayload` (`payload`) are flagged
  provisional in spec 0003 and will gain fields when their slices are specced. The
  converters **copy these objects through** without inspecting them, so additive
  non-timestamp fields need **no converter change**. A converter update is needed
  **only if a future additive domain field is itself a `Timestamp`** (e.g. a
  hypothetical `metadata.firstAiredAt`) — then its `…ReadData`/`…WriteData` and the
  mapping must be extended **here**, with the field added to `shared/domain` first.
  Noted so a later spec author expects to touch this lib for new timestamp fields
  only.
- **No runtime validation is a deliberate trade-off.** Converters trust their
  input (we own every write; spec 0004's rules gate access). A malformed ISO
  string on the **write** path does **not** throw — `new Date('garbage')` yields
  an `Invalid Date` and is written as such; the failure mode is a `RangeError`
  later, on the **read** path, when `.toDate().toISOString()` is called on that
  invalid date. Either way this can only arise from a hand-corrupted document,
  which the round-trip tests and our controlled writes preclude. If real-world bad
  data ever appears, a defensive guard (or a thin validation pass) can be added
  **in this lib** without changing the public surface. Out of scope now (no zod),
  consistent with spec 0004's "validation deferred to converters", narrowed to
  "trust types".
- **Query helpers + composite indexes are deferred to slices.** PLAN §6 item 6
  names "type-safe query helpers"; shipping them now is impossible without knowing
  each slice's queries, and spec 0004 already deferred per-slice indexes
  (`firestore.indexes.json` empty). The risk is a later reader expecting a query
  layer here; mitigated by the explicit Out-of-scope statement and the path
  builders being the documented foundation slices build queries on.
- **No PLAN conflicts; no secrets.** This implements PLAN §6 item 6 (paths +
  converters now; query helpers deferred) and follows PLAN §4 path-for-path. The
  Firebase-free constraint is the only non-obvious design point and is forced by
  `scope:shared` being imported by two incompatible SDKs (§3) — documented above,
  not a deviation. No secret (TMDB/Trakt/FCM) is involved; data-source accuracy
  risks are not relevant to this pure-mapping lib.
