import { Component } from '@angular/core';
import {
  IonIcon,
  IonLabel,
  IonTabBar,
  IonTabButton,
  IonTabs,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { list, search, settings, todayOutline } from 'ionicons/icons';

/**
 * Tabs shell (spec 0010 + 0083): the app's root navigation. Four tabs —
 * Today (default) / Watchlist / Search / Settings. The Watch Today tab (spec
 * 0083) is placed leftmost and is the default landing route (D1) — an
 * intentional ORDER deviation from the Stitch reference screen, which renders
 * Today as the 3rd tab. The other three mirror the Stitch "Vultus Media
 * Tracker" shell screen (projects/13590348714018893783 screen
 * 7a448e26ae574f15820a175aa2bca453): icons view_list / search / settings,
 * mapped to ionicons `list` / `search` / `settings`; Today uses `today-outline`.
 * Child routes lazy-load each slice's page (see app.routes.ts).
 */
@Component({
  selector: 'app-tabs',
  imports: [IonTabs, IonTabBar, IonTabButton, IonLabel, IonIcon],
  templateUrl: './tabs.page.html',
  styleUrl: './tabs.page.scss',
})
export class TabsPage {
  constructor() {
    addIcons({ list, search, settings, todayOutline });
  }
}
