import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Raw relative ESM import of the generator .mjs. `tools/**` is untagged so
// Sheriff permits it (no barrel, no path alias). The sibling
// `gen-spec-status.d.mts` supplies real types so the type-aware lint rules see
// fully-typed symbols (no `no-unsafe-*`); vitest transpiles + runs the runtime.
import {
  parseSpecFrontmatter,
  renderStatusMarkdown,
  readAllSpecs,
  assertSpecIntegrity,
} from '../../scripts/gen-spec-status.mjs';

/**
 * Ledger freshness guard (spec 0058, task S5a; §8 "Ledger freshness").
 *
 * Verifies the pure parser (comment stripping / quote stripping / flow arrays),
 * the deterministic renderer, and — LIVE — that the committed docs/specs/STATUS.md
 * byte-equals a fresh render of the real spec files. The live freshness assertion
 * is expected RED until the orchestrator's FINAL step (S7) generates STATUS.md
 * after flipping 0058's own status; it is written as a STRICT byte-equality check
 * that must not be weakened.
 */

// Resolve paths relative to THIS spec file (not cwd), per §7 S5a.
// This file lives at tools/doc-integrity-test/src/spec-status-ledger.spec.ts,
// so the workspace root is three levels up.
const here = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(here, '..', '..', '..');
const specsDir = join(workspaceRoot, 'docs', 'specs');
const statusPath = join(specsDir, 'STATUS.md');

describe('parseSpecFrontmatter — core', () => {
  it('extracts number/slug/title/status', () => {
    const md = [
      '---',
      'number: 0058',
      'slug: doc-integrity-guards',
      'title: Deterministic documentation integrity',
      'status: implementing',
      '---',
      '',
      '## Body',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0058-doc-integrity-guards.md');
    expect(parsed.number).toBe(58);
    expect(parsed.slug).toBe('doc-integrity-guards');
    expect(parsed.title).toBe('Deterministic documentation integrity');
    expect(parsed.status).toBe('implementing');
  });

  it('defaults slices/scopes to [] when the keys are absent', () => {
    const md = [
      '---',
      'number: 0003',
      'slug: domain-types',
      'title: Domain types',
      'status: done',
      '---',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0003-domain-types.md');
    expect(parsed.slices).toEqual([]);
    expect(parsed.scopes).toEqual([]);
  });

  it('throws a file-named error on a missing required key (no number)', () => {
    const md = [
      '---',
      'slug: no-number',
      'title: Missing number',
      'status: draft',
      '---',
    ].join('\n');
    expect(() => parseSpecFrontmatter(md, '9999-no-number.md')).toThrow(
      /9999-no-number\.md/,
    );
    expect(() => parseSpecFrontmatter(md, '9999-no-number.md')).toThrow(
      /number/,
    );
  });
});

describe('parseSpecFrontmatter — inline-comment stripping (finding 1a)', () => {
  it('strips a trailing # comment from status', () => {
    const md = [
      '---',
      'number: 0058',
      'slug: doc-integrity-guards',
      'title: Doc integrity',
      'status: approved # draft | approved | implementing | done',
      '---',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0058.md');
    expect(parsed.status).toBe('approved');
    expect(parsed.status).not.toContain('#');
  });

  it('strips a trailing # comment from an empty slices array', () => {
    const md = [
      '---',
      'number: 0058',
      'slug: doc-integrity-guards',
      'title: Doc integrity',
      'status: approved',
      'slices: [] # foundation / tooling',
      '---',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0058.md');
    expect(parsed.slices).toEqual([]);
  });
});

describe('parseSpecFrontmatter — quote stripping (finding 1b)', () => {
  const quotedTitle =
    "'Deterministic documentation integrity: spec-status ledger + CI drift guards'";
  const bareTitle =
    'Deterministic documentation integrity: spec-status ledger + CI drift guards';

  it('strips surrounding single quotes and preserves the inner colon', () => {
    const md = [
      '---',
      'number: 0058',
      'slug: doc-integrity-guards',
      `title: ${quotedTitle}`,
      'status: approved',
      '---',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0058.md');
    expect(parsed.title).toBe(bareTitle);
    expect(parsed.title.startsWith("'")).toBe(false);
    expect(parsed.title.endsWith("'")).toBe(false);
    expect(parsed.title).toContain(':');
  });

  it('yields an identical string for the bare (unquoted) title form', () => {
    const md = [
      '---',
      'number: 0058',
      'slug: doc-integrity-guards',
      `title: ${bareTitle}`,
      'status: approved',
      '---',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0058.md');
    expect(parsed.title).toBe(bareTitle);
  });
});

describe('parseSpecFrontmatter — flow-sequence arrays (finding 1c)', () => {
  it('parses [scope:functions, scope:shared] without splitting elements on ":"', () => {
    const md = [
      '---',
      'number: 0055',
      'slug: some-slice',
      'title: Some slice',
      'status: done',
      'scopes: [scope:functions, scope:shared]',
      '---',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0055-some-slice.md');
    expect(parsed.scopes).toEqual(['scope:functions', 'scope:shared']);
  });

  it('parses an empty [] to []', () => {
    const md = [
      '---',
      'number: 0055',
      'slug: some-slice',
      'title: Some slice',
      'status: done',
      'slices: []',
      '---',
    ].join('\n');
    const parsed = parseSpecFrontmatter(md, '0055-some-slice.md');
    expect(parsed.slices).toEqual([]);
  });
});

describe('renderStatusMarkdown — determinism', () => {
  // Hand-built fixture, intentionally out of number order, with mixed statuses.
  const fixtureEntries = [
    {
      number: 3,
      slug: 'domain-types',
      title: 'Domain types',
      status: 'done',
      slices: [],
      scopes: ['scope:shared'],
    },
    {
      number: 1,
      slug: 'bootstrap-workspace',
      title: 'Bootstrap',
      status: 'done',
      slices: [],
      scopes: [],
    },
    {
      number: 2,
      slug: 'ci-pipeline',
      title: 'CI pipeline',
      status: 'approved',
      slices: [],
      scopes: [],
    },
  ];

  it('sorts ascending by number', () => {
    const out = renderStatusMarkdown(fixtureEntries);
    const iBootstrap = out.indexOf('bootstrap-workspace');
    const iCi = out.indexOf('ci-pipeline');
    const iDomain = out.indexOf('domain-types');
    expect(iBootstrap).toBeGreaterThan(-1);
    expect(iBootstrap).toBeLessThan(iCi);
    expect(iCi).toBeLessThan(iDomain);
  });

  it('has stable columns and a trailing newline', () => {
    const out = renderStatusMarkdown(fixtureEntries);
    expect(out).toContain('| # | slug | title | status | slices | scopes |');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('produces correct per-status counts', () => {
    const out = renderStatusMarkdown(fixtureEntries);
    expect(out).toContain('- done: 2');
    expect(out).toContain('- approved: 1');
    expect(out).toContain('Total specs: 3');
  });

  it('is deterministic — identical input yields byte-identical output', () => {
    expect(renderStatusMarkdown(fixtureEntries)).toBe(
      renderStatusMarkdown(fixtureEntries),
    );
  });
});

describe('Numbering integrity — filename↔number guard (spec 0066)', () => {
  const mdWithNumber = (n: string) =>
    [
      '---',
      `number: ${n}`,
      'slug: some-slug',
      'title: Some spec',
      'status: draft',
      '---',
    ].join('\n');

  it('(a) throws when frontmatter number disagrees with the filename NNNN', () => {
    // 0046-… file carrying `number: 43` — the exact landed collision shape.
    const md = mdWithNumber('0043');
    expect(() =>
      parseSpecFrontmatter(md, '0046-watchlist-sort-filter.md'),
    ).toThrow(/0046-watchlist-sort-filter\.md/);
  });

  it('(a2) does NOT throw for a correct but UNPADDED number (numeric compare)', () => {
    // `0042-notifications-inbox.md` legitimately carries `number: 42`; a
    // padded-string compare ("42" === "0042") would spuriously fail here.
    const md = mdWithNumber('42');
    expect(() =>
      parseSpecFrontmatter(md, '0042-notifications-inbox.md'),
    ).not.toThrow();
  });

  it('skips the filename check when the label has no leading 4-digit prefix', () => {
    // Default `<spec>` label / non-filename callers: number mismatch is NOT a
    // filename mismatch, so no throw from this guard.
    const md = mdWithNumber('7');
    expect(() => parseSpecFrontmatter(md, '<spec>')).not.toThrow();
  });
});

describe('Numbering integrity — cross-file uniqueness guard (spec 0066)', () => {
  const entry = (number: number, slug: string) => ({
    number,
    slug,
    title: `Spec ${slug}`,
    status: 'done',
    slices: [],
    scopes: [],
  });

  it('(b) throws when two entries share the same Number(number)', () => {
    const entries = [
      entry(43, 'fix-media-type-hint-navigation'),
      entry(43, 'watchlist-sort-filter'),
    ];
    expect(() => assertSpecIntegrity(entries)).toThrow(/43/);
    expect(() => assertSpecIntegrity(entries)).toThrow(/watchlist-sort-filter/);
  });

  it('does not throw when every number is unique', () => {
    const entries = [entry(43, 'a'), entry(46, 'b'), entry(66, 'c')];
    expect(() => assertSpecIntegrity(entries)).not.toThrow();
  });
});

describe('Numbering integrity — real docs/specs tree (spec 0066)', () => {
  // (c) The live tree must parse without a filename↔number mismatch or a
  // duplicate-number collision. This is EXPECTED RED until a sibling task fixes
  // `0046-watchlist-sort-filter.md` (which currently carries `number: 0043`,
  // colliding with 0043) — the guard catching the live collision is the point.
  it('readAllSpecs over docs/specs passes the integrity guards', () => {
    expect(() => readAllSpecs(specsDir)).not.toThrow();
  });
});

describe('Ledger freshness (LIVE)', () => {
  // STRICT byte-equality against the committed ledger. Resolved relative to this
  // spec file (not cwd) so it is location-independent. This assertion is EXPECTED
  // RED until the orchestrator's FINAL step (S7) generates docs/specs/STATUS.md
  // after flipping spec 0058's own status. It must NOT be weakened to tolerate a
  // missing file: readFileSync throwing on the absent STATUS.md is the correct
  // red signal now, and this becomes green once S7 commits the fresh ledger.
  it('committed docs/specs/STATUS.md byte-equals a fresh render of the real specs', () => {
    const committed = readFileSync(statusPath, 'utf8');
    const fresh = renderStatusMarkdown(readAllSpecs(specsDir));
    expect(committed).toBe(fresh);
  });
});

describe('Staleness proof (finding, §8) — in-memory, no live file', () => {
  // Prove the --check/freshness comparison would FAIL if someone forgot to
  // regenerate: render a "committed-style" baseline, then render again from the
  // SAME entry list with ONE mutated field, and assert the two strings DIFFER.
  // Uses only in-memory fixtures so it does not depend on the live STATUS.md.
  const baseEntries = [
    {
      number: 1,
      slug: 'bootstrap-workspace',
      title: 'Bootstrap',
      status: 'done',
      slices: [],
      scopes: [],
    },
    {
      number: 2,
      slug: 'ci-pipeline',
      title: 'CI pipeline',
      status: 'approved',
      slices: [],
      scopes: [],
    },
  ];

  it('a flipped status makes the rendered ledger differ', () => {
    const committedStyle = renderStatusMarkdown(baseEntries);
    const mutated = baseEntries.map((e) =>
      e.number === 2 ? { ...e, status: 'implementing' } : e,
    );
    const staleRender = renderStatusMarkdown(mutated);
    expect(staleRender).not.toBe(committedStyle);
  });
});
