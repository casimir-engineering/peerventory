/**
 * Signaling redundancy proof, mirroring the app's multi-relay introduction
 * (app/src/store/p2p.ts): a y-webrtc client opens ONE signaling socket per
 * relay /signal URL and announces every room on ALL of them, so two peers
 * meet as long as they share ANY reachable relay.
 *
 *  - peer A subscribes a room topic on relay 1 AND relay 2; peer B can only
 *    reach relay 2: A's announce still reaches B (introduction survives a
 *    relay neither party shares)
 *  - relay 1 dies mid-session: publishes keep flowing over relay 2
 *  - the surviving relay restarts (same port): clients reconnect and
 *    re-subscribe (what lib0's websocket client does on its automatic
 *    reconnect) and delivery resumes
 *
 * The WebRTC DATA path is not exercised here (no wrtc in Node); see the
 * two-phone manual test plan in CONTRACTS.md.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import { startInventoryServer, type RunningInventoryServer } from "./index.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").WebSocket;

const WAIT_TIMEOUT_MS = 8_000;

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

/* ---------- minimal y-webrtc signaling client (one socket per relay) ---------- */

interface SignalSocket {
  url: string;
  ws: InstanceType<typeof WebSocket>;
  received: Array<Record<string, unknown>>;
  send(message: object): void;
  isOpen(): boolean;
  close(): void;
}

function connectSignal(url: string): Promise<SignalSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const sock: SignalSocket = {
      url,
      ws,
      received: [],
      send(message) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
      },
      isOpen() {
        return ws.readyState === ws.OPEN;
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
      resolve(sock);
    });
    ws.on("error", (error: Error) => {
      clearTimeout(timeout);
      // Post-connect errors (a relay dying is the point of this test) are
      // expected; pre-connect errors fail the pending promise.
      reject(error);
    });
    ws.on("message", (raw: Buffer) => {
      try {
        sock.received.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch {
        /* ignore */
      }
    });
  });
}

/** A peer as y-webrtc behaves: one socket per relay, announces on all. */
class SignalPeer {
  sockets: SignalSocket[] = [];

  constructor(readonly name: string) {}

  async connect(urls: string[], topics: string[]): Promise<void> {
    for (const url of urls) {
      const sock = await connectSignal(url);
      sock.send({ type: "subscribe", topics });
      this.sockets.push(sock);
    }
  }

  /** publishSignalingMessage: send on EVERY connected signaling socket. */
  publish(topic: string, data: string): void {
    for (const sock of this.sockets) {
      if (sock.isOpen()) sock.send({ type: "publish", topic, data });
    }
  }

  receivedData(): string[] {
    return this.sockets.flatMap((s) =>
      s.received
        .filter((m) => m.type === "publish")
        .map((m) => String(m.data)),
    );
  }

  close(): void {
    for (const sock of this.sockets) sock.close();
    this.sockets = [];
  }
}

/* ---------- main ---------- */

async function startRelay(dataDir: string, port = 0): Promise<RunningInventoryServer> {
  return startInventoryServer({
    dataDir,
    port,
    quiet: true,
    handleSignals: false,
    staticDir: join(dataDir, "missing-static"),
  });
}

async function main(): Promise<void> {
  process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error) throw reason;
    console.info("(ignored websocket error event from a dead relay)");
  });

  const topic = "hmac-derived-room-redundancy";
  const dir1 = await mkdtemp(join(tmpdir(), "inventory-sig1-"));
  const dir2 = await mkdtemp(join(tmpdir(), "inventory-sig2-"));
  let relay1: RunningInventoryServer | null = await startRelay(dir1);
  let relay2: RunningInventoryServer | null = await startRelay(dir2);
  const signal1 = `ws://127.0.0.1:${relay1.port}/signal`;
  const signal2 = `ws://127.0.0.1:${relay2.port}/signal`;
  const relay2Port = relay2.port;

  const peerA = new SignalPeer("A");
  const peerB = new SignalPeer("B");

  try {
    /* -- A reaches both relays, B only relay 2 (e.g. relay 1 is A's LAN box) -- */

    await peerA.connect([signal1, signal2], [topic]);
    await peerB.connect([signal2], [topic]);
    await delay(150); // let subscribes settle

    await expect(
      "peers sharing only ONE relay still meet (announce on all sockets)",
      async () => {
        peerA.publish(topic, "offer-from-A");
        await waitFor(
          () => peerB.receivedData().includes("offer-from-A"),
          "A's announce delivered to B via the shared relay",
        );
        peerB.publish(topic, "answer-from-B");
        await waitFor(
          () => peerA.receivedData().includes("answer-from-B"),
          "B's answer delivered back to A",
        );
      },
    );

    /* -- relay 1 dies: the surviving relay keeps ferrying introductions -- */

    await relay1.close();
    relay1 = null;
    await delay(150);

    await expect("introduction keeps working after relay 1 died", async () => {
      peerA.publish(topic, "offer-after-relay1-death");
      await waitFor(
        () => peerB.receivedData().includes("offer-after-relay1-death"),
        "publish delivered over the surviving relay",
      );
    });

    /* -- relay 2 restarts on the same port: reconnect + resubscribe resumes
          delivery (lib0's websocket client does exactly this with backoff) -- */

    await relay2.close();
    relay2 = null;
    peerA.close();
    peerB.close();
    await delay(150);
    relay2 = await startRelay(dir2, relay2Port);

    await expect("clients reconnect + resubscribe after a relay restart", async () => {
      await peerA.connect([signal2], [topic]);
      await peerB.connect([signal2], [topic]);
      await delay(150);
      peerA.publish(topic, "offer-after-restart");
      await waitFor(
        () => peerB.receivedData().includes("offer-after-restart"),
        "publish delivered after the restart",
      );
    });

    console.info("e2e signal-redundancy test passed");
  } finally {
    peerA.close();
    peerB.close();
    if (relay1) await relay1.close().catch(() => {});
    if (relay2) await relay2.close().catch(() => {});
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
