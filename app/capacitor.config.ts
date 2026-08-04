import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.raph.inventory',
  appName: 'Inventory',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;
