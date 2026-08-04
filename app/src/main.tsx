import React from 'react';
import ReactDOM from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import { hasOpenModal } from './ui/components/Modal';

// The service worker exists for offline use of the *website*. Inside the
// Capacitor APK the assets are already bundled locally, and a SW would keep
// serving stale builds after app updates — so register it on web only, and
// actively remove any SW a previous APK version may have registered.
if (!Capacitor.isNativePlatform()) {
  registerSW({ immediate: true });
} else if ('serviceWorker' in navigator) {
  void navigator.serviceWorker
    .getRegistrations()
    .then((regs) => Promise.all(regs.map((r) => r.unregister())))
    .catch(() => {});
}

// Android system back button: close an open modal first, then walk the
// hash-router history (item sheet -> inventory -> main list), and only quit
// the app from the root inventories screen.
if (Capacitor.isNativePlatform()) {
  void import('@capacitor/app').then(({ App: CapacitorApp }) => {
    void CapacitorApp.addListener('backButton', () => {
      if (hasOpenModal()) {
        // Every Modal closes on Escape; reuse that path so back dismisses the
        // dialog without touching navigation state.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        return;
      }
      const hash = window.location.hash;
      const atRoot = hash === '' || hash === '#' || hash === '#/';
      if (atRoot) void CapacitorApp.exitApp();
      else window.history.back();
    });
  });
}

// Dev console access to the store/services, used for seeding demo data
// (e.g. the README screenshots) and for debugging. Never part of prod builds.
if (import.meta.env.DEV) {
  void Promise.all([import('./store'), import('./services')]).then(([store, services]) => {
    (window as unknown as Record<string, unknown>).__store = store;
    (window as unknown as Record<string, unknown>).__services = services;
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
