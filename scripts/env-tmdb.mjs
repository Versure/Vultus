/**
 * Copies TMDB_API_KEY from .env.local into apps/mobile/src/environments/environment.ts
 * so `pnpm nx serve mobile` works without manually editing the environment file.
 *
 * Usage: pnpm env:tmdb
 *
 * .env.local must contain a line like:
 *   TMDB_API_KEY=your_key_here
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const envLocalPath = resolve(root, '.env.local');
let envLocal;
try {
  envLocal = readFileSync(envLocalPath, 'utf-8');
} catch {
  console.error(
    'Error: .env.local not found.\nCreate it at the repo root with:\n  TMDB_API_KEY=your_key_here',
  );
  process.exit(1);
}

const match = envLocal.match(/^TMDB_API_KEY=(.+)$/m);
if (!match) {
  console.error('Error: TMDB_API_KEY line not found in .env.local.');
  process.exit(1);
}
const key = match[1].trim().replace(/^["']|["']$/g, '');

const envTsPath = resolve(
  root,
  'apps/mobile/src/environments/environment.ts',
);
const original = readFileSync(envTsPath, 'utf-8');
const patched = original.replace(
  /auth:\s*\{\s*kind:\s*'apiKey' as const,\s*apiKey:\s*'[^']*'\s*\}/,
  `auth: { kind: 'apiKey' as const, apiKey: '${key}' }`,
);

if (patched === original) {
  console.warn(
    'Warning: auth.apiKey pattern not found in environment.ts — file may have already been patched or its format changed.',
  );
} else {
  writeFileSync(envTsPath, patched, 'utf-8');
  console.log(
    'Done: TMDB_API_KEY written to apps/mobile/src/environments/environment.ts',
  );
}
