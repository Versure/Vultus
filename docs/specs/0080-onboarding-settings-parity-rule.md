---
number: 0080
slug: onboarding-settings-parity-rule
title: Add a standing Onboarding ↔ User-field parity rule (F4) to the spec-driven workflow
status: approved # draft | approved | implementing | done
slices: []
scopes: []
created: 2026-07-20
---

# Add a standing Onboarding ↔ User-field parity rule (F4)

## Context

GitHub issue #202 ("Onboarding not complete") was filed because
`libs/mobile/onboarding` (spec 0022) had drifted out of sync with
`libs/mobile/settings`. Four separate specs each added a new user-configurable
preference to the `User` document (`users/{uid}`) through Settings, and **none of
them asked whether onboarding should also collect it at first launch**:

- **0051** — notification quiet-hours (delivery-hour window on `notificationPrefs`).
- **0060** — `myProviderIds` (TMDB provider ids the user subscribes to).
- **0061** — `hasPlex` (self-hosted Plex server flag).
- **0073** — `plexSync` / Plex-link metadata.

All four fields live on `User` today (`libs/shared/domain/src/lib/documents.ts`
lines 43–58). Onboarding was left collecting only `region` + a bare
push-permission request until #202 surfaced the gap, at which point spec 0078
(onboarding-full-settings — a sibling spec drafted this session, not yet merged)
had to retrofit **all four at once**. Spec 0078 is "the debt is now being paid";
this spec (0080) is "so the debt is never silently taken on again."

**An audit of the current AI setup confirmed there is no rule anywhere that would
have caught #202 as it happened — incrementally, spec-by-spec.** The create-spec
workflow has exactly three numbered "probe" mechanisms, and none of them fits:

- **F1 — DoD ⇄ task-manifest coverage** (spec-author "Before finishing"
  cross-check; spec-reviewer checklist item 8): every DoD checkbox must map to an
  owning task. Catches orphaned `firestore.rules`/indexes/tests — not missing
  onboarding coverage.
- **F2 — shared-type ripple** (spec-author §5, `spec-author.md:80-87`;
  spec-reviewer item 4, `spec-reviewer.md:37-46`): the closest existing mechanism,
  but it fires **only when a `shared/domain` field is made _required_** (or a
  change otherwise breaks existing consumers). Specs 0051/0060/0061/0073 each
  added a new **optional** field with a default/converter coalesce, so F2 never
  triggered — and even if it had, it only asks "does onboarding's existing code
  still compile," never "should onboarding **collect** this new preference."
- **F3 — rendered-text assertion consistency** (spec-author §8,
  `spec-author.md:120-129`; feature-reviewer, `feature-reviewer.md:53-62`):
  unrelated to this problem; cited only to complete the probe-numbering scheme.

There is no probe asking **"does this new preference belong in first-launch
onboarding, or is it deliberately Settings-only?"** This spec adds exactly that as
a new, numbered probe — **F4** — wired into the same four documents F1/F2/F3
already touch, with `CLAUDE.md` carrying a new **canonical statement** the other
three probes don't currently have (verified: `CLAUDE.md` has zero F1/F2/F3
references today, and `spec-reviewer.md` has no F3 item — F3 lives only in
spec-author §8 and feature-reviewer). F4 fires on every future spec the same way,
without relying on any individual session remembering to ask.

This spec is an **AI-setup / standing-instruction change only**, mirroring the
0067/0068/0069 precedent: it edits `CLAUDE.md`, `.claude/skills/**`, and
`.claude/agents/**` — no application, lib, UI, or Firestore code. It does **not**
touch onboarding: spec 0078 is the concrete "yes, catch up" resolution for the
four pre-existing gaps; 0080 only installs the standing rule so the **next** gap
never needs its own catch-up spec.

**Intended outcome.** A spec that adds or changes a `User` field can no longer pass
spec-review while silent about onboarding: it must explicitly resolve to either
"include in onboarding" or "deliberately Settings-only."

## Scope

In scope — the same rule stated once canonically and referenced (not restated) at
each point it applies, mirroring how CLAUDE.md's "UI fidelity is a contract"
pattern and the existing F1/F2/F3 probes work. Four files, each with a single
concrete insertion point:

- **`CLAUDE.md`** — add the **canonical statement** of the rule as a new bullet in
  the "Architecture (PLAN §3–§4)" section, immediately **after the "Data model:"
  bullet** (currently line 19–20), since this is fundamentally a
  data-model-touching-user-facing-behavior rule and reads naturally there. The
  bullet must be self-contained enough that a human reading CLAUDE.md alone
  understands the whole rule: what triggers it (any new/changed `User` field), the
  two compliant outcomes, and that it is enforced as a **blocking** spec-reviewer
  finding (F4). This makes the rule discoverable from a single `grep -n onboarding
CLAUDE.md` (today: **zero** hits — re-confirmed against current `main`).
- **`.claude/skills/create-spec/SKILL.md`** — add a fourth interview probe bullet,
  **"Onboarding ↔ User-field parity probe (F4):"**, in the "Steps → 1. Interview"
  list, immediately **after the F3 rendered-text probe bullet** (F1/F2/F3 are the
  consecutive bullets at lines 50/57/63). It instructs the orchestrator: as
  acceptance criteria firm up, if the feature adds or changes a `User` field, ask
  the user (architect-interview style, via `AskUserQuestion` in an interactive
  session) whether it belongs in first-launch onboarding or is deliberately
  Settings-only, and record which in the decision record so spec-author states the
  resolution explicitly.
- **`.claude/agents/spec-author.md`** — (a) add an F4 paragraph to body-section
  **5 "Public types / APIs"**, immediately **after the F2 shared-type-ripple
  paragraph** (lines 80–87), following that paragraph's exact prose pattern (state
  the trigger, state what must appear in the spec, cite the two allowed
  resolutions). Section 5 is the natural home because F2 already discusses
  `shared/domain` field changes there and even names onboarding as an example
  consumer. **Style note (verified against the current file): `spec-author.md` uses
  unlabeled prose for its F2/F3 analogs — zero literal "F1/F2/F3" tokens appear in
  this file today.** The new §5 paragraph and the "Before finishing" line below
  must match that: unlabeled prose, no literal "(F4)" tag — only
  `create-spec/SKILL.md`'s bullet and `spec-reviewer.md`'s checklist item carry the
  explicit "(F4)" label (those two files already use that convention for F1/F2/F3).
  (b) Add a parity line to the **"Before finishing: DoD ⇄ task-manifest
  cross-check"** section stating that spec-author must not finish a spec that adds
  or changes a `User` field without one of the two resolutions present — mirroring
  how that section already polices F1, and likewise unlabeled prose.
- **`.claude/agents/spec-reviewer.md`** — insert a **new numbered checklist item**
  immediately **after item 4 "Type/API soundness (F2)"** (F4 is closely related —
  both concern `User`-type changes), labeled **"(Blocking — Onboarding parity,
  F4)"**: when a spec adds/changes a `User` field, it must state one of the two
  explicit resolutions; silence is a blocking finding, same severity as F1/F2.
  Renumber the subsequent items so the scheme stays contiguous (final scheme
  below); item 4's existing F2 text is left exactly as-is.

Out of scope:

- Altering the F1/F2/F3 text beyond the mechanical insertion/renumbering above
  (e.g. spec-reviewer's item-4 F2 prose stays verbatim; the new F4 item is its own
  checklist entry, not merged into item 4).
- Touching `.claude/agents/feature-reviewer.md`, `.claude/agents/frontend-engineer.md`,
  or any agent/skill file other than the four above. The gate belongs entirely at
  **spec-review time**; by implementation time the spec is the settled contract and
  feature-reviewer's existing "code matches the spec" job is sufficient downstream
  enforcement.
- **`.claude/skills/implement-feature/SKILL.md` — deliberately not touched.** That
  file carries implementation-time reconciliation analogs for F1 ("DoD ⇄
  task-manifest reconciliation pre-flight (group F1)") and F2 ("workspace-wide
  typecheck ... (group F2)") — real code-drift checks that catch a spec's intent
  diverging from the merged code. F4 has no such analog by design: it is a
  **spec-content-completeness** probe (did the spec address onboarding at all),
  fully resolved at spec-review time before any code exists: there is nothing for
  an implementation-time pass to reconcile. Unlike F1/F2, F4 intentionally gets no
  `implement-feature/SKILL.md` entry.
- Any onboarding/settings/application/lib/UI/Firestore code. This spec adds nothing
  to onboarding — spec 0078 is the catch-up for the four existing gaps.
- Retroactively re-reviewing any already-merged spec. F4 applies **going forward**
  only.

## Affected slices & Sheriff tags

**None** (`slices: []`, `scopes: []`). All four files are prompt/standing-instruction
markdown outside the Nx/TS/Sheriff graph. No cross-slice import, no shared-code
extraction, no new-slice generation.

## Data model touchpoints

**None.** This spec adds no field and reads/writes no collection. It only
introduces a **rule about** future `User`-field changes; the `User` type
(`libs/shared/domain/src/lib/documents.ts:42`) is referenced as the trigger
surface but is **not modified** here.

## Public types / APIs

**None.** No type, signature, endpoint, or callable changes. The change surface is
entirely instruction-markdown text.

The rule's **trigger definition** (recorded here so the implementer copies it
verbatim into the four files): F4 fires whenever a spec's Data model touchpoints
or Public types section **adds a new field to the `User` domain type
(`@vultus/shared/domain`'s `documents.ts`) or changes the meaning/shape of an
existing one** — regardless of which slice's spec introduces it, and whether or
not `libs/mobile/onboarding` or `libs/mobile/settings` appears in "Affected
slices." The failure mode is not "which slice" but "a new persisted user
preference exists and onboarding was never asked about it," so the trigger is
deliberately scoped to the `User` type itself, not to the settings slice.

The two compliant resolutions (also copied verbatim into the four files):

- **(a) Include in onboarding** — the spec's Scope/task graph includes the work to
  also collect this preference during first-launch onboarding, **or** the spec's
  Risks section explicitly names a follow-up spec (by number/description) that
  will, mirroring how spec 0078 is the named follow-up to 0051/0060/0061/0073.
- **(b) Deliberately Settings-only** — an explicit one-line justification for why
  the preference should **not** be part of first-launch onboarding (e.g. "an
  advanced/rarely-changed setting, discoverable later; forcing it into first-launch
  adds friction to the primary happy path without corresponding benefit"). This is
  a legitimate outcome the rule must allow — F4 does not mandate that everything go
  into onboarding.

A spec that adds/changes a `User` field and says **nothing** about onboarding is
**not** compliant — silence is precisely the failure mode that produced #202, and
silence must fail review like an orphaned DoD item (F1) does.

**Final spec-reviewer checklist numbering** (stated explicitly so the diff is
unambiguous): insert F4 as the new **item 5**; renumber the current items 5→6,
6→7, 7→8, 8→9, 9→10. So after the change: 4 = Type/API soundness (F2, unchanged),
**5 = Onboarding parity (F4, new)**, 6 = Testability, 7 = UI fidelity, 8 = Task
graph, 9 = Definition of done (F1), 10 = Risks.

## UI / Stitch screen refs

**Not applicable** — no UI. This spec edits standing-instruction prose only.

## Implementation task graph

Route to **infrastructure-engineer** (prompt/standing-instruction editing).

This is **one sequential task** touching all four files. Although the four file
paths are disjoint and could in principle be split into parallel tasks (as
0067/0068 did), F4 is a **single cross-file rule** whose statements must stay
mutually consistent — CLAUDE.md carries the canonical wording and the other three
reference/extend it (the create-spec probe, spec-author's authoring duty,
spec-reviewer's blocking check must all describe the same trigger and the same two
resolutions). A single coherent authoring pass is the correct unit of work here; a
fake parallel split would risk the four statements drifting from each other on
first authoring — the exact drift this spec exists to prevent. There is no
parallelizable slice boundary.

- **T1 [sequential]** — Manifest:
  - `CLAUDE.md`
  - `.claude/skills/create-spec/SKILL.md`
  - `.claude/agents/spec-author.md`
  - `.claude/agents/spec-reviewer.md`

  Add F4 to each per the Scope insertion points and the trigger/resolution text in
  §5. Do not alter F1/F2/F3 text beyond the spec-reviewer renumber. Run
  `pnpm exec prettier --write` on the four changed markdown files before staging
  (CLAUDE.md Windows E2 convention: Edit/Write can emit CRLF and trip
  `prettier --check`'s `endOfLine: lf`).

## Test plan

There is no executable code, so no unit/component/e2e surface — the "test" is a
self-consistency inspection of the new F4 language, following the same shape
0067/0068/0069 used for their no-code changes.

- **No e2e flows required — standing-instruction/prose change only.** (`nx affected`
  shows no affected project; the `doc-integrity-test` guards for `plan-theme-hex`
  and `lib-README` are unaffected — no hex value, PLAN, or lib-README content
  changes.)
- **Inspection, one assertion per file:**
  - `grep -n onboarding CLAUDE.md` returns the new bullet (was zero hits); the
    bullet states the trigger, both resolutions, and that F4 is a blocking
    spec-reviewer finding — readable standalone.
  - `create-spec/SKILL.md` has an F4 interview-probe bullet in "Steps → 1.
    Interview", immediately after the F3 bullet, matching the F1/F2/F3 bullet
    style.
  - `spec-author.md` §5 has an F4 paragraph after the F2 paragraph matching its
    prose pattern; the "Before finishing" section has the parity line.
  - `spec-reviewer.md` has a new blocking F4 item as item 5 with the renumber
    above; item 4's F2 text is byte-for-byte unchanged.
  - **No stale numeric cross-reference introduced by the renumber:** grep
    `spec-reviewer.md`, `.claude/`, and `docs/specs/*.md` for any existing
    reference to a spec-reviewer checklist item **by number** (e.g. "item 5",
    "checklist item 8") that the 5→6…9→10 shift would silently invalidate.
    Confirmed at draft time: **none exist** (the only "item 4" hit anywhere is an
    unrelated `spec 0069 item 4` comment in a hook, referring to that spec's own
    numbering, not spec-reviewer's checklist) — re-verify this at implementation
    time since it is a point-in-time check.
- **Cross-consistency self-check (the core remedy):** verify all four files
  describe the **same** trigger (new/changed `User` field, any slice) and the
  **same** two resolutions ((a) include-or-named-follow-up / (b) Settings-only with
  justification), and that "silence fails review" is stated at the enforcing points
  (CLAUDE.md + spec-reviewer). A future spec-reviewer agent reading only these
  files must be able to apply F4 without ambiguity. This is the mitigation for the
  primary risk below.
- **Prettier:** `pnpm exec prettier --check` passes on the four changed files (no
  CRLF re-mangle).

## Definition of done

- [ ] `CLAUDE.md` carries the canonical F4 rule as a new bullet after the "Data
      model:" bullet — trigger + both resolutions + "blocking spec-reviewer finding"
      — discoverable via `grep -n onboarding CLAUDE.md`.
- [ ] `.claude/skills/create-spec/SKILL.md` has the F4 interview probe bullet after
      the F3 bullet in "Steps → 1. Interview".
- [ ] `.claude/agents/spec-author.md` §5 has the F4 paragraph (after F2) and the
      "Before finishing" section has the F4 parity cross-check line.
- [ ] `.claude/agents/spec-reviewer.md` has the new blocking F4 item as item 5 with
      subsequent items renumbered 5→6…9→10; item 4's F2 text unchanged.
- [ ] All four files describe the same trigger and the same two resolutions;
      "silence fails review" stated at the enforcing points; no F1/F2/F3 text
      altered beyond the spec-reviewer renumber.
- [ ] `pnpm exec prettier --write` run on the four changed markdown files; no
      product-slice/type/UI/Firestore change; `nx affected` shows no affected
      project.

## Risks

1. **Ambiguous wording defeats the rule.** The whole value of F4 is that a future
   spec-reviewer agent applies it **consistently**; if the trigger or the two
   resolutions are stated differently across the four files, an agent may
   mis-apply it or the four statements drift. **Mitigation:** the Test plan's
   cross-consistency self-check — all four files must state the same trigger and
   the same two resolutions verbatim in substance — plus keeping CLAUDE.md as the
   single canonical source the others reference.
2. **F4 does not mandate onboarding for everything.** Resolution (b)
   (deliberately Settings-only) is a first-class, legitimate outcome. A version of
   the rule that forced every preference into first-launch onboarding would add
   friction to the happy path and would be wrong; the wording must preserve (b) as
   equal to (a).
3. **Forward-only, not retroactive.** F4 applies to specs authored **after** it
   merges; it does not re-open any already-merged spec. The four historical gaps
   (0051/0060/0061/0073) are addressed by spec 0078, not by this rule.
4. **No PLAN/architecture conflict.** This is standing-instruction hardening in the
   same class as specs 0067/0068/0069; it touches no code, no data model, and no
   Sheriff boundary. It extends the existing F-numbered probe scheme (F1/F2/F3) by
   adding F4 without renaming or renumbering the existing three.
