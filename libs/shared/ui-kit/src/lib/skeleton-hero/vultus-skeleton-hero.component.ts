import { ChangeDetectionStrategy, Component } from '@angular/core';
import { IonSkeletonText } from '@ionic/angular/standalone';

/**
 * VultusSkeletonHero — placeholder mimicking the title-detail hero (full-bleed
 * poster/backdrop + title, meta, overview lines and a card block) while the
 * title loads.
 *
 * @example
 * <vultus-skeleton-hero />
 */
@Component({
  selector: 'vultus-skeleton-hero',
  imports: [IonSkeletonText],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-skeleton-text class="vultus-skeleton-hero__hero" [animated]="true" />
    <div class="vultus-skeleton-hero__body">
      <ion-skeleton-text
        class="vultus-skeleton-hero__title"
        [animated]="true"
      />
      <ion-skeleton-text class="vultus-skeleton-hero__meta" [animated]="true" />
      <ion-skeleton-text
        class="vultus-skeleton-hero__line vultus-skeleton-hero__line--full"
        [animated]="true"
      />
      <ion-skeleton-text
        class="vultus-skeleton-hero__line vultus-skeleton-hero__line--full"
        [animated]="true"
      />
      <ion-skeleton-text
        class="vultus-skeleton-hero__line vultus-skeleton-hero__line--short"
        [animated]="true"
      />
      <ion-skeleton-text class="vultus-skeleton-hero__card" [animated]="true" />
    </div>
  `,
  styleUrl: './vultus-skeleton-hero.component.scss',
})
export class VultusSkeletonHero {}
