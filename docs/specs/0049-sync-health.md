---
number: 0049
slug: sync-health
title: Surface the daily sync's last-run status in the settings slice (sync-runs)
status: implementing
slices: [slice:settings]
scopes: [scope:shared, scope:functions, scope:mobile]
created: 2026-06-30
---

# Surface the daily sync's last-run status in the settings slice (sync-runs)

## Context

The sync pipeline now runs in two ways: the daily GitHub Actions cron POSTs to
the `syncTitles` `onRequest` function (specs 0009/0017), and the watchlist
toolbar "refresh now" invokes the `triggerSync` callable (specs 0025/0044/0048).
Both write `title-cache` via the engine, but **nothing surfaces whether either
actually ran**. Project memory (`verify-daily-sync-processes-titles`) records the
first green cron run returning `gathered:0` against an empty prod watchlist — the
exact kind of "did the pipeline even fire?" question the user currently cannot
answer from inside the app. Today the only evidence a sync happened is Cloud
Logging, which a normal app user never sees.

This spec gives the user a **read-only "Last synced" card on the Settings page**
so they can confirm, at a glance, that the sync pipeline is wired end-to-end:
when it last ran, how many titles it gathered/updated, and whether the last run
hit any errors. It introduces a small global `sync-runs/{runId}` collection that
the Cloud Functions write (one record per full run) and the client reads.

Intended outcome: opening **Settings** shows a "Last synced" card with a relative
timestamp ("Last synced 3 hours ago"), the `titlesGathered` / `titlesUpdated`
counts of the most recent run, and — if that run had errors — a prominent error
count (e.g. "3 errors"). If no run has ever happened, the card shows a "Never
synced" state.

### Locked decisions (from the decision record — do NOT re-litigate)

1. **Storage: a global `sync-runs/{runId}` collection** — top-level, like
   `title-cache`. **Read-only from the client** (`request.auth != null` may
   read), **written only by Cloud Functions** via the Admin SDK (which bypasses
   security rules). One document per full sync run; `runId == document ID`.
2. **Both entry points write a record.** The cron path (`syncTitles` →
   `runSync`) writes a record with `kind: 'cron'` and `userId: null` (a cron run
   covers the global union of all users). The manual path (`triggerSync` →
   `runTriggerSync`) writes a record with `kind: 'manual'` and `userId` set to
   the calling UID.
3. **The Settings card reads the single most-recent run** — `sync-runs` ordered
   by `startedAt` desc, `limit 1` — and shows its timestamp, `titlesGathered` /
   `titlesUpdated`, and (when `errorCount > 0`) the error count. **No specific
   error strings are shown** to the user — only the count. No record → "Never
   synced".
4. **Out of scope:** push notifications for sync failures; a per-user cron
   breakdown; a sync-run history list; automatic retry.

## Scope

In scope:

- **`scope:shared` (`shared/firestore-schema`):** add the `SyncRunDoc` domain
  shape + its read/write wire types + converters, and a `syncRunsCollection()`
  path helper (+ `syncRunDocPath(runId)`), mirroring the existing helpers and the
  ISO-string ↔ Timestamp converter boundary.
- **`scope:functions` (`apps/functions`):** write a `sync-runs` record at the end
  of both `runSync` (cron, `kind: 'cron'`, `userId: null`) and `runTriggerSync`
  (manual, `kind: 'manual'`, `userId: <uid>`); update `firestore.rules` to allow
  authenticated reads of `sync-runs` (and keep client writes denied); update
  `firestore.indexes.json` only if the `startedAt desc` query needs it (it does
  not — see Data model touchpoints).
- **`scope:mobile` (`slice:settings`):** a new `SyncStatusService` that queries
  `sync-runs` (`orderBy('startedAt','desc')`, `limit(1)`) and a new
  `SyncStatusCardComponent` rendered on `SettingsPage` showing the last-run
  summary or the "Never synced" empty state.

Out of scope (each stated explicitly so its absence is intentional):

- **Push notifications on sync failure** — not built; the card is passive
  display only.
- **A sync-run history list / per-run drill-down** — only the single most-recent
  run is read and shown.
- **Per-user cron breakdown** — a cron run records `userId: null` (it covers all
  users); the card does not attempt to attribute cron results to the current
  user.
- **Automatic retry / "sync again" affordance on the card** — the existing
  watchlist toolbar refresh button (spec 0025) remains the only manual trigger;
  this card adds no action.
- **Surfacing specific error strings to the user** — only `errorCount` is shown.
  The `errors: string[]` field is persisted for diagnosis (Cloud Logging / future
  tooling) but is **not** rendered in the UI.
- **A TTL / retention policy on `sync-runs`** — runs accumulate; pruning is a
  later concern (see Risks). v1 volume is trivial (one cron/day + occasional
  manual).
- **Changing the sync logic, the engine, the staleness filter, or the
  `system/sync` rate-limit doc** — this spec only _adds_ a record write at the
  end of each existing flow.

## Affected slices & Sheriff tags

| Project                 | Path                                        | Sheriff tags                     | Change                                                                              |
| ----------------------- | ------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| shared-firestore-schema | `libs/shared/firestore-schema`              | `scope:shared`                   | **add** `SyncRunDoc` + read/write data-types + converters + `syncRunsCollection()`  |
| functions (app)         | `apps/functions`                            | `scope:functions`                | **write** a `sync-runs` record in `runSync` + `runTriggerSync`; thin Firestore glue |
| (root config)           | `firestore.rules`, `firestore.indexes.json` | — (not a workspace project)      | **allow** authenticated `sync-runs` read; index unchanged (single-field orderBy)    |
| mobile-settings         | `libs/mobile/settings`                      | `scope:mobile`, `slice:settings` | **add** `SyncStatusService` + `SyncStatusCardComponent`; render on `SettingsPage`   |

- **Tagging is by PATH GLOB in `sheriff.config.ts`** (per specs 0009/0011) — all
  four paths already carry the tags above. **This spec does NOT edit
  `sheriff.config.ts`.** Verify, do not add. `firestore.rules` /
  `firestore.indexes.json` are root config, not Sheriff-governed workspace
  projects.
- **Import boundaries (verified against `sheriff.config.ts`):**
  - `libs/shared/firestore-schema` (`scope:shared`) may be imported by anyone. The
    `SyncRunDoc` domain type belongs in `@vultus/shared/domain` if it is a pure
    persistence-agnostic shape, but its **wire/converter** parts live in
    `@vultus/shared/firestore-schema` alongside the other `*ReadData`/`*WriteData`
    - converters. See Public types / APIs for the exact split (the domain ISO-string
      type in `shared/domain`, the wire types + converters in
      `shared/firestore-schema`) — both `scope:shared`, importable by both the
      settings slice and `apps/functions`.
  - `libs/mobile/settings` (`slice:settings`) may import `['scope:shared',
'slice:settings']` only. It imports `@vultus/shared/domain` (the `SyncRun`
    domain type) and `@vultus/shared/firestore-schema` (`syncRunsCollection`,
    `dataToSyncRun`) — both `scope:shared`, allowed (rule 4). It imports **no other
    slice** and **no `apps/mobile`**; AngularFire (`@angular/fire/firestore`) is
    third-party (not policed by Sheriff). It obtains the uid (if needed) only via
    the existing `AUTH_UID` `scope:shared` token, never by importing `apps/mobile`
    (mirrors `SettingsService`, spec 0011) — though see Data model touchpoints: the
    query is **not** uid-scoped, so the slice likely needs no uid at all.
  - `apps/functions` (`scope:functions`) importing `@vultus/shared/*` is allowed.
    Writing the `sync-runs` record uses the shared `syncRunsCollection` /
    `syncRunToData` + the Admin SDK (`firebase-admin`, third-party). It imports
    **no** `scope:mobile` symbol.
- **`SyncRunDoc` IS a legitimate `shared/` addition, not a premature DRY.** It is
  a **cross-scope persistence contract**: `apps/functions` (`scope:functions`)
  _writes_ it and `libs/mobile/settings` (`scope:mobile`) _reads_ it, and the two
  scopes may never import each other. A shared wire type + converter is the
  _only_ correct place for a Firestore document shape that crosses the
  functions↔mobile boundary — exactly what `shared/firestore-schema` exists for
  (it already holds `TitleCacheReadData` etc. for the same reason). This is not
  the "extract at 3+ slices" rule (that governs _behaviour_ duplication); a
  shared _data shape_ read by a slice and written by functions is the established
  pattern. No business logic is hoisted to `shared/` — the query lives in the
  settings slice, the record-build lives in `apps/functions`.

## Data model touchpoints

A **new top-level `sync-runs/{runId}` collection** (PLAN §4 currently documents
`users/**`, `title-cache/**`, and `system/sync`; this adds `sync-runs` as a
sibling global collection, like `title-cache`). It is **written only by Cloud
Functions** (Admin SDK, bypasses rules) and **read by the client** (the settings
slice).

| Path                | Access                | By                                                              |
| ------------------- | --------------------- | --------------------------------------------------------------- |
| `sync-runs/{runId}` | **write** (functions) | `runSync` (cron) + `runTriggerSync` (manual) via the Admin SDK  |
| `sync-runs/{runId}` | **read** (client)     | `SyncStatusService` — `orderBy('startedAt','desc')`, `limit(1)` |
| `title-cache/**`    | r/w (unchanged)       | the engine, as today — no change                                |
| `system/sync`       | r/w (unchanged)       | the cron rate-limit doc, as today — no change                   |
| `users/**`          | **none**              | this spec writes no `users/**` doc                              |

- **Document ID (`runId`).** Use an auto-generated Firestore document ID
  (`collection(...).add(...)` server-side, or `doc(collection(...))` then `.set`)
  and store that same value in the `runId` field so `runId == document ID`. The
  ID is **not** time-ordered text — ordering is by the `startedAt` Timestamp
  field, not the doc id.
- **The query needs NO composite index.** `orderBy('startedAt','desc') + limit(1)`
  with **no `where` clause** is a single-field order on one collection. Firestore
  provides single-field indexes automatically; a composite index is required only
  for `where` + `orderBy` on different fields or multiple range/orderBy fields.
  **So `firestore.indexes.json` is unchanged** — state this in the PR and do
  **not** add an index. (If, during implementation, the Firestore emulator or prod
  emits a "create index" link for this exact single-field-orderBy query — it will
  not for a single-field order — only then add the suggested entry; otherwise
  leave `firestore.indexes.json` as `{"indexes":[],"fieldOverrides":[]}`.)
- **`firestore.rules` — ADD a `sync-runs` block** (the one rules change). Mirror
  the existing `title-cache` pattern (authenticated read, client write denied):

  ```
  // ---- Global sync-run records — authenticated read, NEVER client-write ----
  // Written ONLY by Cloud Functions (Admin SDK, which bypasses these rules).
  // Any authenticated user (incl. anonymous) may READ to see last-sync status.
  match /sync-runs/{runId} {
    allow read: if request.auth != null;
    allow write: if false;
  }
  ```

  Place it **before** the final `match /{document=**} { allow read, write: if
false; }` default-deny (which must stay last). Like `title-cache`, do **not**
  add a "functions can write" allowance — the Admin SDK does not pass through
  these rules. Without this block, the default-deny would reject the client read
  and the Settings card would error.

- **No change to any existing document shape** — `title-cache`, `users/**`,
  `system/sync` are untouched. This spec only adds the new `sync-runs` collection.

## Public types / APIs

### Domain type (`@vultus/shared/domain`)

The persistence-agnostic shape (timestamps as ISO 8601 strings, matching every
other domain document — see `shared/domain` barrel header). Add to
`libs/shared/domain/src/lib/documents.ts` (where `NotificationDoc` etc. live):

```ts
/** A single completed sync-pipeline run, written by Cloud Functions to the
 *  global `sync-runs/{runId}` collection and read by the settings slice. */
export interface SyncRun {
  /** == the Firestore document ID. */
  runId: string;
  /** Which entry point wrote this run. */
  kind: 'cron' | 'manual';
  /** The calling UID for a manual run; `null` for a cron run (covers all users). */
  userId: string | null;
  /** ISO 8601 — when the run started. */
  startedAt: string;
  /** ISO 8601 — when the run completed. */
  completedAt: string;
  /** Wall-clock duration of the run, ms. */
  durationMs: number;
  /** Distinct titles gathered for this run. */
  titlesGathered: number;
  /** Titles the engine reported as `outcome: 'synced'`. */
  titlesUpdated: number;
  /** Number of titles the engine reported as `outcome: 'error'`. */
  errorCount: number;
  /** First ~10 error messages (credential-free); `[]` when none. */
  errors: string[];
}
```

> **Building `errors` — filter out `undefined`.** `SyncResult.reason` is
> optional (`reason?: string`), so an `outcome: 'error'` result is **not**
> guaranteed to carry a reason. When building the `errors: string[]` array,
> implementers must drop the missing ones (and only then cap at 10), e.g.:
>
> ```ts
> const errors = results
>   .filter((r) => r.outcome === 'error')
>   .map((r) => r.reason)
>   .filter((s): s is string => !!s)
>   .slice(0, 10);
> ```
>
> The type-guard `.filter((s): s is string => !!s)` keeps `errors` a true
> `string[]` (no `undefined` leaking into the persisted array).

> **Reconciliation note (see Risks).** The decision record sketches `SyncRunDoc`
> with `startedAt`/`completedAt` typed as Firestore `Timestamp`. The repo's
> established boundary is: **domain types carry ISO 8601 strings** (no SDK type),
> and the **Timestamp boundary lives in `shared/firestore-schema`** read/write
> data-types + converters (see `data-types.ts` / `converters.ts`). This spec
> follows that convention — `SyncRun` (domain) uses ISO strings; the wire types
> below carry the Timestamp boundary. The persisted _fields_ are exactly those in
> the decision record; only the in-memory representation follows the house style.
> The interface is named `SyncRun` (domain) with `SyncRunReadData`/`SyncRunWriteData`
> wire types, consistent with `User`/`UserReadData` etc.

### Wire types + converters (`@vultus/shared/firestore-schema`)

Add to `libs/shared/firestore-schema/src/lib/data-types.ts`:

```ts
export interface SyncRunReadData {
  runId: string;
  kind: 'cron' | 'manual';
  userId: string | null;
  startedAt: FirestoreTimestampLike;
  completedAt: FirestoreTimestampLike;
  durationMs: number;
  titlesGathered: number;
  titlesUpdated: number;
  errorCount: number;
  errors: string[];
}
export interface SyncRunWriteData {
  runId: string;
  kind: 'cron' | 'manual';
  userId: string | null;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  titlesGathered: number;
  titlesUpdated: number;
  errorCount: number;
  errors: string[];
}
```

Add to `libs/shared/firestore-schema/src/lib/converters.ts` (mirroring
`titleCacheToData` / `dataToTitleCache` — only the two timestamps cross the
boundary; everything else passes through):

```ts
export function syncRunToData(run: SyncRun): SyncRunWriteData {
  return {
    runId: run.runId,
    kind: run.kind,
    userId: run.userId,
    startedAt: new Date(run.startedAt),
    completedAt: new Date(run.completedAt),
    durationMs: run.durationMs,
    titlesGathered: run.titlesGathered,
    titlesUpdated: run.titlesUpdated,
    errorCount: run.errorCount,
    errors: run.errors,
  };
}
export function dataToSyncRun(data: SyncRunReadData): SyncRun {
  return {
    runId: data.runId,
    kind: data.kind,
    userId: data.userId,
    startedAt: data.startedAt.toDate().toISOString(),
    completedAt: data.completedAt.toDate().toISOString(),
    durationMs: data.durationMs,
    titlesGathered: data.titlesGathered,
    titlesUpdated: data.titlesUpdated,
    errorCount: data.errorCount,
    errors: data.errors,
  };
}
```

> **Imports note.** `converters.ts` imports domain types from
> `@vultus/shared/domain`; add `SyncRun` to that import group. `data-types.ts`
> already imports `FirestoreTimestampLike`'s siblings from `@vultus/shared/domain`
> — `kind`/`userId` are inline primitives (no new domain import needed there
> beyond what `SyncRun` itself uses).

### Path helpers (`@vultus/shared/firestore-schema`)

Add to `libs/shared/firestore-schema/src/lib/paths.ts`, mirroring the
`title-cache` helpers and adding the collection-id constant:

```ts
// in COLLECTIONS:  syncRuns: 'sync-runs',

// sync-runs                 (collection)
export function syncRunsCollection(): string {
  return COLLECTIONS.syncRuns;
}
// sync-runs/{runId}
export function syncRunDocPath(runId: string): string {
  return join(syncRunsCollection(), runId);
}
```

All of `SyncRun`, `SyncRunReadData`, `SyncRunWriteData`, `syncRunToData`,
`dataToSyncRun`, `syncRunsCollection`, `syncRunDocPath` are re-exported by the
existing `shared/domain` / `shared/firestore-schema` barrels (the barrels are
`export *` — verify the new symbols flow through). Update both lib READMEs.

### Functions: building the record (`apps/functions`)

No new exported symbol is required, but the record must be written at the end of
both flows. Keep the Firestore write thin (a `firestore-io.ts` helper) and the
field-mapping pure where convenient.

- **Cron (`runSync`, `apps/functions/src/main.ts`):** `runSync` already computes
  `start`/`end` (epoch ms), `gathered`, `synced`, `errored`, and the
  `SyncResult[]`. After `writeSyncState(...)`, also write a `sync-runs` record:
  - `kind: 'cron'`, `userId: null`.
  - `startedAt`/`completedAt`: ISO strings from the existing `start`/`end` epoch
    ms (`new Date(start).toISOString()` / `new Date(end).toISOString()`), or pass
    `Date`s straight into the write helper (see below).
  - `durationMs`: the existing `end - start`.
  - `titlesGathered`: the existing `gathered`.
  - `titlesUpdated`: the existing `synced`.
  - `errorCount`: the existing `errored`.
  - `errors`: collect up to **the first 10** credential-free error messages from
    the `SyncResult[]` with `outcome: 'error'` (use the engine's per-title
    `reason`/error text, which spec 0008 guarantees credential-free); `[]` when
    none. **Cap at 10** to bound the doc size.
- **Manual (`runTriggerSync`, `apps/functions/src/main.ts`):** `runTriggerSync`
  already computes the `synced`/`skipped`/`errored` counts and has `inputs`
  (gathered count) and the `SyncResult[]`. It must now also capture a start
  timestamp (add `const start = Date.now()` at the top, or reuse a `now` if one
  exists) so it can record `startedAt`/`durationMs`. After the engine pass, write
  a `sync-runs` record:
  - `kind: 'manual'`, `userId: uid` (the verified `uid`, already in scope).
  - `startedAt`/`completedAt`/`durationMs` from the captured start + a completion
    `Date.now()`.
  - `titlesGathered`: `inputs.length`.
  - `titlesUpdated`: `synced`.
  - `errorCount`: `errored`.
  - `errors`: first 10 credential-free error messages, as above; `[]` when none.
- **The write itself** — add a `writeSyncRun(db, run)` helper to
  `apps/functions/src/lib/firestore-io.ts`:

  ```ts
  import {
    syncRunsCollection,
    syncRunToData,
  } from '@vultus/shared/firestore-schema';
  import type { SyncRun } from '@vultus/shared/domain';

  /** Write one completed sync run to `sync-runs/{runId}` (auto-id == runId). */
  export async function writeSyncRun(
    db: Firestore,
    run: Omit<SyncRun, 'runId'>,
  ): Promise<string> {
    const ref = db.collection(syncRunsCollection()).doc(); // auto-id
    const runId = ref.id;
    await ref.set(syncRunToData({ ...run, runId }));
    return runId;
  }
  ```

  (Generating the id from `.doc()` so `runId == ref.id` is set into the document,
  then `.set(...)`. The helper takes the `Omit<SyncRun,'runId'>` so callers do not
  pre-invent the id.)

- **Best-effort / non-fatal.** The record write must **not** change the response
  contract or fail the run. Wrap it so a `sync-runs` write error is logged
  (`logger.error('[syncRun] failed to record run', err)`) but does **not** alter
  the existing `SyncRunResponse` (cron) or `TriggerSyncResponse` (manual), nor
  re-throw — the sync itself already succeeded; recording it is observability.
  (For the cron path, the record write happens after `writeSyncState`; for manual,
  after the engine pass and before the `{ syncedAt }` return.)
- **No change** to `dispatchNotifications`, the engine, the staleness filter, the
  `system/sync` doc, the auth/cors/secret config, or either response shape.

## UI / Stitch screen refs

This is a `scope:mobile` change to the **existing** Settings page —
**no new screen.** The Settings screen is **already captured and aligned** by
spec 0018: project `projects/13590348714018893783`, screen ID
**`81945ff3381e453dafcc4e5ce896fcfa`** ("Settings - Vultus"). This card is an
**additional read-only row in the same card stack**; it reuses the existing
`.settings-card` / `.settings-row` pattern already in
`libs/mobile/settings/src/lib/settings.page.{html,scss}` (a left icon tile + a
body column with a title and helper/value text). The implementer should pull that
screen for visual reference if extending the layout meaningfully, but the
authoritative structure is the **in-repo** card pattern that spec 0018 already
built to match it — match the _sibling_ Region/Notifications cards, do not invent
a new card shape.

**Authoritative tokens live in `docs/design/vultus-design-system.md`** and are
wired into `shared/ui-kit` `theme.scss` as `--vultus-*` / `--ion-*` vars —
**consume those vars; do not hand-transcribe hex values.** (Reminder: primary is
`#4edea3`; `#10B981` is `primary-container`, NOT primary.)

**Where it goes.** Add the "Last synced" card as a **sibling `.settings-card`
inside `.settings-cards`**, after the Region and Notifications cards (it is
status/info, so it sits below the user-changeable controls). It reuses the exact
row structure: `.settings-row` → `.settings-row__icon` (icon tile) +
`.settings-row__body` (title + value/helper). It is **read-only** — no
`ion-select`/`ion-toggle`, no interactive control. It renders **inside** the
existing `@else if (service.loaded())` branch (so it shares the page's
load-gate), or as its own component that manages its own loading internally —
see the per-state list. Implement it as the **`SyncStatusCardComponent`** (a
standalone component the page imports and places in the card stack), keeping
`SettingsPage`'s template legible.

This is a **checkable contract** — pin these values (reconcile exact spacing
against the sibling cards; where the sibling cards specify a value, match it so
the new card aligns with them):

- **Card container:** the existing `.settings-card` (surface-container fill,
  `--vultus-radius-md` radius, 1px `outline-variant` hairline at 20% alpha, 16px
  `--vultus-space-md` internal padding). **Identical** to the Region/Notifications
  cards so the three align in the stack with the existing `--vultus-space-sm` (8px)
  gap. **No `&:active` press-tint** is required (the card is non-interactive); if
  reusing `.settings-card` verbatim brings the press tint, that is acceptable but
  the card must not be tappable/focusable.
- **Icon tile:** the existing `.settings-row__icon` (40×40px, `--vultus-radius`
  0.5rem, `surface-container-highest` @ 50% alpha, primary-coloured 22px glyph).
  Use ionicon **`sync-outline`** (idle/success) — register it via `addIcons`. When
  the last run has `errorCount > 0`, the glyph is **`alert-circle-outline`** in the
  **danger** color (`--ion-color-danger` / the design `error` token via the var —
  do **not** hardcode `#ffb4ab`).
- **Title:** text **"Last synced"** in the same role as the sibling card titles —
  **body-lg** (16/400/24, weight 600 as the sibling `.settings-row__select` label
  uses), `--vultus-on-surface` color. (Type roles per
  `docs/design/vultus-design-system.md` §typography: `body-lg` = list/row titles.)
- **Value / helper line:** below the title, **body-md** (14/400/20) in
  `--vultus-on-surface-variant`, reusing the `.settings-row__helper` style
  (8px `--vultus-space-sm` above it). Content depends on state (below).
- **Error chip (when `errorCount > 0`):** the error count rendered prominently as
  a **label-md** chip/pill (12/600, +0.05em per the design label scale) with
  `--ion-color-danger` text/fill-tint, e.g. text **"3 errors"** (pluralize: "1
  error" / "N errors"). Place it trailing on the title row (right-aligned via the
  same row flex) or directly under the title — pin it to the title row's trailing
  edge to mirror how the Region card trails its value in primary. Use the `error`
  token via the var; do **not** hardcode.

**Per-state acceptance list (the reviewer/human ticks each):**

- **loading (sync-runs query in flight):** an `ion-skeleton-text` placeholder the
  height of one card (reuse `.settings-skeleton__card` ~96px), or — if the card
  is rendered only inside the page's `@else if (service.loaded())` gate and the
  query is fast — a minimal inline spinner. Pin: the card never renders stale/blank
  content before the query resolves.
- **never-synced (query returns empty):** icon `sync-outline`, title "Last
  synced", value line **"Never synced"** in `on-surface-variant`. No counts, no
  error chip.
- **load-failed (the `sync-runs` Firestore query rejects):** the card **silently
  falls back to the "Never synced" display** — same icon/title/value as
  never-synced, **no** error affordance, **no** banner/toast. This is
  non-essential observability, not a blocking UI path, so a failed read must not
  surface an error to the user (and must not block the rest of the Settings
  page). Pin: `loadFailed()` renders identically to the never-synced state.
- **success (latest run, `errorCount == 0`):** icon `sync-outline`; title "Last
  synced"; value line shows a **relative timestamp** ("Last synced 3 hours ago" /
  "Last synced just now" — derived from `startedAt`) followed by the counts
  **"{titlesGathered} gathered · {titlesUpdated} updated"**. No error chip. (Exact
  copy/format is the implementer's call; pin: a human-readable relative time + both
  counts, no raw ISO string.)
- **with-errors (latest run, `errorCount > 0`):** icon swaps to
  `alert-circle-outline` in danger; the value line shows the relative timestamp +
  counts as above; the **error chip "{errorCount} error(s)"** in danger renders
  prominently. **No specific error strings** (decision 3) — count only.
- **focus/hover/active:** the card is **non-interactive read-only display** — it
  is **not** a button/link, takes **no** focus ring, has **no** hover/active
  feedback. (Explicitly: do not make the card tappable or focusable. If it reuses
  `.settings-card`'s `&:active` tint that is cosmetically harmless but there is no
  click handler.)
- **disabled:** N/A — no control.

**Token wiring reminder:** Inter is already loaded as a web-font (spec 0010 wired
the Google Fonts link); this feature adds no new font — verify, do not merely
name it. All colors/spacing/type come from the `--vultus-*`/`--ion-*` vars the
sibling cards already consume.

**Mock profile:** the `mock` build profile swaps `settings.providers.ts` for
`settings.providers.mock.ts` (spec 0018). The mock `SETTINGS_PROVIDERS` must also
provide a mock `SyncStatusService` (structural mirror, no Firebase) seeded with a
plausible recent run (e.g. ~2h ago, `titlesGathered: 12`, `titlesUpdated: 3`,
`errorCount: 0`) so `mobile:serve-mock` renders the success state for visual
verification — and the implementer can flip a seed value to eyeball the
never-synced and with-errors states.

## Implementation task graph

One sequential shared prerequisite (the `sync-runs` shape + path helper, which
both the functions write and the mobile read import), then two parallel slice
tasks (functions write + mobile UI) that write **disjoint** file sets.

### Sequential prerequisite

1. **[sequential] Add the `SyncRun` shape + converters + path helper to
   `shared/domain` + `shared/firestore-schema`.** frontend-engineer / domain.
   - `libs/shared/domain/src/lib/documents.ts`: add the `SyncRun` interface
     (Public types). Verify it flows through the `shared/domain` barrel.
   - `libs/shared/firestore-schema/src/lib/data-types.ts`: add `SyncRunReadData` /
     `SyncRunWriteData`.
   - `libs/shared/firestore-schema/src/lib/converters.ts`: add `syncRunToData` /
     `dataToSyncRun` (add `SyncRun` to the domain import group).
   - `libs/shared/firestore-schema/src/lib/paths.ts`: add `syncRuns: 'sync-runs'`
     to `COLLECTIONS`, plus `syncRunsCollection()` + `syncRunDocPath(runId)`.
   - Unit-test the converters (round-trip incl. the two timestamps, `userId` null
     and string, `errors: []` and a non-empty array) in
     `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts` (extend the
     existing suite) and add a path-helper assertion.
   - Update `libs/shared/domain/README.md` (add `SyncRun` to the documents list)
     and `libs/shared/firestore-schema/README.md` (add the data-types rows,
     converters, and path helpers).
   - `docs/PLAN.md`: add a one-line entry for `sync-runs/{runId}` under the
     **"Global"** section of the §4 data-model table (sibling to `title-cache` /
     `system/sync`) so PLAN §4 no longer drifts from the new collection —
     authenticated read, Admin-SDK-only write, one doc per full sync run.
   - **File manifest:** `libs/shared/domain/src/lib/documents.ts`,
     `libs/shared/domain/README.md`,
     `libs/shared/firestore-schema/src/lib/data-types.ts`,
     `libs/shared/firestore-schema/src/lib/converters.ts`,
     `libs/shared/firestore-schema/src/lib/paths.ts`,
     `libs/shared/firestore-schema/src/lib/firestore-schema.spec.ts`,
     `libs/shared/firestore-schema/README.md`,
     `docs/PLAN.md`.

### Parallel slice tasks (disjoint manifests — orchestrator asserts pairwise-disjoint before fan-out)

2. **[parallel] Write the `sync-runs` record in both flows + the rules block
   (`apps/functions` + `firestore.rules` + `firestore.indexes.json`,
   `scope:functions`). Depends on task 1.** backend-engineer (the record write +
   tests) with the rules edit; the index file is verified-unchanged.
   - `apps/functions/src/lib/firestore-io.ts`: add `writeSyncRun(db, run)`
     (Public types) using `syncRunsCollection` + `syncRunToData`.
   - `apps/functions/src/main.ts`: in `runSync`, after `writeSyncState`, build the
     cron record (`kind: 'cron'`, `userId: null`, the existing
     `start`/`end`/`gathered`/`synced`/`errored` + first-10 `errors`) and
     `writeSyncRun` it, **best-effort** (logged, non-fatal, response unchanged). In
     `runTriggerSync`, capture a start timestamp, after the engine pass build the
     manual record (`kind: 'manual'`, `userId: uid`, `inputs.length`/`synced`/
     `errored` + first-10 `errors`) and `writeSyncRun` it, **best-effort** (logged,
     non-fatal, `{ syncedAt }` return unchanged). Keep `RunSyncDeps`/
     `RunTriggerSyncDeps` testable — if `writeSyncRun` is invoked via the injected
     `db` it is already fakeable; if a clock is needed in `runTriggerSync`, inject
     it via the deps (or use `Date.now()` consistent with the existing pattern).
     - **`RunTriggerSyncDeps.now`:** add an optional `now?: () => number` field to
       `RunTriggerSyncDeps` (matching the `runSync` `deps.now` convention) so that
       `startedAt` / `durationMs` in the recorded run are deterministic and
       testable. Capture the start with `const start = deps.now?.() ?? Date.now()`
       and the completion the same way — **not** a bare
       `new Date().toISOString()` — so a test can inject a fixed clock and assert
       `durationMs`.
   - `firestore.rules`: add the `match /sync-runs/{runId}` block (authenticated
     read, `write: if false`) **before** the final default-deny (Data model).
   - `firestore.indexes.json`: **verify unchanged** (single-field orderBy needs no
     composite index) — record the verification; only add an entry if Firestore
     genuinely demands one for this exact query (it will not).
   - Tests (`apps/functions/src/main.spec.ts` / `trigger-sync.spec.ts` additions,
     fake engine + fake `db`): assert that after a cron run a `sync-runs` write
     occurs with `kind: 'cron'`, `userId: null`, and the right counts mapped from
     the engine results; that after a manual run a `sync-runs` write occurs with
     `kind: 'manual'`, `userId: <uid>`, counts mapped; that `errors` is capped at
     ≤10 and credential-free; that a **failing `writeSyncRun` does NOT change the
     response** and does NOT throw (best-effort); and that all **existing** 0009/
     0025/0048 cases stay green (the `users/**` no-write boundary still holds —
     `sync-runs` is the only _new_ write).
   - Update `apps/functions` README **only if one exists** (lib-README rule binds
     only `libs/**`).
   - **File manifest (creates/modifies):**
     - `apps/functions/src/main.ts`
     - `apps/functions/src/lib/firestore-io.ts`
     - `apps/functions/src/lib/firestore-io.spec.ts` (if present / add a focused test)
     - `apps/functions/src/main.spec.ts`
     - `apps/functions/src/trigger-sync.spec.ts`
     - `firestore.rules`
     - `firestore.indexes.json` (verify-only; expected no diff)

3. **[parallel] `SyncStatusService` + `SyncStatusCardComponent` on `SettingsPage`
   (`libs/mobile/settings`, `scope:mobile`/`slice:settings`). Depends on task 1.**
   frontend-engineer.
   - `libs/mobile/settings/src/lib/sync-status.service.ts`: a `SyncStatusService`
     (`@Injectable`) that injects AngularFire `Firestore`, queries
     `query(collection(firestore, syncRunsCollection()), orderBy('startedAt','desc'),
limit(1))`, maps the single doc via `dataToSyncRun`, and exposes the result as
     signals: e.g. `lastRun: Signal<SyncRun | null>`, `loaded: Signal<boolean>`,
     `loadFailed: Signal<boolean>` (mirror `SettingsService`'s loaded/loadFailed
     pattern). Provide a `load()` (one-shot `getDocs`) — a live subscription is
     **not** required (the card is informational; a fresh read on page open is
     enough). Empty result → `lastRun() === null` (the never-synced state).
   - `libs/mobile/settings/src/lib/sync-status-card.component.ts` (+ `.html` /
     `.scss` if separated, or inline): the read-only card per UI/Stitch refs,
     consuming `SyncStatusService`. Computes the relative-time string from
     `startedAt` (a small pure helper — unit-test it) and the
     gathered/updated/error display. Register `sync-outline` + `alert-circle-outline`
     via `addIcons`.
   - `libs/mobile/settings/src/lib/settings.page.{ts,html}`: import and place
     `<lib-sync-status-card>` in the `.settings-cards` stack after the
     Notifications card; trigger its `load()` (e.g. in the page `ngOnInit`
     alongside `service.load()`, or the component self-loads in its own
     `ngOnInit`).
   - `libs/mobile/settings/src/lib/settings.providers.ts`: add `SyncStatusService`
     to `SETTINGS_PROVIDERS`.
   - `libs/mobile/settings/src/lib/settings.providers.mock.ts`: add a structural
     mock `SyncStatusService` (no Firebase) seeded with a recent success run, so
     `mobile:serve-mock` renders the success state.
   - Tests: `sync-status.service.spec.ts` (mocked AngularFire `Firestore`: a doc
     present → `lastRun` mapped via `dataToSyncRun`; empty → `null`; query uses
     `orderBy('startedAt','desc') + limit(1)`; a failing read → `loadFailed`),
     `sync-status-card.component.spec.ts` (the four visual states: never-synced →
     "Never synced"; success → relative time + counts, no error chip;
     with-errors → error chip in danger + `alert-circle-outline`; loading →
     skeleton/no stale content), plus a unit test for the relative-time helper.
     Extend `settings.page.spec.ts` to assert the card renders in the stack.
   - Update `libs/mobile/settings/README.md`: add `SyncStatusService` +
     `SyncStatusCardComponent` to the public surface and note the read-only
     `sync-runs` query and its Sheriff boundaries.
   - **File manifest (creates/modifies):**
     - `libs/mobile/settings/src/lib/sync-status.service.ts`
     - `libs/mobile/settings/src/lib/sync-status.service.spec.ts`
     - `libs/mobile/settings/src/lib/sync-status-card.component.ts`
     - `libs/mobile/settings/src/lib/sync-status-card.component.html` (if separated)
     - `libs/mobile/settings/src/lib/sync-status-card.component.scss` (if separated)
     - `libs/mobile/settings/src/lib/sync-status-card.component.spec.ts`
     - `libs/mobile/settings/src/lib/settings.page.ts`
     - `libs/mobile/settings/src/lib/settings.page.html`
     - `libs/mobile/settings/src/lib/settings.page.spec.ts`
     - `libs/mobile/settings/src/lib/settings.providers.ts`
     - `libs/mobile/settings/src/lib/settings.providers.mock.ts`
     - `libs/mobile/settings/README.md`

(Tasks 2 and 3 write **disjoint** file sets — `apps/functions/**` + `firestore.*`
vs `libs/mobile/settings/**` — and may run in parallel after task 1.
`firebase-admin` / `@angular/fire` are already dependencies; verify, add nothing
new.)

## Test plan

Per the PLAN §5 pyramid: **unit** for the converters + the functions record-build

- the service query + the relative-time helper; **component** for the card's
  visual states; **no new e2e** (read-only display — rubric below).

**Unit — `scope:shared` (`firestore-schema.spec.ts`):**

- `syncRunToData` / `dataToSyncRun` round-trip: both timestamps map ISO ↔
  Timestamp-like; `userId` both `null` and a string; `errors` both `[]` and a
  populated array; `kind` both `'cron'` and `'manual'`; counts pass through.
- `syncRunsCollection()` === `'sync-runs'`; `syncRunDocPath('abc')` ===
  `'sync-runs/abc'`.

\*\*Unit — `scope:functions` (`main.spec.ts` / `trigger-sync.spec.ts`, fake engine

- fake `db`):\*\*

* **Cron:** after a `runSync` pass, a `sync-runs` write occurs with `kind:
'cron'`, `userId: null`, `titlesGathered`/`titlesUpdated`/`errorCount` matching
  the gathered/synced/errored counts, `durationMs == end - start`, and
  `startedAt`/`completedAt` set; the `SyncRunResponse` is **unchanged**.
* **Manual:** after a `runTriggerSync` pass, a `sync-runs` write occurs with
  `kind: 'manual'`, `userId: <uid>`, counts mapped from `inputs.length`/`synced`/
  `errored`; the `{ syncedAt }` response is **unchanged**.
* **`errors` cap + hygiene:** when the engine returns >10 `outcome:'error'`
  results, the recorded `errors` array has **≤10** entries and contains no secret
  (the engine guarantees credential-free reasons).
* **Best-effort:** a `writeSyncRun` that **rejects** is caught/logged and does
  **not** change the response and does **not** propagate (the cron still 200s; the
  manual still resolves `{ syncedAt }`).
* **Boundary (regression):** the only _new_ write is to `sync-runs`; the existing
  no-`users/**`-write boundary still holds for both flows; `system/sync` is still
  written by the cron exactly as before; all existing 0009/0025/0048 cases stay
  green.

**Unit — `scope:mobile` (`sync-status.service.spec.ts`, mocked AngularFire
`Firestore`):**

- A single doc present → `lastRun()` is the `dataToSyncRun`-mapped `SyncRun`;
  empty result → `lastRun() === null`; the query is built with
  `orderBy('startedAt','desc')` + `limit(1)`; a rejecting read sets `loadFailed()`.
- The relative-time helper: "just now" / "N minutes ago" / "N hours ago" / "N
  days ago" boundaries from a fixed clock.

**Component — `scope:mobile` (`sync-status-card.component.spec.ts`, TestBed +
Ionic; mocked `SyncStatusService`):**

- **never-synced:** `lastRun() === null` → "Never synced", no counts, no error
  chip, `sync-outline` icon.
- **success:** a recent run with `errorCount === 0` → relative time + gathered/
  updated counts, **no** error chip, `sync-outline` icon.
- **with-errors:** `errorCount === 3` → the "3 errors" chip in danger +
  `alert-circle-outline` icon; **no** specific error strings rendered.
- **loading:** before `load()` resolves → skeleton/no stale content.
- The card renders inside `SettingsPage`'s `.settings-cards` stack
  (`settings.page.spec.ts`).

**e2e — Not required (per the rubric):** this is a **read-only informational
display** added to an existing route (Settings). It introduces **no new
navigation route and no new user-facing action** (no add/status-change/persist —
the only writes are server-side, by Cloud Functions). The PLAN §5 e2e rubric
makes e2e _required_ only for a new route or a critical user action; a passive
status card is neither. The `sync-runs` write happens inside the already-e2e'd
sync flow (spec 0025's `manual-sync-trigger`), and the card's correctness is
fully covered by the unit + component tests above against mocked Firestore. State
explicitly: **"No e2e flows required — read-only display; no new route or user
action; the only writes are server-side."**

## Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist to the three projects + the root
config touched. Green gate is **typecheck + lint/Sheriff + unit + component +
build**; no new e2e (read-only display).

- [ ] `pnpm nx typecheck shared-domain shared-firestore-schema functions mobile-settings`
      passes — the `SyncRun` type, the wire types + converters + path helpers, the
      functions record-build, and the service/card all compile.
- [ ] `pnpm nx lint shared-domain shared-firestore-schema functions mobile-settings`
      passes **with Sheriff active**: `mobile-settings` imports `@vultus/shared/domain` + `@vultus/shared/firestore-schema` + AngularFire/Ionic (third-party) only —
      **no other-slice import, no `apps/mobile` import, no `scope:functions` import**;
      `apps/functions` imports `@vultus/shared/*` + Firebase only — **no `scope:mobile`
      import**.
- [ ] `pnpm nx test shared-firestore-schema` passes — the `syncRunToData`/
      `dataToSyncRun` round-trip + path-helper tests green; existing converter tests
      still pass.
- [ ] `pnpm nx test functions` passes — the cron + manual `sync-runs` record-write
      tests (counts mapped, `kind`/`userId` correct, `errors` ≤10 + credential-free,
      best-effort non-fatal) green; the existing 0009/0025/0048 cases (incl. the
      no-`users/**`-write boundary) still pass.
- [ ] `pnpm nx test mobile-settings` passes — `SyncStatusService` query/mapping
      tests + the relative-time helper + the four card-state component tests green
      (mocked AngularFire; no network/emulator/secrets).
- [ ] `pnpm nx build functions` passes — the deployable barrel builds with the
      added record write; `pnpm nx run functions:deploy-preflight` passes (the
      pruned-bundle deploy gate — a CI gate; the write touches `apps/functions`
      runtime code).
- [ ] `pnpm nx build mobile` passes — the settings slice + new card lazy-load
      cleanly into the shell within budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green
      (affected: `shared-domain`, `shared-firestore-schema`, `functions`,
      `mobile-settings`, `mobile`).
- [ ] **`firestore.rules`** adds the `match /sync-runs/{runId}` block
      (authenticated read, `write: if false`) before the default-deny, mirroring
      `title-cache`; **`firestore.indexes.json` is unchanged** (single-field
      orderBy needs no composite index — recorded in the PR).
- [ ] **Component tests** cover the never-synced / success / with-errors / loading
      states; the card is **read-only** (no specific error strings rendered, no
      click handler, no focus ring) (PLAN §5: component tests for non-trivial UI).
- [ ] **`sheriff.config.ts` is NOT modified** (existing path-glob tags already
      cover all touched projects — verified, recorded in the PR).
- [ ] READMEs updated **in the same change** (CLAUDE.md lib-README rule):
      `libs/shared/domain/README.md` (`SyncRun`), `libs/shared/firestore-schema/README.md`
      (`SyncRun*` data-types + converters + path helpers), `libs/mobile/settings/README.md`
      (`SyncStatusService` + `SyncStatusCardComponent`). `apps/functions` README updated
      only if one exists.
- [ ] **Boundary verifications (review-checked):** (a) the only **new** Firestore
      write is to `sync-runs/{runId}` — no `users/**` write added, `title-cache`/
      `system/sync` writes unchanged; (b) the `sync-runs` record write is
      **best-effort** — a failure is logged and does **not** change or fail either
      response; (c) `errors` carries **no secret/token** and is **capped at 10**;
      (d) the client read is **not** uid-scoped and shows **no specific error
      strings** (count only); (e) **no cross-slice / cross-scope import**; (f) **no
      secret read/written** (the functions reuse the existing param bindings; the
      slice uses the shell's AngularFire).
- [ ] **Visual verification (PLAN §2 / CLAUDE.md UI-fidelity rule):** the card is
      eyeballed via `pnpm nx run mobile:serve-mock` (the mock `SyncStatusService`
      renders the success state; flip the seed to confirm never-synced and
      with-errors), or explicitly flagged unverified for a human — a green build
      does **not** prove the card looks right. The PR records which.
- [ ] PR description records: the reused **Settings screen ID**
      (`81945ff3381e453dafcc4e5ce896fcfa`) and that no new screen was needed; the
      exact verification commands; the `firestore.rules` `sync-runs` block + the
      no-index-change verification; the best-effort / no-`users/**`-write /
      counts-only-no-error-strings / `errors`-capped-and-credential-free boundary
      confirmations; and the visual-verification outcome.

## Risks

- **Decision-record `Timestamp` shape vs the repo's ISO-string convention
  (RESOLVED in-spec).** The decision record's `SyncRunDoc` sketch types
  `startedAt`/`completedAt` as Firestore `Timestamp`. The repo's established
  boundary (`shared/domain` ISO strings + `shared/firestore-schema` Timestamp
  read/write data-types + converters — see `User`/`TitleCacheEntry`) keeps SDK
  types out of domain code. **Resolution:** the domain `SyncRun` uses ISO strings;
  the `SyncRunReadData`/`SyncRunWriteData` wire types carry the Timestamp boundary,
  converted by `syncRunToData`/`dataToSyncRun`. The **persisted fields are exactly
  the decision record's** (`startedAt`/`completedAt` stored as Timestamps via the
  `Date`-write coercion); only the in-memory representation follows house style.
  This is a convention reconciliation, not a data-model fork — flagged per the
  spec-author rule rather than silently designing around the sketch.
- **PLAN §4 does not list `sync-runs` (a new global collection).** PLAN §4
  documents `users/**`, `title-cache/**`, and the specs added `system/sync`.
  `sync-runs` is a new sibling global collection. It follows the **same access
  pattern as `title-cache`** (authenticated read, Admin-SDK-only write), so it fits
  the existing model cleanly; the addition is recorded here. **Task 1 updates
  PLAN §4** with a one-line `sync-runs/{runId}` entry under "Global" so the
  data-model table no longer drifts.
- **`sync-runs` accumulates with no retention/TTL (accepted for v1).** One cron
  run/day + occasional manual runs is a few hundred docs/year — negligible on
  Blaze. The `limit(1)` query reads only the newest, so growth does not slow the
  card. A TTL policy or a periodic prune is a later concern (out of scope) if
  volume ever matters.
- **Cron `userId: null` means the card cannot attribute a cron run to "you"
  (intended).** A cron run covers the global union of all users' titles, so its
  counts are global, not per-user. The card shows the most-recent run regardless
  of `kind`/`userId` — which is the desired "did the pipeline run?" signal. A
  per-user breakdown is explicitly out of scope (decision 4).
- **Single-field `orderBy` index assumption.** The `orderBy('startedAt','desc') +
limit(1)` query has no `where`, so Firestore's automatic single-field index
  serves it — **no composite index, `firestore.indexes.json` unchanged**. If the
  emulator/prod ever demands an index for this exact query (it should not for a
  single-field order), add only the suggested entry; do not pre-emptively add one.
- **The card only reflects a run once it's deployed + has actually run.** The
  record write is inert until `apps/functions` is redeployed (`/deploy-functions`,
  manual per `docs/specs/README.md` "Scope & limitations"). Until then the card
  shows "Never synced" (no `sync-runs` docs yet). Per project memory
  (`emulator-tooling-limitation`), the agent verifies the write path via unit tests
  - the mock-seeded card locally; the real prod record + card-reflects-it check is
    a post-deploy human step — flag it, do not report "working" off a green build.
    (Project memory `verify-daily-sync-processes-titles` is the exact scenario this
    card makes visible.)
- **Best-effort write must not regress the sync.** The biggest risk is making the
  `sync-runs` write fail the cron or the callable. **Binding:** the write is
  wrapped, logged on failure, and **never** alters or rejects the existing
  response — the sync's success is independent of recording it. Reviewer checks the
  `runSync`/`runTriggerSync` diffs are additive and the response shapes are
  byte-for-byte unchanged.
- **No PLAN conflict beyond the new collection.** This is additive observability:
  a shared data shape (correctly placed in `shared/firestore-schema` because it
  crosses the functions↔mobile boundary), a server-side record write, and a
  read-only slice card. Vertical slice and the extract-at-3+ rule are respected
  (no behaviour is hoisted to `shared/`; only the cross-scope _data shape_ is, as
  the existing wire types already are). TMDB/Trakt accuracy is unaffected — the
  card reports counts the engine already derived, it does not re-fetch.
