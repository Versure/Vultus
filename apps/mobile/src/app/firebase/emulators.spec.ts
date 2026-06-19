import { vi } from 'vitest';
import type { Auth } from '@angular/fire/auth';
import type { Firestore } from '@angular/fire/firestore';
import {
  AUTH_EMULATOR_URL,
  FIRESTORE_EMULATOR_HOST,
  FIRESTORE_EMULATOR_PORT,
  connectEmulatorsIfEnabled,
  type EmulatorEnv,
} from './emulators';

describe('connectEmulatorsIfEnabled', () => {
  const auth = {} as Auth;
  const firestore = {} as Firestore;

  function makeConnectors() {
    return {
      connectAuth: vi.fn(),
      connectFirestore: vi.fn(),
    };
  }

  it('connects both emulators when dev + useEmulators', () => {
    const connectors = makeConnectors();
    const env: EmulatorEnv = { production: false, useEmulators: true };

    connectEmulatorsIfEnabled(env, auth, firestore, connectors);

    expect(connectors.connectAuth).toHaveBeenCalledWith(
      auth,
      AUTH_EMULATOR_URL,
      {
        disableWarnings: true,
      },
    );
    expect(connectors.connectFirestore).toHaveBeenCalledWith(
      firestore,
      FIRESTORE_EMULATOR_HOST,
      FIRESTORE_EMULATOR_PORT,
    );
  });

  it('connects neither emulator when useEmulators is false', () => {
    const connectors = makeConnectors();
    const env: EmulatorEnv = { production: false, useEmulators: false };

    connectEmulatorsIfEnabled(env, auth, firestore, connectors);

    expect(connectors.connectAuth).not.toHaveBeenCalled();
    expect(connectors.connectFirestore).not.toHaveBeenCalled();
  });

  it('connects neither emulator in production', () => {
    const connectors = makeConnectors();
    const env: EmulatorEnv = { production: true, useEmulators: true };

    connectEmulatorsIfEnabled(env, auth, firestore, connectors);

    expect(connectors.connectAuth).not.toHaveBeenCalled();
    expect(connectors.connectFirestore).not.toHaveBeenCalled();
  });
});
