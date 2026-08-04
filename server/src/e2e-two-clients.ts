import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
import { startInventoryServer } from "./index.js";

const require = createRequire(import.meta.url);
const WebSocketPolyfill = require("ws");

const WAIT_TIMEOUT_MS = 5_000;
const READONLY_SETTLE_MS = 750;

interface TestClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  synced: Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    if (predicate()) {
      return;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function expectStatus(
  responsePromise: Promise<Response>,
  expected: number,
  label: string,
): Promise<Response> {
  const response = await responsePromise;
  await expect(label, () => {
    assert.equal(
      response.status,
      expected,
      `expected ${expected}, received ${response.status}`,
    );
  });
  return response;
}

function makeItem(fields: Record<string, unknown>): Y.Map<unknown> {
  const item = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) {
    item.set(key, value);
  }
  return item;
}

function connectClient(
  url: string,
  docId: string,
  token: string,
): TestClient {
  const doc = new Y.Doc({ guid: docId });
  let resolveSynced!: () => void;
  let rejectSynced!: (error: Error) => void;
  let syncSettled = false;
  let timeout: NodeJS.Timeout;

  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
    timeout = setTimeout(() => {
      reject(new Error(`Timed out syncing ${docId}`));
    }, WAIT_TIMEOUT_MS);
  }).finally(() => {
    clearTimeout(timeout);
  });

  const provider = new HocuspocusProvider({
    url,
    name: docId,
    document: doc,
    token,
    WebSocketPolyfill,
    maxAttempts: 1,
    timeout: WAIT_TIMEOUT_MS,
    onSynced: ({ state }) => {
      if (state && !syncSettled) {
        syncSettled = true;
        resolveSynced();
      }
    },
    onAuthenticationFailed: ({ reason }) => {
      if (!syncSettled) {
        syncSettled = true;
        rejectSynced(new Error(`Authentication failed: ${reason}`));
      }
    },
    onClose: ({ event }) => {
      if (!syncSettled) {
        syncSettled = true;
        rejectSynced(
          new Error(`Connection closed before sync (${event.code})`),
        );
      }
    },
  } as HocuspocusProviderConfiguration & {
    WebSocketPolyfill: typeof WebSocketPolyfill;
    maxAttempts: number;
    timeout: number;
  });

  return { doc, provider, synced };
}

async function expectBadTokenRejected(
  url: string,
  docId: string,
  token: string,
): Promise<void> {
  const doc = new Y.Doc({ guid: docId });
  let provider: HocuspocusProvider | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Bad-token connection was not rejected"));
      }, WAIT_TIMEOUT_MS);
      const rejected = () => {
        clearTimeout(timeout);
        resolve();
      };

      provider = new HocuspocusProvider({
        url,
        name: docId,
        document: doc,
        token,
        WebSocketPolyfill,
        maxAttempts: 1,
        timeout: WAIT_TIMEOUT_MS,
        onAuthenticationFailed: rejected,
        onClose: rejected,
      } as HocuspocusProviderConfiguration & {
        WebSocketPolyfill: typeof WebSocketPolyfill;
        maxAttempts: number;
        timeout: number;
      });
    });
  } finally {
    provider?.destroy();
    doc.destroy();
  }
}

async function main(): Promise<void> {
  const docId = "DocE2E1111";
  const rwToken = "RwE2EToken111111";
  const roToken = "RoE2EToken111111";
  const badToken = "BadE2EToken11111";
  const createToken = JSON.stringify({
    t: rwToken,
    create: {
      rwHash: sha256Hex(rwToken),
      roHash: sha256Hex(roToken),
    },
  });
  const normalRwToken = JSON.stringify({ t: rwToken });
  const normalRoToken = JSON.stringify({ t: roToken });
  const clients: TestClient[] = [];
  const dataDir = await mkdtemp(join(tmpdir(), "inventory-e2e-"));
  const running = await startInventoryServer({
    dataDir,
    port: 0,
    quiet: true,
    handleSignals: false,
    staticDir: join(dataDir, "missing-static"),
  });
  const wsUrl = `ws://127.0.0.1:${running.port}/sync`;
  const httpUrl = `http://127.0.0.1:${running.port}`;

  try {
    const clientA = connectClient(wsUrl, docId, createToken);
    clients.push(clientA);

    const meta = clientA.doc.getMap<unknown>("meta");
    const itemsA = clientA.doc.getMap<Y.Map<unknown>>("items");
    clientA.doc.transact(() => {
      meta.set("id", docId);
      meta.set("name", "E2E Inventory");
      meta.set("description", "two-client sync fixture");
      meta.set("createdAt", 1_753_000_000_000);
      meta.set("ownerTrackingEnabled", true);
      meta.set("currency", "EUR");
      itemsA.set(
        "ItemE2E111",
        makeItem({
          id: "ItemE2E111",
          createdAt: 1_753_000_000_100,
          updatedAt: 1_753_000_000_100,
          description: "Cordless drill",
          category: "Tools",
          tags: ["power-tool", "garage"],
          quantity: 1,
          photos: [],
          locationHistory: [{ time: 1_753_000_000_100, label: "Garage" }],
          ownerHistory: [{ time: 1_753_000_000_100, owner: "Alice" }],
          weight: { class: "kg1_2", exactGrams: 1_450 },
          dimensions: {
            class: "shoebox",
            exactMm: { l: 260, w: 220, h: 90 },
          },
          serialNumber: "DRILL-001",
        }),
      );
      itemsA.set(
        "ItemE2E222",
        makeItem({
          id: "ItemE2E222",
          createdAt: 1_753_000_000_200,
          updatedAt: 1_753_000_000_200,
          description: "Travel adapter",
          tags: ["travel"],
          quantity: 2,
          photos: [],
          locationHistory: [],
          ownerHistory: [],
          weight: { class: "g50_200", exactGrams: 125 },
          dimensions: { class: "pocket" },
          countryOfOrigin: "CN",
        }),
      );
    });
    await expect("client A creates and syncs inventory", async () => {
      await clientA.synced;
      assert.equal(clientA.provider.authorizedScope, "read-write");
    });

    const clientB = connectClient(wsUrl, docId, normalRwToken);
    clients.push(clientB);
    await expect("client B syncs with normal rw token", async () => {
      await clientB.synced;
      assert.equal(clientB.provider.authorizedScope, "read-write");
    });
    await expect("client B receives meta and both item values", async () => {
      await waitFor(
        () => clientB.doc.getMap("items").size === 2,
        "both items on client B",
      );
      assert.deepEqual(
        {
          meta: clientB.doc.getMap("meta").toJSON(),
          item1: (
            clientB.doc
              .getMap<Y.Map<unknown>>("items")
              .get("ItemE2E111") as Y.Map<unknown>
          ).toJSON(),
          item2: (
            clientB.doc
              .getMap<Y.Map<unknown>>("items")
              .get("ItemE2E222") as Y.Map<unknown>
          ).toJSON(),
        },
        {
          meta: meta.toJSON(),
          item1: itemsA.get("ItemE2E111")?.toJSON(),
          item2: itemsA.get("ItemE2E222")?.toJSON(),
        },
      );
    });

    const clientC = connectClient(wsUrl, docId, normalRoToken);
    clients.push(clientC);
    await expect("client C receives inventory with readonly scope", async () => {
      await clientC.synced;
      await waitFor(
        () => clientC.doc.getMap("items").size === 2,
        "both items on client C",
      );
      const itemsC = clientC.doc.getMap<Y.Map<unknown>>("items");
      assert.deepEqual(
        {
          scope: clientC.provider.authorizedScope,
          meta: clientC.doc.getMap("meta").toJSON(),
          item1: itemsC.get("ItemE2E111")?.toJSON(),
          item2: itemsC.get("ItemE2E222")?.toJSON(),
        },
        {
          scope: "readonly",
          meta: meta.toJSON(),
          item1: itemsA.get("ItemE2E111")?.toJSON(),
          item2: itemsA.get("ItemE2E222")?.toJSON(),
        },
      );
    });

    clientC.doc
      .getMap<Y.Map<unknown>>("items")
      .set(
        "Readonly11",
        makeItem({ id: "Readonly11", description: "must not propagate" }),
      );
    await delay(READONLY_SETTLE_MS);
    await expect("readonly client C write never reaches client A", () => {
      assert.equal(itemsA.has("Readonly11"), false);
    });

    const clientD = connectClient(wsUrl, docId, normalRwToken);
    clients.push(clientD);
    await expect("fresh client D confirms readonly write was not stored", async () => {
      await clientD.synced;
      await delay(READONLY_SETTLE_MS);
      assert.equal(
        clientD.doc.getMap<Y.Map<unknown>>("items").has("Readonly11"),
        false,
      );
    });

    await expect("bad token connection is rejected", () =>
      expectBadTokenRejected(
        wsUrl,
        docId,
        JSON.stringify({ t: badToken }),
      ),
    );

    const blob = randomBytes(3 * 1024 * 1024 + 113);
    const blobHash = sha256Hex(blob);
    const blobUrl = `${httpUrl}/api/blobs/${docId}/${blobHash}`;
    await expectStatus(
      fetch(blobUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-token": rwToken,
        },
        body: blob,
      }),
      204,
      "rw token uploads 3 MB blob",
    );
    const blobResponse = await expectStatus(
      fetch(blobUrl, { headers: { "x-token": roToken } }),
      200,
      "ro token downloads blob",
    );
    await expect("downloaded blob bytes match upload", async () => {
      assert.deepEqual(Buffer.from(await blobResponse.arrayBuffer()), blob);
    });
    await expectStatus(
      fetch(`${httpUrl}/api/blobs/${docId}/${"0".repeat(64)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-token": rwToken,
        },
        body: blob,
      }),
      400,
      "wrong blob hash is rejected",
    );
    await expectStatus(
      fetch(blobUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-token": roToken,
        },
        body: blob,
      }),
      403,
      "readonly token cannot upload blob",
    );
    await expectStatus(
      fetch(
        `${httpUrl}/api/blobs/${docId}/${sha256Hex(randomBytes(32))}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-token": rwToken,
          },
          body: randomBytes(11 * 1024 * 1024),
        },
      ),
      413,
      "11 MB blob is rejected",
    );

    const itemA = itemsA.get("ItemE2E111");
    const itemB = clientB.doc
      .getMap<Y.Map<unknown>>("items")
      .get("ItemE2E111");
    await expect("shared item is available to both rw clients", () => {
      assert(itemA && itemB);
    });
    if (!itemA || !itemB) {
      throw new Error("Expected shared item on both rw clients");
    }
    itemA.set("category", "Workshop tools");
    itemB.set("notes", "Edited concurrently by client B");
    await expect("concurrent edits merge on client A", async () => {
      await waitFor(
        () =>
          itemA.get("category") === "Workshop tools" &&
          itemA.get("notes") === "Edited concurrently by client B",
        "both concurrent fields on client A",
      );
      assert.deepEqual(
        {
          category: itemA.get("category"),
          notes: itemA.get("notes"),
        },
        {
          category: "Workshop tools",
          notes: "Edited concurrently by client B",
        },
      );
    });
    await expect("concurrent edits merge on client B", async () => {
      await waitFor(
        () =>
          itemB.get("category") === "Workshop tools" &&
          itemB.get("notes") === "Edited concurrently by client B",
        "both concurrent fields on client B",
      );
      assert.deepEqual(
        {
          category: itemB.get("category"),
          notes: itemB.get("notes"),
        },
        {
          category: "Workshop tools",
          notes: "Edited concurrently by client B",
        },
      );
    });

    console.info("e2e two-client sync passed");
  } finally {
    for (const client of clients.reverse()) {
      client.provider.destroy();
      client.doc.destroy();
    }
    await running.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
