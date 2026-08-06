/**
 * Direct device-to-device sync (WebRTC) for E2E inventories.
 *
 * A y-webrtc provider is attached to the OUTER (encrypted) doc — the same
 * bytes a relay sees — so P2P peers decrypt through the existing e2ee
 * pipeline and there is exactly one sync code path. Signaling NEVER uses
 * public y-webrtc servers: introduction runs over the `/signal` endpoint of
 * EVERY relay the doc syncs through plus every relay enabled on this device
 * (y-webrtc opens one signaling socket per URL and announces on all of them;
 * the lib0 websocket client reconnects forever with backoff, so a relay
 * coming back is re-used automatically), and — on Android — over LAN
 * signaling endpoints discovered via mDNS (lan.ts).
 *
 * Room privacy: the room name is HMAC-SHA256(contentKey, "room" label +
 * docId), unguessable without the E2E key, and y-webrtc's room password
 * (a second HMAC) additionally encrypts all signaling payloads. A stranger
 * on the signaling server can neither discover a doc's room nor join it,
 * and the signaling server itself sees only opaque room ids, IPs, and
 * encrypted SDP blobs.
 *
 * On top of the y-webrtc rooms this module runs the gossip/introduction
 * protocol (gossip.ts): connected peers exchange relay origins and forward
 * WebRTC introductions for peers that share no reachable relay, and every
 * peer's device id feeds the account-wide "reachable now" P2P presence.
 */
import type * as Y from 'yjs';
import { WebrtcProvider, WebrtcConn } from 'y-webrtc';
import type { Id } from '../types';
import { bytesToBase64Url, importContentKey } from './crypto';
import { getDeviceId, platformLabel } from './device';
import { GossipManager, type GossipEnv, type RemoteGossipState } from './gossip';
import { lanRoomClosed, lanRoomOpened } from './lan';
import { enabledRelayOrigins, mergeRelayLists, relayOriginsForDoc, relaySignalingUrl } from './relays';

export { isP2pEnabled, setP2pEnabled, subscribeP2p } from './p2pSettings';
import { isP2pEnabled } from './p2pSettings';

/* ---------- room derivation ---------- */

async function hmacB64Url(keyB64: string, label: string, docId: Id): Promise<string> {
  const { hmac } = await importContentKey(keyB64);
  const input = new TextEncoder().encode(`peerventory:webrtc-${label}:${docId}`);
  const mac = await crypto.subtle.sign('HMAC', hmac, input.slice().buffer as ArrayBuffer);
  return bytesToBase64Url(new Uint8Array(mac));
}

/** Unguessable signaling room name for a doc (needs the content key). */
export function deriveRoomName(keyB64: string, docId: Id): Promise<string> {
  return hmacB64Url(keyB64, 'room', docId);
}

/** Room password: encrypts signaling payloads (SDP) on top of the room name. */
export function deriveRoomPassword(keyB64: string, docId: Id): Promise<string> {
  return hmacB64Url(keyB64, 'pw', docId);
}

/* ---------- P2P device presence (account-wide "reachable now") ---------- */

const PRESENCE_TTL_MS = 45_000;

interface PresenceEntry {
  plat?: string;
  lastSeen: number;
}

const presence = new Map<string, PresenceEntry>();
const presenceListeners = new Set<() => void>();
let presenceVersion = 0;
let presenceSnapshot: Array<{ id: string; plat?: string; lastSeen: number }> = [];
let presenceSnapshotVersion = -1;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function bumpPresence(): void {
  presenceVersion++;
  for (const cb of presenceListeners) cb();
}

function notePresence(deviceId: string, plat?: string): void {
  if (!deviceId || deviceId === getDeviceId()) return;
  const now = Date.now();
  const cur = presence.get(deviceId);
  const wasReachable = Boolean(cur);
  presence.set(deviceId, { plat: plat ?? cur?.plat, lastSeen: now });
  if (!sweepTimer && typeof setInterval !== 'undefined') {
    sweepTimer = setInterval(() => {
      const cutoff = Date.now() - PRESENCE_TTL_MS;
      let changed = false;
      for (const [id, e] of presence) {
        if (e.lastSeen < cutoff) {
          presence.delete(id);
          changed = true;
        }
      }
      if (changed) bumpPresence();
    }, 15_000);
  }
  if (!wasReachable) bumpPresence();
}

export function subscribeP2pPresence(cb: () => void): () => void {
  presenceListeners.add(cb);
  return () => presenceListeners.delete(cb);
}

/** Devices currently reachable over any live P2P room (stable snapshot). */
export function getP2pPresenceSnapshot(): Array<{ id: string; plat?: string; lastSeen: number }> {
  if (presenceSnapshotVersion !== presenceVersion) {
    presenceSnapshot = [...presence.entries()].map(([id, e]) => ({
      id,
      plat: e.plat,
      lastSeen: e.lastSeen,
    }));
    presenceSnapshotVersion = presenceVersion;
  }
  return presenceSnapshot;
}

export function isDeviceReachableP2p(deviceId: string): boolean {
  return presence.has(deviceId);
}

/* ---------- gossip adapter over a y-webrtc room ---------- */

/** The parts of y-webrtc's internal Room/WebrtcConn this module relies on. */
interface ConnLike {
  connected: boolean;
  glareToken: number | undefined;
  peer: {
    on(ev: 'signal', cb: (sg: unknown) => void): void;
    signal(sg: unknown): void;
    destroy(): void;
  };
}

interface RoomLike {
  peerId: string;
  webrtcConns: Map<string, ConnLike>;
  bcConns: Set<string>;
}

function emitPeers(provider: WebrtcProvider, room: RoomLike): void {
  (provider as unknown as { emit(ev: string, args: unknown[]): void }).emit('peers', [
    {
      added: [],
      removed: [],
      webrtcPeers: Array.from(room.webrtcConns.keys()),
      bcPeers: Array.from(room.bcConns),
    },
  ]);
}

interface GossipHooks {
  /** Relay origins to advertise to room peers. */
  advertiseRelays: () => string[];
  /** Relay origins gossiped by room peers (already length-capped). */
  onRemoteRelays?: (urls: string[]) => void;
}

function attachGossip(
  provider: WebrtcProvider,
  hooks: GossipHooks,
): () => void {
  const room = provider.room as unknown as RoomLike | null;
  if (!room) return () => {};
  const awareness = provider.awareness;
  // WebrtcConn's constructor publishes signals through the signaling
  // connection it was created with; for introduced connections we drop those
  // (encrypted) publishes and ferry the plaintext signal through the room's
  // awareness instead — the room already requires the doc key.
  const noopSignaling = { send: () => {} };
  const ferried = new WeakSet<object>();

  const getOrCreateConn = (pid: string, initiator: boolean): ConnLike | null => {
    if (!pid || pid === room.peerId) return null;
    let conn = room.webrtcConns.get(pid);
    if (!conn) {
      if (room.webrtcConns.size >= provider.maxConns) return null;
      try {
        conn = new WebrtcConn(
          noopSignaling as never,
          initiator,
          pid,
          provider.room as never,
        ) as unknown as ConnLike;
      } catch (err) {
        console.warn('[p2p] intro connection failed to start', err);
        return null;
      }
      room.webrtcConns.set(pid, conn);
      emitPeers(provider, room);
    }
    if (!ferried.has(conn)) {
      ferried.add(conn);
      const c = conn;
      c.peer.on('signal', (sg: unknown) => manager.outboundSignal(pid, sg, c.glareToken));
    }
    return conn;
  };

  const env: GossipEnv = {
    pid: () => room.peerId,
    deviceId: getDeviceId(),
    platform: platformLabel(),
    advertiseRelays: hooks.advertiseRelays,
    isConnected: (pid) => Boolean(room.webrtcConns.get(pid)?.connected),
    atCapacity: () => room.webrtcConns.size >= provider.maxConns,
    initiate: (pid) => {
      getOrCreateConn(pid, true);
    },
    resetStale: (pid) => {
      const conn = room.webrtcConns.get(pid);
      if (conn && !conn.connected) {
        room.webrtcConns.delete(pid);
        try {
          conn.peer.destroy();
        } catch {
          /* already gone */
        }
        emitPeers(provider, room);
      }
    },
    applySignal: (from, sg, tk) => {
      const sig = sg as { type?: string } | null;
      if (!sig || typeof sig !== 'object') return;
      // Offer glare, mirroring y-webrtc's signaling handler: when both sides
      // sent offers, the higher glare token wins and the loser's offer is
      // dropped (it then answers the winner's offer instead).
      const existing = room.webrtcConns.get(from);
      if (sig.type === 'offer' && existing) {
        const local = existing.glareToken;
        if (local !== undefined && tk !== undefined && local > tk) return;
        existing.glareToken = undefined;
      }
      if (sig.type === 'answer' && existing) existing.glareToken = undefined;
      const conn = getOrCreateConn(from, false);
      if (!conn) return;
      try {
        conn.peer.signal(sg);
      } catch (err) {
        console.warn('[p2p] ferried signal failed to apply', err);
      }
    },
    publish: (pv, pvi) => {
      awareness.setLocalStateField('pv', pv);
      awareness.setLocalStateField('pvi', pvi);
    },
    onRemoteRelays: (urls) => hooks.onRemoteRelays?.(urls),
    onDeviceSeen: (dev, meta) => notePresence(dev, meta.plat),
  };

  const manager = new GossipManager(env);

  const onAwareness = () => {
    const states: RemoteGossipState[] = [];
    awareness.getStates().forEach((st, clientId) => {
      if (clientId === awareness.clientID) return;
      const s = st as RemoteGossipState | null;
      if (s && typeof s === 'object') states.push({ pv: s.pv, pvi: s.pvi });
    });
    manager.applyRemote(states);
  };

  awareness.on('change', onAwareness);
  const tickTimer = setInterval(() => manager.tick(), 1_500);
  manager.start();
  onAwareness();

  return () => {
    clearInterval(tickTimer);
    awareness.off('change', onAwareness);
    try {
      awareness.setLocalStateField('pv', null);
      awareness.setLocalStateField('pvi', null);
    } catch {
      /* awareness may already be destroyed */
    }
  };
}

/* ---------- provider lifecycle ---------- */

export interface P2pConn {
  provider: WebrtcProvider;
  destroy(): void;
}

/**
 * The signaling websocket URLs a doc's room uses: every enabled relay of the
 * device PLUS every relay recorded on the doc's handle (a doc shared across
 * accounts is announced on the other account's relays too, so introduction
 * survives either side's relay loss). LAN endpoints are handled separately
 * (lan.ts attaches standalone signaling connections that serve all rooms).
 */
export function p2pSignalingOrigins(docId: Id): string[] {
  return mergeRelayLists(enabledRelayOrigins(), relayOriginsForDoc(docId));
}

export interface AttachP2pOptions {
  /** Relay origins to advertise to room peers (default: doc's relay set). */
  advertiseRelays?: () => string[];
  /** Called with relay origins gossiped by room peers. */
  onRemoteRelays?: (urls: string[]) => void;
}

/**
 * Attach a y-webrtc provider to a doc's outer (encrypted) doc. Returns null
 * when P2P is off or the room cannot be derived. A provider is created even
 * with zero reachable relays: LAN signaling and already-established peers
 * keep working without any relay. `onPeers` receives the current
 * direct-peer count.
 */
export async function attachP2p(
  docId: Id,
  outerDoc: Y.Doc,
  keyB64: string,
  onPeers: (count: number) => void,
  opts?: AttachP2pOptions,
): Promise<P2pConn | null> {
  if (!isP2pEnabled() || !keyB64) return null;
  const signaling = p2pSignalingOrigins(docId).map(relaySignalingUrl);

  let roomName: string;
  let password: string;
  try {
    [roomName, password] = await Promise.all([
      deriveRoomName(keyB64, docId),
      deriveRoomPassword(keyB64, docId),
    ]);
  } catch (err) {
    console.warn(`[p2p] cannot derive room for ${docId}`, err);
    return null;
  }

  let provider: WebrtcProvider;
  try {
    provider = new WebrtcProvider(roomName, outerDoc, {
      signaling,
      password,
      // Tabs of the same browser already share state via y-indexeddb +
      // BroadcastChannel inside y-webrtc; count only real WebRTC peers.
      filterBcConns: true,
      maxConns: 12,
    });
  } catch (err) {
    console.warn(`[p2p] provider failed to start for ${docId}`, err);
    return null;
  }

  const peersHandler = ({ webrtcPeers }: { webrtcPeers: string[] }) => {
    onPeers(webrtcPeers.length);
  };
  provider.on('peers', peersHandler);

  // The room only exists once the room password finished deriving.
  let detachGossip: (() => void) | null = null;
  let destroyed = false;
  void Promise.resolve(provider.key).then(() => {
    if (destroyed || !provider.room) return;
    detachGossip = attachGossip(provider, {
      advertiseRelays: opts?.advertiseRelays ?? (() => relayOriginsForDoc(docId)),
      onRemoteRelays: opts?.onRemoteRelays,
    });
    lanRoomOpened(provider.room);
  });

  return {
    provider,
    destroy() {
      destroyed = true;
      try {
        detachGossip?.();
        if (provider.room) lanRoomClosed(provider.room);
        provider.off('peers', peersHandler);
        provider.destroy();
      } catch {
        /* already gone */
      }
      onPeers(0);
    },
  };
}
