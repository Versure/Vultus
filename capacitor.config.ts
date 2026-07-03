import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.vultus.mobile',
  appName: 'Vultus',
  webDir: 'dist/apps/mobile/browser',
  // Native WebView surface paint (behind the display cutout / status bar).
  // = --vultus-surface / --ion-background-color; matches StatusBar & SplashScreen.
  backgroundColor: '#0b1326',
  plugins: {
    SplashScreen: {
      // The static native splash stays up until the app shell's animated web
      // splash (SplashComponent) renders and calls SplashScreen.hide() — a
      // same-color handoff into the Stitch splash screen animations.
      launchAutoHide: false,
      backgroundColor: '#0b1326',
      showSpinner: false,
      androidSplashResourceName: 'splash',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0b1326', // = --vultus-surface / --ion-background-color (dark navy)
      overlaysWebView: true,
    },
  },
};

export default config;
