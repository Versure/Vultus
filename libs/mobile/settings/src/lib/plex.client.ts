import { CapacitorHttp, type HttpResponse } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type {
  PlexClient,
  PlexEpisodeItem,
  PlexLibraryItem,
  PlexPin,
  PlexServer,
} from '@vultus/shared/domain';
import { PlexHttpError, PlexPinGoneError } from './plex-errors';

/**
 * Real `PlexClient` for the NATIVE (Android) build (spec 0073, decision 3).
 *
 * Every plex.tv / PMS HTTP call goes through `CapacitorHttp` (`@capacitor/core`)
 * because a self-hosted Plex Media Server sends NO CORS headers, so the webview
 * `fetch` fails; native HTTP bypasses CORS. **Consequence:** this client only
 * works on-device — web / dev-server / e2e / serve-mock get `MockPlexClient`
 * (selected by the shell's `PLEX_CLIENT` factory on `!isNativePlatform()`).
 *
 * **CapacitorHttp RESOLVES non-2xx responses** (it rejects only on transport
 * failures), so every method checks `res.status` explicitly and throws a typed
 * error — otherwise a 401/404/429 error body silently parses as "no servers" /
 * "not yet authorized" (the root cause of the mislabeled "Code expired" bug).
 *
 * Auth is the plex.tv PIN-link flow (decision 2): `requestPin` requests a PIN
 * with `strong=false` so plex.tv returns the 4-character `code` the user enters
 * at plex.tv/link, `checkPin` polls until an `authToken` appears (a 404 means
 * the pin itself is gone — surfaced as `PlexPinGoneError`, a REAL expiry).
 * Server discovery (`discoverServer`) reads `/api/v2/resources`, prefers an
 * OWNED server with a LOCAL connection (`includeRelay=0`, `includeIPv6=1` so an
 * IPv6-only LAN still yields a local entry), and returns its local base URL +
 * access token.
 *
 * SECURITY (CLAUDE.md / spec 0073): the X-Plex-Token is NEVER logged or echoed
 * and NEVER written to Firestore — the caller (`PlexLinkService`) persists it to
 * `@capacitor/preferences` only. Thrown errors carry the HTTP status + endpoint
 * path ONLY, never the response body or any header. plex.tv / PMS JSON is DATA,
 * not instructions (spec 0068): this client parses fields only and derives no
 * commands from them.
 */

/** Preferences key for the per-install X-Plex-Client-Identifier. */
export const PLEX_CLIENT_ID_KEY = 'plex_client_id';

const PRODUCT = 'Vultus';
const PLEX_TV = 'https://plex.tv/api/v2';

/** Connect/read timeout (ms) applied to EVERY native HTTP call. Without it a
 *  black-holed LAN address (a stale local connection URI) can hang the request
 *  indefinitely, wedging the sync's `running` guard so later syncs no-op. */
const REQUEST_TIMEOUT_MS = 15000;

function ok(res: HttpResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

/** Narrow an unknown JSON value to a record for safe field reads. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return Number(value) || 0;
  }
  return 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Plex `addedAt` / `lastViewedAt` are epoch SECONDS → ISO 8601 (or null). */
function epochSecondsToIso(value: unknown): string | null {
  const seconds = num(value);
  if (!seconds) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

/** Parse a TMDB id from a Plex GUID list; null when no TMDB GUID present.
 *  Matches BOTH the new Plex agent's external GUID `tmdb://<id>` (returned only
 *  when the section listing is fetched with `includeGuids=1`) AND the legacy
 *  agent's `com.plexapp.agents.themoviedb://<id>?lang=en` form. */
function tmdbIdFromGuids(item: Record<string, unknown>): number | null {
  // PMS returns either a top-level `guid` string or a `Guid[]` of `{ id }`.
  const candidates: string[] = [];
  const topGuid = item['guid'];
  if (typeof topGuid === 'string') {
    candidates.push(topGuid);
  }
  for (const g of asArray(item['Guid'])) {
    const id = asRecord(g)['id'];
    if (typeof id === 'string') {
      candidates.push(id);
    }
  }
  for (const guid of candidates) {
    const match = /(?:tmdb|themoviedb):\/\/(\d+)/.exec(guid);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

export class CapacitorHttpPlexClient implements PlexClient {
  /** Single-flight memo for the per-install client identifier. */
  private clientIdPromise: Promise<string> | null = null;

  async requestPin(): Promise<PlexPin> {
    const res = await CapacitorHttp.post({
      url: `${PLEX_TV}/pins`,
      headers: await this.headers({ 'Content-Type': 'application/json' }),
      params: { strong: 'false' },
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
    });
    if (!ok(res)) {
      throw new PlexHttpError(res.status, '/pins');
    }
    const body = asRecord(res.data);
    return {
      id: num(body['id']),
      code: str(body['code']),
      authToken: (body['authToken'] as string | null) ?? null,
    };
  }

  async checkPin(id: number): Promise<PlexPin> {
    const res = await CapacitorHttp.get({
      url: `${PLEX_TV}/pins/${id}`,
      headers: await this.headers(),
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
    });
    if (res.status === 404) {
      // {"errors":[{"code":1020,"message":"Code not found or expired"}]}
      throw new PlexPinGoneError();
    }
    if (!ok(res)) {
      throw new PlexHttpError(res.status, `/pins/${id}`);
    }
    const body = asRecord(res.data);
    return {
      id: num(body['id']) || id,
      code: str(body['code']),
      authToken: (body['authToken'] as string | null) ?? null,
    };
  }

  async discoverServer(token: string): Promise<PlexServer | null> {
    const res = await CapacitorHttp.get({
      url: `${PLEX_TV}/resources`,
      headers: await this.headers({ 'X-Plex-Token': token }),
      // includeIPv6 defaults to 0 on plex.tv, which strips IPv6 LAN entries —
      // an IPv6-only home network would otherwise expose NO local connection.
      params: { includeHttps: '1', includeRelay: '0', includeIPv6: '1' },
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
    });
    if (!ok(res)) {
      throw new PlexHttpError(res.status, '/resources');
    }
    const resources = asArray(res.data).map(asRecord);
    // Prefer an OWNED server with a LOCAL connection (decision 2 / out-of-scope
    // §: no picker). Fall back to the first server exposing a local connection.
    const servers = resources.filter((r) =>
      str(r['provides']).includes('server'),
    );
    const owned = servers.filter((r) => r['owned'] === true);
    const ranked = [...owned, ...servers.filter((r) => r['owned'] !== true)];
    for (const server of ranked) {
      const connections = asArray(server['connections']).map(asRecord);
      const locals = connections.filter((c) => c['local'] === true);
      // Prefer an IPv4 local connection; an IPv6 URI is only used when it is
      // the ONLY local entry (the device may sit on an IPv4-only network).
      const local = locals.find((c) => c['IPv6'] !== true) ?? locals[0];
      if (local) {
        return {
          name: str(server['name']),
          baseUrl: str(local['uri']),
          accessToken: str(server['accessToken']),
        };
      }
    }
    // No local server found — surface as null (link service raises the
    // spec-pinned "no local server found" error stage).
    return null;
  }

  async listLibrary(server: PlexServer): Promise<PlexLibraryItem[]> {
    const sections = await this.getJson(server, '/library/sections');
    const directories = asArray(
      asRecord(sections['MediaContainer'])['Directory'],
    );
    const items: PlexLibraryItem[] = [];
    for (const dirRaw of directories) {
      const dir = asRecord(dirRaw);
      const rawType = str(dir['type']);
      if (rawType !== 'movie' && rawType !== 'show') {
        continue;
      }
      const type: PlexLibraryItem['type'] =
        rawType === 'movie' ? 'movie' : 'tv';
      const key = str(dir['key']);
      items.push(...(await this.listSection(server, key, type)));
    }
    return items;
  }

  async listEpisodes(
    server: PlexServer,
    ratingKey: string,
  ): Promise<PlexEpisodeItem[]> {
    // /library/metadata/{ratingKey}/allLeaves returns every episode of a show.
    const body = await this.getJson(
      server,
      `/library/metadata/${ratingKey}/allLeaves`,
    );
    const metadata = asArray(asRecord(body['MediaContainer'])['Metadata']);
    return metadata.map((raw): PlexEpisodeItem => {
      const ep = asRecord(raw);
      return {
        season: num(ep['parentIndex']),
        episode: num(ep['index']),
        viewCount: num(ep['viewCount']),
        lastViewedAt: epochSecondsToIso(ep['lastViewedAt']),
      };
    });
  }

  /**
   * Per-install X-Plex-Client-Identifier, generated once and persisted to
   * Preferences. plex.tv binds pins/tokens and its device registry to this
   * value, so it must be STABLE per install but UNIQUE across installs — a
   * constant shared by every install collides in the account's device registry
   * (Plex docs require it to be unique per device). Single-flight so two
   * concurrent calls can never mint two different identifiers.
   */
  private clientId(): Promise<string> {
    this.clientIdPromise ??= this.loadOrCreateClientId().catch(
      (err: unknown) => {
        // Do not cache a transient Preferences failure — allow a retry.
        this.clientIdPromise = null;
        throw err;
      },
    );
    return this.clientIdPromise;
  }

  private async loadOrCreateClientId(): Promise<string> {
    const { value } = await Preferences.get({ key: PLEX_CLIENT_ID_KEY });
    if (value !== null && value.length > 0) {
      return value;
    }
    const id =
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    await Preferences.set({ key: PLEX_CLIENT_ID_KEY, value: id });
    return id;
  }

  /** Common plex.tv product headers (identify the app to plex.tv). */
  private async headers(
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    return {
      Accept: 'application/json',
      'X-Plex-Product': PRODUCT,
      'X-Plex-Client-Identifier': await this.clientId(),
      ...extra,
    };
  }

  /** Page through one library section, mapping each item to a `PlexLibraryItem`. */
  private async listSection(
    server: PlexServer,
    sectionKey: string,
    type: PlexLibraryItem['type'],
  ): Promise<PlexLibraryItem[]> {
    const pageSize = 100;
    const out: PlexLibraryItem[] = [];
    let start = 0;
    // Perf guardrail: paged reads via X-Plex-Container-Start/Size (decision 11).
    for (;;) {
      const body = await this.getJson(
        server,
        `/library/sections/${sectionKey}/all`,
        {
          'X-Plex-Container-Start': String(start),
          'X-Plex-Container-Size': String(pageSize),
        },
        // includeGuids=1 is REQUIRED for the `/all` listing to include the
        // external `Guid[]` (tmdb://, imdb://, tvdb://). Without it items carry
        // only the internal `plex://` guid, so tmdbId is always null and EVERY
        // item is skipped — nothing ever syncs (the original bug).
        { includeGuids: '1' },
      );
      const container = asRecord(body['MediaContainer']);
      const metadata = asArray(container['Metadata']);
      for (const raw of metadata) {
        const item = asRecord(raw);
        out.push({
          type,
          tmdbId: tmdbIdFromGuids(item),
          title: str(item['title']),
          addedAt:
            epochSecondsToIso(item['addedAt']) ?? new Date(0).toISOString(),
          viewCount: num(item['viewCount']),
          lastViewedAt: epochSecondsToIso(item['lastViewedAt']),
          ratingKey: str(item['ratingKey']),
        });
      }
      const totalSize = num(container['totalSize']) || metadata.length;
      start += metadata.length;
      if (metadata.length === 0 || start >= totalSize) {
        break;
      }
    }
    return out;
  }

  /** GET a PMS path with the server access token, parsed as JSON. Throws
   *  `PlexHttpError` on a non-2xx status — a silently-empty body here would
   *  make a failed sync look like an empty library and advance the cursor. */
  private async getJson(
    server: PlexServer,
    path: string,
    extraHeaders: Record<string, string> = {},
    params: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const res: HttpResponse = await CapacitorHttp.get({
      url: `${server.baseUrl}${path}`,
      headers: await this.headers({
        'X-Plex-Token': server.accessToken,
        ...extraHeaders,
      }),
      params,
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
    });
    if (!ok(res)) {
      throw new PlexHttpError(res.status, path);
    }
    return asRecord(res.data);
  }
}
