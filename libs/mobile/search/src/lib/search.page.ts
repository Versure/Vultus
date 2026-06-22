import { Component, inject } from '@angular/core';
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

  retry(): void {
    this.service.retrySearch();
  }

  trackByTmdbId(_: number, r: SearchResultView): number {
    return r.tmdbId;
  }
}
