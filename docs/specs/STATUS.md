<!--
  GENERATED FILE — DO NOT HAND-EDIT.

  This ledger is generated from every docs/specs/NNNN-*.md spec
  frontmatter by tools/scripts/gen-spec-status.mjs. To refresh it,
  run `node tools/scripts/gen-spec-status.mjs`. A stale ledger is
  caught by `node tools/scripts/gen-spec-status.mjs --check` (the
  pre-commit hook + the CI `nx test` gate).
-->

# Spec status ledger

Total specs: 89

- done: 86
- approved: 3

| # | slug | title | status | slices | scopes |
| --- | --- | --- | --- | --- | --- |
| 1 | bootstrap-workspace | Bootstrap the Nx workspace with Sheriff module boundaries enforced | done | — | scope:shared, scope:mobile, scope:functions |
| 2 | ci-pipeline | Add GitHub Actions CI pipeline running the definition-of-done gates on PRs | done | — | scope:shared, scope:mobile, scope:functions |
| 3 | domain-types | Define the core domain types in shared/domain | done | — | scope:shared |
| 4 | firebase-config-emulators | Commit version-controlled Firebase config and wire up the local Emulator Suite | done | — | scope:shared |
| 5 | firestore-schema | Add collection paths and Timestamp converters in shared/firestore-schema | done | — | scope:shared |
| 6 | tmdb-client | Add a typed TMDB API client to the sync-titles functions slice | done | slice:sync-titles | scope:functions |
| 7 | trakt-client | Add a typed Trakt calendar client to the sync-titles functions slice | done | slice:sync-titles | scope:functions |
| 8 | sync-engine | Add the title-cache sync engine to the sync-titles functions slice | done | slice:sync-titles | scope:functions, scope:shared |
| 9 | http-sync-function | Add the HTTP sync function wrapping the sync engine in apps/functions | done | slice:sync-titles | scope:functions |
| 10 | app-shell | Add the Ionic tabs app shell, routing, Firebase/AngularFire init, anonymous auth, and the three stub mobile slice libs | done | slice:watchlist, slice:search, slice:settings | scope:mobile, scope:shared |
| 11 | settings-slice | Flesh out the settings slice — region picker, global notifications toggle, and eager users/{uid} init | done | slice:settings | scope:mobile, scope:shared |
| 12 | notification-dispatcher | Add the notification dispatcher — Firestore trigger, transition detection, FCM dispatch | done | slice:dispatch-notifications | scope:functions |
| 13 | search-slice | Build the search slice — debounced TMDB search with inline add-to-watchlist | done | slice:search | scope:mobile |
| 14 | watchlist-slice | Flesh out the watchlist slice — grouped status list, type filter, status action sheet, remove, and provider badges | done | slice:watchlist | scope:mobile, scope:shared |
| 15 | tmdb-ci-key-injection | Wire TMDB API key injection for CI/CD and local dev | done | — | scope:mobile |
| 16 | title-detail-slice | Build the title-detail slice — per-title detail page with metadata, regional providers, and watchlist actions | done | slice:title-detail | scope:mobile |
| 17 | daily-sync-cron | Add the daily-sync GitHub Actions cron that triggers the syncTitles function | done | — | scope:functions |
| 18 | settings-design-alignment | Align settings page visual design to Stitch | done | slice:settings | scope:mobile |
| 19 | e2e-setup | Set up Playwright e2e infrastructure against the Firebase emulators and wire 8 critical flows into CI | done | — | scope:mobile |
| 20 | capacitor-android-build | Wire the Capacitor Android platform — add android/, app icon + splash, FCM plumbing, and Nx sync/open targets so the app builds and runs as a debug APK on a device | done | — | scope:mobile |
| 21 | daily-sync-public-invoker | Fix the failing daily-sync cron — make syncTitles publicly invokable and add deploy + runtime regression checks | done | — | scope:functions |
| 22 | onboarding-flow | Add the first-launch onboarding flow — region pick + push-permission grant + FCM token registration before the tabs shell | done | slice:onboarding | scope:mobile, scope:shared |
| 23 | functions-deploy-env-asset | Fix the CI Functions deploy — stage the .env.vultus-cab62 param file into dist in preflight and guard it loudly | done | — | scope:functions |
| 24 | empty-loading-states | Align empty, loading, and error states across all mobile slices to the Stitch design | done | slice:watchlist, slice:search, slice:title-detail, slice:settings | scope:mobile, scope:shared |
| 25 | manual-sync-trigger | Add a manual "refresh now" sync trigger to the watchlist toolbar via a triggerSync callable | done | slice:watchlist, slice:sync-titles | scope:mobile, scope:functions |
| 26 | debug-android-prod-parity | Inject real config/secrets at build time so a debug-signed Android APK has full production parity, keeping committed files key-free | done | — | scope:mobile |
| 27 | serve-emulator-build-dep | Make mobile:serve-emulator build functions before starting the emulator | done | — | scope:mobile |
| 28 | fix-onboarding-back-navigation | Fix back-button navigation returning to the onboarding screen | done | slice:onboarding | scope:mobile |
| 29 | android-edge-to-edge | Enable edge-to-edge / fullscreen rendering on Android via the StatusBar plugin | done | — | scope:mobile |
| 30 | fix-title-detail-empty-page | Fix title-detail page displaying blank while waiting for Firestore streams | done | slice:title-detail | scope:mobile |
| 31 | fix-search-add-to-watchlist | Fix add-to-watchlist button in search showing no feedback and silently failing | done | slice:search | scope:mobile |
| 32 | fix-settings-load-reactive | Fix settings page not loading when uid resolves after ngOnInit | done | slice:settings | scope:mobile |
| 33 | fix-manual-sync-error | Diagnose and fix manual sync always failing with "Sync failed — try again later" | done | slice:watchlist | scope:mobile, scope:functions |
| 34 | episode-watch-progress | Add episode list and watch-progress tracking to the title-detail slice | done | slice:title-detail | scope:mobile, scope:shared |
| 35 | fix-watchlist-poster-image | Fix watchlist — denormalize posterPath and voteAverage on add | done | slice:search | scope:mobile |
| 36 | fix-detail-poster-blurry | Fix blurry title-detail hero poster by serving a larger TMDB image size | done | slice:title-detail | scope:mobile |
| 37 | fix-title-detail-navigation | Fix title-detail page showing the wrong title on navigation from watchlist/search | done | slice:title-detail | scope:mobile |
| 38 | consolidate-mobile-targets | Consolidate mobile Nx run/build targets into 5 named scenarios | done | — | scope:mobile |
| 39 | android-immersive-system-bars | Auto-hide the Android status & navigation bars (sticky immersive mode) | done | — | scope:mobile |
| 40 | seed-worktree-local-files | Seed gitignored local files into feature worktrees on creation | done | — | — |
| 41 | notification-deep-links | Display FCM push notifications and deep-link taps to the title-detail page | done | slice:title-detail | scope:mobile, scope:functions |
| 42 | notifications-inbox | Add an in-app notifications inbox slice and a watchlist-header bell entry point | done | slice:notifications, slice:watchlist | scope:mobile |
| 43 | fix-media-type-hint-navigation | Fix: thread media-type hint through navigation to prevent wrong-title TMDB collision | done | slice:search, slice:watchlist, slice:title-detail | scope:mobile |
| 44 | fix-triggersync-cors | Add explicit CORS origins to the triggerSync Gen2 callable so browser-origin invocations are not preflight-blocked | done | — | scope:functions |
| 45 | android-display-cutout | Draw under the camera notch on Android (display-cutout mode) | done | — | scope:mobile |
| 46 | watchlist-sort-filter | Add sort, status filter, text search, and provider filter to the watchlist | done | slice:watchlist, slice:search | scope:mobile, scope:shared |
| 47 | sync-episodes | Sync TV episodes from TMDB into the per-user episodes subcollection | done | slice:sync-episodes | scope:functions, scope:shared |
| 48 | fix-triggersync-500 | Make the triggerSync callable surface diagnosable errors instead of an opaque INTERNAL 500 | done | — | scope:functions |
| 49 | sync-health | Surface the daily sync's last-run status in the settings slice (sync-runs) | done | slice:settings | scope:shared, scope:functions, scope:mobile |
| 50 | auto-status-progression | Auto-progress TV watchlist status between watching and completed in title-detail | done | slice:title-detail | scope:mobile |
| 51 | notification-quiet-hours | Add a notification delivery-hour preference (UTC) gating FCM sends | done | slice:settings, slice:dispatch-notifications | scope:shared, scope:mobile, scope:functions |
| 52 | title-detail-refresh | Add pull-to-refresh manual sync to the title-detail page (shared SyncStateService) | done | slice:title-detail, slice:watchlist | scope:mobile, scope:shared |
| 53 | completed-marks-episodes-watched | Mark all episodes watched when a TV show is manually set to Completed | done | slice:title-detail, slice:watchlist | scope:mobile |
| 54 | advanced-watchlist-filters | Restyle the watchlist filter/search controls to the Advanced Watchlist Stitch design | done | slice:watchlist | scope:mobile |
| 55 | android-cutout-runtime-theme | Instrument the Android running-window theme to diagnose the still-visible camera-cutout letterbox, then apply the data-indicated fix | done | — | scope:mobile |
| 56 | title-detail-mark-watched | Add a "Mark as Watched" action for untracked titles on the title-detail page | done | slice:title-detail | scope:mobile |
| 57 | leaving-platform-notifications | Notify when a tracked title loses flatrate availability in the user's region | approved | slice:dispatch-notifications, slice:notifications, slice:settings | scope:functions, scope:mobile, scope:shared |
| 58 | doc-integrity-guards | Deterministic documentation integrity: spec-status ledger + CI drift guards | done | — | — |
| 59 | audit-docs-skill | /audit-docs skill: LLM-judgment documentation drift audit | done | — | — |
| 60 | provider-preferences | Let users pick their subscribed providers and flag "on your platform" availability | done | slice:settings, slice:watchlist, slice:title-detail, slice:sync-titles | scope:mobile, scope:functions, scope:shared |
| 61 | plex-provider | Add Plex as a manual, per-title "I'm watching this via Plex" provider | done | slice:settings, slice:title-detail, slice:watchlist | scope:mobile, scope:shared |
| 62 | android-webview-cutout-background | Paint the Android WebView background behind the camera cutout via Capacitor's top-level backgroundColor config | done | — | scope:mobile |
| 63 | implement-feature-hardening | Harden the implement-feature workflow against observed friction (specs 0060/0062) | done | — | — |
| 64 | android-cutout-viewport-fit | Extend the WebView under the Android display cutout via viewport-fit=cover, with a dark window background fallback | done | — | scope:mobile |
| 65 | worktree-dependency-bootstrap | Bootstrap dependencies in the implement-feature worktree (fresh worktrees have no node_modules) | done | — | — |
| 66 | spec-numbering-integrity | Fix spec-number allocation (branch-based scan), repair the landed 0043/0046 collision, and guard against recurrence | done | — | — |
| 67 | ai-setup-instruction-corrections | Correct drifted/incorrect standing-instruction content in agents, PLAN.md, and CLAUDE.md | done | — | — |
| 68 | ai-setup-security-hardening | Harden the AI setup — narrow secret-copy allows, add deny rules, treat external text as untrusted, tighten CI | done | — | — |
| 69 | guard-hook-robustness | Harden the slice-edit guard hook — crash-safety, self-test, exemptions, and documented bypass | done | — | — |
| 70 | audit-docs-accuracy | Fix the audit-docs skill — stale "must-detect" example and the phantom scheduled runner | done | — | — |
| 71 | normative-text-dedup | De-duplicate copy-pasted normative rules (Stitch recipe, worktree snippet, design hexes, Windows E-notes) | done | — | — |
| 72 | plan-accuracy-refresh | Refresh docs/PLAN.md to eliminate accumulated drift against the shipped codebase | done | — | — |
| 73 | plex-sync | One-way Plex → Vultus sync (library additions + watch status) | done | slice:settings | scope:mobile, scope:shared |
| 74 | revert-completed-to-watching | Revert a Completed TV show to Watching when it has unwatched episodes again | done | slice:title-detail | scope:mobile, scope:functions |
| 75 | settings-provider-list-fixes | Fix "N of 0 selected" providers on Settings entry + make the provider list collapsible | done | slice:settings | scope:mobile |
| 76 | empty-state-centering | Center the empty/error state and stop the stray scroll on the Watchlist and Search pages | done | slice:watchlist, slice:search | scope:mobile |
| 77 | consolidate-plex-provider-entry | Exclude the real TMDB "Plex" provider from the Settings catalog so only the manual Plex chip shows | done | — | scope:functions |
| 78 | onboarding-full-settings | Expand onboarding into a multi-step wizard covering region, provider selection, notification settings, and Plex link | done | slice:onboarding | scope:mobile |
| 79 | fix-region-display-names | Display human-readable region names (endonyms) in Settings instead of raw ISO codes | done | slice:settings, slice:onboarding | scope:shared, scope:mobile |
| 80 | onboarding-settings-parity-rule | Add a standing Onboarding ↔ User-field parity rule (F4) to the spec-driven workflow | done | — | — |
| 81 | next-unwatched-episode-airdate | Track each TV show's next-unwatched-episode air date for watchability checks | done | slice:sync-episodes, slice:title-detail, slice:watchlist, slice:search | scope:shared, scope:functions, scope:mobile |
| 82 | fix-watchlist-scroll-overflow | Stop the empty Watchlist page scrolling — clip the off-screen filter sheet | done | slice:watchlist | scope:mobile |
| 83 | watch-today-tab | Add a Watch Today tab showing everything ready to watch right now | done | slice:today, slice:onboarding | scope:mobile |
| 85 | background-plex-sync | Background Plex sync (periodic on-device sync while backgrounded) | done | slice:settings | scope:mobile, scope:shared |
| 86 | fix-plex-sync-posters | Fix Plex sync — fetch and denormalize posterPath/voteAverage on add + backfill | done | slice:settings | scope:mobile |
| 87 | fix-watchlist-filter-sheet-clip | Fix the clipped Watchlist filter sheet — bind `open` on the panel/backdrop themselves | done | slice:watchlist | scope:mobile |
| 88 | no-notifications-for-completed | Suppress availability/episode notifications for completed or dropped watchlist items | done | slice:dispatch-notifications | scope:functions |
| 90 | plex-link-code-actions | Add copy-code + "Open plex.tv/link" actions to the Plex link-code stage (onboarding parity + both pages) | approved | slice:onboarding, slice:settings | scope:mobile |
| 91 | fix-watch-today-header | Shrink the Watch Today hero title/subtitle to match other pages' headings | approved | slice:today | scope:mobile |
