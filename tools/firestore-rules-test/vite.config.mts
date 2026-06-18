/// <reference types='vitest' />
import { defineConfig } from 'vite';

// DEFAULT vitest config for this project.
//
// The @nx/vitest plugin auto-infers a `test` target from this config, and CI
// runs that target (`nx run-many -t test --all` / `nx affected -t test`) with
// NO Firestore emulator and NO Java. The emulator-backed rules specs live in
// `src/**/*.rules.spec.ts` and MUST NOT be collected here, or they would run
// bare in CI and fail/hang. `passWithNoTests` (set globally in nx.json) only
// short-circuits when ZERO files match `include` — it does not skip files that
// DO match. So this config is deliberately set to match ZERO files:
//   - `include` is a sentinel that no file matches, and
//   - `exclude` additionally rules out `**/*.rules.spec.ts` defensively.
// The rules specs are run ONLY via `vitest.rules.config.mts` under the
// `test-rules` target / `pnpm test:rules` (emulator up). Keep it this way.
export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/tools/firestore-rules-test',
  resolve: { tsconfigPaths: true },
  plugins: [],
  test: {
    name: 'firestore-rules-test',
    watch: false,
    globals: true,
    environment: 'node',
    // Sentinel: matches no file in this project. Do NOT broaden to
    // `src/**/*.spec.ts` — that would collect the emulator-backed rules specs.
    include: ['src/**/__no_default_specs__.spec.ts'],
    exclude: ['**/*.rules.spec.ts', '**/node_modules/**'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/tools/firestore-rules-test',
      provider: 'v8' as const,
    },
  },
}));
