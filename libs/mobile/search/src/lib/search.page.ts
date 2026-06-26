import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonList,
  IonSearchbar,
  IonTitle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import {
  VultusEmptyState,
  VultusErrorState,
  VultusSkeletonCard,
} from '@vultus/shared/ui-kit';
import { addIcons } from 'ionicons';
import {
  add,
  checkmarkCircle,
  filmOutline,
  personCircleOutline,
  search,
} from 'ionicons/icons';
import { SearchService } from './search.service';
import type { SearchResultView } from './search.service';

@Component({
  selector: 'lib-search',
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonSearchbar,
    IonList,
    IonBadge,
    IonIcon,
    VultusSkeletonCard,
    VultusEmptyState,
    VultusErrorState,
  ],
  providers: [SearchService],
  templateUrl: './search.page.html',
  styleUrl: './search.page.scss',
})
export class SearchPage {
  readonly service = inject(SearchService);
  private readonly router = inject(Router);
  private readonly toastCtrl = inject(ToastController);

  constructor() {
    addIcons({
      search,
      checkmarkCircle,
      add,
      filmOutline,
      personCircleOutline,
    });
  }

  onSearch(event: CustomEvent<{ value?: string | null }>): void {
    this.service.setQuery(event.detail?.value ?? '');
  }

  async onAdd(result: SearchResultView, event: Event): Promise<void> {
    event.stopPropagation();
    try {
      await this.service.add(result);
    } catch {
      const toast = await this.toastCtrl.create({
        message: 'Failed to add — try again later',
        duration: 3000,
        position: 'bottom',
        color: 'danger',
      });
      await toast.present();
    }
  }

  openDetail(result: SearchResultView): void {
    void this.router.navigate(['tabs', 'title-detail', String(result.tmdbId)]);
  }

  retry(): void {
    this.service.retrySearch();
  }

  trackByTmdbId(_: number, r: SearchResultView): number {
    return r.tmdbId;
  }
}
