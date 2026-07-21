import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Background Plex sync (spec 0085) is initialized in-app via PLEX_BACKGROUND_INIT
// (app.ts), which wires the settings slice's PlexBackgroundService.init(). The
// Capacitor background-fetch plugin has no JS headless API
// (registerHeadlessTask), so terminated-state (swiped-away) headless sync is a
// future native-Android task — deliberately NOT registered here, and no plugin
// import is added to this web/e2e entry point.
bootstrapApplication(App, appConfig).catch((err) => console.error(err));
