/**
 * Live-relay integration: starts the REAL server from server/ (tsx, random
 * temp data dir), publishes an end-to-end encrypted inventory through it the
 * way the app does (create-handshake + enc:log entry), then runs the
 * connector's actual syncInventory() — the same code the popup ships — with
 * the READ-ONLY token and asserts the items materialize.
 *
 * Requires server/node_modules (npm install in server/). Node >= 22 for the
 * global WebSocket the Hocuspocus provider uses in the connector path.
 *
 * Run: cd connector && npm run test:relay
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { bytesToBase64Url, syncInventory } from './.tmp/core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(HERE, '..', '..', 'server');
const PORT = 5877;
const ORIGIN = `http://127.0.0.1:${PORT}`;

if (!existsSync(join(SERVER_DIR, 'node_modules'))) {
  console.error('server/node_modules missing — npm install in server/ first.');
  process.exit(1);
}

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');

const DOC_ID = 'DocRelayIT';
const RW_TOKEN = 'RwRelayTokenIT11';
const RO_TOKEN = 'RoRelayTokenIT11';
const rawKey = randomBytes(32);
const keyB64 = bytesToBase64Url(new Uint8Array(rawKey));

/* ---- start the real relay ---- */

const dataDir = mkdtempSync(join(tmpdir(), 'pv-connector-it-'));
const server = spawn(join(SERVER_DIR, 'node_modules', '.bin', 'tsx'), ['src/index.ts'], {
  cwd: SERVER_DIR,
  env: { ...process.env, PORT: String(PORT), INVENTORY_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${ORIGIN}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not come up');
}

/* ---- writer: publish an encrypted inventory like the app would ---- */

async function publishFixture() {
  const inner = new Y.Doc();
  inner.transact(() => {
    const meta = inner.getMap('meta');
    meta.set('id', DOC_ID);
    meta.set('name', 'Relay garage');
    const items = inner.getMap('items');
    const item = new Y.Map();
    item.set('id', 'ItemRelay1');
    item.set('description', 'Relay-synced camping stove');
    item.set('brandModel', 'Primus');
    item.set('quantity', 1);
    item.set('createdAt', 1_720_000_000_000);
    item.set('updatedAt', 1_720_000_000_000);
    item.set('photos', []);
    items.set('ItemRelay1', item);
  });
  const update = Y.encodeStateAsUpdate(inner);
  const iv = new Uint8Array(randomBytes(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(DOC_ID) },
      await crypto.subtle.importKey('raw', new Uint8Array(rawKey), { name: 'AES-GCM' }, false, [
        'encrypt',
      ]),
      update,
    ),
  );

  const outer = new Y.Doc();
  outer.getArray('enc:log').push([{ v: 1, dev: 'writer', seq: 1, iv, ct }]);

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('writer sync timeout')), 10_000);
    const provider = new HocuspocusProvider({
      url: ORIGIN.replace('http', 'ws') + '/sync',
      name: DOC_ID,
      document: outer,
      token: JSON.stringify({
        t: RW_TOKEN,
        create: { rwHash: sha256Hex(RW_TOKEN), roHash: sha256Hex(RO_TOKEN) },
      }),
      onSynced: ({ state }) => {
        if (!state) return;
        clearTimeout(timeout);
        // Give the outgoing update a beat to flush before disconnecting.
        setTimeout(() => {
          provider.destroy();
          resolve();
        }, 500);
      },
      onAuthenticationFailed: ({ reason }) => {
        clearTimeout(timeout);
        reject(new Error(`writer auth failed: ${reason}`));
      },
    });
  });
}

/* ---- the test ---- */

try {
  await waitForHealth();
  await publishFixture();

  const inv = await syncInventory(ORIGIN, {
    docId: DOC_ID,
    roToken: RO_TOKEN,
    key: keyB64,
    name: 'fallback name',
  });
  assert.equal(inv.name, 'Relay garage');
  assert.equal(inv.items.length, 1);
  assert.equal(inv.items[0].description, 'Relay-synced camping stove');
  assert.equal(inv.items[0].brandModel, 'Primus');
  assert.ok(inv.syncedAt > 0);
  console.log('  PASS  connector syncInventory pulls and decrypts through the real relay (ro token)');

  await assert.rejects(
    () => syncInventory(ORIGIN, { docId: DOC_ID, roToken: 'WrongToken111111', key: keyB64 }),
    /rejected/i,
  );
  console.log('  PASS  wrong token is rejected by the relay');

  const wrongKey = bytesToBase64Url(new Uint8Array(randomBytes(32)));
  await assert.rejects(
    () => syncInventory(ORIGIN, { docId: DOC_ID, roToken: RO_TOKEN, key: wrongKey }),
    /decrypt/i,
  );
  console.log('  PASS  wrong content key is detected (nothing decrypts)');

  console.log('\nRelay integration test passed.');
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
