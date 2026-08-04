/**
 * chrome.storage.local keys. Everything sensitive (tokens, E2E content keys)
 * lives ONLY here — never chrome.storage.sync, never any server except the
 * relay the tokens belong to. Decrypted photo thumbnails are cached in the
 * extension's own IndexedDB (blobs can't live in chrome.storage).
 */

import type { CacheMap, CachedInventory, ListingPayload, Profile } from './types';

export const PROFILE_KEY = 'pv:profile';
export const CACHE_KEY = 'pv:cache';
/** Listing payload consumed by the content scripts (existing contract). */
export const PAYLOAD_KEY = 'pv:payload';
/** One-shot autofill request for a tab the popup just opened. */
export const PENDING_KEY = 'pv:pending';

export async function getProfile(): Promise<Profile | null> {
  const data = await chrome.storage.local.get(PROFILE_KEY);
  return (data[PROFILE_KEY] as Profile | undefined) ?? null;
}

export async function setProfile(profile: Profile): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}

export async function getCache(): Promise<CacheMap> {
  const data = await chrome.storage.local.get(CACHE_KEY);
  return (data[CACHE_KEY] as CacheMap | undefined) ?? {};
}

export async function putCachedInventory(inv: CachedInventory): Promise<void> {
  const cache = await getCache();
  cache[inv.docId] = inv;
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

export async function setPayload(payload: ListingPayload): Promise<void> {
  await chrome.storage.local.set({ [PAYLOAD_KEY]: payload });
}

export async function setPendingFill(site: 'anibis' | 'facebook'): Promise<void> {
  await chrome.storage.local.set({ [PENDING_KEY]: { site, at: Date.now() } });
}

/** Forget everything: profile, caches, payload, photo thumbnails. */
export async function clearAll(): Promise<void> {
  await chrome.storage.local.remove([PROFILE_KEY, CACHE_KEY, PAYLOAD_KEY, PENDING_KEY]);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(PHOTO_DB);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/* ---------- photo blob cache (IndexedDB) ---------- */

const PHOTO_DB = 'pv-photos';
const PHOTO_STORE = 'blobs';

function openPhotoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PHOTO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedPhoto(hash: string): Promise<Blob | null> {
  try {
    const db = await openPhotoDb();
    return await new Promise((resolve) => {
      const req = db.transaction(PHOTO_STORE).objectStore(PHOTO_STORE).get(hash);
      req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function putCachedPhoto(hash: string, blob: Blob): Promise<void> {
  try {
    const db = await openPhotoDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(PHOTO_STORE, 'readwrite');
      tx.objectStore(PHOTO_STORE).put(blob, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // Cache miss next time; not fatal.
  }
}
