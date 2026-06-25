/**
 * TMDB network interception (spec 0019 — TMDB interception contract).
 *
 * Every spec that searches MUST register this BEFORE navigating to Search. It
 * fulfills any `api.themoviedb.org` request with a committed fixture, so the e2e
 * suite needs NO `TMDB_API_KEY` and makes NO live external call (€0 / no-secret
 * invariant). The fixture shape matches the real TMDB `search/multi` response the
 * `tmdb-search.client` parses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/** Absolute path to `apps/mobile-e2e/fixtures`. */
const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures');

/**
 * A committed TMDB fixture file name under `apps/mobile-e2e/fixtures/`, e.g.
 * `tmdb-search-multi.json`.
 */
export type TmdbFixtureName = `tmdb-${string}.json`;

function loadFixture(name: TmdbFixtureName): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8'));
}

/**
 * Route every `api.themoviedb.org` request on `page` to the given committed
 * fixture (default `tmdb-search-multi.json`). Call before navigating to Search.
 *
 * Returns the parsed fixture so specs can assert against the same titles the app
 * renders without re-reading the file.
 */
export async function routeTmdb(
  page: Page,
  fixtureName: TmdbFixtureName = 'tmdb-search-multi.json',
): Promise<unknown> {
  const fixture = loadFixture(fixtureName);
  await page.route('**/api.themoviedb.org/**', (route) =>
    route.fulfill({ json: fixture as Record<string, unknown> }),
  );
  return fixture;
}
