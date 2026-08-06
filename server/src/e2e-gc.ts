/**
 * Lease GC + explicit deletion e2e (CONTRACTS.md "Relay data lifecycle"):
 *
 *  - an authenticated sync connection stamps the doc's lease
 *  - authenticated blob access (GET) renews a stale lease
 *  - DELETE /api/docs/:docId: 401 without token, 403 for ro/garbage tokens,
 *    204 for rw; removes doc state + token record + blobs; idempotent
 *  - globally deduped blob files survive while another doc references them
 *  - the sweep deletes only docs whose lease is older than the retention
 *    window, and stamps pre-lease-column docs (NULL) instead of deleting
 *    them — the fresh-deploy safety
 *  - after deletion the old tokens no longer authenticate (no create payload)
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdtemp, rm } from "node:fs/promises";
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
const BetterSqlite3 = require("better-sqlite3");

const WAIT_TIMEOUT_MS = 8_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

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

function createToken(rwToken: string, roToken: string): string {
  return JSON.stringify({
    t: rwToken,
    create: { rwHash: sha256Hex(rwToken), roHash: sha256Hex(roToken) },
  });
}

interface SyncClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  synced: Promise<void>;
}

function connect(url: string, docId: string, token: string): SyncClient {
  const doc = new Y.Doc();
  let resolveSynced!: () => void;
  let rejectSynced!: (error: Error) => void;
  let settled = false;
  let timeout: NodeJS.Timeout;
  const synced = new Promise<void>((resolve, reject) => {
    resolveSynced = resolve;
    rejectSynced = reject;
    timeout = setTimeout(() => {
      reject(new Error(`Timed out syncing ${docId}`));
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

function destroy(client: SyncClient): void {
  client.provider.destroy();
  client.doc.destroy();
}

async function main(): Promise<void> {
  const docA = "DocGcAaaa1"; // explicitly deleted via the endpoint
  const docB = "DocGcBbbb1"; // goes stale, swept
  const docC = "DocGcCccc1"; // pre-lease-column row (NULL), must be stamped
  const docD = "DocGcDddd1"; // stays fresh, must survive the sweep
  const tokens = {
    [docA]: { rw: "RwGcTokenAaaaaa1", ro: "RoGcTokenAaaaaa1" },
    [docB]: { rw: "RwGcTokenBbbbbb1", ro: "RoGcTokenBbbbbb1" },
    [docC]: { rw: "RwGcTokenCccccc1", ro: "RoGcTokenCccccc1" },
    [docD]: { rw: "RwGcTokenDddddd1", ro: "RoGcTokenDddddd1" },
  } as const;

  const dataDir = await mkdtemp(join(tmpdir(), "inventory-e2e-gc-"));
  const running = await startInventoryServer({
    dataDir,
    port: 0,
    quiet: true,
    handleSignals: false,
    retentionDays: RETENTION_DAYS,
    staticDir: join(dataDir, "missing-static"),
  });
  const wsUrl = `ws://127.0.0.1:${running.port}/sync`;
  const httpUrl = `http://127.0.0.1:${running.port}`;
  const { metadata } = running;

  const blobPath = (hash: string) => join(dataDir, "blobs", hash.slice(0, 2), hash);
  const putBlob = async (docId: string, body: Buffer): Promise<string> => {
    const hash = sha256Hex(body);
    const res = await fetch(`${httpUrl}/api/blobs/${docId}/${hash}`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-token": tokens[docId as keyof typeof tokens].rw,
      },
      body,
    });
    assert.equal(res.status, 204);
    return hash;
  };
  const deleteDoc = (docId: string, token?: string) =>
    fetch(`${httpUrl}/api/docs/${docId}`, {
      method: "DELETE",
      headers: token ? { "x-token": token } : {},
    });

  try {
    /* -- create four docs over sync; each connect stamps the lease -- */

    for (const docId of [docA, docB, docC, docD]) {
      const t = tokens[docId as keyof typeof tokens];
      const client = connect(wsUrl, docId, createToken(t.rw, t.ro));
      client.doc.getMap<unknown>("meta").set("name", `gc test ${docId}`);
      await client.synced;
      destroy(client);
    }
    await expect("authenticated sync connections stamp the lease", () => {
      for (const docId of [docA, docB, docC, docD]) {
        const lease = metadata.getLease(docId);
        assert.ok(lease !== null && Date.now() - lease < 60_000);
      }
    });

    /* -- blobs: one shared between A and B (dedupe), one only on B -- */

    const sharedBytes = randomBytes(4096);
    const onlyBBytes = randomBytes(4096);
    const sharedHash = await putBlob(docA, sharedBytes);
    assert.equal(await putBlob(docB, sharedBytes), sharedHash);
    const onlyBHash = await putBlob(docB, onlyBBytes);

    /* -- blob access renews a stale lease -- */

    await expect("an authenticated blob GET renews a stale lease", async () => {
      const stale = Date.now() - 10 * DAY_MS;
      metadata.setLease(docB, stale);
      const res = await fetch(`${httpUrl}/api/blobs/${docB}/${onlyBHash}`, {
        headers: { "x-token": tokens[docB].ro },
      });
      assert.equal(res.status, 200);
      const lease = metadata.getLease(docB);
      assert.ok(lease !== null && lease > stale);
    });

    /* -- explicit DELETE endpoint -- */

    await expect("DELETE without a token is 401", async () => {
      assert.equal((await deleteDoc(docA)).status, 401);
    });
    await expect("DELETE with the ro token is 403", async () => {
      assert.equal((await deleteDoc(docA, tokens[docA].ro)).status, 403);
    });
    await expect("DELETE with a garbage token is 403", async () => {
      assert.equal((await deleteDoc(docA, "NotAToken1111111")).status, 403);
    });
    await expect("DELETE with the rw token is 204", async () => {
      assert.equal((await deleteDoc(docA, tokens[docA].rw)).status, 204);
    });
    await expect("deleted doc: token record and lease are gone", () => {
      assert.equal(metadata.getDocMeta(docA), null);
      assert.equal(metadata.getLease(docA), null);
    });
    await expect("deleted doc: old rw token no longer authenticates", async () => {
      await assert.rejects(async () => {
        const client = connect(wsUrl, docA, JSON.stringify({ t: tokens[docA].rw }));
        try {
          await client.synced;
        } finally {
          destroy(client);
        }
      }, /Authentication failed/);
    });
    await expect("shared blob file survives (doc B still references it)", async () => {
      assert.equal(metadata.blobReferenceCount(sharedHash), 1);
      await access(blobPath(sharedHash));
    });
    await expect("DELETE is idempotent (repeat and unknown doc are 204)", async () => {
      assert.equal((await deleteDoc(docA, tokens[docA].rw)).status, 204);
      assert.equal((await deleteDoc("NoSuchDoc1", "AnyTokenAtAll111")).status, 204);
    });

    /* -- sweep: stale deleted, NULL stamped, fresh untouched -- */

    // Simulate a doc row from before the lease column existed.
    const db = new BetterSqlite3(join(dataDir, "docs.sqlite"));
    db.prepare("UPDATE doc_meta SET last_access_at = NULL WHERE doc_id = ?").run(docC);
    db.close();

    metadata.setLease(docB, Date.now() - (RETENTION_DAYS + 5) * DAY_MS);
    const sweep1 = await running.sweep();
    await expect("sweep deletes only the stale doc", () => {
      assert.equal(sweep1.docsDeleted, 1);
      assert.equal(metadata.getDocMeta(docB), null);
      assert.notEqual(metadata.getDocMeta(docD), null);
    });
    await expect("sweep deletes the stale doc's now-unreferenced blobs", async () => {
      assert.equal(sweep1.blobsDeleted, 2);
      await assert.rejects(access(blobPath(sharedHash)));
      await assert.rejects(access(blobPath(onlyBHash)));
    });
    await expect("sweep stamps pre-lease docs instead of deleting them", () => {
      assert.equal(sweep1.stamped, 1);
      const lease = metadata.getLease(docC);
      assert.ok(lease !== null && Date.now() - lease < 60_000);
      assert.notEqual(metadata.getDocMeta(docC), null);
    });
    await expect("a second sweep right away deletes nothing", async () => {
      const sweep2 = await running.sweep();
      assert.equal(sweep2.docsDeleted, 0);
      assert.equal(sweep2.stamped, 0);
      assert.notEqual(metadata.getDocMeta(docC), null);
      assert.notEqual(metadata.getDocMeta(docD), null);
    });

    console.info("e2e gc test passed");
  } finally {
    await running.close().catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
