import type {
  PlexClient,
  PlexEpisodeItem,
  PlexLibraryItem,
  PlexPin,
  PlexServer,
} from '@vultus/shared/domain';

/**
 * Deterministic in-memory `PlexClient` for every NON-native surface (spec 0073):
 * web build, dev server, e2e, and `mobile:serve-mock`. The shell's `PLEX_CLIENT`
 * factory (T4, `app.config.ts`) selects this class whenever
 * `!Capacitor.isNativePlatform()`, so no real PMS or plex.tv call ever fires off
 * a device. The real protocol lives in `plex.client.ts` (CapacitorHttp).
 *
 * Behaviour is fully deterministic so unit / component / e2e assertions are
 * stable:
 * - `requestPin()` returns a fixed 4-char code with `authToken: null`;
 * - `checkPin()` auto-authorizes (returns the same pin with a non-empty
 *   `authToken`) — the mock link flow never waits on a human;
 * - `discoverServer()` returns a fixed local-network server;
 * - `listLibrary()` returns a small fixture: a tmdb-GUID movie (watched), a
 *   tmdb-GUID tv show (partially watched), a planned tmdb-GUID movie, and one
 *   GUID-less item (`tmdbId: null`) so the sync engine's skip path is exercised;
 * - `listEpisodes()` returns two episodes for the fixture show, the first
 *   watched — so the mirror + first-episode `planned → watching` flip is exercised.
 *
 * The fixture `addedAt` timestamps sit in the RECENT past so a fresh link's
 * cursor (initialized at link time) lets them through as additions.
 */

/** The fixture show's Plex ratingKey (used by `listEpisodes`). */
const MOCK_SHOW_RATING_KEY = 'show-1';

/** ISO timestamps a few minutes ago so a just-linked cursor admits them. */
const NOW = Date.now();
const MINUTES_AGO = (m: number): string =>
  new Date(NOW - m * 60_000).toISOString();

export class MockPlexClient implements PlexClient {
  requestPin(): Promise<PlexPin> {
    return Promise.resolve({ id: 424242, code: 'H7X2', authToken: null });
  }

  checkPin(id: number): Promise<PlexPin> {
    // Auto-authorize immediately: the mock never blocks on the user entering
    // the code at plex.tv/link.
    return Promise.resolve({ id, code: 'H7X2', authToken: 'mock-plex-token' });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface param unused in the deterministic mock
  discoverServer(_token: string): Promise<PlexServer | null> {
    return Promise.resolve({
      name: 'Vultus Media Server',
      baseUrl: 'http://192.168.1.20:32400',
      accessToken: 'mock-server-token',
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- interface param unused in the deterministic mock
  listLibrary(_server: PlexServer): Promise<PlexLibraryItem[]> {
    const items: PlexLibraryItem[] = [
      // Watched tmdb-GUID movie (Fight Club, 550) — drives watch-implies-add →
      // completed OR flips an already-tracked movie to completed.
      {
        type: 'movie',
        tmdbId: 550,
        title: 'Fight Club',
        addedAt: MINUTES_AGO(9),
        viewCount: 1,
        lastViewedAt: MINUTES_AGO(3),
        ratingKey: 'movie-watched',
      },
      // Planned (unwatched) tmdb-GUID movie (Blade Runner 2049, 335984) — a
      // cursor library addition → planned.
      {
        type: 'movie',
        tmdbId: 335984,
        title: 'Blade Runner 2049',
        addedAt: MINUTES_AGO(7),
        viewCount: 0,
        lastViewedAt: null,
        ratingKey: 'movie-planned',
      },
      // Partially-watched tmdb-GUID tv show (Breaking Bad, 1396) — drives the
      // episode mirror + first-episode planned → watching flip.
      {
        type: 'tv',
        tmdbId: 1396,
        title: 'Breaking Bad',
        addedAt: MINUTES_AGO(5),
        viewCount: 1,
        lastViewedAt: MINUTES_AGO(2),
        ratingKey: MOCK_SHOW_RATING_KEY,
      },
      // GUID-less legacy-agent item (no tmdb:// GUID) — SKIPPED by the sync
      // engine (counted, never fuzzy-matched, no write).
      {
        type: 'movie',
        tmdbId: null,
        title: 'Home Movie 2019',
        addedAt: MINUTES_AGO(4),
        viewCount: 0,
        lastViewedAt: null,
        ratingKey: 'guidless',
      },
    ];
    return Promise.resolve(items);
  }

  listEpisodes(
    _server: PlexServer,
    ratingKey: string,
  ): Promise<PlexEpisodeItem[]> {
    if (ratingKey !== MOCK_SHOW_RATING_KEY) {
      return Promise.resolve([]);
    }
    return Promise.resolve([
      // S1E1 watched → flips a planned show to watching.
      { season: 1, episode: 1, viewCount: 1, lastViewedAt: MINUTES_AGO(2) },
      // S1E2 unwatched → so the show is NOT all-watched (stays watching).
      { season: 1, episode: 2, viewCount: 0, lastViewedAt: null },
    ]);
  }
}
