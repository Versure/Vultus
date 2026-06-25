import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { IonSkeletonText } from '@ionic/angular/standalone';

/**
 * VultusSkeletonCard — placeholder rows mimicking a watchlist / search result
 * list item (poster + title + meta + status badge) while data loads.
 *
 * @example
 * <vultus-skeleton-card [count]="6" />
 */
@Component({
  selector: 'vultus-skeleton-card',
  imports: [IonSkeletonText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (i of rows; track i) {
      <div class="vultus-skeleton-card__row">
        <ion-skeleton-text
          class="vultus-skeleton-card__poster"
          [animated]="true"
        />
        <div class="vultus-skeleton-card__body">
          <ion-skeleton-text
            class="vultus-skeleton-card__title"
            [animated]="true"
          />
          <ion-skeleton-text
            class="vultus-skeleton-card__meta"
            [animated]="true"
          />
          <ion-skeleton-text
            class="vultus-skeleton-card__badge"
            [animated]="true"
          />
        </div>
      </div>
    }
  `,
  styleUrl: './vultus-skeleton-card.component.scss',
})
export class VultusSkeletonCard {
  /** Number of skeleton rows to render. */
  @Input() count = 1;

  /** Iterable of row indices, derived from `count`, for the `@for` block. */
  get rows(): number[] {
    return Array.from({ length: this.count }, (_, i) => i);
  }
}
