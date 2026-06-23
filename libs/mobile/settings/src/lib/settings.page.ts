import { Component, type OnInit, inject } from '@angular/core';
import {
  IonContent,
  IonHeader,
  IonIcon,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import type { Region } from '@vultus/shared/domain';
import { addIcons } from 'ionicons';
import { globeOutline, notificationsOutline } from 'ionicons/icons';
import { SettingsService } from './settings.service';

@Component({
  selector: 'lib-settings',
  providers: [SettingsService],
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonIcon,
    IonSelect,
    IonSelectOption,
    IonToggle,
    IonSpinner,
  ],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
})
export class SettingsPage implements OnInit {
  protected readonly service = inject(SettingsService);

  constructor() {
    addIcons({ globeOutline, notificationsOutline });
  }

  ngOnInit(): void {
    void this.service.load();
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
