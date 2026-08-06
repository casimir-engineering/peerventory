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
 * - Y.Map('inventories'): docId -> { d, rw?, ro?, ek?, nm?, rl?, ow?,
 *   removed?, at }. One plain-object value per inventory (LWW per docId —
 *   concurrent list edits on different inventories always merge).
 *   `removed: true` is a tombstone: other devices drop the handle from
 *   their registry but KEEP the locally cached doc data (no silent data
 *   loss; re-joining via a share link or backup revives the inventory
 *   instantly).
 * - Y.Map('relays'): account relay list, origin -> { u, at, removed? }
 *   (accountRelays.ts holds the merge semantics).
 * - Y.Map('devices'): deviceId -> { id, label, at } — account device list
 *   for the "Linked devices" UI (throttled presence).
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
import type { DevicePresence, Id } from '../types';
import type { SyncStatus } from './contract';
import {
  planRelayApply,
  planRelayPush,
  type AccountRelayEntry,
} from './accountRelays';
import { getDevicePresence } from './device';
import { E2eSync } from './e2ee';
import { sha256Hex } from './ids';
import { closeDoc, openDoc } from './docs';
import { attachP2p, subscribeP2p, type P2pConn } from './p2p';
import {
  applyAccountRelays,
  clearRelayIntent,
  defaultRelayOrigin,
  enabledRelayOrigins,
  getPendingRelayAdds,
  getPendingRelayRemovals,
  getRelaysSnapshot,
  mergeRelayLists,
  relayWsUrl,
  subscribeRelays,
} from './relays';
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
const RELAYS_MAP = 'relays';
const DEVICES_MAP = 'devices';
const APPLY_DEBOUNCE_MS = 200;
const PUSH_DEBOUNCE_MS = 500;
/** Push even if the first server sync never arrives (offline start). */
const READY_TIMEOUT_MS = 8_000;
/** Throttle for this device's presence entry in the profile doc. */
const DEVICE_PRESENCE_THROTTLE_MS = 5 * 60_000;

/** Wire shape of one inventory entry inside Y.Map('inventories'). */
interface ProfileInvEntry {
  d: string;
  rw?: string;
  ro?: string;
  /** E2E content key of the inventory. */
  ek?: string;
  /** Cached display name. */
  nm?: string;
  /** Relay origins the inventory is known to live on (union-merged). */
  rl?: string[];
  /** Owned by this account (fill-only; drives automatic replication). */
  ow?: boolean;
  /** Tombstone: the inventory was left/forgotten on some device. */
  removed?: boolean;
  /** epoch ms of the last write (informational; Y.Map resolves conflicts). */
  at: number;
}

/** Wire shape of one entry inside Y.Map('devices') (account device list). */
interface ProfileDeviceEntry {
  id: string;
  /** e.g. "Alex · Android" */
  label: string;
  /** epoch ms the device last recorded itself (throttled). */
  at: number;
}

interface Engine {
  handle: ProfileDocHandle;
  doc: Y.Doc;
  idb: IndexeddbPersistence;
  e2ee: E2eSync;
  /** One provider per enabled relay: the profile doc lives on all of them. */
  providers: Map<string, { provider: HocuspocusProvider; status: SyncStatus }>;
  /**
   * Direct device-to-device sync of the profile doc itself: the account's
   * devices share a standing P2P room, so the inventory/relay lists converge
   * and devices see each other as reachable even with zero relays up.
   */
  p2p: P2pConn | null;
  p2pGen: number;
  /** Local load done + first server sync attempt settled: safe to push. */
  ready: boolean;
  destroyed: boolean;
  unsubs: Array<() => void>;
  applyTimer?: ReturnType<typeof setTimeout>;
  pushTimer?: ReturnType<typeof setTimeout>;
  readyTimer?: ReturnType<typeof setTimeout>;
  presenceTimer?: ReturnType<typeof setInterval>;
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

/* ---------------- account data (devices list) for the UI ---------------- */

let dataVersion = 0;
const dataListeners = new Set<() => void>();
let devicesSnapshot: DevicePresence[] = [];
let devicesSnapshotVersion = -1;

function bumpAccountData(): void {
  dataVersion++;
  for (const cb of dataListeners) cb();
}

export function subscribeAccountDevices(cb: () => void): () => void {
  dataListeners.add(cb);
  return () => dataListeners.delete(cb);
}

/** Devices linked to this account, from the profile doc (newest first). */
export function getAccountDevicesSnapshot(): DevicePresence[] {
  if (devicesSnapshotVersion !== dataVersion) {
    devicesSnapshotVersion = dataVersion;
    const out: DevicePresence[] = [];
    const map = engine?.doc.getMap<ProfileDeviceEntry>(DEVICES_MAP);
    map?.forEach((v) => {
      if (v && typeof v.id === 'string' && typeof v.label === 'string' && typeof v.at === 'number') {
        out.push({ id: v.id, label: v.label, at: v.at });
      }
    });
    out.sort((a, b) => b.at - a.at);
    devicesSnapshot = out;
  }
  return devicesSnapshot;
}

/* ---------------- lifecycle ---------------- */

/** Start (or return) the profile sync engine. Lazily creates the profile doc
 *  identity on first use — the migration path for existing installs. */
export function startProfileSync(): void {
  if (engine || typeof indexedDB === 'undefined') return;
  openEngine(ensureProfileDocHandle());
}

function stopEngine(opts?: { clearData?: boolean }): Promise<void> {
  const e = engine;
  if (!e) return Promise.resolve();
  engine = null;
  e.destroyed = true;
  clearTimeout(e.applyTimer);
  clearTimeout(e.pushTimer);
  clearTimeout(e.readyTimer);
  clearInterval(e.presenceTimer);
  for (const unsub of e.unsubs) unsub();
  for (const conn of e.providers.values()) {
    try {
      conn.provider.destroy();
    } catch { /* ignore */ }
  }
  e.providers.clear();
  e.p2pGen++;
  try {
    e.p2p?.destroy();
  } catch { /* ignore */ }
  e.p2p = null;
  pendingLive.clear();
  setStatus('offline');
  bumpAccountData();
  const done = Promise.all([
    e.e2ee.destroy({ clearData: opts?.clearData }).catch(() => {}),
    (opts?.clearData ? e.idb.clearData() : e.idb.destroy()).catch(() => {}),
  ]).then(() => {
    e.doc.destroy();
  });
  return done;
}

/**
 * Leave the current account (unlink flow): tear the engine down and, with
 * clearData, drop this account's locally cached profile doc as well. No
 * tombstones are written — the other devices of that account keep everything.
 */
export function stopProfileSync(opts?: { clearData?: boolean }): Promise<void> {
  return stopEngine(opts);
}

/** docId of the account (profile doc) this device currently belongs to. */
export function currentProfileDocId(): string | null {
  return getProfileDocHandle()?.docId ?? null;
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
    providers: new Map(),
    p2p: null,
    p2pGen: 0,
    ready: false,
    destroyed: false,
    unsubs: [],
  };
  engine = e;

  e.e2ee.start().catch((err) => {
    console.warn('[profile-sync] e2ee start failed', err);
  });

  doc.on('update', () => {
    scheduleApply(e);
    bumpAccountData();
  });
  idb.whenSynced.then(() => {
    if (e.destroyed) return;
    scheduleApply(e);
    bumpAccountData();
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
  // The profile doc follows the device relay set: connect to added relays,
  // drop removed/disabled ones; the relay set also feeds the profile doc's
  // relay map, and the P2P signaling list changes with it.
  e.unsubs.push(
    subscribeRelays(() => {
      reconcileProviders(e);
      schedulePush(e);
      restartProfileP2p(e);
    }),
  );
  e.unsubs.push(subscribeP2p(() => restartProfileP2p(e)));

  attachProviders(e);
  attachProfileP2p(e);
  e.presenceTimer = setInterval(() => {
    if (!e.destroyed && e.ready) recordDevicePresence(e);
  }, DEVICE_PRESENCE_THROTTLE_MS);
}

/* ---------------- direct device-to-device sync of the profile doc ---------------- */

function attachProfileP2p(e: Engine): void {
  if (!e.handle.key) return;
  const gen = ++e.p2pGen;
  void attachP2p(
    e.handle.docId,
    e.e2ee.outer,
    e.handle.key,
    () => bumpAccountData(),
    {
      // Within the account, advertise the device's enabled relays: another
      // account device picking them up is exactly the account relay list
      // converging (the doc itself carries the authoritative map).
      advertiseRelays: () => enabledRelayOrigins(),
    },
  ).then((conn) => {
    if (!conn) return;
    if (engine !== e || e.destroyed || gen !== e.p2pGen) {
      conn.destroy();
      return;
    }
    e.p2p = conn;
  });
}

function restartProfileP2p(e: Engine): void {
  if (e.destroyed) return;
  e.p2pGen++;
  try {
    e.p2p?.destroy();
  } catch { /* ignore */ }
  e.p2p = null;
  attachProfileP2p(e);
}

function markReady(e: Engine): void {
  if (e.destroyed || e.ready) return;
  e.ready = true;
  clearTimeout(e.readyTimer);
  schedulePush(e);
}

/* ---------------- relay providers (mirrors docs.ts, simplified) ---------------- */

/**
 * Unlike inventory docs, the profile doc always carries the create payload
 * when both tokens are known: its tokens were minted locally (or came from
 * this same user's backup), so replicating it onto every enabled relay via
 * the create-handshake is always safe.
 */
async function buildToken(): Promise<string> {
  const h = getProfileDocHandle();
  const t = h?.rwToken ?? h?.roToken ?? '';
  if (h?.rwToken && h.roToken) {
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

function recomputeStatus(e: Engine): void {
  const statuses = [...e.providers.values()].map((p) => p.status);
  if (statuses.includes('synced')) setStatus('synced');
  else if (statuses.includes('connecting')) setStatus('connecting');
  else if (statuses.includes('error')) setStatus('error');
  else setStatus('offline');
}

function attachProviders(e: Engine): void {
  for (const origin of enabledRelayOrigins()) {
    if (!e.providers.has(origin)) attachProvider(e, origin);
  }
}

function reconcileProviders(e: Engine): void {
  const targets = new Set(enabledRelayOrigins());
  for (const [origin, conn] of e.providers) {
    if (targets.has(origin)) continue;
    try {
      conn.provider.destroy();
    } catch { /* ignore */ }
    e.providers.delete(origin);
  }
  attachProviders(e);
  recomputeStatus(e);
}

function attachProvider(e: Engine, origin: string): void {
  try {
    const provider = new HocuspocusProvider({
      url: relayWsUrl(origin),
      name: e.handle.docId,
      document: e.e2ee.outer,
      token: () => buildToken(),
      onStatus: ({ status: s }) => {
        const conn = e.providers.get(origin);
        if (!conn || conn.status === 'error') return;
        if (s === WebSocketStatus.Connecting) conn.status = 'connecting';
        else if (s === WebSocketStatus.Disconnected) conn.status = 'offline';
        recomputeStatus(e);
      },
      onSynced: ({ state }) => {
        if (!state) return;
        const conn = e.providers.get(origin);
        if (conn) conn.status = 'synced';
        recomputeStatus(e);
        e.e2ee.onServerSynced();
        markReady(e);
      },
      onAuthenticated: ({ scope }) => {
        if (scope === 'read-write' && getProfileDocHandle()?.pendingCreate) {
          updateProfileDocHandle({ pendingCreate: undefined });
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        console.warn(`[profile-sync] auth failed on ${origin}: ${reason}`);
        const conn = e.providers.get(origin);
        if (conn) {
          conn.status = 'error';
          // Deterministic rejection: stop this relay's reconnect loop.
          conn.provider.disconnect();
        }
        recomputeStatus(e);
        markReady(e);
      },
    });
    e.providers.set(origin, { provider, status: 'connecting' });
    recomputeStatus(e);
  } catch (err) {
    console.warn(`[profile-sync] failed to start provider for ${origin}`, err);
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

  // Account relay list: doc -> device list (this device's default origin is
  // pinned and survives an account-level removal; un-pushed local adds win
  // over stale tombstones).
  const relaysMap = e.doc.getMap<AccountRelayEntry>(RELAYS_MAP);
  const relayEntries: AccountRelayEntry[] = [];
  relaysMap.forEach((v) => {
    if (v && typeof v === 'object' && typeof v.u === 'string') relayEntries.push(v);
  });
  if (relayEntries.length > 0) {
    applyAccountRelays(
      planRelayApply(relayEntries, getRelaysSnapshot(), defaultRelayOrigin(), getPendingRelayAdds()),
    );
  }

  const map = e.doc.getMap<ProfileInvEntry>(INV_MAP);
  const live: Array<{
    docId: string;
    rwToken?: string;
    roToken?: string;
    key?: string;
    name?: string;
    relays?: string[];
    owned?: boolean;
  }> = [];
  const removed: string[] = [];
  map.forEach((_v, docId) => {
    const entry = readEntry(map, docId);
    if (!entry || entry.d === e.handle.docId) return;
    if (entry.removed) removed.push(entry.d);
    else {
      live.push({
        docId: entry.d,
        rwToken: entry.rw,
        roToken: entry.ro,
        key: entry.ek,
        name: entry.nm,
        relays: Array.isArray(entry.rl) ? entry.rl : undefined,
        owned: entry.ow === true,
      });
    }
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
    a.rw === b.rw &&
    a.ro === b.ro &&
    a.ek === b.ek &&
    a.nm === b.nm &&
    !a.removed === !b.removed &&
    !a.ow === !b.ow &&
    (a.rl ?? []).join(' ') === (b.rl ?? []).join(' ')
  );
}

/**
 * Record this device in the account's device list (name·platform, last
 * seen). Requires write access to the profile doc; throttled.
 */
function recordDevicePresence(e: Engine): void {
  if (!getProfileDocHandle()?.rwToken) return;
  const presence = getDevicePresence();
  const map = e.doc.getMap<ProfileDeviceEntry>(DEVICES_MAP);
  const prev = map.get(presence.id);
  if (
    prev &&
    typeof prev.at === 'number' &&
    Date.now() - prev.at < DEVICE_PRESENCE_THROTTLE_MS &&
    prev.label === presence.label
  ) {
    return;
  }
  map.set(presence.id, { id: presence.id, label: presence.label, at: presence.at });
}

function pushLocalToDoc(e: Engine): void {
  const map = e.doc.getMap<ProfileInvEntry>(INV_MAP);
  const profile = e.doc.getMap<unknown>(PROFILE_MAP);
  const relaysMap = e.doc.getMap<AccountRelayEntry>(RELAYS_MAP);
  const localName = getUserName();
  const writtenIntents: string[] = [];

  e.doc.transact(() => {
    if (localName && (pendingNamePush || typeof profile.get('name') !== 'string')) {
      if (profile.get('name') !== localName) profile.set('name', localName);
    }
    pendingNamePush = false;
    if (typeof profile.get('ownerId') !== 'string') profile.set('ownerId', getOwnerId());

    // Account relay list: device -> doc (first push unions the local list in,
    // which is the migration path for pre-account-relay installs).
    const docRelays = new Map<string, AccountRelayEntry>();
    relaysMap.forEach((v, k) => {
      if (v && typeof v === 'object' && typeof v.u === 'string') docRelays.set(k, v);
    });
    const relayOps = planRelayPush(
      getRelaysSnapshot(),
      docRelays,
      getPendingRelayAdds(),
      getPendingRelayRemovals(),
      Date.now(),
    );
    for (const op of relayOps) {
      relaysMap.set(op.u, op);
      writtenIntents.push(op.u);
    }

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
      const ow = h.owned || existing?.ow;
      // Relay lists union-merge: a device can add relays, never remove them
      // through the profile doc (removal stays a local decision).
      const rl = mergeRelayLists(existing?.rl, h.relays);
      if (rw) next.rw = rw;
      if (ro) next.ro = ro;
      if (ek) next.ek = ek;
      if (nm) next.nm = nm;
      if (ow) next.ow = true;
      if (rl.length > 0) next.rl = rl;
      if (existing && sameEntry(existing, next)) continue;
      map.set(h.docId, next);
    }
  });
  for (const url of writtenIntents) clearRelayIntent(url);
  recordDevicePresence(e);
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
  // The previous account's cached profile doc stays on disk: it is harmless
  // and lets a mistaken switch be undone by re-importing that account's code.
  void stopEngine();
  openEngine(getProfileDocHandle()!);
  return true;
}
