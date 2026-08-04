/**
 * End-to-end test of the Peerventory connector extension against local
 * fixture pages, without touching the live sites or a live relay:
 *
 *  1. Builds the React-controlled Facebook fixture with esbuild.
 *  2. Serves both fixtures over local HTTPS (self-signed cert).
 *  3. Launches Chromium with the extension loaded (build it first: `npm run
 *     build` in connector/) and --host-resolver-rules mapping www.anibis.ch /
 *     www.facebook.com to the local server — so the real manifest matches,
 *     content-script injection, popup → storage → tabs.sendMessage plumbing
 *     and the fill engine all run exactly as they would in production.
 *  4. Covers: onboarding (profile link paste), cached-inventory search,
 *     per-item "Sell on Anibis" fill, the pending-autofill flow for a tab
 *     the popup opens, the app-payload paste path, and the wrong-page guard.
 *
 * Relay sync itself is covered by unit-tests.mjs (decode + decrypt) and the
 * server-side e2e (server/src/e2e-encrypted.ts); here the relay origin is
 * unreachable on purpose and the popup must stay usable on cached data.
 *
 * Run: cd connector && npm run build && cd test && npm install && npm test
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import QRCode from 'qrcode';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, '..', 'chrome-extension');
const TMP = join(HERE, '.tmp');
const PORT = 5299;

if (!existsSync(join(EXT, 'popup.js'))) {
  console.error('chrome-extension/popup.js missing — run `npm run build` in connector/ first.');
  process.exit(1);
}

const payload = JSON.parse(readFileSync(join(HERE, 'sample-payload.json'), 'utf8'));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---- synthetic profile (relay origin is unreachable on purpose) ------ */

const DOC_ID = 'DocTest111';
const CONTENT_KEY = Buffer.from(randomBytes(32)).toString('base64url');
const PROFILE_LINK = `https://127.0.0.1:9/#/restore/${Buffer.from(
  JSON.stringify({
    v: 2,
    n: 'Test',
    h: [{ d: DOC_ID, ro: 'RoTokenTest11111', ek: CONTENT_KEY, nm: 'Garage' }],
  }),
  'utf8',
).toString('base64url')}`;

const CACHED_ITEMS = [
  {
    id: 'ItemDrill1',
    docId: DOC_ID,
    description: 'Cordless drill 18V',
    category: 'Tools',
    tags: ['workshop'],
    quantity: 1,
    condition: 'Bon état',
    brandModel: 'Bosch GSR 18V',
    valueCurrent: { amount: 123, currency: 'CHF' },
    weightGrams: 1450,
    serialIncluded: true,
    photos: [],
    createdAt: 1700000000000,
    updatedAt: 1700000500000,
  },
  {
    id: 'ItemLamp11',
    docId: DOC_ID,
    description: 'Vintage desk lamp',
    tags: [],
    quantity: 2,
    serialIncluded: false,
    photos: [],
    createdAt: 1710000000000,
    updatedAt: 1710000000000,
  },
];

/* 1. Build the React fixture ---------------------------------------- */

mkdirSync(join(HERE, 'dist'), { recursive: true });
execFileSync(
  join(HERE, 'node_modules', '.bin', 'esbuild'),
  [
    join(HERE, 'fixture-facebook.jsx'),
    '--bundle',
    '--jsx=automatic',
    '--define:process.env.NODE_ENV="production"',
    `--outfile=${join(HERE, 'dist', 'fixture-facebook.js')}`,
  ],
  { stdio: 'inherit' },
);

/* 2. Self-signed cert + HTTPS fixture server ------------------------- */

rmSync(join(TMP, 'profile'), { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '7',
  '-keyout', join(TMP, 'key.pem'), '-out', join(TMP, 'cert.pem'),
  '-subj', '/CN=peerventory-test',
]);

const routes = {
  '/fr/publier': ['fixture-anibis.html', 'text/html; charset=utf-8'],
  '/marketplace/create/item': ['fixture-facebook.html', 'text/html; charset=utf-8'],
  '/dist/fixture-facebook.js': ['dist/fixture-facebook.js', 'text/javascript'],
};

const server = createServer(
  { key: readFileSync(join(TMP, 'key.pem')), cert: readFileSync(join(TMP, 'cert.pem')) },
  (req, res) => {
    const route = routes[new URL(req.url, 'https://x').pathname];
    if (!route || !existsSync(join(HERE, route[0]))) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': route[1] });
    res.end(readFileSync(join(HERE, route[0])));
  },
);
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

/* 3. Chromium with the extension ------------------------------------- */

const context = await chromium.launchPersistentContext(join(TMP, 'profile'), {
  // Extensions need the full Chromium build; the default headless shell
  // silently ignores --load-extension.
  channel: 'chromium',
  headless: true,
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    `--host-resolver-rules=MAP www.anibis.ch 127.0.0.1:${PORT}, MAP www.facebook.com 127.0.0.1:${PORT}`,
    '--ignore-certificate-errors',
    // Fake camera for the scan-page smoke test (green test pattern).
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extId = new URL(sw.url()).host;
  console.log(`extension loaded, id ${extId}`);
  check('extension loads in Chromium (load-unpacked equivalent)', Boolean(extId));
  const popupUrl = `chrome-extension://${extId}/popup.html`;

  /* Popup: onboarding ------------------------------------------------- */

  console.log('\nOnboarding:');
  const popup = await context.newPage();
  await popup.goto(popupUrl);
  check('fresh popup shows onboarding', await popup.locator('#view-onboarding').isVisible());

  await popup.fill('#ob-link', 'this is not a profile link');
  await popup.click('#ob-connect');
  check(
    'garbage input rejected with a readable error',
    (await popup.locator('#ob-status').textContent()).includes('Not a profile share link'),
  );

  /* QR image drop: generate a real QR of the profile link, drop it ------ */

  const qrDataUrl = await QRCode.toDataURL(PROFILE_LINK, { width: 480, margin: 2 });
  await popup.evaluate(async (dataUrl) => {
    const blob = await (await fetch(dataUrl)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'profile-qr.png', { type: 'image/png' }));
    document
      .getElementById('view-onboarding')
      .dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, qrDataUrl);
  await popup.waitForSelector('#view-main:not([hidden])', { timeout: 15_000 });
  check('dropped QR image decodes and connects the profile', true);

  /* Camera scan page (fake camera: page must start cleanly) ------------- */

  const scan = await context.newPage();
  await scan.goto(`chrome-extension://${extId}/scan.html`);
  await scan.waitForFunction(
    () => document.getElementById('video').readyState >= 2,
    null,
    { timeout: 10_000 },
  );
  check(
    'scan page starts the camera without errors',
    !(await scan.locator('#status').textContent()).trim(),
  );
  await scan.close();

  /* Paste-link fallback (after a full reset) ----------------------------- */

  await popup.evaluate(() => chrome.storage.local.clear());
  await popup.reload();
  await popup.waitForSelector('#view-onboarding:not([hidden])');
  await popup.fill('#ob-link', PROFILE_LINK);
  await popup.click('#ob-connect');
  await popup.waitForSelector('#view-main:not([hidden])');
  check('pasted profile link connects and switches to the main view', true);
  check(
    'inventory from the link is counted',
    (await popup.locator('#counts').textContent()).includes('1 inventory'),
  );

  /* Cached items: search + rendering ----------------------------------- */

  console.log('\nSearch over cached inventories:');
  await popup.evaluate(
    ([docId, items]) =>
      chrome.storage.local.set({
        'pv:cache': {
          [docId]: { docId, name: 'Garage', syncedAt: Date.now(), items },
        },
      }),
    [DOC_ID, CACHED_ITEMS],
  );
  await popup.reload();
  await popup.waitForSelector('#view-main:not([hidden])');
  check('cached items render', (await popup.locator('.item').count()) === 2);
  check(
    'counts reflect the cache',
    (await popup.locator('#counts').textContent()).includes('2 items'),
  );

  await popup.fill('#search', 'bosch drill');
  check('search narrows to the matching item', (await popup.locator('.item').count()) === 1);
  await popup.fill('#search', 'zzz-no-match');
  check(
    'no-match search shows the empty note',
    (await popup.locator('#results .empty').textContent()).includes('No items match'),
  );
  await popup.fill('#search', '');

  /* "Sell on Anibis" from an item row ---------------------------------- */

  console.log('\nSell on Anibis (fixture at https://www.anibis.ch/fr/publier):');
  const anibis = await context.newPage();
  await anibis.goto('https://www.anibis.ch/fr/publier');
  await anibis.bringToFront();
  await popup.evaluate(() => {
    document.querySelector('[data-item-id="ItemDrill1"] [data-sell="anibis"]').click();
  });
  await anibis.waitForFunction(
    () => document.querySelector('input[name="title"]')?.value !== '',
    null,
    { timeout: 10_000 },
  );
  check(
    'title generated from item (brand + description)',
    (await anibis.inputValue('input[name="title"]')) === 'Bosch GSR 18V — Cordless drill 18V',
  );
  check('price suggested from valueCurrent (rounded)', (await anibis.inputValue('input[name="price"]')) === '125');
  check(
    'condition select matched by option text',
    (await anibis.inputValue('select[name="condition"]')) === 'good',
  );
  const desc = await anibis.inputValue('textarea[name="description"]');
  check('description is the template draft', desc.includes('Brand / model: Bosch GSR 18V'));
  check(
    'serial presence mentioned, number never present',
    desc.includes('Serial number on record') && !desc.includes('SN-'),
  );
  check('status overlay shown', (await anibis.locator('#pv-fill-overlay').count()) === 1);
  check(
    'popup reports the fill',
    (await popup.locator('#status').textContent()).includes('filled'),
  );

  /* Pending autofill (tab opened by the popup) -------------------------- */

  console.log('\nPending autofill on Facebook (fixture, React-controlled):');
  await popup.evaluate((p) => {
    return chrome.storage.local.set({
      'pv:payload': p,
      'pv:pending': { site: 'facebook', at: Date.now() },
    });
  }, payload);
  const fb = await context.newPage();
  await fb.goto('https://www.facebook.com/marketplace/create/item');
  await fb.waitForSelector('#state');
  await fb.waitForFunction(
    () => JSON.parse(document.querySelector('#state').textContent).title !== '',
    null,
    { timeout: 15_000 },
  );
  const state = JSON.parse(await fb.locator('#state').textContent());
  check('pending flag auto-fills the freshly opened form', state.title === payload.item.title);
  check('React state received the price (native-setter trick)', state.price === '120');
  check('React state received the description', state.description === payload.item.description);
  check(
    'pending flag is cleared after one use',
    await popup.evaluate(async () => {
      const data = await chrome.storage.local.get('pv:pending');
      return data['pv:pending'] === undefined;
    }),
  );

  /* App-drafted payload paste path -------------------------------------- */

  console.log('\nApp payload paste + "Fill this page":');
  await anibis.reload();
  await anibis.bringToFront();
  await popup.evaluate((json) => {
    document.querySelector('#payload').value = json;
    document.querySelector('#fill-page').click();
  }, JSON.stringify(payload));
  await anibis.waitForFunction(
    () => document.querySelector('input[name="title"]')?.value !== '',
    null,
    { timeout: 10_000 },
  );
  check(
    'pasted app payload fills the page (AI copy path)',
    (await anibis.inputValue('input[name="title"]')) === payload.item.title,
  );
  check(
    'description uses the FR translation (page lang=fr)',
    (await anibis.inputValue('textarea[name="description"]')) ===
      payload.item.descriptionTranslations.fr,
  );

  /* Wrong-page guard ---------------------------------------------------- */

  const elsewhere = await context.newPage();
  await elsewhere.goto('https://www.facebook.com/dist/fixture-facebook.js');
  await elsewhere.bringToFront();
  const resW = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true });
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return await chrome.tabs.sendMessage(tab.id, { type: 'PV_FILL' });
      } catch (err) {
        await new Promise((r) => setTimeout(r, 500));
        if (attempt === 9) return { ok: false, error: String(err) };
      }
    }
  });
  check(
    'facebook script refuses to fill outside /marketplace/create',
    resW && resW.ok === false && resW.error === 'not-listing-page',
    JSON.stringify(resW),
  );
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
