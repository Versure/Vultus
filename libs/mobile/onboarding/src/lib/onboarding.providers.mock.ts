import { Injectable } from '@angular/core';
import { REGIONS, type Region } from '@vultus/shared/domain';
import { OnboardingService } from './onboarding.service';

/**
 * Mock onboarding service for the `mock` build profile (spec 0018 / 0022).
 *
 * Build-time file replacement swaps `onboarding.providers.ts` for this file so
 * the Onboarding page renders and "Get started" works with no Firebase and no
 * native plugins. It does NOT extend `OnboardingService` (that injects
 * `Firestore` / `AUTH_UID`); it structurally mirrors the public surface —
 * `regions` and `complete()` — resolving `complete()` immediately.
 */
@Injectable()
class MockOnboardingServiceImpl {
  readonly regions: readonly Region[] = REGIONS;

  complete(region: Region): Promise<void> {
    void region;
    return Promise.resolve();
  }
}

export const ONBOARDING_PROVIDERS = [
  { provide: OnboardingService, useClass: MockOnboardingServiceImpl },
] as const;
