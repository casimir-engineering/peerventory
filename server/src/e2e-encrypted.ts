/**
 * End-to-end encryption proof: two clients sync an E2E inventory THROUGH the
 * relay while the relay only ever stores ciphertext.
 *
 * The encrypted-sync client below mirrors app/src/store/e2ee.ts + crypto.ts
 * (outer Y.Doc with an `enc:log` Y.Array of AES-256-GCM update chunks,
 * shadow-doc reconciliation, last-writer compaction) without the browser
 * persistence layer. Keep the two in sync when the protocol changes.
 *
 * Proven here:
 *  - client B (rw) and client C (ro) decrypt client A's content via the relay
 *  - concurrent edits from two writers merge
 *  - compaction keeps the log bounded and a fresh client still gets full state
 *  - encrypted photo blobs round-trip and are opaque on disk
 *  - docs.sqlite + WAL contain a marker written to a PLAINTEXT CONTROL doc
 *    (synced by this test's own Node client — the app has no plaintext mode,
 *    but the relay is content-agnostic, which proves the assertion could see
 *    plaintext) yet NOT the marker written to the E2E doc, nor the photo
 *    marker bytes
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

const WAIT_TIMEOUT_MS = 8_000;
const ENC_LOG_NAME = "enc:log";
const COMPACT_MAX_ENTRIES = 40;
const IV_BYTES = 12;

const DOC_MARKER = "SECRET-MARKER-E2E-cordless-drill-777";
const PHOTO_MARKER = "SECRET-MARKER-PHOTO-BYTES-777";
const LEGACY_MARKER = "CONTROL-MARKER-LEGACY-PLAINTEXT-777";

/* ---------- generic helpers (same shape as e2e-two-clients.ts) ---------- */

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

/* ---------- crypto (mirrors app/src/store/crypto.ts) ---------- */

interface EncLogEntry {
  v: 1;
  dev: string;
  seq: number;
  snap?: boolean;
  iv: Uint8Array;
  ct: Uint8Array;
}

/** Copy into a plain ArrayBuffer (WebCrypto's BufferSource rejects pooled Buffers). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importAesKey(raw: Buffer): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

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

/** Deterministic photo encryption: envelope = mimeLen(u16 BE)|mime|bytes,
 *  iv = HMAC-SHA256(key, "peerventory:photo-iv:" + sha256hex(envelope))[:12],
 *  wire = iv || ct; the blob hash addresses sha256(wire). */
async function encryptPhoto(
  key: CryptoKey,
  rawKey: Buffer,
  plain: Buffer,
  mime: string,
): Promise<Buffer> {
  const mimeBytes = Buffer.from(mime, "utf8");
  const envelope = Buffer.concat([
    Buffer.from([mimeBytes.length >> 8, mimeBytes.length & 0xff]),
    mimeBytes,
    plain,
  ]);
  const envelopeHash = createHash("sha256").update(envelope).digest("hex");
  const iv = createHmac("sha256", rawKey)
    .update("peerventory:photo-iv:" + envelopeHash)
    .digest()
    .subarray(0, IV_BYTES);
  const ct = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(envelope),
  );
  return Buffer.concat([iv, Buffer.from(ct)]);
}

async function decryptPhoto(
  key: CryptoKey,
  wire: Buffer,
): Promise<{ bytes: Buffer; mime: string }> {
  const iv = wire.subarray(0, IV_BYTES);
  const ct = wire.subarray(IV_BYTES);
  const pt = Buffer.from(
    await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ct),
    ),
  );
  const mimeLen = (pt[0] << 8) | pt[1];
  return {
    mime: pt.subarray(2, 2 + mimeLen).toString("utf8"),
    bytes: pt.subarray(2 + mimeLen),
  };
}

/* ---------- encrypted-sync client (mirrors app/src/store/e2ee.ts) ---------- */

const REMOTE_ORIGIN = Symbol("e2ee-remote");
const LOG_ORIGIN = Symbol("e2ee-log");

class EncClient {
  readonly inner: Y.Doc;
  readonly outer: Y.Doc;
  readonly shadow: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly synced: Promise<void>;

  private readonly applied = new Set<string>();
  private readonly deletable = new Set<string>();
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dev: string,
    private readonly docId: string,
    private readonly key: CryptoKey,
    private readonly canWrite: boolean,
    url: string,
    token: string,
  ) {
    this.inner = new Y.Doc();
    this.outer = new Y.Doc();
    this.shadow = new Y.Doc();

    let resolveSynced!: () => void;
    let rejectSynced!: (error: Error) => void;
    let settled = false;
    let timeout: NodeJS.Timeout;
    this.synced = new Promise<void>((resolve, reject) => {
      resolveSynced = resolve;
      rejectSynced = reject;
      timeout = setTimeout(() => {
        reject(new Error(`Timed out syncing ${docId} (${dev})`));
      }, WAIT_TIMEOUT_MS);
    }).finally(() => clearTimeout(timeout));

    this.inner.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      const copy = new Uint8Array(update);
      this.enqueue(() => this.append(copy, false));
    });
    this.log().observe(() => {
      this.enqueue(() => this.scan());
    });

    this.provider = new HocuspocusProvider({
      url,
      name: docId,
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
          rejectSynced(new Error(`Authentication failed: ${reason}`));
        }
      },
    } as HocuspocusProviderConfiguration & {
      WebSocketPolyfill: typeof WebSocketPolyfill;
      maxAttempts: number;
      timeout: number;
    });
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

  /** Wait until all queued crypto/log work has drained. */
  flush(): Promise<void> {
    return this.chain;
  }

  logLength(): number {
    return this.log().length;
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
      this.deletable.add(id);
    }
  }

  private async reconcile(): Promise<void> {
    const diff = Y.encodeStateAsUpdate(
      this.inner,
      Y.encodeStateVector(this.shadow),
    );
    if (diff.length <= 2) return;
    await this.append(diff, false);
  }

  private async append(update: Uint8Array, isSnapshot: boolean): Promise<void> {
    if (!this.canWrite || update.length <= 2) return;
    const { iv, ct } = await encryptUpdate(this.key, this.docId, update);
    const entry: EncLogEntry = {
      v: 1,
      dev: this.dev,
      seq: ++this.seq,
      ...(isSnapshot ? { snap: true } : {}),
      iv,
      ct,
    };
    this.applied.add(this.entryId(entry));
    this.deletable.add(this.entryId(entry));
    Y.applyUpdate(this.shadow, update);
    this.outer.transact(() => {
      this.log().push([entry]);
    }, LOG_ORIGIN);
    if (!isSnapshot) await this.compactIfNeeded();
  }

  private async compactIfNeeded(): Promise<void> {
    const log = this.log();
    const entries = log.toArray();
    if (entries.length <= COMPACT_MAX_ENTRIES) return;
    const last = entries[entries.length - 1];
    if (!last || last.dev !== this.dev) return;

    const snapshot = Y.encodeStateAsUpdate(this.shadow);
    const { iv, ct } = await encryptUpdate(this.key, this.docId, snapshot);
    const entry: EncLogEntry = {
      v: 1,
      dev: this.dev,
      seq: ++this.seq,
      snap: true,
      iv,
      ct,
    };
    this.applied.add(this.entryId(entry));
    this.deletable.add(this.entryId(entry));
    this.outer.transact(() => {
      for (let i = log.length - 1; i >= 0; i--) {
        const e = log.get(i);
        if (e && this.deletable.has(this.entryId(e))) log.delete(i, 1);
      }
      log.push([entry]);
    }, LOG_ORIGIN);
  }

  destroy(): void {
    this.provider.destroy();
    this.inner.destroy();
    this.outer.destroy();
    this.shadow.destroy();
  }
}

/* ---------- plaintext control client ----------
 * Syncs plaintext straight through the content-agnostic relay. The app never
 * does this (it is E2E-only); the control proves the sqlite assertions would
 * catch plaintext if the encrypted pipeline ever leaked it. */

function connectLegacy(url: string, docId: string, token: string): {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  synced: Promise<void>;
} {
  const doc = new Y.Doc();
  let resolveSynced!: () => void;
  let rejectSynced!: (error: Error) => void;
  let settled = false;
  let timeout: NodeJS.Timeout;
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
    timeout = setTimeout(() => {
      reject(new Error(`Timed out syncing legacy ${docId}`));
    }, WAIT_TIMEOUT_MS);
  }).finally(() => clearTimeout(timeout));

  const provider = new HocuspocusProvider({
    url,
    name: docId,
    document: doc,
    token,
    WebSocketPolyfill,
    maxAttempts: 1,
    timeout: WAIT_TIMEOUT_MS,
    onSynced: ({ state }) => {
      if (state && !settled) {
        settled = true;
        resolveSynced();
      }
    },
    onAuthenticationFailed: ({ reason }) => {
      if (!settled) {
        settled = true;
        rejectSynced(new Error(`Authentication failed: ${reason}`));
      }
    },
  } as HocuspocusProviderConfiguration & {
    WebSocketPolyfill: typeof WebSocketPolyfill;
    maxAttempts: number;
    timeout: number;
  });
  return { doc, provider, synced };
}

/* ---------- main ---------- */

function createToken(rwToken: string, roToken: string): string {
  return JSON.stringify({
    t: rwToken,
    create: { rwHash: sha256Hex(rwToken), roHash: sha256Hex(roToken) },
  });
}

async function main(): Promise<void> {
  const docId = "DocEncE2E1";
  const rwToken = "RwEncToken111111";
  const roToken = "RoEncToken111111";
  const legacyDocId = "DocLegacy1";
  const legacyRw = "RwLegacyTok11111";
  const legacyRo = "RoLegacyTok11111";

  const rawKey = randomBytes(32);
  const key = await importAesKey(rawKey);

  const dataDir = await mkdtemp(join(tmpdir(), "inventory-e2e-enc-"));
  const running = await startInventoryServer({
    dataDir,
    port: 0,
    quiet: true,
    handleSignals: false,
    staticDir: join(dataDir, "missing-static"),
  });
  const wsUrl = `ws://127.0.0.1:${running.port}/sync`;
  const httpUrl = `http://127.0.0.1:${running.port}`;
  const clients: EncClient[] = [];
  let legacy: ReturnType<typeof connectLegacy> | null = null;

  try {
    /* -- two encrypted writers + one encrypted reader through the relay -- */

    const clientA = new EncClient(
      "devA",
      docId,
      key,
      true,
      wsUrl,
      createToken(rwToken, roToken),
    );
    clients.push(clientA);
    await clientA.synced;

    clientA.inner.transact(() => {
      const meta = clientA.inner.getMap<unknown>("meta");
      meta.set("id", docId);
      meta.set("name", "Encrypted inventory");
      meta.set("createdAt", 1_753_000_000_000);
      meta.set("currency", "EUR");
      const items = clientA.inner.getMap<Y.Map<unknown>>("items");
      const item = new Y.Map<unknown>();
      item.set("id", "ItemEnc111");
      item.set("description", DOC_MARKER);
      item.set("quantity", 1);
      items.set("ItemEnc111", item);
    });
    await clientA.flush();

    const clientB = new EncClient(
      "devB",
      docId,
      key,
      true,
      wsUrl,
      JSON.stringify({ t: rwToken }),
    );
    clients.push(clientB);
    await clientB.synced;
    await expect("client B decrypts client A's content via the relay", async () => {
      await waitFor(
        () => clientB.inner.getMap("items").size === 1,
        "encrypted item on client B",
      );
      const item = clientB.inner
        .getMap<Y.Map<unknown>>("items")
        .get("ItemEnc111");
      assert.equal(item?.get("description"), DOC_MARKER);
      assert.equal(clientB.inner.getMap("meta").get("name"), "Encrypted inventory");
    });

    const clientC = new EncClient(
      "devC",
      docId,
      key,
      false,
      wsUrl,
      JSON.stringify({ t: roToken }),
    );
    clients.push(clientC);
    await clientC.synced;
    await expect("read-only client C decrypts content (read = decrypt)", async () => {
      await waitFor(
        () => clientC.inner.getMap("items").size === 1,
        "encrypted item on client C",
      );
      assert.equal(clientC.provider.authorizedScope, "readonly");
      const item = clientC.inner
        .getMap<Y.Map<unknown>>("items")
        .get("ItemEnc111");
      assert.equal(item?.get("description"), DOC_MARKER);
    });

    /* -- concurrent writers merge -- */

    clientA.inner
      .getMap<Y.Map<unknown>>("items")
      .get("ItemEnc111")!
      .set("category", "Workshop tools");
    clientB.inner
      .getMap<Y.Map<unknown>>("items")
      .get("ItemEnc111")!
      .set("notes", "Edited concurrently by B");
    await expect("concurrent encrypted edits merge on both clients", async () => {
      const read = (client: EncClient) => {
        const item = client.inner
          .getMap<Y.Map<unknown>>("items")
          .get("ItemEnc111");
        return {
          category: item?.get("category"),
          notes: item?.get("notes"),
        };
      };
      const want = {
        category: "Workshop tools",
        notes: "Edited concurrently by B",
      };
      await waitFor(
        () =>
          JSON.stringify(read(clientA)) === JSON.stringify(want) &&
          JSON.stringify(read(clientB)) === JSON.stringify(want),
        "merged fields on A and B",
      );
      assert.deepEqual(read(clientA), want);
      assert.deepEqual(read(clientB), want);
    });

    /* -- compaction keeps the log bounded; fresh client still gets everything -- */

    for (let i = 0; i < COMPACT_MAX_ENTRIES + 10; i++) {
      clientA.inner.getMap<unknown>("meta").set("tick", i);
      await clientA.flush();
    }
    await expect("log compacts after exceeding the entry threshold", async () => {
      // ~55 appends happened; without compaction the log would exceed the
      // threshold. Entries appended after the compaction pass keep trickling
      // in, so assert "well below threshold", not "exactly one snapshot".
      await waitFor(
        () => clientA.logLength() < COMPACT_MAX_ENTRIES / 2,
        `compacted log (length ${clientA.logLength()})`,
      );
    });

    const clientD = new EncClient(
      "devD",
      docId,
      key,
      true,
      wsUrl,
      JSON.stringify({ t: rwToken }),
    );
    clients.push(clientD);
    await clientD.synced;
    await expect("fresh client D gets full state from the compacted log", async () => {
      await waitFor(
        () =>
          clientD.inner.getMap("items").size === 1 &&
          clientD.inner.getMap("meta").get("tick") === COMPACT_MAX_ENTRIES + 9,
        "full decrypted state on client D",
      );
      const item = clientD.inner
        .getMap<Y.Map<unknown>>("items")
        .get("ItemEnc111");
      assert.equal(item?.get("description"), DOC_MARKER);
      assert.equal(item?.get("notes"), "Edited concurrently by B");
    });

    /* -- encrypted photo blob round-trip -- */

    const photoPlain = Buffer.concat([
      Buffer.from(PHOTO_MARKER, "utf8"),
      randomBytes(64 * 1024),
    ]);
    const photoWire = await encryptPhoto(key, rawKey, photoPlain, "image/jpeg");
    const photoHash = sha256Hex(photoWire);
    const blobUrl = `${httpUrl}/api/blobs/${docId}/${photoHash}`;
    await expect("encrypted blob uploads under its ciphertext hash", async () => {
      const res = await fetch(blobUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-token": rwToken,
        },
        body: photoWire,
      });
      assert.equal(res.status, 204);
    });
    await expect("downloaded blob decrypts to the original photo", async () => {
      const res = await fetch(blobUrl, { headers: { "x-token": roToken } });
      assert.equal(res.status, 200);
      const wire = Buffer.from(await res.arrayBuffer());
      const { bytes, mime } = await decryptPhoto(key, wire);
      assert.equal(mime, "image/jpeg");
      assert.deepEqual(bytes, photoPlain);
    });
    await expect("stored blob file contains no plaintext photo bytes", async () => {
      const path = join(dataDir, "blobs", photoHash.slice(0, 2), photoHash);
      const stored = await readFile(path);
      assert.equal(stored.includes(PHOTO_MARKER), false);
      assert.equal(stored.includes(Buffer.from(PHOTO_MARKER, "utf8")), false);
    });

    /* -- control: a plaintext doc (non-app client) IS readable in sqlite -- */

    legacy = connectLegacy(wsUrl, legacyDocId, createToken(legacyRw, legacyRo));
    legacy.doc.getMap<unknown>("meta").set("name", LEGACY_MARKER);
    await legacy.synced;

    /* -- the relay's database never saw the encrypted doc's plaintext -- */

    // Let the SQLite extension's debounced store flush, then shut down.
    await delay(3_000);
    while (clients.length > 0) clients.pop()?.destroy();
    legacy.provider.destroy();
    legacy.doc.destroy();
    legacy = null;
    await running.close();

    const files = await readdir(dataDir);
    let persisted = Buffer.alloc(0);
    for (const file of files) {
      if (file.startsWith("docs.sqlite")) {
        persisted = Buffer.concat([
          persisted,
          await readFile(join(dataDir, file)),
        ]);
      }
    }
    await expect("sqlite bytes DO contain the plaintext control marker", () => {
      assert.equal(persisted.includes(LEGACY_MARKER), true);
    });
    await expect("sqlite bytes contain NO plaintext from the encrypted doc", () => {
      assert.equal(persisted.includes(DOC_MARKER), false);
      assert.equal(persisted.includes("Encrypted inventory"), false);
      assert.equal(persisted.includes("Workshop tools"), false);
      assert.equal(persisted.includes("Edited concurrently by B"), false);
    });

    console.info("e2e encrypted relay test passed");
  } finally {
    for (const client of clients.reverse()) {
      try {
        client.destroy();
      } catch { /* already destroyed */ }
    }
    if (legacy) {
      legacy.provider.destroy();
      legacy.doc.destroy();
    }
    await running.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
