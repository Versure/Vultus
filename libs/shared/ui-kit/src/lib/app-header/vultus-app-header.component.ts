import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  IonButtons,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { filmOutline } from 'ionicons/icons';

/**
 * VultusAppHeader — the shared tab-page header. Renders the fixed Vultus brand
 * mark (`film-outline` icon + "Vultus" wordmark) in the toolbar title, plus an
 * `ion-buttons slot="end"` whose per-page trailing buttons are supplied by the
 * consumer via content projection.
 *
 * There are no `@Input`s: the brand mark is identical on all four tab pages
 * (Today, Watchlist, Search, Settings); only the trailing buttons differ, so
 * they are projected. A single default `<ng-content>` is rendered inside the
 * toolbar's trailing `ion-buttons`, so Angular projects the consumer's bare
 * `<ion-button>` elements as children of `ion-buttons`, preserving Ionic's
 * toolbar-button styling.
 *
 * Icon ownership: this component registers **only** `filmOutline` (the brand
 * icon). Consumers keep registering their own button icons via `addIcons`.
 *
 * @example
 * <vultus-app-header>
 *   <ion-button aria-label="Account">
 *     <ion-icon name="person-circle-outline" slot="icon-only" />
 *   </ion-button>
 * </vultus-app-header>
 */
@Component({
  selector: 'vultus-app-header',
  imports: [IonHeader, IonToolbar, IonTitle, IonButtons, IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>
          <span class="brand-mark">
            <ion-icon name="film-outline" class="brand-icon"></ion-icon>
            Vultus
          </span>
        </ion-title>
        <ion-buttons slot="end">
          <ng-content></ng-content>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
  `,
  styleUrl: './vultus-app-header.component.scss',
})
export class VultusAppHeader {
  constructor() {
    addIcons({ filmOutline });
  }
}
