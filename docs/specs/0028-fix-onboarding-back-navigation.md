---
number: 0028
slug: fix-onboarding-back-navigation
title: Fix back-button navigation returning to the onboarding screen
status: approved
slices: [slice:onboarding]
scopes: [scope:mobile]
created: 2026-06-26
---

# Fix back-button navigation returning to the onboarding screen

## 1. Context

GitHub issue #65: on first launch the user lands on the onboarding screen, picks
a region, and taps **Get started**; the app navigates into `/tabs/watchlist`.
Pressing the Android hardware **back** button then returns them to
`/onboarding` — but the onboarding page renders in a permanent loading/spinner
state and the user is **stuck** with no way back into the app.

Root cause (confirmed from code):

1. `libs/mobile/onboarding/src/lib/onboarding.page.ts` `onGetStarted()` navigates
   out with `await this.router.navigate(['/tabs/watchlist'])` — **without**
   `{ replaceUrl: true }`. So `/onboarding` stays on the Angular/Ionic navigation
   history stack, and the hardware back button pops straight back to it.
2. `apps/mobile/src/app/app.routes.ts` registers the `/onboarding` route with
   **no guard**. There is an `onboardingGuard` on `tabs` (redirects _into_
   onboarding until `onboarding_done` is `'true'`), but nothing prevents
   _re-entering_ `/onboarding` once onboarding is already done. So even a
   deep-link or a stale history entry can land the user back on a page that
   should never show again.

When the page is re-entered after completion, its `loading` signal can remain
set / the page re-runs in a half-state, presenting the "stuck spinner" the issue
describes.

Intended outcome: once onboarding is complete, the user can **never** get back to
`/onboarding` — not via the hardware back button, not via a deep-link, not via a
stale history entry. The back button from the first in-app screen behaves like a
normal app exit/no-op, not a return to onboarding.

## 2. Scope

In scope:

- Make the post-completion navigation in `onboarding.page.ts` use
  `{ replaceUrl: true }` so `/onboarding` is dropped from the history stack.
- Add a **reverse guard** (`reverseOnboardingGuard`, a `CanActivateFn`) in
  `onboarding.guard.ts` that redirects away from `/onboarding` to
  `/tabs/watchlist` when `onboarding_done` is already `'true'`; export it from
  the slice barrel.
- Register `reverseOnboardingGuard` as a `canActivate` on the `/onboarding` route
  in `app.routes.ts`.
- Unit tests for the new guard and for the page's `replaceUrl` navigation.
- Update `libs/mobile/onboarding/README.md` to document the new guard.

Out of scope:

- Any change to the onboarding **flow** itself (region picker, push explainer,
  `OnboardingService.complete()` behaviour) — spec 0022 owns those, unchanged.
- The existing `onboardingGuard` on `tabs` — its logic is unchanged; the new
  guard is the inverse, a separate export.
- Any Firestore / data-model / security-rule change.
- iOS-specific back-gesture handling.
- A new automated e2e flow (the back-button scenario is device-only — see §8).

## 3. Affected slices & Sheriff tags

All changes are within **`scope:mobile`**, **`slice:onboarding`** plus the mobile
shell (`apps/mobile`, `scope:mobile`).

| File                                                      | Tags                            | Change                                                                                    |
| --------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `libs/mobile/onboarding/src/lib/onboarding.page.ts`       | scope:mobile / slice:onboarding | `router.navigate(...)` → add `{ replaceUrl: true }` (both the success and the catch path) |
| `libs/mobile/onboarding/src/lib/onboarding.guard.ts`      | scope:mobile / slice:onboarding | add `reverseOnboardingGuard`                                                              |
| `libs/mobile/onboarding/src/index.ts`                     | —                               | export `reverseOnboardingGuard` from the barrel                                           |
| `libs/mobile/onboarding/src/lib/onboarding.guard.spec.ts` | scope:mobile / slice:onboarding | tests for the new guard                                                                   |
| `apps/mobile/src/app/app.routes.ts`                       | scope:mobile                    | add `canActivate: [reverseOnboardingGuard]` to `/onboarding`                              |
| `libs/mobile/onboarding/README.md`                        | —                               | document the new guard                                                                    |

Sheriff: the shell importing `reverseOnboardingGuard` from
`@vultus/mobile/onboarding` is `scope:mobile → scope:mobile` (allowed — same
pattern as the existing `onboardingGuard` import in `app.routes.ts`). **No
cross-slice imports.** No shared code is introduced, so the "extract only at 3+
slices" rule does not apply. **No `sheriff.config.ts` change** — the existing
path glob already tags `libs/mobile/onboarding/src`.

## 4. Data model touchpoints

**None.** No Firestore collection, field, converter, index, or security-rule
change. Both guards read the **existing** `onboarding_done` Capacitor
**Preferences** key (`ONBOARDING_DONE_KEY = 'onboarding_done'`, written by
`OnboardingService.complete()` in spec 0022) — a device-local preference, not
Firestore.

## 5. Public types / APIs

New export from `@vultus/mobile/onboarding` (added to `src/index.ts`):

```ts
/**
 * Reverse guard for the /onboarding route: redirects to /tabs/watchlist when the
 * onboarding_done Preferences flag is already 'true' (onboarding already done),
 * otherwise allows the onboarding page to render. The inverse of onboardingGuard.
 */
export const reverseOnboardingGuard: CanActivateFn;
```

Implementation contract (mirror the existing `onboardingGuard` structure in the
same file — capture `inject(Router)` **synchronously before the first `await`**,
because the injection context is gone once the `Preferences.get` promise
resolves):

```ts
export const reverseOnboardingGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const { value } = await Preferences.get({ key: ONBOARDING_DONE_KEY });
  if (value === 'true') {
    return router.createUrlTree(['/tabs/watchlist']);
  }
  return true;
};
```

- Returns a `UrlTree` redirect to `/tabs/watchlist` when the flag is `'true'`.
- Returns `true` (renders `/onboarding`) when the flag is absent / `null` / any
  non-`'true'` value (first-launch).
- Reuses the existing `ONBOARDING_DONE_KEY` and `Preferences` import already in
  `onboarding.guard.ts` — no new third-party deps.

`onboardingGuard` is unchanged. `OnboardingPage`'s public surface (the component
class) is unchanged; only the body of `onGetStarted()` changes.

## 6. UI / Stitch screen refs

**Not applicable — no visual change.** This is a navigation/routing fix. There is
**no Stitch screen for onboarding** in the project (recorded in spec 0022 and the
slice README), and this spec does not alter the onboarding page's layout,
typography, tokens, or any rendered element. No Stitch fetch is required. The
visible outcome is purely that the onboarding page no longer **reappears** after
completion.

## 7. Implementation task graph

This is a small, tightly-coupled bug fix; the slice library change and the shell
wiring must land together (the route references the new export). Two **sequential**
tasks — no parallel fan-out value, so no disjoint file manifests are needed.

### 1. [sequential] Slice fix: `replaceUrl` + reverse guard + tests + README

Owner: **frontend-engineer**. Files:

- `libs/mobile/onboarding/src/lib/onboarding.page.ts`
- `libs/mobile/onboarding/src/lib/onboarding.guard.ts`
- `libs/mobile/onboarding/src/index.ts`
- `libs/mobile/onboarding/src/lib/onboarding.guard.spec.ts`
- `libs/mobile/onboarding/README.md`

- In `onboarding.page.ts` `onGetStarted()`: change **both** navigation calls (the
  success path after `complete()` resolves, and the `catch` fallback) to
  `await this.router.navigate(['/tabs/watchlist'], { replaceUrl: true })` so
  `/onboarding` is removed from history in every exit path.
- In `onboarding.guard.ts`: add `reverseOnboardingGuard` per §5 (same
  inject-before-await structure as `onboardingGuard`; reuse `ONBOARDING_DONE_KEY`
  and the existing `Preferences` import).
- Export `reverseOnboardingGuard` from `src/index.ts`.
- Extend `onboarding.guard.spec.ts` with the new guard's cases (§8). The existing
  test helper provides a mock Router with `createUrlTree`; the reverse-guard
  cases assert `createUrlTree(['/tabs/watchlist'])` on the redirect path. Add a
  page-level unit test (new sibling spec `onboarding.page.spec.ts`, or extend an
  existing page spec if present) asserting `router.navigate` is called with
  `['/tabs/watchlist'], { replaceUrl: true }` after `complete()` resolves.
- Update `libs/mobile/onboarding/README.md`: add `reverseOnboardingGuard` to the
  **Public surface (barrel)** list and note the back-navigation fix in the
  **Behavior** section (the page now navigates out with `replaceUrl: true`, and
  the `/onboarding` route is guarded against re-entry once onboarding is done).

### 2. [sequential] Shell wiring: guard the `/onboarding` route

Owner: **frontend-engineer**. File: `apps/mobile/src/app/app.routes.ts`.

- Import `reverseOnboardingGuard` from `@vultus/mobile/onboarding` (alongside the
  existing `onboardingGuard` import).
- Add `canActivate: [reverseOnboardingGuard]` to the `/onboarding` route object.
- Update the file's doc-comment to mention the reverse guard (the `/onboarding`
  route now redirects already-onboarded users to `/tabs/watchlist`).

Depends on Task 1 (the export must exist first).

## 8. Test plan

Per the PLAN §5 pyramid — this is a small routing fix, so the surface is unit-level.

- **Unit (Vitest) — `reverseOnboardingGuard`** in `onboarding.guard.spec.ts`,
  reusing the existing `runInInjectionContext` + mock-Router + mocked
  `@capacitor/preferences` harness already in that file:
  - flag `'true'` → returns the `UrlTree`; `createUrlTree(['/tabs/watchlist'])`
    called.
  - flag `null` (absent) → returns `true`; `createUrlTree` **not** called.
  - flag non-`'true'` string (e.g. `'false'`) → returns `true`; `createUrlTree`
    **not** called.
- **Unit (Vitest) — `OnboardingPage.onGetStarted()`** (new
  `onboarding.page.spec.ts` or extend an existing page spec): with a stubbed
  `OnboardingService.complete()` that resolves, assert
  `router.navigate` is called with `['/tabs/watchlist']` and
  `{ replaceUrl: true }`. Optionally assert the `catch` path also uses
  `{ replaceUrl: true }` when `complete()` rejects.
- **Component:** none — no component state/markup change.
- **e2e: No new e2e flow.** Per the §5 e2e rubric this is **Not required for an
  automated flow** here: the spec-0022 onboarding e2e suite already covers the
  forward flow (first-launch → region → Get started → `/tabs/watchlist`), and the
  failing scenario is the **Android hardware back button**, which is a
  **device-only** behaviour Playwright (web) cannot exercise faithfully. Stated
  explicitly so the reviewer does not flag a missing e2e. The back-button
  behaviour is covered by the **human device-verification checklist** below.
- **Human device verification (post-merge, physical Android device):**
  1. Fresh install (clear app data so `onboarding_done` is unset) → onboarding
     shows on launch.
  2. Pick a region, tap **Get started** → lands on `/tabs/watchlist`.
  3. Press the **hardware back** button → the app does **not** return to the
     onboarding screen (no stuck spinner); it behaves as a normal app
     exit/no-op.
  4. Re-open the app → it opens directly into the tabs shell, never onboarding.

## 9. Definition of done

Tailored from the PLAN §5 / CLAUDE.md checklist (`onboarding` lib + `mobile` app
are affected):

- [ ] `onboarding.page.ts` navigates out of onboarding with `{ replaceUrl: true }`
      on **both** the success and catch paths.
- [ ] `reverseOnboardingGuard` added to `onboarding.guard.ts`, exported from the
      barrel, and registered as `canActivate` on the `/onboarding` route.
- [ ] Unit tests cover the new guard (flag `'true'` → redirect; absent/null and
      non-`'true'` → allow) and the page's `replaceUrl` navigation; all green.
- [ ] `libs/mobile/onboarding/README.md` updated for the new public guard +
      behaviour (in the same change).
- [ ] No cross-slice import; no `sheriff.config.ts` change; no Firestore /
      data-model / rule change.
- [ ] Standard gates green for affected projects:
      `nx affected -t typecheck lint build test --base=main` (lint includes
      Sheriff).
- [ ] e2e: no new automated flow — explicitly recorded; back-button behaviour
      verified via the human device checklist post-merge.

## 10. Risks

- **`replaceUrl: true` clears `/onboarding` from history.** This is the intended
  effect. If `complete()` were to throw, the navigation still fires because the
  catch path also navigates (with `replaceUrl: true`) — the user is never left on
  onboarding. (`OnboardingService.complete()` is best-effort and swallows its own
  errors per spec 0022, so the catch path is a belt-and-suspenders.)
- **Ionic/Capacitor back-button handling is layered.** The hardware back button
  is routed through Ionic's back-button event into Angular router navigation;
  `replaceUrl: true` on the exit navigation is the primary fix (no `/onboarding`
  on the stack), and `reverseOnboardingGuard` is the **belt-and-suspenders** for
  edge cases (deep-link to `/onboarding`, history not replaced on older OS
  versions, app resumed onto a stale entry). Both are needed; either alone leaves
  a gap.
- **Page-spec testability.** If the onboarding slice has no existing page-level
  spec harness, adding `onboarding.page.spec.ts` may require a small TestBed/inject
  setup for the component. This is in-slice and low-risk; if the page spec proves
  disproportionately heavy, the guard unit tests plus the human device checklist
  are the load-bearing verification — record any such trade-off in the PR.
- **No architecture conflict.** No new slice, no cross-slice import, no shared
  code, no data-model change; the change mirrors the existing `onboardingGuard`
  pattern and the existing shell-imports-slice-guard wiring.
