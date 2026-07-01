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

// --- Live sources (read once) -----------------------------------------------
const planMarkdown = readFileSync(PLAN_PATH, 'utf8');
const themeScss = readFileSync(THEME_PATH, 'utf8');
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
