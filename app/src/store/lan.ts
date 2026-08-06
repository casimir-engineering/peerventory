/**
 * LAN peer discovery (Android): zero-infrastructure introduction between
 * devices on the same network.
 *
 * Native side (app/android LanDiscovery plugin): each device advertises an
 * mDNS/NSD service `_peerventory._tcp` carrying its deviceId and runs a tiny
 * embedded WebSocket server speaking the exact y-webrtc signaling pub/sub
 * protocol of server/src/signaling.ts (subscribe/unsubscribe/publish/ping).
 *
 * JS side (this module): every discovered peer endpoint — plus our own local
 * server, so peers that found US meet us there — gets a standalone y-webrtc
 * SignalingConn. y-webrtc keeps a module-global room registry, so a
 * standalone SignalingConn transparently serves EVERY open doc room: on
 * connect it subscribes + announces all rooms, and incoming publishes create
 * ordinary WebRTC connections with the usual glare handling. No provider
 * restarts, no second code path.
 *
 * Privacy: room names are HMAC-derived (opaque) and all published payloads
 * are encrypted with the room password (derived from the doc key), exactly
 * as on a relay's /signal. A stranger's device on the LAN can run the same
 * server and learn only opaque room ids and ciphertext — it cannot discover,
 * join, or read a doc's room without the key.
 *
 * Rooms opened after a LAN socket connected are announced from here (the
 * y-webrtc connect handler only announces rooms existing at connect time),
 * and unconnected rooms are re-announced periodically so two phones that
 * dropped their link find each other again without any relay.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { SignalingConn } from 'y-webrtc';
import * as encoding from 'lib0/encoding';
import * as buffer from 'lib0/buffer';
import { getDeviceId } from './device';
import { isP2pEnabled, subscribeP2p } from './p2pSettings';

interface LanPeer {
  deviceId: string;
  host: string;
  port: number;
}

interface LanDiscoveryPlugin {
  start(options: { deviceId: string }): Promise<{ port: number }>;
  stop(): Promise<void>;
  addListener(
    eventName: 'peersChanged',
    listener: (data: { peers: LanPeer[] }) => void,
  ): Promise<PluginListenerHandle>;
}

/** y-webrtc Room internals this module relies on (structurally typed). */
interface RoomLike {
  name: string;
  peerId: string;
  key: CryptoKey | null;
  webrtcConns: Map<string, { connected: boolean }>;
  provider: { maxConns: number };
}

interface LanSignalingConn {
  connected: boolean;
  send(message: object): void;
  destroy(): void;
  on(ev: 'connect', cb: () => void): void;
}

const ANNOUNCE_INTERVAL_MS = 20_000;

const conns = new Map<string, LanSignalingConn>();
const rooms = new Set<RoomLike>();
let plugin: LanDiscoveryPlugin | null = null;
let pluginListener: PluginListenerHandle | null = null;
let ownEndpoint: string | null = null;
let running = false;
let announceTimer: ReturnType<typeof setInterval> | null = null;
let lastPeers: LanPeer[] = [];

const lanListeners = new Set<() => void>();

function notifyLan(): void {
  for (const cb of lanListeners) cb();
}

export function subscribeLan(cb: () => void): () => void {
  lanListeners.add(cb);
  return () => lanListeners.delete(cb);
}

/** Number of Peerventory devices currently visible on the local network. */
export function getLanPeerCount(): number {
  return running ? lastPeers.length : 0;
}

export function isLanSupported(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function isLanRunning(): boolean {
  return running;
}

/* ---------- announce (mirrors y-webrtc's publishSignalingMessage) ---------- */

/** y-webrtc's crypto.js encrypt(): 'AES-GCM' + iv + ciphertext, lib0-encoded. */
async function encryptAnnounce(room: RoomLike): Promise<string | object> {
  const payload = { type: 'announce', from: room.peerId };
  if (!room.key) return payload;
  const dataEncoder = encoding.createEncoder();
  encoding.writeAny(dataEncoder, payload);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    room.key,
    encoding.toUint8Array(dataEncoder),
  );
  const out = encoding.createEncoder();
  encoding.writeVarString(out, 'AES-GCM');
  encoding.writeVarUint8Array(out, iv);
  encoding.writeVarUint8Array(out, new Uint8Array(cipher));
  return buffer.toBase64(encoding.toUint8Array(out));
}

async function announceRoom(conn: LanSignalingConn, room: RoomLike): Promise<void> {
  try {
    conn.send({ type: 'subscribe', topics: [room.name] });
    if (room.webrtcConns.size < room.provider.maxConns) {
      const data = await encryptAnnounce(room);
      conn.send({ type: 'publish', topic: room.name, data });
    }
  } catch (err) {
    console.warn('[lan] announce failed', err);
  }
}

function announceRoomEverywhere(room: RoomLike): void {
  for (const conn of conns.values()) {
    if (conn.connected) void announceRoom(conn, room);
  }
}

/** p2p.ts calls this when a doc room opens (provider room ready). */
export function lanRoomOpened(room: unknown): void {
  const r = room as RoomLike;
  rooms.add(r);
  if (running) announceRoomEverywhere(r);
}

export function lanRoomClosed(room: unknown): void {
  rooms.delete(room as RoomLike);
}

function startAnnounceLoop(): void {
  if (announceTimer) return;
  announceTimer = setInterval(() => {
    if (conns.size === 0) return;
    for (const room of rooms) {
      // Only nudge rooms that still miss peers; connected rooms are settled.
      const connectedPeers = [...room.webrtcConns.values()].filter((c) => c.connected).length;
      if (connectedPeers === 0) announceRoomEverywhere(room);
    }
  }, ANNOUNCE_INTERVAL_MS);
}

/* ---------- endpoint / connection management ---------- */

function endpointUrl(peer: LanPeer): string {
  const host = peer.host.includes(':') ? `[${peer.host}]` : peer.host;
  return `ws://${host}:${peer.port}`;
}

function reconcileConns(): void {
  const targets = new Set<string>();
  if (running) {
    if (ownEndpoint) targets.add(ownEndpoint);
    for (const p of lastPeers) targets.add(endpointUrl(p));
  }
  for (const [url, conn] of conns) {
    if (targets.has(url)) continue;
    try {
      conn.destroy();
    } catch {
      /* ignore */
    }
    conns.delete(url);
  }
  for (const url of targets) {
    if (conns.has(url)) continue;
    try {
      // Standalone y-webrtc signaling client: subscribes + announces every
      // open room on connect and handles publishes for all of them.
      const conn = new SignalingConn(url) as unknown as LanSignalingConn;
      conns.set(url, conn);
    } catch (err) {
      console.warn(`[lan] signaling connection failed for ${url}`, err);
    }
  }
  notifyLan();
}

/* ---------- lifecycle ---------- */

async function startNative(): Promise<void> {
  if (running) return;
  try {
    plugin = plugin ?? registerPlugin<LanDiscoveryPlugin>('LanDiscovery');
    pluginListener = await plugin.addListener('peersChanged', ({ peers }) => {
      lastPeers = Array.isArray(peers)
        ? peers.filter(
            (p) =>
              p &&
              typeof p.deviceId === 'string' &&
              p.deviceId !== getDeviceId() &&
              typeof p.host === 'string' &&
              typeof p.port === 'number',
          )
        : [];
      reconcileConns();
    });
    const { port } = await plugin.start({ deviceId: getDeviceId() });
    ownEndpoint = `ws://127.0.0.1:${port}`;
    running = true;
    reconcileConns();
    startAnnounceLoop();
    console.info(`[lan] discovery running, local signaling on :${port}`);
  } catch (err) {
    console.warn('[lan] discovery failed to start', err);
    await stopNative();
  }
}

async function stopNative(): Promise<void> {
  running = false;
  lastPeers = [];
  ownEndpoint = null;
  reconcileConns();
  if (announceTimer) {
    clearInterval(announceTimer);
    announceTimer = null;
  }
  try {
    await pluginListener?.remove();
  } catch {
    /* ignore */
  }
  pluginListener = null;
  try {
    await plugin?.stop();
  } catch {
    /* ignore */
  }
}

/**
 * Start LAN discovery when supported (Android native) and P2P is enabled;
 * follows the P2P toggle from then on. No-op on web/desktop — those reach
 * phones through a relay or via gossip introduction once any path exists.
 */
export function startLanDiscovery(): void {
  if (!isLanSupported()) return;
  const apply = () => {
    if (isP2pEnabled()) void startNative();
    else void stopNative();
  };
  subscribeP2p(apply);
  apply();
}
