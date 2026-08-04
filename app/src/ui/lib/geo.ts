/** Geolocation helper: never rejects, so a denied prompt cannot block item entry. */

import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { nearestPlaceLabel } from '../../services';
import type { LocationEntry } from '../../types';

export async function getCurrentLocation(timeoutMs = 8000): Promise<LocationEntry | null> {
  if (Capacitor.isNativePlatform()) {
    // Native (Android APK): the plugin handles runtime permission prompts,
    // which the bare WebView geolocation API does not.
    try {
      const perm = await Geolocation.requestPermissions();
      if (perm.location === 'denied') return null;
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: false,
        timeout: timeoutMs,
        maximumAge: 120_000,
      });
      return { time: Date.now(), lat: pos.coords.latitude, lon: pos.coords.longitude };
    } catch {
      return null;
    }
  }
  return webLocation(timeoutMs);
}

/**
 * A fix plus, when it lands within `maxMeters` of a place the user has saved
 * before, that place's label. Used to prefill an empty label; a label the user
 * already typed always wins, so the caller decides whether to take it.
 */
export async function getLocationWithPlace(
  timeoutMs = 8000,
  maxMeters = 250,
): Promise<LocationEntry | null> {
  const entry = await getCurrentLocation(timeoutMs);
  if (!entry || typeof entry.lat !== 'number' || typeof entry.lon !== 'number') return entry;
  try {
    const label = nearestPlaceLabel(entry.lat, entry.lon, maxMeters);
    return label ? { ...entry, label } : entry;
  } catch {
    return entry;
  }
}

function webLocation(timeoutMs: number): Promise<LocationEntry | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    let settled = false;
    const done = (value: LocationEntry | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        done({
          time: Date.now(),
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
        }),
      () => done(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 120_000 },
    );
    setTimeout(() => done(null), timeoutMs + 500);
  });
}
