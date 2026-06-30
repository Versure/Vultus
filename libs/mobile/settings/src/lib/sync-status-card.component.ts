import { Component, type OnInit, computed, inject } from '@angular/core';
import { IonIcon, IonSkeletonText } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { alertCircleOutline, syncOutline } from 'ionicons/icons';
import { SyncStatusService } from './sync-status.service';

/**
 * Read-only "Last synced" card on the Settings page (spec 0049).
 *
 * Renders the single most-recent `sync-runs` record from `SyncStatusService`
 * as an additional `.settings-card` / `.settings-row` in the page's card stack
 * — matching the sibling Region/Notifications cards. It is NON-interactive: no
 * click handler, no focus ring, no toggle/select.
 *
 * States (see spec UI/Stitch refs per-state acceptance list):
 * - loading: an `ion-skeleton-text` placeholder; never stale/blank content.
 * - never-synced (`lastRun() === null`): "Never synced", no counts/chip,
 *   `sync-outline`.
 * - load-failed: renders IDENTICALLY to never-synced (the service leaves
 *   `lastRun` null on failure) — no error affordance, banner, or toast.
 * - success (`errorCount === 0`): relative time + "{gathered} gathered ·
 *   {updated} updated", no chip, `sync-outline`.
 * - with-errors (`errorCount > 0`): relative time + counts + a danger
 *   "{n} error(s)" chip + `alert-circle-outline`. COUNT ONLY — no error strings.
 *
 * SHERIFF: `scope:mobile` / `slice:settings`. Imports only Ionic (third-party)
 * and this slice's `SyncStatusService`. No cross-slice / `apps/mobile` /
 * `scope:functions` import.
 */
@Component({
  selector: 'lib-sync-status-card',
  imports: [IonIcon, IonSkeletonText],
  templateUrl: './sync-status-card.component.html',
  styleUrl: './sync-status-card.component.scss',
})
export class SyncStatusCardComponent implements OnInit {
  protected readonly service = inject(SyncStatusService);

  /** True while the one-shot query is in flight (before `load()` resolves). */
  protected readonly loading = computed(() => !this.service.loaded());

  /** The most-recent run, or null (never-synced / load-failed). */
  protected readonly run = this.service.lastRun;

  /** Whether the last run reported errors (drives the icon swap + chip). */
  protected readonly hasErrors = computed(() => {
    const r = this.service.lastRun();
    return r !== null && r.errorCount > 0;
  });

  /** Ionicon name: alert in danger when the last run errored, else sync. */
  protected readonly iconName = computed(() =>
    this.hasErrors() ? 'alert-circle-outline' : 'sync-outline',
  );

  /** Value/helper line: "Never synced" or "Last synced <rel> · <counts>". */
  protected readonly valueLine = computed(() => {
    const r = this.service.lastRun();
    if (r === null) {
      return 'Never synced';
    }
    const rel = relativeTime(r.startedAt, Date.now());
    return `Last synced ${rel} · ${r.titlesGathered} gathered · ${r.titlesUpdated} updated`;
  });

  /** Pluralized error-chip label, or null when there is no error chip. */
  protected readonly errorChipLabel = computed(() => {
    const r = this.service.lastRun();
    if (r === null || r.errorCount <= 0) {
      return null;
    }
    return `${r.errorCount} ${r.errorCount === 1 ? 'error' : 'errors'}`;
  });

  constructor() {
    addIcons({ syncOutline, alertCircleOutline });
  }

  ngOnInit(): void {
    void this.service.load();
  }
}

/**
 * Pure relative-time formatter for the "Last synced …" line.
 *
 * Returns a coarse, human-readable phrase derived from `iso` relative to `now`
 * (both ms-comparable). Boundaries: < 60s → "just now"; < 60min → "N minute(s)
 * ago"; < 24h → "N hour(s) ago"; else "N day(s) ago". A future timestamp
 * (clock skew) collapses to "just now". Unit-tested separately.
 */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  const deltaMs = now - then;

  if (Number.isNaN(then) || deltaMs < 60_000) {
    return 'just now';
  }

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
