import { Component, type OnInit, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSelect,
  IonSelectOption,
  IonSkeletonText,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import type { Region } from '@vultus/shared/domain';
import { VultusErrorState } from '@vultus/shared/ui-kit';
import { addIcons } from 'ionicons';
import {
  filmOutline,
  globeOutline,
  notificationsOutline,
  personCircleOutline,
} from 'ionicons/icons';
import { SETTINGS_PROVIDERS } from './settings.providers';
import { SettingsService } from './settings.service';

@Component({
  selector: 'lib-settings',
  providers: [...SETTINGS_PROVIDERS],
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonIcon,
    IonSelect,
    IonSelectOption,
    IonToggle,
    IonSkeletonText,
    VultusErrorState,
  ],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
})
export class SettingsPage implements OnInit {
  protected readonly service = inject(SettingsService);

  constructor() {
    addIcons({
      globeOutline,
      notificationsOutline,
      filmOutline,
      personCircleOutline,
    });
  }

  ngOnInit(): void {
    void this.service.load();
  }

  protected retry(): void {
    this.service.retryLoad();
  }

  protected onRegionChange(event: CustomEvent): void {
    void this.service.setRegion((event.detail as { value: Region }).value);
  }

  protected onNotificationsChange(event: CustomEvent): void {
    void this.service.setNotificationsEnabled(
      (event.detail as { checked: boolean }).checked,
    );
  }
}
