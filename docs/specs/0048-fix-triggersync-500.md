---
number: 0048
slug: fix-triggersync-500
title: Make the triggerSync callable surface diagnosable errors instead of an opaque INTERNAL 500
status: approved
slices: []
scopes: [scope:functions]
created: 2026-06-30
---

# Make the triggerSync callable surface diagnosable errors instead of an opaque INTERNAL 500

## 1. Context

GitHub issue **#103**: after the CORS fix landed (spec 0044, merged 2026-06-29),
the watchlist toolbar refresh button reaches the `triggerSync` Gen2 callable, but
the call now fails with `functions/internal` (HTTP **500 INTERNAL**). The user
gets an opaque "internal error" toast with **no actionable feedback**, and Cloud
Logging shows **nothing useful** — the failure cannot be diagnosed from logs.

The manual-sync feature (spec 0025) wired the toolbar refresh button to a
`scope:shared` `TRIGGER_SYNC` token that invokes the Gen2 `triggerSync` callable
(`apps/functions/src/main.ts`, currently the `triggerSync` export around line 304)
via AngularFire `httpsCallable` pinned to `europe-west1`. The callable
self-authenticates from the verified Firebase Auth context (`request.auth?.uid`),
then delegates to `runTriggerSync` (`main.ts` ~line 281), which:

1. throws `HttpsError('unauthenticated', ...)` when no `uid`,
2. calls `gatherUserWatchlistTitles(deps.db, uid)` to read the caller's
   `users/{uid}/watchlist`,
3. runs one force-fresh `engine.sync(inputs)` pass, and
4. resolves `{ syncedAt }`.

**Root cause (confirmed by code review).** Two gaps turn any read-time failure
into an opaque, untraceable 500:

1. **No try-catch around the gather.** `gatherUserWatchlistTitles`
   (`libs/functions/sync-titles/src/lib/gather/user-gather.ts`, lines 22–35) does
   `await db.collection(watchlistPath(uid)).get()` with **no try-catch**, and
   `runTriggerSync` (`main.ts` line 288) `await`s it with **no try-catch** either.
   Any Firestore error (permission-denied, transient network blip, a bad
   collection path, an unexpected doc shape) propagates **unhandled** to the
   Firebase callable runtime, which wraps **any non-`HttpsError`** thrown by an
   `onCall` handler as the opaque `INTERNAL` (HTTP 500) with **no `details`** —
   exactly the symptom in #103.
2. **No `logger.error` anywhere on the `triggerSync` path.** `main.ts` imports
   `logger` from `firebase-functions` (line 16) but only calls `logger.info` once
   — inside `runSync` (the `syncTitles` path, line 205). The `triggerSync`
   callable / `runTriggerSync` emit **no log at all** on failure, so Cloud Logging
   captures nothing beyond the framework's bare `INTERNAL` line. Diagnosis is
   impossible.

Additionally, `runTriggerSync` **discards** the `SyncResult[]` returned by
`engine.sync()` (`main.ts` line 294: `await engine.sync(inputs)` with no
assignment) — so even on the success path there is **no observability** into how
many titles synced / errored / skipped. Per-title engine errors are already
swallowed by the engine (spec 0008 isolation — correct, unchanged here), but the
aggregate counts are thrown away. The `syncTitles` path already logs this exact
summary (`main.ts` lines 205–213); the manual path should mirror it.

**Intended outcome.** A Firestore read failure in the manual-sync flow produces
(a) a structured `logger.error` line in Cloud Logging naming where it failed, and
(b) an `HttpsError('internal', 'Failed to read watchlist')` whose message the
client can show — instead of a bare `INTERNAL` with empty `details`. Any other
unhandled throw on the callable path is also logged before propagating. On the
success path, a `logger.info` summary (synced / errored / skipped counts) is
emitted, mirroring `syncTitles`. This is a **logic + observability fix, one PR,
`scope:functions` only** — no UI, no Firestore schema, no new secret, no CORS or
region change.

### Locked decisions (from the decision record — do NOT re-litigate)

1. **Wrap the gather in `runTriggerSync`.** Surround the
   `gatherUserWatchlistTitles(deps.db, uid)` call in a try-catch. On catch:
   `logger.error('[triggerSync] gather failed', err)` then
   `throw new HttpsError('internal', 'Failed to read watchlist')`.
2. **Top-level try-catch in the `onCall` handler.** Wrap the
   `return runTriggerSync(...)` in the `triggerSync` handler body in a try-catch
   that calls `logger.error('[triggerSync] unhandled error', err)` and **re-throws**
   (so an already-typed `HttpsError` — e.g. `unauthenticated`, or the `internal`
   from decision 1 — reaches the client unchanged, while still being logged).
3. **Capture + log the engine summary.** Assign the `SyncResult[]` from
   `engine.sync(inputs)` in `runTriggerSync` and emit a `logger.info` summary
   (`synced` / `errored` / `skipped` / `gathered` counts), mirroring the
   `runSync` pattern (`main.ts` lines 205–213). The counts are derived from
   `result.outcome` (`'synced' | 'skipped' | 'error'`, see
   `libs/functions/sync-titles/src/lib/engine/types.ts`).
4. **Best-effort engine isolation is unchanged.** Per-title engine errors still do
   **not** fail the callable (spec 0008). The new try-catch in `runTriggerSync`
   covers the **gather** read only; the `engine.sync` call already returns results
   (it does not throw per-title). Do **not** wrap `engine.sync` in a catch that
   converts a swallowed per-title error into a failure.
5. **`HttpsError`, not a raw throw.** Use `'internal'` as the `HttpsError` code for
   the gather failure (the gather read failed server-side; it is not the caller's
   fault, so not `failed-precondition` / `invalid-argument`). The client message is
   the fixed string `'Failed to read watchlist'` — no secret, no `uid`, no raw
   Firestore error text in the **client-facing** message (the raw `err` goes only
   to `logger.error`, server-side).
6. **No CORS / region / secret / auth change.** The spec-0044 `cors` array, the
   `europe-west1` region, the `TMDB_READ_TOKEN` binding, and the
   `request.auth?.uid` self-auth are **untouched**. `syncTitles` and
   `dispatchNotifications` are **untouched**.

## 2. Scope

In scope (`scope:functions`, one PR):

- **`runTriggerSync` (`apps/functions/src/main.ts`):** wrap the
  `gatherUserWatchlistTitles` call in a try-catch (decision 1); capture the
  `SyncResult[]` from `engine.sync` and `logger.info` a count summary (decision 3).
- **The `triggerSync` `onCall` handler body (`apps/functions/src/main.ts`):** add
  a top-level try-catch that `logger.error`s and re-throws (decision 2).
- **Unit tests (`apps/functions/src/trigger-sync.spec.ts`):** add a case asserting
  a rejecting gather → `runTriggerSync` rejects with `HttpsError('internal', ...)`;
  keep all existing cases green.

Out of scope (explicitly):

- **Any `gatherUserWatchlistTitles` signature/behaviour change**
  (`libs/functions/sync-titles/src/lib/gather/user-gather.ts`). The try-catch lives
  in the **caller** (`runTriggerSync`), not in the gather function — keeping the
  gather a thin, SDK-agnostic read consistent with the cron `gatherWatchlistTitles`.
  (If a reviewer prefers the catch inside the gather, that is a deliberate non-goal
  here: the callable is the boundary that owns the `HttpsError` translation.)
- **Any change to the engine, the per-title isolation, the staleness filter, the
  force-fresh manual semantics, or the `{ syncedAt }` response shape** (spec 0025).
- **Any change to `syncTitles` / `runSync` / `dispatchNotifications`** — the
  `syncTitles` `logger.info` summary is the **pattern to mirror**, not to edit.
- **CORS, region, secrets, the `TRIGGER_SYNC` token, the `httpsCallable` wiring,
  the mobile caller (`app.config.ts`)** — all unchanged (decision 6).
- **Firestore schema / `firestore.rules` / `firestore.indexes.json` /
  `firebase.json` / `sheriff.config.ts`** — none required.
- **Any UI / `scope:mobile` change.** The existing internal-error toast already
  renders an `HttpsError` message; this spec only makes the thrown error
  diagnosable (logs) and message-bearing (`'Failed to read watchlist'`). No
  template/copy change is in scope.
- **e2e** — backend-only change; not exercisable from the emulator-backed suite
  (rubric in §8).

## 3. Affected slices & Sheriff tags

| Project         | Path                                | Sheriff tags      | Change                                                                                  |
| --------------- | ----------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| functions (app) | `apps/functions/src/main.ts`        | `scope:functions` | try-catch in `runTriggerSync` + `triggerSync` handler; capture + `logger.info` summary  |
| functions (app) | `apps/functions/src/trigger-sync.spec.ts` | `scope:functions` | add one unit case (rejecting gather → `internal`); existing cases unchanged       |

- **`slices: []`** — a `scope:functions` logic change touching only the functions
  entry file + its spec; introduces no slice, library, or app-shell change.
- **No cross-scope / cross-slice import.** `logger` and `HttpsError` are **already
  imported** in `main.ts` (lines 16–17); no new import edge is added.
  `scope:functions` imports nothing from `scope:mobile`.
- **No `sheriff.config.ts` change.** The `apps/functions` tag already exists
  (specs 0009/0025/0044); verify by path glob — do **not** edit `sheriff.config.ts`.
- **Not a `shared/` extraction.** The `HttpsError`-translation + summary log are
  callable-boundary concerns local to `main.ts`; the cron path already has its own
  (`runSync`). The DRY/3+-slice rule is not engaged.

## 4. Data model touchpoints

**None.** No Firestore collection, field, converter, security rule, or index is
added or changed. `runTriggerSync` still **reads** the caller's
`users/{uid}/watchlist` (via `gatherUserWatchlistTitles`) and **writes** only
`title-cache/**` through the engine store (spec 0025) — both unchanged. The fix
adds error handling + logging around the **existing** read/sync; it touches no
data shape. Record "no `firestore.rules` / no `firestore.indexes.json` change" in
the PR.

## 5. Public types / APIs

**No new or changed public type, token, function signature, callable shape, or
HTTP contract.**

- `triggerSync` — still `onCall<unknown, Promise<TriggerSyncResponse>>` resolving
  `{ syncedAt: string }`. Its **failure surface improves** but stays within the
  existing callable error model: `HttpsError('unauthenticated', 'Sign-in required')`
  when no `uid` (unchanged), and **now** `HttpsError('internal', 'Failed to read
  watchlist')` when the watchlist read fails (previously a bare framework
  `INTERNAL`). The success response, region (`europe-west1`), `cors` array
  (spec 0044), and `TMDB_READ_TOKEN` binding are unchanged.
- `runTriggerSync` — **signature unchanged**:
  `(deps: RunTriggerSyncDeps, uid: string | undefined) => Promise<TriggerSyncResponse>`.
  Internally it now try-catches the gather and logs a summary; callers and the
  return type are unaffected.
- `RunTriggerSyncDeps`, `TriggerSyncResponse`, `gatherUserWatchlistTitles`,
  `GatheredUserTitle`, the `TRIGGER_SYNC` token, the mobile `httpsCallable` wiring —
  all **unchanged**.

### The edits (the only code changes)

All in `apps/functions/src/main.ts`. `logger` and `HttpsError` are already
imported (lines 16–17) — **no new import**.

**Edit A — `runTriggerSync` (currently ~lines 281–296):** wrap the gather in a
try-catch and capture + log the engine summary. The body becomes (the `if (!uid)`
guard and the `{ syncedAt }` return are unchanged):

```typescript
export async function runTriggerSync(
  deps: RunTriggerSyncDeps,
  uid: string | undefined,
): Promise<TriggerSyncResponse> {
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required');
  }

  let rawTitles: GatheredUserTitle[];
  try {
    rawTitles = await gatherUserWatchlistTitles(deps.db, uid);
  } catch (err) {
    logger.error('[triggerSync] gather failed', err);
    throw new HttpsError('internal', 'Failed to read watchlist');
  }

  const inputs: SyncTitleInput[] = rawTitles.map((t) => ({
    tmdbId: t.tmdbId,
    type: t.type,
  }));
  const engine = deps.createEngine(deps.db);
  const results: SyncResult[] = await engine.sync(inputs);

  const synced = results.filter((r) => r.outcome === 'synced').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const errored = results.filter((r) => r.outcome === 'error').length;
  logger.info('[triggerSync] sync complete', {
    gathered: inputs.length,
    synced,
    skipped,
    errored,
  });

  return { syncedAt: new Date().toISOString() };
}
```

- `SyncResult` is **already imported** in `main.ts` (line 31, the
  `import type { SyncEngine, SyncResult, SyncTitleInput }` group). The explicit
  `GatheredUserTitle[]` annotation requires adding `GatheredUserTitle` to that same
  import group (it is exported by `@vultus/functions/sync-titles` alongside
  `gatherUserWatchlistTitles` — one name added to an existing import, not a new edge).
- The summary log **must not** include any per-title `reason` string or any
  secret — aggregate counts + `gathered` only (mirrors `runSync` lines 205–213,
  which log counts, not reasons).
- Do **not** wrap `engine.sync` in the try-catch — per-title errors are already
  isolated inside the engine (spec 0008); `engine.sync` returns results rather
  than throwing per-title (decision 4).

**Edit B — the `triggerSync` `onCall` handler body (currently ~lines 314–323):**
add a top-level try-catch that logs and re-throws, leaving the `cors`/`secrets`
options object (spec 0044) untouched:

```typescript
export const triggerSync = onCall<unknown, Promise<TriggerSyncResponse>>(
  {
    secrets: [TMDB_READ_TOKEN],
    cors: [
      'https://vultus-cab62.web.app',
      'https://vultus-cab62.firebaseapp.com',
      'http://localhost', // Capacitor Android WebView (production native app)
      'http://localhost:4200', // Angular dev server (serve-prod-debug)
    ],
  },
  async (request) => {
    try {
      const db = ensureAdmin();
      const createEngine = (firestore: Firestore): SyncEngine =>
        createSyncEngine({
          tmdb: createTmdbClient({ readAccessToken: TMDB_READ_TOKEN.value() }),
          trakt: createTraktClient({ clientId: TRAKT_CLIENT_ID.value() }),
          store: createFirestoreTitleCacheStore(firestore),
        });
      return await runTriggerSync({ db, createEngine }, request.auth?.uid);
    } catch (err) {
      logger.error('[triggerSync] unhandled error', err);
      throw err;
    }
  },
);
```

- The handler arrow becomes `async` and **`await`s** `runTriggerSync` so a
  rejection is caught here (not silently returned as a rejected promise the
  framework logs opaquely). The `cors`/`secrets` options object is **byte-for-byte
  unchanged** from spec 0044.
- `throw err` **re-throws the original error**: an already-typed `HttpsError`
  (`unauthenticated`, or `internal` from Edit A) reaches the client unchanged while
  still being logged; a non-`HttpsError` is logged here too (it would otherwise be
  an opaque framework `INTERNAL`) before the framework wraps it.

## 6. UI / Stitch screen refs

**Not applicable — backend/observability change only.** No markup, template,
design token, on-screen element, or copy changes. The watchlist toolbar refresh
button and its idle/syncing/cooldown states (spec 0025) are unchanged. The only
user-visible effect is that a failed sync now shows the client-facing message
`'Failed to read watchlist'` (carried by the new `HttpsError`) instead of an
opaque internal-error string, and a successful sync is unchanged. **No Stitch
screen needs to be pulled** for this spec. (Stated explicitly so the absent UI
section is not read as an omission.)

## 7. Implementation task graph

Two tasks. The code + tests are one file pair (single agent); the deploy +
verification is the sequential operational follow-on (the real production fix).

### 1. [sequential] Add gather try-catch + handler try-catch + summary log, with the unit test

backend-engineer. `apps/functions`, `scope:functions`.

- Edit `apps/functions/src/main.ts` per §5 Edit A (try-catch the gather in
  `runTriggerSync`; capture `SyncResult[]` and `logger.info` the count summary) and
  Edit B (top-level try-catch in the `triggerSync` handler that `logger.error`s and
  re-throws; make the handler `async` and `await runTriggerSync`). Leave the
  `cors`/`secrets` options object, the region, and `syncTitles`/`runSync`/
  `dispatchNotifications` **unchanged**.
- Edit `apps/functions/src/trigger-sync.spec.ts`: add the **rejecting-gather** case
  (§8) asserting `runTriggerSync` rejects with `HttpsError` code `'internal'` and
  the engine is **not** called; keep all four existing cases + the export
  regression green and unchanged.
- Run `pnpm nx affected -t lint typecheck test build --base=main` (affected:
  `functions` only) and `pnpm nx run functions:deploy-preflight` (the
  pruned-bundle deploy gate, also a CI gate) so the artifact is known-good before
  task 2.
- **File manifest (modifies):** `apps/functions/src/main.ts`,
  `apps/functions/src/trigger-sync.spec.ts` (two files, one agent — not split, they
  change together).

> This task is intentionally `[sequential]` and alone — no parallel fan-out (the
> two files are a tightly-coupled code+test pair, so no disjoint-manifest split).

### 2. [sequential] Deploy + functionally verify the diagnosable error path. Depends on task 1 + the merged PR

infrastructure-engineer (operational).

- **Deploy:** `pnpm nx run functions:deploy-preflight`, then `/deploy-functions` to
  ship `triggerSync` to production (the established pnpm/gen2 recipe — user memory
  `functions-deploy-pnpm-recipe`; project `vultus-cab62`, region `europe-west1`).
- **Functional verification (the real production check):** from
  `pnpm nx run mobile:serve-prod-debug` (browser origin `localhost:4200` against
  **real prod** Functions — requires a populated `.env.local`, per CLAUDE.md), tap
  the watchlist refresh button and confirm: (a) on success the call returns
  `{ syncedAt }` with **HTTP 200** and the success toast renders; (b) in
  **Cloud Logging** the `[triggerSync] sync complete` `logger.info` summary line
  appears with the count fields. If a failure is reproducible (e.g. against a
  signed-out / permission-restricted account), confirm a `[triggerSync] gather
  failed` or `[triggerSync] unhandled error` `logger.error` line appears and the
  client shows `'Failed to read watchlist'` (a typed error) rather than the prior
  opaque `INTERNAL`.
- **File manifest:** none (operational; no repo files change).

> **Why task 2 is in the spec though deploy is "out of band":** per
> `docs/specs/README.md` the skill workflow ends at a merged PR and does not
> deploy — but the reported bug (#103) is a **production** 500 whose fix (and the
> Cloud Logging it adds) only takes effect once deployed. Recording the deploy +
> log verification as an explicit, ordered task (and in the DoD) makes the
> operational fix non-optional and traceable. Per user memory
> `emulator-tooling-limitation`, the deploy + browser/log check run in the **user's
> own terminal**, not under Claude Code tools — flag this rather than reporting the
> bug fixed off a green build.

## 8. Test plan

Per the PLAN §5 pyramid: **unit only**, extending the existing functions suite. No
component test (no UI), no e2e (rubric below).

**Unit (Vitest) — `apps/functions/src/trigger-sync.spec.ts`:**

- **NEW — rejecting gather → `HttpsError('internal')`, engine NOT called.** Drive
  `runTriggerSync` with a fake `db` whose watchlist `collection(...).get()`
  **rejects** (e.g. `get: () => Promise.reject(new Error('permission-denied'))`).
  A valid `uid` is supplied. Assert the returned promise **rejects** with an
  `HttpsError` whose `code` is `'internal'` (and message `'Failed to read
  watchlist'`), and that the fake engine's `sync` was **not** called (gather failed
  before the engine pass). Implement by extending `createFakeDb` to accept an
  optional `getRejects` flag (or add a small dedicated fake) so the existing
  happy-path `createFakeDb` is unaffected.
- **UNCHANGED — must stay green:** the four existing `runTriggerSync` cases
  (no-auth → `HttpsError('unauthenticated')`, engine not called; valid uid →
  deduped per-user titles + `{ syncedAt }`; the `users/**`/`system/sync`
  no-write **BOUNDARY**; partial engine error still resolves `{ syncedAt }`) and
  the **REGRESSION** case (`syncTitles` + `dispatchNotifications` remain exported).
  The summary `logger.info` (Edit A) and the handler try-catch (Edit B) must not
  break these — the success path still resolves `{ syncedAt }`, and the per-title
  partial-error case still resolves (engine isolation unchanged).

> **Note on logging assertions:** asserting the exact `logger.info` /
> `logger.error` call shape is optional and low-value (it tests the literal we
> wrote, and `firebase-functions` `logger` is a side-effecting global). The
> load-bearing behavioural assertions are: (1) gather rejection → `internal`
> `HttpsError`, engine not called; (2) success path still resolves `{ syncedAt }`.
> If the implementer chooses to assert logging, spy on the `firebase-functions`
> `logger` rather than over-constraining the message string.

**Component — none.** No UI/template change; `scope:mobile` untouched.

**e2e — Not required (per the rubric):** this is a **`scope:functions`-only**
logic/observability change — it introduces **no new route and no new user-facing
action** (the watchlist refresh action already exists, spec 0025), and the new
error/log behaviour is **not exercisable from the emulator-backed e2e suite**
(the emulator path bypasses prod and the failure is a server-side Firestore-read
error + Cloud Logging line, neither of which Playwright can assert). State
explicitly: **"No e2e flows required — backend/observability change only; the
error-translation and Cloud Logging are not exercisable from the emulator-backed
e2e suite."** The real validation is the unit test (gather rejection → `internal`)
plus the manual post-deploy log/response verification (task 2).

## 9. Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist to a `scope:functions`
logic+observability change. Gates that don't apply are marked N/A with the reason.

- [ ] `apps/functions/src/main.ts` — `runTriggerSync` try-catches
      `gatherUserWatchlistTitles`; on catch it `logger.error('[triggerSync] gather
      failed', err)` then `throw new HttpsError('internal', 'Failed to read
      watchlist')` (Edit A, decision 1). The `if (!uid)` guard and `{ syncedAt }`
      return are unchanged.
- [ ] `runTriggerSync` captures the `SyncResult[]` from `engine.sync` and emits a
      `logger.info('[triggerSync] sync complete', { gathered, synced, skipped,
      errored })` summary — aggregate counts only, **no** per-title reason / secret
      (Edit A, decision 3). Counts derived from `result.outcome`.
- [ ] The `triggerSync` `onCall` handler body has a top-level try-catch that
      `logger.error('[triggerSync] unhandled error', err)` and **re-throws** `err`;
      the handler is `async` and `await`s `runTriggerSync`; the `cors`/`secrets`
      options object (spec 0044) is **unchanged** (Edit B, decision 2).
- [ ] Per-title engine isolation is **unchanged** — `engine.sync` is **not**
      wrapped in the new catch; a partial per-title error still resolves
      `{ syncedAt }` (decision 4).
- [ ] **No new import** added (`logger`, `HttpsError`, `SyncResult` already
      imported); **no change** to `syncTitles` / `runSync` /
      `dispatchNotifications` / region / CORS / secrets / auth (decision 6).
- [ ] **No `gatherUserWatchlistTitles` change** — the try-catch is in the caller;
      `libs/functions/sync-titles/src/lib/gather/user-gather.ts` is untouched.
- [ ] `apps/functions/src/trigger-sync.spec.ts` has the **new** rejecting-gather
      case (gather rejects → `runTriggerSync` rejects with `HttpsError` code
      `'internal'`, engine not called); all four existing cases + the export
      regression remain green and unchanged (§8).
- [ ] `pnpm nx typecheck functions` passes.
- [ ] `pnpm nx lint functions` passes **with Sheriff active** — no new import edge;
      `scope:functions` imports nothing from `scope:mobile`.
- [ ] `pnpm nx test functions` passes — new + existing cases green.
- [ ] `pnpm nx build functions` passes.
- [ ] `pnpm nx run functions:deploy-preflight` passes (the pruned-bundle deploy
      gate) — the artifact with the new error handling is known-good.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green
      (affected: `functions` only; no mobile/shared project touched).
- [ ] **No `firestore.rules` / `firestore.indexes.json` / `firebase.json` /
      `sheriff.config.ts` / shared-type change** — verified, recorded in the PR.
- [ ] **No secret read/written, none logged** — `logger.error` receives only the
      caught `err` (server-side); the client message is the fixed string `'Failed
      to read watchlist'`; the summary logs aggregate counts only.
- [ ] **Component / e2e: N/A** — no UI change; `scope:functions`-only change, error
      + logging not exercisable from the emulator-backed e2e (stated in the PR).
- [ ] **Operational (task 2) recorded in the PR / follow-up:** the
      `/deploy-functions` run and the post-deploy verification —
      `mobile:serve-prod-debug` shows the refresh returning `{ syncedAt }` (200),
      the `[triggerSync] sync complete` `logger.info` appears in Cloud Logging, and
      (if reproducible) a failure shows the `logger.error` line + the typed `'Failed
      to read watchlist'` client error instead of the opaque `INTERNAL`. If deploy
      can't happen within the PR window, recorded as a **required follow-up** with
      the named blocker — the code change alone doesn't fix the user's app until
      deployed.
- [ ] PR description references GitHub issue **#103** and records: the two root
      causes; the `internal` error code + client message choice; that per-title
      isolation is unchanged; and the deploy + Cloud Logging verification outcome
      (or the named blocker if deferred).

## 10. Risks

- **The diagnosability fix only takes full effect on deploy (operational).** The
  `HttpsError` + Cloud Logging are inert until `triggerSync` is deployed
  (`/deploy-functions`). The code change alone makes the **next** failure
  diagnosable; it does not retroactively explain past 500s. Task 2 (deploy + log
  verification) is the required production step, and the DoD is not fully met by a
  green build alone.
- **This makes the error *diagnosable*, not necessarily *fixed*.** #103's 500 is
  caused by *some* Firestore read failure; this spec ensures that failure is logged
  and surfaced with a typed error + message. The **underlying** cause (e.g. a
  security-rule denial on `users/{uid}/watchlist`, a region/credential issue, or an
  unexpected doc shape) may then be revealed by the new `logger.error` line and
  require a **follow-up spec** to fix. State this in the PR: the immediate
  deliverable is observability + graceful failure; the post-deploy log read may
  identify a distinct root cause to address separately. (If the post-deploy log
  shows a permission-denied on the watchlist read, that is a `firestore.rules` /
  auth-context concern — out of scope here, a new spec.)
- **Cannot fully verify here.** Per user memory `emulator-tooling-limitation`, the
  emulator can't run under Claude Code tools; the deploy + prod log/response check
  require the user's own terminal + a populated `.env.local`. The implementing
  agent makes the edit, adds the unit test, and runs the preflight; the deploy +
  Cloud Logging confirmation may need the user — flag it rather than reporting #103
  closed off a green build.
- **`internal` vs a more specific code.** `'internal'` is chosen because the gather
  read failed server-side and the cause is not yet known to be the caller's fault.
  If a future log read shows the failure is consistently a permission denial tied
  to an unauthenticated/again-expired token, a more specific code
  (`permission-denied` / `unauthenticated`) could be more accurate — defer that to
  the follow-up that addresses the confirmed root cause; do not pre-emptively guess
  the code now.
- **Log noise / cost.** One `logger.info` per successful manual sync and one
  `logger.error` per failure is negligible volume (manual, user-triggered, 5-min
  rate-limited per spec 0025) and mirrors the existing `syncTitles` summary — no
  cost concern.
- **No PLAN conflict.** Additive `scope:functions` logic/observability fix; no
  cross-slice/cross-scope import, no data-model change, respects vertical-slice and
  extract-at-3+ rules (the `HttpsError` translation + summary log are callable-local,
  matching the cron path's own in-`main.ts` logging). TMDB/Trakt data accuracy is
  unaffected — the sync flow is unchanged; this only makes its failures legible.
</content>
</invoke>
