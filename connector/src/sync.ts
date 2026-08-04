/**
 * Read-only relay sync: for each handle, connect a Hocuspocus provider to
 * the OUTER doc (wss `<origin>/sync`, auth token JSON per CONTRACTS.md),
 * wait for the initial server sync, decrypt the log into items, disconnect.
 *
 * The connector authenticates with the read-only token when the profile has
 * one and NEVER appends to the log, so from the relay's point of view it is
 * just one more (read-mostly) device.
 */

import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { syncToken } from './backup';
import { decryptOuterDoc, ENC_LOG_NAME, readInventory } from './materialize';
import type { CachedInventory, ProfileHandle } from './types';

const SYNC_TIMEOUT_MS = 12_000;

function wsUrl(origin: string): string {
  return origin.replace(/^http/, 'ws') + '/sync';
}

/** Resolves when the provider reports the initial sync; rejects on auth failure/timeout. */
function connectAndSync(url: string, docId: string, token: string, outer: Y.Doc): Promise<HocuspocusProvider> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let provider: HocuspocusProvider | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        provider?.destroy();
      } catch { /* already down */ }
      reject(new Error('Relay not reachable (timeout)'));
    }, SYNC_TIMEOUT_MS);

    provider = new HocuspocusProvider({
      url,
      name: docId,
      document: outer,
      token: JSON.stringify({ t: token }),
      onSynced: ({ state }) => {
        if (!state || settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(provider!);
      },
      onAuthenticationFailed: ({ reason }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          provider?.destroy();
        } catch { /* already down */ }
        reject(new Error(`Access rejected by relay (${reason})`));
      },
    });
  });
}

/** Sync one inventory and return its cache entry. Throws with a user-readable message. */
export async function syncInventory(
  origin: string,
  handle: ProfileHandle,
): Promise<CachedInventory> {
  const token = syncToken(handle);
  if (!token) throw new Error('No access token in the profile link');
  if (!handle.key) throw new Error('No encryption key in the profile link');

  const outer = new Y.Doc();
  let provider: HocuspocusProvider | null = null;
  try {
    provider = await connectAndSync(wsUrl(origin), handle.docId, token, outer);
    const { inner, entries, skipped } = await decryptOuterDoc(outer, handle.docId, handle.key);
    const { name, items } = readInventory(inner, handle.docId);
    inner.destroy();
    if (entries > 0 && skipped === entries) {
      throw new Error('Could not decrypt this inventory (wrong key?)');
    }
    // A brand-new doc legitimately has no log; an unreadable one is caught above.
    void outer.getArray(ENC_LOG_NAME);
    return {
      docId: handle.docId,
      name: name ?? handle.name ?? handle.docId,
      syncedAt: Date.now(),
      items,
    };
  } finally {
    try {
      provider?.destroy();
    } catch { /* socket already closed */ }
    outer.destroy();
  }
}
