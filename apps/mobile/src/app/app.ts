import { Component, OnInit } from '@angular/core';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

@Component({
  imports: [IonApp, IonRouterOutlet],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected title = 'mobile';

  ngOnInit(): void {
    // Fire-and-forget: ngOnInit must return void (OnInit contract). The
    // edge-to-edge StatusBar setup is native-only and guarded below.
    void this.initStatusBar();
  }

  private async initStatusBar(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    await StatusBar.setOverlaysWebView({ overlay: true });
    await StatusBar.setStyle({ style: Style.Dark });
  }
}
