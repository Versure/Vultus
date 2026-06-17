import { ESLint } from 'eslint';
import sheriff from '@softarc/eslint-plugin-sheriff';
import tseslint from 'typescript-eslint';
import { join } from 'node:path';

/**
 * PERMANENT Sheriff guard (PLAN §6 task 2, spec 0001 "negative test").
 *
 * Programmatically runs ESLint with the Sheriff plugin over the planted
 * `scope:mobile -> scope:functions` fixture and asserts the boundary rule
 * reports at least one violation. We assert on the rule ID, never the
 * human-readable message text, so an @softarc upgrade that rewords the message
 * does not break this test (spec Risks + PLAN §9).
 *
 * The fixture is excluded from production lint/build, so default `nx lint` /
 * `nx build` stay green — only this test exercises it.
 */
const SHERIFF_RULE_ID = '@softarc/sheriff/dependency-rule';
const workspaceRoot = join(__dirname, '..', '..', '..');
const fixture = join(
  workspaceRoot,
  'tools',
  'sheriff-fixtures',
  'mobile-side',
  'illegal-cross-scope-import.ts',
);

function createESLint(): ESLint {
  return new ESLint({
    // Run against the workspace root so Sheriff finds sheriff.config.ts and
    // resolves the fixture's tags exactly as production lint would.
    cwd: workspaceRoot,
    // Bypass the root eslint.config.mjs (which intentionally ignores the
    // fixture) and apply only the Sheriff dependency-rule here. A `files` glob
    // and the TypeScript parser are required so ESLint flat config actually
    // lints the .ts fixture instead of skipping it.
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { '@softarc/sheriff': sheriff },
        rules: { [SHERIFF_RULE_ID]: 'error' },
      },
    ],
  });
}

describe('Sheriff module boundaries', () => {
  it('reports a dependency-rule violation for scope:mobile -> scope:functions', async () => {
    const eslint = createESLint();
    const results = await eslint.lintFiles([fixture]);

    const sheriffMessages = results
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === SHERIFF_RULE_ID);

    expect(sheriffMessages.length).toBeGreaterThan(0);
  });
});
