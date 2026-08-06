/**
 * Unit test for the gossip / one-hop introduction protocol
 * (store/gossip.ts) with three fake peers over an in-memory awareness bus:
 *
 *  - relay-origin exchange (pv cards feed onRemoteRelays on every peer)
 *  - one-hop introduction: A and C are NOT directly connected but both are
 *    connected to B; A's offer envelope floods to C, C answers, both mark
 *    the channel connected — no signaling server involved
 *  - envelopes are addressed (B never applies A<->C signals)
 *  - duplicate envelope delivery is idempotent (per-stream sequence dedup)
 *  - the outbox is pruned once the target is connected
 *  - unanswered introductions retry with backoff and give up at the cap
 *
 * Run: npm run test:store (vite-bundles to scripts/dist, runs under node).
 */
import assert from 'node:assert/strict';
import {
  GossipManager,
  INTRO_DELAY_MS,
  type GossipEnv,
  type IntroEnvelope,
  type PvState,
  type RemoteGossipState,
} from '../src/store/gossip';

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.info(`ok - ${label}`);
  } catch (error) {
    console.error(`FAIL - ${label}`);
    throw error;
  }
}

/* ---------- fake peer over an in-memory awareness bus ---------- */

const RETRY_MS = 20_000; // mirrors gossip.ts

class FakePeer {
  readonly manager: GossipManager;
  /** Last published awareness fields (what the room would flood). */
  published: RemoteGossipState = {};
  /** Direct data channels, pid -> connected. */
  readonly conns = new Map<string, boolean>();
  /** Every relay list any peer gossiped to us. */
  readonly remoteRelays: string[][] = [];
  /** Devices seen live. */
  readonly devicesSeen = new Map<string, string | undefined>();
  readonly initiated: string[] = [];
  readonly signalsApplied: Array<{ from: string; sg: { type: string } }> = [];
  readonly resets: string[] = [];
  /** When true, inbound offers are answered (simple-peer stand-in). */
  answering = true;

  constructor(
    readonly pid: string,
    readonly dev: string,
    readonly relays: string[],
    readonly clock: { now: number },
  ) {
    const env: GossipEnv = {
      pid: () => this.pid,
      deviceId: this.dev,
      platform: 'Test',
      advertiseRelays: () => this.relays,
      isConnected: (pid) => this.conns.get(pid) === true,
      initiate: (pid) => {
        this.initiated.push(pid);
        this.conns.set(pid, false);
        // simple-peer as initiator emits an offer immediately.
        this.manager.outboundSignal(pid, { type: 'offer', sdp: `offer-from-${this.pid}` }, 42);
      },
      resetStale: (pid) => {
        this.resets.push(pid);
        if (this.conns.get(pid) === false) this.conns.delete(pid);
      },
      applySignal: (from, sg) => {
        const sig = sg as { type: string };
        this.signalsApplied.push({ from, sg: sig });
        if (sig.type === 'offer' && this.answering) {
          this.conns.set(from, true);
          this.manager.outboundSignal(from, { type: 'answer', sdp: `answer-from-${this.pid}` });
        } else if (sig.type === 'answer') {
          this.conns.set(from, true);
        }
      },
      publish: (pv: PvState, pvi: IntroEnvelope[]) => {
        this.published = { pv, pvi };
      },
      onRemoteRelays: (urls) => {
        this.remoteRelays.push(urls);
      },
      onDeviceSeen: (deviceId, meta) => {
        this.devicesSeen.set(deviceId, meta.plat);
      },
    };
    this.manager = new GossipManager(env, () => this.clock.now);
    this.manager.start();
  }
}

/** Awareness flood: every peer sees every OTHER peer's published state. */
function exchange(peers: FakePeer[]): void {
  for (const p of peers) {
    p.manager.applyRemote(peers.filter((o) => o !== p).map((o) => o.published));
  }
}

/* ---------- scenario: A - B - C chain ---------- */

const clock = { now: 1_000 };
const a = new FakePeer('pid-a', 'devA', ['https://relay-a.example'], clock);
const b = new FakePeer('pid-b', 'devB', ['https://relay-b.example'], clock);
const c = new FakePeer('pid-c', 'devC', ['https://relay-c.example'], clock);
// A<->B and B<->C have live channels (met via their relays); A<->C do not.
a.conns.set('pid-b', true);
b.conns.set('pid-a', true);
b.conns.set('pid-c', true);
c.conns.set('pid-b', true);

exchange([a, b, c]);

check('relay origins gossip to every room peer', () => {
  assert.ok(a.remoteRelays.some((rl) => rl.includes('https://relay-b.example')));
  assert.ok(a.remoteRelays.some((rl) => rl.includes('https://relay-c.example')));
  assert.ok(c.remoteRelays.some((rl) => rl.includes('https://relay-a.example')));
});

check('device presence flows from pv cards', () => {
  assert.deepEqual([...a.devicesSeen.keys()].sort(), ['devB', 'devC']);
  assert.equal(a.devicesSeen.get('devB'), 'Test');
});

check('no introduction before the relay-path grace period', () => {
  a.manager.tick();
  b.manager.tick();
  c.manager.tick();
  assert.deepEqual(a.initiated, []);
  assert.deepEqual(c.initiated, []);
});

check('one-hop introduction connects A and C through flooding', () => {
  clock.now += INTRO_DELAY_MS + 500;
  a.manager.tick();
  b.manager.tick();
  c.manager.tick();
  // Deterministic initiator: only the smaller pid (A) offers, C never does.
  assert.deepEqual(a.initiated, ['pid-c']);
  assert.deepEqual(c.initiated, []);
  assert.ok((a.published.pvi ?? []).some((e) => e.t === 'pid-c'), 'offer envelope in A outbox');

  exchange([a, b, c]); // offer floods A -> (B) -> C
  assert.deepEqual(c.signalsApplied, [{ from: 'pid-a', sg: { type: 'offer', sdp: 'offer-from-pid-a' } }]);

  exchange([a, b, c]); // answer floods C -> (B) -> A
  assert.deepEqual(a.signalsApplied, [{ from: 'pid-c', sg: { type: 'answer', sdp: 'answer-from-pid-c' } }]);
  assert.equal(a.conns.get('pid-c'), true);
  assert.equal(c.conns.get('pid-a'), true);
});

check('envelopes are addressed: B never applies A<->C signals', () => {
  assert.deepEqual(b.signalsApplied, []);
  assert.deepEqual(b.initiated, []);
});

check('duplicate delivery is idempotent (stream dedup)', () => {
  const before = c.signalsApplied.length;
  exchange([a, b, c]);
  exchange([a, b, c]);
  assert.equal(c.signalsApplied.length, before);
});

check('outbox is pruned once the target is connected', () => {
  a.manager.tick();
  c.manager.tick();
  assert.deepEqual(a.published.pvi, []);
  assert.deepEqual(c.published.pvi, []);
});

/* ---------- scenario: unanswered introduction retries, then gives up ---------- */

check('unanswered intro retries with backoff and stops at the attempt cap', () => {
  const clock2 = { now: 1_000 };
  const d = new FakePeer('pid-d', 'devD', [], clock2);
  const e = new FakePeer('pid-e', 'devE', [], clock2);
  e.answering = false; // E's answers never make it back

  exchange([d, e]);
  clock2.now += INTRO_DELAY_MS + 500;
  d.manager.tick();
  assert.deepEqual(d.initiated, ['pid-e'], 'first attempt');

  clock2.now += RETRY_MS + 500;
  d.manager.tick();
  assert.equal(d.initiated.length, 2, 'second attempt after RETRY_MS');
  assert.deepEqual(d.resets, ['pid-e'], 'stale half-open connection was reset');

  clock2.now += RETRY_MS + 500;
  d.manager.tick();
  assert.equal(d.initiated.length, 3, 'third attempt');

  clock2.now += RETRY_MS + 500;
  d.manager.tick();
  clock2.now += RETRY_MS + 500;
  d.manager.tick();
  assert.equal(d.initiated.length, 3, 'no attempts past MAX_ATTEMPTS');
});

/* ---------- scenario: disconnected peers are forgotten ---------- */

check('a peer whose awareness state vanished is forgotten', () => {
  const clock3 = { now: 1_000 };
  const f = new FakePeer('pid-f', 'devF', [], clock3);
  const g = new FakePeer('pid-g', 'devG', [], clock3);
  exchange([f, g]);
  f.manager.applyRemote([]); // G disconnected: awareness dropped its state
  clock3.now += INTRO_DELAY_MS + 500;
  f.manager.tick();
  assert.deepEqual(f.initiated, [], 'no introduction toward a vanished peer');
});

console.info('gossip-intro test passed');
