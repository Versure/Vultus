import '@angular/compiler';
import '@analogjs/vitest-angular/setup-snapshots';
import { NgModule, provideZonelessChangeDetection } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import {
  BrowserTestingModule,
  platformBrowserTesting,
} from '@angular/platform-browser/testing';

/**
 * Zoneless Angular TestBed setup under Analog/Vitest.
 *
 * Analog's `setupTestBed()` helper does not expose `errorOnUnknownElements` /
 * `errorOnUnknownProperties`, which the workspace requires (these strictness
 * flags were enforced by the previous `jest-preset-angular`
 * `setupZonelessTestEnv` setup). We therefore initialise the TestBed manually,
 * mirroring Analog's zoneless module (`provideZonelessChangeDetection`) while
 * keeping the strict unknown-element/property assertions.
 */
@NgModule({
  providers: [provideZonelessChangeDetection()],
})
class ZonelessTestModule {}

getTestBed().initTestEnvironment(
  [BrowserTestingModule, ZonelessTestModule],
  platformBrowserTesting(),
  {
    errorOnUnknownElements: true,
    errorOnUnknownProperties: true,
    teardown: { destroyAfterEach: true },
  },
);
