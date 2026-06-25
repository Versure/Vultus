import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
} from '@angular/core';
import { IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { alertCircleOutline, refreshOutline } from 'ionicons/icons';

/**
 * VultusErrorState — centered error icon + message + a "Try again" button that
 * emits `retry`. Registers its own icons, so consumers do not need to.
 *
 * @example
 * <vultus-error-state
 *   message="Couldn't load your watchlist."
 *   (retry)="reload()" />
 */
@Component({
  selector: 'vultus-error-state',
  imports: [IonButton, IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-icon class="vultus-error-state__icon" name="alert-circle-outline" />
    <p class="vultus-error-state__message">{{ message }}</p>
    <ion-button
      class="vultus-error-state__button"
      fill="outline"
      color="primary"
      (click)="retry.emit()"
    >
      <ion-icon name="refresh-outline" slot="start" />
      Try again
    </ion-button>
  `,
  styleUrl: './vultus-error-state.component.scss',
})
export class VultusErrorState {
  /** The error message shown above the retry button. */
  @Input() message = 'Something went wrong';

  /** Emits when the user taps "Try again". */
  @Output() retry = new EventEmitter<void>();

  constructor() {
    addIcons({ refreshOutline, alertCircleOutline });
  }
}
