/**
 * Spec-status ledger generator + freshness guard (spec 0058).
 *
 * Renders a committed, always-fresh `docs/specs/STATUS.md` from the leading YAML
 * frontmatter of every `docs/specs/NNNN-*.md` spec — a machine-generated index of
 * every spec's number/slug/title/status/slices/scopes. It exists because project
 * state otherwise lives across ~57 spec files that must be opened by hand.
 *
 * The parser is deliberately NOT a naive `split(':')[1].trim()`: that corrupts
 * the ledger, and because `--check` compares a committed render to a fresh render
 * from the SAME parser, corruption is byte-identical on both sides and the
 * freshness guard stays GREEN while the data is wrong. So the scalar parse (a)
 * strips trailing `# …` inline comments (unless the `#` is inside a quoted
 * string), (b) unquotes single/double-quoted scalars while preserving an inner
 * `:` (split on the FIRST `key:` colon only), and (c) parses `[a, b]`
 * flow-sequence arrays whose elements may contain `:` (`scope:functions`).
 *
 * Style modeled on tools/scripts/inject-mobile-env.mjs (ESM, numbered helpers,
 * synchronous fs, ok()/fail() helpers, pure functions exported for test). The
 * main entry point is guarded by an
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check so a Vitest
 * import of the pure helpers does NOT run the script against the real cwd.
 *
 * Windows/PowerShell-safe: node:path join (no hard-coded `/`), node:url
 * pathToFileURL for the CLI guard, and `\n`-only newlines so `--check` is
 * byte-exact regardless of the checkout's autocrlf.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The spec-file selector: `docs/specs/NNNN-*.md`. Basename must match
// `/^\d{4}-.*\.md$/`; `README.md` and `STATUS.md` are excluded.
export const SPEC_GLOB = 'docs/specs/NNNN-*.md';

const SPEC_BASENAME_RE = /^\d{4}-.*\.md$/;

// Column order for the rendered table — fixed for deterministic output.
const COLUMNS = ['#', 'slug', 'title', 'status', 'slices', 'scopes'];

// Placeholder for an empty array field in the rendered table.
const EMPTY_CELL = '—';

// The exact staleness hint the CLI prints on a `--check` mismatch. The vitest
// ledger guard and the pre-commit hook depend on this exact text.
const STALE_HINT = 'run `node tools/scripts/gen-spec-status.mjs` to update';

const ok = (msg) => console.log(`  ✓ ${msg}`);
function fail(msg) {
  console.error(`\n✗ gen-spec-status failed: ${msg}\n`);
  process.exit(1);
}

/**
 * Strip a trailing `# …` inline comment from a scalar value, unless the `#` sits
 * inside a single- or double-quoted string. Returns the value with any comment
 * removed (NOT yet trimmed). Pure.
 */
export function stripInlineComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      // A `#` starting or preceded by whitespace, outside quotes, is a comment.
      if (i === 0 || /\s/.test(value[i - 1])) {
        return value.slice(0, i);
      }
    }
  }
  return value;
}

/**
 * Remove surrounding single/double quotes from a scalar, preserving inner
 * characters (including `:`). A bare (unquoted) value is returned unchanged.
 * Pure — input should already be trimmed with comments stripped.
 */
export function unquoteScalar(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a `[a, b, c]` flow-sequence array. Splits the inner list on commas then
 * trims each element; does NOT split elements on `:` (so `scope:functions` stays
 * intact). An empty `[]` (comments already stripped upstream) yields `[]`. Pure.
 */
export function parseFlowSequence(value) {
  const inner = value.slice(value.indexOf('[') + 1, value.lastIndexOf(']'));
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((el) => unquoteScalar(el.trim()))
    .filter((el) => el.length > 0);
}

/**
 * Interpret a raw frontmatter scalar (comment-stripped, trimmed): a `[...]` flow
 * sequence becomes an array; anything else is unquoted to a string. Pure.
 */
function parseScalarOrArray(value) {
  if (value.startsWith('[')) return parseFlowSequence(value);
  return unquoteScalar(value);
}

/**
 * Parse the leading `---` YAML frontmatter block of a spec markdown string into
 * `{ number, slug, title, status, slices, scopes }`. PURE.
 *
 * `number` is coerced to a Number (the ledger sorts ascending by it). Missing
 * optional `slices`/`scopes` default to `[]`. Throws a clear error NAMING the
 * file (`label`, an optional filename for the message) when a required key
 * (`number`/`slug`/`title`/`status`) is absent.
 */
export function parseSpecFrontmatter(markdown, label = '<spec>') {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!match) {
    throw new Error(
      `${label}: no leading \`---\` YAML frontmatter block found`,
    );
  }

  const raw = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    // (a) strip inline comment, then trim; (b)/(c) interpret quotes/arrays.
    const valuePart = stripInlineComment(line.slice(colon + 1)).trim();
    raw[key] = parseScalarOrArray(valuePart);
  }

  for (const required of ['number', 'slug', 'title', 'status']) {
    if (raw[required] === undefined || raw[required] === '') {
      throw new Error(
        `${label}: missing required frontmatter key \`${required}\``,
      );
    }
  }

  return {
    number: Number(raw.number),
    slug: String(raw.slug),
    title: String(raw.title),
    status: String(raw.status),
    slices: Array.isArray(raw.slices) ? raw.slices : [],
    scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
  };
}

/**
 * Render an array field for the table cell: comma-joined, empty → EMPTY_CELL.
 * Pure.
 */
function renderList(values) {
  return values.length ? values.join(', ') : EMPTY_CELL;
}

/**
 * Escape a value for a markdown table cell: normalize `|` and stray newlines so
 * the table stays valid. Pure.
 */
function escapeCell(value) {
  return String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Render the full STATUS.md text from parsed entries. PURE. Deterministic: fixed
 * column order, entries sorted ascending by `number` (stable), `\n`-only
 * newlines, trailing newline. Includes a generated-file banner and a per-status
 * count summary. `--check` diffs are byte-exact off this.
 */
export function renderStatusMarkdown(entries) {
  // Stable ascending sort by number (Array.prototype.sort is stable in V8).
  const sorted = [...entries].sort((a, b) => a.number - b.number);

  const lines = [];

  // 1. Generated-file banner.
  lines.push('<!--');
  lines.push('  GENERATED FILE — DO NOT HAND-EDIT.');
  lines.push('');
  lines.push('  This ledger is generated from every docs/specs/NNNN-*.md spec');
  lines.push(
    '  frontmatter by tools/scripts/gen-spec-status.mjs. To refresh it,',
  );
  lines.push(
    '  run `node tools/scripts/gen-spec-status.mjs`. A stale ledger is',
  );
  lines.push(
    '  caught by `node tools/scripts/gen-spec-status.mjs --check` (the',
  );
  lines.push('  pre-commit hook + the CI `nx test` gate).');
  lines.push('-->');
  lines.push('');
  lines.push('# Spec status ledger');
  lines.push('');

  // 2. Per-status count summary (statuses ordered by first appearance in the
  // sorted list, so the summary is deterministic).
  const counts = new Map();
  for (const entry of sorted) {
    counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  }
  lines.push(`Total specs: ${sorted.length}`);
  lines.push('');
  for (const [status, count] of counts) {
    lines.push(`- ${escapeCell(status)}: ${count}`);
  }
  lines.push('');

  // 3. The table, fixed column order.
  lines.push(`| ${COLUMNS.join(' | ')} |`);
  lines.push(`| ${COLUMNS.map(() => '---').join(' | ')} |`);
  for (const entry of sorted) {
    const cells = [
      String(entry.number),
      escapeCell(entry.slug),
      escapeCell(entry.title),
      escapeCell(entry.status),
      escapeCell(renderList(entry.slices)),
      escapeCell(renderList(entry.scopes)),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  // Trailing newline; `\n`-only join.
  return lines.join('\n') + '\n';
}

/**
 * List, read, and parse every spec file matching SPEC_GLOB in `specsDir`. Impure
 * (reads the filesystem). Returns entries in a stable order (sorted by basename),
 * each parsed through `parseSpecFrontmatter` with the filename as the error label.
 */
export function readAllSpecs(specsDir) {
  const files = readdirSync(specsDir)
    .filter((name) => SPEC_BASENAME_RE.test(name))
    .sort();
  return files.map((name) => {
    const markdown = readFileSync(join(specsDir, name), 'utf8');
    return parseSpecFrontmatter(markdown, name);
  });
}

const STATUS_RELATIVE = join('docs', 'specs', 'STATUS.md');

/** The default flow: render from the real specs and write STATUS.md. */
function runWrite(root) {
  const specsDir = resolve(root, 'docs', 'specs');
  const entries = readAllSpecs(specsDir);
  const content = renderStatusMarkdown(entries);
  const outPath = resolve(root, STATUS_RELATIVE);
  writeFileSync(outPath, content, 'utf8');
  ok(`wrote ${STATUS_RELATIVE} (${entries.length} spec(s))`);
  console.log(`\ngen-spec-status: ${outPath}`);
}

/**
 * `--check`: regenerate in-memory and compare to the committed STATUS.md. Exits
 * non-zero on any difference (printing the exact staleness hint); exits 0 when
 * byte-equal. Committed content is normalized to `\n` before comparing so an
 * autocrlf checkout does not produce a false mismatch.
 */
function runCheck(root) {
  const specsDir = resolve(root, 'docs', 'specs');
  const entries = readAllSpecs(specsDir);
  const fresh = renderStatusMarkdown(entries);
  const outPath = resolve(root, STATUS_RELATIVE);
  let committed;
  try {
    committed = readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    fail(`${STATUS_RELATIVE} is missing — ${STALE_HINT}`);
    return;
  }
  if (committed !== fresh) {
    fail(`${STATUS_RELATIVE} is stale — ${STALE_HINT}`);
  }
  ok(`${STATUS_RELATIVE} is fresh (${entries.length} spec(s))`);
  console.log('\ngen-spec-status: ledger is up to date.');
}

// Guarded main entry — does NOT run when this module is imported (e.g. Vitest).
// `process.argv[1]` may be a relative or platform path (backslashes on Windows);
// `pathToFileURL` normalizes it to a comparable absolute file:// URL. Mode is
// detected via `--check`; any extra positional args (lint-staged appends staged
// filenames after the flag) are IGNORED — the check always covers the whole
// ledger.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = process.cwd();
  if (process.argv.includes('--check')) {
    runCheck(root);
  } else {
    runWrite(root);
  }
}
