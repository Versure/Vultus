import { Injectable } from '@angular/core';
import { type Observable, of } from 'rxjs';
import {
  type NotificationRow,
  NotificationsService,
} from './notifications.service';

/**
 * Mock notifications service for the `mock` build profile (spec 0042 §7).
 *
 * Build-time `fileReplacements` swaps `notifications.providers.ts` for this file
 * so the inbox renders seeded rows with no Firebase. It does NOT extend
 * `NotificationsService` (that injects `Firestore` / `AUTH_UID`); it structurally
 * mirrors the public surface (`notifications$`, `posterUrl$`, `markRead`,
 * `markAllRead`, `remove`).
 *
 * The seed deliberately exercises EVERY row state under `--configuration=mock`:
 * unread + read, with-poster + no-poster (icon fallback), and all three
 * notification kinds — so a visual check covers the full §6 contract.
 */
@Injectable()
class MockNotificationsServiceImpl {
  private readonly now = Date.now();

  private iso(msAgo: number): string {
    return new Date(this.now - msAgo).toISOString();
  }

  // Posters keyed by tmdbId; a tmdbId absent from this map → null (icon).
  private readonly posters: Record<number, string> = {
    1: 'https://image.tmdb.org/t/p/w185/9PFonBhy4cQy7Jz20NpMygczOkv.jpg',
    3: 'https://image.tmdb.org/t/p/w185/czembW0Rk1Ke7lCJGahbOhdCuhV.jpg',
  };

  private readonly rows: NotificationRow[] = [
    {
      id: 'n1',
      titleId: '1',
      kind: 'episode-aired',
      payload: {
        tmdbId: 1,
        titleId: '1',
        title: 'Severance',
        region: 'NL',
        providerName: 'Apple TV+',
      },
      sentAt: this.iso(2 * 60 * 60 * 1000), // 2h ago, unread, poster
      readAt: null,
    },
    {
      id: 'n2',
      titleId: '2',
      kind: 'show-came-to-platform',
      payload: {
        tmdbId: 2, // no poster → icon fallback
        titleId: '2',
        title: 'The Bear',
        region: 'NL',
        providerName: 'Hulu',
      },
      sentAt: this.iso(5 * 60 * 60 * 1000), // 5h ago, unread, icon
      readAt: null,
    },
    {
      id: 'n3',
      titleId: '3',
      kind: 'movie-available',
      payload: {
        tmdbId: 3,
        titleId: '3',
        title: 'Dune: Part Two',
        region: 'NL',
        providerName: 'Netflix',
      },
      sentAt: this.iso(28 * 60 * 60 * 1000), // Yesterday, unread, poster
      readAt: null,
    },
    {
      id: 'n4',
      titleId: '4',
      kind: 'episode-aired',
      payload: {
        tmdbId: 4, // no poster → icon fallback, read
        titleId: '4',
        title: 'Shogun',
        region: 'NL',
      },
      sentAt: this.iso(2 * 24 * 60 * 60 * 1000), // 2 days ago, read
      readAt: this.iso(2 * 24 * 60 * 60 * 1000),
    },
    {
      id: 'n5',
      titleId: '5',
      kind: 'show-came-to-platform',
      payload: {
        tmdbId: 5,
        titleId: '5',
        title: 'Fallout',
        region: 'NL',
        providerName: 'Prime Video',
      },
      sentAt: this.iso(8 * 24 * 60 * 60 * 1000), // 1 week ago, read
      readAt: this.iso(7 * 24 * 60 * 60 * 1000),
    },
  ];

  notifications$(): Observable<NotificationRow[]> {
    return of(this.rows);
  }

  posterUrl$(tmdbId: number): Observable<string | null> {
    return of(this.posters[tmdbId] ?? null);
  }

  markRead(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.readAt = new Date().toISOString();
    }
    return Promise.resolve();
  }

  markAllRead(unreadIds: string[]): Promise<void> {
    for (const id of unreadIds) {
      const row = this.rows.find((r) => r.id === id);
      if (row) {
        row.readAt = new Date().toISOString();
      }
    }
    return Promise.resolve();
  }

  remove(id: string): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.rows.splice(idx, 1);
    }
    return Promise.resolve();
  }
}

export const NOTIFICATIONS_PROVIDERS = [
  { provide: NotificationsService, useClass: MockNotificationsServiceImpl },
] as const;
