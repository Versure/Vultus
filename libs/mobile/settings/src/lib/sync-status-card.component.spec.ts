import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import type { SyncRun } from '@vultus/shared/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the service module so the component test never pulls in the real
// `@angular/fire/firestore` import chain (rxfire ships ESM-in-CJS and breaks
// the jsdom transform). The component is tested against this token + a useValue.
interface MockSyncStatusService {
  lastRun: WritableSignal<SyncRun | null>;
  loaded: WritableSignal<boolean>;
  loadFailed: WritableSignal<boolean>;
  load: ReturnType<typeof vi.fn>;
}

vi.mock('./sync-status.service', () => ({
  SyncStatusService: class SyncStatusService {},
}));

import {
  SyncStatusCardComponent,
  relativeTime,
} from './sync-status-card.component';
import { SyncStatusService } from './sync-status.service';

function run(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    runId: 'run-1',
    kind: 'cron',
    userId: null,
    startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    completedAt: new Date(
      Date.now() - 3 * 60 * 60 * 1000 + 30_000,
    ).toISOString(),
    durationMs: 30_000,
    titlesGathered: 12,
    titlesUpdated: 3,
    errorCount: 0,
    errors: [],
    ...overrides,
  };
}

function mockService(
  lastRun: SyncRun | null,
  loaded = true,
  loadFailed = false,
): MockSyncStatusService {
  return {
    lastRun: signal<SyncRun | null>(lastRun),
    loaded: signal<boolean>(loaded),
    loadFailed: signal<boolean>(loadFailed),
    load: vi.fn().mockResolvedValue(undefined),
  };
}

async function setup(service: MockSyncStatusService) {
  await TestBed.configureTestingModule({
    imports: [SyncStatusCardComponent],
    providers: [
      provideIonicAngular(),
      { provide: SyncStatusService, useValue: service },
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(SyncStatusCardComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, service, el };
}

describe('SyncStatusCardComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('calls load() on init', async () => {
    const { service } = await setup(mockService(run()));
    expect(service.load).toHaveBeenCalledTimes(1);
  });

  it('loading: shows a skeleton and no stale content before load resolves', async () => {
    const { el } = await setup(mockService(null, false));
    expect(el.querySelector('ion-skeleton-text')).toBeTruthy();
    expect(el.querySelector('.sync-card__title')).toBeFalsy();
    expect(el.textContent).not.toContain('Never synced');
    expect(el.textContent).not.toContain('Last synced');
  });

  it('never-synced: "Never synced", no counts, no chip, sync-outline icon', async () => {
    const { el } = await setup(mockService(null));
    expect(el.querySelector('ion-skeleton-text')).toBeFalsy();
    expect(el.querySelector('.sync-card__title')?.textContent?.trim()).toBe(
      'Last synced',
    );
    expect(el.querySelector('.settings-row__helper')?.textContent?.trim()).toBe(
      'Never synced',
    );
    expect(el.querySelector('.sync-card__chip')).toBeFalsy();
    expect(el.querySelector('ion-icon')?.getAttribute('name')).toBe(
      'sync-outline',
    );
    expect(el.textContent).not.toContain('gathered');
  });

  it('load-failed renders identically to never-synced (no error affordance)', async () => {
    // On a failed read the service resolves the render-gate (loaded=true) while
    // leaving lastRun null, so the card renders the never-synced display — NOT a
    // perpetual skeleton — and shows no banner/toast/error string.
    const { el } = await setup(mockService(null, true, true));
    // No skeleton: the render-gate resolved on failure.
    expect(el.querySelector('ion-skeleton-text')).toBeFalsy();
    // Byte-identical to never-synced: "Last synced" title + "Never synced"
    // helper + sync-outline, no chip.
    expect(el.querySelector('.sync-card__title')?.textContent?.trim()).toBe(
      'Last synced',
    );
    expect(el.querySelector('.settings-row__helper')?.textContent?.trim()).toBe(
      'Never synced',
    );
    expect(el.querySelector('.sync-card__chip')).toBeFalsy();
    expect(el.querySelector('ion-icon')?.getAttribute('name')).toBe(
      'sync-outline',
    );
    // No error affordance anywhere.
    expect(el.textContent).not.toContain('gathered');
    expect(el.textContent?.toLowerCase()).not.toContain('error');
    expect(el.textContent?.toLowerCase()).not.toContain('failed');
    expect(el.textContent?.toLowerCase()).not.toContain('retry');
  });

  it('load-failed with loaded true (empty docs) shows never-synced, no error UI', async () => {
    const { el } = await setup(mockService(null, true, true));
    expect(el.querySelector('.settings-row__helper')?.textContent?.trim()).toBe(
      'Never synced',
    );
    expect(el.querySelector('.sync-card__chip')).toBeFalsy();
    expect(el.querySelector('ion-icon')?.getAttribute('name')).toBe(
      'sync-outline',
    );
  });

  it('success: relative time + counts, no error chip, sync-outline icon', async () => {
    const { el } = await setup(
      mockService(run({ titlesGathered: 12, titlesUpdated: 3, errorCount: 0 })),
    );
    const helper = el
      .querySelector('.settings-row__helper')
      ?.textContent?.trim();
    expect(helper).toContain('Last synced');
    expect(helper).toContain('3 hours ago');
    expect(helper).toContain('12 gathered');
    expect(helper).toContain('3 updated');
    expect(el.querySelector('.sync-card__chip')).toBeFalsy();
    expect(el.querySelector('ion-icon')?.getAttribute('name')).toBe(
      'sync-outline',
    );
    // No raw ISO string leaks into the UI.
    expect(helper).not.toContain('T');
    expect(helper).not.toContain('Z');
  });

  it('with-errors: danger chip "{n} errors" + alert-circle-outline, count only', async () => {
    const { el } = await setup(
      mockService(
        run({
          errorCount: 3,
          errors: ['secret-leaky-detail-should-not-render', 'another reason'],
        }),
      ),
    );
    const chip = el.querySelector('.sync-card__chip')?.textContent?.trim();
    expect(chip).toBe('3 errors');
    expect(el.querySelector('ion-icon')?.getAttribute('name')).toBe(
      'alert-circle-outline',
    );
    expect(el.querySelector('.sync-card__icon--error')).toBeTruthy();
    // COUNT ONLY — no specific error strings rendered anywhere.
    expect(el.textContent).not.toContain(
      'secret-leaky-detail-should-not-render',
    );
    expect(el.textContent).not.toContain('another reason');
  });

  it('with-errors: singular "1 error" pluralization', async () => {
    const { el } = await setup(mockService(run({ errorCount: 1 })));
    expect(el.querySelector('.sync-card__chip')?.textContent?.trim()).toBe(
      '1 error',
    );
  });
});

describe('relativeTime', () => {
  const NOW = new Date('2026-06-30T12:00:00.000Z').getTime();
  const minus = (ms: number) => new Date(NOW - ms).toISOString();

  it('< 60s → "just now"', () => {
    expect(relativeTime(minus(0), NOW)).toBe('just now');
    expect(relativeTime(minus(59_000), NOW)).toBe('just now');
  });

  it('a future timestamp (clock skew) → "just now"', () => {
    expect(relativeTime(new Date(NOW + 10_000).toISOString(), NOW)).toBe(
      'just now',
    );
  });

  it('minutes boundary: 1 minute / N minutes ago', () => {
    expect(relativeTime(minus(60_000), NOW)).toBe('1 minute ago');
    expect(relativeTime(minus(5 * 60_000), NOW)).toBe('5 minutes ago');
    expect(relativeTime(minus(59 * 60_000), NOW)).toBe('59 minutes ago');
  });

  it('hours boundary: 1 hour / N hours ago', () => {
    expect(relativeTime(minus(60 * 60_000), NOW)).toBe('1 hour ago');
    expect(relativeTime(minus(3 * 60 * 60_000), NOW)).toBe('3 hours ago');
    expect(relativeTime(minus(23 * 60 * 60_000), NOW)).toBe('23 hours ago');
  });

  it('days boundary: 1 day / N days ago', () => {
    expect(relativeTime(minus(24 * 60 * 60_000), NOW)).toBe('1 day ago');
    expect(relativeTime(minus(5 * 24 * 60 * 60_000), NOW)).toBe('5 days ago');
  });
});
