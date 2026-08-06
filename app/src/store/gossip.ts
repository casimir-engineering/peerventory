/**
 * Peer gossip + one-hop introduction protocol, carried over y-webrtc's
 * awareness states (see CONTRACTS.md "Peer gossip & introduction").
 *
 * Why awareness: y-webrtc floods awareness updates transitively through every
 * connected peer of a room (each peer re-broadcasts applied updates), so two
 * fields on the local awareness state give us, with zero changes to y-webrtc:
 *
 * - `pv`  — this peer's card: device id, platform, room peer id, and the
 *   relay origins it syncs this doc through. Peers union those origins into
 *   the doc's relay hints, so relay knowledge spreads over the wire even when
 *   no relay or profile doc is reachable.
 * - `pvi` — an outbox of introduction envelopes: WebRTC signaling messages
 *   (offer/answer/ICE) addressed to a specific room peer id. Because
 *   awareness floods through intermediate peers, A's envelope for C travels
 *   via B when A and C share no relay — B "forwards the introduction" simply
 *   by being connected to both. One hop is the design target, but flooding
 *   makes deeper chains work too.
 *
 * Privacy: awareness rides the room's data channels (and BroadcastChannel),
 * which require the doc's content key to join — relay origins and SDP are
 * not secrets *within* a room. Nothing here ever touches a signaling server.
 *
 * This module is transport-agnostic and dependency-free (unit-tested under
 * plain node); p2p.ts adapts it to y-webrtc rooms and awareness.
 */

/** This peer's card, published as awareness field 'pv'. */
export interface PvState {
  v: 1;
  /** y-webrtc room peer id (uuid, per room). */
  pid: string;
  /** Stable device id (device.ts). */
  dev: string;
  /** Platform label, e.g. "Android". */
  plat?: string;
  /** Relay origins this peer syncs the doc through. */
  rl?: string[];
}

/** One ferried signaling message, published in the awareness field 'pvi'. */
export interface IntroEnvelope {
  /** Target room peer id. */
  t: string;
  /** Sender room peer id. */
  f: string;
  /** Session nonce (one per connection attempt). */
  s: number;
  /** Sequence within the session (envelopes apply in order). */
  i: number;
  /** y-webrtc glare token of the sending connection, for offer glare. */
  tk?: number;
  /** epoch ms, for outbox expiry (receivers ignore it). */
  ts?: number;
  /** The simple-peer signal payload (offer/answer/ICE candidate). */
  sg: unknown;
}

/** One remote client's gossip-relevant awareness state. */
export interface RemoteGossipState {
  pv?: PvState;
  pvi?: IntroEnvelope[];
}

/** Environment the manager drives; p2p.ts implements it over y-webrtc. */
export interface GossipEnv {
  /** Own room peer id (stable for the life of the room). */
  pid(): string;
  deviceId: string;
  platform?: string;
  /** Relay origins to advertise for this doc. */
  advertiseRelays(): string[];
  /** Whether a live data channel to this peer exists. */
  isConnected(pid: string): boolean;
  /** Room is at its connection cap: do not initiate more. */
  atCapacity?(): boolean;
  /** Create an outbound connection attempt (offers flow via outboundSignal). */
  initiate(pid: string): void;
  /** Drop a half-open connection so a retry starts clean. */
  resetStale(pid: string): void;
  /** Apply an inbound ferried signal (incl. glare handling + conn creation). */
  applySignal(from: string, sg: unknown, tk: number | undefined): void;
  /** Publish local awareness fields. */
  publish(pv: PvState, pvi: IntroEnvelope[]): void;
  /** A peer advertised relay origins for this doc. */
  onRemoteRelays(relays: string[]): void;
  /** A peer's device was seen live (feeds P2P reachability). */
  onDeviceSeen(deviceId: string, meta: { pid: string; plat?: string }): void;
}

/** Grace period for the normal relay-signaling path before an intro starts. */
export const INTRO_DELAY_MS = 4_000;
const RETRY_MS = 20_000;
const MAX_ATTEMPTS = 3;
const OUTBOX_TTL_MS = 45_000;
const MAX_OUTBOX = 64;
const MAX_PROCESSED = 256;
/** Cap on advertised/accepted relay origins (abuse guard). */
export const MAX_GOSSIP_RELAYS = 12;

export class GossipManager {
  /** Known remote peers (from pv cards), by room peer id. */
  private peers = new Map<string, { dev: string; firstSeen: number; lastSeen: number }>();
  /** Highest envelope index applied per inbound stream `${from}:${session}`. */
  private processed = new Map<string, number>();
  /** Outbound intro attempts, by target peer id. */
  private attempts = new Map<string, { count: number; lastAt: number }>();
  /** Outbound envelope numbering, by target peer id. */
  private streams = new Map<string, { s: number; i: number }>();
  private outbox: IntroEnvelope[] = [];
  private dirty = false;

  constructor(
    private readonly env: GossipEnv,
    private readonly now: () => number = Date.now,
  ) {}

  /** Publish the initial pv card. */
  start(): void {
    this.dirty = true;
    this.publish();
  }

  /** Feed the current remote awareness states (own client excluded). */
  applyRemote(states: RemoteGossipState[]): void {
    const t = this.now();
    const seen = new Set<string>();
    for (const st of states) {
      const pv = st?.pv;
      if (pv && typeof pv.pid === 'string' && pv.pid && pv.pid !== this.env.pid()) {
        seen.add(pv.pid);
        const p = this.peers.get(pv.pid);
        if (p) {
          p.lastSeen = t;
        } else {
          this.peers.set(pv.pid, {
            dev: typeof pv.dev === 'string' ? pv.dev : '',
            firstSeen: t,
            lastSeen: t,
          });
        }
        if (Array.isArray(pv.rl) && pv.rl.length > 0) {
          const relays = pv.rl
            .filter((u): u is string => typeof u === 'string' && u.length > 0 && u.length < 200)
            .slice(0, MAX_GOSSIP_RELAYS);
          if (relays.length > 0) this.env.onRemoteRelays(relays);
        }
        if (typeof pv.dev === 'string' && pv.dev) {
          this.env.onDeviceSeen(pv.dev, { pid: pv.pid, plat: pv.plat });
        }
      }
      if (Array.isArray(st?.pvi)) {
        for (const envl of st.pvi) this.applyEnvelope(envl);
      }
    }
    // Awareness drops disconnected clients' states; forget their cards.
    for (const pid of [...this.peers.keys()]) {
      if (!seen.has(pid)) this.peers.delete(pid);
    }
  }

  private applyEnvelope(e: IntroEnvelope): void {
    if (!e || typeof e !== 'object') return;
    if (e.t !== this.env.pid()) return; // not addressed to us (or malformed)
    if (typeof e.f !== 'string' || !e.f || typeof e.s !== 'number' || typeof e.i !== 'number') return;
    const key = `${e.f}:${e.s}`;
    const max = this.processed.get(key) ?? -1;
    if (e.i <= max) return;
    this.processed.set(key, e.i);
    if (this.processed.size > MAX_PROCESSED) {
      const oldest = this.processed.keys().next().value;
      if (oldest !== undefined) this.processed.delete(oldest);
    }
    this.env.applySignal(e.f, e.sg, typeof e.tk === 'number' ? e.tk : undefined);
  }

  /** Ferry a locally generated signal to a peer (called by the adapter). */
  outboundSignal(to: string, sg: unknown, tk?: number): void {
    let st = this.streams.get(to);
    if (!st) {
      st = { s: this.now(), i: 0 };
      this.streams.set(to, st);
    }
    this.outbox.push({
      t: to,
      f: this.env.pid(),
      s: st.s,
      i: st.i++,
      ...(typeof tk === 'number' ? { tk } : {}),
      ts: this.now(),
      sg,
    });
    if (this.outbox.length > MAX_OUTBOX) {
      this.outbox.splice(0, this.outbox.length - MAX_OUTBOX);
    }
    this.dirty = true;
    this.publish();
  }

  /**
   * Periodic driver: initiates introductions for peers that stayed
   * unconnected past the grace period (deterministic initiator: the smaller
   * peer id, so exactly one side offers), retries with backoff, and prunes
   * finished/expired envelopes from the outbox.
   */
  tick(): void {
    const t = this.now();
    for (const [pid, p] of this.peers) {
      if (this.env.isConnected(pid)) {
        if (this.attempts.delete(pid)) this.dirty = true;
        this.pruneOutbox((e) => e.t === pid);
        continue;
      }
      if (this.env.pid() >= pid) continue; // the other side initiates
      if (t - p.firstSeen < INTRO_DELAY_MS) continue;
      if (this.env.atCapacity?.()) continue;
      const a = this.attempts.get(pid);
      if (!a) {
        this.attempts.set(pid, { count: 1, lastAt: t });
        this.streams.delete(pid);
        this.env.initiate(pid);
      } else if (a.count < MAX_ATTEMPTS && t - a.lastAt >= RETRY_MS) {
        a.count++;
        a.lastAt = t;
        this.streams.delete(pid);
        this.pruneOutbox((e) => e.t === pid);
        this.env.resetStale(pid);
        this.env.initiate(pid);
      }
    }
    this.pruneOutbox((e) => t - (e.ts ?? t) >= OUTBOX_TTL_MS);
    this.publish();
  }

  /** Re-publish the pv card (e.g. after the advertised relay set changed). */
  refresh(): void {
    this.dirty = true;
    this.publish();
  }

  private pruneOutbox(drop: (e: IntroEnvelope) => boolean): void {
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((e) => !drop(e));
    if (this.outbox.length !== before) this.dirty = true;
  }

  private publish(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const rl = this.env.advertiseRelays().slice(0, MAX_GOSSIP_RELAYS);
    this.env.publish(
      {
        v: 1,
        pid: this.env.pid(),
        dev: this.env.deviceId,
        ...(this.env.platform ? { plat: this.env.platform } : {}),
        ...(rl.length > 0 ? { rl } : {}),
      },
      this.outbox.slice(),
    );
  }
}
