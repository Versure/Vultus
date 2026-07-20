import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlexHttpError, PlexPinGoneError } from './plex-errors';

// --- @capacitor/core (CapacitorHttp) mock ---
interface HttpCall {
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
}
const httpGet = vi.fn<(opts: HttpCall) => Promise<unknown>>();
const httpPost = vi.fn<(opts: HttpCall) => Promise<unknown>>();
vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    get: (opts: HttpCall) => httpGet(opts),
    post: (opts: HttpCall) => httpPost(opts),
  },
}));

// --- @capacitor/preferences mock (a persisted client id by default) ---
const prefsGet = vi.fn<() => Promise<{ value: string | null }>>();
const prefsSet = vi.fn<() => Promise<void>>();
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: () => prefsGet(),
    set: () => prefsSet(),
  },
}));

import { CapacitorHttpPlexClient } from './plex.client';

const res = (status: number, data: unknown) => ({ status, data });

describe('CapacitorHttpPlexClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsGet.mockResolvedValue({ value: 'existing-client-id' });
    prefsSet.mockResolvedValue();
  });

  describe('requestPin', () => {
    it('parses id/code/authToken on a 2xx', async () => {
      httpPost.mockResolvedValue(
        res(201, { id: 7, code: 'AB12', authToken: null }),
      );
      const pin = await new CapacitorHttpPlexClient().requestPin();
      expect(pin).toEqual({ id: 7, code: 'AB12', authToken: null });
    });

    it('throws PlexHttpError on a non-2xx', async () => {
      httpPost.mockResolvedValue(res(400, { errors: [{ code: 1000 }] }));
      await expect(new CapacitorHttpPlexClient().requestPin()).rejects.toThrow(
        PlexHttpError,
      );
    });
  });

  describe('checkPin', () => {
    it('returns the pin with the authToken on a 2xx', async () => {
      httpGet.mockResolvedValue(
        res(200, { id: 7, code: 'AB12', authToken: 'tok' }),
      );
      const pin = await new CapacitorHttpPlexClient().checkPin(7);
      expect(pin.authToken).toBe('tok');
    });

    it('throws PlexPinGoneError on a 404 (pin gone / expired)', async () => {
      httpGet.mockResolvedValue(res(404, { errors: [{ code: 1020 }] }));
      await expect(new CapacitorHttpPlexClient().checkPin(7)).rejects.toThrow(
        PlexPinGoneError,
      );
    });

    it('throws PlexHttpError on other non-2xx (e.g. 500)', async () => {
      httpGet.mockResolvedValue(res(500, 'oops'));
      await expect(new CapacitorHttpPlexClient().checkPin(7)).rejects.toThrow(
        PlexHttpError,
      );
    });
  });

  describe('discoverServer', () => {
    const serverWith = (
      connections: unknown[],
      over: Record<string, unknown> = {},
    ) => ({
      provides: 'server',
      owned: true,
      accessToken: 'srv-token',
      name: 'My PMS',
      connections,
      ...over,
    });

    it('throws PlexHttpError on a non-2xx instead of silently returning null', async () => {
      // The core bug: a 401 error BODY must NOT be swallowed as "no servers".
      httpGet.mockResolvedValue(res(401, { errors: [{ code: 1001 }] }));
      await expect(
        new CapacitorHttpPlexClient().discoverServer('tok'),
      ).rejects.toThrow(PlexHttpError);
    });

    it('returns null when no server exposes a local connection', async () => {
      httpGet.mockResolvedValue(
        res(200, [
          serverWith([
            { uri: 'https://relay.plex.direct', local: false, relay: true },
          ]),
        ]),
      );
      expect(
        await new CapacitorHttpPlexClient().discoverServer('tok'),
      ).toBeNull();
    });

    it('returns the local server, preferring an IPv4 local connection over IPv6', async () => {
      httpGet.mockResolvedValue(
        res(200, [
          serverWith([
            { uri: 'http://[fe80::1]:32400', local: true, IPv6: true },
            { uri: 'http://192.168.1.20:32400', local: true, IPv6: false },
          ]),
        ]),
      );
      const server = await new CapacitorHttpPlexClient().discoverServer('tok');
      expect(server).toEqual({
        name: 'My PMS',
        baseUrl: 'http://192.168.1.20:32400',
        accessToken: 'srv-token',
      });
    });

    it('falls back to an IPv6-only local connection when that is all there is', async () => {
      httpGet.mockResolvedValue(
        res(200, [
          serverWith([
            { uri: 'http://[fe80::1]:32400', local: true, IPv6: true },
          ]),
        ]),
      );
      const server = await new CapacitorHttpPlexClient().discoverServer('tok');
      expect(server?.baseUrl).toBe('http://[fe80::1]:32400');
    });

    it('prefers a raw-IP http local over the .plex.direct https local (issue #171)', async () => {
      // Both connections are IPv4 + local; the secure one is a *.plex.direct
      // hostname that a DNS-rebind-protected router cannot resolve, so the
      // plaintext raw-IP connection must win regardless of array order.
      httpGet.mockResolvedValue(
        res(200, [
          serverWith([
            {
              uri: 'https://192-168-178-195.abc123.plex.direct:32400',
              protocol: 'https',
              local: true,
              IPv6: false,
            },
            {
              uri: 'http://192.168.178.195:32400',
              protocol: 'http',
              local: true,
              IPv6: false,
            },
          ]),
        ]),
      );
      const server = await new CapacitorHttpPlexClient().discoverServer('tok');
      expect(server?.baseUrl).toBe('http://192.168.178.195:32400');
    });

    it('falls back to the .plex.direct https local when no plaintext local exists', async () => {
      // Plex "Secure connections: Required" advertises only the https local.
      httpGet.mockResolvedValue(
        res(200, [
          serverWith([
            {
              uri: 'https://192-168-178-195.abc123.plex.direct:32400',
              protocol: 'https',
              local: true,
              IPv6: false,
            },
          ]),
        ]),
      );
      const server = await new CapacitorHttpPlexClient().discoverServer('tok');
      expect(server?.baseUrl).toBe(
        'https://192-168-178-195.abc123.plex.direct:32400',
      );
    });

    it('prefers an OWNED server over a shared one', async () => {
      httpGet.mockResolvedValue(
        res(200, [
          serverWith([{ uri: 'http://10.0.0.9:32400', local: true }], {
            owned: false,
            name: 'Shared',
            accessToken: 'shared-token',
          }),
          serverWith([{ uri: 'http://192.168.1.20:32400', local: true }], {
            owned: true,
            name: 'Mine',
            accessToken: 'mine-token',
          }),
        ]),
      );
      const server = await new CapacitorHttpPlexClient().discoverServer('tok');
      expect(server?.name).toBe('Mine');
    });

    it('requests includeIPv6=1 so an IPv6-only LAN is not stripped', async () => {
      httpGet.mockResolvedValue(res(200, []));
      await new CapacitorHttpPlexClient().discoverServer('tok');
      expect(httpGet.mock.calls[0][0].params).toMatchObject({
        includeRelay: '0',
        includeIPv6: '1',
      });
    });
  });

  describe('listLibrary', () => {
    const SERVER = {
      name: 'My PMS',
      baseUrl: 'http://192.168.1.20:32400',
      accessToken: 'srv-token',
    };

    it('sends includeGuids=1 on the section listing and parses tmdb + legacy themoviedb guids', async () => {
      httpGet.mockImplementation((opts: HttpCall) => {
        if (opts.url.endsWith('/library/sections')) {
          return Promise.resolve(
            res(200, {
              MediaContainer: { Directory: [{ type: 'show', key: '1' }] },
            }),
          );
        }
        if (opts.url.includes('/library/sections/1/all')) {
          return Promise.resolve(
            res(200, {
              MediaContainer: {
                totalSize: 2,
                Metadata: [
                  {
                    title: 'New Agent',
                    ratingKey: '10',
                    Guid: [{ id: 'tmdb://1396' }],
                  },
                  {
                    title: 'Legacy Agent',
                    ratingKey: '11',
                    guid: 'com.plexapp.agents.themoviedb://999?lang=en',
                  },
                ],
              },
            }),
          );
        }
        return Promise.resolve(res(200, {}));
      });

      const items = await new CapacitorHttpPlexClient().listLibrary(SERVER);

      // The `/all` listing MUST request includeGuids=1 — without it Plex omits
      // the external Guid[] and every tmdbId is null (the original sync bug).
      const allCall = httpGet.mock.calls.find(([o]) => o.url.includes('/all'));
      expect(allCall?.[0].params).toMatchObject({ includeGuids: '1' });
      // Both the new-agent tmdb:// GUID and the legacy themoviedb:// GUID parse.
      expect(items.map((i) => i.tmdbId)).toEqual([1396, 999]);
    });
  });

  describe('client identifier', () => {
    it('sends the persisted per-install X-Plex-Client-Identifier', async () => {
      httpPost.mockResolvedValue(
        res(201, { id: 1, code: 'AB12', authToken: null }),
      );
      await new CapacitorHttpPlexClient().requestPin();
      expect(
        httpPost.mock.calls[0][0].headers?.['X-Plex-Client-Identifier'],
      ).toBe('existing-client-id');
    });

    it('generates and persists a client id once when none exists', async () => {
      prefsGet.mockResolvedValue({ value: null });
      httpPost.mockResolvedValue(
        res(201, { id: 1, code: 'AB12', authToken: null }),
      );
      const client = new CapacitorHttpPlexClient();
      await client.requestPin();
      await client.checkPin(1).catch(() => undefined); // second call reuses the id
      // Persisted exactly once despite two requests (single-flight memo).
      expect(prefsSet).toHaveBeenCalledTimes(1);
    });
  });
});
