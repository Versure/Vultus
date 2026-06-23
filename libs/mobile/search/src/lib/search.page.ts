import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonBadge,
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonList,
  IonSearchbar,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  add,
  alertCircleOutline,
  checkmarkCircle,
  filmOutline,
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
    IonContent,
    IonSearchbar,
    IonList,
    IonBadge,
    IonButton,
    IonSpinner,
    IonIcon,
  ],
  providers: [SearchService],
  templateUrl: './search.page.html',
  styleUrl: './search.page.scss',
})
export class SearchPage {
  readonly service = inject(SearchService);
  private readonly router = inject(Router);

  constructor() {
    addIcons({ search, checkmarkCircle, add, alertCircleOutline, filmOutline });
  }

  onSearch(event: CustomEvent<{ value?: string | null }>): void {
    this.service.setQuery(event.detail?.value ?? '');
  }

  onAdd(result: SearchResultView, event: Event): void {
    event.stopPropagation();
    void this.service.add(result);
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
