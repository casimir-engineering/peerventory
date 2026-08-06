import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.raph.inventory',
  appName: 'Peerventory',
  webDir: 'dist',
  android: {
    // LAN device-to-device signaling uses ws:// endpoints discovered via
    // mDNS (no TLS possible on link-local addresses); the payloads that ride
    // them are already E2E-protected (opaque room hashes + encrypted SDP).
    allowMixedContent: true,
  },
};

export default config;
