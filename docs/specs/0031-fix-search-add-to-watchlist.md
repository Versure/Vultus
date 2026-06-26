---
number: 0031
slug: fix-search-add-to-watchlist
title: Fix add-to-watchlist button in search showing no feedback and silently failing
status: done
slices: [slice:search]
scopes: [scope:mobile]
created: 2026-06-26
---

# Fix add-to-watchlist button in search showing no feedback and silently failing

## 1. Context

GitHub issue #67: "When running the app on my phone I can search for tv shows
and movies but cannot add them to my wish list, nothing happens when clicking on
the add button."

Root cause (confirmed from code in the search slice):

1. `SearchPage.onAdd()` (`libs/mobile/search/src/lib/search.page.ts`) is
   **fire-and-forget**: `void this.service.add(result)`. It does not `await` the
   promise and has no `catch`, so any rejection from `add()` is silently
   swallowed.
2. `SearchService.add()` (`libs/mobile/search/src/lib/search.service.ts`) does
   the optimistic UI update (flip `_addedIds` + the result's `added` flag)
   **after** `await setDoc(...)`. If `setDoc` throws — Firestore permission
   denied, offline, or any network error — execution stops at the `await` and
   the two optimistic-update lines **never run**. The button stays in its
   "not added" state.

Net effect for the user: tapping **Add** does nothing visible, with no error.
On a real device (where transient network / write failures are far more likely
than in the emulator) this is exactly the reported symptom. There is also **no
success confirmation** today — the only feedback on success is the button
swapping to the disabled checkmark, which is easy to miss.

Intended outcome: tapping **Add** gives **immediate** visual feedback (the
button flips to the added/checkmark state at once), and if the underlying
Firestore write fails the UI **rolls back** and the user sees an explicit error
toast ("Failed to add — try again later"). The user is never left guessing.

## 2. Scope

In scope:

- `SearchService.add()`: apply the optimistic update **before** the `setDoc`
  await (true optimistic pattern), wrap the write in `try/catch`, **roll back**
  both signals on failure, and **re-throw** so the page can surface the error.
- `SearchPage.onAdd()`: make it `async`, `await service.add(result)` inside a
  `try/catch`, and present a `color: 'danger'` error toast on failure. Inject
  `ToastController` (not currently in `SearchPage`).
- Unit tests for the service rollback/re-throw + optimistic ordering.
- Component tests for the error-toast behaviour on `onAdd`.
- Update `libs/mobile/search/README.md` to note the optimistic add + error-toast
  behaviour.

Out of scope:

- A **success** toast on add. The existing button → checkmark transition is the
  success affordance; adding a success toast is a separate UX decision, not part
  of this bug fix. (Noted explicitly so the implementer does not add one.)
- The live `collectionData` watchlist subscription in the `SearchService`
  constructor — unchanged. (It is the reconciler that confirms/corrects the
  optimistic set; see §10.)
- The duplicate guard (`if (this._addedIds().has(titleId)) return;`) and the
  `if (!uid) return;` early-return — behaviour preserved (the latter is the
  "no signed-in user yet" no-op; not the cause of issue #67, which is a thrown
  `setDoc`).
- Any Firestore schema, converter, security-rule, or `WatchlistItem` shape
  change. Any cross-slice change.
- The watchlist slice (`libs/mobile/watchlist`) — it already has its own
  ToastController flow (spec 0025) and is not touched here.

## 3. Affected slices & Sheriff tags

All changes are within **`scope:mobile`**, **`slice:search`**. No shell
(`apps/mobile`) change.

| File                                                | Tags                        | Change                                                                                                         |
| --------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `libs/mobile/search/src/lib/search.service.ts`      | scope:mobile / slice:search | Move optimistic update before the `setDoc` await; add `try/catch`; roll back both signals on failure; re-throw |
| `libs/mobile/search/src/lib/search.page.ts`         | scope:mobile / slice:search | `onAdd` → `async`; inject `ToastController`; `await service.add()` in `try/catch`; error toast on failure      |
| `libs/mobile/search/src/lib/search.service.spec.ts` | scope:mobile / slice:search | Tests: optimistic-before-await, rollback on throw, re-throw, uid-null no-op                                    |
| `libs/mobile/search/src/lib/search.page.spec.ts`    | scope:mobile / slice:search | Tests: error toast on reject, no toast on resolve                                                              |
| `libs/mobile/search/README.md`                      | —                           | Document optimistic add + error toast                                                                          |

Sheriff:

- `ToastController` is imported from `@ionic/angular/standalone` — a third-party
  dependency, allowed from any scope. This is the **same import path** already
  used by `libs/mobile/watchlist` (spec 0025), so no new boundary is crossed.
- **No cross-slice imports.** No shared code is introduced (the toast pattern now
  appears in watchlist + search = 2 slices, **below** the "extract only at 3+
  slices" threshold, so it stays duplicated by design — do not extract).
- **No `sheriff.config.ts` change** — the existing path glob already tags
  `libs/mobile/search/src`.

## 4. Data model touchpoints

**No schema change.** The write target is unchanged: a `WatchlistItem` document
at `watchlistItemPath(uid, titleId)` (PLAN §4, `users/{userId}/watchlist/{titleId}`),
serialized via `watchlistItemToData()` from `@vultus/shared/firestore-schema`.
The fix only changes **when** the local optimistic state is applied relative to
the write and how a **failed** write is handled — it does not change the document
shape, the path, the converter, indexes, or security rules.

The `previousSnapshot` transition model (PLAN §4) is untouched: the item is
created with `status: 'planned'` exactly as today.

## 5. Public types / APIs

No type changes. The `SearchService.add(result: SearchResult): Promise<void>`
signature is unchanged, but its **contract** is sharpened:

```ts
/**
 * Adds a result to the user's watchlist with an optimistic local update.
 *
 * - No-op when there is no signed-in uid, or when the title is already added.
 * - Applies the optimistic update (flip `_addedIds` + the result's `added`
 *   flag) BEFORE awaiting the Firestore write, so the button reflects the add
 *   immediately.
 * - On write failure: rolls back BOTH the optimistic signal updates, then
 *   RE-THROWS so the caller (SearchPage) can present an error toast.
 */
async add(result: SearchResult): Promise<void>;
```

Reference implementation (the contract the implementer follows):

```ts
async add(result: SearchResult): Promise<void> {
  const uid = this._uid();
  if (!uid) return;
  const titleId = String(result.tmdbId);
  if (this._addedIds().has(titleId)) return; // duplicate guard

  // Optimistic update FIRST — the button flips to "added" immediately.
  this._addedIds.update((s) => new Set([...s, titleId]));
  this._results.update((rs) =>
    rs.map((r) => (r.tmdbId === result.tmdbId ? { ...r, added: true } : r)),
  );

  const item: WatchlistItem = {
    type: result.type,
    tmdbId: result.tmdbId,
    traktId: null,
    title: result.title,
    addedAt: new Date().toISOString(),
    status: 'planned',
  };

  try {
    await setDoc(
      doc(this._firestore, watchlistItemPath(uid, titleId)),
      watchlistItemToData(item),
    );
  } catch (err) {
    // Roll back BOTH optimistic updates.
    this._addedIds.update((s) => {
      const n = new Set(s);
      n.delete(titleId);
      return n;
    });
    this._results.update((rs) =>
      rs.map((r) => (r.tmdbId === result.tmdbId ? { ...r, added: false } : r)),
    );
    throw err; // re-throw so SearchPage can show the toast
  }
}
```

`SearchPage.onAdd` becomes `async` and presents a toast on failure, mirroring the
existing watchlist toast pattern (`inject(ToastController)`,
`@ionic/angular/standalone`, `color: 'danger'`, bottom, 3000ms):

```ts
async onAdd(result: SearchResultView, event: Event): Promise<void> {
  event.stopPropagation();
  try {
    await this.service.add(result);
  } catch {
    const toast = await this.toastCtrl.create({
      message: 'Failed to add — try again later',
      duration: 3000,
      position: 'bottom',
      color: 'danger',
    });
    await toast.present();
  }
}
```

- Add `ToastController` to the `@ionic/angular/standalone` import in
  `search.page.ts` and `private readonly toastCtrl = inject(ToastController);` to
  the class. `ToastController` is a **service** (not a component), so it does
  **not** go in the component `imports` array — same as in `watchlist.page.ts`.
- The template binding `(click)="onAdd(result, $event)"` is unchanged; Angular
  handles a method that now returns a promise.

## 6. UI / Stitch screen refs

**No new layout or token change.** This fix does not alter the search results
markup, the add-button geometry, the card layout, typography, or any
`--vultus-*` token. The visible deltas are purely behavioural:

1. The add button flips to its existing **added** state (the disabled
   `checkmark-circle` `ion-button.added-btn`, already in `search.page.html`)
   **immediately** on tap, instead of only after the write resolves.
2. On a failed write the button **reverts** to the add state and a standard Ionic
   error toast appears.

The toast uses the **standard Ionic `ToastController`** styled by the project
theme's `color: 'danger'` (`--ion-color-danger`, wired in
`shared/ui-kit` `theme.scss`, sourced from `docs/design/vultus-design-system.md`)
— do **not** hand-set a hex. This is the identical toast treatment already
shipped in `libs/mobile/watchlist` (spec 0025): bottom position, 3000ms,
`color: 'danger'`.

No Stitch screen fetch is required for this spec because no rendered element's
dimensions, insets, radius, type role, or interactive state changes — the
existing search screen contract (spec 0013 / 0024) still holds. The add button's
default/added/disabled states are unchanged in appearance; only **when** the
added state is entered (and the new failure → revert) changes.

Per-state acceptance (behavioural, tickable by reviewer):

- [ ] **Tap (default → optimistic):** button flips from `.add-btn` (plus `add`
      icon) to `.added-btn` (disabled, `checkmark-circle` icon) immediately on
      tap, before the write resolves.
- [ ] **Write succeeds:** button stays in the added/checkmark state (the live
      `collectionData` subscription confirms it).
- [ ] **Write fails:** button reverts to `.add-btn` and a `color: 'danger'`
      toast ("Failed to add — try again later", bottom, ~3s) is shown.
- [ ] **Already-added result:** renders the disabled `.added-btn` only (no
      `.add-btn`) — unchanged from today.

## 7. Implementation task graph

This is a small, single-slice bug fix. The service change and the page change are
tightly coupled (the page relies on `add()` re-throwing) and write disjoint sets
of files, but there is no parallel fan-out value — one **sequential** task keeps
it simple per the additional instructions.

### 1. [sequential] Search slice: optimistic add + rollback + error toast + tests + README

Owner: **frontend-engineer**. Files:

- `libs/mobile/search/src/lib/search.service.ts`
- `libs/mobile/search/src/lib/search.page.ts`
- `libs/mobile/search/src/lib/search.service.spec.ts`
- `libs/mobile/search/src/lib/search.page.spec.ts`
- `libs/mobile/search/README.md`

Steps:

- In `search.service.ts` `add()`: move the two optimistic-update lines **above**
  the `WatchlistItem`/`setDoc` block; wrap `setDoc` in `try/catch`; in `catch`,
  roll back both `_addedIds` (delete the id) and `_results` (set `added: false`
  for the matching `tmdbId`), then re-throw. Preserve the `if (!uid) return;`
  early-return and the duplicate guard ahead of the optimistic update. (See §5
  reference implementation.)
- In `search.page.ts`: add `ToastController` to the `@ionic/angular/standalone`
  import; add `private readonly toastCtrl = inject(ToastController);`; make
  `onAdd` `async` and wrap `await this.service.add(result)` in a `try/catch` that
  presents the `color: 'danger'` toast on failure (see §5). Keep
  `event.stopPropagation()` first. Do **not** add `ToastController` to the
  component `imports` array (it is a service).
- Extend `search.service.spec.ts` (§8) — the existing `@angular/fire/firestore`
  mock already stubs `setDoc`; drive its resolve/reject to exercise the new
  paths.
- Extend `search.page.spec.ts` (§8) — provide a mock `ToastController` whose
  `create` resolves to an object with a `present` spy (mirror
  `watchlist.page.spec.ts`'s harness); make the mock `service.add` reject to
  assert the toast, resolve to assert no toast.
- Update `libs/mobile/search/README.md`: in the **Behavior** section note that
  add is optimistic (button flips immediately), rolls back on write failure, and
  surfaces a `color: 'danger'` toast; mention `ToastController` is now a page
  dependency.

## 8. Test plan

Per the PLAN §5 pyramid. Search is a `scope:mobile` slice but this change does
**not** introduce or substantially change a navigation route or a new primary
action — it fixes feedback on an **existing** action — so per the e2e rubric a
new automated flow is **not required** (see below). Coverage is unit + component.

**Unit (Vitest) — `search.service.spec.ts`** (uses the existing
`@angular/fire/firestore` module mock; `setDoc` is a `vi.fn()`):

- `add()` applies the optimistic update **immediately / before `setDoc`
  resolves** — with `setDoc` returning a never-resolving (or deferred) promise,
  assert `service.results()` shows `added: true` and the internal added-set
  contains the id **before** awaiting. (Assert ordering, e.g. read state after
  calling `add` synchronously / between microtasks, before the deferred resolves.)
- `add()` **rolls back** both updates when `setDoc` rejects — with `setDoc`
  mocked to reject, after `add()` rejects, `service.results()` shows
  `added: false` for that result and the id is absent from the added set.
- `add()` **re-throws** on `setDoc` failure — `await expect(service.add(r))`
  `.rejects` (so the page can show a toast).
- `add()` is a **no-op when uid is null** — with `AUTH_UID` signal `null`,
  `setDoc` is not called and no state changes (existing behaviour, kept).
- `add()` is a **no-op for an already-added** result (duplicate guard) — id
  already in the added set → `setDoc` not called.

**Component (Vitest + TestBed) — `search.page.spec.ts`** (extend the existing
suite; add a mock `ToastController` provider):

- `onAdd()` calls `service.add(result)` — **existing test, keep** (the
  "calls add when Add button tapped" / "does not navigate" cases).
- `onAdd()` shows an error toast (`color: 'danger'`, message "Failed to add — try
  again later") when `service.add()` **rejects** — mock `service.add` to reject,
  click `.add-btn`, assert `toastCtrl.create` called with the danger config and
  `toast.present()` called.
- `onAdd()` does **not** show a toast when `service.add()` **resolves** — default
  mock (resolves), click `.add-btn`, assert `toastCtrl.create` **not** called.

**e2e:** **Not required — feedback fix on an existing action, no new route or
primary navigation.** The search slice's add path is exercised at the unit +
component level above. Stated explicitly per the §8 rubric so the reviewer does
not flag a missing flow. (If a search→add e2e is later desired it belongs to the
search-slice e2e spec, not this bug fix.) Device verification of the real
on-device failure (issue #67's actual symptom) is in the human checklist below.

**Human device verification (post-merge, physical Android device):**

1. Search for a title, tap **Add** → button flips to the checkmark **immediately**.
2. With the item added, confirm it appears on the watchlist tab.
3. Simulate a failing write (e.g. airplane mode / offline) and tap **Add** → the
   button reverts and the "Failed to add — try again later" toast appears.

## 9. Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist (`search` lib affected; no
shell/app change):

- [ ] `SearchService.add()` applies the optimistic update **before** the `setDoc`
      await, rolls back **both** signals on failure, and **re-throws**.
- [ ] `SearchPage.onAdd()` is `async`, awaits `service.add()` in `try/catch`, and
      presents a `color: 'danger'` toast ("Failed to add — try again later") on
      failure; `ToastController` injected (not in component `imports`).
- [ ] Unit tests cover optimistic ordering, rollback, re-throw, uid-null no-op,
      and duplicate-guard no-op; all green.
- [ ] Component tests cover error toast on reject and no toast on resolve; the
      existing `onAdd`/navigation tests still pass.
- [ ] `libs/mobile/search/README.md` updated for the optimistic-add + error-toast
      behaviour (same change).
- [ ] No cross-slice import; no shared-code extraction; no `sheriff.config.ts`,
      Firestore schema, converter, or security-rule change.
- [ ] No success toast added (out of scope).
- [ ] Standard gates green for affected projects:
      `nx affected -t typecheck lint build test --base=main` (lint includes
      Sheriff).
- [ ] e2e: no new automated flow — explicitly recorded; on-device add (success
      and failure) verified via the human checklist post-merge.

## 10. Risks

- **Brief "added" flash before a rollback.** Moving the optimistic update before
  `setDoc` means a failed write shows the checkmark for a moment, then reverts.
  This is the standard mobile optimistic-UI pattern — it feels faster, and the
  rollback + danger toast communicate the failure clearly. Accepted.
- **Race with the live `collectionData` subscription.** The constructor
  subscription is the reconciler. On **success**, it re-emits with the new doc
  and confirms the optimistic set (no-op vs the optimistic value). On **failure**,
  the write never lands, so the subscription never emits a contradicting value,
  and our explicit rollback restores the correct `added: false`. The two never
  fight: the subscription only ever sets state from what's actually in Firestore,
  and the rollback only removes an id the subscription was never told to add.
  No additional guarding needed.
- **`ToastController` injection context.** `inject(ToastController)` at field
  initialization runs in the component's injection context — identical to
  `watchlist.page.ts` (spec 0025), so this is a proven pattern. The toast is
  created/presented inside the async `catch`, after the injection context is
  captured at construction, so there is no "injection outside context" issue.
- **No architecture conflict.** Single slice, no cross-slice import, no shared
  extraction (toast pattern now in 2 slices, under the 3+ threshold), no
  data-model change. Fully consistent with PLAN §3–§4.
- **`setDoc` error opacity.** The page shows a generic "try again later" message
  rather than distinguishing offline vs permission-denied. This is intentional
  for a bug fix — the user need is "tell me it failed", not error taxonomy. The
  service re-throws the original error so a future enhancement could branch on it.
