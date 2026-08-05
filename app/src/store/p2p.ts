/**
 * Direct device-to-device sync (WebRTC) for E2E inventories.
 *
 * A y-webrtc provider is attached to the OUTER (encrypted) doc — the same
 * bytes a relay sees — so P2P peers decrypt through the existing e2ee
 * pipeline and there is exactly one sync code path. Signaling NEVER uses
 * public y-webrtc servers: it goes through the `/signal` endpoint of the
 * user's own relays (see server/src/signaling.ts).
 *
 * Room privacy: the room name is HMAC-SHA256(contentKey, "room" label +
 * docId), unguessable without the E2E key, and y-webrtc's room password
 * (a second HMAC) additionally encrypts all signaling payloads. A stranger
 * on the signaling server can neither discover a doc's room nor join it,
 * and the signaling server itself sees only opaque room ids, IPs, and
 * encrypted SDP blobs.
 */
import type * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';
import type { Id } from '../types';
import { bytesToBase64Url, importContentKey } from './crypto';
import { enabledRelayOrigins, relaySignalingUrl } from './relays';

const P2P_KEY = 'p2p:v1';

/* ---------- setting: direct device-to-device sync (default ON) ---------- */

let p2pListeners = new Set<() => void>();

export function isP2pEnabled(): boolean {
  try {
    return localStorage.getItem(P2P_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setP2pEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(P2P_KEY, enabled ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  for (const cb of p2pListeners) cb();
}

export function subscribeP2p(cb: () => void): () => void {
  p2pListeners.add(cb);
  return () => p2pListeners.delete(cb);
}

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

/* ---------- provider lifecycle ---------- */

export interface P2pConn {
  provider: WebrtcProvider;
  destroy(): void;
}

/**
 * Attach a y-webrtc provider to a doc's outer (encrypted) doc. Returns null
 * when P2P is off, no relays are enabled (no signaling path), or the room
 * cannot be derived. `onPeers` receives the current direct-peer count.
 */
export async function attachP2p(
  docId: Id,
  outerDoc: Y.Doc,
  keyB64: string,
  onPeers: (count: number) => void,
): Promise<P2pConn | null> {
  if (!isP2pEnabled()) return null;
  const signaling = enabledRelayOrigins().map(relaySignalingUrl);
  if (signaling.length === 0) return null;

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

  return {
    provider,
    destroy() {
      try {
        provider.off('peers', peersHandler);
        provider.destroy();
      } catch {
        /* already gone */
      }
      onPeers(0);
    },
  };
}
