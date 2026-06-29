import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Firestore } from '@angular/fire/firestore';
import { ToastController } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { AUTH_UID } from '@vultus/shared/domain/tokens';
import { notificationPath } from '@vultus/shared/firestore-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationHandlerService } from './notification-handler.service';

// --- Module mocks --------------------------------------------------------
// Capacitor + the push plugin are native shims with no browser implementation;
// the @angular/fire free functions (doc/updateDoc) are mocked so we can assert
// the targeted doc path + payload without a live Firestore.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn() },
}));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: { addListener: vi.fn() },
}));

interface DocRef {
  path: string;
}
const docMock = vi.fn(
  (_firestore: unknown, path: string): DocRef => ({ path }),
);
const updateDocMock = vi.fn<(ref: DocRef, payload: unknown) => Promise<void>>();
vi.mock('@angular/fire/firestore', () => ({
  Firestore: class Firestore {},
  doc: (firestore: unknown, path: string) => docMock(firestore, path),
  updateDoc: (ref: DocRef, payload: unknown) => updateDocMock(ref, payload),
  Timestamp: { now: vi.fn().mockReturnValue({ seconds: 1 }) },
}));

// --- Test types & helpers ------------------------------------------------
interface PushData {
  notificationId: string;
  tmdbId: string;
  [key: string]: unknown;
}
type ReceivedHandler = (n: {
  title?: string;
  body?: string;
  data: PushData;
}) => void;
type ActionHandler = (a: {
  actionId: string;
  notification: { data: PushData };
}) => void;
interface ToastButton {
  text: string;
  role?: string;
  handler: () => void;
}
interface ToastConfig {
  message: string;
  duration: number;
  position: string;
  buttons: ToastButton[];
}

const UID = 'user-123';
const NOTIFICATION_ID = '603-NL-movie-available';
const TMDB_ID = '603';
const PUSH_DATA: PushData = {
  notificationId: NOTIFICATION_ID,
  titleId: '603',
  tmdbId: TMDB_ID,
  kind: 'movie-available',
  region: 'NL',
};

const navigateMock = vi.fn<(commands: unknown[]) => Promise<boolean>>();
const toastPresentMock = vi.fn<() => Promise<void>>();
const toastCreateMock =
  vi.fn<(config: ToastConfig) => Promise<{ present: () => Promise<void> }>>();

// Local alias for the mocked static so assertions/config don't reference it as
// an unbound member method (avoids @typescript-eslint/unbound-method noise).
// vi.mocked is identity at runtime — the single member ref is safe (it is a
// mock fn, never invoked with an unintended `this`).
// eslint-disable-next-line @typescript-eslint/unbound-method
const addListenerMock = vi.mocked(PushNotifications.addListener);

/** Build the service inside an injection context with all deps mocked. */
function createService(uid: string | null = UID): NotificationHandlerService {
  TestBed.configureTestingModule({
    providers: [
      NotificationHandlerService,
      { provide: Router, useValue: { navigate: navigateMock } },
      { provide: Firestore, useValue: {} },
      { provide: ToastController, useValue: { create: toastCreateMock } },
      { provide: AUTH_UID, useValue: signal<string | null>(uid) },
    ],
  });
  return TestBed.inject(NotificationHandlerService);
}

/** Pull the handler registered for a given push event off the addListener spy. */
function receivedHandler(): ReceivedHandler {
  return findHandler('pushNotificationReceived') as ReceivedHandler;
}
function actionHandler(): ActionHandler {
  return findHandler('pushNotificationActionPerformed') as ActionHandler;
}
function findHandler(event: string): unknown {
  const call = addListenerMock.mock.calls.find(([name]) => name === event);
  if (!call) {
    throw new Error(`no listener registered for ${event}`);
  }
  return call[1];
}

function setNative(value: boolean): void {
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(value);
}

function lastToastConfig(): ToastConfig {
  return toastCreateMock.mock.calls[0][0];
}

describe('NotificationHandlerService', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    addListenerMock.mockReset();
    addListenerMock.mockResolvedValue({ remove: vi.fn() });
    docMock.mockClear();
    updateDocMock.mockReset();
    updateDocMock.mockResolvedValue(undefined);
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(true);
    toastCreateMock.mockReset();
    toastPresentMock.mockReset();
    toastPresentMock.mockResolvedValue(undefined);
    toastCreateMock.mockResolvedValue({ present: toastPresentMock });
  });

  it('is a no-op in the browser (non-native): no listeners registered', async () => {
    setNative(false);
    const service = createService();

    await service.init();

    expect(addListenerMock).not.toHaveBeenCalled();
  });

  it('registers the received + action listeners on native', async () => {
    setNative(true);
    const service = createService();

    await service.init();

    const events = addListenerMock.mock.calls.map(([name]) => name);
    expect(events).toContain('pushNotificationReceived');
    expect(events).toContain('pushNotificationActionPerformed');
    expect(addListenerMock).toHaveBeenCalledTimes(2);
  });

  it('is idempotent: a second init() does not double-register', async () => {
    setNative(true);
    const service = createService();

    await service.init();
    await service.init();

    expect(addListenerMock).toHaveBeenCalledTimes(2);
  });

  it('background tap navigates to title detail and marks the notification read', async () => {
    setNative(true);
    const service = createService(UID);
    await service.init();

    actionHandler()({ actionId: 'tap', notification: { data: PUSH_DATA } });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith([
      'tabs',
      'title-detail',
      TMDB_ID,
    ]);
    expect(docMock).toHaveBeenCalledWith(
      {},
      notificationPath(UID, NOTIFICATION_ID),
    );
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    const [ref, payload] = updateDocMock.mock.calls[0];
    expect(ref).toEqual({ path: notificationPath(UID, NOTIFICATION_ID) });
    expect(payload).toEqual({ readAt: { seconds: 1 } });
  });

  it('navigates to the tmdbId route segment exactly', async () => {
    setNative(true);
    const service = createService(UID);
    await service.init();

    actionHandler()({ actionId: 'tap', notification: { data: PUSH_DATA } });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith(['tabs', 'title-detail', '603']);
  });

  it('foreground arrival shows a toast (no navigate, no mark-read)', async () => {
    setNative(true);
    const service = createService(UID);
    await service.init();

    receivedHandler()({
      title: 'Up',
      body: 'Up is now on Netflix',
      data: PUSH_DATA,
    });
    await flush();

    expect(toastCreateMock).toHaveBeenCalledTimes(1);
    const config = lastToastConfig();
    expect(config.message).toBe('Up is now on Netflix');
    expect(config.duration).toBe(4000);
    expect(config.position).toBe('top');
    expect(config.buttons[0].text).toBe('View');
    expect(toastPresentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).not.toHaveBeenCalled();
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('foreground "View" tap runs the same navigate + mark-read as a background tap', async () => {
    setNative(true);
    const service = createService(UID);
    await service.init();

    receivedHandler()({ body: 'Up is now on Netflix', data: PUSH_DATA });
    await flush();

    lastToastConfig().buttons[0].handler();
    await flush();

    expect(navigateMock).toHaveBeenCalledWith([
      'tabs',
      'title-detail',
      TMDB_ID,
    ]);
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    expect(updateDocMock.mock.calls[0][0]).toEqual({
      path: notificationPath(UID, NOTIFICATION_ID),
    });
  });

  it('null-uid guard: tap still navigates but skips updateDoc', async () => {
    setNative(true);
    const service = createService(null);
    await service.init();

    actionHandler()({ actionId: 'tap', notification: { data: PUSH_DATA } });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith([
      'tabs',
      'title-detail',
      TMDB_ID,
    ]);
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('mark-read failure is non-fatal: navigation still happened', async () => {
    setNative(true);
    updateDocMock.mockRejectedValue(new Error('offline'));
    const service = createService(UID);
    await service.init();

    actionHandler()({ actionId: 'tap', notification: { data: PUSH_DATA } });
    await flush();

    expect(navigateMock).toHaveBeenCalledWith([
      'tabs',
      'title-detail',
      TMDB_ID,
    ]);
    expect(updateDocMock).toHaveBeenCalledTimes(1);
    // No unhandled rejection escaped: the test reaching here is the assertion.
  });
});

/** Drain the navigate() + updateDoc() microtask chain. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
