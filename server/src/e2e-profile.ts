/**
 * Synced-profile (device group) proof: the profile doc from CONTRACTS.md
 * ("Synced profile") is just another E2E doc to the relay. Two "devices"
 * share one profile doc through the relay and their INVENTORY LISTS merge:
 *
 *  - device B joins with the profile handle and sees device A's name and
 *    inventory entries
 *  - concurrent adds from A and B merge (Y.Map keyed by inventory docId)
 *  - a `removed: true` tombstone written by B propagates to A
 *  - a fresh device C gets the full converged list
 *  - the relay's sqlite never sees profile plaintext (names, tokens, keys)
 *
 * The encrypted-sync client mirrors app/src/store/e2ee.ts the same way
 * e2e-encrypted.ts does (no compaction here: the log stays tiny). Keep in
 * sync with the app when the protocol changes.
 */
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
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
const IV_BYTES = 12;

const NAME_MARKER = "SECRET-PROFILE-NAME-Raphael-777";
const INV_MARKER = "SECRET-INV-NAME-lab-shipment-777";
const RW_MARKER = "RwSecretTok77777";

interface ProfileInvEntry {
  d: string;
  rw?: string;
  ro?: string;
  ek?: string;
  nm?: string;
  removed?: boolean;
  at: number;
}

/* ---------- helpers ---------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expect(label: string, assertion: () => void | Promise<void>): Promise<void> {
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

/* ---------- crypto (mirrors app/src/store/crypto.ts) ---------- */

interface EncLogEntry {
  v: 1;
  dev: string;
  seq: number;
  snap?: boolean;
  iv: Uint8Array;
  ct: Uint8Array;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importAesKey(raw: Buffer): Promise<CryptoKey> {
  return webcrypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
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

/* ---------- minimal encrypted profile client (mirrors profileSync.ts) ---------- */

const REMOTE_ORIGIN = Symbol("e2ee-remote");
const LOG_ORIGIN = Symbol("e2ee-log");

class ProfileClient {
  readonly inner: Y.Doc;
  readonly outer: Y.Doc;
  readonly shadow: Y.Doc;
  readonly provider: HocuspocusProvider;
  readonly synced: Promise<void>;

  private readonly applied = new Set<string>();
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dev: string,
    private readonly docId: string,
    private readonly key: CryptoKey,
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
      this.enqueue(() => this.append(copy));
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

  /* -- profile-doc schema helpers (CONTRACTS.md "Synced profile") -- */

  inventories(): Y.Map<ProfileInvEntry> {
    return this.inner.getMap<ProfileInvEntry>("inventories");
  }

  profile(): Y.Map<unknown> {
    return this.inner.getMap<unknown>("profile");
  }

  liveInventoryIds(): string[] {
    const out: string[] = [];
    this.inventories().forEach((entry, id) => {
      if (!entry?.removed) out.push(id);
    });
    return out.sort();
  }

  destroy(): void {
    this.provider.destroy();
    this.inner.destroy();
    this.outer.destroy();
    this.shadow.destroy();
  }
}

/* ---------- main ---------- */

async function main(): Promise<void> {
  const profileDocId = "DocProfile1";
  const rwToken = "RwProfileTok1111";
  const roToken = "RoProfileTok1111";

  const rawKey = randomBytes(32);
  const key = await importAesKey(rawKey);

  const dataDir = await mkdtemp(join(tmpdir(), "inventory-e2e-profile-"));
  const running = await startInventoryServer({
    dataDir,
    port: 0,
    quiet: true,
    handleSignals: false,
    staticDir: join(dataDir, "missing-static"),
  });
  const wsUrl = `ws://127.0.0.1:${running.port}/sync`;
  const clients: ProfileClient[] = [];

  try {
    /* -- device A creates the profile doc via the normal create handshake -- */

    const devA = new ProfileClient(
      "devA",
      profileDocId,
      key,
      wsUrl,
      JSON.stringify({
        t: rwToken,
        create: { rwHash: sha256Hex(rwToken), roHash: sha256Hex(roToken) },
      }),
    );
    clients.push(devA);
    await devA.synced;

    devA.inner.transact(() => {
      devA.profile().set("name", NAME_MARKER);
      devA.profile().set("ownerId", "Owner11111");
      devA.inventories().set("Inv1111111", {
        d: "Inv1111111",
        rw: RW_MARKER,
        ro: "RoSecretTok77777",
        ek: "k".repeat(43),
        nm: INV_MARKER,
        at: Date.now(),
      });
    });
    await devA.flush();

    /* -- device B joins the profile (backup import) and sees the list -- */

    const devB = new ProfileClient(
      "devB",
      profileDocId,
      key,
      wsUrl,
      JSON.stringify({ t: rwToken }),
    );
    clients.push(devB);
    await devB.synced;
    await expect("device B receives name + inventory list via the relay", async () => {
      await waitFor(
        () => devB.inventories().size === 1,
        "profile entries on device B",
      );
      assert.equal(devB.profile().get("name"), NAME_MARKER);
      assert.equal(devB.profile().get("ownerId"), "Owner11111");
      const entry = devB.inventories().get("Inv1111111");
      assert.equal(entry?.rw, RW_MARKER);
      assert.equal(entry?.nm, INV_MARKER);
    });

    /* -- concurrent adds on A and B merge (Y.Map keyed by inventory id) -- */

    devA.inventories().set("Inv2222222", { d: "Inv2222222", rw: "RwTok2222222222A", at: Date.now() });
    devB.inventories().set("Inv3333333", { d: "Inv3333333", rw: "RwTok3333333333B", at: Date.now() });
    await expect("concurrent inventory adds from two devices merge", async () => {
      const want = ["Inv1111111", "Inv2222222", "Inv3333333"];
      await waitFor(
        () =>
          JSON.stringify(devA.liveInventoryIds()) === JSON.stringify(want) &&
          JSON.stringify(devB.liveInventoryIds()) === JSON.stringify(want),
        "three live inventories on both devices",
      );
    });

    /* -- B forgets an inventory: tombstone propagates, entry stays -- */

    devB.inventories().set("Inv1111111", { d: "Inv1111111", removed: true, at: Date.now() });
    await expect("removal tombstone from B reaches A", async () => {
      await waitFor(
        () => devA.inventories().get("Inv1111111")?.removed === true,
        "tombstone on device A",
      );
      assert.deepEqual(devA.liveInventoryIds(), ["Inv2222222", "Inv3333333"]);
    });

    /* -- a fresh device C gets the converged state -- */

    const devC = new ProfileClient(
      "devC",
      profileDocId,
      key,
      wsUrl,
      JSON.stringify({ t: rwToken }),
    );
    clients.push(devC);
    await devC.synced;
    await expect("fresh device C converges to the full profile state", async () => {
      await waitFor(
        () => devC.inventories().size === 3,
        "all entries (incl. tombstone) on device C",
      );
      assert.deepEqual(devC.liveInventoryIds(), ["Inv2222222", "Inv3333333"]);
      assert.equal(devC.profile().get("name"), NAME_MARKER);
    });

    /* -- the relay's sqlite never saw profile plaintext -- */

    await delay(3_000); // let the SQLite extension's debounced store flush
    while (clients.length > 0) clients.pop()?.destroy();
    await running.close();

    const files = await readdir(dataDir);
    let persisted = Buffer.alloc(0);
    for (const file of files) {
      if (file.startsWith("docs.sqlite")) {
        persisted = Buffer.concat([persisted, await readFile(join(dataDir, file))]);
      }
    }
    await expect("sqlite bytes contain NO profile plaintext (name/tokens)", () => {
      assert.equal(persisted.length > 0, true);
      assert.equal(persisted.includes(NAME_MARKER), false);
      assert.equal(persisted.includes(INV_MARKER), false);
      assert.equal(persisted.includes(RW_MARKER), false);
    });

    console.info("e2e profile-doc test passed");
  } finally {
    for (const client of clients.reverse()) {
      try {
        client.destroy();
      } catch { /* already destroyed */ }
    }
    await running.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
