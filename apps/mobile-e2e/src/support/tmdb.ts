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

/**
 * Path-discriminating TMDB interception for flows that make both a search/multi
 * call AND a detail call (e.g. search → title-detail). Registers two handlers:
 *
 *  - search/multi requests  → tmdb-search-multi.json  (search results)
 *  - movie detail requests  → provided detailFixtureName (detail shape)
 *
 * Playwright matches the most-specific route first. The existing `routeTmdb`
 * catch-all is NOT registered here — register this instead for tests that need
 * both shapes. Other specs that only need search can still use `routeTmdb`.
 *
 * Returns both parsed fixtures.
 */
export async function routeTmdbDiscriminated(
  page: Page,
  detailFixtureName: TmdbFixtureName,
): Promise<{ search: unknown; detail: unknown }> {
  const searchFixture = loadFixture('tmdb-search-multi.json');
  const detailFixture = loadFixture(detailFixtureName);

  // Register search/multi last — Playwright gives higher priority to later-
  // registered routes, so this takes precedence over the detail handler for
  // search/multi URLs. Both patterns are non-overlapping in practice:
  //   **/search/multi** → search results shape
  //   **/movie/**       → detail shape (covers /movie/{id} and /movie/{id}/watch/providers)
  await page.route('**/movie/**', (route) =>
    route.fulfill({ json: detailFixture as Record<string, unknown> }),
  );
  await page.route('**/search/multi**', (route) =>
    route.fulfill({ json: searchFixture as Record<string, unknown> }),
  );

  return { search: searchFixture, detail: detailFixture };
}

/**
 * TV-detail interception for a specific tv id (spec 0043). Registers a glob
 * that matches any URL containing the tv id as a path segment, so both the
 * detail and watch/providers calls are fulfilled by the given fixture.
 *
 * Register this AFTER the search/multi route — Playwright applies the
 * most-recently-registered matching route first.
 */
export async function routeTmdbTV(
  page: Page,
  tvId: number,
  tvFixture: TmdbFixtureName,
): Promise<unknown> {
  const fixture = loadFixture(tvFixture);
  await page.route(`**/${tvId}**`, (route) =>
    route.fulfill({ json: fixture as Record<string, unknown> }),
  );
  return fixture;
}

/**
 * Per-id MOVIE-detail interception (spec 0086). `routeTmdbDiscriminated` fulfills
 * ONE fixture for every movie-detail request; this flow needs two movie ids (550
 * and 335984) to resolve to two different fixtures, so match on the id itself.
 */
export async function routeTmdbMovie(
  page: Page,
  movieId: number,
  fixtureName: TmdbFixtureName,
): Promise<unknown> {
  const fixture = loadFixture(fixtureName);
  await page.route(`**/movie/${movieId}**`, (route) =>
    route.fulfill({ json: fixture as Record<string, unknown> }),
  );
  return fixture;
}
