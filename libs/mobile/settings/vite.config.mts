/// <reference types='vitest' />
import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../../node_modules/.vite/libs/mobile/settings',
  plugins: [angular(), nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
  test: {
    name: 'mobile-settings',
    watch: false,
    globals: true,
    environment: 'jsdom',
    // Ionic/Stencil ship `.js` files that are ESM but live in CommonJS-typed
    // packages, which trips Vitest's SSR module loader. Inline them so Vite
    // transforms them as ESM (mirrors apps/mobile).
    server: {
      deps: {
        inline: [/@ionic/, /@stencil\/core/, /ionicons/],
      },
    },
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    setupFiles: ['src/test-setup.ts'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../../coverage/libs/mobile/settings',
      provider: 'v8' as const,
    },
  },
}));
