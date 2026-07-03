import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * PLAN-vs-theme hex guard (spec 0058 deliverable 2, task S5b; §8 test plan).
 *
 * Asserts that the structured design-token table in docs/PLAN.md §2 (under the
 * "### Design reference (Stitch)" bullet) agrees, hex-for-hex, with the
 * `--vultus-*` CSS custom properties in libs/shared/ui-kit/src/lib/theme.scss
 * — theme.scss is the runtime source of truth (CLAUDE.md). This reproduces and
 * permanently guards against the real bug where PLAN §2 said primary was
 * `#10B981` while theme.scss (correctly) says `#4edea3`.
 *
 * The guard reads the REAL files off disk (paths resolved relative to this spec
 * file via import.meta.url, NOT cwd) and keys each PLAN token to its mapped
 * theme.scss var per the §8 contract below. Hex compares are case-insensitive
 * (PLAN historically used uppercase, theme.scss uses lowercase) — both sides are
 * normalized to lower-case before comparison. A missing token on either side is
 * a FAILURE (no silent no-op), so renaming a var or dropping a PLAN row surfaces
 * as red drift rather than a silently-skipped assertion.
 */

// --- File locations (resolved from this spec file, not cwd) -----------------
const here = dirname(fileURLToPath(import.meta.url)); // tools/doc-integrity-test/src
const workspaceRoot = join(here, '..', '..', '..');
const PLAN_PATH = join(workspaceRoot, 'docs', 'PLAN.md');
const THEME_PATH = join(
  workspaceRoot,
  'libs',
  'shared',
  'ui-kit',
  'src',
  'lib',
  'theme.scss',
);
const CLAUDE_MD_PATH = join(workspaceRoot, 'CLAUDE.md');
const FRONTEND_ENGINEER_MD_PATH = join(
  workspaceRoot,
  '.claude',
  'agents',
  'frontend-engineer.md',
);
const SPEC_AUTHOR_MD_PATH = join(
  workspaceRoot,
  '.claude',
  'agents',
  'spec-author.md',
);

/**
 * The guard's contract: each PLAN §2 token → its theme.scss `--vultus-*` var.
 * theme.scss is the source of truth; the `expected` hex is documented here only
 * as a sanity anchor for readers — the live assertion is PLAN-hex === theme-hex,
 * not against these literals (so a legitimate theme.scss change flows through
 * without editing this list, as long as PLAN is kept in sync).
 */
const MAPPING: readonly {
  token: string;
  themeVar: string;
  expected: string;
}[] = [
  { token: 'primary', themeVar: '--vultus-primary', expected: '#4edea3' },
  {
    token: 'primary-container',
    themeVar: '--vultus-primary-container',
    expected: '#10b981',
  },
  { token: 'background', themeVar: '--vultus-surface', expected: '#0b1326' },
  {
    token: 'surface-container',
    themeVar: '--vultus-surface-container',
    expected: '#171f33',
  },
  {
    token: 'surface-highest',
    themeVar: '--vultus-surface-container-highest',
    expected: '#2d3449',
  },
  {
    token: 'on-surface',
    themeVar: '--vultus-on-surface',
    expected: '#dae2fd',
  },
  {
    token: 'status-watching',
    themeVar: '--vultus-status-watching',
    expected: '#3b82f6',
  },
  {
    token: 'status-completed',
    themeVar: '--vultus-status-completed',
    expected: '#10b981',
  },
  {
    token: 'status-dropped',
    themeVar: '--vultus-status-dropped',
    expected: '#ef4444',
  },
  {
    token: 'status-planned',
    themeVar: '--vultus-status-planned',
    expected: '#94a3b8',
  },
];

// --- Pure parsers -----------------------------------------------------------

/**
 * Pure. Parses the PLAN §2 design-token markdown table into { token: hex }.
 *
 * Only matches rows shaped `| <token> | \`#hex\` |` — the two-column table with
 * a backtick-wrapped hex in the second column. The header row (`| Token | Hex |`)
 * and the `| --- | --- |` separator row do not contain a backtick-wrapped hex,
 * so they are naturally ignored. Tolerant of surrounding whitespace and any
 * hex length (3/4/6/8 chars).
 */
export function parsePlanTokenTable(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Rows are indented under a bullet in PLAN §2, so allow leading whitespace
  // after the line start before the opening pipe.
  const rowRe =
    /^[ \t]*\|\s*([a-z][a-z0-9-]*)\s*\|\s*`(#[0-9a-fA-F]+)`\s*\|/gim;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(markdown)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * Pure. Parses `--vultus-NAME: #hex;` declarations from theme.scss into
 * { '--vultus-NAME': '#hex' }. Only bare hex literals are captured (var()
 * / color-mix() values are skipped, which is correct — every var in the
 * mapping is a bare hex).
 */
export function parseThemeVars(scss: string): Record<string, string> {
  const out: Record<string, string> = {};
  const declRe = /(--vultus-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]+)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(scss)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * Pure. Extracts every `#rgb` / `#rrggbb` / `#rrggbbaa` hex literal found
 * anywhere in a markdown/prose string. Unlike parsePlanTokenTable (which only
 * matches PLAN §2 table rows), this is format-agnostic: it finds hexes embedded
 * in free prose (e.g. CLAUDE.md's anti-confusion note). Results are lowercased
 * and de-duplicated so the caller sees each distinct color once.
 *
 * Matches only 3/6/8-char hex lengths (the valid CSS color-literal lengths),
 * bounded so a longer hex run isn't partially captured. Backtick-wrapping (as
 * used in the prose, `` `#4edea3` ``) is irrelevant — the `#hex` inside is still
 * matched.
 */
export function parseProseHexes(markdown: string): string[] {
  const hexRe = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(markdown)) !== null) {
    seen.add(`#${m[1].toLowerCase()}`);
  }
  return [...seen];
}

// --- Live sources (read once) -----------------------------------------------
const planMarkdown = readFileSync(PLAN_PATH, 'utf8');
const themeScss = readFileSync(THEME_PATH, 'utf8');
const claudeMd = readFileSync(CLAUDE_MD_PATH, 'utf8');
const frontendEngineerMd = readFileSync(FRONTEND_ENGINEER_MD_PATH, 'utf8');
const specAuthorMd = readFileSync(SPEC_AUTHOR_MD_PATH, 'utf8');
const planTokens = parsePlanTokenTable(planMarkdown);
const themeVars = parseThemeVars(themeScss);

// --- Tests ------------------------------------------------------------------

describe('PLAN §2 token table ↔ theme.scss --vultus-* vars', () => {
  it('parses at least the mapped tokens from the real PLAN §2 table', () => {
    // Sanity: the parser found a table, not zero rows (would indicate a
    // reformatted/unparseable PLAN table rather than a genuine drift).
    expect(Object.keys(planTokens).length).toBeGreaterThanOrEqual(
      MAPPING.length,
    );
  });

  it('parses the mapped --vultus-* vars from the real theme.scss', () => {
    expect(Object.keys(themeVars).length).toBeGreaterThanOrEqual(
      MAPPING.length,
    );
  });

  describe('every mapped token is present in BOTH sources (no silent no-op)', () => {
    for (const { token, themeVar } of MAPPING) {
      it(`PLAN table has "${token}"`, () => {
        expect(
          Object.prototype.hasOwnProperty.call(planTokens, token),
          `token "${token}" missing from PLAN §2 table — a dropped/renamed row must fail, not silently skip`,
        ).toBe(true);
      });

      it(`theme.scss has "${themeVar}"`, () => {
        expect(
          Object.prototype.hasOwnProperty.call(themeVars, themeVar),
          `var "${themeVar}" missing from theme.scss — a renamed var must fail, not silently skip`,
        ).toBe(true);
      });
    }
  });

  describe('live equality: PLAN hex === theme.scss hex (case-insensitive)', () => {
    for (const { token, themeVar } of MAPPING) {
      it(`${token} (${themeVar})`, () => {
        const planHex = planTokens[token];
        const themeHex = themeVars[themeVar];
        // Guard against undefined silently comparing equal-to-equal: both must
        // be present (covered above too, asserted here so this test can't pass
        // on undefined === undefined).
        expect(planHex, `PLAN token "${token}" not found`).toBeDefined();
        expect(themeHex, `theme var "${themeVar}" not found`).toBeDefined();
        expect(planHex.toLowerCase()).toBe(themeHex.toLowerCase());
      });
    }
  });

  it('mismatch proof (§8): the OLD wrong primary #10B981 in PLAN fails the compare', () => {
    // Reproduce today's real bug against an in-string fixture (never edit the
    // real PLAN.md): a copy of a PLAN-shaped table with `primary` set to the
    // old wrong value #10B981. The pure parser + the same case-insensitive
    // compare against theme.scss's --vultus-primary must FAIL for `primary`.
    const brokenPlanTable = [
      '| Token             | Hex       |',
      '| ----------------- | --------- |',
      '| primary           | `#10B981` |', // <- the historical bug
      '| primary-container | `#10b981` |',
      '| background        | `#0b1326` |',
    ].join('\n');

    const brokenTokens = parsePlanTokenTable(brokenPlanTable);
    const brokenPrimary = brokenTokens.primary;
    const themePrimary = themeVars['--vultus-primary'];

    // The parser must actually have read the fixture (not a silent no-op).
    expect(brokenPrimary).toBe('#10B981');
    expect(themePrimary).toBeDefined();

    // The guard's comparison would flag this as drift.
    expect(brokenPrimary.toLowerCase()).not.toBe(themePrimary.toLowerCase());
  });

  it('sanity: the correctly-formed real PLAN primary matches theme (regression anchor)', () => {
    expect(planTokens.primary?.toLowerCase()).toBe(
      themeVars['--vultus-primary']?.toLowerCase(),
    );
  });
});

/**
 * CLAUDE.md prose-hex guard (spec 0071 cluster 3, task T7).
 *
 * Cluster 3 trimmed the hand-reprinted design palette in CLAUDE.md and
 * frontend-engineer.md down to token NAMES, keeping in CLAUDE.md only TWO
 * deliberate hex literals as an anti-confusion note: primary is emerald
 * `#4edea3` and `#10B981` is `primary-container` (NOT primary). Those two hexes
 * live in prose, so parsePlanTokenTable (table-row-only) can't guard them. This
 * block guards them with the prose-hex extractor against theme.scss — the
 * runtime source of truth — so a future theme change that leaves CLAUDE.md
 * stale fails CI, and a re-introduced palette dump surfaces.
 */
describe('CLAUDE.md prose hexes ↔ theme.scss', () => {
  // The set of legitimate theme hex VALUES (lowercased), from --vultus-* vars.
  const themeHexValues = new Set(
    Object.values(themeVars).map((h) => h.toLowerCase()),
  );

  it('found the deliberate anti-confusion hexes in the real CLAUDE.md', () => {
    // Sanity: the extractor actually read the note (not a silent no-op after a
    // reformat that removed the hexes entirely).
    expect(parseProseHexes(claudeMd).length).toBeGreaterThanOrEqual(1);
  });

  it('no-stale-hex: every hex in CLAUDE.md is a current theme.scss value', () => {
    for (const hex of parseProseHexes(claudeMd)) {
      expect(
        themeHexValues.has(hex),
        `CLAUDE.md contains hex "${hex}" which is NOT a --vultus-* value in theme.scss — it has drifted from the theme (or a raw palette hex was re-introduced). Use a token name, or update the anti-confusion note to the current theme value.`,
      ).toBe(true);
    }
  });

  it('deliberate note present & fresh: CLAUDE.md contains the current primary AND primary-container hexes', () => {
    const primary = themeVars['--vultus-primary']?.toLowerCase();
    const primaryContainer =
      themeVars['--vultus-primary-container']?.toLowerCase();
    // Both must exist in theme.scss for this assertion to be meaningful.
    expect(primary, '--vultus-primary missing from theme.scss').toBeDefined();
    expect(
      primaryContainer,
      '--vultus-primary-container missing from theme.scss',
    ).toBeDefined();

    const claudeHexes = parseProseHexes(claudeMd);
    expect(
      claudeHexes,
      `CLAUDE.md anti-confusion note must cite the current --vultus-primary "${primary}" — if the theme's primary changed, CLAUDE.md must be updated too`,
    ).toContain(primary);
    expect(
      claudeHexes,
      `CLAUDE.md anti-confusion note must cite the current --vultus-primary-container "${primaryContainer}" — if the theme changed, CLAUDE.md must be updated too`,
    ).toContain(primaryContainer);
  });

  it('sanity: CLAUDE.md keeps only a small handful of hexes (no re-introduced dump)', () => {
    const count = parseProseHexes(claudeMd).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(
      count,
      `CLAUDE.md now has ${count} distinct hexes — expected at most the deliberate primary/primary-container note (≤4). A palette dump was likely re-introduced; trim to token names.`,
    ).toBeLessThanOrEqual(4);
  });

  it('defensive sweep: any hex in frontend-engineer.md must match theme.scss (should be none)', () => {
    // Cluster 3 trimmed frontend-engineer.md to ZERO hexes. An empty list
    // trivially passes; if anyone re-adds a hex, it must be a real theme value.
    for (const hex of parseProseHexes(frontendEngineerMd)) {
      expect(
        themeHexValues.has(hex),
        `.claude/agents/frontend-engineer.md contains hex "${hex}" which is NOT a --vultus-* value in theme.scss — it should use token names; if a hex is required it must match the theme.`,
      ).toBe(true);
    }
  });

  it('defensive sweep: any hex in spec-author.md must match theme.scss', () => {
    // spec-author.md keeps the same deliberate primary/primary-container
    // anti-confusion note (out of cluster 3's trim scope), so its hexes are
    // guarded here against theme drift rather than left unguarded — DoD:
    // "hexes only in guarded locations".
    for (const hex of parseProseHexes(specAuthorMd)) {
      expect(
        themeHexValues.has(hex),
        `.claude/agents/spec-author.md contains hex "${hex}" which is NOT a --vultus-* value in theme.scss — it has drifted from the theme; use a token name or update it to the current theme value.`,
      ).toBe(true);
    }
  });

  it('mismatch proof (§8-style): a STALE CLAUDE-shaped note fails the no-stale-hex compare', () => {
    // Never edit real files: reproduce the drift bug against an in-string
    // fixture — a CLAUDE-shaped anti-confusion note whose "primary" was left at
    // the old wrong slate `#0f172a` (never a --vultus-* value). The same
    // extractor + set-membership check the live guard uses must FLAG it.
    const staleClaudeNote = [
      'Design language: dark-first, Inter, primary Emerald `#0f172a` (note:',
      '`#10b981` is `primary-container`, **not** primary).',
    ].join('\n');

    const staleHexes = parseProseHexes(staleClaudeNote);
    // The extractor must actually have read the fixture (not a silent no-op).
    expect(staleHexes).toContain('#0f172a');

    // The guard would flag the stale primary as drift (not a theme value)...
    expect(themeHexValues.has('#0f172a')).toBe(false);
    // ...while the still-correct primary-container in the same note passes.
    expect(themeHexValues.has('#10b981')).toBe(true);
  });
});
