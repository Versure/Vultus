---
number: 0021
slug: daily-sync-public-invoker
title: Fix the failing daily-sync cron — make syncTitles publicly invokable and add deploy + runtime regression checks
status: approved
slices: []
scopes: [scope:functions]
created: 2026-06-24
---

# Fix the failing daily-sync cron — make syncTitles publicly invokable and add deploy + runtime regression checks

## Context

The first real daily-sync run **failed**. GitHub Actions run `28096039977`
(manual `workflow_dispatch` on `main`, 2026-06-24) ran the `daily-sync.yml`
`curl` POST to the deployed `syncTitles` endpoint
(`https://synctitles-mnapnzrmgq-ew.a.run.app`) and got **HTTP 403** — but the 403
did **not** come from the function. The response body was Google-Front-End HTML:

```
<title>403 Forbidden</title>
"Your client does not have permission to get URL / from this server."
```

`curl` exited 22; all retries hit the same 403; the job failed (correctly emailing
the owner). **Note:** that non-zero `curl` exit came specifically from the **old
`--fail-with-body` flag** (which makes curl return 22 on any HTTP ≥ 400). The
runtime replacement in Task 1b **no longer relies on a non-zero curl exit for 4xx**
— it drops `--fail-with-body`, captures the status code, and branches on it (so do
not read exit-22 behaviour as preserved). This is the canonical **Cloud Run IAM
rejection**: the gen2
`syncTitles` `onRequest` function is a Cloud Run service that does **not** allow
unauthenticated invocations (no `allUsers` → `roles/run.invoker` binding), so the
Google Front End blocks the request **before it reaches the function**. If the
request had reached the function, its own auth layer
(`apps/functions/src/lib/auth.ts` → `classifyAuth`, wired in
`apps/functions/src/main.ts`) would have returned a **JSON** body —
`{"error":"forbidden"}` (wrong secret), `{"error":"unauthenticated"}` (no header),
or `{"error":"method_not_allowed"}` (non-POST) — **never** Google's HTML page. The
shared secret was therefore never even evaluated.

Spec 0009 designed `syncTitles` as a **public** endpoint that self-authenticates at
the application layer: the constant-time-compared `X-Vultus-Sync-Secret`
shared-secret header (the cron path) or a Firebase ID token in
`Authorization: Bearer` (the user path). **Public invokability is required by
design** — the shared secret is the security gate, not Cloud Run IAM. The likely
true cause of the failure: `firebase deploy` (run via `deploy-functions.yml` using
the `FIREBASE_SERVICE_ACCOUNT`) silently failed to apply the `allUsers` invoker
binding because the deploy service account lacks `run.services.setIamPolicy`, **or**
an org domain-restricted-sharing policy blocked `allUsers`. A grep across
`.github/`, `docs/`, `firebase.json`, `deploy-functions.yml`, the
`functions:deploy-preflight` target, and the `/deploy-functions` skill confirmed
that **nothing currently sets or verifies public invokability** — so there was no
guard, and the regression surfaced only on the first cron run, a day after deploy.

Intended outcome: the deployed `syncTitles` service is publicly invokable (as the
design always assumed) via a documented one-time manual IAM grant, and the pipeline
gains a **deploy-time smoke gate** plus an improved **runtime diagnostic** so this
class of failure is detected loudly and explained, never silent again. This spec is
**pure infrastructure + docs + agent guidance** — it changes **no function
TypeScript**.

## Scope

In scope:

- **Deploy-time smoke gate** in `.github/workflows/deploy-functions.yml` (a new
  post-`firebase deploy` step): an **unauthenticated** smoke POST to the `syncTitles`
  URL that asserts the function was actually reached (any function-originated JSON
  response) and **fails the deploy with a clear `::error::`** if the response is a
  Google-Front-End infra 403 (the service is private). Skips with a `::warning::`
  (does not fail) when `vars.VULTUS_SYNC_URL` is unset. Sends **no** real shared
  secret.
- **Runtime diagnostic** in `.github/workflows/daily-sync.yml` (improve the existing
  `curl` step): capture HTTP status and body separately and branch the `::error::`
  on whether a 403 is a GFE infra rejection (service private — actionable: grant
  `allUsers` invoker) vs a function-level 403/401 (secret wrong/missing). Preserve
  all existing behaviour (fail on any non-2xx, retry transient/5xx, never log the
  secret, the `{"force": true}` body, the URL/secret guard, job/step timeouts).
- **`docs/PLAN.md` §7**: add a checklist item for the one-time
  `allUsers`→`roles/run.invoker` grant on the `synctitles` Cloud Run service, with
  the exact `gcloud` command and the "why" (gen2 = Cloud Run, private by default;
  the function self-authenticates via the shared secret, so it must be publicly
  invokable). Note it is the fix for the 2026-06-24 first-run failure.
- **`.claude/agents/infrastructure-engineer.md`**: add a gen2-private-by-default trap
  note to its Cloud Functions deploy section (symptom, cause, the smoke gate guard).
- **`.claude/skills/deploy-functions/SKILL.md`**: add a brief post-deploy note that
  the deploy must confirm `syncTitles` is publicly invokable, cross-referencing the
  manual grant.

Out of scope (each stated explicitly):

- **Modifying `syncTitles` or any function TypeScript** (`apps/functions/src/**`) —
  Decision 1. The spec-0009 `syncTitles` contract is fixed input here; the fix is
  infra, not a function change.
- **Switching to a private service + OIDC identity-token auth** — Decision 1,
  rejected. Parsing a Google OIDC token in the function's `Authorization: Bearer`
  slot (reserved for the user-path Firebase ID token) would be a function rewrite.
  Recorded as a **considered, deferred alternative** (see Risks).
- **Performing the actual GCP IAM grant / running any `gcloud` command** — a
  manual/human, out-of-repo step (same posture as deploy in spec 0017). This spec
  documents and verifies it; it does not execute it.
- **Changing the cron schedule, the `{"force": true}` body semantics, the
  staleness/rate-limit logic, or notification dispatch.**
- **Re-running or fixing the historical failed run** — this spec prevents
  recurrence; it does not replay run `28096039977`.
- **Provisioning/rotating `SYNC_SHARED_SECRET`, `TMDB_READ_TOKEN`, or
  `VULTUS_SYNC_URL`** — existing prerequisites (spec 0017 / PLAN §7), unchanged.
- **Any Sheriff-governed workspace code** — see next section.

## Affected slices & Sheriff tags

**None.** This spec touches only:

- `.github/workflows/deploy-functions.yml` and `.github/workflows/daily-sync.yml`
  (CI workflow YAML),
- `docs/PLAN.md` (documentation),
- `.claude/agents/infrastructure-engineer.md` and
  `.claude/skills/deploy-functions/SKILL.md` (agent/skill guidance, not workspace
  code).

Sheriff governs **workspace import boundaries between projects** — it does not police
workflow YAML, markdown, or `.claude/` guidance files. There is **no slice, no
library, no app, and no `sheriff.config.ts` change**. `slices: []`;
`scopes: [scope:functions]` is **descriptive only** (this is the deploy/cron leg of
the `scope:functions` sync backend) and drives no Sheriff rule. No workspace import
boundary is introduced or crossed, and there is no DRY/3+-slice extraction question
because no TypeScript is added.

**Note on `functions:deploy-preflight`:** the smoke gate is deliberately **not**
folded into the `functions:deploy-preflight` target (see Implementation task 1 for
the reasoning). No `apps/functions/project.json` target or function source is
touched by this spec, so the `nx affected` set for the workspace is **empty**.

## Data model touchpoints

**None directly.** This spec changes no Firestore collection, field, converter,
index, or security rule, and adds no `firestore.rules`/`firestore.indexes.json`
change. The deploy-time smoke check makes a single unauthenticated HTTP request that
**fails auth before any Firestore access** (no secret header → `classifyAuth`
returns `unauthenticated` → 401 before `gatherWatchlistTitles`/`runSync` touch the
database), so it reads/writes nothing and triggers no sync. The runtime
(`daily-sync`) request continues to invoke the already-shipped spec-0009 sync flow;
its Firestore touchpoints are unchanged and owned by spec 0009/0017.

## Public types / APIs

No new or changed types, function signatures, or workspace APIs. This spec is a
**consumer** of the already-shipped spec-0009 `syncTitles` HTTP contract. The only
relevant request/response expectations (fixed input):

- **A reachable function always returns JSON** with a known status. With **no**
  secret header it returns `401 {"error":"unauthenticated"}`; a **GET** returns
  `405 {"error":"method_not_allowed"}`; a present-but-wrong secret returns
  `403 {"error":"forbidden"}`; a valid cron secret + `{"force": true}` returns
  `200` with `SyncRunResponse`
  `{ ok, trigger:'cron', gathered, synced, skipped, errored, forced:true, durationMs }`.
- **A private service returns a Google-Front-End HTML 403** — `<title>403
  Forbidden</title>` / `"Your client does not have permission to get URL / from this
  server."` — and the function is **never reached**. This HTML body (not JSON) is
  the signal the new checks key on.
- The deployed Cloud Run **service name** is the lowercased function name
  **`synctitles`**, region **`europe-west1`**, project **`vultus-cab62`** (per
  `setGlobalOptions({ region: 'europe-west1' })` in `main.ts`).
- **Both workflow checks deliberately use `POST`, never `GET`.** A GET against a
  still-private service would *also* be GFE-blocked, muddying the
  infra-403-vs-function signal the checks rely on; POST is used intentionally so the
  only way to get a 403 is the IAM/GFE path or a function-level secret rejection.

## UI / Stitch screen refs

**Not applicable.** This is CI/infrastructure + docs work. There is no mobile slice,
screen, or design token.

## Implementation task graph

Four tasks, all **infrastructure-engineer** territory; none touches a Sheriff slice.
All four write **disjoint** files, but tasks 2–4 are documentation/guidance that must
describe the exact behaviour, command, and marker introduced by task 1, so keep them
**[sequential]** behind task 1 for consistency. (There is no parallel slice fan-out
here — every task edits a shared/root or guidance file the foundation phase owns.)

### 1. [sequential] Deploy-time smoke gate + runtime diagnostic (the two workflows)

Files: `.github/workflows/deploy-functions.yml`, `.github/workflows/daily-sync.yml`.

**1a — `deploy-functions.yml`: post-deploy public-invokability smoke gate.**
Add a new step **after** the existing `Deploy to Firebase` step. Reasoning for
placement (state explicitly in the spec/PR): the check needs the **deployed URL**,
which only exists post-deploy; `functions:deploy-preflight` runs **before** deploy
(and locally), validates the **artifact**, and has no deployed endpoint to hit — so
folding the smoke check into preflight is wrong. `deploy-functions.yml` is the right
home; **preflight stays the artifact validator**. Pinned step (default `bash` on
`ubuntu-latest` — POSIX, **not** PowerShell):

```yaml
      # After deploy, confirm the syncTitles Cloud Run service is publicly
      # invokable. gen2 onRequest functions are Cloud Run services, PRIVATE by
      # default; this function self-authenticates via the shared secret, so it
      # MUST allow unauthenticated invocations (allUsers → roles/run.invoker).
      # If the service is private, the Google Front End returns an HTML 403 and
      # the request never reaches the function — the cron would then fail daily.
      # This sends NO secret (it must not trigger a real sync); a reachable
      # function answers any unauthenticated POST with a JSON error body, which
      # proves invokability regardless of the auth outcome.
      - name: Verify syncTitles is publicly invokable
        timeout-minutes: 2
        env:
          SYNC_URL: ${{ vars.VULTUS_SYNC_URL }}
        run: |
          if [ -z "$SYNC_URL" ]; then
            echo "::warning::VULTUS_SYNC_URL is not set; skipping the public-invokability smoke check. Set the repo Actions variable to enable it."
            exit 0
          fi
          # Unauthenticated POST (NO secret header). Capture body + status code
          # separately; do NOT use --fail so we always inspect the body.
          body_file="$(mktemp)"
          status="$(curl --silent --show-error \
            --retry 2 --retry-delay 5 \
            --max-time 60 \
            -o "$body_file" -w '%{http_code}' \
            -X POST "$SYNC_URL" \
            -H 'Content-Type: application/json' \
            -d '{}')"
          echo "Smoke check HTTP status: $status"
          if [ "$status" = "403" ] && grep -qiE 'Your client does not have permission|<title>403 Forbidden' "$body_file"; then
            echo "::error::syncTitles returned a Google Front End 403 — the Cloud Run service is PRIVATE (request never reached the function). Grant public invokability once: gcloud run services add-iam-policy-binding synctitles --region=europe-west1 --member=allUsers --role=roles/run.invoker --project=vultus-cab62  (see docs/PLAN.md §7)."
            exit 1
          fi
          echo "syncTitles is publicly invokable (function reached; got a function-level response)."
```

Pin these properties (review-checkable):

- **No secret is sent** — neither `X-Vultus-Sync-Secret` nor `Authorization`. The
  body is `{}`, never `{"force": true}`. So even reaching the function only yields a
  401 and triggers **no** sync. (`SYNC_SHARED_SECRET` is **not** referenced by this
  step's `env:` at all.)
- **Status and body are captured separately** (`-o body_file -w '%{http_code}'`,
  **without** `--fail`/`--fail-with-body`) so the body is always available for the
  GFE-marker test.
- **GFE-403 ⇒ fail the deploy** with the actionable `::error::` naming the exact
  `gcloud` grant; **anything else ⇒ pass** (a reachable function answered).
- **Unset `VULTUS_SYNC_URL` ⇒ `::warning::` and `exit 0`** (skip, do **not** fail —
  the deploy itself is still valid). The variable is a documented prerequisite.
- The GFE marker is matched case-insensitively against **both** `"Your client does
  not have permission"` and `"<title>403 Forbidden"` (either present ⇒ infra 403).
- **`--retry` here likewise covers only transient/connection-level errors** — the
  expected pre-grant GFE-403 is a *completed* response, so it is **not** retried (the
  retry doesn't waste time re-hitting the 403; the step branches on the captured
  status immediately).
- The `mktemp` body temp file is **intentionally not cleaned up** — the
  `ubuntu-latest` runner VM is ephemeral and discarded after the job.

**1b — `daily-sync.yml`: GFE-403-vs-function-403 runtime diagnostic.**
Replace the single `--fail-with-body` `curl` with a status+body-capturing block that
branches the error message. Preserve: the `[ -z "$SYNC_URL" ] || [ -z "$SYNC_SECRET" ]`
guard, the `{"force": true}` body, the `X-Vultus-Sync-Secret` header (secret via
`env:`, never logged), the retry-on-transient/5xx behaviour, the job/step timeouts,
and **fail the job on any non-2xx** (so the failed-workflow email still fires). Pinned
replacement for the `Trigger daily sync` step's `run:`:

```yaml
        run: |
          if [ -z "$SYNC_URL" ] || [ -z "$SYNC_SECRET" ]; then
            echo "::error::VULTUS_SYNC_URL variable and SYNC_SHARED_SECRET secret must be configured."
            exit 1
          fi
          body_file="$(mktemp)"
          # Capture status + body separately so we can diagnose a 403 precisely.
          # --retry-all-errors retries transient/5xx; we still inspect the final
          # body. The secret is passed only via the header from $SYNC_SECRET and
          # is never echoed.
          status="$(curl --silent --show-error \
            --retry 3 --retry-all-errors --retry-delay 5 \
            --max-time 240 \
            -o "$body_file" -w '%{http_code}' \
            -X POST "$SYNC_URL" \
            -H "X-Vultus-Sync-Secret: $SYNC_SECRET" \
            -H "Content-Type: application/json" \
            -d '{"force": true}')"
          echo "Daily sync HTTP status: $status"
          # Print the response body for observability (SyncRunResponse counts on
          # 200; a JSON {"error":...} on a function-level failure). The function
          # never echoes secrets, and we never print the request header.
          cat "$body_file"
          echo
          case "$status" in
            2??)
              exit 0
              ;;
            403)
              if grep -qiE 'Your client does not have permission|<title>403 Forbidden' "$body_file"; then
                echo "::error::Google Front End 403 — the syncTitles Cloud Run service is PRIVATE; the request never reached the function. Grant public invokability: gcloud run services add-iam-policy-binding synctitles --region=europe-west1 --member=allUsers --role=roles/run.invoker --project=vultus-cab62 (see docs/PLAN.md §7)."
              else
                echo "::error::Function returned 403 (forbidden) — the shared secret was reached but did NOT match. Verify SYNC_SHARED_SECRET matches the function-side param."
              fi
              exit 1
              ;;
            401)
              echo "::error::Function returned 401 (unauthenticated) — the X-Vultus-Sync-Secret header was missing or empty as seen by the function."
              exit 1
              ;;
            *)
              echo "::error::Daily sync failed with HTTP $status. See the response body above."
              exit 1
              ;;
          esac
```

**On `--retry-all-errors` here (read before touching the curl flags):** because this
variant drops `--fail`/`--fail-with-body` and captures the status via
`-o body_file -w '%{http_code}'`, curl does **not** treat a *completed* 4xx/5xx HTTP
**response** as an error — it exits 0 and hands the status code back to the `case`.
So `--retry-all-errors` retries only genuine **transient/connection-level** failures
(DNS, connection reset, etc.), **not** a completed 5xx. A completed 5xx therefore
falls through to the catch-all `*)` arm and fails the job (as intended). **Do NOT
"fix" this by re-adding `--fail`/`--fail-with-body`** — doing so would break the
status+body capture and the GFE-vs-function-403 branching this step exists for.

Review-checkable properties: secret only in the header from `$SYNC_SECRET` (never
echoed, never on the visible command line, body file holds the **response** not the
request); GFE-403 distinguished from function-403 by the HTML marker; 401 and other
non-2xx each get a clear `::error::`; any non-2xx exits 1 (email fires); the
`{"force": true}` body and the URL/secret guard are preserved.

### 2. [sequential] PLAN §7 manual-grant prerequisite

File: `docs/PLAN.md`.

Add a checklist item to §7 (Manual prerequisites, near the existing
`VULTUS_SYNC_URL` / `SYNC_SHARED_SECRET` items, ~lines 460–472) for the one-time
`allUsers` → `roles/run.invoker` grant on the `synctitles` Cloud Run service:

- The exact command:
  `gcloud run services add-iam-policy-binding synctitles --region=europe-west1 --member=allUsers --role=roles/run.invoker --project=vultus-cab62`
- The **why**: gen2 `onRequest` functions are Cloud Run services, **private by
  default**; `syncTitles` self-authenticates via the `X-Vultus-Sync-Secret` shared
  secret, so the service must be **publicly invokable** — the shared secret is the
  security gate, not Cloud Run IAM. The service name is the **lowercased** function
  name `synctitles`.
- Note that this is the **fix for the 2026-06-24 first-run failure** (the cron got a
  Google-Front-End HTML 403 because the service was private), and that the deploy
  pipeline now **verifies** invokability (the smoke gate) but does **not** auto-grant
  it (Decision 2).
- Follow spec 0017's precedent for the stale-Spark lines: the existing §7 "Spark
  plan" bullet (~line 477) and §2 "Stays on Spark plan" row are stale (project is on
  **Blaze** per project setup) — **do not reword them**; just add a brief
  parenthetical to the **new** item (e.g. "(Blaze, per project setup)") so it isn't
  misread next to the stale neighbour. Do **not** commit any real secret or URL
  value.

### 3. [sequential] infrastructure-engineer agent — gen2-private-by-default trap note

File: `.claude/agents/infrastructure-engineer.md`.

In the **"Cloud Functions deploy (pnpm + gen2) — known traps"** section (the numbered
list, ~lines 54–70), add a trap note in the same house style as the existing
pnpm/gen2 entries: a gen2 `onRequest` function that **self-authenticates** (e.g.
`syncTitles` via the shared secret) needs an **`allUsers` → `roles/run.invoker`**
binding to be publicly invokable; the deploy SA may lack `run.services.setIamPolicy`
(or an org policy may block `allUsers`), so the binding can **silently not apply**;
the symptom is a **Google-Front-End HTML 403** ("Your client does not have
permission") rather than the function's JSON error; the binding is a **documented
one-time manual grant** (PLAN §7) and the **deploy-time smoke check** in
`deploy-functions.yml` guards against regression. Match the existing references to
the `functions-deploy-pnpm-recipe` memo in tone (reference it; do not write to user
memory).

### 4. [sequential] /deploy-functions skill — post-deploy invokability note

File: `.claude/skills/deploy-functions/SKILL.md`.

In the **"### 4. Report"** (post-deploy) section, add a short note that the deploy
must confirm `syncTitles` is **publicly invokable** — the `deploy-functions.yml`
smoke check verifies this automatically, and the one-time `allUsers` invoker grant
(PLAN §7) is the fix if the smoke check reports a Google-Front-End 403. Keep it brief
and consistent with the file's existing tone (it already references the
`infrastructure-engineer` deploy notes and the recipe memo).

(No new dependency is added — `curl`/`grep`/`mktemp` are preinstalled on
`ubuntu-latest`. No workspace project, lib, `project.json`, or function source is
touched, so no lib-README update applies and `functions:deploy-preflight` is
unchanged.)

## Test plan

There is **no unit-testable workspace logic** here — the deliverable is workflow YAML
+ docs + agent/skill guidance, with no code in a workspace project. Per the PLAN §5
pyramid, no unit / component / e2e tests are added or applicable. **CI does not
exercise either changed workflow** — both `daily-sync.yml` (schedule/`workflow_dispatch`)
and `deploy-functions.yml` (`workflow_dispatch`) run **only** on dispatch/schedule,
never on `pull_request`/`push`, so `ci.yml` will not invoke them on the PR (call this
out, as spec 0017 did). The DoD rests on static validity, a manual dry-run, and review
checks:

- **YAML / workflow validity (degrade gracefully).** If `actionlint` is available,
  run it against **both** changed workflows and it must pass; if it is not installed,
  fall back to a YAML parse/lint check on both files and record that `actionlint` was
  unavailable (CLAUDE.md / skills tooling-absent rule). Confirm the `on`/`jobs`/`steps`
  structure stays well-formed after the edits.
- **Manual post-merge verification (human-verified — agent cannot run in-session):**
  1. Perform the one-time `allUsers` → `roles/run.invoker` grant on the `synctitles`
     Cloud Run service (the `gcloud` command in PLAN §7).
  2. Manual `workflow_dispatch` of **deploy-functions** → confirm the new **"Verify
     syncTitles is publicly invokable"** step passes (function reached, no GFE-403)
     and that it would have failed loudly before the grant.
  3. Manual `workflow_dispatch` of **daily-sync** → confirm a **green** sync
     (`SyncRunResponse` with `trigger:'cron'`, `forced:true`, sane counts) and that
     the secret does not appear in the logs.
  These require the live deployed service + provisioned secret/variable; the
  implementing agent **cannot** run them — flagged as human/post-merge verification.
- **Review checks:**
  - The shared secret is **never logged** in either workflow; the deploy smoke check
    sends **no** secret header at all (no `SYNC_SHARED_SECRET` in its `env:`).
  - GFE-403 vs function-403 branching is correct in both the smoke gate and the
    runtime diagnostic (HTML marker match vs JSON error).
  - The deploy smoke gate **skips with a `::warning::` (does not fail)** when
    `VULTUS_SYNC_URL` is unset.
  - The `daily-sync` job still **fails on any non-2xx**, retries transient/5xx,
    preserves the `{"force": true}` body and the URL/secret guard, and prints only
    the **response** body (never the request header).
  - PLAN §7 / agent / skill docs name **no** real secret or URL value, and the new
    PLAN §7 item carries the Blaze parenthetical without rewording the stale Spark
    lines.

## Definition of done

Tailored from the PLAN §5 checklist to an infra/docs-only change (no workspace
project is touched, so there are no `nx` typecheck/lint/test/build targets for this
spec; the affected set is empty). Gates that don't apply are marked N/A with the
reason.

- [ ] `.github/workflows/deploy-functions.yml` has a post-deploy **"Verify syncTitles
      is publicly invokable"** step that: sends an unauthenticated POST (no secret);
      captures status + body separately (no `--fail`); **fails the deploy on a
      GFE-403** with an `::error::` naming the exact `allUsers` invoker grant; passes
      on any function-level response; and **skips with a `::warning::` (does not
      fail) when `VULTUS_SYNC_URL` is unset**.
- [ ] `.github/workflows/daily-sync.yml` distinguishes a **GFE infra 403** from a
      **function-level 403** (and 401) with a clear actionable `::error::` for each,
      while preserving fail-on-non-2xx, retry-on-transient/5xx, the `{"force": true}`
      body, the URL/secret guard, the job/step timeouts, and secret hygiene.
- [ ] Neither workflow logs the shared secret or places it on the visible command
      line; the smoke check references no secret at all (review-checked).
- [ ] `docs/PLAN.md` §7 has a manual-grant checklist item with the exact `gcloud`
      command, the gen2-private-by-default rationale, the `synctitles` service name,
      a note that this fixes the 2026-06-24 first-run failure, and a Blaze
      parenthetical — without rewording the stale Spark lines. No real secret/URL
      value committed.
- [ ] `.claude/agents/infrastructure-engineer.md` has the gen2-private-by-default trap
      note (symptom: GFE HTML 403; cause: missing `allUsers` invoker / deploy-SA
      perms / org policy; guard: deploy-time smoke check) in its Cloud Functions
      deploy section.
- [ ] `.claude/skills/deploy-functions/SKILL.md` post-deploy section notes the
      public-invokability confirmation + cross-references the manual grant.
- [ ] **No function TypeScript changed** (`apps/functions/src/**` untouched);
      `functions:deploy-preflight` target unchanged.
- [ ] Both changed workflows are **valid** — `actionlint` passes if available;
      otherwise a YAML parse/lint check passes and the PR notes `actionlint` was
      unavailable.
- [ ] Lint/Sheriff/typecheck/unit/component/build/e2e: **N/A** — no workspace project,
      code, or boundary is changed; `nx affected` is empty for this spec (the PR
      description states this explicitly).
- [ ] The **manual `allUsers` grant + dual `workflow_dispatch` dry-run** (deploy-
      functions smoke gate green; daily-sync green) are **flagged for human post-merge
      verification** — the agent cannot run them in-session (live service + secret
      required). The PR description records this as the real functional verification.
- [ ] PR description records that **CI does not exercise** either workflow (both run
      only on schedule/dispatch), what static checks ran, and the secret-hygiene /
      GFE-vs-function-403 / skip-on-unset-URL review confirmations.

## Risks

- **Org domain-restricted-sharing policy may block the `allUsers` binding entirely
  (main contingency).** If the GCP org enforces domain-restricted sharing, the
  `gcloud run services add-iam-policy-binding ... --member=allUsers` grant will be
  rejected and public invokability becomes **impossible**. In that case the team must
  either obtain an org-policy exception for the `synctitles` service, **or** fall back
  to the deferred private-service + OIDC identity-token model (Decision 1's rejected
  alternative — which would require a function rewrite to accept a Google OIDC token,
  out of scope here). The deploy smoke gate will surface this as a persistent GFE-403,
  making the contingency visible rather than silent.
- **Verify-only cannot fix a missing grant — it only detects it (Decision 2).** If the
  deploy SA lacks `run.services.setIamPolicy`, `firebase deploy` may silently not
  apply the binding; the smoke gate then fails the deploy. The durable fix is the
  documented manual grant (a human action); the gate is the guard, not the remedy.
- **The smoke check hits the real (rate-limited) function but is side-effect-free.**
  It sends **no** (and never a wrong) secret, so `classifyAuth` returns
  `unauthenticated` and the function returns 401 **before** any Firestore access or
  sync — no sync is triggered, no rate-limit state is consumed, nothing is written.
- **GFE-403 detection is heuristic (HTML string match).** Both checks key on the exact
  markers `"Your client does not have permission"` / `"<title>403 Forbidden"`. If
  Google changes the Front End error page wording, the heuristic could misclassify a
  GFE-403 as a function failure (or vice versa). Acceptable for v1; noted as brittle —
  the pinned markers are the contract and should be revisited if Google changes them.
- **DST/cron caveats are unchanged from spec 0017.** The `0 4 * * *` UTC schedule and
  its no-DST behaviour are untouched by this spec.
- **No PLAN conflict.** This spec aligns with the spec-0009 as-built design (public
  endpoint, shared-secret gate) and PLAN §2/§6 (cron → HTTP function). It does not
  change PLAN architecture; it adds a §7 manual prerequisite and pipeline guards. The
  same stale §7 "Spark" / §2 "Spark plan" lines noted by spec 0017 remain (project is
  on Blaze) — this spec does not depend on or reword them.
