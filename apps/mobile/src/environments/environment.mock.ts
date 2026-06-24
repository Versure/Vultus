/**
 * Mock environment — use with `pnpm nx serve mobile --configuration=mock`.
 *
 * The mock TMDB fetch returns fixture data based on the query, enabling
 * manual testing of all search view-states without a real TMDB API key:
 *
 *   "error"   → error state (network/API error)
 *   "empty"   → no-results state
 *   "slow"    → loading state (2 s delay before results appear)
 *   anything else → results state (5 fixture movies/shows)
 *
 * Firebase is deliberately NOT emulated (`useEmulators: false`). Slices that
 * need data (e.g. settings) must be backed by a file-replaced mock provider so
 * this profile runs without any running emulator. Auth is also skipped — the
 * anonymous sign-in will fail gracefully (caught in app.config) and slices
 * whose mock providers do not require a uid will still render correctly.
 */

import type { TmdbSearchConfig } from '@vultus/mobile/search';

const MOCK_RESULTS = [
  {
    id: 1,
    media_type: 'movie',
    title: 'The Grand Illusion',
    release_date: '1937-06-04',
    poster_path: null,
  },
  {
    id: 2,
    media_type: 'tv',
    name: 'Breaking Bad',
    first_air_date: '2008-01-20',
    poster_path: null,
  },
  {
    id: 3,
    media_type: 'movie',
    title: 'Inception',
    release_date: '2010-07-16',
    poster_path: null,
  },
  {
    id: 4,
    media_type: 'tv',
    name: 'The Wire',
    first_air_date: '2002-06-02',
    poster_path: null,
  },
  {
    id: 5,
    media_type: 'movie',
    title: 'Parasite',
    release_date: '2019-05-30',
    poster_path: null,
  },
];

function createMockFetch(): typeof fetch {
  const mockFetch: typeof fetch = (input) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
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
  useEmulators: false,
  firebase: {
    apiKey: 'demo-vultus-not-a-real-key',
    authDomain: 'demo-vultus.firebaseapp.com',
    projectId: 'vultus-cab62',
    storageBucket: 'demo-vultus.appspot.com',
    messagingSenderId: 'demo-sender-id',
    appId: 'demo-app-id',
  },
  tmdb: mockTmdbConfig,
};
