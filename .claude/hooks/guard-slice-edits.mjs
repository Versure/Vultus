#!/usr/bin/env node
/**
 * PreToolUse guard (Edit|Write) — enforces the implement-feature orchestrator
 * boundary: the orchestrator (main thread) must NOT hand-author slice source or
 * test files inside a feature worktree. That work goes to a specialist subagent
 * (backend/frontend/feature-implementer), which is exactly what implement-feature
 * orchestrates. This makes the "route through an agent" rule mechanical instead
 * of relying on the model to remember it (the failure that shipped spec 0047's
 * code without an independent implementer/review pass).
 *
 * How it discriminates orchestrator vs. agent: PreToolUse fires for BOTH, but the
 * hook input carries `agent_id` ONLY inside a subagent. Absent => main thread =>
 * the orchestrator => deny slice edits. Present => a specialist => allow.
 *
 * Scope: only fires for edits whose target lives in a `*-worktrees/{feat,spec}-*`
 * worktree (where implement-feature/rework-feature run). Edits in the primary
 * checkout, or to non-slice paths, are never touched here.
 *
 * Fail-OPEN: any parse/shape surprise allows the edit. A broken guard must never
 * brick the workflow — it should under-block, not over-block.
 */
import { readFileSync } from 'node:fs';

function allow() {
  // No output + exit 0 => defer to normal permission flow.
  process.exit(0);
}

function deny(relPath, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  allow(); // unreadable/malformed stdin — fail open
}

// Subagent calls carry agent_id; the orchestrator's do not. Only the
// orchestrator is constrained here.
if (input.agent_id) allow();

const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || filePath.length === 0) allow();

const norm = filePath.replace(/\\/g, '/');

// Only guard inside a feature/spec worktree: ".../<name>-worktrees/feat-…/<rel>"
const wt = norm.match(/-worktrees\/(?:feat|spec)-[^/]+\/(.+)$/);
if (!wt) allow();
const rel = wt[1];

// Slice source/tests: libs/**/src/** or apps/**/src/**.
const isSliceFile =
  /^libs\/.+\/src\/.+/.test(rel) || /^apps\/.+\/src\/.+/.test(rel);
if (!isSliceFile) allow();

// Allowlist: files the orchestrator legitimately owns per the skill's
// concurrency model (registration barrels + apps/* export/route registration).
// These are tiny wiring edits, not slice implementation. NOTE: logic that leaks
// into an exempt file (e.g. business code in apps/functions/src/main.ts) is NOT
// caught here by design — the enforced feature-reviewer pass is its backstop.
const isExempt =
  /\/src\/index\.ts$/.test(rel) || // lib public barrel
  rel === 'apps/functions/src/main.ts' || // functions export/registration barrel
  /^apps\/mobile\/src\/.*\.routes\.ts$/.test(rel); // mobile route registration
if (isExempt) allow();

deny(
  rel,
  `Blocked: the implement-feature orchestrator must not hand-author slice files ` +
    `(${rel}) in a feature worktree. Route this to a specialist subagent ` +
    `(backend-engineer / frontend-engineer / feature-implementer) per ` +
    `.claude/skills/implement-feature/SKILL.md Step 4. If a specialist keeps ` +
    `failing, halt the slice as needs-human — do not implement it by hand.`,
);
