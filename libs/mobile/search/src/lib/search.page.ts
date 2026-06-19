import { Component } from '@angular/core';
import {
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

@Component({
  selector: 'lib-search',
  imports: [IonHeader, IonToolbar, IonTitle, IonContent],
  templateUrl: './search.page.html',
  styleUrl: './search.page.scss',
})
export class SearchPage {}
