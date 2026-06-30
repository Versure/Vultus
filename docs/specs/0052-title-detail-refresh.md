---
number: 0052
slug: title-detail-refresh
title: Add pull-to-refresh manual sync to the title-detail page (shared SyncStateService)
status: approved
slices: [slice:title-detail, slice:watchlist]
scopes: [scope:mobile, scope:shared]
created: 2026-06-30
---

# Add pull-to-refresh manual sync to the title-detail page (shared SyncStateService)

## Context

The Watchlist tab already has a manual "refresh now" affordance — a toolbar
button wired to the `triggerSync` callable, behind a client-side 5-minute
cooldown (spec 0025, `done`). The title-detail page (spec 0016, `done`) has
**no** way to trigger a sync: a user viewing a single title who wants fresher
provider availability or newly-aired episodes must navigate back to the
watchlist and use the toolbar button there.

This spec adds **pull-to-refresh** to the title-detail page so the user can
trigger a manual re-sync without leaving the page.

Intended outcome: on the title-detail page, pulling down the content shows the
native Ionic refresher spinner and calls the existing `triggerSync` callable
(spec 0025). That callable re-fetches TMDB metadata + watch-provider data for
**all** of the user's watchlist titles and writes them to `title-cache`. The
title-detail page's existing Firestore streams (`detail$` cache read, the
provider stream, and — once the sync engine writes new episode docs — the
`episodes$` stream) then pick up the changes **reactively**; the page does not
manually reload anything. On success a "Refreshed" toast appears; on error an
error toast. The refresh is rate-limited by the **same** client-side cooldown
the watchlist uses (a shared singleton), so a refresh on either page counts
against the one 5-minute window.

### What the refresh does (and does NOT do)

- It calls the **existing** `triggerSync` callable via the **existing**
  `TRIGGER_SYNC` `scope:shared` token (spec 0025). The callable behaviour is
  unchanged: it syncs the whole user watchlist force-fresh and writes only
  `title-cache/**`.
- The title-detail page already subscribes to `detail$` (cache read), the
  provider stream, and `episodes$` (spec 0034) — **all realtime**. After
  `triggerSync` writes `title-cache`, those streams re-emit on their own. **No
  per-title fetch, no manual list reload, and no separate episode-fetch call is
  added.** The episode list updates as a side-effect of `triggerSync` once the
  episode-sync engine (spec 0047, `sync-episodes`) writes new episode docs; this
  spec does **not** add any episode-fetch path of its own.

### Why `SyncStateService` moves to `shared/ui-kit` (locked decision)

The cooldown must be **shared** across the watchlist page and the title-detail
page (one 5-minute window, persisted in `localStorage`). The existing
`SyncStateService` lives in `libs/mobile/watchlist` and is already
`providedIn: 'root'` (an Angular singleton) — but `slice:title-detail` cannot
inject a service from `slice:watchlist` (a forbidden cross-slice import,
Sheriff rule §3).

The fix is to **move `SyncStateService` (and its `LAST_SYNC_KEY` +
`SYNC_COOLDOWN_MS` constants) from `libs/mobile/watchlist` to
`libs/shared/ui-kit`**, exported from its barrel. This is justified against the
"extract only at 3+ slices" rule by the service's **dependencies**, not just
its consumer count: `SyncStateService` depends only on `scope:shared` /
third-party symbols — `TRIGGER_SYNC` from `@vultus/shared/domain/tokens`,
`FirebaseError` from `firebase/app`, and `@angular/core`. It contains no
slice-specific logic. It therefore **fits `scope:shared`** cleanly, and moving
it (rather than duplicating the cooldown state into a second service) is the
only way two slices can share **one** singleton cooldown. After the move both
slices import `SyncStateService` from `@vultus/shared/ui-kit`; it stays
`providedIn: 'root'`, so it remains a single instance and the cooldown is truly
shared.

## Scope

In scope:

- **`scope:shared`, `shared/ui-kit`:** **move** `SyncStateService` (+
  `LAST_SYNC_KEY`, `SYNC_COOLDOWN_MS`) into `libs/shared/ui-kit`, export them
  from the barrel, and move the existing unit tests alongside. `providedIn:
'root'` is preserved. **No logic change** — this is a relocation.
- **`scope:mobile`, `slice:watchlist`:** delete the slice-local
  `watchlist.sync-state.service.ts` + its spec, and update `WatchlistPage`'s
  import of `SyncStateService` from `./watchlist.sync-state.service` to
  `@vultus/shared/ui-kit`. Update the slice README. **No behaviour change.**
- **`scope:mobile`, `slice:title-detail`:** add an `IonRefresher` +
  `IonRefresherContent` inside the page's existing `IonContent`, inject the
  shared `SyncStateService` (and `ToastController`), and wire a pull-to-refresh
  handler that triggers a sync, shows a "Refreshed" / error toast, and respects
  the shared cooldown. Update the slice README.

Out of scope (explicitly):

- **A separate "sync this title only" callable.** The refresh reuses the
  existing whole-watchlist `triggerSync` (spec 0025). No new callable, no
  per-title sync, no change to `apps/functions`.
- **A per-title cooldown.** The cooldown stays the single shared 5-minute
  window (the existing `SyncStateService` semantics). A refresh on title-detail
  and a refresh on the watchlist share the one window.
- **A toolbar button on title-detail.** The only new affordance is
  pull-to-refresh. (The title-detail toolbar keeps its existing back/account
  buttons unchanged.)
- **Any change to the `triggerSync` callable, `syncTitles`, the sync engine, or
  the episode-sync engine (spec 0047).** This spec is a pure mobile/shared
  client change.
- **FCM / notification changes.**
- **Any change to `sheriff.config.ts`, `firestore.rules`,
  `firestore.indexes.json`, or `apps/mobile` shell wiring.** The `TRIGGER_SYNC`
  token + the AngularFire `provideFunctions` wiring already exist (spec 0025);
  `shared/ui-kit` is already `scope:shared` and importable by both slices.

## Affected slices & Sheriff tags

| Project          | Path                       | Sheriff tags                          | Change                                                                                          |
| ---------------- | -------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| shared-ui-kit    | `libs/shared/ui-kit`       | `scope:shared`                        | **add** `SyncStateService` (+ `LAST_SYNC_KEY`, `SYNC_COOLDOWN_MS`) + its moved test; barrel + README |
| mobile-watchlist | `libs/mobile/watchlist`    | `scope:mobile`, `slice:watchlist`     | **remove** slice-local `SyncStateService` + spec; **re-point** import to `@vultus/shared/ui-kit`; README |
| mobile-title-detail | `libs/mobile/title-detail` | `scope:mobile`, `slice:title-detail` | **add** `IonRefresher`+`IonRefresherContent`, inject `SyncStateService` + `ToastController`, handler; README |

- **`sheriff.config.ts` is NOT modified.** All three paths already carry the
  tags above. Verify, do not add.
- **No cross-slice import.** Today `slice:title-detail` injecting
  `SyncStateService` from `slice:watchlist` would be a forbidden
  `slice:title-detail → slice:watchlist` edge — this spec **removes that risk
  entirely** by relocating the service to `scope:shared` (`shared/ui-kit`),
  which **both** slices may import (Sheriff rule §3: `scope:shared` is importable
  by anyone). After the move:
  - `slice:title-detail` imports `SyncStateService` from `@vultus/shared/ui-kit`
    (a `scope:shared → scope:shared`-consumed-by-`scope:mobile` edge, allowed) —
    **no** `slice:watchlist` import, **no** `@angular/fire/functions` import,
    **no** `apps/mobile` import.
  - `slice:watchlist` likewise imports `SyncStateService` from
    `@vultus/shared/ui-kit` (it already imports `VultusEmptyState` etc. from the
    same barrel — verified in `watchlist.page.ts`).
- **`shared/ui-kit` stays self-contained.** `SyncStateService` imports only
  `@angular/core`, `@vultus/shared/domain/tokens` (`TRIGGER_SYNC` — another
  `scope:shared` lib, allowed), and `firebase/app` (third-party). It imports
  **no** `scope:mobile` symbol, so the move does not create a `scope:shared →
scope:mobile` edge. (`shared/ui-kit`'s README states "It imports nothing else"
  re: TS — update that note: it now additionally imports `@vultus/shared/domain`
  + `firebase` + `@angular/core`, all permitted for a `scope:shared` lib.)
- **Not a premature `shared/` extraction.** The service now genuinely has **2**
  slice consumers (watchlist, title-detail) and depends only on `scope:shared`
  things; co-locating a single shared singleton in `shared/ui-kit` is the
  correct call (duplicating the cooldown state would defeat the shared window).
  This is a deliberate, justified extraction recorded here per the spec-author
  rule.

## Data model touchpoints

**None.** This spec adds, removes, or changes **no** Firestore collection,
field, converter, index, or security rule.

- `triggerSync` (spec 0025) is the only thing that writes Firestore, and it is
  **unchanged** — it still writes only `title-cache/**` via the engine port.
- The title-detail page's existing reads (`title-cache/{tmdbId}`,
  `title-cache/{tmdbId}/availability/{region}`, `users/{uid}.region`,
  `users/{uid}/watchlist/{titleId}`, `users/{uid}/watchlist/{titleId}/episodes`)
  are **unchanged**; they simply re-emit reactively after the sync writes.
- `localStorage` key `vultus_last_sync_at` is the only persisted client state,
  and it is unchanged (the constant moves modules but keeps its value).
- **No `firestore.rules`, no `firestore.indexes.json`, no `firebase.json`
  change** — record this in the PR.

## Public types / APIs

### `SyncStateService` — relocated to `@vultus/shared/ui-kit`

The service's **public surface is unchanged**; only its import path moves.
After the move:

```ts
// libs/shared/ui-kit/src/lib/sync-state.service.ts
import { Injectable, inject, signal } from '@angular/core';
import { FirebaseError } from 'firebase/app';
import { TRIGGER_SYNC } from '@vultus/shared/domain/tokens';

/** localStorage key holding the ISO timestamp of the last successful manual sync. */
export const LAST_SYNC_KEY = 'vultus_last_sync_at';

/** Client-side cooldown window for the manual sync trigger: 5 minutes. */
export const SYNC_COOLDOWN_MS = 300_000;

@Injectable({ providedIn: 'root' })
export class SyncStateService {
  /** True when a manual sync is allowed (not inside the cooldown window). */
  readonly canSync; // Signal<boolean>
  /** True while a manual sync is in flight. */
  readonly syncing; // Signal<boolean>
  /** Guards canSync/syncing, calls the injected TRIGGER_SYNC thunk; on success
   *  records the timestamp + restarts the cooldown; on failure re-throws
   *  (without advancing the timestamp) so the caller can show an error toast. */
  triggerSync(): Promise<void>;
}
```

- Exported from `libs/shared/ui-kit/src/index.ts` **alongside** the existing
  `SHARED_UI_KIT_THEME_PATH` and the four state atoms (none dropped):
  `export { SyncStateService, LAST_SYNC_KEY, SYNC_COOLDOWN_MS } from
'./lib/sync-state.service';`
- **Behaviour is byte-for-byte the same as the watchlist's current
  `SyncStateService`** — including: `providedIn: 'root'`; the cooldown restore
  on construction; the exact-expiry re-enable timer; the guarded `localStorage`
  access (degrade to "always allowed" on throw/unavailable); and the
  `console.error` distinct-message logging for `functions/not-found` /
  `functions/unauthenticated` `FirebaseError`s (spec 0033 on-device diagnosis)
  with a re-throw on failure. The implementer **moves the file**, it does not
  rewrite the logic.

### `slice:watchlist` — import re-point only

`WatchlistPage` currently does
`import { SyncStateService } from './watchlist.sync-state.service';`
(verified). Change it to
`import { SyncStateService } from '@vultus/shared/ui-kit';`. No other watchlist
change (the `onSync()` handler, the toolbar button, all toasts stay exactly as
spec 0025 left them). Delete `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.ts`
and `…watchlist.sync-state.service.spec.ts`.

### `slice:title-detail` — new pull-to-refresh handler

Add to `TitleDetailPage`:

- Add `IonRefresher` + `IonRefresherContent` to the `@Component({ imports })`
  array (the page already imports `IonContent` from
  `@ionic/angular/standalone`).
- Inject the shared service + a toast controller:
  ```ts
  import { ToastController } from '@ionic/angular/standalone';
  import { SyncStateService } from '@vultus/shared/ui-kit';
  // …
  readonly syncState = inject(SyncStateService);
  private readonly toastCtrl = inject(ToastController);
  ```
- A handler bound to `(ionRefresh)`:
  ```ts
  /**
   * Pull-to-refresh: trigger a manual whole-watchlist sync (spec 0025's
   * `triggerSync`) and surface the outcome as a toast. The shared
   * `SyncStateService` owns the cooldown — when the cooldown is active
   * (`canSync()` false) `triggerSync()` is a guarded no-op, so we complete the
   * refresher immediately with no toast. The refresher's spinner is dismissed
   * via `event.detail.complete()` in a `finally` so it always clears, even on
   * the cooldown no-op or an error. The page's existing Firestore streams
   * (`detail$`, providers, `episodes$`) re-emit on their own after the sync
   * writes `title-cache` — no manual reload here.
   */
  async onRefresh(event: CustomEvent): Promise<void> {
    const complete = () =>
      (event.detail as { complete: () => void }).complete();
    if (!this.syncState.canSync()) {
      complete(); // recently synced — nothing to do, no toast
      return;
    }
    try {
      await this.syncState.triggerSync();
      const toast = await this.toastCtrl.create({
        message: 'Refreshed',
        duration: 2000,
        position: 'bottom',
        color: 'success',
      });
      await toast.present();
    } catch {
      const toast = await this.toastCtrl.create({
        message: 'Sync failed — try again later',
        duration: 3000,
        position: 'bottom',
        color: 'danger',
      });
      await toast.present();
    } finally {
      complete();
    }
  }
  ```
  > Note: the cooldown check is `!this.syncState.canSync()` **before** calling
  > `triggerSync()`. `triggerSync()` itself is also a guarded no-op in cooldown,
  > but checking `canSync()` first lets us complete the refresher without
  > presenting a misleading success toast for a sync that never ran.
- **`addIcons`:** the refresher uses the **native platform spinner** (no
  ionicon), so no new icon registration is required. Do not add an icon.

(No new `scope:shared` type or callable is introduced — the `TRIGGER_SYNC`
token and the `triggerSync` callable already exist from spec 0025.)

## UI / Stitch screen refs

This is a `scope:mobile` change to the existing **title-detail** page. The
relevant Stitch screen is the title-detail screen from spec 0016 —
**screen ID `208cb8d7a679490b8d13672c6943d6d3`**, project
**`projects/13590348714018893783`** ("Vultus Android App Design"). Per the
CLAUDE.md / spec-0025 recipe the implementer **must pull the live screen** via
the `stitch` MCP to confirm the content layout the refresher sits above:
`get_screen` → take `htmlCode.downloadUrl` → fetch the **raw HTML** (plain GET /
`Invoke-WebRequest`, **not** WebFetch) → read the markup; grab
`screenshot.downloadUrl` for a visual compare. **Retry on MCP failure** (project
memory: the Stitch MCP is reachable — an in-session "MCP unreachable" is a
retry, not a reason to skip). If the screen HTML is genuinely unreadable after
retries, record **"Stitch screen NOT captured"** as a **blocking open item** in
the PR. **Reference the screen ID in the PR.**

**Authoritative tokens live in `docs/design/vultus-design-system.md`**, wired
into `shared/ui-kit` `theme.scss` as `--vultus-*` / `--ion-*` vars — consume
those vars; do **not** hand-transcribe hex values. (Reminder: primary is
`#4edea3`, **not** `#10B981`.)

**The `IonRefresher` is a native Ionic platform pattern with no design-system
token** — it renders the platform's native pull-to-refresh spinner (the same
component the Watchlist page already uses, verified in `watchlist.page.html`).
There is therefore **no bespoke styling, no custom spinner, and no new token**
to wire. The contract below is a checkable list of the structural facts (these
match the existing `IonContent`/refresher idiom already in the repo):

- **Placement:** `<ion-refresher slot="fixed" (ionRefresh)="onRefresh($event)">`
  with a single `<ion-refresher-content></ion-refresher-content>` child, placed
  as the **first child inside the page's existing `<ion-content>`** (the
  `<ion-content>` opens at `title-detail.page.html` line 20 — the refresher goes
  immediately after the opening tag, **before** the `@if (vm$ | async; as vm)`
  block). `slot="fixed"` is required so the refresher pins to the top of the
  scroll container and does not scroll with the content (this mirrors the
  watchlist's `watchlist.page.html` lines 48–50).
- **Spinner:** the **default** `ion-refresher-content` (no `pullingIcon` /
  `refreshingSpinner` overrides) → Ionic's platform-default refresher spinner.
  Do not set a custom spinner; do not theme it with `--vultus-*` (the native
  refresher is intentionally platform-styled).
- **Toasts (Ionic `ToastController`)** — match the watchlist pattern (spec 0025)
  but with the title-detail copy:
  - **success:** message **"Refreshed"**, `duration: 2000`, `position: 'bottom'`,
    `color: 'success'` (the `--ion-color-success` token via theme — not
    hardcoded).
  - **error:** message **"Sync failed — try again later"**, `duration: 3000`,
    `position: 'bottom'`, `color: 'danger'` (the `--ion-color-danger` token via
    theme — not hardcoded).
  - Toast text type role: **`body-md`** (14/400/20) per the design scale — this
    is the Ionic toast default; no override needed.
- **Interactive states (per-state acceptance list — the reviewer/human ticks each):**
  - **idle (not pulled):** no refresher UI visible; content scrolls normally.
  - **pulling:** dragging the content down past the threshold reveals the native
    refresher spinner (Ionic default behaviour — no custom threshold).
  - **refreshing (cooldown inactive, `canSync()` true):** on release the native
    spinner animates while `triggerSync()` is in flight (`syncState.syncing()`
    is true); on resolve the **"Refreshed"** success toast appears and the
    refresher completes (`event.detail.complete()` dismisses the spinner).
  - **refreshing → error:** on reject the **"Sync failed — try again later"**
    `danger` toast appears and the refresher still completes (spinner dismissed
    via the `finally`).
  - **cooldown active (`canSync()` false):** pulling to refresh **immediately
    completes** the refresher (native dismiss) with **no toast** and **no
    `triggerSync` call** — the user synced within the last 5 minutes, so there
    is nothing to do. The `IonRefresher` is **NOT disabled** (`disabled` stays
    `false` / unset) — disabling the refresher is not idiomatic Ionic UX; the
    handler no-ops instead.
  - **transition:** the spinner appears/dismisses via Ionic's built-in refresher
    animation; no custom animation is added.
- **Token wiring reminder:** Inter is already loaded as a web-font (spec 0010
  Google Fonts link in `index.html`); this feature adds no font. The native
  refresher spinner is unaffected by the font.

## Implementation task graph

One **sequential** prerequisite (the `SyncStateService` move + watchlist
re-point — it touches `shared/ui-kit` **and** `watchlist`, the shared dep both
the watchlist and the title-detail tasks consume), then one **parallel** slice
task (the title-detail wiring, whose files are disjoint from T1's). Because T1
already touches `watchlist`, there is no separate watchlist task — the re-point
is part of T1.

### Sequential prerequisite

1. **[sequential] Move `SyncStateService` to `shared/ui-kit` + re-point the
   watchlist import.** frontend-engineer.
   - **Move** `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.ts` →
     `libs/shared/ui-kit/src/lib/sync-state.service.ts` (rename the file to drop
     the `watchlist.` prefix; **no logic change**). Move the spec
     `…watchlist.sync-state.service.spec.ts` →
     `libs/shared/ui-kit/src/lib/sync-state.service.spec.ts`, updating its
     relative import to `./sync-state.service` (the test body is otherwise
     unchanged — it already mocks `TRIGGER_SYNC` + `localStorage`, no
     watchlist-specific deps).
   - **Export** `SyncStateService`, `LAST_SYNC_KEY`, `SYNC_COOLDOWN_MS` from
     `libs/shared/ui-kit/src/index.ts` (keep all existing exports).
   - **Delete** the two original watchlist files (`watchlist.sync-state.service.ts`
     + its `.spec.ts`).
   - **Re-point** `libs/mobile/watchlist/src/lib/watchlist.page.ts`'s import from
     `./watchlist.sync-state.service` to `@vultus/shared/ui-kit`. No other
     watchlist change.
   - Update `libs/shared/ui-kit/README.md` (add `SyncStateService` +
     `LAST_SYNC_KEY` / `SYNC_COOLDOWN_MS` to the public surface; correct the
     "imports nothing else" note to list `@angular/core` +
     `@vultus/shared/domain` + `firebase`) and
     `libs/mobile/watchlist/README.md` (the `SyncStateService` paragraph now says
     it lives in `@vultus/shared/ui-kit`, shared with title-detail).
   - **File manifest (creates/modifies/deletes):**
     - `libs/shared/ui-kit/src/lib/sync-state.service.ts` (new)
     - `libs/shared/ui-kit/src/lib/sync-state.service.spec.ts` (new)
     - `libs/shared/ui-kit/src/index.ts`
     - `libs/shared/ui-kit/README.md`
     - `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.ts` (delete)
     - `libs/mobile/watchlist/src/lib/watchlist.sync-state.service.spec.ts` (delete)
     - `libs/mobile/watchlist/src/lib/watchlist.page.ts` (import re-point only)
     - `libs/mobile/watchlist/README.md`

### Parallel slice task (disjoint manifest — depends on T1)

2. **[parallel after T1] Wire pull-to-refresh in `slice:title-detail`.**
   frontend-engineer. Depends on T1 (injects the relocated `SyncStateService`
   from `@vultus/shared/ui-kit`).
   - `title-detail.page.ts`: add `IonRefresher` + `IonRefresherContent` to the
     `imports`, inject `SyncStateService` (from `@vultus/shared/ui-kit`) +
     `ToastController` (from `@ionic/angular/standalone`), add the `onRefresh`
     handler from Public types / APIs.
   - `title-detail.page.html`: add the `<ion-refresher slot="fixed"
(ionRefresh)="onRefresh($event)"><ion-refresher-content></ion-refresher-content></ion-refresher>`
     as the first child inside the existing `<ion-content>` (before the
     `@if (vm$ | async; as vm)` block).
   - `title-detail.page.spec.ts`: extend with the pull-to-refresh component
     tests (see Test plan); mock `SyncStateService` (with controllable
     `canSync`/`syncing` signals + a `triggerSync` spy) and `ToastController`.
   - Update `libs/mobile/title-detail/README.md`: note the pull-to-refresh
     affordance, that it calls the shared `SyncStateService.triggerSync()` from
     `@vultus/shared/ui-kit` (whole-watchlist sync; the page's streams re-emit
     reactively), and that the cooldown is shared with the watchlist tab.
   - **File manifest (creates/modifies):**
     - `libs/mobile/title-detail/src/lib/title-detail.page.ts`
     - `libs/mobile/title-detail/src/lib/title-detail.page.html`
     - `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`
     - `libs/mobile/title-detail/README.md`

(T1's manifest — `libs/shared/ui-kit/**` + `libs/mobile/watchlist/**` — and T2's
manifest — `libs/mobile/title-detail/**` — are **disjoint**. But T2 imports the
symbol T1 relocates, so T2 must run **after** T1, not concurrently. `@angular/fire`,
`@ionic/angular`, `firebase`, `@vultus/shared/domain` are all already
dependencies — verify, add nothing new.)

## Test plan

Per the PLAN §5 pyramid: **unit** for the (moved, unchanged) cooldown logic;
**component** for the title-detail pull-to-refresh states. **No new e2e.**

**Unit — `scope:shared` (`libs/shared/ui-kit/src/lib/sync-state.service.spec.ts`,
moved verbatim):**

- The existing `SyncStateService` test suite moves with the service. **No logic
  changed**, so all existing cases must still pass after the relocation:
  `canSync` true with empty `localStorage`; `canSync` false within the window +
  flips true at exact expiry; `canSync` true when older than the window;
  `triggerSync` guarded no-op when `canSync` false / already `syncing`; happy
  path persists the timestamp + starts the cooldown; thunk rejection clears
  `syncing`, does not advance the timestamp, re-throws; `functions/not-found`
  distinct logging; degrades to "always allowed" when `localStorage` is
  unavailable / throws. Only the relative import path in the spec changes
  (`./sync-state.service`).

**Component — `scope:mobile` (`title-detail.page.spec.ts`, TestBed + Ionic;
mocked `SyncStateService` + `ToastController`):**

- **canSync true → pull triggers sync + success toast:** with `canSync()` true,
  invoking `onRefresh` (with a fake `CustomEvent` whose `detail.complete` is a
  spy) calls `syncState.triggerSync()` once, presents a **"Refreshed"** success
  toast, and calls `event.detail.complete()`.
- **canSync false → no-op:** with `canSync()` false, `onRefresh` does **not**
  call `triggerSync()`, presents **no** toast, and **still** calls
  `event.detail.complete()` (the refresher always dismisses).
- **error path → error toast:** with `canSync()` true and `triggerSync()`
  rejecting, `onRefresh` presents the **"Sync failed — try again later"**
  (`color: 'danger'`) toast and **still** calls `event.detail.complete()`.
- **(structural)** the `IonRefresher` renders inside the `IonContent` with
  `slot="fixed"` and is bound to `onRefresh` (assert the template wiring, e.g.
  the refresher element is present and `disabled` is not set).

> **e2e decision (per the rubric):** **Not required.** Pull-to-refresh is an
> existing Ionic pattern added to an **existing** route (title-detail), it
> introduces **no new navigation route or new critical action** — it reuses the
> `triggerSync` callable already exercised by the watchlist's
> `manual-sync-trigger` e2e flow (spec 0025), and adds no new server path. The
> shared `SyncStateService` cooldown is fully covered by the moved unit suite,
> and the page-level wiring by the component tests above. **No new e2e flow is
> added.** (Stated explicitly so the omission is intentional, not silent.)

## Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist to the three projects touched.

- [ ] `pnpm nx typecheck shared-ui-kit mobile-watchlist mobile-title-detail`
      passes — the relocated `SyncStateService` + barrel export, the watchlist
      import re-point, and the title-detail refresher wiring all compile.
- [ ] `pnpm nx lint shared-ui-kit mobile-watchlist mobile-title-detail` passes
      **with Sheriff active**: `shared/ui-kit` imports only `@angular/core`,
      `@vultus/shared/domain`, and `firebase` (all permitted for `scope:shared`)
      — **no `scope:mobile` import**; both slices import `SyncStateService` from
      `@vultus/shared/ui-kit` — **no cross-slice import, no
      `@angular/fire/functions` import, no `apps/mobile` import**.
- [ ] `pnpm nx test shared-ui-kit` passes — the **moved** `SyncStateService`
      cooldown suite is green (all prior cases pass unchanged); the existing
      state-atom tests still pass.
- [ ] `pnpm nx test mobile-watchlist` passes — the watchlist tests still pass
      with the re-pointed import; the deleted slice-local `SyncStateService` spec
      is gone (its coverage moved to `shared-ui-kit`).
- [ ] `pnpm nx test mobile-title-detail` passes — the new pull-to-refresh
      component tests (canSync true → triggerSync + success toast; canSync false
      → no-op + complete; error → error toast + complete) are green; the existing
      title-detail tests still pass.
- [ ] `pnpm nx build mobile` passes — the title-detail + watchlist slices and
      the relocated `shared/ui-kit` service bundle cleanly within budgets.
- [ ] `pnpm nx affected -t lint typecheck test build --base=main` is green
      (affected: `shared-ui-kit`, `mobile-watchlist`, `mobile-title-detail`,
      `mobile`).
- [ ] **`SyncStateService` behaviour is byte-for-byte unchanged** — the diff is
      a file move + barrel export + two import re-points + README updates; no
      method body changed. Recorded in the PR.
- [ ] **Boundary verifications (review-checked):** (a) `shared/ui-kit` gains
      **no** `scope:mobile` import; (b) `slice:title-detail` reaches the sync
      **only** via the relocated `SyncStateService` (which reaches the callable
      via the `TRIGGER_SYNC` token) — **no** `@angular/fire/functions`, **no**
      `@vultus/functions/*`, **no** `apps/mobile`, **no** `slice:watchlist`
      import; (c) `slice:watchlist` no longer has a slice-local
      `SyncStateService`; (d) **no cross-slice / cross-scope import** anywhere.
- [ ] **`sheriff.config.ts`, `firestore.rules`, `firestore.indexes.json`,
      `firebase.json`, and `apps/mobile` shell wiring are NOT modified** —
      verified, recorded in the PR (the `TRIGGER_SYNC` token + `provideFunctions`
      already exist from spec 0025).
- [ ] **READMEs updated in the same change** (CLAUDE.md lib-README rule):
      `libs/shared/ui-kit/README.md` (the `SyncStateService` export + corrected
      import note), `libs/mobile/watchlist/README.md` (service now lives in
      `shared/ui-kit`), and `libs/mobile/title-detail/README.md` (the
      pull-to-refresh affordance).
- [ ] **UI verified, not assumed (CLAUDE.md):** the pull-to-refresh is visually
      checked via `pnpm nx run mobile:serve-mock` (offline, no backend needed) —
      pull on the title-detail page shows the native spinner and (cooldown
      permitting) the "Refreshed" toast — **or** explicitly flagged
      "unverified — needs a human eyeball" in the PR. A green build does not
      prove the refresher renders.
- [ ] PR description records: the **Stitch title-detail screen ID** used (or
      "Stitch screen NOT captured" as a blocking item), the exact verification
      commands, the **`SyncStateService`-behaviour-unchanged** confirmation, the
      cross-slice/cross-scope boundary confirmations, the **no-`sheriff.config`/
      no-`firestore.rules`/no-index/no-shell** verification, and the **e2e: none
      added (reuses spec 0025's `manual-sync-trigger`)** note.

## Risks

- **Moving a `providedIn: 'root'` service relocates DI identity, not just the
  symbol.** Because the service is `providedIn: 'root'` and both slices import
  the **same** class token from `@vultus/shared/ui-kit`, there is exactly **one**
  instance — the cooldown is genuinely shared. If the move accidentally left a
  second copy (e.g. a stray re-export from the watchlist barrel, or a
  `providers: [SyncStateService]` somewhere), two instances would split the
  cooldown. **Binding:** the service is provided **only** via `providedIn:
'root'` (no component/route `providers` entry), and the watchlist slice
  **deletes** its local copy — verified in the boundary checklist.
- **Shared cooldown is intentionally global, not per-page.** A refresh on the
  title-detail page consumes the **same** 5-minute window as the watchlist
  toolbar button (and vice-versa). This is the locked decision (one personal
  sync budget), but it means a user who just synced from the watchlist will get
  the silent cooldown no-op on title-detail (refresher dismisses, no toast).
  Acceptable and intended; documented so it is not mistaken for a bug.
- **The refreshed title's data only appears if `triggerSync` actually changes
  `title-cache`.** `triggerSync` syncs the whole watchlist force-fresh; if the
  current title is **not** on the user's watchlist (title-detail can be reached
  for an untracked title via search/live-TMDB fallback — spec 0016/0043), the
  sync will **not** fetch that title (it only syncs watchlist titles), so the
  page's cache-miss live-TMDB view will not change. The "Refreshed" toast still
  shows (the sync ran). This matches `triggerSync`'s spec-0025 contract
  (watchlist-only) and is acceptable — a manual refresh is a "refresh my tracked
  titles" action; documented, not mitigated.
- **Episode list freshness depends on spec 0047 (`sync-episodes`) being merged.**
  This spec's claim that the `episodes$` stream updates after a refresh relies on
  the sync engine writing new episode docs, which is spec 0047's job. If 0047 is
  not yet merged, `triggerSync` still refreshes metadata + providers (the parts
  spec 0025's engine writes) and the episode list simply shows whatever episode
  docs already exist — the refresh does not regress anything. This spec adds **no**
  episode-fetch path of its own, so there is no hard dependency on 0047 to land;
  the episode-freshness benefit is a side-effect that arrives with 0047. Recorded
  as a known sequencing caveat, not a blocker.
- **`shared/ui-kit` gains its first injectable service + first runtime TS
  dependencies.** Until now `shared/ui-kit`'s only runtime exports were
  standalone components; it now also exports a root service that imports
  `@vultus/shared/domain` + `firebase`. These are permitted `scope:shared`
  imports (no boundary violation), but the implementer must verify the lib's
  Vitest/Analog setup (`src/test-setup.ts`) and `tsconfig` happily compile a
  plain `@Injectable` + its spec (the moved spec already uses `TestBed` +
  `vi.useFakeTimers`, the same harness the watchlist used — confirm
  `shared/ui-kit`'s test config provides an equivalent zoneless TestBed). If the
  lib's test-setup lacks something the spec needs, extend it minimally rather
  than weakening the test.
- **The two pages' pull-to-refresh semantics differ by design and must not be
  conflated.** The watchlist page's existing `onRefresh` (pull-to-refresh)
  **re-subscribes the Firestore stream only** — it does NOT call `triggerSync`.
  The watchlist already has a toolbar sync button for that. Title-detail's
  pull-to-refresh IS the `triggerSync` call (no toolbar button here). This
  difference is intentional; the implementer must **not** change the watchlist's
  `onRefresh` handler as part of this spec — T1 touches watchlist only to
  update the `SyncStateService` import path, nothing else.
- **Depends on spec 0025 (`TRIGGER_SYNC` token + `triggerSync` callable + the
  shell `provideFunctions` wiring) and spec 0016 (the title-detail page +
  `IonContent`) being merged.** Both are `done`. If the relocated service's
  `TRIGGER_SYNC` import or the title-detail `IonContent` are absent in the
  worktree, **stop and flag** rather than recreating them.
