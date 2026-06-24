# CLAUDE.md — Vultus standing instructions

Vultus is a personal Movie/TV tracker (Ionic + Angular via Capacitor, Nx
monorepo, Firebase backend). `docs/PLAN.md` is the source of truth for
architecture and decisions; read it before non-trivial work.

## Architecture (PLAN §3–§4)

- **Vertical slice, enforced by Sheriff.** Each slice owns its UI, state, data,
  and types. **No cross-slice imports** — slices communicate only through
  `scope:shared`. **Don't DRY across slices**: duplication inside a slice is
  fine; extract to `shared/` only when the _same_ logic appears in **3+ slices**
  with the same reason to change. The agent's instinct to deduplicate breaks
  vertical slice — resist it.
- **Scope tags:** `scope:shared` (importable by anyone), `scope:mobile`
  (`apps/mobile` + `libs/mobile/*`), `scope:functions` (`apps/functions` +
  `libs/functions/*`). `scope:mobile` and `scope:functions` must never import
  each other.
- **Data model:** Firestore, keyed by `userId` from day one; see PLAN §4 for
  collection paths, `title-cache`, and the `previousSnapshot` transition model.
- **UI design source:** Google Stitch "Vultus Android App Design"
  (`projects/13590348714018893783`), via the `stitch` MCP. The **authoritative
  token set lives in the repo** at `docs/design/vultus-design-system.md` (exported
  from Stitch) and is wired into `shared/ui-kit` `theme.scss`. Design language:
  dark-first, Inter, primary Emerald `#4edea3` (note: `#10B981` is
  `primary-container`, **not** primary), deep-navy surface ramp (`#0b1326`
  background → `#171f33` cards → `#2d3449` overlays), `on-surface` text `#dae2fd`,
  8px grid. **Never hand-transcribe a hex from memory or from prose — cite
  `docs/design/vultus-design-system.md` (or the fetched Stitch screen) and consume
  the `--vultus-*` / `--ion-*` vars `theme.scss` exposes.** Treat the Stitch design
  system as the contract for `shared/ui-kit` theming.
- **UI fidelity is a contract, not a vibe.** For any mobile UI work the relevant
  **Stitch screen** (not just the tokens) is the spec. Fetching it has a specific
  recipe: `get_screen` returns **metadata + a download URL, not the rendered
  markup** — take `htmlCode.downloadUrl`, fetch the **raw HTML** (a plain GET /
  `Invoke-WebRequest`, **not** WebFetch, which summarizes away the CSS), and read
  the Tailwind config (`colors`/`fontSize`/`spacing`) + element markup for the
  concrete values; also grab `screenshot.downloadUrl` for a visual compare. **Retry
  on MCP failure**; if the screen HTML genuinely can't be read, the UI task is
  **blocked / `needs-human`** — do **not** "fall back to tokens and proceed" (the
  fallback hides structure the tokens can't express). Pin concrete values and **all
  interactive states** (focus/active/hover/disabled, animations), and remember a
  named token only renders if it's wired (e.g. the font must be _loaded_, not just
  listed in the family stack). A green typecheck/lint/test/build does **not** prove
  the UI looks right — visually verify it (render/screenshot, or the
  `--configuration=mock` serve target) or **explicitly flag it unverified for a
  human eyeball**; never report UI fidelity as done off a green build alone.

## Commands & definition of done (PLAN §5)

- The workspace is **bootstrapped** (spec 0001): Nx 23 monorepo, pnpm, Ionic +
  Angular 21 / Capacitor 8 (`apps/mobile`), Firebase Functions (`apps/functions`),
  `libs/shared/{domain,firestore-schema,ui-kit}`. **Unit tests run on Vitest +
  Analog** (not Jest); **e2e on Playwright** (`apps/mobile-e2e`).
- Commands: `pnpm nx test`, `pnpm nx lint` (includes Sheriff), `pnpm nx build`,
  `pnpm nx e2e`, `pnpm nx serve`, `firebase emulators:start` (once Firebase is
  configured in a later spec). Prefer `nx affected -t <target> --base=main`.
- **Definition of done** for any PR: typecheck + lint/Sheriff + unit + component
  (for non-trivial UI) + build + e2e (affected critical flows) all green, and the
  changed slice has tests for its logic. Tooling-absent gates degrade gracefully —
  see the skills.
- **Cloud Functions deploy gate.** CI validates the monorepo but the deployable
  artifact is the **pruned `dist/apps/functions`**, installed by Cloud Build with
  pnpm — a different beast. Any change to `apps/functions` deps or build **must**
  pass `pnpm nx run functions:deploy-preflight` (also a CI gate): it installs the
  pruned bundle, checks the required deps + `allowBuilds` ship, verifies
  `firebase-admin` satisfies `firebase-functions`' peer range, and loads `main.js`
  (gen2 discovery). To actually ship, use `/deploy-functions`. The pnpm/gen2 traps
  are documented in the `infrastructure-engineer` agent.

## Conventions

- **Shell is PowerShell** (Windows). Use PS-safe syntax: `2>$null`, here-strings
  `@'...'@` for multi-line text, `$env:VAR`, `$LASTEXITCODE`.
- **Secrets:** never read or write `.env.local` or any secret. Secrets live in
  `.env.local` (gitignored), GitHub Actions secrets, and Firebase functions
  config. Flag if a secret would be needed somewhere it shouldn't be.
- **Branches:** `spec/NNNN-slug` (spec PRs), `feat/NNNN-slug` (feature PRs).
  PRs target `main`; squash-merge so each spec/feature is one commit.
- **Pre-commit hook:** husky + lint-staged run ESLint `--fix` (Sheriff included)
  and Prettier on staged files; a commit that breaks lint, the module boundaries,
  or formatting is blocked locally. Don't bypass with `--no-verify` — fix the
  underlying issue.
- **Library READMEs stay current.** Every lib (`libs/**`) has a `README.md`. When
  you change a lib's public API, behavior, or boundaries, update its `README.md`
  in the **same change** — never leave the generated Nx scaffold text behind. A
  lib README should state what the lib is, its public surface (the barrel
  exports), a short usage note, and its Sheriff scope/slice boundaries. This is
  part of the definition of done for any PR touching a lib.

## Development workflow — spec-driven (no GitHub issues)

This repo is built through a spec-first, mostly-autonomous workflow. **There are
no GitHub issues** — a spec file (`docs/specs/NNNN-slug.md`), reviewed and merged
as a PR, is the unit of work. This **supersedes the issue-driven model in
PLAN §5–§6** (the architecture/DoD there remain authoritative).

Five skills drive it (each is self-contained — its mechanics live in its
`SKILL.md`): `/create-spec` → review the spec PR → `/rework-spec` → merge →
`/implement-feature` → review the feature PR → `/rework-feature` → merge →
`/cleanup-feature` (tear down the merged feature's worktree + branch). See
`docs/specs/README.md` for the spec format and status lifecycle. Specialist
subagents (`spec-author`, `spec-reviewer`, `feature-implementer`,
`backend-engineer`, `frontend-engineer`, `infrastructure-engineer`,
`feature-reviewer`, `qa-runner`) carry their own behavior rules.
