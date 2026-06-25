import { vi } from 'vitest';
import type { Auth } from '@angular/fire/auth';
import type { Firestore } from '@angular/fire/firestore';
import type { Functions } from '@angular/fire/functions';
import {
  AUTH_EMULATOR_URL,
  FIRESTORE_EMULATOR_HOST,
  FIRESTORE_EMULATOR_PORT,
  FUNCTIONS_EMULATOR_HOST,
  FUNCTIONS_EMULATOR_PORT,
  connectAuthEmulatorIfEnabled,
  connectFirestoreEmulatorIfEnabled,
  connectFunctionsEmulatorIfEnabled,
  type ConnectFunctionsFn,
  type EmulatorEnv,
} from './emulators';

const auth = {} as Auth;
const firestore = {} as Firestore;
const fns = {} as Functions;

const DEV: EmulatorEnv = { production: false, useEmulators: true };
const DEV_NO_EMU: EmulatorEnv = { production: false, useEmulators: false };
const PROD: EmulatorEnv = { production: true, useEmulators: true };

describe('connectAuthEmulatorIfEnabled', () => {
  it('connects the Auth emulator when dev + useEmulators', () => {
    const connectAuth = vi.fn();

    connectAuthEmulatorIfEnabled(DEV, auth, connectAuth);

    expect(connectAuth).toHaveBeenCalledWith(auth, AUTH_EMULATOR_URL, {
      disableWarnings: true,
    });
  });

  it('does not connect when useEmulators is false', () => {
    const connectAuth = vi.fn();

    connectAuthEmulatorIfEnabled(DEV_NO_EMU, auth, connectAuth);

    expect(connectAuth).not.toHaveBeenCalled();
  });

  it('does not connect in production', () => {
    const connectAuth = vi.fn();

    connectAuthEmulatorIfEnabled(PROD, auth, connectAuth);

    expect(connectAuth).not.toHaveBeenCalled();
  });
});

describe('connectFirestoreEmulatorIfEnabled', () => {
  it('connects the Firestore emulator when dev + useEmulators', () => {
    const connectFirestore = vi.fn();

    connectFirestoreEmulatorIfEnabled(DEV, firestore, connectFirestore);

    expect(connectFirestore).toHaveBeenCalledWith(
      firestore,
      FIRESTORE_EMULATOR_HOST,
      FIRESTORE_EMULATOR_PORT,
    );
  });

  it('does not connect when useEmulators is false', () => {
    const connectFirestore = vi.fn();

    connectFirestoreEmulatorIfEnabled(DEV_NO_EMU, firestore, connectFirestore);

    expect(connectFirestore).not.toHaveBeenCalled();
  });

  it('does not connect in production', () => {
    const connectFirestore = vi.fn();

    connectFirestoreEmulatorIfEnabled(PROD, firestore, connectFirestore);

    expect(connectFirestore).not.toHaveBeenCalled();
  });
});

describe('connectFunctionsEmulatorIfEnabled', () => {
  it('connects the Functions emulator when dev + useEmulators', () => {
    const connectFunctions: ConnectFunctionsFn = vi.fn();

    connectFunctionsEmulatorIfEnabled(DEV, fns, connectFunctions);

    expect(connectFunctions).toHaveBeenCalledWith(
      fns,
      FUNCTIONS_EMULATOR_HOST,
      FUNCTIONS_EMULATOR_PORT,
    );
  });

  it('does not connect when useEmulators is false', () => {
    const connectFunctions: ConnectFunctionsFn = vi.fn();

    connectFunctionsEmulatorIfEnabled(DEV_NO_EMU, fns, connectFunctions);

    expect(connectFunctions).not.toHaveBeenCalled();
  });

  it('does not connect in production', () => {
    const connectFunctions: ConnectFunctionsFn = vi.fn();

    connectFunctionsEmulatorIfEnabled(PROD, fns, connectFunctions);

    expect(connectFunctions).not.toHaveBeenCalled();
  });
});
