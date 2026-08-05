/**
 * Multi-relay replication + signaling proof, mirroring the app's relay-set
 * behavior (app/src/store/relays.ts + docs.ts):
 *
 *  - a doc is created on relay 1 via the create-handshake
 *  - the SAME client then connects the SAME outer doc to relay 2, again with
 *    the create payload: relay 2 registers the doc under the same token
 *    hashes and receives the full encrypted state (replication is just
 *    "connect everywhere"; relays never talk to each other)
 *  - relay 1 is killed; a FRESH client knowing both relay URLs still gets the
 *    full decrypted content from relay 2
 *  - encrypted photo blobs uploaded to both relays stay fetchable from
 *    relay 2 alone
 *  - the y-webrtc signaling endpoint (/signal) relays subscribe/publish
 *    messages between two peers on the same topic, answers ping, and does
 *    not leak messages across topics
 *
 * The WebRTC DATA path (actual peer connection) is not exercised here — wrtc
 * in Node is not worth the pain; it needs live verification on two devices.
 */
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import * as Y from "yjs";

import { sha256Hex } from "./auth.js";
import { startInventoryServer, type RunningInventoryServer } from "./index.js";

const require = createRequire(import.meta.url);
const WebSocketPolyfill = require("ws");
const WebSocket = WebSocketPolyfill as typeof import("ws").WebSocket;

const WAIT_TIMEOUT_MS = 8_000;
const ENC_LOG_NAME = "enc:log";
const IV_BYTES = 12;

/* ---------- helpers (same shape as e2e-encrypted.ts) ---------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expect(
  label: string,
  assertion: () => void | Promise<void>,
): Promise<void> {
  try {
    await assertion();
    console.info(`ok - ${label}`);
  } catch (error) {
    console.error(`FAIL - ${label}`);
    throw error;
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/* ---------- minimal encrypted client (mirrors app e2ee pipeline) ---------- */

interface EncLogEntry {
  v: 1;
  dev: string;
  seq: number;
  snap?: boolean;
  iv: Uint8Array;
  ct: Uint8Array;
}

const REMOTE_ORIGIN = Symbol("e2ee-remote");
const LOG_ORIGIN = Symbol("e2ee-log");

async function encryptUpdate(
  key: CryptoKey,
  docId: string,
  update: Uint8Array,
): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = new Uint8Array(randomBytes(IV_BYTES));
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(docId) },
    key,
    toArrayBuffer(update),
  );
  return { iv, ct: new Uint8Array(ct) };
}

async function decryptUpdate(
  key: CryptoKey,
  docId: string,
  entry: EncLogEntry,
): Promise<Uint8Array> {
  const pt = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(entry.iv),
      additionalData: new TextEncoder().encode(docId),
    },
    key,
    toArrayBuffer(entry.ct),
  );
  return new Uint8Array(pt);
}

/** Encrypted client whose OUTER doc can be connected to SEVERAL relays. */
class MultiRelayEncClient {
  readonly inner = new Y.Doc();
  readonly outer = new Y.Doc();
  readonly shadow = new Y.Doc();
  readonly providers: HocuspocusProvider[] = [];

  private readonly applied = new Set<string>();
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dev: string,
    private readonly docId: string,
    private readonly key: CryptoKey,
  ) {
    this.inner.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      const copy = new Uint8Array(update);
      this.enqueue(() => this.append(copy));
    });
    this.log().observe(() => {
      this.enqueue(() => this.scan());
    });
  }

  /** Attach one more relay to the same outer doc (the app's multi-provider). */
  connect(url: string, token: string): Promise<void> {
    let resolveSynced!: () => void;
    let rejectSynced!: (error: Error) => void;
    let settled = false;
    let timeout: NodeJS.Timeout;
    const synced = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
      timeout = setTimeout(() => {
        reject(new Error(`Timed out syncing ${this.docId} (${this.dev}) via ${url}`));
      }, WAIT_TIMEOUT_MS);
    }).finally(() => clearTimeout(timeout));

    const provider = new HocuspocusProvider({
      url,
      name: this.docId,
      document: this.outer,
      token,
      WebSocketPolyfill,
      maxAttempts: 1,
      timeout: WAIT_TIMEOUT_MS,
      onSynced: ({ state }) => {
        if (!state) return;
        this.enqueue(async () => {
          await this.scan();
          await this.reconcile();
        });
        if (!settled) {
          settled = true;
          resolveSynced();
        }
      },
      onAuthenticationFailed: ({ reason }) => {
        if (!settled) {
          settled = true;
          rejectSynced(new Error(`Authentication failed via ${url}: ${reason}`));
        }
      },
    } as HocuspocusProviderConfiguration & {
      WebSocketPolyfill: typeof WebSocketPolyfill;
      maxAttempts: number;
      timeout: number;
    });
    this.providers.push(provider);
    return synced;
  }

  private log(): Y.Array<EncLogEntry> {
    return this.outer.getArray<EncLogEntry>(ENC_LOG_NAME);
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((error: unknown) => {
      console.error(`[${this.dev}] pipeline error`, error);
      process.exitCode = 1;
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private entryId(entry: EncLogEntry): string {
    return `${entry.dev}:${entry.seq}`;
  }

  private async scan(): Promise<void> {
    for (const entry of this.log().toArray()) {
      const id = this.entryId(entry);
      if (this.applied.has(id)) continue;
      const update = await decryptUpdate(this.key, this.docId, entry);
      Y.applyUpdate(this.shadow, update);
      Y.applyUpdate(this.inner, update, REMOTE_ORIGIN);
      this.applied.add(id);
    }
  }

  private async reconcile(): Promise<void> {
    const diff = Y.encodeStateAsUpdate(this.inner, Y.encodeStateVector(this.shadow));
    if (diff.length <= 2) return;
    await this.append(diff);
  }

  private async append(update: Uint8Array): Promise<void> {
    if (update.length <= 2) return;
    const { iv, ct } = await encryptUpdate(this.key, this.docId, update);
    const entry: EncLogEntry = { v: 1, dev: this.dev, seq: ++this.seq, iv, ct };
    this.applied.add(this.entryId(entry));
    Y.applyUpdate(this.shadow, update);
    this.outer.transact(() => {
      this.log().push([entry]);
    }, LOG_ORIGIN);
  }

  destroy(): void {
    for (const provider of this.providers) provider.destroy();
    this.inner.destroy();
    this.outer.destroy();
    this.shadow.destroy();
  }
}

/* ---------- y-webrtc signaling protocol client ---------- */

interface SignalPeer {
  ws: InstanceType<typeof WebSocket>;
  received: Array<Record<string, unknown>>;
  send(message: object): void;
  close(): void;
}

function connectSignal(url: string): Promise<SignalPeer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const peer: SignalPeer = {
      ws,
      received: [],
      send(message) {
        ws.send(JSON.stringify(message));
      },
      close() {
        ws.close();
      },
    };
    const timeout = setTimeout(
      () => reject(new Error(`Timed out connecting to ${url}`)),
      WAIT_TIMEOUT_MS,
    );
    ws.on("open", () => {
      clearTimeout(timeout);
      resolve(peer);
    });
    ws.on("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    ws.on("message", (raw: Buffer) => {
      try {
        peer.received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    });
  });
}

/* ---------- main ---------- */

function createToken(rwToken: string, roToken: string): string {
  return JSON.stringify({
    t: rwToken,
    create: { rwHash: sha256Hex(rwToken), roHash: sha256Hex(roToken) },
  });
}

async function startRelay(dataDir: string): Promise<RunningInventoryServer> {
  return startInventoryServer({
    dataDir,
    port: 0,
    quiet: true,
    handleSignals: false,
    staticDir: join(dataDir, "missing-static"),
  });
}

async function main(): Promise<void> {
  // Dead relays make Hocuspocus providers surface WebSocket ErrorEvents as
  // unhandled rejections in Node (the browser provider just retries). Killing
  // a relay mid-test is the point here, so ignore those — real Errors stay fatal.
  process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error) throw reason;
    console.info("(ignored websocket error event from a dead relay)");
  });

  const docId = "DocMultiRelay1";
  const rwToken = "RwMultiTok111111";
  const roToken = "RoMultiTok111111";
  const rawKey = randomBytes(32);
  const key = await webcrypto.subtle.importKey(
    "raw",
    toArrayBuffer(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const dir1 = await mkdtemp(join(tmpdir(), "inventory-relay1-"));
  const dir2 = await mkdtemp(join(tmpdir(), "inventory-relay2-"));
  const relay1 = await startRelay(dir1);
  const relay2 = await startRelay(dir2);
  const ws1 = `ws://127.0.0.1:${relay1.port}/sync`;
  const ws2 = `ws://127.0.0.1:${relay2.port}/sync`;

  const clients: MultiRelayEncClient[] = [];
  const signalPeers: SignalPeer[] = [];
  let relay1Closed = false;

  try {
    /* -- create on relay 1, write content -- */

    const writer = new MultiRelayEncClient("devW", docId, key);
    clients.push(writer);
    await writer.connect(ws1, createToken(rwToken, roToken));
    writer.inner.transact(() => {
      const meta = writer.inner.getMap<unknown>("meta");
      meta.set("id", docId);
      meta.set("name", "Multi-relay inventory");
      const items = writer.inner.getMap<Y.Map<unknown>>("items");
      const item = new Y.Map<unknown>();
      item.set("id", "ItemMulti1");
      item.set("description", "Replicated cordless drill");
      items.set("ItemMulti1", item);
    });
    await writer.flush();

    /* -- replicate: connect the SAME outer doc to relay 2 with the create
          payload; relay 2 registers the doc and pulls the encrypted state -- */

    await expect("rw client registers the doc on relay 2 (create-handshake)", async () => {
      await writer.connect(ws2, createToken(rwToken, roToken));
      assert.notEqual(relay2.metadata.getDocMeta(docId), null);
    });

    /* -- blob replication: upload the same encrypted blob to both relays -- */

    const blob = randomBytes(4096);
    const blobHash = sha256Hex(blob);
    for (const relay of [relay1, relay2]) {
      const res = await fetch(
        `http://127.0.0.1:${relay.port}/api/blobs/${docId}/${blobHash}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-token": rwToken,
          },
          body: blob,
        },
      );
      assert.equal(res.status, 204);
    }

    // Let relay 2's SQLite extension persist the replicated doc, then take
    // the replicating device offline before relay 1 dies.
    await delay(2_500);
    writer.destroy();
    clients.pop();

    /* -- kill relay 1 -- */

    await relay1.close();
    relay1Closed = true;

    /* -- a fresh client with both relay URLs still syncs (from relay 2) -- */

    await expect(
      "fresh client syncs full content from relay 2 after relay 1 died",
      async () => {
        const reader = new MultiRelayEncClient("devR", docId, key);
        clients.push(reader);
        // The app tries every relay in the handle; relay 1 fails, relay 2 works.
        const viaDead = reader
          .connect(ws1, JSON.stringify({ t: rwToken }))
          .catch(() => "dead");
        await reader.connect(ws2, JSON.stringify({ t: rwToken }));
        await viaDead;
        await waitFor(
          () => reader.inner.getMap("items").size === 1,
          "decrypted item on the fresh client",
        );
        const item = reader.inner.getMap<Y.Map<unknown>>("items").get("ItemMulti1");
        assert.equal(item?.get("description"), "Replicated cordless drill");
        assert.equal(reader.inner.getMap("meta").get("name"), "Multi-relay inventory");
      },
    );

    await expect("blob still downloads from relay 2 alone", async () => {
      const res = await fetch(
        `http://127.0.0.1:${relay2.port}/api/blobs/${docId}/${blobHash}`,
        { headers: { "x-token": roToken } },
      );
      assert.equal(res.status, 200);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), blob);
    });

    /* -- signaling endpoint: y-webrtc pub/sub protocol -- */

    const signalUrl = `ws://127.0.0.1:${relay2.port}/signal`;
    const topic = "hmac-derived-room-name-abc";

    await expect("signaling: publish reaches all subscribers of the topic", async () => {
      const a = await connectSignal(signalUrl);
      const b = await connectSignal(signalUrl);
      const c = await connectSignal(signalUrl);
      signalPeers.push(a, b, c);
      a.send({ type: "subscribe", topics: [topic] });
      b.send({ type: "subscribe", topics: [topic] });
      c.send({ type: "subscribe", topics: ["some-other-room"] });
      await delay(150);
      a.send({ type: "publish", topic, data: "encrypted-sdp-offer" });
      await waitFor(
        () => b.received.some((m) => m.type === "publish" && m.topic === topic),
        "publish delivered to peer B",
      );
      const delivered = b.received.find((m) => m.type === "publish")!;
      assert.equal(delivered.data, "encrypted-sdp-offer");
      assert.equal(delivered.clients, 2); // both subscribers of the topic
      // Publisher is itself subscribed, so it receives its own message too
      // (y-webrtc filters by `from` client-side); peer C must NOT see it.
      assert.equal(c.received.some((m) => m.type === "publish"), false);
    });

    await expect("signaling: ping is answered with pong", async () => {
      const a = signalPeers[0];
      a.send({ type: "ping" });
      await waitFor(
        () => a.received.some((m) => m.type === "pong"),
        "pong reply",
      );
    });

    await expect("signaling: unsubscribe stops delivery and empty rooms are dropped", async () => {
      const [a, b] = signalPeers;
      b.send({ type: "unsubscribe", topics: [topic] });
      await delay(150);
      const before = b.received.length;
      a.send({ type: "publish", topic, data: "after-unsubscribe" });
      await delay(250);
      assert.equal(b.received.length, before);
      a.send({ type: "unsubscribe", topics: [topic] });
      await waitFor(
        () => relay2.signaling.topicCount === 1, // only C's other room remains
        `empty topics dropped (have ${relay2.signaling.topicCount})`,
      );
    });

    console.info("e2e multi-relay test passed");
  } finally {
    for (const peer of signalPeers) peer.close();
    for (const client of clients.reverse()) {
      try {
        client.destroy();
      } catch { /* already destroyed */ }
    }
    if (!relay1Closed) await relay1.close().catch(() => {});
    await relay2.close().catch(() => {});
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
