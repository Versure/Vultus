import { Component } from '@angular/core';
import {
  IonIcon,
  IonLabel,
  IonTabBar,
  IonTabButton,
  IonTabs,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { list, search, settings } from 'ionicons/icons';

/**
 * Tabs shell (spec 0010): the app's root navigation. Three tabs —
 * Watchlist (default) / Search / Settings — matching the Stitch "Vultus Media
 * Tracker" shell screen (projects/13590348714018893783 screen
 * 7a448e26ae574f15820a175aa2bca453): icons view_list / search / settings,
 * mapped to ionicons `list` / `search` / `settings`. Child routes lazy-load
 * each slice's page (see app.routes.ts).
 */
@Component({
  selector: 'app-tabs',
  imports: [IonTabs, IonTabBar, IonTabButton, IonLabel, IonIcon],
  templateUrl: './tabs.page.html',
  styleUrl: './tabs.page.scss',
})
export class TabsPage {
  constructor() {
    addIcons({ list, search, settings });
  }
}
