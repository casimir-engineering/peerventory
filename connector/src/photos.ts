/**
 * Photo fetch + decrypt (see CONTRACTS.md "Blob API"): GET
 * `<origin>/api/blobs/<docId>/<hash>` with the doc token in `x-token`
 * (the server sends `Access-Control-Allow-Origin: *`, so the extension
 * origin needs no host permission), then AES-GCM-decrypt the wire bytes.
 * Decrypted blobs are cached in the extension's IndexedDB.
 */

import { importContentKey, decryptPhoto } from './crypto';
import { syncToken } from './backup';
import { getCachedPhoto, putCachedPhoto } from './storage';
import type { ProfileHandle } from './types';

const keyCache = new Map<string, Promise<CryptoKey>>();

function docKey(keyB64: string): Promise<CryptoKey> {
  let cached = keyCache.get(keyB64);
  if (!cached) {
    cached = importContentKey(keyB64);
    keyCache.set(keyB64, cached);
  }
  return cached;
}

export async function fetchPhotoBlob(
  origin: string,
  handle: ProfileHandle,
  hash: string,
): Promise<Blob | null> {
  const cached = await getCachedPhoto(hash);
  if (cached) return cached;

  const token = syncToken(handle);
  if (!token || !handle.key) return null;
  try {
    const res = await fetch(`${origin}/api/blobs/${handle.docId}/${hash}`, {
      headers: { 'x-token': token },
    });
    if (!res.ok) return null;
    const wire = new Uint8Array(await res.arrayBuffer());
    const plain = await decryptPhoto(await docKey(handle.key), wire);
    if (!plain) return null;
    const buf = new Uint8Array(plain.bytes.byteLength);
    buf.set(plain.bytes);
    const blob = new Blob([buf.buffer], { type: plain.mime });
    await putCachedPhoto(hash, blob);
    return blob;
  } catch {
    return null;
  }
}

/** Small concurrency gate so a long result list doesn't fire 50 fetches at once. */
export function createFetchQueue(limit = 3): (task: () => Promise<void>) => void {
  let active = 0;
  const queue: Array<() => Promise<void>> = [];
  const next = (): void => {
    if (active >= limit) return;
    const task = queue.shift();
    if (!task) return;
    active++;
    void task().finally(() => {
      active--;
      next();
    });
  };
  return (task) => {
    queue.push(task);
    next();
  };
}
