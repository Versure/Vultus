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

    // TV detail: /tv/{id}[?...]
    const tvMatch = /\/tv\/(\d+)/.exec(url);
    if (tvMatch) {
      const id = Number(tvMatch[1]);
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
