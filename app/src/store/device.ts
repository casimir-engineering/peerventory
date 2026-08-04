/**
 * Stable identity of this device, used for the in-doc presence map so other
 * peers can see who an inventory last synchronized with.
 */
import type { DevicePresence } from '../types';
// Direct module import (not the services barrel), cycle-free: profile only
// imports types and store/ids.
import { getOwnerId } from '../services/profile';

const ID_KEY = 'deviceId:v1';

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(ID_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      localStorage.setItem(ID_KEY, id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

function platformLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Device';
}

/** Reads the profile name directly to avoid a store -> services barrel cycle. */
function ownerName(): string | null {
  try {
    const raw = localStorage.getItem('profile:v1');
    if (!raw) return null;
    const name = (JSON.parse(raw) as { userName?: unknown }).userName;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export function getDevicePresence(): DevicePresence {
  const name = ownerName();
  return {
    id: getDeviceId(),
    label: name ? `${name} · ${platformLabel()}` : platformLabel(),
    at: Date.now(),
    // Only meaningful once the user has a name; avoids minting an owner id
    // for anonymous devices.
    ...(name ? { ownerId: getOwnerId() } : {}),
  };
}
