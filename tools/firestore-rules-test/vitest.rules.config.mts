/// <reference types='vitest' />
import { defineConfig } from 'vite';

// EMULATOR-ONLY vitest config for the Firestore security-rules tests.
//
// This config is the ONLY one whose `include` matches the `*.rules.spec.ts`
// pattern. It is invoked exclusively by the `test-rules` Nx target /
// `pnpm test:rules`, which wraps it in `firebase emulators:exec --only
// firestore "..."` so the Firestore emulator is up (and FIRESTORE_EMULATOR_HOST
// is set) for the duration. It is deliberately NOT the auto-inferred `test`
// target, so the bare `nx test` graph (CI) never runs these specs.
export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/tools/firestore-rules-test-rules',
  resolve: { tsconfigPaths: true },
  plugins: [],
  test: {
    name: 'firestore-rules-test:rules',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.rules.spec.ts'],
    reporters: ['default'],
  },
}));
