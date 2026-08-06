/**
 * Per-inventory Y.Doc lifecycle: y-indexeddb persistence, one Hocuspocus sync
 * provider per configured relay (with the create-handshake from CONTRACTS.md),
 * direct device-to-device WebRTC sync (p2p.ts), and reactive per-doc status.
 *
 * Multi-relay: every relay a doc is configured for (relays.ts) gets its own
 * provider on the SAME outer Y.Doc — Yjs updates dedupe by design, so
 * connecting to several relays at once is safe and gives automatic
 * replication between them (through this client).
 */
import * as Y from 'yjs';
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import type { Box, DevicePresence, Id, InventoryMeta, Item, SavedList } from '../types';
import type { SyncStatus } from './contract';
import { getDevicePresence } from './device';
import { clearOuterDoc, E2eSync, E2EE_REMOTE_ORIGIN, ENC_LOG_NAME } from './e2ee';
import { sha256Hex } from './ids';
import { ensureSelfOwner } from './owners';
import { attachP2p, p2pSignalingOrigins, subscribeP2p, type P2pConn } from './p2p';
import { getStoredHandle, subscribeRegistry, updateHandle } from './registry';
import { mergeRelayLists, relayOriginsForDoc, relayWsUrl, subscribeRelays } from './relays';
// Direct module import (not the services barrel), cycle-free: profile only
// imports types and the leaf modules store/ids + store/crypto.
import { subscribeOwnerName } from '../services/profile';

/** One Hocuspocus provider bound to one relay origin. */
export interface RelayConn {
  origin: string;
  provider: HocuspocusProvider;
  status: SyncStatus;
  /** Access level this relay granted during this session, once known. */
  scope?: 'rw' | 'ro';
}

export interface DocEntry {
  docId: Id;
  doc: Y.Doc;
  idb: IndexeddbPersistence;
  /** One connection per relay origin the doc syncs through. */
  conns: Map<string, RelayConn>;
  /** Direct WebRTC sync (signaling via own relays); null while off/unavailable. */
  p2p: P2pConn | null;
  /** Number of directly connected WebRTC peers. */
  peerCount: number;
  /** Guards async p2p attach against stale completions. */
  p2pGen: number;
  /** Signaling origins the current p2p attach used (restart detection). */
  p2pSignals?: string;
  /** Encrypted-sync bridge; set when the handle stores a content key. */
  e2ee: E2eSync | null;
  /**
   * The doc turned out to be end-to-end encrypted but this device has no
   * content key: the synced payload is an opaque log we cannot decrypt.
   */
  keyMissing: boolean;
  status: SyncStatus;
  /** true once y-indexeddb has loaded the locally persisted state */
  loaded: boolean;
  version: number;
  /** Debounce for the owner-directory upsert after update bursts. */
  ownerTimer?: ReturnType<typeof setTimeout>;
}

const entries = new Map<Id, DocEntry>();

// A rename (global name, per-doc alias, or owner-id link) is pushed into the
// owners directory of every affected open doc right away; docs opened later
// pick it up via recordOwner on load/sync.
subscribeOwnerName((docId) => {
  for (const entry of entries.values()) {
    if (docId && entry.docId !== docId) continue;
    recordOwner(entry);
  }
});

// Keyed by docId (not stored on the entry) so subscriptions survive an entry
// being closed and recreated (forget + re-join in the same session), and so
// subscribing before the doc is first opened still works.
const docListeners = new Map<Id, Set<() => void>>();

function listenersFor(docId: Id): Set<() => void> {
  let set = docListeners.get(docId);
  if (!set) {
    set = new Set();
    docListeners.set(docId, set);
  }
  return set;
}

function bump(entry: DocEntry): void {
  entry.version++;
  for (const cb of listenersFor(entry.docId)) cb();
}

/**
 * Aggregate the per-relay statuses into the doc status the UI shows:
 * synced anywhere counts as synced; a live attempt beats a dead relay.
 */
function recomputeStatus(entry: DocEntry): void {
  const statuses = [...entry.conns.values()].map((c) => c.status);
  let next: SyncStatus = 'offline';
  if (statuses.includes('synced')) next = 'synced';
  else if (statuses.includes('connecting')) next = 'connecting';
  else if (statuses.includes('error')) next = 'error';
  if (entry.status !== next) {
    entry.status = next;
  }
  bump(entry);
}

function setConnStatus(entry: DocEntry, conn: RelayConn, status: SyncStatus): void {
  if (conn.status === status) return;
  conn.status = status;
  recomputeStatus(entry);
}

/** Whether any relay granted read-write scope this session. */
function anyRwConn(entry: DocEntry): boolean {
  return [...entry.conns.values()].some((c) => c.scope === 'rw');
}

/** Docs that already used their one automatic candidate-swap after an auth
 *  rejection this session (see onAuthenticationFailed). */
const authFallbackTried = new Set<Id>();

const SYNC_STAMP_THROTTLE_MS = 30_000;
const PRESENCE_THROTTLE_MS = 5 * 60_000;

/** Persist "last synced" on the handle so the list screen can show it. */
function stampSynced(docId: Id): void {
  const h = getStoredHandle(docId);
  const now = Date.now();
  if (!h || (h.lastSyncedAt && now - h.lastSyncedAt < SYNC_STAMP_THROTTLE_MS)) return;
  updateHandle(docId, { lastSyncedAt: now });
}

/**
 * Record this device in the doc's `devices` map so peers can see who an
 * inventory synced with. Write access only; throttled to avoid update spam.
 * Requires the E2E bridge: without a content key `entry.doc` never reaches
 * the server (only the opaque outer doc does), and we must not write
 * plaintext presence into a doc we cannot read anyway.
 */
function recordPresence(entry: DocEntry): void {
  if (!entry.e2ee) return;
  const h = getStoredHandle(entry.docId);
  if (!h || h.readonly || !h.rwToken) return;
  const presence = getDevicePresence();
  const map = entry.doc.getMap<Record<string, unknown>>('devices');
  const prev = map.get(presence.id) as { at?: number; label?: string } | undefined;
  if (
    prev &&
    typeof prev.at === 'number' &&
    Date.now() - prev.at < PRESENCE_THROTTLE_MS &&
    prev.label === presence.label
  ) {
    return;
  }
  entry.doc.transact(() => {
    map.set(presence.id, {
      id: presence.id,
      label: presence.label,
      at: presence.at,
      ...(presence.ownerId ? { ownerId: presence.ownerId } : {}),
    });
  });
}

/**
 * Keep this user's entry in the doc's owners directory current (see
 * owners.ts). Same gates as recordPresence: write access and the E2E bridge
 * (without a content key we must not write plaintext into the doc). Also
 * gated on meta being present: registering into a doc whose content has not
 * arrived yet would mint a duplicate owner instead of matching an existing
 * same-name entry.
 */
function recordOwner(entry: DocEntry): void {
  if (!entry.e2ee) return;
  if (!entry.doc.getMap<unknown>('meta').has('id')) return;
  const h = getStoredHandle(entry.docId);
  if (!h || h.readonly || !h.rwToken) return;
  try {
    ensureSelfOwner(entry.doc, entry.docId);
  } catch (err) {
    console.warn(`[store] owner directory update failed for ${entry.docId}`, err);
  }
}

/**
 * Auth token per CONTRACTS.md: JSON string, with a `create` payload while the
 * doc is pending creation — and also once our rw token is server-confirmed,
 * which is what lets a doc be REGISTERED on additional relays: a relay that
 * does not know the doc accepts the create-handshake and stores the token
 * hashes, a relay that does simply ignores the payload. The same tokens and
 * content key are valid on every relay (they only ever guard ciphertext).
 */
async function buildToken(docId: Id): Promise<string> {
  const h = getStoredHandle(docId);
  const t = h?.rwToken ?? h?.roToken ?? '';
  if ((h?.pendingCreate || h?.rwConfirmed) && h.rwToken && h.roToken && !h.readonly) {
    return JSON.stringify({
      t,
      create: {
        rwHash: await sha256Hex(h.rwToken),
        roHash: await sha256Hex(h.roToken),
      },
    });
  }
  return JSON.stringify({ t });
}

/** Connect the doc to every configured relay it is not yet connected to. */
function attachSyncProviders(entry: DocEntry): void {
  const handle = getStoredHandle(entry.docId);
  if (!handle || (!handle.rwToken && !handle.roToken)) return;
  for (const origin of relayOriginsForDoc(entry.docId)) {
    if (!entry.conns.has(origin)) attachRelayConn(entry, origin);
  }
}

function attachRelayConn(entry: DocEntry, origin: string): void {
  const { docId } = entry;
  try {
    const provider = new HocuspocusProvider({
      url: relayWsUrl(origin),
      name: docId,
      // With a content key the provider syncs the opaque outer doc; the real
      // doc never leaves the client. Without one (share link that lost its
      // /k/ fragment) we still sync so the update handler below can detect
      // the encrypted log and surface "key missing" instead of "empty".
      document: entry.e2ee ? entry.e2ee.outer : entry.doc,
      token: () => buildToken(docId),
      onStatus: ({ status }) => {
        const conn = entry.conns.get(origin);
        if (!conn) return;
        // After an auth rejection we stop the socket ourselves; the resulting
        // Disconnected event must not overwrite the sticky 'error' status.
        if (conn.status === 'error') return;
        if (status === WebSocketStatus.Connecting) setConnStatus(entry, conn, 'connecting');
        else if (status === WebSocketStatus.Disconnected) setConnStatus(entry, conn, 'offline');
        // Connected: stay 'connecting' until authenticated + synced.
      },
      onSynced: ({ state }) => {
        const conn = entry.conns.get(origin);
        if (state && conn) {
          setConnStatus(entry, conn, 'synced');
          stampSynced(docId);
          entry.e2ee?.onServerSynced();
          recordPresence(entry);
          recordOwner(entry);
        }
      },
      onAuthenticated: ({ scope }) => {
        const conn = entry.conns.get(origin);
        if (conn) {
          conn.scope = scope === 'read-write' ? 'rw' : 'ro';
          bump(entry);
        }
        const h = getStoredHandle(docId);
        if (!h) return;
        if (scope === 'read-write') {
          authFallbackTried.delete(docId);
          // This relay accepted the create handshake (if any) and confirmed
          // rw. Only persist when something changes: this fires on every
          // reconnect, on every relay.
          if (h.readonly || h.pendingCreate || !h.rwConfirmed || !h.rwToken) {
            updateHandle(docId, {
              // The token we authenticated with is by definition the rw
              // token; normally it already sits in rwToken, but a fallback
              // (see onAuthenticationFailed) may have left it in roToken.
              ...(h.rwToken ? {} : { rwToken: h.roToken, roToken: undefined }),
              readonly: false,
              pendingCreate: undefined,
              rwConfirmed: true,
            });
          }
          return;
        }
        // Read-only verdicts only demote the handle when NO relay granted rw
        // this session: with several relays racing their handshakes, a slower
        // relay's ro answer must not clobber a confirmed rw grant. (Relays
        // share the same token hashes by construction, so genuine
        // disagreement only occurs with a stale or hostile relay.)
        if (anyRwConn(entry)) return;
        if (h.rwToken) {
          const untried = h.roToken && h.roToken !== h.rwToken ? h.roToken : undefined;
          if (untried && !h.rwConfirmed) {
            // The primary token turned out read-only, but we hold a second
            // candidate of unknown kind (joinInventory stashes a superseded
            // unconfirmed token there). A doc has exactly one rw and one ro
            // token, so two distinct candidates cannot both be read-only:
            // swap and re-authenticate. This cannot loop — the swapped-in
            // token is either granted rw or rejected, never demoted again.
            updateHandle(docId, {
              rwToken: untried,
              roToken: h.rwToken,
              readonly: false,
              rwConfirmed: undefined,
            });
            // Rebuild outside this provider callback: resyncDoc destroys the
            // provider we are currently running inside.
            setTimeout(() => resyncDoc(docId, { tokenChanged: true }), 0);
          } else {
            // The token we stored as rw (kind unknown until now) is actually
            // read-only; move it so nothing (e.g. the upload queue) treats
            // this handle as writable.
            updateHandle(docId, {
              rwToken: undefined,
              roToken: h.rwToken,
              readonly: true,
              rwConfirmed: undefined,
            });
          }
        } else if (!h.readonly) {
          updateHandle(docId, { readonly: true });
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        // Local cached data stays fully readable; we just can't sync there.
        console.warn(`[store] sync auth failed for ${docId} on ${origin}: ${reason}`);
        const conn = entry.conns.get(origin);
        const h = getStoredHandle(docId);
        // A rejected primary token that was never server-confirmed may just
        // be the wrong one of two stored candidates: swap and retry once per
        // session instead of parking the doc in 'error'. Nothing is dropped,
        // so a wrong guess costs one extra handshake at most. Skipped when
        // another relay already granted rw (then this relay simply does not
        // know the doc / the tokens — e.g. not replicated there yet).
        if (
          h?.rwToken &&
          h.roToken &&
          h.roToken !== h.rwToken &&
          !h.rwConfirmed &&
          !h.pendingCreate &&
          !anyRwConn(entry) &&
          !authFallbackTried.has(docId)
        ) {
          authFallbackTried.add(docId);
          updateHandle(docId, {
            rwToken: h.roToken,
            roToken: h.rwToken,
            rwConfirmed: undefined,
          });
          setTimeout(() => resyncDoc(docId, { tokenChanged: true }), 0);
          return;
        }
        if (conn) setConnStatus(entry, conn, 'error');
        // Rejection is deterministic for a given token: stop this provider's
        // (otherwise unlimited) reconnect loop. resyncDoc() re-enables it.
        conn?.provider.disconnect();
      },
    });
    const conn: RelayConn = { origin, provider, status: 'connecting' };
    entry.conns.set(origin, conn);
    recomputeStatus(entry);
  } catch (err) {
    console.warn(`[store] failed to start sync provider for ${origin}`, err);
  }
}

/* ---------- direct device-to-device sync (WebRTC) ---------- */

/** Cap on a handle's relay list so gossiping peers cannot balloon it. */
const MAX_HANDLE_RELAYS = 12;

/**
 * Relay origins gossiped by a room peer become relay hints on the handle
 * (union, add-only, capped) — the same effect as a share link's origin — and
 * from there flow into the profile doc's per-doc `rl` hints.
 */
function gossipRelaysIntoHandle(docId: Id, urls: string[]): void {
  const h = getStoredHandle(docId);
  if (!h) return;
  const merged = mergeRelayLists(h.relays, urls).slice(0, MAX_HANDLE_RELAYS);
  if (merged.join(' ') !== (h.relays ?? []).join(' ')) {
    updateHandle(docId, { relays: merged });
  }
}

function attachP2pFor(entry: DocEntry): void {
  entry.p2pSignals = p2pSignalingOrigins(entry.docId).join(' ');
  const key = getStoredHandle(entry.docId)?.key;
  if (!entry.e2ee || !key) return; // no content key -> no room derivation
  const gen = ++entry.p2pGen;
  void attachP2p(
    entry.docId,
    entry.e2ee.outer,
    key,
    (count) => {
      if (entry.peerCount !== count) {
        entry.peerCount = count;
        bump(entry);
      }
    },
    {
      advertiseRelays: () => relayOriginsForDoc(entry.docId),
      onRemoteRelays: (urls) => gossipRelaysIntoHandle(entry.docId, urls),
    },
  ).then((conn) => {
    if (!conn) return;
    // The entry may have been closed or the p2p layer restarted meanwhile.
    if (entries.get(entry.docId) !== entry || gen !== entry.p2pGen) {
      conn.destroy();
      return;
    }
    entry.p2p = conn;
    bump(entry);
  });
}

function restartP2p(entry: DocEntry): void {
  entry.p2pGen++;
  try {
    entry.p2p?.destroy();
  } catch { /* ignore */ }
  entry.p2p = null;
  entry.peerCount = 0;
  attachP2pFor(entry);
}

// Relay-set changes reshape both the relay connections and the signaling
// list of the P2P layer; the P2P toggle only the latter.
subscribeRelays(() => {
  for (const entry of entries.values()) {
    reconcileRelayConns(entry);
    restartP2p(entry);
  }
});
subscribeP2p(() => {
  for (const entry of entries.values()) restartP2p(entry);
});
// A handle's relay list can change while the doc is open (gossip, share-link
// re-join, replication): pick up new relays for sync AND for signaling.
subscribeRegistry(() => {
  for (const entry of entries.values()) {
    if (entry.conns.size > 0) {
      const targets = relayOriginsForDoc(entry.docId);
      if (
        targets.length !== entry.conns.size ||
        targets.some((o) => !entry.conns.has(o))
      ) {
        reconcileRelayConns(entry);
      }
    }
    const sigs = p2pSignalingOrigins(entry.docId).join(' ');
    if (entry.p2pSignals !== undefined && sigs !== entry.p2pSignals) {
      restartP2p(entry);
    }
  }
});

/** Add newly configured relays and drop removed/disabled ones in place. */
function reconcileRelayConns(entry: DocEntry): void {
  const targets = new Set(relayOriginsForDoc(entry.docId));
  for (const [origin, conn] of entry.conns) {
    if (targets.has(origin)) continue;
    try {
      conn.provider.destroy();
    } catch { /* ignore */ }
    entry.conns.delete(origin);
  }
  attachSyncProviders(entry);
  recomputeStatus(entry);
}

/** Open (or return the already-open) doc for an inventory. Never throws. */
export function openDoc(docId: Id): DocEntry {
  const existing = entries.get(docId);
  if (existing) {
    // Tokens may have arrived after the doc was first opened (e.g. opened via
    // snapshotInventory, then joined): attach the sync providers late.
    if (existing.conns.size === 0) attachSyncProviders(existing);
    return existing;
  }

  const doc = new Y.Doc({ guid: docId });
  const idb = new IndexeddbPersistence(docId, doc);
  const entry: DocEntry = {
    docId,
    doc,
    idb,
    conns: new Map(),
    p2p: null,
    peerCount: 0,
    p2pGen: 0,
    e2ee: null,
    keyMissing: false,
    status: 'offline',
    loaded: false,
    version: 0,
  };
  entries.set(docId, entry);

  const contentKey = getStoredHandle(docId)?.key;
  if (contentKey) {
    entry.e2ee = new E2eSync(docId, doc, idb, contentKey, {
      canWrite: () => {
        const h = getStoredHandle(docId);
        return Boolean(h?.rwToken) && !h?.readonly;
      },
      onError: () => bump(entry),
    });
    entry.e2ee.start().catch((err) => {
      console.warn(`[store] e2ee start failed for ${docId}`, err);
    });
  }

  idb.whenSynced.then(() => {
    entry.loaded = true;
    // Offline-opened docs get the owner-directory update here; online ones
    // also refresh it on every server sync.
    recordOwner(entry);
    bump(entry);
  });

  doc.on('update', (_update: Uint8Array, origin: unknown) => {
    // Keep the cached display name on the handle fresh.
    const name = doc.getMap<unknown>('meta').get('name');
    const h = getStoredHandle(docId);
    if (typeof name === 'string' && h && h.name !== name) {
      updateHandle(docId, { name });
    }
    // A doc synced without a content key that carries the encrypted log is an
    // E2E doc this device cannot read; surface that instead of "empty".
    if (!entry.e2ee && !entry.keyMissing && doc.share.has(ENC_LOG_NAME)) {
      entry.keyMissing = true;
    }
    // Remote updates while connected keep the "last synced" stamp fresh.
    const fromRelay =
      origin === E2EE_REMOTE_ORIGIN ||
      [...entry.conns.values()].some((c) => origin === c.provider);
    if (fromRelay && entry.status === 'synced') {
      stampSynced(docId);
    }
    // Re-check the owner directory once the burst settles: the initial sync
    // of a joined doc applies the encrypted log asynchronously, so the
    // load/sync-time recordOwner calls can run before the directory exists.
    clearTimeout(entry.ownerTimer);
    entry.ownerTimer = setTimeout(() => recordOwner(entry), 800);
    bump(entry);
  });

  attachSyncProviders(entry);
  attachP2pFor(entry);
  return entry;
}

export function getEntry(docId: Id): DocEntry | null {
  return entries.get(docId) ?? null;
}

/** Per-relay connection status for a doc, for the UI's per-relay dots. */
export function getRelayConns(docId: Id): Array<{ origin: string; status: SyncStatus; scope?: 'rw' | 'ro' }> {
  const entry = entries.get(docId);
  if (!entry) return [];
  return [...entry.conns.values()].map((c) => ({
    origin: c.origin,
    status: c.status,
    scope: c.scope,
  }));
}

/**
 * (Re)start sync for an open doc: attaches providers if none started, and
 * rebuilds them after an auth failure, when a different token was just
 * stored, or when the doc's relay list changed. Rebuilding matters for token
 * upgrades: an already-authenticated readonly connection silently drops
 * writes server-side and only picks up the new token by re-authenticating.
 * (Providers are destroyed and recreated because HocuspocusProvider.connect()
 * no-ops while the socket still reports connected, making an in-place
 * disconnect+connect racy.)
 */
export function resyncDoc(docId: Id, opts?: { tokenChanged?: boolean }): void {
  const entry = entries.get(docId);
  if (!entry) return;
  const targets = relayOriginsForDoc(docId);
  const missing = targets.some((o) => !entry.conns.has(o));
  const anyError = [...entry.conns.values()].some((c) => c.status === 'error');
  if (entry.conns.size > 0 && !missing && !opts?.tokenChanged && !anyError) return;
  for (const conn of entry.conns.values()) {
    try {
      conn.provider.destroy();
    } catch { /* ignore */ }
  }
  entry.conns.clear();
  recomputeStatus(entry); // clears a sticky 'error' before reconnecting
  attachSyncProviders(entry);
}

export function subscribeDoc(docId: Id, cb: () => void): () => void {
  const set = listenersFor(docId);
  set.add(cb);
  return () => set.delete(cb);
}

/** Close the doc and optionally wipe its local IndexedDB data (forget flow). */
export async function closeDoc(docId: Id, opts?: { clearData?: boolean }): Promise<void> {
  const entry = entries.get(docId);
  if (!entry) {
    if (opts?.clearData) {
      await clearDocument(docId).catch(() => {});
      await clearOuterDoc(docId);
    }
    return;
  }
  entries.delete(docId);
  clearTimeout(entry.ownerTimer);
  entry.p2pGen++; // cancel any in-flight p2p attach
  for (const conn of entry.conns.values()) {
    try {
      conn.provider.destroy();
    } catch { /* ignore */ }
  }
  entry.conns.clear();
  try {
    entry.p2p?.destroy();
  } catch { /* ignore */ }
  if (entry.e2ee) await entry.e2ee.destroy({ clearData: opts?.clearData });
  else if (opts?.clearData) await clearOuterDoc(docId);
  if (opts?.clearData) await entry.idb.clearData().catch(() => {});
  else await entry.idb.destroy().catch(() => {});
  entry.doc.destroy();
}

/* ---------- plain-object readers over the doc structure ---------- */

export function readMeta(doc: Y.Doc): InventoryMeta | null {
  const meta = doc.getMap<unknown>('meta');
  if (!meta.has('id')) return null;
  return meta.toJSON() as InventoryMeta;
}

export function readItems(doc: Y.Doc): Item[] {
  const items = doc.getMap<Y.Map<unknown>>('items');
  const out: Item[] = [];
  items.forEach((ymap) => out.push(ymap.toJSON() as Item));
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export function readBoxes(doc: Y.Doc): Box[] {
  return Array.from(doc.getMap<Box>('boxes').values());
}

export function readLists(doc: Y.Doc): SavedList[] {
  return Array.from(doc.getMap<SavedList>('lists').values());
}

export function readDevices(doc: Y.Doc): DevicePresence[] {
  const out: DevicePresence[] = [];
  doc.getMap<unknown>('devices').forEach((v) => {
    const d = v as { id?: unknown; label?: unknown; at?: unknown; ownerId?: unknown };
    if (typeof d?.id === 'string' && typeof d.label === 'string' && typeof d.at === 'number') {
      out.push({
        id: d.id,
        label: d.label,
        at: d.at,
        ...(typeof d.ownerId === 'string' ? { ownerId: d.ownerId } : {}),
      });
    }
  });
  out.sort((a, b) => b.at - a.at);
  return out;
}
