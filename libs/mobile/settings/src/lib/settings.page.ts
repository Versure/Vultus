import { Component, type OnInit, inject } from '@angular/core';
import {
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import type { Region } from '@vultus/shared/domain';
import { SettingsService } from './settings.service';

@Component({
  selector: 'lib-settings',
  providers: [SettingsService],
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonNote,
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
