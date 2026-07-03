import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// tools/scripts -> repo root is two levels up.
const hookAbsPath = join(
  __dirname,
  '../../.claude/hooks/guard-slice-edits.mjs',
);

/**
 * Spawn the guard hook as a real subprocess with the given stdin payload.
 * The hook always exits 0 (fail-open + deny both exit 0), so execFileSync never
 * throws for well-behaved input — a thrown error means the hook crashed
 * (nonzero exit), which is itself a test failure.
 */
function runHook(input) {
  return execFileSync('node', [hookAbsPath], { input, encoding: 'utf8' });
}

/** Build a hook-input JSON payload for an Edit/Write of `filePath`. */
function payload({ filePath, agentId }) {
  const obj = { tool_input: { file_path: filePath } };
  if (agentId !== undefined) obj.agent_id = agentId;
  return JSON.stringify(obj);
}

// A realistic absolute worktree slice path (need not exist on disk).
const WT = 'C:/Projects/Prive/Vultus/Vultus-worktrees/feat-0001-x';

describe('guard-slice-edits hook', () => {
  // (a) Orchestrator (no agent_id) editing a slice file in a feat-* worktree.
  it('denies an orchestrator slice edit in a feature worktree', () => {
    const out = runHook(
      payload({ filePath: `${WT}/libs/some-lib/src/foo.ts` }),
    );
    // The hook literally serializes this field on deny.
    expect(out).toContain('"permissionDecision":"deny"');
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // (b) Subagent (agent_id present) editing the same path → allowed.
  it('allows the same edit when agent_id is present (subagent)', () => {
    const out = runHook(
      payload({
        filePath: `${WT}/libs/some-lib/src/foo.ts`,
        agentId: 'agent_123',
      }),
    );
    expect(out).toBe('');
  });

  // (c) Malformed / absent-object stdin — the regression lock for item 1.
  // If the post-parse object guard is reverted, the `null` case throws a
  // TypeError (nonzero exit), execFileSync throws, and this test fails.
  describe('fails open on malformed / non-object stdin', () => {
    it('null stdin → empty stdout, exit 0 (regression lock)', () => {
      expect(runHook('null')).toBe('');
    });

    it('empty object stdin → empty stdout, exit 0', () => {
      expect(runHook('{}')).toBe('');
    });

    it('genuinely malformed JSON → empty stdout, exit 0', () => {
      expect(runHook('not json')).toBe('');
    });
  });

  // (d) Each exemption class → allowed (no agent_id, in a feat-* worktree, a
  // path that would otherwise be denied).
  describe('allows orchestrator-owned exempt wiring files', () => {
    const exemptRels = [
      'libs/some-lib/src/index.ts', // lib public barrel
      'apps/functions/src/main.ts', // functions registration barrel
      'apps/mobile/src/some.routes.ts', // mobile route registration
      'apps/mobile/src/main.ts', // mobile bootstrap (newly added)
      'apps/mobile/src/app/app.config.ts', // mobile provider reg (newly added)
    ];

    for (const rel of exemptRels) {
      it(`allows ${rel}`, () => {
        const out = runHook(payload({ filePath: `${WT}/${rel}` }));
        expect(out).toBe('');
      });
    }
  });
});
