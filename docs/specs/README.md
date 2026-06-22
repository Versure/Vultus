# Vultus feature specs

Each feature is specified as one markdown file here before it is implemented.
The spec is the contract an agent implements without further questions. This
**spec-file workflow supersedes the GitHub-issue task management described in
`docs/PLAN.md` §5–§6** — there are no GitHub issues; the spec file (reviewed and
merged as a PR) is the unit of work.

## Lifecycle

```
/create-spec   → interview → draft → auto-review/rework → spec PR  (status: approved in the diff)
[you review the PR, comment]
/rework-spec   → apply comments → push                  → [you merge → lands 'approved' on main]
/implement-feature → worktree → implement → review → QA → code PR  (flips 'done' in diff)
[you review the PR, comment]
/rework-feature → apply comments → QA → push → pipeline green → [you merge → spec is 'done']
```

On `main` the spec moves `approved → done`; `implementing` is worktree-local only
(it never lands on `main`), so don't query `main` for it.

`status: approved` is written into the spec **in the spec PR diff**, so merging
the spec PR lands it as `approved` on `main` whether or not `/rework-spec` ran
(the no-comment happy path is covered). Likewise `/implement-feature` flips
`done` in the feature PR diff, so merging that PR marks the spec complete.

## Scope & limitations (by design)

- **The workflow ends at a green, merged PR.** Deployment (Firebase Functions
  deploy, FCM setup, Capacitor APK build/install — PLAN §7, §10) is a manual /
  separate step, not driven by these skills.
- **Re-speccing a merged spec:** the lifecycle is forward-only. If implementation
  reveals a merged spec is wrong, open a **new spec PR editing that file** (run
  `/create-spec` referencing it, or edit + PR directly) and re-review — there's
  no automated "kick an approved spec back to draft."
- **Spec numbering** scans `main` + open `spec/*` PRs for the next `NNNN`; truly
  simultaneous `/create-spec` runs could still pick the same number — serialize
  them if you spec in bulk.

## File naming

`NNNN-slug.md`, zero-padded, incrementing (e.g. `0001-region-picker.md`).

## Frontmatter

```yaml
---
number: 0001
slug: region-picker
title: Add region picker to settings slice
status: approved # draft | approved | implementing | done (no 'in-review')
slices: [slice:settings] # may be [] for foundation/infra specs (no slice)
scopes: [scope:mobile] # optional; for scope-only/foundation work
created: 2026-06-16
# Note: slices/scopes are DESCRIPTIVE (for humans + spec-reviewer). Agent
# routing is driven by the per-task scope tags in the task graph, not these.
---
```

## Body sections (in order)

1. **Context** — why; the user need; intended outcome.
2. **Scope** — what's in; an explicit "Out of scope".
3. **Affected slices & Sheriff tags** — libs/apps + their scope/slice tags (PLAN §3).
4. **Data model touchpoints** — Firestore collections/fields (PLAN §4).
5. **Public types / APIs** — new/changed types, signatures, endpoints.
6. **UI / Stitch screen refs** — mobile only; **the actual Stitch screen ID**
   (pulled via the MCP — retry, don't silently fall back to tokens) + design
   tokens (PLAN §2). A **checkable** contract, not prose: concrete dimensions
   (control heights), insets that agree across sibling elements, radius, and
   **every interactive state** (default/focus/hover/active/disabled + animations).
   Note token wiring that's easy to miss (e.g. the font must be _loaded_, not just
   named).
7. **Implementation task graph** — tasks mapped to slices, marked `[sequential]`
   (shared deps, new-slice generation, root config first) or `[parallel]`
   (independent slices). Every `[parallel]` task carries a **file manifest** (the
   paths it writes); the orchestrator asserts these are pairwise disjoint before
   fanning out agents.
8. **Test plan** — unit / component / e2e per the PLAN §5 pyramid.
9. **Definition of done** — the PLAN §5 checklist, tailored.
10. **Risks** — unknowns, data-source caveats, PLAN conflicts.

`status` is advanced automatically by the skills; `implement-feature` flips it to
`done` inside the feature PR diff so merging the PR marks the spec complete.
