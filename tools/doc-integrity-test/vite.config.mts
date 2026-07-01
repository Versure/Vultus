/// <reference types='vitest' />
import { defineConfig } from 'vite';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/tools/doc-integrity-test',
  resolve: { tsconfigPaths: true },
  plugins: [],
  test: {
    name: 'doc-integrity-test',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/tools/doc-integrity-test',
      provider: 'v8' as const,
    },
  },
}));
