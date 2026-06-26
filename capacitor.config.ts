import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.vultus.mobile',
  appName: 'Vultus',
  webDir: 'dist/apps/mobile/browser',
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
