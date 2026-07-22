/**
 * Mock environment — use with `pnpm nx serve mobile --configuration=mock`.
 *
 * Works WITHOUT the Firebase emulator running:
 *   - `mockAuthUid` bypasses Firebase Auth: the app skips signInAnonymously and
 *     uses a fixture uid so write-guards never short-circuit on null uid.
 *   - `useEmulators: true` points Firestore at localhost:8080. When the emulator
 *     is NOT running, the SDK enters offline mode: writes buffer in memory and
 *     `onSnapshot` reflects them immediately (hasPendingWrites: true), giving
 *     realistic UI feedback without any server. When the emulator IS running,
 *     writes persist normally.
 *   - The TMDB fetch is fully mocked (search + detail + providers).
 *
 * Mock TMDB keywords (search):
 *   "error"   → error state
 *   "empty"   → no-results state
 *   "slow"    → loading state (2 s delay)
 *   anything else → results (5 fixture titles, ids 1–5)
 *
 * Title detail: navigate to tabs/title-detail/1–5 for fixture data. Any other
 * id resolves to the not-found state (404 from mock). Providers always return a
 * US fixture set; region is null in mock (no cached user doc) so providers show
 * the empty-providers state unless you set a region in the emulator.
 *
 * 401 in real (non-mock) dev serve: the TMDB api_key in environment.ts is
 * intentionally empty — spec 0015 wires it for CI/prod; set it manually in
 * .env.local for live dev, or use this mock configuration instead.
 */

import type { TmdbSearchConfig } from '@vultus/mobile/search';

const MOCK_RESULTS = [
  {
    id: 1,
    media_type: 'movie',
    title: 'The Grand Illusion',
    release_date: '1937-06-04',
    poster_path: null,
    vote_average: 8.1,
  },
  {
    id: 2,
    media_type: 'tv',
    name: 'Breaking Bad',
    first_air_date: '2008-01-20',
    poster_path: null,
    vote_average: 9.5,
  },
  {
    id: 3,
    media_type: 'movie',
    title: 'Inception',
    release_date: '2010-07-16',
    poster_path: null,
    vote_average: 8.8,
  },
  {
    id: 4,
    media_type: 'tv',
    name: 'The Wire',
    first_air_date: '2002-06-02',
    poster_path: null,
    vote_average: 9.3,
  },
  {
    id: 5,
    media_type: 'movie',
    title: 'Parasite',
    release_date: '2019-05-30',
    poster_path: null,
    vote_average: 8.5,
  },
];

/**
 * Detail-only fixtures for the Plex mock-library ids (spec 0086 / T4). These ids
 * are NOT in MOCK_RESULTS (which drives the search fixture, ids 1–5); they are the
 * tmdbIds the mock Plex library returns (`plex.client.mock.ts`): Fight Club (550,
 * movie), Blade Runner 2049 (335984, movie), Breaking Bad (1396, tv). The detail
 * stub checks this map BEFORE the MOCK_RESULTS lookup so PlexSyncService's TMDB
 * fetch resolves a real `poster_path` / `vote_average` for these titles — without
 * disturbing the search-results fixture. If the mock Plex library ids change, this
 * map must change with them (and with the e2e assertions in plex-sync.spec.ts).
 */
interface DetailExtra {
  media_type: 'movie' | 'tv';
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview: string;
  poster_path: string;
  vote_average: number;
  /**
   * For tv extras: the show's season count, served on the `/tv/{id}` detail stub
   * so PlexSyncService's on-device episode-doc creation (spec 0098) loops the
   * right season range. Only the Plex mock-library tv show (1396) sets it.
   */
  number_of_seasons?: number;
}

const DETAIL_EXTRAS: Record<number, DetailExtra> = {
  550: {
    media_type: 'movie',
    title: 'Fight Club',
    release_date: '1999-10-15',
    overview:
      'A mock detail fixture (spec 0086) so the Plex-synced Fight Club renders real poster artwork instead of the fallback.',
    poster_path: '/mock-fight-club-550.jpg',
    vote_average: 8.4,
  },
  335984: {
    media_type: 'movie',
    title: 'Blade Runner 2049',
    release_date: '2017-10-06',
    overview:
      'A mock detail fixture (spec 0086) so the Plex-synced Blade Runner 2049 renders real poster artwork instead of the fallback.',
    poster_path: '/mock-blade-runner-335984.jpg',
    vote_average: 7.6,
  },
  1396: {
    media_type: 'tv',
    name: 'Breaking Bad',
    first_air_date: '2008-01-20',
    overview:
      'A mock detail fixture (spec 0086) so the Plex-synced Breaking Bad renders real poster artwork instead of the fallback.',
    poster_path: '/mock-breaking-bad-1396.jpg',
    vote_average: 8.9,
    // 1 season (spec 0098) — PlexSyncService.ensureEpisodeDocs loops seasons
    // 1..count and fetches /tv/1396/season/1 (served below) to create the
    // missing episode docs on-device before mirroring the Plex watch state.
    number_of_seasons: 1,
  },
};

/**
 * Deterministic season/episode fixtures for the Plex mock-library tv show (spec
 * 0098), keyed by tmdbId → season number → the TMDB `/tv/{id}/season/{n}`
 * `episodes[]`. These MUST line up with `MockPlexClient.listEpisodes` (Breaking
 * Bad S1E1 watched + S1E2 unwatched): both episodes carry a NON-NULL `air_date`
 * so neither is dropped by the null-air_date skip, letting on-device episode-doc
 * creation + mirror mark S1E1 watched immediately. If the mock Plex library
 * episode numbers change, this map, `plex.client.mock.ts`, and the e2e route
 * fixtures must change together (spec 0098 "Mock-fixture id coupling" risk).
 */
const SEASON_EPISODES: Record<number, Record<number, unknown[]>> = {
  1396: {
    1: [
      {
        episode_number: 1,
        season_number: 1,
        name: 'Pilot',
        air_date: '2008-01-20',
      },
      {
        episode_number: 2,
        season_number: 1,
        name: "Cat's in the Bag...",
        air_date: '2008-01-27',
      },
    ],
  },
};

const MOCK_PROVIDERS_RESPONSE = {
  results: {
    US: {
      flatrate: [{ provider_name: 'Netflix' }, { provider_name: 'Disney+' }],
      rent: [{ provider_name: 'Apple TV' }, { provider_name: 'Amazon Video' }],
      buy: [{ provider_name: 'Vudu' }],
    },
  },
};

function createMockFetch(): typeof fetch {
  const mockFetch: typeof fetch = (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    // Watch-providers endpoint — must be checked before movie/tv detail
    if (url.includes('/watch/providers')) {
      return Promise.resolve(
        new Response(JSON.stringify(MOCK_PROVIDERS_RESPONSE), { status: 200 }),
      );
    }

    // Movie detail: /movie/{id}[?...]
    const movieMatch = /\/movie\/(\d+)/.exec(url);
    if (movieMatch) {
      const id = Number(movieMatch[1]);
      // Plex mock-library detail ids (spec 0086) resolve with a real poster.
      const extra = DETAIL_EXTRAS[id];
      if (extra?.media_type === 'movie') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id,
              title: extra.title,
              release_date: extra.release_date,
              overview: extra.overview,
              poster_path: extra.poster_path,
              vote_average: extra.vote_average,
              runtime: 112,
            }),
            { status: 200 },
          ),
        );
      }
      const fixture = MOCK_RESULTS.find(
        (r) => r.id === id && r.media_type === 'movie',
      );
      if (!fixture) {
        return Promise.resolve(
          new Response(JSON.stringify({ status_message: 'Not Found' }), {
            status: 404,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id,
            title: fixture.title,
            release_date: fixture.release_date,
            overview:
              'A mock movie overview for manual testing. Navigate to ids 1–5 for the fixture titles.',
            poster_path: null,
            vote_average: fixture.vote_average,
            runtime: 112,
          }),
          { status: 200 },
        ),
      );
    }

    // TV season: /tv/{id}/season/{n}[?...] — MUST be checked before the generic
    // /tv/{id} detail match below, or the season URL is captured as a detail
    // request (spec 0098). Serves the deterministic season episode list for the
    // Plex mock-library show so on-device episode-doc creation is stable.
    const seasonMatch = /\/tv\/(\d+)\/season\/(\d+)/.exec(url);
    if (seasonMatch) {
      const id = Number(seasonMatch[1]);
      const season = Number(seasonMatch[2]);
      const episodes = SEASON_EPISODES[id]?.[season];
      if (!episodes) {
        return Promise.resolve(
          new Response(JSON.stringify({ status_message: 'Not Found' }), {
            status: 404,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ episodes }), { status: 200 }),
      );
    }

    // TV detail: /tv/{id}[?...]
    const tvMatch = /\/tv\/(\d+)/.exec(url);
    if (tvMatch) {
      const id = Number(tvMatch[1]);
      // Plex mock-library detail ids (spec 0086) resolve with a real poster.
      const extra = DETAIL_EXTRAS[id];
      if (extra?.media_type === 'tv') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id,
              name: extra.name,
              first_air_date: extra.first_air_date,
              overview: extra.overview,
              poster_path: extra.poster_path,
              vote_average: extra.vote_average,
              number_of_seasons: extra.number_of_seasons,
            }),
            { status: 200 },
          ),
        );
      }
      const fixture = MOCK_RESULTS.find(
        (r) => r.id === id && r.media_type === 'tv',
      );
      if (!fixture) {
        return Promise.resolve(
          new Response(JSON.stringify({ status_message: 'Not Found' }), {
            status: 404,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id,
            name: fixture.name,
            first_air_date: fixture.first_air_date,
            overview:
              'A mock TV show overview for manual testing. Navigate to ids 1–5 for the fixture titles.',
            poster_path: null,
            vote_average: fixture.vote_average,
          }),
          { status: 200 },
        ),
      );
    }

    // Search endpoint: /search/multi?query=...
    const queryMatch = /[?&]query=([^&]*)/.exec(url);
    const query = queryMatch
      ? decodeURIComponent(queryMatch[1]).toLowerCase()
      : '';
    const delayMs = query.includes('slow') ? 2000 : 200;

    return new Promise((resolve) =>
      setTimeout(() => {
        if (query.includes('error')) {
          resolve(
            new Response(JSON.stringify({ status_message: 'Mock error' }), {
              status: 500,
            }),
          );
        } else if (query.includes('empty')) {
          resolve(
            new Response(JSON.stringify({ results: [] }), { status: 200 }),
          );
        } else {
          resolve(
            new Response(JSON.stringify({ results: MOCK_RESULTS }), {
              status: 200,
            }),
          );
        }
      }, delayMs),
    );
  };
  return mockFetch;
}

const mockTmdbConfig: TmdbSearchConfig = {
  apiBaseUrl: 'https://api.themoviedb.org/3',
  imageBaseUrl: 'https://image.tmdb.org/t/p/w185',
  auth: { kind: 'apiKey', apiKey: 'mock' },
  fetchImpl: createMockFetch(),
};

export const environment = {
  production: false,
  // Emulators on so Firestore uses localhost:8080 rather than real Firebase.
  // Without a running emulator the SDK enters offline mode: writes buffer in
  // memory and onSnapshot reflects them — no emulator required for basic testing.
  useEmulators: true,
  // Bypasses Firebase Auth: provides a fixture uid directly so all write-guards
  // receive a non-null uid and Firestore writes are not short-circuited.
  mockAuthUid: 'mock-user-123',
  firebase: {
    apiKey: 'demo-vultus-not-a-real-key',
    authDomain: 'demo-vultus.firebaseapp.com',
    projectId: 'vultus-cab62',
    storageBucket: 'demo-vultus.appspot.com',
    messagingSenderId: 'demo-sender-id',
    appId: 'demo-app-id',
  },
  // Spread the search-typed mock config and add the detail base (spec 0036) so
  // environment.tmdb.detailImageBaseUrl is defined under --configuration=mock.
  // mockTmdbConfig stays TmdbSearchConfig-typed (adding the key there would be a
  // TS excess-property error).
  tmdb: {
    ...mockTmdbConfig,
    detailImageBaseUrl: 'https://image.tmdb.org/t/p/w780',
  },
};
