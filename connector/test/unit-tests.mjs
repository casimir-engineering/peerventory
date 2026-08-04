/**
 * Node-side unit tests for the connector's pure logic (test/.tmp/core.mjs,
 * built from src/ by `npm run build` — run via `npm run test:unit` in
 * connector/). Proves, without a browser:
 *
 *  1. a profile share link (app backup URL, WirePayload v2) decodes into a
 *     profile with origin, tokens and content keys — and the AI key is DROPPED
 *  2. an end-to-end encrypted outer doc (enc:log per CONTRACTS.md, built here
 *     exactly like the app builds it) decrypts and materializes into items,
 *     tolerating undecryptable entries
 *  3. the generated listing payload matches the v1 contract the content
 *     scripts validate
 *  4. an encrypted photo blob round-trips through the connector's decrypt
 *
 * Fixture crypto mirrors server/src/e2e-encrypted.ts (which mirrors the app).
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import {
  AI_MODEL,
  ANTHROPIC_URL,
  aiPickOption,
  buildListingPayload,
  buildProfile,
  bytesToBase64Url,
  decryptOuterDoc,
  decryptPhoto,
  draftListing,
  importContentKey,
  isListingPayload,
  itemTitle,
  matchesQuery,
  parseAiKeyInput,
  parseProfileLink,
  readInventory,
  syncToken,
} from './.tmp/core.mjs';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const IV_BYTES = 12;

function toBase64Url(json) {
  return Buffer.from(json, 'utf8').toString('base64url');
}

async function encryptUpdate(key, docId, update) {
  const iv = new Uint8Array(randomBytes(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(docId) },
    key,
    update,
  );
  return { iv, ct: new Uint8Array(ct) };
}

/* ---------- fixtures ---------- */

const DOC_ID = 'DocFixt111';
const RO_TOKEN = 'RoTokenFixture11';
const RW_TOKEN = 'RwTokenFixture11';
const rawKey = randomBytes(32);
const keyB64 = bytesToBase64Url(new Uint8Array(rawKey));

const wirePayload = {
  v: 2,
  n: 'Raph',
  oi: 'Owner11111',
  k: 'sk-ant-FAKE-ai-key-must-never-be-imported',
  h: [
    { d: DOC_ID, rw: RW_TOKEN, ro: RO_TOKEN, ek: keyB64, nm: 'Garage' },
    { d: 'DocNoKey11', ro: 'RoTokenNoKey1111', nm: 'Locked' },
  ],
};
const backupUrl = `https://inv.example.com/#/restore/${toBase64Url(JSON.stringify(wirePayload))}`;

/* ---------- 1. profile link decoding ---------- */

await test('profile link parses: origin + payload extracted from the URL', () => {
  const parsed = parseProfileLink(backupUrl);
  assert.ok(parsed);
  assert.equal(parsed.origin, 'https://inv.example.com');
});

await test('profile decodes: handles, tokens, keys, names, user name', () => {
  const profile = buildProfile(backupUrl);
  assert.ok(profile);
  assert.equal(profile.origin, 'https://inv.example.com');
  assert.equal(profile.userName, 'Raph');
  assert.equal(profile.handles.length, 2);
  const h = profile.handles[0];
  assert.deepEqual(
    { d: h.docId, rw: h.rwToken, ro: h.roToken, ek: h.key, nm: h.name },
    { d: DOC_ID, rw: RW_TOKEN, ro: RO_TOKEN, ek: keyB64, nm: 'Garage' },
  );
});

await test('read-only token preferred for sync; AI key never imported', () => {
  const profile = buildProfile(backupUrl);
  assert.equal(syncToken(profile.handles[0]), RO_TOKEN);
  assert.equal(JSON.stringify(profile).includes('sk-ant-FAKE'), false);
});

await test('bare payload without origin is rejected unless an origin is supplied', () => {
  const bare = toBase64Url(JSON.stringify(wirePayload));
  assert.equal(buildProfile(bare), null);
  const withOrigin = buildProfile(bare, 'https://inv.example.com/');
  assert.equal(withOrigin?.origin, 'https://inv.example.com');
});

/* ---------- 2. encrypted outer doc -> items ---------- */

function makeInnerDoc() {
  const inner = new Y.Doc();
  inner.transact(() => {
    const meta = inner.getMap('meta');
    meta.set('id', DOC_ID);
    meta.set('name', 'Garage');
    meta.set('currency', 'CHF');
    const items = inner.getMap('items');
    const drill = new Y.Map();
    drill.set('id', 'ItemDrill1');
    drill.set('createdAt', 1_700_000_000_000);
    drill.set('updatedAt', 1_700_000_500_000);
    drill.set('description', 'Cordless drill 18V\nWith two batteries');
    drill.set('brandModel', 'Bosch GSR 18V');
    drill.set('category', 'Tools');
    drill.set('tags', ['workshop', 'power']);
    drill.set('quantity', 1);
    drill.set('condition', 'Good');
    drill.set('serialNumber', 'SN-SECRET-123');
    drill.set('valueCurrent', { amount: 123, currency: 'CHF' });
    drill.set('valueNew', { amount: 300, currency: 'CHF' });
    drill.set('weight', { class: 'kg1_2', exactGrams: 1450 });
    drill.set('dimensions', { class: 'shoebox', exactMm: { l: 250, w: 80, h: 220 } });
    drill.set('photos', [{ hash: 'a'.repeat(64), mime: 'image/jpeg', role: 'photo', addedAt: 1 }]);
    items.set('ItemDrill1', drill);
    const lamp = new Y.Map();
    lamp.set('id', 'ItemLamp11');
    lamp.set('createdAt', 1_710_000_000_000);
    lamp.set('updatedAt', 1_710_000_000_000);
    lamp.set('description', 'Vintage desk lamp');
    lamp.set('quantity', 2);
    lamp.set('photos', []);
    items.set('ItemLamp11', lamp);
  });
  return inner;
}

async function makeOuterDoc(aesKey) {
  const inner = makeInnerDoc();
  const outer = new Y.Doc();
  const log = outer.getArray('enc:log');
  // Two real entries (split state like two sessions would) + one garbage entry.
  const fullState = Y.encodeStateAsUpdate(inner);
  const half = await encryptUpdate(aesKey, DOC_ID, fullState);
  log.push([{ v: 1, dev: 'devA', seq: 1, ...half }]);
  const editDoc = new Y.Doc();
  Y.applyUpdate(editDoc, fullState);
  const before = Y.encodeStateVector(editDoc);
  editDoc.getMap('items').get('ItemLamp11').set('notes', 'Bulb included');
  const diff = Y.encodeStateAsUpdate(editDoc, before);
  const edit = await encryptUpdate(aesKey, DOC_ID, diff);
  log.push([{ v: 1, dev: 'devB', seq: 2, ...edit }]);
  log.push([
    { v: 1, dev: 'devX', seq: 3, iv: new Uint8Array(12), ct: new Uint8Array(randomBytes(64)) },
  ]);
  return outer;
}

const aesKeyForFixture = await (async () => {
  const { webcrypto } = await import('node:crypto');
  return webcrypto.subtle.importKey('raw', new Uint8Array(rawKey), { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
})();

let materialized;
await test('encrypted outer doc decrypts and materializes items (skipping bad entries)', async () => {
  const outer = await makeOuterDoc(aesKeyForFixture);
  const { inner, entries, skipped } = await decryptOuterDoc(outer, DOC_ID, keyB64);
  assert.equal(entries, 3);
  assert.equal(skipped, 1);
  materialized = readInventory(inner, DOC_ID);
  assert.equal(materialized.name, 'Garage');
  assert.equal(materialized.items.length, 2);
  // Sorted newest first; the devB edit merged in.
  assert.equal(materialized.items[0].id, 'ItemLamp11');
  assert.equal(materialized.items[0].notes, 'Bulb included');
});

await test('materialized item carries search/listing fields but never the serial number', () => {
  const drill = materialized.items.find((i) => i.id === 'ItemDrill1');
  assert.equal(drill.brandModel, 'Bosch GSR 18V');
  assert.equal(drill.weightGrams, 1450);
  assert.deepEqual(drill.dimensionsMm, { l: 250, w: 80, h: 220 });
  assert.equal(drill.serialIncluded, true);
  assert.equal(JSON.stringify(drill).includes('SN-SECRET'), false);
  assert.deepEqual(drill.photos, [{ hash: 'a'.repeat(64), mime: 'image/jpeg' }]);
});

await test('wrong key: everything skipped, nothing decrypted', async () => {
  const outer = await makeOuterDoc(aesKeyForFixture);
  const wrongKey = bytesToBase64Url(new Uint8Array(randomBytes(32)));
  const { entries, skipped } = await decryptOuterDoc(outer, DOC_ID, wrongKey);
  assert.equal(skipped, entries);
});

await test('AAD binding: ciphertext does not decrypt under another docId', async () => {
  const outer = await makeOuterDoc(aesKeyForFixture);
  const { skipped, entries } = await decryptOuterDoc(outer, 'DocOther11', keyB64);
  assert.equal(skipped, entries);
});

/* ---------- 3. listing payload + search ---------- */

await test('listing payload matches the v1 contract and rounds the price', () => {
  const drill = materialized.items.find((i) => i.id === 'ItemDrill1');
  const payload = buildListingPayload(drill);
  assert.equal(isListingPayload(payload), true);
  assert.equal(payload.item.priceAmount, 125); // 123 rounded to a 5-step
  assert.equal(payload.item.priceCurrency, 'CHF');
  assert.equal(payload.item.serialIncluded, true);
  assert.equal(payload.item.title, itemTitle(drill));
  assert.ok(payload.item.description.includes('Serial number on record'));
  assert.equal(JSON.stringify(payload).includes('SN-SECRET'), false);
});

await test('search matches name/brand/category/tags across inventories', () => {
  const drill = materialized.items.find((i) => i.id === 'ItemDrill1');
  assert.equal(matchesQuery(drill, 'Garage', 'bosch drill'), true);
  assert.equal(matchesQuery(drill, 'Garage', 'workshop'), true); // tag
  assert.equal(matchesQuery(drill, 'Garage', 'garage'), true); // inventory name
  assert.equal(matchesQuery(drill, 'Garage', 'lamp'), false);
});

/* ---------- 3b. listing language (template boilerplate) ---------- */

await test('template boilerplate is localized (FR default flavor, DE, IT)', () => {
  const drill = materialized.items.find((i) => i.id === 'ItemDrill1');
  const fr = buildListingPayload(drill, 'fr');
  assert.equal(fr.item.language, 'fr');
  assert.equal(fr.item.aiDrafted, false);
  assert.ok(fr.item.description.includes('Marque / modèle: Bosch GSR 18V'));
  assert.ok(fr.item.description.includes('Numéro de série enregistré'));
  assert.ok(fr.item.description.includes('Vendu comme sur les photos'));
  const de = buildListingPayload(drill, 'de');
  assert.ok(de.item.description.includes('Marke / Modell: Bosch GSR 18V'));
  assert.ok(de.item.description.includes('Seriennummer registriert'));
  const it = buildListingPayload(drill, 'it');
  assert.ok(it.item.description.includes('Marca / modello: Bosch GSR 18V'));
  // Item data itself is untouched — only the fixed strings are translated.
  assert.ok(fr.item.description.includes('Cordless drill 18V'));
});

/* ---------- 3c. AI plumbing (mocked fetch — never a real API) ---------- */

await test('AI key input accepts raw keys and the app inv-ai: QR format', () => {
  assert.equal(parseAiKeyInput('sk-ant-api03-abcdefghijklmnop'), 'sk-ant-api03-abcdefghijklmnop');
  assert.equal(parseAiKeyInput('  inv-ai:sk-ant-api03-abcdefghijklmnop '), 'sk-ant-api03-abcdefghijklmnop');
  assert.equal(parseAiKeyInput('inv-ai:short'), null);
  assert.equal(parseAiKeyInput('not a key at all'), null);
  assert.equal(parseAiKeyInput(''), null);
});

function mockFetch(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const req = { url, init, body: JSON.parse(init.body) };
    calls.push(req);
    const out = handler(req);
    return { ok: true, status: 200, json: async () => out };
  };
  return { fetchFn, calls };
}

const anthropicText = (text) => ({ content: [{ type: 'text', text }] });

await test('draftListing: tiny anthropic request, language + facts in prompt, fenced JSON parsed', async () => {
  const drill = materialized.items.find((i) => i.id === 'ItemDrill1');
  const { fetchFn, calls } = mockFetch(() =>
    anthropicText('```json\n{"title":"Perceuse Bosch 18V","description":"Copie IA.\\nPrix neuf: 300 CHF"}\n```'),
  );
  const draft = await draftListing(drill, { amount: 125, currency: 'CHF' }, 'fr', 'sk-test', {
    fetchFn,
  });
  assert.equal(draft.title, 'Perceuse Bosch 18V');
  assert.equal(draft.description, 'Copie IA.\nPrix neuf: 300 CHF');
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.url, ANTHROPIC_URL);
  assert.equal(req.init.headers['x-api-key'], 'sk-test');
  assert.equal(req.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(req.body.model, AI_MODEL);
  assert.ok(req.body.max_tokens <= 400, 'small max_tokens (user pays per token)');
  const prompt = req.body.messages[0].content;
  assert.ok(prompt.includes('French'), 'selected language in the prompt');
  assert.ok(prompt.includes('Bosch GSR 18V'), 'brand fact in the prompt');
  assert.ok(prompt.includes('Asking price: 125 CHF'), 'price fact in the prompt');
  assert.ok(!prompt.includes('SN-SECRET'), 'serial number never reaches the AI');
});

await test('draftListing throws on HTTP error / bad JSON (caller keeps the template)', async () => {
  const drill = materialized.items.find((i) => i.id === 'ItemDrill1');
  const failFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() =>
    draftListing(drill, null, 'fr', 'sk-test', { fetchFn: failFetch }),
  );
  const { fetchFn } = mockFetch(() => anthropicText('sorry, no JSON here'));
  await assert.rejects(() => draftListing(drill, null, 'fr', 'sk-test', { fetchFn }));
});

await test('aiPickOption: numbered options in prompt, 1-based answer -> 0-based index', async () => {
  const { fetchFn, calls } = mockFetch(() => anthropicText(' 2 '));
  const idx = await aiPickOption(
    ['Informatique', 'Maison', 'TV & Audio'],
    { title: 'Lampe à lave', category: 'Weird stuff' },
    'sk-test',
    { fetchFn },
  );
  assert.equal(idx, 1);
  const prompt = calls[0].body.messages[0].content;
  assert.ok(prompt.includes('1. Informatique') && prompt.includes('3. TV & Audio'));
  assert.ok(prompt.includes('Lampe à lave'));
  assert.ok(calls[0].body.max_tokens <= 16, 'number-only answer, tiny max_tokens');
});

await test('aiPickOption: "0" and out-of-range answers mean "unsure" (null)', async () => {
  const zero = mockFetch(() => anthropicText('0'));
  assert.equal(
    await aiPickOption(['A', 'B'], { title: 'x' }, 'sk-test', { fetchFn: zero.fetchFn }),
    null,
  );
  const big = mockFetch(() => anthropicText('99'));
  assert.equal(
    await aiPickOption(['A', 'B'], { title: 'x' }, 'sk-test', { fetchFn: big.fetchFn }),
    null,
  );
});

/* ---------- 4. encrypted photo round-trip ---------- */

await test('encrypted photo blob decrypts to bytes + mime', async () => {
  const plain = Buffer.concat([Buffer.from('PHOTO-MARKER'), randomBytes(4096)]);
  const mimeBytes = Buffer.from('image/jpeg', 'utf8');
  const envelope = Buffer.concat([
    Buffer.from([mimeBytes.length >> 8, mimeBytes.length & 0xff]),
    mimeBytes,
    plain,
  ]);
  const envelopeHash = createHash('sha256').update(envelope).digest('hex');
  const iv = createHmac('sha256', rawKey)
    .update('peerventory:photo-iv:' + envelopeHash)
    .digest()
    .subarray(0, IV_BYTES);
  const { webcrypto } = await import('node:crypto');
  const encKey = await webcrypto.subtle.importKey(
    'raw',
    new Uint8Array(rawKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  const ct = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(iv) },
    encKey,
    new Uint8Array(envelope),
  );
  const wire = new Uint8Array(Buffer.concat([iv, Buffer.from(ct)]));

  const key = await importContentKey(keyB64);
  const out = await decryptPhoto(key, wire);
  assert.ok(out);
  assert.equal(out.mime, 'image/jpeg');
  assert.deepEqual(Buffer.from(out.bytes), plain);
});

console.log(failures === 0 ? '\nAll unit tests passed.' : `\n${failures} unit test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
