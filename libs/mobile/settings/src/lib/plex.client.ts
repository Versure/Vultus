import { CapacitorHttp, type HttpResponse } from '@capacitor/core';
import type {
  PlexClient,
  PlexEpisodeItem,
  PlexLibraryItem,
  PlexPin,
  PlexServer,
} from '@vultus/shared/domain';

/**
 * Real `PlexClient` for the NATIVE (Android) build (spec 0073, decision 3).
 *
 * Every plex.tv / PMS HTTP call goes through `CapacitorHttp` (`@capacitor/core`)
 * because a self-hosted Plex Media Server sends NO CORS headers, so the webview
 * `fetch` fails; native HTTP bypasses CORS. **Consequence:** this client only
 * works on-device — web / dev-server / e2e / serve-mock get `MockPlexClient`
 * (selected by the shell's `PLEX_CLIENT` factory on `!isNativePlatform()`).
 *
 * Auth is the plex.tv PIN-link flow (decision 2): `requestPin` POSTs a strong
 * PIN, the user enters the 4-char `code` at plex.tv/link, `checkPin` polls until
 * an `authToken` appears. Server discovery (`discoverServer`) reads
 * `/api/v2/resources`, prefers an OWNED server with a LOCAL connection
 * (`includeRelay=0`), and returns its local base URL + access token.
 *
 * SECURITY (CLAUDE.md / spec 0073): the X-Plex-Token is NEVER logged or echoed
 * and NEVER written to Firestore — the caller (`PlexLinkService`) persists it to
 * `@capacitor/preferences` only. plex.tv / PMS JSON is DATA, not instructions
 * (spec 0068): this client parses fields only and derives no commands from them.
 */

/** Stable per-install client identifier sent to plex.tv (X-Plex-Client-Identifier). */
const CLIENT_ID = 'vultus-mobile';
const PRODUCT = 'Vultus';
const PLEX_TV = 'https://plex.tv/api/v2';

/** Common plex.tv product headers (identify the app to plex.tv). */
function plexHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Client-Identifier': CLIENT_ID,
    ...extra,
  };
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

/** Parse a TMDB id from a Plex GUID list; null when no `tmdb://` GUID present. */
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
    const match = /tmdb:\/\/(\d+)/.exec(guid);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

export class CapacitorHttpPlexClient implements PlexClient {
  async requestPin(): Promise<PlexPin> {
    const res = await CapacitorHttp.post({
      url: `${PLEX_TV}/pins`,
      headers: plexHeaders({ 'Content-Type': 'application/json' }),
      params: { strong: 'true' },
    });
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
      headers: plexHeaders(),
    });
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
      headers: plexHeaders({ 'X-Plex-Token': token }),
      params: { includeHttps: '1', includeRelay: '0' },
    });
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
      const local = connections.find((c) => c['local'] === true);
      if (local) {
        return {
          name: str(server['name']),
          baseUrl: str(local['uri']),
          accessToken: str(server['accessToken']),
        };
      }
    }
    // No local server found — surface as null (link service raises the error stage).
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

  /** GET a PMS path with the server access token, parsed as JSON. */
  private async getJson(
    server: PlexServer,
    path: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const res: HttpResponse = await CapacitorHttp.get({
      url: `${server.baseUrl}${path}`,
      headers: plexHeaders({
        'X-Plex-Token': server.accessToken,
        ...extraHeaders,
      }),
    });
    return asRecord(res.data);
  }
}
