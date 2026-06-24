---
number: 0017
slug: daily-sync-cron
title: Add the daily-sync GitHub Actions cron that triggers the syncTitles function
status: done
slices: []
scopes: [scope:functions]
created: 2026-06-23
---

# Add the daily-sync GitHub Actions cron that triggers the syncTitles function

## Context

PLAN §6 item 13 — the **Daily-sync GitHub Action**: "Cron schedule, calls HTTP
function with secret." Spec 0009 delivered the `syncTitles` HTTPS `onRequest`
function (now merged on `main`) and **explicitly deferred this cron to a separate
spec, naming this file** (`.github/workflows/daily-sync.yml`). This spec delivers
exactly that workflow and nothing else.

The user need: `title-cache` must refresh **automatically** once a day so
streaming-availability changes are detected without anyone opening the app, and
so the notification dispatcher (spec 0012, already built) fires in production —
it is triggered by the `title-cache/*/availability/*` writes that a sync pass
makes. PLAN §2 architecture row: "Daily refresh | GitHub Actions cron → HTTP
Cloud Function". This is the cron leg of that row.

Intended outcome: a scheduled GitHub Actions workflow POSTs to the deployed
`syncTitles` endpoint once a day with the shared-secret header and a forced
refresh, the job fails (emailing the repo owner) on any non-success, and the
`SyncRunResponse` counts are logged for observability.

This is **pure infrastructure** — a single GitHub Actions workflow YAML plus
documentation of the required GitHub variable/secret. It does **not** modify
`syncTitles` or any function code, and it does **not** deploy the function or
provision the function-side secret (both manual, PLAN §7 — out of scope).

## Scope

In scope:

- **A new scheduled workflow** `.github/workflows/daily-sync.yml` that, on a daily
  cron **and** on manual `workflow_dispatch`, POSTs to the deployed `syncTitles`
  endpoint with the `X-Vultus-Sync-Secret` header and a `{"force": true}` body,
  fails the job on any non-2xx response, retries transient/5xx failures, and logs
  the `SyncRunResponse` counts.
- **Documentation of the required GitHub config**: a repo Actions **variable**
  `VULTUS_SYNC_URL` (the public endpoint URL) and a repo Actions **secret**
  `SYNC_SHARED_SECRET` (the shared secret), documented as manual prerequisites in
  the root `README.md` and `docs/PLAN.md` §7, mirroring spec 0015's convention.
  The doc must state that the **same** `SYNC_SHARED_SECRET` value must also be
  provisioned on the Cloud Function side (PLAN §7) for the header to match — this
  spec provisions neither.

Out of scope (each stated explicitly):

- **Modifying `syncTitles` or any function code** (spec 0009, merged). This spec
  only *calls* the endpoint; the function's contract is fixed input here.
- **Deploying the function / provisioning the function-side `SYNC_SHARED_SECRET`
  param** — manual (PLAN §7, specs README "Scope & limitations: deployment is a
  manual/separate step"). The cron is inert until the function is deployed and
  both sides of the secret are provisioned; that wiring is a human step.
- **The mobile "refresh now" path** (PLAN §6 item 18, `slice:watchlist`) — the
  user/ID-token leg of the same endpoint; a separate spec.
- **Notification dispatch internals** (spec 0012, already built). This cron only
  triggers the `title-cache` writes that fan notifications out; it asserts nothing
  about dispatch behaviour.
- **Any Sheriff-governed workspace code** — see next section.

## Affected slices & Sheriff tags

**None.** This spec touches only `.github/workflows/daily-sync.yml` (a CI workflow
file) and documentation (`README.md`, `docs/PLAN.md`). Sheriff governs **workspace
import boundaries between projects** — it does not police workflow YAML or
markdown. There is **no slice, no library, no app, and no `sheriff.config.ts`
change**. `slices: []`; `scopes: [scope:functions]` is **descriptive only** (this
is the cron leg of the `scope:functions` sync backend) and drives no Sheriff rule.

No workspace import boundaries are introduced or crossed; there is no DRY/3+-slice
extraction question because no TypeScript is added.

## Data model touchpoints

**None directly.** This workflow makes a single HTTP request and reads no
Firestore. *Transitively*, the `syncTitles` function it invokes reads
`collectionGroup('watchlist')` and writes `title-cache/{tmdbId}` +
`title-cache/{tmdbId}/availability/{region}` and `system/sync` (all per spec
0009 §"Data model touchpoints"). This spec changes **no** Firestore collection,
field, converter, index, or security rule — it adds no `firestore.rules` or
`firestore.indexes.json` change.

## Public types / APIs

No new or changed types, function signatures, or workspace APIs. This spec is a
**consumer** of the already-shipped `syncTitles` HTTP contract (spec 0009). The
request it sends and the response it expects (the fixed input to this work):

**Request** (built by the workflow):

- Method: `POST` (the only method `syncTitles` accepts; anything else → 405).
- URL: `${{ vars.VULTUS_SYNC_URL }}` — the deployed gen2 `onRequest` endpoint in
  region `europe-west1`, project `vultus-cab62`. A **public** endpoint, so it
  lives in a repo **variable**, not a secret.
- Headers:
  - `X-Vultus-Sync-Secret: ${{ secrets.SYNC_SHARED_SECRET }}` — the privileged
    cron credential. Constant-time compared by the function against its
    `SYNC_SHARED_SECRET` param. Missing → 401; present-but-wrong → 403.
  - `Content-Type: application/json`.
  - (Header order is immaterial — HTTP does not order headers — so a reviewer
    should not flag the `curl` listing the secret header before `Content-Type`.)
- Body: `{"force": true}` — the cron is the privileged path, which **honors
  `force`**, bypassing the ~20h staleness window for a deterministic full daily
  refresh (locked decision 2). (The user/ID-token path ignores `force`; that path
  is out of scope here.)

**Expected response**: `200` with `SyncRunResponse`
`{ ok, trigger: 'cron', gathered, synced, skipped, errored, forced: true,
durationMs }` (the shape is owned by spec 0009; reproduced here only as the
consumer's expectation). The workflow treats **any non-2xx** as failure. The
function never leaks secrets/tokens in this body, and the workflow must never
print the request header (see decision 4).

## UI / Stitch screen refs

Not applicable. This is CI/infrastructure work (a scheduled workflow + docs).
There is no mobile slice, no screen, no design token.

## Implementation task graph

Two tasks. Both are `scope:functions`-adjacent infrastructure; neither touches a
Sheriff slice. They write **disjoint** files, so they *could* run in parallel, but
the second is documentation describing the names introduced/used by the first;
keep them **[sequential]** so the doc reflects the exact variable/secret names and
header the workflow uses. This is **infrastructure-engineer** territory.

1. **[sequential] Create the daily-sync workflow** —
   `.github/workflows/daily-sync.yml`.
   - `name: Daily sync`.
   - Triggers: both
     ```yaml
     on:
       schedule:
         - cron: '0 4 * * *'
       workflow_dispatch:
     ```
     `0 4 * * *` = daily 04:00 **UTC**. GitHub cron is UTC with **no DST
     adjustment**, so this lands ~05:00 (winter) / ~06:00 (summer) NL — chosen so
     a NL-overnight provider refresh surfaces notifications in the morning
     (decision 1). Add a YAML comment recording this UTC/DST note.
   - `permissions: contents: read` (least privilege; the job needs no write
     scope), matching the `ci.yml` convention.
   - A single job (e.g. `sync`) on `runs-on: ubuntu-latest` with a sane cap —
     `timeout-minutes: 10` at the job level and `timeout-minutes: 5` on the POST
     step (the function itself can run long, but the workflow only awaits the HTTP
     response; 5 min is generous headroom and bounds a hung request).
   - The job needs **no** repo checkout, Node, or pnpm — it is a single `curl`
     call. Do **not** add `actions/checkout`/`pnpm`/Node steps (unlike `ci.yml`);
     keep it minimal.
   - Read config from `${{ vars.VULTUS_SYNC_URL }}` and
     `${{ secrets.SYNC_SHARED_SECRET }}`. Pass the secret into the step via `env:`
     (so it is masked) and reference it as a shell variable — never interpolate it
     directly into the logged command line.
   - **Pinned implementation** (decision 4): a single `curl` invocation that
     retries transient/5xx, fails the step on any non-2xx, and prints the response
     body (the `SyncRunResponse` counts) without printing the secret. The `run:`
     step uses the **default `bash` shell on `ubuntu-latest`** (so the POSIX
     `[ -z … ]` guard and `exit 1` below are correct as written — the repo's
     PowerShell-first convention does **not** apply inside Linux Actions runners).
     Use exactly:
     ```yaml
     - name: Trigger daily sync
       timeout-minutes: 5
       env:
         SYNC_URL: ${{ vars.VULTUS_SYNC_URL }}
         SYNC_SECRET: ${{ secrets.SYNC_SHARED_SECRET }}
       run: |
         if [ -z "$SYNC_URL" ] || [ -z "$SYNC_SECRET" ]; then
           echo "::error::VULTUS_SYNC_URL variable and SYNC_SHARED_SECRET secret must be configured."
           exit 1
         fi
         curl --silent --show-error --fail-with-body \
           --retry 3 --retry-all-errors --retry-delay 5 \
           --max-time 240 \
           -X POST "$SYNC_URL" \
           -H "X-Vultus-Sync-Secret: $SYNC_SECRET" \
           -H "Content-Type: application/json" \
           -d '{"force": true}'
     ```
     Rationale for the flags, each load-bearing:
     - `--fail-with-body` makes a 4xx/5xx response exit non-zero **and** still
       print the response body — so the step (and job) fails on any non-2xx, GitHub
       sends its default failed-workflow email, and the body is captured for
       diagnosis. (`--fail-with-body` requires curl ≥ 7.76; `ubuntu-latest` ships a
       newer curl — acceptable.)
     - `--retry 3 --retry-all-errors --retry-delay 5` retries transient and 5xx
       failures a small number of times with a backoff before giving up (decision
       4's retry requirement).
     - `--silent --show-error` suppress the progress meter but keep error text.
     - `--max-time 240` bounds the request below the step timeout.
     - The successful response body is printed by `curl` to stdout on the `200`
       path, satisfying "log the SyncRunResponse counts" — no separate echo of the
       header/secret is needed (and must not be added).
   - **Secret hygiene (review-checked):** the secret is passed via `env:` only,
     never echoed, never placed on the visible command line, never written to a
     file. GitHub masks registered secrets in logs, but the workflow must not
     defeat that by printing the header.
   - Files: `.github/workflows/daily-sync.yml`.

2. **[sequential] Document the required GitHub variable + secret** (depends on
   task 1's chosen names). Mirror spec 0015's documentation convention.
   - In the root `README.md`: add a short **"CI / scheduled sync configuration"**
     subsection documenting that the daily-sync workflow requires a repo Actions
     **variable** `VULTUS_SYNC_URL` (the deployed `syncTitles` endpoint URL, a
     public value) and a repo Actions **secret** `SYNC_SHARED_SECRET` (the shared
     secret sent in `X-Vultus-Sync-Secret`), and that the **same**
     `SYNC_SHARED_SECRET` value must be provisioned on the Cloud Function side for
     the header to match. Note the workflow can be triggered manually via
     `workflow_dispatch` for a dry-run.
   - In `docs/PLAN.md` §7 (Manual prerequisites): add checklist items for
     configuring the `VULTUS_SYNC_URL` GitHub variable and the `SYNC_SHARED_SECRET`
     GitHub secret, and for setting the matching `SYNC_SHARED_SECRET` function
     param (cross-referencing PLAN §5's secrets table row "Sync HTTP function
     shared secret | GitHub secret + Firebase functions config"). Do **not** edit
     PLAN §5's secrets table itself (it already lists this secret) and do **not**
     change the Spark-vs-Blaze line in §7 (out of scope; the function is already
     deployed per project setup). Because the new §7 items sit adjacent to that
     now-stale Spark bullet, add a brief parenthetical to the **new** items noting
     the project runs on **Blaze** (per project setup) so a human reading the new
     prerequisites is not misled by the neighbouring stale line — without rewording
     the existing Spark bullet itself.
   - Do **not** write any real secret or URL value into these docs — names and
     instructions only (CLAUDE.md secrets rule).
   - Files: `README.md`, `docs/PLAN.md`.

(No new dependency is added — `curl` is preinstalled on `ubuntu-latest`. No
workspace project, lib, or `project.json` is touched, so no lib-README update
applies.)

## Test plan

There is **no unit-testable code** here — the deliverable is a workflow YAML and
docs, with no logic in a workspace project. Per the PLAN §5 pyramid this means no
unit / component / e2e tests are added or applicable. **CI itself will not exercise
this workflow** — `daily-sync.yml` runs only on `schedule` and `workflow_dispatch`,
never on `pull_request`/`push`, so the `ci.yml` gates do not invoke it. The DoD
therefore rests on static validity, a manual dry-run, and review checks:

- **YAML / workflow validity (degrade gracefully).** If `actionlint` is available,
  run it against `.github/workflows/daily-sync.yml` and it must pass; if it is not
  installed, fall back to a YAML parse/lint check and record that `actionlint` was
  unavailable (per CLAUDE.md / skills tooling-absent rule — do not block on a
  missing optional tool). Confirm the file parses and the `on`/`jobs`/`steps`
  structure is well-formed.
- **Manual `workflow_dispatch` dry-run (human-verified).** The real verification
  is triggering the workflow manually (Actions → Daily sync → Run workflow) against
  the **deployed** function with the GitHub variable/secret configured, and
  confirming: the job succeeds, the logged `SyncRunResponse` shows
  `trigger: 'cron'`, `forced: true`, and sane counts, and **the secret does not
  appear in the logs**. The implementing agent **cannot** run this in-session — it
  requires the live deployed function plus the provisioned function-side secret —
  so it is **flagged as a human/post-merge verification**, not an in-session gate.
- **Review checks.** A reviewer confirms: (a) the secret is passed via `env:` and
  **never echoed/logged** or placed on the visible command line; (b) any non-2xx
  fails the job (`--fail-with-body`) so the failed-workflow email fires; (c) retry
  on transient/5xx is present; (d) the cron is `0 4 * * *` with the UTC/DST note;
  (e) the body is `{"force": true}`; (f) the required `VULTUS_SYNC_URL` variable and
  `SYNC_SHARED_SECRET` secret (and the matching function-side secret) are documented.

## Definition of done

Tailored from the PLAN §5 checklist to an infra-only change (no workspace project
is touched, so there are no `nx` typecheck/lint/test/build targets to run for this
spec; the affected set is empty). Gates that don't apply are marked N/A with the
reason.

- [ ] `.github/workflows/daily-sync.yml` exists with: both `schedule`
      (`cron: '0 4 * * *'`) and `workflow_dispatch` triggers; `permissions:
      contents: read`; a single `curl` POST to `${{ vars.VULTUS_SYNC_URL }}` with
      the `X-Vultus-Sync-Secret` header from `${{ secrets.SYNC_SHARED_SECRET }}`
      (via `env:`), `Content-Type: application/json`, and body `{"force": true}`;
      `--fail-with-body` + retry flags; and job/step timeouts.
- [ ] The workflow is **valid** — `actionlint` passes if available; otherwise a
      YAML lint/parse check passes and the PR notes `actionlint` was unavailable.
- [ ] The UTC/DST behaviour of the fixed `0 4 * * *` cron is recorded as a YAML
      comment in the workflow.
- [ ] The secret is **never echoed or logged** and never appears on the visible
      command line (review-checked); it is referenced only via the step `env:`.
- [ ] Any non-2xx response **fails the job** (so GitHub's failed-workflow email
      fires), transient/5xx failures are retried, and the success-path response
      body (`SyncRunResponse` counts) is logged.
- [ ] The required repo Actions **variable** `VULTUS_SYNC_URL` and **secret**
      `SYNC_SHARED_SECRET`, plus the matching function-side `SYNC_SHARED_SECRET`
      param, are documented in `README.md` and `docs/PLAN.md` §7 (mirroring spec
      0015). No real value committed.
- [ ] Lint/Sheriff/typecheck/unit/component/build/e2e: **N/A** — no workspace
      project, code, or boundary is changed; `nx affected` is empty for this spec.
      (The PR description states this explicitly.)
- [ ] **Manual `workflow_dispatch` dry-run is flagged for human verification**
      post-merge (live deployed function + provisioned secret required; the agent
      cannot run it in-session). The PR description records this as the real
      functional verification and that the agent did not run it.
- [ ] PR description records that CI does **not** exercise this workflow (it runs
      only on schedule/dispatch), what static checks ran, and the secret-hygiene
      and non-2xx-fails-job review confirmations.

## Risks

- **GitHub cron is delayed/skipped under load.** GitHub documents that scheduled
  workflows can be delayed during periods of high load and are not guaranteed to
  fire at the exact minute. Acceptable for a personal v1. A missed daily run
  **self-heals on the next run**: because the cron sends `{"force": true}`, the
  next successful run refreshes the entire tracked-title union regardless of
  staleness, so no state is permanently lost — at worst a day's notifications are
  late.
- **The function must actually be deployed for the cron to do anything.** Deploy is
  manual and out of scope (PLAN §7). Until `syncTitles` is deployed at
  `VULTUS_SYNC_URL`, the workflow will fail (connection error / 404) — which is the
  desired loud failure (email), not silent no-op. Documented as a prerequisite.
- **Misconfigured/missing secret or URL → the job fails (401/403/error).** If
  `SYNC_SHARED_SECRET` is unset or doesn't match the function-side param the
  function returns 401/403 and the job fails; if `VULTUS_SYNC_URL` is unset the
  guard exits 1 with a clear error. This is intentional fail-loud behaviour, and
  the required config is documented (README + PLAN §7). The two `SYNC_SHARED_SECRET`
  values (GitHub side and function side) must be **kept in sync manually**;
  rotating one without the other breaks the cron until both are updated.
- **DST drift on a fixed UTC time.** `0 4 * * *` does not shift with NL daylight
  saving, so the local trigger time moves ~1h between winter and summer. Accepted
  by decision 1 (the goal is "overnight in NL", which a fixed early-UTC time
  satisfies in both seasons); not worth the complexity of a DST-aware schedule for
  v1.
- **No PLAN conflict.** PLAN §6 item 13 specifies exactly this (cron schedule calls
  the HTTP function with the secret). One stale detail: PLAN §7 still references the
  Spark plan + cron path, but project setup has since moved to Blaze with the
  function deployed — this spec does not depend on or change that line (it is left
  as-is; only the new GitHub variable/secret prerequisites are added to §7).
- **`curl --fail-with-body` curl-version dependency.** Requires curl ≥ 7.76;
  `ubuntu-latest` ships a far newer curl, so this is not a practical risk, but it is
  noted in case the runner image is ever pinned older.
