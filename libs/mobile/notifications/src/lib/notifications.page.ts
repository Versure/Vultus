import { AsyncPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonItemOption,
  IonItemOptions,
  IonItemSliding,
  IonLabel,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToolbar,
  NavController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack,
  filmOutline,
  notificationsOffOutline,
  playCircleOutline,
  tvOutline,
  trash,
} from 'ionicons/icons';
import type { NotificationKind } from '@vultus/shared/domain';
import { VultusEmptyState, VultusSkeletonCard } from '@vultus/shared/ui-kit';
import { type Observable, map, shareReplay, startWith } from 'rxjs';
import {
  type NotificationRow,
  NotificationsService,
} from './notifications.service';
import { NOTIFICATIONS_PROVIDERS } from './notifications.providers';
import { relativeTime } from './relative-time';

/** A presentational row: the data row + a flag for the read/unread styling. */
interface NotificationVm extends NotificationRow {
  unread: boolean;
}

@Component({
  selector: 'lib-notifications',
  providers: [...NOTIFICATIONS_PROVIDERS],
  imports: [
    AsyncPipe,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonIcon,
    IonItem,
    IonItemSliding,
    IonItemOptions,
    IonItemOption,
    IonLabel,
    IonRefresher,
    IonRefresherContent,
    VultusSkeletonCard,
    VultusEmptyState,
  ],
  templateUrl: './notifications.page.html',
  styleUrl: './notifications.page.scss',
})
export class NotificationsPage {
  private readonly service = inject(NotificationsService);
  private readonly router = inject(Router);
  private readonly nav = inject(NavController);

  /**
   * View model for the list. `rows` is `null` until the first emission of the
   * realtime stream → the template renders skeletons; once it emits (even `[]`)
   * the empty state / list takes over (mirrors the watchlist `vm$` gating). The
   * `unreadIds` projection drives the "Mark all read" header action's
   * visibility and payload.
   */
  readonly vm$: Observable<{
    rows: NotificationVm[] | null;
    unreadIds: string[];
  }> = this.service.notifications$().pipe(
    map((rows) => {
      const vmRows = rows.map((r) => ({ ...r, unread: r.readAt === null }));
      return {
        rows: vmRows,
        unreadIds: vmRows.filter((r) => r.unread).map((r) => r.id),
      };
    }),
    startWith({ rows: null as NotificationVm[] | null, unreadIds: [] }),
    shareReplay({ bufferSize: 1, refCount: false }),
  );

  // Memoized poster streams keyed by tmdbId so the async pipe does not reopen a
  // Firestore listener on every change-detection pass (same reasoning as the
  // watchlist's provider cache).
  private readonly posterCache = new Map<number, Observable<string | null>>();

  constructor() {
    addIcons({
      arrowBack,
      notificationsOffOutline,
      trash,
      filmOutline,
      tvOutline,
      playCircleOutline,
    });
  }

  /** Memoized poster URL stream for a tmdbId (null → kind-icon fallback). */
  posterUrl$(tmdbId: number): Observable<string | null> {
    let stream = this.posterCache.get(tmdbId);
    if (!stream) {
      stream = this.service
        .posterUrl$(tmdbId)
        .pipe(shareReplay({ bufferSize: 1, refCount: false }));
      this.posterCache.set(tmdbId, stream);
    }
    return stream;
  }

  /** Ionicon name for the poster fallback, by notification kind. */
  kindIcon(kind: NotificationKind): string {
    switch (kind) {
      case 'episode-aired':
        return 'tv-outline';
      case 'movie-available':
        return 'film-outline';
      case 'show-came-to-platform':
        return 'play-circle-outline';
      // Leaving-platform kinds (spec 0057) reuse the title-type glyph so movie
      // vs show stays visually distinguishable; the body copy conveys "leaving".
      case 'movie-leaving-platform':
        return 'film-outline';
      case 'show-leaving-platform':
        return 'tv-outline';
      default:
        return 'notifications-off-outline';
    }
  }

  /** Relative timestamp for a row's `sentAt`. */
  timestamp(row: NotificationRow): string {
    return relativeTime(row.sentAt);
  }

  /**
   * Human-readable body line composed from `kind` + optional `providerName`
   * (the domain `NotificationPayload` carries no pre-rendered message). Mirrors
   * the Stitch copy ("New episode available on Apple TV+" / "Now streaming on
   * Hulu" / "Now available on Netflix").
   */
  body(row: NotificationRow): string {
    const on = row.payload.providerName
      ? ` on ${row.payload.providerName}`
      : '';
    switch (row.kind) {
      case 'episode-aired':
        return `New episode available${on}`;
      case 'movie-available':
        return `Now available${on}`;
      case 'show-came-to-platform':
        return `Now streaming${on}`;
      case 'movie-leaving-platform':
      case 'show-leaving-platform':
        return `Leaving your platform${on}`;
      default:
        return `Update${on}`;
    }
  }

  /**
   * Header back — return to Watchlist deterministically (notifications has a
   * single entry point today). Uses `NavController.navigateBack` rather than
   * `ion-back-button`'s `defaultHref` stack-fallback, which is ambiguous under
   * page-instance reuse / deep links (issue #253, spec 0092).
   */
  goBack(): void {
    void this.nav.navigateBack('/tabs/watchlist');
  }

  /** Row tap → mark read + deep-link to the title (string route, no slice import). */
  onRowTap(row: NotificationRow): void {
    void this.service.markRead(row.id);
    this.router
      .navigate(['tabs', 'title-detail', String(row.payload.tmdbId)])
      .catch(() => {
        // title-detail route absent → graceful no-op.
      });
  }

  /** Header action → batch mark all currently-unread rows read. */
  onMarkAllRead(unreadIds: string[]): void {
    void this.service.markAllRead(unreadIds);
  }

  /** Swipe option → delete one notification. */
  onDelete(row: NotificationRow): void {
    void this.service.remove(row.id);
  }

  /**
   * Pull-to-refresh: the list is a realtime Firestore stream, so the refresher
   * is a supplementary affordance — there is nothing to re-fetch (the stream
   * already pushes updates). Complete it immediately so it returns to idle.
   */
  onRefresh(event: CustomEvent): void {
    (event.detail as { complete: () => void }).complete();
  }
}
