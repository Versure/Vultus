import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';

/**
 * VultusEmptyState — centered icon + title (+ optional subtitle) for "no data
 * yet" / "nothing here" states.
 *
 * The consumer is responsible for registering the Ionicon it passes via
 * `icon` (call `addIcons(...)` in the host component) — this component does
 * NOT register any icons.
 *
 * @example
 * <vultus-empty-state
 *   icon="film-outline"
 *   title="Your watchlist is empty"
 *   subtitle="Search for a movie or show to add it." />
 */
@Component({
  selector: 'vultus-empty-state',
  imports: [IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-icon class="vultus-empty-state__icon" [name]="icon" />
    <p class="vultus-empty-state__title">{{ title }}</p>
    @if (subtitle) {
      <p class="vultus-empty-state__subtitle">{{ subtitle }}</p>
    }
  `,
  styleUrl: './vultus-empty-state.component.scss',
})
export class VultusEmptyState {
  /** Ionicons name. The consumer must register this icon via `addIcons`. */
  @Input({ required: true }) icon!: string;

  /** Primary headline of the empty state. */
  @Input({ required: true }) title!: string;

  /** Optional supporting copy. Hidden when empty. */
  @Input() subtitle = '';
}
