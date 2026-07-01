import { TestBed } from '@angular/core/testing';
import { FirebaseError } from 'firebase/app';
import { TRIGGER_SYNC } from '@vultus/shared/domain/tokens';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAST_SYNC_KEY,
  SYNC_COOLDOWN_MS,
  SyncStateService,
} from './sync-state.service';

/** Minimal in-memory localStorage stand-in (only the two methods we use). */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  const storage: Storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  return storage;
}

/** A resolved sync thunk with no `await` (avoids the require-await lint). */
const okThunk = () => Promise.resolve({ syncedAt: 'x' });

/** Installs a localStorage on globalThis for the duration of a test. */
function withStorage(storage: Storage | undefined): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function makeService(thunk: () => Promise<{ syncedAt: string }>) {
  TestBed.configureTestingModule({
    providers: [{ provide: TRIGGER_SYNC, useValue: thunk }],
  });
  return TestBed.inject(SyncStateService);
}

describe('SyncStateService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('canSync is true with no prior sync (empty localStorage)', () => {
    withStorage(fakeStorage());
    const thunk = vi.fn(okThunk);
    const service = makeService(thunk);
    expect(service.canSync()).toBe(true);
    expect(service.syncing()).toBe(false);
  });

  it('canSync is false when the stored timestamp is within the window, and flips true at the exact expiry', () => {
    const now = Date.UTC(2026, 5, 25, 12, 0, 0);
    vi.setSystemTime(now);
    // Last sync 1 minute ago → 4 minutes (240_000 ms) remaining.
    const lastSync = new Date(now - 60_000).toISOString();
    withStorage(fakeStorage({ [LAST_SYNC_KEY]: lastSync }));
    const thunk = vi.fn(okThunk);
    const service = makeService(thunk);

    expect(service.canSync()).toBe(false);

    // Just before expiry → still false.
    vi.advanceTimersByTime(240_000 - 1);
    expect(service.canSync()).toBe(false);

    // At the exact expiry → true.
    vi.advanceTimersByTime(1);
    expect(service.canSync()).toBe(true);
  });

  it('canSync is true immediately when the stored timestamp is older than the window', () => {
    const now = Date.UTC(2026, 5, 25, 12, 0, 0);
    vi.setSystemTime(now);
    const lastSync = new Date(now - SYNC_COOLDOWN_MS - 1000).toISOString();
    withStorage(fakeStorage({ [LAST_SYNC_KEY]: lastSync }));
    const thunk = vi.fn(okThunk);
    const service = makeService(thunk);

    expect(service.canSync()).toBe(true);
  });

  it('triggerSync is a no-op when canSync is false (does not call the thunk)', async () => {
    const now = Date.UTC(2026, 5, 25, 12, 0, 0);
    vi.setSystemTime(now);
    withStorage(
      fakeStorage({ [LAST_SYNC_KEY]: new Date(now - 60_000).toISOString() }),
    );
    const thunk = vi.fn(okThunk);
    const service = makeService(thunk);

    expect(service.canSync()).toBe(false);
    await service.triggerSync();
    expect(thunk).not.toHaveBeenCalled();
  });

  it('triggerSync is a no-op when already syncing (does not call the thunk twice)', async () => {
    withStorage(fakeStorage());
    let resolve!: (v: { syncedAt: string }) => void;
    const thunk = vi.fn(
      () => new Promise<{ syncedAt: string }>((r) => (resolve = r)),
    );
    const service = makeService(thunk);

    // First call leaves the promise pending → syncing stays true.
    const first = service.triggerSync();
    expect(service.syncing()).toBe(true);

    // Second call while syncing → guarded out.
    await service.triggerSync();
    expect(thunk).toHaveBeenCalledTimes(1);

    resolve({ syncedAt: 'x' });
    await first;
  });

  it('happy path: sets syncing, calls the thunk, persists the timestamp, then starts the cooldown', async () => {
    const now = Date.UTC(2026, 5, 25, 12, 0, 0);
    vi.setSystemTime(now);
    const storage = fakeStorage();
    withStorage(storage);
    const thunk = vi.fn(() => Promise.resolve({ syncedAt: 'server-iso' }));
    const service = makeService(thunk);

    expect(service.canSync()).toBe(true);
    await service.triggerSync();

    expect(thunk).toHaveBeenCalledTimes(1);
    expect(service.syncing()).toBe(false);
    // Cooldown started.
    expect(service.canSync()).toBe(false);
    // Fresh ISO timestamp written under the key.
    expect(storage.getItem(LAST_SYNC_KEY)).toBe(new Date(now).toISOString());

    // Re-enable timer flips canSync true at the exact expiry.
    vi.advanceTimersByTime(SYNC_COOLDOWN_MS - 1);
    expect(service.canSync()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(service.canSync()).toBe(true);
  });

  it('thunk rejection: clears syncing, does NOT advance the timestamp, and re-throws', async () => {
    withStorage(fakeStorage());
    const storage = globalThis.localStorage;
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const thunk = vi.fn(() => Promise.reject(new Error('network down')));
    const service = makeService(thunk);

    await expect(service.triggerSync()).rejects.toThrow('network down');
    expect(service.syncing()).toBe(false);
    // No cooldown started → still allowed to retry, timestamp not written.
    expect(service.canSync()).toBe(true);
    expect(storage.getItem(LAST_SYNC_KEY)).toBeNull();
    // Logging asserted.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('thunk rejection with functions/not-found: logs distinctly and still re-throws', async () => {
    withStorage(fakeStorage());
    const storage = globalThis.localStorage;
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const notFoundErr = new FirebaseError(
      'functions/not-found',
      'callable not found',
    );
    const thunk = vi.fn(() => Promise.reject(notFoundErr));
    const service = makeService(thunk);

    await expect(service.triggerSync()).rejects.toThrow();
    expect(service.syncing()).toBe(false);
    expect(service.canSync()).toBe(true);
    expect(storage.getItem(LAST_SYNC_KEY)).toBeNull();
    // Should have logged at error level.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  it('degrades to "always allowed" when localStorage is unavailable', () => {
    withStorage(undefined);
    const thunk = vi.fn(okThunk);
    const service = makeService(thunk);
    expect(service.canSync()).toBe(true);
  });

  it('degrades to "always allowed" when localStorage.getItem throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('access denied');
      },
      setItem: () => {
        throw new Error('access denied');
      },
    } as unknown as Storage;
    withStorage(throwing);
    const thunk = vi.fn(okThunk);
    const service = makeService(thunk);
    expect(service.canSync()).toBe(true);
  });
});
