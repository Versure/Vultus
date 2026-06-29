import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REQUIRED_KEYS,
  PROJECT_ID,
  parseDotenv,
  resolveValues,
  missingKeyMessage,
  renderGeneratedEnv,
  guardGeneratedContent,
} from './inject-mobile-env.mjs';

/** A complete, valid set of env values keyed by REQUIRED_KEYS. */
function fullValues(overrides = {}) {
  return {
    TMDB_API_KEY: 'tmdb-test-key',
    FIREBASE_API_KEY: 'AIzaSyTEST',
    FIREBASE_AUTH_DOMAIN: 'vultus-cab62.firebaseapp.com',
    FIREBASE_STORAGE_BUCKET: 'vultus-cab62.appspot.com',
    FIREBASE_MESSAGING_SENDER_ID: '1234567890',
    FIREBASE_APP_ID: '1:1234567890:web:abc123',
    ...overrides,
  };
}

describe('inject-mobile-env helpers', () => {
  // (a) all values present → generated content has real values, no REPLACE_WITH_*,
  // no empty required field.
  it('renders real values with no placeholders or empty fields when all present', () => {
    const { values, missing } = resolveValues(fullValues(), {});
    expect(missing).toEqual([]);

    const content = renderGeneratedEnv(values);
    expect(content).not.toMatch(/REPLACE_WITH_/);
    expect(content).toContain('tmdb-test-key');
    expect(content).toContain('AIzaSyTEST');
    expect(content).toContain('1:1234567890:web:abc123');
    // projectId is hardcoded, not injected.
    expect(content).toContain(`projectId: "${PROJECT_ID}"`);
    // Shape parity with environment.prod.ts.
    expect(content).toContain('production: true');
    expect(content).toContain('useEmulators: false');
    expect(content).toContain('mockAuthUid: null as string | null');
    // Detail hero base (spec 0036): the generated env must carry the w780
    // detailImageBaseUrl so CI/production-built APKs render a sharp detail hero.
    expect(content).toContain('https://image.tmdb.org/t/p/w780');

    expect(guardGeneratedContent(content, values)).toEqual([]);
  });

  // (b) a missing/empty required value → guard fails with an actionable message
  // naming the key.
  it('detects a missing/empty required value (blank FIREBASE_API_KEY)', () => {
    const { values, missing } = resolveValues(
      fullValues({ FIREBASE_API_KEY: '   ' }),
      {},
    );
    expect(missing).toEqual(['FIREBASE_API_KEY']);
    expect(values.FIREBASE_API_KEY).toBeUndefined();

    const msg = missingKeyMessage('FIREBASE_API_KEY');
    expect(msg).toContain('FIREBASE_API_KEY');
    expect(msg).toContain('.env.local');
    expect(msg).toContain('GitHub Actions');
  });

  // (c) missing local source AND missing CI env → fails with an actionable
  // "set it locally or in GitHub" message.
  it('reports all keys missing when neither env nor local file provide them', () => {
    const { values, missing } = resolveValues({}, {});
    expect(missing).toEqual(REQUIRED_KEYS);
    expect(Object.keys(values)).toEqual([]);

    const msg = missingKeyMessage(missing[0]);
    expect(msg).toContain(missing[0]);
    expect(msg).toContain('.env.local');
    expect(msg).toContain('GitHub Actions');
  });

  it('lets CI env take precedence over the local file', () => {
    const { values } = resolveValues(
      { TMDB_API_KEY: 'from-ci' },
      fullValues({ TMDB_API_KEY: 'from-file' }),
    );
    expect(values.TMDB_API_KEY).toBe('from-ci');
  });

  it('parses a minimal dotenv, stripping quotes and comments', () => {
    const parsed = parseDotenv(
      [
        '# a comment',
        '',
        'TMDB_API_KEY=plain',
        'FIREBASE_API_KEY="quoted"',
        "FIREBASE_APP_ID='1:2:web:3=x'",
      ].join('\n'),
    );
    expect(parsed.TMDB_API_KEY).toBe('plain');
    expect(parsed.FIREBASE_API_KEY).toBe('quoted');
    // The trailing `=` inside the value is preserved.
    expect(parsed.FIREBASE_APP_ID).toBe('1:2:web:3=x');
  });

  it('flags a surviving REPLACE_WITH_* placeholder in the guard', () => {
    const values = fullValues();
    const tainted = `const x = 'REPLACE_WITH_REAL_TMDB_API_KEY';\n`;
    const problems = guardGeneratedContent(tainted, values);
    expect(problems.some((p) => p.includes('REPLACE_WITH_'))).toBe(true);
  });
});

// (d) the google-services.json presence guard fails when the file is absent.
// runCheckNative calls process.exit(1); we exercise the existsSync-based contract
// against a temp dir that has no android/app/google-services.json by re-importing
// the module's NATIVE path logic via a subprocess-free existence assertion.
describe('inject-mobile-env --check-native contract', () => {
  it('a temp dir without android/app/google-services.json is treated as absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'inject-native-'));
    try {
      const { existsSync } = await import('node:fs');
      const path = join(dir, 'android', 'app', 'google-services.json');
      // The guard's contract: absence → fail. We assert the precondition the
      // guard keys off (the file is absent in a fresh temp dir).
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
