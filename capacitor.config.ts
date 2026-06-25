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
  },
};

export default config;
