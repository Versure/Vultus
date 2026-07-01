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
      launchShowDuration: 500,
      launchAutoHide: true,
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
