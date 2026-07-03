/**
 * TypeScript declarations for the plain-JS ESM generator
 * `tools/scripts/gen-spec-status.mjs` (spec 0058). Declares only the pure,
 * exported public API the Vitest spec imports so the untyped `.mjs` resolves to
 * real types under type-aware ESLint — the impure CLI helpers (runWrite /
 * runCheck / the guarded main) are intentionally NOT part of the surface.
 *
 * TypeScript associates this `.d.mts` with the sibling `.mjs` under the repo's
 * `moduleResolution`, typing `import { … } from './gen-spec-status.mjs'`.
 */

/**
 * A single spec's parsed frontmatter. `number` is coerced to a Number; missing
 * optional `slices`/`scopes` default to `[]`.
 */
export interface SpecEntry {
  number: number;
  slug: string;
  title: string;
  status: string;
  slices: string[];
  scopes: string[];
}

/** The spec-file selector: `docs/specs/NNNN-*.md`. */
export const SPEC_GLOB: string;

/**
 * Strip a trailing `# …` inline comment from a scalar value, unless the `#` sits
 * inside a single- or double-quoted string. Returns the value with any comment
 * removed (NOT yet trimmed). Pure.
 */
export function stripInlineComment(value: string): string;

/**
 * Remove surrounding single/double quotes from a scalar, preserving inner
 * characters (including `:`). A bare (unquoted) value is returned unchanged. Pure.
 */
export function unquoteScalar(value: string): string;

/**
 * Parse a `[a, b, c]` flow-sequence array. Splits the inner list on commas then
 * trims/unquotes each element; does NOT split elements on `:`. Empty `[]` → `[]`.
 * Pure.
 */
export function parseFlowSequence(value: string): string[];

/**
 * Parse the leading `---` YAML frontmatter block of a spec markdown string into a
 * `SpecEntry`. Throws a clear error naming `label` when a required key
 * (`number`/`slug`/`title`/`status`) is absent. Pure.
 */
export function parseSpecFrontmatter(
  markdown: string,
  label?: string,
): SpecEntry;

/**
 * Render the full STATUS.md text from parsed entries. Pure and deterministic:
 * fixed column order, entries sorted ascending by `number`, `\n`-only newlines,
 * trailing newline.
 */
export function renderStatusMarkdown(entries: SpecEntry[]): string;

/**
 * Cross-file integrity guard: throws if two entries share the same
 * `Number(number)` (the error names the duplicate number and both slugs). Pure.
 */
export function assertSpecIntegrity(entries: SpecEntry[]): void;

/**
 * List, read, and parse every spec file matching `SPEC_GLOB` in `specsDir`.
 * Impure (reads the filesystem). Returns entries in a stable order (sorted by
 * basename). Runs `assertSpecIntegrity` over the parsed set.
 */
export function readAllSpecs(specsDir: string): SpecEntry[];
