/**
 * Synced profile ("device group"). One dedicated end-to-end encrypted Yjs doc
 * per profile, synced through the relay exactly like an inventory (same outer
 * `enc:log` wrapping via E2eSync, same token auth + create handshake), shared
 * by every device that imported the same backup. It carries the user's
 * display name and the full set of inventory handles, so an inventory
 * created/joined/renamed/left on one device shows up on all others live —
 * the backup QR links devices permanently instead of copying a snapshot.
 *
 * Inner doc schema (see CONTRACTS.md "Synced profile"):
 * - Y.Map('profile'): { name?: string, ownerId?: string }
 * - Y.Map('inventories'): docId -> { d, rw?, ro?, ek?, nm?, removed?, at }
 *   One plain-object value per inventory (LWW per docId — concurrent list
 *   edits on different inventories always merge). `removed: true` is a
 *   tombstone: other devices drop the handle from their registry but KEEP
 *   the locally cached doc data (no silent data loss; re-joining via a share
 *   link or backup revives the inventory instantly).
 *
 * The AI key is deliberately never stored in this doc.
 *
 * Mirroring rules:
 * - doc -> registry: applied via importHandles (never downgrades access),
 *   new handles are opened so the inventory materializes through normal sync.
 * - registry -> doc: debounced push of every local handle; fields only ever
 *   fill gaps in an existing entry (a device missing the rw token cannot
 *   erase it from the doc). Tombstoned ids are skipped unless the handle was
 *   explicitly (re)created/joined/imported on this device.
 * - display name: the doc is authoritative on sync; an explicit local rename
 *   pushes. ownerId: first write wins (same semantics as backup import).
 */
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import { getServerConfig } from '../config';
import type { Id } from '../types';
import type { SyncStatus } from './contract';
import { E2eSync } from './e2ee';
import { sha256Hex } from './ids';
import { closeDoc, openDoc } from './docs';
import {
  getHandlesSnapshot,
  getStoredHandle,
  importHandles,
  removeHandle,
  subscribeRegistry,
} from './registry';
// Direct module import (not the services barrel), cycle-free: profile only
// imports types and the leaf modules store/ids + store/crypto.
import {
  ensureProfileDocHandle,
  getProfileDocHandle,
  getStoredOwnerId,
  getOwnerId,
  getUserName,
  setOwnerId,
  setUserName,
  subscribeOwnerName,
  updateProfileDocHandle,
  setProfileDocHandle,
  type ProfileDocHandle,
} from '../services/profile';

const PROFILE_MAP = 'profile';
const INV_MAP = 'inventories';
const APPLY_DEBOUNCE_MS = 200;
const PUSH_DEBOUNCE_MS = 500;
/** Push even if the first server sync never arrives (offline start). */
const READY_TIMEOUT_MS = 8_000;

/** Wire shape of one inventory entry inside Y.Map('inventories'). */
interface ProfileInvEntry {
  d: string;
  rw?: string;
  ro?: string;
  /** E2E content key of the inventory. */
  ek?: string;
  /** Cached display name. */
  nm?: string;
  /** Tombstone: the inventory was left/forgotten on some device. */
  removed?: boolean;
  /** epoch ms of the last write (informational; Y.Map resolves conflicts). */
  at: number;
}

interface Engine {
  handle: ProfileDocHandle;
  doc: Y.Doc;
  idb: IndexeddbPersistence;
  e2ee: E2eSync;
  provider: HocuspocusProvider | null;
  /** Local load done + first server sync attempt settled: safe to push. */
  ready: boolean;
  destroyed: boolean;
  unsubs: Array<() => void>;
  applyTimer?: ReturnType<typeof setTimeout>;
  pushTimer?: ReturnType<typeof setTimeout>;
  readyTimer?: ReturnType<typeof setTimeout>;
}

let engine: Engine | null = null;
let status: SyncStatus = 'offline';
const statusListeners = new Set<() => void>();
/** docIds explicitly (re)created/joined/imported here: next push writes them
 *  live even over a tombstone. */
const pendingLive = new Set<Id>();
let pendingNamePush = false;

/* ---------------- status (for a subtle UI indicator) ---------------- */

export function subscribeProfileStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

export function getProfileStatus(): SyncStatus {
  return status;
}

function setStatus(next: SyncStatus): void {
  if (status === next) return;
  status = next;
  for (const cb of statusListeners) cb();
}

/* ---------------- lifecycle ---------------- */

/** Start (or return) the profile sync engine. Lazily creates the profile doc
 *  identity on first use — the migration path for existing installs. */
export function startProfileSync(): void {
  if (engine || typeof indexedDB === 'undefined') return;
  openEngine(ensureProfileDocHandle());
}

function stopEngine(): void {
  const e = engine;
  if (!e) return;
  engine = null;
  e.destroyed = true;
  clearTimeout(e.applyTimer);
  clearTimeout(e.pushTimer);
  clearTimeout(e.readyTimer);
  for (const unsub of e.unsubs) unsub();
  try {
    e.provider?.destroy();
  } catch { /* ignore */ }
  void e.e2ee.destroy();
  void e.idb.destroy().catch(() => {});
  e.doc.destroy();
  setStatus('offline');
}

function openEngine(handle: ProfileDocHandle): void {
  const doc = new Y.Doc({ guid: handle.docId });
  const idb = new IndexeddbPersistence(handle.docId, doc);
  const e2ee = new E2eSync(handle.docId, doc, idb, handle.key ?? '', {
    canWrite: () => Boolean(getProfileDocHandle()?.rwToken),
  });
  const e: Engine = {
    handle,
    doc,
    idb,
    e2ee,
    provider: null,
    ready: false,
    destroyed: false,
    unsubs: [],
  };
  engine = e;

  e.e2ee.start().catch((err) => {
    console.warn('[profile-sync] e2ee start failed', err);
  });

  doc.on('update', () => scheduleApply(e));
  idb.whenSynced.then(() => {
    if (e.destroyed) return;
    scheduleApply(e);
    // If the server never answers (offline start), push after a grace period
    // so locally created inventories still land in the (local) profile doc.
    e.readyTimer = setTimeout(() => markReady(e), READY_TIMEOUT_MS);
  });

  e.unsubs.push(subscribeRegistry(() => schedulePush(e)));
  e.unsubs.push(
    subscribeOwnerName((docId) => {
      if (docId) return; // per-doc aliases stay local to their inventory doc
      pendingNamePush = true;
      schedulePush(e);
    }),
  );

  attachProvider(e);
}

function markReady(e: Engine): void {
  if (e.destroyed || e.ready) return;
  e.ready = true;
  clearTimeout(e.readyTimer);
  schedulePush(e);
}

/* ---------------- relay provider (mirrors docs.ts, simplified) ---------------- */

async function buildToken(): Promise<string> {
  const h = getProfileDocHandle();
  const t = h?.rwToken ?? h?.roToken ?? '';
  if (h?.pendingCreate && h.rwToken && h.roToken) {
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

function attachProvider(e: Engine): void {
  try {
    e.provider = new HocuspocusProvider({
      url: getServerConfig().wsUrl,
      name: e.handle.docId,
      document: e.e2ee.outer,
      token: () => buildToken(),
      onStatus: ({ status: s }) => {
        if (status === 'error') return;
        if (s === WebSocketStatus.Connecting) setStatus('connecting');
        else if (s === WebSocketStatus.Disconnected) setStatus('offline');
      },
      onSynced: ({ state }) => {
        if (!state) return;
        setStatus('synced');
        e.e2ee.onServerSynced();
        markReady(e);
      },
      onAuthenticated: ({ scope }) => {
        if (scope === 'read-write' && getProfileDocHandle()?.pendingCreate) {
          updateProfileDocHandle({ pendingCreate: undefined });
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        console.warn(`[profile-sync] auth failed: ${reason}`);
        setStatus('error');
        // Deterministic rejection: stop the reconnect loop for this session.
        e.provider?.disconnect();
        markReady(e);
      },
    });
    setStatus('connecting');
  } catch (err) {
    console.warn('[profile-sync] failed to start provider', err);
    e.provider = null;
  }
}

/* ---------------- doc -> local registry ---------------- */

function readEntry(map: Y.Map<ProfileInvEntry>, docId: string): ProfileInvEntry | null {
  const v = map.get(docId) as Partial<ProfileInvEntry> | undefined;
  if (!v || typeof v !== 'object' || typeof v.d !== 'string' || !v.d) return null;
  return v as ProfileInvEntry;
}

function scheduleApply(e: Engine): void {
  clearTimeout(e.applyTimer);
  e.applyTimer = setTimeout(() => {
    if (!e.destroyed) applyDocToLocal(e);
  }, APPLY_DEBOUNCE_MS);
}

function applyDocToLocal(e: Engine): void {
  // Identity: ownerId fills only when absent (same rule as backup import);
  // the synced display name wins over the local one.
  const profile = e.doc.getMap<unknown>(PROFILE_MAP);
  const ownerId = profile.get('ownerId');
  if (typeof ownerId === 'string' && ownerId && !getStoredOwnerId()) setOwnerId(ownerId);
  const name = profile.get('name');
  if (typeof name === 'string' && name.trim() && name !== getUserName()) {
    setUserName(name);
  }

  const map = e.doc.getMap<ProfileInvEntry>(INV_MAP);
  const live: Array<{ docId: string; rwToken?: string; roToken?: string; key?: string; name?: string }> = [];
  const removed: string[] = [];
  map.forEach((_v, docId) => {
    const entry = readEntry(map, docId);
    if (!entry || entry.d === e.handle.docId) return;
    if (entry.removed) removed.push(entry.d);
    else live.push({ docId: entry.d, rwToken: entry.rw, roToken: entry.ro, key: entry.ek, name: entry.nm });
  });

  const known = new Set(getHandlesSnapshot().map((h) => h.docId));
  importHandles(live);
  for (const h of live) {
    // A handle another device shared through the profile: open it so the
    // normal sync pipeline materializes items right away.
    if (!known.has(h.docId) && getStoredHandle(h.docId)) openDoc(h.docId);
  }
  for (const docId of removed) {
    if (pendingLive.has(docId)) continue; // just re-joined here, push will revive it
    if (!getStoredHandle(docId)) continue;
    // Removed on another device: drop it from the list but KEEP the locally
    // cached doc data (closeDoc without clearData) — nothing is silently lost.
    removeHandle(docId);
    void closeDoc(docId).catch(() => {});
  }
}

/* ---------------- local registry -> doc ---------------- */

function schedulePush(e: Engine): void {
  clearTimeout(e.pushTimer);
  e.pushTimer = setTimeout(() => {
    if (!e.destroyed && e.ready) pushLocalToDoc(e);
  }, PUSH_DEBOUNCE_MS);
}

function sameEntry(a: ProfileInvEntry, b: ProfileInvEntry): boolean {
  return (
    a.rw === b.rw && a.ro === b.ro && a.ek === b.ek && a.nm === b.nm && !a.removed === !b.removed
  );
}

function pushLocalToDoc(e: Engine): void {
  const map = e.doc.getMap<ProfileInvEntry>(INV_MAP);
  const profile = e.doc.getMap<unknown>(PROFILE_MAP);
  const localName = getUserName();

  e.doc.transact(() => {
    if (localName && (pendingNamePush || typeof profile.get('name') !== 'string')) {
      if (profile.get('name') !== localName) profile.set('name', localName);
    }
    pendingNamePush = false;
    if (typeof profile.get('ownerId') !== 'string') profile.set('ownerId', getOwnerId());

    for (const h of getHandlesSnapshot()) {
      if (h.docId === e.handle.docId) continue;
      if (!h.rwToken && !h.roToken) continue;
      const existing = readEntry(map, h.docId);
      if (existing?.removed && !pendingLive.has(h.docId)) continue;
      // Fill-only merge: this device's view never erases tokens/keys another
      // device contributed to the entry.
      const next: ProfileInvEntry = {
        d: h.docId,
        at: Date.now(),
      };
      const rw = h.rwToken ?? existing?.rw;
      const ro = h.roToken ?? existing?.ro;
      const ek = h.key ?? existing?.ek;
      const nm = h.name ?? existing?.nm;
      if (rw) next.rw = rw;
      if (ro) next.ro = ro;
      if (ek) next.ek = ek;
      if (nm) next.nm = nm;
      if (existing && sameEntry(existing, next)) continue;
      map.set(h.docId, next);
    }
  });
  // Ids whose handle has not landed in the registry yet stay pending for the
  // next push (joinInventory records the intent before the async join settles).
  for (const id of Array.from(pendingLive)) {
    if (getStoredHandle(id)) pendingLive.delete(id);
  }
}

/* ---------------- explicit intents (called from hooks/backup) ---------------- */

/** An inventory was created/joined/imported here: sync it into the profile
 *  doc, reviving it if a tombstone exists. */
export function profileRecordInventory(docId: Id): void {
  startProfileSync();
  const e = engine;
  if (!e) return;
  pendingLive.add(docId);
  schedulePush(e);
}

/** The user left/forgot an inventory here: tombstone it so other devices
 *  drop it from their lists (their local doc data is retained). */
export function profileRecordRemoval(docId: Id): void {
  startProfileSync();
  const e = engine;
  if (!e) return;
  pendingLive.delete(docId);
  const map = e.doc.getMap<ProfileInvEntry>(INV_MAP);
  const existing = readEntry(map, docId);
  if (existing?.removed) return;
  map.set(docId, { d: docId, removed: true, at: Date.now() });
}

/** Backup import: adopt the payload's profile doc. Returns true when this
 *  device switched to (or newly joined) that profile. The local registry is
 *  pushed into the adopted doc afterwards, so nothing local is lost. */
export function adoptProfileHandle(p: {
  docId: string;
  rwToken?: string;
  roToken?: string;
  key?: string;
}): boolean {
  if (!p.docId || !p.key || (!p.rwToken && !p.roToken)) return false;
  const current = getProfileDocHandle();
  if (current?.docId === p.docId) {
    updateProfileDocHandle({
      rwToken: current.rwToken ?? p.rwToken,
      roToken: current.roToken ?? p.roToken,
      key: current.key ?? p.key,
    });
    startProfileSync();
    return false;
  }
  setProfileDocHandle({ docId: p.docId, rwToken: p.rwToken, roToken: p.roToken, key: p.key });
  stopEngine();
  openEngine(getProfileDocHandle()!);
  return true;
}
