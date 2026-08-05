import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single version source of truth: package.json feeds both the web bundle
// (__APP_VERSION__, what the in-app updater compares against the latest
// GitHub release tag) and Android's versionName/versionCode, which
// android/app/build.gradle reads from this same file.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registration happens manually in main.tsx (web only, skipped in the APK).
      injectRegister: null,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // OCR engine + language data (~9.5 MB) stay out of the install-time
        // precache; they are fetched on first scan and then cached below.
        globIgnores: ['ocr/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/ocr\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'ocr-assets',
              expiration: { maxEntries: 8 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Inventory',
        short_name: 'Inventory',
        description: 'Local-first inventory for customs and forwarding',
        theme_color: '#101418',
        background_color: '#101418',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  server: { port: 5173 },
});
