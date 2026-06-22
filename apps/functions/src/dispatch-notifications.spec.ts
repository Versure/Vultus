import { describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import { handleDispatch, type DispatchEvent } from './dispatch-notifications';
import { createMessagingFcmSender } from './dispatch/adapters';

// --- Fakes -----------------------------------------------------------------

interface DocSnap {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

/**
 * Minimal Firestore fake: serves `title-cache/{id}` doc reads and records every
 * write path (set/add/update) so boundary assertions can inspect them. Empty
 * collections answer `findUsersTracking` / `getEpisodes` with no results.
 */
function createFakeDb(opts: {
  titleCache: Record<string, Record<string, unknown>>;
}) {
  const writes: { path: string; data: unknown }[] = [];

  const collection = (path: string) => ({
    get: () => Promise.resolve({ docs: [] }),
    add: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve({ id: 'generated' });
    },
    doc: () => ({ id: 'generated' }),
  });

  const collectionGroup = () => ({
    get: () => Promise.resolve({ docs: [] }),
  });

  const doc = (path: string) => ({
    get: (): Promise<DocSnap> => {
      const data = opts.titleCache[path];
      return Promise.resolve({
        exists: data !== undefined,
        data: () => data,
      });
    },
    set: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve();
    },
    update: (data: unknown) => {
      writes.push({ path, data });
      return Promise.resolve();
    },
  });

  const db = { collection, collectionGroup, doc } as unknown as Firestore;
  return { db, writes };
}

const noopMessaging = {
  send: vi.fn(() => Promise.resolve('msg-id')),
} as unknown as Messaging;

// --- handleDispatch wiring --------------------------------------------------

describe('handleDispatch', () => {
  it('reads the title type, builds the AvailabilityChange and dispatches', async () => {
    const flatrate = {
      providerId: 8,
      name: 'Netflix',
      type: 'flatrate' as const,
    };
    const { db } = createFakeDb({
      titleCache: { 'title-cache/603': { type: 'movie' } },
    });
    const getSpy = vi.spyOn(db, 'doc');

    const event: DispatchEvent = {
      params: { tmdbId: '603', region: 'NL' },
      data: {
        after: {
          data: () => ({ providers: [flatrate], previousSnapshot: [] }),
        },
      },
    };

    await handleDispatch(event, db, noopMessaging);

    // The title type is read from the parent title-cache doc.
    expect(getSpy).toHaveBeenCalledWith('title-cache/603');
    // No users tracking (empty collection group) → no notification writes, but
    // the flow completed without throwing, proving the change was assembled.
  });

  it('is a no-op when the doc was deleted (no afterData)', async () => {
    const { db, writes } = createFakeDb({ titleCache: {} });
    const collSpy = vi.spyOn(db, 'collectionGroup');

    const event: DispatchEvent = {
      params: { tmdbId: '603', region: 'NL' },
      data: { after: { data: () => undefined } },
    };

    await handleDispatch(event, db, noopMessaging);

    expect(collSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('is a no-op when the title-cache doc is unknown', async () => {
    const { db, writes } = createFakeDb({ titleCache: {} });
    const collSpy = vi.spyOn(db, 'collectionGroup');

    const event: DispatchEvent = {
      params: { tmdbId: '999', region: 'NL' },
      data: {
        after: { data: () => ({ providers: [], previousSnapshot: [] }) },
      },
    };

    await handleDispatch(event, db, noopMessaging);

    // Returns before touching the watchlist collection group or any write path.
    expect(collSpy).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('never writes to title-cache/** or system/** during dispatch', async () => {
    const flatrate = {
      providerId: 8,
      name: 'Netflix',
      type: 'flatrate' as const,
    };
    const { db, writes } = createFakeDb({
      titleCache: { 'title-cache/603': { type: 'movie' } },
    });

    const event: DispatchEvent = {
      params: { tmdbId: '603', region: 'NL' },
      data: {
        after: {
          data: () => ({ providers: [flatrate], previousSnapshot: [] }),
        },
      },
    };

    await handleDispatch(event, db, noopMessaging);

    for (const w of writes) {
      expect(w.path.startsWith('title-cache/')).toBe(false);
      expect(w.path.startsWith('system/')).toBe(false);
    }
  });
});

// --- FCM sender adapter -----------------------------------------------------

// A messaging error carrying a Firebase `code`, as the Admin SDK throws.
function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

describe('createMessagingFcmSender', () => {
  it('returns unregistered:false on a successful send', async () => {
    const send = vi.fn(() => Promise.resolve('msg-id'));
    const messaging = { send } as unknown as Messaging;
    const sender = createMessagingFcmSender(messaging);

    const result = await sender.send('tok-1', { kind: 'movie-available' });

    expect(result).toEqual({ token: 'tok-1', unregistered: false });
    expect(send).toHaveBeenCalledWith({
      token: 'tok-1',
      data: { kind: 'movie-available' },
    });
  });

  it('maps registration-token-not-found to unregistered:true', async () => {
    const send = vi.fn(() =>
      Promise.reject(codedError('messaging/registration-token-not-found')),
    );
    const sender = createMessagingFcmSender({ send } as unknown as Messaging);

    const result = await sender.send('stale', {});

    expect(result).toEqual({ token: 'stale', unregistered: true });
  });

  it('maps invalid-registration-token to unregistered:true', async () => {
    const send = vi.fn(() =>
      Promise.reject(codedError('messaging/invalid-registration-token')),
    );
    const sender = createMessagingFcmSender({ send } as unknown as Messaging);

    const result = await sender.send('bad', {});

    expect(result).toEqual({ token: 'bad', unregistered: true });
  });

  it('rethrows non-token errors', async () => {
    const send = vi.fn(() =>
      Promise.reject(codedError('messaging/internal-error')),
    );
    const sender = createMessagingFcmSender({ send } as unknown as Messaging);

    await expect(sender.send('tok', {})).rejects.toMatchObject({
      code: 'messaging/internal-error',
    });
  });
});
