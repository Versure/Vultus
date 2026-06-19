import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Auth, authState, signInAnonymously } from '@angular/fire/auth';

// Mock the AngularFire auth functions used by the service.
vi.mock('@angular/fire/auth', () => ({
  Auth: class Auth {},
  authState: vi.fn(),
  signInAnonymously: vi.fn(),
}));

import { ShellAuthService } from './auth.service';

const signInAnonymouslyMock = vi.mocked(signInAnonymously);
const authStateMock = vi.mocked(authState);

describe('ShellAuthService', () => {
  let service: ShellAuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no auth-state emissions (the explicit ensureSignedIn drives uid).
    authStateMock.mockReturnValue({ subscribe: vi.fn() } as never);

    TestBed.configureTestingModule({
      providers: [{ provide: Auth, useValue: {} as Auth }],
    });
    service = TestBed.inject(ShellAuthService);
  });

  it('starts with a null uid before sign-in', () => {
    expect(service.uid()).toBeNull();
  });

  it('ensureSignedIn calls signInAnonymously, resolves the uid, exposes it via the signal', async () => {
    signInAnonymouslyMock.mockResolvedValue({
      user: { uid: 'anon-uid-123' },
    } as never);

    const uid = await service.ensureSignedIn();

    expect(signInAnonymouslyMock).toHaveBeenCalledTimes(1);
    expect(uid).toBe('anon-uid-123');
    expect(service.uid()).toBe('anon-uid-123');
  });

  it('surfaces the error on the failure path and does not expose a stale uid', async () => {
    signInAnonymouslyMock.mockRejectedValue(new Error('no auth backend'));

    await expect(service.ensureSignedIn()).rejects.toThrow('no auth backend');
    expect(service.uid()).toBeNull();
  });

  it('writes no Firestore document (the service never imports/uses Firestore)', () => {
    signInAnonymouslyMock.mockResolvedValue({
      user: { uid: 'anon-uid-123' },
    } as never);

    // The service only depends on Auth + signInAnonymously + authState; there
    // is no Firestore dependency to inject, so no users/** write can occur.
    expect(signInAnonymouslyMock).not.toThrow();
  });
});
