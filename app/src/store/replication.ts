/**
 * Replication policy (see CONTRACTS.md "Multi-relay replication"):
 *
 * - Inventories OWNED by this account replicate automatically to every relay
 *   enabled on the device: whenever the relay set or the registry changes,
 *   any owned inventory missing an enabled relay is pushed there (doc
 *   registration via the create-handshake plus photo upload queueing).
 * - Joined/shared inventories never replicate automatically — pushing
 *   someone else's inventory onto relays they know nothing about is an
 *   explicit act (per-inventory button, or the prompt after adding a relay).
 *
 * Ownership test: `owned: true` is stamped on the handle at creation and
 * propagated across the account through the profile doc. Inventories that
 * predate the flag fall back to a capability test: holding BOTH tokens with
 * server-confirmed (or pending-create) write access. Rationale: creators
 * mint both tokens, while share links carry exactly one — and registering a
 * doc on a new relay REQUIRES both tokens anyway, so the fallback matches
 * what replication can actually do. (A collaborator who was explicitly given
 * both tokens is treated as a co-owner; that is the documented tradeoff.)
 */
import type { Id, InventoryHandle } from '../types';
import { openDoc, resyncDoc } from './docs';
import { enqueueDocPhotos, kickUploadLoop } from './photos';
import {
  defaultRelayOrigin,
  enabledRelayOrigins,
  mergeRelayLists,
  subscribeRelays,
} from './relays';
import {
  getHandlesSnapshot,
  getStoredHandle,
  subscribeRegistry,
  updateHandle,
  type StoredHandle,
} from './registry';

export function isOwnedInventory(h: InventoryHandle | StoredHandle | null): boolean {
  if (!h) return false;
  if (h.owned) return true;
  const s = h as StoredHandle;
  return Boolean(!h.readonly && h.rwToken && h.roToken && (s.rwConfirmed || s.pendingCreate));
}

/** Replication needs both tokens (the ro hash registers with the rw hash). */
export function canReplicate(h: InventoryHandle | StoredHandle | null): boolean {
  return Boolean(h && h.rwToken && h.roToken && !h.readonly);
}

/**
 * Push an inventory to every relay enabled on this device: the handle's relay
 * list becomes the union, the doc (re)connects everywhere — new relays learn
 * the doc through the create-handshake (requires a server-confirmed rw token
 * plus the ro token, see CONTRACTS.md "Multi-relay replication") — and all
 * photos are queued for upload to relays that miss them.
 */
export async function replicateToMyRelays(
  docId: Id,
): Promise<{ relays: string[]; photosQueued: number }> {
  const h = getStoredHandle(docId);
  if (!h) throw new Error('replicateToMyRelays: unknown inventory');
  const relays = mergeRelayLists(
    h.relays ?? [defaultRelayOrigin()],
    enabledRelayOrigins(),
  );
  updateHandle(docId, { relays });
  openDoc(docId);
  resyncDoc(docId, { tokenChanged: true });
  let photosQueued = 0;
  if (h.rwToken && !h.readonly) {
    photosQueued = await enqueueDocPhotos(docId);
    kickUploadLoop(docId);
  }
  return { relays, photosQueued };
}

/* ---------- automatic replication of owned inventories ---------- */

const DEBOUNCE_MS = 1_500;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let running = false;

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(() => void runPolicy(), DEBOUNCE_MS);
}

async function runPolicy(): Promise<void> {
  if (running) {
    schedule();
    return;
  }
  running = true;
  try {
    const enabled = enabledRelayOrigins();
    if (enabled.length === 0) return;
    for (const h of getHandlesSnapshot()) {
      if (!isOwnedInventory(h) || !canReplicate(h)) continue;
      const have = new Set(h.relays ?? []);
      if (enabled.every((o) => have.has(o))) continue;
      try {
        await replicateToMyRelays(h.docId);
      } catch (err) {
        console.warn(`[replication] auto-replicate failed for ${h.docId}`, err);
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Start the auto-replication policy (called once at app start). Reacts to
 * relay-set changes (a new account relay pulls every owned inventory in) and
 * registry changes (a new owned inventory spreads to all enabled relays).
 */
export function startReplicationPolicy(): void {
  if (started) return;
  started = true;
  subscribeRelays(schedule);
  subscribeRegistry(schedule);
  schedule();
}
