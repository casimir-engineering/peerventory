/**
 * Node-side test of the relay-independent payload formats (CONTRACTS.md
 * "Share links, backups"): device-link/backup payloads carry the account
 * relay list (`rl`), share links embed the doc's other relays (`?r=`), and
 * old payloads/links without either keep decoding exactly as before.
 * Also reports the real payload/URL/QR sizes for the CONTRACTS numbers.
 *
 * Run: npm run test:store (vite-bundles to scripts/dist, runs under node).
 */
import assert from 'node:assert/strict';

/* The modules under test live in browser-land; a Map-backed storage and a
 * minimal window are enough for the code paths exercised here. Installed
 * before the dynamic import below so module-scope initializers see them. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true });
const WRAPPER_ORIGIN = 'https://wrapper.example';
Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
Object.defineProperty(globalThis, 'location', {
  value: { origin: WRAPPER_ORIGIN, pathname: '/' },
  configurable: true,
});
(globalThis as { addEventListener?: unknown }).addEventListener ??= () => {};

function check(label: string, fn: () => void): void {
  try {
    fn();
    console.info(`ok - ${label}`);
  } catch (error) {
    console.error(`FAIL - ${label}`);
    throw error;
  }
}

function toBase64Url(json: string): string {
  return Buffer.from(json, 'utf8').toString('base64url');
}

async function main(): Promise<void> {
  const backup = await import('../src/services/backup');
  const links = await import('../src/ui/lib/links');
  const store = await import('../src/store');
  const { create: qrCreate } = await import('qrcode');

  const RELAY_B = 'https://relay-b.example';
  const RELAY_C = 'http://192.168.1.20:8787';
  // Whatever the build baked in (VITE_SERVER_ORIGIN) or the window shim.
  const DEFAULT = store.defaultRelayOrigin();

  /* ---------- device-link token / full backup carry the relay list ---------- */

  store.addRelay(RELAY_B);
  store.addRelay(RELAY_C);
  localStorage.setItem('profile:v1', JSON.stringify({ userName: 'Raph' }));

  const token = backup.encodeLinkToken();
  const decodedToken = backup.decodeBackup(token);
  check('link token carries the enabled relay origins', () => {
    assert.ok(decodedToken);
    assert.deepEqual(decodedToken.relays, [DEFAULT, RELAY_B, RELAY_C]);
    assert.ok(decodedToken.profile, 'link token still carries the profile handle');
    assert.equal(decodedToken.handles.length, 0);
  });

  const full = backup.encodeBackup();
  check('full backup carries the relay list too', () => {
    const decoded = backup.decodeBackup(full);
    assert.ok(decoded);
    assert.deepEqual(decoded.relays, [DEFAULT, RELAY_B, RELAY_C]);
  });

  const tokenUrl = links.buildBackupUrl(token);
  const qr = qrCreate(tokenUrl, { errorCorrectionLevel: 'M' });
  console.info(
    `[size] link token: payload ${token.length} B, URL ${tokenUrl.length} B, ` +
      `QR version ${qr.version} (relays included: 3)`,
  );
  check('link token stays QR-scannable off a phone screen', () => {
    // Version 12 was the pre-relay-list size; three origins cost ~2 versions.
    assert.ok(qr.version <= 15, `QR version ${qr.version} > 15`);
  });

  /* ---------- old payloads keep working (no rl / v1) ---------- */

  check('v2 payload without rl decodes with relays undefined', () => {
    const old = toBase64Url(
      JSON.stringify({ v: 2, n: 'Old', oi: 'owner00001', p: { d: 'Doc0000001', rw: 'T'.repeat(16), ek: 'k'.repeat(43) }, h: [] }),
    );
    const decoded = backup.decodeBackup(old);
    assert.ok(decoded);
    assert.equal(decoded.relays, undefined);
    assert.equal(decoded.name, 'Old');
  });
  check('v1 payload still decodes', () => {
    const v1 = toBase64Url(
      JSON.stringify({ v: 1, n: 'Ancient', h: [{ d: 'Doc0000001', rw: 'T'.repeat(16) }] }),
    );
    const decoded = backup.decodeBackup(v1);
    assert.ok(decoded);
    assert.equal(decoded.handles.length, 1);
    assert.equal(decoded.relays, undefined);
  });

  /* ---------- importing a payload adds its relays to the device set ---------- */

  check('importBackup adds the payload relays to the relay set', () => {
    const RELAY_D = 'https://relay-d.example';
    const payload = toBase64Url(
      JSON.stringify({
        v: 2,
        rl: [RELAY_D, 'not a url', RELAY_B],
        h: [{ d: 'DocImport1', rw: 'ImportTok1111111', ek: 'k'.repeat(43) }],
      }),
    );
    const decoded = backup.decodeBackup(payload);
    assert.ok(decoded);
    backup.importBackup(decoded);
    const relays = store.getRelaysSnapshot().map((r) => r.url);
    assert.ok(relays.includes(RELAY_D), 'new relay added');
    assert.equal(relays.filter((r) => r === RELAY_B).length, 1, 'known relay not duplicated');
  });

  /* ---------- share links: `?r=` hints ---------- */

  const docId = 'DocShare01';
  store.importHandles([
    {
      docId,
      rwToken: 'ShareRwTok111111',
      roToken: 'ShareRoTok111111',
      key: 'k'.repeat(43),
      relays: [WRAPPER_ORIGIN, RELAY_B, RELAY_C],
    },
  ]);
  const shareUrl = links.buildShareUrl(docId, 'ShareRoTok111111', { kind: 'inventory' }, 'k'.repeat(43));
  console.info(`[size] share link with 2 extra relay hints: ${shareUrl.length} B (QR version ${qrCreate(shareUrl, { errorCorrectionLevel: 'M' }).version})`);

  check('share URL embeds the other relays compactly after ?r=', () => {
    assert.ok(shareUrl.startsWith(`${WRAPPER_ORIGIN}/#/join/${docId}/`), shareUrl);
    assert.ok(shareUrl.includes('?r=relay-b.example,http://192.168.1.20:8787'), shareUrl);
  });
  check('parseShareLink returns docId/token/key and the relay hints', () => {
    const parsed = links.parseShareLink(shareUrl);
    assert.ok(parsed);
    assert.equal(parsed.docId, docId);
    assert.equal(parsed.token, 'ShareRoTok111111');
    assert.equal(parsed.key, 'k'.repeat(43));
    assert.equal(parsed.origin, WRAPPER_ORIGIN);
    assert.deepEqual(parsed.relays, [RELAY_B, RELAY_C]);
  });
  check('item share links keep the suffix with hints appended after it', () => {
    const url = links.buildShareUrl(docId, 'ShareRoTok111111', { kind: 'item', itemId: 'Item000001' }, 'k'.repeat(43));
    const parsed = links.parseShareLink(url);
    assert.ok(parsed);
    assert.equal(parsed.suffix, '/i/Item000001');
    assert.deepEqual(parsed.relays, [RELAY_B, RELAY_C]);
  });
  check('old links without ?r= still parse (relays empty)', () => {
    const parsed = links.parseShareLink(
      `${WRAPPER_ORIGIN}/#/join/${docId}/ShareRoTok111111/k/${'k'.repeat(43)}`,
    );
    assert.ok(parsed);
    assert.deepEqual(parsed.relays, []);
    assert.equal(parsed.origin, WRAPPER_ORIGIN);
  });
  check('joinRoute drops the hints (they travel via the stash, not the route)', () => {
    const parsed = links.parseShareLink(shareUrl);
    assert.ok(parsed);
    assert.equal(links.joinRoute(parsed), `/join/${docId}/ShareRoTok111111/k/${'k'.repeat(43)}`);
  });
  check('relay hint codec round-trips https, bare-http and LAN origins', () => {
    const encoded = links.encodeRelayHints([RELAY_B, RELAY_C, 'https://192.168.5.5']);
    assert.deepEqual(links.decodeRelayHints(encoded), [RELAY_B, RELAY_C, 'https://192.168.5.5']);
    assert.deepEqual(links.decodeRelayHints(undefined), []);
  });

  console.log('backup payload test passed');
  // The imported store schedules browser-only background work (photo upload
  // loops) that would crash node after the test is done; exit cleanly now.
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
