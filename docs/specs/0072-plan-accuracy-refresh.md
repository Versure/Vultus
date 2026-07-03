---
number: 0072
slug: plan-accuracy-refresh
title: Refresh docs/PLAN.md to eliminate accumulated drift against the shipped codebase
status: implementing # draft | approved | implementing | done
slices: [] # docs-only foundation work — touches no product slice
scopes: [] # docs-only — touches no scope tag
created: 2026-07-03
---

## 1. Context

`docs/PLAN.md` is the single source of truth for architecture and decisions
(CLAUDE.md, `docs/specs/README.md`). After 63 done specs (through 0064) the plan
has drifted from the shipped repo: some of its statements are now stale, some
contradict other sections of the same document, and it omits slices, collections,
and workflow files that exist on disk. A reader trusting PLAN.md today is misled
on multiple concrete points (e.g. it claims the project runs on the Spark plan at
the same time §7 admits Blaze; it claims manual refresh reuses the HTTP sync
function when the app actually calls a separate `triggerSync` callable).

A thorough 2026-07 multi-agent review of PLAN.md against the current repo found the
specific contradictions and omissions catalogued in §7 below. Every correction was
verified against concrete `file:line` / spec-number evidence in the repo, cited
inline so the implementer and reviewer can re-verify without re-investigating.

This is a **docs-only** spec. Its entire deliverable is surgical edits to a single
file, `docs/PLAN.md`. There is no code, no new tests, no slice work.

## 2. Scope

In scope:

- Corrective edits to `docs/PLAN.md` only, per the section-by-section list in §7.
- Resolving PLAN.md's internal contradictions (Spark vs Blaze; §3 line 131 "2+" vs
  line 187 "3+"; §2 manual-refresh row vs actual `triggerSync` callable).
- Checking `[x]` the demonstrably-shipped items in §10 and the §7 manual-prereq
  checklist per the checkbox rule below, with the two "within 24h push" criteria
  left caveated.
- Reframing the cost model from "Spark / €0" to "Blaze pay-as-you-go, engineered to
  stay within free-tier allowances, budget alert recommended."

Out of scope:

- **The `docs/specs/0046-*.md` frontmatter number collision.** That belongs with
  the already-drafted `0066-spec-numbering-integrity.md`; do not touch it here.
- **The 7 untracked draft specs (0065–0071).** Not this spec's concern.
- **Any code, test, or spec-ledger change.** Do not touch `STATUS.md`,
  `firestore.rules`, `documents.ts`, source, or any doc other than `PLAN.md`.
  Regenerating `STATUS.md` from this spec's frontmatter happens when the spec
  lands, per the workflow — it is not part of this spec's edits.
- **The already-correct design-token hexes (§2, PLAN lines 105-117) and the
  notification-kind enum (§4, PLAN line 225).** These were verified accurate and
  must be left unchanged — see Risks.

## 3. Affected slices & Sheriff tags

**None.** This is a docs-only change touching only `docs/PLAN.md`. No lib or app
changes, no Sheriff tags, no cross-slice imports, no shared-code extraction. The
`docs/` tree carries no scope/slice tag (consistent with spec 0058's `scopes: []`
for `tools/*` docs/tooling work).

## 4. Data model touchpoints

**None changed.** No Firestore collection, field, converter, security rule, or
index is added or modified. This spec only makes PLAN.md's §4 _describe existing,
already-shipped fields accurately_. The fields being newly documented (all verified
present in the code today) are, for the reviewer to confirm:

- `provider-catalog/{region}` global collection (spec 0060) — `providers`,
  `lastSyncedAt`; function-written, client read-only. Verified:
  `libs/shared/domain/src/lib/documents.ts:37-40` (`ProviderCatalogDoc`),
  `firestore.rules:72-75`, `libs/shared/firestore-schema/src/lib/converters.ts:178-194`.
  `CatalogProvider` shape (`providerId`, `name`, `logoPath`) at
  `libs/shared/domain/src/lib/entities.ts:15-18`.
- `users/{userId}.myProviderIds: number[]` (spec 0060) — `documents.ts:30-33`.
- `users/{userId}/watchlist/{titleId}` denormalized fields `posterPath?`,
  `voteAverage?` (spec 0035), `releaseDate?` (spec 0046) —
  `documents.ts:49-51`.
- `.../episodes/{episodeId}.title: string | null` (specs 0034/0047) —
  `documents.ts:58`.
- `title-cache/{tmdbId}.traktId: number | null` (spec 0008), top-level — NOT
  inside the `metadata { ... }` placeholder — `documents.ts:117`.
- `sync-runs/{runId}.runId` (== document ID, duplicated in data) —
  `documents.ts:85-86`.

## 5. Public types / APIs

**None.** No new or changed types, function signatures, endpoints, or callable
shapes.

## 6. UI / Stitch screen refs

**None.** No mobile UI, no Stitch screens. Docs-only change.

## 7. Implementation task graph

One `[sequential]` task; file manifest is exactly `docs/PLAN.md`. Sub-steps below
are for reviewer legibility only — they all edit the same single file.

### Task 1 — Edit `docs/PLAN.md` `[sequential]`

**File manifest:** `docs/PLAN.md` (only).

Apply every correction below. Each carries the PLAN line reference and the
verifying evidence. Preserve PLAN.md's structure, tone, and section numbering —
these are surgical corrections, not a rewrite. Do NOT hand-transcribe any hex or
invent facts; reproduce the cited values exactly.

**Checkbox rule (applies to §10 and the §7 manual-prereq checklist):** CHECK `[x]`
the demonstrably-shipped / repo-verifiable items; leave the two "within 24h push
notification" §10 criteria UNCHECKED with the inline note
`shipped; end-to-end prod delivery pending re-verification` (the first green
daily-sync run on 2026-06-24 processed 0 titles against an empty prod watchlist — a
known TODO). Purely external/unverifiable-from-repo §7 items may stay unchecked or
carry a note.

#### 7.1 — §1 Product scope (PLAN lines 14-36) and §10 (lines 522-533)

- **§1 lines 23-24** ("Track watch progress … Treated as v1.1 — built last, after
  the notification pipeline is working end-to-end."): reword to past tense — watch
  progress SHIPPED (specs 0034 episode-watch-progress, 0050 auto-status-progression,
  0053 completed-marks-episodes-watched, 0056 title-detail-mark-watched, all done).
  Drop the "v1.1, built last" sequencing — 0034 landed before 0047 (which completes
  the episode pipeline), so the claimed ordering is wrong.
- **§1 line 25** (manual "refresh now, rate-limited to once per 5 minutes"):
  annotate that the 5-minute limit on the APP path is **client-side only**
  (`SYNC_COOLDOWN_MS = 300_000` at
  `libs/shared/ui-kit/src/lib/sync-state.service.ts:9`, on the `triggerSync`
  callable path). Server-side rate limiting (`RATE_LIMIT_MS` at
  `apps/functions/src/main.ts:85`) exists only on the HTTP `syncTitles` user path,
  which the app does not use. This was a deliberate decision (spec 0025 non-goal).
- **§1** add a short note: §1 records the ORIGINAL v1 planning scope; the spec
  ledger (`docs/specs/STATUS.md`) is the live scope record. The shipped product now
  exceeds the original 5-item list (onboarding 0022, notifications inbox 0042,
  quiet hours 0051, sync health 0049, provider preferences 0060, watchlist
  sort/filter 0046/0054) without violating the out-of-scope list.
- **§10** apply the checkbox rule. Demonstrably-shipped criteria to check `[x]`:
  - APK installs (specs 0020 + 0026; `android/` exists on disk).
  - Search + add (spec 0013).
  - NL provider visibility (specs 0014/0016).
  - Manual refresh works (spec 0025 + fixes 0033/0044/0048).
  - All CI gates green on `main` (verified 2026-07-02).
    Leave the two "within 24h push" criteria (lines ~527-530) UNCHECKED with the
    caveat note above.
- **§10 line 533** ("€0/month bill"): reframe per the cost-model decision in 7.6.

#### 7.2 — §2 Architecture decisions (PLAN lines 39-123)

- **Decisions table line 51** ("Daily sync trigger | GitHub Actions cron → HTTP
  Cloud Function | Stays on Spark plan, no credit card") and **line 56** ("Hosting
  cost | €0/month | Firebase Spark + GitHub Actions free tier + TMDB/Trakt free
  tier"): reconcile with the Blaze reality. The project moved to Blaze to deploy
  gen2 Cloud Functions. Keep the €0-**target** framing but correct the plan tier to
  **Blaze-within-free-tier**. This is currently an internal contradiction: §7
  (PLAN lines 456-478) already admits Blaze. See 7.6 for the exact reframing.
- **Decisions table line 52** ("Manual refresh | App calls same HTTP Cloud Function
  (rate-limited) | Single code path for sync logic"): STALE. The app calls a
  SEPARATE `triggerSync` Gen2 **callable** (specs 0025; 0044 CORS; 0048 error
  surfacing), not the shared-secret HTTP `syncTitles` function. Correct the row to
  describe the separate callable path (and drop the "single code path" rationale,
  which is no longer true).
- **Decisions table line 54 / "Data source reliability" (lines 72-86)**: Trakt is
  listed as a co-equal data source ("+ Trakt (calendar)"), but in the production
  sync engine Trakt is used ONLY to resolve `traktId`
  (`libs/functions/sync-titles/src/lib/engine/sync-engine.ts:44`,
  `trakt.getShowTraktId`, tv only). Episode airing data comes from TMDB (spec 0047
  sync-episodes). `getCalendar` on the Trakt client has **no production caller** —
  only tests and the client definition reference it (grep for `getCalendar`:
  hits in `trakt-client.ts`, `trakt-client.spec.ts`, `sync-engine.spec.ts`,
  `README.md` only; no non-test production call site). Clarify Trakt's actual
  narrowed role (traktId resolution, tv only) rather than "calendar". The
  Watchmode-as-unused-fallback framing (line 84, "If accuracy turns out to be
  poor") is still accurate — leave it.
- **§2 design token table (lines 105-117)**: VERIFIED ACCURATE against
  `libs/shared/ui-kit/src/lib/theme.scss` — do **NOT** change any hex. (Called out
  here so the implementer does not "fix" already-correct values.)

#### 7.3 — §3 Nx workspace structure (PLAN lines 127-193)

- **Tree diagram root (line 135)**: `movie-tracker/` → `vultus/` (repo is Vultus;
  `package.json` name is `@vultus/source`).
- **Tree — add three shipped slice libs missing from the diagram** (all dirs exist
  on disk): `libs/mobile/onboarding/` (spec 0022), `libs/mobile/notifications/`
  (spec 0042), `libs/functions/sync-episodes/` (spec 0047).
- **Tree — add the real load-bearing top-level dirs the diagram omits**:
  `apps/mobile-e2e/` (Playwright, spec 0019); `android/` (Capacitor platform, spec
  0020); `tools/` (doc-integrity-test, firestore-rules-test, scripts,
  sheriff-fixtures / -test); `docs/design/` (`vultus-design-system.md` — the
  authoritative token set); `docs/setup/`; `.claude/` (agents/hooks/skills/settings
  driving the §5 workflow). Add root files `capacitor.config.ts` and
  `pnpm-workspace.yaml` (both exist at repo root).
- **apps/mobile annotation (line 137)** ("# Ionic shell, routing, app module"): the
  app is STANDALONE Angular 21 (bootstrap via
  `apps/mobile/src/app/app.config.ts` + `app.routes.ts`, no NgModule). Change
  "app module" → "app config (standalone)".
- **Line 131 vs line 187 CONTRADICTION**: line 131 says extract to `shared/` "only
  when 2+ slices need them"; line 187 (and CLAUDE.md) say **3+ slices**. Fix line
  131 to "3+" to match.
- **Sheriff slice-tag list (lines 173-174)**: enumerates only 6 slice tags, but the
  config assigns tags by path glob (`sheriff.config.ts:56-57`), so
  `slice:onboarding`, `slice:notifications`, `slice:sync-episodes` are also enforced
  for the libs that exist. Either extend the list to all 9 slices (watchlist,
  search, title-detail, settings, onboarding, notifications, sync-titles,
  dispatch-notifications, sync-episodes) or state that tags are glob-derived (one
  `slice:<name>` per `libs/{mobile,functions}/<slice>`). Also **line 168** calls
  them "type tags" while the actual prefix is `slice:` — align the wording (they
  are slice tags).
- **Sheriff rules (lines 176-182)**: lists 4 rules, but `sheriff.config.ts` enforces
  a real 5th constraint the plan omits: **`scope:shared` may ONLY import
  `scope:shared`** (`sheriff.config.ts:81`,
  `'scope:shared': 'scope:shared'`). Add it as rule 5. (Optionally mention the
  `root`/`noTag` escape hatch at `sheriff.config.ts:67-68` as a config detail.)

#### 7.4 — §4 Data model (PLAN lines 196-248)

All field additions VERIFIED in `libs/shared/domain/src/lib/documents.ts` (see §4
of this spec for exact line refs). Add to the PLAN §4 code block:

- Global collection `provider-catalog/{region}` (spec 0060):
  `providers: [{ providerId, name, logoPath }]`, `lastSyncedAt`. Function-written,
  client read-only (`documents.ts:37-40`; `firestore.rules:66-75`;
  `converters.ts:178-194`; `CatalogProvider` at `entities.ts:15-18`).
- `users/{userId}`: add `myProviderIds: number[]` (TMDB provider ids the user
  subscribes to; default `[]`; spec 0060) — `documents.ts:30-33`.
- `users/{userId}/watchlist/{titleId}`: add denormalized `posterPath?: string | null`,
  `voteAverage?: number | null` (spec 0035), `releaseDate?: string | null`
  (spec 0046) — `documents.ts:49-51`. (Provenance note: the sort/filter spec's
  filename is `0046-watchlist-sort-filter.md` but its frontmatter declares
  `number: 0043` — the known collision this spec defers to 0066. The `releaseDate`
  field is present regardless; cite it by filename number 0046.)
- `.../episodes/{episodeId}`: add `title: string | null` (episode name; specs
  0034/0047) — `documents.ts:58`.
- `title-cache/{tmdbId}`: add **top-level** `traktId: number | null` (Trakt show id,
  tv only; spec 0008) — `documents.ts:117`. It is top-level, NOT inside the
  `metadata { ... }` placeholder.
- `sync-runs/{runId}` (line 242): add `runId` (== document ID, duplicated in the
  data) to the field list — `documents.ts:85-86`. (Minor.)
- The `notificationPrefs { ... }` placeholder (line 205) legitimately absorbs spec
  0051's `deliveryHour` (`documents.ts:23`) — **no change needed there**; note it's
  fine.
- The notification `kind` enum
  `"episode-aired" | "movie-available" | "show-came-to-platform"` (line 225) is
  VERIFIED accurate (`libs/shared/domain/src/lib/enums.ts:27-32`) — do **NOT**
  change it. (Specs 0057/0061 that would touch it are still only approved.)

#### 7.5 — §5 The agentic workflow (PLAN lines 250-356)

- **Command list (lines 268-269)** mentions raw `nx serve` — STALE. Serving is via
  the five named scenario targets (`mobile:serve-mock` / `serve-emulator` /
  `serve-prod-debug` / `serve-prod` / `android-usb`) since spec 0038; raw
  `pnpm nx serve` is owned by the e2e web server. Correct to match CLAUDE.md.
- **Lines 312-313** ("After merge, GitHub Action deploys (when we add deploy
  workflows)"): the deploy workflow EXISTS now —
  `.github/workflows/deploy-functions.yml`. Update the parenthetical.
- **Test pyramid line 336** ("e2e tests (5–10, named)"): there are now 12 e2e spec
  files in `apps/mobile-e2e/src` (`app.boot`, `app.smoke`, `manual-sync-trigger`,
  `mark-watched`, `notification-deep-links`, `notifications`, `onboarding`,
  `provider-preferences`, `search`, `settings`, `title-detail`,
  `watchlist-refresh`). Update the count (e.g. "critical flows, currently 12").
- **Secrets table (lines 341-346)**: the TMDB row's `pnpm env:tmdb` script still
  exists (`package.json` `scripts["env:tmdb"] = "node scripts/env-tmdb.mjs"`) —
  verified accurate; no change needed unless something else in the table is wrong.

#### 7.6 — Cost model reframing (touches §2 lines 51/56 and §10 line 533)

Reframe from "Spark / €0" to: the project runs on the **Blaze** pay-as-you-go plan
(required to deploy Cloud Functions), engineered to stay within free-tier
allowances, with a **budget alert** recommended. This matches
`docs/setup/firebase-and-secrets.md:41-61` (which states Cloud Functions
deployment requires Blaze; Blaze still bills €0 under personal usage; set a budget
_alert_, not a hard cap). Keep the €0-target framing intact.

#### 7.7 — §7 Manual prerequisites (PLAN lines 437-491)

- Apply the checkbox rule. Items verifiable-done from committed repo evidence get
  `[x]`:
  - Firebase project `vultus-cab62` exists (MEMORY: firebase-project-setup; Blaze,
    provisioned 2026-06-18).
  - `google-services.json` committed at `android/app/` (spec-0026 flow; the file is
    present in the repo).
  - TMDB key wired in CI (`TMDB_API_KEY` GitHub Actions secret; PLAN §5 secrets
    table).
  - `VULTUS_SYNC_URL` + `SYNC_SHARED_SECRET` referenced by
    `.github/workflows/daily-sync.yml`.
  - Public invoker granted per spec 0021 (MEMORY: syncTitles-public-invoker,
    applied + verified 2026-06-24).
    Purely external / unverifiable-from-repo items (e.g. "Install Claude Code
    locally", "Install Node/Android Studio/Firebase CLI") may stay unchecked or carry
    a short note.
- **Line 490-491** ("Add a credit card test: confirm you do _not_ want to enable
  Blaze. Spark plan + GitHub Actions cron is the chosen path."): this contradicts
  the shipped reality (Blaze is enabled and Cloud Functions are deployed). Correct
  it to reflect the chosen Blaze-with-budget-alert path, consistent with 7.6 and
  `docs/setup/firebase-and-secrets.md:41-61`.

#### 7.8 — §8 Open questions (PLAN lines 495-504)

- The "Watch progress as v1.1 vs v2: build after notifications" question (lines
  503-504) is ANSWERED — it is built (specs 0034/0050/0053/0056). Remove it or mark
  it resolved. iOS (line 500), multi-user (lines 501-502), and Watchmode/NL accuracy
  (lines 497-499) remain genuinely open — keep those.

#### 7.9 — §9 Risk register (PLAN lines 508-518) — mitigations that do NOT exist

- **Line 518** ("Agent commits secrets | `.env.local` gitignored; CLAUDE.md rule;
  pre-commit hook with `gitleaks`"): gitleaks is NOT configured. The pre-commit hook
  (`.husky/pre-commit` → `pnpm exec lint-staged`) runs ESLint `--fix` + Prettier +
  `gen-spec-status --check` only. Correct the mitigation to describe the actual
  hook; if gitleaks is worth keeping, list it as recommended-but-unimplemented — do
  NOT claim it runs.
- **Line 516** ("Sheriff/Nx version mismatch … Pin versions; renovate updates via
  PR"): Renovate is NOT configured (no `renovate.json` in the repo outside
  `node_modules`). Correct or drop the Renovate claim (keep "pin versions").
- **Line 515** ("Background daily sync fails silently … Cloud Function logs to
  Firebase Logging; weekly sanity-check issue"): there are NO GitHub issues in this
  workflow. The real shipped mitigation is spec 0049 (sync-health surfaces last-run
  status in the settings slice, reading `sync-runs`) plus the `deploy-functions`
  smoke gate. Update the mitigation.

#### 7.10 — §6 Initial task breakdown (PLAN lines 359-433) — minor

- **Intro (lines 362-363)** claims "all 23 items below have since shipped as
  specs" but item 7 (`CLAUDE.md`, authored in the pre-spec bootstrap commit
  `f2b01cf`, not a spec) and item 8 (`~~Issue + PR templates~~`, superseded, struck
  through) did NOT ship as specs. Soften to "all remaining items" or explicitly
  except items 7 and 8 (21/23 map cleanly).

## 8. Test plan

No new tests. Per the PLAN §5 pyramid this is a docs-only change, so:

- **Unit / component / e2e:** none added or changed. **No e2e flows required —
  documentation change only.**
- **Doc-integrity guards (must not regress):** `node tools/scripts/gen-spec-status.mjs --check`
  (spec 0058) must still pass. Note the lint-staged hook gates this check on staged
  `docs/specs/*.md` files, so it does NOT actively fire on a `docs/PLAN.md`-only edit
  commit — **Prettier over the changed file is the guard that validates this commit**
  (`lint-staged.config.mjs` runs Prettier on `**/*.md`). The ledger regen happens when
  the spec file itself lands, per the workflow. The implementer must not stage a
  `STATUS.md` change.
- **Lint / format:** `pnpm nx lint` and Prettier must pass over the changed file.
  Because Edit/Write can emit CRLF on Windows and this repo enforces
  `endOfLine: lf`, run `pnpm exec prettier --write docs/PLAN.md` before staging.
- **Rendered-text assertions:** N/A (no UI, no rendered copy).
- Note: `/audit-docs` (spec 0059) should have less to flag after this lands.

## 9. Definition of done

- [ ] `docs/PLAN.md` edited per every sub-step in §7 (7.1–7.10).
- [ ] All of PLAN.md's internal contradictions resolved (Spark vs Blaze §2⇄§7;
      §3 line 131 "2+" vs line 187 "3+"; §2 manual-refresh row vs the `triggerSync`
      callable).
- [ ] §10 and §7 checkboxes applied per the checkbox rule; the two "within 24h
      push" §10 criteria left UNCHECKED with the caveat note.
- [ ] The already-correct §2 design-token hexes and §4 notification-kind enum are
      UNCHANGED.
- [ ] Section numbering and structure preserved (CLAUDE.md and the skills reference
      PLAN section numbers).
- [ ] `docs/PLAN.md` is Prettier-clean with LF line endings
      (`pnpm exec prettier --write docs/PLAN.md` run before staging).
- [ ] `node tools/scripts/gen-spec-status.mjs --check` passes; no `STATUS.md` change
      staged.
- [ ] `pnpm nx lint` passes.
- [ ] **No file other than `docs/PLAN.md` is touched.**

## 10. Risks

- **PLAN.md is heavily cross-referenced** by CLAUDE.md and the `.claude/` skills via
  section number (e.g. "PLAN §3", "PLAN §5"). Keep section numbers and headings
  stable so those references do not break. Do not renumber or reorder sections.
- **Risk of "fixing" already-correct content.** The §2 design-token hexes
  (`theme.scss`-verified, PLAN lines 105-117) and the §4 notification-kind enum
  (`enums.ts:27-32`-verified, PLAN line 225) are correct and are explicitly
  do-not-touch. An agent's instinct to normalize/"improve" them would introduce
  drift, not remove it.
- **CRLF trap (Windows).** Edit/Write can emit CRLF; the repo enforces
  `endOfLine: lf`. Failing to run Prettier on the changed file before staging will
  fail the pre-commit hook / `prettier --check`.
- **No PLAN conflict with the requested edits** — every correction aligns PLAN.md
  _toward_ the shipped code and its already-authoritative §7 Blaze notes, resolving
  contradictions rather than creating them.
