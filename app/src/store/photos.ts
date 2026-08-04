/**
 * Content-addressed photo store: local blobs in idb-keyval ('blob:<hash>'),
 * a persisted background upload queue per doc ('uploadq:<docId>'), and
 * download-on-demand from the blob HTTP API (see CONTRACTS.md).
 */
import { get as idbGet, set as idbSet, del as idbDel, update as idbUpdate } from 'idb-keyval';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { getServerConfig } from '../config';
import type { Id, PhotoRef, PhotoRole } from '../types';
import { decryptPhoto, encryptPhoto, importContentKey, type DocKey } from './crypto';
import { openDoc } from './docs';
import { sha256Hex } from './ids';
import { getHandlesSnapshot, getStoredHandle } from './registry';

/** Imported CryptoKeys per content key string (import is async, keys are stable). */
const keyCache = new Map<string, Promise<DocKey>>();

/**
 * Every doc is end-to-end encrypted; a handle without a content key cannot
 * read or write photos (the UI shows "key missing" for such docs).
 */
function docKeyFor(docId: Id): Promise<DocKey> | null {
  const keyB64 = getStoredHandle(docId)?.key;
  if (!keyB64) return null;
  let cached = keyCache.get(keyB64);
  if (!cached) {
    cached = importContentKey(keyB64);
    keyCache.set(keyB64, cached);
  }
  return cached;
}

const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.85;
const blobKey = (hash: string) => 'blob:' + hash;
const queueKey = (docId: Id) => 'uploadq:' + docId;

interface QueueEntry {
  hash: string;
  mime: string;
}

/* ---------- image normalization ---------- */

async function normalizeImage(blob: Blob): Promise<{ bytes: Blob; mime: string }> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    // Not decodable client-side; store as-is.
    return { bytes: blob, mime: blob.type || 'application/octet-stream' };
  }
  try {
    const maxEdge = Math.max(bmp.width, bmp.height);
    const alreadyCompact =
      maxEdge <= MAX_EDGE && (blob.type === 'image/jpeg' || blob.type === 'image/webp');
    if (alreadyCompact) return { bytes: blob, mime: blob.type };

    const scale = Math.min(1, MAX_EDGE / maxEdge);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { bytes: blob, mime: blob.type || 'application/octet-stream' };
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    if (!out) return { bytes: blob, mime: blob.type || 'application/octet-stream' };
    return { bytes: out, mime: 'image/jpeg' };
  } finally {
    bmp.close();
  }
}

/* ---------- add / get ---------- */

export async function addPhoto(
  docId: Id,
  itemId: Id,
  blob: Blob,
  role: PhotoRole = 'photo',
): Promise<PhotoRef> {
  const { bytes, mime } = await normalizeImage(blob);

  // Blobs are addressed by the hash of the CIPHERTEXT (the server only ever
  // sees opaque bytes). Encryption is deterministic per doc key, so the
  // address is stable and uploads stay idempotent. Locally we keep plaintext
  // under that same address; uploadOne re-encrypts (reproducibly) when it
  // pushes to the server.
  const keyPromise = docKeyFor(docId);
  if (!keyPromise) throw new Error('addPhoto: no content key for this inventory');
  const key = await keyPromise;
  const wire = await encryptPhoto(key, new Uint8Array(await bytes.arrayBuffer()), mime);
  const hash = await sha256Hex(wire.slice().buffer as ArrayBuffer);
  await idbSet(blobKey(hash), bytes);

  const ref: PhotoRef = { hash, mime, role, addedAt: Date.now() };
  const entry = openDoc(docId);
  const items = entry.doc.getMap<Y.Map<unknown>>('items');
  const item = items.get(itemId);
  if (item) {
    // Fresh read + write inside one transact. The photos array is a single
    // JSON value, so concurrent appends from two offline devices still
    // resolve last-writer-wins on the whole array (schema tradeoff, see
    // appendToArray in hooks.ts) — but the blob itself survives locally and
    // the photo can be re-attached.
    entry.doc.transact(() => {
      const current = item.get('photos');
      const photos = Array.isArray(current) ? [...(current as PhotoRef[])] : [];
      photos.push(ref);
      item.set('photos', photos);
    });
  } else {
    console.warn(`[store] addPhoto: item ${itemId} not found in ${docId}`);
  }

  void enqueueUpload(docId, hash, mime);
  return ref;
}

export async function getPhotoBlob(docId: Id, hash: string): Promise<Blob | null> {
  const local = await idbGet<Blob>(blobKey(hash)).catch(() => undefined);
  if (local) return local;

  const handle = getStoredHandle(docId);
  const token = handle?.rwToken ?? handle?.roToken;
  const keyPromise = docKeyFor(docId);
  if (!token || !keyPromise) return null;
  try {
    const res = await fetch(`${getServerConfig().httpUrl}/blobs/${docId}/${hash}`, {
      headers: { 'x-token': token },
    });
    if (!res.ok) return null;
    // The server returned ciphertext; decrypt before caching.
    const wire = new Uint8Array(await res.arrayBuffer());
    const plain = await decryptPhoto(await keyPromise, wire);
    if (!plain) {
      console.warn(`[store] photo ${hash} of ${docId} failed to decrypt`);
      return null;
    }
    const blob = new Blob([plain.bytes.slice().buffer as ArrayBuffer], { type: plain.mime });
    await idbSet(blobKey(hash), blob);
    return blob;
  } catch {
    return null;
  }
}

/* ---------- upload queue ---------- */

async function enqueueUpload(docId: Id, hash: string, mime: string): Promise<void> {
  // idbUpdate runs get+put in one IndexedDB transaction, so concurrent
  // enqueues/removals (other calls in this tab, or another tab's loop)
  // can't clobber each other with stale reads.
  await idbUpdate<QueueEntry[]>(queueKey(docId), (q = []) =>
    q.some((e) => e.hash === hash) ? q : [...q, { hash, mime }],
  );
  kickUploadLoop(docId);
}

export async function clearUploadQueue(docId: Id): Promise<void> {
  await idbDel(queueKey(docId)).catch(() => {});
}

const runningLoops = new Map<Id, { rerun: boolean }>();

/** Start the background upload loop for a doc if not already running. Cheap and idempotent. */
export function kickUploadLoop(docId: Id): void {
  const running = runningLoops.get(docId);
  if (running) {
    // The loop might be exiting on a just-turned-stale empty read; make it
    // re-check the queue before it goes away so this kick isn't lost.
    running.rerun = true;
    return;
  }
  const state = { rerun: false };
  runningLoops.set(docId, state);
  void (async () => {
    do {
      state.rerun = false;
      await runUploadLoop(docId);
    } while (state.rerun);
  })().finally(() => runningLoops.delete(docId));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runUploadLoop(docId: Id): Promise<void> {
  let backoff = 2000;
  for (;;) {
    const q = (await idbGet<QueueEntry[]>(queueKey(docId)).catch(() => undefined)) ?? [];
    if (q.length === 0) return;
    const token = getStoredHandle(docId)?.rwToken;
    if (!token) return; // no write access (yet); re-kicked when things change

    const entry = q[0];
    let done = false;
    try {
      done = await uploadOne(docId, token, entry);
    } catch {
      done = false; // network error -> backoff below
    }
    if (done) {
      // Atomic remove (see enqueueUpload): a plain get/filter/set here could
      // drop an entry enqueued between the read and the write.
      await idbUpdate<QueueEntry[]>(queueKey(docId), (latest = []) =>
        latest.filter((e) => e.hash !== entry.hash),
      );
      backoff = 2000;
    } else {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

/** Returns true when the entry can be removed from the queue. Throws on network errors. */
async function uploadOne(docId: Id, token: string, entry: QueueEntry): Promise<boolean> {
  const blob = await idbGet<Blob>(blobKey(entry.hash));
  if (!blob) {
    console.warn(`[store] upload: missing local blob ${entry.hash}, dropping`);
    return true;
  }
  const url = `${getServerConfig().httpUrl}/blobs/${docId}/${entry.hash}`;

  const keyPromise = docKeyFor(docId);
  if (!keyPromise) {
    console.warn(`[store] upload: no content key for ${docId}, dropping ${entry.hash}`);
    return true;
  }

  const head = await fetch(url, { method: 'HEAD', headers: { 'x-token': token } });
  if (head.ok) return true; // already on the server (dedupe)

  // Upload ciphertext only. Local blobs stay plaintext; deterministic
  // encryption reproduces exactly the bytes the entry hash addresses.
  const key = await keyPromise;
  const wire = await encryptPhoto(key, new Uint8Array(await blob.arrayBuffer()), entry.mime);
  const wireHash = await sha256Hex(wire.slice().buffer as ArrayBuffer);
  if (wireHash !== entry.hash) {
    console.warn(`[store] upload: ciphertext hash mismatch for ${entry.hash}, dropping`);
    return true;
  }

  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'x-token': token, 'content-type': 'application/octet-stream' },
    body: wire as BodyInit,
  });
  if (put.ok) return true;
  if (put.status === 413 || put.status === 400) {
    console.warn(`[store] upload: server rejected blob ${entry.hash} (${put.status}), dropping`);
    return true;
  }
  return false; // auth/5xx -> retry with backoff
}

function kickAllLoops(): void {
  for (const h of getHandlesSnapshot()) kickUploadLoop(h.docId);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', kickAllLoops);
  // Resume any queued uploads from a previous session.
  setTimeout(kickAllLoops, 2000);
}

/* ---------- object URL cache + hook ---------- */

const urlCache = new Map<string, { url: string; refs: number }>();

async function acquireUrl(docId: Id, hash: string): Promise<string | null> {
  const cached = urlCache.get(hash);
  if (cached) {
    cached.refs++;
    return cached.url;
  }
  const blob = await getPhotoBlob(docId, hash);
  if (!blob) return null;
  // Someone else may have created it while we were fetching.
  const again = urlCache.get(hash);
  if (again) {
    again.refs++;
    return again.url;
  }
  const url = URL.createObjectURL(blob);
  urlCache.set(hash, { url, refs: 1 });
  return url;
}

function releaseUrl(hash: string): void {
  const cached = urlCache.get(hash);
  if (!cached) return;
  cached.refs--;
  if (cached.refs <= 0) {
    urlCache.delete(hash);
    URL.revokeObjectURL(cached.url);
  }
}

/**
 * Object URL for a photo blob, or null while unavailable. Triggers a
 * background download from the blob server when the blob is not cached.
 */
export function usePhotoUrl(docId: Id, hash: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hash) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let held = false;
    acquireUrl(docId, hash).then((u) => {
      if (cancelled) {
        if (u) releaseUrl(hash);
        return;
      }
      held = u !== null;
      setUrl(u);
    });
    return () => {
      cancelled = true;
      if (held) releaseUrl(hash);
      setUrl(null);
    };
  }, [docId, hash]);

  return url;
}
