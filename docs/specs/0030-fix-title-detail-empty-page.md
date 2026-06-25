---
number: 0030
slug: fix-title-detail-empty-page
title: Fix title-detail page displaying blank while waiting for Firestore streams
status: approved
slices: [slice:title-detail]
scopes: [scope:mobile]
created: 2026-06-26
---

# 0030 — Fix title-detail page displaying blank while waiting for Firestore streams

## Context

GitHub issue #70: on a real device, searching for a movie/TV title returns a
result list, but tapping a result opens a **completely blank** detail page — not
even the loading skeleton (built in spec 0024) renders.

The `TitleDetailPage` template gates its entire body on a single
`@if (vm$ | async; as vm)`. If `vm$` does not emit, `ion-content` shows nothing:
no skeleton, no error, no content. The page only renders once `vm$` produces its
first value.

`vm$` is `combineLatest([detail$, region$])` piped through a `switchMap`.
`combineLatest` does not emit until **every** source has emitted at least once:

- `detail$` emits `{ kind: 'loading' }` immediately via `startWith` (in the
  service). ✓
- `region$` is `this.service.region$()`. When `uid` is non-null (the normal case
  on a real device with working anonymous auth), `region$()` returns a Firestore
  realtime stream (`docData(doc(firestore, userPath(uid)))`) that emits **only**
  when the `onSnapshot` callback fires. It does **not** emit synchronously. ✗

So on a real device with any Firestore latency, `combineLatest` stays silent
until the user doc round-trips, and the page is blank the whole time. (In the
existing component spec the bug is masked because the test double returns
`of('NL')` for `region$`, which emits synchronously.)

A secondary instance of the same defect: once `detail$` reaches
`{ kind: 'loaded' }`, the `switchMap` swaps to an inner
`combineLatest([providers$, tracked$])`. `tracked$` (uid non-null) is also a
`docData` stream with **no** `startWith`, so after the skeleton the page can go
blank again until the watchlist doc round-trips.

**Intended outcome:** the loading skeleton renders immediately on open, and the
page never blanks while waiting on the user/watchlist Firestore streams.

## Scope

In:

- Add `startWith<Region | null>(null)` to the `region$` member in
  `TitleDetailPage` so `vm$` emits the loading state immediately.
- Add `startWith<WatchlistItem | null>(null)` to the inner `tracked$` in the
  `vm$` `switchMap` so the loaded state renders without waiting on the watchlist
  doc.
- Component tests reproducing the blank-page scenario for both streams.

Out of scope:

- Any change to `TitleDetailService` (the service's null-uid paths already use
  `of(...)`; the realtime-stream timing is a page-composition concern).
- Any visual/markup change. The skeleton, error, not-found, and loaded markup
  are unchanged — the fix only makes the already-existing skeleton actually show.
- Search slice, settings/region picker, or any other slice.
- Data model, Firestore security rules, Sheriff config.

## Affected slices & Sheriff tags

- `libs/mobile/title-detail` — `scope:mobile`, `slice:title-detail`.

The change is entirely within one slice. No cross-slice imports are introduced;
`startWith`, `Region`, and `WatchlistItem` are already imported in
`title-detail.page.ts`. No `shared/` extraction is involved (the "extract only at
3+ slices" rule does not apply). No Sheriff boundary or config change.

## Data model touchpoints

None. No Firestore collections, fields, converters, or security rules are added
or changed. The reads involved (`users/{uid}`, `users/{uid}/watchlist/{titleId}`,
PLAN §4) are unchanged; only the page's RxJS composition over those existing
streams changes.

## Public types / APIs

None. No new or changed exported types, function signatures, endpoints, or
callable shapes. `DetailVm` already permits `region: Region | null` and
`tracked: WatchlistItem | null`, so the seeded `null` values are already valid.
`TitleDetailService`'s public surface is unchanged (its README needs no update).

## UI / Stitch screen refs

No Stitch screen fetch required — this is a bug fix with **no visual or markup
change**. The fix makes the loading skeleton (`<vultus-skeleton-hero>`, spec 0024) that already exists in the template actually render, and prevents a
transient re-blank. The "Where to Watch" card will briefly show its existing
null-region copy ("Set your region in Settings to see availability") until the
user doc resolves — that is existing copy and existing behavior on the uid-null
path, not a new UI state (see Risks).

## Implementation task graph

1. **[sequential]** Fix `vm$` composition in `title-detail.page.ts` and add the
   reproduction tests. Single task, single slice — no parallelism.
   - File manifest:
     - `libs/mobile/title-detail/src/lib/title-detail.page.ts`
     - `libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`
   - Changes in `title-detail.page.ts`:
     - `region$` member: insert `startWith<Region | null>(null)` **before**
       `shareReplay(...)` in the `.pipe(...)` so `vm$` emits immediately:
       ```ts
       private readonly region$ = this.service
         .region$()
         .pipe(
           startWith<Region | null>(null),
           shareReplay({ bufferSize: 1, refCount: true }),
         );
       ```
     - inner `tracked$` in the `vm$` `switchMap`: add
       `startWith<WatchlistItem | null>(null)`:
       ```ts
       const tracked$ = this.service
         .tracked$(state.detail.tmdbId)
         .pipe(startWith<WatchlistItem | null>(null));
       ```

## Test plan

Component tests in
`libs/mobile/title-detail/src/lib/title-detail.page.spec.ts`. The current test
double returns `of('NL')` / `of(null)` for `region$` / `tracked$`, which emit
synchronously and therefore **cannot** reproduce the bug. The new tests must
drive those streams from a source that does **not** emit synchronously (e.g.
`NEVER`, or a `Subject`/`ReplaySubject` left un-`next`-ed), matching how a
pending Firestore `docData` stream behaves on a real device.

- **Skeleton shows while `region$` is pending (primary regression):** with
  `detail$` emitting `{ kind: 'loading' }` and `region$` returning a
  never-emitting stream, `vm$` must still emit and the template must render
  `[data-test="loading"]` / `<vultus-skeleton-hero>`. Before the `region$`
  `startWith(null)` fix this assertion fails (the content is blank). Extend
  `makeService`/`SvcOpts` to allow a non-emitting `region$` (e.g. a
  `region: 'pending'` sentinel mapping to `NEVER`).
- **Loaded content shows while `tracked$` is pending (secondary regression):**
  with `detail$` emitting `{ kind: 'loaded', ... }` and `tracked$` returning a
  never-emitting stream, `vm$` must emit the loaded state with `tracked: null`
  (the hero title + Add-to-Watchlist CTA render). Before the `tracked$`
  `startWith(null)` fix this assertion fails (blank after the skeleton). Extend
  `SvcOpts` to allow a non-emitting `tracked$`.
- **No regressions:** all existing `TitleDetailPage` specs continue to pass
  (loading, not-found, error+retry, loaded movie/tv, poster placeholder,
  cache/live DOM parity, provider groups, empty/null-region, tracked/untracked
  actions).

### e2e

No e2e flows required for this spec. Per the rubric this is a `scope:mobile`
change that touches a primary route, but it introduces **no new route or action**
— it fixes rendering of the existing title-detail page, which is exercised by the
existing search → detail e2e flow (spec 0019). That existing flow, when run on a
real Firestore-backed target, already covers the regression; this fix adds no new
named flow. (Note: the bug only manifests against a real Firestore stream, not
the synchronous test doubles, so it is the component tests above plus the
existing e2e flow that gate it — there is no new Playwright flow to add.)

## Definition of done

- Typecheck passes (`nx affected -t typecheck --base=main`).
- Lint + Sheriff pass (no new boundary violations).
- Unit/component tests pass, including the two new regression tests above; the
  changed slice has tests for the fixed logic.
- Build passes (`nx affected -t build --base=main`).
- Affected critical e2e flows (search → detail, spec 0019) green where the e2e
  gate is runnable; degrade gracefully if tooling is absent (per CLAUDE.md /
  skills).
- No lib README change needed (no public-API change), and none is made.

## Risks

- **Brief null-region copy for users who have set a region.** Seeding `region$`
  with `null` means the "Where to Watch" card shows "Set your region in
  Settings to see availability" until the user doc's `onSnapshot` resolves, even
  for users who already have a region. This is acceptable: it is the existing
  behavior on the uid-null path and lasts only until the first emission
  (typically < 300ms on a good connection). The alternative — leaving the whole
  page blank — is the bug being fixed.
- **No data-model, Firestore-rules, or Sheriff-boundary change**, so no
  migration or security risk.
- **Test-double timing.** The bug is invisible to synchronous `of(...)` doubles;
  if the new tests are written with synchronous sources they will pass even
  against the unfixed code and provide no regression coverage. The reproduction
  must use a non-emitting source (`NEVER`/un-`next`-ed `Subject`) — called out
  in the test plan.
- No PLAN.md conflict: the fix stays within the vertical slice and the existing
  Firestore data model (PLAN §3–§4).
