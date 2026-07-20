import { runInInjectionContext, Injector } from '@angular/core';
import { Router, type UrlTree } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONBOARDING_DONE_KEY,
  onboardingGuard,
  reverseOnboardingGuard,
} from './onboarding.guard';

// Mock @capacitor/preferences; `get` is stubbed per-test.
const preferencesGetMock =
  vi.fn<(opts: { key: string }) => Promise<{ value: string | null }>>();

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: (opts: { key: string }) => preferencesGetMock(opts),
  },
}));

// A sentinel UrlTree the mock Router returns from createUrlTree.
const urlTreeSentinel = { __urlTree: true } as unknown as UrlTree;
const createUrlTreeMock = vi.fn(() => urlTreeSentinel);

function runGuard(): Promise<boolean | UrlTree> {
  const injector = Injector.create({
    providers: [
      { provide: Router, useValue: { createUrlTree: createUrlTreeMock } },
    ],
  });
  // CanActivateFn takes (route, state); the guard ignores both. It returns a
  // Promise here, so await it inside the injection context.
  return runInInjectionContext(
    injector,
    () =>
      onboardingGuard(undefined as never, undefined as never) as Promise<
        boolean | UrlTree
      >,
  );
}

function runReverseGuard(): Promise<boolean | UrlTree> {
  const injector = Injector.create({
    providers: [
      { provide: Router, useValue: { createUrlTree: createUrlTreeMock } },
    ],
  });
  return runInInjectionContext(
    injector,
    () =>
      reverseOnboardingGuard(undefined as never, undefined as never) as Promise<
        boolean | UrlTree
      >,
  );
}

describe('onboardingGuard', () => {
  beforeEach(() => {
    preferencesGetMock.mockReset();
    createUrlTreeMock.mockClear();
  });

  it('flag true -> returns true', async () => {
    preferencesGetMock.mockResolvedValue({ value: 'true' });

    const result = await runGuard();

    expect(result).toBe(true);
    expect(preferencesGetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
    });
    expect(createUrlTreeMock).not.toHaveBeenCalled();
  });

  it('flag null -> returns UrlTree to /onboarding', async () => {
    preferencesGetMock.mockResolvedValue({ value: null });

    const result = await runGuard();

    expect(result).toBe(urlTreeSentinel);
    expect(createUrlTreeMock).toHaveBeenCalledWith(['/onboarding']);
  });

  it('flag non-true string -> returns UrlTree', async () => {
    preferencesGetMock.mockResolvedValue({ value: 'false' });

    const result = await runGuard();

    expect(result).toBe(urlTreeSentinel);
    expect(createUrlTreeMock).toHaveBeenCalledWith(['/onboarding']);
  });
});

describe('reverseOnboardingGuard', () => {
  beforeEach(() => {
    preferencesGetMock.mockReset();
    createUrlTreeMock.mockClear();
  });

  it('flag true -> returns UrlTree to /tabs/today', async () => {
    preferencesGetMock.mockResolvedValue({ value: 'true' });

    const result = await runReverseGuard();

    expect(result).toBe(urlTreeSentinel);
    expect(preferencesGetMock).toHaveBeenCalledWith({
      key: ONBOARDING_DONE_KEY,
    });
    expect(createUrlTreeMock).toHaveBeenCalledWith(['/tabs/today']);
  });

  it('flag null -> returns true (allows onboarding)', async () => {
    preferencesGetMock.mockResolvedValue({ value: null });

    const result = await runReverseGuard();

    expect(result).toBe(true);
    expect(createUrlTreeMock).not.toHaveBeenCalled();
  });

  it('flag non-true string -> returns true (allows onboarding)', async () => {
    preferencesGetMock.mockResolvedValue({ value: 'false' });

    const result = await runReverseGuard();

    expect(result).toBe(true);
    expect(createUrlTreeMock).not.toHaveBeenCalled();
  });
});
